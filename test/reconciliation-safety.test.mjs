import assert from 'node:assert/strict';
import { test } from 'node:test';
import { openInbox, createEntitlementPolicy, syntheticEvent } from '../src/index.mjs';

const NOW = Date.parse('2026-01-16T12:00:00Z');

function flagged(t) {
  const inbox = openInbox({ path: ':memory:', now: () => NOW,
    policy: createEntitlementPolicy({ onFact: { payment_confirmed: 'grant', payment_refunded: 'revoke' } }) });
  t.after(() => inbox.close());
  const event = syntheticEvent({ id: 'evt_safety', paymentId: 'pay_safety', dateCreated: '2026-01-15 10:00:00' });
  inbox.receive(event);
  inbox.processDue();
  inbox.receive({ ...event, event: 'PAYMENT_REFUNDED' });
  assert.equal(inbox.getEntity('pay_safety').reconciliationReason, 'event_id_conflict');
  return inbox;
}

test('a stale reconciliation snapshot cannot be promoted to a newer state', (t) => {
  const inbox = flagged(t);
  const before = inbox.getEntity('pay_safety');
  const result = inbox.resolveReconciliation('pay_safety', {
    complete: true, kind: 'payment_refunded', observedAt: Date.parse('2026-01-14T12:00:00Z'),
  });
  assert.equal(result.resolved, false);
  assert.equal(result.reason, 'snapshot_stale');
  assert.deepEqual(inbox.getEntity('pay_safety'), before);
  assert.equal(inbox.listEffects({ pendingOnly: false }).length, 1);
});

test('a future reconciliation observation cannot suppress later webhook events', (t) => {
  const inbox = flagged(t);
  const result = inbox.resolveReconciliation('pay_safety', {
    complete: true, kind: 'payment_refunded', observedAt: NOW + 60_000,
  });
  assert.equal(result.resolved, false);
  assert.equal(result.reason, 'snapshot_in_future');
  assert.equal(inbox.listEffects({ pendingOnly: false }).length, 1);
});

test('invalid retention and timestamp configuration are rejected before opening storage', () => {
  for (const options of [{ minRetentionMs: NaN }, { minRetentionMs: -1 },
                         { timestampOffsetMinutes: NaN }, { timestampOffsetMinutes: 900 }]) {
    assert.throws(() => openInbox({ path: ':memory:', ...options }), RangeError);
  }
});

test('distinct entity and event identifiers cannot collide in the effect key', (t) => {
  const inbox = openInbox({ path: ':memory:', policy: createEntitlementPolicy({
    onFact: { payment_confirmed: 'grant' },
  }) });
  t.after(() => inbox.close());
  inbox.receive(syntheticEvent({ id: 'c', paymentId: 'a:b' }));
  inbox.receive(syntheticEvent({ id: 'b:c', paymentId: 'a' }));
  inbox.processDue();
  const effects = inbox.listEffects({ pendingOnly: false });
  assert.equal(effects.length, 2);
  assert.equal(new Set(effects.map(effect => effect.effectKey)).size, 2);
});
