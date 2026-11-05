import { generateText, Output } from "ai";
import { z } from "zod";

/** Cap so a slow model never stalls the front-desk line. */
export const GUEST_INFO_TIMEOUT_MS = 2_500;

const DEFAULT_MODEL = "openai/gpt-4.1-mini";

export interface GuestInfoAnswer {
  answer: "yes" | "no" | "unclear";
  reply: string;
}

const answerSchema = z.object({
  answer: z.enum(["yes", "no", "unclear"]),
  reply: z
    .string()
    .describe("One short spoken sentence for the front-desk concierge."),
});

/**
 * Narrow LLM step: answer a permission question using ONLY the guest's notes.
 * Returns null on timeout, missing credentials, parse failure, or thrown errors
 * so the callflow can fall back to a transfer.
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
        "Never invent permissions, access, parking rights, or unit entry that the notes do not clearly support.",
        "If the notes do not clearly yes-or-no answer the question, set answer to unclear.",
        "reply must be one short spoken sentence suitable for a phone call.",
        "When answer is yes or no, name the guest and restate the relevant permission from the notes.",
        "When answer is unclear, reply can be a brief apology that you need to check with the residents.",
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
