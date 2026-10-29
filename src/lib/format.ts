/**
 * Human-readable relative time formatting for loan automation activity badges
 * (e.g., "Reminder sent 2 days ago", "Approval notification sent 5m ago").
 */
export function formatRelativeTime(
  timestampMs: number | undefined,
  nowMs: number = Date.now()
): string {
  if (!timestampMs || !Number.isFinite(timestampMs)) {
    return "";
  }
  const diffSec = Math.max(0, Math.floor((nowMs - timestampMs) / 1000));
  if (diffSec < 45) {
    return "just now";
  }
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) {
    return `${diffMin}m ago`;
  }
  const diffHours = Math.floor(diffMin / 60);
  if (diffHours < 24) {
    return `${diffHours}h ago`;
  }
  const diffDays = Math.floor(diffHours / 24);
  if (diffDays === 1) {
    return "1 day ago";
  }
  return `${diffDays} days ago`;
}

/**
 * Formats the primary automation activity line shown on each loan card.
 * Prioritizes overdue reminder timestamps ("Reminder sent X days ago") when present,
 * falling back to the latest n8n webhook/callback activity summary.
 */
export function formatLoanAutomationBadge(params: {
  lastReminderSentAt?: number;
  lastAutomationSummary?: string;
  lastAutomationAt?: number;
  nowMs?: number;
}): string | null {
  const {
    lastReminderSentAt,
    lastAutomationSummary,
    lastAutomationAt,
    nowMs = Date.now(),
  } = params;

  if (
    lastReminderSentAt &&
    (!lastAutomationAt || lastReminderSentAt >= lastAutomationAt)
  ) {
    const rel = formatRelativeTime(lastReminderSentAt, nowMs);
    return `Reminder sent ${rel}`;
  }

  if (lastAutomationSummary) {
    const rel = lastAutomationAt
      ? formatRelativeTime(lastAutomationAt, nowMs)
      : "";
    return rel ? `${lastAutomationSummary} · ${rel}` : lastAutomationSummary;
  }

  return null;
}
