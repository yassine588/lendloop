import { v } from "convex/values";
import {
  mutation,
  query,
  QueryCtx,
  MutationCtx,
} from "./_generated/server";
import { Doc } from "./_generated/dataModel";
import {
  assertAdmin,
  assertAuthenticated,
  Role,
  UnauthenticatedError,
} from "./lib/rbac";

function parseAdminEmails(): Set<string> {
  const raw = process.env.ADMIN_EMAILS ?? "";
  return new Set(
    raw
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean)
  );
}

/**
 * Looks up the authenticated user in Convex's `users` table using the verified Clerk JWT `subject`.
 */
export async function getCurrentUserOrNull(
  ctx: QueryCtx | MutationCtx
): Promise<Doc<"users"> | null> {
  const identity = await ctx.auth.getUserIdentity();
  if (!identity) {
    return null;
  }
  return await ctx.db
    .query("users")
    .withIndex("by_clerk_id", (q) => q.eq("clerkId", identity.subject))
    .unique();
}

export async function requireCurrentUser(
  ctx: QueryCtx | MutationCtx
): Promise<Doc<"users">> {
  const user = await getCurrentUserOrNull(ctx);
  assertAuthenticated(user);
  return user;
}

export async function requireAdminUser(
  ctx: QueryCtx | MutationCtx
): Promise<Doc<"users">> {
  const user = await getCurrentUserOrNull(ctx);
  assertAdmin(user);
  return user;
}

/**
 * Ensures the signed-in Clerk user has a corresponding record in Convex.
 * Role assignment is derived strictly from server-side Clerk JWT metadata or
 * the server-side `ADMIN_EMAILS` environment variable — never from client input.
 */
export const ensureCurrentUser = mutation({
  args: {},
  handler: async (ctx) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) {
      throw new UnauthenticatedError();
    }

    const email = (identity.email ?? "").trim().toLowerCase();
    const displayName =
      identity.name?.trim() ||
      identity.nickname?.trim() ||
      (email ? email.split("@")[0] : "Neighbor");

    const adminEmails = parseAdminEmails();
    const jwtRole = (identity as Record<string, unknown>).role;
    const isServerVerifiedAdmin =
      jwtRole === "admin" || (email.length > 0 && adminEmails.has(email));

    const existing = await ctx.db
      .query("users")
      .withIndex("by_clerk_id", (q) => q.eq("clerkId", identity.subject))
      .unique();

    if (existing) {
      const nextRole: Role =
        existing.role === "admin" || isServerVerifiedAdmin ? "admin" : "user";
      if (
        existing.email !== email ||
        existing.name !== displayName ||
        existing.role !== nextRole
      ) {
        await ctx.db.patch(existing._id, {
          email: email || existing.email,
          name: displayName,
          role: nextRole,
        });
      }
      return await ctx.db.get(existing._id);
    }

    const role: Role = isServerVerifiedAdmin ? "admin" : "user";
    const userId = await ctx.db.insert("users", {
      clerkId: identity.subject,
      email: email || `${identity.subject}@users.lendloop.local`,
      name: displayName,
      role,
      isTrustedLender: false,
      createdAt: Date.now(),
    });

    return await ctx.db.get(userId);
  },
});

/**
 * Returns the currently signed-in user's profile and RBAC role.
 */
export const me = query({
  args: {},
  handler: async (ctx) => {
    return await getCurrentUserOrNull(ctx);
  },
});

/**
 * Admin-only query: Lists all users so admins can inspect lenders and toggle "Trusted Lender".
 */
export const listUsersForAdmin = query({
  args: {},
  handler: async (ctx) => {
    await requireAdminUser(ctx);
    const users = await ctx.db.query("users").order("desc").collect();
    const tools = await ctx.db.query("tools").collect();

    const listingCountByOwner = new Map<string, number>();
    for (const tool of tools) {
      listingCountByOwner.set(
        tool.ownerId,
        (listingCountByOwner.get(tool.ownerId) ?? 0) + 1
      );
    }

    return users.map((u) => ({
      _id: u._id,
      name: u.name,
      email: u.email,
      role: u.role,
      isTrustedLender: u.isTrustedLender,
      listingCount: listingCountByOwner.get(u._id) ?? 0,
      createdAt: u.createdAt,
    }));
  },
});

/**
 * Admin-only mutation: Marks or unmarks a lender as a "Trusted Lender".
 * Strictly enforced in Convex so non-admin users receive an AuthorizationError.
 */
export const setTrustedLender = mutation({
  args: {
    userId: v.id("users"),
    isTrustedLender: v.boolean(),
  },
  handler: async (ctx, args) => {
    await requireAdminUser(ctx);

    const targetUser = await ctx.db.get(args.userId);
    if (!targetUser) {
      throw new Error("Target user not found.");
    }

    await ctx.db.patch(args.userId, {
      isTrustedLender: args.isTrustedLender,
    });

    return {
      userId: args.userId,
      isTrustedLender: args.isTrustedLender,
    };
  },
});
