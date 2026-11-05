import { describe, expect, it } from "vitest";
import {
  INITIAL_STATE,
  cleanSpokenName,
  extractName,
  extractQuestionGuestName,
  isPartialName,
  looksLikeGuestPermissionQuestion,
  step,
  transferFailedResult,
  type CallflowDeps,
  type Effect,
  type GuestInfoQaResult,
} from "./callflow";
import type { Guest } from "./db/guests";

const guest = (name: string, guest_info: string | null = null): Guest => ({
  id: "00000000-0000-0000-0000-000000000001",
  name,
  guest_info,
  guest_phone: null,
  starts_at: "",
  ends_at: "",
  created_at: "",
  updated_at: "",
  archived: false,
});

const depsWith = (
  impl: CallflowDeps["matchGuest"],
  answerGuestInfo?: CallflowDeps["answerGuestInfo"]
): CallflowDeps => ({
  matchGuest: impl,
  ...(answerGuestInfo ? { answerGuestInfo } : {}),
});

const noMatch = depsWith(async () => ({ match: null, candidates: [] }));

function notifyEvents(effects: Effect[]): string[] {
  return effects.filter((e) => e.type === "notify").map((e) => e.event);
}

function outcomeOf(effects: Effect[]): string | undefined {
  return effects.findLast((e) => e.type === "outcome")?.outcome;
}

describe("name extraction", () => {
  it("extracts Sarah Connor from a sentence with a trailing question", () => {
    const u =
      "Yeah, I have a guest here. Her name is Sarah Connor. Is she allowed to come up?";
    expect(extractName(u)).toBe("Sarah Connor");
    expect(cleanSpokenName("Sarah Connor. Is she allowed to come up?")).toBe(
      "Sarah Connor"
    );
  });

  it("does not swallow trailing clauses into the name", () => {
    expect(cleanSpokenName("John Smith. Can he come up?")).toBe("John Smith");
    expect(isPartialName("Connor")).toBe(true);
    expect(isPartialName("Sarah Connor")).toBe(false);
  });

  it("extracts a guest name from a garage permission question", () => {
    expect(
      extractQuestionGuestName("Is Jane allowed to park in the garage?")
    ).toBe("Jane");
    expect(
      looksLikeGuestPermissionQuestion("Is Jane allowed to park in the garage?")
    ).toBe(true);
  });

  it("does not treat pronouns as guest names in permission questions", () => {
    expect(extractQuestionGuestName("Is she allowed to park in the garage?")).toBe(
      null
    );
    expect(extractQuestionGuestName("Can he come up?")).toBe(null);
    expect(extractQuestionGuestName("Are they permitted entry?")).toBe(null);
  });
});

