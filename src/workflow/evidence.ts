import { createHash } from "node:crypto";
import { ProtocolError } from "../domain/errors.js";
import { campaignId, candidateDigest } from "./campaign.js";
import type {
  Campaign,
  DecideReasonCode,
  EvidenceBundle,
  EvidencePacket,
  MetricObservation,
  MetricSummary,
} from "./schemas.js";

export interface PreparedEvaluation {
  candidate_id: string;
  packet?: EvidencePacket;
  status: "viable" | "rejected" | "incomplete";
  reasons: DecideReasonCode[];
  objective: {
    required_commands_passed: boolean;
    requirements_complete: boolean;
    within_budget: boolean;
    metrics: MetricSummary[];
  };
}

export interface PreparedDecision {
  campaign: Campaign;
  bundle: EvidenceBundle;
  evaluations: PreparedEvaluation[];
  viable: PreparedEvaluation[];
}

export function workflowDigest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function mean(values: readonly number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function sampleSd(values: readonly number[], average: number): number {
  const variance = values.reduce((sum, value) => sum + (value - average) ** 2, 0) /
    (values.length - 1);
  return Math.sqrt(variance);
}

const rounded = (value: number): number => Math.round(value * 1e6) / 1e6;

export function summarizeMetric(metric: MetricObservation): MetricSummary {
  const baselineMean = mean(metric.baseline_samples);
  const candidateMean = mean(metric.candidate_samples);
  const denominator = Math.abs(baselineMean);
  const rawImprovement = metric.direction === "higher"
    ? candidateMean - baselineMean
    : baselineMean - candidateMean;
  return {
    metric_id: metric.id,
    criterion_id: metric.criterion_id,
    unit: metric.unit,
    direction: metric.direction,
    sample_count: {
      baseline: metric.baseline_samples.length,
      candidate: metric.candidate_samples.length,
    },
    baseline_mean: rounded(baselineMean),
    candidate_mean: rounded(candidateMean),
    baseline_sample_sd: rounded(sampleSd(metric.baseline_samples, baselineMean)),
    candidate_sample_sd: rounded(sampleSd(metric.candidate_samples, candidateMean)),
    relative_improvement: denominator === 0 ? null : rounded(rawImprovement / denominator),
  };
}

export function prepareDecision(
  campaign: Campaign,
  bundle: EvidenceBundle,
): PreparedDecision {
  if (campaign.campaign_id !== campaignId(campaign)) {
    throw new ProtocolError("Campaign ID does not match its frozen request and sift result");
  }
  if (bundle.campaign_id !== campaign.campaign_id) {
    throw new ProtocolError("Evidence bundle does not belong to this campaign");
  }

  const candidates = new Map(campaign.request.candidates.map((candidate) => [candidate.id, candidate]));
  const packets = new Map(bundle.packets.map((packet) => [packet.candidate_id, packet]));
  const allWorkOrders = [...campaign.work_orders, ...campaign.review_work_orders];
  const expectedIds = new Set(allWorkOrders.map((workOrder) => workOrder.candidate_id));
  for (const packet of bundle.packets) {
    if (!expectedIds.has(packet.candidate_id)) {
      throw new ProtocolError(`Evidence references non-finalist candidate: ${packet.candidate_id}`);
    }
  }

  const baseCommits = new Set(bundle.packets.map((packet) => packet.revision.base_commit));
  if (baseCommits.size > 1) {
    throw new ProtocolError("Evidence packets must share the same base commit");
  }

  const requiredRequirements = [
    ...campaign.request.task.success.map((criterion) => ({ id: criterion.id, kind: "success" as const })),
    ...campaign.request.task.constraints
      .filter((constraint) => constraint.kind === "hard")
      .map((constraint) => ({ id: constraint.id, kind: "constraint" as const })),
  ];
  const knownRequirements = new Set([
    ...campaign.request.task.success.map((criterion) => `success:${criterion.id}`),
    ...campaign.request.task.constraints.map((constraint) => `constraint:${constraint.id}`),
  ]);

  const evaluations = allWorkOrders.map((workOrder): PreparedEvaluation => {
    const candidate = candidates.get(workOrder.candidate_id);
    if (candidate === undefined) {
      throw new ProtocolError(`Campaign work order references unknown candidate: ${workOrder.candidate_id}`);
    }
    if (workOrder.candidate_sha256 !== candidateDigest(candidate)) {
      throw new ProtocolError(`Campaign candidate hash is invalid: ${candidate.id}`);
    }
    const packet = packets.get(workOrder.candidate_id);
    const baseObjective = {
      required_commands_passed: false,
      requirements_complete: false,
      within_budget: false,
      metrics: [] as MetricSummary[],
    };
    if (packet === undefined) {
      return {
        candidate_id: candidate.id,
        status: "incomplete",
        reasons: ["MISSING_EVIDENCE"],
        objective: baseObjective,
      };
    }
    if (packet.candidate_sha256 !== workOrder.candidate_sha256) {
      throw new ProtocolError(`Evidence candidate hash does not match campaign: ${candidate.id}`);
    }
    const totalCommandMs = packet.observations.reduce(
      (total, observation) => total + observation.duration_ms,
      0,
    );
    if (packet.development.wall_ms < totalCommandMs) {
      throw new ProtocolError(
        `Development wall_ms is less than recorded command duration total for ${candidate.id}`,
      );
    }

    const knownProbeEvidence = new Set(workOrder.required_evidence.map((item) => item.id));
    for (const result of packet.probe_results) {
      if (!knownProbeEvidence.has(result.evidence_id)) {
        throw new ProtocolError(`Evidence contains unknown probe requirement: ${result.evidence_id}`);
      }
    }

    for (const result of packet.requirement_results) {
      const key = `${result.kind}:${result.criterion_id}`;
      if (!knownRequirements.has(key)) {
        throw new ProtocolError(`Evidence contains unknown requirement: ${key}`);
      }
      for (const metricId of result.metric_ids) {
        const metric = packet.metrics.find((entry) => entry.id === metricId);
        if (metric?.criterion_id !== result.criterion_id) {
          throw new ProtocolError(
            `Metric ${metricId} does not measure requirement ${result.criterion_id}`,
          );
        }
      }
    }

    const reasons: DecideReasonCode[] = [];
    const addReason = (reason: DecideReasonCode): void => {
      if (!reasons.includes(reason)) reasons.push(reason);
    };
    if (packet.development.status === "not_started") addReason("DEVELOPMENT_NOT_STARTED");
    if (packet.development.status === "failed") addReason("DEVELOPMENT_FAILED");
    if (packet.development.status === "stopped") addReason("DEVELOPMENT_STOPPED");

    const requirementMap = new Map(
      packet.requirement_results.map((result) => [`${result.kind}:${result.criterion_id}`, result]),
    );
    let requirementsComplete = true;
    for (const required of requiredRequirements) {
      const result = requirementMap.get(`${required.kind}:${required.id}`);
      if (result === undefined || result.status === "unknown") {
        requirementsComplete = false;
        addReason("MISSING_REQUIREMENT");
      } else if (result.status === "fail") {
        addReason("REQUIREMENT_FAILED");
      }
    }

    const probeMap = new Map(
      packet.probe_results.map((result) => [result.evidence_id, result]),
    );
    for (const required of workOrder.required_evidence) {
      const result = probeMap.get(required.id);
      if (result === undefined || result.status === "unknown") {
        requirementsComplete = false;
        addReason("MISSING_PROBE_EVIDENCE");
      } else if (result.status === "fail") {
        addReason("PROBE_EVIDENCE_FAILED");
      }
    }

    const mandatoryResults = [
      ...requiredRequirements.map((required) =>
        requirementMap.get(`${required.kind}:${required.id}`)),
      ...workOrder.required_evidence.map((required) => probeMap.get(required.id)),
    ].filter((result) => result !== undefined);
    const artifactEvaluationMap = new Map(
      (packet.artifact_evaluations ?? []).map((evaluation) => [evaluation.id, evaluation]),
    );
    const mandatoryArtifactEvaluationIds = new Set(
      mandatoryResults.flatMap((result) => result.artifact_evaluation_ids ?? []),
    );
    for (const evaluationId of mandatoryArtifactEvaluationIds) {
      const evaluation = artifactEvaluationMap.get(evaluationId);
      if (evaluation?.status === "fail") addReason("ARTIFACT_EVALUATION_FAILED");
      else if (evaluation === undefined || evaluation.status === "unknown") {
        requirementsComplete = false;
        addReason("MISSING_ARTIFACT_EVALUATION");
      }
    }
    const citedObservationIds = new Set(
      mandatoryResults.flatMap((result) => result.observation_ids),
    );
    const requiredCommands = packet.observations.filter(
      (observation) => observation.required || citedObservationIds.has(observation.id),
    );
    const requiredCommandsPassed =
      requiredCommands.length > 0 &&
      requiredCommands.every((observation) =>
        observation.exit_code === 0 &&
        observation.termination !== "timed_out" &&
        observation.termination !== "spawn_error" &&
        observation.termination !== "buffer_exceeded",
      );
    if (requiredCommands.length === 0) addReason("MISSING_REQUIRED_COMMAND");
    else if (!requiredCommandsPassed) addReason("REQUIRED_COMMAND_FAILED");

    const withinWallBudget = packet.development.wall_ms <= workOrder.budget.max_wall_ms;
    const withinFileBudget = packet.changed_files.length <= workOrder.budget.max_changed_files;
    if (!withinWallBudget) addReason("WALL_BUDGET_EXCEEDED");
    if (!withinFileBudget) addReason("FILE_BUDGET_EXCEEDED");

    const incompleteReasons = new Set<DecideReasonCode>([
      "DEVELOPMENT_NOT_STARTED",
      "MISSING_REQUIRED_COMMAND",
      "MISSING_REQUIREMENT",
      "MISSING_PROBE_EVIDENCE",
      "MISSING_ARTIFACT_EVALUATION",
    ]);
    const incomplete = reasons.some((reason) => incompleteReasons.has(reason));
    const rejected = reasons.some((reason) => !incompleteReasons.has(reason));
    return {
      candidate_id: candidate.id,
      packet,
      status: rejected ? "rejected" : incomplete ? "incomplete" : "viable",
      reasons,
      objective: {
        required_commands_passed: requiredCommandsPassed,
        requirements_complete: requirementsComplete,
        within_budget: withinWallBudget && withinFileBudget,
        metrics: packet.metrics.map(summarizeMetric),
      },
    };
  });

  return {
    campaign,
    bundle,
    evaluations,
    viable: evaluations.filter((evaluation) => evaluation.status === "viable"),
  };
}
