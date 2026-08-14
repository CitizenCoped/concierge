/**
 * Idempotent AgentPhone provisioning:
 *  - configures the concierge agent (webhook voice mode, greeting, STT,
 *    transfer default, silence timeout)
 *  - verifies the dedicated number is attached
 *  - creates (or reuses) the AGENT-LEVEL webhook pointed at the prod URL and
 *    captures its signing secret into .env.local
 *
 * NEVER touches the project-level webhook — it belongs to a different app.
 *
 *   npm run provision -- https://<prod-domain>
 */
import { readFileSync, writeFileSync } from "node:fs";
import { loadEnv } from "./env";

loadEnv();

const BASE = "https://api.agentphone.ai/v1";
const API_KEY = process.env.AGENTPHONE_API_KEY;
const AGENT_ID = process.env.AGENTPHONE_AGENT_ID;
const NUMBER = process.env.AGENTPHONE_NUMBER;
const SCOTT = process.env.SCOTT_PHONE;

const GREETING =
  "Hi, this is Scott and Monica's automated concierge assistant. How can I help you?";

function headers(): Record<string, string> {
  return { Authorization: `Bearer ${API_KEY}`, "Content-Type": "application/json" };
}

async function api(
  method: string,
  path: string,
  body?: object
): Promise<{ status: number; json: Record<string, unknown> | null }> {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: headers(),
    body: body ? JSON.stringify(body) : undefined,
  });
  let json: Record<string, unknown> | null = null;
  try {
    json = (await res.json()) as Record<string, unknown>;
  } catch {
    json = null;
  }
  return { status: res.status, json };
}

function setEnvLocal(key: string, value: string) {
  const path = ".env.local";
  let content = readFileSync(path, "utf8");
  const line = `${key}=${value}`;
  if (new RegExp(`^${key}=`, "m").test(content)) {
    content = content.replace(new RegExp(`^${key}=.*$`, "m"), line);
  } else {
    content += `\n${line}\n`;
  }
  writeFileSync(path, content);
}

async function main() {
  const prodUrl = (process.argv[2] ?? process.env.APP_URL ?? "").replace(/\/$/, "");
  if (!API_KEY || !AGENT_ID || !NUMBER || !SCOTT) {
    console.error("Missing AGENTPHONE_* / SCOTT_PHONE env vars");
    process.exit(1);
  }
  if (!prodUrl.startsWith("https://")) {
    console.error("Usage: npm run provision -- https://<prod-domain>");
    process.exit(1);
  }
  const webhookUrl = `${prodUrl}/api/agentphone/webhook`;

  // 1. Configure the agent
  const patch = await api("PATCH", `/agents/${AGENT_ID}`, {
    name: "Angel Concierge",
    description:
      "Front-desk concierge for Scott & Monica's building — guest list, transfers, messages.",
    voiceMode: "webhook",
    beginMessage: GREETING,
    transferNumber: SCOTT,
    sttMode: "accurate",
    maxSilenceMs: 60000,
  });
  if (patch.status !== 200) {
    console.error("agent PATCH failed", patch.status, patch.json);
    process.exit(1);
  }
  console.log(`✅ agent configured: ${AGENT_ID} ("Angel Concierge")`);

  // 2. Verify the dedicated number is attached
  const agent = await api("GET", `/agents/${AGENT_ID}`);
  const numbers = (agent.json?.numbers ?? []) as Array<{ phoneNumber?: string }>;
  if (numbers.some((n) => n.phoneNumber === NUMBER)) {
    console.log(`✅ number attached: ${NUMBER}`);
  } else {
    console.error(
      `❌ ${NUMBER} is NOT attached to agent ${AGENT_ID} — attach it in the dashboard`
    );
    process.exit(1);
  }

  // 3. Agent-level webhook (create or reuse; secret only returned by the API).
  // timeout 60s: transfers hold the concierge ~20s waiting for an ack, so the
  // default 30s delivery timeout is too tight.
  const WEBHOOK_TIMEOUT = 60;
  const existing = await api("GET", `/agents/${AGENT_ID}/webhook`);
  const ex = existing.json as {
    url?: string;
    secret?: string;
    timeout?: number;
  } | null;
  let secret: string | undefined;
  if (ex && ex.url === webhookUrl && ex.timeout === WEBHOOK_TIMEOUT && ex.secret) {
    secret = ex.secret;
    console.log(`✅ agent webhook already points at ${webhookUrl}`);
  } else {
    const created = await api("POST", `/agents/${AGENT_ID}/webhook`, {
      url: webhookUrl,
      timeout: WEBHOOK_TIMEOUT,
    });
    secret = (created.json as { secret?: string } | null)?.secret;
    if (created.status !== 200 || !secret) {
      console.error("webhook create failed", created.status, created.json);
      process.exit(1);
    }
    console.log(`✅ agent webhook created → ${webhookUrl}`);
  }

  setEnvLocal("AGENTPHONE_WEBHOOK_SECRET", secret);
  setEnvLocal("APP_URL", prodUrl);
  console.log("✅ AGENTPHONE_WEBHOOK_SECRET saved to .env.local");
  console.log(
    "\n⚠️  Remember: set AGENTPHONE_WEBHOOK_SECRET in the Vercel env to the same value and redeploy."
  );
  console.log(`\n📞 Front-desk number: ${NUMBER}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
