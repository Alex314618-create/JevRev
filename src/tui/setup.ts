import { loadConfig, configPath, hydrateEnvironmentFromConfig, isProviderConfigured, redactEndpoint, saveConfig, type ConfigPathOptions, type ConfigProvider, type JevRevConfig } from "../config.js";

type SetupInput = NodeJS.ReadStream & { setRawMode?: (mode: boolean) => void; resume?: () => void; pause?: () => void };
type SetupOutput = NodeJS.WriteStream;
type SetupToken = "previous" | "next" | "enter" | "backspace" | "quit" | `text:${string}`;

export interface SetupOptions extends ConfigPathOptions {
  input?: SetupInput;
  output?: SetupOutput;
  color?: boolean;
}

interface SetupState {
  provider: string;
  endpoint: string;
  apiKey: string;
  focus: 0 | 1 | 2;
  endpointDirty: boolean;
  error: string | undefined;
}

const ANSI = { reset: "\x1b[0m", cyan: "\x1b[36m", dim: "\x1b[2m", green: "\x1b[32m", red: "\x1b[31m", yellow: "\x1b[33m" } as const;
function paint(value: string, tone: keyof typeof ANSI, enabled: boolean): string { return enabled ? `${ANSI[tone]}${value}${ANSI.reset}` : value; }
function mask(value: string): string { return value.length === 0 ? "" : "*".repeat(Math.min(value.length, 32)); }
function line(value: string, width: number): string { const plain = value.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, ""); return plain.length >= width ? plain.slice(0, width) : `${value}${" ".repeat(width - plain.length)}`; }

function endpointFor(config: JevRevConfig, provider: string): string {
  return provider === "local" ? config.localUrl : provider === "semif" ? config.semifUrl : config.apiUrl;
}

export function renderSetup(state: SetupState, options: { width?: number; color?: boolean } = {}): string {
  const width = Math.max(64, options.width ?? 88); const color = options.color ?? false;
  const endpoint = redactEndpoint(state.endpoint);
  const rows = [
    "",
    paint("JevRev setup", "cyan", color),
    "First run: choose how JevRev should score work.",
    "Your key is masked while you type and is never printed to output.",
    "",
    `${state.focus === 0 ? ">" : " "} Provider       ${state.provider || "jev"}`,
    `${state.focus === 1 ? ">" : " "} ${state.provider === "local" ? "Local URL      " : state.provider === "semif" ? "SemIf URL      " : "Jev API URL    "}${endpoint}`,
    `${state.focus === 2 ? ">" : " "} Jev API key    ${mask(state.apiKey) || paint("not set", "dim", color)}`,
    "",
    paint("Tab / ↑↓  move    Enter  next / save    Backspace  edit    Esc  exit", "dim", color),
    state.error === undefined ? "" : paint(`Error: ${state.error}`, "red", color),
    "",
    paint("For a local scorer, set Provider to local and leave the key empty.", "yellow", color),
  ];
  return rows.map((row) => line(row, width)).join("\r\n");
}

function validProvider(value: string): value is ConfigProvider { return value === "jev" || value === "local" || value === "semif"; }

function validHttpEndpoint(value: string): boolean {
  try {
    const protocol = new URL(value).protocol;
    return protocol === "http:" || protocol === "https:";
  } catch {
    return false;
  }
}

/** Stateful terminal decoder. A CSI sequence can arrive in multiple data chunks. */
export class SetupInputDecoder {
  private pending = "";
  private escapeTimer: NodeJS.Timeout | undefined;

  public constructor(private readonly emit: (token: SetupToken) => void) {}

  public push(chunk: Buffer | string): void {
    this.pending += typeof chunk === "string" ? chunk : chunk.toString("utf8");
    this.parse();
  }

  public close(): void {
    if (this.escapeTimer !== undefined) clearTimeout(this.escapeTimer);
    this.escapeTimer = undefined;
    this.pending = "";
  }

  private parse(): void {
    while (this.pending.length > 0) {
      if (this.pending.startsWith("\u001b[A") || this.pending.startsWith("\u001bOA")) { this.pending = this.pending.slice(3); this.emit("previous"); continue; }
      if (this.pending.startsWith("\u001b[B") || this.pending.startsWith("\u001bOB")) { this.pending = this.pending.slice(3); this.emit("next"); continue; }
      if (this.pending === "\u001b" || this.pending === "\u001b[") { this.scheduleEscapeFlush(); return; }
      const character = this.pending[0]!;
      this.pending = this.pending.slice(1);
      if (character === "\u001b" || character === "\u0003") this.emit("quit");
      else if (character === "\t") this.emit("next");
      else if (character === "\r" || character === "\n") this.emit("enter");
      else if (character === "\u0008" || character === "\u007f") this.emit("backspace");
      else if (character >= " ") this.emit(`text:${character}`);
    }
    if (this.escapeTimer !== undefined) { clearTimeout(this.escapeTimer); this.escapeTimer = undefined; }
  }

