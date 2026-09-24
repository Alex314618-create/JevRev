import { TypeSafeClient, TypeSafeError } from "@typesafe-ai/sdk";
import { z } from "zod";
import { ProtocolError, ProviderError } from "./domain/errors.js";
import {
  judgeResponseSchema,
  replayResponseSchema,
  type JudgeResponse,
} from "./domain/schemas.js";
import {
  candidateQuestionKey,
  duplicateQuestionKey,
  SIGNALS,
  type QuestionPlan,
  type SignalName,
} from "./questions.js";
import type { Question } from "@typesafe-ai/sdk";

export interface Judge {
  evaluate(plan: QuestionPlan): Promise<JudgeResponse>;
}

interface SystemOneClient {
  systemOne(request: {
    state: QuestionPlan["state"];
    questions: QuestionPlan["questions"];
    model?: string;
  }): Promise<unknown>;
}

export interface TypeSafeJudgeOptions {
  apiKey?: string;
  /** TypeSafe/Jev API root. Defaults to https://api.typesafe.ai. */
  baseUrl?: string;
  model?: string;
  client?: SystemOneClient;
  /** HTTP transport override for tests or an application-owned transport. */
  fetch?: FetchLike;
}

export const DEFAULT_JEV_URL = "https://api.typesafe.ai";
const DEFAULT_LOCAL_URL = "http://127.0.0.1:4877";
const DEFAULT_LOCAL_BATCH_SIZE = 8;
const DEFAULT_LOCAL_TIMEOUT_MS = 120_000;
const DEFAULT_SEMIF_URL = "http://127.0.0.1:4878";
const DEFAULT_SEMIF_MODEL = "Qwen3.5-4B-Q4_K_M";
const DEFAULT_SEMIF_TOP_LOGPROBS = 20;
const DEFAULT_SEMIF_TIMEOUT_MS = 120_000;

const SEMIF_SYSTEM_PROMPT =
  "Apply the supplied criterion to the supplied evidence. Choose exactly one listed option. Respond with only its uppercase letter, with no explanation or reasoning.";

const localScoreResponseSchema = z
  .object({
    model: z.string().min(1),
    device: z.string().min(1),
    count: z.number().int().nonnegative().optional(),
    scores: z.array(
      z
        .object({
          id: z.string().min(1),
          score: z.number().min(0).max(1),
        })
        .strict(),
    ),
    input_tokens: z.number().int().nonnegative().optional(),
    duration_ms: z.number().nonnegative().optional(),
  })
  .strict();

export interface LocalScoreItem {
  id: string;
  query: string;
  document: string;
  instruction: string;
}

export interface LocalScoreRequest {
  items: LocalScoreItem[];
  batch_size?: number;
}

type FetchLike = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

export interface LocalJudgeOptions {
  baseUrl?: string;
  batchSize?: number;
  timeoutMs?: number;
  fetch?: FetchLike;
}

interface PlannedLocalItem {
  item: LocalScoreItem;
  answerKey: string;
  answerType: "noul" | "score";
}

const LOCAL_SIGNAL_NAMES: Record<SignalName, string> = {
  goal_fit: "goal_fit",
  constraint_fit: "constraint_fit",
  feasibility: "feasibility",
  validation_quality: "validation_quality",
  execution_value: "execution_readiness",
};

const LOCAL_SIGNAL_INSTRUCTIONS: Record<SignalName, string> = {
  goal_fit:
    "Judge whether the candidate's mechanism is likely to achieve the task goal and success criteria. Answer yes only if it materially addresses them.",
  constraint_fit:
    "Judge whether the candidate is likely to satisfy every hard task constraint. Answer yes only if all are likely satisfied; answer yes when no hard constraints exist.",
  feasibility:
    "Judge whether the candidate's specific mechanism is technically feasible in the supplied task context. Answer yes only if it is credible and implementable.",
  validation_quality:
    "Judge whether the candidate's validation plan can establish success and detect regressions. Answer yes only if it provides strong, falsifiable evidence.",
  execution_value:
    "Judge whether this candidate is ready and worthwhile to execute under a limited implementation budget. Answer yes only if it merits an implementation slot.",
};

