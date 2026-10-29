import { describe, expect, it } from "vitest";
import fs from "fs";
import path from "path";
import crypto from "crypto";
import {
  computeHmacSha256Hex,
  constantTimeEqual,
  SIGNATURE_HEADER,
  signWebhookPayload,
  TIMESTAMP_HEADER,
  verifyWebhookSignature,
} from "../convex/lib/hmac";
import {
  ActorUser,
  assertAdmin,
  assertAuthenticated,
  assertCanDeleteTool,
  assertCanEditTool,
  assertCanMarkLoanReturned,
  assertCanRequestBorrow,
  assertCanReviewLoanRequest,
  AuthorizationError,
  buildMinimizedLoanWebhookPayload,
  buildMinimizedOverdueLoanItem,
  computeDaysOverdue,
  LoanRecord,
  ToolRecord,
  toPublicToolSummary,
  UnauthenticatedError,
  validateBorrowDateRange,
  ValidationError,
} from "../convex/lib/rbac";
import {
  formatLoanAutomationBadge,
  formatRelativeTime,
} from "../src/lib/format";

const TEST_SECRET =
  "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

const userAlice: ActorUser = {
  _id: "user_alice",
  clerkId: "clerk_alice",
  email: "alice@example.com",
  name: "Alice Lender",
  role: "user",
  isTrustedLender: true,
};

const userBob: ActorUser = {
  _id: "user_bob",
  clerkId: "clerk_bob",
  email: "bob@example.com",
  name: "Bob Borrower",
  role: "user",
  isTrustedLender: false,
};

const userAdmin: ActorUser = {
  _id: "user_admin",
  clerkId: "clerk_admin",
  email: "admin@lendloop.local",
  name: "Site Admin",
  role: "admin",
  isTrustedLender: true,
};

const sampleTool: ToolRecord = {
  _id: "tool_drill",
  name: "Bosch Hammer Drill",
  category: "power tools",
  condition: "Like New",
  description: "Includes masonry bits and carrying case.",
  ownerId: userAlice._id,
  isAvailable: true,
  createdAt: 1700000000000,
  updatedAt: 1700000000000,
};

const samplePendingLoan: LoanRecord = {
  _id: "loan_01",
  toolId: sampleTool._id,
  lenderId: userAlice._id,
  borrowerId: userBob._id,
  startDate: "2026-11-01",
  endDate: "2026-11-05",
  status: "pending",
  borrowerNote: "Hanging shelves",
  reminderCount: 0,
};

function runN8nCodeNode(
  jsCode: string,
  inputJson: unknown,
  env: Record<string, string>
): Array<{ json: Record<string, unknown> }> {
  const fn = new Function(
    "require",
    "$input",
    "$env",
    "console",
    "Buffer",
    jsCode
  );
  return fn(
    (mod: string) => {
      if (mod === "crypto") return crypto;
      throw new Error(`Unexpected module: ${mod}`);
    },
    {
      first: () => ({ json: inputJson }),
    },
    env,
    {
      log: () => {},
      error: () => {},
    },
    Buffer
  );
}

