#!/usr/bin/env node

import { performance } from "node:perf_hooks";
import { realpathSync } from "node:fs";
import { access, stat, writeFile } from "node:fs/promises";
import { env, stdin as input, stderr, stdout } from "node:process";
import { fileURLToPath } from "node:url";
import { dirname, resolve as resolvePath } from "node:path";
import { Command, CommanderError, InvalidArgumentError } from "commander";
import { ZodError } from "zod";
import { InputError, ProtocolError, ProviderError } from "./domain/errors.js";
import { rankRequestSchema, type RankRequest } from "./domain/schemas.js";
import {
  DEFAULT_JEV_URL,
  LocalJudge,
  ReplayJudge,
  SemIfJudge,
  TypeSafeJudge,
} from "./judge.js";
import { rankCandidates } from "./policy.js";
import { buildQuestionPlan } from "./questions.js";
import { renderHuman, renderJson } from "./report.js";
import { recordCommand } from "./evidence/recorder.js";
import { recordMetric, type EvidenceResultStatus } from "./evidence/metric.js";
import { recordArtifact } from "./evidence/artifact.js";
import { evidenceNext, evidenceStatus, renderEvidenceNext, renderEvidenceStatus } from "./evidence/status.js";
import { buildCampaign } from "./workflow/campaign.js";
import { decideCampaign } from "./workflow/decide.js";
import { buildDecidePlan } from "./workflow/decide-questions.js";
import { prepareDecision } from "./workflow/evidence.js";
import { campaignSchema, evidenceBundleSchema, metricObservationSchema } from "./workflow/schemas.js";
import { renderCampaignHuman, renderCampaignSummary, renderDecideHuman, renderWorkflowJson } from "./workflow/report.js";
import {
  approveLoopSpecCommand, auditLoopCommand, abortLoopCommand, createLoopCommand,
  nextLoopCommand, readLoopSpec, readRoundEvidence, readRoundPlan, renderLoopHuman,
  resumeLoopCommand, loopStatusData, loopEvidenceTemplate, buildLoopJudge,
} from "./loop/commands.js";
import { recordLoopArtifact, recordLoopCommand, recordLoopMetric } from "./loop/evidence-recorder.js";
import { loadLoop } from "./loop/store.js";
import { createLongCommand, ingestLongJsonlCommand, longStatusCommand, readLongSpec, renderLongHuman } from "./long/commands.js";
import { recordLoopAuditEvent } from "./long/bridge.js";
import { watchLong } from "./long/watch.js";
import { parseJsonBytes, readJsonFile } from "./io/json.js";
import { formatZodError } from "./io/validation.js";
import { reconsiderCandidate, renderReconsiderHuman } from "./reconsider.js";
import { evaluateActivation, renderActivationHuman, renderActivationJson } from "./activation.js";
import { activationRequestSchema, type ActivationRequest } from "./domain/schemas.js";

type Provider = "jev" | "typesafe" | "local" | "semif";
type OutputFormat = "human" | "json";

const DEFAULT_SEMIF_URL = "http://127.0.0.1:4878";
const DEFAULT_LOCAL_URL = "http://127.0.0.1:4877";
const VERSION = "0.2.0";
let commandExitCode = 0;

interface RankOptions {
  input: string;
  replay?: string;
  format: OutputFormat;
  model: string;
  provider: Provider | string;
  jevUrl?: string;
  localUrl?: string;
  semifUrl?: string;
  semifModel?: string;
  output?: string;
  summary?: boolean;
  top?: number;
}

interface DoctorOptions {
  format: OutputFormat;
  provider: Provider | string;
  check: boolean;
  jevUrl: string;
  localUrl: string;
  semifUrl: string;
}

interface DecideOptions {
  campaign: string;
  evidence: string;
  replay?: string;
  format: OutputFormat;
  model: string;
  provider: Provider | string;
  jevUrl?: string;
  localUrl?: string;
  semifUrl?: string;
  semifModel?: string;
  output?: string;
}

interface EvidenceRunOptions {
  evidence: string;
  candidate: string;
  id: string;
  workspace?: string;
  cwd: string;
  timeoutMs: number;
  maxOutputBytes: number;
  optional: boolean;
  complete: boolean;
  replace: boolean;
  quiet: boolean;
  echo: boolean;
  probe: string[];
  requirement: string[];
}

interface EvidenceMetricOptions {
  evidence: string;
  candidate: string;
  input: string;
  result?: EvidenceResultStatus;
  replace: boolean;
  probe: string[];
  requirement: string[];
}

interface EvidenceArtifactOptions {
  evidence: string;
  candidate: string;
  id: string;
  file: string;
  workspace?: string;
  mediaType?: string;
  excerpt: boolean;
  replace: boolean;
  evaluationId?: string;
  evaluator?: string;
  result?: EvidenceResultStatus;
  summary?: string;
  criterion?: string;
  score?: number;
  probe: string[];
  requirement: string[];
}

interface EvidenceStatusOptions {
  campaign: string;
  evidence: string;
  format: OutputFormat;
  output?: string;
  next: boolean;
}

interface LoopFormatOptions { format: OutputFormat; output?: string }
interface LoopCreateOptions extends LoopFormatOptions { directory: string; spec: string; baseRevision: string }
interface LoopNextOptions extends LoopFormatOptions { directory: string; plan?: string }
interface LoopEvidenceTemplateOptions extends LoopFormatOptions { directory: string; headRevision: string }
interface LoopAuditOptions extends LoopFormatOptions { directory: string; evidence: string; replay?: string; provider: string; jevUrl?: string; localUrl?: string; semifUrl?: string; semifModel?: string; model: string }
interface LoopDirectoryOptions extends LoopFormatOptions { directory: string }
interface LoopApproveOptions extends LoopFormatOptions { directory: string; spec: string; approvedBy: string; reason: string; yes: boolean }
interface LoopResumeOptions extends LoopDirectoryOptions { approvedBy: string; reason: string; yes: boolean }
interface LoopEvidenceRunOptions { directory: string; evidence: string; id: string; cwd?: string; timeoutMs: number; maxOutputBytes: number; replace: boolean; echo: boolean; criterion: string[]; protectedSurface: string[] }
interface LoopEvidenceMetricOptions { directory: string; evidence: string; input: string; criterion?: string; result?: EvidenceResultStatus; replace: boolean }
interface LoopEvidenceArtifactOptions { directory: string; evidence: string; id: string; artifactId?: string; file: string; summary: string; status: EvidenceResultStatus; criterion?: string; replace: boolean }
interface LongFormatOptions { format: OutputFormat; output?: string; directory: string }
interface ReconsiderOptions extends LoopFormatOptions {
  campaign: string;
  candidate: string;
  replay?: string;
  provider: string;
  jevUrl?: string;
  localUrl?: string;
  semifUrl?: string;
  semifModel?: string;
  model: string;
  promotedCampaignOutput?: string;
}

function envValue(...names: string[]): string | undefined {
  for (const name of names) {
    const value = env[name]?.trim();
    if (value !== undefined && value.length > 0) return value;
  }
  return undefined;
}

async function readStdinBytes(): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of input) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

