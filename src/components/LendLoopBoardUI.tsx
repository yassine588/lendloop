"use client";

import React, { useState } from "react";
import {
  Wrench,
  ShieldCheck,
  ShieldAlert,
  Plus,
  Calendar,
  CheckCircle2,
  XCircle,
  RotateCcw,
  Trash2,
  Pencil,
  Activity,
  Lock,
  Sparkles,
  Filter,
  AlertTriangle,
  UserCheck,
  ArrowRight,
} from "lucide-react";
import {
  TOOL_CATEGORIES,
  TOOL_CONDITIONS,
} from "@convex/schema";
import type {
  PublicToolSummary,
  Role,
  ToolCategory,
  ToolCondition,
  LoanStatus,
} from "@convex/lib/rbac";
import { getTodayIsoDate } from "@convex/lib/rbac";
import { formatLoanAutomationBadge, formatRelativeTime } from "@/lib/format";

export interface AuthenticatedToolItem {
  _id: string;
  name: string;
  category: ToolCategory;
  condition: ToolCondition;
  description: string;
  isAvailable: boolean;
  ownerId: string;
  ownerName: string;
  ownerIsTrustedLender: boolean;
  isOwnListing: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface AutomationEventView {
  _id: string;
  workflow: "request_notification" | "overdue_reminder" | "error_handler";
  eventType: string;
  direction: "outbound" | "inbound";
  status: "delivered" | "failed" | "retrying";
  summary: string;
  attemptCount: number;
  errorMessage?: string;
  createdAt: number;
}

export interface LoanItemView {
  _id: string;
  toolId: string;
  toolName: string;
  toolCategory: ToolCategory;
  toolCondition: ToolCondition;
  lenderId: string;
  lenderName: string;
  lenderIsTrustedLender: boolean;
  borrowerId: string;
  borrowerName: string;
  startDate: string;
  endDate: string;
  status: LoanStatus;
  borrowerNote?: string;
  lenderNote?: string;
  isOverdue: boolean;
  daysOverdue: number;
  reminderCount: number;
  lastReminderSentAt?: number;
  lastAutomationSummary?: string;
  lastAutomationAt?: number;
  createdAt: number;
  updatedAt: number;
  recentAutomationEvents: AutomationEventView[];
}

export interface AdminUserItem {
  _id: string;
  name: string;
  email: string;
  role: Role;
  isTrustedLender: boolean;
  listingCount: number;
  createdAt: number;
}

export interface CurrentUserProfile {
  _id: string;
  name: string;
  email: string;
  role: Role;
  isTrustedLender: boolean;
}

export interface LendLoopBoardUIProps {
  mode: "live" | "sandbox";
  isSignedIn: boolean;
  currentUser: CurrentUserProfile | null;
  publicTools: PublicToolSummary[];
  allTools: AuthenticatedToolItem[];
  myListings: AuthenticatedToolItem[];
  myRequests: LoanItemView[];
  incomingRequests: LoanItemView[];
  adminAllLoans: LoanItemView[];
  adminUsers: AdminUserItem[];
  selectedCategory: ToolCategory | undefined;
  onSelectCategory: (cat: ToolCategory | undefined) => void;
  onCreateTool: (input: {
    name: string;
    category: ToolCategory;
    condition: ToolCondition;
    description: string;
  }) => Promise<void>;
  onUpdateTool: (input: {
    toolId: string;
    name: string;
    category: ToolCategory;
    condition: ToolCondition;
    description: string;
  }) => Promise<void>;
  onDeleteTool: (toolId: string) => Promise<void>;
  onRequestBorrow: (input: {
    toolId: string;
    startDate: string;
    endDate: string;
    borrowerNote?: string;
  }) => Promise<void>;
  onApproveRequest: (loanId: string, lenderNote?: string) => Promise<void>;
  onDeclineRequest: (loanId: string, lenderNote?: string) => Promise<void>;
  onMarkReturned: (loanId: string, lenderNote?: string) => Promise<void>;
  onToggleTrustedLender: (
    userId: string,
    isTrustedLender: boolean
  ) => Promise<void>;
  renderAuthSignInButton: () => React.ReactNode;
  renderUserMenu: () => React.ReactNode;
  sandboxControls?: React.ReactNode;
}

type ActiveTab =
  | "browse"
  | "my-listings"
  | "my-requests"
  | "incoming-requests"
  | "admin";

const CATEGORY_LABELS: Record<ToolCategory, string> = {
  "power tools": "Power Tools",
  garden: "Garden",
  kitchen: "Kitchen",
  camping: "Camping",
  "hand tools": "Hand Tools",
  automotive: "Automotive",
  cleaning: "Cleaning",
  other: "Other",
};

export function LendLoopBoardUI(props: LendLoopBoardUIProps) {
  const {
    isSignedIn,
    currentUser,
    publicTools,
    allTools,
    myListings,
    myRequests,
    incomingRequests,
    adminAllLoans,
    adminUsers,
    selectedCategory,
    onSelectCategory,
    onCreateTool,
    onUpdateTool,
    onDeleteTool,
    onRequestBorrow,
    onApproveRequest,
    onDeclineRequest,
    onMarkReturned,
    onToggleTrustedLender,
    renderAuthSignInButton,
    renderUserMenu,
    sandboxControls,
  } = props;

  const [activeTab, setActiveTab] = useState<ActiveTab>("browse");
  const [feedback, setFeedback] = useState<{
    type: "success" | "error";
    message: string;
  } | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  // Tool Create / Edit Modal state
  const [toolModalOpen, setToolModalOpen] = useState(false);
  const [editingTool, setEditingTool] = useState<AuthenticatedToolItem | null>(
    null
  );
  const [toolName, setToolName] = useState("");
  const [toolCategory, setToolCategory] =
    useState<ToolCategory>("power tools");
  const [toolCondition, setToolCondition] =
    useState<ToolCondition>("Like New");
  const [toolDescription, setToolDescription] = useState("");

  // Borrow Request Modal state
  const [borrowTarget, setBorrowTarget] =
    useState<AuthenticatedToolItem | null>(null);
  const todayIso = getTodayIsoDate();
  const defaultEndIso = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000)
    .toISOString()
    .slice(0, 10);
  const [startDate, setStartDate] = useState(todayIso);
  const [endDate, setEndDate] = useState(defaultEndIso);
  const [borrowerNote, setBorrowerNote] = useState("");

