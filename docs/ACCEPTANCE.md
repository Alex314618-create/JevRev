# JevRev release acceptance

Release candidate: `0.2.0`
Product: JevRev
Tagline: **Explore wide. Prove cheap. Commit once.**

The checks below are the acceptance record for this package. Commands were run
from the repository root on Node.js 25.2.1 / Windows PowerShell; the package
requires Node.js 20 or newer. The CI workflow repeats the TypeScript, test,
build, link, and demo checks on Node.js 20 for Ubuntu, macOS, and Windows.

## Module checklist

| Module | Acceptance check | Result |
| --- | --- | --- |
| Request schema | 2–12 candidates, bounded fields, unique IDs, hard/soft constraints, budget validation | PASS |
| Question planner | Five typed candidate questions plus pairwise duplicate questions; canonical live ordering | PASS |
| Jev adapter | Official SDK, explicit `--jev-url`, model selection, API-key environment aliases, typed response validation | PASS |
| SemIf adapter | Local Qwen3.5-4B option-logit protocol at `/v1/chat/completions`; no prose parsing | PASS |
| Legacy local adapter | Reranker protocol at `/v1/score` retained as an explicit compatibility provider | PASS |
| Policy | Hard gates, confidence review route, effort weighting, deduplication, survivor budget, empty-result action | PASS |
| Handoff | JSON `selected`, `shortlist`, decisions, reason codes, usage, stable run IDs, provider profile, thresholds | PASS |
| Campaign | Deterministic survivor hashes, bounded probe work orders, evidence requirements and stop conditions | PASS |
| Evidence | Campaign/candidate binding, reference integrity, raw samples, revision identity, command and budget gates | PASS |
| Agent handoff | Skill phase contract, safe template, command/metric/artifact recorders, and evidence status | PASS |
| Artifacts | Content-addressed source/demo/screenshot references and typed imported evaluator observations | PASS |
| Decide | Distinct evidence questions; winner, merge, probe-more, no-winner, and human-review outcomes | PASS |
| Replay safety | Candidate-order metadata checked before positional answers are accepted | PASS |
| CLI | `run`/`rank` compatibility, `sift`, `decide`, stdin, file output, stable exit codes | PASS |
| Evaluation/skill tooling | Read-only case evaluator and explicit skill installer | PASS |
| Cross-platform entry | Source checkout, local `npx`, linked CLI, four skill targets, and clean consumer tarball install | PASS |
| Operations | `doctor`, local health probes, PowerShell model lifecycle scripts | PASS |
| JevLoop contracts | frozen spec, one active round, scope/budget gates, fresh completion evidence | PASS |
| JevLoop store | hash-chained events, lock recovery, replay, resume/abort/approval | PASS |
| JevLoop CLI | create, evidence template, next, audit, status, resume, abort, approve | PASS |
| Documentation | README, protocol, design, local setup, skill, release notes | PASS |
| Packaging | `npm pack --dry-run`, clean consumer CLI/skill smoke test, compiled CLI, examples, docs, scripts, no generated benchmark results | PASS |

## Automated tests

```text
npm run check     PASS
npm test          PASS — 307 tests
npm run build     PASS
```

The packed `jevrev-0.2.0.tgz` was installed in a fresh temporary consumer
directory with scripts disabled. Its `jevrev --version`, `jevrev doctor`, and
`jevrev-skill-install --target agents --dry-run` commands all passed.

The tests cover JevSift/Probe/Decide plus JevLoop schema rejection, scope and
budget gates, question construction, official-client
transport, local response mapping, SemIf option-logit normalization, policy
invariants, replay-order rejection, empty-result actions, workflow schemas,
evidence references, artifact references, sample statistics, hard-gate ranking
reversal, objective dominance, all five Decide outcomes, JSON/human reporting,
CLI/provider integration, skill installation safety, and the public input-address
diagnostic.

The legacy Python reranker runtime suite also passes:

```text
python -m unittest discover -s runtime/tests -v  PASS — 7 tests
```

## Offline demonstrations

```text
npm run demo      PASS — parser-speedup fixture
npm run demo:all  PASS — parser-speedup, api-boundary-hardening,
                       flaky-ci-concurrency
npm run demo:workflow PASS — executes two implementations, five correctness
                         cases and seven benchmark samples per candidate;
                         paper favorite fails and runner-up wins
live long cases PASS — tenant auth, checkout performance, and payment
                       idempotency requests ran against Jev; results are
                       recorded in the task handoff, not committed as fixtures
```

The original demos prove deterministic protocol and policy behavior. The
workflow demo executes a self-contained delimiter-counter fixture, captures
real command exits/durations/output digests and repeated benchmark samples, and
writes its campaign, evidence, replay, and decision artifacts under the ignored
`benchmarks/results/workflow-demo/` directory. Sift and Decide model answers are
replayed; measured throughput varies by machine.

## Local model run

The pinned local service was started with:

