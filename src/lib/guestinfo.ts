import { generateText, Output } from "ai";
import { z } from "zod";

/** Cap so a slow model never stalls the front-desk line. */
export const GUEST_INFO_TIMEOUT_MS = 2_500;

const DEFAULT_MODEL = "openai/gpt-4.1-mini";

export interface GuestInfoAnswer {
  /** yes/no for permissions; answered for grounded factual/instruction replies. */
  answer: "yes" | "no" | "unclear" | "answered";
  reply: string;
}

const answerSchema = z.object({
  answer: z.enum(["yes", "no", "unclear", "answered"]),
  reply: z
    .string()
    .describe("One short spoken sentence for the front-desk concierge."),
});

/**
 * Narrow LLM step: answer a concierge question using ONLY the guest's notes.
 * Covers permissions and factual/instruction follow-ups (arrival time, what to
 * tell the guest, delivery placement, special instructions, etc.).
 * Returns null on timeout/parse/network errors so the callflow can offer a transfer.
 */
export async function answerFromGuestInfo(input: {
  guestName: string;
  guestInfo: string;
  question: string;
}): Promise<GuestInfoAnswer | null> {
  const info = input.guestInfo.trim();
  if (!info) return null;

  const model = process.env.AI_GATEWAY_MODEL?.trim() || DEFAULT_MODEL;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), GUEST_INFO_TIMEOUT_MS);

  try {
    const { output } = await generateText({
      model,
      abortSignal: controller.signal,
      timeout: GUEST_INFO_TIMEOUT_MS,
      temperature: 0,
      instructions: [
        "You are Angel Concierge's notes checker for a condo front desk.",
        "Answer the concierge's question using ONLY the provided guest notes.",
        "Never invent permissions, access, parking, arrival times, delivery instructions, or other facts the notes do not clearly support.",
        "Do not infer building access or parking merely because the guest is on the list — only what the notes say.",
        "For yes/no permission questions: answer yes or no when the notes clearly support it.",
        "For factual or instruction questions (expected time, what to tell them, where to leave a delivery, special instructions): use answer=answered and put the fact in reply when the notes contain it.",
        "If the notes do not clearly answer, set answer to unclear.",
        "reply must be one short spoken sentence suitable for a phone call.",
        "When answering, name the guest when natural.",
        "When unclear, reply can briefly say you need to check with the residents.",
      ].join(" "),
      prompt: [
        `Guest name: ${input.guestName}`,
        `Guest notes:\n${info}`,
        `Concierge question: ${input.question}`,
      ].join("\n\n"),
      output: Output.object({ schema: answerSchema }),
    });

    if (!output?.reply?.trim()) return null;
    return {
      answer: output.answer,
      reply: output.reply.trim(),
    };
  } catch (e) {
    console.error("guestinfo: answerFromGuestInfo failed", e);
    return null;
  } finally {
    clearTimeout(timer);
  }
}
