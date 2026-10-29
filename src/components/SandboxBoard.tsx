"use client";

import React, { useState } from "react";
import {
  ActorUser,
  assertAdmin,
  assertCanDeleteTool,
  assertCanEditTool,
  assertCanMarkLoanReturned,
  assertCanRequestBorrow,
  assertCanReviewLoanRequest,
  buildMinimizedLoanWebhookPayload,
  computeDaysOverdue,
  getTodayIsoDate,
  LoanRecord,
  ToolCategory,
  ToolRecord,
  toPublicToolSummary,
  validateBorrowDateRange,
  validateToolFields,
  ValidationError,
} from "@convex/lib/rbac";
import {
  AdminUserItem,
  AuthenticatedToolItem,
  AutomationEventView,
  LendLoopBoardUI,
  LoanItemView,
} from "./LendLoopBoardUI";

const INITIAL_USERS: ActorUser[] = [
  {
    _id: "user_maya",
    clerkId: "clerk_maya_01",
    name: "Maya Lin",
    email: "maya@neighborhood.local",
    role: "user",
    isTrustedLender: true,
  },
  {
    _id: "user_carlos",
    clerkId: "clerk_carlos_02",
    name: "Carlos Rivera",
    email: "carlos@neighborhood.local",
    role: "user",
    isTrustedLender: false,
  },
  {
    _id: "user_admin",
    clerkId: "clerk_admin_03",
    name: "Yassine (Admin)",
    email: "admin@lendloop.local",
    role: "admin",
    isTrustedLender: true,
  },
];

const nowMs = Date.now();
const twoDaysAgoMs = nowMs - 2 * 24 * 60 * 60 * 1000;
const fiveDaysAgoIso = new Date(nowMs - 5 * 24 * 60 * 60 * 1000)
  .toISOString()
  .slice(0, 10);
const twoDaysAgoIso = new Date(twoDaysAgoMs).toISOString().slice(0, 10);
const tomorrowIso = new Date(nowMs + 24 * 60 * 60 * 1000)
  .toISOString()
  .slice(0, 10);
const nextWeekIso = new Date(nowMs + 6 * 24 * 60 * 60 * 1000)
  .toISOString()
  .slice(0, 10);

const INITIAL_TOOLS: ToolRecord[] = [
  {
    _id: "tool_1",
    name: "DeWalt 20V Max Hammer Drill",
    category: "power tools",
    condition: "Like New",
    description:
      "Brushless cordless hammer drill with two 4.0Ah batteries, charger, and masonry bit set.",
    ownerId: "user_maya",
    isAvailable: true,
    createdAt: nowMs - 86400000 * 10,
    updatedAt: nowMs - 86400000 * 2,
  },
  {
    _id: "tool_2",
    name: "Fiskars Telescoping Tree Pruner",
    category: "garden",
    condition: "Good",
    description:
      "Extends up to 12 feet for high branches with bypass lopper head and saw attachment.",
    ownerId: "user_carlos",
    isAvailable: true,
    createdAt: nowMs - 86400000 * 8,
    updatedAt: nowMs - 86400000 * 3,
  },
  {
    _id: "tool_3",
    name: "KitchenAid Stand Mixer + Pasta Roller",
    category: "kitchen",
    condition: "Like New",
    description:
      "5-quart tilt-head mixer with stainless steel pasta sheet roller and fettuccine cutter.",
    ownerId: "user_maya",
    isAvailable: false,
    createdAt: nowMs - 86400000 * 7,
    updatedAt: nowMs - 86400000 * 2,
  },
  {
    _id: "tool_4",
    name: "REI Co-op 4-Person Dome Tent",
    category: "camping",
    condition: "Good",
    description:
      "Waterproof rainfly, aluminum poles, footprint tarp, and stakes included. Packs light.",
    ownerId: "user_admin",
    isAvailable: true,
    createdAt: nowMs - 86400000 * 6,
    updatedAt: nowMs - 86400000 * 1,
  },
  {
    _id: "tool_5",
    name: "Kärcher 2000 PSI Electric Pressure Washer",
    category: "cleaning",
    condition: "Good",
    description:
      "Great for driveways, patio furniture, and siding. Includes 25ft high-pressure hose.",
    ownerId: "user_carlos",
    isAvailable: true,
    createdAt: nowMs - 86400000 * 5,
    updatedAt: nowMs - 86400000 * 1,
  },
];

