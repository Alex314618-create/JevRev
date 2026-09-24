# JevRev

<p align="center">
  <img src=".github/assets/jevrev-banner.png" alt="JevRev wordmark with skull illustration" width="620" />
</p>

<p align="center"><strong>The decision layer beside your LLM.</strong></p>

<p align="center">
  <a href="README.md">English</a> · <a href="README.zh-CN.md">简体中文</a>
</p>

<p align="center">
  <a href="https://github.com/Alex314618-create/JevRev/releases"><img alt="Latest release" src="https://img.shields.io/github/v/release/Alex314618-create/JevRev?style=flat-square&amp;color=555555&amp;labelColor=333333" /></a>
  <a href="package.json"><img alt="Node.js 20 or newer" src="https://img.shields.io/badge/Node.js-%3E%3D20-555555?style=flat-square&amp;labelColor=333333" /></a>
  <a href="LICENSE"><img alt="MIT license" src="https://img.shields.io/badge/License-MIT-555555?style=flat-square&amp;labelColor=333333" /></a>
</p>

> Shortlist the options. Score in a loop. Watch the run.

Your LLM can imagine, write, test, and revise. It should not have to make every
cheap routing decision by itself.

JevRev puts Jev beside the LLM: a semantic layer that filters
plans, checks progress, and keeps attention on the work worth continuing. The
LLM supplies breadth and implementation power. JevRev supplies the second look
before more time and tokens are spent.

That is JevRev: not another coding agent, but the decision system around one.

## See the idea

The included case asks for a faster CSV parser. The LLM proposes a tempting
regex shortcut and a more careful state machine. The shortcut wins the paper
ranking, then fails the correctness check. The state machine is slower, passes
the same checks, and becomes the evidence winner.

<picture>
  <source media="(max-width: 600px)" srcset=".github/assets/jevrev-decision-gate-mobile.svg">
  <img src=".github/assets/jevrev-decision-gate.svg" alt="The paper favorite regex shortcut fails required correctness; the second-ranked state machine passes and wins after both receive the same probes.">
</picture>

Run the complete case:

```bash
git clone https://github.com/Alex314618-create/JevRev.git
cd JevRev
npm install
npm run build
npm run demo:workflow
```

The Jev answers are replayed for a deterministic demo. The implementations,
correctness checks, benchmark samples, output digests, and final decision are
real:

```text
Paper favorite: regex-shortcut
  correctness command: failed
  result: rejected

Evidence winner: indexed-state-machine
  correctness command: passed
Decision: winner -> integrate_winner
```

Inspect the [executed probe](benchmarks/workflow-fixture/probe.mjs),
[demo driver](scripts/run-workflow-demo.mjs), and
[decision tests](tests/workflow-decide.test.ts). The measured throughput varies
by machine; the required correctness failure is what reverses the ranking.

For a longer, zero-context run against a real JSONL ingestion problem, see the
[recorded case](benchmarks/real-jsonl-ingestion/README.md). It includes the
actual failed shortcut, the evidence that rejected it, three Loop rounds, and
the Long observer output.

## The three parts

<picture>
  <source media="(max-width: 600px)" srcset=".github/assets/jevrev-product-roles-mobile.svg">
  <img src=".github/assets/jevrev-product-roles.svg" alt="JevSift selects paths, JevLoop audits one artifact, and read-only JevLong watches the session. Probe, Evidence, and Decide are shared workflow boundaries; Sift and Loop keep separate state machines.">
</picture>

### JevSift: choose the work

The host LLM proposes a few materially different approaches. JevSift removes
weak, duplicate, risky, or low-value paths before they consume implementation
budget, then emits bounded work orders for the survivors.

### JevLoop: improve one artifact

The host agent executes a bounded work order, records what actually happened,
and submits the round to JevLoop. Loop checks the evidence, asks Jev only the
narrow questions that facts cannot settle, and returns the next action: continue,
fix, verify, replan, wait for a human, or finish when every criterion is proven.

This is where `Probe`, `Evidence`, and `Decide` belong in the product story:
they are Loop's working machinery, not another product surface.

### JevLong: watch the session

JevLong observes a long-running agent session and reports stalls, repeated
failures, drift, tool-call problems, budget risk, and progress to a human. It
does not silently steer, retry, edit, or kill the agent.

`long watch` is the live terminal cockpit. In a non-interactive shell it emits
one compact status by default; use `--stream` for continuous background sampling
or `--iterations N` for a fixed sample count. Use `long status --format json`
when another tool needs the full snapshot.

The result is a simple split: the LLM does the expensive creative work, while
JevRev prevents the workflow from repeatedly paying for bad directions.

## Use it from Codex

Build the CLI and install the bundled skill into Codex:

```bash
npm install
npm run build
node scripts/install-skill.mjs --target codex
```

Installing the skill does not put `jevrev` on PATH. Confirm
`jevrev --version` before use. In a project with a local JevRev dependency,
use `npx --no-install jevrev --version` and prefix the skill's commands with
`npx --no-install` when the bare command is unavailable.