async function readJson(path: string): Promise<unknown> {
  return path === "-" ? parseJsonBytes(await readStdinBytes(), "stdin") : readJsonFile(path);
}

function parsePositiveInteger(value: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 5) {
    throw new InvalidArgumentError("must be an integer from 1 to 5");
  }
  return parsed;
}

function parsePositiveNumber(value: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new InvalidArgumentError("must be a positive integer");
  }
  return parsed;
}
interface ActivationOptions { input: string; format: OutputFormat; output?: string }

function parseLongWatchInterval(value: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 100) {
    throw new InvalidArgumentError("must be an integer of at least 100 milliseconds");
  }
  return parsed;
}

function parseLongWatchIterations(value: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new InvalidArgumentError("must be a positive integer");
  }
  return parsed;
}

function parseLongWatchWidth(value: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 40) {
    throw new InvalidArgumentError("must be an integer of at least 40 columns");
  }
  return parsed;
}

function collectValue(value: string, previous: string[]): string[] {
  return [...previous, value];
}

function parseEvidenceResult(value: string): EvidenceResultStatus {
  if (value === "pass" || value === "fail" || value === "unknown") return value;
  throw new InvalidArgumentError("must be pass, fail, or unknown");
}

function parseUnitScore(value: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1) {
    throw new InvalidArgumentError("must be a number from 0 to 1");
  }
  return parsed;
}

function parseProvider(value: string): Provider {
  if (value === "jev" || value === "typesafe" || value === "local" || value === "semif") {
    return value;
  }
  throw new InvalidArgumentError("must be jev, semif, or local (typesafe is a compatibility alias)");
}

function normalizedProvider(provider: Provider): Exclude<Provider, "typesafe"> {
  return provider === "typesafe" ? "jev" : provider;
}

function requireJevApiKey(provider: Exclude<Provider, "typesafe">): string | undefined {
  const key = envValue("JEVREV_JEV_API_KEY", "TYPESAFE_API_KEY");
  if (provider === "jev" && key === undefined) {
    throw new ProviderError(
      "Missing Jev API key. Set JEVREV_JEV_API_KEY (or TYPESAFE_API_KEY), or use --provider semif/local.",
    );
  }
  return key;
}

function validateFormat(format: string): asserts format is OutputFormat {
  if (format !== "human" && format !== "json") {
    throw new InputError("--format must be human or json");
  }
}

async function emit(rendered: string, outputPath: string | undefined): Promise<void> {
  if (outputPath === undefined) {
    stdout.write(rendered);
    return;
  }
  try {
    await writeFile(outputPath, rendered, "utf8");
  } catch (error) {
    throw new InputError(`Could not write ${outputPath}`, { cause: error });
  }
}

async function evaluateRank(options: RankOptions) {
  const rawRequest = await readJson(options.input);
  let request: RankRequest;
  try {
    request = rankRequestSchema.parse(rawRequest);
    if (options.top !== undefined) {
      request = rankRequestSchema.parse({
        ...request,
        budget: { max_survivors: options.top },
      });
    }
  } catch (error) {
    if (error instanceof ZodError) {
      throw new InputError(`Invalid rank request: ${formatZodError(error)}. See examples/parser-speedup.json.`, { cause: error });
    }
    throw error;
  }

  const plan = buildQuestionPlan(request, { canonicalize: options.replay === undefined });
  const provider = normalizedProvider(parseProvider(String(options.provider)));
  const jevApiKey = options.replay === undefined ? requireJevApiKey(provider) : undefined;
  const judge =
    options.replay === undefined
      ? provider === "local"
        ? new LocalJudge(
            options.localUrl === undefined ? {} : { baseUrl: options.localUrl },
          )
        : provider === "semif"
          ? new SemIfJudge({
              ...(options.semifUrl ?? options.localUrl
                ? { baseUrl: options.semifUrl ?? options.localUrl }
                : {}),
              ...(options.semifModel === undefined ? {} : { model: options.semifModel }),
            })
          : new TypeSafeJudge({
              model: options.model,
              ...(jevApiKey === undefined ? {} : { apiKey: jevApiKey }),
              ...(options.jevUrl === undefined ? {} : { baseUrl: options.jevUrl }),
            })
      : new ReplayJudge(await readJson(options.replay));
  const response = await judge.evaluate(plan);
  const providerProfile = options.replay === undefined
    ? `${provider}/${response.model}`
    : "replay";
  const result = rankCandidates(request, response, plan.candidateOrder, { providerProfile });
  return { request, result };
}

async function runRank(options: RankOptions): Promise<void> {
  const { result } = await evaluateRank(options);
  await emit(options.format === "json" ? renderJson(result) : `${renderHuman(result)}\n`, options.output);
}

async function runSift(options: RankOptions): Promise<void> {
  if (options.summary && (options.output === undefined || options.format !== "json")) {
    throw new InputError("--summary requires --output and --format json");
  }
  const { request, result } = await evaluateRank(options);
  const campaign = buildCampaign(request, result);
  await emit(
    options.format === "json"
      ? renderWorkflowJson(campaign)
      : `${renderCampaignHuman(campaign)}\n`,
    options.output,
  );
  if (options.summary) stdout.write(renderCampaignSummary(campaign));
}

async function runReconsider(options: ReconsiderOptions): Promise<void> {
  validateFormat(options.format);
  await validateOutputTarget(options.output);
  await validateOutputTarget(options.promotedCampaignOutput);
  let campaign;
  try {
    campaign = campaignSchema.parse(await readJson(options.campaign));
  } catch (error) {
    if (error instanceof ZodError) throw new InputError(`Invalid reconsider campaign: ${formatZodError(error)}.`, { cause: error });
    throw error;
  }
  const replay = options.replay === undefined ? undefined : await readJson(options.replay);
  const provider = loopProvider(options.provider);
  const judge = buildLoopJudge({
    provider,
    ...(replay === undefined ? {} : { replay }),
    ...(options.jevUrl === undefined ? {} : { jevUrl: options.jevUrl }),
    ...(options.localUrl === undefined ? {} : { localUrl: options.localUrl }),
    ...(options.semifUrl === undefined ? {} : { semifUrl: options.semifUrl }),
    ...(options.semifModel === undefined ? {} : { semifModel: options.semifModel }),
    model: options.model,
    ...(envValue("JEVREV_JEV_API_KEY", "TYPESAFE_API_KEY") === undefined ? {} : { apiKey: envValue("JEVREV_JEV_API_KEY", "TYPESAFE_API_KEY")! }),
  });
  if (judge === undefined) throw new ProviderError("A judge provider is required for reconsider");
  const result = await reconsiderCandidate(campaign, options.candidate, judge, {
    providerProfile: replay === undefined ? `${provider}/${options.model}` : "replay",
  });
  if (options.promotedCampaignOutput !== undefined && result.promoted_campaign !== null) {
    await emit(`${JSON.stringify(result.promoted_campaign, null, 2)}\n`, options.promotedCampaignOutput);
  }
  await emit(options.format === "json" ? `${JSON.stringify(result, null, 2)}\n` : renderReconsiderHuman(result), options.output);
}

