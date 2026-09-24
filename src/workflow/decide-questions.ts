import { noul, score, type Question } from "@typesafe-ai/sdk";
import { basename } from "node:path";
import type { QuestionPlan } from "../questions.js";
import type { PreparedDecision } from "./evidence.js";

export const DECIDE_SIGNALS = [
  "evidence_support",
  "reproducibility",
  "residual_risk_acceptance",
  "shipping_value",
] as const;
export type DecideSignal = (typeof DECIDE_SIGNALS)[number];

export function finalistQuestionKey(index: number, signal: DecideSignal): string {
  return `finalist_${index}_${signal}`;
}

export function complementarityQuestionKey(left: number, right: number): string {
  return `finalist_pair_${left}_${right}_complementary`;
}

const SUPPORT_RUBRIC = [
  "The evidence does not support the success criteria.",
  "The evidence is indirect or leaves major alternative explanations.",
  "The evidence supports the main claim with bounded uncertainty.",
  "The evidence directly and causally supports every material success claim.",
] as const;

const REPRODUCIBILITY_RUBRIC = [
  "The result cannot be reproduced from the recorded observations.",
  "The result depends on a single weak or poorly controlled observation.",
  "The result has repeatable observations with minor remaining uncertainty.",
  "The result is well controlled, repeatable, and independently falsifiable.",
] as const;