Then give the host agent this instruction:

```text
Use JevRev for this task. Propose materially different approaches, ask JevRev
to sift them, run only the bounded probes, record the evidence, and let JevRev
audit the next round before continuing.
```

## The interaction layer

JevRev is a command-line protocol that the host LLM calls at decision points.
You stay in Codex, Claude Code, or another agent; JevRev does not replace that
agent and does not need to run a second conversation beside it.

The exchange is deliberately plain:

```text
host agent writes proposals.json
        -> jevrev sift        -> bounded work orders
host agent implements and tests a survivor
        -> evidence run/metric/artifact -> evidence.json
        -> jevrev decide or loop audit -> next action
host adapter sends session JSONL
        -> jevrev long ingest/watch -> status and alerts for a human
```

The input and output are JSON, so an agent can call JevRev as a normal tool,
save every decision, and resume after an interruption. Human control stays at
the meaningful boundaries: define or change the contract, choose a provider,
approve a resume, abort a loop, and decide whether a reported winner is
integrated. JevRev can reject an incomplete or failed path and return
`continue`, `fix_regression`, `verify`, `replan`, `waiting_human`, or
`completed`; it cannot edit the repository, start or stop the host agent, merge
a branch, or silently continue in the background.

That is the practical role of the interaction layer: it turns an LLM's free
form reasoning into inspectable work orders, recorded facts, and typed next
actions without taking the work away from the LLM or the final decision away
from the user.

## The command surface

| Command | Role in the LLM + Jev workflow |
| --- | --- |
| `jevrev sift` | Decide which proposed approaches deserve a probe |
| `jevrev loop` | Audit one artifact after each agent round |
| `jevrev long` | Observe the health of a long-running session |

`jevrev evidence` and `jevrev decide` are lower-level infrastructure commands.
They record and adjudicate the facts that JevSift and JevLoop consume; they are
not a fourth and fifth product component.

From source, use `node dist/cli.js` in place of `jevrev`:

```bash
node dist/cli.js sift --input examples/parser-speedup.json --replay examples/parser-jev-response.json
```

For an agent handoff, keep the complete campaign on disk and return only a
short navigation summary:

```bash
node dist/cli.js sift --input examples/parser-speedup.json \
  --replay examples/parser-jev-response.json --format json \
  --output campaign.json --summary
```

## Providers

JevRev keeps the decision boundary the same whether Jev is hosted, local, or
replayed:

Hosted Jev in a POSIX shell:

```bash
export JEVREV_JEV_API_KEY="..."
node dist/cli.js sift --input examples/parser-speedup.json --provider jev \
  --output campaign.json --summary
```

Local SemIf through llama.cpp on Windows:

```powershell
powershell -ExecutionPolicy Bypass -File scripts/start-semif.ps1 -Background
node dist/cli.js sift --input examples/parser-speedup.json --provider semif \
  --output campaign.json --summary
```

Replay fixtures work without a network or API key. See
[`docs/SEMIF_LOCAL.md`](docs/SEMIF_LOCAL.md) for the local model setup.

## One brief, two outcomes

JevRev is useful beyond code paths. The repository includes two pages made from
the same brief: a conventional first pass and a JevRev-routed evidence dossier.

<table>
  <tr>
    <th width="50%">First pass</th>
    <th width="50%">JevRev route</th>
  </tr>
  <tr>
    <td><img src=".github/assets/one-shot-showcase/direct-hero.png" alt="Conventional first-pass page" /></td>
    <td><img src=".github/assets/one-shot-showcase/routed-hero.png" alt="JevRev-routed evidence dossier" /></td>
  </tr>
</table>

The point is not a magic visual score. It is that the route chosen by Jev can
change the artifact's structure, evidence, and final direction together.
See the [source pages](benchmarks/one-shot-showcase/README.md) and their
[validation record](benchmarks/one-shot-showcase/VALIDATION.md) before comparing
the screenshots.

## Read next

- [Workflow guide](docs/WORKFLOW.md)
- [Protocol and JSON contracts](docs/PROTOCOL.md)
- [Authority model](docs/AUTHORITY.md)
- [JevLoop design](docs/JEVLOOP_DESIGN.md)
- [JevLong design](docs/JEVLONG_DESIGN.md)
- [Acceptance record](docs/ACCEPTANCE.md)

## Development

```bash
npm install
npm run check
npm test
npm run build
npm run demo:all
npm run demo:workflow
npm run demo:loop
npm run demo:engineering
```

Node.js 20 or newer is required. JevRev is MIT licensed.

## Contributing

The most useful contribution is a recorded decision case: a real task you ran
through JevRev, the route it picked, and the evidence behind it. Negative results
count, and so does a task where Sift was correctly skipped.

See [`CONTRIBUTING.md`](CONTRIBUTING.md) for the contribution surface, the setup
steps, and the claims this project cannot make. Contributors are listed in
[`AUTHORS.md`](AUTHORS.md).

[MIT](LICENSE)
