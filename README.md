# JevRev

[![CI](https://github.com/Alex314618-create/JevRev/actions/workflows/ci.yml/badge.svg)](https://github.com/Alex314618-create/JevRev/actions/workflows/ci.yml)

> Pick the right path before you build.

Cut 3-7 candidate approaches to the one or two worth building before you spend
two days on the wrong one. Hard-constraint risks are surfaced and gated;
duplicates are cut. One
command, JSON out, no plugin, never touches your repo. Offline runs need no
key; local judging has zero API spend and keeps the request on your machine.

JevRev is a CLI gate between planning and implementation. Your coding agent
drafts 3-7 materially different approaches. Jev (or a local judge) scores them
against one brief, removes duplicates and hard-constraint failures, and returns
a short queue to implement and test.

The first pass should feel like an octopus: several arms reach into the problem
at once. JevRev keeps the arms that have earned another step. It does not edit
your repository or pretend that a score is proof.

## Try it in a minute

From a source checkout:

```bash
git clone https://github.com/Alex314618-create/JevRev.git
cd JevRev
npm install
npm run build
npm run demo
```

The demo is offline and deterministic. It ranks seven parser-speedup ideas:

```text
JevRev jvr_... | jev-1.13.0-demo
Kept 2/7 | shortlist 2 | review 0 | rejected 5
Implement next: allocation-cut, byte-fast-path
```

The calling agent implements the IDs in `selected`, runs the tests, and keeps or
drops the result using real evidence. To run all three included scenarios:

```bash
npm run demo:all
```

After the package is published, install the CLI separately and point it at your
own request file:

```bash
npm install -g jevrev
jevrev run --input request.json --provider jev --format json
```

It is a small command between planning and editing, not a second coding agent,
workflow dashboard, or patch generator.

## Why this exists

The expensive mistake is often made before the first line of code: the agent
chooses the first plausible approach and only discovers a better one after the
implementation has grown around it.

JevRev makes the agent compare first.

- The calling agent proposes 3-7 candidate cards.
- JevRev asks the same narrow questions about every card.
- Deterministic policy removes hard-constraint failures, duplicates, and
  low-value work outside the budget.
- The calling agent builds the few that remain.

The input and output are ordinary JSON. That is the integration surface. Call it
from Codex, Claude Code, CI, or a shell script.

## See it run

The included replay demos need no account and no model. They cover three
concrete problems:

- parser throughput without changing a public API;
- API boundary validation without weakening limits;
- flaky CI caused by shared state and time.

The live provider can be Jev, or a local model. With a request file of your own:

```bash
jevrev run --input request.json --provider jev --format json
jevrev run --input request.json --provider semif --format json
```

## The result

JSON mode returns two queues. The example below is abridged:

```json
{
  "selected": ["allocation-cut", "byte-fast-path"],
  "shortlist": ["allocation-cut", "byte-fast-path"],
  "decisions": [
    { "candidate_id": "allocation-cut", "status": "keep" },
    { "candidate_id": "native-extension", "status": "reject" }
  ]
}
```

`selected` is the set that passed JevRev's policy gates; still verify it.
`shortlist` is the handoff queue and may include a `review` item when Jev is
uncertain. Review is visible and deliberate, not an automatic approval.

A decision includes the score, confidence, five signal values, reason codes,
policy version, run ID, and provider token usage. The policy is deterministic;
the judge supplies typed signals, not prose.

## What gets checked

JevRev asks five small questions for each candidate:

1. Does the mechanism fit the goal and success criteria?
2. Does it satisfy every hard constraint?
3. Is it feasible in the supplied context?
4. Can the validation plan catch a false win or regression?
5. Is it worth one implementation slot right now?

Candidate pairs are also checked for material duplication. Low-confidence answers go
to review; they do not silently become rejections.

The calling agent still owns the repository, implementation, tests, benchmarks,
and final decision. A JevRev result is a routing signal, not proof that a patch
is correct.

## The numbers

We ran the three included scenarios against a local Qwen3.5-4B Q4_K_M SemIf
service on Windows. This is one recorded local run, not a production
benchmark. For each scenario, candidate order was rotated until every card had
appeared first at least once.

The first-choice column is the mean utility of the card a naive workflow would
try first. The next column is the sample standard deviation of first-choice
utility (left) and best-shortlist utility (right) across the same rotations
(`n - 1` denominator). These are cyclic candidate-order rotations, not repeated
stochastic model runs. It measures order sensitivity, not general model
uncertainty. `Shortlist best` is the best utility among the paths returned for
implementation or review; it is not a claim that every returned path is
equally good.

The three scenarios ran 7, 6, and 6 rotations respectively. CLI time is
process wall time, including Node startup and the provider request.

| Scenario | Naive first-choice mean (0-1) | Order sensitivity (sample sd): first choice -> shortlist best | Shortlist utility, best / mean (0-1) | CLI wall time (mean +/- sd) | Judge tokens (mean) |
| --- | ---: | ---: | ---: | ---: | ---: |
| Parser speedup | 0.550 | 0.382 -> 0.000 | 1.000 / 0.975 | 10.234s +/- 0.189 | 27,488 in / 56 out |
| API boundary hardening | 0.412 | 0.385 -> 0.000 | 1.000 / 0.850 | 8.005s +/- 0.035 | 21,430 in / 45 out |
| Flaky CI concurrency | 0.433 | 0.448 -> 0.000 | 1.000 / 0.975 | 8.148s +/- 0.022 | 21,539 in / 45 out |

The useful result is the middle column. In this fixed local run, changing which
candidate appeared first changed the naive choice a lot, but did not change the
final JevRev shortlist. Order sensitivity fell from 0.382, 0.385, and 0.448 to
0.000. Against the predeclared scenario labels, each recorded shortlist had
precision and recall of 1.00; the full per-scenario figures are in the
acceptance report.

This is a routing comparison, not an apples-to-apples quality uplift: the
first-choice number describes one path, while `best` is the maximum utility in
a returned set. The shortlist mean is included to make that distinction
visible.

This is a decision-stability measurement, not a claim that the model is always
right or that production engineering time will drop by the same amount. The
rubric was written before the run by a human, and the experiment used one local
model. Full precision/recall, token deltas, benchmark summaries, and the exact
method are in [docs/ACCEPTANCE.md](docs/ACCEPTANCE.md). The raw observations
are regenerated locally by `npm run benchmark:demos`.

Run the benchmark yourself after starting the local SemIf service (see
[Provider setup](#provider-setup)):

```bash
npm run benchmark:demos
```

Local inference has zero API spend. Hosted cost estimates can be supplied with
`JEVREV_INPUT_USD_PER_MILLION` and `JEVREV_OUTPUT_USD_PER_MILLION`; those are
user-supplied rates, not official Jev billing.

## Provider setup

### Jev

The default adapter uses the official TypeSafe SDK:

```text
API root:   https://api.typesafe.ai
request:    POST https://api.typesafe.ai/v1/systemone
credential: JEVREV_JEV_API_KEY or TYPESAFE_API_KEY
```

```bash
export JEVREV_JEV_API_KEY="..."
jevrev run --input request.json --provider jev --model jev-latest
```

Jev URL overrides are accepted through `--jev-url` or `JEVREV_JEV_URL`.
Compatibility aliases `TYPESAFE_BASE_URL` and `TYPESAFE_DEFAULT_MODEL` are also
accepted.

### Local SemIf

The tested local path uses a Qwen3.5-4B GGUF behind llama.cpp. The model service
must be installed and running separately:

```powershell
powershell -ExecutionPolicy Bypass -File scripts/check-semif.ps1
powershell -ExecutionPolicy Bypass -File scripts/start-semif.ps1 -Background
jevrev run --input request.json --provider semif --format json
```

```text
request: POST http://127.0.0.1:4878/v1/chat/completions
health:  GET http://127.0.0.1:4878/health
```

The older local reranker remains available at
`POST http://127.0.0.1:4877/v1/score`. Run
`jevrev doctor --format json --check` to inspect all configured addresses.

Model setup and lifecycle scripts are documented in
[docs/SEMIF_LOCAL.md](docs/SEMIF_LOCAL.md).

## Input

A candidate is more than a title. It states the mechanism, assumptions, risks,
validation plan, and expected effort. Requests contain 2-12 candidates.

```json
{
  "version": "1",
  "task": {
    "goal": "Make the parser at least 2x faster",
    "context": "Single-threaded TypeScript parser; public API is stable",
    "constraints": [
      { "id": "api", "text": "Do not change the public API", "kind": "hard" }
    ],
    "success": [
      { "id": "speed", "text": "Throughput is at least 2.0x baseline" }
    ]
  },
  "budget": { "max_survivors": 2 },
  "candidates": [
    {
      "id": "byte-fast-path",
      "title": "Add an ASCII byte fast path",
      "summary": "Bypass intermediate strings for common input.",
      "mechanism": "Parse common token classes directly from the input buffer and retain a Unicode fallback.",
      "assumptions": ["ASCII-heavy files dominate the benchmark corpus"],
      "risks": ["Fast and fallback paths could diverge"],
      "validation": ["Differential tests", "Corpus benchmark"],
      "effort": "medium"
    },
    {
      "id": "allocation-cut",
      "title": "Reduce hot-path allocations",
      "summary": "Reuse bounded temporary storage on the measured path.",
      "mechanism": "Pool temporary arrays with reset-on-parse ownership and retain the fallback path.",
      "assumptions": ["Allocation pressure is a measured bottleneck"],
      "risks": ["State could leak between parses"],
      "validation": ["Run the full suite", "Compare allocation counts and throughput"],
      "effort": "small"
    }
  ]
}
```

Use `--input -` for stdin, `--top 3` to override the survivor budget, and
`--output result.json` for a file handoff. `jevrev rank` and the `specjev` binary
remain compatibility aliases.

The complete protocol, field limits, reason codes, and exit codes are in
[docs/PROTOCOL.md](docs/PROTOCOL.md).

## For agent authors

The repository includes [skills/jevrev/SKILL.md](skills/jevrev/SKILL.md).
The calling convention is short:

1. State the goal, constraints, success criteria, and implementation budget.
2. Draft 3-7 materially different candidate cards.
3. Run `jevrev run --input request.json --format json`.
4. Implement only `selected`; send `review` items to a human or another pass.
5. Verify the result with real tests and measurements.

No repository contents are sent unless the calling agent includes them in the
request. Credentials are read from the environment and never printed.

## Development

```bash
npm install
npm run check
npm test
npm run build
npm run demo:all
npm pack --dry-run
```

Node.js 20 or newer is required. The package includes the compiled CLI,
protocol docs, examples, local-provider scripts, runtime, and the JevRev skill.
See [RELEASE.md](RELEASE.md) for the release checklist.

## Boundaries

JevRev stops at the shortlist. It does not edit a repository, create worktrees,
run an implementation, merge a patch, or replace a test suite. Those boundaries
keep the tool useful inside the workflows agents already use.

## License

[MIT](LICENSE)
