import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";
import assert from "node:assert/strict";

// Real CLI processes in a disposable project; never read the operator's config.
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const cli = join(root, "dist", "cli.js");
const directory = mkdtempSync(join(tmpdir(), "jevrev-developer-smoke-"));
const environment = { ...process.env };
for (const name of Object.keys(environment)) {
  if (/^(JEVREV_|SPECJEV_|TYPESAFE_)/.test(name)) delete environment[name];
}
Object.assign(environment, {
  JEVREV_NO_TUI: "1",
  JEVREV_CONFIG_PATH: join(directory, "provider-config.json"),
  JEVREV_UI_DATA_DIR: join(directory, "ui"),
});
const digest = (text) => createHash("sha256").update(text).digest("hex");
const steps = [];
const runId = randomUUID();
const relativeOutput = `benchmarks/results/developer-smoke/${runId}`;
const outputDirectory = join(root, relativeOutput);
mkdirSync(outputDirectory, { recursive: true });
let passed = false;
let failure;
const run = (id, args, expectedExit = 0) => {
  const started = performance.now();
  const result = spawnSync(process.execPath, [cli, ...args], {
    cwd: directory, env: environment, encoding: "utf8", timeout: 15_000,
  });
  const row = {
    id, expected_exit: expectedExit, exit: result.status,
    wall_ms: Math.round(performance.now() - started),
    stdout_sha256: digest(result.stdout ?? ""), stderr_sha256: digest(result.stderr ?? ""),
  };
  steps.push(row);
  writeFileSync(join(outputDirectory, `${id}.stdout.txt`), result.stdout ?? "");
  writeFileSync(join(outputDirectory, `${id}.stderr.txt`), result.stderr ?? "");
  assert.ifError(result.error);
  assert.equal(result.status, expectedExit, `${id}: unexpected exit`);
  assert.ok(!/\x1b\[/.test(result.stdout), `${id}: terminal controls in piped output`);
  return result.stdout;
};

try {
  const record = JSON.parse(run("register-host", ["session", "register", "--host", "other",
    "--session-id", "developer-smoke", "--title", "Developer smoke", "--goal", "Verify monitor rollback", "--format", "json"]));
  const on = JSON.parse(run("enable-monitor", ["session", "monitor", "--id", record.id, "--loop", "on", "--format", "json"]));
  assert.equal(on.monitoring.loop, true);
  run("reject-invalid-monitor", ["session", "monitor", "--id", record.id, "--loop", "invalid", "--format", "json"], 2);
  const afterError = JSON.parse(run("read-after-error", ["session", "list", "--format", "json"]));
  assert.equal(afterError[0].monitoring.loop, true);
  const off = JSON.parse(run("rollback-monitor", ["session", "monitor", "--id", record.id, "--loop", "off", "--format", "json"]));
  assert.equal(off.monitoring.loop, false);
  const reopened = JSON.parse(run("read-new-process", ["session", "list", "--format", "json"]));
  assert.equal(reopened[0].host_session_id, "developer-smoke");
  assert.equal(reopened[0].monitoring.loop, false);
  const request = JSON.parse(readFileSync(join(root, "examples", "activation-parser.json"), "utf8"));
  request.assessment.candidate_count = 1;
  const input = join(directory, "activation.json");
  writeFileSync(input, JSON.stringify(request));
  const activation = JSON.parse(run("shadow-bypass", ["activation", "--input", input, "--format", "json"]));
  assert.equal(activation.shadow, true);
  assert.equal(activation.decision, "bypass");
  const uncertain = JSON.parse(run("shadow-sift", ["activation", "--input", join(root, "examples", "activation-parser.json"), "--format", "json"]));
  assert.equal(uncertain.shadow, true);
  assert.equal(uncertain.decision, "sift");
  passed = true;
} catch (error) {
  failure = error instanceof Error ? error.message : String(error);
  process.exitCode = 1;
} finally {
  const report = {
    kind: "jevrev.developer-smoke", schema_version: 1,
    run_id: runId, evidence_directory: relativeOutput,
    measurement_class: "machine_smoke_not_human_study", timestamp_utc: new Date().toISOString(),
    source_revision: spawnSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).stdout.trim(),
    cli_sha256: existsSync(cli) ? digest(readFileSync(cli)) : null, node: process.version, platform: process.platform,
    runner_sha256: digest(readFileSync(fileURLToPath(import.meta.url))),
    provider_calls: 0, human_orientation_ms: null, human_interruptions: null,
    steps, passed, ...(failure === undefined ? {} : { failure }),
  };
  const output = join(outputDirectory, "report.json");
  writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  rmSync(directory, { recursive: true, force: true });
}
