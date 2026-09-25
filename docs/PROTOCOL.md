# JevRev Protocol v1

## Input

The CLI accepts one JSON object from `--input <path>` or stdin (`--input -`).

```json
{
  "version": "1",
  "task": {
    "goal": "Make the parser at least 2x faster.",
    "context": "The parser is single-threaded TypeScript.",
    "constraints": [
      { "id": "api", "text": "Do not change the public API", "kind": "hard" }
    ],
    "success": [
      { "id": "speed", "text": "Benchmark throughput is at least 2.0x baseline" }
    ]
  },
  "budget": { "max_survivors": 2 },
  "candidates": [
    {
      "id": "byte-fast-path",
      "title": "Add a byte-level fast path",
      "summary": "Bypass token objects for common ASCII input.",
      "mechanism": "Parse common ASCII tokens directly from the input buffer.",
      "assumptions": ["ASCII-heavy input dominates the benchmark corpus"],
      "risks": ["Fast and slow paths may diverge semantically"],
      "validation": ["Run the existing suite against both paths", "Benchmark the corpus"],
      "effort": "medium"
    },
    {
      "id": "allocation-cut",
      "title": "Reduce hot-path allocations",
      "summary": "Reuse bounded temporary storage on the measured hot path.",
      "mechanism": "Pool temporary arrays with reset-on-parse ownership and retain the existing fallback path.",
      "assumptions": ["Allocation pressure is a measured bottleneck"],
      "risks": ["State could leak between parses"],
      "validation": ["Run the full test suite", "Compare allocation counts and throughput"],
      "effort": "small"
    }
  ]
}
```

Rules:

- `version` must be `"1"`.
- Rank protocol version `1` remains the compatibility wire version. Since
  0.1.1 the result includes `provider_profile`, `next_action`, and
  `empty_reason`; strict consumers must accept those fields. Campaign,
  evidence, and Decide objects use their own `kind` plus `schema_version`.
- Candidate and criterion IDs use lowercase letters, digits, `_`, and `-`.
- Candidate IDs must be unique.
- A request contains 2-12 candidates.
- `max_survivors` cannot exceed the number of candidates.
- Free-text fields are length-bounded to keep the Jev state focused.

## Sift activation (shadow)

`jevrev activation` accepts a separate `jevrev.activation-request` envelope.
It is deliberately not part of the rank request because activation decides
whether to open Sift at all. The deterministic `activation-v1` policy returns
a `jevrev.activation-decision` with `decision: "sift"` or `"bypass"`, the
calculation, stable IDs, and reason codes. It always returns `shadow: true`:
the command never calls Jev, starts work, or changes the host agent's next
action. See [`ACTIVATION.md`](ACTIVATION.md) for field definitions and the
planned corpus study before any active gate is considered.

## Output

JSON mode returns one object:

```json
{
  "version": "1",
  "run_id": "jvr_...",
  "model": "jev-1.13.0",
  "policy": {
    "name": "default-v1",
    "provider_profile": "jev/jev-1.13.0",
    "max_survivors": 2,
    "thresholds": {
      "goal_fit": 0.34,
      "constraint_fit": 0.55,
      "feasibility": 0.34,
      "validation_quality": 0.25,
      "execution_value": 0.45,
      "confidence": 0.2,
      "duplicate": 0.75,
      "duplicate_confidence": 0.3
    },
    "weights": {
      "goal_fit": 0.3,
      "constraint_fit": 0.2,
      "feasibility": 0.2,
      "validation_quality": 0.1,
      "execution_value": 0.2
    },
    "effort_multipliers": { "small": 1, "medium": 0.94, "large": 0.86 }
  },
  "summary": { "evaluated": 7, "kept": 2, "shortlisted": 2, "review": 0, "rejected": 5 },
  "next_action": "implement",
  "empty_reason": "none",
  "selected": ["byte-fast-path", "allocation-cut"],
  "shortlist": ["byte-fast-path", "allocation-cut"],
  "decisions": [
    {
      "candidate_id": "byte-fast-path",
      "status": "keep",
      "rank": 1,
      "score": 0.82,
      "confidence": 0.76,
      "signals": {
        "goal_fit": 0.85,
        "constraint_fit": 0.91,
        "feasibility": 0.79,
        "validation_quality": 0.88,
        "execution_value": 0.74
      },
      "reasons": []
    }
  ],
  "usage": { "input_tokens": 1200, "output_tokens": 300 }
}
```

Statuses:

- `keep`: eligible for implementation.
- `review`: uncertain; an agent or human must decide.
- `reject`: do not spend implementation budget under the current policy.

A hard-constraint risk is checked before the confidence route. A candidate can
therefore be `reject` with both `CONSTRAINT_RISK` and `LOW_CONFIDENCE`; ordinary
low-confidence semantic scores remain `review`.

Reason codes:

- `GOAL_MISMATCH`
- `CONSTRAINT_RISK`
- `LOW_FEASIBILITY`
- `WEAK_VALIDATION`
- `LOW_EXECUTION_VALUE`
- `LOW_CONFIDENCE`
- `DUPLICATE_CANDIDATE` with a related candidate ID
- `BUDGET_CUTOFF`

Reason codes identify the rule that fired. They are not chain-of-thought or a
natural-language explanation from Jev.

