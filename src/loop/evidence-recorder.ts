import { createHash, randomUUID } from "node:crypto";
import { open, readFile, realpath, rename, stat as statFile, unlink, writeFile } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import { z } from "zod";
import { InputError, ProtocolError } from "../domain/errors.js";
import { executeCommand } from "../evidence/recorder.js";
import { DEFAULT_MAX_ARTIFACT_BYTES } from "../evidence/artifact.js";
import { loopHash, roundEvidenceSchema, type RoundEvidence } from "./schemas.js";
import { loadLoop } from "./store.js";

const id = z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/);
const INVALID_LOCK_STALE_MS = 10 * 60_000;

export interface RecordLoopCommandOptions {
  directory: string;
  evidencePath: string;
  observationId: string;
  argv: readonly string[];
  criterionIds?: readonly string[];
  protectedSurfaceIds?: readonly string[];
  cwd?: string;
  timeoutMs?: number;
  maxOutputBytes?: number;
  replace?: boolean;
  echo?: boolean;
}

export interface RecordLoopMetricOptions {
  directory: string;
  evidencePath: string;
  metric: unknown;
  criterionId?: string;
  result?: "pass" | "fail" | "unknown";
  replace?: boolean;
}

export interface RecordLoopArtifactOptions {
  directory: string;
  evidencePath: string;
  artifactId: string;
  evaluationId?: string;
  file: string;
  summary: string;
  status: "pass" | "fail" | "unknown";
  criterionId?: string;
  replace?: boolean;
}

const metricInputSchema = z.object({
  id,
  criterion_id: id.optional(),
  unit: z.string().trim().min(1).max(64),
  samples: z.array(z.number().finite()).min(2).max(1_000),
  head_revision: z.string().trim().min(1).max(2_000).optional(),
}).strict();

async function readEvidence(pathInput: string): Promise<{ path: string; evidence: RoundEvidence }> {
  const path = resolve(pathInput);
  let raw: string;
  try { raw = await readFile(path, "utf8"); }
  catch (error) { throw new InputError(`Could not read Loop evidence ${pathInput}`, { cause: error }); }
  try { return { path, evidence: roundEvidenceSchema.parse(JSON.parse(raw) as unknown) }; }
  catch (error) { throw new InputError(`Invalid Loop evidence ${pathInput}`, { cause: error }); }
}

async function writeEvidence(path: string, evidence: RoundEvidence): Promise<void> {
  const validated = roundEvidenceSchema.parse(evidence);
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(validated, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
    await rename(temporary, path);
  } catch (error) {
    await unlink(temporary).catch(() => undefined);
    throw new InputError(`Could not update Loop evidence: ${path}`, { cause: error });
  }
}

async function withEvidenceLock<T>(evidencePath: string, operation: () => Promise<T>): Promise<T> {
  const lockPath = `${resolve(evidencePath)}.lock`;
  const lock = await acquireEvidenceLock(lockPath, evidencePath);
  try { return await operation(); }
  finally { await lock.close(); await unlink(lockPath).catch(() => undefined); }
}

async function acquireEvidenceLock(lockPath: string, evidencePath: string): Promise<Awaited<ReturnType<typeof open>>> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const lock = await open(lockPath, "wx");
      try {
        await lock.writeFile(JSON.stringify({ pid: process.pid, created_at: new Date().toISOString() }));
        await lock.sync();
        return lock;
      } catch (error) {
        await lock.close().catch(() => undefined);
        await unlink(lockPath).catch(() => undefined);
        throw new InputError(`Could not initialize Loop evidence lock: ${evidencePath}`, { cause: error });
      }
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "EEXIST") throw error instanceof InputError ? error : new InputError(`Could not lock Loop evidence: ${evidencePath}`, { cause: error });
      const metadata = await readFile(lockPath, "utf8").then((value) => JSON.parse(value) as unknown).catch(() => undefined);
      const metadataStat = await statFile(lockPath).catch(() => undefined);
      const record = metadata !== null && typeof metadata === "object" &&
        "pid" in metadata && typeof metadata.pid === "number" && Number.isInteger(metadata.pid) && metadata.pid > 0 &&
        "created_at" in metadata && typeof metadata.created_at === "string"
        ? { pid: metadata.pid, createdAt: Date.parse(metadata.created_at) }
        : undefined;
      const alive = record === undefined ? undefined : processAlive(record.pid);
      const stale = record === undefined
        ? metadataStat !== undefined && Date.now() - metadataStat.mtimeMs >= INVALID_LOCK_STALE_MS
        : alive === false;
      if (!stale || attempt > 0) throw new InputError(`Loop evidence is being updated (or has a stale lock): ${evidencePath}`, { cause: error });
      const tombstone = `${lockPath}.${randomUUID()}.stale`;
      try {
        await rename(lockPath, tombstone);
        await unlink(tombstone).catch(() => undefined);
      } catch (takeoverError) {
        throw new InputError(`Could not recover stale Loop evidence lock: ${evidencePath}`, { cause: takeoverError });
      }
    }
  }
  throw new InputError(`Could not lock Loop evidence: ${evidencePath}`);
}

