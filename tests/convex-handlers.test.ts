import { describe, expect, it } from "vitest";
import * as usersModule from "../convex/users";
import * as toolsModule from "../convex/tools";
import * as loansModule from "../convex/loans";
import * as n8nModule from "../convex/n8n";
import httpRouter from "../convex/http";
import { signWebhookPayload } from "../convex/lib/hmac";
import { AuthorizationError, UnauthenticatedError, ValidationError } from "../convex/lib/rbac";

type TableMap = Record<string, Map<string, Record<string, any>>>;

function createInMemoryConvexCtx(options?: {
  identity?: {
    subject: string;
    email?: string;
    name?: string;
    role?: string;
  } | null;
}) {
  const tables: TableMap = {
    users: new Map(),
    tools: new Map(),
    loans: new Map(),
    automationEvents: new Map(),
  };
  let idCounter = 1;
  const scheduledCalls: Array<{ fn: unknown; args: unknown }> = [];

  function makeQueryChain(tableName: string) {
    let items = () => Array.from(tables[tableName]?.values() ?? []);
    const filters: Array<(doc: Record<string, any>) => boolean> = [];

    const chain: any = {
      withIndex: (_indexName: string, cb?: (q: any) => any) => {
        if (cb) {
          const eqBuilder: any = {
            eq: (field: string, value: any) => {
              filters.push((doc) => doc[field] === value);
              return eqBuilder;
            },
          };
          cb(eqBuilder);
        }
        return chain;
      },
      order: (_dir: "asc" | "desc") => chain,
      collect: async () => items().filter((doc) => filters.every((f) => f(doc))),
      take: async (n: number) =>
        items()
          .filter((doc) => filters.every((f) => f(doc)))
          .slice(0, n),
      unique: async () => {
        const matched = items().filter((doc) => filters.every((f) => f(doc)));
        return matched[0] ?? null;
      },
    };
    return chain;
  }

  const db = {
    get: async (id: string) => {
      for (const map of Object.values(tables)) {
        if (map.has(id)) return map.get(id)!;
      }
      return null;
    },
    insert: async (tableName: string, doc: Record<string, any>) => {
      const id = `${tableName}_${idCounter++}`;
      const record = { _id: id, _creationTime: Date.now(), ...doc };
      tables[tableName].set(id, record);
      return id;
    },
    patch: async (id: string, patchDoc: Record<string, any>) => {
      for (const map of Object.values(tables)) {
        if (map.has(id)) {
          const existing = map.get(id)!;
          map.set(id, { ...existing, ...patchDoc });
          return;
        }
      }
    },
    delete: async (id: string) => {
      for (const map of Object.values(tables)) {
        map.delete(id);
      }
    },
    query: (tableName: string) => makeQueryChain(tableName),
  };

  let currentIdentity = options?.identity ?? null;

  const ctx: any = {
    db,
    auth: {
      getUserIdentity: async () => currentIdentity,
    },
    scheduler: {
      runAfter: async (_delayMs: number, fn: unknown, args: unknown) => {
        scheduledCalls.push({ fn, args });
      },
    },
    setIdentity: (nextIdentity: typeof currentIdentity) => {
      currentIdentity = nextIdentity;
    },
    scheduledCalls,
    tables,
  };

  return ctx;
}

function invokeConvexFn<TArgs, TResult>(fnObj: any, ctx: any, args: TArgs): Promise<TResult> {
  const handler = fnObj._handler;
  return handler(ctx, args);
}

