# Developer workflow trial

Track the remaining evidence for [TUI attention, issue #7](https://github.com/Alex314618-create/JevRev/issues/7)
and [Sift activation, issue #8](https://github.com/Alex314618-create/JevRev/issues/8).
Machine checks, an agent-operated terminal, human observations and live-provider
comparisons are different evidence. Do not substitute one for another.

## Current technical check

From a clean checkout, run `npm ci`, `npm run build`, then:

```text
node scripts/run-developer-smoke.mjs
npm run demo:workflow
```

The smoke runs real CLI processes in a temporary project, isolates provider/UI
configuration, and removes that project on exit. It checks monitor enable,
invalid-input rejection without state loss, rollback, process-to-process session
continuity, shadow bypass and shadow Sift. It makes no provider calls. Each step
records expected/actual exit, elapsed time and output digests in a unique
`benchmarks/results/developer-smoke/<run-id>/report.json`, alongside stdout/stderr
files. Failed runs retain their steps and return a nonzero exit. Review raw files
before sharing. Digests alone are insufficient raw evidence for performance or
quality claims.

The workflow demo runs actual correctness/throughput probes but replays model
responses. Its winner is a deterministic evidence-gate check, not evidence of
live Jev quality, latency or token savings. Keep campaign, evidence, replay and
decision files together. See [the current acceptance record](DEVELOPER_TRIAL_2026-10-02.md).

## One ordinary developer session

Use a task the participant already needs to complete. Freeze its goal, repository
revision and acceptance checks before revealing activation advice. Record the
participant's initial route and reason first. Allow normal tools and normal
breaks. Do not coach them through the TUI; record any assistance as intervention.

Observe initial setup, one meaningful decision, an error/recovery if it occurs
naturally, and return after an unattended interval. Do not manufacture a failure
to increase event counts. Before leaving, record the actual session and next
expected action. On return, ask the participant to find the objective, current
state, changed evidence, next action and any human gate. Time from the first
visible frame until they answer correctly against authoritative artifacts.

For each observation record:

| Field | Requirement |
| --- | --- |
| Provenance | Run ID, UTC timestamp, source SHA, host/model/version, OS and terminal dimensions |
| Trigger and intent | What happened naturally and what the participant wanted to know |
| Result | Answer and evidence path; task, phase and product completion kept distinct |
| Effort | Time to correct understanding, wrong selections, backtracks and assistance count |
| Attention | Missed important cues and irrelevant interruptions, with denominator/opportunity |
| Continuity | Lost state/context or successful resume; distinguish host transcript from JevRev index |
| Subjective account | Verbatim short reaction; do not infer satisfaction from successful commands |
| Cost | Host tokens, Jev tokens, account quota and elapsed time separately; unavailable = null |

At the end, ask: What changed your decision? What was harder than normal? Which
information was missing or distracting? Would you choose this for the next
similar task, and why? Include negative and uneventful cases.

Do not declare issue #7 accepted from renderer tests. Before collecting data,
agree on a target for return-understanding time and missed required human gates.
Report the full distribution, sample size and observed failures rather than a
best run. One session is a formative observation, not a product-wide verdict.

## Activation annotations

The public component is **JevSift** and its shadow command is `activation`.
`shft` is unresolved shorthand in the original report; do not add a CLI alias
without clarification. See [activation workflow placement](ACTIVATION.md).

Collect 30–50 ordinary tasks with human judgments recorded before policy output.
Retain goal/revision, named mechanisms, assessment estimates, initial human
`sift`/`bypass` judgment and rationale, policy version/result, eventual decision,
and actual reversals or wasted probes. Human labels are judgments, not ground
truth. Keep initial and late activation observations under the same task ID to
avoid counting retries as independent tasks.

Report false-positive activation, false-negative bypass, disagreements,
activation rate and reason distribution with denominators. Preserve unknown
annotations; do not count them as correct predictions. Use completed comparable
tasks for payoff analysis and reserve unseen tasks if revising policy weights.
Remain shadow-only until the empirical gate in issue #8 is reviewed.
