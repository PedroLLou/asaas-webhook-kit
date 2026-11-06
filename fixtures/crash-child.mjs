// Test helper: a process that dies without closing the database.
// usage: node crash-child.mjs <dbPath> <after-receive|during-processing>
import { openInbox, syntheticEvent } from "../src/index.mjs";

const [dbPath, mode] = process.argv.slice(2);

const policy = (fact) => {
  if (mode === "during-processing") process.exit(9); // dies inside the open transaction
  return { action: "grant", reason: "child" };
};

const inbox = openInbox({ path: dbPath, policy });
const result = inbox.receive(syntheticEvent({ id: "evt_crash", paymentId: "pay_crash" }));
if (result.ack !== 200) process.exit(3);
if (mode === "after-receive") process.exit(7);
inbox.processDue();
process.exit(4); // unreachable when the policy kills the process
