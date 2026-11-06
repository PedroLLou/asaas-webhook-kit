import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createEntitlementPolicy,
  hashPayload,
  neutralPolicy,
  normalizeEvent,
  parseEnvelope,
  parseProviderTimestamp,
  syntheticEvent,
} from "../src/core.mjs";

const fact = (body) => {
  const parsed = parseEnvelope(body);
  assert.equal(parsed.ok, true);
  return normalizeEvent(parsed.value);
};

test("a complete payment envelope is accepted", () => {
  const parsed = parseEnvelope(syntheticEvent({ id: "evt_1" }));
  assert.equal(parsed.ok, true);
  assert.equal(parsed.value.eventId, "evt_1");
  assert.equal(parsed.value.paymentId, "pay_synthetic_001");
});

test("missing id, event or payment.id are each reported by path, without echoing values", () => {
  const secret = "sentinel-value-should-not-leak";
  const cases = [
    [{ event: "PAYMENT_CONFIRMED", payment: { id: "p", note: secret } }, "id"],
    [{ id: "e", payment: { id: "p", note: secret } }, "event"],
    [{ id: "e", event: "PAYMENT_CONFIRMED", payment: { note: secret } }, "payment.id"],
    [{ id: "e", event: "PAYMENT_OVERDUE", note: secret }, "payment"],
  ];
  for (const [body, path] of cases) {
    const parsed = parseEnvelope(body);
    assert.equal(parsed.ok, false);
    assert.ok(parsed.errors.some((e) => e.path === path), `expected error at ${path}`);
    assert.ok(!JSON.stringify(parsed.errors).includes(secret));
  }
});

test("non-object bodies, bad JSON and oversized bodies are rejected", () => {
  for (const input of [null, 42, [], "[]", "{oops", Buffer.from([0xff, 0xfe]), `{"id":"${"x".repeat(300_000)}"}`]) {
    assert.equal(parseEnvelope(input).ok, false);
  }
});

test("JSON text and bytes parse like the equivalent object", () => {
  const body = syntheticEvent({ id: "evt_json" });
  const fromObject = parseEnvelope(body);
  assert.deepEqual(parseEnvelope(JSON.stringify(body)), fromObject);
  assert.deepEqual(parseEnvelope(Buffer.from(JSON.stringify(body))), fromObject);
});

test("ids with control characters or absurd length are rejected", () => {
  assert.equal(parseEnvelope(syntheticEvent({ id: "evt\n1" })).ok, false);
  assert.equal(parseEnvelope(syntheticEvent({ id: "e".repeat(256) })).ok, false);
});

test("events the kit does not know only need id and event", () => {
  const parsed = parseEnvelope({ id: "evt_x", event: "CHECKOUT_CREATED" });
  assert.equal(parsed.ok, true);
  assert.equal(normalizeEvent(parsed.value).kind, "unknown");
});

test("the four payment events normalize to provider facts; anything else is unknown", () => {
  const kinds = {
    PAYMENT_CONFIRMED: "payment_confirmed",
    PAYMENT_RECEIVED: "payment_received",
    PAYMENT_OVERDUE: "payment_overdue",
    PAYMENT_REFUNDED: "payment_refunded",
    PAYMENT_PARTIALLY_REFUNDED: "unknown",
    payment_confirmed: "unknown",
    PAYMENT_NEW_THING_2030: "unknown",
  };
  for (const [event, kind] of Object.entries(kinds)) {
    assert.equal(fact(syntheticEvent({ id: "e", event })).kind, kind, event);
  }
});

test("a fact carries the provider facts, not a decision", () => {
  const f = fact(syntheticEvent({ id: "e", event: "PAYMENT_RECEIVED", paymentId: "pay_9" }));
  assert.deepEqual(Object.keys(f).sort(), [
    "eventId", "kind", "paymentId", "providerEvent", "subscriptionId", "timestampIssue", "timestampMs",
  ]);
});

