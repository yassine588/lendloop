/**
 * Role-Based Access Control (RBAC), data-minimization projections,
 * and domain validation rules enforced across all Convex queries and mutations.
 */

export type Role = "user" | "admin";
export type LoanStatus = "pending" | "approved" | "declined" | "returned";
export type ToolCategory =
  | "power tools"
  | "garden"
  | "kitchen"
  | "camping"
  | "hand tools"
  | "automotive"
  | "cleaning"
  | "other";
export type ToolCondition =
  | "New"
  | "Like New"
  | "Good"
  | "Fair"
  | "Well-Used";

export interface ActorUser {
  _id: string;
  clerkId: string;
  email: string;
  name: string;
  role: Role;
  isTrustedLender: boolean;
}

export interface ToolRecord {
  _id: string;
  name: string;
  category: ToolCategory;
  condition: ToolCondition;
  description: string;
  ownerId: string;
  isAvailable: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface LoanRecord {
  _id: string;
  toolId: string;
  lenderId: string;
  borrowerId: string;
  startDate: string;
  endDate: string;
  status: LoanStatus;
  borrowerNote?: string;
  lenderNote?: string;
  reminderCount: number;
  lastReminderSentAt?: number;
  lastReminderDateKey?: string;
  lastAutomationSummary?: string;
  lastAutomationAt?: number;
}

export class AuthorizationError extends Error {
  public readonly code = "FORBIDDEN";
  constructor(message: string) {
    super(message);
    this.name = "AuthorizationError";
  }
}

export class UnauthenticatedError extends Error {
  public readonly code = "UNAUTHENTICATED";
  constructor(message = "Authentication required. Please sign in.") {
    super(message);
    this.name = "UnauthenticatedError";
  }
}

export class ValidationError extends Error {
  public readonly code = "BAD_REQUEST";
  constructor(message: string) {
    super(message);
    this.name = "ValidationError";
  }
}

export function assertAuthenticated(
  user: ActorUser | null | undefined
): asserts user is ActorUser {
  if (!user) {
    throw new UnauthenticatedError();
  }
}

export function assertAdmin(
  user: ActorUser | null | undefined
): asserts user is ActorUser {
  assertAuthenticated(user);
  if (user.role !== "admin") {
    throw new AuthorizationError(
      "Admin privileges are required to perform this action."
    );
  }
}

/**
 * Only the owner can edit a tool listing's details.
 */
export function assertCanEditTool(user: ActorUser | null, tool: ToolRecord): void {
  assertAuthenticated(user);
  if (tool.ownerId !== user._id) {
    throw new AuthorizationError(
      "You can only edit your own tool listings."
    );
  }
}

/**
 * Users can delete only their own listings; admins can remove any listing.
 */
export function assertCanDeleteTool(user: ActorUser | null, tool: ToolRecord): void {
  assertAuthenticated(user);
  if (user.role !== "admin" && tool.ownerId !== user._id) {
    throw new AuthorizationError(
      "You can only delete your own tool listings unless you are an admin."
    );
  }
}

/**
 * Only a signed-in user who does NOT own the tool can request to borrow it,
 * and the tool must currently be available.
 */
export function assertCanRequestBorrow(
  user: ActorUser | null,
  tool: ToolRecord
): void {
  assertAuthenticated(user);
  if (tool.ownerId === user._id) {
    throw new ValidationError("You cannot request to borrow your own tool.");
  }
  if (!tool.isAvailable) {
    throw new ValidationError(
      "This tool is currently borrowed and unavailable for new requests."
    );
  }
}

/**
 * Only the tool owner (lender) can approve or decline a pending borrow request on their tool.
 */
export function assertCanReviewLoanRequest(
  user: ActorUser | null,
  loan: LoanRecord
): void {
  assertAuthenticated(user);
  if (loan.lenderId !== user._id) {
    throw new AuthorizationError(
      "Only the tool owner can approve or decline requests for their tool."
    );
  }
  if (loan.status !== "pending") {
    throw new ValidationError(
      `Cannot review a request whose status is '${loan.status}'. Only 'pending' requests can be approved or declined.`
    );
  }
}

/**
 * Only the tool owner (lender) or an admin can mark an active ('approved') loan as returned.
 */
export function assertCanMarkLoanReturned(
  user: ActorUser | null,
  loan: LoanRecord
): void {
  assertAuthenticated(user);
  if (loan.lenderId !== user._id && user.role !== "admin") {
    throw new AuthorizationError(
      "Only the tool owner or an admin can mark a loan as returned."
    );
  }
  if (loan.status !== "approved") {
    throw new ValidationError(
      `Only active ('approved') loans can be marked as returned (current status: '${loan.status}').`
    );
  }
}

const ISO_DATE_REGEX = /^\d{4}-\d{2}-\d{2}$/;

export function isValidIsoDateString(dateStr: string): boolean {
  if (!ISO_DATE_REGEX.test(dateStr)) {
    return false;
  }
  const [y, m, d] = dateStr.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return (
    dt.getUTCFullYear() === y &&
    dt.getUTCMonth() === m - 1 &&
    dt.getUTCDate() === d
  );
}

export function getTodayIsoDate(nowMs: number = Date.now()): string {
  return new Date(nowMs).toISOString().slice(0, 10);
}

/**
 * Validates borrow date range (YYYY-MM-DD).
 */
export function validateBorrowDateRange(
  startDate: string,
  endDate: string,
  todayIso: string = getTodayIsoDate()
): void {
  if (!isValidIsoDateString(startDate) || !isValidIsoDateString(endDate)) {
    throw new ValidationError(
      "Start date and end date must be valid calendar dates in YYYY-MM-DD format."
    );
  }
  if (startDate > endDate) {
    throw new ValidationError(
      "End date must be on or after the start date."
    );
  }
  if (endDate < todayIso) {
    throw new ValidationError(
      "Borrow end date cannot be in the past."
    );
  }
}

/**
 * Computes how many days a loan is overdue relative to `todayIso` (YYYY-MM-DD).
 * Returns 0 if not overdue.
 */
export function computeDaysOverdue(
  endDate: string,
  todayIso: string = getTodayIsoDate()
): number {
  if (!isValidIsoDateString(endDate) || !isValidIsoDateString(todayIso)) {
    return 0;
  }
  if (endDate >= todayIso) {
    return 0;
  }
  const endMs = Date.parse(`${endDate}T00:00:00Z`);
  const todayMs = Date.parse(`${todayIso}T00:00:00Z`);
  const diffDays = Math.round((todayMs - endMs) / (1000 * 60 * 60 * 24));
  return Math.max(0, diffDays);
}

/**
 * Data minimization for the unauthenticated public landing page:
 * Exposes ONLY `_id`, `name`, and `category` of available tools.
 * Never leaks ownerId, owner email/name, condition, description, or timestamps.
 */
export interface PublicToolSummary {
  _id: string;
  name: string;
  category: ToolCategory;
}

export function toPublicToolSummary(tool: ToolRecord): PublicToolSummary {
  return {
    _id: tool._id,
    name: tool.name,
    category: tool.category,
  };
}

/**
 * Data minimization for outbound n8n Request Notification webhook payloads:
 * Includes ONLY the fields required by n8n to notify the target user and log activity.
 * Never includes Clerk IDs, internal user IDs, or non-essential profile data.
 */
export interface MinimizedLoanWebhookPayload {
  eventId: string;
  eventType:
    | "loan.requested"
    | "loan.approved"
    | "loan.declined"
    | "loan.returned";
  loanId: string;
  toolName: string;
  toolCategory: ToolCategory;
  status: LoanStatus;
  startDate: string;
  endDate: string;
  recipientRole: "lender" | "borrower";
  recipientName: string;
  recipientEmail: string;
  counterpartyName: string;
  note?: string;
  occurredAt: string;
}

export function buildMinimizedLoanWebhookPayload(params: {
  eventId: string;
  eventType: MinimizedLoanWebhookPayload["eventType"];
  loan: LoanRecord;
  tool: Pick<ToolRecord, "name" | "category">;
  lender: Pick<ActorUser, "name" | "email">;
  borrower: Pick<ActorUser, "name" | "email">;
  occurredAtMs?: number;
}): MinimizedLoanWebhookPayload {
  const {
    eventId,
    eventType,
    loan,
    tool,
    lender,
    borrower,
    occurredAtMs = Date.now(),
  } = params;

  // When a borrow request is created ("loan.requested"), notify the lender.
  // When a request is approved/declined/returned, notify the borrower.
  const notifyLender = eventType === "loan.requested";
  const recipient = notifyLender ? lender : borrower;
  const counterparty = notifyLender ? borrower : lender;

  return {
    eventId,
    eventType,
    loanId: loan._id,
    toolName: tool.name,
    toolCategory: tool.category,
    status: loan.status,
    startDate: loan.startDate,
    endDate: loan.endDate,
    recipientRole: notifyLender ? "lender" : "borrower",
    recipientName: recipient.name,
    recipientEmail: recipient.email,
    counterpartyName: counterparty.name,
    ...(notifyLender && loan.borrowerNote
      ? { note: loan.borrowerNote }
      : !notifyLender && loan.lenderNote
      ? { note: loan.lenderNote }
      : {}),
    occurredAt: new Date(occurredAtMs).toISOString(),
  };
}

/**
 * Data minimization for the Overdue Loans HTTP endpoint consumed by n8n:
 * Returns ONLY the fields needed by the daily reminder workflow.
 */
export interface MinimizedOverdueLoanItem {
  loanId: string;
  toolName: string;
  toolCategory: ToolCategory;
  borrowerName: string;
  borrowerEmail: string;
  lenderName: string;
  startDate: string;
  endDate: string;
  daysOverdue: number;
  reminderCount: number;
  idempotencyKey: string;
}

export function buildMinimizedOverdueLoanItem(params: {
  loan: LoanRecord;
  tool: Pick<ToolRecord, "name" | "category">;
  borrower: Pick<ActorUser, "name" | "email">;
  lender: Pick<ActorUser, "name">;
  todayIso: string;
}): MinimizedOverdueLoanItem {
  const { loan, tool, borrower, lender, todayIso } = params;
  return {
    loanId: loan._id,
    toolName: tool.name,
    toolCategory: tool.category,
    borrowerName: borrower.name,
    borrowerEmail: borrower.email,
    lenderName: lender.name,
    startDate: loan.startDate,
    endDate: loan.endDate,
    daysOverdue: computeDaysOverdue(loan.endDate, todayIso),
    reminderCount: loan.reminderCount,
    idempotencyKey: `overdue-reminder:${loan._id}:${todayIso}`,
  };
}
