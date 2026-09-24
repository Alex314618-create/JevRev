import { createHash } from "node:crypto";
import { readFile, realpath, stat } from "node:fs/promises";
import { extname, isAbsolute, relative, resolve } from "node:path";
import { InputError, ProtocolError } from "../domain/errors.js";
import type { EvidenceResultStatus } from "./metric.js";
import {
  appendUnique,
  evidencePacket,
  withEvidenceBundleLock,
  writeEvidenceBundle,
} from "./store.js";

export const DEFAULT_MAX_ARTIFACT_BYTES = 16 * 1024 * 1024;

export interface ArtifactEvaluationInput {
  id: string;
  evaluator: string;
  status: EvidenceResultStatus;
  summary: string;
  criterionId?: string;
  score?: number;
}

export interface RecordArtifactOptions {
  evidencePath: string;
  candidateId: string;
  artifactId: string;
  file: string;
  workspace?: string;
  mediaType?: string;
  excerpt?: boolean;
  replace?: boolean;
  evaluation?: ArtifactEvaluationInput;
  probeIds?: readonly string[];
  requirementRefs?: readonly string[];
  maxBytes?: number;
}

const MEDIA_TYPES: Record<string, string> = {
  ".diff": "text/x-diff",
  ".html": "text/html",
  ".htm": "text/html",
  ".json": "application/json",
  ".js": "text/javascript",
  ".mjs": "text/javascript",
  ".ts": "text/typescript",
  ".tsx": "text/typescript",
  ".md": "text/markdown",
  ".txt": "text/plain",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
};

function inferredMediaType(path: string): string {
  return MEDIA_TYPES[extname(path).toLowerCase()] ?? "application/octet-stream";
}

function textual(mediaType: string): boolean {
  return mediaType.startsWith("text/") ||
    mediaType === "application/json" ||
    mediaType === "application/xml" ||
    mediaType === "image/svg+xml";
}

async function safeArtifactPath(workspaceInput: string, fileInput: string) {
  const workspace = await realpath(resolve(workspaceInput));
  const file = await realpath(resolve(workspace, fileInput));
  const pathFromWorkspace = relative(workspace, file);
  if (pathFromWorkspace === "" || pathFromWorkspace.startsWith("..") || isAbsolute(pathFromWorkspace)) {
    throw new InputError(`Artifact file escapes workspace: ${fileInput}`);
  }
  const metadata = await stat(file);
  if (!metadata.isFile()) throw new InputError(`Artifact is not a regular file: ${fileInput}`);
  return { absolute: file, relative: pathFromWorkspace.replaceAll("\\", "/"), sizeBytes: metadata.size };
}

function parseRequirement(reference: string) {
  const separator = reference.indexOf(":");
  const kind = reference.slice(0, separator);
  const criterionId = reference.slice(separator + 1);
  if ((kind !== "success" && kind !== "constraint") || criterionId.length === 0) {
    throw new InputError(`Requirement must be success:<id> or constraint:<id>: ${reference}`);
  }
  return { kind: kind as "success" | "constraint", criterionId };
}

