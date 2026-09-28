import { chmod, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { homedir, platform } from "node:os";
import { dirname, join, posix, resolve, win32 } from "node:path";
import { z } from "zod";
import { DEFAULT_JEV_URL } from "./judge.js";

export type ConfigProvider = "jev" | "local" | "semif";

export interface JevRevConfig {
  provider: ConfigProvider;
  apiUrl: string;
  apiKey?: string;
  localUrl: string;
  semifUrl: string;
  semifModel: string;
  model: string;
}

const httpEndpoint = z.string().url().refine((value) => {
  try {
    const protocol = new URL(value).protocol;
    return protocol === "http:" || protocol === "https:";
  } catch {
    return false;
  }
}, "Endpoint must use http or https");

const configSchema = z.object({
  provider: z.enum(["jev", "local", "semif"]),
  apiUrl: httpEndpoint,
  apiKey: z.string().min(1).optional(),
  localUrl: httpEndpoint,
  semifUrl: httpEndpoint,
  semifModel: z.string().min(1),
  model: z.string().min(1),
}).strict();

export const DEFAULT_CONFIG: JevRevConfig = {
  provider: "jev",
  apiUrl: DEFAULT_JEV_URL,
  localUrl: "http://127.0.0.1:4877",
  semifUrl: "http://127.0.0.1:4878",
  semifModel: "Qwen3.5-4B-Q4_K_M",
  model: "jev-latest",
};

const configSaveLocks = new Map<string, Promise<void>>();

export interface ConfigPathOptions {
  env?: NodeJS.ProcessEnv;
  platformName?: NodeJS.Platform;
  home?: string;
  path?: string;
}

function normalizeExplicitPath(value: string, os: NodeJS.Platform): string {
  if (os === "win32") return win32.isAbsolute(value) ? win32.normalize(value) : win32.resolve(value);
  return posix.isAbsolute(value) ? posix.normalize(value) : resolve(value);
}

export function configPath(options: ConfigPathOptions = {}): string {
  const os = options.platformName ?? platform();
  if (options.path !== undefined && options.path.trim().length > 0) return normalizeExplicitPath(options.path, os);
  const environment = options.env ?? process.env;
  const explicit = environment.JEVREV_CONFIG_PATH?.trim();
  if (explicit !== undefined && explicit.length > 0) return normalizeExplicitPath(explicit, os);
  const home = options.home ?? homedir();
  if (os === "win32") return win32.join(environment.APPDATA?.trim() || win32.join(home, "AppData", "Roaming"), "jevrev", "config.json");
  if (os === "darwin") return posix.join(home, "Library", "Application Support", "jevrev", "config.json");
  return posix.join(environment.XDG_CONFIG_HOME?.trim() || posix.join(home, ".config"), "jevrev", "config.json");
}

function envValue(environment: NodeJS.ProcessEnv, ...names: string[]): string | undefined {
  for (const name of names) {
    const value = environment[name]?.trim();
    if (value !== undefined && value.length > 0) return value;
  }
  return undefined;
}

export function configuredFromEnvironment(environment: NodeJS.ProcessEnv = process.env): Partial<JevRevConfig> {
  const provider = envValue(environment, "JEVREV_PROVIDER", "SPECJEV_PROVIDER");
  const apiUrl = envValue(environment, "JEVREV_JEV_URL", "TYPESAFE_BASE_URL");
  const apiKey = envValue(environment, "JEVREV_JEV_API_KEY", "TYPESAFE_API_KEY");
  const localUrl = envValue(environment, "JEVREV_LOCAL_URL", "SPECJEV_LOCAL_URL");
  const semifUrl = envValue(environment, "JEVREV_SEMIF_URL", "SPECJEV_SEMIF_URL");
  const semifModel = envValue(environment, "JEVREV_SEMIF_MODEL", "SPECJEV_SEMIF_MODEL");
  const model = envValue(environment, "JEVREV_JEV_MODEL", "TYPESAFE_DEFAULT_MODEL");
  return {
    ...(provider === "jev" || provider === "local" || provider === "semif" ? { provider } : {}),
    ...(apiUrl === undefined ? {} : { apiUrl }),
    ...(apiKey === undefined ? {} : { apiKey }),
    ...(localUrl === undefined ? {} : { localUrl }),
    ...(semifUrl === undefined ? {} : { semifUrl }),
    ...(semifModel === undefined ? {} : { semifModel }),
    ...(model === undefined ? {} : { model }),
  };
}

export async function loadStoredConfig(path = configPath()): Promise<Partial<JevRevConfig>> {
  try {
    const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
    const result = configSchema.partial().safeParse(parsed);
    return result.success ? result.data as Partial<JevRevConfig> : {};
  } catch {
    return {};
  }
}

export async function loadConfig(options: ConfigPathOptions = {}): Promise<JevRevConfig> {
  const path = configPath(options);
  const stored = await loadStoredConfig(path);
  const environment = configuredFromEnvironment(options.env ?? process.env);
  return { ...DEFAULT_CONFIG, ...stored, ...environment } as JevRevConfig;
}

/** Apply only persisted values that the caller has not supplied explicitly. */
export async function hydrateEnvironmentFromConfig(options: ConfigPathOptions = {}): Promise<void> {
  const environment = options.env ?? process.env;
  const stored = await loadStoredConfig(configPath(options));
  if (environment.JEVREV_PROVIDER === undefined && environment.SPECJEV_PROVIDER === undefined && stored.provider !== undefined) environment.JEVREV_PROVIDER = stored.provider;
  if (environment.JEVREV_JEV_URL === undefined && environment.TYPESAFE_BASE_URL === undefined && stored.apiUrl !== undefined) environment.JEVREV_JEV_URL = stored.apiUrl;
  if (environment.JEVREV_JEV_API_KEY === undefined && environment.TYPESAFE_API_KEY === undefined && stored.apiKey !== undefined) environment.JEVREV_JEV_API_KEY = stored.apiKey;
  if (environment.JEVREV_LOCAL_URL === undefined && environment.SPECJEV_LOCAL_URL === undefined && stored.localUrl !== undefined) environment.JEVREV_LOCAL_URL = stored.localUrl;
  if (environment.JEVREV_SEMIF_URL === undefined && environment.SPECJEV_SEMIF_URL === undefined && stored.semifUrl !== undefined) environment.JEVREV_SEMIF_URL = stored.semifUrl;
  if (environment.JEVREV_SEMIF_MODEL === undefined && environment.SPECJEV_SEMIF_MODEL === undefined && stored.semifModel !== undefined) environment.JEVREV_SEMIF_MODEL = stored.semifModel;
  if (environment.JEVREV_JEV_MODEL === undefined && environment.TYPESAFE_DEFAULT_MODEL === undefined && stored.model !== undefined) environment.JEVREV_JEV_MODEL = stored.model;
}

export function isProviderConfigured(config: Pick<JevRevConfig, "provider" | "apiKey">): boolean {
  return config.provider !== "jev" || (config.apiKey?.trim().length ?? 0) > 0;
}

export function redactSecret(value: string | undefined): string {
  if (value === undefined || value.length === 0) return "not set";
  return "********";
}

/** Remove credentials and query fragments before an endpoint is shown in a terminal. */
export function redactEndpoint(value: string): string {
  try {
    const url = new URL(value);
    url.username = "";
    url.password = "";
    url.search = "";
    url.hash = "";
    return url.toString().replace(/\/$/, "");
  } catch {
    return "invalid endpoint";
  }
}

export async function saveConfig(config: JevRevConfig, path = configPath()): Promise<void> {
  const parsed = configSchema.parse({ ...config, ...(config.apiKey === undefined ? {} : { apiKey: config.apiKey.trim() }) });
  if (parsed.apiKey === undefined && parsed.provider === "jev") throw new Error("A Jev API key is required");
  const previous = configSaveLocks.get(path) ?? Promise.resolve();
  let release!: () => void;
  const turn = new Promise<void>((resolveTurn) => { release = resolveTurn; });
  const queued = previous.then(() => turn);
  configSaveLocks.set(path, queued);
  await previous;
  let temporary: string | undefined;
  try {
    await mkdir(dirname(path), { recursive: true });
    temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
    await writeFile(temporary, `${JSON.stringify(parsed, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    await chmod(temporary, 0o600).catch(() => undefined);
    try {
      await rename(temporary, path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EPERM" && (error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      await unlink(path).catch((unlinkError) => {
        if ((unlinkError as NodeJS.ErrnoException).code !== "ENOENT") throw unlinkError;
      });
      await rename(temporary, path);
    }
  } finally {
    if (temporary !== undefined) await unlink(temporary).catch(() => undefined);
    release();
    if (configSaveLocks.get(path) === queued) configSaveLocks.delete(path);
  }
}
