# JevRev TUI Design and Integration

Status: implementation design and review record for the three-page CLI cockpit.

Human attention acceptance remains open. See [the developer trial
method](DEVELOPER_TRIAL.md) and [current technical acceptance
record](DEVELOPER_TRIAL_2026-10-02.md); terminal/state checks do not measure a
participant's understanding time or missed interruptions.

## Product decisions

1. The CLI TUI has exactly three top-level pages, in this order: Sessions,
   Kanban, Config.
2. The page indicator is centered at the bottom. The current page is a filled
   circle; the other two are hollow circles.
3. A thin horizontal rule separates the title from the page body. The page
   layout avoids vertical rules and heavy box borders.
4. `jevrev` with no subcommand opens the TUI in an interactive terminal even
   when the project has no Long store. Starting a JevRev component also opens
   it after its result is emitted when project configuration allows it.
   Machine/CI pipes never receive terminal control sequences.
5. `jevrev` with no subcommand reopens the project TUI at the last page and
   selected session. `jevrev --no-tui <component> ...` and `JEVREV_NO_TUI=1`
   suppress automatic open.
6. Component use always records session state when possible; auto-open is a
   separate preference. Disabling the TUI does not disable JevLong observation
   or prevent session records from being indexed.
7. The TUI is a viewer and project preference editor. It does not drive an
   agent, retry work, modify a frozen Loop contract, or claim unverified work.
   Its Loop/Long switches persist which observers are bound to the selected
   session; they never start a host agent.

## Pages

### Sessions

- Lists recent Codex, Claude, OpenCode, and other host sessions alongside
  JevSift, JevLoop, and JevLong component sessions.
- Shows component, lifecycle status, elapsed session age, and recorded agent
  work duration.
- The adjacent preview shows goal, latest summary, details, and Kanban counts.
- Up/down selects a session; Enter opens its Kanban page.
- Session ID remains internal unless shown in detailed diagnostics.

### Kanban / monitor

- Three lanes: In Progress, Needs Attention, Verified.
- A prominent Loop Monitor and Long Monitor switch sits above the lanes.
- Space persists the selected switch; `l` and `o` select Loop and Long. An
  enabled switch with no bound store is shown as armed and waiting for host
  evidence, rather than pretending that observation has started.
- A bound Loop or Long directory is displayed so the operator can verify what
  the switch actually controls.
- JevSift candidates are marked as selected/review/probe-ready, not verified.
- JevLoop records active round, pause reason, and accepted evidence/progress.
- JevLong records unfinished milestones, open alerts, and trusted passed
  milestones. Imported/self-reported milestone claims never enter Verified.
- Empty lanes remain visible so absence of work is explicit.

### Config

- Project-local file: `.jevrev/ui/config.json`.
- `auto_open_on_component` defaults to true; Space toggles it and saves.
- Refresh interval is adjustable in 250ms increments, bounded from 250ms to
  10s; changes save immediately.
- Color is independently toggleable.
- `JEVREV_UI_DATA_DIR` relocates UI config, session index, and navigation state
  for tests or managed environments.

## Trigger and lifecycle

```text
jevrev sift/run/rank/decide ─┐
jevrev loop create ──────────┼─> persist project session record
jevrev long create ──────────┘             │
                                           ├─ interactive + enabled -> open Kanban
                                           └─ piped/disabled          -> return normally

jevrev (no subcommand) -> open last page/session, including an empty project
long ingest/status     -> update/inspect without opening the TUI
long watch (interactive) -> open the project cockpit on the Long session
long watch (piped)    -> emit compact/full watch output
host session register -> persist host identity and monitoring switches
```

The CLI remains foreground-owned while the TUI is visible. `q` exits and
restores the prior terminal screen; it does not stop a Long observer or abort a
Loop. Reopening with `jevrev` reconstructs pages from local records and stores.
This first implementation does not install a daemon or global keyboard hook.

## Module boundaries and data flow

