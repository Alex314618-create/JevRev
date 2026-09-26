import { mkdir, readFile, readdir, rename, stat, unlink, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { InputError } from "../domain/errors.js";

export const tuiHostSchema = z.enum(["codex", "claude", "opencode", "other"]);
export type TuiHost = z.infer<typeof tuiHostSchema>;

const monitoringSchema = z.object({ loop: z.boolean(), long: z.boolean() }).strict();
export type TuiMonitoring = z.infer<typeof monitoringSchema>;
export const DEFAULT_TUI_MONITORING: TuiMonitoring = { loop: false, long: false };

const sessionSchema = z.object({
  version: z.literal(1),
  id: z.string().min(1).max(128).regex(/^[a-zA-Z0-9_-]+$/),
  component: z.enum(["sift", "loop", "long", "session"]),
  source: z.enum(["component", "host"]).default("component"),
  host: tuiHostSchema.optional(),
  host_session_id: z.string().trim().min(1).max(512).optional(),
  workspace: z.string().max(4_096).optional(),
  title: z.string().trim().min(1).max(240),
  goal: z.string().trim().min(1).max(2_000),
  status: z.enum(["active", "paused", "complete", "aborted"]),
  started_at: z.string().datetime({ offset: true }),
  updated_at: z.string().datetime({ offset: true }),
  agent_work_ms: z.number().int().nonnegative().nullable(),
  directory: z.string().max(4_096).optional(),
  loop_directory: z.string().max(4_096).optional(),
  long_directory: z.string().max(4_096).optional(),
  monitoring: monitoringSchema.default(DEFAULT_TUI_MONITORING),
  summary: z.string().max(1_000),
  details: z.array(z.string().max(1_000)).max(64),
  kanban: z.object({ in_progress: z.array(z.string().max(1_000)).max(64), attention: z.array(z.string().max(1_000)).max(64), verified: z.array(z.string().max(1_000)).max(64) }).strict(),
}).strict();
export type TuiSessionRecord = z.infer<typeof sessionSchema>;
export type TuiSessionStatus = TuiSessionRecord["status"];

export interface HostSessionRegistration {
  host: TuiHost;
  sessionId: string;
  title: string;
  goal: string;
  workspace?: string;
  status?: TuiSessionStatus;
}

const configSchema = z.object({
  version: z.literal(1),
  auto_open_on_component: z.boolean(),
  refresh_ms: z.number().int().min(250).max(10_000),
  color: z.boolean(),
}).strict();
export type TuiConfig = z.infer<typeof configSchema>;

const navigationSchema = z.object({ version: z.literal(1), page: z.enum(["sessions", "kanban", "config"]), session_id: z.string().max(128).nullable() }).strict();
export type TuiNavigation = z.infer<typeof navigationSchema>;
export const DEFAULT_TUI_NAVIGATION: TuiNavigation = { version: 1, page: "sessions", session_id: null };

export const DEFAULT_TUI_CONFIG: TuiConfig = { version: 1, auto_open_on_component: true, refresh_ms: 1_000, color: true };

function paths(rootInput: string): { root: string; sessions: string; config: string } {
  const root = resolve(rootInput);
  const ui = process.env.JEVREV_UI_DATA_DIR === undefined ? join(root, ".jevrev", "ui") : resolve(process.env.JEVREV_UI_DATA_DIR);
  return { root, sessions: join(ui, "sessions"), config: join(ui, "config.json") };
}

async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
    await rename(temporary, path);
  } catch (error) {
    await unlink(temporary).catch(() => undefined);
    throw new InputError(`Could not save JevRev TUI data: ${path}`, { cause: error });
  }
}

export async function readTuiConfig(rootInput: string): Promise<TuiConfig> {
  const location = paths(rootInput);
  try { return configSchema.parse(JSON.parse(await readFile(location.config, "utf8")) as unknown); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return DEFAULT_TUI_CONFIG;
    throw new InputError(`Invalid JevRev TUI config: ${location.config}`, { cause: error });
  }
}

export async function writeTuiConfig(rootInput: string, config: TuiConfig): Promise<TuiConfig> {
  const location = paths(rootInput);
  const value = configSchema.parse(config);
  await mkdir(dirname(location.config), { recursive: true });
  await writeJsonAtomic(location.config, value);
  return value;
}

export async function readTuiNavigation(rootInput: string): Promise<TuiNavigation> {
  const location = paths(rootInput);
  try { return navigationSchema.parse(JSON.parse(await readFile(join(location.sessions, "..", "navigation.json"), "utf8")) as unknown); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return DEFAULT_TUI_NAVIGATION; throw new InputError("Invalid JevRev TUI navigation state", { cause: error }); }
}

export async function writeTuiNavigation(rootInput: string, navigation: TuiNavigation): Promise<TuiNavigation> {
  const location = paths(rootInput); const value = navigationSchema.parse(navigation);
  const uiRoot = process.env.JEVREV_UI_DATA_DIR === undefined ? join(location.root, ".jevrev", "ui") : resolve(process.env.JEVREV_UI_DATA_DIR);
  await mkdir(uiRoot, { recursive: true });
  await writeJsonAtomic(join(uiRoot, "navigation.json"), value);
  return value;
}

