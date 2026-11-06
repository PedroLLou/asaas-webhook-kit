// Type-level usage check. Not executed by `npm test`; run `npm run typecheck`
// with any TypeScript install (TypeScript is intentionally not a dependency).
import {
  createEntitlementPolicy,
  openInbox,
  parseEnvelope,
  syntheticEvent,
  type Inbox,
  type Policy,
  type ReceiveResult,
} from "asaas-webhook-kit";
import { neutralPolicy, type ProviderFact } from "asaas-webhook-kit/core";

const policy: Policy = createEntitlementPolicy({
  onFact: { payment_confirmed: "grant" },
  tiePriority: ["payment_refunded", "payment_confirmed"],
});

const custom: Policy = (fact: Readonly<ProviderFact>, context) => {
  if (context.ordering === "tie") return { action: "reconciliation_required", reason: "tie" };
  return fact.kind === "payment_confirmed" ? { action: "grant" } : neutralPolicy();
};

const inbox: Inbox = openInbox({ path: ":memory:", policy: custom });
const result: ReceiveResult = inbox.receive(syntheticEvent({ id: "evt_1" }));
if (result.ack === 503) {
  const label: string = result.error;
  void label;
}
const parsed = parseEnvelope({});
if (!parsed.ok) {
  const first: string | undefined = parsed.errors[0]?.code;
  void first;
}
void policy;
inbox.close();

// @ts-expect-error "unknown" cannot be mapped by a policy
createEntitlementPolicy({ onFact: { unknown: "grant" } });
