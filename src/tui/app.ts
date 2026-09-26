import { DEFAULT_TUI_MONITORING, discoverTuiSessions, readTuiConfig, readTuiNavigation, setSessionMonitoring, writeTuiConfig, writeTuiNavigation, type TuiConfig, type TuiSessionRecord } from "./store.js";
import { refreshRegisteredSessions } from "./sessions.js";

type Screen = "sessions" | "kanban" | "config";
type Input = NodeJS.ReadStream & { setRawMode?: (mode: boolean) => void };
type Output = NodeJS.WriteStream;

interface ViewState { screen: Screen; selectedSession: number; selectedSessionId: string | null; selectedConfig: number; selectedMonitor?: number; }
interface AppOptions { initialScreen?: Screen; initialSessionId?: string; intervalMs?: number; input?: Input; output?: Output; }

const C = { reset: "\x1b[0m", dim: "\x1b[2m", bold: "\x1b[1m", cyan: "\x1b[36m", teal: "\x1b[32m", yellow: "\x1b[33m", magenta: "\x1b[35m", red: "\x1b[31m", gray: "\x1b[90m" } as const;
type Tone = keyof typeof C;
function color(text: string, tone: Tone, enabled: boolean): string { return enabled ? `${C[tone]}${text}${C.reset}` : text; }
const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]/g;
function visible(value: string): string { return value.replace(ANSI, ""); }
function fit(value: string, width: number): string { const plain = visible(value); return plain.length >= width ? plain.slice(0, width) : value + " ".repeat(width - plain.length); }
function line(width: number, enabled: boolean): string { return color("─".repeat(width), "gray", enabled); }
function center(value: string, width: number): string { const plain = visible(value); const left = Math.max(0, Math.floor((width - plain.length) / 2)); return `${" ".repeat(left)}${value}`; }
function elapsed(ms: number | null): string { if (ms === null) return "not recorded"; const total = Math.floor(Math.max(0, ms) / 1_000); const h = Math.floor(total / 3_600); const m = Math.floor(total % 3_600 / 60); const s = total % 60; return h ? `${h}h ${String(m).padStart(2, "0")}m` : m ? `${m}m ${String(s).padStart(2, "0")}s` : `${s}s`; }
function age(started: string, now: number): string { const stamp = Date.parse(started); return Number.isFinite(stamp) ? elapsed(now - stamp) : "unknown"; }

function statusTone(status: TuiSessionRecord["status"]): Tone { return status === "active" ? "teal" : status === "paused" ? "yellow" : status === "aborted" ? "red" : "gray"; }
function componentName(value: TuiSessionRecord["component"]): string { return value === "long" ? "JevLong" : value === "loop" ? "JevLoop" : value === "session" ? "Host session" : "JevSift"; }
function sourceName(session: TuiSessionRecord): string { return session.source === "host" && session.host !== undefined ? session.host.toUpperCase() : componentName(session.component); }

function sessionsPage(sessions: readonly TuiSessionRecord[], selected: number, width: number, height: number, enabled: boolean): string[] {
  const rows: string[] = [];
  if (sessions.length === 0) {
    rows.push(color("SESSIONS", "bold", enabled)); rows.push(""); rows.push(color("No JevRev sessions in this project yet.", "gray", enabled));
    rows.push("No session is registered yet. A host can register its Codex or Claude session here.");
    return rows;
  }
  const selectedSession = sessions[Math.max(0, Math.min(selected, sessions.length - 1))]!;
  const listWidth = Math.max(28, Math.floor(width * 0.48));
  const rightWidth = Math.max(20, width - listWidth - 2);
  const join = (left: string, right: string): string => `${fit(left, listWidth)}  ${fit(right, rightWidth)}`;
  rows.push(join(color(`SESSIONS  ${sessions.length}`, "bold", enabled), color("PREVIEW", "bold", enabled)));
  rows.push(join("SESSION · SOURCE · AGE · AGENT WORK", selectedSession.title));
  rows.push(line(width, enabled));
  const visibleCount = Math.max(1, height - 12);
  const start = Math.max(0, Math.min(selected - Math.floor(visibleCount / 2), sessions.length - visibleCount));
  const displayed = Math.min(sessions.length, start + visibleCount);
  const preview = [
    `${componentName(selectedSession.component)} · ${selectedSession.status.toUpperCase()}`,
    `Session age  ${age(selectedSession.started_at, Date.now())}`,
    `Agent work   ${elapsed(selectedSession.agent_work_ms)}`,
    `Latest       ${selectedSession.summary}`,
    `Goal         ${selectedSession.goal}`,
    ...selectedSession.details.slice(0, 4).map((detail) => `· ${detail}`),
  ];
  for (let i = start; i < Math.max(displayed, start + preview.length); i += 1) {
    const session = sessions[i]!;
    const marker = i < displayed && i === selected ? color("›", "cyan", enabled) : " ";
    const left = i < displayed && session !== undefined ? `${marker} ${session.title} · ${sourceName(session)} · ${age(session.started_at, Date.now())} · ${elapsed(session.agent_work_ms)}` : "";
    rows.push(join(left, preview[i - start] ?? ""));
  }
  return rows;
}