export class TypeSafeJudge implements Judge {
  readonly #client: SystemOneClient;
  readonly #model: string;

  constructor(options: TypeSafeJudgeOptions = {}) {
    this.#model = options.model ?? "jev-latest";
    try {
      this.#client =
        options.client ??
        new TypeSafeClient({
          ...(options.apiKey === undefined ? {} : { apiKey: options.apiKey }),
          ...(options.baseUrl === undefined ? {} : { baseURL: options.baseUrl }),
          ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
          defaultModel: this.#model,
          logLevel: "off",
        });
    } catch (error) {
      if (error instanceof TypeSafeError) {
        throw new ProviderError(error.message, { cause: error });
      }
      throw error;
    }
  }

  async evaluate(plan: QuestionPlan): Promise<JudgeResponse> {
    try {
      const raw = await this.#client.systemOne({
        state: plan.state,
        questions: plan.questions,
        model: this.#model,
      });
      return validateJudgeResponse(raw, plan);
    } catch (error) {
      if (error instanceof ProtocolError) {
        throw error;
      }
      if (error instanceof TypeSafeError) {
        throw new ProviderError(error.message, { cause: error });
      }
      throw new ProviderError("TypeSafe request failed", { cause: error });
    }
  }
}

function localScoreUrl(baseUrl: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(baseUrl);
  } catch (error) {
    throw new ProviderError(`Invalid local scorer URL: ${baseUrl}`, { cause: error });
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new ProviderError("Local scorer URL must use http or https");
  }
  parsed.search = "";
  parsed.hash = "";
  const pathname = parsed.pathname.replace(/\/$/, "");
  parsed.pathname = pathname.endsWith("/v1")
    ? `${pathname}/score`
    : `${pathname}/v1/score`;
  return parsed;
}

function localState(plan: QuestionPlan): {
  task: unknown;
  candidates: unknown[];
} {
  const state = plan.state;
  if (state === null || Array.isArray(state) || typeof state !== "object") {
    throw new ProtocolError("Local judge requires an object question state");
  }

  const task = state.task;
  const candidates = state.candidates;
  if (task === undefined || !Array.isArray(candidates)) {
    throw new ProtocolError("Local judge state must contain task and candidates");
  }
  return { task, candidates };
}

function jsonText(value: unknown): string {
  const serialized = JSON.stringify(value);
  if (serialized === undefined) {
    throw new ProtocolError("Could not serialize local scorer input");
  }
  return serialized;
}

function localItemId(index: number, signal: SignalName): string {
  return `candidate_${index}_${LOCAL_SIGNAL_NAMES[signal]}`;
}

function buildLocalItems(plan: QuestionPlan): PlannedLocalItem[] {
  const state = plan.state;
  if (
    state !== null &&
    !Array.isArray(state) &&
    typeof state === "object" &&
    Array.isArray(state.finalists)
  ) {
    const task = state.task;
    const finalists = state.finalists;
    return Object.entries(plan.questions).map(([answerKey, question]) => {
      const finalistMatch = /^finalist_(\d+)_/.exec(answerKey);
      const pairMatch = /^finalist_pair_(\d+)_(\d+)_complementary$/.exec(answerKey);
      let document: unknown = state;
      if (finalistMatch !== null) {
        document = finalists[Number(finalistMatch[1])];
      } else if (pairMatch !== null) {
        document = {
          left_finalist: finalists[Number(pairMatch[1])],
          right_finalist: finalists[Number(pairMatch[2])],
        };
      }
      if (document === undefined) {
        throw new ProtocolError(`Local judge cannot map ${answerKey} to a finalist`);
      }
      if (question.type !== "noul" && question.type !== "score") {
        throw new ProtocolError(`Unsupported local question type for ${answerKey}`);
      }
      return {
        item: {
          id: answerKey,
          query: jsonText(task),
          document: jsonText(document),
          instruction: typeof question.instructions === "string"
            ? question.instructions
            : question.instructions === undefined
              ? "Apply the declared criterion."
              : jsonText(question.instructions),
        },
        answerKey,
        answerType: question.type,
      };
    });
  }

  const { task, candidates } = localState(plan);
  const planned: PlannedLocalItem[] = [];

  candidates.forEach((candidate, index) => {
    for (const signal of SIGNALS) {
      const answerKey = candidateQuestionKey(index, signal);
      const answerType = plan.expectedTypes[answerKey];
      if (answerType !== "noul" && answerType !== "score") {
        throw new ProtocolError(`Unsupported local question type for ${answerKey}`);
      }
      planned.push({
        item: {
          id: localItemId(index, signal),
          query: jsonText(task),
          document: jsonText(candidate),
          instruction: LOCAL_SIGNAL_INSTRUCTIONS[signal],
        },
        answerKey,
        answerType,
      });
    }
  });

  for (let left = 0; left < candidates.length; left += 1) {
    for (let right = left + 1; right < candidates.length; right += 1) {
      const answerKey = duplicateQuestionKey(left, right);
      const answerType = plan.expectedTypes[answerKey];
      if (answerType !== "noul") {
        throw new ProtocolError(`Unsupported local question type for ${answerKey}`);
      }
      planned.push({
        item: {
          id: answerKey,
          query: jsonText(candidates[left]),
          document: jsonText(candidates[right]),
          instruction:
            "Judge whether the two candidates use materially the same implementation mechanism and would provide little additional diversity. Answer yes only if they are duplicative.",
        },
        answerKey,
        answerType,
      });
    }
  }

  if (planned.length !== Object.keys(plan.expectedTypes).length) {
    throw new ProtocolError("Local judge cannot map every planned question");
  }
  return planned;
}

