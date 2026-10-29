"use client";

import React, { useEffect, useState } from "react";
import { SignInButton, UserButton, useAuth } from "@clerk/nextjs";
import { useMutation, useQuery } from "convex/react";
import { api } from "@convex/_generated/api";
import { Id } from "@convex/_generated/dataModel";
import type { ToolCategory } from "@convex/lib/rbac";
import {
  AuthenticatedToolItem,
  LendLoopBoardUI,
} from "./LendLoopBoardUI";

export function LiveConvexBoard() {
  const { isSignedIn, isLoaded } = useAuth();
  const [selectedCategory, setSelectedCategory] = useState<
    ToolCategory | undefined
  >(undefined);

  const ensureCurrentUser = useMutation(api.users.ensureCurrentUser);
  const currentUser = useQuery(api.users.me, isSignedIn ? {} : "skip");

  useEffect(() => {
    if (isLoaded && isSignedIn && currentUser === null) {
      void ensureCurrentUser({});
    }
  }, [isLoaded, isSignedIn, currentUser, ensureCurrentUser]);

  // Public query (runs even when signed out, returns name & category only)
  const publicTools = useQuery(api.tools.listPublicAvailable) ?? [];

  // Authenticated queries (skipped until signed in and user record exists in Convex)
  const isReadyUser = Boolean(isSignedIn && currentUser);
  const isAdmin = Boolean(isReadyUser && currentUser?.role === "admin");

  const allToolsRaw = useQuery(
    api.tools.listAll,
    isReadyUser
      ? selectedCategory
        ? { category: selectedCategory }
        : {}
      : "skip"
  );
  const myListingsRaw = useQuery(
    api.tools.listMyListings,
    isReadyUser ? {} : "skip"
  );
  const myRequests = useQuery(
    api.loans.listMyRequests,
    isReadyUser ? {} : "skip"
  );
  const incomingRequests = useQuery(
    api.loans.listIncomingRequests,
    isReadyUser ? {} : "skip"
  );
  const adminAllLoans = useQuery(
    api.loans.listAllLoans,
    isAdmin ? {} : "skip"
  );
  const adminUsers = useQuery(
    api.users.listUsersForAdmin,
    isAdmin ? {} : "skip"
  );

  // Mutations
  const createToolMutation = useMutation(api.tools.createTool);
  const updateToolMutation = useMutation(api.tools.updateTool);
  const deleteToolMutation = useMutation(api.tools.deleteTool);
  const requestBorrowMutation = useMutation(api.loans.requestBorrow);
  const approveRequestMutation = useMutation(api.loans.approveRequest);
  const declineRequestMutation = useMutation(api.loans.declineRequest);
  const markReturnedMutation = useMutation(api.loans.markReturned);
  const setTrustedLenderMutation = useMutation(api.users.setTrustedLender);

  const myListings: AuthenticatedToolItem[] = (myListingsRaw ?? []).map(
    (t) => ({
      _id: t._id,
      name: t.name,
      category: t.category,
      condition: t.condition,
      description: t.description,
      isAvailable: t.isAvailable,
      ownerId: t.ownerId,
      ownerName: currentUser?.name ?? "You",
      ownerIsTrustedLender: currentUser?.isTrustedLender ?? false,
      isOwnListing: true,
      createdAt: t.createdAt,
      updatedAt: t.updatedAt,
    })
  );

  return (
    <LendLoopBoardUI
      mode="live"
      isSignedIn={Boolean(isSignedIn && currentUser)}
      currentUser={
        currentUser
          ? {
              _id: currentUser._id,
              name: currentUser.name,
              email: currentUser.email,
              role: currentUser.role,
              isTrustedLender: currentUser.isTrustedLender,
            }
          : null
      }
      publicTools={publicTools}
      allTools={allToolsRaw ?? []}
      myListings={myListings}
      myRequests={myRequests ?? []}
      incomingRequests={incomingRequests ?? []}
      adminAllLoans={adminAllLoans ?? []}
      adminUsers={adminUsers ?? []}
      selectedCategory={selectedCategory}
      onSelectCategory={setSelectedCategory}
      onCreateTool={async (input) => {
        await createToolMutation(input);
      }}
      onUpdateTool={async (input) => {
        await updateToolMutation({
          toolId: input.toolId as Id<"tools">,
          name: input.name,
          category: input.category,
          condition: input.condition,
          description: input.description,
        });
      }}
      onDeleteTool={async (toolId) => {
        await deleteToolMutation({ toolId: toolId as Id<"tools"> });
      }}
      onRequestBorrow={async (input) => {
        await requestBorrowMutation({
          toolId: input.toolId as Id<"tools">,
          startDate: input.startDate,
          endDate: input.endDate,
          borrowerNote: input.borrowerNote,
        });
      }}
      onApproveRequest={async (loanId, lenderNote) => {
        await approveRequestMutation({
          loanId: loanId as Id<"loans">,
          lenderNote,
        });
      }}
      onDeclineRequest={async (loanId, lenderNote) => {
        await declineRequestMutation({
          loanId: loanId as Id<"loans">,
          lenderNote,
        });
      }}
      onMarkReturned={async (loanId, lenderNote) => {
        await markReturnedMutation({
          loanId: loanId as Id<"loans">,
          lenderNote,
        });
      }}
      onToggleTrustedLender={async (userId, isTrustedLender) => {
        await setTrustedLenderMutation({
          userId: userId as Id<"users">,
          isTrustedLender,
        });
      }}
      renderAuthSignInButton={() => (
        <SignInButton mode="modal">
          <button
            type="button"
            className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-emerald-700 hover:bg-emerald-800 text-white text-sm font-medium shadow-2xs transition-colors cursor-pointer"
          >
            Sign in to lend or borrow
          </button>
        </SignInButton>
      )}
      renderUserMenu={() => <UserButton afterSignOutUrl="/" />}
    />
  );
}
