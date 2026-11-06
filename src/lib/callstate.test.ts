import { describe, expect, it } from "vitest";
import {
  INITIAL_STATE,
  step,
  transferFailedResult,
  type CallState,
  type CallflowDeps,
  type Effect,
} from "./callflow";
import { mergePersistedCallState, serializeCallState } from "./callstate";

const jane = {
  id: "11111111-1111-1111-1111-111111111111",
  name: "Jane McDaniel",
  guest_info:
    "Jane McDaniel is allowed access to the condo and secured underground parking.",
};

const snapshot = [jane];

function janeState(overrides: Partial<CallState> = {}): CallState {
  return {
    phase: "INTENT",
    activeGuest: {
      id: jane.id,
      name: jane.name,
      guest_info: jane.guest_info,
    },
    guestSnapshot: snapshot,
    ...overrides,
  };
}

function deps(answer?: CallflowDeps["answerGuestInfo"]): CallflowDeps {
  return {
    matchGuest: async (name) => {
      if (/jane/i.test(name)) return { match: jane, candidates: [jane] };
      return { match: null, candidates: [] };
    },
    answerGuestInfo:
      answer ??
      (async () => ({
        answer: "yes",
        reply: "Yes, Jane McDaniel has underground parking access.",
      })),
  };
}

function notifyEvents(effects: Effect[]): string[] {
  return effects
    .filter((e): e is Extract<Effect, { type: "notify" }> => e.type === "notify")
    .map((e) => e.event);
}

/** Legacy buggy coalesce from the webhook — used to prove the regression. */
function buggyPersist(next: CallState, prev: CallState): CallState {
  return {
    ...next,
    guestSnapshot: snapshot,
    activeGuest: next.activeGuest ?? prev.activeGuest,
    messageSaved: next.messageSaved ?? prev.messageSaved,
  };
}

describe("webhook persistence boundary — activeGuest clear", () => {
  it("reproduces: undefined/null ?? priorGuest resurrects Jane", async () => {
    const prev = janeState();
    const r = await step(
      prev,
      "I also have someone else here, can he come up?",
      deps()
    );
    expect(r.nextState.phase).toBe("ASK_NAME");
    // Callflow clears (null). Buggy webhook coalesce brings Jane back.
    const resurrected = buggyPersist(r.nextState, prev);
    expect(resurrected.activeGuest?.name).toBe("Jane McDaniel");
  });

  it("mergePersistedCallState keeps intentional clear through JSON DB round-trip", async () => {
    const prev = janeState();
    const r = await step(
      prev,
      "There's a visitor in the lobby, can they park in the garage?",
      deps()
    );
    expect(r.nextState.phase).toBe("ASK_NAME");
    expect(r.nextState.activeGuest).toBeNull();

    const merged = mergePersistedCallState(r.nextState, prev, snapshot);
    expect(merged.activeGuest).toBeUndefined();
    expect(Object.prototype.hasOwnProperty.call(merged, "activeGuest")).toBe(
      false
    );

    const stored = serializeCallState(merged);
    expect(stored.activeGuest).toBeUndefined();
    expect("activeGuest" in stored).toBe(false);
  });

  it("subsequent turn after persisted clear must not answer from Jane notes", async () => {
    const prev = janeState();
    let notesHits = 0;
    const guarded = deps(async () => {
      notesHits += 1;
      return {
        answer: "yes",
        reply: "Yes, Jane McDaniel has underground parking access.",
      };
    });

    const ask = await step(
      prev,
      "I also have someone else here, can he come up?",
      guarded
    );
    const persisted = serializeCallState(
      mergePersistedCallState(ask.nextState, prev, snapshot)
    );

    // Next webhook turn loads persisted state (no Jane) and asks parking.
    const follow = await step(
      persisted,
      "Can he park in the garage?",
      guarded
    );
    expect(notesHits).toBe(0);
    expect(notifyEvents(follow.effects)).not.toContain("guest.info_answered");
    expect(follow.nextState.activeGuest?.name).not.toBe("Jane McDaniel");
    // Still identifying — no silent admit from Jane's permissions.
    expect(follow.action).not.toBe("transfer");
  });

  it("legitimate same-guest pronoun follow-up still carries Jane across persist", async () => {
    const prev = janeState();
    const r = await step(prev, "Can she still use the garage?", deps());
    expect(notifyEvents(r.effects)).toContain("guest.info_answered");

    const merged = mergePersistedCallState(r.nextState, prev, snapshot);
    const stored = serializeCallState(merged);
    expect(stored.activeGuest?.name).toBe("Jane McDaniel");

    const again = await step(stored, "What time is she expected?", {
      ...deps(),
      answerGuestInfo: async () => ({
        answer: "answered",
        reply: "Jane McDaniel is expected around 3pm.",
      }),
    });
    expect(notifyEvents(again.effects)).toContain("guest.info_answered");
    expect(again.nextState.activeGuest?.name).toBe("Jane McDaniel");
  });

  it("omitted activeGuest on soft-close carries prior guest forward", async () => {
    const prev = janeState();
    // Soft close paths should not wipe Jane when they omit the field.
    const r = await step(prev, "Thank you", deps());
    expect(r.action).toBeUndefined();
    const merged = mergePersistedCallState(r.nextState, prev, snapshot);
    const stored = serializeCallState(merged);
    expect(stored.activeGuest?.name).toBe("Jane McDaniel");
  });

  it("transfer-fail path merge does not resurrect cleared guest or undo messageSaved:false", async () => {
    const prev = janeState({ messageSaved: true });
    // Simulate callflow clear then transferFailedResult (PATCH fail fallback).
    const clearedAsk = await step(
      prev,
      "I have another guest here",
      deps()
    );
    expect(clearedAsk.nextState.activeGuest).toBeNull();

    // If a later transfer fails after clear was persisted…
    const afterClear = serializeCallState(
      mergePersistedCallState(clearedAsk.nextState, prev, snapshot)
    );
    expect(afterClear.activeGuest).toBeUndefined();

    const failed = transferFailedResult({
      reply: "connecting",
      nextState: { phase: "DONE", activeGuest: afterClear.activeGuest },
      action: "transfer",
      transferTarget: "scott",
      effects: [],
    });
    expect(failed.nextState.messageSaved).toBe(false);

    // Same merge the webhook uses on the failure branch.
    const merged = mergePersistedCallState(failed.nextState, afterClear, snapshot);
    const stored = serializeCallState(merged);
    expect(stored.activeGuest).toBeUndefined();
    expect(stored.messageSaved).toBe(false);
    expect(stored.phase).toBe("TAKE_MESSAGE");
  });

  it("admit path still persists new activeGuest", async () => {
    const prev: CallState = { ...INITIAL_STATE, phase: "INTENT" };
    const r = await step(
      prev,
      "Jane McDaniel is here to see Scott",
      deps()
    );
    const merged = mergePersistedCallState(r.nextState, prev, snapshot);
    const stored = serializeCallState(merged);
    expect(stored.activeGuest?.name).toBe("Jane McDaniel");
  });
});
