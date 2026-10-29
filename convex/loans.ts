import { v } from "convex/values";
import { mutation, query, QueryCtx } from "./_generated/server";
import { internal } from "./_generated/api";
import { Doc } from "./_generated/dataModel";
import {
  assertCanMarkLoanReturned,
  assertCanRequestBorrow,
  assertCanReviewLoanRequest,
  buildMinimizedLoanWebhookPayload,
  computeDaysOverdue,
  getTodayIsoDate,
  validateBorrowDateRange,
  ValidationError,
} from "./lib/rbac";
import { requireAdminUser, requireCurrentUser } from "./users";

async function enrichLoans(ctx: QueryCtx, loans: Doc<"loans">[]) {
  const todayIso = getTodayIsoDate();

  return await Promise.all(
    loans.map(async (loan) => {
      const [tool, lender, borrower, events] = await Promise.all([
        ctx.db.get(loan.toolId),
        ctx.db.get(loan.lenderId),
        ctx.db.get(loan.borrowerId),
        ctx.db
          .query("automationEvents")
          .withIndex("by_loan", (q) => q.eq("loanId", loan._id))
          .order("desc")
          .take(5),
      ]);

      const daysOverdue =
        loan.status === "approved"
          ? computeDaysOverdue(loan.endDate, todayIso)
          : 0;

      return {
        _id: loan._id,
        toolId: loan.toolId,
        toolName: tool?.name ?? "Removed Tool",
        toolCategory: tool?.category ?? "other",
        toolCondition: tool?.condition ?? "Good",
        lenderId: loan.lenderId,
        lenderName: lender?.name ?? "Neighbor",
        lenderIsTrustedLender: lender?.isTrustedLender ?? false,
        borrowerId: loan.borrowerId,
        borrowerName: borrower?.name ?? "Neighbor",
        startDate: loan.startDate,
        endDate: loan.endDate,
        status: loan.status,
        borrowerNote: loan.borrowerNote,
        lenderNote: loan.lenderNote,
        isOverdue: daysOverdue > 0,
        daysOverdue,
        reminderCount: loan.reminderCount,
        lastReminderSentAt: loan.lastReminderSentAt,
        lastAutomationSummary: loan.lastAutomationSummary,
        lastAutomationAt: loan.lastAutomationAt,
        createdAt: loan.createdAt,
        updatedAt: loan.updatedAt,
        recentAutomationEvents: events.map((e) => ({
          _id: e._id,
          workflow: e.workflow,
          eventType: e.eventType,
          direction: e.direction,
          status: e.status,
          summary: e.summary,
          attemptCount: e.attemptCount,
          errorMessage: e.errorMessage,
          createdAt: e.createdAt,
        })),
      };
    })
  );
}

/**
 * AUTHENTICATED QUERY: "My requests" — loans requested by the signed-in borrower.
 */
export const listMyRequests = query({
  args: {},
  handler: async (ctx) => {
    const currentUser = await requireCurrentUser(ctx);
    const loans = await ctx.db
      .query("loans")
      .withIndex("by_borrower", (q) => q.eq("borrowerId", currentUser._id))
      .order("desc")
      .collect();

    return await enrichLoans(ctx, loans);
  },
});

/**
 * AUTHENTICATED QUERY: "Incoming requests" — borrow requests on the signed-in user's tools.
 */
export const listIncomingRequests = query({
  args: {},
  handler: async (ctx) => {
    const currentUser = await requireCurrentUser(ctx);
    const loans = await ctx.db
      .query("loans")
      .withIndex("by_lender", (q) => q.eq("lenderId", currentUser._id))
      .order("desc")
      .collect();

    return await enrichLoans(ctx, loans);
  },
});

/**
 * ADMIN-ONLY QUERY: View all loans across the entire LendLoop platform.
 * Enforced in Convex via `requireAdminUser`.
 */
export const listAllLoans = query({
  args: {},
  handler: async (ctx) => {
    await requireAdminUser(ctx);
    const loans = await ctx.db.query("loans").order("desc").collect();
    return await enrichLoans(ctx, loans);
  },
});

/**
 * AUTHENTICATED MUTATION: Request to borrow an available tool for a date range.
 * Triggers an HMAC-signed outbound webhook to the n8n Request Notification workflow.
 */
