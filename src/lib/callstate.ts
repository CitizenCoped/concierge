import type { CallState } from "./callflow";

/**
 * Merge callflow nextState with prior persisted state for DB write.
 *
 * Contract:
 * - If callflow **omits** `activeGuest` / `messageSaved`, carry the prior value
 *   forward (multi-turn continuity).
 * - If callflow **sets** the property — including explicit `null`/`undefined`
 *   clear — that value wins. Never use `??` / nullish coalesce against the prior
 *   guest: `undefined ?? priorGuest` resurrected cleared identity across the
 *   webhook persistence boundary (security).
 */
export function mergePersistedCallState(
  next: CallState,
  prev: CallState,
  guestSnapshot: NonNullable<CallState["guestSnapshot"]>
): CallState {
  const merged: CallState = {
    ...next,
    guestSnapshot: next.guestSnapshot ?? guestSnapshot,
  };

  if (Object.prototype.hasOwnProperty.call(next, "activeGuest")) {
    const g = next.activeGuest;
    if (g == null) {
      // Intentional clear — do not leave a nullish key that JSON drops while
      // also not coalescing back to prev. Omit so the stored blob has no guest.
      delete merged.activeGuest;
    } else {
      merged.activeGuest = g;
    }
  } else if (prev.activeGuest != null) {
    merged.activeGuest = prev.activeGuest;
  } else {
    delete merged.activeGuest;
  }

  if (Object.prototype.hasOwnProperty.call(next, "messageSaved")) {
    merged.messageSaved = next.messageSaved;
  } else if (prev.messageSaved !== undefined) {
    merged.messageSaved = prev.messageSaved;
  }

  return merged;
}

/** Round-trip through JSON the same way the webhook persists `calls.state`. */
export function serializeCallState(state: CallState): CallState {
  return JSON.parse(JSON.stringify(state)) as CallState;
}
