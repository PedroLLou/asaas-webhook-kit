/** What the provider reported. Unlisted events are `unknown` and never reach a policy. */
export type ProviderFactKind =
  | "payment_confirmed"
  | "payment_received"
  | "payment_overdue"
  | "payment_refunded"
  | "unknown";

export type TimestampIssue = "missing" | "invalid";

export interface ValidationError {
  path: string;
  code: string;
}

export interface Envelope {
  eventId: string;
  event: string;
  paymentId: string | null;
  subscriptionId: string | null;
  dateCreated: string | null;
  dateCreatedMalformed: boolean;
  payloadHash: string;
}

export type ParseResult =
  | { ok: true; value: Envelope }
  | { ok: false; errors: ValidationError[] };

export interface ProviderFact {
  eventId: string;
  providerEvent: string;
  kind: ProviderFactKind;
  paymentId: string | null;
  subscriptionId: string | null;
  timestampMs: number | null;
  timestampIssue: TimestampIssue | null;
}

export const MAX_BODY_BYTES: number;
export const PROVIDER_FACT_KINDS: readonly Exclude<ProviderFactKind, "unknown">[];
export const POLICY_ACTIONS: readonly PolicyAction[];

export function parseEnvelope(input: unknown): ParseResult;
export function hashPayload(value: unknown): string;
export function isKnownPaymentEvent(eventName: unknown): boolean;
export function parseProviderTimestamp(value: unknown, offsetMinutes?: number): number | null;
export function normalizeEvent(
  envelope: Envelope,
  options?: { timestampOffsetMinutes?: number },
): ProviderFact;

export type PolicyAction = "none" | "grant" | "revoke" | "reconciliation_required";

export interface PolicyDecision {
  action: PolicyAction;
  reason?: string | null;
}

export interface PreviousFact {
  eventId: string;
  kind: ProviderFactKind;
  timestampMs: number;
}

export interface PolicyContext {
  /** `tie`: same timestamp as the last applied fact, so no causal order is known. */
  ordering: "first" | "newer" | "tie";
  previous: PreviousFact | null;
  source: "webhook" | "reconciliation";
}

/** Must be synchronous and free of side effects: it runs inside the database transaction. */
export type Policy = (fact: Readonly<ProviderFact>, context: Readonly<PolicyContext>) => PolicyDecision;

export function neutralPolicy(): PolicyDecision;
export function createEntitlementPolicy(options?: {
  onFact?: Partial<Record<Exclude<ProviderFactKind, "unknown">, PolicyAction>>;
  tiePriority?: Exclude<ProviderFactKind, "unknown">[];
}): Policy;

export function syntheticEvent(fields: {
  id: string;
  event?: string;
  paymentId?: string;
  dateCreated?: string | null;
  extra?: Record<string, unknown>;
}): Record<string, unknown>;