function processAlive(pid: number): boolean | undefined {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code === "ESRCH" ? false : undefined;
  }
}

function assertActiveEvidence(evidence: RoundEvidence, loop: Awaited<ReturnType<typeof loadLoop>>): void {
  const order = loop.state.active_order;
  if (order === null) throw new InputError(`Loop has no active round (status: ${loop.state.status})`);
  if (evidence.loop_id !== loop.state.loop_id || evidence.round_number !== order.round_number ||
      evidence.spec_sha256 !== loop.state.spec_sha256 || evidence.work_order_sha256 !== loopHash(order) ||
      evidence.base_revision !== order.base_revision) {
    throw new ProtocolError("Loop evidence is not bound to the active work order");
  }
}

function claimById(evidence: RoundEvidence, criterionId: string, protectedSurface: boolean) {
  const claims = protectedSurface ? evidence.protected_surface_results : evidence.criterion_results;
  const claim = claims.find((item) => item.id === criterionId);
  if (claim === undefined) throw new InputError(`Unknown ${protectedSurface ? "protected surface" : "criterion"}: ${criterionId}`);
  return claim;
}

function linkObservation(evidence: RoundEvidence, idValue: string, criterionIds: readonly string[], protectedSurfaceIds: readonly string[], passed: boolean): void {
  for (const criterionId of criterionIds) {
    const claim = claimById(evidence, criterionId, false);
    if (!claim.observation_ids.includes(idValue)) claim.observation_ids.push(idValue);
    claim.status = passed ? "pass" : "fail";
  }
  for (const surfaceId of protectedSurfaceIds) {
    const claim = claimById(evidence, surfaceId, true);
    if (!claim.observation_ids.includes(idValue)) claim.observation_ids.push(idValue);
    claim.status = passed ? "pass" : "fail";
  }
}

async function recordLoopCommandUnlocked(options: RecordLoopCommandOptions): Promise<RoundEvidence["observations"][number]> {
  const loop = await loadLoop(options.directory);
  const { path, evidence } = await readEvidence(options.evidencePath);
  assertActiveEvidence(evidence, loop);
  const existing = evidence.observations.findIndex((item) => item.id === options.observationId);
  if (existing >= 0 && !options.replace) throw new ProtocolError(`Loop observation already exists: ${options.observationId}; pass --replace to overwrite it`);
  const executed = await executeCommand({
    argv: options.argv,
    workspace: await realpath(resolve(loop.spec.workspace)).catch((error) => { throw new InputError(`Could not resolve Loop workspace ${loop.spec.workspace}`, { cause: error }); }),
    ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
    ...(options.maxOutputBytes === undefined ? {} : { maxOutputBytes: options.maxOutputBytes }),
    ...(options.echo === undefined ? {} : { echo: options.echo }),
  });
  const observation = {
    id: options.observationId,
    exit_code: executed.exit_code,
    duration_ms: executed.duration_ms,
    head_revision: evidence.head_revision,
    termination: executed.termination,
    source: "recorded" as const,
    stdout_sha256: executed.stdout_sha256,
    stderr_sha256: executed.stderr_sha256,
  };
  const priorDuration = existing >= 0 ? evidence.observations[existing]!.duration_ms : 0;
  if (existing >= 0) evidence.observations[existing] = observation;
  else evidence.observations.push(observation);
  evidence.wall_ms += executed.duration_ms - priorDuration;
  linkObservation(evidence, options.observationId, options.criterionIds ?? [], options.protectedSurfaceIds ?? [], executed.exit_code === 0 && executed.termination === "exited");
  await writeEvidence(path, evidence);
  return observation;
}

export function recordLoopCommand(options: RecordLoopCommandOptions): Promise<RoundEvidence["observations"][number]> {
  return withEvidenceLock(options.evidencePath, () => recordLoopCommandUnlocked(options));
}

