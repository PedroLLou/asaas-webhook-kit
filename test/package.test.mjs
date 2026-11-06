import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import * as core from "../src/core.mjs";
import * as full from "../src/index.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));

function npm(args) {
  const env = { ...process.env, npm_config_update_notifier: "false", npm_config_fund: "false", npm_config_audit: "false" };
  // npm_execpath is set when run through `npm test`; otherwise fall back to the platform shim.
  const execPath = process.env.npm_execpath;
  if (execPath && /npm-cli\.c?js$/.test(execPath)) {
    return spawnSync(process.execPath, [execPath, ...args], { cwd: ROOT, encoding: "utf8", env });
  }
  return spawnSync(process.platform === "win32" ? "npm.cmd" : "npm", args, {
    cwd: ROOT, encoding: "utf8", env, shell: process.platform === "win32",
  });
}

test("package.json guards publication and declares the contract", () => {
  assert.equal(pkg.private, true);
  assert.equal(pkg.type, "module");
  assert.equal(pkg.license, "MIT");
  assert.match(pkg.engines.node, /^>=22/);
  assert.deepEqual(pkg.dependencies ?? {}, {});
  assert.deepEqual(pkg.devDependencies ?? {}, {});
  assert.equal(pkg.scripts.test, "node --test");
  for (const target of [pkg.bin["asaas-webhook-kit"], pkg.exports["."].default, pkg.exports["."].types,
    pkg.exports["./core"].default, pkg.exports["./core"].types]) {
    assert.ok(existsSync(new URL(`../${target}`, import.meta.url)), `${target} exists`);
  }
});

test("every runtime export is declared in the type definitions, and vice versa", () => {
  const declared = (file) =>
    [...readFileSync(new URL(file, import.meta.url), "utf8").matchAll(/^export (?:declare )?(?:const|function) (\w+)/gm)].map(
      (m) => m[1],
    );
  assert.deepEqual(declared("../src/core.d.mts").sort(), Object.keys(core).sort());
  const fullDeclared = [...declared("../src/core.d.mts"), ...declared("../src/index.d.mts")].sort();
  assert.deepEqual(fullDeclared, Object.keys(full).sort());
});

test("the core entry point does not load node:sqlite", () => {
  const code = `
    import("${new URL("../src/core.mjs", import.meta.url).href}").then(() => {
      const loaded = process.moduleLoadList.some((m) => m.includes("sqlite"));
      process.exit(loaded ? 1 : 0);
    });`;
  const r = spawnSync(process.execPath, ["--input-type=module", "-e", code], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
});

test("npm pack --dry-run ships the library, bin, types and docs, and nothing else", () => {
  const r = npm(["pack", "--dry-run", "--json", "--ignore-scripts"]);
  assert.equal(r.status, 0, r.stderr);
  const [report] = JSON.parse(r.stdout);
  const files = report.files.map((f) => f.path.replaceAll("\\", "/")).sort();
  for (const required of [
    "package.json", "LICENSE", "README.md", "README.pt-BR.md", "PROVENANCE.md", "SECURITY.md",
    "bin/asaas-webhook-kit.mjs", "src/index.mjs", "src/core.mjs", "src/inbox.mjs", "src/index.d.mts", "src/core.d.mts",
  ]) {
    assert.ok(files.includes(required), `missing ${required}`);
  }
  for (const f of files) {
    assert.ok(
      /^(package\.json|LICENSE|README(\.pt-BR)?\.md|PROVENANCE\.md|SECURITY\.md|bin\/.+|src\/.+)$/.test(f),
      `unexpected file in package: ${f}`,
    );
  }
});
