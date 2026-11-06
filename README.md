# asaas-webhook-kit

A small, dependency-free toolkit for handling [Asaas](https://docs.asaas.com) payment webhooks safely: validate the envelope, normalize events into provider facts, keep a durable inbox, and apply events in a way that survives duplicates, crashes and out-of-order delivery. Your product's entitlement rules stay yours.

**Status: 0.1.0, early source release on GitHub. Not published on npm (`private: true`).** Written from the observed behavior of one private billing integration. No other product consumes it yet, so treat the API as unproven.

Requires Node.js >= 22.13 (uses the built-in `node:sqlite`; no runtime or dev dependencies). Node prints an `ExperimentalWarning` for `node:sqlite` on some versions; the CLI hides it, the library does not.

## What it does

- **Validates** the envelope: `id`, `event`, and `payment.id` for the payment events it understands. Errors name the field, never the value.
- **Normalizes** `PAYMENT_CONFIRMED`, `PAYMENT_RECEIVED`, `PAYMENT_OVERDUE` and `PAYMENT_REFUNDED` into provider facts. Every other event is `unknown`: it is recorded, and a policy is never asked about it, so it can never grant anything.
- **Separates fact from policy.** A fact says what the provider reported. A policy (your function) says what to do. The kit ships no default that grants or revokes.
- **Durable inbox** (SQLite file): `receive()` inserts a `pending` row and tells you which HTTP status to answer. `processDue()` applies pending rows later, so a crash between the two loses nothing.
- **Idempotency.** Key is the event id plus a SHA-256 of the full payload. Same id and same payload: acknowledged, no second effect. Same id, different payload: recorded as a conflict and the entity is flagged for reconciliation.
- **Ordering per payment** by the provider timestamp (`dateCreated`). Older than the applied state: no-op. Same timestamp: no causal order exists, so the policy decides, and it may answer `reconciliation_required`. No global provider priority is invented.
- **Atomic apply.** Inbox status, entity state and the effect record commit in one transaction. The policy runs inside it, so it must be synchronous and side-effect free. External calls belong to whoever consumes the effect records.
- **Retry.** A policy error leaves the event pending with backoff; after `maxAttempts` it is marked dead. One bad event does not block the others.
- **Reconciliation never acts alone.** Late or contradictory events end as no-ops or flag the entity. While flagged, new events are held. An incomplete reconciliation snapshot changes nothing and never revokes.
- **Conformance checks** you can run against your own policy.

## HTTP acknowledgement

`receive()` returns `{ ack, status }`:

| ack | status | meaning |
|---|---|---|
| 200 | `stored` | durable row inserted |
| 200 | `duplicate` | already known, same payload |
| 200 | `conflict` | same id, different payload; recorded, entity flagged |
| 400 | `invalid` | envelope invalid; nothing stored |
| 503 | `storage_error` | could not persist; do not acknowledge with 200 |

Asaas's documentation says only an HTTP 200 counts as a successful delivery and that repeated failures can pause the webhook queue. Because of that, an unrecoverable 400 is a trade-off for you to weigh (see below). Read the provider docs: [Introduction to webhooks](https://docs.asaas.com/docs/sobre-os-webhooks), [Delivery types](https://docs.asaas.com/docs/tipos-de-envio), [Paused queue](https://docs.asaas.com/docs/fila-pausada). These pages were read in this project's research notes on 2026-11-06; this package did not re-fetch them, and it states no prices, deadlines or retry intervals.

Subscribe only to events you handle. Events without `payment.id` that the kit knows as payment events are rejected with 400; events it does not know are acknowledged and ignored.

## Usage

```js
import { openInbox, createEntitlementPolicy } from "asaas-webhook-kit";

// YOUR decision. This mapping is an example, not a recommendation.
const policy = createEntitlementPolicy({
  onFact: { payment_confirmed: "grant", payment_refunded: "revoke" },
  tiePriority: undefined, // none: same-second conflicts go to reconciliation
});

const inbox = openInbox({ path: "./webhooks.db", policy });

// In your HTTP handler, AFTER you authenticated the request:
const result = inbox.receive(rawBodyText);
response.status(result.ack).end();

// In a worker or timer:
inbox.processDue();
for (const effect of inbox.listEffects()) {
  await applyToYourSystem(effect); // use effect.effectKey as the idempotency key
  inbox.markEffectApplied(effect.effectKey);
}
```

A custom policy is `(fact, context) => ({ action, reason })`, with `action` one of `none`, `grant`, `revoke`, `reconciliation_required`. `context.ordering` is `first`, `newer` or `tie`; `context.previous` is the last applied fact. See `src/core.d.mts`.

Import from `asaas-webhook-kit/core` for the pure parts only (no SQLite).

## CLI

```
node bin/asaas-webhook-kit.mjs demo                       # synthetic scenario, temp SQLite file
node bin/asaas-webhook-kit.mjs conformance [--policy ./policy.mjs]
node bin/asaas-webhook-kit.mjs validate event.json        # or: ... validate - < event.json
```

Exit codes: `0` ok, `1` conformance failed, `2` usage error or invalid input. The demo uses a DEMO-ONLY policy. Nothing touches the network.

Clone https://github.com/PedroLLou/asaas-webhook-kit and run these commands from its directory. The npm package is unpublished; do not use
`npx` to fetch this provisional name from the registry. For a local consumer,
create a tarball with `npm pack --ignore-scripts` and install that local tarball
with `npm install --offline --ignore-scripts ./path/to/the-tarball.tgz`.

Reconciliation rejects observation timestamps older than the last applied fact
or later than the configured clock. It never upgrades a stale observation to a
newer timestamp. The caller remains responsible for snapshot identity and truth.
Stored event/payment/subscription identifiers may themselves be sensitive; this
package minimizes payload storage, it does not anonymize billing data.

## What it does not do

- No HTTP server and no authentication. Verify the request (Asaas lets you configure an access token header) **before** calling `receive()`, and compare it in constant time.
- No network calls, no Asaas API client, no reconciliation fetching. You fetch the provider state and pass a snapshot.
- No subscriptions, checkouts or non-payment events yet; they are ignored.
- No entitlement logic of its own, no email, no notifications.
- No multi-writer guarantees beyond SQLite's own locking; one inbox file per deployment.
- No Next.js or Prisma integration.
- Not proven in production, and no product is claimed to consume it today.

## Retention

`purgeProcessed({ olderThan })` forgets event ids. After that, a redelivery of the same event looks new. Keep rows longer than the provider can redeliver; the default minimum is 30 days.

## Development

```
npm test               # node --test, no network
npm run demo
npm run conformance
npm run pack:dry       # what would be packaged
npm run typecheck      # needs a TypeScript install of your own (not a dependency)
```

See [SECURITY.md](SECURITY.md) and [PROVENANCE.md](PROVENANCE.md). License: MIT, for the code in this package only.
