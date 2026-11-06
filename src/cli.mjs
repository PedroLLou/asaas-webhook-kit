// CLI logic. Exit codes: 0 ok, 1 conformance failed, 2 usage error or invalid input.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { MAX_BODY_BYTES, parseEnvelope } from "./envelope.mjs";
import { normalizeEvent } from "./events.mjs";

const HELP = `asaas-webhook-kit <command> [options]

Commands:
  demo                      Run a synthetic scenario in a temporary SQLite file.
  conformance               Check inbox invariants against a policy.
  validate [file|-]         Validate one webhook body (file or stdin) and print
                            the normalized provider fact. Payload is not echoed.

Options:
  --json                    Machine-readable output.
  --policy <module>         conformance: ESM module whose default export is a
                            policy function. Default: built-in DEMO policy.
  -h, --help                Show this help.
  -v, --version             Show the version.

Exit codes: 0 ok, 1 conformance failed, 2 usage error or invalid input.
Nothing here touches the network or real services.
`;

async function readInput(source) {
  if (source && source !== "-") {
    const buf = readFileSync(source);
    return buf;
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES + 1) break;
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

// node:sqlite prints an ExperimentalWarning on some Node versions. Hide only that one.
async function loadSqliteModules() {
  const original = process.emitWarning;
  process.emitWarning = (warning, ...rest) => {
    const type = typeof rest[0] === "string" ? rest[0] : rest[0]?.type;
    if (type === "ExperimentalWarning" && String(warning).includes("SQLite")) return;
    return original.call(process, warning, ...rest);
  };
  try {
    const [conformance, demo] = await Promise.all([import("./conformance.mjs"), import("./demo.mjs")]);
    return { ...conformance, ...demo };
  } finally {
    process.emitWarning = original;
  }
}

export async function run(argv, io = {}) {
  const out = io.stdout ?? ((s) => process.stdout.write(s));
  const err = io.stderr ?? ((s) => process.stderr.write(s));
  const args = [...argv];
  const flags = { json: false, policy: null };
  const positional = [];
  while (args.length > 0) {
    const a = args.shift();
    if (a === "--json") flags.json = true;
    else if (a === "--policy") {
      flags.policy = args.shift() ?? null;
      if (!flags.policy) {
        err("--policy needs a module path\n");
        return 2;
      }
    } else if (a === "-h" || a === "--help") {
      out(HELP);
      return 0;
    } else if (a === "-v" || a === "--version") {
      const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
      out(`${pkg.version}\n`);
      return 0;
    } else if (a.startsWith("-") && a !== "-") {
      err(`unknown option: ${a}\n`);
      return 2;
    } else positional.push(a);
  }
  const [command, ...rest] = positional;
  if (!command) {
    err(HELP);
    return 2;
  }

  if (command === "validate") {
    if (rest.length > 1) {
      err("validate takes at most one file\n");
      return 2;
    }
    let body;
    try {
      body = await readInput(rest[0]);
    } catch (e) {
      err(`cannot read input (${e?.code ?? "error"})\n`);
      return 2;
    }
    const parsed = parseEnvelope(body);
    if (!parsed.ok) {
      if (flags.json) out(`${JSON.stringify({ valid: false, errors: parsed.errors })}\n`);
      else err(`invalid envelope: ${parsed.errors.map((x) => `${x.path || "(body)"} ${x.code}`).join(", ")}\n`);
      return 2;
    }
    const fact = normalizeEvent(parsed.value);
    if (flags.json) out(`${JSON.stringify({ valid: true, fact })}\n`);
    else {
      out(`valid: kind=${fact.kind} event=${fact.providerEvent} payment=${fact.paymentId ?? "-"} `);
      out(`timestampMs=${fact.timestampMs ?? "-"}${fact.timestampIssue ? ` (${fact.timestampIssue})` : ""}\n`);
    }
    return 0;
  }

  if (rest.length > 0 && command !== "validate") {
    err(`unexpected argument: ${rest[0]}\n`);
    return 2;
  }

  if (command === "demo") {
    const { runDemo } = await loadSqliteModules();
    const result = runDemo();
    if (flags.json) out(`${JSON.stringify(result, null, 2)}\n`);
    else {
      out("DEMO policy only (confirmed => grant, refunded => revoke). Synthetic data.\n\n");
      for (const s of result.steps) {
        const { title, ...detail } = s;
        out(`- ${title}: ${JSON.stringify(detail)}\n`);
      }
      out(`\nsummary: ${JSON.stringify(result.summary)}\n`);
    }
    return 0;
  }

  if (command === "conformance") {
    const { runConformance, demoPolicy } = await loadSqliteModules();
    let policy = demoPolicy;
    if (flags.policy) {
      try {
        const mod = await import(pathToFileURL(resolve(flags.policy)).href);
        policy = mod.default ?? mod.policy;
      } catch (e) {
        err(`cannot load policy module (${e?.code ?? e?.name ?? "error"})\n`);
        return 2;
      }
      if (typeof policy !== "function") {
        err("policy module must export a function as default (or named `policy`)\n");
        return 2;
      }
    }
    const report = runConformance({ policy });
    if (flags.json) out(`${JSON.stringify(report, null, 2)}\n`);
    else {
      for (const r of report.results) out(`${r.ok ? "PASS" : "FAIL"}  ${r.name}${r.error ? ` (${r.error})` : ""}\n`);
      out(`\n${report.passed ? "conformance passed" : "conformance FAILED"}\n`);
    }
    return report.passed ? 0 : 1;
  }

  err(`unknown command: ${command}\n`);
  return 2;
}
