# JevRev evidence workflow

Status: implemented CLI workflow

## Product contract

JevRev is a speculative engineering funnel for coding agents:

```text
ideas -> sift -> cheap probes -> evidence -> decide
```

The host agent still writes code. JevRev freezes the brief, removes weak or
duplicative directions, emits comparable probe work orders, validates the
evidence returned by the host, and adjudicates only after deterministic facts
have been checked.

The default promise is:

> Explore wide. Prove cheap. Commit once.

It is not "build five products and ask a model which one looks best." The
expensive stages get progressively narrower:

```text
4-7 hypotheses -> 2 probes -> winner, merge probe, more evidence, or no winner
```

Simple or obvious tasks should bypass the workflow. It is useful only when the
expected cost of choosing the wrong mechanism exceeds the cost of two bounded
probes.

`jevrev activation` is the current shadow check for that decision. It accepts a
small host-agent assessment, records the deterministic loss-versus-exploration
calculation, and emits reason codes. It does not call Jev and does not activate
or bypass Sift automatically. The active gate remains deferred until a
30–50-task corpus and human counterfactual review establish its error rate.

## Truth hierarchy

Jev is not the final source of truth. Decision inputs are applied in this
order:

1. Schema, hashes, candidate identity, budgets, and command exit codes.
2. Required tests, hard constraints, and recorded measurements.
3. Jev judgments about evidence coverage, reproducibility, residual risk, and
   whether the result is worth shipping.
4. Deterministic product policy.

A failed required command or hard constraint cannot be overturned by a high
Jev score. Builder notes are untrusted context and cannot satisfy a required
criterion by themselves.

## Stateless vertical slice

The first release adds two composable primitives without building another
coding agent:

```bash
jevrev sift --input proposals.json --output campaign.json --summary
jevrev decide --campaign campaign.json --evidence evidence.json
```

`run` and `rank` keep their current output for compatibility. `sift` wraps the
same shortlist result in a campaign and emits one bounded work order per strict
survivor. A work order contains the hypothesis, the smallest-probe instruction,
required evidence, budget, and stop conditions.

The host agent performs each work order in an isolated branch or worktree and
returns an evidence bundle. JevRev does not run arbitrary shell commands or
merge a branch in this slice.

`jevrev-evidence-template --campaign campaign.json --output evidence.json`
creates a schema-valid handoff with `not_started` development and `unknown`
requirements. It removes envelope boilerplate without fabricating evidence; an
unchanged template deterministically routes to `probe_more`.

`jevrev evidence run --evidence evidence.json --candidate <id> --id <id> --
<argv...>` is the first trusted recorder. It executes argv directly without a
shell, enforces a workspace-relative cwd, strips Jev credentials, hashes output,
keeps child output quiet by default, atomically updates the packet, and returns
the child exit code after persisting the observation. Use `--echo` only for an
interactive debugging run because command output may contain secrets. Repeated
`--probe` and `--requirement` flags bind the real exit status to frozen evidence
slots.

Command arguments and artifact excerpts remain local evidence. Before a Decide
request is sent to a provider, JevRev reduces observations to the executable
name, exit/termination state, timings, byte counts, and output digests; artifact
content excerpts and raw argument values are not sent. Do not put credentials in
commands or artifacts anyway: the evidence file is intentionally inspectable on
disk. Text artifacts are capped at 16 MiB before hashing and reading.

Concurrent evidence writes are serialized. If a process dies while holding the
lock, JevRev fails closed; verify that no writer is active before removing the
reported `.lock` file manually.

On Windows, bare `npm`, `npx`, `pnpm`, `yarn`, and `corepack` commands are mapped
to their PowerShell shim without enabling shell parsing; prefer these names for
package scripts. Explicit executable names or paths are preserved exactly as
supplied and are never silently replaced; a launcher that requires a shell may
return a recorded `spawn_error` under `shell:false`.

`jevrev evidence metric` appends raw baseline/candidate samples and links them
to frozen slots only with an explicit result. `jevrev evidence artifact`
content-addresses a workspace-bound file and can attach an explicitly imported
evaluator result. `jevrev evidence status` is the read-only handoff view: it
lists missing/failed requirements and probes and tells the host whether to
collect evidence, revise/stop, or call Decide.

Replacing a linked metric requires a new `--result`. Replacing an artifact that
already has an evaluation requires a replacement evaluation with the same
evaluation ID; the linked status is refreshed from that result. This prevents a
new sample or file from inheriting an old pass decision.