describe("1. Bidirectional HMAC-SHA256 Signing & Verification", () => {
  it("signs and verifies a valid webhook payload within the replay window", async () => {
    const rawBody = JSON.stringify({
      eventId: "evt_123",
      loanId: "loan_01",
      status: "approved",
    });
    const nowSeconds = 1760000000;

    const headers = await signWebhookPayload({
      secret: TEST_SECRET,
      rawBody,
      idempotencyKey: "evt_123",
      timestampSeconds: nowSeconds,
    });

    const result = await verifyWebhookSignature({
      secret: TEST_SECRET,
      signatureHeader: headers[SIGNATURE_HEADER],
      timestampHeader: headers[TIMESTAMP_HEADER],
      rawBody,
      nowSeconds: nowSeconds + 15,
    });

    expect(result.valid).toBe(true);
  });

  it("rejects tampered payload bodies", async () => {
    const nowSeconds = 1760000000;
    const rawBody = JSON.stringify({ loanId: "loan_01", status: "approved" });
    const headers = await signWebhookPayload({
      secret: TEST_SECRET,
      rawBody,
      idempotencyKey: "evt_123",
      timestampSeconds: nowSeconds,
    });

    const tamperedBody = JSON.stringify({
      loanId: "loan_01",
      status: "returned",
    });
    const result = await verifyWebhookSignature({
      secret: TEST_SECRET,
      signatureHeader: headers[SIGNATURE_HEADER],
      timestampHeader: headers[TIMESTAMP_HEADER],
      rawBody: tamperedBody,
      nowSeconds,
    });

    expect(result.valid).toBe(false);
    expect(result.reason).toContain("mismatch");
  });

  it("rejects replayed requests outside the 5-minute timestamp window", async () => {
    const nowSeconds = 1760000000;
    const rawBody = JSON.stringify({ ping: true });
    const headers = await signWebhookPayload({
      secret: TEST_SECRET,
      rawBody,
      idempotencyKey: "evt_old",
      timestampSeconds: nowSeconds - 301,
    });

    const result = await verifyWebhookSignature({
      secret: TEST_SECRET,
      signatureHeader: headers[SIGNATURE_HEADER],
      timestampHeader: headers[TIMESTAMP_HEADER],
      rawBody,
      nowSeconds,
    });

    expect(result.valid).toBe(false);
    expect(result.reason).toContain("replay window");
  });

  it("rejects missing headers, short secrets, and malformed hex digests", async () => {
    await expect(
      computeHmacSha256Hex("short", 1760000000, "{}")
    ).rejects.toThrow("at least 16 characters");

    const missing = await verifyWebhookSignature({
      secret: TEST_SECRET,
      signatureHeader: null,
      timestampHeader: "1760000000",
      rawBody: "{}",
      nowSeconds: 1760000000,
    });
    expect(missing.valid).toBe(false);

    const malformed = await verifyWebhookSignature({
      secret: TEST_SECRET,
      signatureHeader: "sha256=not-a-valid-hex",
      timestampHeader: "1760000000",
      rawBody: "{}",
      nowSeconds: 1760000000,
    });
    expect(malformed.valid).toBe(false);
    expect(constantTimeEqual("abc", "abcd")).toBe(false);
    expect(constantTimeEqual("same", "same")).toBe(true);
  });
});

describe("2. Role-Based Access Control (RBAC) Enforcement", () => {
  it("rejects unauthenticated callers across all protected assertions", () => {
    expect(() => assertAuthenticated(null)).toThrow(UnauthenticatedError);
    expect(() => assertAdmin(null)).toThrow(UnauthenticatedError);
    expect(() => assertCanEditTool(null, sampleTool)).toThrow(
      UnauthenticatedError
    );
  });

  it("enforces admin-only actions (viewing all loans, marking Trusted Lender)", () => {
    expect(() => assertAdmin(userAlice)).toThrow(AuthorizationError);
    expect(() => assertAdmin(userAdmin)).not.toThrow();
  });

  it("allows users to edit/delete only their own listings, while admins can remove any listing", () => {
    expect(() => assertCanEditTool(userAlice, sampleTool)).not.toThrow();
    expect(() => assertCanDeleteTool(userAlice, sampleTool)).not.toThrow();

    expect(() => assertCanEditTool(userBob, sampleTool)).toThrow(
      AuthorizationError
    );
    expect(() => assertCanDeleteTool(userBob, sampleTool)).toThrow(
      AuthorizationError
    );

    expect(() => assertCanDeleteTool(userAdmin, sampleTool)).not.toThrow();
    expect(() => assertCanEditTool(userAdmin, sampleTool)).toThrow(
      AuthorizationError
    );
  });

  it("enforces borrow request, approval/decline, and return rules", () => {
    expect(() => assertCanRequestBorrow(userAlice, sampleTool)).toThrow(
      ValidationError
    );
    expect(() => assertCanRequestBorrow(userBob, sampleTool)).not.toThrow();
    expect(() =>
      assertCanRequestBorrow(userBob, { ...sampleTool, isAvailable: false })
    ).toThrow(ValidationError);

    expect(() =>
      assertCanReviewLoanRequest(userBob, samplePendingLoan)
    ).toThrow(AuthorizationError);

    expect(() =>
      assertCanReviewLoanRequest(userAlice, samplePendingLoan)
    ).not.toThrow();

    const approvedLoan: LoanRecord = {
      ...samplePendingLoan,
      status: "approved",
    };
    expect(() => assertCanReviewLoanRequest(userAlice, approvedLoan)).toThrow(
      ValidationError
    );

    expect(() => assertCanMarkLoanReturned(userBob, approvedLoan)).toThrow(
      AuthorizationError
    );
    expect(() =>
      assertCanMarkLoanReturned(userAlice, approvedLoan)
    ).not.toThrow();
    expect(() =>
      assertCanMarkLoanReturned(userAdmin, approvedLoan)
    ).not.toThrow();
  });
});

