import { ProtocolError } from "../domain/errors.js";
import { loopHash, loopSpecSchema, roundAuditResultSchema, roundEvidenceSchema, roundWorkOrderSchema, type LoopSpec, type RoundAuditResult, type RoundEvidence, type RoundWorkOrder } from "./schemas.js";

export type LoopStatus = "ready" | "issued" | "completion_pending" | "waiting_human" | "budget_paused" | "completed" | "aborted";

export interface LoopState {
  loop_id: string;
  spec_revision: number;
  spec_sha256: string;
  status: LoopStatus;
  last_round: number;
  active_order: RoundWorkOrder | null;
  last_audit: RoundAuditResult | null;
  cumulative_wall_ms: number;
  cumulative_provider_tokens: number;
  plateau_replans: number;
  consecutive_stalled: number;
  head_revision: string;
}

export type LoopTransition =
  | { type: "issue"; order: RoundWorkOrder; spec: LoopSpec }
  | { type: "audit"; result: RoundAuditResult; evidence: RoundEvidence; spec: LoopSpec }
  | { type: "resume" }
  | { type: "abort" }
  | { type: "approve_spec"; revision: number; spec_sha256: string };

function normalizeWorkspacePath(value: string): string {
  const normalized = value.replace(/\\/g, "/").replace(/^(?:\.\/)+/, "").replace(/\/+$/, "");
  return normalized.length === 0 ? "." : normalized;
}

function isWithinAllowedScope(file: string, scopes: readonly string[]): boolean {
  if (scopes.length === 0) return false;
  const normalizedFile = normalizeWorkspacePath(file);
  return scopes.some((scope) => {
    const normalizedScope = normalizeWorkspacePath(scope);
    return normalizedScope === "." || normalizedFile === normalizedScope || normalizedFile.startsWith(`${normalizedScope}/`);
  });
}

