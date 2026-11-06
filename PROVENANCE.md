# Provenance

## What this is

A new implementation, written on 2026-11-06 for this package. It is based on the **observed behavior** of a private billing-webhook integration (what it accepts, how it deduplicates, how it orders events, which situations it refuses to act on automatically). No source code was copied from that integration or from any upstream project, and no code was adapted line by line. Names, data model, SQL, tests and API are original to this package.

Copyright for the new code in this package belongs to Pedro Lourenconi Lima (2026), released under the MIT License. The license covers this package's code only. It does not cover, and implies no rights to, the private integration, its product, its data or its policies.

## Behaviors observed, then re-expressed

- Registering the event durably before processing, keyed by the provider's event id, with duplicates detected by a uniqueness constraint.
- Acknowledging with success only once the event is recorded, and signalling failure when it could not be recorded.
- A pure mapping from event name to effect, where an unknown event is ignored.
- Ordering by provider timestamp, with equal timestamps not treated as stale.
- Refusing to grant access from an incomplete listing, and refusing to guess when evidence is missing.
- Keeping notification and other side effects out of the database transaction.
- Not sending payloads to error reporting because they contain personal data.

## Deliberately NOT carried over

- Any product policy: which event grants access, whether non-payment cancels immediately, plan or tier logic. Here the policy is a parameter and the kit has no default that grants or revokes.
- Same-timestamp priority rules. Here the policy decides or the entity is flagged; there is no built-in ranking.
- Network lookups, framework or ORM code, notifications, email, per-user locking, checkout and subscription handling.
- Any secret, token, environment value, database content, customer data or production data. All fixtures in this package are synthetic.

## Provider documentation

The Asaas documentation pages linked from the README (webhook introduction, delivery types, paused queue) were read in this project's research notes dated 2026-11-06. The package's authors did not re-fetch them while implementing. The kit does not encode prices, deadlines, retry intervals or limits taken from them. The facts it relies on are: delivery may repeat; the event `id` identifies an event; only an HTTP 200 is a successful delivery; ordering is not guaranteed in non-sequential mode.

## Local sources

Two modules of the private integration (an event-to-effect mapping and a webhook processor) and a set of internal research notes, all private and not distributed with this package. No upstream repository is vendored or forked. Third-party Asaas SDKs were looked at in research only to confirm that they do not cover this scope; nothing from them is used.
