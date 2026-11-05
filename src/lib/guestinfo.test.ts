import { describe, expect, it } from "vitest";
import { answerFromGuestInfo } from "./guestinfo";

describe("answerFromGuestInfo", () => {
  it("returns null immediately when notes are empty (no LLM call)", async () => {
    const r = await answerFromGuestInfo({
      guestName: "Jane McDaniel",
      guestInfo: "   ",
      question: "Is Jane allowed to park in the garage?",
    });
    expect(r).toBeNull();
  });
});
