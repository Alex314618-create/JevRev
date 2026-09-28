import { randomUUID } from "node:crypto";
import { open, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { InputError, ProtocolError } from "../domain/errors.js";
import {
  evidenceBundleSchema,
  type EvidenceBundle,
  type EvidencePacket,
} from "../workflow/schemas.js";
import { readJsonFile } from "../io/json.js";
import { formatZodError } from "../io/validation.js";

const LOCK_WAIT_MS = 5_000;

interface EvidenceLock {
  handle: Awaited<ReturnType<typeof open>>;
  path: string;
  token: string;
}

async function acquireEvidenceLock(lockPath: string, evidencePath: string): Promise<EvidenceLock> {
  const startedAt = Date.now();
  while (Date.now() - startedAt <= LOCK_WAIT_MS) {
    const token = randomUUID();
    try {
      const lock = await open(lockPath, "wx");
      try {
        await lock.writeFile(JSON.stringify({ pid: process.pid, created_at: new Date().toISOString(), token }));
        await lock.sync();
        return { handle: lock, path: lockPath, token };
      } catch (error) {
        await lock.close().catch(() => undefined);
        await unlink(lockPath).catch(() => undefined);
        throw new InputError(`Could not initialize evidence lock: ${evidencePath}`, { cause: error });
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
        throw error instanceof InputError ? error : new InputError(`Could not lock evidence bundle: ${evidencePath}`, { cause: error });
      }
      const metadata = await readFile(lockPath, "utf8")
        .then((value) => JSON.parse(value) as { pid?: unknown })
        .catch(() => undefined);
      if (typeof metadata?.pid === "number" && Number.isInteger(metadata.pid) && metadata.pid > 0 && !processAlive(metadata.pid)) {
        throw new InputError(
          `Evidence bundle has a stale lock: ${lockPath}. Verify that no writer is active, then remove the lock manually.`,
        );
      }
      await new Promise<void>((resolvePromise) => setTimeout(resolvePromise, 10));
    }
  }
  throw new InputError(
    `Evidence bundle is being updated: ${evidencePath}. If no process owns ${lockPath}, remove the lock after verifying that no writer is active.`,
  );
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

async function releaseEvidenceLock(lock: EvidenceLock): Promise<void> {
  await lock.handle.close().catch(() => undefined);
  const metadata = await readFile(lock.path, "utf8")
    .then((value) => JSON.parse(value) as { token?: unknown })
    .catch(() => undefined);
  if (metadata?.token === lock.token) await unlink(lock.path).catch(() => undefined);
}

export async function readEvidenceBundle(pathInput: string): Promise<{
  path: string;
  bundle: EvidenceBundle;
}> {
  const path = resolve(pathInput);
  const raw = await readJsonFile(path);
  const parsed = evidenceBundleSchema.safeParse(raw);
  if (!parsed.success) {
    throw new InputError(`Invalid evidence bundle: ${formatZodError(parsed.error)}`);
  }
  return { path, bundle: parsed.data };
}

export async function writeEvidenceBundle(path: string, value: EvidenceBundle): Promise<void> {
  const validated = evidenceBundleSchema.parse(value);
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(validated, null, 2)}\n`, "utf8");
    try {
      await rename(temporary, path);
    } catch (error) {
      // Windows does not replace an existing file with rename. The caller holds
      // the evidence lock, so removing the old snapshot here is safe.
      if ((error as NodeJS.ErrnoException).code !== "EPERM" && (error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      await unlink(path).catch((unlinkError) => {
        if ((unlinkError as NodeJS.ErrnoException).code !== "ENOENT") throw unlinkError;
      });
      await rename(temporary, path);
    }
  } catch (error) {
    await unlink(temporary).catch(() => undefined);
    throw new InputError(`Could not update evidence bundle: ${path}`, { cause: error });
  }
}

export async function withEvidenceBundleLock<T>(
  pathInput: string,
  operation: (path: string, bundle: EvidenceBundle) => Promise<T>,
): Promise<T> {
  const path = resolve(pathInput);
  const lock = await acquireEvidenceLock(`${path}.lock`, path);
  try {
    const { bundle } = await readEvidenceBundle(path);
    return await operation(path, bundle);
  } finally {
    await releaseEvidenceLock(lock);
  }
}

export function evidencePacket(bundle: EvidenceBundle, candidateId: string): EvidencePacket {
  const packet = bundle.packets.find((item) => item.candidate_id === candidateId);
  if (packet === undefined) throw new ProtocolError(`Unknown evidence candidate: ${candidateId}`);
  return packet;
}

export function appendUnique(values: string[], value: string): void {
  if (!values.includes(value)) values.push(value);
}
