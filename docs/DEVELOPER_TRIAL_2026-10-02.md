# Current-version acceptance record — 2026-10-02

Baseline: `265c9eaff6e6f18d72dbb7caa029d0ffd516f627`, Windows, Node `v24.13.1`,
npm `11.8.0`. Runtime source was unchanged. The runner is identified separately
by SHA-256 in its report because it was added during this review.

This is an agent-operated technical acceptance pass. No ordinary developer
participant or live matched-model experiment was run. Those gates remain open.

## Reproduced behavior

| Check | Observation | Evidence boundary |
| --- | --- | --- |
| CLI continuity | Register, monitor on, invalid input rejected with exit 2, prior state retained, monitor off, fresh process reads retained identity/settings | Eight-step [smoke report](../benchmarks/developer-validation/2026-10-02/smoke/report.json) with raw stdout/stderr and hashes; synthetic isolated project |
| Failure retention | Temporarily unavailable built CLI causes runner exit 1 and a retained failed report; CLI restored afterwards | [Intentional runner failure](../benchmarks/developer-validation/2026-10-02/expected-runner-failure/report.json); tests runner handling, not a natural product failure |
| Activation | One-mechanism request bypasses; parser fixture recommends Sift; both remain shadow-only | Smoke outputs; estimates are synthetic fixtures, not human labels or a 30–50 task corpus |
| TUI return | Actual Windows PTY opened Sessions; `c` opened Config; `q` restored the alternate screen; reopening showed Config | [Navigation and exit record](../benchmarks/developer-validation/2026-10-02/terminal-observation.json); empty session list, operator observation, no screenshot or human timing |
| Workflow gate | Regex favored on paper (0.9593), measured 22.32x baseline but failed correctness and was rejected; indexed state machine passed at 4.74x and won | [Decision](../benchmarks/developer-validation/2026-10-02/workflow-replay/decision.json) and adjacent campaign/evidence/replay files; machine-specific throughput, replay provider |

The PTY wrapper returned exit 1 without a diagnostic on two reopen attempts.
A separate invocation instrumenting the exported CLI `main()` recorded return
code 0 after `q`, and navigation/alternate-screen restoration were observed.
This narrows the discrepancy to terminal/process-wrapper behavior but does not
establish its cause. Keep it as a harness limitation; it is not evidence that
all terminal environments pass. Config page restore is distinct from recovery
of a host agent's private transcript.

## Verification and reproduction

`npm run check`, `npm run build`, and the full test suite passed: 36 files, 339
tests using `--maxWorkers=2 --testTimeout=20000`. The config/setup/TUI/activation
subset passed 36 tests. `npm run demo:workflow` executed the probe outcomes above.
`node scripts/run-developer-smoke.mjs` passed all eight steps, with no provider
calls. The rejection case and intentional missing-CLI failure were retained.

Rebuild before running the smoke and replay demo. New timings and generated IDs
will differ. Compare decisions, exit expectations and state invariants; do not
expect identical throughput. [Manifest](../benchmarks/developer-validation/2026-10-02/manifest.json)
contains SHA-256 for archived artifacts and the input implementation files.
Run `node scripts/verify-developer-trial.mjs` to verify the committed artifact
bytes, output digests and smoke runner provenance without making provider calls.
Both verification and the smoke are included in the existing three-platform CI;
smoke traces are uploaded for 14 days even if a step fails. Remote CI results
remain separate from the local Windows evidence recorded here.
Archived raw files were checked for credentials before publication. Temporary
project/UI/provider settings were isolated from the user's configuration.

Replay token counters are captured fixture metadata. They are not measured
provider spend, host-agent tokens or Codex quota savings. Human orientation time,
misclicks, missed alerts, irrelevant interruptions and subjective usefulness
remain unmeasured. TidalCity's matched budget, prompts and full run trace remain
unverified here. Use [the trial method](DEVELOPER_TRIAL.md) and
[comparison protocol](../benchmarks/COMPARISON_PROTOCOL.md) for those next gates.

## Scope and rollback

This PR adds an isolated developer smoke, archived evidence and trial/comparison
guidance. Activation remains shadow-only; Loop contracts and TUI interaction
semantics are unchanged. No daemon, automatic trigger, schema migration or
product-level acceptance is introduced. Revert the commit titled `Record current
developer workflow checks and comparison boundaries` to undo the tracked change.
Generated local evidence under `benchmarks/results/` is independent of Git revert.