describe("3. Date Validation & Overdue Calculations", () => {
  it("validates calendar date ranges and rejects invalid or past dates", () => {
    expect(() =>
      validateBorrowDateRange("2026-11-01", "2026-11-05", "2026-10-30")
    ).not.toThrow();

    expect(() =>
      validateBorrowDateRange("2026-02-30", "2026-03-02", "2026-02-01")
    ).toThrow(ValidationError);

    expect(() =>
      validateBorrowDateRange("2026-11-10", "2026-11-05", "2026-10-30")
    ).toThrow(ValidationError);

    expect(() =>
      validateBorrowDateRange("2026-10-01", "2026-10-15", "2026-10-30")
    ).toThrow(ValidationError);
  });

  it("computes overdue days accurately", () => {
    expect(computeDaysOverdue("2026-10-25", "2026-10-30")).toBe(5);
    expect(computeDaysOverdue("2026-10-30", "2026-10-30")).toBe(0);
    expect(computeDaysOverdue("2026-11-02", "2026-10-30")).toBe(0);
  });
});

describe("4. Data Minimization (Public Page & n8n Payloads)", () => {
  it("strips all owner and descriptive metadata from public tool summaries", () => {
    const summary = toPublicToolSummary(sampleTool);
    expect(summary).toEqual({
      _id: "tool_drill",
      name: "Bosch Hammer Drill",
      category: "power tools",
    });
    expect(Object.keys(summary).sort()).toEqual(["_id", "category", "name"]);
    expect("ownerId" in summary).toBe(false);
    expect("description" in summary).toBe(false);
    expect("condition" in summary).toBe(false);
  });

  it("constructs minimized n8n webhook payloads without internal IDs or Clerk tokens", () => {
    const reqPayload = buildMinimizedLoanWebhookPayload({
      eventId: "evt_001",
      eventType: "loan.requested",
      loan: samplePendingLoan,
      tool: sampleTool,
      lender: userAlice,
      borrower: userBob,
      occurredAtMs: 1760000000000,
    });

    expect(reqPayload.recipientRole).toBe("lender");
    expect(reqPayload.recipientEmail).toBe(userAlice.email);
    expect(reqPayload.counterpartyName).toBe(userBob.name);
    expect(JSON.stringify(reqPayload)).not.toContain("clerk_");
    expect(JSON.stringify(reqPayload)).not.toContain("user_alice");

    const overdueItem = buildMinimizedOverdueLoanItem({
      loan: { ...samplePendingLoan, status: "approved", endDate: "2026-10-27" },
      tool: sampleTool,
      borrower: userBob,
      lender: userAlice,
      todayIso: "2026-10-30",
    });

    expect(overdueItem.daysOverdue).toBe(3);
    expect(overdueItem.idempotencyKey).toBe(
      "overdue-reminder:loan_01:2026-10-30"
    );
  });
});

