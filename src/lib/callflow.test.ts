import { describe, expect, it } from "vitest";
import {
  INITIAL_STATE,
  cleanSpokenName,
  detectExplicitTransfer,
  detectOfferSelection,
  extractName,
  extractQuestionGuestName,
  hasTransferNegation,
  isPartialName,
  isPureDoneUtterance,
  looksLikeGuestInfoFollowUp,
  looksLikeGuestPermissionQuestion,
  looksLikeNewVisitorAnnouncement,
  step,
  transferFailedResult,
  transferIfAvailable,
  type CallflowDeps,
  type Effect,
  type GuestInfoQaResult,
} from "./callflow";
import type { Guest } from "./db/guests";

const guest = (
  name: string,
  guest_info: string | null = null,
  id = "00000000-0000-0000-0000-000000000001"
): Guest => ({
  id,
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
  extras: Partial<CallflowDeps> = {}
): CallflowDeps => ({
  matchGuest: impl,
  transferAvailable: { scott: true, monica: true },
  ...extras,
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
});

describe("guest approval stays open for follow-ups", () => {
  const janeNotes =
    "House keeper for scott and Monica. Jane is allowed access to our condo unit and access to the secured parking underground.";
  const jane = guest("Jane McDaniel", janeNotes);

  const admitDeps = (answer?: CallflowDeps["answerGuestInfo"]) =>
    depsWith(async () => ({ match: jane, candidates: [jane] }), {
      answerGuestInfo: answer,
    });

  it("approval does not hang up and remembers the guest", async () => {
    const r = await step(
      { phase: "INTENT" },
      "Jane McDaniel is here to see Scott",
      admitDeps()
    );
    expect(r.action).toBeUndefined();
    expect(r.action).not.toBe("hangup");
    expect(outcomeOf(r.effects)).toBe("guest_admitted");
    expect(r.nextState.phase).toBe("INTENT");
    expect(r.nextState.activeGuest?.name).toBe("Jane McDaniel");
    expect(r.reply.toLowerCase()).toMatch(/anything else/);
  });

  it("garage follow-up after approval uses active guest (allowed)", async () => {
    const admitted = await step(
      { phase: "INTENT" },
      "Jane McDaniel is here to see Scott",
      admitDeps()
    );
    const deps = admitDeps(async (input) => {
      expect(input.guestName).toBe("Jane McDaniel");
      expect(input.question.toLowerCase()).toContain("park");
      return {
        answer: "yes",
        reply:
          "Yes, Jane McDaniel has access to the secured underground parking.",
      } satisfies GuestInfoQaResult;
    });
    const r = await step(
      admitted.nextState,
      "Can she park in the secured garage?",
      deps
    );
    expect(r.action).toBeUndefined();
    expect(r.reply.toLowerCase()).toMatch(/parking|underground|garage/);
    expect(notifyEvents(r.effects)).toContain("guest.info_answered");
    expect(r.nextState.activeGuest?.name).toBe("Jane McDaniel");
  });

  it("garage follow-up denied by notes stays on the line", async () => {
    const state = {
      phase: "INTENT" as const,
      activeGuest: {
        id: jane.id,
        name: jane.name,
        guest_info: "Housekeeper. No parking access.",
      },
    };
    const deps = depsWith(async () => ({ match: jane, candidates: [jane] }), {
      answerGuestInfo: async () => ({
        answer: "no",
        reply: "No, Jane McDaniel does not have parking access.",
      }),
    });
    const r = await step(state, "Can she park in the secured garage?", deps);
    expect(r.action).toBeUndefined();
    expect(r.reply.toLowerCase()).toContain("no");
    expect(notifyEvents(r.effects)).toContain("guest.info_answered");
  });

  it("garage follow-up with missing notes offers Scott or Monica", async () => {
    const state = {
      phase: "INTENT" as const,
      activeGuest: { id: jane.id, name: jane.name, guest_info: null },
    };
    let llm = 0;
    const deps = depsWith(async () => ({ match: jane, candidates: [jane] }), {
      answerGuestInfo: async () => {
        llm += 1;
        return { answer: "yes", reply: "should not run" };
      },
    });
    const r = await step(state, "Can she park in the secured garage?", deps);
    expect(llm).toBe(0);
    expect(r.action).toBeUndefined();
    expect(r.nextState.phase).toBe("OFFER_TRANSFER");
    expect(r.reply.toLowerCase()).toMatch(/not sure|don't have notes/);
    expect(r.reply.toLowerCase()).toMatch(/scott or monica/);
  });

  it("multiple follow-ups keep activeGuest and never hang up", async () => {
    const deps = admitDeps(async () => ({
      answer: "yes",
      reply: "Yes, Jane McDaniel may access the unit.",
    }));
    const a = await step(
      { phase: "INTENT" },
      "I have Jane McDaniel here in the lobby",
      deps
    );
    const b = await step(a.nextState, "Can she come up to the unit?", deps);
    const c = await step(
      b.nextState,
      "Is Jane allowed to park in the garage?",
      deps
    );
    expect(a.action).toBeUndefined();
    expect(b.action).toBeUndefined();
    expect(c.action).toBeUndefined();
    expect(c.nextState.activeGuest?.name).toBe("Jane McDaniel");
  });

  it("caller requests Scott after approval → transfer to Scott", async () => {
    const admitted = await step(
      { phase: "INTENT" },
      "Jane McDaniel is here to see Scott",
      admitDeps()
    );
    const r = await step(
      admitted.nextState,
      "Can you connect me to Scott please?",
      admitDeps()
    );
    expect(r.action).toBe("transfer");
    expect(r.transferTarget).toBe("scott");
  });

  it("caller requests Monica after approval → transfer to Monica when configured", async () => {
    const admitted = await step(
      { phase: "INTENT" },
      "Jane McDaniel is here to see Scott",
      admitDeps()
    );
    const r = await step(
      admitted.nextState,
      "Please put me through to Monica",
      admitDeps()
    );
    expect(r.action).toBe("transfer");
    expect(r.transferTarget).toBe("monica");
  });

  it("uncertain → offer → accept Scott", async () => {
    const deps = depsWith(async () => ({ match: jane, candidates: [jane] }), {
      answerGuestInfo: async () => ({
        answer: "unclear",
        reply: "Notes don't say.",
      }),
    });
    const offer = await step(
      {
        phase: "INTENT",
        activeGuest: { id: jane.id, name: jane.name, guest_info: janeNotes },
      },
      "Can she use the rooftop pool?",
      deps
    );
    expect(offer.nextState.phase).toBe("OFFER_TRANSFER");
    expect(offer.action).toBeUndefined();

    const yes = await step(offer.nextState, "Yes please", deps);
    expect(yes.nextState.phase).toBe("OFFER_TRANSFER");
    expect(yes.reply.toLowerCase()).toMatch(/scott or monica/);

    const pick = await step(yes.nextState, "Scott", deps);
    expect(pick.action).toBe("transfer");
    expect(pick.transferTarget).toBe("scott");
  });

  it("uncertain → offer → decline stays listening", async () => {
    const offer = await step(
      {
        phase: "OFFER_TRANSFER",
        activeGuest: { id: jane.id, name: jane.name, guest_info: janeNotes },
      },
      "No thanks",
      admitDeps()
    );
    expect(offer.action).toBeUndefined();
    expect(offer.nextState.phase).toBe("INTENT");
    expect(offer.nextState.activeGuest?.name).toBe("Jane McDaniel");
    expect(offer.reply.toLowerCase()).toMatch(/anything else/);
  });

  it("model failure offers connect instead of hanging up or blind transfer", async () => {
    const deps = depsWith(async () => ({ match: jane, candidates: [jane] }), {
      answerGuestInfo: async () => null,
    });
    const r = await step(
      {
        phase: "INTENT",
        activeGuest: { id: jane.id, name: jane.name, guest_info: janeNotes },
      },
      "Can she park downstairs?",
      deps
    );
    expect(r.action).toBeUndefined();
    expect(r.nextState.phase).toBe("OFFER_TRANSFER");
    expect(r.reply.toLowerCase()).toMatch(/not sure/);
  });

  it("calls are isolated — fresh state has no activeGuest", async () => {
    expect(INITIAL_STATE.activeGuest).toBeUndefined();
    const other = guest("Other Person", "notes", "00000000-0000-0000-0000-000000000099");
    const callA = await step(
      { phase: "INTENT" },
      "Jane McDaniel is here to see Scott",
      admitDeps()
    );
    expect(callA.nextState.activeGuest?.name).toBe("Jane McDaniel");

    const callB = await step(
      INITIAL_STATE,
      "Other Person is here in the lobby",
      depsWith(async () => ({ match: other, candidates: [other] }))
    );
    expect(callB.nextState.activeGuest?.name).toBe("Other Person");
    expect(callB.nextState.activeGuest?.id).not.toBe(callA.nextState.activeGuest?.id);
  });

  it("goodbye after approval does not send hangup", async () => {
    const admitted = await step(
      { phase: "INTENT" },
      "Jane McDaniel is here to see Scott",
      admitDeps()
    );
    const r = await step(admitted.nextState, "Okay that's all, goodbye", admitDeps());
    expect(r.action).toBeUndefined();
    expect(r.action).not.toBe("hangup");
    expect(r.nextState.phase).toBe("INTENT");
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
      {
        answerGuestInfo: async () =>
          ({
            answer: "yes",
            reply:
              "Yes, Jane McDaniel has access to the secured underground parking.",
          }) satisfies GuestInfoQaResult,
      }
    );
    const r = await step(
      { phase: "INTENT" },
      "Is Jane allowed to park in the garage?",
      deps
    );
    expect(r.action).toBeUndefined();
    expect(r.reply).toContain("Jane McDaniel");
    expect(notifyEvents(r.effects)).toContain("guest.info_answered");
    expect(r.nextState.phase).toBe("INTENT");
    expect(r.nextState.activeGuest?.name).toBe("Jane McDaniel");
  });

  it("question not covered by the notes → offer transfer (not immediate)", async () => {
    const deps = depsWith(async () => ({ match: jane, candidates: [jane] }), {
      answerGuestInfo: async () => ({
        answer: "unclear",
        reply: "I need to check with Scott.",
      }),
    });
    const r = await step(
      { phase: "INTENT" },
      "Is Jane allowed to use the rooftop pool?",
      deps
    );
    expect(r.action).toBeUndefined();
    expect(r.nextState.phase).toBe("OFFER_TRANSFER");
    expect(notifyEvents(r.effects)).not.toContain("guest.info_answered");
  });

  it("inactive / unknown guest → no answer from notes, transfer", async () => {
    let answered = false;
    const deps = depsWith(
      async () => ({ match: null, candidates: [] }),
      {
        answerGuestInfo: async () => {
          answered = true;
          return { answer: "yes", reply: "should not run" };
        },
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

  it("empty guest_info → offer without calling the LLM", async () => {
    const bare = guest("Jane McDaniel", null);
    let answered = false;
    const deps = depsWith(async () => ({ match: bare, candidates: [bare] }), {
      answerGuestInfo: async () => {
        answered = true;
        return { answer: "yes", reply: "should not run" };
      },
    });
    const r = await step(
      { phase: "INTENT" },
      "Is Jane allowed to park in the garage?",
      deps
    );
    expect(answered).toBe(false);
    expect(r.action).toBeUndefined();
    expect(r.nextState.phase).toBe("OFFER_TRANSFER");
  });

  it("visitor arrival is not routed through guest-info Q&A", async () => {
    let qaCalls = 0;
    const deps = depsWith(
      async (name) => {
        expect(name).toBe("Jane McDaniel");
        return { match: jane, candidates: [jane] };
      },
      {
        answerGuestInfo: async () => {
          qaCalls += 1;
          return { answer: "yes", reply: "should not run for visitor admit" };
        },
      }
    );
    const r = await step(
      { phase: "INTENT" },
      "Jane McDaniel is here to see Scott",
      deps
    );
    expect(qaCalls).toBe(0);
    expect(r.action).toBeUndefined();
    expect(outcomeOf(r.effects)).toBe("guest_admitted");
    expect(notifyEvents(r.effects)).toContain("guest.admitted");
  });
});

describe("Monica / Scott transfer availability", () => {
  it("detectExplicitTransfer parses connect requests", () => {
    expect(detectExplicitTransfer("Connect me to Scott")).toBe("scott");
    expect(detectExplicitTransfer("Please put me through to Monica")).toBe(
      "monica"
    );
    expect(
      detectExplicitTransfer("Can I still be connected to Scott or Monica?")
    ).toBe("ask");
    expect(detectExplicitTransfer("Jane is here")).toBeNull();
  });

  it("negated connect requests are not transfers", () => {
    expect(hasTransferNegation("No, don't connect me to Monica")).toBe(true);
    expect(detectExplicitTransfer("No, don't connect me to Monica")).toBeNull();
    expect(detectExplicitTransfer("Don't transfer me to Scott")).toBeNull();
    expect(
      detectOfferSelection("No thanks, can she still use the garage?")
    ).toBeNull();
    expect(
      detectExplicitTransfer("Did Monica leave any instructions for her?")
    ).toBeNull();
  });

  it("Monica request without MONICA_PHONE does not silently use Scott", async () => {
    const r = transferIfAvailable("monica", {
      matchGuest: async () => ({ match: null, candidates: [] }),
      transferAvailable: { scott: true, monica: false },
    });
    expect(r.action).toBeUndefined();
    expect(r.nextState.phase).toBe("OFFER_TRANSFER");
    expect(r.reply.toLowerCase()).toContain("monica");
    expect(r.reply.toLowerCase()).toMatch(/don't have|not.*configured|scott instead/);
    expect(notifyEvents(r.effects)).toContain("system.error");
  });

  it("asking for Monica when configured transfers to Monica", async () => {
    const r = await step(
      { phase: "INTENT" },
      "Is Monica available? I have a question about the unit",
      depsWith(async () => ({ match: null, candidates: [] }))
    );
    expect(r.action).toBe("transfer");
    expect(r.transferTarget).toBe("monica");
  });

  it("resident mention in a guest question is not a transfer", async () => {
    const jane = guest(
      "Jane McDaniel",
      "Housekeeper. Monica left instructions to use the service elevator."
    );
    const deps = depsWith(async () => ({ match: jane, candidates: [jane] }), {
      answerGuestInfo: async () => ({
        answer: "answered",
        reply:
          "Monica left instructions for Jane McDaniel to use the service elevator.",
      }),
    });
    const r = await step(
      {
        phase: "INTENT",
        activeGuest: {
          id: jane.id,
          name: jane.name,
          guest_info: jane.guest_info,
        },
      },
      "Did Monica leave any instructions for her?",
      deps
    );
    expect(r.action).toBeUndefined();
    expect(notifyEvents(r.effects)).toContain("guest.info_answered");
  });
});

describe("offer negation and continued questions", () => {
  const janeNotes =
    "Jane may use the garage. Expected around 3pm. Leave packages at the door.";
  const jane = guest("Jane McDaniel", janeNotes);

  it("decline with continued garage question does not transfer", async () => {
    const deps = depsWith(async () => ({ match: jane, candidates: [jane] }), {
      answerGuestInfo: async () => ({
        answer: "yes",
        reply: "Yes, Jane McDaniel may use the garage.",
      }),
    });
    const r = await step(
      {
        phase: "OFFER_TRANSFER",
        activeGuest: {
          id: jane.id,
          name: jane.name,
          guest_info: janeNotes,
        },
      },
      "No thanks, can she still use the garage?",
      deps
    );
    expect(r.action).toBeUndefined();
    expect(r.nextState.phase).toBe("INTENT");
    expect(r.reply.toLowerCase()).toMatch(/garage|yes/);
  });

  it("don't connect me to Monica declines without transferring", async () => {
    const r = await step(
      {
        phase: "OFFER_TRANSFER",
        activeGuest: { id: jane.id, name: jane.name, guest_info: janeNotes },
      },
      "No, don't connect me to Monica",
      depsWith(async () => ({ match: jane, candidates: [jane] }))
    );
    expect(r.action).toBeUndefined();
    expect(r.nextState.phase).toBe("INTENT");
  });
});

describe("INTENT full-step transfer consent (not helpers alone)", () => {
  const janeNotes =
    "Jane may use the garage. Expected around 3pm. Leave packages at the door.";
  const jane = guest("Jane McDaniel", janeNotes);
  const active = {
    phase: "INTENT" as const,
    activeGuest: {
      id: jane.id,
      name: jane.name,
      guest_info: janeNotes,
    },
  };
  const deps = depsWith(async () => ({ match: jane, candidates: [jane] }), {
    answerGuestInfo: async () => ({
      answer: "yes",
      reply: "Yes, Jane McDaniel may use the garage.",
    }),
  });

  it("isPureDoneUtterance does not swallow continued questions", () => {
    expect(isPureDoneUtterance("No thanks")).toBe(true);
    expect(isPureDoneUtterance("That's all")).toBe(true);
    expect(isPureDoneUtterance("Thank you")).toBe(true);
    expect(isPureDoneUtterance("No thank you")).toBe(true);
    expect(
      isPureDoneUtterance("No thanks, can she still use the garage?")
    ).toBe(false);
    expect(
      isPureDoneUtterance("No thank you, can she still use the garage?")
    ).toBe(false);
  });

  it("post-admit thanks and holds soft-close without transferring", async () => {
    for (const utterance of [
      "Thank you",
      "No thank you",
      "hold on",
      "let me check",
    ]) {
      const r = await step(active, utterance, deps);
      expect(r.action).toBeUndefined();
      expect(r.transferTarget).toBeUndefined();
      expect(r.nextState.phase).toBe("INTENT");
    }
  });

  it("guest connect/talk questions are not transfer consent", async () => {
    expect(detectExplicitTransfer("Can she connect to wifi?")).toBeNull();
    expect(detectExplicitTransfer("Can she talk to them?")).toBeNull();
    const wifi = await step(active, "Can she connect to wifi?", {
      ...deps,
      answerGuestInfo: async () => ({
        answer: "unclear",
        reply: "",
      }),
    });
    expect(wifi.action).toBeUndefined();
    expect(wifi.transferTarget).toBeUndefined();
    // Unclear notes → offer connect, not an immediate cold transfer.
    expect(wifi.nextState.phase).toBe("OFFER_TRANSFER");
  });

  it("Is Monica available? still transfers after a guest is identified", async () => {
    const r = await step(active, "Is Monica available?", deps);
    expect(r.action).toBe("transfer");
    expect(r.transferTarget).toBe("monica");
  });

  it("offer please/don't instructions are not yes/no consent", async () => {
    expect(
      detectOfferSelection("Please tell her to use the elevator")
    ).toBeNull();
    const please = await step(
      {
        phase: "OFFER_TRANSFER",
        activeGuest: active.activeGuest,
      },
      "Please tell her to use the elevator",
      {
        ...deps,
        answerGuestInfo: async () => ({
          answer: "answered",
          reply: "Please have Jane McDaniel use the elevator.",
        }),
      }
    );
    expect(please.action).toBeUndefined();
    expect(please.nextState.phase).toBe("INTENT");
    expect(notifyEvents(please.effects)).toContain("guest.info_answered");

    const dont = await step(
      {
        phase: "OFFER_TRANSFER",
        activeGuest: active.activeGuest,
      },
      "Don't let her use the garage",
      {
        ...deps,
        answerGuestInfo: async () => ({
          answer: "no",
          reply: "No, Jane McDaniel should not use the garage.",
        }),
      }
    );
    expect(dont.action).toBeUndefined();
    expect(dont.nextState.phase).toBe("INTENT");
    expect(dont.reply.toLowerCase()).not.toMatch(/^no problem/);
  });

  it("Don't transfer me to Scott in INTENT never transfers via fallback", async () => {
    const r = await step(active, "Don't transfer me to Scott", deps);
    expect(r.action).toBeUndefined();
    expect(r.action).not.toBe("transfer");
    expect(r.transferTarget).toBeUndefined();
    expect(r.nextState.phase).toBe("INTENT");
    expect(r.reply.toLowerCase()).toMatch(/no problem|anything else/);
  });

  it("Don't connect me to Monica in INTENT never transfers via fallback", async () => {
    const r = await step(active, "Don't connect me to Monica", deps);
    expect(r.action).toBeUndefined();
    expect(r.transferTarget).toBeUndefined();
    expect(r.nextState.phase).toBe("INTENT");
  });

  it("No thanks, can she still use the garage? in INTENT answers Guest Info", async () => {
    const r = await step(
      active,
      "No thanks, can she still use the garage?",
      deps
    );
    expect(r.action).toBeUndefined();
    expect(r.reply.toLowerCase()).toMatch(/garage|yes/);
    expect(notifyEvents(r.effects)).toContain("guest.info_answered");
    // Must not soft-close via DONE_RE swallowing the question.
    expect(r.reply.toLowerCase()).not.toMatch(/thank you! i'm here/);
  });

  it("GREETING phase also refuses negated connect without transferring", async () => {
    const r = await step(
      { phase: "GREETING" },
      "Don't transfer me to Scott",
      deps
    );
    expect(r.action).toBeUndefined();
    expect(notifyEvents(r.effects)).toContain("call.started");
  });

  it("ASK_NAME clear refusal does not no-match-transfer", async () => {
    const r = await step(
      { phase: "ASK_NAME", activeGuest: active.activeGuest },
      "Don't connect me to Monica",
      deps
    );
    expect(r.action).toBeUndefined();
    expect(outcomeOf(r.effects)).not.toBe("no_match_transferred");
  });

  it("CONFIRM_MESSAGE transfer refusal finalizes once and does not transfer", async () => {
    const r = await step(
      {
        phase: "CONFIRM_MESSAGE",
        messageParts: ["Please call about the visitor"],
        activeGuest: active.activeGuest,
      },
      "Don't transfer me to Scott",
      deps
    );
    expect(r.action).toBeUndefined();
    expect(outcomeOf(r.effects)).toBe("message_taken");
    expect(r.nextState.messageSaved).toBe(true);
  });
});

describe("security: new/unnamed visitor must not reuse prior activeGuest", () => {
  const janeNotes =
    "Jane McDaniel is allowed access to the condo and secured underground parking.";
  const jane = guest("Jane McDaniel", janeNotes);

  const admitJane = async () => {
    const deps = depsWith(async () => ({ match: jane, candidates: [jane] }), {
      answerGuestInfo: async () => ({
        answer: "yes",
        reply: "Yes, Jane McDaniel has underground parking access.",
      }),
    });
    const admitted = await step(
      { phase: "INTENT" },
      "Jane McDaniel is here to see Scott",
      deps
    );
    expect(outcomeOf(admitted.effects)).toBe("guest_admitted");
    expect(admitted.nextState.activeGuest?.name).toBe("Jane McDaniel");
    return { admitted, deps };
  };

  it("helper: new arrival vs same-guest pronoun follow-up", () => {
    const state = {
      phase: "INTENT" as const,
      activeGuest: {
        id: jane.id,
        name: jane.name,
        guest_info: janeNotes,
      },
    };
    expect(
      looksLikeNewVisitorAnnouncement(
        "I also have someone else here, can he come up?",
        state
      )
    ).toBe(true);
    expect(
      looksLikeNewVisitorAnnouncement(
        "There's a visitor in the lobby, can they park?",
        state
      )
    ).toBe(true);
    expect(
      looksLikeNewVisitorAnnouncement(
        "Someone is downstairs, can they come up?",
        state
      )
    ).toBe(true);
    expect(
      looksLikeNewVisitorAnnouncement("Got a visitor, can he come up?", state)
    ).toBe(true);
    expect(
      looksLikeNewVisitorAnnouncement(
        "I have a delivery here, can they come up?",
        state
      )
    ).toBe(true);
    expect(
      looksLikeGuestInfoFollowUp(
        "I also have someone else here, can he come up?",
        state
      )
    ).toBe(false);
    // Legitimate same-guest follow-ups — must NOT clear
    for (const u of [
      "Can she still use the garage?",
      "She's in the lobby, can she park?",
      "Can she come up one more time?",
      "I also have a question about parking",
      "I also have her parking pass",
    ]) {
      expect(looksLikeNewVisitorAnnouncement(u, state), u).toBe(false);
      expect(looksLikeGuestInfoFollowUp(u, state), u).toBe(true);
    }
  });

  it("Hold on + guest question answers notes; bare hold soft-closes", async () => {
    const { admitted, deps } = await admitJane();
    const holdQ = await step(
      admitted.nextState,
      "Hold on, can she still use the garage?",
      deps
    );
    expect(holdQ.action).toBeUndefined();
    expect(notifyEvents(holdQ.effects)).toContain("guest.info_answered");
    expect(holdQ.nextState.activeGuest?.name).toBe("Jane McDaniel");

    const bare = await step(admitted.nextState, "hold on", deps);
    expect(bare.action).toBeUndefined();
    expect(notifyEvents(bare.effects)).not.toContain("guest.info_answered");
    expect(bare.reply.toLowerCase()).toMatch(/here if you need/);
  });

  it("after Jane admit, unnamed other visitor asks access → ASK_NAME, no Jane notes", async () => {
    const { admitted, deps } = await admitJane();
    let answeredFromNotes = false;
    const guarded = {
      ...deps,
      answerGuestInfo: async () => {
        answeredFromNotes = true;
        return {
          answer: "yes" as const,
          reply: "Yes, Jane McDaniel may come up.",
        };
      },
    };
    const r = await step(
      admitted.nextState,
      "I also have someone else here, can he come up?",
      guarded
    );
    expect(r.action).toBeUndefined();
    expect(r.nextState.phase).toBe("ASK_NAME");
    expect(r.nextState.activeGuest).toBeNull();
    expect(answeredFromNotes).toBe(false);
    expect(notifyEvents(r.effects)).not.toContain("guest.info_answered");
    expect(outcomeOf(r.effects)).not.toBe("guest_admitted");
    expect(r.reply.toLowerCase()).toMatch(/name/);
  });

  it("after Jane admit, unnamed visitor + parking question does not use Jane parking", async () => {
    const { admitted, deps } = await admitJane();
    let answeredFromNotes = false;
    const guarded = {
      ...deps,
      answerGuestInfo: async () => {
        answeredFromNotes = true;
        return {
          answer: "yes" as const,
          reply: "Yes, Jane McDaniel has underground parking access.",
        };
      },
    };
    const r = await step(
      admitted.nextState,
      "There's a visitor in the lobby, can they park in the garage?",
      guarded
    );
    expect(answeredFromNotes).toBe(false);
    expect(r.nextState.phase).toBe("ASK_NAME");
    expect(r.nextState.activeGuest).toBeNull();
    expect(notifyEvents(r.effects)).not.toContain("guest.info_answered");
    expect(r.reply.toLowerCase()).not.toMatch(/jane/);
  });

  it("after Jane admit, same-guest pronoun parking follow-up still works", async () => {
    const { admitted, deps } = await admitJane();
    const r = await step(
      admitted.nextState,
      "Can she still use the garage?",
      deps
    );
    expect(r.action).toBeUndefined();
    expect(notifyEvents(r.effects)).toContain("guest.info_answered");
    expect(r.nextState.activeGuest?.name).toBe("Jane McDaniel");
  });

  it("after Jane admit then ASK_NAME, access question before name does not revive Jane", async () => {
    const { admitted, deps } = await admitJane();
    const ask = await step(
      admitted.nextState,
      "I have another guest here",
      deps
    );
    expect(ask.nextState.phase).toBe("ASK_NAME");
    expect(ask.nextState.activeGuest).toBeNull();

    let answeredFromNotes = false;
    const guarded = {
      ...deps,
      answerGuestInfo: async () => {
        answeredFromNotes = true;
        return { answer: "yes" as const, reply: "should not run" };
      },
    };
    // During ASK_NAME, an access question is not a guest name — re-ask, no notes.
    const r = await step(ask.nextState, "Can he park in the garage?", guarded);
    expect(answeredFromNotes).toBe(false);
    expect(r.action).toBeUndefined();
    expect(r.nextState.phase).toBe("ASK_NAME");
    expect(notifyEvents(r.effects)).not.toContain("guest.info_answered");
  });
});

describe("messageSaved allows a distinct later message", () => {
  it("second failed-transfer message session can save a new body", async () => {
    const deps = depsWith(async () => ({ match: null, candidates: [] }));
    const firstFail = transferFailedResult({
      reply: "connecting",
      nextState: { phase: "DONE" },
      action: "transfer",
      transferTarget: "scott",
      effects: [],
    });
    const took = await step(
      firstFail.nextState,
      "Please call about guest A",
      deps
    );
    const saved = await step(took.nextState, "That's all", deps);
    expect(outcomeOf(saved.effects)).toBe("message_taken");
    expect(saved.nextState.messageSaved).toBe(true);
    // Same finalize again must not re-notify.
    const dup = await step(saved.nextState, "Goodbye", deps);
    expect(dup.effects.filter((e) => e.type === "saveMessage")).toHaveLength(0);

    // A later distinct failed-transfer session resets messageSaved.
    const secondFail = transferFailedResult({
      reply: "connecting",
      nextState: {
        phase: "DONE",
        activeGuest: saved.nextState.activeGuest,
        messageSaved: true,
      },
      action: "transfer",
      transferTarget: "scott",
      effects: [],
    });
    expect(secondFail.nextState.messageSaved).toBe(false);
    const took2 = await step(
      secondFail.nextState,
      "Please call about guest B instead",
      deps
    );
    const saved2 = await step(took2.nextState, "That's all", deps);
    expect(outcomeOf(saved2.effects)).toBe("message_taken");
    const bodies = saved2.effects
      .filter((e): e is Extract<Effect, { type: "saveMessage" }> => e.type === "saveMessage")
      .map((e) => e.body);
    expect(bodies).toEqual(["Please call about guest B instead"]);
  });
});

describe("factual Guest Info follow-ups", () => {
  const janeNotes =
    "Housekeeper. Expected around 3pm. Special instructions: leave packages at the unit door. Allowed underground parking.";
  const jane = guest("Jane McDaniel", janeNotes);

  it("answers expected-time / instructions / delivery from notes", async () => {
    expect(
      looksLikeGuestInfoFollowUp("What time is she expected?", {
        phase: "INTENT",
        activeGuest: { id: jane.id, name: jane.name, guest_info: janeNotes },
      })
    ).toBe(true);
    expect(
      looksLikeGuestInfoFollowUp("What should I tell her?", {
        phase: "INTENT",
        activeGuest: { id: jane.id, name: jane.name, guest_info: janeNotes },
      })
    ).toBe(true);
    // Without activeGuest, a bare pronoun question is not Guest Info routing
    // (and must not mis-extract filler words like "time" as a guest name).
    expect(extractQuestionGuestName("What time is she expected?")).toBeNull();
    expect(looksLikeGuestPermissionQuestion("What time is she expected?")).toBe(
      false
    );

    const deps = depsWith(async () => ({ match: jane, candidates: [jane] }), {
      answerGuestInfo: async (input) => {
        if (/time|expected/i.test(input.question)) {
          return {
            answer: "answered",
            reply: "Jane McDaniel is expected around 3pm.",
          };
        }
        if (/tell|instructions/i.test(input.question)) {
          return {
            answer: "answered",
            reply:
              "Special instructions for Jane McDaniel: leave packages at the unit door.",
          };
        }
        return {
          answer: "answered",
          reply: "Leave deliveries for Jane McDaniel at the unit door.",
        };
      },
    });
    const state = {
      phase: "INTENT" as const,
      activeGuest: {
        id: jane.id,
        name: jane.name,
        guest_info: janeNotes,
      },
    };
    const t = await step(state, "What time is she expected?", deps);
    expect(t.action).toBeUndefined();
    expect(t.reply).toMatch(/3\s*pm/i);
    expect(notifyEvents(t.effects)).toContain("guest.info_answered");

    const i = await step(state, "What should I tell her?", deps);
    expect(i.action).toBeUndefined();
    expect(i.reply.toLowerCase()).toMatch(/package|door|instructions/);

    const d = await step(state, "Where should the delivery be left?", deps);
    expect(d.action).toBeUndefined();
    expect(d.reply.toLowerCase()).toMatch(/door|deliver/);
  });

  it("factual question missing from notes offers transfer, not blind transfer", async () => {
    const deps = depsWith(async () => ({ match: jane, candidates: [jane] }), {
      answerGuestInfo: async () => ({
        answer: "unclear",
        reply: "Notes don't say.",
      }),
    });
    const r = await step(
      {
        phase: "INTENT",
        activeGuest: {
          id: jane.id,
          name: jane.name,
          guest_info: janeNotes,
        },
      },
      "Does she have a gate code?",
      deps
    );
    expect(r.action).toBeUndefined();
    expect(r.nextState.phase).toBe("OFFER_TRANSFER");
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

  it("happy path: announcement with name → admitted, stays on the line", async () => {
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
    expect(r.action).toBeUndefined();
    expect(notifyEvents(r.effects)).toContain("guest.admitted");
    expect(outcomeOf(r.effects)).toBe("guest_admitted");
    expect(r.nextState.activeGuest?.name).toBe("John Smith");
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
    expect(r.action).toBeUndefined();
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
    expect(r.action).toBeUndefined();
    expect(outcomeOf(r.effects)).toBe("guest_admitted");
  });

  it("expired/unknown guest (no match) → denied + immediate transfer", async () => {
    const r = await step({ phase: "ASK_NAME" }, "Nobody Realname", noMatch);
    expect(r.action).toBe("transfer");
    expect(r.transferTarget).toBe("scott");
    expect(r.reply.toLowerCase()).toContain("connecting");
    expect(notifyEvents(r.effects)).toContain("guest.denied");
    expect(notifyEvents(r.effects)).not.toContain("call.transfer");
    expect(outcomeOf(r.effects)).toBe("no_match_transferred");
  });

  it("ambiguous duplicate name → no admit, re-ask then transfer", async () => {
    const deps = depsWith(async () => ({
      match: null,
      candidates: [guest("Sam Ash"), guest("Sam Bell")],
    }));
    const r = await step({ phase: "ASK_NAME" }, "Sam", deps);
    expect(r.action).toBeUndefined();
    expect(r.nextState.phase).toBe("ASK_NAME");
    expect(r.nextState.askedFullName).toBe(true);

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
    expect(first.nextState.phase).toBe("ASK_NAME");
    expect(first.nextState.askedFullName).toBe(true);

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
    expect(r.action).toBeUndefined();
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

  it("failed transfer → message → keeps listening without hangup", async () => {
    const denied = await step({ phase: "ASK_NAME" }, "Nobody Realname", noMatch);
    const fallback = transferFailedResult(denied);
    expect(fallback.nextState.phase).toBe("TAKE_MESSAGE");
    expect(fallback.action).toBeUndefined();

    const took = await step(
      fallback.nextState,
      "Please ask Scott to call the front desk about his visitor",
      noMatch
    );
    expect(took.nextState.phase).toBe("CONFIRM_MESSAGE");

    const done = await step(took.nextState, "No, that's all", noMatch);
    expect(done.action).toBeUndefined();
    expect(done.action).not.toBe("hangup");
    expect(outcomeOf(done.effects)).toBe("message_taken");
    expect(done.nextState.phase).toBe("INTENT");
    expect(done.nextState.messageSaved).toBe(true);
    // Second close must not re-save / re-notify.
    const again = await step(done.nextState, "Goodbye", noMatch);
    expect(again.effects.filter((e) => e.type === "saveMessage")).toHaveLength(0);
    expect(notifyEvents(again.effects)).not.toContain("message.taken");
  });

  it("approval → transfer fail → message → another guest question (no hangup, save once)", async () => {
    const jane = guest(
      "Jane McDaniel",
      "Allowed underground parking. Expected 3pm."
    );
    const deps = depsWith(async () => ({ match: jane, candidates: [jane] }), {
      answerGuestInfo: async () => ({
        answer: "yes",
        reply: "Yes, Jane McDaniel has underground parking access.",
      }),
    });
    const admitted = await step(
      { phase: "INTENT" },
      "Jane McDaniel is here to see Scott",
      deps
    );
    expect(admitted.action).toBeUndefined();

    const wantTransfer = await step(
      admitted.nextState,
      "Connect me to Scott please",
      deps
    );
    expect(wantTransfer.action).toBe("transfer");

    const failed = transferFailedResult(wantTransfer);
    expect(failed.nextState.phase).toBe("TAKE_MESSAGE");
    expect(failed.nextState.activeGuest?.name).toBe("Jane McDaniel");

    const took = await step(
      failed.nextState,
      "Please have Scott call the desk",
      deps
    );
    const followUp = await step(
      took.nextState,
      "Can she still park in the garage?",
      deps
    );
    expect(followUp.action).toBeUndefined();
    expect(followUp.action).not.toBe("hangup");
    expect(notifyEvents(followUp.effects)).toContain("message.taken");
    expect(notifyEvents(followUp.effects)).toContain("guest.info_answered");
    expect(
      followUp.effects.filter((e) => e.type === "saveMessage")
    ).toHaveLength(1);
    expect(followUp.nextState.messageSaved).toBe(true);
    expect(followUp.reply.toLowerCase()).toMatch(/parking|garage/);
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
    expect(r.action).toBeUndefined();
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

  it("STT fragments get a clarification, then offer connect", async () => {
    const first = await step({ phase: "INTENT" }, "I have a ", noMatch);
    expect(first.reply).toContain("say that again");
    const second = await step(first.nextState, "and then the ", noMatch);
    const third = await step(second.nextState, "with a ", noMatch);
    expect(third.action).toBeUndefined();
    expect(third.nextState.phase).toBe("OFFER_TRANSFER");
  });

  it("regression: ASK_NAME rejects phrasing debris instead of denying on it", async () => {
    const r = await step({ phase: "ASK_NAME" }, "a visitor for them", noMatch);
    expect(r.reply).toContain("name");
    expect(r.nextState.phase).toBe("ASK_NAME");
    // After clarification budget, offer connect rather than a guessy lookup.
    const r3 = await step(
      { phase: "ASK_NAME", clarifies: 2 },
      "someone here",
      noMatch
    );
    expect(r3.action === "transfer" || r3.nextState.phase === "OFFER_TRANSFER").toBe(
      true
    );
  });

  it("HOLDING (legacy): transfers to Scott when available", async () => {
    const r = await step({ phase: "HOLDING" }, "Hello? Are you there?", noMatch);
    expect(r.action).toBe("transfer");
    expect(r.transferTarget).toBe("scott");
  });

  it("goodbye soft-closes without hangup", async () => {
    const r = await step({ phase: "INTENT" }, "Okay that's all, goodbye", noMatch);
    expect(r.action).toBeUndefined();
    expect(r.nextState.phase).toBe("INTENT");
  });
});

describe("desk-subject redesign (clarify / holds / message / unnamed)", () => {
  const janeNotes =
    "Jane McDaniel is allowed access to the condo and secured underground parking.";
  const jane = guest("Jane McDaniel", janeNotes);

  const admitJane = async () => {
    const deps = depsWith(async () => ({ match: jane, candidates: [jane] }), {
      answerGuestInfo: async () => ({
        answer: "yes",
        reply: "Yes, Jane McDaniel has underground parking access.",
      }),
    });
    const admitted = await step(
      { phase: "INTENT" },
      "Jane McDaniel is here to see Scott",
      deps
    );
    expect(outcomeOf(admitted.effects)).toBe("guest_admitted");
    return { admitted, deps };
  };

  it("he/they location after Jane clarifies — never answers from Jane notes", async () => {
    const { admitted, deps } = await admitJane();
    let answeredFromNotes = false;
    const guarded = {
      ...deps,
      answerGuestInfo: async () => {
        answeredFromNotes = true;
        return {
          answer: "yes" as const,
          reply: "Yes, Jane McDaniel may come up.",
        };
      },
    };
    const r = await step(
      admitted.nextState,
      "He's downstairs, can he come up?",
      guarded
    );
    expect(answeredFromNotes).toBe(false);
    expect(r.nextState.phase).toBe("CLARIFY_SUBJECT");
    expect(r.nextState.activeGuest?.name).toBe("Jane McDaniel");
    expect(r.nextState.pendingUtterance).toMatch(/downstairs/i);
    expect(r.reply).toMatch(/Jane McDaniel|someone new/i);
    expect(notifyEvents(r.effects)).not.toContain("guest.info_answered");
  });

  it("clarify → same guest replays pending question against notes", async () => {
    const { admitted, deps } = await admitJane();
    const ask = await step(
      admitted.nextState,
      "He's downstairs, can he come up?",
      deps
    );
    expect(ask.nextState.phase).toBe("CLARIFY_SUBJECT");
    const confirmed = await step(ask.nextState, "Yes, Jane", deps);
    expect(notifyEvents(confirmed.effects)).toContain("guest.info_answered");
    expect(confirmed.nextState.activeGuest?.name).toBe("Jane McDaniel");
    expect(confirmed.nextState.phase).toBe("INTENT");
  });

  it("clarify → someone new asks for a name and clears Jane", async () => {
    const { admitted, deps } = await admitJane();
    const ask = await step(
      admitted.nextState,
      "They're waiting outside, can they park?",
      deps
    );
    const neu = await step(ask.nextState, "Someone new", deps);
    expect(neu.nextState.phase).toBe("ASK_NAME");
    expect(neu.nextState.activeGuest).toBeNull();
  });

  it("hold variants soft-close; hold+question answers Guest Info", async () => {
    const { admitted, deps } = await admitJane();
    for (const hold of [
      "hold on please",
      "hold on a second",
      "one moment please",
      "just a minute",
    ]) {
      const bare = await step(admitted.nextState, hold, deps);
      expect(bare.action, hold).toBeUndefined();
      expect(bare.reply.toLowerCase(), hold).toMatch(/here if you need/);
    }
    const holdQ = await step(
      admitted.nextState,
      "Hold on a second, can she still use the garage?",
      deps
    );
    expect(notifyEvents(holdQ.effects)).toContain("guest.info_answered");
    expect(holdQ.nextState.activeGuest?.name).toBe("Jane McDaniel");
  });

  it("visitor-parking questions keep Jane (not treated as new arrival)", async () => {
    const { admitted, deps } = await admitJane();
    const r = await step(
      admitted.nextState,
      "Does she have visitor parking?",
      deps
    );
    expect(r.nextState.phase).not.toBe("ASK_NAME");
    expect(r.nextState.activeGuest?.name).toBe("Jane McDaniel");
    expect(notifyEvents(r.effects)).toContain("guest.info_answered");
  });

  it("TAKE_MESSAGE keeps guest-info / connect dictation as message body", async () => {
    const { admitted, deps } = await admitJane();
    const failed = transferFailedResult({
      reply: "connecting",
      nextState: admitted.nextState,
      action: "transfer",
      transferTarget: "scott",
      effects: [],
    });
    expect(failed.nextState.phase).toBe("TAKE_MESSAGE");

    const took = await step(
      failed.nextState,
      "Please tell Jane she can use visitor parking and ask Scott to call back",
      deps
    );
    expect(took.nextState.phase).toBe("CONFIRM_MESSAGE");
    expect(took.nextState.messageParts?.join(" ")).toMatch(/visitor parking/i);
    expect(took.action).toBeUndefined();
    expect(notifyEvents(took.effects)).not.toContain("guest.info_answered");
  });

  it("TAKE_MESSAGE still diverts on a clear new arrival", async () => {
    const { admitted, deps } = await admitJane();
    const failed = transferFailedResult({
      reply: "connecting",
      nextState: admitted.nextState,
      action: "transfer",
      transferTarget: "scott",
      effects: [],
    });
    const divert = await step(
      failed.nextState,
      "Actually I also have someone else here, can he come up?",
      deps
    );
    expect(divert.nextState.phase).toBe("ASK_NAME");
    expect(divert.nextState.activeGuest).toBeNull();
  });

  it("descriptive unnamed arrivals never reuse Jane notes", async () => {
    const { admitted, deps } = await admitJane();
    for (const u of [
      "There's a man at the door, can he come up?",
      "I have a delivery person here, can they come up?",
      "There's a female visitor downstairs asking for access",
      "I have a female guest here, can she come up?",
      "Guest in the lobby wants to come up",
      "Visitor downstairs asking for access",
    ]) {
      let answeredFromNotes = false;
      const guarded = {
        ...deps,
        answerGuestInfo: async () => {
          answeredFromNotes = true;
          return { answer: "yes" as const, reply: "should not run" };
        },
      };
      const r = await step(admitted.nextState, u, guarded);
      expect(answeredFromNotes, u).toBe(false);
      expect(r.nextState.phase, u).toBe("ASK_NAME");
      expect(r.nextState.activeGuest, u).toBeNull();
      expect(notifyEvents(r.effects), u).not.toContain("guest.info_answered");
    }
  });

  it("clarify denials / yes-someone-new clear Jane (never forceSameGuest)", async () => {
    const { admitted, deps } = await admitJane();
    const ask = await step(
      admitted.nextState,
      "He's downstairs, can he come up?",
      deps
    );
    expect(ask.nextState.phase).toBe("CLARIFY_SUBJECT");

    for (const reply of [
      "not her",
      "not Jane",
      "no it's not her",
      "yes, someone new",
      "Right, someone else",
    ]) {
      let answeredFromNotes = false;
      const guarded = {
        ...deps,
        answerGuestInfo: async () => {
          answeredFromNotes = true;
          return { answer: "yes" as const, reply: "should not run" };
        },
      };
      const r = await step(ask.nextState, reply, guarded);
      expect(answeredFromNotes, reply).toBe(false);
      expect(r.nextState.phase, reply).toBe("ASK_NAME");
      expect(r.nextState.activeGuest, reply).toBeNull();
      expect(notifyEvents(r.effects), reply).not.toContain(
        "guest.info_answered"
      );
    }
  });

  it("someone + instructions for her clarifies instead of reusing Jane notes", async () => {
    const { admitted, deps } = await admitJane();
    let answeredFromNotes = false;
    const guarded = {
      ...deps,
      answerGuestInfo: async () => {
        answeredFromNotes = true;
        return { answer: "yes" as const, reply: "should not run" };
      },
    };
    const r = await step(
      admitted.nextState,
      "Did someone leave instructions for her?",
      guarded
    );
    expect(answeredFromNotes).toBe(false);
    expect(notifyEvents(r.effects)).not.toContain("guest.info_answered");
    expect(r.nextState.phase).toBe("CLARIFY_SUBJECT");
    expect(r.nextState.activeGuest?.name).toBe("Jane McDaniel");
  });

  it("CONFIRM_MESSAGE routes clarify subjects after finalize", async () => {
    const { admitted, deps } = await admitJane();
    let answeredFromNotes = false;
    const guarded = {
      ...deps,
      answerGuestInfo: async () => {
        answeredFromNotes = true;
        return { answer: "yes" as const, reply: "should not run" };
      },
    };
    const r = await step(
      {
        phase: "CONFIRM_MESSAGE",
        messageParts: ["Please call about the package"],
        activeGuest: admitted.nextState.activeGuest,
      },
      "He's downstairs, can he come up?",
      guarded
    );
    expect(answeredFromNotes).toBe(false);
    expect(notifyEvents(r.effects)).toContain("message.taken");
    expect(r.nextState.phase).toBe("CLARIFY_SUBJECT");
    expect(r.nextState.activeGuest?.name).toBe("Jane McDaniel");
    expect(r.nextState.pendingUtterance).toMatch(/downstairs/i);
  });

  it("someone-new with unmatched name still clears Jane", async () => {
    const { admitted, deps } = await admitJane();
    const ask = await step(
      admitted.nextState,
      "They're waiting outside, can they park?",
      deps
    );
    const r = await step(ask.nextState, "No, this is Bob Smith", {
      ...deps,
      matchGuest: async () => ({ match: null, candidates: [] }),
    });
    expect(r.nextState.phase).toBe("ASK_NAME");
    expect(r.nextState.activeGuest).toBeNull();
  });

  it("someone + parking question does not reuse Jane notes", async () => {
    const { admitted, deps } = await admitJane();
    let answeredFromNotes = false;
    const guarded = {
      ...deps,
      answerGuestInfo: async () => {
        answeredFromNotes = true;
        return { answer: "yes" as const, reply: "should not run" };
      },
    };
    const r = await step(
      admitted.nextState,
      "Can someone park in the garage?",
      guarded
    );
    expect(answeredFromNotes).toBe(false);
    expect(r.nextState.phase).toBe("ASK_NAME");
    expect(r.nextState.activeGuest).toBeNull();
  });

  it("deictic the/our guest + she/her keeps Jane notes", async () => {
    const { admitted, deps } = await admitJane();
    for (const u of [
      "I have the guest here, can she come up?",
      "Our guest is in the lobby, can she park?",
    ]) {
      const r = await step(admitted.nextState, u, deps);
      expect(r.nextState.phase, u).not.toBe("ASK_NAME");
      expect(r.nextState.activeGuest?.name, u).toBe("Jane McDaniel");
      expect(notifyEvents(r.effects), u).toContain("guest.info_answered");
    }
  });

  it("deictic guest + location without she/her clarifies (no Jane notes)", async () => {
    const { admitted, deps } = await admitJane();
    for (const u of [
      "The guest in the lobby wants to come up",
      "Our guest is in the lobby",
      "This guest is waiting outside",
      "The visitor is downstairs asking for access",
      "The guest is here",
      "Our guest arrived",
      "This guest is here",
    ]) {
      let answeredFromNotes = false;
      const guarded = {
        ...deps,
        answerGuestInfo: async () => {
          answeredFromNotes = true;
          return { answer: "yes" as const, reply: "should not run" };
        },
      };
      const r = await step(admitted.nextState, u, guarded);
      expect(answeredFromNotes, u).toBe(false);
      expect(notifyEvents(r.effects), u).not.toContain("guest.info_answered");
      expect(r.nextState.phase, u).toBe("CLARIFY_SUBJECT");
      expect(r.nextState.activeGuest?.name, u).toBe("Jane McDaniel");
    }
  });

  it("friend-of-Jane / other named access does not reuse Jane notes", async () => {
    const { admitted, deps } = await admitJane();
    for (const u of [
      "A friend of Jane is here, can they come up?",
      "Jane is here, can Bob come up?",
      "Can Bob come up?",
      "Can Bob please come up?",
    ]) {
      let answeredFromNotes = false;
      const guarded = {
        ...deps,
        matchGuest: async () => ({ match: null, candidates: [] }),
        answerGuestInfo: async () => {
          answeredFromNotes = true;
          return { answer: "yes" as const, reply: "should not run" };
        },
      };
      const r = await step(admitted.nextState, u, guarded);
      expect(answeredFromNotes, u).toBe(false);
      expect(notifyEvents(r.effects), u).not.toContain("guest.info_answered");
      expect(
        ["ASK_NAME", "CLARIFY_SUBJECT"].includes(r.nextState.phase),
        `${u} → ${r.nextState.phase}`
      ).toBe(true);
      if (r.nextState.phase === "ASK_NAME") {
        expect(r.nextState.activeGuest, u).toBeNull();
      }
    }
  });

  it("can Jane please / can the guest come up keeps Jane notes", async () => {
    const { admitted, deps } = await admitJane();
    for (const u of [
      "Can Jane please come up?",
      "Can Jane still come up?",
      "Can the guest come up?",
      "Can our guest come up?",
    ]) {
      const r = await step(admitted.nextState, u, deps);
      expect(r.nextState.phase, u).not.toBe("ASK_NAME");
      expect(r.nextState.activeGuest?.name, u).toBe("Jane McDaniel");
      expect(notifyEvents(r.effects), u).toContain("guest.info_answered");
    }
  });

  it("she/her with a new person intro does not bind to Jane", async () => {
    const { admitted, deps } = await admitJane();
    for (const u of [
      "Sarah Connor is at the door, can she come up?",
      "There is a housekeeper at the door, can she come up?",
      "There is a housekeeper here, can she come up?",
      "Someone new is here, can she come up?",
      "I have someone here, can she come up?",
      "Somebody new downstairs, can she come up?",
      "He is with her, can he come up?",
    ]) {
      let answeredFromNotes = false;
      const guarded = {
        ...deps,
        matchGuest: async () => ({ match: null, candidates: [] }),
        answerGuestInfo: async () => {
          answeredFromNotes = true;
          return { answer: "yes" as const, reply: "should not run" };
        },
      };
      const r = await step(admitted.nextState, u, guarded);
      expect(answeredFromNotes, u).toBe(false);
      expect(notifyEvents(r.effects), u).not.toContain("guest.info_answered");
      // New arrival asks name; mixed-pronoun clarify asks which person.
      expect(
        ["ASK_NAME", "CLARIFY_SUBJECT"].includes(r.nextState.phase),
        `${u} → ${r.nextState.phase}`
      ).toBe(true);
      if (r.nextState.phase === "ASK_NAME") {
        expect(r.nextState.activeGuest, u).toBeNull();
      }
    }
  });

  it("same first name different surname does not reuse Jane", async () => {
    const { admitted, deps } = await admitJane();
    let answeredFromNotes = false;
    const guarded = {
      ...deps,
      matchGuest: async () => ({ match: null, candidates: [] }),
      answerGuestInfo: async () => {
        answeredFromNotes = true;
        return { answer: "yes" as const, reply: "should not run" };
      },
    };
    const r = await step(
      admitted.nextState,
      "Jane Smith is here, can she come up?",
      guarded
    );
    expect(answeredFromNotes).toBe(false);
    expect(r.nextState.phase).toBe("ASK_NAME");
    expect(r.nextState.activeGuest).toBeNull();
    expect(notifyEvents(r.effects)).not.toContain("guest.info_answered");
  });
});

describe("name extraction stop-word boundaries", () => {
  it("extracts Ann, Helen, and Theodore (stop words must not prefix-match)", () => {
    expect(extractName("Ann Smith is here, can she come up?")).toBe(
      "Ann Smith"
    );
    expect(extractName("Helen Park is at the door")).toBe("Helen Park");
    expect(extractName("Theodore Roosevelt is downstairs")).toBe(
      "Theodore Roosevelt"
    );
    expect(extractName("I have Ann here")).toBe("Ann");
    expect(extractName("I have Helen waiting")).toBe("Helen");
  });
});
