import { httpRouter } from "convex/server";
import { httpAction } from "./_generated/server";
import { internal } from "./_generated/api";
import { Id } from "./_generated/dataModel";
import {
  SIGNATURE_HEADER,
  TIMESTAMP_HEADER,
  verifyWebhookSignature,
} from "./lib/hmac";
import { getTodayIsoDate, isValidIsoDateString } from "./lib/rbac";

const http = httpRouter();

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

/**
 * GET /api/n8n/overdue-loans
 * Called daily by the n8n Overdue Reminders workflow.
 * Security: Requires valid `X-LendLoop-Timestamp` and `X-LendLoop-Signature`
 * computed over `${timestamp}.${pathname}${search}` (e.g. `${timestamp}./api/n8n/overdue-loans`).
 */
http.route({
  path: "/api/n8n/overdue-loans",
  method: "GET",
  handler: httpAction(async (ctx, request) => {
    const url = new URL(request.url);
    const verification = await verifyWebhookSignature({
      secret: process.env.LENDLOOP_WEBHOOK_SECRET,
      signatureHeader: request.headers.get(SIGNATURE_HEADER),
      timestampHeader: request.headers.get(TIMESTAMP_HEADER),
      rawBody: `${url.pathname}${url.search}`,
    });

    if (!verification.valid) {
      return jsonResponse(
        { error: "Unauthorized", reason: verification.reason },
        401
      );
    }

    const asOfDate = url.searchParams.get("asOfDate") ?? getTodayIsoDate();
    if (!isValidIsoDateString(asOfDate)) {
      return jsonResponse(
        { error: "Invalid asOfDate query parameter; expected YYYY-MM-DD" },
        400
      );
    }

    const payload = await ctx.runQuery(internal.n8n.getOverdueLoansForN8n, {
      asOfDate,
    });

    return jsonResponse(payload, 200);
  }),
});

/**
 * POST /api/n8n/reminder-callback
 * Called by the n8n Overdue Reminders workflow after sending each overdue reminder.
 * Security: Verifies HMAC-SHA256 signature over `${timestamp}.${rawBody}`.
 * Reliability: Enforces idempotency via `idempotencyKey` so retries never create duplicate records.
 */
http.route({
  path: "/api/n8n/reminder-callback",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    const rawBody = await request.text();
    const verification = await verifyWebhookSignature({
      secret: process.env.LENDLOOP_WEBHOOK_SECRET,
      signatureHeader: request.headers.get(SIGNATURE_HEADER),
      timestampHeader: request.headers.get(TIMESTAMP_HEADER),
      rawBody,
    });

    if (!verification.valid) {
      return jsonResponse(
        { error: "Unauthorized", reason: verification.reason },
        401
      );
    }

    let parsed: {
      idempotencyKey?: string;
      loanId?: string;
      reminderDateKey?: string;
      status?: "delivered" | "failed";
      summary?: string;
      attemptCount?: number;
      errorMessage?: string;
    };

    try {
      parsed = JSON.parse(rawBody);
    } catch {
      return jsonResponse({ error: "Invalid JSON payload" }, 400);
    }

    if (!parsed.idempotencyKey || !parsed.loanId) {
      return jsonResponse(
        { error: "Missing required fields: idempotencyKey and loanId" },
        400
      );
    }

    const reminderDateKey = parsed.reminderDateKey ?? getTodayIsoDate();
    if (!isValidIsoDateString(reminderDateKey)) {
      return jsonResponse(
        { error: "Invalid reminderDateKey; expected YYYY-MM-DD" },
        400
      );
    }
    const status = parsed.status === "failed" ? "failed" : "delivered";
    const summary =
      parsed.summary ??
      (status === "delivered"
        ? `Overdue reminder sent to borrower (${reminderDateKey})`
        : `Overdue reminder failed (${reminderDateKey})`);

    const result = await ctx.runMutation(internal.n8n.recordAutomationEvent, {
      idempotencyKey: parsed.idempotencyKey,
      loanId: parsed.loanId as Id<"loans">,
      workflow: "overdue_reminder",
      eventType: "loan.overdue_reminder",
      direction: "inbound",
      status,
      summary,
      attemptCount: parsed.attemptCount ?? 1,
      errorMessage: parsed.errorMessage,
      markReminderSentForDate: reminderDateKey,
    });

    return jsonResponse(result, 200);
  }),
});

/**
 * POST /api/n8n/automation-events
 * Called by:
 *   1. The n8n Request Notification workflow to confirm notification delivery.
 *   2. The n8n Error Handler workflow when any workflow fails after retries,
 *      ensuring failed automation runs are visible in LendLoop and never fail silently.
 */
http.route({
  path: "/api/n8n/automation-events",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    const rawBody = await request.text();
    const verification = await verifyWebhookSignature({
      secret: process.env.LENDLOOP_WEBHOOK_SECRET,
      signatureHeader: request.headers.get(SIGNATURE_HEADER),
      timestampHeader: request.headers.get(TIMESTAMP_HEADER),
      rawBody,
    });

    if (!verification.valid) {
      return jsonResponse(
        { error: "Unauthorized", reason: verification.reason },
        401
      );
    }

    let parsed: {
      idempotencyKey?: string;
      loanId?: string;
      workflow?: "request_notification" | "overdue_reminder" | "error_handler";
      eventType?: string;
      status?: "delivered" | "failed" | "retrying";
      summary?: string;
      attemptCount?: number;
      errorMessage?: string;
    };

    try {
      parsed = JSON.parse(rawBody);
    } catch {
      return jsonResponse({ error: "Invalid JSON payload" }, 400);
    }

    if (!parsed.idempotencyKey || !parsed.summary) {
      return jsonResponse(
        { error: "Missing required fields: idempotencyKey and summary" },
        400
      );
    }

    const result = await ctx.runMutation(internal.n8n.recordAutomationEvent, {
      idempotencyKey: parsed.idempotencyKey,
      loanId: parsed.loanId ? (parsed.loanId as Id<"loans">) : undefined,
      workflow: parsed.workflow ?? "request_notification",
      eventType: parsed.eventType ?? "workflow.callback",
      direction: "inbound",
      status: parsed.status ?? "delivered",
      summary: parsed.summary,
      attemptCount: parsed.attemptCount ?? 1,
      errorMessage: parsed.errorMessage,
    });

    return jsonResponse(result, 200);
  }),
});

export default http;