export async function saveTuiSession(rootInput: string, input: TuiSessionRecord): Promise<TuiSessionRecord> {
  const location = paths(rootInput);
  await mkdir(location.sessions, { recursive: true });
  let previous: TuiSessionRecord | undefined;
  try { previous = sessionSchema.parse(JSON.parse(await readFile(join(location.sessions, `${input.id}.json`), "utf8")) as unknown); }
  catch { /* new session */ }
  const value = sessionSchema.parse({ ...input, ...(previous === undefined ? {} : { started_at: previous.started_at }) });
  await writeJsonAtomic(join(location.sessions, `${value.id}.json`), value);
  return value;
}

function sessionFile(rootInput: string, id: string): string {
  return join(paths(rootInput).sessions, `${id}.json`);
}

export async function readTuiSession(rootInput: string, id: string): Promise<TuiSessionRecord | undefined> {
  try { return sessionSchema.parse(JSON.parse(await readFile(sessionFile(rootInput, id), "utf8")) as unknown); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    return undefined;
  }
}

function sessionIdForHost(host: TuiHost, sessionId: string): string {
  const safe = sessionId.toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 96) || "session";
  return `host_${host}_${safe}`.slice(0, 128);
}

export async function registerHostSession(rootInput: string, registration: HostSessionRegistration): Promise<TuiSessionRecord> {
  const existing = await readTuiSession(rootInput, sessionIdForHost(registration.host, registration.sessionId));
  const now = new Date().toISOString();
  return saveTuiSession(rootInput, {
    version: 1,
    id: sessionIdForHost(registration.host, registration.sessionId),
    component: "session",
    source: "host",
    host: registration.host,
    host_session_id: registration.sessionId,
    ...(registration.workspace === undefined ? {} : { workspace: registration.workspace }),
    title: registration.title,
    goal: registration.goal,
    status: registration.status ?? existing?.status ?? "active",
    started_at: existing?.started_at ?? now,
    updated_at: now,
    agent_work_ms: null,
    ...(existing?.directory === undefined ? {} : { directory: existing.directory }),
    ...(existing?.loop_directory === undefined ? {} : { loop_directory: existing.loop_directory }),
    ...(existing?.long_directory === undefined ? {} : { long_directory: existing.long_directory }),
    monitoring: existing?.monitoring ?? DEFAULT_TUI_MONITORING,
    summary: existing?.summary ?? `${registration.host} session registered`,
    details: existing?.details ?? [`Host session ${registration.sessionId}`],
    kanban: existing?.kanban ?? { in_progress: [], attention: [], verified: [] },
  });
}

export async function setSessionMonitoring(rootInput: string, id: string, patch: Partial<TuiMonitoring>): Promise<TuiSessionRecord> {
  const current = await readTuiSession(rootInput, id);
  if (current === undefined) throw new InputError(`Unknown JevRev session: ${id}`);
  return saveTuiSession(rootInput, { ...current, monitoring: { ...current.monitoring, ...patch }, updated_at: new Date().toISOString() });
}

async function readRegisteredSessions(directory: string): Promise<TuiSessionRecord[]> {
  const entries = await readdir(directory, { withFileTypes: true }).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  });
  const records: TuiSessionRecord[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    try { records.push(sessionSchema.parse(JSON.parse(await readFile(join(directory, entry.name), "utf8")) as unknown)); }
    catch { /* skip an incomplete or stale index record */ }
  }
  return records;
}

async function walkStoreDirectories(root: string, depth: number, output: string[]): Promise<void> {
  if (depth < 0 || output.length >= 256) return;
  const entries = await readdir(root, { withFileTypes: true }).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  });
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
    const child = join(root, entry.name);
    if (await stat(join(child, "spec.json")).then((result) => result.isFile()).catch(() => false) ||
        await stat(join(child, "snapshot.json")).then((result) => result.isFile()).catch(() => false)) output.push(child);
    else await walkStoreDirectories(child, depth - 1, output);
    if (output.length >= 256) return;
  }
}

export async function discoverTuiSessions(rootInput: string): Promise<TuiSessionRecord[]> {
  const location = paths(rootInput);
  const registered = await readRegisteredSessions(location.sessions);
  const byId = new Map(registered.map((record) => [record.id, record]));
  const candidates: string[] = [];
  await walkStoreDirectories(join(location.root, ".jevrev"), 3, candidates);
  for (const directory of candidates) {
    try {
      const spec = JSON.parse(await readFile(join(directory, "spec.json"), "utf8")) as Record<string, unknown>;
      if (spec.kind === "jevrev.long-spec" && typeof spec.session_id === "string") {
        const info = JSON.parse(await readFile(join(directory, "identity.json"), "utf8")) as { created_at?: string };
        const updated = (await stat(join(directory, "snapshot.json"))).mtime.toISOString();
        if (!byId.has(spec.session_id)) byId.set(spec.session_id, sessionSchema.parse({ version: 1, id: spec.session_id, component: "long", source: "component", monitoring: { loop: false, long: true }, title: spec.title, goal: spec.goal,
          status: "active", started_at: info.created_at ?? updated, updated_at: updated, agent_work_ms: 0, directory, long_directory: directory,
          summary: "Long observer session", details: [`${Array.isArray(spec.milestones) ? spec.milestones.length : 0} milestones`],
          kanban: { in_progress: [], attention: [], verified: [] } }));
      }
    } catch { /* loop and unrelated stores have different schemas */ }
  }
  return [...byId.values()].sort((left, right) => right.updated_at.localeCompare(left.updated_at));
}

export async function registerComponentSession(root: string, record: TuiSessionRecord): Promise<void> {
  await saveTuiSession(root, record);
}
