import type { Policy, PolicyAction, ProviderFactKind, TimestampIssue, ValidationError } from "./core.mjs";

export * from "./core.mjs";

export interface InboxOptions {
  /** SQLite file path, or ":memory:". */
  path: string;
  /** Default: neutral policy (records facts, never grants or revokes). */
  policy?: Policy;
  /** Clock in epoch ms. Default: Date.now. */
  now?: () => number;
  /** Failures before an event is marked dead. Default 8. */
  maxAttempts?: number;
  /** Delay after the nth failure. Default: exponential from 1 s, capped at 1 h. */
  retryDelayMs?: (attempt: number) => number;
  /** `purgeProcessed` refuses cutoffs newer than now minus this. Default 30 days. */
  minRetentionMs?: number;
  /** Offset assumed for timestamps without a zone. Default -180. */
  timestampOffsetMinutes?: number;
}

export type ReceiveResult =
  | { ack: 200; status: "stored" | "duplicate" | "conflict"; eventId: string }
  | { ack: 400; status: "invalid"; errors: ValidationError[] }
  | { ack: 503; status: "storage_error"; error: string };

export type ProcessOutcome =
  | "applied"
  | "recorded"
  | "noop"
  | "stale_noop"
  | "ignored_unknown"
  | "reconciliation_required"
  | "held"
  | "skipped"
  | "retry_scheduled"
  | "dead"
  | "failure_unrecorded";

export interface ProcessResult {
  eventId: string;
  outcome: ProcessOutcome;
  reason?: string | null;
  effectKey?: string | null;
  attempts?: number;
  nextAttemptAt?: number;
  error?: string;
}

export interface EventRecord {
  eventId: string;
  providerEvent: string;
  kind: ProviderFactKind;
  entityId: string | null;
  timestampMs: number | null;
  timestampIssue: TimestampIssue | null;
  status: "pending" | "processed" | "dead";
  attempts: number;
  nextAttemptAt: number;
  lastError: string | null;
  outcome: string | null;
  outcomeReason: string | null;
  receivedAt: number;
  processedAt: number | null;
}

export interface EntityRecord {
  entityId: string;
  lastEventId: string | null;
  lastKind: ProviderFactKind | null;
  lastTimestampMs: number | null;
  version: number;
  reconciliationReason: string | null;
  updatedAt: number;
}

export interface EffectRecord {
  effectKey: string;
  eventId: string;
  entityId: string;
  action: Exclude<PolicyAction, "none" | "reconciliation_required">;
  reason: string | null;
  createdAt: number;
  appliedAt: number | null;
}

export interface ReconciliationSnapshot {
  /** Must be exactly `true`. Pages cut short or failed lookups are incomplete. */
  complete: boolean;
  kind: Exclude<ProviderFactKind, "unknown">;
  observedAt: Date | number;
}

export interface ReconciliationResult {
  resolved: boolean;
  reason: string | null;
  outcome?: string;
  effectKey: string | null;
}

export interface Inbox {
  receive(input: unknown): ReceiveResult;
  processDue(options?: { limit?: number }): { results: ProcessResult[]; counts: Record<string, number> };
  resolveReconciliation(entityId: string, snapshot: ReconciliationSnapshot): ReconciliationResult;
  getEvent(eventId: string): EventRecord | null;
  getEntity(entityId: string): EntityRecord | null;
  listEffects(options?: { pendingOnly?: boolean; limit?: number }): EffectRecord[];
  markEffectApplied(effectKey: string): boolean;
  listConflicts(): { eventId: string; storedHash: string; incomingHash: string; receivedAt: number }[];
  stats(): {
    pending: number;
    processed: number;
    dead: number;
    pendingEffects: number;
    entitiesInReconciliation: number;
    conflicts: number;
  };
  purgeProcessed(options: { olderThan: Date | number }): { deleted: number };
  close(): void;
}

export function openInbox(options: InboxOptions): Inbox;

export interface ConformanceReport {
  passed: boolean;
  results: { name: string; ok: boolean; error?: string }[];
}

export function runConformance(options: { policy: Policy }): ConformanceReport;