function monitorLine(marker: string, label: string, active: boolean, binding: string, enabled: boolean): string {
  const state = active ? color("ON", "teal", enabled) : color("OFF", "gray", enabled);
  return `${marker} ${label.padEnd(13, " ")} [${state}]  ${binding}`;
}

function kanbanPage(session: TuiSessionRecord | undefined, width: number, enabled: boolean, selectedMonitor: number): string[] {
  if (session === undefined) return [color("No session selected", "gray", enabled)];
  const monitoring = session.monitoring ?? DEFAULT_TUI_MONITORING;
  const loopBinding = session.loop_directory === undefined ? "armed; waiting for a Loop store" : session.loop_directory;
  const longBinding = session.long_directory === undefined ? "armed; waiting for Long events" : session.long_directory;
  const rows = [color(`MONITOR / KANBAN   ${session.title}`, "bold", enabled), session.goal, ""];
  rows.push(color("OBSERVATION SWITCHES", "bold", enabled));
  rows.push(monitorLine(selectedMonitor === 0 ? color("›", "cyan", enabled) : " ", "LOOP MONITOR", monitoring.loop, loopBinding, enabled));
  rows.push(monitorLine(selectedMonitor === 1 ? color("›", "cyan", enabled) : " ", "LONG MONITOR", monitoring.long, longBinding, enabled));
  rows.push(color("Space toggles the selected monitor; l/o selects Loop/Long.", "gray", enabled), "");
  const colWidth = Math.max(12, Math.floor((width - 4) / 3));
  const columns = [
    { name: "IN PROGRESS", items: session.kanban.in_progress, tone: "cyan" as Tone },
    { name: "NEEDS ATTENTION", items: session.kanban.attention, tone: "yellow" as Tone },
    { name: "VERIFIED", items: session.kanban.verified, tone: "teal" as Tone },
  ];
  rows.push(columns.map((column) => fit(color(column.name, column.tone, enabled), colWidth)).join("  "));
  rows.push(line(width, enabled));
  const count = Math.max(...columns.map((column) => column.items.length), 1);
  for (let row = 0; row < count; row += 1) {
    rows.push(columns.map((column) => {
      const value = column.items[row];
      return fit(value === undefined ? "" : `· ${value}`, colWidth);
    }).join("  "));
  }
  rows.push(""); rows.push(line(width, enabled));
  rows.push(`${color("Source", "gray", enabled)} ${sourceName(session)}    ${color("Status", "gray", enabled)} ${color(session.status.toUpperCase(), statusTone(session.status), enabled)}    ${color("Session age", "gray", enabled)} ${age(session.started_at, Date.now())}    ${color("Agent work", "gray", enabled)} ${elapsed(session.agent_work_ms)}`);
  rows.push(`${color("Summary", "gray", enabled)} ${session.summary}`);
  for (const detail of session.details.slice(0, 4)) rows.push(`· ${detail}`);
  return rows;
}

function configPage(config: TuiConfig, selected: number, enabled: boolean): string[] {
  const rows = [color("CONFIG", "bold", enabled), "Project settings   ·   .jevrev/ui/config.json", "", color("LAUNCH", "gray", enabled)];
  const fields = [
    `Open TUI after a JevRev component starts   ${config.auto_open_on_component ? "On" : "Off"}`,
    `Refresh interval                           ${config.refresh_ms} ms`,
    `Use terminal color                         ${config.color ? "On" : "Off"}`,
  ];
  fields.forEach((field, index) => rows.push(`${index === selected ? color("›", "cyan", enabled) : " "} ${field}`));
  rows.push("", color("Changes apply to this project only.", "gray", enabled));
  rows.push("↑/↓ select   Space toggle   +/- refresh interval   s save");
  return rows;
}

