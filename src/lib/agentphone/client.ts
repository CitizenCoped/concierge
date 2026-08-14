const BASE = "https://api.agentphone.ai/v1";

function headers(): Record<string, string> {
  return {
    Authorization: `Bearer ${process.env.AGENTPHONE_API_KEY}`,
    "Content-Type": "application/json",
  };
}

export async function getAgent(agentId: string): Promise<Record<string, unknown> | null> {
  const res = await fetch(`${BASE}/agents/${agentId}`, { headers: headers() });
  if (!res.ok) return null;
  return (await res.json()) as Record<string, unknown>;
}

export async function patchAgent(
  agentId: string,
  fields: Record<string, unknown>
): Promise<boolean> {
  try {
    const res = await fetch(`${BASE}/agents/${agentId}`, {
      method: "PATCH",
      headers: headers(),
      body: JSON.stringify(fields),
    });
    if (!res.ok) {
      console.error("agentphone: PATCH agent failed", res.status, await res.text());
    }
    return res.ok;
  } catch (e) {
    console.error("agentphone: PATCH agent network error", e);
    return false;
  }
}

/** Set the cold-transfer target for the concierge agent. Must succeed BEFORE
 *  responding with `action: "transfer"` (transfer is agent-level, not per-call). */
export async function setTransferNumber(target: string): Promise<boolean> {
  const agentId = process.env.AGENTPHONE_AGENT_ID;
  if (!agentId || !target) return false;
  return patchAgent(agentId, { transferNumber: target });
}

/** Create or update the agent-level webhook; the response contains the signing
 *  secret (only place it is ever exposed). Used by the provisioning script. */
export async function createOrUpdateAgentWebhook(
  agentId: string,
  url: string
): Promise<{ secret: string } | null> {
  const res = await fetch(`${BASE}/agents/${agentId}/webhook`, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify({ url }),
  });
  if (!res.ok) {
    console.error("agentphone: webhook upsert failed", res.status, await res.text());
    return null;
  }
  return (await res.json()) as { secret: string };
}
