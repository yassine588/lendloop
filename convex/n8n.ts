import { v } from "convex/values";
import {
  internalAction,
  internalMutation,
  internalQuery,
} from "./_generated/server";
import { internal } from "./_generated/api";
import { signWebhookPayload } from "./lib/hmac";
import {
  buildMinimizedOverdueLoanItem,
  computeDaysOverdue,
  getTodayIsoDate,
} from "./lib/rbac";

/**
 * Idempotent internal mutation that records an automation event (outbound webhook,
 * inbound n8n callback, or n8n Error Workflow alert) and updates the loan's
 * recent automation activity summary.
 */
export const recordAutomationEvent = internalMutation({
  args: {
    idempotencyKey: v.string(),
    loanId: v.optional(v.id("loans")),
    workflow: v.union(
      v.literal("request_notification"),
      v.literal("overdue_reminder"),
      v.literal("error_handler")
    ),
    eventType: v.string(),
    direction: v.union(v.literal("outbound"), v.literal("inbound")),
    status: v.union(
      v.literal("delivered"),
      v.literal("failed"),
      v.literal("retrying")
    ),
    summary: v.string(),
    attemptCount: v.number(),
    errorMessage: v.optional(v.string()),
    markReminderSentForDate: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("automationEvents")
      .withIndex("by_idempotency_key", (q) =>
        q.eq("idempotencyKey", args.idempotencyKey)
      )
      .unique();

    if (existing) {
      // Idempotent retry: if already delivered, do not duplicate state changes or increment counters
      if (existing.status === "delivered") {
        return {
          ok: true,
          deduplicated: true,
          eventId: existing._id,
        };
      }
      await ctx.db.patch(existing._id, {
        status: args.status,
        summary: args.summary,
        attemptCount: args.attemptCount,
        errorMessage: args.errorMessage,
      });
    } else {
      await ctx.db.insert("automationEvents", {
        idempotencyKey: args.idempotencyKey,
        loanId: args.loanId,
        workflow: args.workflow,
        eventType: args.eventType,
        direction: args.direction,
        status: args.status,
        summary: args.summary,
        attemptCount: args.attemptCount,
        errorMessage: args.errorMessage,
        createdAt: Date.now(),
      });
    }

    if (args.loanId) {
      const loan = await ctx.db.get(args.loanId);
      if (loan) {
        const now = Date.now();
        const patchData: Record<string, unknown> = {
          lastAutomationSummary: args.summary,
          lastAutomationAt: now,
          updatedAt: now,
        };

        if (
          args.workflow === "overdue_reminder" &&
          args.status === "delivered" &&
          args.markReminderSentForDate &&
          loan.lastReminderDateKey !== args.markReminderSentForDate
        ) {
          patchData.lastReminderSentAt = now;
          patchData.lastReminderDateKey = args.markReminderSentForDate;
          patchData.reminderCount = loan.reminderCount + 1;
        }

        await ctx.db.patch(args.loanId, patchData);
      }
    }

    return {
      ok: true,
      deduplicated: false,
    };
  },
});

/**
 * Internal query invoked by `GET /api/n8n/overdue-loans` after HMAC verification.
 * Returns a data-minimized list of approved loans whose `endDate` has passed
 * and that have not yet received an overdue reminder today.
 */
export const getOverdueLoansForN8n = internalQuery({
  args: {
    asOfDate: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const todayIso = args.asOfDate ?? getTodayIsoDate();

    const approvedLoans = await ctx.db
      .query("loans")
      .withIndex("by_status", (q) => q.eq("status", "approved"))
      .collect();

    const overdueLoans = approvedLoans.filter(
      (loan) =>
        computeDaysOverdue(loan.endDate, todayIso) > 0 &&
        loan.lastReminderDateKey !== todayIso
    );

    const results = [];
    for (const loan of overdueLoans) {
      const [tool, borrower, lender] = await Promise.all([
        ctx.db.get(loan.toolId),
        ctx.db.get(loan.borrowerId),
        ctx.db.get(loan.lenderId),
      ]);
      if (!tool || !borrower || !lender) {
        continue;
      }

      results.push(
        buildMinimizedOverdueLoanItem({
          loan,
          tool,
          borrower,
          lender,
          todayIso,
        })
      );
    }

    return {
      asOfDate: todayIso,
      count: results.length,
      overdueLoans: results,
    };
  },
});