export function renderTuiPage(sessions: readonly TuiSessionRecord[], config: TuiConfig, state: ViewState, options: { width?: number; height?: number; now?: number } = {}): string {
  const width = Math.max(40, options.width ?? 100); const height = Math.max(12, options.height ?? 28); const enabled = config.color;
  const selected = sessions[state.selectedSession];
  const screenIndex = state.screen === "sessions" ? 0 : state.screen === "kanban" ? 1 : 2;
  const heading = `${color("JevRev", "cyan", enabled)}   ${selected === undefined ? "Project sessions" : `${componentName(selected.component)}  ·  ${selected.title}`}`;
  const rows = [fit(heading, width), line(width, enabled)];
  const content = state.screen === "sessions" ? sessionsPage(sessions, state.selectedSession, width, height, enabled)
    : state.screen === "kanban" ? kanbanPage(selected, width, enabled, state.selectedMonitor ?? 0)
      : configPage(config, state.selectedConfig, enabled);
  const bodyHeight = height - 5;
  for (let index = 0; index < bodyHeight; index += 1) rows.push(fit(content[index] ?? "", width));
  rows.push(line(width, enabled));
  rows.push(fit("←/→ page   ↑/↓ select   Enter open   c config   Space toggle monitor   q quit", width));
  const circles = [0, 1, 2].map((index) => index === screenIndex ? color("●", "cyan", enabled) : color("○", "gray", enabled)).join("     ");
  rows.push(fit(center(circles, width), width));
  return rows.slice(0, height).join("\r\n");
}

function decode(chunk: Buffer | string): string {
  const value = typeof chunk === "string" ? chunk : chunk.toString("utf8");
  if (value === "\u001b[D" || value === "\u001bOD") return "left";
  if (value === "\u001b[C" || value === "\u001bOC") return "right";
  if (value === "\u001b[A" || value === "\u001bOA" || value === "k") return "up";
  if (value === "\u001b[B" || value === "\u001bOB" || value === "j") return "down";
  if (value === "\r" || value === "\n") return "enter";
  if (value === " ") return "space";
  if (value === "q" || value === "\u0003") return "quit";
  if (value === "c") return "config";
  if (value === "l") return "loop";
  if (value === "o") return "long";
  if (value === "+" || value === "=") return "increase";
  if (value === "-") return "decrease";
  if (value === "s") return "save";
  return "other";
}

