---
name: jevrev
description: Use JevRev beside an LLM: JevSift narrows competing mechanisms, JevLoop audits one evolving result, and JevLong observes a long-running session without driving it.
---

# JevRev: Sift, Loop, Long

## Resolve the CLI before the first command

Installing this skill copies instructions; it does not install the JevRev CLI
or add a project-local binary to your shell's PATH. Check `jevrev --version`
before following the commands below. If JevRev is installed in the current
project but the bare command is unavailable, check
`npx --no-install jevrev --version` and use `npx --no-install jevrev` wherever
this skill shows `jevrev`. The `--no-install` flag uses the existing local
package without installing one during the workflow. If neither command works,
install or build JevRev first; do not silently skip a JevRev step.

JevRev has three product components and a shared evidence protocol:

- **JevSift**: `jevrev sift` (with `run`/`rank` compatibility aliases). It
  filters proposal cards and writes probe work orders. It does not prove code.
- **JevLoop**: `jevrev loop`. It owns one evolving artifact and one active
  round. The host agent executes the work order; Loop records and audits the
  result. It never launches or drives the agent.
- **JevLong**: `jevrev long`. It observes a long-running session from JSONL
  events, reports stalls, failure loops, drift, and budget risk, and leaves
  intervention to a human. It is not a daemon and does not drive the agent.

`Probe`, `Evidence`, and `Decide` are shared workflow concepts and judge
boundaries. They are how the host agent performs work, records facts, and lets
Jev answer narrow questions inside Sift and Loop; Sift campaigns and Loop
rounds intentionally use separate envelopes and state machines.

## When to use it

Use JevSift when:

- at least two materially different mechanisms could solve the task;
- a wrong path costs more than two bounded probes;
- success can be checked with tests, benchmarks, screenshots, or another
  falsifiable observation.

Skip it for an obvious one-line fix, a cheap reversible change, or a task whose
success criteria cannot be observed. Do not generate seven wording variants.

For a borderline task, an agent may record a small activation assessment and
run the shadow policy first:

```bash
jevrev activation --input activation.json --format json
```

Treat `decision` as a routing signal, not permission. The result is always
shadow-only; it never replaces the host agent's decision and it never calls
Sift for you. Keep the assessment in the run record so later human review can
compare the prediction with the path actually taken.

Use JevLoop when one implementation should improve over several bounded rounds
and each round can return fresh command, metric, or artifact evidence. Freeze the
contract first, let the host agent execute the work order, and submit the
resulting `jevrev.round-evidence`. Start with `jevrev loop evidence-template`
when creating the envelope. Use `jevrev loop evidence run`, `metric`, and
`artifact` to fill it with recorded facts; only `jevrev loop audit` advances the
Loop. For judged criteria use `--provider jev`,
`--provider local`, `--provider semif`, or `--replay`; hard-only loops need no
provider.

Use JevLong when the host agent or harness will run for long enough that stalls,
repeated failures, scope drift, or budget burn need a second pair of eyes. Start
the observer with `jevrev long create`, feed normalized events with
`jevrev long ingest --input events.jsonl` (or
`... | jevrev long ingest --input -`). The host agent checks
`jevrev long status` only when it needs a snapshot; it must not poll or capture
the live dashboard into its context. A human can use `jevrev long watch` in a
foreground terminal. In a non-interactive shell, watch returns one compact
summary unless `--stream` or `--iterations` is explicit. After a Loop audit, record the
bridge event with all of the Loop-owned identifiers and digests:

```bash
jevrev long loop-audit \
  --directory .jevrev/long \
  --loop-directory .jevrev/loop \
  --loop-id <loop-id> \
  --round <round-number> \
  --work-order-sha256 <work-order-sha256> \
  --outcome <outcome> \
  --evidence-sha256 <evidence-sha256>
```

Take these values from the actual `jevrev loop next` and `jevrev loop audit`
outputs. `<outcome>` must be one of `continue`, `fix_regression`, `verify`,
`replan`, `waiting_human`, `budget_paused`, or `completed`. The bridge verifies
the Loop event and digests before granting the
observation `recorded` provenance; it never accepts a caller-supplied outcome
for a round that is absent from the Loop event log.

## Host-agent contract

The host agent owns the repository, worktrees, commands, and user conversation.
JevRev owns the frozen task contract, candidate routing, evidence schema, and
decision policy. Never send secrets, a whole repository, or untrusted logs to
Jev unless required by the task.

### Phase A — Freeze and Sift

1. State the goal, context, hard/soft constraints, success criteria, and probe
   budget. Freeze these before writing implementation code.
2. Draft 4–7 genuinely different candidate cards. Every card needs `id`,
   `title`, `summary`, `mechanism`, `assumptions`, `risks`, `validation`, and
   `effort`.
3. Write the request to a temporary file and run:

```bash
jevrev sift --input proposals.json --format json --output campaign.json --summary
```

4. Use the short stdout summary to choose work orders. Read only the needed
   `work_orders` fields from `campaign.json`; do not dump the full file into the
   host conversation. Do not implement rejected cards.
   If a strong borderline idea is `review`, use `jevrev reconsider` once for
   that candidate instead of silently treating review as approval.
   A `review` card is not approved; ask a human or revise the ideas.

