// Provider-fact normalization. Pure: no I/O, no policy.
//
// A "provider fact" says what the provider reported, nothing about what a
// product should do about it. Anything not listed here normalizes to
// `unknown`, and the inbox never hands `unknown` facts to a policy.

const KIND_BY_EVENT = Object.freeze({
  PAYMENT_CONFIRMED: "payment_confirmed",
  PAYMENT_RECEIVED: "payment_received",
  PAYMENT_OVERDUE: "payment_overdue",
  PAYMENT_REFUNDED: "payment_refunded",
});

/** Fact kinds a policy can be asked about (excludes `unknown`). */
export const PROVIDER_FACT_KINDS = Object.freeze(Object.values(KIND_BY_EVENT));

export function isKnownPaymentEvent(eventName) {
  return typeof eventName === "string" && Object.hasOwn(KIND_BY_EVENT, eventName);
}

const TIMESTAMP =
  /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?(Z|[+-]\d{2}:?\d{2})?$/;

/**
 * Parses a provider timestamp into epoch milliseconds, or returns null.
 * Strings with an explicit `Z` or offset are absolute. Strings without one
 * ("YYYY-MM-DD HH:mm:ss") are read at `offsetMinutes` from UTC. The offset only
 * matters when comparing against absolute times; ordering between two
 * timestamps in the same format is unaffected by it.
 */
export function parseProviderTimestamp(value, offsetMinutes = -180) {
  if (typeof value !== "string") return null;
  const m = TIMESTAMP.exec(value.trim());
  if (!m) return null;
  const [year, month, day, hour, minute, second] = m.slice(1, 7).map(Number);
  const millis = m[7] ? Number(m[7].padEnd(3, "0")) : 0;
  if (month < 1 || month > 12 || hour > 23 || minute > 59 || second > 59) return null;
  const base = Date.UTC(year, month - 1, day, hour, minute, second, millis);
  const check = new Date(base);
  if (check.getUTCFullYear() !== year || check.getUTCMonth() !== month - 1 || check.getUTCDate() !== day) {
    return null; // e.g. 2026-02-30
  }
  let offset = offsetMinutes;
  if (m[8] === "Z") offset = 0;
  else if (m[8]) {
    const sign = m[8][0] === "-" ? -1 : 1;
    const digits = m[8].slice(1).replace(":", "");
    const oh = Number(digits.slice(0, 2));
    const om = Number(digits.slice(2, 4));
    if (oh > 23 || om > 59) return null;
    offset = sign * (oh * 60 + om);
  }
  return base - offset * 60_000;
}

/**
 * Normalizes a parsed envelope (see `parseEnvelope`) into a provider fact.
 * `timestampIssue` is `null`, `"missing"` or `"invalid"`; a fact with an issue
 * cannot be ordered and is never applied automatically.
 */
export function normalizeEvent(envelope, options = {}) {
  const offset = options.timestampOffsetMinutes ?? -180;
  const kind = isKnownPaymentEvent(envelope.event) ? KIND_BY_EVENT[envelope.event] : "unknown";
  let timestampMs = null;
  let timestampIssue = null;
  if (envelope.dateCreatedMalformed) {
    timestampIssue = "invalid";
  } else if (envelope.dateCreated === null || envelope.dateCreated === "") {
    timestampIssue = "missing";
  } else {
    timestampMs = parseProviderTimestamp(envelope.dateCreated, offset);
    if (timestampMs === null) timestampIssue = "invalid";
  }
  return {
    eventId: envelope.eventId,
    providerEvent: envelope.event,
    kind,
    paymentId: kind === "unknown" ? null : envelope.paymentId,
    subscriptionId: kind === "unknown" ? null : envelope.subscriptionId,
    timestampMs,
    timestampIssue,
  };
}