async function runDecide(options: DecideOptions): Promise<void> {
  const rawCampaign = await readJson(options.campaign);
  const rawEvidence = await readJson(options.evidence);
  let campaign;
  let bundle;
  try {
    campaign = campaignSchema.parse(rawCampaign);
    bundle = evidenceBundleSchema.parse(rawEvidence);
  } catch (error) {
    if (error instanceof ZodError) {
      throw new InputError(`Invalid decide input: ${formatZodError(error)}.`, { cause: error });
    }
    throw error;
  }

  const prepared = prepareDecision(campaign, bundle);
  let response;
  let candidateOrder: readonly number[] = [];
  let providerProfile = "deterministic/no-viable-finalists";
  if (prepared.viable.length > 0) {
    const plan = buildDecidePlan(prepared, { canonicalize: options.replay === undefined });
    candidateOrder = plan.candidateOrder;
    const provider = normalizedProvider(parseProvider(String(options.provider)));
    const jevApiKey = options.replay === undefined ? requireJevApiKey(provider) : undefined;
    const judge = options.replay === undefined
      ? provider === "local"
        ? new LocalJudge(options.localUrl === undefined ? {} : { baseUrl: options.localUrl })
        : provider === "semif"
          ? new SemIfJudge({
              ...(options.semifUrl ?? options.localUrl
                ? { baseUrl: options.semifUrl ?? options.localUrl }
                : {}),
              ...(options.semifModel === undefined ? {} : { model: options.semifModel }),
            })
          : new TypeSafeJudge({
              model: options.model,
              ...(jevApiKey === undefined ? {} : { apiKey: jevApiKey }),
              ...(options.jevUrl === undefined ? {} : { baseUrl: options.jevUrl }),
            })
      : new ReplayJudge(await readJson(options.replay));
    response = await judge.evaluate(plan);
    providerProfile = options.replay === undefined ? `${provider}/${response.model}` : "replay";
  }

  const result = decideCampaign(prepared, response, candidateOrder, { providerProfile });
  await emit(
    options.format === "json" ? renderWorkflowJson(result) : `${renderDecideHuman(result)}\n`,
    options.output,
  );
}

function validatedHttpUrl(value: string, label: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch (error) {
    throw new InputError(`Invalid ${label} URL: ${value}`, { cause: error });
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new InputError(`${label} URL must use http or https`);
  }
  parsed.search = "";
  parsed.hash = "";
  return parsed.toString().replace(/\/$/, "");
}

function endpoint(baseUrl: string, path: string, label: string): string {
  return `${validatedHttpUrl(baseUrl, label)}${path}`;
}

function versionedEndpoint(baseUrl: string, path: string, label: string): string {
  const normalized = validatedHttpUrl(baseUrl, label);
  const versionRoot = normalized.endsWith("/v1") ? normalized : `${normalized}/v1`;
  return `${versionRoot}/${path.replace(/^\/+/, "")}`;
}

function serviceHealthEndpoint(baseUrl: string, label: string): string {
  const normalized = validatedHttpUrl(baseUrl, label);
  const serviceRoot = normalized.endsWith("/v1") ? normalized.slice(0, -3) : normalized;
  return `${serviceRoot}/health`;
}

function doctorHuman(data: Record<string, unknown>): string {
  const endpoints = data.endpoints as Record<string, Record<string, unknown>>;
  const lines = [
    `JevRev ${VERSION}`,
    `provider: ${String(data.provider)}`,
    "",
    "Configured endpoints:",
  ];
  for (const [name, value] of Object.entries(endpoints)) {
    lines.push(`- ${name}: ${String(value.request_url)} (${String(value.state)})`);
  }
  const credentials = data.credentials as { configured: boolean };
  lines.push(
    "",
    `Jev credentials: ${credentials.configured ? "configured" : "not configured"}`,
    "Credential names: JEVREV_JEV_API_KEY or TYPESAFE_API_KEY (never passed on the command line).",
  );
  return `${lines.join("\n")}\n`;
}

async function checkEndpoint(url: string): Promise<string> {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(2_000) });
    return `${response.status} ${response.statusText}`.trim();
  } catch (error) {
    return error instanceof Error ? `unreachable: ${error.message}` : "unreachable";
  }
}

async function runActivation(options: ActivationOptions): Promise<void> {
  validateFormat(options.format);
  await validateOutputTarget(options.output);
  let request: ActivationRequest;
  try {
    request = activationRequestSchema.parse(await readJson(options.input));
  } catch (error) {
    if (error instanceof ZodError) {
      throw new InputError(`Invalid activation request: ${formatZodError(error)}.`, { cause: error });
    }
    throw error;
  }
  const decision = evaluateActivation(request);
  await emit(options.format === "json" ? renderActivationJson(decision) : renderActivationHuman(decision), options.output);
}

function endpointCheckFailed(state: string): boolean {
  return state.startsWith("unreachable:") || /^[45]\d\d(?:\s|$)/.test(state);
}

async function runDoctor(options: DoctorOptions): Promise<void> {
  const provider = normalizedProvider(parseProvider(String(options.provider)));
  const data: Record<string, unknown> = {
    product: "JevRev",
    version: VERSION,
    provider,
    credentials: { configured: envValue("JEVREV_JEV_API_KEY", "TYPESAFE_API_KEY") !== undefined },
    endpoints: {
      jev: {
        base_url: options.jevUrl,
        request_url: endpoint(options.jevUrl, "/v1/systemone", "Jev"),
        state: options.check ? "configured; use `run` for an authenticated request" : "not_checked",
      },
      semif: {
        base_url: options.semifUrl,
        request_url: versionedEndpoint(options.semifUrl, "chat/completions", "SemIf"),
        state: options.check ? await checkEndpoint(serviceHealthEndpoint(options.semifUrl, "SemIf")) : "not_checked",
      },
      local: {
        base_url: options.localUrl,
        request_url: versionedEndpoint(options.localUrl, "score", "local scorer"),
        state: options.check ? await checkEndpoint(serviceHealthEndpoint(options.localUrl, "local scorer")) : "not_checked",
      },
    },
  };
  await emit(options.format === "json" ? `${JSON.stringify(data, null, 2)}\n` : doctorHuman(data), undefined);
  if (options.check && (provider === "local" || provider === "semif")) {
    const endpointData = data.endpoints as Record<string, { state: string }>;
    const selectedEndpoint = endpointData[provider];
    if (selectedEndpoint !== undefined && endpointCheckFailed(selectedEndpoint.state)) commandExitCode = 3;
  }
}

