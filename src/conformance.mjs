// Conformance: invariants the inbox guarantees for ANY policy, checked through
// the public interface against fresh synthetic data. No network, no real services.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openInbox } from "./inbox.mjs";
import { syntheticEvent } from "./synthetic.mjs";

function spy(policy) {
  const calls = [];
  const wrapped = (fact, context) => {
    calls.push({ eventId: fact.eventId, kind: fact.kind, ordering: context.ordering });
    return policy(fact, context);
  };
  return { wrapped, calls };
}

function withTempDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), "awk-conformance-"));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const CHECKS = [
  [
    "duplicate delivery is acknowledged and applied once",
    (policy) => {
      const inbox = openInbox({ path: ":memory:", policy });
      const body = syntheticEvent({ id: "evt_dup" });
      const first = inbox.receive(body);
      const second = inbox.receive(structuredClone(body));
      inbox.processDue();
      const ok =
        first.ack === 200 && first.status === "stored" && second.ack === 200 && second.status === "duplicate" &&
        inbox.stats().processed === 1;
      inbox.close();
      return ok;
    },
  ],
  [
    "same id with different content is a recorded conflict and flags the entity",
    (policy) => {
      const inbox = openInbox({ path: ":memory:", policy });
      inbox.receive(syntheticEvent({ id: "evt_c", paymentId: "pay_c" }));
      const r = inbox.receive(syntheticEvent({ id: "evt_c", paymentId: "pay_c", event: "PAYMENT_REFUNDED" }));
      const ok =
        r.status === "conflict" && inbox.listConflicts().length === 1 &&
        inbox.getEntity("pay_c")?.reconciliationReason === "event_id_conflict";
      inbox.close();
      return ok;
    },
  ],
  [
    "invalid envelopes are rejected with 400 and store nothing",
    (policy) => {
      const inbox = openInbox({ path: ":memory:", policy });
      const results = [
        inbox.receive({ event: "PAYMENT_CONFIRMED", payment: { id: "p" } }),
        inbox.receive({ id: "e", event: "PAYMENT_CONFIRMED" }),
        inbox.receive("{not json"),
      ];
      const ok = results.every((r) => r.ack === 400) && inbox.stats().pending === 0;
      inbox.close();
      return ok;
    },
  ],
  [
    "unknown events are recorded but never reach the policy",
    (policy) => {
      const { wrapped, calls } = spy(policy);
      const inbox = openInbox({ path: ":memory:", policy: wrapped });
      inbox.receive({ id: "evt_u", event: "SOMETHING_NEW", dateCreated: "2026-01-15 10:00:00" });
      const { results } = inbox.processDue();
      const ok = calls.length === 0 && results[0].outcome === "ignored_unknown" && inbox.listEffects().length === 0;
      inbox.close();
      return ok;
    },
  ],
  [
    "an older event arriving late is a no-op and never reaches the policy",
    (policy) => {
      const { wrapped, calls } = spy(policy);
      const inbox = openInbox({ path: ":memory:", policy: wrapped });
      inbox.receive(syntheticEvent({ id: "evt_new", paymentId: "pay_o", dateCreated: "2026-01-15 10:10:00" }));
      inbox.processDue();
      inbox.receive(
        syntheticEvent({ id: "evt_old", paymentId: "pay_o", event: "PAYMENT_OVERDUE", dateCreated: "2026-01-15 10:05:00" }),
      );
      const { results } = inbox.processDue();
      const ok = results[0].outcome === "stale_noop" && calls.length === 1;
      inbox.close();
      return ok;
    },
  ],
  [
    "a missing timestamp requires reconciliation and is never applied",
    (policy) => {
      const { wrapped, calls } = spy(policy);
      const inbox = openInbox({ path: ":memory:", policy: wrapped });
      inbox.receive(syntheticEvent({ id: "evt_nots", paymentId: "pay_m", dateCreated: null }));
      const { results } = inbox.processDue();
      const ok =
        results[0].outcome === "reconciliation_required" && calls.length === 0 && inbox.listEffects().length === 0 &&
        inbox.getEntity("pay_m")?.reconciliationReason === "timestamp_missing";
      inbox.close();
      return ok;
    },
  ],
  [
    "storage failure answers 503",
    (policy) => {
      const inbox = openInbox({ path: ":memory:", policy });
      inbox.close();
      return inbox.receive(syntheticEvent({ id: "evt_s" })).ack === 503;
    },
  ],
  [
    "a failing policy keeps the event pending and retries it later",
    (policy) => {
      let clock = 1_000_000;
      let failed = false;
      const flaky = (fact, context) => {
        if (!failed) {
          failed = true;
          throw new Error("synthetic failure");
        }
        return policy(fact, context);
      };
      const inbox = openInbox({ path: ":memory:", policy: flaky, now: () => clock, retryDelayMs: () => 5000 });
      inbox.receive(syntheticEvent({ id: "evt_r", paymentId: "pay_r" }));
      const first = inbox.processDue().results[0];
      const early = inbox.processDue().results.length;
      clock += 5000;
      const retry = inbox.processDue().results[0];
      const ok =
        first.outcome === "retry_scheduled" && early === 0 && retry.outcome !== "retry_scheduled" &&
        inbox.getEvent("evt_r").status === "processed" && inbox.getEvent("evt_r").attempts === 1;
      inbox.close();
      return ok;
    },
  ],
  [
    "a received event survives closing and reopening the database",
    (policy) =>
      withTempDir((dir) => {
        const path = join(dir, "inbox.db");
        const a = openInbox({ path, policy });
        const received = a.receive(syntheticEvent({ id: "evt_d", paymentId: "pay_d" }));
        a.close();
        const b = openInbox({ path, policy });
        const pendingAfterReopen = b.getEvent("evt_d")?.status === "pending";
        b.processDue();
        const ok = received.ack === 200 && pendingAfterReopen && b.getEvent("evt_d").status === "processed";
        b.close();
        return ok;
      }),
  ],
];

/**
 * Runs the conformance checks against `policy`.
 * Returns `{ passed, results: [{ name, ok, error? }] }`.
 */
export function runConformance({ policy }) {
  if (typeof policy !== "function") throw new TypeError("runConformance: policy must be a function");
  const results = CHECKS.map(([name, check]) => {
    try {
      return { name, ok: check(policy) === true };
    } catch (err) {
      return { name, ok: false, error: typeof err?.name === "string" ? err.name : "Error" };
    }
  });
  return { passed: results.every((r) => r.ok), results };
}