  private scheduleEscapeFlush(): void {
    if (this.escapeTimer !== undefined) return;
    this.escapeTimer = setTimeout(() => {
      this.escapeTimer = undefined;
      if (this.pending.startsWith("\u001b")) {
        this.pending = this.pending.slice(1);
        this.emit("quit");
        this.parse();
      }
    }, 35);
  }
}

async function runSetup(input: SetupInput, output: SetupOutput, options: SetupOptions, initial: JevRevConfig): Promise<JevRevConfig | undefined> {
  const state: SetupState = { provider: initial.provider, endpoint: endpointFor(initial, initial.provider), apiKey: initial.apiKey ?? "", focus: 2, endpointDirty: false, error: undefined };
  let stopped = false;
  let saving = false;
  let resolveDone: ((value: JevRevConfig | undefined) => void) | undefined;
  const done = new Promise<JevRevConfig | undefined>((resolvePromise) => { resolveDone = resolvePromise; });
  const draw = (): void => { output.write(`\x1b[H\x1b[2J${renderSetup(state, { ...(output.columns === undefined ? {} : { width: output.columns }), color: options.color ?? true })}`); };
  const finish = (value: JevRevConfig | undefined): void => { if (stopped) return; stopped = true; resolveDone?.(value); };
  const submit = async (): Promise<void> => {
    if (saving) return;
    if (state.focus < 2) { state.focus = (state.focus + 1) as 0 | 1 | 2; draw(); return; }
    const provider = state.provider.trim().toLowerCase();
    if (!validProvider(provider)) { state.error = "Provider must be jev, local, or semif"; draw(); return; }
    const selectedEndpoint = state.endpointDirty || provider === initial.provider ? state.endpoint.trim() : endpointFor(initial, provider);
    if (!validHttpEndpoint(selectedEndpoint)) { state.error = "Endpoint must use http or https"; draw(); return; }
    if (provider === "jev" && state.apiKey.trim().length === 0) { state.error = "Enter a Jev API key, or choose local/semif"; draw(); return; }
    const { apiKey: _oldApiKey, ...withoutApiKey } = initial;
    const config: JevRevConfig = provider === "jev"
      ? { ...withoutApiKey, provider: "jev", apiUrl: selectedEndpoint, ...(state.apiKey.trim().length === 0 ? {} : { apiKey: state.apiKey.trim() }) }
      : provider === "local"
        ? { ...withoutApiKey, provider: "local", localUrl: selectedEndpoint }
        : { ...withoutApiKey, provider: "semif", semifUrl: selectedEndpoint };
    saving = true;
    try { await saveConfig(config, configPath(options)); finish(config); }
    catch (error) { state.error = error instanceof Error ? error.message : "Could not save configuration"; draw(); }
    finally { saving = false; }
  };
  const onToken = (token: SetupToken): void => {
    if (saving || stopped) return;
    if (token === "quit") { finish(undefined); return; }
    if (token === "next") { state.focus = ((state.focus + 1) % 3) as 0 | 1 | 2; state.error = undefined; draw(); return; }
    if (token === "previous") { state.focus = ((state.focus + 2) % 3) as 0 | 1 | 2; state.error = undefined; draw(); return; }
    if (token === "enter") { void submit(); return; }
    if (token === "backspace") { if (state.focus === 0) state.provider = state.provider.slice(0, -1); else if (state.focus === 1) { state.endpoint = state.endpoint.slice(0, -1); state.endpointDirty = true; } else state.apiKey = state.apiKey.slice(0, -1); state.error = undefined; draw(); return; }
    if (!token.startsWith("text:")) return;
    const text = token.slice(5); if (state.focus === 0) state.provider += text; else if (state.focus === 1) { state.endpoint += text; state.endpointDirty = true; } else state.apiKey += text; state.error = undefined; draw();
  };
  const decoder = new SetupInputDecoder(onToken);
  const onData = (chunk: Buffer | string): void => decoder.push(chunk);
  draw(); input.setRawMode?.(true); input.resume?.(); input.on("data", onData);
  try { return await done; }
  finally { decoder.close(); input.off("data", onData); input.setRawMode?.(false); input.pause?.(); }
}

/** Prompt once on a TTY, then persist and hydrate the selected provider. */
export async function ensureProviderSetup(options: SetupOptions = {}): Promise<JevRevConfig | undefined> {
  const config = await loadConfig(options);
  if (isProviderConfigured(config)) {
    await hydrateEnvironmentFromConfig(options);
    return config;
  }
  const input = options.input ?? process.stdin;
  const output = options.output ?? process.stdout;
  const configured = await runSetup(input, output, options, config);
  if (configured !== undefined) await hydrateEnvironmentFromConfig(options);
  return configured;
}
