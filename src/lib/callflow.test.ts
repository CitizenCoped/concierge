import { describe, expect, it } from "vitest";
import {
  INITIAL_STATE,
  step,
  transferFailedResult,
  type CallflowDeps,
  type Effect,
} from "./callflow";
import type { Guest } from "./db/guests";

const guest = (name: string): Guest => ({
  id: "00000000-0000-0000-0000-000000000001",
  name,
  guest_info: null,
  guest_phone: null,
  starts_at: "",
  ends_at: "",
  created_at: "",
  updated_at: "",
  archived: false,
});

const depsWith = (impl: CallflowDeps["matchGuest"]): CallflowDeps => ({
  matchGuest: impl,
});

const noMatch = depsWith(async () => ({ match: null, candidates: [] }));

function notifyEvents(effects: Effect[]): string[] {
  return effects.filter((e) => e.type === "notify").map((e) => e.event);
}

function outcomeOf(effects: Effect[]): string | undefined {
  return effects.findLast((e) => e.type === "outcome")?.outcome;
}

describe("callflow", () => {
  it("greets and fires call.started on the first turn", async () => {
    const r = await step(INITIAL_STATE, "", noMatch);
    expect(r.reply).toContain("automated concierge assistant");
    expect(notifyEvents(r.effects)).toContain("call.started");
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

  it("expired/future/unknown guest (no match) → denied + transfer", async () => {
    const r = await step({ phase: "ASK_NAME" }, "Nobody Realname", noMatch);
    expect(r.action).toBe("transfer");
    expect(r.transferTarget).toBe("scott");
    expect(r.reply).toContain("don't see them on the approved list");
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
    expect(r.action).toBe("transfer");
    expect(outcomeOf(r.effects)).toBe("no_match_transferred");
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

  it("goodbye closes politely with a hangup", async () => {
    const r = await step({ phase: "INTENT" }, "Okay that's all, goodbye", noMatch);
    expect(r.action).toBe("hangup");
    expect(outcomeOf(r.effects)).toBe("hangup");
  });
});