function scoreProbabilities(score: number, levels: number): Record<string, number> {
  const probabilities = Object.fromEntries(
    Array.from({ length: levels }, (_unused, index) => [String(index), 0]),
  );
  const scaled = score * (levels - 1);
  const lower = Math.floor(scaled);
  const upper = Math.ceil(scaled);
  probabilities[String(lower)] = upper === lower ? 1 : upper - scaled;
  if (upper !== lower) {
    probabilities[String(upper)] = scaled - lower;
  }
  return probabilities;
}

function mapLocalResponse(
  raw: unknown,
  plan: QuestionPlan,
  planned: PlannedLocalItem[],
): JudgeResponse {
  const parsed = localScoreResponseSchema.safeParse(raw);
  if (!parsed.success) {
    throw new ProtocolError(`Invalid local scorer response: ${parsed.error.message}`);
  }
  if (
    parsed.data.count !== undefined &&
    parsed.data.count !== parsed.data.scores.length
  ) {
    throw new ProtocolError(
      `Local scorer count ${parsed.data.count} does not match ${parsed.data.scores.length} scores`,
    );
  }

  const scores = new Map<string, number>();
  for (const item of parsed.data.scores) {
    if (scores.has(item.id)) {
      throw new ProtocolError(`Duplicate local scorer result: ${item.id}`);
    }
    scores.set(item.id, item.score);
  }

  const expectedIds = new Set(planned.map(({ item }) => item.id));
  const missing = [...expectedIds].filter((id) => !scores.has(id));
  const unexpected = [...scores.keys()].filter((id) => !expectedIds.has(id));
  if (missing.length > 0 || unexpected.length > 0) {
    throw new ProtocolError(
      `Local scorer IDs do not match request (missing: ${missing.join(", ") || "none"}; unexpected: ${unexpected.join(", ") || "none"})`,
    );
  }

  const answers: JudgeResponse["answers"] = {};
  for (const entry of planned) {
    const value = scores.get(entry.item.id);
    if (value === undefined) {
      throw new ProtocolError(`Missing local scorer result: ${entry.item.id}`);
    }

    if (entry.answerType === "noul") {
      answers[entry.answerKey] = { type: "noul", noul: value };
      continue;
    }

    const question = plan.questions[entry.answerKey];
    if (question?.type !== "score") {
      throw new ProtocolError(`Missing score rubric for ${entry.answerKey}`);
    }
    const levels = question.criteria.length;
    const probabilities = scoreProbabilities(value, levels);
    answers[entry.answerKey] = {
      type: "score",
      score: value * (levels - 1),
      confidence: Math.abs(value - 0.5) * 2,
      legend: Object.fromEntries(
        question.criteria.map((criterion, index) => [String(index), criterion]),
      ),
      probabilities,
    };
  }

  return validateJudgeResponse(
    {
      model: parsed.data.model,
      answers,
      usage: {
        input_tokens: parsed.data.input_tokens ?? 0,
        output_tokens: 0,
      },
    },
    plan,
  );
}

