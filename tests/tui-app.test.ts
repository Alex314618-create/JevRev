import { afterEach, describe, expect, it } from "vitest";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openTui, renderTuiPage } from "../src/tui/app.js";
import { DEFAULT_TUI_CONFIG, DEFAULT_TUI_MONITORING, discoverTuiSessions, readTuiConfig, readTuiNavigation, registerHostSession, saveTuiSession, setSessionMonitoring, writeTuiConfig, type TuiSessionRecord } from "../src/tui/store.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function root(): string { const value = mkdtempSync(join(tmpdir(), "jevrev-ui-")); roots.push(value); return value; }

const session: TuiSessionRecord = {
  version: 1, id: "jvc_0123456789ab", component: "sift", source: "component", monitoring: { ...DEFAULT_TUI_MONITORING }, title: "Parser throughput", goal: "Improve parser throughput without changing output",
  status: "active", started_at: "2026-09-23T10:00:00.000Z", updated_at: "2026-09-23T10:05:00.000Z", agent_work_ms: 180_000,
  summary: "2 probe work orders created", details: ["Candidates are selected for bounded probing; none is verified yet."],
  kanban: { in_progress: ["cache hot tokens", "reuse parser state"], attention: ["Review memory risk"], verified: ["Baseline captured"] },
};