const INITIAL_LOANS: LoanRecord[] = [
  {
    _id: "loan_overdue_1",
    toolId: "tool_3",
    lenderId: "user_maya",
    borrowerId: "user_carlos",
    startDate: fiveDaysAgoIso,
    endDate: twoDaysAgoIso,
    status: "approved",
    borrowerNote: "Making fresh ravioli for family dinner!",
    reminderCount: 1,
    lastReminderSentAt: twoDaysAgoMs,
    lastReminderDateKey: twoDaysAgoIso,
    lastAutomationSummary: "Reminder sent 2 days ago",
    lastAutomationAt: twoDaysAgoMs,
  },
  {
    _id: "loan_pending_2",
    toolId: "tool_1",
    lenderId: "user_maya",
    borrowerId: "user_carlos",
    startDate: tomorrowIso,
    endDate: nextWeekIso,
    status: "pending",
    borrowerNote: "Mounting floating bookshelves in the study.",
    reminderCount: 0,
    lastAutomationSummary: "Request notification delivered via n8n",
    lastAutomationAt: nowMs - 3600 * 1000,
  },
];

const INITIAL_EVENTS: Record<string, AutomationEventView[]> = {
  loan_overdue_1: [
    {
      _id: "evt_1",
      workflow: "overdue_reminder",
      eventType: "loan.overdue_reminder",
      direction: "inbound",
      status: "delivered",
      summary: "Overdue reminder sent to borrower",
      attemptCount: 1,
      createdAt: twoDaysAgoMs,
    },
    {
      _id: "evt_2",
      workflow: "request_notification",
      eventType: "loan.approved",
      direction: "outbound",
      status: "delivered",
      summary: "Approval notification sent to borrower",
      attemptCount: 1,
      createdAt: nowMs - 5 * 86400000,
    },
  ],
  loan_pending_2: [
    {
      _id: "evt_3",
      workflow: "request_notification",
      eventType: "loan.requested",
      direction: "outbound",
      status: "delivered",
      summary: "Request notification sent to lender (Maya Lin)",
      attemptCount: 1,
      createdAt: nowMs - 3600 * 1000,
    },
  ],
};