describe("5. Exported n8n Workflows Audit & End-to-End Code Execution", () => {
  const workflowDir = path.resolve(__dirname, "../n8n/workflows");
  const files = [
    "01-request-notification.json",
    "02-overdue-reminders.json",
    "03-error-handler.json",
  ];

  it.each(files)(
    "validates %s has valid nodes, retries, and zero hardcoded secrets",
    (filename) => {
      const raw = fs.readFileSync(path.join(workflowDir, filename), "utf-8");
      const parsed = JSON.parse(raw);

      expect(parsed.name).toBeTruthy();
      expect(Array.isArray(parsed.nodes)).toBe(true);
      expect(parsed.nodes.length).toBeGreaterThanOrEqual(3);

      const httpNodes = parsed.nodes.filter(
        (n: { type: string }) => n.type === "n8n-nodes-base.httpRequest"
      );
      expect(httpNodes.length).toBeGreaterThanOrEqual(1);
      for (const node of httpNodes) {
        expect(node.retryOnFail).toBe(true);
        expect(node.maxTries).toBeGreaterThanOrEqual(3);
      }

      if (filename !== "03-error-handler.json") {
        expect(parsed.settings?.errorWorkflow).toBe("lendloop-error-handler");
      }

      expect(raw).toContain("$env.LENDLOOP_WEBHOOK_SECRET");
      expect(raw).not.toMatch(/sk_live_|sk_test_|pk_live_|pk_test_/);
    }
  );

  it("executes Workflow 01 (Request Notification) Code nodes end-to-end with bidirectional HMAC verification", async () => {
    const wf1 = JSON.parse(
      fs.readFileSync(
        path.join(workflowDir, "01-request-notification.json"),
        "utf-8"
      )
    );
    const verifyNode = wf1.nodes.find(
      (n: { id: string }) => n.id === "node-verify-hmac"
    );
    const deliverNode = wf1.nodes.find(
      (n: { id: string }) => n.id === "node-deliver-and-sign-ack"
    );

    const payload = buildMinimizedLoanWebhookPayload({
      eventId: "loan-requested:loan_01:1760000000",
      eventType: "loan.requested",
      loan: samplePendingLoan,
      tool: sampleTool,
      lender: userAlice,
      borrower: userBob,
    });
    const rawBody = JSON.stringify(payload);
    const headers = await signWebhookPayload({
      secret: TEST_SECRET,
      rawBody,
      idempotencyKey: payload.eventId,
    });

    const env = {
      LENDLOOP_WEBHOOK_SECRET: TEST_SECRET,
      CONVEX_SITE_URL: "https://example.convex.site",
    };

    // Execute Node 2: Verify inbound HMAC from Convex
    const verifiedOutput = runN8nCodeNode(
      verifyNode.parameters.jsCode,
      { headers, body: payload },
      env
    );
    expect(verifiedOutput[0].json.recipientEmail).toBe(userAlice.email);
    expect(verifiedOutput[0].json.subject).toContain("Bosch Hammer Drill");

    // Verify Node 2 rejects forged signatures
    expect(() =>
      runN8nCodeNode(
        verifyNode.parameters.jsCode,
        {
          headers: {
            ...headers,
            "x-lendloop-signature": "sha256=" + "0".repeat(64),
          },
          body: payload,
        },
        env
      )
    ).toThrow("Invalid HMAC-SHA256");

    // Execute Node 3: Deliver notification & sign write-back to Convex
    const ackOutput = runN8nCodeNode(
      deliverNode.parameters.jsCode,
      verifiedOutput[0].json,
      env
    );
    const ack = ackOutput[0].json as {
      rawCallbackBody: string;
      ts: string;
      sig: string;
      idempotencyKey: string;
    };
    expect(ack.idempotencyKey).toBe(
      "n8n-ack:loan-requested:loan_01:1760000000"
    );

    // Verify Convex HTTP Action accepts the signature produced by n8n Node 3
    const convexVerify = await verifyWebhookSignature({
      secret: TEST_SECRET,
      signatureHeader: ack.sig,
      timestampHeader: ack.ts,
      rawBody: ack.rawCallbackBody,
    });
    expect(convexVerify.valid).toBe(true);
  });

  it("executes Workflow 02 (Overdue Reminders) & Workflow 03 (Error Handler) Code nodes and verifies Convex HMAC acceptance", async () => {
    const wf2 = JSON.parse(
      fs.readFileSync(
        path.join(workflowDir, "02-overdue-reminders.json"),
        "utf-8"
      )
    );
    const signGetNode = wf2.nodes.find(
      (n: { id: string }) => n.id === "node-sign-overdue-fetch"
    );
    const sendRemindersNode = wf2.nodes.find(
      (n: { id: string }) => n.id === "node-send-reminders-and-sign"
    );

    const env = {
      LENDLOOP_WEBHOOK_SECRET: TEST_SECRET,
      CONVEX_SITE_URL: "https://example.convex.site",
    };

    // 1. Test GET /api/n8n/overdue-loans signing in Workflow 02
    const signedGet = runN8nCodeNode(
      signGetNode.parameters.jsCode,
      {},
      env
    )[0].json as { url: string; ts: string; sig: string };

    const getVerify = await verifyWebhookSignature({
      secret: TEST_SECRET,
      signatureHeader: signedGet.sig,
      timestampHeader: signedGet.ts,
      rawBody: "/api/n8n/overdue-loans",
    });
    expect(getVerify.valid).toBe(true);

    // 2. Test per-loan reminder callback signing in Workflow 02
    const overdueItem = buildMinimizedOverdueLoanItem({
      loan: { ...samplePendingLoan, status: "approved", endDate: "2026-10-25" },
      tool: sampleTool,
      borrower: userBob,
      lender: userAlice,
      todayIso: "2026-10-30",
    });

    const reminderCallbacks = runN8nCodeNode(
      sendRemindersNode.parameters.jsCode,
      { asOfDate: "2026-10-30", overdueLoans: [overdueItem] },
      env
    );
    expect(reminderCallbacks).toHaveLength(1);
    const cb = reminderCallbacks[0].json as {
      rawCallbackBody: string;
      ts: string;
      sig: string;
      idempotencyKey: string;
    };
    expect(cb.idempotencyKey).toBe("overdue-reminder:loan_01:2026-10-30");

    const postVerify = await verifyWebhookSignature({
      secret: TEST_SECRET,
      signatureHeader: cb.sig,
      timestampHeader: cb.ts,
      rawBody: cb.rawCallbackBody,
    });
    expect(postVerify.valid).toBe(true);

    // 3. Test Workflow 03 (Error Handler) failure telemetry signing
    const wf3 = JSON.parse(
      fs.readFileSync(
        path.join(workflowDir, "03-error-handler.json"),
        "utf-8"
      )
    );
    const errorNode = wf3.nodes.find(
      (n: { id: string }) => n.id === "node-format-error-alert"
    );
    const errOutput = runN8nCodeNode(
      errorNode.parameters.jsCode,
      {
        workflow: { name: "LendLoop — 01 Request & Status Notification" },
        execution: {
          id: "exec_999",
          lastNodeExecuted: "Idempotent Write-Back to Convex",
          error: { message: "Connection refused" },
        },
      },
      env
    )[0].json as {
      rawCallbackBody: string;
      ts: string;
      sig: string;
      idempotencyKey: string;
    };

    expect(errOutput.idempotencyKey).toBe("n8n-error:exec_999");
    const errVerify = await verifyWebhookSignature({
      secret: TEST_SECRET,
      signatureHeader: errOutput.sig,
      timestampHeader: errOutput.ts,
      rawBody: errOutput.rawCallbackBody,
    });
    expect(errVerify.valid).toBe(true);
  });
});

describe("6. UI Automation Activity Formatting", () => {
  it("formats overdue reminder relative badges accurately", () => {
    const now = 1760000000000;
    const twoDaysAgo = now - 2 * 24 * 60 * 60 * 1000;

    expect(formatRelativeTime(twoDaysAgo, now)).toBe("2 days ago");
    expect(
      formatLoanAutomationBadge({
        lastReminderSentAt: twoDaysAgo,
        lastAutomationSummary: "Overdue reminder sent",
        nowMs: now,
      })
    ).toBe("Reminder sent 2 days ago");
  });
});
