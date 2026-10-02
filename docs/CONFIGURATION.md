# Provider configuration

Provider settings and project cockpit preferences are separate. Provider settings
live in a user configuration file; `.jevrev/ui/config.json` controls project TUI
auto-open, refresh and color. Neither monitor switches nor setup start an agent.

## When setup appears

With interactive stdin and stdout, the CLI checks configuration for a bare
`jevrev` invocation and `run`, `rank`, `sift`, `reconsider`, `decide`, `activation`,
`doctor`, `loop`, and `long` commands. The form appears when the resolved provider
is `jev` and no non-empty API key is available. Choosing `local` or `semif` does
not require a Jev key, but a running endpoint is still needed for live inference.

Help/version requests, pipes, `--no-tui`, and `JEVREV_NO_TUI=1` skip setup.
Replay does not itself suppress the form: use `--no-tui` for interactive offline
examples. Skipping setup does not disable loading an existing configuration.

Tab or up/down changes the field; Backspace edits; Enter advances or saves.
Esc/Ctrl-C closes the setup form without saving. The CLI then proceeds with the
requested command, so this is not a command-abort operation. To avoid a request
entirely, invoke help or exit the process before running the command.

## Storage and precedence

| Platform | Default file |
| --- | --- |
| Windows | `%APPDATA%/jevrev/config.json`, or `~/AppData/Roaming/jevrev/config.json` |
| macOS | `~/Library/Application Support/jevrev/config.json` |
| Linux | `$XDG_CONFIG_HOME/jevrev/config.json`, or `~/.config/jevrev/config.json` |

`JEVREV_CONFIG_PATH` overrides this location. Relative overrides resolve from the
current working directory. Avoid placing a credential file inside a repository.
The API key is stored as plaintext. Input masking and redacted terminal output
do not encrypt it. Files are written with mode `0600` on POSIX; on Windows,
access depends on filesystem ACLs. There is no OS keychain integration.

Defaults are overridden by saved settings, then environment settings. Explicit
CLI provider/endpoint/model options override those defaults. API keys are read
from configuration/environment, never a CLI key argument. The primary variables
are `JEVREV_PROVIDER`, `JEVREV_JEV_API_KEY`, `JEVREV_JEV_URL`,
`JEVREV_JEV_MODEL`, `JEVREV_LOCAL_URL`, `JEVREV_SEMIF_URL`, and
`JEVREV_SEMIF_MODEL`. Legacy aliases remain supported by `src/config.ts`.

Use non-empty environment values. An empty-but-defined primary variable is not
a reliable way to fall back to a stored value during CLI hydration; unset it
instead. `jevrev --no-tui doctor --format json` reports configuration without
displaying the key; it does not prove authenticated inference succeeds.

## Environment-only use and rollback

Set `JEVREV_JEV_API_KEY` in the process environment and run commands with
`--no-tui` to avoid saving a key. See the shell examples in the README.

To reset persisted provider settings, locate the file above (or the override),
then move it to a private backup outside source control or delete it. Also unset
provider environment overrides if you want the default setup form to return.
To restore the prior settings, restore the backup to the same path. Restart the
CLI after changing configuration. Treat any backup as a credential file too.

Configuration loading does not rewrite the file. Invalid or unreadable saved
settings fall back to defaults/environment; inspect the file locally if settings
appear missing, without pasting keys into bug reports.
