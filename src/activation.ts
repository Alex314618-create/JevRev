import { createHash } from "node:crypto";
import {
  activationDecisionSchema,
  activationRequestSchema,
  type ActivationDecision,
  type ActivationReason,
  type ActivationRequest,
} from "./domain/schemas.js";

export const ACTIVATION_POLICY = {
  name: "activation-v1" as const,
  mode: "shadow" as const,
  thresholds: {
    minimum_expected_loss: 0.35,
    minimum_advantage: 0.05,
    minimum_candidates: 2,
  },
};

const REASON_LABELS: Record<ActivationReason["code"], string> = {
  INSUFFICIENT_ALTERNATIVES: "fewer than two materially different alternatives",
  LOW_WRONG_PATH_LOSS: "the expected cost of a wrong path is low",
  LOW_UNCERTAINTY: "the decision is already well understood",
  HIGH_REVERSIBILITY: "the decision is cheap to undo",
  STRONG_EXISTING_EVIDENCE: "existing evidence already covers the decision",
  DIVERSE_MECHANISMS: "the alternatives use materially different mechanisms",
  INTERACTING_CONSTRAINTS: "the constraints may change which approach is viable",
  CHEAP_TO_PROBE: "a bounded probe can cheaply distinguish the alternatives",
  EXPLORATION_COST_TOO_HIGH: "the estimated Sift cost outweighs the avoidable loss",
  LOSS_OUTWEIGHS_EXPLORATION_COST: "the avoidable loss outweighs the estimated Sift cost",
  LOW_EXPECTED_VALUE: "the structural signals do not justify opening a Sift campaign",
};

function round(value: number, digits = 4): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function clamp(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function shortHash(value: unknown, prefix: "jva" | "jvt"): string {
  return `${prefix}_${createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 12)}`;
}

function reason(code: ActivationReason["code"], signal?: string): ActivationReason {
  return signal === undefined ? { code } : { code, signal };
}

/**
 * Decide whether opening Sift is worth its exploration budget. This is a
 * deterministic shadow policy: it never calls a judge and never changes the
 * host agent's workflow by itself.
 */
export function evaluateActivation(request: ActivationRequest): ActivationDecision {
  const parsed = activationRequestSchema.parse(request);
  const { assessment } = parsed;
  const structuralScore =
    0.18 * assessment.mechanism_diversity +
    0.18 * assessment.uncertainty +
    0.18 * assessment.probeability +
    0.16 * assessment.constraint_interaction +
    0.15 * (1 - assessment.reversibility) +
    0.1 * (1 - assessment.existing_evidence) +
    0.05 * Math.min(1, assessment.candidate_count / 5);
  const structuralFactor = clamp(0.5 + 0.5 * structuralScore);
  const adjustedLoss = clamp(assessment.wrong_path_loss * structuralFactor);
  const candidateCostFactor = 0.75 + 0.25 * Math.min(1, assessment.candidate_count / 12);
  const adjustedCost = clamp(assessment.exploration_cost * candidateCostFactor);
  const advantage = round(adjustedLoss - adjustedCost);

  const reasons: ActivationReason[] = [];
  if (assessment.candidate_count < ACTIVATION_POLICY.thresholds.minimum_candidates) {
    reasons.push(reason("INSUFFICIENT_ALTERNATIVES", "candidate_count"));
  }
  if (assessment.wrong_path_loss < ACTIVATION_POLICY.thresholds.minimum_expected_loss) {
    reasons.push(reason("LOW_WRONG_PATH_LOSS", "wrong_path_loss"));
  }
  if (assessment.uncertainty < 0.25) reasons.push(reason("LOW_UNCERTAINTY", "uncertainty"));
  if (assessment.reversibility > 0.75) reasons.push(reason("HIGH_REVERSIBILITY", "reversibility"));
  if (assessment.existing_evidence > 0.75) reasons.push(reason("STRONG_EXISTING_EVIDENCE", "existing_evidence"));
  if (assessment.mechanism_diversity >= 0.65) reasons.push(reason("DIVERSE_MECHANISMS", "mechanism_diversity"));
  if (assessment.constraint_interaction >= 0.65) reasons.push(reason("INTERACTING_CONSTRAINTS", "constraint_interaction"));
  if (assessment.probeability >= 0.65) reasons.push(reason("CHEAP_TO_PROBE", "probeability"));

  const eligible = assessment.candidate_count >= ACTIVATION_POLICY.thresholds.minimum_candidates;
  const worthwhile =
    eligible &&
    adjustedLoss >= ACTIVATION_POLICY.thresholds.minimum_expected_loss &&
    advantage >= ACTIVATION_POLICY.thresholds.minimum_advantage;

  if (worthwhile) {
    reasons.push(reason("LOSS_OUTWEIGHS_EXPLORATION_COST"));
  } else if (advantage < ACTIVATION_POLICY.thresholds.minimum_advantage) {
    reasons.push(reason("EXPLORATION_COST_TOO_HIGH", "advantage"));
  } else {
    reasons.push(reason("LOW_EXPECTED_VALUE"));
  }

  return activationDecisionSchema.parse({
    kind: "jevrev.activation-decision",
    schema_version: "1",
    run_id: shortHash(parsed, "jva"),
    policy: ACTIVATION_POLICY,
    task: {
      goal: parsed.task.goal,
      task_id: shortHash(parsed.task, "jvt"),
    },
    assessment,
    calculation: {
      structural_factor: round(structuralFactor),
      adjusted_wrong_path_loss: round(adjustedLoss),
      adjusted_exploration_cost: round(adjustedCost),
      advantage,
    },
    decision: worthwhile ? "sift" : "bypass",
    shadow: true,
    reasons,
  });
}

export function activationReasonLabel(reasonValue: ActivationReason): string {
  return REASON_LABELS[reasonValue.code];
}

export function renderActivationHuman(decision: ActivationDecision): string {
  const lines = [
    `JevRev activation ${decision.run_id} | shadow policy ${decision.policy.name}`,
    `${decision.decision === "sift" ? "Sift is worthwhile" : "Bypass Sift"} (advisory; no workflow change)`,
    `loss ${decision.calculation.adjusted_wrong_path_loss.toFixed(3)} | cost ${decision.calculation.adjusted_exploration_cost.toFixed(3)} | advantage ${decision.calculation.advantage.toFixed(3)}`,
    "",
    "Reasons:",
    ...decision.reasons.map((item) => `- ${activationReasonLabel(item)}${item.signal === undefined ? "" : ` [${item.signal}]`}`),
    "",
    "This result is shadow-only. The host agent still chooses whether to call `jevrev sift`.",
  ];
  return `${lines.join("\n")}\n`;
}

export function renderActivationJson(decision: ActivationDecision): string {
  return `${JSON.stringify(decision, null, 2)}\n`;
}
