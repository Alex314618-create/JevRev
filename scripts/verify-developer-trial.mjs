import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const base = "benchmarks/developer-validation/2026-10-02";
const hash = (path) => createHash("sha256").update(readFileSync(join(root, path))).digest("hex");
const json = (path) => JSON.parse(readFileSync(join(root, path), "utf8"));
const manifest = json(`${base}/manifest.json`);
for (const entry of manifest.artifacts) {
  assert.ok(entry.path.startsWith(`${base}/`) && !entry.path.split("/").includes(".."));
  assert.equal(hash(entry.path), entry.sha256, `Changed archived artifact: ${entry.path}`);
}
for (const name of ["smoke", "expected-runner-failure"]) {
  const report = json(`${base}/${name}/report.json`);
  for (const row of report.steps) {
    for (const stream of ["stdout", "stderr"]) {
      assert.equal(hash(`${base}/${name}/${row.id}.${stream}.txt`), row[`${stream}_sha256`]);
    }
  }
}
const passed = json(`${base}/smoke/report.json`);
assert.equal(passed.passed, true);
assert.equal(passed.steps.length, 8);
assert.equal(hash("scripts/run-developer-smoke.mjs"), passed.runner_sha256);
const failed = json(`${base}/expected-runner-failure/report.json`);
assert.equal(failed.passed, false);
assert.equal(hash(`${base}/expected-runner-failure/runner.mjs`), failed.runner_sha256);
console.log(`Verified ${manifest.artifacts.length} archived artifacts and smoke output provenance.`);
