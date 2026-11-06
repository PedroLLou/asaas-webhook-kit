import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { syntheticEvent } from "../src/core.mjs";

const BIN = fileURLToPath(new URL("../bin/asaas-webhook-kit.mjs", import.meta.url));

function cli(args, input) {
  const r = spawnSync(process.execPath, [BIN, ...args], { encoding: "utf8", input });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

function tempDir(t) {
  const dir = mkdtempSync(join(tmpdir(), "awk-cli-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test("the bin file starts with a node shebang", () => {
  assert.match(readFileSync(BIN, "utf8"), /^#!\/usr\/bin\/env node\r?\n/);
});

test("--help and --version exit 0; no command is a usage error", () => {
  const help = cli(["--help"]);
  assert.equal(help.code, 0);
  assert.match(help.out, /demo/);
  assert.match(cli(["--version"]).out, /^\d+\.\d+\.\d+/);
  assert.equal(cli([]).code, 2);
});

test("unknown commands and options exit 2", () => {
  assert.equal(cli(["frobnicate"]).code, 2);
  assert.equal(cli(["demo", "--nope"]).code, 2);
  assert.equal(cli(["demo", "extra"]).code, 2);
  assert.equal(cli(["conformance", "--policy"]).code, 2);
});

test("demo exits 0 and shows the scenarios, as text and as JSON", () => {
  const text = cli(["demo"]);
  assert.equal(text.code, 0);
  assert.match(text.out, /duplicate/);
  assert.match(text.out, /conflict/);
  const json = cli(["demo", "--json"]);
  assert.equal(json.code, 0);
  const data = JSON.parse(json.out);
  const outcomes = Object.fromEntries(data.steps.filter((s) => s.outcome).map((s) => [s.title, s.outcome]));
  assert.equal(outcomes["processed evt_demo_3"], "stale_noop");
  assert.equal(outcomes["processed evt_demo_5"], "reconciliation_required");
  assert.equal(outcomes["processed evt_demo_6"], "ignored_unknown");
  assert.equal(outcomes["retried evt_demo_7"], "applied");
  assert.equal(data.summary.effects.every((e) => e.action === "grant"), true, "the demo never revokes");
  assert.equal(data.summary.stats.pending, 0);
});

test("conformance passes for the built-in policy and for a custom policy module", (t) => {
  assert.equal(cli(["conformance"]).code, 0);
  const dir = tempDir(t);
  const file = join(dir, "policy.mjs");
  writeFileSync(file, 'export default () => ({ action: "none", reason: "mine" });\n');
  const r = cli(["conformance", "--policy", file, "--json"]);
  assert.equal(r.code, 0);
  const report = JSON.parse(r.out);
  assert.equal(report.passed, true);
  assert.ok(report.results.length >= 8);
});

test("conformance exits 1 when a policy violates the contract", (t) => {
  const dir = tempDir(t);
  const file = join(dir, "bad-policy.mjs");
  // Returns a promise: the inbox must treat that as a failure, so checks that
  // expect a processed event fail.
  writeFileSync(file, 'export default async () => ({ action: "grant" });\n');
  const r = cli(["conformance", "--policy", file]);
  assert.equal(r.code, 1);
  assert.match(r.out, /FAIL/);
});

test("conformance exits 2 for a missing or invalid policy module", (t) => {
  const dir = tempDir(t);
  assert.equal(cli(["conformance", "--policy", join(dir, "missing.mjs")]).code, 2);
  const file = join(dir, "notfn.mjs");
  writeFileSync(file, "export default 42;\n");
  assert.equal(cli(["conformance", "--policy", file]).code, 2);
});

test("validate: a good body from a file prints the fact and exits 0", (t) => {
  const dir = tempDir(t);
  const file = join(dir, "event.json");
  writeFileSync(file, JSON.stringify(syntheticEvent({ id: "evt_v", event: "PAYMENT_OVERDUE" })));
  const r = cli(["validate", file]);
  assert.equal(r.code, 0);
  assert.match(r.out, /kind=payment_overdue/);
  const json = JSON.parse(cli(["validate", file, "--json"]).out);
  assert.equal(json.valid, true);
  assert.equal(json.fact.kind, "payment_overdue");
});

test("validate: stdin works, and invalid input exits 2 without echoing payload values", () => {
  const ok = cli(["validate", "-"], JSON.stringify(syntheticEvent({ id: "evt_s" })));
  assert.equal(ok.code, 0);
  const secret = "sentinel.person@example.test";
  const bad = cli(["validate", "-"], JSON.stringify({ event: "PAYMENT_CONFIRMED", customerEmail: secret }));
  assert.equal(bad.code, 2);
  assert.match(bad.err, /id/);
  assert.ok(!bad.out.includes(secret) && !bad.err.includes(secret));
  const badJson = cli(["validate", "-"], `{"customerEmail":"${secret}"`);
  assert.equal(badJson.code, 2);
  assert.ok(!badJson.out.includes(secret) && !badJson.err.includes(secret));
  const asJson = JSON.parse(cli(["validate", "--json"], "[]").out);
  assert.deepEqual(asJson, { valid: false, errors: [{ path: "", code: "not_an_object" }] });
});

test("validate: a missing file exits 2", (t) => {
  assert.equal(cli(["validate", join(tempDir(t), "nope.json")]).code, 2);
});
