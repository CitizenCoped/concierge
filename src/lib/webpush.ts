import webpush from "web-push";
import { db } from "./db";

let vapidConfigured = false;

function configureVapid(): boolean {
  if (vapidConfigured) return true;
  const pub = process.env.VAPID_PUBLIC_KEY;
  const priv = process.env.VAPID_PRIVATE_KEY;
  const subject = process.env.VAPID_SUBJECT;
  if (!pub || !priv || !subject) {
    console.error("webpush: VAPID env vars not set");
    return false;
  }
  webpush.setVapidDetails(subject, pub, priv);
  vapidConfigured = true;
  return true;
}

export interface WebPushPayload {
  event: string;
  title: string;
  message: string;
  url?: string;
}

interface SubscriptionRow {
  id: string;
  endpoint: string;
  keys: { p256dh: string; auth: string };
}

/**
 * Send a Web Push notification to every stored subscription, pruning
 * subscriptions the push service reports as gone (404/410).
 * Returns the number of successful sends. Never throws.
 */
export async function sendWebPushToAll(payload: WebPushPayload): Promise<number> {
  if (!configureVapid()) return 0;
  let subs: SubscriptionRow[];
  try {
    subs = (await db()`select id, endpoint, keys from push_subscriptions`) as SubscriptionRow[];
  } catch (e) {
    console.error("webpush: failed to load subscriptions", e);
    return 0;
  }
  let sent = 0;
  await Promise.all(
    subs.map(async (sub) => {
      try {
        await webpush.sendNotification(
          { endpoint: sub.endpoint, keys: sub.keys },
          JSON.stringify(payload)
        );
        sent++;
      } catch (e) {
        const statusCode = (e as { statusCode?: number }).statusCode;
        if (statusCode === 404 || statusCode === 410) {
          try {
            await db()`delete from push_subscriptions where id = ${sub.id}`;
          } catch (delErr) {
            console.error("webpush: failed to prune dead subscription", delErr);
          }
        } else {
          console.error("webpush: send failed", statusCode, e);
        }
      }
    })
  );
  return sent;
}
