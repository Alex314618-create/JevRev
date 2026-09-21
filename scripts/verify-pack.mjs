import { execFileSync } from "node:child_process";

const npmCli = process.env.npm_execpath;
if (npmCli === undefined) {
  throw new Error(
    "verify-pack must be run through npm so npm_execpath is available",
  );
}
const output = execFileSync(
  process.execPath,
  [npmCli, "pack", "--dry-run", "--json", "--ignore-scripts"],
  { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] },
);
const [manifest] = JSON.parse(output);

if (manifest === undefined || !Array.isArray(manifest.files)) {
  throw new Error("npm pack did not return a file manifest");
}

const files = new Set(
  manifest.files.map(({ path }) => path.replaceAll("\\", "/")),
);
const required = [
  "dist/cli.js",
  "dist/index.js",
  "dist/index.d.ts",
  "docs/PROTOCOL.md",
  "runtime/server.py",
  "skills/jevrev/SKILL.md",
];
const missing = required.filter((path) => !files.has(path));
const forbidden = [...files].filter(
  (path) =>
    path.startsWith("src/") ||
    path.startsWith("tests/") ||
    path.startsWith("benchmarks/results/") ||
    path.includes("/__pycache__/") ||
    path.endsWith(".map") ||
    path === ".env",
);

if (missing.length > 0 || forbidden.length > 0) {
  if (missing.length > 0) {
    console.error(`Missing required package files: ${missing.join(", ")}`);
  }
  if (forbidden.length > 0) {
    console.error(`Forbidden package files: ${forbidden.join(", ")}`);
  }
  process.exitCode = 1;
} else {
  console.log(
    `Verified ${files.size} package files (${manifest.size} byte tarball, ${manifest.unpackedSize} bytes unpacked).`,
  );
}