`confidence` is a routing value computed by JevRev. It combines Jev's Score
confidence with the decision margin of Noul probabilities; it is not an extra
confidence field returned for Noul questions.

`next_action` is the host-agent handoff: `implement` when at least one
candidate was kept, `ask_human` when every candidate needs review or the
budget is exhausted, `revise_candidates` when candidates were rejected for
ordinary policy reasons, and `relax_constraints` when every candidate failed
the hard-constraint gate. `empty_reason` is `none` for a non-empty selection;
otherwise it identifies the empty result (`all_review`, `all_rejected`,
`mixed_no_survivor`, or `budget_exhausted`).

Replay fixtures must include `candidate_order`, an array of candidate IDs in
the exact order used when the answers were recorded. JevRev rejects a replay
whose order does not match the input instead of applying positional answers to
the wrong candidate.

## Evidence workflow protocols

`jevrev sift` accepts the same rank request but emits a
`jevrev.campaign` envelope. The existing rank result is preserved under `sift`;
`work_orders` contains one entry for each strict survivor. Candidate SHA-256
digests bind later evidence to the exact proposal.

`jevrev reconsider` accepts exactly one candidate whose Sift decision is
`review`. It returns `promote_to_probe`, `keep_review`, or `reject`. Promotion
adds one explicitly bounded review work order; it is permission to collect one
probe, never permission to integrate.

`jevrev decide` accepts two files:

```bash
jevrev decide --campaign campaign.json --evidence evidence.json
```

The evidence file is a `jevrev.evidence-bundle` containing zero or one packet
per work order. A packet records revision identity, command observations, raw
metric samples, requirement results, changed files, development cost, and known
failures. A `pass` requirement must cite at least one known observation or
metric. Packets with unknown references, duplicate IDs, mismatched campaign or
candidate hashes, or inconsistent base commits fail closed.

Decide recomputes metric means, sample standard deviations (`n - 1`), and
relative improvement. Required command failures, failed hard requirements, and
budget violations are applied before Jev is called. Builder notes are omitted
from judge state.

The result kind is `jevrev.decide-result`. `decision` is one of:

- `winner` — integrate the named winner after review;
- `merge` — run a combined probe for two independently viable candidates;
- `probe_more` — collect missing or discriminating evidence;
- `no_winner` — revise the candidate set;
- `human_review` — resolve a low-confidence or subjective trade-off.

Packets may attach content-addressed `artifacts` (source, diff, demo, or
screenshot) and typed `artifact_evaluations`. Current imported evaluations are
explicitly marked `source: "imported"`; a future trusted recorder can add a
runner-produced source without changing the packet shape. Decide receives
artifact metadata and redacted evaluation summaries, never raw artifact excerpts
or arbitrary repository access.

These are normal results and exit with code `0`. Nonzero exit codes remain
reserved for usage/input, provider, protocol, and unexpected failures. The
complete trust model and acceptance criteria are in [`WORKFLOW.md`](WORKFLOW.md).

## JevLoop wire format

`jevrev loop` uses four JSON documents. A `jevrev.loop-spec` freezes the goal,
criteria, budgets, and protected surfaces. `jevrev.round-work-order` is the
single bounded assignment issued to the host agent. The host fills a
`jevrev.round-evidence` envelope with recorded command observations, raw metric
samples, and typed claims. Every claim cites evidence IDs and the envelope is
bound to the loop, spec, work order, base revision, and current head. A
`jevrev.round-audit-result` is the deterministic gate plus one batched Jev
judgement for subjective criteria.

Metric criteria use an absolute `target` by default. A spec may also freeze a
numeric `baseline`; then `target` is a multiplier of that baseline (for
example, `baseline: 100`, `target: 2` means at least `200` for a higher-is-better
metric). This keeps relative claims explicit instead of hiding a baseline in
free-form prose.

Imported Loop artifacts must include a human-readable `summary`; they may also
include a workspace-relative `path` and bounded `content` excerpt. The digest
still binds the material to the artifact, while the summary/excerpt gives Jev
something concrete to judge. Existing Sift artifact bundles are not silently
treated as Loop evidence: copy their verified facts into the bound Loop
envelope.

## Provider addresses

The live Jev adapter calls `POST https://api.typesafe.ai/v1/systemone` by
default. Set `--jev-url` or `JEVREV_JEV_URL` to replace the API root. The API
key is read from `JEVREV_JEV_API_KEY` or the compatible `TYPESAFE_API_KEY`.

The local adapters use `POST /v1/chat/completions` on the SemIf base URL
(`http://127.0.0.1:4878` by default), or `POST /v1/score` on the legacy local
reranker (`http://127.0.0.1:4877`). `jevrev doctor --format json` prints the
resolved addresses without making an authenticated Jev request.

## Exit codes

| Code | Meaning |
| ---: | --- |
| 0 | Ranking completed, including a valid result with zero survivors |
| 2 | Invalid input or CLI usage |
| 3 | Judge provider/authentication/network failure |
| 4 | Judge response violated the expected protocol |
| 1 | Unexpected internal failure |

`jevrev doctor --check` uses code `3` when the selected local (`local` or
`semif`) endpoint is unreachable or returns a 4xx/5xx response. The hosted Jev
endpoint is reported as configured without making an authenticated request.
