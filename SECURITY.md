# Security notes

This is an early, publicly available source project. It has not been released on npm. These are its real limits.

## Out of scope: authentication

The kit has no HTTP layer. **Authenticate the webhook request before calling `receive()`.** Asaas lets you configure an access token that it sends in a header; compare it in constant time and refuse requests when your secret is not configured. `receive()` assumes its input already comes from the provider. Anyone who can call it can create events, including `grant` effects if your policy maps a fact to `grant`.

## What is stored

Only an allow-list: event id, event name, payment id, subscription id, the event timestamp, processing status and outcome, and a SHA-256 of the full payload. The payload body is never stored, so customer data in it (email, tax id, and so on) does not reach the database. The hash exists only to detect "same id, different content"; it is not a secret and is not reversible in practice for payloads with unguessable ids, but treat the database file as sensitive anyway because ids can be personal data in your context.

Error handling keeps only the error **name** (and `code` if present), never the message, because messages can embed payload data. Validation errors carry field paths, never values. The library and CLI do not log payloads. Your own policy and handler code are responsible for not logging them.

## Trust boundaries and known limits

- **The policy is trusted code.** It runs in-process, inside a database transaction. A policy that blocks, throws forever, or is asynchronous is treated as a failure (promises are rejected as `policy_returned_promise`). `conformance --policy <module>` imports and executes that module: only point it at code you trust.
- **Timestamps come from the sender.** Ordering uses `dateCreated`. A sender that can forge it can influence ordering, which is another reason authentication comes first. Timestamps without a zone are read at a configurable UTC offset (default -03:00); that only matters when mixing zoned and unzoned values.
- **Same-timestamp events have no causal order.** The kit does not guess; it asks the policy and, by default, flags the entity. Timestamps have second resolution, so ties are normal, not exceptional.
- **A conflict is acknowledged with 200.** This keeps the provider's queue moving; the anomaly is recorded (`listConflicts`) and the entity flagged. You must monitor flagged entities. Nothing alerts on its own.
- **Flagged entities are frozen.** While flagged, new events for that entity are held and produce no effect, in either direction. An operator clears the flag with a complete provider snapshot via `resolveReconciliation`. Events held meanwhile are not replayed; the snapshot is the new baseline.
- **400 responses count as failures to the provider.** Rejecting a malformed body means the provider may retry it and repeated failures can pause its queue (see its documentation). Subscribe only to events you handle.
- **Retention deletes dedupe memory.** `purgeProcessed` forgets event ids; a later redelivery would look new. Keep rows longer than the provider can redeliver. Dead rows and effect records are never purged automatically.
- **SQLite concurrency.** WAL mode, `synchronous=FULL` and `BEGIN IMMEDIATE` give crash safety and writer exclusion across processes on one machine. Network file systems are not supported. There is no replication.
- **`node:sqlite` is marked experimental by Node.** Its API may change across Node versions; CI covers Node 22 and 24 only.
- **Effects are at-least-once.** The kit records decisions durably and idempotently keyed; applying them downstream, and acknowledging with `markEffectApplied`, is yours. A crash between the two repeats the effect: make it idempotent using `effectKey`.
- No fuzzing, no third-party audit, no production use so far.

## Reporting

Report security issues privately through GitHub: https://github.com/PedroLLou/asaas-webhook-kit/security/advisories/new. Do not post credentials or payment payloads in a public issue.