Use `jevrev evidence status --next` after an interruption to print the first
missing evidence slot. It is a resume hint, not an executor.

`decide` first checks deterministic evidence. Only viable finalists are sent
to Jev (or a supported local judge) for narrow evidence questions. The result
is one of:

The legacy local scorer has a 120-second request timeout by default. A stalled
local model is reported as a provider failure instead of leaving the command
blocked indefinitely.

- `winner`: one candidate is ready to integrate;
- `merge`: independently viable, complementary candidates deserve a combined
  probe; this is not permission to merge untested code;
- `probe_more`: evidence is missing or the leading candidates are too close;
- `no_winner`: every candidate failed a deterministic or semantic gate;
- `human_review`: the judge is too uncertain or the trade-off is subjective.

If Sift returns a candidate with `status: review`, it is not silently promoted
or discarded. Reconsider one candidate explicitly:

```bash
jevrev reconsider --campaign campaign.json --candidate regex-match \
  --provider jev --output reconsider.json
```

`reconsider` asks a narrow second-pass question set. `promote_to_probe` grants
one bounded probe slot only; it never authorizes integration. `keep_review`
means the evidence is still too uncertain, and `reject` closes the candidate
under the current policy. Hard-constraint risk can never be promoted.

## Evidence contract

An evidence packet is tied to a campaign and candidate hash. It records:

- revision identity (`base_commit`, optional `head_commit`, and optional diff
  hash);
- command observations with argv, exit code, duration, and output digests;
- raw baseline and candidate metric samples;
- explicit results for every success criterion and hard constraint;
- content-addressed source, diff, demo, or screenshot artifacts plus imported
  evaluator observations when a probe produces a qualitative result;
- changed files, wall time, optional token/cost accounting;
- known failures and untrusted builder notes.

JevRev recomputes metric mean, sample standard deviation, and relative change
from raw samples. A passing requirement must cite a recorded observation or
metric. Evidence with the wrong campaign, candidate hash, duplicate IDs,
inconsistent base revision, a failed cited command, or a wall-time
contradiction fails closed.

## Sift and decide use different questions

Sift keeps the existing proposal signals:

- goal fit;
- hard-constraint fit;
- feasibility;
- validation quality;
- execution value;
- pairwise duplication.

Decide does not repeat those scores. It asks:

- does the evidence causally support the declared success criteria?
- is the result reproducible from the recorded observations?
- is residual risk acceptable?
- is the verified gain worth integrating?
- are two independently viable candidates complementary enough to justify a
  combined probe?

## Acceptance criteria for the slice

1. Existing `run`/`rank` JSON and replay behavior remain compatible.
2. `sift` produces a schema-valid campaign and deterministic candidate hashes.
3. `decide` rejects mismatched or incomplete evidence before calling policy.
4. A failed required command or hard constraint can never win.
5. Metric summaries are recomputed from raw samples with sample standard
   deviation (`n - 1`).
6. Decisions support all five normal outcomes and do not force a winner.
7. Jev, SemIf, legacy local, and replay providers remain usable through the
   shared typed-question boundary.
8. An executable demo runs correctness and repeated benchmark probes for two
   implementations, then shows the paper favorite losing after a regression
   while the initially second-ranked candidate wins on evidence. Jev answers
   are replayed; command and metric evidence is measured.
9. JSON stdout remains machine-readable; diagnostics stay on stderr.
10. No command is executed and no branch is merged by `sift` or `decide`.

## Current boundaries

- JevLoop is available as `jevrev loop create/next/audit/status/resume/abort`.
  Its `loop evidence run/metric/artifact` commands fill the bound
  `jevrev.round-evidence` envelope without advancing state; only `loop audit`
  changes the Loop state.
- JevLong is available as `jevrev long create/ingest/status/watch/loop-audit`. It accepts
  JSONL from a host adapter or stdin. `long loop-audit` verifies a real Loop
  directory and records its outcome in the observer journal without changing
  Loop state. Automatic worktree
  creation, integration/merge automation, a web UI, daemon, and MCP server
  remain deferred.

JevLoop reuses the same evidence-first trust model, but does not silently turn
the stateless Sift recorder into a long-running agent controller.

The authority split is normative: the host agent executes work, Jev judges
only the questions it is given, JevRev enforces deterministic contracts, and a
human owns contract changes, resumption, abortion, and integration. See
[`AUTHORITY.md`](AUTHORITY.md).
