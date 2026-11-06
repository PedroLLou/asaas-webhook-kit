// Envelope validation. Pure. Never echoes payload values in errors.
import { createHash } from "node:crypto";
import { isKnownPaymentEvent } from "./events.mjs";

/** Largest body (bytes) `parseEnvelope` accepts when given text or bytes. */
export const MAX_BODY_BYTES = 256 * 1024;

const MAX_ID_LENGTH = 255;
const MAX_EVENT_LENGTH = 128;
const MAX_DATE_LENGTH = 64;
const MAX_DEPTH = 64;
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/;

function canonical(value, depth = 0) {
  if (depth > MAX_DEPTH) throw new RangeError("payload nested too deeply");
  if (value === null || typeof value !== "object") {
    const text = JSON.stringify(value);
    if (text === undefined) return "null";
    return text;
  }
  if (Array.isArray(value)) return `[${value.map((v) => canonical(v, depth + 1)).join(",")}]`;
  const keys = Object.keys(value).filter((k) => value[k] !== undefined).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonical(value[k], depth + 1)}`).join(",")}}`;
}

/** SHA-256 over a key-order-independent form of the full payload. */
export function hashPayload(value) {
  return createHash("sha256").update(canonical(value)).digest("hex");
}

function isObject(v) {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function cleanString(v, max) {
  return typeof v === "string" && v.length > 0 && v.length <= max && !CONTROL.test(v);
}

function toObject(input) {
  if (typeof input === "string" || input instanceof Uint8Array) {
    const bytes = typeof input === "string" ? Buffer.byteLength(input) : input.byteLength;
    if (bytes > MAX_BODY_BYTES) return { error: "body_too_large" };
    try {
      const text = typeof input === "string" ? input : new TextDecoder("utf-8", { fatal: true }).decode(input);
      return { value: JSON.parse(text) };
    } catch {
      return { error: "invalid_json" };
    }
  }
  return { value: input };
}

/**
 * Validates a webhook envelope: `id`, `event`, and, for the payment events this
 * kit understands, `payment.id`. Events it does not understand only need `id`
 * and `event`, so that the sender is acknowledged and they are recorded and
 * ignored rather than rejected.
 *
 * Returns `{ ok: true, value }` with an allow-listed envelope plus a payload
 * hash, or `{ ok: false, errors }` where each error is `{ path, code }`.
 */
export function parseEnvelope(input) {
  const read = toObject(input);
  if (read.error) return { ok: false, errors: [{ path: "", code: read.error }] };
  const body = read.value;
  if (!isObject(body)) return { ok: false, errors: [{ path: "", code: "not_an_object" }] };

  const errors = [];
  if (!cleanString(body.id, MAX_ID_LENGTH)) errors.push({ path: "id", code: "required_string" });
  if (!cleanString(body.event, MAX_EVENT_LENGTH)) errors.push({ path: "event", code: "required_string" });

  let paymentId = null;
  let subscriptionId = null;
  const payment = body.payment;
  const needsPayment = isKnownPaymentEvent(body.event);
  if (needsPayment) {
    if (!isObject(payment)) errors.push({ path: "payment", code: "required_object" });
    else if (!cleanString(payment.id, MAX_ID_LENGTH)) errors.push({ path: "payment.id", code: "required_string" });
    else paymentId = payment.id;
  }
  if (isObject(payment) && cleanString(payment.subscription, MAX_ID_LENGTH)) {
    subscriptionId = payment.subscription;
  }
  if (errors.length > 0) return { ok: false, errors };

  let dateCreated = null;
  let dateCreatedMalformed = false;
  if (body.dateCreated !== undefined && body.dateCreated !== null) {
    if (typeof body.dateCreated === "string" && body.dateCreated.length <= MAX_DATE_LENGTH) {
      dateCreated = body.dateCreated;
    } else {
      dateCreatedMalformed = true;
    }
  }

  let payloadHash;
  try {
    payloadHash = hashPayload(body);
  } catch {
    return { ok: false, errors: [{ path: "", code: "unserializable" }] };
  }
  return {
    ok: true,
    value: {
      eventId: body.id,
      event: body.event,
      paymentId,
      subscriptionId,
      dateCreated,
      dateCreatedMalformed,
      payloadHash,
    },
  };
}
