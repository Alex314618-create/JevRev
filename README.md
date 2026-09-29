# JevRev

<p align="center">
  <img src=".github/assets/jevrev-banner.png" alt="JevRev wordmark and illustration" width="620" />
</p>

<p align="center"><strong>An alloy spine for your LLM, built with Jev.</strong></p>

<p align="center">
  <a href="README.md">English</a> · <a href="docs/README.zh-CN.md">简体中文</a> · <a href="docs/README.ja.md">日本語</a>
</p>

<p align="center">
  <a href="https://github.com/Alex314618-create/JevRev/releases"><img alt="Latest release" src="https://img.shields.io/github/v/release/Alex314618-create/JevRev?style=flat-square&amp;color=555555&amp;labelColor=333333" /></a>
  <a href="package.json"><img alt="Requires Node.js 20 or newer" src="https://img.shields.io/badge/Node.js-%3E%3D20-555555?style=flat-square&amp;labelColor=333333" /></a>
  <a href="LICENSE"><img alt="MIT license" src="https://img.shields.io/badge/License-MIT-555555?style=flat-square&amp;labelColor=333333" /></a>
</p>

<p align="center">
  Jump to: <a href="#see-it-in-action">Examples</a> · <a href="#the-three-parts-in-detail">Sift / Loop / Long</a> · <a href="#quick-start-connect-any-agent">Connect an agent</a> · <a href="#tui-the-human-cockpit">TUI</a> · <a href="#connect-jev-or-a-local-model">Providers</a> · <a href="#read-next">Docs</a>
</p>

JevRev is an LLM + Jev system. Evolution gave animals a spine so they could make many decisions quickly and cheaply. JevRev applies the same split to a workflow: the LLM brings depth and range, while Jev brings very fast, low-cost decisions. Together they make the workflow more efficient.

The tool has three parts: **JevSift**, **JevLoop**, and **JevLong**.

At the start of a task, it lets the LLM spread out like an octopus. Each arm can reach for a different path, and weak or disappointing paths get cut away. That is **JevSift**. **JevLoop** audits and scores each round of work, then uses the result to decide what the agent should do next. Jev makes the workflow faster and cheaper, and the final result can be far better. We include concrete cases below. **JevLong** watches long, multi-round tasks for stalls, repeated failures, drift, tool-call problems, and budget risk.

Jev stays on the sidelines. It makes decisions, filters paths, and raises reminders. The LLM proposes and executes the work. JevRev communicates through a CLI and JSON protocol and leaves the session in the host agent's hands.

## See it in action

Here are a few examples that show what JevRev changes in practice.

### 1. Tidal City (start here)

<details>
<summary>Open the case: building TidalCity</summary>

The same model, ChatGPT-6-Sol-Ultra, ran the same prompt to build TidalCity, a city simulation that floods with the tide. Here is the benchmark version without Jev's involvement:

<p align="center">
  <img src=".github/assets/tidal-city/benchmark-01.jpg" alt="Tidal City benchmark 1" width="49%" />
  <img src=".github/assets/tidal-city/benchmark-02.jpg" alt="Tidal City benchmark 2" width="49%" />
</p>

It has a few simple buildings, roads, and a basic rising-water simulation. The model is rough, the controls are limited, and the roads and buildings are placed as disconnected pieces without much structure.

Here is the result built with JevRev, including JevSift, JevLoop, and JevLong:

<p align="center">
  <img src=".github/assets/tidal-city/jevrev-01.jpg" alt="Tidal City with JevRev 1" width="100%" />
</p>
<p align="center">
  <img src=".github/assets/tidal-city/jevrev-02.jpg" alt="Tidal City with JevRev 2" width="49%" />
  <img src=".github/assets/tidal-city/jevrev-03.jpg" alt="Tidal City with JevRev 3" width="49%" />
</p>
<p align="center">
  <img src=".github/assets/tidal-city/jevrev-04.jpg" alt="Tidal City with JevRev 4" width="49%" />
  <img src=".github/assets/tidal-city/jevrev-05.jpg" alt="Tidal City with JevRev 5" width="49%" />