export const requestBorrow = mutation({
  args: {
    toolId: v.id("tools"),
    startDate: v.string(),
    endDate: v.string(),
    borrowerNote: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const borrower = await requireCurrentUser(ctx);
    const tool = await ctx.db.get(args.toolId);
    if (!tool) {
      throw new ValidationError("Tool not found.");
    }

    assertCanRequestBorrow(borrower, tool);
    validateBorrowDateRange(args.startDate, args.endDate);

    const existingForBorrower = await ctx.db
      .query("loans")
      .withIndex("by_borrower", (q) => q.eq("borrowerId", borrower._id))
      .collect();

    const hasDuplicatePending = existingForBorrower.some(
      (l) => l.toolId === args.toolId && l.status === "pending"
    );
    if (hasDuplicatePending) {
      throw new ValidationError(
        "You already have a pending request for this tool."
      );
    }

    const lender = await ctx.db.get(tool.ownerId);
    if (!lender) {
      throw new ValidationError("Tool owner account no longer exists.");
    }

    const now = Date.now();
    const trimmedNote = args.borrowerNote?.trim() || undefined;
    const loanId = await ctx.db.insert("loans", {
      toolId: tool._id,
      lenderId: tool.ownerId,
      borrowerId: borrower._id,
      startDate: args.startDate,
      endDate: args.endDate,
      status: "pending",
      borrowerNote: trimmedNote,
      reminderCount: 0,
      lastAutomationSummary: "Borrow request notification queued for n8n",
      lastAutomationAt: now,
      createdAt: now,
      updatedAt: now,
    });

    const loanDoc = await ctx.db.get(loanId);
    if (loanDoc) {
      const eventId = `loan-requested:${loanId}:${now}`;
      const payload = buildMinimizedLoanWebhookPayload({
        eventId,
        eventType: "loan.requested",
        loan: loanDoc,
        tool,
        lender,
        borrower,
        occurredAtMs: now,
      });

      await ctx.scheduler.runAfter(0, internal.n8n.dispatchLoanWebhook, {
        loanId,
        payload,
      });
    }

    return loanId;
  },
});

/**
 * AUTHENTICATED MUTATION: Approve a pending borrow request on the user's own tool.
 * Enforces RBAC (`assertCanReviewLoanRequest`), marks the tool as borrowed,
 * and triggers the n8n Request Notification workflow.
 */
export const approveRequest = mutation({
  args: {
    loanId: v.id("loans"),
    lenderNote: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const currentUser = await requireCurrentUser(ctx);
    const loan = await ctx.db.get(args.loanId);
    if (!loan) {
      throw new ValidationError("Loan request not found.");
    }

    assertCanReviewLoanRequest(currentUser, loan);

    const tool = await ctx.db.get(loan.toolId);
    if (!tool) {
      throw new ValidationError("Associated tool listing not found.");
    }
    if (!tool.isAvailable) {
      throw new ValidationError(
        "This tool is already checked out on another active loan."
      );
    }

    const [lender, borrower] = await Promise.all([
      ctx.db.get(loan.lenderId),
      ctx.db.get(loan.borrowerId),
    ]);
    if (!lender || !borrower) {
      throw new ValidationError("Associated lender or borrower not found.");
    }

    const now = Date.now();
    const trimmedNote = args.lenderNote?.trim() || undefined;

    await ctx.db.patch(tool._id, {
      isAvailable: false,
      updatedAt: now,
    });

    await ctx.db.patch(loan._id, {
      status: "approved",
      approvedAt: now,
      lenderNote: trimmedNote,
      lastAutomationSummary: "Loan approval notification queued for n8n",
      lastAutomationAt: now,
      updatedAt: now,
    });

    const updatedLoan = await ctx.db.get(loan._id);
    if (updatedLoan) {
      const eventId = `loan-approved:${loan._id}:${now}`;
      const payload = buildMinimizedLoanWebhookPayload({
        eventId,
        eventType: "loan.approved",
        loan: updatedLoan,
        tool,
        lender,
        borrower,
        occurredAtMs: now,
      });

      await ctx.scheduler.runAfter(0, internal.n8n.dispatchLoanWebhook, {
        loanId: loan._id,
        payload,
      });
    }

    // Automatically decline any other competing pending requests for the same tool
    const otherRequests = await ctx.db
      .query("loans")
      .withIndex("by_tool", (q) => q.eq("toolId", tool._id))
      .collect();

    for (const other of otherRequests) {
      if (other._id !== loan._id && other.status === "pending") {
        await ctx.db.patch(other._id, {
          status: "declined",
          declinedAt: now,
          lenderNote: "Tool was approved for another overlapping request.",
          lastAutomationSummary: "Decline notification queued for n8n",
          lastAutomationAt: now,
          updatedAt: now,
        });

        const otherBorrower = await ctx.db.get(other.borrowerId);
        const updatedOther = await ctx.db.get(other._id);
        if (otherBorrower && updatedOther) {
          const otherEventId = `loan-declined:${other._id}:${now}`;
          const otherPayload = buildMinimizedLoanWebhookPayload({
            eventId: otherEventId,
            eventType: "loan.declined",
            loan: updatedOther,
            tool,
            lender,
            borrower: otherBorrower,
            occurredAtMs: now,
          });
          await ctx.scheduler.runAfter(0, internal.n8n.dispatchLoanWebhook, {
            loanId: other._id,
            payload: otherPayload,
          });
        }
      }
    }

    return loan._id;
  },
});

