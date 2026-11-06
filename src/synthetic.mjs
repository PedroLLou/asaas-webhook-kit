// Builder for synthetic webhook bodies. Fake ids and values only; for demos,
// conformance runs and your own tests.

/**
 * @param {object} fields
 * @param {string} fields.id Event id.
 * @param {string} [fields.event]
 * @param {string} [fields.paymentId]
 * @param {string|null} [fields.dateCreated] `null` omits the field.
 * @param {object} [fields.extra] Extra top-level fields (merged last).
 */
export function syntheticEvent({
  id,
  event = "PAYMENT_CONFIRMED",
  paymentId = "pay_synthetic_001",
  dateCreated = "2026-01-15 10:00:00",
  extra = {},
}) {
  const body = {
    id,
    event,
    payment: { object: "payment", id: paymentId, status: "SYNTHETIC", value: 10 },
  };
  if (dateCreated !== null) body.dateCreated = dateCreated;
  return { ...body, ...extra };
}