function addRankCommand(program: Command, name: "run" | "rank" | "sift"): void {
  const defaultFormat: OutputFormat = name === "rank" ? "human" : "json";
  const command = program
    .command(name)
    .description(
      name === "sift"
        ? "Sift candidate approaches and emit bounded probe work orders"
        : name === "run"
        ? "Evaluate candidate approaches and return an implementation shortlist"
        : "Compatibility alias for run",
    )
    .requiredOption("-i, --input <path>", "request JSON path, or - for stdin")
    .option("--replay <path>", "use a captured Jev response instead of a live provider")
    .option("--format <format>", "human or json", defaultFormat)
    .option(
      "--provider <provider>",
      "jev, semif, or local (typesafe is a compatibility alias)",
      envValue("JEVREV_PROVIDER", "SPECJEV_PROVIDER") ?? "jev",
    )
    .option(
      "--jev-url <url>",
      "Jev API root; request is POST /v1/systemone",
      envValue("JEVREV_JEV_URL", "TYPESAFE_BASE_URL"),
    )
    .option(
      "--local-url <url>",
      "legacy local reranker base URL",
      envValue("JEVREV_LOCAL_URL", "SPECJEV_LOCAL_URL"),
    )
    .option(
      "--semif-url <url>",
      "local SemIf llama.cpp base URL",
      envValue("JEVREV_SEMIF_URL", "SPECJEV_SEMIF_URL"),
    )
    .option(
      "--semif-model <model>",
      "SemIf model identifier",
      envValue("JEVREV_SEMIF_MODEL", "SPECJEV_SEMIF_MODEL"),
    )
    .option(
      "--model <model>",
      "Jev model",
      envValue("JEVREV_JEV_MODEL", "TYPESAFE_DEFAULT_MODEL") ?? "jev-latest",
    )
    .option("--top <count>", "override max survivors", parsePositiveInteger)
    .option("-o, --output <path>", "write the rendered result to a file");
  if (name === "sift") command.option("--summary", "print a short work-order summary while writing JSON to --output");
  command.action(async (rawOptions: RankOptions) => {
      validateFormat(rawOptions.format);
      if (name === "sift") await runSift(rawOptions);
      else await runRank(rawOptions);
    });
}

async function validateOutputTarget(outputPath: string | undefined): Promise<void> {
  if (outputPath === undefined) return;
  const target = resolvePath(outputPath);
  try {
    const metadata = await stat(target);
    if (metadata.isDirectory()) throw new InputError(`Output path is a directory: ${outputPath}`);
    try {
      await access(target, 2);
    } catch (error) {
      throw new InputError(`Output path is not writable: ${outputPath}`, { cause: error });
    }
  } catch (error) {
    if (error instanceof InputError) throw error;
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw new InputError(`Output path is not accessible: ${outputPath}`, { cause: error });
    }
    try {
      await access(dirname(target), 3);
    } catch (parentError) {
      throw new InputError(`Output path is not writable: ${outputPath}`, { cause: parentError });
    }
  }
}

async function emitLoopStatus(loop: Awaited<ReturnType<typeof loadLoop>>, options: LoopFormatOptions): Promise<void> {
  validateFormat(options.format);
  await emit(options.format === "json" ? `${JSON.stringify(loopStatusData(loop), null, 2)}\n` : renderLoopHuman(loop), options.output);
}

function loopProvider(value: string): "jev" | "local" | "semif" {
  const provider = normalizedProvider(parseProvider(value));
  return provider;
}

async function runLoopCreate(options: LoopCreateOptions): Promise<void> {
  validateFormat(options.format);
  await validateOutputTarget(options.output);
  const spec = await readLoopSpec(options.spec);
  const loop = await createLoopCommand(options.directory, spec, options.baseRevision);
  await emitLoopStatus(loop, options);
}

async function runLoopNext(options: LoopNextOptions): Promise<void> {
  validateFormat(options.format);
  await validateOutputTarget(options.output);
  const plan = options.plan === undefined ? undefined : await readRoundPlan(options.plan);
  const issued = await nextLoopCommand(options.directory, plan);
  validateFormat(options.format);
  const rendered = options.format === "json" ? `${JSON.stringify(issued.order, null, 2)}\n` : [
    `round ${issued.order.round_number}  ${issued.order.mode}`,
    `goal: ${issued.order.round_goal}`,
    `base: ${issued.order.base_revision}`,
    `focus: ${issued.order.focus_criteria.join(", ")}`,
    `evidence slots: ${issued.order.required_evidence.length}`,
    issued.issued ? "issued: yes" : "issued: already active",
    "The agent owns execution; submit a round-evidence JSON to `jevrev loop audit`.",
    "",
  ].join("\n");
  await emit(rendered, options.output);
}

async function runLoopEvidenceTemplate(options: LoopEvidenceTemplateOptions): Promise<void> {
  validateFormat(options.format);
  await validateOutputTarget(options.output);
  const loop = await loadLoop(options.directory);
  const template = loopEvidenceTemplate(loop, options.headRevision);
  const rendered = options.format === "json" ? `${JSON.stringify(template, null, 2)}\n` : [
    `round ${template.round_number}  evidence template`,
    `loop: ${template.loop_id}`,
    `base: ${template.base_revision}`,
    `head: ${template.head_revision}`,
    `criteria: ${template.criterion_results.map((item) => `${item.id}=${item.status}`).join(", ") || "none"}`,
    `protected surfaces: ${template.protected_surface_results.map((item) => `${item.id}=${item.status}`).join(", ") || "none"}`,
    "The template is incomplete; record observations and submit it to `jevrev loop audit`.",
    "",
  ].join("\n");
  await emit(rendered, options.output);
}

async function runLoopAudit(options: LoopAuditOptions): Promise<void> {
  validateFormat(options.format);
  await validateOutputTarget(options.output);
  const evidence = await readRoundEvidence(options.evidence);
  const replay = options.replay === undefined ? undefined : await readJson(options.replay);
  const result = await auditLoopCommand(options.directory, evidence, {
    provider: loopProvider(options.provider),
    ...(replay === undefined ? {} : { replay }),
    ...(options.jevUrl === undefined ? {} : { jevUrl: options.jevUrl }),
    ...(options.localUrl === undefined ? {} : { localUrl: options.localUrl }),
    ...(options.semifUrl === undefined ? {} : { semifUrl: options.semifUrl }),
    ...(options.semifModel === undefined ? {} : { semifModel: options.semifModel }),
    model: options.model,
    ...(envValue("JEVREV_JEV_API_KEY", "TYPESAFE_API_KEY") === undefined ? {} : { apiKey: envValue("JEVREV_JEV_API_KEY", "TYPESAFE_API_KEY")! }),
  });
  const progressLabel = result.result.material_progress
    ? "material"
    : result.result.outcome === "completed" ? "no new material change (completion verified)" : "stalled";
  const rendered = options.format === "json" ? `${JSON.stringify(result.result, null, 2)}\n` : [
    `round ${result.result.round_number}  ${result.result.outcome}`,
    `progress: ${progressLabel}`,
    `blocking: ${result.result.blocking_criteria.join(", ") || "none"}`,
    `next: ${result.result.next_action.type}${result.result.next_action.focus_criteria.length ? ` (${result.result.next_action.focus_criteria.join(", ")})` : ""}`,
    result.result.next_action.reason,
    "",
  ].join("\n");
  await emit(rendered, options.output);
}

async function runLoopEvidenceRun(options: LoopEvidenceRunOptions, command: string[]): Promise<void> {
  const observation = await recordLoopCommand({
    directory: options.directory, evidencePath: options.evidence, observationId: options.id, argv: command,
    ...(options.cwd === undefined ? {} : { cwd: options.cwd }), timeoutMs: options.timeoutMs,
    maxOutputBytes: options.maxOutputBytes, replace: options.replace, echo: options.echo,
    criterionIds: options.criterion, protectedSurfaceIds: options.protectedSurface,
  });
  stderr.write(`jevrev: recorded Loop observation ${observation.id}: exit ${observation.exit_code}, ${observation.duration_ms}ms\n`);
  commandExitCode = observation.exit_code === 0 && observation.termination === "exited" ? 0 : observation.exit_code || 1;
  await emit(`${JSON.stringify(observation, null, 2)}\n`, undefined);
}

