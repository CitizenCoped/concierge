export interface PushoverMessage {
  title: string;
  message: string;
  priority?: number;
  url?: string;
}

/**
 * POST a message to the Pushover REST API. Returns true on success.
 * Do not call from route handlers — go through notify() in notify.ts.
 */
export async function sendPushover(msg: PushoverMessage): Promise<boolean> {
  const token = process.env.PUSHOVER_APP_TOKEN;
  const user = process.env.PUSHOVER_USER_KEY;
  if (!token || !user) {
    console.error("pushover: PUSHOVER_APP_TOKEN / PUSHOVER_USER_KEY not set");
    return false;
  }
  const body = new URLSearchParams({
    token,
    user,
    title: msg.title,
    message: msg.message,
  });
  if (msg.priority !== undefined) body.set("priority", String(msg.priority));
  if (msg.url) body.set("url", msg.url);
  try {
    const res = await fetch("https://api.pushover.net/1/messages.json", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
    });
    const json = (await res.json()) as { status?: number; errors?: string[] };
    if (json.status !== 1) {
      console.error("pushover: send failed", res.status, json.errors);
      return false;
    }
    return true;
  } catch (e) {
    console.error("pushover: network error", e);
    return false;
  }
}
