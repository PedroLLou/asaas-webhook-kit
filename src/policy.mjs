// Entitlement policy: the part that is YOUR product's decision, not the provider's.
//
// A policy is a synchronous, pure function `(fact, context) => decision`.
// The kit ships no default that grants or revokes anything.

export const POLICY_ACTIONS = Object.freeze(["none", "grant", "revoke", "reconciliation_required"]);

/** Policy that never grants, never revokes. Records facts only. */
export function neutralPolicy() {
  return { action: "none", reason: "neutral_policy" };
}

const decide = (action, reason) => ({ action, reason });

/**
 * Builds a policy from a mapping of fact kind to action.
 *
 *   createEntitlementPolicy({
 *     onFact: { payment_confirmed: "grant", payment_refunded: "revoke" },
 *     tiePriority: ["payment_refunded", "payment_confirmed"], // optional
 *   })
 *
 * Kinds missing from `onFact` map to "none". `unknown` cannot be mapped: the
 * inbox never asks a policy about unknown events.
 *
 * Same-timestamp events have no causal order. When two facts at the same
 * timestamp point in opposite directions (grant vs revoke), the policy returns
 * `reconciliation_required` unless `tiePriority` ranks them (earlier entries
 * win). There is no built-in priority.
 */
export function createEntitlementPolicy(options = {}) {
  const onFact = options.onFact ?? {};
  const tiePriority = options.tiePriority ?? null;
  const kinds = ["payment_confirmed", "payment_received", "payment_overdue", "payment_refunded"];
  for (const [kind, action] of Object.entries(onFact)) {
    if (!kinds.includes(kind)) throw new TypeError(`onFact: unsupported fact kind "${kind}"`);
    if (!POLICY_ACTIONS.includes(action)) throw new TypeError(`onFact.${kind}: unsupported action`);
  }
  if (tiePriority !== null) {
    if (!Array.isArray(tiePriority) || new Set(tiePriority).size !== tiePriority.length) {
      throw new TypeError("tiePriority must be an array without duplicates");
    }
    for (const kind of tiePriority) {
      if (!kinds.includes(kind)) throw new TypeError(`tiePriority: unsupported fact kind "${kind}"`);
    }
  }
  const mappedAction = (kind) => onFact[kind] ?? "none";

  return (fact, context) => {
    const mapped = mappedAction(fact.kind);
    if (context.ordering !== "tie" || !context.previous) return decide(mapped, "configured");
    if (mapped === "none") return decide("none", "tie_no_entitlement_change");
    const previous = context.previous;
    if (previous.kind === fact.kind) return decide("none", "tie_same_kind");
    const previousMapped = mappedAction(previous.kind);
    if (previousMapped === mapped) return decide("none", "tie_same_direction");
    if (previousMapped === "none") return decide(mapped, "configured");
    if (tiePriority) {
      const mine = tiePriority.indexOf(fact.kind);
      const theirs = tiePriority.indexOf(previous.kind);
      if (mine !== -1 && theirs !== -1) {
        return mine <= theirs ? decide(mapped, "tie_priority") : decide("none", "tie_lower_priority");
      }
    }
    return decide("reconciliation_required", "tie_conflicting_directions");
  };
}
