import { db } from "./db";
import { sendPushover } from "./pushover";
import { sendWebPushToAll } from "./webpush";

export type NotifyEvent =
  | "call.started"
  | "guest.admitted"
  | "guest.denied"
  | "call.transfer"
  | "message.taken"
  | "call.ended"
  | "system.error"
  | "system.test";

/** Canonical Pushover titles — keep these exact strings (see PROMPT.md §3).
 *  call.transfer is dynamic: pass title `📲 Transferring to {target}`. */
export const EVENT_TITLES: Record<NotifyEvent, string> = {
  "call.started": "📞 Front Desk Call",
  "guest.admitted": "✅ Guest Admitted",
  "guest.denied": "⛔ No Guest Match",
  "call.transfer": "📲 Transferring",
  "message.taken": "📝 Message From Concierge",
  "call.ended": "☎️ Call Ended",
  "system.error": "🚨 Concierge System Error",
  "system.test": "🔔 Test Notification",
};

export interface NotifyInput {
  event: NotifyEvent;
  /** Override the catalog title (required for call.transfer to name the target). */
  title?: string;
  message: string;
  priority?: number;
  url?: string;
}

/**
 * The single notification fan-out: Pushover + Web Push + DB log.
 * Never throws into callers; failures are logged and, when the failure is not
 * Pushover itself, self-reported via a system.error Pushover.
 */
export async function notify(input: NotifyInput): Promise<void> {
  const title = input.title ?? EVENT_TITLES[input.event];
  const priority =
    input.priority ?? (input.event === "system.error" ? 1 : undefined);
  let pushoverOk = false;
  let webpushSent = 0;
  try {
    [pushoverOk, webpushSent] = await Promise.all([
      sendPushover({ title, message: input.message, priority, url: input.url }),
      sendWebPushToAll({
        event: input.event,
        title,
        message: input.message,
        url: input.url,
      }),
    ]);
  } catch (e) {
    console.error("notify: fan-out error", e);
  }
  try {
    await db()`
      insert into notifications (event, title, message, pushover_ok, webpush_sent)
      values (${input.event}, ${title}, ${input.message}, ${pushoverOk}, ${webpushSent})`;
  } catch (e) {
    console.error("notify: DB log failed", e);
    if (input.event !== "system.error") {
      await sendPushover({
        title: EVENT_TITLES["system.error"],
        message: `Notification DB log failed for ${input.event}`,
        priority: 1,
      }).catch(() => {});
    }
  }
}
