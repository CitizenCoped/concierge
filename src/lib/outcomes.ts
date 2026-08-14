export const OUTCOME_BADGES: Record<string, { label: string; cls: string }> = {
  guest_admitted: {
    label: "✅ Admitted",
    cls: "bg-green-100 text-green-800 dark:bg-green-900/50 dark:text-green-300",
  },
  no_match_transferred: {
    label: "⛔ No match",
    cls: "bg-red-100 text-red-800 dark:bg-red-900/50 dark:text-red-300",
  },
  transfer_attempted: {
    label: "📲 Transferred",
    cls: "bg-blue-100 text-blue-800 dark:bg-blue-900/50 dark:text-blue-300",
  },
  message_taken: {
    label: "📝 Message",
    cls: "bg-amber-100 text-amber-800 dark:bg-amber-900/50 dark:text-amber-300",
  },
  hangup: {
    label: "☎️ Ended",
    cls: "bg-neutral-200 text-neutral-600 dark:bg-neutral-800 dark:text-neutral-300",
  },
  error: {
    label: "🚨 Error",
    cls: "bg-red-100 text-red-800 dark:bg-red-900/50 dark:text-red-300",
  },
  in_progress: {
    label: "⏳ In progress",
    cls: "bg-blue-100 text-blue-800 dark:bg-blue-900/50 dark:text-blue-300",
  },
};