export class LocalJudge implements Judge {
  readonly #url: URL;
  readonly #batchSize: number;
  readonly #timeoutMs: number;
  readonly #fetch: FetchLike;

  constructor(options: LocalJudgeOptions = {}) {
    this.#url = localScoreUrl(options.baseUrl ?? DEFAULT_LOCAL_URL);
    this.#batchSize = options.batchSize ?? DEFAULT_LOCAL_BATCH_SIZE;
    if (!Number.isInteger(this.#batchSize) || this.#batchSize < 1) {
      throw new ProviderError("Local scorer batch size must be a positive integer");
    }
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_LOCAL_TIMEOUT_MS;
    if (!Number.isInteger(this.#timeoutMs) || this.#timeoutMs < 1) {
      throw new ProviderError("Local scorer timeout must be a positive integer");
    }
    this.#fetch = options.fetch ?? globalThis.fetch;
  }

  async evaluate(plan: QuestionPlan): Promise<JudgeResponse> {
    const planned = buildLocalItems(plan);
    const request: LocalScoreRequest = {
      items: planned.map(({ item }) => item),
      batch_size: this.#batchSize,
    };

    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const requestPromise = (async (): Promise<unknown> => {
      let response: Response;
      try {
        response = await this.#fetch(this.#url, {
          method: "POST",
          headers: {
            accept: "application/json",
            "content-type": "application/json",
          },
          body: JSON.stringify(request),
          signal: controller.signal,
        });
      } catch (error) {
        throw new ProviderError("Local scorer request failed", { cause: error });
      }

      if (!response.ok) {
        throw new ProviderError(
          `Local scorer returned HTTP ${response.status} ${response.statusText}`.trim(),
        );
      }

      try {
        return (await response.json()) as unknown;
      } catch (error) {
        throw new ProtocolError("Local scorer returned invalid JSON", { cause: error });
      }
    })();
    try {
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(new ProviderError(`Local scorer request timed out after ${this.#timeoutMs}ms`));
        }, this.#timeoutMs);
      });
      const raw = await Promise.race([requestPromise, timeout]);
      return mapLocalResponse(raw, plan, planned);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }
}

/** A single option in the direct option-logit protocol used by SemIf. */
export interface SemIfOption {
  letter: string;
  description: unknown;
}

/** The OpenAI-compatible request sent to llama.cpp's chat endpoint. */
export interface SemIfChatRequest {
  model: string;
  messages: ReadonlyArray<{
    role: "system" | "user";
    content: string;
  }>;
  max_tokens: 1;
  temperature: 0;
  logprobs: true;
  top_logprobs: number;
  chat_template_kwargs: { enable_thinking: false };
  seed: 1;
}

export interface SemIfJudgeOptions {
  /** llama.cpp server base URL, for example http://127.0.0.1:4878. */
  baseUrl?: string;
  /** Model identifier sent to the server. */
  model?: string;
  /** Number of alternatives requested in each token log-probability response. */
  topLogprobs?: number;
  /** Per-question request timeout. */
  timeoutMs?: number;
  fetch?: FetchLike;
}

interface SemIfPlannedQuestion {
  answerKey: string;
  question: Question;
  evidence: unknown;
  criterion: unknown;
  options: SemIfOption[];
}

interface SemIfTokenLogprob {
  token: string;
  logprob: number;
}

interface SemIfCompletionResponse {
  model?: unknown;
  choices?: unknown;
  usage?: unknown;
}

function semifChatUrl(baseUrl: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(baseUrl);
  } catch (error) {
    throw new ProviderError(`Invalid SemIf server URL: ${baseUrl}`, { cause: error });
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new ProviderError("SemIf server URL must use http or https");
  }
  parsed.search = "";
  parsed.hash = "";
  const pathname = parsed.pathname.replace(/\/$/, "");
  parsed.pathname = pathname.endsWith("/v1")
    ? `${pathname}/chat/completions`
    : `${pathname}/v1/chat/completions`;
  return parsed;
}

