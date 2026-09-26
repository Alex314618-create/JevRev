import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "..");
const installer = resolve(root, "scripts", "install-skill.mjs");

function run(args: string[]) {
  return spawnSync(process.execPath, [installer, ...args], {
    cwd: root,
    encoding: "utf8",
  });
}

describe("skill installer", () => {
  it("requires an explicit target or destination", () => {
    const result = run([]);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("exactly one of --target or --destination");
  });

  it("documents the explicit OpenCode target", () => {
    const result = run(["--help"]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("<codex|claude|opencode|agents|dsh>");
  });

  it("resolves the OpenCode target under the user's config directory", () => {
    const result = run(["--target", "opencode", "--dry-run"]);
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe(join(homedir(), ".config", "opencode", "skills", "jevrev", "SKILL.md"));
  });

  it("installs, leaves an identical file alone, and protects changes", () => {
    const temporaryRoot = mkdtempSync(join(tmpdir(), "jevrev-skill-"));
    const destination = join(temporaryRoot, "custom", "jevrev");
    try {
      const installed = run(["--destination", destination]);
      expect(installed.status).toBe(0);
      const target = join(destination, "SKILL.md");
      const original = readFileSync(target, "utf8");
      expect(original).toContain("name: jevrev");

      const repeat = run(["--destination", destination]);
      expect(repeat.status).toBe(0);
      expect(repeat.stdout).toContain("already installed");

      writeFileSync(target, "local change\n", "utf8");
      const refused = run(["--destination", destination]);
      expect(refused.status).toBe(1);
      expect(refused.stderr).toContain("--force");
      expect(readFileSync(target, "utf8")).toBe("local change\n");

      const replaced = run(["--destination", destination, "--force"]);
      expect(replaced.status).toBe(0);
      expect(readFileSync(target, "utf8")).toBe(original);
    } finally {
      rmSync(temporaryRoot, { recursive: true, force: true });
    }
  });

  it("supports a non-mutating dry run", () => {
    const temporaryRoot = mkdtempSync(join(tmpdir(), "jevrev-skill-"));
    const destination = join(temporaryRoot, "jevrev");
    try {
      const result = run(["--destination", destination, "--dry-run"]);
      expect(result.status).toBe(0);
      expect(result.stdout.trim()).toBe(join(destination, "SKILL.md"));
    } finally {
      rmSync(temporaryRoot, { recursive: true, force: true });
    }
  });
});