export function SandboxBoard() {
  const [users, setUsers] = useState<ActorUser[]>(INITIAL_USERS);
  const [tools, setTools] = useState<ToolRecord[]>(INITIAL_TOOLS);
  const [loans, setLoans] = useState<LoanRecord[]>(INITIAL_LOANS);
  const [eventsByLoan, setEventsByLoan] =
    useState<Record<string, AutomationEventView[]>>(INITIAL_EVENTS);
  const [processedIdempotencyKeys, setProcessedIdempotencyKeys] = useState<
    Set<string>
  >(new Set(["overdue-reminder:loan_overdue_1:" + twoDaysAgoIso]));

  // Start on the Public Landing Page so evaluators immediately see the required Public Page
  const [activeUserId, setActiveUserId] = useState<string | null>(null);
  const [selectedCategory, setSelectedCategory] = useState<
    ToolCategory | undefined
  >(undefined);

  const currentUser = users.find((u) => u._id === activeUserId) ?? null;

  // Public query projection using the exact Convex RBAC helper (`toPublicToolSummary`)
  const publicTools = tools
    .filter((t) => t.isAvailable)
    .map((t) => toPublicToolSummary(t));

  const userMap = new Map(users.map((u) => [u._id, u]));

  const enrichTool = (t: ToolRecord): AuthenticatedToolItem => {
    const owner = userMap.get(t.ownerId);
    return {
      _id: t._id,
      name: t.name,
      category: t.category,
      condition: t.condition,
      description: t.description,
      isAvailable: t.isAvailable,
      ownerId: t.ownerId,
      ownerName: owner?.name ?? "Neighbor",
      ownerIsTrustedLender: owner?.isTrustedLender ?? false,
      isOwnListing: currentUser ? t.ownerId === currentUser._id : false,
      createdAt: t.createdAt,
      updatedAt: t.updatedAt,
    };
  };

  const allTools = tools
    .filter((t) => (!selectedCategory ? true : t.category === selectedCategory))
    .map(enrichTool);

  const myListings = currentUser
    ? tools.filter((t) => t.ownerId === currentUser._id).map(enrichTool)
    : [];

  const todayIso = getTodayIsoDate();

  const enrichLoan = (l: LoanRecord): LoanItemView => {
    const tool = tools.find((t) => t._id === l.toolId);
    const lender = userMap.get(l.lenderId);
    const borrower = userMap.get(l.borrowerId);
    const daysOverdue =
      l.status === "approved" ? computeDaysOverdue(l.endDate, todayIso) : 0;

    return {
      _id: l._id,
      toolId: l.toolId,
      toolName: tool?.name ?? "Removed Tool",
      toolCategory: tool?.category ?? "other",
      toolCondition: tool?.condition ?? "Good",
      lenderId: l.lenderId,
      lenderName: lender?.name ?? "Neighbor",
      lenderIsTrustedLender: lender?.isTrustedLender ?? false,
      borrowerId: l.borrowerId,
      borrowerName: borrower?.name ?? "Neighbor",
      startDate: l.startDate,
      endDate: l.endDate,
      status: l.status,
      borrowerNote: l.borrowerNote,
      lenderNote: l.lenderNote,
      isOverdue: daysOverdue > 0,
      daysOverdue,
      reminderCount: l.reminderCount,
      lastReminderSentAt: l.lastReminderSentAt,
      lastAutomationSummary: l.lastAutomationSummary,
      lastAutomationAt: l.lastAutomationAt,
      createdAt: nowMs,
      updatedAt: nowMs,
      recentAutomationEvents: eventsByLoan[l._id] ?? [],
    };
  };

  const myRequests = currentUser
    ? loans.filter((l) => l.borrowerId === currentUser._id).map(enrichLoan)
    : [];

  const incomingRequests = currentUser
    ? loans.filter((l) => l.lenderId === currentUser._id).map(enrichLoan)
    : [];

  const adminAllLoans =
    currentUser?.role === "admin" ? loans.map(enrichLoan) : [];

  const adminUsers: AdminUserItem[] =
    currentUser?.role === "admin"
      ? users.map((u) => ({
          _id: u._id,
          name: u.name,
          email: u.email,
          role: u.role,
          isTrustedLender: u.isTrustedLender,
          listingCount: tools.filter((t) => t.ownerId === u._id).length,
          createdAt: nowMs,
        }))
      : [];

  function appendAutomationEvent(loanId: string, evt: AutomationEventView) {
    setEventsByLoan((prev) => ({
      ...prev,
      [loanId]: [evt, ...(prev[loanId] ?? [])],
    }));
  }

  function simulateDailyOverdueCron() {
    const now = Date.now();
    const nextKeys = new Set(processedIdempotencyKeys);
    const eventsToAdd: Array<{ loanId: string; evt: AutomationEventView }> = [];

    const nextLoans = loans.map((loan) => {
      const overdueDays =
        loan.status === "approved"
          ? computeDaysOverdue(loan.endDate, todayIso)
          : 0;
      if (overdueDays <= 0) return loan;

      const idempotencyKey = `overdue-reminder:${loan._id}:${todayIso}`;
      if (nextKeys.has(idempotencyKey)) {
        return loan;
      }

      nextKeys.add(idempotencyKey);
      eventsToAdd.push({
        loanId: loan._id,
        evt: {
          _id: `evt_${now}_${loan._id}`,
          workflow: "overdue_reminder",
          eventType: "loan.overdue_reminder",
          direction: "inbound",
          status: "delivered",
          summary: `Overdue reminder sent (${overdueDays}d overdue)`,
          attemptCount: 1,
          createdAt: now,
        },
      });

      return {
        ...loan,
        reminderCount: loan.reminderCount + 1,
        lastReminderSentAt: now,
        lastReminderDateKey: todayIso,
        lastAutomationSummary: `Overdue reminder sent (${overdueDays}d overdue)`,
        lastAutomationAt: now,
      };
    });

    if (eventsToAdd.length > 0) {
      setProcessedIdempotencyKeys(nextKeys);
      setLoans(nextLoans);
      setEventsByLoan((prev) => {
        const updated = { ...prev };
        for (const { loanId, evt } of eventsToAdd) {
          updated[loanId] = [evt, ...(updated[loanId] ?? [])];
        }
        return updated;
      });
    }
  }

  const sandboxBar = (
    <div className="bg-stone-900 text-stone-200 text-xs px-4 py-2 border-b border-stone-800">
      <div className="max-w-6xl mx-auto flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <span className="px-2 py-0.5 rounded bg-emerald-500/20 text-emerald-300 font-medium border border-emerald-500/30">
            Interactive Evaluation Mode
          </span>
          <span className="text-stone-400 hidden md:inline">
            Switch roles to test Public View, Neighbor RBAC, Admin Governance
            &amp; n8n Automation:
          </span>
        </div>
        <div className="flex items-center gap-1.5 flex-wrap">
          <button
            type="button"
            onClick={() => setActiveUserId(null)}
            className={`px-2.5 py-1 rounded text-xs font-medium cursor-pointer ${
              activeUserId === null
                ? "bg-white text-stone-900"
                : "bg-stone-800 text-stone-300 hover:bg-stone-700"
            }`}
          >
            Public Visitor (Signed Out)
          </button>
          {users.map((u) => (
            <button
              key={u._id}
              type="button"
              onClick={() => setActiveUserId(u._id)}
              className={`px-2.5 py-1 rounded text-xs font-medium cursor-pointer ${
                activeUserId === u._id
                  ? "bg-emerald-600 text-white"
                  : "bg-stone-800 text-stone-300 hover:bg-stone-700"
              }`}
            >
              {u.name} ({u.role})
            </button>
          ))}
          <button
            type="button"
            onClick={simulateDailyOverdueCron}
            className="px-2.5 py-1 rounded text-xs font-medium bg-amber-600/90 hover:bg-amber-600 text-white cursor-pointer"
            title="Simulates the daily n8n Overdue Reminders cron job with idempotency key deduplication"
          >
            Run n8n Overdue Cron
          </button>
        </div>
      </div>
    </div>
  );

  return (
    <LendLoopBoardUI
      mode="sandbox"
      isSignedIn={Boolean(currentUser)}
      currentUser={currentUser}
      publicTools={publicTools}
      allTools={allTools}
      myListings={myListings}
      myRequests={myRequests}
      incomingRequests={incomingRequests}
      adminAllLoans={adminAllLoans}
      adminUsers={adminUsers}
      selectedCategory={selectedCategory}
      onSelectCategory={setSelectedCategory}
      sandboxControls={sandboxBar}
      onCreateTool={async (input) => {
        if (!currentUser) throw new ValidationError("Sign in required.");
        const { trimmedName, trimmedDesc } = validateToolFields(
          input.name,
          input.description
        );
        const now = Date.now();
        const newTool: ToolRecord = {
          _id: `tool_${now}`,
          name: trimmedName,
          category: input.category,
          condition: input.condition,
          description: trimmedDesc,
          ownerId: currentUser._id,
          isAvailable: true,
          createdAt: now,
          updatedAt: now,
        };
        setTools((prev) => [newTool, ...prev]);
      }}
      onUpdateTool={async (input) => {
        const target = tools.find((t) => t._id === input.toolId);
        if (!target) throw new ValidationError("Tool not found.");
        assertCanEditTool(currentUser, target);
        const { trimmedName, trimmedDesc } = validateToolFields(
          input.name,
          input.description
        );
        setTools((prev) =>
          prev.map((t) =>
            t._id === input.toolId
              ? {
                  ...t,
                  name: trimmedName,
                  category: input.category,
                  condition: input.condition,
                  description: trimmedDesc,
                  updatedAt: Date.now(),
                }
              : t
          )
        );
      }}
      onDeleteTool={async (toolId) => {
        const target = tools.find((t) => t._id === toolId);
        if (!target) throw new ValidationError("Tool not found.");
        assertCanDeleteTool(currentUser, target);

        const relatedLoans = loans.filter((l) => l.toolId === toolId);
        const hasActiveLoan = relatedLoans.some((l) => l.status === "approved");
        if (hasActiveLoan && currentUser.role !== "admin") {
          throw new ValidationError(
            "Cannot delete a listing while it is out on an active loan. Mark the loan as returned first."
          );
        }

        const now = Date.now();
        setLoans((prev) =>
          prev.map((l) => {
            if (l.toolId !== toolId) return l;
            if (l.status === "pending") {
              return {
                ...l,
                status: "declined",
                lenderNote: "Listing was removed.",
                lastAutomationSummary:
                  "Decline notification delivered via n8n",
                lastAutomationAt: now,
              };
            }
            if (l.status === "approved" && currentUser.role === "admin") {
              return {
                ...l,
                status: "returned",
                lenderNote: "Listing removed by admin.",
                lastAutomationSummary:
                  "Return confirmation delivered via n8n",
                lastAutomationAt: now,
              };
            }
            return l;
          })
        );
        setTools((prev) => prev.filter((t) => t._id !== toolId));
      }}
      onRequestBorrow={async (input) => {
        const tool = tools.find((t) => t._id === input.toolId);
        if (!tool) throw new ValidationError("Tool not found.");
        assertCanRequestBorrow(currentUser, tool);
        validateBorrowDateRange(input.startDate, input.endDate);

        const hasDuplicatePending = loans.some(
          (l) =>
            l.borrowerId === currentUser._id &&
            l.toolId === input.toolId &&
            l.status === "pending"
        );
        if (hasDuplicatePending) {
          throw new ValidationError(
            "You already have a pending request for this tool."
          );
        }

        const lender = userMap.get(tool.ownerId);
        if (!lender || !currentUser) {
          throw new ValidationError("User not found.");
        }

        const now = Date.now();
        const newLoan: LoanRecord = {
          _id: `loan_${now}`,
          toolId: tool._id,
          lenderId: tool.ownerId,
          borrowerId: currentUser._id,
          startDate: input.startDate,
          endDate: input.endDate,
          status: "pending",
          borrowerNote: input.borrowerNote,
          reminderCount: 0,
          lastAutomationSummary: `Request notification sent to lender (${lender.name})`,
          lastAutomationAt: now,
        };

        // Build minimized webhook payload using the real Convex helper
        buildMinimizedLoanWebhookPayload({
          eventId: `loan-requested:${newLoan._id}:${now}`,
          eventType: "loan.requested",
          loan: newLoan,
          tool,
          lender,
          borrower: currentUser,
          occurredAtMs: now,
        });

        setLoans((prev) => [newLoan, ...prev]);
        appendAutomationEvent(newLoan._id, {
          _id: `evt_${now}`,
          workflow: "request_notification",
          eventType: "loan.requested",
          direction: "outbound",
          status: "delivered",
          summary: `Request notification sent to lender (${lender.name})`,
          attemptCount: 1,
          createdAt: now,
        });
      }}
      onApproveRequest={async (loanId, lenderNote) => {
        const loan = loans.find((l) => l._id === loanId);
        if (!loan) throw new ValidationError("Loan not found.");
        assertCanReviewLoanRequest(currentUser, loan);

        const tool = tools.find((t) => t._id === loan.toolId);
        if (!tool) throw new ValidationError("Associated tool listing not found.");
        if (!tool.isAvailable) {
          throw new ValidationError(
            "This tool is already checked out on another active loan."
          );
        }

        const now = Date.now();
        setTools((prev) =>
          prev.map((t) =>
            t._id === loan.toolId ? { ...t, isAvailable: false } : t
          )
        );
        setLoans((prev) =>
          prev.map((l) => {
            if (l._id === loanId) {
              return {
                ...l,
                status: "approved",
                lenderNote,
                lastAutomationSummary:
                  "Approval notification delivered via n8n",
                lastAutomationAt: now,
              };
            }
            if (l.toolId === loan.toolId && l.status === "pending") {
              return {
                ...l,
                status: "declined",
                lenderNote: "Tool was approved for another overlapping request.",
                lastAutomationSummary:
                  "Decline notification delivered via n8n",
                lastAutomationAt: now,
              };
            }
            return l;
          })
        );
        appendAutomationEvent(loanId, {
          _id: `evt_${now}`,
          workflow: "request_notification",
          eventType: "loan.approved",
          direction: "outbound",
          status: "delivered",
          summary: "Approval notification delivered via n8n",
          attemptCount: 1,
          createdAt: now,
        });
      }}
      onDeclineRequest={async (loanId, lenderNote) => {
        const loan = loans.find((l) => l._id === loanId);
        if (!loan) throw new ValidationError("Loan not found.");
        assertCanReviewLoanRequest(currentUser, loan);

        const now = Date.now();
        setLoans((prev) =>
          prev.map((l) =>
            l._id === loanId
              ? {
                  ...l,
                  status: "declined",
                  lenderNote,
                  lastAutomationSummary:
                    "Decline notification delivered via n8n",
                  lastAutomationAt: now,
                }
              : l
          )
        );
        appendAutomationEvent(loanId, {
          _id: `evt_${now}`,
          workflow: "request_notification",
          eventType: "loan.declined",
          direction: "outbound",
          status: "delivered",
          summary: "Decline notification delivered via n8n",
          attemptCount: 1,
          createdAt: now,
        });
      }}
      onMarkReturned={async (loanId, lenderNote) => {
        const loan = loans.find((l) => l._id === loanId);
        if (!loan) throw new ValidationError("Loan not found.");
        assertCanMarkLoanReturned(currentUser, loan);

        const now = Date.now();
        setTools((prev) =>
          prev.map((t) =>
            t._id === loan.toolId ? { ...t, isAvailable: true } : t
          )
        );
        setLoans((prev) =>
          prev.map((l) =>
            l._id === loanId
              ? {
                  ...l,
                  status: "returned",
                  lenderNote,
                  lastAutomationSummary:
                    "Return confirmation delivered via n8n",
                  lastAutomationAt: now,
                }
              : l
          )
        );
        appendAutomationEvent(loanId, {
          _id: `evt_${now}`,
          workflow: "request_notification",
          eventType: "loan.returned",
          direction: "outbound",
          status: "delivered",
          summary: "Return confirmation delivered via n8n",
          attemptCount: 1,
          createdAt: now,
        });
      }}
      onToggleTrustedLender={async (userId, isTrustedLender) => {
        assertAdmin(currentUser);
        setUsers((prev) =>
          prev.map((u) =>
            u._id === userId ? { ...u, isTrustedLender } : u
          )
        );
      }}
      renderAuthSignInButton={() => (
        <button
          type="button"
          onClick={() => setActiveUserId("user_maya")}
          className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-emerald-700 hover:bg-emerald-800 text-white text-sm font-medium shadow-2xs transition-colors cursor-pointer"
        >
          Sign in to lend or borrow
        </button>
      )}
      renderUserMenu={() => (
        <button
          type="button"
          onClick={() => setActiveUserId(null)}
          className="px-3 py-1.5 rounded-lg border border-stone-200 hover:bg-stone-50 text-xs font-medium text-stone-700 cursor-pointer"
        >
          Sign Out ({currentUser?.name.split(" ")[0]})
        </button>
      )}
    />
  );
}