const PRIVATE_KEY_BLOCK = /-----BEGIN [^-\r\n]*PRIVATE KEY-----[\s\S]*?-----END [^-\r\n]*PRIVATE KEY-----/gi;
const SECRET_VALUE = /(?:\b(?:bearer|basic)\s+[^\s"',;]+|(?:api)?key_[A-Za-z0-9_-]{8,}|sk-[A-Za-z0-9_-]{8,}|gh[pousr]_[A-Za-z0-9_]{8,}|AIza[0-9A-Za-z_-]{12,}|(?:api[_-]?key|access[_-]?token|token|password|secret)\s*[:=]\s*[^\s"',;]+)/gi;
const URL_SECRET_VALUE = /([?&](?:api[_-]?key|access[_-]?token|token|password|secret)=)[^&#\s]+/gi;

function redactJudgeText(value: string): string {
  return value
    .replace(PRIVATE_KEY_BLOCK, "[REDACTED]")
    .replace(SECRET_VALUE, "[REDACTED]")
    .replace(URL_SECRET_VALUE, "$1[REDACTED]");
}

function judgeObservation(observation: NonNullable<PreparedDecision["viable"][number]["packet"]>["observations"][number]) {
  return {
    id: observation.id,
    kind: observation.kind,
    command: basename(observation.argv[0] ?? "unknown"),
    argument_count: Math.max(0, observation.argv.length - 1),
    exit_code: observation.exit_code,
    termination: observation.termination,
    duration_ms: observation.duration_ms,
    required: observation.required,
    ...(observation.stdout_sha256 === undefined ? {} : { stdout_sha256: observation.stdout_sha256 }),
    ...(observation.stderr_sha256 === undefined ? {} : { stderr_sha256: observation.stderr_sha256 }),
    ...(observation.stdout_bytes === undefined ? {} : { stdout_bytes: observation.stdout_bytes }),
    ...(observation.stderr_bytes === undefined ? {} : { stderr_bytes: observation.stderr_bytes }),
  };
}

function judgeArtifact(
  artifact: NonNullable<NonNullable<PreparedDecision["viable"][number]["packet"]>["artifacts"]>[number],
) {
  return {
    id: artifact.id,
    path: artifact.path,
    media_type: artifact.media_type,
    sha256: artifact.sha256,
    size_bytes: artifact.size_bytes,
  };
}

function judgeArtifactEvaluation(
  evaluation: NonNullable<NonNullable<PreparedDecision["viable"][number]["packet"]>["artifact_evaluations"]>[number],
) {
  return {
    id: evaluation.id,
    source: evaluation.source,
    evaluator: evaluation.evaluator,
    artifact_ids: evaluation.artifact_ids,
    ...(evaluation.criterion_id === undefined ? {} : { criterion_id: evaluation.criterion_id }),
    status: evaluation.status,
    ...(evaluation.score === undefined ? {} : { score: evaluation.score }),
    summary: redactJudgeText(evaluation.summary),
    ...(evaluation.output_sha256 === undefined ? {} : { output_sha256: evaluation.output_sha256 }),
  };
}

export function buildDecidePlan(
  prepared: PreparedDecision,
  options: { canonicalize?: boolean } = {},
): QuestionPlan {
  const source = prepared.viable;
  const candidateOrder = (options.canonicalize ?? false)
    ? source
        .map((evaluation, index) => ({ id: evaluation.candidate_id, index }))
        .sort((left, right) => left.id.localeCompare(right.id))
        .map(({ index }) => index)
    : source.map((_evaluation, index) => index);
  const finalists = candidateOrder.map((index) => source[index]!);
  const questions: Record<string, Question> = {};
  const expectedTypes: Record<string, Question["type"]> = {};
  const add = (key: string, question: Question): void => {
    questions[key] = question;
    expectedTypes[key] = question.type;
  };

  finalists.forEach((_finalist, index) => {
    add(
      finalistQuestionKey(index, "evidence_support"),
      score(
        `How strongly do finalists[${index}]'s recorded observations and metrics support the frozen task success criteria? Ignore builder_notes and judge the evidence itself.`,
        SUPPORT_RUBRIC,
      ),
    );
    add(
      finalistQuestionKey(index, "reproducibility"),
      score(
        `How reproducible and falsifiable is finalists[${index}]'s claimed result from its raw samples, commands, and revision identity?`,
        REPRODUCIBILITY_RUBRIC,
      ),
    );
    add(
      finalistQuestionKey(index, "residual_risk_acceptance"),
      noul(
        `After accounting for known failures and untested surfaces, is finalists[${index}]'s residual risk acceptable for integration under the frozen task constraints?`,
        {
          true: "Residual risk is bounded and acceptable for integration.",
          false: "Residual risk is material or insufficiently bounded.",
        },
      ),
    );
    add(
      finalistQuestionKey(index, "shipping_value"),
      noul(
        `Given the measured gain, implementation cost, changed-file count, and alternatives, is finalists[${index}] worth integrating?`,
        {
          true: "The verified gain justifies integration cost and risk.",
          false: "The verified gain does not justify integration cost or risk.",
        },
      ),
    );
  });

  for (let left = 0; left < finalists.length; left += 1) {
    for (let right = left + 1; right < finalists.length; right += 1) {
      add(
        complementarityQuestionKey(left, right),
        noul(
          `Are finalists[${left}] and finalists[${right}] independently verified and materially complementary, such that a combined probe is more valuable than choosing either alone?`,
          {
            true: "They address orthogonal mechanisms and merit a combined probe.",
            false: "They overlap, conflict, or should be compared rather than combined.",
          },
        ),
      );
    }
  }

  const state = JSON.parse(JSON.stringify({
      task: prepared.campaign.request.task,
      finalists: finalists.map((evaluation) => ({
        candidate: (() => {
          const candidate = prepared.campaign.request.candidates.find(
            (item) => item.id === evaluation.candidate_id,
          );
          return candidate === undefined ? undefined : {
            mechanism: candidate.mechanism,
            assumptions: candidate.assumptions,
            risks: candidate.risks,
            validation: candidate.validation,
            effort: candidate.effort,
          };
        })(),
        work_order: (() => {
          const workOrder = [...prepared.campaign.work_orders, ...prepared.campaign.review_work_orders].find(
            (item) => item.candidate_id === evaluation.candidate_id,
          );
          return workOrder === undefined ? undefined : {
            required_evidence: workOrder.required_evidence,
            budget: workOrder.budget,
            stop_conditions: workOrder.stop_conditions,
          };
        })(),
        revision: evaluation.packet?.revision,
        development: evaluation.packet?.development,
        observations: evaluation.packet?.observations.map(judgeObservation),
        metric_summaries: evaluation.objective.metrics,
        requirement_results: evaluation.packet?.requirement_results,
        artifacts: evaluation.packet?.artifacts?.map(judgeArtifact),
        artifact_evaluations: evaluation.packet?.artifact_evaluations?.map(judgeArtifactEvaluation),
        changed_files: evaluation.packet?.changed_files,
        known_failure_count: evaluation.packet?.known_failures.length,
      })),
    })) as QuestionPlan["state"];

  return {
    state,
    questions,
    expectedTypes,
    candidateOrder,
    candidateIds: finalists.map((evaluation) => evaluation.candidate_id),
  };
}