</p>

The city is larger and the environment is much more fully built out. It has distinct districts, and almost every building has its own name. You can change the time of day, switch camera views, and use WASD to walk through the city or swim through the water.
</details>

### 2. JSONL event ingestion

<details>

<summary>Open the case: processing 25,000 JSONL events</summary>

The task was to make a pure Node 20 JSONL ingester handle 25,000 production-shaped events while meeting four requirements:

- isolate malformed lines;
- preserve first-seen order;
- emit each duplicate event only once;
- reach at least twice a conservative baseline throughput.

The input was about 2.3 MB, with 184 malformed/schema-invalid lines and 258 duplicate IDs.

**What JevSift did:**

Six approaches entered the sift. JevSift kept two strict survivors and sent one more to review:

| Approach | Sift score | Result |
| --- | ---: | --- |
| `batch-index` | 0.9243 | kept, sent to a real probe |
| `regex-shortcut` | 0.9240 | kept, sent to a real probe |
| `state-scan` | 0.7965 | cut off by the budget |
| `baseline-parse` | 0.6100 | rejected, low execution value |
| `worker-shards` | 0.6043 | review, not treated as approved |
| `external-index` | 0.4931 | rejected, low execution value |

Both survivors ran a correctness check and seven benchmark runs:

| Metric | `regex-shortcut` | `batch-index` |
| --- | ---: | ---: |
| Correctness | failed, expected 184 / actual 65 | passed |
| Mean throughput (events/s) | 180,530.90 | 180,317.21 |
| Sample standard deviation (n-1) | 8,567.37 | 10,486.05 |
| Decide | rejected | `winner` |

A one-shot workflow would pick regex. It is fast on paper, but it misses most malformed lines. JevRev chose `batch-index` because it met the task contract.

**What JevLoop did:**

1. Round 1: throughput passed, correctness failed; returned `fix_regression`.
2. Round 2: fresh correctness and maintenance evidence passed; returned `verify`.
3. Round 3: all criteria and the protected surface were submitted again on the same head; returned `completed`.

Final state: `completed`, round 3, with 838 ms wall-clock time and 1,628 tokens in replay provider accounting.

**What JevLong did:**

- accepted 13 events on the first import; accepted 0 on the duplicate import and identified 13 duplicates;
- ran `long status`, a multi-frame `long watch`, and `long loop-audit`;
- ended at sequence 14;
- reported a high-severity `failure_loop` alert and a critical `protocol` alert;
- The Loop reached `completed` while Long's `progress_index` remained 0.

</details>

## The three parts in detail

<picture>
  <source media="(max-width: 600px)" srcset=".github/assets/jevrev-product-roles-mobile.svg">
  <img src=".github/assets/jevrev-product-roles.svg" alt="JevSift chooses paths, JevLoop reviews one result, JevLong watches a long-running session" />
</picture>

### JevSift: decide what to try first

The LLM writes several genuinely different proposal cards. JevSift uses Jev for narrow questions, then deterministic policy handles duplicates and hard-constraint risk and creates probe work orders with budgets and stop conditions for the candidates that remain.

Sift answers one question: which directions deserve your token budget? The host agent still writes the code, runs the tests, and runs the benchmark.

If it is unclear whether a task deserves a Sift round, start with shadow activation:

```bash
jevrev activation --input activation.json --format json
```

It compares the expected cost of taking a wrong path with the cost of a few bounded probes and returns stable reason codes. It currently runs in shadow mode: it does not call Jev and does not start or skip Sift for you. See the [activation policy](docs/ACTIVATION.md) for the fields and the follow-up evaluation plan.

### JevLoop: let each round converge on evidence

The agent moves the work forward each round. JevLoop checks the result, reading the commands, tests, metrics, and artifacts recorded by the recorder. It confirms the facts first, then asks Jev what the result still needs. The next action can be `fix`, `verify`, `continue`, `replan`, or `human`, and the loop stops when the goal is actually met.

Loop follows one result. The agent acts, Loop reviews, and Jev decides. It does not take over the session or rubber-stamp a result that merely looks good. Every completion must be backed by replayable evidence.