async function recordLoopMetricUnlocked(options: RecordLoopMetricOptions): Promise<RoundEvidence["metrics"][number]> {
  const loop = await loadLoop(options.directory);
  const { path, evidence } = await readEvidence(options.evidencePath);
  assertActiveEvidence(evidence, loop);
  const parsed = metricInputSchema.parse(options.metric);
  const criterionId = options.criterionId ?? parsed.criterion_id;
  if (criterionId === undefined) throw new InputError("Loop metric needs --criterion or metric JSON criterion_id");
  const specCriterion = loop.spec.criteria.find((item) => item.id === criterionId);
  if (specCriterion?.type !== "metric") throw new InputError(`Loop metric criterion must be a metric criterion: ${criterionId}`);
  if (specCriterion.unit !== parsed.unit) throw new ProtocolError(`Loop metric unit does not match criterion ${criterionId}`);
  const criterion = claimById(evidence, criterionId, false);
  const metric = { id: parsed.id, criterion_id: criterionId, unit: parsed.unit, samples: parsed.samples, head_revision: parsed.head_revision ?? evidence.head_revision };
  if (metric.head_revision !== evidence.head_revision) throw new ProtocolError("Loop metric must target the evidence head revision");
  const existing = evidence.metrics.findIndex((item) => item.id === metric.id);
  if (existing >= 0 && !options.replace) throw new ProtocolError(`Loop metric already exists: ${metric.id}; pass --replace to overwrite it`);
  if (existing >= 0) evidence.metrics[existing] = metric;
  else evidence.metrics.push(metric);
  if (!criterion.metric_ids.includes(metric.id)) criterion.metric_ids.push(metric.id);
  if (options.result !== undefined) criterion.status = options.result;
  await writeEvidence(path, evidence);
  return metric;
}

export function recordLoopMetric(options: RecordLoopMetricOptions): Promise<RoundEvidence["metrics"][number]> {
  return withEvidenceLock(options.evidencePath, () => recordLoopMetricUnlocked(options));
}

async function recordLoopArtifactUnlocked(options: RecordLoopArtifactOptions): Promise<RoundEvidence["artifact_evaluations"][number]> {
  const loop = await loadLoop(options.directory);
  const { path, evidence } = await readEvidence(options.evidencePath);
  assertActiveEvidence(evidence, loop);
  const workspace = await realpath(resolve(loop.spec.workspace)).catch((error) => { throw new InputError(`Could not resolve Loop workspace ${loop.spec.workspace}`, { cause: error }); });
  const file = resolve(workspace, options.file);
  const realFile = await realpath(file).catch((error) => { throw new InputError(`Could not read Loop artifact ${options.file}`, { cause: error }); });
  const relativePath = relative(workspace, realFile).replaceAll("\\", "/");
  if (relativePath.startsWith("..") || isAbsolute(relativePath)) throw new InputError("Loop artifact escapes the workspace");
  const metadata = await statFile(realFile).catch((error) => { throw new InputError(`Could not stat Loop artifact ${options.file}`, { cause: error }); });
  if (!metadata.isFile()) throw new InputError(`Loop artifact is not a regular file: ${options.file}`);
  if (metadata.size > DEFAULT_MAX_ARTIFACT_BYTES) throw new InputError(`Loop artifact exceeds the ${DEFAULT_MAX_ARTIFACT_BYTES}-byte limit: ${options.file}`);
  const content = await readFile(realFile).catch((error) => { throw new InputError(`Could not read Loop artifact ${options.file}`, { cause: error }); });
  const artifact = {
    id: options.evaluationId ?? options.artifactId,
    artifact_id: options.artifactId,
    sha256: createHash("sha256").update(content).digest("hex"),
    status: options.status,
    head_revision: evidence.head_revision,
    source: "imported" as const,
    path: relativePath,
    summary: options.summary,
  };
  const existing = evidence.artifact_evaluations.findIndex((item) => item.id === artifact.id);
  if (existing >= 0 && !options.replace) throw new ProtocolError(`Loop artifact evaluation already exists: ${artifact.id}; pass --replace to overwrite it`);
  if (existing >= 0) evidence.artifact_evaluations[existing] = artifact;
  else evidence.artifact_evaluations.push(artifact);
  if (options.criterionId !== undefined) {
    const criterion = claimById(evidence, options.criterionId, false);
    if (!criterion.artifact_evaluation_ids.includes(artifact.id)) criterion.artifact_evaluation_ids.push(artifact.id);
    criterion.status = options.status;
  }
  await writeEvidence(path, evidence);
  return artifact;
}

export function recordLoopArtifact(options: RecordLoopArtifactOptions): Promise<RoundEvidence["artifact_evaluations"][number]> {
  return withEvidenceLock(options.evidencePath, () => recordLoopArtifactUnlocked(options));
}
