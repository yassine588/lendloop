# LendLoop

> **“Borrow what you need. Lend what you don’t.”**
>
> A neighborhood tool-lending board built with **Next.js (App Router)**, **Clerk**, **Convex**, **n8n**, and **TypeScript**, featuring server-enforced Role-Based Access Control (RBAC), strict data minimization, bidirectional HMAC-SHA256 webhook security, idempotent write-backs, and automated error visibility.

---

## Table of Contents

1. [Architecture Overview](#1-architecture-overview)
2. [Local Setup (Next.js + Convex + Clerk + Docker n8n)](#2-local-setup-nextjs--convex--clerk--docker-n8n)
3. [Environment Variables Reference](#3-environment-variables-reference)
4. [n8n Workflows & Reliability Design](#4-n8n-workflows--reliability-design)
5. [Security & Data-Minimization Decisions](#5-security--data-minimization-decisions)
6. [What I Would Change to Run This in Production](#6-what-i-would-change-to-run-this-in-production)
7. [Verification & Automated Tests](#7-verification--automated-tests)

---

## 1. Architecture Overview

```text
┌──────────────────────────────────────────────────────────────────────────────┐
│                         Next.js 15 App Router (TypeScript)                   │
│  • Public View: Read-only available tools (name & category only) + Clerk CTA │
│  • Authenticated View: All Tools, My Listings, My Requests, Incoming, Admin  │
│  • Bonus: Live n8n automation activity badge & timeline on every loan card   │
└───────────────┬──────────────────────────────────────────────┬───────────────┘
                │ Clerk JWT (OIDC)                             │ Real-time WebSocket
                ▼                                              ▼
┌───────────────────────────────┐              ┌───────────────────────────────┐
│      Clerk Authentication     │              │     Convex Backend & DB       │
│  • Issues signed JWTs         │─────────────▶│  • RBAC enforced in functions │
│  • Server-verified identity   │              │  • Data-minimized projections │
└───────────────────────────────┘              │  • Outbound HMAC Action       │
                                               │  • Inbound HMAC HTTP Router   │
                                               └───────┬───────────────▲───────┘
                                                       │               │
                 1. Outbound Webhook (HMAC-SHA256)     │               │ 2. Inbound Polling &
                    POST /webhook/lendloop-loan-event  │               │    Idempotent Write-Backs
                                                       ▼               │    (HMAC-SHA256 + Key)
                                               ┌───────────────────────┴───────┐
                                               │      n8n Automation Engine    │
                                               │  01 Request Notifications     │
                                               │  02 Daily Overdue Reminders   │
                                               │  03 Automation Error Handler  │
                                               └───────────────────────────────┘
```

### Repository Structure

- [`convex/schema.ts`](./convex/schema.ts) — Convex tables (`users`, `tools`, `loans`, `automationEvents`) with strict validators and indexes.
- [`convex/lib/rbac.ts`](./convex/lib/rbac.ts) — Pure RBAC assertions (`user` vs `admin`), date-range validators, and data-minimization projections.
- [`convex/lib/hmac.ts`](./convex/lib/hmac.ts) — Bidirectional HMAC-SHA256 signing & verification with 300-second replay window and constant-time comparison.
- [`convex/users.ts`](./convex/users.ts) — Clerk identity synchronization, server-side admin role resolution, and `setTrustedLender` (`admin` only).
- [`convex/tools.ts`](./convex/tools.ts) — `listPublicAvailable` (name & category only), `listAll` (filterable by category), `listMyListings`, `createTool`, `updateTool`, and `deleteTool` (owner or `admin`).
- [`convex/loans.ts`](./convex/loans.ts) — `requestBorrow`, `approveRequest`, `declineRequest`, `markReturned`, `listMyRequests`, `listIncomingRequests`, and `listAllLoans` (`admin` only).
- [`convex/n8n.ts`](./convex/n8n.ts) — Outbound webhook action with exponential backoff retries (`dispatchLoanWebhook`), overdue loan query (`getOverdueLoansForN8n`), and idempotent event recorder (`recordAutomationEvent`).
- [`convex/http.ts`](./convex/http.ts) — HMAC-protected HTTP endpoints consumed by n8n:
  - `GET /api/n8n/overdue-loans`
  - `POST /api/n8n/reminder-callback`
  - `POST /api/n8n/automation-events`
- [`n8n/workflows/`](./n8n/workflows/) — Exported n8n workflow JSON files (zero hardcoded secrets):
  - [`01-request-notification.json`](./n8n/workflows/01-request-notification.json)
  - [`02-overdue-reminders.json`](./n8n/workflows/02-overdue-reminders.json)
  - [`03-error-handler.json`](./n8n/workflows/03-error-handler.json)
- [`src/components/`](./src/components/) — Next.js App Router UI components (`LendLoopBoardUI.tsx`, `LiveConvexBoard.tsx`, `SandboxBoard.tsx`).
- [`tests/lendloop.test.ts`](./tests/lendloop.test.ts) — Automated Vitest suite covering HMAC signing/replay protection, RBAC, date validation, data minimization, and n8n workflow JSON audits.

---

## 2. Local Setup (Next.js + Convex + Clerk + Docker n8n)

### Prerequisites

- **Node.js** 20+ and **npm**
- **Docker & Docker Compose** (for self-hosted n8n, or an n8n Cloud workspace)
- A free **Convex** account (`npx convex dev`) and **Clerk** application

### Step 1: Install Dependencies

```bash
npm install
```

> **Quick Zero-Config Evaluation Mode:**
> If you run `npm run dev` before creating `.env.local`, LendLoop automatically launches in **Interactive Evaluation Mode** (powered by the exact same RBAC and data-minimization functions in `convex/lib/rbac.ts`). You can immediately inspect the Public Landing Page, switch between Neighbor (`user`) and `admin` roles, test RBAC protections, and trigger the simulated n8n Overdue Reminders cron job in the browser.

### Step 2: Configure Environment Variables

Copy `.env.example` to `.env.local`:

```bash
cp .env.example .env.local
```

Generate a 256-bit shared HMAC secret and an n8n encryption key:

```bash
openssl rand -hex 32
```

Fill in `.env.local` with your Clerk keys, Convex URLs, and `LENDLOOP_WEBHOOK_SECRET`.

### Step 3: Start Convex & Set Backend Secrets

```bash
npx convex dev
```

Set the server-side environment variables in your Convex deployment (secrets are never stored in source code):

```bash
npx convex env set CLERK_JWT_ISSUER_DOMAIN "https://your-clerk-domain.clerk.accounts.dev"
npx convex env set ADMIN_EMAILS "your-admin-email@example.com"
npx convex env set LENDLOOP_WEBHOOK_SECRET "your_32_byte_hex_hmac_shared_secret"
npx convex env set N8N_REQUEST_WEBHOOK_URL "http://localhost:5678/webhook/lendloop-loan-event"
```

### Step 4: Start n8n via Docker Compose & Import Workflows

Start the self-hosted n8n container:

```bash
docker compose --env-file .env.local up -d
```

Open `http://localhost:5678` and import the three workflows from `./n8n/workflows` (also mounted inside the container at `/home/node/workflows`):

1. `n8n/workflows/03-error-handler.json` (**Activate first** so its workflow ID can be linked as the `errorWorkflow` for the other two workflows)
2. `n8n/workflows/01-request-notification.json`
3. `n8n/workflows/02-overdue-reminders.json`

Or import them via the n8n CLI inside the container:

```bash
docker exec -u node lendloop-n8n n8n import:workflow --separate --input=/home/node/workflows
```

### Step 5: Start the Next.js Application

```bash
npm run dev
```

Visit `http://localhost:3000`.

---

## 3. Environment Variables Reference

| Variable | Where Configured | Purpose |
| :--- | :--- | :--- |
| `NEXT_PUBLIC_CONVEX_URL` | `.env.local` | Public Convex WebSocket URL (`https://<deployment>.convex.cloud`) |
| `CONVEX_SITE_URL` | `.env.local` & n8n Docker env | Convex HTTP Actions base URL (`https://<deployment>.convex.site`) |
| `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` | `.env.local` | Clerk publishable key for Next.js frontend |
| `CLERK_SECRET_KEY` | `.env.local` | Clerk backend secret key for Next.js middleware |
| `CLERK_JWT_ISSUER_DOMAIN` | Convex env (`npx convex env set`) | Clerk OIDC issuer domain validated by `convex/auth.config.ts` |
| `ADMIN_EMAILS` | Convex env (`npx convex env set`) | Comma-separated emails automatically granted the `admin` role |
| `LENDLOOP_WEBHOOK_SECRET` | Convex env & n8n Docker env | 32-byte shared secret used for bidirectional HMAC-SHA256 signing |
| `N8N_REQUEST_WEBHOOK_URL` | Convex env (`npx convex env set`) | n8n webhook URL (`.../webhook/lendloop-loan-event`) |
| `N8N_ENCRYPTION_KEY` | `.env.local` (Docker Compose) | Encrypts credentials stored in n8n's volume |

---

## 4. n8n Workflows & Reliability Design

### Workflow 01: Request & Status Notification (`01-request-notification.json`)

- **Trigger:** When a borrow request is created (`loan.requested`) or changes status (`loan.approved`, `loan.declined`, `loan.returned`), Convex schedules `internal.n8n.dispatchLoanWebhook`.
- **Outbound Security & Retries:** Convex signs `${timestamp}.${rawBody}` with `LENDLOOP_WEBHOOK_SECRET` (`X-LendLoop-Signature: sha256=<hex>`, `X-LendLoop-Timestamp`, `X-Idempotency-Key`) and retries up to 3 times with exponential backoff. If all attempts fail, Convex records a `status: "failed"` event on the loan so failures never happen silently.
- **Inbound Verification & Write-Back:** n8n verifies the timestamp freshness (`<= 300s`) and HMAC-SHA256 signature using `crypto.timingSafeEqual`, formats a notification for the recipient (`lender` on new request; `borrower` on approve/decline/return), logs/delivers the message, and calls `POST /api/n8n/automation-events` with an HMAC-signed, idempotent acknowledgement (`idempotencyKey: "n8n-ack:<eventId>"`).

### Workflow 02: Daily Overdue Loan Reminders (`02-overdue-reminders.json`)

- **Trigger:** Runs daily at `09:00 UTC` via n8n's `Schedule Trigger`.
- **Signed Polling:** Signs `GET /api/n8n/overdue-loans` with `X-LendLoop-Timestamp` and `X-LendLoop-Signature` (`HMAC-SHA256(secret, "${timestamp}./api/n8n/overdue-loans")`).
- **Per-Borrower Reminder & Idempotent Callback:** Iterates through each overdue loan, sends a reminder using only minimized borrower/tool fields, and writes back to `POST /api/n8n/reminder-callback` with a deterministic `idempotencyKey` (`overdue-reminder:<loanId>:<YYYY-MM-DD>`).

### Workflow 03: Automation Error Handler (`03-error-handler.json`)

- **Trigger:** n8n `Error Trigger` node linked via `"errorWorkflow": "lendloop-error-handler"` in Workflows 01 and 02.
- **Visibility:** Emits structured operator error telemetry (`[LENDLOOP_AUTOMATION_ERROR]`) and sends an HMAC-signed callback to `POST /api/n8n/automation-events` with `status: "failed"`, surfacing failed workflow runs directly inside the LendLoop UI.

---

## 5. Security & Data-Minimization Decisions

1. **Server-Side RBAC Enforced in Convex (Never UI-Only):**
   - Every authenticated query and mutation resolves the caller's identity via `ctx.auth.getUserIdentity()` and looks up their `users` record by verified `clerkId`.
   - Role assignment (`user` vs `admin`) is derived strictly from server-side Clerk JWT claims or the `ADMIN_EMAILS` Convex environment variable — never from client-supplied arguments.
   - `user` role checks (`assertCanEditTool`, `assertCanDeleteTool`, `assertCanReviewLoanRequest`, `assertCanMarkLoanReturned`) ensure neighbors can only edit/delete their own tools and can only approve/decline/return requests on tools they own.
   - `admin` role checks (`requireAdminUser`, `assertCanDeleteTool`) enforce that only admins can call `listAllLoans`, `setTrustedLender`, or remove another user's listing.

2. **Strict Data Minimization Across Boundaries:**
   - **Public Landing Page (`api.tools.listPublicAvailable`):** Projects each available tool through `toPublicToolSummary`, returning **only** `{ _id, name, category }`. Owner IDs, owner names/emails, descriptions, and conditions are stripped on the server before data leaves Convex.
   - **Authenticated Tool Board (`api.tools.listAll`):** Exposes `ownerName` and `ownerIsTrustedLender` badge status, but never exposes neighbor email addresses or `clerkId` values to other users.
   - **n8n Payloads (`buildMinimizedLoanWebhookPayload` & `buildMinimizedOverdueLoanItem`):** Sends only the recipient's name/email, counterparty display name, tool name/category, and loan dates required to render the message.

3. **Bidirectional HMAC-SHA256 & Replay Protection:**
   - Both directions (`Convex -> n8n` and `n8n -> Convex HTTP Actions`) sign `${timestamp}.${payload}` using `LENDLOOP_WEBHOOK_SECRET`.
   - Receivers enforce a strict **300-second timestamp replay window** (`X-LendLoop-Timestamp`) and compare digests in constant time (`constantTimeEqual` / `crypto.timingSafeEqual`) to prevent timing side-channel and replay attacks.

4. **Idempotent Write-Backs:**
   - `automationEvents` is indexed by `by_idempotency_key`. Duplicate deliveries from n8n retries (`n8n-ack:<eventId>` or `overdue-reminder:<loanId>:<YYYY-MM-DD>`) short-circuit cleanly (`{ ok: true, deduplicated: true }`) without incrementing `reminderCount` twice or creating duplicate activity entries.

---

## 6. What I Would Change to Run This in Production

1. **Webhook-Driven Clerk User & Role Synchronization (`svix`):**
   - Replace lazy `ensureCurrentUser` session initialization with a Clerk webhook endpoint (`user.created`, `user.updated`, `user.deleted`) verified via `svix`, keeping roles and profile changes synchronized in real time even when users are offline.
2. **Managed Secrets & Key Rotation (Dual-Key HMAC Window):**
   - Support an array of active webhook secrets (`LENDLOOP_WEBHOOK_SECRET_PRIMARY`, `LENDLOOP_WEBHOOK_SECRET_SECONDARY`) so zero-downtime key rotation can be performed periodically via AWS Secrets Manager / Doppler / GCP Secret Manager.
3. **Cursor-Based Pagination & Search Indexes:**
   - Migrate `tools.listAll`, `loans.listAllLoans`, and `/api/n8n/overdue-loans` from `.collect()` to Convex `.paginate(paginationOpts)` with a full-text search index (`searchIndex`) on tool names/descriptions to support thousands of listings per neighborhood.
4. **Reservation Calendar Conflict Detection & Timezone Normalization:**
   - Instead of a single boolean `isAvailable` flag, store approved booking intervals (`[startDate, endDate]`) per tool and validate non-overlapping date ranges in `requestBorrow` and `approveRequest`, normalized to the neighborhood's local IANA timezone.
5. **Rate Limiting & Abuse Protection:**
   - Add token-bucket rate limiting per `userId` on `requestBorrow` and `createTool` (via `@convex-dev/rate-limiter`) and IP/WAF rate limiting in front of Convex HTTP routes.
6. **Production n8n Deployment & Observability:**
   - Run n8n in Queue Mode backed by Redis and PostgreSQL (instead of SQLite), wire Workflow 03 (`Error Trigger`) to PagerDuty/Slack + Sentry, and use dedicated transactional email credentials (Postmark / AWS SES) stored in n8n's encrypted credential store.

---

## 7. Verification & Automated Tests

Run the automated test suite, TypeScript typechecker, and production Next.js build:

```bash
npm test
npm run typecheck
npm run build
```