export async function openTui(root = process.cwd(), options: AppOptions = {}): Promise<void> {
  const input = options.input ?? process.stdin; const output = options.output ?? process.stdout;
  const config = await readTuiConfig(root); let sessions = await discoverTuiSessions(root);
  let refreshInterval = options.intervalMs ?? config.refresh_ms;
  const navigation = await readTuiNavigation(root);
  let state: ViewState = { screen: options.initialScreen ?? navigation.page, selectedSession: 0, selectedSessionId: options.initialSessionId ?? (options.initialScreen === undefined ? navigation.session_id : null), selectedConfig: 0, selectedMonitor: 0 };
  if (state.screen === "kanban" && sessions.length === 0) state.screen = "sessions";
  let timer: NodeJS.Timeout | undefined; let doneResolve: (() => void) | undefined; let doneReject: ((error: unknown) => void) | undefined; let renderBusy = false; let renderPending = false;
  const done = new Promise<void>((resolve, reject) => { doneResolve = resolve; doneReject = reject; });
  const scheduleRefresh = (): void => {
    if (timer !== undefined) clearInterval(timer);
    timer = setInterval(() => { void render().catch((error) => doneReject?.(error)); }, refreshInterval);
  };
  const render = async (): Promise<void> => {
    if (renderBusy) { renderPending = true; return; } renderBusy = true;
    try {
      await refreshRegisteredSessions(root);
      sessions = await discoverTuiSessions(root);
      const remembered = state.selectedSessionId === null ? -1 : sessions.findIndex((session) => session.id === state.selectedSessionId);
      if (remembered >= 0) state.selectedSession = remembered;
      state.selectedSession = Math.max(0, Math.min(state.selectedSession, Math.max(0, sessions.length - 1)));
      state.selectedSessionId ??= sessions[state.selectedSession]?.id ?? null;
      const width = Math.max(40, Math.min(output.columns ?? 100, 160)); const height = Math.max(12, Math.min(output.rows ?? 28, 50));
      output.write(`\u001b[H\u001b[2J${renderTuiPage(sessions, config, state, { width, height })}`);
    } finally {
      renderBusy = false;
      if (renderPending) { renderPending = false; void render().catch((error) => doneReject?.(error)); }
    }
  };
  const onData = (chunk: Buffer | string): void => {
    const key = decode(chunk);
    const selectedSession = sessions[state.selectedSession];
    if (key === "quit") { doneResolve?.(); return; }
    let changed = true;
    if (key === "left") state.screen = state.screen === "config" ? "kanban" : "sessions";
    else if (key === "right") state.screen = state.screen === "sessions" ? "kanban" : "config";
    else if (key === "config") state.screen = "config";
    else if (key === "enter" && state.screen === "sessions") { state.screen = "kanban"; state.selectedSessionId = sessions[state.selectedSession]?.id ?? null; state.selectedMonitor = 0; }
    else if ((key === "loop" || key === "long") && state.screen === "kanban") { state.selectedMonitor = key === "loop" ? 0 : 1; }
    else if (key === "up") {
      if (state.screen === "sessions") { state.selectedSession = Math.max(0, state.selectedSession - 1); state.selectedSessionId = sessions[state.selectedSession]?.id ?? null; }
      else if (state.screen === "config") state.selectedConfig = Math.max(0, state.selectedConfig - 1);
      else if (state.screen === "kanban") state.selectedMonitor = Math.max(0, (state.selectedMonitor ?? 0) - 1);
    } else if (key === "down") {
      if (state.screen === "sessions") { state.selectedSession = Math.min(sessions.length - 1, state.selectedSession + 1); state.selectedSessionId = sessions[state.selectedSession]?.id ?? null; }
      else if (state.screen === "config") state.selectedConfig = Math.min(2, state.selectedConfig + 1);
      else if (state.screen === "kanban") state.selectedMonitor = Math.min(1, (state.selectedMonitor ?? 0) + 1);
    } else if (key === "space" && state.screen === "kanban" && selectedSession !== undefined) {
      const monitor = state.selectedMonitor === 1 ? "long" : "loop";
      void setSessionMonitoring(root, selectedSession.id, { [monitor]: !selectedSession.monitoring[monitor] }).then(() => render()).catch((error) => doneReject?.(error));
      changed = false;
    } else if (key === "space" && state.screen === "config") {
      if (state.selectedConfig === 0) config.auto_open_on_component = !config.auto_open_on_component;
      else if (state.selectedConfig === 2) config.color = !config.color;
      void writeTuiConfig(root, config).catch((error) => doneReject?.(error));
    } else if ((key === "increase" || key === "decrease") && state.screen === "config" && state.selectedConfig === 1) {
      config.refresh_ms = Math.max(250, Math.min(10_000, config.refresh_ms + (key === "increase" ? 250 : -250)));
      refreshInterval = config.refresh_ms;
      void writeTuiConfig(root, config).catch((error) => doneReject?.(error));
      scheduleRefresh();
    } else if (key === "save" && state.screen === "config") {
      void writeTuiConfig(root, config).catch((error) => { doneReject?.(error); });
      changed = false;
    }
    if (changed) void writeTuiNavigation(root, { version: 1, page: state.screen, session_id: state.selectedSessionId }).then(render).catch((error) => { doneReject?.(error); });
  };
  let alternateScreen = false; let rawMode = false;
  try {
    output.write("\u001b[?1049h\u001b[?25l"); alternateScreen = true;
    input.setRawMode?.(true); rawMode = true; input.resume(); input.on("data", onData);
    scheduleRefresh();
    await render(); await done;
  } finally {
    if (timer !== undefined) clearInterval(timer);
    input.off("data", onData);
    if (rawMode) input.setRawMode?.(false);
    input.pause();
    if (alternateScreen) output.write("\u001b[?25h\u001b[?1049l");
  }
}
