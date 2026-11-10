import { describe, expect, it } from "vitest";
import {
  classifyDeskSubject,
  isWholeTurnHold,
  stripHoldLead,
} from "./desksubject";

const jane = { name: "Jane McDaniel" };

describe("classifyDeskSubject", () => {
  it("same guest: she/her and named active guest", () => {
    expect(
      classifyDeskSubject("Can she still use the garage?", jane).kind
    ).toBe("same_guest");
    expect(
      classifyDeskSubject("She's in the lobby, can she park?", jane).kind
    ).toBe("same_guest");
    expect(
      classifyDeskSubject("Does she have visitor parking?", jane, {
        spokenName: null,
      }).kind
    ).toBe("same_guest");
    expect(
      classifyDeskSubject("Is Jane allowed in the garage?", jane, {
        spokenName: "Jane",
      }).kind
    ).toBe("same_guest");
  });

  it("new arrival: someone else, person nouns, indefinite someone", () => {
    for (const u of [
      "I also have someone else here, can he come up?",
      "Someone is downstairs, can they come up?",
      "Got a visitor, can he come up?",
      "There's a man at the door, can he come up?",
      "I have a delivery person here, can they come up?",
      "There's a female visitor downstairs",
      "I have a delivery here, can they come up?",
    ]) {
      expect(classifyDeskSubject(u, jane).kind, u).toBe("new_arrival");
    }
  });

  it("clarify: he/they location after a known she/her guest", () => {
    expect(
      classifyDeskSubject("He's downstairs, can he come up?", jane).kind
    ).toBe("clarify");
    expect(
      classifyDeskSubject("They're waiting outside, can they park?", jane)
        .kind
    ).toBe("clarify");
  });

  it("visitor parking compound is not a new person", () => {
    expect(
      classifyDeskSubject("Does she have visitor parking available?", jane)
        .kind
    ).toBe("same_guest");
    expect(
      classifyDeskSubject("Can she use the visitor pass?", jane).kind
    ).toBe("same_guest");
  });
});

describe("hold helpers", () => {
  it("whole-turn hold variants soft-close", () => {
    for (const u of [
      "hold on",
      "hold on please",
      "hold on a second",
      "hold on a moment please",
      "one second please",
      "just a minute",
      "let me check",
      "give me a second",
    ]) {
      expect(isWholeTurnHold(u), u).toBe(true);
    }
    expect(isWholeTurnHold("Hold on, can she park?")).toBe(false);
  });

  it("stripHoldLead keeps the question", () => {
    expect(stripHoldLead("Hold on, can she still use the garage?")).toBe(
      "can she still use the garage?"
    );
    expect(stripHoldLead("hold on please")).toBe("");
  });
});