export async function recordArtifact(options: RecordArtifactOptions) {
  const links = [...(options.probeIds ?? []), ...(options.requirementRefs ?? [])];
  if (links.length > 0 && options.evaluation === undefined) {
    throw new InputError("An artifact evaluation is required when linking an artifact to evidence");
  }
  if (options.evaluation?.score !== undefined &&
      (options.evaluation.score < 0 || options.evaluation.score > 1)) {
    throw new InputError("Artifact evaluation score must be between 0 and 1");
  }
  const artifactPath = await safeArtifactPath(options.workspace ?? process.cwd(), options.file);
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_ARTIFACT_BYTES;
  if (!Number.isInteger(maxBytes) || maxBytes < 1) throw new InputError("max artifact bytes must be a positive integer");
  if (artifactPath.sizeBytes > maxBytes) {
    throw new InputError(`Artifact exceeds the ${maxBytes}-byte limit: ${options.file}`);
  }
  const bytes = await readFile(artifactPath.absolute);
  if (bytes.length > maxBytes) throw new InputError(`Artifact exceeds the ${maxBytes}-byte limit: ${options.file}`);
  const mediaType = options.mediaType ?? inferredMediaType(artifactPath.absolute);
  const artifact = {
    id: options.artifactId,
    path: artifactPath.relative,
    media_type: mediaType,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    size_bytes: bytes.length,
    ...((options.excerpt ?? true) && textual(mediaType)
      ? { content_excerpt: bytes.toString("utf8").slice(0, 4_000) }
      : {}),
  };

  return withEvidenceBundleLock(options.evidencePath, async (path, bundle) => {
    const packet = evidencePacket(bundle, options.candidateId);
    packet.artifacts ??= [];
    const artifactIndex = packet.artifacts.findIndex((item) => item.id === artifact.id);
    if (artifactIndex >= 0 && !options.replace) {
      throw new ProtocolError(`Artifact already exists: ${artifact.id}; pass --replace to overwrite it`);
    }
    const priorEvaluationIds = (packet.artifact_evaluations ?? [])
      .filter((evaluation) => evaluation.artifact_ids.includes(artifact.id))
      .map((evaluation) => evaluation.id);
    if (artifactIndex >= 0 && options.replace && priorEvaluationIds.length > 0 && options.evaluation === undefined) {
      throw new ProtocolError(`Replacing evaluated artifact ${artifact.id} requires a replacement evaluation`);
    }
    if (artifactIndex >= 0 && options.replace && priorEvaluationIds.length > 0 &&
        (priorEvaluationIds.length !== 1 || options.evaluation?.id !== priorEvaluationIds[0])) {
      throw new ProtocolError(`Replacing evaluated artifact ${artifact.id} requires the same evaluation ID: ${priorEvaluationIds.join(", ")}`);
    }
    const priorEvaluation = priorEvaluationIds.length === 1
      ? packet.artifact_evaluations?.find((evaluation) => evaluation.id === priorEvaluationIds[0])
      : undefined;
    if (artifactIndex >= 0 && options.replace && priorEvaluation !== undefined && options.evaluation !== undefined &&
        options.evaluation.criterionId !== undefined && priorEvaluation.criterion_id !== undefined &&
        options.evaluation.criterionId !== priorEvaluation.criterion_id) {
      throw new ProtocolError(`Replacing evaluated artifact ${artifact.id} cannot change its criterion`);
    }
    if (artifactIndex >= 0 && options.replace && priorEvaluationIds.length > 1) {
      throw new ProtocolError(`Artifact ${artifact.id} has multiple evaluations; replace them explicitly before replacing the artifact`);
    }
    if (artifactIndex >= 0 && options.replace && priorEvaluationIds.length === 1 && priorEvaluation === undefined) {
      throw new ProtocolError(`Artifact ${artifact.id} references a missing evaluation`);
    }
    if (artifactIndex >= 0) packet.artifacts[artifactIndex] = artifact;
    else packet.artifacts.push(artifact);

    if (options.evaluation !== undefined) {
      packet.artifact_evaluations ??= [];
      const evaluation = {
        id: options.evaluation.id,
        source: "imported" as const,
        evaluator: options.evaluation.evaluator,
        artifact_ids: [artifact.id],
        ...(options.evaluation.criterionId === undefined && priorEvaluation?.criterion_id === undefined
          ? {}
          : { criterion_id: options.evaluation.criterionId ?? priorEvaluation?.criterion_id }),
        status: options.evaluation.status,
        ...(options.evaluation.score === undefined ? {} : { score: options.evaluation.score }),
        summary: options.evaluation.summary,
      };
      const evaluationIndex = packet.artifact_evaluations.findIndex((item) => item.id === evaluation.id);
      if (evaluationIndex >= 0 && !options.replace) {
        throw new ProtocolError(`Artifact evaluation already exists: ${evaluation.id}; pass --replace to overwrite it`);
      }
      if (evaluationIndex >= 0) packet.artifact_evaluations[evaluationIndex] = evaluation;
      else packet.artifact_evaluations.push(evaluation);

      for (const result of [...packet.probe_results, ...packet.requirement_results]) {
        if (result.artifact_evaluation_ids?.includes(evaluation.id)) result.status = evaluation.status;
      }

      for (const probeId of options.probeIds ?? []) {
        const probe = packet.probe_results.find((result) => result.evidence_id === probeId);
        if (probe === undefined) throw new ProtocolError(`Unknown probe evidence ID: ${probeId}`);
        probe.artifact_evaluation_ids ??= [];
        appendUnique(probe.artifact_evaluation_ids, evaluation.id);
        probe.status = evaluation.status;
      }
      for (const reference of options.requirementRefs ?? []) {
        const { kind, criterionId } = parseRequirement(reference);
        if (evaluation.criterion_id !== criterionId) {
          throw new ProtocolError(`Artifact evaluation ${evaluation.id} measures ${evaluation.criterion_id ?? "no criterion"}, not ${criterionId}`);
        }
        const requirement = packet.requirement_results.find((result) => result.kind === kind && result.criterion_id === criterionId);
        if (requirement === undefined) throw new ProtocolError(`Unknown requirement: ${reference}`);
        requirement.artifact_evaluation_ids ??= [];
        appendUnique(requirement.artifact_evaluation_ids, evaluation.id);
        requirement.status = evaluation.status;
      }
    }

    packet.known_failures = packet.known_failures.filter((failure) => !failure.startsWith("TEMPLATE:"));
    await writeEvidenceBundle(path, bundle);
    return artifact;
  });
}
