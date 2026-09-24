import { InputError, ProtocolError } from "../domain/errors.js";
import { summarizeMetric } from "../workflow/evidence.js";
import type { MetricObservation } from "../workflow/schemas.js";
import {
  appendUnique,
  evidencePacket,
  withEvidenceBundleLock,
  writeEvidenceBundle,
} from "./store.js";

export type EvidenceResultStatus = "pass" | "fail" | "unknown";

export interface RecordMetricOptions {
  evidencePath: string;
  candidateId: string;
  metric: MetricObservation;
  resultStatus?: EvidenceResultStatus;
  replace?: boolean;
  probeIds?: readonly string[];
  requirementRefs?: readonly string[];
}

function requirementReference(reference: string): {
  kind: "success" | "constraint";
  criterionId: string;
} {
  const separator = reference.indexOf(":");
  const kind = reference.slice(0, separator);
  const criterionId = reference.slice(separator + 1);
  if ((kind !== "success" && kind !== "constraint") || criterionId.length === 0) {
    throw new InputError(`Requirement must be success:<id> or constraint:<id>: ${reference}`);
  }
  return { kind, criterionId };
}

export async function recordMetric(options: RecordMetricOptions) {
  const links = [...(options.probeIds ?? []), ...(options.requirementRefs ?? [])];
  if (links.length > 0 && options.resultStatus === undefined) {
    throw new InputError("--result pass|fail|unknown is required when linking a metric");
  }
  return withEvidenceBundleLock(options.evidencePath, async (path, bundle) => {
    const packet = evidencePacket(bundle, options.candidateId);
    const existingIndex = packet.metrics.findIndex((metric) => metric.id === options.metric.id);
    if (existingIndex >= 0 && !options.replace) {
      throw new ProtocolError(`Metric already exists: ${options.metric.id}; pass --replace to overwrite it`);
    }
    const linkedProbes = packet.probe_results.filter((result) => result.metric_ids.includes(options.metric.id));
    const linkedRequirements = packet.requirement_results.filter((result) => result.metric_ids.includes(options.metric.id));
    const hasExistingLinks = linkedProbes.length > 0 || linkedRequirements.length > 0;
    if (existingIndex >= 0 && options.replace && hasExistingLinks && options.resultStatus === undefined) {
      throw new ProtocolError(`Replacing linked metric ${options.metric.id} requires --result pass|fail|unknown`);
    }
    if (existingIndex >= 0 && options.replace && hasExistingLinks &&
        packet.metrics[existingIndex]!.criterion_id !== options.metric.criterion_id) {
      throw new ProtocolError(`Cannot change the criterion of linked metric ${options.metric.id}`);
    }
    if (existingIndex >= 0) packet.metrics[existingIndex] = options.metric;
    else packet.metrics.push(options.metric);

    if (options.resultStatus !== undefined) {
      for (const result of [...linkedProbes, ...linkedRequirements]) result.status = options.resultStatus;
    }

    for (const probeId of options.probeIds ?? []) {
      const probe = packet.probe_results.find((result) => result.evidence_id === probeId);
      if (probe === undefined) throw new ProtocolError(`Unknown probe evidence ID: ${probeId}`);
      appendUnique(probe.metric_ids, options.metric.id);
      probe.status = options.resultStatus!;
    }
    for (const reference of options.requirementRefs ?? []) {
      const { kind, criterionId } = requirementReference(reference);
      if (criterionId !== options.metric.criterion_id) {
        throw new ProtocolError(`Metric ${options.metric.id} measures ${options.metric.criterion_id}, not ${criterionId}`);
      }
      const requirement = packet.requirement_results.find(
        (result) => result.kind === kind && result.criterion_id === criterionId,
      );
      if (requirement === undefined) throw new ProtocolError(`Unknown requirement: ${reference}`);
      appendUnique(requirement.metric_ids, options.metric.id);
      requirement.status = options.resultStatus!;
    }
    packet.known_failures = packet.known_failures.filter((failure) => !failure.startsWith("TEMPLATE:"));
    await writeEvidenceBundle(path, bundle);
    return summarizeMetric(options.metric);
  });
}