function semifRecord(value: unknown, description: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new ProtocolError(`SemIf returned invalid ${description}`);
  }
  return value as Record<string, unknown>;
}

function semifState(plan: QuestionPlan): Record<string, unknown> {
  return semifRecord(plan.state, "question state");
}

function compactCandidate(value: unknown): unknown {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return value;
  }
  const candidate = value as Record<string, unknown>;
  return {
    id: candidate.id,
    title: candidate.title,
    summary: candidate.summary,
    effort: candidate.effort,
  };
}

function candidateEvidence(
  state: Record<string, unknown>,
  index: number,
  includeAlternatives = false,
): unknown {
  const candidates = state.candidates;
  if (!Array.isArray(candidates) || candidates[index] === undefined) {
    throw new ProtocolError(`SemIf state is missing candidates[${index}]`);
  }
  return {
    task: state.task,
    candidate: candidates[index],
    ...(includeAlternatives && state.budget !== undefined
      ? { budget: state.budget }
      : {}),
    ...(includeAlternatives && candidates.length > 1
      ? { candidate_count: candidates.length }
      : {}),
    ...(includeAlternatives
      ? { alternatives: candidates.map((candidate) => compactCandidate(candidate)) }
      : {}),
  };
}

function pairEvidence(
  state: Record<string, unknown>,
  leftIndex: number,
  rightIndex: number,
): unknown {
  const candidates = state.candidates;
  if (
    !Array.isArray(candidates) ||
    candidates[leftIndex] === undefined ||
    candidates[rightIndex] === undefined
  ) {
    throw new ProtocolError(
      `SemIf state is missing candidates[${leftIndex}] or candidates[${rightIndex}]`,
    );
  }
  return {
    task: state.task,
    left_candidate: candidates[leftIndex],
    right_candidate: candidates[rightIndex],
  };
}

function constraintEvidence(
  state: Record<string, unknown>,
  index: number,
): unknown {
  const task = semifRecord(state.task, "task state");
  const constraints = task.constraints;
  const hardConstraints = Array.isArray(constraints)
    ? constraints.filter(
        (constraint) =>
          constraint !== null &&
          typeof constraint === "object" &&
          !Array.isArray(constraint) &&
          (constraint as Record<string, unknown>).kind === "hard",
      )
    : [];
  const candidates = state.candidates;
  if (!Array.isArray(candidates) || candidates[index] === undefined) {
    throw new ProtocolError(`SemIf state is missing candidates[${index}]`);
  }
  return {
    hard_constraints: hardConstraints,
    candidate: candidates[index],
  };
}

function questionCriterion(answerKey: string, question: Question): unknown {
  if (answerKey.endsWith("_constraint_fit")) {
    return {
      question: question.instructions ?? null,
      decision_rule:
        "Choose A only when the candidate does not violate any listed hard constraint. Choose B when it violates at least one hard constraint.",
    };
  }
  return question.instructions ?? null;
}

function questionOptions(question: Question): SemIfOption[] {
  if (question.type === "score") {
    return question.criteria.map((description, index) => ({
      letter: String.fromCharCode("A".charCodeAt(0) + index),
      description,
    }));
  }
  if (question.type === "noul") {
    const criteria = question.criteria ?? {};
    return [
      { letter: "A", description: criteria.true ?? "Yes / true" },
      { letter: "B", description: criteria.false ?? "No / false" },
    ];
  }
  throw new ProtocolError("SemIf provider does not support choice questions yet");
}