describe("7. Convex Handlers Integration (Users, Tools, Loans, Idempotent n8n Events & HTTP Router)", () => {
  it("executes full user -> tool -> borrow -> approve -> overdue query -> idempotent reminder -> return lifecycle", async () => {
    process.env.ADMIN_EMAILS = "admin@lendloop.local";
    process.env.LENDLOOP_WEBHOOK_SECRET =
      "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

    const ctx = createInMemoryConvexCtx();

    // 1. Unauthenticated calls to mutations must fail
    await expect(
      invokeConvexFn(usersModule.ensureCurrentUser, ctx, {})
    ).rejects.toThrow(UnauthenticatedError);

    // 2. Register Lender (Maya, regular user)
    ctx.setIdentity({
      subject: "clerk_maya",
      email: "maya@example.com",
      name: "Maya Lin",
    });
    const maya = await invokeConvexFn<any, any>(
      usersModule.ensureCurrentUser,
      ctx,
      {}
    );
    expect(maya.role).toBe("user");
    expect(maya.isTrustedLender).toBe(false);

    // 3. Register Borrower (Carlos, regular user)
    ctx.setIdentity({
      subject: "clerk_carlos",
      email: "carlos@example.com",
      name: "Carlos Rivera",
    });
    const carlos = await invokeConvexFn<any, any>(
      usersModule.ensureCurrentUser,
      ctx,
      {}
    );
    expect(carlos.role).toBe("user");

    // 4. Register Admin (via ADMIN_EMAILS server env var)
    ctx.setIdentity({
      subject: "clerk_admin",
      email: "admin@lendloop.local",
      name: "Yassine Admin",
    });
    const admin = await invokeConvexFn<any, any>(
      usersModule.ensureCurrentUser,
      ctx,
      {}
    );
    expect(admin.role).toBe("admin");

    // 5. Regular user cannot mark a lender as Trusted Lender; Admin can
    ctx.setIdentity({
      subject: "clerk_carlos",
      email: "carlos@example.com",
      name: "Carlos Rivera",
    });
    await expect(
      invokeConvexFn(usersModule.setTrustedLender, ctx, {
        userId: maya._id,
        isTrustedLender: true,
      })
    ).rejects.toThrow(AuthorizationError);

    ctx.setIdentity({
      subject: "clerk_admin",
      email: "admin@lendloop.local",
      name: "Yassine Admin",
    });
    await invokeConvexFn(usersModule.setTrustedLender, ctx, {
      userId: maya._id,
      isTrustedLender: true,
    });

    // 6. Maya creates a tool listing
    ctx.setIdentity({
      subject: "clerk_maya",
      email: "maya@example.com",
      name: "Maya Lin",
    });
    const toolId = await invokeConvexFn<any, string>(
      toolsModule.createTool,
      ctx,
      {
        name: "Makita Circular Saw",
        category: "power tools",
        condition: "Like New",
        description: "7-1/4 inch circular saw with carbide blade.",
      }
    );

    // 7. Public query returns ONLY _id, name, and category (no owner details)
    ctx.setIdentity(null);
    const publicList = await invokeConvexFn<any, any[]>(
      toolsModule.listPublicAvailable,
      ctx,
      {}
    );
    expect(publicList).toEqual([
      {
        _id: toolId,
        name: "Makita Circular Saw",
        category: "power tools",
      },
    ]);

    // 8. Carlos cannot edit or delete Maya's listing
    ctx.setIdentity({
      subject: "clerk_carlos",
      email: "carlos@example.com",
      name: "Carlos Rivera",
    });
    await expect(
      invokeConvexFn(toolsModule.updateTool, ctx, {
        toolId,
        name: "Hijacked",
        category: "other",
        condition: "Fair",
        description: "Unauthorized edit attempt",
      })
    ).rejects.toThrow(AuthorizationError);
    await expect(
      invokeConvexFn(toolsModule.deleteTool, ctx, { toolId })
    ).rejects.toThrow(AuthorizationError);

    // 9. Carlos requests to borrow Maya's tool -> schedules outbound n8n webhook
    const futureStart = "2099-05-01";
    const futureEnd = "2099-05-05";
    const loanId = await invokeConvexFn<any, string>(
      loansModule.requestBorrow,
      ctx,
      {
        toolId,
        startDate: futureStart,
        endDate: futureEnd,
        borrowerNote: "Cutting plywood for garden bed",
      }
    );
    expect(ctx.scheduledCalls.length).toBe(1);

    // Duplicate pending request from same borrower is rejected
    await expect(
      invokeConvexFn(loansModule.requestBorrow, ctx, {
        toolId,
        startDate: futureStart,
        endDate: futureEnd,
      })
    ).rejects.toThrow(ValidationError);

    // 10. Carlos (borrower) cannot approve his own request
    await expect(
      invokeConvexFn(loansModule.approveRequest, ctx, { loanId })
    ).rejects.toThrow(AuthorizationError);

    // 11. Maya (lender) approves the request -> marks tool unavailable & schedules webhook
    ctx.setIdentity({
      subject: "clerk_maya",
      email: "maya@example.com",
      name: "Maya Lin",
    });
    await invokeConvexFn(loansModule.approveRequest, ctx, {
      loanId,
      lenderNote: "Pick up anytime after 6pm!",
    });
    expect(ctx.scheduledCalls.length).toBe(2);

    // Tool is now unavailable on the public board
    const publicAfterApprove = await invokeConvexFn<any, any[]>(
      toolsModule.listPublicAvailable,
      ctx,
      {}
    );
    expect(publicAfterApprove).toHaveLength(0);

    // 12. Simulate overdue check after endDate (asOfDate = "2099-05-08")
    const overdueRes = await invokeConvexFn<any, any>(
      n8nModule.getOverdueLoansForN8n,
      ctx,
      { asOfDate: "2099-05-08" }
    );
    expect(overdueRes.count).toBe(1);
    expect(overdueRes.overdueLoans[0].daysOverdue).toBe(3);
    const idempotencyKey = overdueRes.overdueLoans[0].idempotencyKey;

    // 13. Record idempotent reminder write-back from n8n (first call increments reminderCount)
    const firstWriteBack = await invokeConvexFn<any, any>(
      n8nModule.recordAutomationEvent,
      ctx,
      {
        idempotencyKey,
        loanId,
        workflow: "overdue_reminder",
        eventType: "loan.overdue_reminder",
        direction: "inbound",
        status: "delivered",
        summary: "Overdue reminder sent (3d overdue)",
        attemptCount: 1,
        markReminderSentForDate: "2099-05-08",
      }
    );
    expect(firstWriteBack.deduplicated).toBe(false);

    // Second retry with the same idempotencyKey is deduplicated and does NOT increment reminderCount again
    const duplicateWriteBack = await invokeConvexFn<any, any>(
      n8nModule.recordAutomationEvent,
      ctx,
      {
        idempotencyKey,
        loanId,
        workflow: "overdue_reminder",
        eventType: "loan.overdue_reminder",
        direction: "inbound",
        status: "delivered",
        summary: "Overdue reminder sent (3d overdue)",
        attemptCount: 2,
        markReminderSentForDate: "2099-05-08",
      }
    );
    expect(duplicateWriteBack.deduplicated).toBe(true);

    const loanAfterReminder = await ctx.db.get(loanId);
    expect(loanAfterReminder.reminderCount).toBe(1);

    // 14. Maya marks the loan as returned -> tool becomes available again
    await invokeConvexFn(loansModule.markReturned, ctx, { loanId });
    const publicAfterReturn = await invokeConvexFn<any, any[]>(
      toolsModule.listPublicAvailable,
      ctx,
      {}
    );
    expect(publicAfterReturn).toHaveLength(1);
  });

  it("verifies Convex HTTP router rejects unsigned requests and accepts HMAC-signed callbacks", async () => {
    const secret =
      "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
    process.env.LENDLOOP_WEBHOOK_SECRET = secret;

    const routeEntry = (httpRouter as any).getRoutes().find(
      (r: any) => r[0] === "/api/n8n/reminder-callback" && r[1] === "POST"
    );
    expect(routeEntry).toBeDefined();
    const handler = routeEntry[2]._handler;

    const mutationsCalled: any[] = [];
    const httpCtx: any = {
      runMutation: async (_fn: unknown, args: unknown) => {
        mutationsCalled.push(args);
        return { ok: true, deduplicated: false };
      },
    };

    // 1. Unsigned request -> 401 Unauthorized
    const unsignedReq = new Request(
      "https://example.convex.site/api/n8n/reminder-callback",
      {
        method: "POST",
        body: JSON.stringify({ idempotencyKey: "k1", loanId: "loans_1" }),
      }
    );
    const unsignedRes = await handler(httpCtx, unsignedReq);
    expect(unsignedRes.status).toBe(401);
    expect(mutationsCalled).toHaveLength(0);

    // 2. Properly HMAC-signed request -> 200 OK
    const rawBody = JSON.stringify({
      idempotencyKey: "overdue-reminder:loans_1:2026-10-30",
      loanId: "loans_1",
      reminderDateKey: "2026-10-30",
      status: "delivered",
      summary: "Overdue reminder sent",
    });
    const signedHeaders = await signWebhookPayload({
      secret,
      rawBody,
      idempotencyKey: "overdue-reminder:loans_1:2026-10-30",
    });
    const signedReq = new Request(
      "https://example.convex.site/api/n8n/reminder-callback",
      {
        method: "POST",
        headers: signedHeaders,
        body: rawBody,
      }
    );
    const signedRes = await handler(httpCtx, signedReq);
    expect(signedRes.status).toBe(200);
    expect(mutationsCalled).toHaveLength(1);
    expect(mutationsCalled[0].idempotencyKey).toBe(
      "overdue-reminder:loans_1:2026-10-30"
    );
  });
});
