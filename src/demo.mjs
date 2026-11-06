// Demo scenario with a DEMO-ONLY policy. The policy below is an example of a
// configuration, not a recommendation: decide your own mapping.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openInbox } from "./inbox.mjs";
import { createEntitlementPolicy } from "./policy.mjs";
import { syntheticEvent } from "./synthetic.mjs";

export const demoPolicy = createEntitlementPolicy({
  onFact: { payment_confirmed: "grant", payment_refunded: "revoke" },
});

export function runDemo() {
  const dir = mkdtempSync(join(tmpdir(), "awk-demo-"));
  const path = join(dir, "inbox.db");
  const steps = [];
  const step = (title, detail) => steps.push({ title, ...detail });
  try {
    let clock = Date.parse("2026-01-15T13:00:00Z");
    let flakyOnce = true;
    const policy = (fact, context) => {
      if (fact.paymentId === "pay_demo_retry" && flakyOnce) {
        flakyOnce = false;
        throw new Error("synthetic transient failure");
      }
      return demoPolicy(fact, context);
    };
    const open = () => openInbox({ path, policy, now: () => clock, retryDelayMs: () => 1000 });
    let inbox = open();

    const confirmed = syntheticEvent({ id: "evt_demo_1", paymentId: "pay_demo_a" });
    step("receive PAYMENT_CONFIRMED", { ack: inbox.receive(confirmed).ack, status: "stored" });
    const dup = inbox.receive(structuredClone(confirmed));
    step("same event redelivered", { ack: dup.ack, status: dup.status });
    const original = syntheticEvent({ id: "evt_demo_0", paymentId: "pay_demo_d" });
    inbox.receive(original);
    const conflict = inbox.receive({ ...original, event: "PAYMENT_REFUNDED" });
    step("same id, different content", { ack: conflict.ack, status: conflict.status });

    inbox.receive(syntheticEvent({ id: "evt_demo_2", paymentId: "pay_demo_b", dateCreated: "2026-01-15 10:10:00" }));
    inbox.receive(
      syntheticEvent({ id: "evt_demo_3", paymentId: "pay_demo_b", event: "PAYMENT_OVERDUE", dateCreated: "2026-01-15 10:05:00" }),
    );
    inbox.receive(syntheticEvent({ id: "evt_demo_4", paymentId: "pay_demo_c", dateCreated: "2026-01-15 10:00:00" }));
    inbox.receive(
      syntheticEvent({ id: "evt_demo_5", paymentId: "pay_demo_c", event: "PAYMENT_REFUNDED", dateCreated: "2026-01-15 10:00:00" }),
    );
    inbox.receive({ id: "evt_demo_6", event: "SOMETHING_NEW", dateCreated: "2026-01-15 10:00:00" });
    inbox.receive(syntheticEvent({ id: "evt_demo_7", paymentId: "pay_demo_retry" }));
    step("received more events, none processed yet", { pending: inbox.stats().pending });

    inbox.close();
    inbox = open();
    step("simulated crash: reopened the database file", {
      pendingAfterReopen: inbox.stats().pending,
      note: "pending rows were durable before any processing",
    });

    const first = inbox.processDue();
    for (const r of first.results) step(`processed ${r.eventId}`, { outcome: r.outcome, reason: r.reason ?? null, effectKey: r.effectKey ?? null });
    clock += 1000;
    for (const r of inbox.processDue().results) {
      step(`retried ${r.eventId}`, { outcome: r.outcome, reason: r.reason ?? null, effectKey: r.effectKey ?? null });
    }

    const summary = {
      effects: inbox.listEffects().map((e) => ({ effectKey: e.effectKey, action: e.action })),
      entitiesInReconciliation: ["pay_demo_a", "pay_demo_b", "pay_demo_c", "pay_demo_d"].filter(
        (id) => inbox.getEntity(id)?.reconciliationReason,
      ),
      stats: inbox.stats(),
    };
    inbox.close();
    return { steps, summary };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