function buildSemIfQuestions(plan: QuestionPlan): SemIfPlannedQuestion[] {
  const state = semifState(plan);
  const planned: SemIfPlannedQuestion[] = [];

  for (const [answerKey, question] of Object.entries(plan.questions)) {
    let evidence: unknown;
    const candidateMatch = /^candidate_(\d+)_/.exec(answerKey);
    const pairMatch = /^pair_(\d+)_(\d+)_duplicate$/.exec(answerKey);
    const finalistMatch = /^finalist_(\d+)_/.exec(answerKey);
    const finalistPairMatch = /^finalist_pair_(\d+)_(\d+)_complementary$/.exec(answerKey);
    if (candidateMatch !== null) {
      const index = Number(candidateMatch[1]);
      evidence = answerKey.endsWith("_constraint_fit")
        ? constraintEvidence(state, index)
        : candidateEvidence(state, index, answerKey.endsWith("_execution_value"));
    } else if (pairMatch !== null) {
      evidence = pairEvidence(
        state,
        Number(pairMatch[1]),
        Number(pairMatch[2]),
      );
    } else if (finalistMatch !== null) {
      const finalists = state.finalists;
      const index = Number(finalistMatch[1]);
      if (!Array.isArray(finalists) || finalists[index] === undefined) {
        throw new ProtocolError(`SemIf state is missing finalists[${index}]`);
      }
      evidence = { task: state.task, finalist: finalists[index] };
    } else if (finalistPairMatch !== null) {
      const finalists = state.finalists;
      const left = Number(finalistPairMatch[1]);
      const right = Number(finalistPairMatch[2]);
      if (
        !Array.isArray(finalists) ||
        finalists[left] === undefined ||
        finalists[right] === undefined
      ) {
        throw new ProtocolError(`SemIf state is missing finalists[${left}] or finalists[${right}]`);
      }
      evidence = {
        task: state.task,
        left_finalist: finalists[left],
        right_finalist: finalists[right],
      };
    } else {
      evidence = state;
    }

    planned.push({
      answerKey,
      question,
      evidence,
      criterion: questionCriterion(answerKey, question),
      options: questionOptions(question),
    });
  }

  if (planned.length !== Object.keys(plan.expectedTypes).length) {
    throw new ProtocolError("SemIf provider cannot map every planned question");
  }
  return planned;
}

function semifFiniteNumber(value: unknown, description: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new ProtocolError(`SemIf returned invalid ${description}`);
  }
  return value;
}

function parseSemIfTokenLogprobs(raw: unknown): SemIfTokenLogprob[] {
  const choice = semifRecord(raw, "completion response");
  const choices = choice.choices;
  if (!Array.isArray(choices) || choices.length < 1) {
    throw new ProtocolError("SemIf response has no completion choices");
  }
  const firstChoice = semifRecord(choices[0], "completion choice");
  const logprobs = semifRecord(firstChoice.logprobs, "token logprobs");
  const content = logprobs.content;
  if (!Array.isArray(content) || content.length < 1) {
    throw new ProtocolError("SemIf response has no token logprobs");
  }
  const firstToken = semifRecord(content[0], "token logprobs");
  const top = firstToken.top_logprobs;
  if (!Array.isArray(top)) {
    throw new ProtocolError("SemIf response has no top token logprobs");
  }

  return top.map((entry) => {
    const parsed = semifRecord(entry, "token logprob");
    if (typeof parsed.token !== "string") {
      throw new ProtocolError("SemIf token logprob has no token");
    }
    return {
      token: parsed.token,
      logprob: semifFiniteNumber(parsed.logprob, "token logprob"),
    };
  });
}

function canonicalOptionLetter(token: string): string | undefined {
  const trimmed = token.trim();
  return /^[A-Z]$/.test(trimmed) ? trimmed : undefined;
}

function optionProbabilities(
  options: readonly SemIfOption[],
  tokenLogprobs: readonly SemIfTokenLogprob[],
): Record<string, number> {
  const byLetter = new Map<string, number>();
  for (const entry of tokenLogprobs) {
    const letter = canonicalOptionLetter(entry.token);
    if (letter === undefined || !options.some((option) => option.letter === letter)) {
      continue;
    }
    const previous = byLetter.get(letter);
    if (previous === undefined || entry.logprob > previous) {
      byLetter.set(letter, entry.logprob);
    }
  }

  const missing = options
    .map(({ letter }) => letter)
    .filter((letter) => !byLetter.has(letter));
  if (missing.length > 0) {
    throw new ProtocolError(
      `SemIf response omitted option logprobs: ${missing.join(", ")}`,
    );
  }

  const maxLogprob = Math.max(...byLetter.values());
  const weights = options.map(({ letter }) => Math.exp(byLetter.get(letter)! - maxLogprob));
  const denominator = weights.reduce((sum, weight) => sum + weight, 0);
  if (!Number.isFinite(denominator) || denominator <= 0) {
    throw new ProtocolError("SemIf option logprobs cannot be normalized");
  }
  return Object.fromEntries(
    options.map(({ letter }, index) => [letter, weights[index]! / denominator]),
  );
}

