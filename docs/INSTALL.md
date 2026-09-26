# Install and use JevRev

## Requirements

- Git
- Node.js 20 or newer, with npm
- A shell: PowerShell or Command Prompt on Windows; Bash, Zsh, or another POSIX shell on macOS/Linux

JevRev's CLI, Sift, Loop, Long, replay provider, and hosted Jev provider use
the same Node.js package on Windows, macOS, and Linux.

## Install from the repository

The `jevrev` package is not currently available from the public npm registry.
Install from the source repository instead:

```text
git clone https://github.com/Alex314618-create/JevRev.git
cd JevRev
npm ci
npm run build
node dist/cli.js --version
npm run demo
```

The demo uses a captured Jev response, so it needs no API key or network access
to a model provider.

### Make `jevrev` available as a command

From the JevRev checkout, run:

```text
npm link
jevrev --version
```

`npm link` creates a global link to this checkout; it does not publish or copy
the package. Keep the checkout in place. If the command is not found, open a
new terminal and check that npm's global executable directory is on `PATH`.
Run `npm prefix -g` to see the configured global prefix. On Windows, npm puts
command shims in that prefix; on macOS and Linux, the executable directory is
usually the prefix's `bin` directory.

You can skip the global link and run the CLI from the checkout with
`node dist/cli.js` instead.

## Try a workflow without an API key

From the repository checkout:

```text
node dist/cli.js activation --input examples/activation-parser.json
node dist/cli.js sift --input examples/parser-speedup.json --replay examples/parser-jev-response.json
npm run demo:workflow
npm run demo:loop
npm run demo:engineering
```

`activation` is a local shadow assessment. The replay run exercises Sift
without contacting Jev. The workflow demo executes real probes and evidence
checks, while replaying Jev's decision response for repeatability.

For a real task, save the Sift request as JSON and call:

```text
jevrev sift --input proposals.json --provider jev --output campaign.json --summary
```

The CLI accepts a path or `-` for stdin, and supports JSON output for agent
handoffs. See [PROTOCOL.md](PROTOCOL.md) for the request and response
contracts.

## Configure hosted Jev

Set `JEVREV_JEV_API_KEY` in the current shell. Do not put the key in CLI
arguments, proposal files, evidence, or source control.

PowerShell:

```powershell
$env:JEVREV_JEV_API_KEY = '<your key>'
jevrev doctor --format json
jevrev sift --input proposals.json --provider jev --output campaign.json --summary
Remove-Item Env:JEVREV_JEV_API_KEY
```

Bash, Zsh, and other POSIX shells:

```sh
export JEVREV_JEV_API_KEY='<your key>'
jevrev doctor --format json
jevrev sift --input proposals.json --provider jev --output campaign.json --summary
unset JEVREV_JEV_API_KEY
```

The same CLI and key variable work on all three operating systems.

## Install the agent skill

The installer copies the bundled `SKILL.md`; it does not install the CLI. Run
it from the JevRev checkout after building:

```text
node scripts/install-skill.mjs --target codex
node scripts/install-skill.mjs --target claude
node scripts/install-skill.mjs --target opencode
node scripts/install-skill.mjs --target agents
```

The `opencode` target installs under `~/.config/opencode/skills/jevrev`.
The `agents` target installs under `~/.agents/skills/jevrev`, which OpenCode
and other Agent Skills-compatible hosts can discover. To install into a
project instead, pass the skill directory as the destination. For example,
use `.claude/skills/jevrev` for Claude Code or `.agents/skills/jevrev` for
OpenCode and other compatible hosts:

```text
node scripts/install-skill.mjs --destination .claude/skills/jevrev
```

Use the same commands in PowerShell, Bash, and Zsh. The installer uses the
current user's home directory for global targets and accepts native Windows
or POSIX destination paths.

## Local models

The CLI's HTTP adapters are not tied to an operating system. The bundled
SemIf model download/start/stop scripts and their pinned local model setup are
currently Windows PowerShell scripts. On macOS or Linux, run a compatible
SemIf endpoint yourself and pass its address with `--semif-url`; see
[SEMIF_LOCAL.md](SEMIF_LOCAL.md) for the request contract and Windows setup.

## Troubleshooting

- `node` or `npm` is not found: install Node.js 20 or newer, then open a new terminal.
- `jevrev` is not found after `npm link`: verify the global npm executable directory is on `PATH`, or use `node dist/cli.js` from the checkout.
- `Missing Jev API key`: set `JEVREV_JEV_API_KEY`, or use `--replay` / `--provider semif`.
- A skill is visible but commands fail: skill installation and CLI installation are separate; run `jevrev --version` in that host's shell.
- Local SemIf cannot connect: confirm the endpoint is listening on loopback or the configured `--semif-url`, then run `jevrev doctor --provider semif --check`.
