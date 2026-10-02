# Provider setup documentation verification — 2026-10-02

Baseline: upstream `265c9eaff6e6f18d72dbb7caa029d0ffd516f627`.

The three README languages and both install guides now distinguish masked input
from plaintext storage, name platform paths, explain environment/CLI precedence,
and document setup suppression and reset. `docs/CONFIGURATION.md` is the detailed
reference and is explicitly included in the npm package.

Checks executed on Windows with Node/npm from the local development environment:

- `npm run check` and `npm run build`: passed.
- Focused config/setup/TUI/activation tests: 4 files, 36 passed.
- `npx vitest run --maxWorkers=2 --testTimeout=20000`: 36 files, 339 passed.
- `npm pack --dry-run --ignore-scripts --json`: passed; configuration doc present.

No provider request or real API credential was needed. The documentation was
checked against `src/config.ts`, `src/tui/setup.ts`, and the CLI setup guard.
Notable existing behavior is stated explicitly: replay can still prompt on a
TTY; Esc exits the form, then the requested command continues. Empty-but-defined
environment variables are not advertised as fallback values.

Rollback: revert the commit titled `Document provider setup across three README
languages`. No runtime code, migration, generated config or user data is changed.
The historical P5 governance phase is retained; this record closes only this
bounded documentation task and does not claim current product completion.
