import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export const TOOL_CATEGORIES = [
  "power tools",
  "garden",
  "kitchen",
  "camping",
  "hand tools",
  "automotive",
  "cleaning",
  "other",
] as const;

export const TOOL_CONDITIONS = [
  "New",
  "Like New",
  "Good",
  "Fair",
  "Well-Used",
] as const;

export const LOAN_STATUSES = [
  "pending",
  "approved",
  "declined",
  "returned",
] as const;

export const USER_ROLES = ["user", "admin"] as const;

export const toolCategoryValidator = v.union(
  v.literal("power tools"),
  v.literal("garden"),
  v.literal("kitchen"),
  v.literal("camping"),
  v.literal("hand tools"),
  v.literal("automotive"),
  v.literal("cleaning"),
  v.literal("other")
);

export const toolConditionValidator = v.union(
  v.literal("New"),
  v.literal("Like New"),
  v.literal("Good"),
  v.literal("Fair"),
  v.literal("Well-Used")
);

export const loanStatusValidator = v.union(
  v.literal("pending"),
  v.literal("approved"),
  v.literal("declined"),
  v.literal("returned")
);

export const userRoleValidator = v.union(
  v.literal("user"),
  v.literal("admin")
);

export default defineSchema({
  users: defineTable({
    clerkId: v.string(),
    email: v.string(),
    name: v.string(),
    role: userRoleValidator,
    isTrustedLender: v.boolean(),
    createdAt: v.number(),
  })
    .index("by_clerk_id", ["clerkId"])
    .index("by_email", ["email"])
    .index("by_role", ["role"]),

  tools: defineTable({
    name: v.string(),
    category: toolCategoryValidator,
    condition: toolConditionValidator,
    description: v.string(),
    ownerId: v.id("users"),
    isAvailable: v.boolean(),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_owner", ["ownerId"])
    .index("by_availability", ["isAvailable"])
    .index("by_category", ["category"])
    .index("by_category_and_availability", ["category", "isAvailable"]),

  loans: defineTable({
    toolId: v.id("tools"),
    lenderId: v.id("users"),
    borrowerId: v.id("users"),
    startDate: v.string(), // YYYY-MM-DD
    endDate: v.string(), // YYYY-MM-DD
    status: loanStatusValidator,
    borrowerNote: v.optional(v.string()),
    lenderNote: v.optional(v.string()),
    approvedAt: v.optional(v.number()),
    declinedAt: v.optional(v.number()),
    returnedAt: v.optional(v.number()),
    lastReminderSentAt: v.optional(v.number()),
    lastReminderDateKey: v.optional(v.string()),
    reminderCount: v.number(),
    lastAutomationSummary: v.optional(v.string()),
    lastAutomationAt: v.optional(v.number()),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_tool", ["toolId"])
    .index("by_lender", ["lenderId"])
    .index("by_borrower", ["borrowerId"])
    .index("by_status", ["status"]),

  automationEvents: defineTable({
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
    createdAt: v.number(),
  })
    .index("by_idempotency_key", ["idempotencyKey"])
    .index("by_loan", ["loanId"]),
});