describe("JevRev TUI shell", () => {
  it("renders three navigable pages with one active centered page marker", () => {
    const sessions = [session];
    const views = ["sessions", "kanban", "config"] as const;
    const expected = ["●     ○     ○", "○     ●     ○", "○     ○     ●"];
    views.forEach((screen, index) => {
      const frame = renderTuiPage(sessions, { ...DEFAULT_TUI_CONFIG, color: false }, { screen, selectedSession: 0, selectedConfig: 0 }, { width: 100, height: 28 });
      const rows = frame.split("\r\n");
      expect(rows).toHaveLength(28);
      expect(rows.every((row) => row.length === 100)).toBe(true);
      expect(rows.at(-1)).toContain(expected[index]);
      expect(frame).not.toContain("│");
      expect(frame).toContain("─");
    });
  });

  it("shows session duration and agent work preview separately", () => {
    const frame = renderTuiPage([session], DEFAULT_TUI_CONFIG, { screen: "sessions", selectedSession: 0, selectedConfig: 0 }, { width: 100, height: 28 });
    expect(frame).toContain("PREVIEW");
    expect(frame).toContain("Session age");
    expect(frame).toContain("Agent work");
    expect(frame).toContain("JevSift");
    expect(renderTuiPage([{ ...session, agent_work_ms: null }], DEFAULT_TUI_CONFIG, { screen: "sessions", selectedSession: 0, selectedConfig: 0 }, { width: 100, height: 28 })).toContain("not recorded");
  });

  it("renders the kanban lanes without claiming sift selections are verified", () => {
    const frame = renderTuiPage([session], { ...DEFAULT_TUI_CONFIG, color: false }, { screen: "kanban", selectedSession: 0, selectedConfig: 0 }, { width: 96, height: 24 });
    expect(frame).toContain("LOOP MONITOR");
    expect(frame).toContain("LONG MONITOR");
    expect(frame).toContain("[OFF]");
    expect(frame).toContain("IN PROGRESS");
    expect(frame).toContain("NEEDS ATTENTION");
    expect(frame).toContain("VERIFIED");
    expect(frame).toContain("Baseline captured");
    expect(frame).toContain("cache hot tokens");
  });

  it("opens an empty project without requiring a Long store", () => {
    const frame = renderTuiPage([], { ...DEFAULT_TUI_CONFIG, color: false }, { screen: "sessions", selectedSession: 0, selectedConfig: 0 }, { width: 80, height: 20 });
    expect(frame).toContain("No session is registered yet");
    expect(frame).toContain("Codex or Claude");
  });

  it("persists project config and defaults to component-triggered TUI", async () => {
    const directory = root();
    expect(await readTuiConfig(directory)).toEqual(DEFAULT_TUI_CONFIG);
    await writeTuiConfig(directory, { ...DEFAULT_TUI_CONFIG, auto_open_on_component: false, refresh_ms: 2_000 });
    expect(await readTuiConfig(directory)).toMatchObject({ auto_open_on_component: false, refresh_ms: 2_000 });
  });

  it("creates config under a relocated UI data directory", async () => {
    const directory = root(); const uiDirectory = join(directory, "isolated-ui");
    const previous = process.env.JEVREV_UI_DATA_DIR;
    process.env.JEVREV_UI_DATA_DIR = uiDirectory;
    try {
      await writeTuiConfig(directory, { ...DEFAULT_TUI_CONFIG, color: false });
      expect(await readTuiConfig(directory)).toMatchObject({ color: false });
    } finally {
      if (previous === undefined) delete process.env.JEVREV_UI_DATA_DIR;
      else process.env.JEVREV_UI_DATA_DIR = previous;
    }
  });

  it("upserts sessions without resetting their original start time", async () => {
    const directory = root();
    await saveTuiSession(directory, session);
    await saveTuiSession(directory, { ...session, updated_at: "2026-09-23T11:00:00.000Z", agent_work_ms: 240_000 });
    const sessions = await discoverTuiSessions(directory);
    expect(sessions).toHaveLength(1);
    expect(sessions[0]).toMatchObject({ started_at: session.started_at, updated_at: "2026-09-23T11:00:00.000Z", agent_work_ms: 240_000 });
  });

  it("registers host sessions and persists monitor switches", async () => {
    const directory = root();
    const host = await registerHostSession(directory, { host: "claude", sessionId: "claude-42", title: "Claude refactor", goal: "Refactor the parser" });
    expect(host.source).toBe("host");
    expect(host.host).toBe("claude");
    expect((await discoverTuiSessions(directory))[0]?.host_session_id).toBe("claude-42");
    const updated = await setSessionMonitoring(directory, host.id, { long: true });
    expect(updated.monitoring).toEqual({ loop: false, long: true });
  });

  it("handles page navigation, remembers selection, and restores the terminal", async () => {
    const directory = root(); await saveTuiSession(directory, session);
    class FakeInput extends EventEmitter {
      isTTY = true;
      modes: boolean[] = [];
      setRawMode(value: boolean): void { this.modes.push(value); }
      resume(): this { return this; }
      pause(): this { return this; }
    }
    class FakeOutput extends EventEmitter {
      isTTY = true; columns = 100; rows = 28; output = "";
      write(value: string): boolean { this.output += value; return true; }
    }
    const input = new FakeInput(); const output = new FakeOutput();
    const done = openTui(directory, { input, output, intervalMs: 10_000 });
    for (let attempt = 0; attempt < 100 && !output.output.includes("PREVIEW"); attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(output.output).toContain("PREVIEW");
    input.emit("data", "\u001b[C");
    await new Promise((resolve) => setTimeout(resolve, 75));
    input.emit("data", "\u001b[C");
    await new Promise((resolve) => setTimeout(resolve, 75));
    input.emit("data", " ");
    await new Promise((resolve) => setTimeout(resolve, 75));
    input.emit("data", "q");
    await done;
    const plain = output.output.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "");
    expect(plain).toContain("●     ○     ○");
    expect(plain).toContain("○     ●     ○");
    expect(plain).toContain("○     ○     ●");
    expect(input.modes).toEqual([true, false]);
    expect(await readTuiNavigation(directory)).toMatchObject({ page: "config", session_id: session.id });
    expect(await readTuiConfig(directory)).toMatchObject({ auto_open_on_component: false });
  });

  it("opens a component-triggered Kanban on the newly activated session", async () => {
    const directory = root();
    await saveTuiSession(directory, session);
    const target = { ...session, id: "jvlng_abcdef123456", component: "long" as const, title: "Current Long run", updated_at: "2026-09-23T10:10:00.000Z" };
    await saveTuiSession(directory, target);
    class FakeInput extends EventEmitter { isTTY = true; setRawMode(): void {} resume(): this { return this; } pause(): this { return this; } }
    class FakeOutput extends EventEmitter { isTTY = true; columns = 100; rows = 28; output = ""; write(value: string): boolean { this.output += value; return true; } }
    const input = new FakeInput(); const output = new FakeOutput();
    const done = openTui(directory, { initialScreen: "kanban", initialSessionId: target.id, input, output, intervalMs: 10_000 });
    for (let attempt = 0; attempt < 100 && !output.output.includes("Current Long run"); attempt += 1) await new Promise((resolve) => setTimeout(resolve, 20));
    input.emit("data", "q");
    await done;
    expect(output.output).toContain("Current Long run");
  });

  it("turns the selected Kanban monitor switch into persisted state", async () => {
    const directory = root(); await saveTuiSession(directory, session);
    class FakeInput extends EventEmitter { isTTY = true; setRawMode(): void {} resume(): this { return this; } pause(): this { return this; } }
    class FakeOutput extends EventEmitter { isTTY = true; columns = 100; rows = 28; output = ""; write(value: string): boolean { this.output += value; return true; } }
    const input = new FakeInput(); const output = new FakeOutput();
    const done = openTui(directory, { initialScreen: "kanban", initialSessionId: session.id, input, output, intervalMs: 10_000 });
    for (let attempt = 0; attempt < 100 && !output.output.includes("LOOP MONITOR"); attempt += 1) await new Promise((resolve) => setTimeout(resolve, 20));
    input.emit("data", " ");
    await new Promise((resolve) => setTimeout(resolve, 60));
    input.emit("data", "q");
    await done;
    const records = await discoverTuiSessions(directory);
    expect(records[0]?.monitoring.loop).toBe(true);
  });

  it("restores the alternate screen if raw-mode setup fails", async () => {
    const directory = root();
    class BrokenInput extends EventEmitter { setRawMode(): void { throw new Error("raw mode unavailable"); } resume(): this { return this; } pause(): this { return this; } }
    class FakeOutput extends EventEmitter { columns = 100; rows = 28; output = ""; write(value: string): boolean { this.output += value; return true; } }
    const output = new FakeOutput();
    await expect(openTui(directory, { input: new BrokenInput(), output })).rejects.toThrow("raw mode unavailable");
    expect(output.output).toContain("\u001b[?1049h");
    expect(output.output).toContain("\u001b[?1049l");
  });
});
