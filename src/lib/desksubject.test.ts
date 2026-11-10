import { describe, expect, it } from "vitest";
import {
  classifyDeskSubject,
  isWholeTurnHold,
  looksLikePersonIntro,
  namesReferToSameGuest,
  stripHoldLead,
} from "./desksubject";

const jane = { name: "Jane McDaniel" };

describe("namesReferToSameGuest", () => {
  it("requires unambiguous identity (full or first-only, not conflicting surname)", () => {
    expect(namesReferToSameGuest("Jane McDaniel", "Jane McDaniel")).toBe(true);
    expect(namesReferToSameGuest("Jane", "Jane McDaniel")).toBe(true);
    expect(namesReferToSameGuest("jane mcdaniel", "Jane McDaniel")).toBe(true);
    expect(namesReferToSameGuest("Jane Smith", "Jane McDaniel")).toBe(false);
    expect(namesReferToSameGuest("Sarah Connor", "Jane McDaniel")).toBe(false);
  });
});

describe("classifyDeskSubject", () => {
  it("same guest: she/her and named active guest with no competing signal", () => {
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

  it("fail-closed: someone + instructions for her clarifies (no note reuse)", () => {
    expect(
      classifyDeskSubject("Did someone leave instructions for her?", jane)
        .kind
    ).toBe("clarify");
  });

  it("same guest: deictic the/our guest + she/her continuity", () => {
    expect(
      classifyDeskSubject("I have the guest here, can she come up?", jane).kind
    ).toBe("same_guest");
    expect(
      classifyDeskSubject("Our guest is in the lobby, can she park?", jane)
        .kind
    ).toBe("same_guest");
  });

  it("new arrival: someone else, person nouns, indefinite someone arrivals", () => {
    for (const u of [
      "I also have someone else here, can he come up?",
      "Someone is downstairs, can they come up?",
      "Can someone park in the garage?",
      "Someone new is here, can she come up?",
      "I have someone here, can she come up?",
      "Got a visitor, can he come up?",
      "There's a man at the door, can he come up?",
      "I have a delivery person here, can they come up?",
      "There's a female visitor downstairs",
      "I have a female guest here, can she come up?",
      "I have a delivery here, can they come up?",
      "Guest in the lobby wants to come up",
      "Visitor downstairs asking for access",
      "There is a housekeeper at the door, can she come up?",
      "There is a housekeeper here, can she come up?",
    ]) {
      expect(classifyDeskSubject(u, jane).kind, u).toBe("new_arrival");
    }
  });

  it("new arrival: different full name / conflicting surname", () => {
    expect(
      classifyDeskSubject("Sarah Connor is at the door, can she come up?", jane, {
        spokenName: "Sarah Connor",
      }).kind
    ).toBe("new_arrival");
    expect(
      classifyDeskSubject("Jane Smith is here, can she come up?", jane, {
        spokenName: "Jane Smith",
      }).kind
    ).toBe("new_arrival");
  });

  it("clarify: he/they location and mixed pronouns after a known guest", () => {
    expect(
      classifyDeskSubject("He's downstairs, can he come up?", jane).kind
    ).toBe("clarify");
    expect(
      classifyDeskSubject("They're waiting outside, can they park?", jane)
        .kind
    ).toBe("clarify");
    expect(
      classifyDeskSubject("He is with her, can he come up?", jane).kind
    ).toBe("clarify");
    expect(
      classifyDeskSubject(
        "The visitor is downstairs, can they come up?",
        jane
      ).kind
    ).toBe("clarify");
  });

  it("clarify: deictic the/this/our guest + location without she/her (no note reuse)", () => {
    expect(
      classifyDeskSubject("The guest in the lobby wants to come up", jane)
        .kind
    ).toBe("clarify");
    expect(
      classifyDeskSubject(
        "The visitor is downstairs asking for access",
        jane
      ).kind
    ).toBe("clarify");
    expect(
      classifyDeskSubject("This guest is at the door, can they come up?", jane)
        .kind
    ).toBe("clarify");
    expect(
      classifyDeskSubject("Our guest is in the lobby", jane).kind
    ).toBe("clarify");
    expect(
      classifyDeskSubject("This guest is waiting outside", jane).kind
    ).toBe("clarify");
    expect(classifyDeskSubject("The guest is here", jane).kind).toBe(
      "clarify"
    );
    expect(classifyDeskSubject("The guest arrived", jane).kind).toBe(
      "clarify"
    );
    expect(classifyDeskSubject("This guest is here", jane).kind).toBe(
      "clarify"
    );
    expect(classifyDeskSubject("Our guest arrived", jane).kind).toBe(
      "clarify"
    );
    expect(classifyDeskSubject("Our guest is here", jane).kind).toBe(
      "clarify"
    );
  });

  it("new arrival: companion of known guest or different access name", () => {
    expect(
      classifyDeskSubject("A friend of Jane is here, can they come up?", jane, {
        spokenName: "Jane",
      }).kind
    ).toBe("new_arrival");
    expect(
      classifyDeskSubject("Jane is here, can Bob come up?", jane, {
        spokenName: "Jane",
      }).kind
    ).toBe("new_arrival");
    expect(
      classifyDeskSubject("Can Bob come up?", jane).kind
    ).toBe("new_arrival");
    expect(
      classifyDeskSubject("Can Bob please come up?", jane).kind
    ).toBe("new_arrival");
  });

  it("same guest: access name with trailing filler, not a conflicting surname", () => {
    expect(
      classifyDeskSubject("Can Jane please come up?", jane).kind
    ).toBe("same_guest");
    expect(
      classifyDeskSubject("Can Jane still come up?", jane).kind
    ).toBe("same_guest");
    expect(
      classifyDeskSubject("Can Jane McDaniel please come up?", jane).kind
    ).toBe("same_guest");
  });

  it("same guest: given names that look like determiners (An, My)", () => {
    const an = { name: "An Nguyen" };
    const my = { name: "My Tran" };
    expect(classifyDeskSubject("Can An Nguyen come up?", an).kind).toBe(
      "same_guest"
    );
    expect(classifyDeskSubject("Can An come up?", an).kind).toBe("same_guest");
    expect(classifyDeskSubject("Can My Tran come up?", my).kind).toBe(
      "same_guest"
    );
    expect(classifyDeskSubject("Can My come up?", my).kind).toBe("same_guest");
  });

  it("same guest: deictic can the/our guest come up (not a new arrival)", () => {
    expect(
      classifyDeskSubject("Can the guest come up?", jane).kind
    ).toBe("same_guest");
    expect(
      classifyDeskSubject("Can our guest come up?", jane).kind
    ).toBe("same_guest");
    expect(
      classifyDeskSubject("Can this guest come up?", jane).kind
    ).toBe("same_guest");
    expect(
      classifyDeskSubject("Can my guest come up?", jane).kind
    ).toBe("same_guest");
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
    expect(
      looksLikePersonIntro("There is a housekeeper at the door")
    ).toBe(true);
    expect(looksLikePersonIntro("There is a housekeeper here")).toBe(true);
    expect(looksLikePersonIntro("I have someone here")).toBe(true);
    expect(looksLikePersonIntro("Does she have visitor parking?")).toBe(false);
    expect(
      looksLikePersonIntro("I also have a question about the guest")
    ).toBe(false);
    expect(
      looksLikePersonIntro("I have the guest here, can she come up?")
    ).toBe(false);
    expect(
      looksLikePersonIntro("Our guest is in the lobby, can she park?")
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
