import { z } from "zod";

const id = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9][a-z0-9_-]*$/, "must use lowercase letters, digits, _ or -");

const shortText = z.string().trim().min(1).max(300);

const criterionSchema = z
  .object({
    id,
    text: z.string().trim().min(1).max(500),
  })
  .strict();

const constraintSchema = criterionSchema
  .extend({
    kind: z.enum(["hard", "soft"]),
  })
  .strict();

export const candidateSchema = z
  .object({
    id,
    title: z.string().trim().min(1).max(120),
    summary: z.string().trim().min(1).max(600),
    mechanism: z.string().trim().min(1).max(1_500),
    assumptions: z.array(shortText).min(1).max(8),
    risks: z.array(shortText).min(1).max(8),
    validation: z.array(shortText).min(1).max(8),
    effort: z.enum(["small", "medium", "large"]),
  })
  .strict();

export const rankRequestSchema = z
  .object({
    version: z.literal("1"),
    task: z
      .object({
        goal: z.string().trim().min(1).max(1_000),
        context: z.string().trim().max(4_000).optional(),
        constraints: z.array(constraintSchema).max(12),
        success: z.array(criterionSchema).min(1).max(12),
      })
      .strict(),
    budget: z
      .object({
        max_survivors: z.number().int().min(1).max(5),
      })
      .strict(),
    candidates: z.array(candidateSchema).min(2).max(12),
  })
  .strict()
  .superRefine((value, context) => {
    const candidateIds = value.candidates.map((candidate) => candidate.id);
    if (new Set(candidateIds).size !== candidateIds.length) {
      context.addIssue({
        code: "custom",
        path: ["candidates"],
        message: "candidate IDs must be unique",
      });
    }

    const criterionIds = [
      ...value.task.constraints.map((criterion) => criterion.id),
      ...value.task.success.map((criterion) => criterion.id),
    ];
    if (new Set(criterionIds).size !== criterionIds.length) {
      context.addIssue({
        code: "custom",
        path: ["task"],
        message: "constraint and success IDs must be unique",
      });
    }

    if (value.budget.max_survivors > value.candidates.length) {
      context.addIssue({
        code: "custom",
        path: ["budget", "max_survivors"],
        message: "cannot exceed the number of candidates",
      });
    }

    if (JSON.stringify(value).length > 32_000) {
      context.addIssue({
        code: "custom",
        path: [],
        message: "serialized request must not exceed 32,000 characters",
      });
    }
  });

export const noulAnswerSchema = z
  .object({
    type: z.literal("noul"),
    noul: z.number().min(0).max(1),
  })
  .strict();

export const scoreAnswerSchema = z
  .object({
    type: z.literal("score"),
    score: z.number().min(0),
    confidence: z.number().min(0).max(1),
    legend: z.record(z.string(), z.unknown()),
    probabilities: z.record(z.string(), z.number().min(0).max(1)),
  })
  .strict();

export const judgeAnswerSchema = z.discriminatedUnion("type", [
  noulAnswerSchema,
  scoreAnswerSchema,
]);

export const judgeResponseSchema = z
  .object({
    model: z.string().min(1),
    answers: z.record(z.string(), judgeAnswerSchema),
    usage: z
      .object({
        input_tokens: z.number().int().nonnegative(),
        output_tokens: z.number().int().nonnegative(),
      })
      .strict(),
  })
  .strict();

/**
 * A captured response must carry the request-order candidate IDs. Answer keys
 * are positional, so without this metadata a reordered request could silently
 * apply one candidate's judgment to another candidate.
 */
export const replayResponseSchema = judgeResponseSchema
  .extend({
    // Sift starts with at least two candidates, while deterministic evidence
    // gates may leave a single viable finalist for Decide.
    candidate_order: z.array(id).min(1).max(12),
  })
  .strict();

export const reasonSchema = z
  .object({
    code: z.enum([
      "GOAL_MISMATCH",
      "CONSTRAINT_RISK",
      "LOW_FEASIBILITY",
      "WEAK_VALIDATION",
      "LOW_EXECUTION_VALUE",
      "LOW_CONFIDENCE",
      "DUPLICATE_CANDIDATE",
      "BUDGET_CUTOFF",
    ]),
    related_candidate_id: id.optional(),
  })
  .strict();

export const nextActionSchema = z.enum([
  "implement",
  "ask_human",
  "revise_candidates",
  "relax_constraints",
]);

export const emptyReasonSchema = z.enum([
  "none",
  "all_rejected",
  "all_review",
  "mixed_no_survivor",
  "budget_exhausted",
  "invalid",
]);