/**
 * AUTHENTICATED MUTATION: Decline a pending borrow request on the user's own tool.
 * Enforces RBAC (`assertCanReviewLoanRequest`) and triggers the n8n notification workflow.
 */
export const declineRequest = mutation({
  args: {
    loanId: v.id("loans"),
    lenderNote: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const currentUser = await requireCurrentUser(ctx);
    const loan = await ctx.db.get(args.loanId);
    if (!loan) {
      throw new ValidationError("Loan request not found.");
    }

    assertCanReviewLoanRequest(currentUser, loan);

    const [tool, lender, borrower] = await Promise.all([
      ctx.db.get(loan.toolId),
      ctx.db.get(loan.lenderId),
      ctx.db.get(loan.borrowerId),
    ]);
    if (!tool || !lender || !borrower) {
      throw new ValidationError("Associated tool or users not found.");
    }

    const now = Date.now();
    const trimmedNote = args.lenderNote?.trim() || undefined;

    await ctx.db.patch(loan._id, {
      status: "declined",
      declinedAt: now,
      lenderNote: trimmedNote,
      lastAutomationSummary: "Decline notification queued for n8n",
      lastAutomationAt: now,
      updatedAt: now,
    });

    const updatedLoan = await ctx.db.get(loan._id);
    if (updatedLoan) {
      const eventId = `loan-declined:${loan._id}:${now}`;
      const payload = buildMinimizedLoanWebhookPayload({
        eventId,
        eventType: "loan.declined",
        loan: updatedLoan,
        tool,
        lender,
        borrower,
        occurredAtMs: now,
      });

      await ctx.scheduler.runAfter(0, internal.n8n.dispatchLoanWebhook, {
        loanId: loan._id,
        payload,
      });
    }

    return loan._id;
  },
});

/**
 * AUTHENTICATED MUTATION: Mark an active loan as returned.
 * Enforces RBAC (`assertCanMarkLoanReturned`), restores tool availability,
 * and triggers the n8n return confirmation notification.
 */
export const markReturned = mutation({
  args: {
    loanId: v.id("loans"),
    lenderNote: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const currentUser = await requireCurrentUser(ctx);
    const loan = await ctx.db.get(args.loanId);
    if (!loan) {
      throw new ValidationError("Loan not found.");
    }

    assertCanMarkLoanReturned(currentUser, loan);

    const [tool, lender, borrower] = await Promise.all([
      ctx.db.get(loan.toolId),
      ctx.db.get(loan.lenderId),
      ctx.db.get(loan.borrowerId),
    ]);

    const now = Date.now();
    const trimmedNote = args.lenderNote?.trim() || undefined;

    if (tool) {
      await ctx.db.patch(tool._id, {
        isAvailable: true,
        updatedAt: now,
      });
    }

    await ctx.db.patch(loan._id, {
      status: "returned",
      returnedAt: now,
      ...(trimmedNote ? { lenderNote: trimmedNote } : {}),
      lastAutomationSummary: "Return confirmation notification queued for n8n",
      lastAutomationAt: now,
      updatedAt: now,
    });

    const updatedLoan = await ctx.db.get(loan._id);
    if (updatedLoan && tool && lender && borrower) {
      const eventId = `loan-returned:${loan._id}:${now}`;
      const payload = buildMinimizedLoanWebhookPayload({
        eventId,
        eventType: "loan.returned",
        loan: updatedLoan,
        tool,
        lender,
        borrower,
        occurredAtMs: now,
      });

      await ctx.scheduler.runAfter(0, internal.n8n.dispatchLoanWebhook, {
        loanId: loan._id,
        payload,
      });
    }

    return loan._id;
  },
});