export function transition(state: LoopState, action: LoopTransition): LoopState {
  switch (action.type) {
    case "issue": {
      roundWorkOrderSchema.parse(action.order);
      loopSpecSchema.parse(action.spec);
      if (loopHash(action.spec) !== state.spec_sha256 || action.spec.revision !== state.spec_revision) {
        throw new ProtocolError("Work order must use current frozen spec");
      }
      if (state.status !== "ready" && state.status !== "completion_pending") throw new ProtocolError(`Cannot issue from ${state.status}`);
      if (action.order.loop_id !== state.loop_id || action.order.spec_sha256 !== state.spec_sha256 ||
          action.order.spec_revision !== state.spec_revision || action.order.round_number !== state.last_round + 1 ||
          action.order.base_revision !== state.head_revision) throw new ProtocolError("Work order does not match current loop state");
      if ((state.status === "completion_pending") !== (action.order.mode === "completion")) {
        throw new ProtocolError("Completion pending requires a completion work order");
      }
      const focusTargets = new Set([
        ...action.spec.criteria.map((criterion) => criterion.id),
        ...action.spec.protected_surfaces.map((surface) => surface.id),
      ]);
      const protectedSurfaces = new Set(action.spec.protected_surfaces.map((surface) => surface.id));
      if (action.order.focus_criteria.some((id) => !focusTargets.has(id)) ||
          action.order.do_not_change.some((id) => !protectedSurfaces.has(id)) ||
          action.order.budget.max_wall_ms > action.spec.budget.per_round_wall_ms ||
          action.order.budget.max_changed_files > action.spec.budget.per_round_changed_files) {
        throw new ProtocolError("Work-order references or budget exceed frozen spec");
      }
      return { ...state, status: "issued", last_round: action.order.round_number, active_order: action.order };
    }
    case "audit": {
      roundAuditResultSchema.parse(action.result);
      roundEvidenceSchema.parse(action.evidence);
      loopSpecSchema.parse(action.spec);
      if (state.status !== "issued" || state.active_order === null) throw new ProtocolError(`Cannot audit from ${state.status}`);
      if (action.result.loop_id !== state.loop_id || action.result.round_number !== state.last_round ||
          action.result.spec_sha256 !== state.spec_sha256) throw new ProtocolError("Audit does not match active round");
      if ((state.active_order.mode === "completion") !== (action.result.audit_mode === "completion")) {
        throw new ProtocolError("Audit mode must match active work order");
      }
      const evidence = action.evidence;
      const targets = new Set([
        ...action.spec.criteria.map((criterion) => criterion.id),
        ...action.spec.protected_surfaces.map((surface) => surface.id),
      ]);
      if ([...action.result.criteria.map((criterion) => criterion.id), ...action.result.blocking_criteria, ...action.result.next_action.focus_criteria].some((id) => !targets.has(id)) ||
          evidence.criterion_results.some((claim) => !action.spec.criteria.some((criterion) => criterion.id === claim.id)) ||
          evidence.protected_surface_results.some((claim) => !action.spec.protected_surfaces.some((surface) => surface.id === claim.id))) {
        throw new ProtocolError("Audit references an unknown criterion or protected surface");
      }
      if (loopHash(action.spec) !== state.spec_sha256 || action.spec.revision !== state.spec_revision ||
          evidence.loop_id !== state.loop_id || evidence.round_number !== state.last_round ||
          evidence.spec_sha256 !== state.spec_sha256 || evidence.work_order_sha256 !== loopHash(state.active_order) ||
          evidence.base_revision !== state.active_order.base_revision ||
          action.result.evidence_sha256 !== loopHash(evidence) ||
          evidence.wall_ms > state.active_order.budget.max_wall_ms ||
          evidence.changed_files.length > state.active_order.budget.max_changed_files ||
          evidence.observations.reduce((total, observation) => total + observation.duration_ms, 0) > evidence.wall_ms ||
          evidence.changed_files.some((file) => !isWithinAllowedScope(file, state.active_order!.allowed_scope))) {
        throw new ProtocolError("Audit evidence, spec, work order or round budget does not match current state");
      }
      for (const claimed of [...evidence.criterion_results, ...evidence.protected_surface_results]) {
        if (claimed.freshness === "fresh" && (claimed.source_round !== evidence.round_number || claimed.head_revision !== evidence.head_revision)) {
          throw new ProtocolError(`Fresh evidence is not from the audited head: ${claimed.id}`);
        }
        if (claimed.status === "pass" && claimed.observation_ids.length + claimed.metric_ids.length + claimed.artifact_evaluation_ids.length === 0) {
          throw new ProtocolError(`Passing evidence lacks observations: ${claimed.id}`);
        }
      }
      const roundProviderTokens = evidence.provider_tokens + action.result.usage.input_tokens + action.result.usage.output_tokens;
      if (state.cumulative_wall_ms + evidence.wall_ms >= action.spec.budget.pause_total_wall_ms ||
          state.cumulative_provider_tokens + roundProviderTokens >= action.spec.budget.pause_total_provider_tokens) {
        if (action.result.outcome !== "budget_paused" && action.result.outcome !== "completed") {
          throw new ProtocolError("Budget reached; audit must pause the loop");
        }
      }
      if (action.result.outcome === "completed") assertCompletion(action.spec, evidence, action.result);
      const status = action.result.outcome === "completed" ? "completed" :
        action.result.outcome === "waiting_human" ? "waiting_human" :
        action.result.outcome === "budget_paused" ? "budget_paused" :
        action.result.outcome === "verify" ? "completion_pending" : "ready";
      return {
        ...state,
        status,
        head_revision: evidence.head_revision,
        active_order: null,
        last_audit: action.result,
        cumulative_wall_ms: state.cumulative_wall_ms + evidence.wall_ms,
        cumulative_provider_tokens: state.cumulative_provider_tokens + roundProviderTokens,
        consecutive_stalled: action.result.material_progress ? 0 : state.consecutive_stalled + 1,
        plateau_replans: action.result.outcome === "replan" ? state.plateau_replans + 1 : state.plateau_replans,
      };
    }
    case "resume":
      if (state.status !== "waiting_human" && state.status !== "budget_paused") throw new ProtocolError(`Cannot resume from ${state.status}`);
      return { ...state, status: "ready" };
    case "approve_spec":
      if (state.status !== "ready" && state.status !== "waiting_human" && state.status !== "budget_paused") {
        throw new ProtocolError(`Cannot revise spec from ${state.status}`);
      }
      if (action.revision !== state.spec_revision + 1 || action.spec_sha256 === state.spec_sha256) throw new ProtocolError("Approved spec must be a new revision");
      return { ...state, status: "ready", spec_revision: action.revision, spec_sha256: action.spec_sha256, last_audit: null, consecutive_stalled: 0, plateau_replans: 0 };
    case "abort":
      if (state.status === "completed" || state.status === "aborted") throw new ProtocolError(`Cannot abort from ${state.status}`);
      return { ...state, status: "aborted", active_order: null };
  }
}

function metricAggregate(samples: readonly number[], aggregation: "mean" | "p75"): number {
  if (aggregation === "mean") return samples.reduce((sum, value) => sum + value, 0) / samples.length;
  const ordered = [...samples].sort((left, right) => left - right);
  return ordered[Math.ceil(0.75 * ordered.length) - 1]!;
}

function metricTarget(criterion: Extract<LoopSpec["criteria"][number], { type: "metric" }>): number {
  return criterion.baseline === undefined ? criterion.target : criterion.baseline * criterion.target;
}