### JevLong: keep long-running sessions visible and auditable

Long keeps reading the JSONL events written by the agent, records session progress, and detects stalls, repeated failures, drift, tool problems, and budget risk. It reports what happened, whether the session is still moving, and where attention is needed.

```bash
jevrev long watch --directory .jevrev/long
jevrev long status --directory .jevrev/long --format json
```

## Quick start: connect any Agent

JevRev connects to external agents through its CLI and JSON/JSONL contracts. Codex, Claude Code, OpenCode, CI workflows, and custom harnesses can all use the same protocol. Hosts with skill support can load the instructions; other hosts can call the CLI directly.

### Install

```bash
npm install
npm run build
node scripts/install-skill.mjs --target <codex|claude|agents|dsh>
```

Choose one `target` for the host you use. OpenCode and other custom hosts can use `--destination <host-skill-directory>`.

Prompt example:

```text
Use JevRev: complete this task with Sift, execute only selected approaches, record the evidence, run each round through Loop, and connect Long for long-running work.
```

Run the full example now:

```bash
npm run demo:workflow
```

## TUI: the human cockpit

Run `jevrev` in an interactive terminal to open the cockpit; a Long store is not
required. Sessions lists JevRev component sessions and host sessions registered
from Codex, Claude Code, OpenCode, or another agent:

```bash
jevrev session register --host codex --session-id <id> --title "..." --goal "..."
jevrev session list
```

Registration stores session metadata, not private host transcripts. Select a
session to open its **Kanban / Monitor** page. The Loop and Long switches persist
for that session and show whether an observer store is available; they do not
start an observer or steer the host agent.

| Page | What it shows |
| --- | --- |
| Sessions | Registered host sessions and JevRev component sessions |
| Kanban / Monitor | Work, evidence, risks, and the Loop / Long switches |
| Config | Auto-open, refresh interval, and terminal colors |

Use Up / Down to select a session, Enter to open it, and `l` / `o` plus `Space`
to change a monitor switch. Successful component commands can open the cockpit
focused on the updated session. Use `jevrev --no-tui ...` or `JEVREV_NO_TUI=1`
to suppress that automatic open. Without an interactive terminal, JevRev keeps
normal human/JSON output and emits no TUI control sequences.

## Connect Jev or a local model

Sift, Decide, and Loop audit use the same provider interface. You can connect to hosted Jev, local SemIf, or a replay file for offline runs. Keep credentials in environment variables; do not put them in command arguments, campaign files, or evidence.

### Hosted Jev

macOS / Linux:

```bash
export JEVREV_JEV_API_KEY="..."

node dist/cli.js sift \
  --input examples/parser-speedup.json \
  --provider jev \
  --output campaign.json
```

Windows PowerShell:

```powershell
$env:JEVREV_JEV_API_KEY = "..."

node dist/cli.js sift `
  --input examples/parser-speedup.json `
  --provider jev `
  --output campaign.json
```

For a custom Jev API address, set `JEVREV_JEV_URL` or pass
`--jev-url <api-root>`. The CLI sends requests to `/v1/systemone` on that address.

### Local SemIf

Windows:

```powershell
powershell -ExecutionPolicy Bypass `
  -File scripts/start-semif.ps1 -Background

node dist/cli.js sift `
  --input examples/parser-speedup.json `
  --provider semif `
  --output campaign.json
```

See [`docs/SEMIF_LOCAL.md`](docs/SEMIF_LOCAL.md) for starting, checking, and stopping the local model.

## Docs

- [Project cockpit design](docs/TUI_DESIGN.md)
- [Workflow](docs/WORKFLOW.md)
- [Activation policy](docs/ACTIVATION.md)
- [Protocol and JSON contracts](docs/PROTOCOL.md)
- [Authority model](docs/AUTHORITY.md)
- [JevLoop design](docs/JEVLOOP_DESIGN.md)
- [JevLong design](docs/JEVLONG_DESIGN.md)
- [Acceptance record](docs/ACCEPTANCE.md)

JevRev is released under the MIT license.

[MIT](LICENSE)
