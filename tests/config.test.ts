import { mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { configPath, configuredFromEnvironment, hydrateEnvironmentFromConfig, isProviderConfigured, loadConfig, loadStoredConfig, redactEndpoint, redactSecret, saveConfig } from "../src/config.js";

describe("JevRev configuration", () => {
  it.each([
    ["win32", "C:\\Users\\alice", "C:\\Users\\alice\\AppData\\Roaming\\jevrev\\config.json"],
    ["darwin", "/Users/alice", "/Users/alice/Library/Application Support/jevrev/config.json"],
    ["linux", "/home/alice", "/home/alice/.config/jevrev/config.json"],
  ])("uses the platform config directory on %s", (platformName, home, expected) => {
    expect(configPath({ platformName: platformName as NodeJS.Platform, home, env: {} })).toBe(expected);
  });

  it("honors an explicit path without touching the default home", () => {
    expect(configPath({ env: { JEVREV_CONFIG_PATH: "C:\\private\\jev.json" }, platformName: "win32", home: "C:\\Users\\alice" })).toBe("C:\\private\\jev.json");
    expect(configPath({ path: "C:\\private\\direct.json", env: { JEVREV_CONFIG_PATH: "C:\\private\\jev.json" }, platformName: "win32", home: "C:\\Users\\alice" })).toBe("C:\\private\\direct.json");
  });

  it("gives JevRev environment variables precedence over stored settings", async () => {
    const root = await mkdtemp(join(tmpdir(), "jevrev-config-"));
    const path = join(root, "config.json");
    await saveConfig({ provider: "local", apiUrl: "https://stored.example", localUrl: "http://stored", semifUrl: "http://stored-semif", semifModel: "stored", model: "stored" }, path);
    const config = await loadConfig({ env: { JEVREV_CONFIG_PATH: path, JEVREV_PROVIDER: "jev", JEVREV_JEV_API_KEY: "from-env", JEVREV_JEV_URL: "https://env.example" } });
    expect(config).toMatchObject({ provider: "jev", apiKey: "from-env", apiUrl: "https://env.example" });
  });

  it("hydrates CLI environment defaults from stored settings without overwriting explicit values", async () => {
    const root = await mkdtemp(join(tmpdir(), "jevrev-config-"));
    const path = join(root, "config.json");
    await saveConfig({ provider: "jev", apiUrl: "https://stored.example", apiKey: "stored-secret", localUrl: "http://stored", semifUrl: "http://stored-semif", semifModel: "stored", model: "stored" }, path);
    const environment: NodeJS.ProcessEnv = { JEVREV_CONFIG_PATH: path, JEVREV_PROVIDER: "local" };
    await hydrateEnvironmentFromConfig({ env: environment });
    expect(environment.JEVREV_PROVIDER).toBe("local");
    expect(environment.JEVREV_JEV_API_KEY).toBe("stored-secret");
    expect(environment.JEVREV_JEV_URL).toBe("https://stored.example");
  });

  it("also preserves explicit legacy environment aliases during hydration", async () => {
    const root = await mkdtemp(join(tmpdir(), "jevrev-config-"));
    const path = join(root, "config.json");
    await saveConfig({ provider: "jev", apiUrl: "https://stored.example", apiKey: "stored-secret", localUrl: "http://stored", semifUrl: "http://stored-semif", semifModel: "stored", model: "stored" }, path);
    const environment: NodeJS.ProcessEnv = { JEVREV_CONFIG_PATH: path, TYPESAFE_API_KEY: "explicit-legacy", TYPESAFE_BASE_URL: "https://explicit-legacy.example" };
    await hydrateEnvironmentFromConfig({ env: environment });
    expect(environment.JEVREV_JEV_API_KEY).toBeUndefined();
    expect(environment.TYPESAFE_API_KEY).toBe("explicit-legacy");
    expect(environment.JEVREV_JEV_URL).toBeUndefined();
  });

  it("accepts the legacy TYPESAFE aliases without printing their value", () => {
    const values = configuredFromEnvironment({ TYPESAFE_API_KEY: "legacy-secret", TYPESAFE_BASE_URL: "https://legacy.example", TYPESAFE_DEFAULT_MODEL: "legacy-model" });
    expect(values).toMatchObject({ apiKey: "legacy-secret", apiUrl: "https://legacy.example", model: "legacy-model" });
    expect(redactSecret(values.apiKey)).toBe("********");
  });

  it("requires a key only for the remote Jev provider", () => {
    expect(isProviderConfigured({ provider: "jev" })).toBe(false);
    expect(isProviderConfigured({ provider: "jev", apiKey: " key " })).toBe(true);
    expect(isProviderConfigured({ provider: "local" })).toBe(true);
    expect(isProviderConfigured({ provider: "semif" })).toBe(true);
  });

  it("writes a reloadable private config and never emits the key", async () => {
    const root = await mkdtemp(join(tmpdir(), "jevrev-config-"));
    const path = join(root, "nested", "config.json");
    const secret = "jev-real-secret-never-log-this";
    await saveConfig({ provider: "jev", apiUrl: "https://api.typesafe.ai", apiKey: secret, localUrl: "http://127.0.0.1:4877", semifUrl: "http://127.0.0.1:4878", semifModel: "Qwen", model: "jev-latest" }, path);
    const loaded = await loadStoredConfig(path);
    expect(loaded.apiKey).toBe(secret);
    expect(await readFile(path, "utf8")).toContain(secret);
    if (process.platform !== "win32") expect((await stat(path)).mode & 0o077).toBe(0);
    expect(redactSecret(secret)).not.toContain(secret);
  });

  it("returns an empty config for missing or malformed files", async () => {
    const root = await mkdtemp(join(tmpdir(), "jevrev-config-"));
    const missing = await loadStoredConfig(join(root, "missing.json"));
    expect(missing).toEqual({});
    const malformed = join(root, "malformed.json");
    await import("node:fs/promises").then(({ writeFile }) => writeFile(malformed, "{ nope"));
    expect(await loadStoredConfig(malformed)).toEqual({});
  });

  it("redacts credentials, query strings, and fragments from displayed endpoints", () => {
    const secret = "secret-query-value";
    expect(redactEndpoint(`https://user:${secret}@api.example/v1?api_key=${secret}#token=${secret}`)).toBe("https://api.example/v1");
    expect(redactEndpoint("not a url")).toBe("invalid endpoint");
  });

  it("rejects non-http endpoints before they can enter persisted configuration", async () => {
    const root = await mkdtemp(join(tmpdir(), "jevrev-config-"));
    await expect(saveConfig({ provider: "local", apiUrl: "file:///tmp/jev", localUrl: "http://127.0.0.1:4877", semifUrl: "http://127.0.0.1:4878", semifModel: "Qwen", model: "jev-latest" }, join(root, "config.json"))).rejects.toThrow();
  });

  it("supports concurrent saves without colliding temporary files", async () => {
    const root = await mkdtemp(join(tmpdir(), "jevrev-config-"));
    const path = join(root, "config.json");
    const results = await Promise.allSettled(Array.from({ length: 100 }, (_, index) => saveConfig({ provider: "jev", apiUrl: "https://api.example", apiKey: `key-${index}`, localUrl: "http://127.0.0.1:4877", semifUrl: "http://127.0.0.1:4878", semifModel: "Qwen", model: "jev-latest" }, path)));
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(100);
    expect((await loadStoredConfig(path)).apiKey).toMatch(/^key-\d+$/);
  });

  it("keeps every one of 100,000 arbitrary secrets out of redacted output", () => {
    for (let index = 0; index < 100_000; index += 1) {
      const secret = `secret-${index}-${"x".repeat(index % 41)}`;
      const redacted = redactSecret(secret);
      expect(redacted).toBe("********");
      expect(redacted).not.toContain(secret);
    }
  });
});
