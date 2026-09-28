import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ensureProviderSetup, renderSetup, SetupInputDecoder } from "../src/tui/setup.js";

const roots: string[] = [];
afterEach(() => { for (const value of roots.splice(0)) rmSync(value, { recursive: true, force: true }); });

class FakeInput extends EventEmitter {
  modes: boolean[] = [];
  setRawMode(value: boolean): void { this.modes.push(value); }
  resume(): this { return this; }
  pause(): this { return this; }
}

class FakeOutput {
  columns = 100;
  output = "";
  write(value: string): boolean { this.output += value; return true; }
}

function directory(): string { const value = mkdtempSync(join(tmpdir(), "jevrev-setup-")); roots.push(value); return value; }
function tick(): Promise<void> { return new Promise((resolve) => setImmediate(resolve)); }
async function waitForOutput(output: FakeOutput): Promise<void> {
  for (let attempt = 0; attempt < 100 && !output.output.includes("JevRev setup"); attempt += 1) await new Promise((resolve) => setTimeout(resolve, 5));
}

describe("first-run provider setup", () => {
  it("saves a Jev key and skips the setup page on the next launch", async () => {
    const input = new FakeInput(); const output = new FakeOutput(); const path = join(directory(), "config.json");
    const pending = ensureProviderSetup({ input, output, path, env: {} });
    await waitForOutput(output);
    input.emit("data", "jev-key-from-setup");
    input.emit("data", "\r");
    const config = await pending;
    expect(config?.provider).toBe("jev");
    expect(config?.apiKey).toBe("jev-key-from-setup");
    expect(output.output).not.toContain("jev-key-from-setup");
    expect(input.modes).toEqual([true, false]);

    const secondOutput = new FakeOutput();
    const second = await ensureProviderSetup({ input: new FakeInput(), output: secondOutput, path, env: {} });
    expect(second?.apiKey).toBe("jev-key-from-setup");
    expect(secondOutput.output).toBe("");
  });

  it("keeps a split CSI arrow sequence intact instead of treating ESC as cancel", async () => {
    const input = new FakeInput(); const output = new FakeOutput(); const path = join(directory(), "config.json");
    const pending = ensureProviderSetup({ input, output, path, env: {} });
    await waitForOutput(output);
    input.emit("data", "\u001b[");
    input.emit("data", "A");
    input.emit("data", "\u001b[B");
    input.emit("data", "split-arrow-key");
    input.emit("data", "\r");
    const config = await pending;
    expect(config?.apiKey).toBe("split-arrow-key");
    expect(output.output).not.toContain("split-arrow-key");
  });

  it("never prints a secret-bearing endpoint while editing", () => {
    const state = { provider: "jev", endpoint: "https://api.example/v1?api_key=visible-secret", apiKey: "", focus: 1 as const, endpointDirty: true, error: undefined };
    const frame = renderSetup(state, { color: false });
    expect(frame).toContain("https://api.example/v1");
    expect(frame).not.toContain("visible-secret");
    expect(frame).not.toContain("api_key");
  });

  it("decodes arbitrary text and split arrows without loss", async () => {
    const tokens: string[] = [];
    const decoder = new SetupInputDecoder((token) => tokens.push(token));
    decoder.push("\u001b[");
    decoder.push("Babc");
    await tick();
    decoder.close();
    expect(tokens).toEqual(["next", "text:a", "text:b", "text:c"]);
  });
});
