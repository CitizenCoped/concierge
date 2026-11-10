import { describe, expect, it } from "vitest";
import {
  classifyDeskSubject,
  isWholeTurnHold,
  looksLikePersonIntro,
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
    expect(
      classifyDeskSubject("I also have a question about the guest", jane).kind
    ).toBe("same_guest");
  });

  it("same guest: someone + instructions for her (not an arrival)", () => {
    expect(
      classifyDeskSubject("Did someone leave instructions for her?", jane)
        .kind
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
      "I have a female guest here, can she come up?",
      "I have a delivery here, can they come up?",
      "Guest in the lobby wants to come up",
      "Visitor downstairs asking for access",
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
    // the/this + location is ambiguous after a known guest — clarify, not notes
    expect(
      classifyDeskSubject(
        "The visitor is downstairs, can they come up?",
        jane
      ).kind
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

  it("looksLikePersonIntro covers descriptive and bare lobby arrivals", () => {
    expect(looksLikePersonIntro("I have a female guest here")).toBe(true);
    expect(looksLikePersonIntro("Guest in the lobby wants to come up")).toBe(
      true
    );
    expect(looksLikePersonIntro("Does she have visitor parking?")).toBe(false);
    expect(
      looksLikePersonIntro("I also have a question about the guest")
    ).toBe(false);
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
