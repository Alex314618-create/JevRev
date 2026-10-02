# Matched workflow comparison

Existing visual showcases and replay demonstrations are useful cases; they do
not establish live model or developer productivity effects. A new claim needs a
prospectively frozen record shared by both conditions.

## Freeze before either run

- Task ID, goal, starting repository SHA, allowed files and a common acceptance
  oracle, including correctness, exception paths and any performance target.
- Host/model exact identifiers and parameters, prompts as files plus SHA-256,
  tool versions, dependencies and initial context. A display name alone is not
  enough. Record unavailable provider version information as unknown.
- Equal maximum host tokens, wall time, retries, human intervention and tool
  budgets. Separately declare Jev's extra provider budget and count it in the
  treatment total. Do not hide it inside an equal host-only budget.
- Control: ordinary host workflow. Treatment: same workflow with explicit JevRev
  use. State exactly which component and revision differs. Setup and observation
  costs must be recorded, including any Observer agent.
- Paired task variants and order: randomize or counterbalance control/treatment
  across tasks so the second run does not inherit the first solution. A single
  pair is exploratory. Specify stopping and exclusion rules before execution.

## Retain enough to reproduce

Keep a manifest, exact prompt/acceptance files, output commits or patches,
command trace with timestamp/exit/duration, relevant stdout/stderr, provider
usage records and all JevRev artifacts. Link every summary row to raw evidence.
Remove credentials and private content before publishing; hashes identify
artifacts but cannot replace accessible redacted artifacts. Record redaction
boundaries. A failed run remains in the denominator unless the predeclared
exclusion rule applies; preserve its last state and reason.

Report a row for every condition with acceptance result, unfinished requirements,
defects/rework, host tokens, Jev tokens, wall time, retries, interventions and
participant attention. Missing metrics are null with a reason, never zero.
Provider-reported replay usage is fixture metadata, not billed usage.
Codex quota is account-wide: record window/reset timestamps, concurrent activity
and changes separately; do not convert a percentage into task tokens.

## Interpret and decide

Run the same independent oracle against both outputs before judging aesthetics
or quoting throughput. Use paired differences over all planned runs; report
sample size, variability, failures and missing data. Do not choose the best
model output from one side or change budgets after seeing the result.

A benefit claim must identify what JevRev changed and whether the benefit
exceeded its extra latency, provider/host tokens and developer attention. If both
routes were already obvious or results are equivalent, retain that negative
evidence. Images, a successful replay, or one impressive task remain case
evidence. Unsupported savings stay unclaimed.

Rollback of this protocol/evidence PR is a commit revert. Trial repositories and
credentials are outside this repository; removal of a documentation commit does
not erase external trial data or change an active provider configuration.