describe("guest_info permission Q&A", () => {
  const janeNotes =
    "House keeper for scott and Monica. Jane is allowed access to our condo unit and access to the secured parking underground.";
  const jane = guest("Jane McDaniel", janeNotes);

  it("garage question for active Jane → yes answer from notes", async () => {
    const deps = depsWith(
      async (name) => {
        expect(name).toBe("Jane");
        return { match: jane, candidates: [jane] };
      },
      async () =>
        ({
          answer: "yes",
          reply:
            "Yes, Jane McDaniel has access to the secured underground parking.",
        }) satisfies GuestInfoQaResult
    );
    const r = await step(
      { phase: "INTENT" },
      "Is Jane allowed to park in the garage?",
      deps
    );
    expect(r.action).toBeUndefined();
    expect(r.reply).toContain("Jane McDaniel");
    expect(r.reply.toLowerCase()).toMatch(/parking|garage|underground/);
    expect(notifyEvents(r.effects)).toContain("guest.info_answered");
    expect(r.nextState.phase).toBe("INTENT");
  });

  it("question not covered by the notes → transfer", async () => {
    const deps = depsWith(
      async () => ({ match: jane, candidates: [jane] }),
      async () => ({ answer: "unclear", reply: "I need to check with Scott." })
    );
    const r = await step(
      { phase: "INTENT" },
      "Is Jane allowed to use the rooftop pool?",
      deps
    );
    expect(r.action).toBe("transfer");
    expect(r.transferTarget).toBe("scott");
    expect(notifyEvents(r.effects)).not.toContain("guest.info_answered");
  });

  it("inactive / unknown guest → no answer from notes, transfer", async () => {
    let answered = false;
    const deps = depsWith(
      async () => ({ match: null, candidates: [] }),
      async () => {
        answered = true;
        return { answer: "yes", reply: "should not run" };
      }
    );
    const r = await step(
      { phase: "INTENT" },
      "Is Jane allowed to park in the garage?",
      deps
    );
    expect(answered).toBe(false);
    expect(r.action).toBe("transfer");
    expect(notifyEvents(r.effects)).not.toContain("guest.info_answered");
  });

  it("empty guest_info → transfer without calling the LLM", async () => {
    const bare = guest("Jane McDaniel", null);
    let answered = false;
    const deps = depsWith(
      async () => ({ match: bare, candidates: [bare] }),
      async () => {
        answered = true;
        return { answer: "yes", reply: "should not run" };
      }
    );
    const r = await step(
      { phase: "INTENT" },
      "Is Jane allowed to park in the garage?",
      deps
    );
    expect(answered).toBe(false);
    expect(r.action).toBe("transfer");
  });

  it("visitor arrival flow is unchanged even with a trailing come-up question", async () => {
    let qaCalls = 0;
    const deps = depsWith(
      async (name) => {
        expect(name).toBe("Jane McDaniel");
        return { match: jane, candidates: [jane] };
      },
      async () => {
        qaCalls += 1;
        return { answer: "yes", reply: "should not run for visitor admit" };
      }
    );
    const r = await step(
      { phase: "INTENT" },
      "Jane McDaniel is here to see Scott",
      deps
    );
    expect(qaCalls).toBe(0);
    expect(r.action).toBe("hangup");
    expect(outcomeOf(r.effects)).toBe("guest_admitted");
    expect(notifyEvents(r.effects)).toContain("guest.admitted");
    expect(notifyEvents(r.effects)).not.toContain("guest.info_answered");
  });

  it("visitor arrival still admits when the line also mentions parking", async () => {
    let qaCalls = 0;
    const deps = depsWith(
      async (name) => {
        expect(name).toBe("Jane McDaniel");
        return { match: jane, candidates: [jane] };
      },
      async () => {
        qaCalls += 1;
        return { answer: "yes", reply: "should not run for visitor admit" };
      }
    );
    const r = await step(
      { phase: "INTENT" },
      "Jane McDaniel is here in the lobby — is she allowed to park in the garage?",
      deps
    );
    expect(qaCalls).toBe(0);
    expect(r.action).toBe("hangup");
    expect(outcomeOf(r.effects)).toBe("guest_admitted");
    expect(notifyEvents(r.effects)).toContain("guest.admitted");
    expect(notifyEvents(r.effects)).not.toContain("guest.info_answered");
  });

  it("pronoun-only parking question does not answer from another guest's notes", async () => {
    const sue = guest("Sue Park", janeNotes);
    let answered = false;
    const deps = depsWith(
      async (name) => {
        // Would fuzzy-match "she" → "Sue" if pronouns were accepted as names.
        expect(name).not.toMatch(/^(she|he|they)$/i);
        return { match: sue, candidates: [sue] };
      },
      async () => {
        answered = true;
        return { answer: "yes", reply: "should not run for pronoun-only Q" };
      }
    );
    const r = await step(
      { phase: "INTENT" },
      "Is she allowed to park in the garage?",
      deps
    );
    expect(answered).toBe(false);
    expect(r.action).toBe("transfer");
    expect(notifyEvents(r.effects)).not.toContain("guest.info_answered");
  });
});