async function runLoopEvidenceMetric(options: LoopEvidenceMetricOptions): Promise<void> {
  const metric = await recordLoopMetric({ directory: options.directory, evidencePath: options.evidence, metric: await readJson(options.input), ...(options.criterion === undefined ? {} : { criterionId: options.criterion }), ...(options.result === undefined ? {} : { result: options.result }), replace: options.replace });
  await emit(`${JSON.stringify(metric, null, 2)}\n`, undefined);
}

async function runLoopEvidenceArtifact(options: LoopEvidenceArtifactOptions): Promise<void> {
  const artifact = await recordLoopArtifact({ directory: options.directory, evidencePath: options.evidence, artifactId: options.artifactId ?? options.id, ...(options.artifactId === undefined ? {} : { evaluationId: options.id }), file: options.file, summary: options.summary, status: options.status, ...(options.criterion === undefined ? {} : { criterionId: options.criterion }), replace: options.replace });
  await emit(`${JSON.stringify(artifact, null, 2)}\n`, undefined);
}

async function runLoopMutation(options: LoopDirectoryOptions, mutation: (directory: string) => Promise<Awaited<ReturnType<typeof loadLoop>>>): Promise<void> {
  validateFormat(options.format);
  await validateOutputTarget(options.output);
  await emitLoopStatus(await mutation(options.directory), options);
}

async function runLoopApprove(options: LoopApproveOptions): Promise<void> {
  validateFormat(options.format);
  await validateOutputTarget(options.output);
  if (!options.yes) throw new InputError("Spec approval changes the frozen contract; pass --yes to confirm the human decision");
  const spec = await readLoopSpec(options.spec);
  await emitLoopStatus(await approveLoopSpecCommand(options.directory, spec, options.approvedBy, options.reason), options);
}

async function runLoopResume(options: LoopResumeOptions): Promise<void> {
  validateFormat(options.format);
  await validateOutputTarget(options.output);
  if (!options.yes) throw new InputError("Resuming a paused loop changes its human boundary; pass --yes to confirm the human decision");
  await emitLoopStatus(await resumeLoopCommand(options.directory, options.approvedBy, options.reason), options);
}

function addLoopCommand(program: Command): void {
  const loop = program.command("loop").description("Human-controlled JevLoop round protocol");
  loop.command("create")
    .description("Create a frozen single-artifact loop")
    .requiredOption("--directory <path>", "new loop directory")
    .requiredOption("--spec <path>", "Loop spec JSON")
    .requiredOption("--base-revision <revision>", "starting workspace revision")
    .option("--format <format>", "human or json", "human")
    .option("-o, --output <path>", "write result to a file")
    .action(async (raw: LoopCreateOptions) => runLoopCreate(raw));
  loop.command("next")
    .description("Issue one agent work order; this command never runs the agent")
    .requiredOption("--directory <path>", "loop directory")
    .option("--plan <path>", "progress round plan JSON; completion rounds derive their plan")
    .option("--format <format>", "human or json", "human")
    .option("-o, --output <path>", "write result to a file")
    .action(async (raw: LoopNextOptions) => runLoopNext(raw));
  loop.command("evidence-template")
    .description("Create an incomplete round-evidence envelope for the active work order")
    .requiredOption("--directory <path>", "loop directory")
    .requiredOption("--head-revision <revision>", "current artifact revision")
    .option("--format <format>", "human or json", "json")
    .option("-o, --output <path>", "write evidence JSON to a file")
    .action(async (raw: LoopEvidenceTemplateOptions) => runLoopEvidenceTemplate(raw));
  loop.command("audit")
    .description("Audit submitted round evidence and append one decision")
    .requiredOption("--directory <path>", "loop directory")
    .requiredOption("--evidence <path>", "round-evidence JSON")
    .option("--provider <provider>", "jev, semif, or local", envValue("JEVREV_PROVIDER", "SPECJEV_PROVIDER") ?? "jev")
    .option("--replay <path>", "captured Jev response JSON")
    .option("--jev-url <url>", "Jev API root", envValue("JEVREV_JEV_URL", "TYPESAFE_BASE_URL"))
    .option("--local-url <url>", "local scorer base URL", envValue("JEVREV_LOCAL_URL", "SPECJEV_LOCAL_URL"))
    .option("--semif-url <url>", "SemIf base URL", envValue("JEVREV_SEMIF_URL", "SPECJEV_SEMIF_URL"))
    .option("--semif-model <model>", "SemIf model", envValue("JEVREV_SEMIF_MODEL", "SPECJEV_SEMIF_MODEL"))
    .option("--model <model>", "Jev model", envValue("JEVREV_JEV_MODEL", "TYPESAFE_DEFAULT_MODEL") ?? "jev-latest")
    .option("--format <format>", "human or json", "human")
    .option("-o, --output <path>", "write result to a file")
    .action(async (raw: LoopAuditOptions) => runLoopAudit(raw));
  const loopEvidence = loop.command("evidence").description("Record facts into the active Loop round without advancing it");
  loopEvidence.command("run <command...>")
    .description("Execute argv directly and append a recorded observation to round evidence")
    .requiredOption("--directory <path>", "loop directory")
    .requiredOption("--evidence <path>", "round-evidence JSON")
    .requiredOption("--id <id>", "stable observation ID")
    .option("--cwd <path>", "command cwd relative to workspace", ".")
    .option("--timeout-ms <n>", "command timeout", parsePositiveNumber, 120_000)
    .option("--max-output-bytes <n>", "maximum captured bytes per stream", parsePositiveNumber, 4 * 1024 * 1024)
    .option("--criterion <id>", "link result to a Loop criterion; repeatable", collectValue, [])
    .option("--protected-surface <id>", "link result to a protected surface; repeatable", collectValue, [])
    .option("--replace", "replace an observation with the same ID", false)
    .option("--echo", "echo child output (may expose secrets)", false)
    .action(async (command: string[], raw: LoopEvidenceRunOptions) => runLoopEvidenceRun(raw, command));
  loopEvidence.command("metric")
    .description("Append raw metric samples to round evidence")
    .requiredOption("--directory <path>", "loop directory")
    .requiredOption("--evidence <path>", "round-evidence JSON")
    .requiredOption("--input <path>", "metric JSON")
    .option("--criterion <id>", "criterion ID when metric JSON does not supply one")
    .option("--result <result>", "pass, fail, or unknown", parseEvidenceResult)
    .option("--replace", "replace a metric with the same ID", false)
    .action(async (raw: LoopEvidenceMetricOptions) => runLoopEvidenceMetric(raw));
  loopEvidence.command("artifact")
    .description("Hash and attach an evaluated artifact to round evidence")
    .requiredOption("--directory <path>", "loop directory")
    .requiredOption("--evidence <path>", "round-evidence JSON")
    .requiredOption("--id <id>", "stable artifact evaluation ID")
    .option("--artifact-id <id>", "spec artifact reference; defaults to --id")
    .requiredOption("--file <path>", "workspace-relative artifact")
    .requiredOption("--summary <text>", "human-readable evaluator summary")
    .requiredOption("--status <status>", "pass, fail, or unknown", parseEvidenceResult)
    .option("--criterion <id>", "judged criterion ID")
    .option("--replace", "replace an evaluation with the same ID", false)
    .action(async (raw: LoopEvidenceArtifactOptions) => runLoopEvidenceArtifact(raw));
  loop.command("status")
    .description("Show the reconstructed loop state")
    .requiredOption("--directory <path>", "loop directory")
    .option("--format <format>", "human or json", "human")
    .option("-o, --output <path>", "write result to a file")
    .action(async (raw: LoopDirectoryOptions) => runLoopMutation(raw, loadLoop));
  loop.command("resume")
    .description("Human-confirm resumption after a human or budget pause")
    .requiredOption("--directory <path>", "loop directory")
    .requiredOption("--approved-by <name>", "human approver attestation")
    .requiredOption("--reason <text>", "why the loop resumes")
    .option("--yes", "confirm this human decision", false)
    .option("--format <format>", "human or json", "human")
    .option("-o, --output <path>", "write result to a file")
    .action(async (raw: LoopResumeOptions) => runLoopResume(raw));
  loop.command("abort")
    .description("End a loop without claiming success")
    .requiredOption("--directory <path>", "loop directory")
    .option("--format <format>", "human or json", "human")
    .option("-o, --output <path>", "write result to a file")
    .action(async (raw: LoopDirectoryOptions) => runLoopMutation(raw, abortLoopCommand));
  loop.command("approve")
    .description("Human-approve a new frozen spec revision")
    .requiredOption("--directory <path>", "loop directory")
    .requiredOption("--spec <path>", "new spec JSON")
    .requiredOption("--approved-by <name>", "human approver attestation")
    .requiredOption("--reason <text>", "why the frozen contract changes")
    .option("--yes", "confirm this human decision", false)
    .option("--format <format>", "human or json", "human")
    .option("-o, --output <path>", "write result to a file")
    .action(async (raw: LoopApproveOptions) => runLoopApprove(raw));
}

