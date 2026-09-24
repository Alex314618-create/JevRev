# Contributing to JevRev

Thanks for looking. JevRev is small and opinionated, and the contribution surface
is deliberately narrower than in most projects. This page says where that surface
is, so you do not spend an afternoon on something we cannot merge.

## The most useful thing you can send

A recorded decision case. If you ran a real task through JevRev, the run itself is
the contribution: the route it picked, the evidence it recorded, whether the pick
was right, and the numbers you measured on your machine.

Negative results are welcome. "Sift was the wrong tool for this task" is a useful
finding, and so is "Sift was correctly skipped here." A case where the workflow
adds nothing is evidence, not a failure.

Open a [decision case issue](.github/ISSUE_TEMPLATE/evidence-case.yml) with the
commands and their output. If you would rather send a fixture, a pull request
works too.

## What we can merge directly

- Documentation corrections: wrong commands, stale paths, or contradictions
  between README, `docs/WORKFLOW.md`, `docs/PROTOCOL.md`, and `docs/ACCEPTANCE.md`.
- New request examples under `examples/`.
- New replay fixtures and tests under `tests/` and `benchmarks/`.
- Fixes that make an existing, documented behavior match its documentation.

## What needs an issue first

Open an issue and let us agree on the shape before you write code:

- Anything that changes a JSON schema, a CLI contract, or a frozen spec.
- New product surface: new commands, new components, new output formats.
- Packaging, release automation, and CI configuration.

This rule exists to save you work. The build and release path changes most often,
so a patch against it tends to fall behind `main` before anyone can review it. An
issue is more likely to land.

## What we cannot accept

JevRev puts a hard floor under what the project is allowed to claim:

- No claim of zero cost, negligible latency, production quality, or guaranteed
  improvement without a recorded run behind it. If you measured something,
  include the command and the platform.
- No change that lets a model, a judge, or the runtime promote a lower-trust
  claim into a higher-trust fact.

[`docs/AUTHORITY.md`](docs/AUTHORITY.md) has the authority model in full. Read it
before you touch anything in the decision path.

## Setup

```bash
git clone https://github.com/Alex314618-create/JevRev.git
cd JevRev
npm install
npm run build
npm run demo:workflow
```

Node.js 20 or newer. The replay fixtures need no network and no API key. To point
the CLI at a hosted or local Jev instead, see
[`docs/SEMIF_LOCAL.md`](docs/SEMIF_LOCAL.md).

## Before you open a pull request

```bash
npm run check   # TypeScript, no emit
npm test        # vitest
npm run build
```

`npm run demo:all` runs the deterministic demonstrations. Run it, and the
Loop and Long demos, if your change touches either component.

## Pull request rules

- One change per pull request. A focused diff is reviewed faster.
- State what you measured, and give the machine and OS for any timing number.
- If your change alters a claim in the README or in `docs/`, update the acceptance
  record in [`docs/ACCEPTANCE.md`](docs/ACCEPTANCE.md) in the same pull request.
- If your change is a fix, include the failing case that motivated it.

## Where things live

| Path | What it holds |
| --- | --- |
| `src/` | CLI, schemas, decision engine, JevLoop, JevLong |
| `tests/` | vitest suites, including the workflow decision tests |
| `examples/` | request files and replay fixtures |
| `benchmarks/` | executed fixtures and their recorded results |
| `docs/` | workflow, protocol, authority model, acceptance record |
| `skills/` | the installable agent skill |
| `scripts/` | demo drivers, local model setup, release helpers |

## Review

We read every issue and pull request. A closed pull request comes with a reason
and a suggested path, including when the answer is no. If a pull request has
simply fallen behind `main`, we will say so, and the fix is usually to rebase and
reopen.

If something you sent has gone quiet, that was an oversight. A comment is a fair
reminder.

## Working with each other

Keep disagreements about the work. Explain the reasoning behind a position, and
assume the other person read the same files you did.

## License

JevRev is MIT licensed. By contributing, you agree that your contribution is
released under the same license. See [`LICENSE`](LICENSE).