/**
 * Internal action that dispatches an HMAC-SHA256 signed webhook to n8n
 * whenever a borrow request is created or changes status.
 * Includes exponential backoff retries and records explicit failure telemetry
 * in `automationEvents` if all retries fail so failures are never silent.
 */
export const dispatchLoanWebhook = internalAction({
  args: {
    loanId: v.id("loans"),
    payload: v.object({
      eventId: v.string(),
      eventType: v.union(
        v.literal("loan.requested"),
        v.literal("loan.approved"),
        v.literal("loan.declined"),
        v.literal("loan.returned")
      ),
      loanId: v.string(),
      toolName: v.string(),
      toolCategory: v.union(
        v.literal("power tools"),
        v.literal("garden"),
        v.literal("kitchen"),
        v.literal("camping"),
        v.literal("hand tools"),
        v.literal("automotive"),
        v.literal("cleaning"),
        v.literal("other")
      ),
      status: v.union(
        v.literal("pending"),
        v.literal("approved"),
        v.literal("declined"),
        v.literal("returned")
      ),
      startDate: v.string(),
      endDate: v.string(),
      recipientRole: v.union(v.literal("lender"), v.literal("borrower")),
      recipientName: v.string(),
      recipientEmail: v.string(),
      counterpartyName: v.string(),
      note: v.optional(v.string()),
      occurredAt: v.string(),
    }),
  },
  handler: async (ctx, args) => {
    const webhookUrl = process.env.N8N_REQUEST_WEBHOOK_URL;
    const webhookSecret = process.env.LENDLOOP_WEBHOOK_SECRET;

    const eventLabels: Record<typeof args.payload.eventType, string> = {
      "loan.requested": "Borrow request notification",
      "loan.approved": "Loan approval notification",
      "loan.declined": "Request declined notification",
      "loan.returned": "Return confirmation notification",
    };
    const label = eventLabels[args.payload.eventType];

    if (!webhookUrl || !webhookSecret) {
      await ctx.runMutation(internal.n8n.recordAutomationEvent, {
        idempotencyKey: `outbound:${args.payload.eventId}`,
        loanId: args.loanId,
        workflow: "request_notification",
        eventType: args.payload.eventType,
        direction: "outbound",
        status: "failed",
        summary: `${label} skipped: N8N_REQUEST_WEBHOOK_URL or LENDLOOP_WEBHOOK_SECRET not configured`,
        attemptCount: 1,
        errorMessage:
          "Missing N8N_REQUEST_WEBHOOK_URL or LENDLOOP_WEBHOOK_SECRET environment variable.",
      });
      return { delivered: false, reason: "missing_env" };
    }

    const rawBody = JSON.stringify(args.payload);
    const maxAttempts = 3;
    let lastError = "Unknown webhook error";

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        const headers = await signWebhookPayload({
          secret: webhookSecret,
          rawBody,
          idempotencyKey: args.payload.eventId,
        });

        const response = await fetch(webhookUrl, {
          method: "POST",
          headers,
          body: rawBody,
        });

        if (response.ok) {
          await ctx.runMutation(internal.n8n.recordAutomationEvent, {
            idempotencyKey: `outbound:${args.payload.eventId}`,
            loanId: args.loanId,
            workflow: "request_notification",
            eventType: args.payload.eventType,
            direction: "outbound",
            status: "delivered",
            summary: `${label} dispatched to n8n (${args.payload.recipientRole})`,
            attemptCount: attempt,
          });
          return { delivered: true, attempt };
        }

        const errorText = await response.text().catch(() => "");
        lastError = `HTTP ${response.status}: ${errorText.slice(0, 200)}`;
      } catch (err) {
        lastError =
          err instanceof Error ? err.message : "Network error calling n8n";
      }

      if (attempt < maxAttempts) {
        const backoffMs = attempt * 750;
        await new Promise((resolve) => setTimeout(resolve, backoffMs));
      }
    }

    await ctx.runMutation(internal.n8n.recordAutomationEvent, {
      idempotencyKey: `outbound:${args.payload.eventId}`,
      loanId: args.loanId,
      workflow: "request_notification",
      eventType: args.payload.eventType,
      direction: "outbound",
      status: "failed",
      summary: `${label} failed after ${maxAttempts} attempts`,
      attemptCount: maxAttempts,
      errorMessage: lastError,
    });

    return { delivered: false, error: lastError };
  },
});