  function showSuccess(message: string) {
    setFeedback({ type: "success", message });
  }

  function showError(err: unknown) {
    const message =
      err instanceof Error
        ? err.message
        : "An unexpected error occurred. Please try again.";
    setFeedback({ type: "error", message });
  }

  function openNewToolModal() {
    setEditingTool(null);
    setToolName("");
    setToolCategory("power tools");
    setToolCondition("Like New");
    setToolDescription("");
    setToolModalOpen(true);
  }

  function openEditToolModal(tool: AuthenticatedToolItem) {
    setEditingTool(tool);
    setToolName(tool.name);
    setToolCategory(tool.category);
    setToolCondition(tool.condition);
    setToolDescription(tool.description);
    setToolModalOpen(true);
  }

  async function handleSaveTool(e: React.FormEvent) {
    e.preventDefault();
    setIsSubmitting(true);
    setFeedback(null);
    try {
      if (editingTool) {
        await onUpdateTool({
          toolId: editingTool._id,
          name: toolName,
          category: toolCategory,
          condition: toolCondition,
          description: toolDescription,
        });
        showSuccess(`Updated "${toolName}".`);
      } else {
        await onCreateTool({
          name: toolName,
          category: toolCategory,
          condition: toolCondition,
          description: toolDescription,
        });
        showSuccess(`Listed "${toolName}" on the neighborhood board.`);
      }
      setToolModalOpen(false);
    } catch (err) {
      showError(err);
    } finally {
      setIsSubmitting(false);
    }
  }