### Phase B — Execute work orders

For each work order, use a separate branch/worktree when practical. Perform the
smallest reversible probe, not a complete product. Use the same evidence shape
and comparable budgets for every finalist.

Record:

- the base and head revision, plus a diff/source hash;
- every command as direct argv, exit code, duration, and stdout/stderr digest;
- raw baseline and candidate metric samples (at least two samples each);
- a pass/fail/unknown result for every hard constraint and success criterion;
- a pass/fail/unknown result for every intended criterion and protected surface;
- changed repository-relative files, wall time, optional token/cost usage;
- artifacts such as a diff, screenshot, or demo output by content hash;
- known failures. Builder notes are context, never proof. Work-order
  `required_evidence` entries are prompts; criterion/protected-surface claims
  and their cited observations are the authoritative completion proof.

If a command fails, record the failure. Do not change `required` to false to
make a failing observation disappear. Do not invent metric samples.

Use the trusted recorder for commands whenever possible:

```bash
jevrev evidence run \
  --evidence evidence.json \
  --candidate <candidate-id> \
  --id tests \
  --probe probe-1 \
  --requirement success:<criterion-id> \
  -- npm test
```

On Windows, use bare `npm`, `npx`, `pnpm`, or another executable name for
package scripts. The recorder resolves common PowerShell shims safely while
preserving explicit executable names or paths exactly as supplied; a shell-only
launcher may therefore produce a recorded `spawn_error` under `shell:false`
rather than being silently replaced.

The command is executed as direct argv, not through a shell. Its exit code,
workspace-relative cwd, duration, output digests, byte counts, and termination
mode are saved before the recorder exits. A failed child command makes the
recorder exit nonzero but does not lose the recorded failure. Continue the
workflow by inspecting the evidence file, not by rerunning blindly.

Concurrent evidence writes are serialized. If a writer dies, the recorder
fails closed on the remaining `.lock` file; verify that no writer is active
before removing that file manually.

Record raw benchmark samples with:

```bash
jevrev evidence metric \
  --evidence evidence.json \
  --candidate <candidate-id> \
  --input metric.json \
  --result pass \
  --probe probe-2 \
  --requirement success:<criterion-id>
```

Do not reduce samples to one claimed percentage. `metric.json` must contain raw
baseline and candidate arrays. Set `--result` by applying the frozen success
criterion, not merely because relative improvement is positive.

Record content-addressed artifacts and an imported evaluator result with
`jevrev evidence artifact`. Link an artifact to a requirement only when an
actual evaluator/status/summary is supplied; a file's existence is not proof.

Before Decide, always run:

```bash
jevrev evidence status --campaign campaign.json --evidence evidence.json
```

Proceed only when every intended finalist says `ready_for_decide`. For
`collect_evidence`, record exactly the missing item. For `revise_or_stop`, do
not spend more budget without user direction.

To avoid hand-writing the envelope, create an explicitly incomplete template:

```bash
jevrev-evidence-template --campaign campaign.json --output evidence.json
```

The template contains `unknown` statuses and a `TEMPLATE` failure marker. It
must be filled with actual observations before Decide.

### Phase C — Decide

```bash
jevrev decide \
  --campaign campaign.json \
  --evidence evidence.json \
  --format json --output decision.json
```

Facts are applied before Jev:

1. campaign/candidate hashes, revision identity, paths, and references;
2. required command exit codes, hard constraints, budgets, and metric samples;
3. Jev evidence-support, reproducibility, residual-risk, and shipping-value
   questions;
4. deterministic outcome policy.

Follow the result exactly:

- `winner` / `integrate_winner`: show evidence and ask before applying/merging;
- `merge` / `probe_combination`: run a combined probe; do not merge yet;
- `probe_more` / `collect_evidence`: collect only missing/discriminating data;
- `no_winner` / `revise_ideas`: discard failed paths and generate new cards;
- `human_review` / `ask_human`: present the unresolved trade-off.

Never turn `merge` into permission to merge. Never treat a Sift score as proof.

## Provider setup

Hosted Jev:

```bash
export JEVREV_JEV_API_KEY="..."
jevrev sift --input proposals.json --provider jev --output campaign.json --summary
```

Local SemIf:

```bash
jevrev sift --input proposals.json --provider semif --output campaign.json --summary
```

The same provider flags work for `decide`. Credentials belong in
`JEVREV_JEV_API_KEY` or `TYPESAFE_API_KEY`, never in command arguments,
campaigns, evidence, or logs.

## Handoff format to the user

Keep the final message short and operational:

```text
JevSift kept: candidate-a, candidate-b
Probe status: candidate-a tests pass; candidate-b benchmark failed
Decide: winner candidate-a
Next action: review the evidence; nothing was merged
```

If setup is missing, say so. If Jev and a local judge disagree, report both
provider profiles and route the disagreement to review; do not hide it behind a
single score.

For a planning-only workflow, `jevrev run` remains available. Use it when the
host intentionally stops before probes.