function addLongCommand(program: Command): void {
  const long = program.command("long").description("Observe a long-running agent session without driving it");
  long.command("create").description("Create a frozen Long observer session")
    .requiredOption("--directory <path>", "Long store directory")
    .requiredOption("--spec <path>", "Long spec JSON")
    .option("--format <format>", "human or json", "human")
    .action(async (raw: { directory: string; spec: string; format: OutputFormat }) => {
      validateFormat(raw.format);
      const store = await createLongCommand(raw.directory, await readLongSpec(raw.spec));
      stdout.write(raw.format === "json" ? `${JSON.stringify(store.snapshot, null, 2)}\n` : `created ${store.spec.session_id}\n`);
    });
  long.command("ingest").description("Normalize and append one bounded JSONL event batch")
    .requiredOption("--directory <path>", "Long store directory")
    .requiredOption("--input <path>", "JSONL event file, or - for stdin")
    .option("--format <format>", "human or json", "human")
    .action(async (raw: { directory: string; input: string; format: OutputFormat }) => {
      validateFormat(raw.format);
      const result = await ingestLongJsonlCommand(raw.directory, raw.input);
      stdout.write(raw.format === "json"
        ? `${JSON.stringify({ accepted: result.accepted.length, duplicates: result.duplicate_event_ids.length, snapshot: result.snapshot }, null, 2)}\n`
        : `accepted ${result.accepted.length}, duplicates ${result.duplicate_event_ids.length}\n`);
    });
  long.command("loop-audit").description("Record a JevLoop audit as a trusted Long observation event")
    .requiredOption("--directory <path>", "Long store directory")
    .requiredOption("--loop-directory <path>", "actual JevLoop directory to verify")
    .requiredOption("--loop-id <id>", "Loop ID")
    .requiredOption("--round <n>", "audited round number", parsePositiveNumber)
    .requiredOption("--work-order-sha256 <digest>", "audited work-order digest")
    .requiredOption("--outcome <outcome>", "Loop audit outcome")
    .requiredOption("--evidence-sha256 <digest>", "audited evidence digest")
    .option("--occurred-at <timestamp>", "audit timestamp")
    .option("--format <format>", "human or json", "human")
    .action(async (raw: { directory: string; loopDirectory: string; loopId: string; round: number; workOrderSha256: string; outcome: string; evidenceSha256: string; occurredAt?: string; format: OutputFormat }) => {
      validateFormat(raw.format);
      const result = await recordLoopAuditEvent(raw.directory, raw.loopDirectory, { loop_id: raw.loopId, round_number: raw.round, work_order_sha256: raw.workOrderSha256, audit_outcome: raw.outcome, evidence_sha256: raw.evidenceSha256, ...(raw.occurredAt === undefined ? {} : { occurred_at: raw.occurredAt }) });
      await emit(raw.format === "json" ? `${JSON.stringify({ accepted: result.accepted.length, duplicates: result.duplicate_event_ids.length, snapshot: result.snapshot }, null, 2)}\n` : `accepted ${result.accepted.length}, duplicates ${result.duplicate_event_ids.length}\n`, undefined);
    });
  long.command("status").description("Read the current deterministic observer snapshot")
    .requiredOption("--directory <path>", "Long store directory")
    .option("--format <format>", "human or json", "human")
    .action(async (raw: LongFormatOptions) => {
      validateFormat(raw.format);
      const result = await longStatusCommand(raw.directory);
      stdout.write(raw.format === "json"
        ? `${JSON.stringify({ snapshot: result.store.snapshot, signals: result.signals, alerts: result.policy.alerts }, null, 2)}\n`
        : renderLongHuman(result));
    });
  long.command("watch").description("Render the external JevLong dashboard without driving the agent")
    .requiredOption("--directory <path>", "Long store directory")
    .option("--root <path>", "browse sibling Long sessions in this root")
    .option("--interval-ms <n>", "refresh interval in milliseconds (foreground: 1000, background: 10000)", parseLongWatchInterval)
    .option("--iterations <n>", "sample N times; non-interactive output prints changes only", parseLongWatchIterations)
    .option("--stream", "keep sampling without a terminal; prints compact changes only", false)
    .option("--full", "print the full dashboard in non-interactive mode", false)
    .option("--width <n>", "dashboard width", parseLongWatchWidth, 100)
    .option("--no-color", "disable ANSI colors")
    .option("--no-clear", "append frames instead of clearing the terminal")
    .action(async (raw: { directory: string; root?: string; intervalMs?: number; iterations?: number; width: number; color: boolean; clear: boolean; stream: boolean; full: boolean }) => {
      await watchLong(raw.directory, {
        ...(raw.intervalMs === undefined ? {} : { intervalMs: raw.intervalMs }),
        ...(raw.iterations === undefined ? {} : { iterations: raw.iterations }),
        ...(raw.root === undefined ? {} : { root: raw.root }),
        width: raw.width,
        color: raw.color,
        clear: raw.clear,
        stream: raw.stream,
        full: raw.full,
      });
    });
}

