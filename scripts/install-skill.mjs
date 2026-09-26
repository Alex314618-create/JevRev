#!/usr/bin/env node

import { lstat, mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const sourcePath = resolve(scriptDirectory, "..", "skills", "jevrev", "SKILL.md");

class UsageError extends Error {}

function expandHome(value) {
  if (value === "~") return homedir();
  if (value.startsWith("~/") || value.startsWith("~\\")) {
    return join(homedir(), value.slice(2));
  }
  return value;
}

function targetDirectory(target) {
  const configuredCodexHome = process.env.CODEX_HOME?.trim();
  const roots = {
    codex: configuredCodexHome ? expandHome(configuredCodexHome) : join(homedir(), ".codex"),
    agents: join(homedir(), ".agents"),
    opencode: join(homedir(), ".config", "opencode"),
    claude: join(homedir(), ".claude"),
    dsh: join(homedir(), ".dsh"),
  };
  const root = roots[target];
  if (!root) {
    throw new UsageError(`Unknown target "${target}". Choose codex, claude, opencode, agents, or dsh.`);
  }
  return join(root, "skills", "jevrev");
}

function parseArguments(argv) {
  let target;
  let destination;
  let force = false;
  let dryRun = false;

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--help" || argument === "-h") return { help: true };
    if (argument === "--force") {
      force = true;
      continue;
    }
    if (argument === "--dry-run") {
      dryRun = true;
      continue;
    }
    if (argument === "--target" || argument === "--destination") {
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) {
        throw new UsageError(`${argument} requires a value.`);
      }
      index += 1;
      if (argument === "--target") target = value;
      else destination = value;
      continue;
    }
    throw new UsageError(`Unknown option "${argument}". Use --help for usage.`);
  }

  if ((target && destination) || (!target && !destination)) {
    throw new UsageError("Pass exactly one of --target or --destination.");
  }

  return {
    destination: resolve(expandHome(destination ?? targetDirectory(target))),
    force,
    dryRun,
    help: false,
  };
}

function printHelp() {
  process.stdout.write("Install the bundled JevRev agent skill.\n\n");
  process.stdout.write("Usage:\n");
  process.stdout.write("  jevrev-skill-install --target <codex|claude|opencode|agents|dsh>\n");
  process.stdout.write("  jevrev-skill-install --destination <directory>\n\n");
  process.stdout.write("Options:\n");
  process.stdout.write("  --force       replace a different existing SKILL.md\n");
  process.stdout.write("  --dry-run     print the destination without changing files\n");
  process.stdout.write("  --help        show this help\n\n");
  process.stdout.write("The target directories are under the current user's home directory.\n");
  process.stdout.write("Use --destination when a project or tool uses a different root.\n");
}

async function assertDirectoryIsSafe(directory) {
  try {
    const info = await lstat(directory);
    if (info.isSymbolicLink()) {
      throw new Error(`Refusing to use a symbolic-link destination: ${directory}`);
    }
    if (!info.isDirectory()) {
      throw new Error(`Destination is not a directory: ${directory}`);
    }
  } catch (error) {
    if (error?.code === "ENOENT") return;
    throw error;
  }
}

async function installSkill(options) {
  const destination = options.destination;
  const targetPath = join(destination, "SKILL.md");
  const content = await readFile(sourcePath, "utf8");

  if (options.dryRun) {
    process.stdout.write(`${targetPath}\n`);
    return;
  }

  await mkdir(destination, { recursive: true });
  await assertDirectoryIsSafe(destination);

  try {
    const info = await lstat(targetPath);
    if (info.isSymbolicLink()) {
      throw new Error(`Refusing to overwrite a symbolic-link file: ${targetPath}`);
    }
    if (!info.isFile()) {
      throw new Error(`Target exists and is not a regular file: ${targetPath}`);
    }
    const existing = await readFile(targetPath, "utf8");
    if (existing === content) {
      process.stdout.write(`Skill already installed: ${targetPath}\n`);
      return;
    }
    if (!options.force) {
      throw new Error(`Refusing to overwrite an existing skill. Re-run with --force: ${targetPath}`);
    }
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }

  await writeFile(targetPath, content, "utf8");
  process.stdout.write(`Installed JevRev skill: ${targetPath}\n`);
}

try {
  const options = parseArguments(process.argv.slice(2));
  if (options.help) printHelp();
  else await installSkill(options);
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`install-skill: ${message}\n`);
  process.exitCode = error instanceof UsageError ? 2 : 1;
}