function semifUsage(raw: unknown): { input_tokens: number; output_tokens: number } {
  if (raw === undefined) return { input_tokens: 0, output_tokens: 0 };
  const usage = semifRecord(raw, "usage");
  const input = usage.prompt_tokens ?? usage.input_tokens ?? 0;
  const output = usage.completion_tokens ?? usage.output_tokens ?? 0;
  const inputTokens = semifFiniteNumber(input, "input token usage");
  const outputTokens = semifFiniteNumber(output, "output token usage");
  if (!Number.isInteger(inputTokens) || !Number.isInteger(outputTokens)) {
    throw new ProtocolError("SemIf token usage must be integers");
  }
  return { input_tokens: inputTokens, output_tokens: outputTokens };
}

function mapSemIfAnswer(
  planned: SemIfPlannedQuestion,
  probabilities: Record<string, number>,
): JudgeResponse["answers"][string] {
  if (planned.question.type === "noul") {
    return { type: "noul", noul: probabilities.A ?? 0 };
  }
  if (planned.question.type !== "score") {
    throw new ProtocolError("SemIf provider does not support choice answers yet");
  }

  const scoreProbabilities = Object.fromEntries(
    planned.question.criteria.map((_criterion, index) => {
      const letter = String.fromCharCode("A".charCodeAt(0) + index);
      return [String(index), probabilities[letter] ?? 0];
    }),
  );
  const score = Object.entries(scoreProbabilities).reduce(
    (sum, [index, probability]) => sum + Number(index) * probability,
    0,
  );
  const confidence = Math.max(...Object.values(scoreProbabilities));
  return {
    type: "score",
    score,
    confidence,
    legend: Object.fromEntries(
      planned.question.criteria.map((criterion, index) => [String(index), criterion]),
    ),
    probabilities: scoreProbabilities,
  };
}

/**
 * Evaluate TypeSafe questions with SemIf's direct option-logit protocol.
 *
 * This intentionally uses a single-token decision and keeps only the logits for
 * the declared options. It therefore exposes calibrated alternatives instead of
 * asking the model to emit a prose explanation and parsing it afterwards.
 */
export class SemIfJudge implements Judge {
  readonly #url: URL;
  readonly #model: string;
  readonly #topLogprobs: number;
  readonly #timeoutMs: number;
  readonly #fetch: FetchLike;