export const rankResultSchema = z
  .object({
    version: z.literal("1"),
    // `spj_` is accepted so captured SpecJev v0.1 responses remain readable;
    // new runs use the JevRev prefix.
    run_id: z.union([z.string().startsWith("jvr_"), z.string().startsWith("spj_")]),
    model: z.string().min(1),
    policy: z
      .object({
        name: z.literal("default-v1"),
        provider_profile: z.string().min(1),
        max_survivors: z.number().int().min(1),
        thresholds: z.record(z.string(), z.number()),
        weights: z.record(z.string(), z.number()),
        effort_multipliers: z.record(z.string(), z.number()),
      })
      .strict(),
    summary: z
      .object({
        evaluated: z.number().int().nonnegative(),
        kept: z.number().int().nonnegative(),
        shortlisted: z.number().int().nonnegative(),
        review: z.number().int().nonnegative(),
        rejected: z.number().int().nonnegative(),
      })
      .strict(),
    next_action: nextActionSchema,
    empty_reason: emptyReasonSchema,
    selected: z.array(id),
    shortlist: z.array(id),
    decisions: z.array(
      z
        .object({
          candidate_id: id,
          title: z.string().min(1),
          status: z.enum(["keep", "review", "reject"]),
          rank: z.number().int().positive(),
          score: z.number().min(0).max(1),
          confidence: z.number().min(0).max(1),
          signals: z
            .object({
              goal_fit: z.number().min(0).max(1),
              constraint_fit: z.number().min(0).max(1),
              feasibility: z.number().min(0).max(1),
              validation_quality: z.number().min(0).max(1),
              execution_value: z.number().min(0).max(1),
            })
            .strict(),
          reasons: z.array(reasonSchema),
        })
        .strict(),
    ),
    usage: z
      .object({
        input_tokens: z.number().int().nonnegative(),
        output_tokens: z.number().int().nonnegative(),
      })
      .strict(),
  })
  .strict();

export type RankRequest = z.infer<typeof rankRequestSchema>;
export type Candidate = z.infer<typeof candidateSchema>;
export type JudgeAnswer = z.infer<typeof judgeAnswerSchema>;
export type JudgeResponse = z.infer<typeof judgeResponseSchema>;
export type ReplayResponse = z.infer<typeof replayResponseSchema>;
export type RankResult = z.infer<typeof rankResultSchema>;
export type DecisionReason = z.infer<typeof reasonSchema>;
export type NextAction = z.infer<typeof nextActionSchema>;
export type EmptyReason = z.infer<typeof emptyReasonSchema>;

const activationUnitScore = z.number().finite().min(0).max(1);

export const activationRequestSchema = z
  .object({
    kind: z.literal("jevrev.activation-request"),
    schema_version: z.literal("1"),
    task: z
      .object({
        goal: z.string().trim().min(1).max(1_000),
        context: z.string().trim().max(4_000).optional(),
      })
      .strict(),
    assessment: z
      .object({
        candidate_count: z.number().int().min(1).max(12),
        wrong_path_loss: activationUnitScore,
        exploration_cost: activationUnitScore,
        mechanism_diversity: activationUnitScore,
        constraint_interaction: activationUnitScore,
        uncertainty: activationUnitScore,
        probeability: activationUnitScore,
        reversibility: activationUnitScore,
        existing_evidence: activationUnitScore,
      })
      .strict(),
    // The first release is deliberately shadow-only. A future active mode must
    // be introduced as a separately reviewed contract, not a CLI default.
    mode: z.literal("shadow").optional().default("shadow"),
  })
  .strict();

export const activationReasonSchema = z
  .object({
    code: z.enum([
      "INSUFFICIENT_ALTERNATIVES",
      "LOW_WRONG_PATH_LOSS",
      "LOW_UNCERTAINTY",
      "HIGH_REVERSIBILITY",
      "STRONG_EXISTING_EVIDENCE",
      "DIVERSE_MECHANISMS",
      "INTERACTING_CONSTRAINTS",
      "CHEAP_TO_PROBE",
      "EXPLORATION_COST_TOO_HIGH",
      "LOSS_OUTWEIGHS_EXPLORATION_COST",
      "LOW_EXPECTED_VALUE",
    ]),
    signal: z.string().min(1).optional(),
  })
  .strict();

export const activationDecisionSchema = z
  .object({
    kind: z.literal("jevrev.activation-decision"),
    schema_version: z.literal("1"),
    run_id: z.string().regex(/^jva_[a-f0-9]{12}$/),
    policy: z
      .object({
        name: z.literal("activation-v1"),
        mode: z.literal("shadow"),
        thresholds: z
          .object({
            minimum_expected_loss: activationUnitScore,
            minimum_advantage: activationUnitScore,
            minimum_candidates: z.number().int().min(1).max(12),
          })
          .strict(),
      })
      .strict(),
    task: z
      .object({
        goal: z.string().min(1),
        task_id: z.string().regex(/^jvt_[a-f0-9]{12}$/),
      })
      .strict(),
    assessment: activationRequestSchema.shape.assessment,
    calculation: z
      .object({
        structural_factor: activationUnitScore,
        adjusted_wrong_path_loss: activationUnitScore,
        adjusted_exploration_cost: activationUnitScore,
        advantage: z.number().min(-1).max(1),
      })
      .strict(),
    decision: z.enum(["sift", "bypass"]),
    shadow: z.literal(true),
    reasons: z.array(activationReasonSchema).min(1).max(8),
  })
  .strict();

export type ActivationRequest = z.infer<typeof activationRequestSchema>;
export type ActivationReason = z.infer<typeof activationReasonSchema>;
export type ActivationDecision = z.infer<typeof activationDecisionSchema>;