describe("callflow", () => {
  it("greets and fires call.started on the first turn", async () => {
    const r = await step(INITIAL_STATE, "", noMatch);
    expect(r.reply).toBe(
      "Hello, Scott and Monica's AI assistant here. What's up?"
    );
    expect(notifyEvents(r.effects)).toContain("call.started");
    expect(r.nextState.phase).toBe("INTENT");
  });

  it("repeat hello on INTENT gets a short What's up?", async () => {
    const r = await step({ phase: "INTENT" }, "Hello?", noMatch);
    expect(r.reply).toBe("What's up?");
    expect(r.nextState.phase).toBe("INTENT");
  });

  it("happy path: announcement with name → admitted + hangup", async () => {
    const deps = depsWith(async (name) => {
      expect(name).toBe("John Smith");
      return { match: guest("John Smith"), candidates: [guest("John Smith")] };
    });
    const r = await step(
      { phase: "INTENT" },
      "I have John Smith here in the lobby",
      deps
    );
    expect(r.reply).toContain("okay to send them up");
    expect(r.action).toBe("hangup");
    expect(notifyEvents(r.effects)).toContain("guest.admitted");
    expect(outcomeOf(r.effects)).toBe("guest_admitted");
  });

  it("live regression: Sarah Connor announcement extracts cleanly and admits", async () => {
    const deps = depsWith(async (name) => {
      expect(name).toBe("Sarah Connor");
      return { match: guest("Sera Connor"), candidates: [guest("Sera Connor")] };
    });
    const r = await step(
      { phase: "INTENT" },
      "Yeah, I have a guest here. Her name is Sarah Connor. Is she allowed to come up?",
      deps
    );
    expect(r.action).toBe("hangup");
    expect(outcomeOf(r.effects)).toBe("guest_admitted");
    expect(r.reply).toContain("Sera Connor");
  });

  it("announcement without a name asks for it, then admits", async () => {
    const ask = await step({ phase: "INTENT" }, "There's a visitor for you", noMatch);
    expect(ask.nextState.phase).toBe("ASK_NAME");
    expect(ask.reply).toContain("name");

    const deps = depsWith(async () => ({
      match: guest("Jane Doe"),
      candidates: [guest("Jane Doe")],
    }));
    const r = await step({ phase: "ASK_NAME" }, "Her name is Jane Doe", deps);
    expect(r.action).toBe("hangup");
    expect(outcomeOf(r.effects)).toBe("guest_admitted");
  });

  it("expired/unknown guest (no match) → denied + immediate transfer", async () => {
    const r = await step({ phase: "ASK_NAME" }, "Nobody Realname", noMatch);
    expect(r.action).toBe("transfer");
    expect(r.transferTarget).toBe("scott");
    expect(r.reply.toLowerCase()).toContain("connecting");
    expect(r.reply.toLowerCase()).not.toContain("please hold for just a moment");
    expect(notifyEvents(r.effects)).toContain("guest.denied");
    // call.transfer fires from the route only when a transfer actually executes
    expect(notifyEvents(r.effects)).not.toContain("call.transfer");
    expect(outcomeOf(r.effects)).toBe("no_match_transferred");
  });

  it("ambiguous duplicate name → no admit, transfer", async () => {
    const deps = depsWith(async () => ({
      match: null,
      candidates: [guest("Sam Ash"), guest("Sam Bell")],
    }));
    const r = await step({ phase: "ASK_NAME" }, "Sam", deps);
    // single-token miss re-asks once for first+last before transferring
    expect(r.action).toBeUndefined();
    expect(r.nextState.phase).toBe("ASK_NAME");
    expect(r.nextState.askedFullName).toBe(true);
    expect(r.reply.toLowerCase()).toContain("first and last");

    const denied = await step(
      { phase: "ASK_NAME", askedFullName: true },
      "Sam",
      deps
    );
    expect(denied.action).toBe("transfer");
    expect(outcomeOf(denied.effects)).toBe("no_match_transferred");
  });

  it("ASK_NAME partial last-name miss re-asks once for first and last", async () => {
    const first = await step({ phase: "ASK_NAME" }, "Connor", noMatch);
    expect(first.action).toBeUndefined();
    expect(first.nextState).toEqual({
      phase: "ASK_NAME",
      askedFullName: true,
    });
    expect(first.reply.toLowerCase()).toContain("first and last");

    const second = await step(
      { phase: "ASK_NAME", askedFullName: true },
      "Connor",
      noMatch
    );
    expect(second.action).toBe("transfer");
    expect(outcomeOf(second.effects)).toBe("no_match_transferred");
  });

  it("ASK_NAME partial that uniquely matches is admitted without re-ask", async () => {
    const deps = depsWith(async (name) => {
      expect(name).toBe("Connor");
      return { match: guest("Sera Connor"), candidates: [guest("Sera Connor")] };
    });
    const r = await step({ phase: "ASK_NAME" }, "Connor", deps);
    expect(r.action).toBe("hangup");
    expect(outcomeOf(r.effects)).toBe("guest_admitted");
  });

  it("general inquiry (package) → transfer to Scott", async () => {
    const r = await step(
      { phase: "INTENT" },
      "I've got a package delivery for the unit",
      noMatch
    );
    expect(r.action).toBe("transfer");
    expect(r.transferTarget).toBe("scott");
    expect(outcomeOf(r.effects)).toBe("transfer_attempted");
  });

  it("asking for Monica routes the transfer to Monica", async () => {
    const r = await step(
      { phase: "INTENT" },
      "Is Monica available? I have a question about the unit",
      noMatch
    );
    expect(r.action).toBe("transfer");
    expect(r.transferTarget).toBe("monica");
  });

  it("DB error → fail-closed transfer, never admit", async () => {
    const deps = depsWith(async () => {
      throw new Error("connection refused");
    });
    const r = await step({ phase: "ASK_NAME" }, "John Smith", deps);
    expect(r.action).toBe("transfer");
    expect(r.reply).not.toContain("send them up");
    expect(notifyEvents(r.effects)).toContain("system.error");
    expect(outcomeOf(r.effects)).toBe("error");
  });

  it("failed transfer falls back to message taking, then stores the message", async () => {
    const denied = await step({ phase: "ASK_NAME" }, "Nobody Realname", noMatch);
    const fallback = transferFailedResult(denied);
    expect(fallback.nextState.phase).toBe("TAKE_MESSAGE");
    expect(fallback.action).toBeUndefined();
    expect(notifyEvents(fallback.effects)).not.toContain("call.transfer");

    const took = await step(
      fallback.nextState,
      "Please ask Scott to call the front desk about his visitor",
      noMatch
    );
    expect(took.nextState.phase).toBe("CONFIRM_MESSAGE");

    const done = await step(took.nextState, "No, that's all", noMatch);
    expect(done.action).toBe("hangup");
    expect(outcomeOf(done.effects)).toBe("message_taken");
    const saved = done.effects.find((e) => e.type === "saveMessage");
    expect(saved?.body).toContain("call the front desk");
    expect(
      done.effects.find((e) => e.type === "notify" && e.event === "message.taken")
    ).toBeTruthy();
  });

  it("regression: extracts the name from 'It is a test visitor' phrasing", async () => {
    const deps = depsWith(async (name) => {
      expect(name.toLowerCase()).toBe("test visitor");
      return { match: guest("Test Visitor"), candidates: [guest("Test Visitor")] };
    });
    const r = await step(
      { phase: "GREETING" },
      "Yeah, I have a visitor here at the front desk. It is a test visitor.",
      deps
    );
    expect(r.action).toBe("hangup");
    expect(outcomeOf(r.effects)).toBe("guest_admitted");
  });

  it("regression: never treats 'here' as a visitor name — asks instead", async () => {
    const r = await step(
      { phase: "INTENT" },
      "I have a visitor here at the front desk",
      noMatch
    );
    expect(r.nextState.phase).toBe("ASK_NAME");
    expect(r.action).toBeUndefined();
    expect(notifyEvents(r.effects)).not.toContain("guest.denied");
  });

  it("auto-extracted name miss re-asks instead of denying", async () => {
    const r = await step(
      { phase: "INTENT" },
      "I have Ghost Person here in the lobby",
      noMatch
    );
    expect(r.nextState.phase).toBe("ASK_NAME");
    expect(r.action).toBeUndefined();
    expect(r.reply.toLowerCase()).toContain("name");
    expect(notifyEvents(r.effects)).not.toContain("guest.denied");
  });

  it("STT fragments get a clarification, then fail safe to transfer", async () => {
    const first = await step({ phase: "INTENT" }, "I have a ", noMatch);
    expect(first.reply).toContain("say that again");
    expect(first.nextState).toEqual({ phase: "INTENT", clarifies: 1 });
    const second = await step(first.nextState, "and then the ", noMatch);
    expect(second.nextState).toEqual({ phase: "INTENT", clarifies: 2 });
    const third = await step(second.nextState, "with a ", noMatch);
    expect(third.action).toBe("transfer");
  });

  it("regression: ASK_NAME rejects phrasing debris instead of denying on it", async () => {
    const r = await step({ phase: "ASK_NAME" }, "a visitor for them", noMatch);
    expect(r.reply).toContain("name");
    expect(r.nextState.phase).toBe("ASK_NAME");
    expect(notifyEvents(r.effects)).not.toContain("guest.denied");
    // third strike falls safe to a transfer, never a guessy lookup
    const r3 = await step(
      { phase: "ASK_NAME", clarifies: 2 },
      "someone here",
      noMatch
    );
    expect(r3.action).toBe("transfer");
  });

  it("HOLDING (legacy): immediately transfers instead of silent hold", async () => {
    const r = await step({ phase: "HOLDING" }, "Hello? Are you there?", noMatch);
    expect(r.action).toBe("transfer");
    expect(r.transferTarget).toBe("scott");
    expect(r.reply.toLowerCase()).toContain("connecting");
  });

  it("goodbye closes politely with a hangup", async () => {
    const r = await step({ phase: "INTENT" }, "Okay that's all, goodbye", noMatch);
    expect(r.action).toBe("hangup");
    expect(outcomeOf(r.effects)).toBe("hangup");
  });
});