function assertCompletion(spec: LoopSpec, evidence: RoundEvidence, audit: RoundAuditResult): void {
  if (audit.audit_mode !== "completion" || audit.blocking_criteria.length > 0 ||
      evidence.known_failures.length > 0) {
    throw new ProtocolError("Completion requires a clean full audit on the current head");
  }
  const expected = new Set([...spec.criteria.map((criterion) => criterion.id), ...spec.protected_surfaces.map((surface) => surface.id)]);
  const audited = new Map(audit.criteria.map((criterion) => [criterion.id, criterion]));
  if (audited.size !== expected.size || [...audited.keys()].some((id) => !expected.has(id))) {
    throw new ProtocolError("Completion must audit every criterion and protected surface");
  }
  const claimed = new Map(evidence.criterion_results.map((result) => [result.id, result]));
  const protectedResults = new Map(evidence.protected_surface_results.map((result) => [result.id, result]));
  const observations = new Map(evidence.observations.map((observation) => [observation.id, observation]));
  const metrics = new Map(evidence.metrics.map((metric) => [metric.id, metric]));
  const artifacts = new Map(evidence.artifact_evaluations.map((artifact) => [artifact.id, artifact]));
  for (const id of expected) {
    const result = spec.protected_surfaces.some((surface) => surface.id === id)
      ? protectedResults.get(id)
      : claimed.get(id);
    const judgement = audited.get(id);
    if (result === undefined || judgement === undefined || result.status !== "pass" || judgement.status !== "pass" ||
        result.freshness !== "fresh" || judgement.freshness !== "fresh" ||
        result.source_round !== evidence.round_number || result.head_revision !== evidence.head_revision ||
        result.observation_ids.length + result.metric_ids.length + result.artifact_evaluation_ids.length === 0) {
      throw new ProtocolError(`Completion lacks fresh passing evidence on current head: ${id}`);
    }
    for (const ref of result.observation_ids) {
      const observation = observations.get(ref);
      if (observation?.head_revision !== evidence.head_revision || observation.exit_code !== 0 ||
          observation.termination !== "exited" || observation.source !== "recorded") {
        throw new ProtocolError(`Completion command failed or is stale: ${id}/${ref}`);
      }
    }
    for (const ref of result.artifact_evaluation_ids) {
      const artifact = artifacts.get(ref);
      if (artifact?.head_revision !== evidence.head_revision || artifact.status !== "pass") {
        throw new ProtocolError(`Completion artifact failed or is stale: ${id}/${ref}`);
      }
    }
    for (const ref of result.metric_ids) {
      if (metrics.get(ref)?.head_revision !== evidence.head_revision) {
        throw new ProtocolError(`Completion metric is missing or stale: ${id}/${ref}`);
      }
    }
  }
  for (const criterion of spec.criteria) {
    const result = claimed.get(criterion.id)!;
    const judgement = audited.get(criterion.id)!;
    if (criterion.type === "hard") {
      if (judgement.source !== "command" || criterion.required_commands.some((ref) =>
        !result.observation_ids.includes(ref) || observations.get(ref)?.exit_code !== 0 ||
        observations.get(ref)?.head_revision !== evidence.head_revision ||
        observations.get(ref)?.source !== "recorded" ||
        observations.get(ref)?.termination !== "exited")) {
        throw new ProtocolError(`Completion has not run every hard command: ${criterion.id}`);
      }
    } else if (criterion.type === "metric") {
      const cited = result.metric_ids.map((ref) => metrics.get(ref));
      const samples = cited.flatMap((metric) => metric?.criterion_id === criterion.id && metric.unit === criterion.unit && metric.head_revision === evidence.head_revision && metric.samples.length >= criterion.minimum_samples ? metric.samples : []);
      if (judgement.source !== "metric" || cited.some((metric) => metric === undefined || metric.criterion_id !== criterion.id || metric.unit !== criterion.unit || metric.head_revision !== evidence.head_revision) || samples.length < criterion.minimum_samples || (() => {
        const value = metricAggregate(samples, criterion.aggregation);
        const target = metricTarget(criterion);
        return criterion.direction === "higher" ? value < target : value > target;
      })()) throw new ProtocolError(`Completion metric target is not met: ${criterion.id}`);
    } else if (judgement.source !== "jev" || judgement.score === null || judgement.score < criterion.target ||
               judgement.confidence === null || judgement.confidence < criterion.required_confidence ||
               criterion.required_artifacts.some((ref) => ![...artifacts.values()].some((artifact) =>
                 artifact.artifact_id === ref && artifact.head_revision === evidence.head_revision && artifact.status === "pass" &&
                 result.artifact_evaluation_ids.includes(artifact.id)))) {
      throw new ProtocolError(`Completion judged criterion is not proven: ${criterion.id}`);
    }
  }
  for (const protectedSurface of spec.protected_surfaces) {
    if (audited.get(protectedSurface.id)?.source !== "command" && audited.get(protectedSurface.id)?.source !== "artifact") {
      throw new ProtocolError(`Protected surface requires command or artifact evidence: ${protectedSurface.id}`);
    }
  }
}
