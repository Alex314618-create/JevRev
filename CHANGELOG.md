# Changelog

## Unreleased

- Add the shadow-only `jevrev activation` policy to measure whether Sift is
  worth opening, with explicit bypass decisions, reason codes, and a documented
  host-agent assessment contract.
- Keep linked CLI invocations working, clarify locally installed skill command
  resolution, and avoid calling a successful Loop completion "stalled".
- Bound agent-facing output: non-interactive Long watch now emits one compact
  status by default, and Sift can write its full campaign to a file while
  returning a short `--summary` handoff. Foreground TUI slows when unfocused.
- Make Evidence command recording work with Windows PowerShell shims while
  keeping direct, shell-free argv execution; serialize concurrent Sift evidence
  updates; add the first-class Long `metric` event type; and refresh the
  workflow examples and authority wording.
- Let Loop artifact evidence keep its completion slot ID separate from the
  spec's `required_artifacts` reference through `--artifact-id`.
- Accept UTF-8 BOM and UTF-16 JSON files, including PowerShell 5.1 output, and
  report path-based validation errors.
- Add `jevrev reconsider` for a bounded second pass on one Sift review
  candidate, plus `jevrev evidence status --next` as a read-only resume hint.
- Harden Long protocol and journal boundaries: unknown or malformed measurements
  raise protocol evidence, dedupe indexes are checked against the verified
  journal, root scopes are handled explicitly, and recorder output is quiet by
  default with opt-in `--echo`.

## 0.2.0 — 2026-09-21

- Add `sift` campaigns with bounded probe work orders while preserving the
  original `run` and `rank` contracts.
- Add evidence packets with candidate hashes, command results, raw metric
  samples, requirement references, revision identity, budgets, and failures.
- Add `decide` with deterministic hard gates followed by a separate Jev
  evidence review.
- Support `winner`, `merge`, `probe_more`, `no_winner`, and `human_review`
  instead of forcing a winner.
- Add an executed ranking-reversal workflow demo and shared Decide support for
  Jev, SemIf, legacy local, and replay providers.
- Add `jevrev-evidence-template` so host agents can create a safe incomplete
  evidence handoff without manually reproducing the schema.
- Add `jevrev evidence run`, a shell-free command recorder that atomically
  captures argv, cwd, exit status, duration and output digests into evidence.
- Add evidence metric/artifact recorders and a status command so an agent can
  reach Decide without manually editing the evidence envelope.
- Add JevLoop: frozen single-artifact specs, bounded work orders, hash-chained
  event storage, evidence audits, scope/budget gates, resume/abort/approval,
  replay/local providers, and the `loop evidence-template` CLI command.
- Add JevLong: a read-only JSONL observer with deterministic `long create`,
  `long ingest`, `long status`, and `long watch` commands. It reports session
  health to a human and never drives the agent.
- Document the authority model across the human operator, host agent, Jev,
  and deterministic JevRev core.
- Harden JevLoop revision boundaries so old audits cannot carry into a new
  frozen contract; require explicit human confirmation and an attestation for
  resume; expose artifact summaries/excerpts to Jev; and support explicit
  metric baselines for relative targets.

## 0.1.1 — 2026-09-21

- Reject replay fixtures whose `candidate_order` does not match the request;
  positional answers can no longer silently move to another candidate.
- Check hard-constraint risk before the confidence review route while keeping
  other low-confidence judgments reviewable.
- Add `next_action`, `empty_reason`, policy thresholds, and provider profile to
  the JSON handoff.
- Add a read-only case evaluator and an explicit bundled-skill installer.

## 0.1.0 — 2026-09-20

First JevRev release.

- `jevrev run` accepts structured candidate cards from a file or stdin.
- `jevrev rank` and the `specjev` binary remain compatibility aliases.
- Official Jev/TypeSafe, local SemIf, replay, and legacy reranker providers are
  available through one typed response contract.
- `--jev-url`, `--semif-url`, `--local-url`, `--output`, and `doctor` expose the
  integration surface needed by shell scripts and coding agents.
- Three realistic request scenarios, offline fixtures, module tests, and a
  at-least-five-repetition benchmark harness are included.