test("timestamps: naive text uses the configured offset, zoned text is absolute", () => {
  const z = Date.UTC(2026, 0, 15, 13, 0, 0);
  assert.equal(parseProviderTimestamp("2026-01-15 10:00:00"), z);
  assert.equal(parseProviderTimestamp("2026-01-15 10:00:00", -180), z);
  assert.equal(parseProviderTimestamp("2026-01-15 13:00:00", 0), z);
  assert.equal(parseProviderTimestamp("2026-01-15T13:00:00Z"), z);
  assert.equal(parseProviderTimestamp("2026-01-15T10:00:00-03:00"), z);
  assert.equal(parseProviderTimestamp("2026-01-15T13:00:00.250Z"), z + 250);
});

test("invalid timestamps are null", () => {
  for (const bad of ["", "yesterday", "2026-02-30 10:00:00", "2026-13-01 10:00:00", "2026-01-15 24:00:00",
    "2026-01-15", "2026-01-15 10:00:60", 1_700_000_000, null, undefined]) {
    assert.equal(parseProviderTimestamp(bad), null, String(bad));
  }
});

test("a missing or malformed dateCreated becomes a timestamp issue instead of a guess", () => {
  assert.equal(fact(syntheticEvent({ id: "e", dateCreated: null })).timestampIssue, "missing");
  assert.equal(fact(syntheticEvent({ id: "e", dateCreated: "soon" })).timestampIssue, "invalid");
  assert.equal(fact(syntheticEvent({ id: "e", extra: { dateCreated: 12345 } })).timestampIssue, "invalid");
  assert.equal(fact(syntheticEvent({ id: "e" })).timestampIssue, null);
});

test("payload hash ignores key order and whitespace but not content", () => {
  assert.equal(hashPayload({ a: 1, b: { c: [1, 2], d: "x" } }), hashPayload({ b: { d: "x", c: [1, 2] }, a: 1 }));
  assert.notEqual(hashPayload({ a: 1 }), hashPayload({ a: 2 }));
  const a = parseEnvelope('{"id":"e","event":"X"}');
  const b = parseEnvelope('{ "event": "X",\n "id": "e" }');
  assert.equal(a.value.payloadHash, b.value.payloadHash);
});

test("neutral policy and an empty configuration never grant or revoke", () => {
  const empty = createEntitlementPolicy();
  for (const kind of ["payment_confirmed", "payment_received", "payment_overdue", "payment_refunded"]) {
    assert.equal(neutralPolicy().action, "none");
    assert.equal(empty({ kind }, { ordering: "newer", previous: null }).action, "none");
  }
});

test("entitlement policy follows its configuration", () => {
  const policy = createEntitlementPolicy({ onFact: { payment_received: "grant", payment_overdue: "revoke" } });
  assert.equal(policy({ kind: "payment_received" }, { ordering: "first", previous: null }).action, "grant");
  assert.equal(policy({ kind: "payment_overdue" }, { ordering: "newer", previous: null }).action, "revoke");
  assert.equal(policy({ kind: "payment_confirmed" }, { ordering: "newer", previous: null }).action, "none");
});

test("policy configuration rejects unknown kinds, bad actions and bad tie lists", () => {
  assert.throws(() => createEntitlementPolicy({ onFact: { unknown: "grant" } }), TypeError);
  assert.throws(() => createEntitlementPolicy({ onFact: { payment_confirmed: "give_everything" } }), TypeError);
  assert.throws(() => createEntitlementPolicy({ tiePriority: ["payment_confirmed", "payment_confirmed"] }), TypeError);
  assert.throws(() => createEntitlementPolicy({ tiePriority: ["nope"] }), TypeError);
});

test("same-timestamp facts in opposite directions need reconciliation unless a tie priority is configured", () => {
  const onFact = { payment_confirmed: "grant", payment_refunded: "revoke" };
  const previous = { eventId: "e1", kind: "payment_confirmed", timestampMs: 1 };
  const tie = { ordering: "tie", previous };
  const none = createEntitlementPolicy({ onFact });
  assert.equal(none({ kind: "payment_refunded" }, tie).action, "reconciliation_required");
  const ranked = createEntitlementPolicy({ onFact, tiePriority: ["payment_refunded", "payment_confirmed"] });
  assert.equal(ranked({ kind: "payment_refunded" }, tie).action, "revoke");
  assert.equal(
    ranked({ kind: "payment_confirmed" }, { ordering: "tie", previous: { ...previous, kind: "payment_refunded" } }).action,
    "none",
  );
});
