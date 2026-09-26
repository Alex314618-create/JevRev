import { readdir, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { dashboardFromStatus, longEventSummary, renderLongDashboard, renderLongTui, renderLongWatchSummary, type LongTuiFocus, type LongTuiModel, type LongTuiSession, type LongTuiTab } from "./tui.js";
import type { LongAlert } from "./schemas.js";
import type { LongNotifier } from "./notifier.js";
import { longStatusCommand } from "./commands.js";
import { loadLongStore } from "./store.js";
import { openTui } from "../tui/app.js";

type TuiInput = NodeJS.ReadableStream & { isTTY?: boolean; setRawMode?: (mode: boolean) => void };
interface TuiOutput extends NodeJS.WritableStream { isTTY?: boolean; columns?: number; rows?: number; }
type LongStatus = Awaited<ReturnType<typeof longStatusCommand>>;

export interface LongWatchOptions {
  intervalMs?: number; iterations?: number; width?: number; height?: number; color?: boolean; clear?: boolean; root?: string; interactive?: boolean; stream?: boolean; full?: boolean;
  input?: TuiInput; output?: TuiOutput; now?: () => Date; sleep?: (milliseconds: number) => Promise<void>; onFrame?: (frame: string) => void | Promise<void>; notifier?: LongNotifier;
}
interface SessionRecord { directory: string; result: LongStatus }

async function hasLongSpec(directory: string): Promise<boolean> { try { return (await stat(join(directory, "spec.json"))).isFile(); } catch { return false; } }
async function sessionDirectories(directory: string, root?: string): Promise<string[]> {
  const current = resolve(directory); if (root === undefined) return [current];
  const base = resolve(root); const found: string[] = [];
  if (await hasLongSpec(base)) found.push(base);
  for (const entry of await readdir(base, { withFileTypes: true })) { if (entry.isDirectory() && await hasLongSpec(join(base, entry.name))) found.push(join(base, entry.name)); }
  if (!found.includes(current)) found.unshift(current); return [...new Set(found)].slice(0, 64);
}
function keyFor(chunk: Buffer | string): string { const value = typeof chunk === "string" ? chunk : chunk.toString("utf8"); if (value === "\u001b[I") return "focus"; if (value === "\u001b[O") return "blur"; if (value === "\u0003" || value === "q") return "quit"; if (value === "\u001b[A" || value === "\u001bOA" || value === "k") return "up"; if (value === "\u001b[B" || value === "\u001bOB" || value === "j") return "down"; if (value === "\t") return "tab"; if (/^[1-4]$/.test(value)) return `tab-${value}`; if (value === "r") return "refresh"; return "other"; }
function clampIndex(value: number, size: number): number { return size <= 0 ? 0 : Math.max(0, Math.min(size - 1, value)); }
function itemCount(model: LongTuiModel): number { if (model.focus === "sessions") return model.sessions.length; if (model.tab === "activity") return model.events.length; if (model.tab === "alerts") return model.alerts.length; if (model.tab === "evidence") return model.evidence.length; return 1; }
function modelFor(records: readonly SessionRecord[], selectedSession: number, tab: LongTuiTab, focus: LongTuiFocus, selectedItem: number): LongTuiModel {
  const selected = records[clampIndex(selectedSession, records.length)] ?? records[0]; if (selected === undefined) throw new Error("No Long sessions are available");
  const dashboard = dashboardFromStatus(selected.result);
  const sessions: LongTuiSession[] = records.map(({ directory, result }) => ({ directory, title: result.store.spec.title, sessionId: result.store.spec.session_id, activity: result.signals.activity, progress: result.signals.progress_index, openAlerts: result.policy.alerts.filter((alert) => alert.status === "open" || alert.status === "acknowledged").length, lastEventAt: result.store.snapshot.last_event_at }));
  const events = selected.result.store.events.slice(-128).map((event) => longEventSummary(event.payload));
  const alerts = selected.result.policy.alerts.filter((alert) => alert.status === "open" || alert.status === "acknowledged");
  const evidence = Object.entries(selected.result.signals.evidence_event_ids).flatMap(([kind, ids]) => ids.map((id) => `${kind} · ${id}`));
  return { title: selected.result.store.spec.title, goal: selected.result.store.spec.goal, dashboard, sessions, events, alerts, evidence, tab, focus, selectedSession: clampIndex(selectedSession, sessions.length), selectedItem: clampIndex(selectedItem, tab === "overview" ? 1 : tab === "activity" ? events.length : tab === "alerts" ? alerts.length : evidence.length) };
}

async function runInteractiveLongWatch(directory: string, options: LongWatchOptions): Promise<void> {
  const intervalMs = options.intervalMs ?? 1_000; if (!Number.isInteger(intervalMs) || intervalMs < 100) throw new Error("Long watch interval must be at least 100ms");
  const input = options.input ?? process.stdin as unknown as TuiInput; const output = options.output ?? process.stdout as unknown as TuiOutput; const directories = await sessionDirectories(directory, options.root);
  const previousAlerts = new Map<string, readonly LongAlert[]>(); const previousAlertIds = new Map<string, Set<string>>();
  let selectedSession = Math.max(0, directories.indexOf(resolve(directory))); let selectedItem = 0; let tab: LongTuiTab = "overview"; let focus: LongTuiFocus = "sessions"; let rendering = false; let stopped = false; let focused = true; let lastBackgroundRefresh = 0; let timer: NodeJS.Timeout | undefined; let resolveDone: (() => void) | undefined; let rejectDone: ((error: unknown) => void) | undefined;
  const done = new Promise<void>((resolvePromise, rejectPromise) => { resolveDone = resolvePromise; rejectDone = rejectPromise; });
  const refresh = async (): Promise<void> => {
    if (rendering || stopped) return; rendering = true;
    try {
      const records: SessionRecord[] = [];
      for (const sessionDirectory of directories) {
        try {
          const prior = previousAlerts.get(sessionDirectory) ?? [];
          const result = await longStatusCommand(sessionDirectory, options.now?.() ?? new Date(), prior);
          records.push({ directory: sessionDirectory, result });
          const ids = previousAlertIds.get(sessionDirectory) ?? new Set<string>();
          const raised = result.policy.raised.filter((alert) => !ids.has(alert.id));
          if (options.notifier !== undefined) await options.notifier.notify(raised);
          previousAlerts.set(sessionDirectory, result.policy.alerts);
          previousAlertIds.set(sessionDirectory, new Set(result.policy.alerts.filter((alert) => alert.status === "open" || alert.status === "acknowledged").map((alert) => alert.id)));
        } catch (error) {
          if (sessionDirectory === resolve(directory)) throw error;
          // A rotated sibling may disappear while the cockpit is refreshing.
        }
      }
      if (records.length === 0) throw new Error("No readable Long sessions are available");
      if (!focused && Date.now() - lastBackgroundRefresh < Math.max(10_000, intervalMs * 10)) return;
      selectedSession = clampIndex(selectedSession, records.length); const model = modelFor(records, selectedSession, tab, focus, selectedItem); selectedItem = clampIndex(selectedItem, itemCount(model));
      const width = Math.max(40, Math.min(options.width ?? output.columns ?? 100, output.columns ?? options.width ?? 100)); const height = Math.max(12, Math.min(options.height ?? output.rows ?? 24, output.rows ?? options.height ?? 24)); output.write(`\u001b[H\u001b[2J${renderLongTui(model, { width, height, color: options.color ?? true })}`);
    } finally { rendering = false; }
  };
  const onKey = (chunk: Buffer | string): void => { const key = keyFor(chunk); if (key === "quit") { stopped = true; resolveDone?.(); return; } if (key === "blur") { focused = false; lastBackgroundRefresh = Date.now(); return; } if (key === "focus") { focused = true; void refresh().catch((error) => { stopped = true; rejectDone?.(error); }); return; } if (key === "refresh") { void refresh().catch((error) => { stopped = true; rejectDone?.(error); }); return; } if (key === "tab") { focus = focus === "sessions" ? "main" : focus === "main" ? "attention" : "sessions"; selectedItem = 0; } else if (key.startsWith("tab-")) { tab = ({ "tab-1": "overview", "tab-2": "activity", "tab-3": "alerts", "tab-4": "evidence" } as const)[key as "tab-1" | "tab-2" | "tab-3" | "tab-4"]; selectedItem = 0; focus = "main"; } else if (key === "up" || key === "down") { const delta = key === "up" ? -1 : 1; if (focus === "sessions") selectedSession = Math.max(0, selectedSession + delta); else selectedItem = Math.max(0, selectedItem + delta); } void refresh().catch((error) => { stopped = true; rejectDone?.(error); }); };
  output.write("\u001b[?1049h\u001b[?25l\u001b[?1004h"); input.setRawMode?.(true); input.resume?.(); input.on("data", onKey); timer = setInterval(() => { if (!focused && Date.now() - lastBackgroundRefresh < Math.max(10_000, intervalMs * 10)) return; if (!focused) lastBackgroundRefresh = Date.now(); void refresh().catch((error) => { stopped = true; rejectDone?.(error); }); }, intervalMs);
  try { await refresh(); await done; } finally { if (timer !== undefined) clearInterval(timer); input.off("data", onKey); input.setRawMode?.(false); input.pause?.(); output.write("\u001b[?1004l\u001b[?25h\u001b[?1049l"); }
}

export async function watchLong(directory: string, options: LongWatchOptions = {}): Promise<void> {
  const input = options.input ?? process.stdin as unknown as TuiInput; const output = options.output ?? process.stdout as unknown as TuiOutput; const shouldUseInteractive = options.interactive ?? (!options.stream && options.iterations === undefined && options.clear !== false && input.isTTY === true && output.isTTY === true);
  const hasCustomTerminal = options.input !== undefined || options.output !== undefined;
  if (shouldUseInteractive && !hasCustomTerminal) {
    const store = await loadLongStore(directory);
    await openTui(options.root ?? process.cwd(), {
      initialScreen: "kanban",
      initialSessionId: store.spec.session_id,
      ...(options.intervalMs === undefined ? {} : { intervalMs: options.intervalMs }),
    });
    return;
  }
  if (shouldUseInteractive) { await runInteractiveLongWatch(directory, options); return; }
  const intervalMs = options.intervalMs ?? 10_000; if (!Number.isInteger(intervalMs) || intervalMs < 100) throw new Error("Long watch interval must be at least 100ms"); const sleep = options.sleep ?? ((milliseconds: number) => new Promise<void>((resolvePromise) => setTimeout(resolvePromise, milliseconds))); const onFrame = options.onFrame ?? ((frame: string) => output.write(frame)); const notifier = options.notifier; const iterations = options.iterations ?? (options.stream ? Infinity : 1); let previousAlertIds = new Set<string>(); let previousAlerts: LongAlert[] = []; let previousFrame: string | undefined;
  for (let iteration = 0; iteration < iterations; iteration += 1) { const status = await longStatusCommand(directory, options.now?.() ?? new Date(), previousAlerts); const dashboard = dashboardFromStatus(status); const newAlerts = status.policy.raised.filter((alert) => !previousAlertIds.has(alert.id)); previousAlertIds = new Set(status.policy.alerts.filter((alert) => alert.status === "open" || alert.status === "acknowledged").map((alert) => alert.id)); previousAlerts = [...status.policy.alerts]; if (notifier !== undefined) await notifier.notify(newAlerts); const frame = options.full ? renderLongDashboard(dashboard, { ...(options.width === undefined ? {} : { width: options.width }), ...(options.color === undefined ? {} : { color: options.color }), timeline: status.store.events.slice(-5).map((event) => `${event.payload.received_at}  ${event.payload.event_type}`) }) : renderLongWatchSummary(dashboard); if (frame !== previousFrame) await onFrame(options.full && options.clear !== false ? `\x1b[2J\x1b[H${frame}` : frame); previousFrame = frame; if (iteration + 1 < iterations) await sleep(intervalMs); }
}
