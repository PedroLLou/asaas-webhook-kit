// Durable inbox on node:sqlite (SQLite built into Node, no dependency).
//
// Two phases, as the provider's docs recommend:
//   receive()     validates and durably inserts a `pending` row, then reports
//                 which HTTP status to answer. 200 only after the insert.
//   processDue()  applies pending rows. Inbox status, entity state and the
//                 effect record change in ONE transaction, and the policy runs
//                 inside it, so it must be synchronous and side-effect free.
//
// Only an allow-list of fields is stored (ids, event name, timestamp), plus a
// SHA-256 of the full payload for collision detection. The payload itself is
// never stored or logged.
import { DatabaseSync } from "node:sqlite";
import { parseEnvelope } from "./envelope.mjs";
import { PROVIDER_FACT_KINDS, normalizeEvent } from "./events.mjs";
import { POLICY_ACTIONS, neutralPolicy } from "./policy.mjs";

const SCHEMA_VERSION = 1;
const DEFAULT_MIN_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/g;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS inbox (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id TEXT NOT NULL UNIQUE,
  payload_hash TEXT NOT NULL,
  provider_event TEXT NOT NULL,
  kind TEXT NOT NULL,
  entity_id TEXT,
  subscription_id TEXT,
  event_ts INTEGER,
  ts_issue TEXT,
  status TEXT NOT NULL CHECK (status IN ('pending','processed','dead')),
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at INTEGER NOT NULL,
  last_error TEXT,
  outcome TEXT,
  outcome_reason TEXT,
  received_at INTEGER NOT NULL,
  processed_at INTEGER
);
CREATE INDEX IF NOT EXISTS inbox_due ON inbox (status, next_attempt_at, seq);
CREATE TABLE IF NOT EXISTS entity_state (
  entity_id TEXT PRIMARY KEY,
  last_event_id TEXT,
  last_kind TEXT,
  last_ts INTEGER,
  version INTEGER NOT NULL,
  reconciliation_reason TEXT,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS effects (
  effect_key TEXT PRIMARY KEY,
  event_id TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  action TEXT NOT NULL,
  reason TEXT,
  created_at INTEGER NOT NULL,
  applied_at INTEGER
);
CREATE TABLE IF NOT EXISTS conflicts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id TEXT NOT NULL,
  stored_hash TEXT NOT NULL,
  incoming_hash TEXT NOT NULL,
  received_at INTEGER NOT NULL,
  UNIQUE (event_id, incoming_hash)
);
`;

class PolicyError extends Error {
  constructor(code) {
    super(code);
    this.name = "PolicyError";
    this.code = code;
  }
}

function errorLabel(err) {
  const name = typeof err?.name === "string" ? err.name : "Error";
  const code = typeof err?.code === "string" ? `:${err.code}` : "";
  return `${name}${code}`.replace(CONTROL, "").slice(0, 80);
}

function cleanReason(reason) {
  return typeof reason === "string" ? reason.replace(CONTROL, "").slice(0, 120) : null;
}

function toMs(value, label) {
  const ms = value instanceof Date ? value.getTime() : value;
  if (typeof ms !== "number" || !Number.isFinite(ms)) throw new TypeError(`${label} must be a Date or epoch ms`);
  return ms;
}

function defaultRetryDelay(attempt) {
  return Math.min(60 * 60 * 1000, 1000 * 2 ** (attempt - 1));
}

function entityView(row) {
  if (!row) return null;
  return {
    entityId: row.entity_id,
    lastEventId: row.last_event_id,
    lastKind: row.last_kind,
    lastTimestampMs: row.last_ts,
    version: row.version,
    reconciliationReason: row.reconciliation_reason,
    updatedAt: row.updated_at,
  };
}

function eventView(row) {
  if (!row) return null;
  return {
    eventId: row.event_id,
    providerEvent: row.provider_event,
    kind: row.kind,
    entityId: row.entity_id,
    timestampMs: row.event_ts,
    timestampIssue: row.ts_issue,
    status: row.status,
    attempts: row.attempts,
    nextAttemptAt: row.next_attempt_at,
    lastError: row.last_error,
    outcome: row.outcome,
    outcomeReason: row.outcome_reason,
    receivedAt: row.received_at,
    processedAt: row.processed_at,
  };
}

/**
 * Opens (creating if needed) an inbox. `path` is a SQLite file or ":memory:".
 */
export function openInbox(options) {
  const {
    path,
    policy = neutralPolicy,
    now = Date.now,
    maxAttempts = 8,
    retryDelayMs = defaultRetryDelay,
    minRetentionMs = DEFAULT_MIN_RETENTION_MS,
    timestampOffsetMinutes = -180,
  } = options ?? {};
  if (typeof path !== "string" || path.length === 0) throw new TypeError("openInbox: path is required");
  if (typeof policy !== "function") throw new TypeError("openInbox: policy must be a function");
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1) throw new RangeError("maxAttempts must be >= 1");
  if (!Number.isFinite(minRetentionMs) || minRetentionMs < 0) {
    throw new RangeError("minRetentionMs must be a finite non-negative duration");
  }
  if (!Number.isInteger(timestampOffsetMinutes) || Math.abs(timestampOffsetMinutes) > 14 * 60) {
    throw new RangeError("timestampOffsetMinutes must be an integer between -840 and 840");
  }
  if (typeof now !== "function" || typeof retryDelayMs !== "function") {
    throw new TypeError("now and retryDelayMs must be functions");
  }

  const db = new DatabaseSync(path);
  db.exec("PRAGMA busy_timeout = 5000");
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA synchronous = FULL");
  const version = db.prepare("PRAGMA user_version").get().user_version;
  if (version > SCHEMA_VERSION) {
    db.close();
    throw new Error("inbox database was written by a newer version of this package");
  }
  db.exec(SCHEMA);
  db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);

  const q = {
    existing: db.prepare("SELECT event_id, payload_hash, entity_id FROM inbox WHERE event_id = ?"),
    insert: db.prepare(
      `INSERT INTO inbox (event_id, payload_hash, provider_event, kind, entity_id, subscription_id,
         event_ts, ts_issue, status, attempts, next_attempt_at, received_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', 0, ?, ?)`,
    ),
    insertConflict: db.prepare(
      "INSERT OR IGNORE INTO conflicts (event_id, stored_hash, incoming_hash, received_at) VALUES (?, ?, ?, ?)",
    ),
    row: db.prepare("SELECT * FROM inbox WHERE event_id = ?"),
    due: db.prepare(
      "SELECT event_id FROM inbox WHERE status = 'pending' AND next_attempt_at <= ? ORDER BY seq LIMIT ?",
    ),
    entity: db.prepare("SELECT * FROM entity_state WHERE entity_id = ?"),
    upsertState: db.prepare(
      `INSERT INTO entity_state (entity_id, last_event_id, last_kind, last_ts, version, updated_at)
       VALUES (?, ?, ?, ?, 1, ?)
       ON CONFLICT (entity_id) DO UPDATE SET last_event_id = excluded.last_event_id,
         last_kind = excluded.last_kind, last_ts = excluded.last_ts,
         version = version + 1, updated_at = excluded.updated_at`,
    ),
    flag: db.prepare(
      `INSERT INTO entity_state (entity_id, version, reconciliation_reason, updated_at)
       VALUES (?, 1, ?, ?)
       ON CONFLICT (entity_id) DO UPDATE SET
         reconciliation_reason = COALESCE(entity_state.reconciliation_reason, excluded.reconciliation_reason),
         version = entity_state.version + 1, updated_at = excluded.updated_at`,
    ),
    clearFlag: db.prepare(
      "UPDATE entity_state SET reconciliation_reason = NULL, version = version + 1, updated_at = ? WHERE entity_id = ?",
    ),
    insertEffect: db.prepare(
      `INSERT OR IGNORE INTO effects (effect_key, event_id, entity_id, action, reason, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ),
    done: db.prepare(
      `UPDATE inbox SET status = 'processed', outcome = ?, outcome_reason = ?, processed_at = ?, last_error = NULL
       WHERE event_id = ? AND status = 'pending'`,
    ),
    fail: db.prepare(
      "UPDATE inbox SET status = ?, attempts = ?, next_attempt_at = ?, last_error = ? WHERE event_id = ? AND status = 'pending'",
    ),
  };

  function tx(fn) {
    db.exec("BEGIN IMMEDIATE");
    try {
      const result = fn();
      db.exec("COMMIT");
      return result;
    } catch (err) {
      try {
        db.exec("ROLLBACK");
      } catch {
        // already rolled back
      }
      throw err;
    }
  }

  function runPolicy(fact, context) {
    const frozenFact = Object.freeze({ ...fact });
    const frozenContext = Object.freeze({
      ...context,
      previous: context.previous ? Object.freeze({ ...context.previous }) : null,
    });
    const out = policy(frozenFact, frozenContext);
    if (out && typeof out.then === "function") {
      Promise.resolve(out).catch(() => {});
      throw new PolicyError("policy_returned_promise");
    }
    if (typeof out !== "object" || out === null || !POLICY_ACTIONS.includes(out.action)) {
      throw new PolicyError("policy_invalid_decision");
    }
    return { action: out.action, reason: cleanReason(out.reason) };
  }

  /** Shared by processing and reconciliation. Returns the outcome record. */
  function applyDecision({ fact, ordering, previous, decision, effectKey, t }) {
    const entityId = fact.paymentId;
    if (decision.action === "reconciliation_required") {
      q.flag.run(entityId, `policy:${decision.reason ?? "reconciliation_required"}`.slice(0, 120), t);
      return { outcome: "reconciliation_required", reason: decision.reason, effectKey: null };
    }
    if (decision.action === "none") {
      if (ordering === "tie") return { outcome: "noop", reason: decision.reason, effectKey: null };
      q.upsertState.run(entityId, fact.eventId, fact.kind, fact.timestampMs, t);
      return { outcome: "recorded", reason: decision.reason, effectKey: null };
    }
    q.upsertState.run(entityId, fact.eventId, fact.kind, fact.timestampMs, t);
    q.insertEffect.run(effectKey, fact.eventId, entityId, decision.action, decision.reason, t);
    return { outcome: "applied", reason: decision.reason, effectKey };
  }

  function decide(row, t) {
    const fact = {
      eventId: row.event_id,
      providerEvent: row.provider_event,
      kind: row.kind,
      paymentId: row.entity_id,
      subscriptionId: row.subscription_id,
      timestampMs: row.event_ts,
      timestampIssue: row.ts_issue,
    };
    if (fact.kind === "unknown") return { outcome: "ignored_unknown", reason: null, effectKey: null };
    const state = q.entity.get(fact.paymentId);
    if (state?.reconciliation_reason) {
      return { outcome: "held", reason: "entity_in_reconciliation", effectKey: null };
    }
    if (fact.timestampIssue) {
      q.flag.run(fact.paymentId, `timestamp_${fact.timestampIssue}`, t);
      return { outcome: "reconciliation_required", reason: `timestamp_${fact.timestampIssue}`, effectKey: null };
    }
    const previous =
      state && state.last_ts !== null
        ? { eventId: state.last_event_id, kind: state.last_kind, timestampMs: state.last_ts }
        : null;
    let ordering = "first";
    if (previous) {
      if (fact.timestampMs > previous.timestampMs) ordering = "newer";
      else if (fact.timestampMs < previous.timestampMs) {
        return { outcome: "stale_noop", reason: "older_than_applied_state", effectKey: null };
      } else ordering = "tie";
    }
    const decision = runPolicy(fact, { ordering, previous, source: "webhook" });
    return applyDecision({
      fact,
      ordering,
      previous,
      decision,
      effectKey: JSON.stringify(["webhook", fact.paymentId, fact.eventId]),
      t,
    });
  }

  function recordFailure(eventId, err, t) {
    try {
      return tx(() => {
        const row = q.row.get(eventId);
        if (!row || row.status !== "pending") return { eventId, outcome: "skipped" };
        const attempts = row.attempts + 1;
        const dead = attempts >= maxAttempts;
        const nextAt = dead ? row.next_attempt_at : t + Math.max(0, retryDelayMs(attempts));
        q.fail.run(dead ? "dead" : "pending", attempts, nextAt, errorLabel(err), eventId);
        return {
          eventId,
          outcome: dead ? "dead" : "retry_scheduled",
          attempts,
          nextAttemptAt: nextAt,
          error: errorLabel(err),
        };
      });
    } catch (inner) {
      return { eventId, outcome: "failure_unrecorded", error: errorLabel(inner) };
    }
  }

  function processOne(eventId, t) {
    try {
      return tx(() => {
        const row = q.row.get(eventId);
        if (!row || row.status !== "pending") return { eventId, outcome: "skipped" };
        const result = decide(row, t);
        q.done.run(result.outcome, result.reason ?? null, t, eventId);
        return { eventId, outcome: result.outcome, reason: result.reason ?? null, effectKey: result.effectKey };
      });
    } catch (err) {
      return recordFailure(eventId, err, t);
    }
  }

  let closed = false;

  return {
    /**
     * Validates and durably records a webhook body (object, JSON text or bytes).
     * Authenticate the request BEFORE calling this. `ack` is the HTTP status to
     * answer with: 200 only once the row is durable (or is a known duplicate or
     * recorded conflict), 400 for an invalid envelope, 503 if storage failed.
     */
    receive(input) {
      let parsed;
      try {
        parsed = parseEnvelope(input);
      } catch {
        return { ack: 400, status: "invalid", errors: [{ path: "", code: "unreadable" }] };
      }
      if (!parsed.ok) return { ack: 400, status: "invalid", errors: parsed.errors };
      const envelope = parsed.value;
      const fact = normalizeEvent(envelope, { timestampOffsetMinutes });
      const t = now();
      try {
        return tx(() => {
          const existing = q.existing.get(fact.eventId);
          if (existing) {
            if (existing.payload_hash === envelope.payloadHash) {
              return { ack: 200, status: "duplicate", eventId: fact.eventId };
            }
            q.insertConflict.run(fact.eventId, existing.payload_hash, envelope.payloadHash, t);
            for (const entityId of new Set([existing.entity_id, fact.paymentId])) {
              if (entityId) q.flag.run(entityId, "event_id_conflict", t);
            }
            return { ack: 200, status: "conflict", eventId: fact.eventId };
          }
          q.insert.run(
            fact.eventId,
            envelope.payloadHash,
            fact.providerEvent,
            fact.kind,
            fact.paymentId,
            fact.subscriptionId,
            fact.timestampMs,
            fact.timestampIssue,
            t,
            t,
          );
          return { ack: 200, status: "stored", eventId: fact.eventId };
        });
      } catch (err) {
        return { ack: 503, status: "storage_error", error: errorLabel(err) };
      }
    },

    /** Applies due pending events, oldest first. One failing event never blocks the rest. */
    processDue({ limit = 100 } = {}) {
      const t = now();
      const ids = q.due.all(t, limit).map((r) => r.event_id);
      const results = ids.map((id) => processOne(id, t));
      const counts = {};
      for (const r of results) counts[r.outcome] = (counts[r.outcome] ?? 0) + 1;
      return { results, counts };
    },

    /**
     * Operator tool. Clears an entity's reconciliation flag from a snapshot the
     * caller fetched from the provider (this package does no network I/O).
     * An incomplete snapshot changes nothing and emits no effect.
     * A complete snapshot is run through the policy like any other fact.
     */
    resolveReconciliation(entityId, snapshot) {
      if (typeof entityId !== "string" || entityId.length === 0) throw new TypeError("entityId is required");
      return tx(() => {
        const state = q.entity.get(entityId);
        if (!state?.reconciliation_reason) return { resolved: false, reason: "not_flagged", effectKey: null };
        if (!snapshot || snapshot.complete !== true) {
          return { resolved: false, reason: "snapshot_incomplete", effectKey: null };
        }
        if (!PROVIDER_FACT_KINDS.includes(snapshot.kind)) {
          return { resolved: false, reason: "snapshot_kind_unsupported", effectKey: null };
        }
        const observed = toMs(snapshot.observedAt, "snapshot.observedAt");
        const t = now();
        const previous =
          state.last_ts !== null
            ? { eventId: state.last_event_id, kind: state.last_kind, timestampMs: state.last_ts }
            : null;
        if (previous && observed < previous.timestampMs) {
          return { resolved: false, reason: "snapshot_stale", effectKey: null };
        }
        if (observed > t) {
          return { resolved: false, reason: "snapshot_in_future", effectKey: null };
        }
        const key = JSON.stringify(["reconciliation", entityId, state.version]);
        const fact = {
          eventId: key,
          providerEvent: "RECONCILIATION_SNAPSHOT",
          kind: snapshot.kind,
          paymentId: entityId,
          subscriptionId: null,
          timestampMs: observed,
          timestampIssue: null,
        };
        const ordering = previous ? "newer" : "first";
        const decision = runPolicy(fact, { ordering, previous, source: "reconciliation" });
        if (decision.action === "reconciliation_required") {
          return { resolved: false, reason: "policy_requires_reconciliation", effectKey: null };
        }
        q.clearFlag.run(t, entityId);
        const applied = applyDecision({ fact, ordering, previous, decision, effectKey: key, t });
        return { resolved: true, reason: decision.reason, outcome: applied.outcome, effectKey: applied.effectKey };
      });
    },

    getEvent: (eventId) => eventView(q.row.get(eventId)),
    getEntity: (entityId) => entityView(q.entity.get(entityId)),

    /** Effect records: the durable, idempotently keyed decisions to apply downstream. */
    listEffects({ pendingOnly = true, limit = 100 } = {}) {
      const sql = `SELECT * FROM effects ${pendingOnly ? "WHERE applied_at IS NULL" : ""} ORDER BY created_at, rowid LIMIT ?`;
      return db
        .prepare(sql)
        .all(limit)
        .map((r) => ({
          effectKey: r.effect_key,
          eventId: r.event_id,
          entityId: r.entity_id,
          action: r.action,
          reason: r.reason,
          createdAt: r.created_at,
          appliedAt: r.applied_at,
        }));
    },
    markEffectApplied(effectKey) {
      const t = now();
      return db.prepare("UPDATE effects SET applied_at = ? WHERE effect_key = ? AND applied_at IS NULL").run(t, effectKey)
        .changes > 0;
    },

    listConflicts: () =>
      db
        .prepare("SELECT event_id, stored_hash, incoming_hash, received_at FROM conflicts ORDER BY id")
        .all()
        .map((r) => ({
          eventId: r.event_id,
          storedHash: r.stored_hash,
          incomingHash: r.incoming_hash,
          receivedAt: r.received_at,
        })),

    stats() {
      const count = (sql) => db.prepare(sql).get().n;
      return {
        pending: count("SELECT COUNT(*) AS n FROM inbox WHERE status = 'pending'"),
        processed: count("SELECT COUNT(*) AS n FROM inbox WHERE status = 'processed'"),
        dead: count("SELECT COUNT(*) AS n FROM inbox WHERE status = 'dead'"),
        pendingEffects: count("SELECT COUNT(*) AS n FROM effects WHERE applied_at IS NULL"),
        entitiesInReconciliation: count(
          "SELECT COUNT(*) AS n FROM entity_state WHERE reconciliation_reason IS NOT NULL",
        ),
        conflicts: count("SELECT COUNT(*) AS n FROM conflicts"),
      };
    },

    /**
     * Deletes processed inbox rows older than `olderThan`. Deleting a row
     * forgets its event id, so a later redelivery would be treated as new:
     * keep rows longer than the provider can redeliver. `olderThan` newer than
     * now - minRetentionMs throws. Dead rows and effects are never deleted.
     */
    purgeProcessed({ olderThan }) {
      const cutoff = toMs(olderThan, "olderThan");
      if (cutoff > now() - minRetentionMs) throw new RangeError("olderThan is inside the minimum retention window");
      const r = db
        .prepare(
          `DELETE FROM inbox WHERE status = 'processed' AND processed_at < ?
           AND NOT EXISTS (SELECT 1 FROM effects e WHERE e.event_id = inbox.event_id AND e.applied_at IS NULL)`,
        )
        .run(cutoff);
      return { deleted: Number(r.changes) };
    },

    close() {
      if (closed) return;
      closed = true;
      db.close();
    },
  };
}