```powershell
powershell -ExecutionPolicy Bypass -File scripts/start-semif.ps1 -Background
powershell -ExecutionPolicy Bypass -File scripts/status-semif.ps1
```

Health returned `200 OK` on `http://127.0.0.1:4878/health`. The parser live
run and the three-scenario benchmark completed through the real local Qwen
model, not a replay fixture.

## Candidate-coverage decision benchmark

The benchmark rotates candidate order so every candidate is first at least once
(at least five runs per scenario; the recorded run uses 7/6/6 repetitions for
the 7/6/6-candidate scenarios). Quality labels are declared in the benchmark
manifest before execution as a human-authored scenario rubric, not external
ground truth. “Shortlist best utility” means the best utility among strict
`selected` candidates plus any budget-filling `review` candidate; mean utility,
precision, recall, and strict selected quality are reported separately. A zero
order-rotation standard deviation means the fixed local run was unchanged
under these rotations; it is not a general model-stability estimate.

| Scenario | First idea (mean ± order σ) | Shortlist best / mean / P / R | Strict selected best / mean / P / R | E2E CLI time | Provider tokens (in/out; Δ vs first idea) | Estimated token spend | Slots saved vs trying all |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Parser speedup | 0.550 ± 0.382 | 1.000 / 0.975 / 1.000 / 1.000 | 1.000 / 0.975 / 1.000 / 1.000 | 10,234 ms ± 189 | 27,488 / 56; +27,544 | $0.00 local | 5 |
| API boundary hardening | 0.412 ± 0.385 | 1.000 / 0.850 / 1.000 / 1.000 | 1.000 / 1.000 / 1.000 / 0.500 | 8,005 ms ± 35 | 21,430 / 45; +21,475 | $0.00 local | 4 |
| Flaky CI concurrency | 0.433 ± 0.448 | 1.000 / 0.975 / 1.000 / 1.000 | 1.000 / 1.000 / 1.000 / 0.500 | 8,148 ms ± 22 | 21,539 / 45; +21,584 | $0.00 local | 4 |

Local API spend is zero because the judge ran on loopback; hardware and
electricity are excluded. The benchmark records token counts and accepts
`JEVREV_INPUT_USD_PER_MILLION` / `JEVREV_OUTPUT_USD_PER_MILLION` for a hosted
illustrative estimate. These rates are not official Jev billing; no provider
price is invented in the release report.

The first-idea baseline is intentionally a quality baseline, not a cost claim:
it spends no judge tokens but is order-sensitive. The token deltas above are
therefore the full JevRev decision overhead for this run. JevRev adds measured
judge time and tokens to reduce decision variance before downstream
implementation; whether that trade is favorable depends on the cost of a
wrong implementation in the host workflow.
The “slots saved” column is a candidate-card count relative to trying every
card, not a measured engineering-token or wall-clock saving.

Raw observations and per-scenario JSON summaries are generated under
`benchmarks/results/` when the benchmark runs. They are intentionally excluded
from git and the npm tarball; the recorded summary values above are the release
record.

The recorded v0.1.0 run is `bench_muagsjry_b903c3c2` with its then-current CLI
artifact SHA-256 `5853d720bb356e446af8383e51966d6e151532c789e1f491b557761a9febbce5`.
The v0.1.1 release asset SHA-256 was
`E8389CF9D6635973A59ECDF48AA353CEBFF47534E3E0F188F9BF8BA8677AEA10`.
The v0.2.0 SHA-256 is recorded in the GitHub release metadata after packaging;
it is not embedded here because changing an included file changes the tarball.

## Real-case provider check

The four hosted Jev cases were rerun after the hardening changes:

```text
4/4 cases passed; 29,886 input + 4,372 output tokens; 4.669 s total wall time
```

The exact commands and the local-model comparison are in
[`CASE_STUDY.md`](CASE_STUDY.md). The API key used for that run was temporary
and is not stored in this repository.

## Known boundaries

- A Sift `selected` candidate is a routing decision, not proof of correctness.
- `review` candidates remain unresolved; `shortlist` makes them visible to the
  host agent without silently approving them.
- Sift evidence is recorded through the trusted command/metric/artifact tools;
  campaign/candidate hashes and reference checks prevent accidental
  misattachment. JevLoop uses a separate bound round-evidence envelope. The
  `loop evidence-template` command creates it, while the host agent fills in
  recorder facts and preserves its round/head hashes. Neither path creates
  worktrees, chooses probes, or orchestrates arbitrary execution.
- JevRev does not create worktrees, run arbitrary commands, or merge code. The
  host agent executes work orders and stops before merge.
- `merge` requests a combined probe; it is not permission to integrate two
  branches without testing the combination.
- The benchmark evaluates decision quality against declared scenario labels;
  it does not claim that JevRev alone improves production latency or defect
  rate.
- The public repository is `https://github.com/Alex314618-create/JevRev`.