| Module | Owns | Does not own |
| --- | --- | --- |
| `src/tui/store.ts` | Validated project UI config, navigation state, host/component session index, monitoring bindings, discovery | Jev scoring or component lifecycle |
| `src/tui/sessions.ts` | Adapters from Sift/Loop/Long persisted state into UI session records | Component writes, agent execution |
| `src/tui/app.ts` | Three-page navigation, terminal lifecycle, render loop, config interaction | Component policy and evidence validity |
| `src/tui.ts` | Long-specific rendering helpers retained for status/watch compatibility | Global app routing |
| `src/cli.ts` | Component activation hooks, no-TUI override, output-before-TUI ordering | TUI screen content |
| component stores | Authoritative contracts, events, evidence, status | UI navigation state |

Session index records are derived summaries, not authority. Host adapters use
`jevrev session register --host codex|claude|opencode|other` to publish a
stable host session ID; JevRev does not scrape private Codex or Claude
transcript directories. The source of truth remains the Sift output/campaign,
Loop hash-chained journal, or Long event journal. Before each repaint the app refreshes indexed Loop and Long summaries
from discoverable local stores, then reads the index for the session list. This
keeps incoming Long events visible without a daemon or provider call. Index
write failure does not invalidate the underlying component operation; it emits
a stderr warning.

The record's `agent_work_ms` is supplied from measured Loop round evidence.
Sift and Long do not know how long an agent spent working, so their previews
say “not recorded”; Jev invocation time and session wall-clock age are not
presented as agent work or implementation time.

## Keyboard contract

| Key | Action |
| --- | --- |
| Left / Right | Previous / next top-level page |
| Up / Down | Select session, monitor switch, or Config setting |
| Enter | Open selected session Kanban |
| `c` | Open Config |
| Space | Toggle selected monitor or Config setting |
| `l` / `o` | Select the Loop / Long monitor switch |
| `+` / `-` | Adjust selected refresh interval |
| `s` | Save Config explicitly |
| `q` / Ctrl-C | Exit and restore terminal |

## Terminal constraints

- Render a bounded frame with explicit CRLF row boundaries; clear/repaint the
  alternate screen instead of appending frames to scrollback.
- Clamp frame dimensions to the terminal, with a compact minimum layout.
- Fit every visible row to the viewport; no decorative vertical separators.
- Hide cursor during the app and restore cursor, raw mode, and alternate screen
  in `finally`, including errors and user exit.
- Color is optional and ANSI escapes are excluded from width calculations.
- Piped invocations do not enter raw mode or emit screen-control sequences.

## Test and review checklist

- Renderer: each of the three pages, bottom page markers, exact bounded row and
  viewport counts, no vertical rules, content clipping, empty sessions/lanes.
- Store: schema rejection, default config, config and navigation persistence,
  session upsert preserves original start time, invalid/stale index recovery.
- Integration: Long create/ingest/status -> TUI record; Loop lifecycle -> one
  stable indexed session; Sift -> campaign and probe cards; winner remains
  unverified until integration evidence exists.
- Host integration: register Codex and Claude identities, select them from the
  Sessions page, toggle Loop/Long, and verify persisted monitor state with
  `jevrev session list --format json`.
- Terminal: page navigation, selection, config toggle/save, exit cleanup,
  non-TTY fallback, and no animation growth in the terminal scrollback.
- Distribution: README and Skill instructions match actual flags and behavior;
  package includes this design record and compiled app modules.

## Known limitations before release

- A TTY can be opened only in the process environment where the component
  command runs. Non-interactive agent hosts keep the session index and open the
  cockpit on the user's next `jevrev` command.
- Session discovery is project-local and bounded; it does not yet aggregate
  multiple repositories into one global dashboard.
- Config covers auto-open, refresh interval, and color. Per-session Loop/Long
  monitoring switches live on the Kanban page; notification routing remains a
  follow-up decision.
- Session records are summaries. The detailed immutable evidence stays in the
  component stores and should be opened from a future detail interaction.
