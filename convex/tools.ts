import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import { internal } from "./_generated/api";
import {
  toolCategoryValidator,
  toolConditionValidator,
} from "./schema";
import {
  assertCanDeleteTool,
  assertCanEditTool,
  buildMinimizedLoanWebhookPayload,
  toPublicToolSummary,
  validateToolFields,
  ValidationError,
} from "./lib/rbac";
import { requireCurrentUser } from "./users";

/**
 * PUBLIC QUERY: Read-only list of available tools for the unauthenticated landing page.
 * Data Minimization: Strictly projects ONLY `_id`, `name`, and `category`.
 * No owner details, descriptions, conditions, or internal IDs are ever returned.
 */
export const listPublicAvailable = query({
  args: {},
  handler: async (ctx) => {
    const availableTools = await ctx.db
      .query("tools")
      .withIndex("by_availability", (q) => q.eq("isAvailable", true))
      .order("desc")
      .collect();

    return availableTools.map((tool) => toPublicToolSummary(tool));
  },
});

/**
 * AUTHENTICATED QUERY: Lists all tools with availability status, filterable by category.
 * Enriches each tool with owner's display name and "Trusted Lender" badge status
 * without exposing private emails or Clerk identifiers.
 */
export const listAll = query({
  args: {
    category: v.optional(toolCategoryValidator),
  },
  handler: async (ctx, args) => {
    const currentUser = await requireCurrentUser(ctx);

    const tools = args.category
      ? await ctx.db
          .query("tools")
          .withIndex("by_category", (q) => q.eq("category", args.category!))
          .order("desc")
          .collect()
      : await ctx.db.query("tools").order("desc").collect();

    const ownerIds = Array.from(new Set(tools.map((t) => t.ownerId)));
    const ownerDocs = await Promise.all(ownerIds.map((id) => ctx.db.get(id)));
    const ownerMap = new Map(
      ownerDocs
        .filter((u): u is NonNullable<typeof u> => u !== null)
        .map((u) => [u._id, u])
    );

    return tools.map((tool) => {
      const owner = ownerMap.get(tool.ownerId);
      return {
        _id: tool._id,
        name: tool.name,
        category: tool.category,
        condition: tool.condition,
        description: tool.description,
        isAvailable: tool.isAvailable,
        ownerId: tool.ownerId,
        ownerName: owner?.name ?? "Neighbor",
        ownerIsTrustedLender: owner?.isTrustedLender ?? false,
        isOwnListing: tool.ownerId === currentUser._id,
        createdAt: tool.createdAt,
        updatedAt: tool.updatedAt,
      };
    });
  },
});

/**
 * AUTHENTICATED QUERY: Lists only the signed-in user's own tool listings ("My listings").
 */
export const listMyListings = query({
  args: {},
  handler: async (ctx) => {
    const currentUser = await requireCurrentUser(ctx);

    return await ctx.db
      .query("tools")
      .withIndex("by_owner", (q) => q.eq("ownerId", currentUser._id))
      .order("desc")
      .collect();
  },
});

/**
 * AUTHENTICATED MUTATION: Create a new tool listing.
 */
export const createTool = mutation({
  args: {
    name: v.string(),
    category: toolCategoryValidator,
    condition: toolConditionValidator,
    description: v.string(),
  },
  handler: async (ctx, args) => {
    const currentUser = await requireCurrentUser(ctx);
    const { trimmedName, trimmedDesc } = validateToolFields(
      args.name,
      args.description
    );

    const now = Date.now();
    const toolId = await ctx.db.insert("tools", {
      name: trimmedName,
      category: args.category,
      condition: args.condition,
      description: trimmedDesc,
      ownerId: currentUser._id,
      isAvailable: true,
      createdAt: now,
      updatedAt: now,
    });

    return toolId;
  },
});

/**
 * AUTHENTICATED MUTATION: Edit an existing tool listing.
 * RBAC: Only the owner of the listing can edit it (`assertCanEditTool`).
 */
export const updateTool = mutation({
  args: {
    toolId: v.id("tools"),
    name: v.string(),
    category: toolCategoryValidator,
    condition: toolConditionValidator,
    description: v.string(),
  },
  handler: async (ctx, args) => {
    const currentUser = await requireCurrentUser(ctx);
    const tool = await ctx.db.get(args.toolId);
    if (!tool) {
      throw new ValidationError("Tool listing not found.");
    }

    assertCanEditTool(currentUser, tool);

    const { trimmedName, trimmedDesc } = validateToolFields(
      args.name,
      args.description
    );

    await ctx.db.patch(args.toolId, {
      name: trimmedName,
      category: args.category,
      condition: args.condition,
      description: trimmedDesc,
      updatedAt: Date.now(),
    });

    return args.toolId;
  },
});

/**
 * AUTHENTICATED MUTATION: Remove a tool listing.
 * RBAC: Users can delete only their own listings; admins can remove ANY listing (`assertCanDeleteTool`).
 */
export const deleteTool = mutation({
  args: {
    toolId: v.id("tools"),
  },
  handler: async (ctx, args) => {
    const currentUser = await requireCurrentUser(ctx);
    const tool = await ctx.db.get(args.toolId);
    if (!tool) {
      throw new ValidationError("Tool listing not found.");
    }

    assertCanDeleteTool(currentUser, tool);

    const relatedLoans = await ctx.db
      .query("loans")
      .withIndex("by_tool", (q) => q.eq("toolId", args.toolId))
      .collect();

    const hasActiveLoan = relatedLoans.some((l) => l.status === "approved");
    if (hasActiveLoan && currentUser.role !== "admin") {
      throw new ValidationError(
        "Cannot delete a listing while it is out on an active loan. Mark the loan as returned first."
      );
    }

    // Automatically decline any still-pending requests (and close active loans if admin-removed)
    const now = Date.now();
    const lender = await ctx.db.get(tool.ownerId);

    for (const loan of relatedLoans) {
      if (loan.status === "pending") {
        await ctx.db.patch(loan._id, {
          status: "declined",
          declinedAt: now,
          lenderNote: "Listing was removed.",
          lastAutomationSummary: "Decline notification queued for n8n",
          lastAutomationAt: now,
          updatedAt: now,
        });

        const borrower = await ctx.db.get(loan.borrowerId);
        const updatedLoan = await ctx.db.get(loan._id);
        if (lender && borrower && updatedLoan) {
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
      } else if (loan.status === "approved" && currentUser.role === "admin") {
        await ctx.db.patch(loan._id, {
          status: "returned",
          returnedAt: now,
          lenderNote: "Listing removed by admin.",
          lastAutomationSummary: "Return confirmation notification queued for n8n",
          lastAutomationAt: now,
          updatedAt: now,
        });

        const borrower = await ctx.db.get(loan.borrowerId);
        const updatedLoan = await ctx.db.get(loan._id);
        if (lender && borrower && updatedLoan) {
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
      }
    }

    await ctx.db.delete(args.toolId);
    return { deletedToolId: args.toolId };
  },
});