function createProgram(): Command {
  const program = new Command()
    .name("jevrev")
    .description("Explore candidate approaches, prune them with Jev, and return the few worth executing")
    .version(VERSION)
    .exitOverride()
    .showHelpAfterError();

  addRankCommand(program, "run");
  addRankCommand(program, "rank");
  addRankCommand(program, "sift");
  program
    .command("reconsider")
    .description("Re-evaluate one Sift review candidate for a single bounded probe")
    .requiredOption("--campaign <path>", "campaign JSON")
    .requiredOption("--candidate <id>", "review candidate ID")
    .option("--replay <path>", "use a captured reconsider response")
    .option("--format <format>", "human or json", "human")
    .option("--provider <provider>", "jev, semif, or local", envValue("JEVREV_PROVIDER", "SPECJEV_PROVIDER") ?? "jev")
    .option("--jev-url <url>", "Jev API root", envValue("JEVREV_JEV_URL", "TYPESAFE_BASE_URL"))
    .option("--local-url <url>", "legacy local scorer base URL", envValue("JEVREV_LOCAL_URL", "SPECJEV_LOCAL_URL"))
    .option("--semif-url <url>", "SemIf base URL", envValue("JEVREV_SEMIF_URL", "SPECJEV_SEMIF_URL"))
    .option("--semif-model <model>", "SemIf model", envValue("JEVREV_SEMIF_MODEL", "SPECJEV_SEMIF_MODEL"))
    .option("--model <model>", "Jev model", envValue("JEVREV_JEV_MODEL", "TYPESAFE_DEFAULT_MODEL") ?? "jev-latest")
    .option("--promoted-campaign-output <path>", "write the promoted campaign envelope when reconsider succeeds")
    .option("-o, --output <path>", "write the rendered result to a file")
    .action(async (raw: ReconsiderOptions) => runReconsider(raw));
  addLoopCommand(program);
  addLongCommand(program);

  program
    .command("activation")
    .alias("activate")
    .description("Report whether Sift is worthwhile (shadow-only, no workflow change)")
    .requiredOption("-i, --input <path>", "activation request JSON path, or - for stdin")
    .option("--format <format>", "human or json", "human")
    .option("-o, --output <path>", "write the rendered decision to a file")
    .action(async (rawOptions: ActivationOptions) => runActivation(rawOptions));

  program
    .command("decide")
    .description("Choose from probed finalists using deterministic evidence and Jev")
    .requiredOption("--campaign <path>", "campaign JSON emitted by `jevrev sift`")
    .requiredOption("--evidence <path>", "evidence bundle JSON")
    .option("--replay <path>", "use a captured decide response instead of a live provider")
    .option("--format <format>", "human or json", "json")
    .option(
      "--provider <provider>",
      "jev, semif, or local (typesafe is a compatibility alias)",
      envValue("JEVREV_PROVIDER", "SPECJEV_PROVIDER") ?? "jev",
    )
    .option("--jev-url <url>", "Jev API root", envValue("JEVREV_JEV_URL", "TYPESAFE_BASE_URL"))
    .option("--local-url <url>", "legacy local reranker base URL", envValue("JEVREV_LOCAL_URL", "SPECJEV_LOCAL_URL"))
    .option("--semif-url <url>", "local SemIf llama.cpp base URL", envValue("JEVREV_SEMIF_URL", "SPECJEV_SEMIF_URL"))
    .option("--semif-model <model>", "SemIf model identifier", envValue("JEVREV_SEMIF_MODEL", "SPECJEV_SEMIF_MODEL"))
    .option("--model <model>", "Jev model", envValue("JEVREV_JEV_MODEL", "TYPESAFE_DEFAULT_MODEL") ?? "jev-latest")
    .option("-o, --output <path>", "write the rendered result to a file")
    .action(async (rawOptions: DecideOptions) => {
      validateFormat(rawOptions.format);
      await runDecide(rawOptions);
    });

  const evidence = program
    .command("evidence")
    .description("Record trusted command evidence for a campaign finalist");

  evidence
    .command("run <command...>")
    .description("Run argv directly and atomically append its observation to an evidence bundle")
    .requiredOption("--evidence <path>", "evidence bundle created from a Sift campaign")
    .requiredOption("--candidate <id>", "candidate packet to update")
    .requiredOption("--id <id>", "stable observation ID")
    .option("--workspace <path>", "workspace boundary (default: current directory)")
    .option("--cwd <path>", "command cwd relative to the workspace", ".")
    .option("--timeout-ms <n>", "command timeout", parsePositiveNumber, 120_000)
    .option("--max-output-bytes <n>", "maximum captured bytes per stream", parsePositiveNumber, 4 * 1024 * 1024)
    .option("--optional", "record the command as optional", false)
    .option("--complete", "mark candidate development completed after recording", false)
    .option("--replace", "replace an observation with the same ID", false)
    .option("--quiet", "compatibility flag; child output is quiet by default", false)
    .option("--echo", "echo child stdout/stderr to the terminal (may expose secrets)", false)
    .option("--probe <id>", "link exit status to a required probe ID; repeatable", collectValue, [])
    .option(
      "--requirement <kind:id>",
      "link exit status to success:<id> or constraint:<id>; repeatable",
      collectValue,
      [],
    )
    .action(async (command: string[], rawOptions: EvidenceRunOptions) => {
      const recorded = await recordCommand({
        evidencePath: rawOptions.evidence,
        candidateId: rawOptions.candidate,
        observationId: rawOptions.id,
        argv: command,
        ...(rawOptions.workspace === undefined ? {} : { workspace: rawOptions.workspace }),
        cwd: rawOptions.cwd,
        timeoutMs: rawOptions.timeoutMs,
        maxOutputBytes: rawOptions.maxOutputBytes,
        optional: rawOptions.optional,
        complete: rawOptions.complete,
        replace: rawOptions.replace,
        probeIds: rawOptions.probe,
        requirementRefs: rawOptions.requirement,
        echo: rawOptions.echo,
      });
      stderr.write(
        `jevrev: recorded ${recorded.observation_id} for ${recorded.candidate_id}: exit ${recorded.exit_code}, ${recorded.duration_ms}ms, ${recorded.termination}\n`,
      );
      commandExitCode = recorded.exit_code;
    });

  evidence
    .command("metric")
    .description("Record raw metric samples and link them to frozen evidence slots")
    .requiredOption("--evidence <path>", "evidence bundle to update")
    .requiredOption("--candidate <id>", "candidate packet to update")
    .requiredOption("--input <path>", "metric JSON path, or - for stdin")
    .option("--result <status>", "pass, fail, or unknown for linked slots", parseEvidenceResult)
    .option("--replace", "replace a metric with the same ID", false)
    .option("--probe <id>", "link metric to a required probe ID; repeatable", collectValue, [])
    .option(
      "--requirement <kind:id>",
      "link metric to success:<id> or constraint:<id>; repeatable",
      collectValue,
      [],
    )
    .action(async (rawOptions: EvidenceMetricOptions) => {
      const raw = await readJson(rawOptions.input);
      const candidateMetric = raw !== null && typeof raw === "object" && !Array.isArray(raw)
        ? { ...raw, kind: "metric" }
        : raw;
      const parsed = metricObservationSchema.safeParse(candidateMetric);
      if (!parsed.success) throw new InputError(`Invalid metric input: ${parsed.error.message}`);
      const summary = await recordMetric({
        evidencePath: rawOptions.evidence,
        candidateId: rawOptions.candidate,
        metric: parsed.data,
        ...(rawOptions.result === undefined ? {} : { resultStatus: rawOptions.result }),
        replace: rawOptions.replace,
        probeIds: rawOptions.probe,
        requirementRefs: rawOptions.requirement,
      });
      stderr.write(
        `jevrev: recorded metric ${summary.metric_id} for ${rawOptions.candidate}: ${summary.baseline_mean} -> ${summary.candidate_mean} ${summary.unit}\n`,
      );
    });

  evidence
    .command("artifact")
    .description("Record a content-addressed artifact and optional imported evaluation")
    .requiredOption("--evidence <path>", "evidence bundle to update")
    .requiredOption("--candidate <id>", "candidate packet to update")
    .requiredOption("--id <id>", "stable artifact ID")
    .requiredOption("--file <path>", "artifact path inside the workspace")
    .option("--workspace <path>", "workspace boundary (default: current directory)")
    .option("--media-type <type>", "artifact media type (otherwise inferred)")
    .option("--no-excerpt", "do not include a bounded text excerpt")
    .option("--replace", "replace the artifact/evaluation with the same ID", false)
    .option("--evaluation-id <id>", "stable imported evaluation ID")
    .option("--evaluator <name>", "evaluator or tool name")
    .option("--result <status>", "pass, fail, or unknown", parseEvidenceResult)
    .option("--summary <text>", "bounded evaluation summary")
    .option("--criterion <id>", "criterion measured by the evaluation")
    .option("--score <number>", "optional score from 0 to 1", parseUnitScore)
    .option("--probe <id>", "link evaluation to a required probe ID; repeatable", collectValue, [])
    .option(
      "--requirement <kind:id>",
      "link evaluation to success:<id> or constraint:<id>; repeatable",
      collectValue,
      [],
    )
    .action(async (rawOptions: EvidenceArtifactOptions) => {
      const evaluationRequested = rawOptions.evaluationId !== undefined ||
        rawOptions.evaluator !== undefined || rawOptions.result !== undefined ||
        rawOptions.summary !== undefined || rawOptions.criterion !== undefined ||
        rawOptions.score !== undefined || rawOptions.probe.length > 0 ||
        rawOptions.requirement.length > 0;
      if (evaluationRequested && (
        rawOptions.evaluationId === undefined || rawOptions.evaluator === undefined ||
        rawOptions.result === undefined || rawOptions.summary === undefined
      )) {
        throw new InputError(
          "Artifact links require --evaluation-id, --evaluator, --result, and --summary",
        );
      }
      const artifact = await recordArtifact({
        evidencePath: rawOptions.evidence,
        candidateId: rawOptions.candidate,
        artifactId: rawOptions.id,
        file: rawOptions.file,
        ...(rawOptions.workspace === undefined ? {} : { workspace: rawOptions.workspace }),
        ...(rawOptions.mediaType === undefined ? {} : { mediaType: rawOptions.mediaType }),
        excerpt: rawOptions.excerpt,
        replace: rawOptions.replace,
        ...(evaluationRequested
          ? {
              evaluation: {
                id: rawOptions.evaluationId!,
                evaluator: rawOptions.evaluator!,
                status: rawOptions.result!,
                summary: rawOptions.summary!,
                ...(rawOptions.criterion === undefined ? {} : { criterionId: rawOptions.criterion }),
                ...(rawOptions.score === undefined ? {} : { score: rawOptions.score }),
              },
            }
          : {}),
        probeIds: rawOptions.probe,
        requirementRefs: rawOptions.requirement,
      });
      stderr.write(
        `jevrev: recorded artifact ${artifact.id} for ${rawOptions.candidate}: ${artifact.path} (${artifact.size_bytes} bytes)\n`,
      );
    });

  evidence
    .command("status")
    .description("Show ready, missing, and failed evidence for every finalist")
    .requiredOption("--campaign <path>", "campaign JSON")
    .requiredOption("--evidence <path>", "evidence bundle JSON")
    .option("--format <format>", "human or json", "human")
    .option("--next", "show the first missing evidence item for resuming", false)
    .option("-o, --output <path>", "write status to a file")
    .action(async (rawOptions: EvidenceStatusOptions) => {
      validateFormat(rawOptions.format);
      const result = await evidenceStatus(rawOptions.campaign, rawOptions.evidence);
      const next = rawOptions.next ? evidenceNext(result) : undefined;
      await emit(
        rawOptions.format === "json"
          ? `${JSON.stringify(next ?? result, null, 2)}\n`
          : rawOptions.next ? renderEvidenceNext(next!) : `${renderEvidenceStatus(result)}\n`,
        rawOptions.output,
      );
    });

  program
    .command("doctor")
    .description("Show provider endpoints and optionally probe local services")
    .option("--format <format>", "human or json", "human")
    .option(
      "--provider <provider>",
      "jev, semif, or local",
      envValue("JEVREV_PROVIDER", "SPECJEV_PROVIDER") ?? "jev",
    )
    .option(
      "--jev-url <url>",
      "Jev API root",
      envValue("JEVREV_JEV_URL", "TYPESAFE_BASE_URL") ?? DEFAULT_JEV_URL,
    )
    .option(
      "--semif-url <url>",
      "local SemIf base URL",
      envValue("JEVREV_SEMIF_URL", "SPECJEV_SEMIF_URL") ?? DEFAULT_SEMIF_URL,
    )
    .option(
      "--local-url <url>",
      "legacy local reranker base URL",
      envValue("JEVREV_LOCAL_URL", "SPECJEV_LOCAL_URL") ?? DEFAULT_LOCAL_URL,
    )
    .option("--check", "probe the local health endpoints")
    .action(async (rawOptions: DoctorOptions) => {
      validateFormat(rawOptions.format);
      await runDoctor(rawOptions);
    });

  return program;
}

export async function main(argv = process.argv): Promise<number> {
  commandExitCode = 0;
  try {
    await createProgram().parseAsync(argv);
    return commandExitCode;
  } catch (error) {
    const label = "jevrev";
    if (error instanceof InvalidArgumentError) {
      stderr.write(`${label}: ${error.message}\n`);
      return 2;
    }
    if (error instanceof CommanderError) {
      if (error.code === "commander.helpDisplayed" || error.code === "commander.version") {
        return 0;
      }
      return 2;
    }
    if (error instanceof InputError) {
      stderr.write(`${label}: ${error.message}\n`);
      return 2;
    }
    if (error instanceof ProviderError) {
      stderr.write(`${label}: provider error: ${error.message}\n`);
      return 3;
    }
    if (error instanceof ProtocolError) {
      stderr.write(`${label}: protocol error: ${error.message}\n`);
      return 4;
    }
    const message = error instanceof Error ? error.message : String(error);
    stderr.write(`${label}: unexpected error: ${message}\n`);
    return 1;
  }
}

function invokedAsCli(path: string | undefined): boolean {
  if (path === undefined) return false;
  try {
    return realpathSync(path) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (invokedAsCli(process.argv[1])) {
  process.exitCode = await main();
}
