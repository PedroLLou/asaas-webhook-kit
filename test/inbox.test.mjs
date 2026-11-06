import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { createEntitlementPolicy, openInbox, syntheticEvent } from "../src/index.mjs";

const CHILD = fileURLToPath(new URL("../fixtures/crash-child.mjs", import.meta.url));
const BASE_ONFACT = { payment_confirmed: "grant", payment_refunded: "revoke" };
const T = (hhmmss) => `2026-01-15 ${hhmmss}`;

/** A fresh file-backed inbox in its own temp dir, with a controllable clock. */
function setup(t, options = {}) {
  const dir = mkdtempSync(join(tmpdir(), "awk-test-"));
  const path = join(dir, "inbox.db");
  const clock = { now: 1_800_000_000_000 };
  const opened = [];
  const open = (extra = {}) => {
    const inbox = openInbox({
      path,
      policy: createEntitlementPolicy({ onFact: BASE_ONFACT }),
      now: () => clock.now,
      ...options,
      ...extra,
    });
    opened.push(inbox);
    return inbox;
  };
  t.after(() => {
    for (const i of opened) i.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return { dir, path, clock, open };
}

const effects = (inbox) => inbox.listEffects({ pendingOnly: false }).map((e) => `${e.action}:${e.entityId}`);

test("a valid event is acknowledged with 200 only after it is durable and pending", (t) => {
  const { path, open } = setup(t);
  const inbox = open();
  const r = inbox.receive(syntheticEvent({ id: "evt_1" }));
  assert.deepEqual([r.ack, r.status], [200, "stored"]);
  // Visible to an independent connection before any processing happened.
  const raw = new DatabaseSync(path, { readOnly: true });
  const row = raw.prepare("SELECT status FROM inbox WHERE event_id = 'evt_1'").get();
  raw.close();
  assert.equal(row.status, "pending");
  assert.equal(effects(inbox).length, 0);
});

test("duplicate delivery of the same payload is acknowledged and produces no second effect", (t) => {
  const { open } = setup(t);
  const inbox = open();
  const body = syntheticEvent({ id: "evt_dup" });
  assert.equal(inbox.receive(body).status, "stored");
  inbox.processDue();
  const again = inbox.receive({ ...body }); // after processing too
  assert.deepEqual([again.ack, again.status], [200, "duplicate"]);
  assert.equal(inbox.processDue().results.length, 0);
  assert.deepEqual(effects(inbox), ["grant:pay_synthetic_001"]);
  assert.equal(inbox.stats().processed, 1);
});

test("a duplicate with reordered keys is still a duplicate, not a conflict", (t) => {
  const { open } = setup(t);
  const inbox = open();
  inbox.receive('{"id":"evt_k","event":"PAYMENT_CONFIRMED","dateCreated":"2026-01-15 10:00:00","payment":{"id":"p1"}}');
  const r = inbox.receive('{"payment":{"id":"p1"},"dateCreated":"2026-01-15 10:00:00","event":"PAYMENT_CONFIRMED","id":"evt_k"}');
  assert.equal(r.status, "duplicate");
});

test("same id with different content is a recorded conflict: acknowledged, not applied, entity flagged", (t) => {
  const { open } = setup(t);
  const inbox = open();
  inbox.receive(syntheticEvent({ id: "evt_c", paymentId: "pay_c" }));
  const r = inbox.receive(syntheticEvent({ id: "evt_c", paymentId: "pay_c", event: "PAYMENT_REFUNDED" }));
  assert.deepEqual([r.ack, r.status], [200, "conflict"]);
  assert.equal(inbox.listConflicts().length, 1);
  assert.equal(inbox.getEntity("pay_c").reconciliationReason, "event_id_conflict");
  // Redelivering the conflicting body does not pile up rows.
  inbox.receive(syntheticEvent({ id: "evt_c", paymentId: "pay_c", event: "PAYMENT_REFUNDED" }));
  assert.equal(inbox.listConflicts().length, 1);
  inbox.processDue();
  assert.equal(effects(inbox).length, 0, "nothing is granted or revoked for a flagged entity");
});

test("out-of-order: a late older event is a no-op and does not override newer state", (t) => {
  const { open } = setup(t);
  const inbox = open();
  inbox.receive(syntheticEvent({ id: "evt_new", paymentId: "pay_o", dateCreated: T("10:10:00") }));
  inbox.processDue();
  inbox.receive(
    syntheticEvent({ id: "evt_old", paymentId: "pay_o", event: "PAYMENT_REFUNDED", dateCreated: T("10:05:00") }),
  );
  const { results } = inbox.processDue();
  assert.equal(results[0].outcome, "stale_noop");
  assert.deepEqual(effects(inbox), ["grant:pay_o"]);
  assert.equal(inbox.getEntity("pay_o").lastEventId, "evt_new");
});

test("out-of-order: arrival order does not change the final state when timestamps differ", (t) => {
  const finals = [];
  for (const order of [["a", "b"], ["b", "a"]]) {
    const { open } = setup(t);
    const inbox = open();
    const events = {
      a: syntheticEvent({ id: "evt_a", paymentId: "pay_x", dateCreated: T("10:00:00") }),
      b: syntheticEvent({ id: "evt_b", paymentId: "pay_x", event: "PAYMENT_REFUNDED", dateCreated: T("10:00:05") }),
    };
    for (const k of order) {
      inbox.receive(events[k]);
      inbox.processDue();
    }
    finals.push(inbox.getEntity("pay_x").lastKind);
    inbox.close();
  }
  assert.deepEqual(finals, ["payment_refunded", "payment_refunded"]);
});

test("a missing timestamp is stored, never applied, and flags the entity", (t) => {
  const { open } = setup(t);
  const inbox = open();
  const r = inbox.receive(syntheticEvent({ id: "evt_n", paymentId: "pay_n", dateCreated: null }));
  assert.equal(r.ack, 200);
  const { results } = inbox.processDue();
  assert.equal(results[0].outcome, "reconciliation_required");
  assert.equal(inbox.getEntity("pay_n").reconciliationReason, "timestamp_missing");
  assert.equal(effects(inbox).length, 0);
});

test("an invalid timestamp behaves the same as a missing one", (t) => {
  const { open } = setup(t);
  const inbox = open();
  inbox.receive(syntheticEvent({ id: "evt_bad", paymentId: "pay_bad", dateCreated: "2026-02-30 10:00:00" }));
  assert.equal(inbox.processDue().results[0].outcome, "reconciliation_required");
  assert.equal(inbox.getEntity("pay_bad").reconciliationReason, "timestamp_invalid");
  assert.equal(effects(inbox).length, 0);
});

test("later events for a flagged entity are held, not applied", (t) => {
  const { open } = setup(t);
  const inbox = open();
  inbox.receive(syntheticEvent({ id: "evt_1", paymentId: "pay_h", dateCreated: null }));
  inbox.processDue();
  inbox.receive(syntheticEvent({ id: "evt_2", paymentId: "pay_h", dateCreated: T("11:00:00") }));
  assert.equal(inbox.processDue().results[0].outcome, "held");
  assert.equal(effects(inbox).length, 0);
});

test("same second, opposite directions: reconciliation required, nothing revoked automatically", (t) => {
  const { open } = setup(t);
  const inbox = open();
  inbox.receive(syntheticEvent({ id: "evt_ok", paymentId: "pay_t", dateCreated: T("10:00:00") }));
  inbox.processDue();
  inbox.receive(
    syntheticEvent({ id: "evt_ref", paymentId: "pay_t", event: "PAYMENT_REFUNDED", dateCreated: T("10:00:00") }),
  );
  const { results } = inbox.processDue();
  assert.equal(results[0].outcome, "reconciliation_required");
  assert.equal(results[0].reason, "tie_conflicting_directions");
  assert.deepEqual(effects(inbox), ["grant:pay_t"], "no revoke effect was created");
  assert.ok(inbox.getEntity("pay_t").reconciliationReason);
});

test("same second with a configured tie priority converges regardless of arrival order", (t) => {
  const outcomes = [];
  for (const order of [["evt_ok", "evt_ref"], ["evt_ref", "evt_ok"]]) {
    const { open } = setup(t);
    const inbox = open({
      policy: createEntitlementPolicy({
        onFact: BASE_ONFACT,
        tiePriority: ["payment_refunded", "payment_confirmed"],
      }),
    });
    const bodies = {
      evt_ok: syntheticEvent({ id: "evt_ok", paymentId: "pay_p", dateCreated: T("10:00:00") }),
      evt_ref: syntheticEvent({ id: "evt_ref", paymentId: "pay_p", event: "PAYMENT_REFUNDED", dateCreated: T("10:00:00") }),
    };
    for (const id of order) {
      inbox.receive(bodies[id]);
      inbox.processDue();
    }
    outcomes.push(inbox.getEntity("pay_p").lastKind);
    inbox.close();
  }
  assert.deepEqual(outcomes, ["payment_refunded", "payment_refunded"]);
});

test("same second, same kind from two different event ids is a no-op", (t) => {
  const { open } = setup(t);
  const inbox = open();
  inbox.receive(syntheticEvent({ id: "evt_1", paymentId: "pay_s", dateCreated: T("10:00:00") }));
  inbox.receive(syntheticEvent({ id: "evt_2", paymentId: "pay_s", dateCreated: T("10:00:00") }));
  const outcomes = inbox.processDue().results.map((r) => r.outcome);
  assert.deepEqual(outcomes, ["applied", "noop"]);
  assert.equal(effects(inbox).length, 1);
});

test("unknown events are recorded and ignored even if a policy would grant everything", (t) => {
  const seen = [];
  const { open } = setup(t);
  const inbox = open({ policy: (fact) => (seen.push(fact.kind), { action: "grant" }) });
  inbox.receive({ id: "evt_u", event: "PAYMENT_BRAND_NEW", payment: { id: "pay_u" }, dateCreated: T("10:00:00") });
  const { results } = inbox.processDue();
  assert.equal(results[0].outcome, "ignored_unknown");
  assert.deepEqual(seen, []);
  assert.equal(effects(inbox).length, 0);
  assert.equal(inbox.getEntity("pay_u"), null);
});

test("crash after register: the event is still pending after reopening and is then processed once", (t) => {
  const { path, open } = setup(t);
  const child = spawnSync(process.execPath, [CHILD, path, "after-receive"], { encoding: "utf8" });
  assert.equal(child.status, 7);
  const inbox = open();
  assert.equal(inbox.getEvent("evt_crash").status, "pending");
  inbox.processDue();
  assert.equal(inbox.getEvent("evt_crash").status, "processed");
  assert.deepEqual(effects(inbox), ["grant:pay_crash"]);
  assert.equal(inbox.receive(syntheticEvent({ id: "evt_crash", paymentId: "pay_crash" })).status, "duplicate");
});

test("crash during processing leaves no partial state and the event is retried", (t) => {
  const { path, open } = setup(t);
  const child = spawnSync(process.execPath, [CHILD, path, "during-processing"], { encoding: "utf8" });
  assert.equal(child.status, 9);
  const inbox = open();
  assert.equal(inbox.getEvent("evt_crash").status, "pending");
  assert.equal(inbox.getEntity("pay_crash"), null);
  assert.equal(effects(inbox).length, 0);
  inbox.processDue();
  assert.deepEqual(effects(inbox), ["grant:pay_crash"]);
});

test("a failing policy keeps the event pending with backoff; state and effects stay untouched", (t) => {
  const { clock, open } = setup(t);
  let calls = 0;
  const inbox = open({
    retryDelayMs: (n) => n * 1000,
    policy: (fact, ctx) => {
      calls += 1;
      if (calls === 1) throw new Error("boom with sensitive@example.test inside");
      return createEntitlementPolicy({ onFact: BASE_ONFACT })(fact, ctx);
    },
  });
  inbox.receive(syntheticEvent({ id: "evt_f", paymentId: "pay_f" }));
  const first = inbox.processDue().results[0];
  assert.equal(first.outcome, "retry_scheduled");
  assert.equal(first.attempts, 1);
  assert.equal(inbox.getEvent("evt_f").status, "pending");
  assert.equal(inbox.getEntity("pay_f"), null);
  assert.equal(effects(inbox).length, 0);
  assert.equal(inbox.getEvent("evt_f").lastError, "Error", "only the error name is kept, never the message");

  assert.equal(inbox.processDue().results.length, 0, "not due before the backoff elapses");
  clock.now += 1000;
  assert.equal(inbox.processDue().results[0].outcome, "applied");
  assert.equal(inbox.getEvent("evt_f").attempts, 1);
  assert.equal(inbox.getEvent("evt_f").lastError, null);
});

test("a poisonous event goes dead after maxAttempts and does not block others", (t) => {
  const { clock, open } = setup(t);
  const inbox = open({
    maxAttempts: 2,
    retryDelayMs: () => 10,
    policy: (fact) => {
      if (fact.paymentId === "pay_bad") throw new TypeError("bad");
      return { action: "grant" };
    },
  });
  inbox.receive(syntheticEvent({ id: "evt_bad", paymentId: "pay_bad" }));
  inbox.receive(syntheticEvent({ id: "evt_good", paymentId: "pay_good" }));
  const first = inbox.processDue().results.map((r) => r.outcome);
  assert.deepEqual(first, ["retry_scheduled", "applied"]);
  clock.now += 10;
  assert.equal(inbox.processDue().results[0].outcome, "dead");
  assert.equal(inbox.getEvent("evt_bad").status, "dead");
  clock.now += 10_000;
  assert.equal(inbox.processDue().results.length, 0);
  assert.equal(inbox.stats().dead, 1);
});

test("a policy that returns a promise or garbage is treated as a failure, not applied", (t) => {
  const { open } = setup(t);
  for (const policy of [async () => ({ action: "grant" }), () => ({ action: "give_pro_forever" }), () => null]) {
    const inbox = open({ path: ":memory:", policy });
    inbox.receive(syntheticEvent({ id: "evt_p" }));
    assert.equal(inbox.processDue().results[0].outcome, "retry_scheduled");
    assert.equal(inbox.listEffects().length, 0);
    inbox.close();
  }
});

test("storage failure answers 503 and stores nothing", (t) => {
  const { path, open } = setup(t);
  const inbox = open();
  inbox.close();
  const r = inbox.receive(syntheticEvent({ id: "evt_503" }));
  assert.equal(r.ack, 503);
  assert.equal(r.status, "storage_error");
  const reopened = open();
  assert.equal(reopened.getEvent("evt_503"), null);
  assert.ok(path);
});

test("invalid input answers 400 and stores nothing", (t) => {
  const { open } = setup(t);
  const inbox = open();
  for (const bad of [{}, { id: "e" }, { id: "e", event: "PAYMENT_CONFIRMED" }, "not json", null]) {
    assert.equal(inbox.receive(bad).ack, 400);
  }
  assert.deepEqual(inbox.stats(), {
    pending: 0, processed: 0, dead: 0, pendingEffects: 0, entitiesInReconciliation: 0, conflicts: 0,
  });
});

test("effects are idempotently keyed and can be marked applied once", (t) => {
  const { open } = setup(t);
  const inbox = open();
  inbox.receive(syntheticEvent({ id: "evt_e", paymentId: "pay_e" }));
  inbox.processDue();
  const [effect] = inbox.listEffects();
  assert.equal(typeof effect.effectKey, "string");
  assert.ok(effect.effectKey.length > 0);
  assert.equal(inbox.markEffectApplied(effect.effectKey), true);
  assert.equal(inbox.markEffectApplied(effect.effectKey), false);
  assert.equal(inbox.listEffects().length, 0);
  assert.equal(inbox.listEffects({ pendingOnly: false }).length, 1);
});

test("incomplete reconciliation changes nothing and never revokes", (t) => {
  const { open } = setup(t);
  const inbox = open();
  inbox.receive(syntheticEvent({ id: "evt_ok", paymentId: "pay_r", dateCreated: T("10:00:00") }));
  inbox.processDue();
  inbox.receive(syntheticEvent({ id: "evt_ref", paymentId: "pay_r", event: "PAYMENT_REFUNDED", dateCreated: T("10:00:00") }));
  inbox.processDue();
  const before = inbox.getEntity("pay_r");
  assert.ok(before.reconciliationReason);

  const incomplete = inbox.resolveReconciliation("pay_r", {
    complete: false, kind: "payment_refunded", observedAt: Date.now(),
  });
  assert.deepEqual([incomplete.resolved, incomplete.reason], [false, "snapshot_incomplete"]);
  assert.deepEqual(inbox.getEntity("pay_r"), before);
  assert.deepEqual(effects(inbox), ["grant:pay_r"], "no revoke from an incomplete snapshot");

  // `complete` must be exactly true.
  assert.equal(inbox.resolveReconciliation("pay_r", { complete: "yes", kind: "payment_refunded", observedAt: 1 }).resolved, false);
});

test("complete reconciliation clears the flag and runs the snapshot through the policy", (t) => {
  const { open } = setup(t);
  const inbox = open();
  inbox.receive(syntheticEvent({ id: "evt_ok", paymentId: "pay_r", dateCreated: T("10:00:00") }));
  inbox.processDue();
  inbox.receive(syntheticEvent({ id: "evt_ref", paymentId: "pay_r", event: "PAYMENT_REFUNDED", dateCreated: T("10:00:00") }));
  inbox.processDue();
  const r = inbox.resolveReconciliation("pay_r", {
    complete: true, kind: "payment_refunded", observedAt: new Date("2026-01-15T14:00:00Z"),
  });
  assert.equal(r.resolved, true);
  assert.equal(inbox.getEntity("pay_r").reconciliationReason, null);
  assert.deepEqual(effects(inbox), ["grant:pay_r", "revoke:pay_r"]);
  assert.equal(inbox.resolveReconciliation("pay_r", { complete: true, kind: "payment_refunded", observedAt: 1 }).reason, "not_flagged");
});

test("a policy that still needs reconciliation leaves the entity flagged", (t) => {
  const { open } = setup(t);
  const inbox = open({ policy: (fact, ctx) => (ctx.source === "reconciliation" ? { action: "reconciliation_required" } : { action: "grant" }) });
  inbox.receive(syntheticEvent({ id: "evt_n", paymentId: "pay_q", dateCreated: null }));
  inbox.processDue();
  const r = inbox.resolveReconciliation("pay_q", { complete: true, kind: "payment_confirmed", observedAt: 1 });
  assert.deepEqual([r.resolved, r.reason], [false, "policy_requires_reconciliation"]);
  assert.ok(inbox.getEntity("pay_q").reconciliationReason);
});

test("retention: purge removes old processed rows only, and refuses to shrink the redelivery window", (t) => {
  const { clock, open } = setup(t);
  const inbox = open({ minRetentionMs: 1000 });
  inbox.receive(syntheticEvent({ id: "evt_old", paymentId: "pay_a" }));
  inbox.receive(syntheticEvent({ id: "evt_unapplied", paymentId: "pay_b" }));
  inbox.processDue();
  const appliedEffect = inbox.listEffects().find(effect => effect.eventId === "evt_old");
  assert.ok(appliedEffect);
  inbox.markEffectApplied(appliedEffect.effectKey);
  clock.now += 5000;
  inbox.receive(syntheticEvent({ id: "evt_pending", paymentId: "pay_c" }));

  assert.throws(() => inbox.purgeProcessed({ olderThan: clock.now }), RangeError);
  const { deleted } = inbox.purgeProcessed({ olderThan: clock.now - 2000 });
  assert.equal(deleted, 1, "only the processed row whose effect was applied");
  assert.equal(inbox.getEvent("evt_old"), null);
  assert.ok(inbox.getEvent("evt_unapplied"));
  assert.ok(inbox.getEvent("evt_pending"));
  assert.equal(inbox.getEntity("pay_a").lastEventId, "evt_old", "entity state is kept");
});

test("the database holds identifiers only: no payload fields, no personal data", (t) => {
  const { path, open } = setup(t);
  const inbox = open();
  const sentinel = "sentinel.person@example.test";
  const cpf = "000.000.000-00";
  inbox.receive(
    syntheticEvent({
      id: "evt_priv",
      paymentId: "pay_priv",
      extra: { payment: { id: "pay_priv", customerEmail: sentinel, cpfCnpj: cpf, description: "private text" } },
    }),
  );
  inbox.processDue();
  inbox.close();
  const raw = readFileSync(path).toString("latin1");
  for (const needle of [sentinel, cpf, "private text"]) {
    assert.ok(!raw.includes(needle), `${needle} must not be stored`);
  }
});

test("a database written by a newer schema is refused", (t) => {
  const { path, open } = setup(t);
  open().close();
  const raw = new DatabaseSync(path);
  raw.exec("PRAGMA user_version = 99");
  raw.close();
  assert.throws(() => open(), /newer version/);
});
