import { describe, expect, it } from "vitest";
import {
  CONDO_UNIT,
  DELIVERY_LIST_NAME,
  clarifyDeliveryOrVisitorPrompt,
  deliveryApprovalReply,
  isAmbiguousDeliveryOrVisitor,
  isDeliveryListName,
  looksLikeDeliveryTypeArrival,
  normalizeDeliveryToken,
} from "./delivery";
import { matchGuestAgainst, type GuestNameRow } from "./db/guests";

describe("delivery identity", () => {
  it("matches Delivery case-insensitively with whitespace/punctuation", () => {
    for (const n of [
      "Delivery",
      "delivery",
      " DELIVERY ",
      "Delivery.",
      "delivery!",
      "Delivery?",
      "De-livery",
    ]) {
      expect(isDeliveryListName(n), n).toBe(true);
    }
    expect(normalizeDeliveryToken(" Delivery! ")).toBe("delivery");
    expect(DELIVERY_LIST_NAME).toBe("Delivery");
    expect(CONDO_UNIT).toBe("305");
  });

  it("rejects near-miss and multi-word names", () => {
    for (const n of [
      "Deliveries",
      "Delbert",
      "Deliver",
      "Delivery Person",
      "Jane Delivery",
      "The Delivery",
      "Delaney",
      "",
    ]) {
      expect(isDeliveryListName(n), n).toBe(false);
    }
  });
});

describe("looksLikeDeliveryTypeArrival", () => {
  it("detects food/courier arrivals with presence/access cues", () => {
    for (const u of [
      "There's a DoorDash downstairs",
      "Uber Eats is here",
      "Instacart groceries at the door",
      "I have a food delivery here, can they come up?",
      "We have a takeout delivery here",
      "I have a delivery here, can they come up?",
      "I have a delivery person here, can they come up?",
      "it's a delivery",
      "Delivery",
      "yes, a delivery",
      "Yeah it's a delivery",
    ]) {
      expect(looksLikeDeliveryTypeArrival(u), u).toBe(true);
    }
  });

  it("does not treat bare food/brand chatter as a delivery arrival", () => {
    for (const u of [
      "DoorDash",
      "take out",
      "groceries",
      "food delivery",
      "Notes mention DoorDash preferred",
      "They ordered takeout earlier",
      "I have a package for Jane",
      "We have a delivery for Jane",
      "I have a question for Jane",
      "I've got a package delivery for the unit",
    ]) {
      expect(looksLikeDeliveryTypeArrival(u), u).toBe(false);
    }
  });
});

describe("isAmbiguousDeliveryOrVisitor", () => {
  it("asks when visitor framing mixes with bare delivery", () => {
    expect(
      isAmbiguousDeliveryOrVisitor(
        "I have a visitor with a delivery, can they come up?"
      )
    ).toBe(true);
    expect(
      isAmbiguousDeliveryOrVisitor("Someone is here with a delivery for you")
    ).toBe(true);
  });

  it("is not ambiguous for clear food/courier arrivals", () => {
    expect(
      isAmbiguousDeliveryOrVisitor("There's a DoorDash delivery downstairs")
    ).toBe(false);
    expect(
      isAmbiguousDeliveryOrVisitor(
        "I have a delivery here, can they come up?"
      )
    ).toBe(false);
  });
});

describe("spoken delivery replies", () => {
  it("names unit 305 and invites follow-ups", () => {
    const reply = deliveryApprovalReply();
    expect(reply).toMatch(/Scott and Monica are expecting a delivery/);
    expect(reply).toMatch(/unit 305/);
    expect(reply.toLowerCase()).toMatch(/anything else/);
    expect(clarifyDeliveryOrVisitorPrompt().toLowerCase()).toMatch(
      /delivery.*visitor|visitor.*delivery/
    );
  });
});

describe("Delivery list name — no fuzzy/phonetic collisions", () => {
  const withDelivery: GuestNameRow[] = [
    { id: "d1", name: "Delivery" },
    { id: "j1", name: "Jane McDaniel" },
    { id: "s1", name: "Sera Connor" },
  ];

  it("admits Delivery only on exact (normalized) identity", () => {
    expect(matchGuestAgainst("Delivery", withDelivery).match?.name).toBe(
      "Delivery"
    );
    expect(matchGuestAgainst("delivery", withDelivery).match?.name).toBe(
      "Delivery"
    );
    expect(matchGuestAgainst(" Delivery! ", withDelivery).match?.name).toBe(
      "Delivery"
    );
  });

  it("never fuzzy-matches Delivery mentions to real guests", () => {
    expect(
      matchGuestAgainst("Delivery", [
        { id: "1", name: "Delbert Smith" },
        { id: "2", name: "Jane McDaniel" },
      ]).match
    ).toBeNull();
    expect(
      matchGuestAgainst("delivery", [{ id: "1", name: "Sera Connor" }]).match
    ).toBeNull();
  });

  it("never fuzzy-matches real names onto the Delivery entry", () => {
    for (const spoken of [
      "Delbert",
      "Deliveries",
      "Deliver",
      "Delaney",
      "Jane McDaniel",
      "Sera Connor",
      "Connor",
    ]) {
      const r = matchGuestAgainst(spoken, [{ id: "d1", name: "Delivery" }]);
      expect(r.match, spoken).toBeNull();
    }
    expect(matchGuestAgainst("Jane McDaniel", withDelivery).match?.name).toBe(
      "Jane McDaniel"
    );
    expect(matchGuestAgainst("Sarah Connor", withDelivery).match?.name).toBe(
      "Sera Connor"
    );
  });
});