  async function handleRequestBorrowSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!borrowTarget) return;
    setIsSubmitting(true);
    setFeedback(null);
    try {
      await onRequestBorrow({
        toolId: borrowTarget._id,
        startDate,
        endDate,
        borrowerNote: borrowerNote.trim() || undefined,
      });
      showSuccess(
        `Borrow request sent for "${borrowTarget.name}". n8n notification webhook dispatched to ${borrowTarget.ownerName}.`
      );
      setBorrowTarget(null);
      setBorrowerNote("");
      setActiveTab("my-requests");
    } catch (err) {
      showError(err);
    } finally {
      setIsSubmitting(false);
    }
  }

  // ============================================================================
  // 1. PUBLIC PAGE (Unauthenticated Experience)
  // ============================================================================
  if (!isSignedIn || !currentUser) {
    return (
      <div className="min-h-screen bg-stone-50 text-stone-900 flex flex-col">
        {sandboxControls}
        <header className="border-b border-stone-200 bg-white/90 backdrop-blur sticky top-0 z-20">
          <div className="max-w-5xl mx-auto px-4 sm:px-6 h-16 flex items-center justify-between">
            <div className="flex items-center gap-2.5">
              <div className="w-9 h-9 rounded-lg bg-emerald-700 text-white flex items-center justify-center shadow-xs">
                <Wrench className="w-5 h-5" />
              </div>
              <div>
                <span className="font-semibold text-lg tracking-tight text-stone-900">
                  LendLoop
                </span>
                <span className="hidden sm:inline-block ml-2 text-xs px-2 py-0.5 rounded-full bg-emerald-50 text-emerald-800 border border-emerald-200 font-medium">
                  Neighborhood Board
                </span>
              </div>
            </div>
            <div>{renderAuthSignInButton()}</div>
          </div>
        </header>

        <main className="flex-1 max-w-5xl w-full mx-auto px-4 sm:px-6 py-12">
          {/* Hero section with required company name & tagline */}
          <section className="bg-white border border-stone-200 rounded-2xl p-8 sm:p-10 shadow-xs mb-10">
            <div className="max-w-2xl">
              <div className="inline-flex items-center gap-1.5 text-xs font-medium text-emerald-800 bg-emerald-50 border border-emerald-200 rounded-full px-3 py-1 mb-4">
                <Sparkles className="w-3.5 h-3.5" />
                Community Tool-Lending Board
              </div>
              <h1 className="text-3xl sm:text-4xl font-bold tracking-tight text-stone-900 mb-3">
                LendLoop
              </h1>
              <p className="text-xl sm:text-2xl text-stone-700 font-medium mb-4">
                “Borrow what you need. Lend what you don’t.”
              </p>
              <p className="text-stone-600 text-sm sm:text-base leading-relaxed mb-6">
                Browse tools currently available in your neighborhood below. To
                protect neighbor privacy, owner details and borrowing controls
                are only visible to signed-in members.
              </p>
              <div className="flex flex-wrap items-center gap-3">
                {renderAuthSignInButton()}
                <span className="inline-flex items-center gap-1.5 text-xs text-stone-500">
                  <Lock className="w-3.5 h-3.5 text-stone-400" />
                  Data-minimized public view (name &amp; category only)
                </span>
              </div>
            </div>
          </section>

          {/* Read-only list of available tools (name & category only, no owner details) */}
          <section aria-labelledby="public-tools-heading">
            <div className="flex items-center justify-between mb-4">
              <div>
                <h2
                  id="public-tools-heading"
                  className="text-lg font-semibold text-stone-900"
                >
                  Available Tools Right Now
                </h2>
                <p className="text-xs text-stone-500">
                  Showing {publicTools.length} available neighborhood{" "}
                  {publicTools.length === 1 ? "tool" : "tools"} pulled from
                  Convex
                </p>
              </div>
              <span className="text-xs font-medium text-emerald-700 bg-emerald-50 border border-emerald-200 px-2.5 py-1 rounded-full">
                Read-Only Preview
              </span>
            </div>

            {publicTools.length === 0 ? (
              <div className="bg-white border border-stone-200 rounded-xl p-10 text-center text-stone-500 text-sm">
                No tools are currently available. Sign in to list the first tool
                in your neighborhood!
              </div>
            ) : (
              <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-4">
                {publicTools.map((tool) => (
                  <div
                    key={tool._id}
                    data-testid="public-tool-card"
                    className="bg-white border border-stone-200 rounded-xl p-4 flex flex-col justify-between hover:border-stone-300 transition-colors"
                  >
                    <div>
                      <div className="flex items-center justify-between gap-2 mb-2">
                        <span className="text-xs font-medium px-2.5 py-0.5 rounded-full bg-stone-100 text-stone-700">
                          {CATEGORY_LABELS[tool.category] ?? tool.category}
                        </span>
                        <span className="inline-flex items-center gap-1 text-xs font-medium text-emerald-700">
                          <span className="w-1.5 h-1.5 rounded-full bg-emerald-600" />
                          Available
                        </span>
                      </div>
                      <h3 className="font-semibold text-stone-900 text-base">
                        {tool.name}
                      </h3>
                    </div>
                    <div className="mt-4 pt-3 border-t border-stone-100 flex items-center justify-between text-xs text-stone-400">
                      <span>Owner details hidden</span>
                      <span>Sign in to request</span>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </section>
        </main>

        <footer className="border-t border-stone-200 bg-white py-5 text-center text-xs text-stone-500">
          LendLoop · “Borrow what you need. Lend what you don’t.” · Powered by
          Next.js, Clerk, Convex &amp; n8n
        </footer>
      </div>
    );
  }

  // ============================================================================
  // 2. AUTHENTICATED EXPERIENCE (Signed-In User / Admin)
  // ============================================================================
  const pendingIncomingCount = incomingRequests.filter(
    (r) => r.status === "pending"
  ).length;

  return (
    <div className="min-h-screen bg-stone-50 text-stone-900 flex flex-col">
      {sandboxControls}

      {/* Top Navigation Bar */}
      <header className="border-b border-stone-200 bg-white sticky top-0 z-20">
        <div className="max-w-6xl mx-auto px-4 sm:px-6 h-16 flex items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-lg bg-emerald-700 text-white flex items-center justify-center">
              <Wrench className="w-5 h-5" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <span className="font-semibold text-lg tracking-tight text-stone-900">
                  LendLoop
                </span>
                <span
                  className={`text-xs font-medium px-2 py-0.5 rounded-full border ${
                    currentUser.role === "admin"
                      ? "bg-amber-50 text-amber-800 border-amber-300"
                      : "bg-stone-100 text-stone-700 border-stone-200"
                  }`}
                >
                  {currentUser.role === "admin" ? "Admin" : "Neighbor"}
                </span>
                {currentUser.isTrustedLender && (
                  <span className="inline-flex items-center gap-1 text-xs font-medium px-2 py-0.5 rounded-full bg-emerald-50 text-emerald-800 border border-emerald-200">
                    <ShieldCheck className="w-3.5 h-3.5" />
                    Trusted Lender
                  </span>
                )}
              </div>
              <p className="text-xs text-stone-500 hidden sm:block">
                Borrow what you need. Lend what you don’t.
              </p>
            </div>
          </div>

          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={openNewToolModal}
              className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-lg bg-emerald-700 hover:bg-emerald-800 text-white text-xs sm:text-sm font-medium transition-colors cursor-pointer"
            >
              <Plus className="w-4 h-4" />
              List a Tool
            </button>
            {renderUserMenu()}
          </div>
        </div>

        {/* View Tabs */}
        <div className="max-w-6xl mx-auto px-4 sm:px-6 flex items-center gap-1 overflow-x-auto border-t border-stone-100">
          <button
            type="button"
            onClick={() => setActiveTab("browse")}
            className={`px-3.5 py-2.5 text-xs sm:text-sm font-medium border-b-2 whitespace-nowrap cursor-pointer transition-colors ${
              activeTab === "browse"
                ? "border-emerald-700 text-emerald-800"
                : "border-transparent text-stone-600 hover:text-stone-900"
            }`}
          >
            All Tools ({allTools.length})
          </button>
          <button
            type="button"
            onClick={() => setActiveTab("my-listings")}
            className={`px-3.5 py-2.5 text-xs sm:text-sm font-medium border-b-2 whitespace-nowrap cursor-pointer transition-colors ${
              activeTab === "my-listings"
                ? "border-emerald-700 text-emerald-800"
                : "border-transparent text-stone-600 hover:text-stone-900"
            }`}
          >
            My Listings ({myListings.length})
          </button>
          <button
            type="button"
            onClick={() => setActiveTab("my-requests")}
            className={`px-3.5 py-2.5 text-xs sm:text-sm font-medium border-b-2 whitespace-nowrap cursor-pointer transition-colors ${
              activeTab === "my-requests"
                ? "border-emerald-700 text-emerald-800"
                : "border-transparent text-stone-600 hover:text-stone-900"
            }`}
          >
            My Requests ({myRequests.length})
          </button>
          <button
            type="button"
            onClick={() => setActiveTab("incoming-requests")}
            className={`px-3.5 py-2.5 text-xs sm:text-sm font-medium border-b-2 whitespace-nowrap flex items-center gap-1.5 cursor-pointer transition-colors ${
              activeTab === "incoming-requests"
                ? "border-emerald-700 text-emerald-800"
                : "border-transparent text-stone-600 hover:text-stone-900"
            }`}
          >
            Incoming Requests ({incomingRequests.length})
            {pendingIncomingCount > 0 && (
              <span className="px-1.5 py-0.2 rounded-full bg-amber-500 text-white text-[11px] font-semibold">
                {pendingIncomingCount}
              </span>
            )}
          </button>
          {currentUser.role === "admin" && (
            <button
              type="button"
              onClick={() => setActiveTab("admin")}
              className={`px-3.5 py-2.5 text-xs sm:text-sm font-medium border-b-2 whitespace-nowrap flex items-center gap-1.5 cursor-pointer transition-colors ${
                activeTab === "admin"
                  ? "border-amber-600 text-amber-800"
                  : "border-transparent text-amber-700 hover:text-amber-900"
              }`}
            >
              <ShieldAlert className="w-3.5 h-3.5" />
              Admin Console
            </button>
          )}
        </div>
      </header>

      <main className="flex-1 max-w-6xl w-full mx-auto px-4 sm:px-6 py-8">
        {/* Feedback Alert Banner */}
        {feedback && (
          <div
            role="status"
            className={`mb-6 rounded-xl border px-4 py-3 text-sm flex items-center justify-between gap-3 ${
              feedback.type === "success"
                ? "bg-emerald-50 border-emerald-200 text-emerald-900"
                : "bg-red-50 border-red-200 text-red-900"
            }`}
          >
            <div className="flex items-center gap-2">
              {feedback.type === "success" ? (
                <CheckCircle2 className="w-4 h-4 text-emerald-700 shrink-0" />
              ) : (
                <AlertTriangle className="w-4 h-4 text-red-700 shrink-0" />
              )}
              <span>{feedback.message}</span>
            </div>
            <button
              type="button"
              onClick={() => setFeedback(null)}
              className="text-xs underline opacity-75 hover:opacity-100 cursor-pointer"
            >
              Dismiss
            </button>
          </div>
        )}

        {/* TAB 1: ALL TOOLS (Filterable by Category) */}
        {activeTab === "browse" && (
          <section>
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 mb-6">
              <div>
                <h1 className="text-xl font-semibold text-stone-900">
                  Neighborhood Tool Directory
                </h1>
                <p className="text-xs sm:text-sm text-stone-500">
                  Filter by category, check availability, or request to borrow
                  for a specific date range.
                </p>
              </div>
              <div className="flex items-center gap-1.5 flex-wrap">
                <Filter className="w-3.5 h-3.5 text-stone-400 mr-1" />
                <button
                  type="button"
                  onClick={() => onSelectCategory(undefined)}
                  className={`px-3 py-1 rounded-full text-xs font-medium border cursor-pointer transition-colors ${
                    !selectedCategory
                      ? "bg-stone-900 text-white border-stone-900"
                      : "bg-white text-stone-600 border-stone-200 hover:border-stone-300"
                  }`}
                >
                  All
                </button>
                {TOOL_CATEGORIES.map((cat) => (
                  <button
                    key={cat}
                    type="button"
                    onClick={() => onSelectCategory(cat)}
                    className={`px-3 py-1 rounded-full text-xs font-medium border cursor-pointer transition-colors ${
                      selectedCategory === cat
                        ? "bg-stone-900 text-white border-stone-900"
                        : "bg-white text-stone-600 border-stone-200 hover:border-stone-300"
                    }`}
                  >
                    {CATEGORY_LABELS[cat]}
                  </button>
                ))}
              </div>
            </div>

            {allTools.length === 0 ? (
              <div className="bg-white border border-stone-200 rounded-xl p-10 text-center text-stone-500 text-sm">
                No tools match the selected category filter.
              </div>
            ) : (
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                {allTools.map((tool) => {
                  const canDelete =
                    tool.isOwnListing || currentUser.role === "admin";
                  return (
                    <div
                      key={tool._id}
                      className="bg-white border border-stone-200 rounded-xl p-5 flex flex-col justify-between shadow-2xs"
                    >
                      <div>
                        <div className="flex items-center justify-between gap-2 mb-2.5">
                          <span className="text-xs font-medium px-2.5 py-0.5 rounded-full bg-stone-100 text-stone-700">
                            {CATEGORY_LABELS[tool.category]}
                          </span>
                          <span
                            className={`inline-flex items-center gap-1.5 text-xs font-medium px-2.5 py-0.5 rounded-full border ${
                              tool.isAvailable
                                ? "bg-emerald-50 text-emerald-800 border-emerald-200"
                                : "bg-amber-50 text-amber-800 border-amber-200"
                            }`}
                          >
                            <span
                              className={`w-1.5 h-1.5 rounded-full ${
                                tool.isAvailable
                                  ? "bg-emerald-600"
                                  : "bg-amber-600"
                              }`}
                            />
                            {tool.isAvailable ? "Available" : "Checked Out"}
                          </span>
                        </div>

                        <h2 className="font-semibold text-stone-900 text-base mb-1">
                          {tool.name}
                        </h2>
                        <p className="text-xs text-stone-500 mb-3">
                          Condition:{" "}
                          <span className="font-medium text-stone-700">
                            {tool.condition}
                          </span>
                        </p>
                        <p className="text-sm text-stone-600 leading-relaxed mb-4">
                          {tool.description}
                        </p>
                      </div>

                      <div className="pt-3 border-t border-stone-100 flex items-center justify-between gap-2">
                        <div className="text-xs text-stone-600 flex items-center gap-1.5 flex-wrap">
                          <span>
                            Lent by{" "}
                            <strong className="text-stone-800">
                              {tool.isOwnListing ? "You" : tool.ownerName}
                            </strong>
                          </span>
                          {tool.ownerIsTrustedLender && (
                            <span
                              title="Verified Trusted Lender by Admin"
                              className="inline-flex items-center gap-0.5 text-[11px] font-medium px-2 py-0.5 rounded-full bg-emerald-50 text-emerald-800 border border-emerald-200"
                            >
                              <ShieldCheck className="w-3 h-3" />
                              Trusted Lender
                            </span>
                          )}
                        </div>

                        <div className="flex items-center gap-1.5">
                          {tool.isOwnListing && (
                            <button
                              type="button"
                              onClick={() => openEditToolModal(tool)}
                              className="p-1.5 rounded-lg border border-stone-200 text-stone-600 hover:bg-stone-50 cursor-pointer"
                              title="Edit your listing"
                            >
                              <Pencil className="w-3.5 h-3.5" />
                            </button>
                          )}
                          {canDelete && (
                            <button
                              type="button"
                              onClick={async () => {
                                try {
                                  await onDeleteTool(tool._id);
                                  showSuccess(
                                    `Removed listing "${tool.name}".`
                                  );
                                } catch (err) {
                                  showError(err);
                                }
                              }}
                              className="p-1.5 rounded-lg border border-red-200 text-red-600 hover:bg-red-50 cursor-pointer"
                              title={
                                currentUser.role === "admin" &&
                                !tool.isOwnListing
                                  ? "Admin: Remove listing"
                                  : "Delete your listing"
                              }
                            >
                              <Trash2 className="w-3.5 h-3.5" />
                            </button>
                          )}
                          {!tool.isOwnListing && (
                            <button
                              type="button"
                              disabled={!tool.isAvailable}
                              onClick={() => {
                                setBorrowTarget(tool);
                                setStartDate(todayIso);
                                setEndDate(defaultEndIso);
                                setBorrowerNote("");
                              }}
                              className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-colors ${
                                tool.isAvailable
                                  ? "bg-stone-900 hover:bg-stone-800 text-white cursor-pointer"
                                  : "bg-stone-100 text-stone-400 cursor-not-allowed"
                              }`}
                            >
                              {tool.isAvailable ? "Borrow" : "Unavailable"}
                            </button>
                          )}
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </section>
        )}

        {/* TAB 2: MY LISTINGS */}
        {activeTab === "my-listings" && (
          <section>
            <div className="flex items-center justify-between mb-6">
              <div>
                <h1 className="text-xl font-semibold text-stone-900">
                  My Listings
                </h1>
                <p className="text-xs sm:text-sm text-stone-500">
                  Manage tools you have shared with your neighbors. You can only
                  edit or delete your own listings.
                </p>
              </div>
              <button
                type="button"
                onClick={openNewToolModal}
                className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-lg bg-emerald-700 hover:bg-emerald-800 text-white text-xs sm:text-sm font-medium cursor-pointer"
              >
                <Plus className="w-4 h-4" />
                Add Listing
              </button>
            </div>

            {myListings.length === 0 ? (
              <div className="bg-white border border-stone-200 rounded-xl p-10 text-center">
                <p className="text-sm text-stone-600 mb-3">
                  You haven’t listed any tools yet.
                </p>
                <button
                  type="button"
                  onClick={openNewToolModal}
                  className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg bg-emerald-700 text-white text-xs font-medium cursor-pointer"
                >
                  <Plus className="w-4 h-4" />
                  List Your First Tool
                </button>
              </div>
            ) : (
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                {myListings.map((tool) => (
                  <div
                    key={tool._id}
                    className="bg-white border border-stone-200 rounded-xl p-5 flex flex-col justify-between"
                  >
                    <div>
                      <div className="flex items-center justify-between mb-2">
                        <span className="text-xs font-medium px-2.5 py-0.5 rounded-full bg-stone-100 text-stone-700">
                          {CATEGORY_LABELS[tool.category]}
                        </span>
                        <span
                          className={`text-xs font-medium px-2.5 py-0.5 rounded-full ${
                            tool.isAvailable
                              ? "bg-emerald-50 text-emerald-800"
                              : "bg-amber-50 text-amber-800"
                          }`}
                        >
                          {tool.isAvailable ? "Available" : "Currently On Loan"}
                        </span>
                      </div>
                      <h3 className="font-semibold text-stone-900 text-base">
                        {tool.name}
                      </h3>
                      <p className="text-xs text-stone-500 mb-2">
                        Condition: {tool.condition}
                      </p>
                      <p className="text-sm text-stone-600 mb-4">
                        {tool.description}
                      </p>
                    </div>
                    <div className="pt-3 border-t border-stone-100 flex items-center justify-end gap-2">
                      <button
                        type="button"
                        onClick={() => openEditToolModal(tool)}
                        className="inline-flex items-center gap-1 px-3 py-1.5 rounded-lg border border-stone-200 text-xs font-medium text-stone-700 hover:bg-stone-50 cursor-pointer"
                      >
                        <Pencil className="w-3.5 h-3.5" />
                        Edit
                      </button>
                      <button
                        type="button"
                        onClick={async () => {
                          try {
                            await onDeleteTool(tool._id);
                            showSuccess(`Deleted "${tool.name}".`);
                          } catch (err) {
                            showError(err);
                          }
                        }}
                        className="inline-flex items-center gap-1 px-3 py-1.5 rounded-lg border border-red-200 text-xs font-medium text-red-700 hover:bg-red-50 cursor-pointer"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                        Delete
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </section>
        )}

        {/* TAB 3: MY REQUESTS (Outgoing Borrow Requests) */}
        {activeTab === "my-requests" && (
          <section>
            <div className="mb-6">
              <h1 className="text-xl font-semibold text-stone-900">
                My Borrow Requests
              </h1>
              <p className="text-xs sm:text-sm text-stone-500">
                Track tools you’ve requested to borrow and view live n8n
                workflow notification &amp; reminder status.
              </p>
            </div>

            {myRequests.length === 0 ? (
              <div className="bg-white border border-stone-200 rounded-xl p-10 text-center text-sm text-stone-500">
                You haven’t requested to borrow any tools yet. Browse the tool
                directory to make a request!
              </div>
            ) : (
              <div className="space-y-4">
                {myRequests.map((loan) => (
                  <LoanCard
                    key={loan._id}
                    loan={loan}
                    perspective="borrower"
                    isAdmin={currentUser.role === "admin"}
                    onApprove={onApproveRequest}
                    onDecline={onDeclineRequest}
                    onMarkReturned={onMarkReturned}
                    onSuccess={showSuccess}
                    onError={showError}
                  />
                ))}
              </div>
            )}
          </section>
        )}

        {/* TAB 4: INCOMING REQUESTS (Requests on My Tools) */}
        {activeTab === "incoming-requests" && (
          <section>
            <div className="mb-6">
              <h1 className="text-xl font-semibold text-stone-900">
                Incoming Requests on My Tools
              </h1>
              <p className="text-xs sm:text-sm text-stone-500">
                Approve or decline pending requests on your tools, and mark
                active loans as returned when neighbors bring them back.
              </p>
            </div>

            {incomingRequests.length === 0 ? (
              <div className="bg-white border border-stone-200 rounded-xl p-10 text-center text-sm text-stone-500">
                No incoming requests on your tools yet.
              </div>
            ) : (
              <div className="space-y-4">
                {incomingRequests.map((loan) => (
                  <LoanCard
                    key={loan._id}
                    loan={loan}
                    perspective="lender"
                    isAdmin={currentUser.role === "admin"}
                    onApprove={onApproveRequest}
                    onDecline={onDeclineRequest}
                    onMarkReturned={onMarkReturned}
                    onSuccess={showSuccess}
                    onError={showError}
                  />
                ))}
              </div>
            )}
          </section>
        )}

        {/* TAB 5: ADMIN CONSOLE (Role == 'admin' only) */}
        {activeTab === "admin" && currentUser.role === "admin" && (
          <section className="space-y-8">
            <div className="bg-amber-50/70 border border-amber-200 rounded-xl p-5">
              <div className="flex items-center gap-2 text-amber-900 font-semibold text-base mb-1">
                <ShieldAlert className="w-5 h-5 text-amber-700" />
                Admin Governance &amp; Oversight Console
              </div>
              <p className="text-xs sm:text-sm text-amber-800">
                Enforced in Convex functions: Admins can view all neighborhood
                loans, remove any tool listing, and grant or revoke the{" "}
                <strong>Trusted Lender</strong> badge.
              </p>
            </div>

            {/* Manage Lenders & Trusted Lender Badges */}
            <div>
              <h2 className="text-lg font-semibold text-stone-900 mb-3">
                Neighborhood Lenders &amp; Trusted Badges ({adminUsers.length})
              </h2>
              <div className="bg-white border border-stone-200 rounded-xl overflow-hidden">
                <table className="w-full text-left border-collapse text-sm">
                  <thead>
                    <tr className="border-b border-stone-200 bg-stone-50 text-xs text-stone-500 uppercase">
                      <th className="py-3 px-4">Neighbor</th>
                      <th className="py-3 px-4">Role</th>
                      <th className="py-3 px-4">Listings</th>
                      <th className="py-3 px-4">Trusted Status</th>
                      <th className="py-3 px-4 text-right">Action</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-stone-100">
                    {adminUsers.map((u) => (
                      <tr key={u._id}>
                        <td className="py-3 px-4">
                          <div className="font-medium text-stone-900">
                            {u.name}
                          </div>
                          <div className="text-xs text-stone-500">
                            {u.email}
                          </div>
                        </td>
                        <td className="py-3 px-4">
                          <span className="text-xs font-medium px-2 py-0.5 rounded-full bg-stone-100 text-stone-700">
                            {u.role}
                          </span>
                        </td>
                        <td className="py-3 px-4 text-stone-600">
                          {u.listingCount}
                        </td>
                        <td className="py-3 px-4">
                          {u.isTrustedLender ? (
                            <span className="inline-flex items-center gap-1 text-xs font-medium text-emerald-800 bg-emerald-50 border border-emerald-200 px-2.5 py-0.5 rounded-full">
                              <ShieldCheck className="w-3.5 h-3.5" />
                              Trusted Lender
                            </span>
                          ) : (
                            <span className="text-xs text-stone-400">
                              Standard
                            </span>
                          )}
                        </td>
                        <td className="py-3 px-4 text-right">
                          <button
                            type="button"
                            onClick={async () => {
                              try {
                                await onToggleTrustedLender(
                                  u._id,
                                  !u.isTrustedLender
                                );
                                showSuccess(
                                  `${u.isTrustedLender ? "Removed" : "Granted"} Trusted Lender badge for ${u.name}.`
                                );
                              } catch (err) {
                                showError(err);
                              }
                            }}
                            className="inline-flex items-center gap-1 px-3 py-1.5 rounded-lg border border-stone-200 hover:bg-stone-50 text-xs font-medium text-stone-800 cursor-pointer"
                          >
                            <UserCheck className="w-3.5 h-3.5" />
                            {u.isTrustedLender
                              ? "Revoke Trusted"
                              : "Mark Trusted Lender"}
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>

            {/* All Loans Across Platform */}
            <div>
              <h2 className="text-lg font-semibold text-stone-900 mb-3">
                All Neighborhood Loans ({adminAllLoans.length})
              </h2>
              {adminAllLoans.length === 0 ? (
                <div className="bg-white border border-stone-200 rounded-xl p-8 text-center text-sm text-stone-500">
                  No loans recorded yet.
                </div>
              ) : (
                <div className="space-y-4">
                  {adminAllLoans.map((loan) => (
                    <LoanCard
                      key={loan._id}
                      loan={loan}
                      perspective="admin"
                      isAdmin={true}
                      onApprove={onApproveRequest}
                      onDecline={onDeclineRequest}
                      onMarkReturned={onMarkReturned}
                      onSuccess={showSuccess}
                      onError={showError}
                    />
                  ))}
                </div>
              )}
            </div>
          </section>
        )}
      </main>

      {/* Modal: Create / Edit Tool Listing */}
      {toolModalOpen && (
        <div className="fixed inset-0 z-50 bg-black/40 backdrop-blur-xs flex items-center justify-center p-4">
          <div className="bg-white border border-stone-200 rounded-2xl max-w-md w-full p-6 shadow-xl">
            <h2 className="text-lg font-semibold text-stone-900 mb-1">
              {editingTool ? "Edit Tool Listing" : "List a Tool to Lend"}
            </h2>
            <p className="text-xs text-stone-500 mb-4">
              Share a tool with your neighbors on LendLoop.
            </p>
            <form onSubmit={handleSaveTool} className="space-y-4">
              <div>
                <label className="block text-xs font-medium text-stone-700 mb-1">
                  Tool Name
                </label>
                <input
                  type="text"
                  required
                  minLength={2}
                  maxLength={100}
                  value={toolName}
                  onChange={(e) => setToolName(e.target.value)}
                  placeholder="e.g., DeWalt 20V Cordless Drill"
                  className="w-full rounded-lg border border-stone-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-emerald-600"
                />
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-medium text-stone-700 mb-1">
                    Category
                  </label>
                  <select
                    value={toolCategory}
                    onChange={(e) =>
                      setToolCategory(e.target.value as ToolCategory)
                    }
                    className="w-full rounded-lg border border-stone-300 px-3 py-2 text-sm bg-white"
                  >
                    {TOOL_CATEGORIES.map((c) => (
                      <option key={c} value={c}>
                        {CATEGORY_LABELS[c]}
                      </option>
                    ))}
                  </select>
                </div>

                <div>
                  <label className="block text-xs font-medium text-stone-700 mb-1">
                    Condition
                  </label>
                  <select
                    value={toolCondition}
                    onChange={(e) =>
                      setToolCondition(e.target.value as ToolCondition)
                    }
                    className="w-full rounded-lg border border-stone-300 px-3 py-2 text-sm bg-white"
                  >
                    {TOOL_CONDITIONS.map((cond) => (
                      <option key={cond} value={cond}>
                        {cond}
                      </option>
                    ))}
                  </select>
                </div>
              </div>

              <div>
                <label className="block text-xs font-medium text-stone-700 mb-1">
                  Short Description
                </label>
                <textarea
                  required
                  minLength={4}
                  maxLength={500}
                  rows={3}
                  value={toolDescription}
                  onChange={(e) => setToolDescription(e.target.value)}
                  placeholder="Includes charger, two batteries, and standard bit set."
                  className="w-full rounded-lg border border-stone-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-emerald-600"
                />
              </div>

              <div className="flex items-center justify-end gap-2 pt-2">
                <button
                  type="button"
                  onClick={() => setToolModalOpen(false)}
                  className="px-4 py-2 rounded-lg border border-stone-200 text-xs font-medium text-stone-700 hover:bg-stone-50 cursor-pointer"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={isSubmitting}
                  className="px-4 py-2 rounded-lg bg-emerald-700 hover:bg-emerald-800 text-white text-xs font-medium cursor-pointer disabled:opacity-50"
                >
                  {editingTool ? "Save Changes" : "Publish Listing"}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Modal: Request to Borrow for a Date Range */}
      {borrowTarget && (
        <div className="fixed inset-0 z-50 bg-black/40 backdrop-blur-xs flex items-center justify-center p-4">
          <div className="bg-white border border-stone-200 rounded-2xl max-w-md w-full p-6 shadow-xl">
            <h2 className="text-lg font-semibold text-stone-900 mb-1">
              Request to Borrow: {borrowTarget.name}
            </h2>
            <p className="text-xs text-stone-500 mb-4">
              Owned by <strong>{borrowTarget.ownerName}</strong> · n8n will
              automatically notify the lender via HMAC-signed webhook.
            </p>
            <form onSubmit={handleRequestBorrowSubmit} className="space-y-4">
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-medium text-stone-700 mb-1">
                    Start Date
                  </label>
                  <input
                    type="date"
                    required
                    value={startDate}
                    onChange={(e) => setStartDate(e.target.value)}
                    className="w-full rounded-lg border border-stone-300 px-3 py-2 text-sm"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-stone-700 mb-1">
                    Return Date
                  </label>
                  <input
                    type="date"
                    required
                    min={startDate}
                    value={endDate}
                    onChange={(e) => setEndDate(e.target.value)}
                    className="w-full rounded-lg border border-stone-300 px-3 py-2 text-sm"
                  />
                </div>
              </div>

              <div>
                <label className="block text-xs font-medium text-stone-700 mb-1">
                  Note for Lender (optional)
                </label>
                <textarea
                  rows={2}
                  maxLength={300}
                  value={borrowerNote}
                  onChange={(e) => setBorrowerNote(e.target.value)}
                  placeholder="Building planter boxes this weekend — can pick up around 5pm!"
                  className="w-full rounded-lg border border-stone-300 px-3 py-2 text-sm"
                />
              </div>

              <div className="flex items-center justify-end gap-2 pt-2">
                <button
                  type="button"
                  onClick={() => setBorrowTarget(null)}
                  className="px-4 py-2 rounded-lg border border-stone-200 text-xs font-medium text-stone-700 hover:bg-stone-50 cursor-pointer"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={isSubmitting}
                  className="px-4 py-2 rounded-lg bg-stone-900 hover:bg-stone-800 text-white text-xs font-medium cursor-pointer disabled:opacity-50"
                >
                  Send Borrow Request
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}

function LoanCard(props: {
  loan: LoanItemView;
  perspective: "borrower" | "lender" | "admin";
  isAdmin: boolean;
  onApprove: (loanId: string, note?: string) => Promise<void>;
  onDecline: (loanId: string, note?: string) => Promise<void>;
  onMarkReturned: (loanId: string, note?: string) => Promise<void>;
  onSuccess: (msg: string) => void;
  onError: (err: unknown) => void;
}) {
  const {
    loan,
    perspective,
    isAdmin,
    onApprove,
    onDecline,
    onMarkReturned,
    onSuccess,
    onError,
  } = props;

  const statusStyles: Record<LoanStatus, string> = {
    pending: "bg-amber-50 text-amber-800 border-amber-200",
    approved: "bg-emerald-50 text-emerald-800 border-emerald-200",
    declined: "bg-stone-100 text-stone-600 border-stone-200",
    returned: "bg-sky-50 text-sky-800 border-sky-200",
  };

  const automationBadge = formatLoanAutomationBadge({
    lastReminderSentAt: loan.lastReminderSentAt,
    lastAutomationSummary: loan.lastAutomationSummary,
    lastAutomationAt: loan.lastAutomationAt,
  });

  const canReview = perspective === "lender" && loan.status === "pending";
  const canReturn =
    (perspective === "lender" || isAdmin) && loan.status === "approved";

  return (
    <div className="bg-white border border-stone-200 rounded-xl p-5 shadow-2xs">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 mb-3">
        <div>
          <div className="flex items-center gap-2 flex-wrap">
            <h3 className="font-semibold text-stone-900 text-base">
              {loan.toolName}
            </h3>
            <span
              className={`text-xs font-medium px-2.5 py-0.5 rounded-full border capitalize ${statusStyles[loan.status]}`}
            >
              {loan.status}
            </span>
            {loan.isOverdue && (
              <span className="inline-flex items-center gap-1 text-xs font-semibold px-2.5 py-0.5 rounded-full bg-red-50 text-red-800 border border-red-200">
                <AlertTriangle className="w-3.5 h-3.5" />
                Overdue by {loan.daysOverdue}d
              </span>
            )}
          </div>
          <div className="text-xs text-stone-500 mt-1 flex items-center gap-2 flex-wrap">
            <span>
              Lender: <strong className="text-stone-700">{loan.lenderName}</strong>
            </span>
            {loan.lenderIsTrustedLender && (
              <span className="inline-flex items-center gap-0.5 text-[11px] text-emerald-700 font-medium">
                <ShieldCheck className="w-3 h-3" />
                Trusted
              </span>
            )}
            <span>·</span>
            <span>
              Borrower:{" "}
              <strong className="text-stone-700">{loan.borrowerName}</strong>
            </span>
            <span>·</span>
            <span className="inline-flex items-center gap-1 text-stone-700 font-medium">
              <Calendar className="w-3.5 h-3.5 text-stone-400" />
              {loan.startDate} <ArrowRight className="w-3 h-3 inline" />{" "}
              {loan.endDate}
            </span>
          </div>
        </div>

        {/* Actions */}
        <div className="flex items-center gap-2 shrink-0">
          {canReview && (
            <>
              <button
                type="button"
                onClick={async () => {
                  try {
                    await onApprove(loan._id);
                    onSuccess(
                      `Approved borrow request for "${loan.toolName}". n8n notification webhook sent.`
                    );
                  } catch (err) {
                    onError(err);
                  }
                }}
                className="inline-flex items-center gap-1 px-3 py-1.5 rounded-lg bg-emerald-700 hover:bg-emerald-800 text-white text-xs font-medium cursor-pointer"
              >
                <CheckCircle2 className="w-3.5 h-3.5" />
                Approve
              </button>
              <button
                type="button"
                onClick={async () => {
                  try {
                    await onDecline(loan._id);
                    onSuccess(
                      `Declined borrow request for "${loan.toolName}".`
                    );
                  } catch (err) {
                    onError(err);
                  }
                }}
                className="inline-flex items-center gap-1 px-3 py-1.5 rounded-lg border border-stone-300 hover:bg-stone-50 text-stone-700 text-xs font-medium cursor-pointer"
              >
                <XCircle className="w-3.5 h-3.5" />
                Decline
              </button>
            </>
          )}

          {canReturn && (
            <button
              type="button"
              onClick={async () => {
                try {
                  await onMarkReturned(loan._id);
                  onSuccess(
                    `Marked "${loan.toolName}" as returned. Tool is now available again.`
                  );
                } catch (err) {
                  onError(err);
                }
              }}
              className="inline-flex items-center gap-1 px-3 py-1.5 rounded-lg bg-stone-900 hover:bg-stone-800 text-white text-xs font-medium cursor-pointer"
            >
              <RotateCcw className="w-3.5 h-3.5" />
              Mark as Returned
            </button>
          )}
        </div>
      </div>

      {loan.borrowerNote && (
        <p className="text-xs text-stone-600 bg-stone-50 rounded-lg px-3 py-2 mb-3">
          <span className="font-medium text-stone-700">Borrower note:</span>{" "}
          {loan.borrowerNote}
        </p>
      )}

      {/* Bonus: Recent n8n Automation Activity on Each Loan */}
      <div className="pt-3 border-t border-stone-100 flex flex-col sm:flex-row sm:items-center justify-between gap-2 text-xs">
        <div className="flex items-center gap-2 text-stone-600">
          <Activity className="w-3.5 h-3.5 text-emerald-700 shrink-0" />
          <span className="font-medium text-stone-700">n8n Automation:</span>
          <span data-testid="loan-automation-badge" className="text-stone-600">
            {automationBadge ?? "Awaiting workflow event"}
          </span>
          {loan.reminderCount > 0 && (
            <span className="px-2 py-0.5 rounded-full bg-amber-50 text-amber-800 border border-amber-200 font-medium">
              {loan.reminderCount}{" "}
              {loan.reminderCount === 1 ? "reminder" : "reminders"} sent
            </span>
          )}
        </div>

        {loan.recentAutomationEvents.length > 0 && (
          <div className="flex items-center gap-1.5 flex-wrap">
            {loan.recentAutomationEvents.slice(0, 2).map((evt) => (
              <span
                key={evt._id}
                title={evt.errorMessage ?? evt.summary}
                className={`inline-flex items-center gap-1 text-[11px] px-2 py-0.5 rounded-full border ${
                  evt.status === "delivered"
                    ? "bg-emerald-50/60 text-emerald-800 border-emerald-200"
                    : evt.status === "failed"
                    ? "bg-red-50 text-red-800 border-red-200"
                    : "bg-stone-100 text-stone-600 border-stone-200"
                }`}
              >
                {evt.workflow === "overdue_reminder"
                  ? "Overdue Cron"
                  : evt.workflow === "error_handler"
                  ? "Error Alert"
                  : "Webhook"}{" "}
                · {formatRelativeTime(evt.createdAt)}
              </span>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