  constructor(options: SemIfJudgeOptions = {}) {
    this.#url = semifChatUrl(options.baseUrl ?? DEFAULT_SEMIF_URL);
    this.#model = options.model ?? DEFAULT_SEMIF_MODEL;
    this.#topLogprobs = options.topLogprobs ?? DEFAULT_SEMIF_TOP_LOGPROBS;
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_SEMIF_TIMEOUT_MS;
    if (!Number.isInteger(this.#topLogprobs) || this.#topLogprobs < 2) {
      throw new ProviderError("SemIf top logprobs must be an integer of at least 2");
    }
    if (!Number.isInteger(this.#timeoutMs) || this.#timeoutMs < 1) {
      throw new ProviderError("SemIf timeout must be a positive integer");
    }
    this.#fetch = options.fetch ?? globalThis.fetch;
    if (typeof this.#fetch !== "function") {
      throw new ProviderError("SemIf requires a fetch implementation");
    }
  }

  async evaluate(plan: QuestionPlan): Promise<JudgeResponse> {
    const planned = buildSemIfQuestions(plan);
    const answers: JudgeResponse["answers"] = {};
    let inputTokens = 0;
    let outputTokens = 0;
    let responseModel = this.#model;

    for (const entry of planned) {
      const request: SemIfChatRequest = {
        model: this.#model,
        messages: [
          { role: "system", content: SEMIF_SYSTEM_PROMPT },
          {
            role: "user",
            content: JSON.stringify({
              evidence: entry.evidence,
              criterion: entry.criterion,
              options: entry.options,
            }),
          },
        ],
        max_tokens: 1,
        temperature: 0,
        logprobs: true,
        top_logprobs: this.#topLogprobs,
        chat_template_kwargs: { enable_thinking: false },
        seed: 1,
      };

      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), this.#timeoutMs);
      let response: Response;
      try {
        response = await this.#fetch(this.#url, {
          method: "POST",
          headers: {
            accept: "application/json",
            "content-type": "application/json",
          },
          body: JSON.stringify(request),
          signal: controller.signal,
        });
      } catch (error) {
        throw new ProviderError("SemIf request failed", { cause: error });
      } finally {
        clearTimeout(timeout);
      }

      if (!response.ok) {
        throw new ProviderError(
          `SemIf server returned HTTP ${response.status} ${response.statusText}`.trim(),
        );
      }

      let raw: unknown;
      try {
        raw = (await response.json()) as unknown;
      } catch (error) {
        throw new ProtocolError("SemIf server returned invalid JSON", { cause: error });
      }

      const parsed = semifRecord(raw, "completion response") as SemIfCompletionResponse;
      const model = typeof parsed.model === "string" && parsed.model.length > 0
        ? parsed.model
        : undefined;
      if (model !== undefined) responseModel = model;
      const probabilities = optionProbabilities(
        entry.options,
        parseSemIfTokenLogprobs(raw),
      );
      answers[entry.answerKey] = mapSemIfAnswer(entry, probabilities);
      const usage = semifUsage(parsed.usage);
      inputTokens += usage.input_tokens;
      outputTokens += usage.output_tokens;
    }

    return validateJudgeResponse(
      {
        model: responseModel,
        answers,
        usage: { input_tokens: inputTokens, output_tokens: outputTokens },
      },
      plan,
    );
  }
}

export class ReplayJudge implements Judge {
  readonly #response: unknown;

  constructor(response: unknown) {
    this.#response = response;
  }

  async evaluate(plan: QuestionPlan): Promise<JudgeResponse> {
    const parsed = replayResponseSchema.safeParse(this.#response);
    if (!parsed.success) {
      throw new ProtocolError(
        `Invalid replay response: ${parsed.error.message}. Replay fixtures must include candidate_order`,
      );
    }

    const expectedOrder = plan.candidateIds;
    const actualOrder = parsed.data.candidate_order;
    if (
      expectedOrder.length !== actualOrder.length ||
      expectedOrder.some((candidateId, index) => candidateId !== actualOrder[index])
    ) {
      throw new ProtocolError(
        `Replay candidate_order does not match the request (expected: ${expectedOrder.join(", ")}; received: ${actualOrder.join(", ")})`,
      );
    }

    const { candidate_order: _candidateOrder, ...response } = parsed.data;
    return validateJudgeResponse(response, plan);
  }
}

export function validateJudgeResponse(raw: unknown, plan: QuestionPlan): JudgeResponse {
  const parsed = judgeResponseSchema.safeParse(raw);
  if (!parsed.success) {
    throw new ProtocolError(`Invalid judge response: ${parsed.error.message}`);
  }

  const expectedKeys = Object.keys(plan.expectedTypes).sort();
  const actualKeys = Object.keys(parsed.data.answers).sort();
  if (
    expectedKeys.length !== actualKeys.length ||
    expectedKeys.some((key, index) => key !== actualKeys[index])
  ) {
    const missing = expectedKeys.filter((key) => !(key in parsed.data.answers));
    const unexpected = actualKeys.filter((key) => !(key in plan.expectedTypes));
    throw new ProtocolError(
      `Judge answer keys do not match questions (missing: ${missing.join(", ") || "none"}; unexpected: ${unexpected.join(", ") || "none"})`,
    );
  }

  for (const key of expectedKeys) {
    const answer = parsed.data.answers[key];
    const expectedType = plan.expectedTypes[key];
    if (answer?.type !== expectedType) {
      throw new ProtocolError(
        `Judge answer ${key} has type ${answer?.type ?? "missing"}; expected ${expectedType}`,
      );
    }
  }

  return parsed.data;
}
