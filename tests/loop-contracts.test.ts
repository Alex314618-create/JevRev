import { describe, expect, it } from "vitest";
import {
  loopSpecSchema, loopHash, roundWorkOrderSchema, roundEvidenceSchema,
  roundAuditResultSchema, type LoopSpec, type RoundWorkOrder,
  type RoundAuditResult, type RoundEvidence,
} from "../src/loop/schemas.js";
import { transition, type LoopState } from "../src/loop/state-machine.js";

const loopId = "jvl_0123456789abcdef";
const digest = "a".repeat(64);
const spec: LoopSpec = {
  kind: "jevrev.loop-spec", schema_version: "1", revision: 1,
  title: "Fix parser", goal: "Double throughput without API regression", workspace: ".",
  criteria: [
    { id: "tests", type: "hard", description: "Tests pass", required_commands: ["npm-test"] },
    { id: "speed", type: "metric", description: "Throughput", unit: "ops/s", direction: "higher", aggregation: "mean", target: 200, minimum_samples: 3 },
    { id: "quality", type: "judged", description: "Readable implementation", target: 0.8, required_confidence: 0.7, rubric: ["Hard to follow", "Easy to maintain"], required_artifacts: ["diff"] },
  ],
  protected_surfaces: [{ id: "api", description: "Public API unchanged" }],
  budget: { per_round_wall_ms: 60_000, per_round_changed_files: 4, pause_total_wall_ms: 600_000, pause_total_provider_tokens: 10_000 },
  plateau: { window: 3, min_material_delta: 0.02 },
};
const order: RoundWorkOrder = {
  kind: "jevrev.round-work-order", schema_version: "1", loop_id: loopId, round_number: 1,
  spec_revision: 1, spec_sha256: loopHash(spec), base_revision: "base", mode: "progress",
  round_goal: "Measure parser hot path", focus_criteria: ["speed"], hypothesis: "Allocations dominate",
  allowed_scope: ["src/parser.ts"], do_not_change: ["api"],
  required_evidence: [{ id: "benchmark", description: "Raw throughput samples", kind: "metric" }],
  budget: { max_wall_ms: 60_000, max_changed_files: 4 }, stop_conditions: ["Tests fail"],
};
const audit: RoundAuditResult = {
  kind: "jevrev.round-audit-result", schema_version: "1", loop_id: loopId,
  round_number: 1, audit_mode: "progress", outcome: "continue",
  criteria: [{ id: "speed", status: "fail", score: 0.5, confidence: null, source: "metric", freshness: "fresh" }],
  blocking_criteria: ["speed"], next_action: { type: "continue", focus_criteria: ["speed"], reason: "Speed below target" },
  material_progress: true, evidence_sha256: digest, spec_sha256: loopHash(spec),
  provider_profile: "deterministic", usage: { input_tokens: 0, output_tokens: 0 },
};
const state: LoopState = {
  loop_id: loopId, spec_revision: 1, spec_sha256: loopHash(spec), status: "ready",
  last_round: 0, active_order: null, last_audit: null, cumulative_wall_ms: 0,
  cumulative_provider_tokens: 0, plateau_replans: 0, consecutive_stalled: 0,
  head_revision: "base",
};
const evidence: RoundEvidence = {
  kind: "jevrev.round-evidence", schema_version: "1", loop_id: loopId,
  round_number: 1, spec_sha256: loopHash(spec), work_order_sha256: loopHash(order),
  base_revision: "base", head_revision: "head", wall_ms: 100, provider_tokens: 0,
  changed_files: [], observations: [], metrics: [], artifact_evaluations: [],
  criterion_results: [], protected_surface_results: [], known_failures: [],
};
audit.evidence_sha256 = loopHash(evidence);
function issue(current: LoopState = state, workOrder: RoundWorkOrder = order): LoopState {
  return transition(current, { type: "issue", order: workOrder, spec });
}
function submit(current: LoopState, result: RoundAuditResult = audit, roundEvidence: RoundEvidence = evidence): LoopState {
  return transition(current, { type: "audit", result, evidence: roundEvidence, spec });
}

describe("JevLoop contracts", () => {
  it("rejects specs whose completion evidence cannot fit the protocol", () => {
    const manyCommands = Array.from({ length: 24 }, (_, index) => `cmd-${index}`);
    const oversized = {
      ...spec,
      criteria: Array.from({ length: 6 }, (_, index) => ({
        id: `hard-${index}`, type: "hard" as const, description: "Hard", required_commands: manyCommands,
      })),
    };
    expect(() => loopSpecSchema.parse(oversized)).toThrow("at most 128 command evidence slots");
  });
  it("rejects duplicate command and artifact requirements at spec creation", () => {
    expect(() => loopSpecSchema.parse({
      ...spec,
      criteria: [{ id: "tests", type: "hard", description: "Tests", required_commands: ["test", "test"] }],
    })).toThrow("required commands must be unique");
    expect(() => loopSpecSchema.parse({
      ...spec,
      criteria: [{
        id: "visual", type: "judged", description: "Visual", target: 0.8,
        required_confidence: 0.7, rubric: ["Bad", "Good"], required_artifacts: ["desktop", "desktop"],
      }],
    })).toThrow("required artifacts must be unique");
  });
  it("accepts a frozen spec with three criterion types", () => {
    expect(loopSpecSchema.parse(spec)).toEqual(spec);
    expect(loopHash(spec)).toMatch(/^[a-f0-9]{64}$/);
  });
  it("accepts an explicit relative metric baseline", () => {
    const relative = structuredClone(spec);
    const metric = relative.criteria.find((criterion) => criterion.id === "speed");
    if (metric?.type !== "metric") throw new Error("metric fixture missing");
    metric.baseline = 100;
    metric.target = 2;
    expect(loopSpecSchema.parse(relative).criteria.find((criterion) => criterion.id === "speed")).toMatchObject({ baseline: 100, target: 2 });
  });

  it.each([
    ["duplicate criterion", (value: LoopSpec) => { value.criteria[1]!.id = "tests"; }],
    ["overlapping protected surface", (value: LoopSpec) => { value.protected_surfaces[0]!.id = "tests"; }],
    ["invalid workspace", (value: LoopSpec) => { value.workspace = "../outside"; }],
    ["insufficient total budget", (value: LoopSpec) => { value.budget.pause_total_wall_ms = 1; }],
    ["empty subjective rubric", (value: LoopSpec) => { const judged = value.criteria[2]; if (judged?.type === "judged") judged.rubric = []; }],
  ])("rejects %s", (_name, mutate) => {
    const bad = structuredClone(spec); mutate(bad);
    expect(loopSpecSchema.safeParse(bad).success).toBe(false);
  });

  it("requires a bounded work order with unique references", () => {
    expect(roundWorkOrderSchema.parse(order)).toEqual(order);
    const bad = structuredClone(order);
    bad.required_evidence.push({ ...bad.required_evidence[0]! });
    expect(roundWorkOrderSchema.safeParse(bad).success).toBe(false);
  });

  it("rejects duplicate IDs in round evidence", () => {
    const evidence = {
      kind: "jevrev.round-evidence", schema_version: "1", loop_id: loopId,
      round_number: 1, spec_sha256: loopHash(spec), work_order_sha256: loopHash(order),
      base_revision: "base", head_revision: "head", wall_ms: 100, provider_tokens: 0,
      changed_files: [], observations: [{ id: "test", exit_code: 0, duration_ms: 100, head_revision: "head" },
        { id: "test", exit_code: 0, duration_ms: 100, head_revision: "head" }],
      metrics: [], artifact_evaluations: [], criterion_results: [], protected_surface_results: [], known_failures: [],
    };
    expect(roundEvidenceSchema.safeParse(evidence).success).toBe(false);
  });

  it("refuses completion by a progress audit or with a blocking criterion", () => {
    const bad = structuredClone(audit);
    bad.outcome = "completed";
    bad.next_action.type = "stop_success";
    expect(roundAuditResultSchema.safeParse(bad).success).toBe(false);
    bad.audit_mode = "completion";
    expect(roundAuditResultSchema.safeParse(bad).success).toBe(false);
  });
});

describe("JevLoop pure state machine", () => {
  function completionFixture() {
    const pending = submit(issue(), {
      ...audit, outcome: "verify", next_action: { type: "verify", focus_criteria: ["tests", "speed", "quality"], reason: "Ready for full verification" },
    });
    const completionOrder: RoundWorkOrder = {
      ...order, mode: "completion", round_number: 2, base_revision: "head",
      focus_criteria: ["tests", "speed", "quality"],
    };
    const issued = issue(pending, completionOrder);
    const head = "verified-head";
    const cite = (id: string, references: { observations?: string[]; metrics?: string[]; artifacts?: string[] }) => ({
      id, status: "pass" as const, freshness: "fresh" as const, source_round: 2,
      head_revision: head, observation_ids: references.observations ?? [],
      metric_ids: references.metrics ?? [], artifact_evaluation_ids: references.artifacts ?? [],
    });
    const proof: RoundEvidence = {
      ...evidence, round_number: 2, work_order_sha256: loopHash(completionOrder),
      base_revision: "head", head_revision: head,
      observations: [
        { id: "npm-test", exit_code: 0, duration_ms: 10, head_revision: head, termination: "exited", source: "recorded" },
        { id: "api-check", exit_code: 0, duration_ms: 10, head_revision: head, termination: "exited", source: "recorded" },
      ],
      metrics: [{ id: "throughput", criterion_id: "speed", unit: "ops/s", samples: [200, 210, 220], head_revision: head }],
      artifact_evaluations: [{ id: "diff-eval", artifact_id: "diff", sha256: digest, status: "pass", head_revision: head, source: "imported", summary: "The diff preserves the public API and has a clear fast path." }],
      criterion_results: [
        cite("tests", { observations: ["npm-test"] }),
        cite("speed", { metrics: ["throughput"] }),
        cite("quality", { artifacts: ["diff-eval"] }),
      ],
      protected_surface_results: [cite("api", { observations: ["api-check"] })],
    };
    const result: RoundAuditResult = {
      ...audit, round_number: 2, audit_mode: "completion", outcome: "completed",
      criteria: [
        { id: "tests", status: "pass", score: null, confidence: null, source: "command", freshness: "fresh" },
        { id: "speed", status: "pass", score: 1, confidence: null, source: "metric", freshness: "fresh" },
        { id: "quality", status: "pass", score: 0.9, confidence: 0.8, source: "jev", freshness: "fresh" },
        { id: "api", status: "pass", score: null, confidence: null, source: "command", freshness: "fresh" },
      ],
      blocking_criteria: [], next_action: { type: "stop_success", focus_criteria: [], reason: "All criteria verified" },
      evidence_sha256: loopHash(proof),
    };
    return { issued, proof, result };
  }

  it("rejects an empty forged completion audit", () => {
    const { issued, proof, result } = completionFixture();
    expect(() => submit(issued, { ...result, criteria: [] }, proof)).toThrow();
  });
  it("completes only with fresh, bound, fully passing evidence on the current head", () => {
    const { issued, proof, result } = completionFixture();
    expect(submit(issued, result, proof).status).toBe("completed");
    expect(() => transition(submit(issued, result, proof), { type: "resume" })).toThrow();
  });
  it("rejects a changed evidence digest or a stale head", () => {
    const { issued, proof, result } = completionFixture();
    expect(() => submit(issued, { ...result, evidence_sha256: digest }, proof)).toThrow();
    const stale = structuredClone(proof);
    stale.criterion_results[0]!.head_revision = "old-head";
    expect(() => submit(issued, { ...result, evidence_sha256: loopHash(stale) }, stale)).toThrow();
  });
  it("rejects passed but below-target metrics and failed hard commands", () => {
    const { issued, proof, result } = completionFixture();
    const slow = structuredClone(proof);
    slow.metrics[0]!.samples = [100, 120, 110];
    expect(() => submit(issued, { ...result, evidence_sha256: loopHash(slow) }, slow)).toThrow("metric target");
    const failed = structuredClone(proof);
    failed.observations[0]!.exit_code = 1;
    expect(() => submit(issued, { ...result, evidence_sha256: loopHash(failed) }, failed)).toThrow("command failed");
    const imported = structuredClone(proof);
    imported.observations[0]!.source = "imported";
    expect(() => submit(issued, { ...result, evidence_sha256: loopHash(imported) }, imported)).toThrow("command failed");
  });
  it("rejects unknown focus and oversized work-order budgets", () => {
    expect(() => issue(state, { ...order, focus_criteria: ["not-in-spec"] })).toThrow();
    expect(() => issue(state, { ...order, do_not_change: ["unknown"] })).toThrow();
    expect(() => issue(state, { ...order, budget: { ...order.budget, max_wall_ms: 61_000 } })).toThrow();
  });
  it("rejects changed files outside the round scope and all changes in completion scope", () => {
    const issued = issue();
    const outside = { ...evidence, changed_files: ["docs/README.md"] };
    expect(() => submit(issued, { ...audit, evidence_sha256: loopHash(outside) }, outside)).toThrow("work order or round budget");
    const pending = submit(issued, { ...audit, outcome: "verify", next_action: { type: "verify", focus_criteria: ["tests"], reason: "Ready for verification" } });
    const completionOrder: RoundWorkOrder = { ...order, mode: "completion", round_number: 2, base_revision: "head", allowed_scope: [], required_evidence: [{ id: "npm-test", description: "Tests", kind: "command" }] };
    const completionState = issue(pending, completionOrder);
    const completionEvidence = { ...evidence, round_number: 2, base_revision: "head", changed_files: ["src/parser.ts"], work_order_sha256: loopHash(completionOrder) };
    expect(() => submit(completionState, { ...audit, round_number: 2, audit_mode: "completion", evidence_sha256: loopHash(completionEvidence) }, completionEvidence)).toThrow("work order or round budget");
  });
  it("keeps protected-surface claims in their own evidence bucket", () => {
    const { issued, proof, result } = completionFixture();
    const forged = structuredClone(proof);
    forged.protected_surface_results = [];
    forged.criterion_results.push({ id: "api", status: "pass", freshness: "fresh", source_round: 2, head_revision: "verified-head", observation_ids: ["api-check"], metric_ids: [], artifact_evaluation_ids: [] });
    expect(() => submit(issued, { ...result, evidence_sha256: loopHash(forged) }, forged)).toThrow();
  });
  it("does not let an observation duration hide outside the wall budget", () => {
    const issued = issue();
    const slow = structuredClone(evidence);
    slow.wall_ms = 0;
    slow.observations = [{ id: "npm-test", exit_code: 0, duration_ms: 999_999, head_revision: "head", termination: "exited", source: "recorded" }];
    slow.criterion_results = [{ id: "tests", status: "pass", freshness: "fresh", source_round: 1, head_revision: "head", observation_ids: ["npm-test"], metric_ids: [], artifact_evaluation_ids: [] }];
    expect(() => submit(issued, { ...audit, evidence_sha256: loopHash(slow) }, slow)).toThrow("round budget");
  });
  it("rejects evidence whose command durations exceed the declared wall time in total", () => {
    const issued = issue();
    const over = structuredClone(evidence);
    over.wall_ms = 15;
    over.observations = [
      { id: "npm-test", exit_code: 0, duration_ms: 10, head_revision: "head", termination: "exited", source: "recorded" },
      { id: "api-check", exit_code: 0, duration_ms: 10, head_revision: "head", termination: "exited", source: "recorded" },
    ];
    over.criterion_results = [{ id: "tests", status: "pass", freshness: "fresh", source_round: 1, head_revision: "head", observation_ids: ["npm-test"], metric_ids: [], artifact_evaluation_ids: [] }];
    expect(() => submit(issued, { ...audit, evidence_sha256: loopHash(over) }, over)).toThrow("round budget");
  });
  it("requires budget pause and rejects contradictory audit actions", () => {
    const over: RoundEvidence = { ...evidence, wall_ms: spec.budget.pause_total_wall_ms };
    expect(() => submit(issue(), { ...audit, evidence_sha256: loopHash(over) }, over)).toThrow("round budget");
    const near = { ...state, cumulative_wall_ms: spec.budget.pause_total_wall_ms - 50 };
    expect(() => submit(issue(near), audit)).toThrow("Budget reached");
    expect(roundAuditResultSchema.safeParse({ ...audit, outcome: "waiting_human" }).success).toBe(false);
  });
  it("counts builder provider tokens in the persisted budget", () => {
    const expensive = { ...evidence, provider_tokens: spec.budget.pause_total_provider_tokens };
    expect(() => submit(issue(), { ...audit, evidence_sha256: loopHash(expensive) }, expensive)).toThrow("Budget reached");
  });
  it("does not let an under-sampled metric record improve a completion aggregate", () => {
    const { issued, proof, result } = completionFixture();
    const mixed = structuredClone(proof);
    mixed.metrics = [
      { id: "throughput", criterion_id: "speed", unit: "ops/s", samples: [180, 190, 190], head_revision: "verified-head" },
      { id: "under-sampled", criterion_id: "speed", unit: "ops/s", samples: [1000, 1000], head_revision: "verified-head" },
    ];
    mixed.criterion_results[1]!.metric_ids = ["throughput", "under-sampled"];
    expect(() => submit(issued, { ...result, evidence_sha256: loopHash(mixed) }, mixed)).toThrow("metric target");
  });
  it("issues one round and accepts its matching audit", () => {
    const issued = issue();
    expect(issued.status).toBe("issued");
    const next = submit(issued);
    expect(next).toMatchObject({ status: "ready", last_round: 1, cumulative_wall_ms: 100, head_revision: "head" });
  });
  it("refuses an issue in an active round and an audit without one", () => {
    expect(() => issue(issue())).toThrow();
    expect(() => submit(state)).toThrow();
  });
  it("rejects altered spec, base revision, or round index", () => {
    for (const alteration of [{ spec_sha256: digest }, { base_revision: "other" }, { round_number: 3 }]) {
      expect(() => issue(state, { ...order, ...alteration })).toThrow();
    }
  });
  it("tracks a completion request separately from completion", () => {
    const requested = { ...audit, outcome: "verify" as const, next_action: { ...audit.next_action, type: "verify" as const } };
    const pending = submit(issue(), requested);
    expect(pending.status).toBe("completion_pending");
    expect(() => issue(pending, { ...order, round_number: 2, base_revision: "head" })).toThrow("completion work order");
    const completionOrder: RoundWorkOrder = { ...order, round_number: 2, base_revision: "head", mode: "completion" };
    expect(issue(pending, completionOrder).status).toBe("issued");
  });
  it("pauses and resumes without claiming success", () => {
    for (const outcome of ["waiting_human", "budget_paused"] as const) {
      const nextActionType = outcome === "waiting_human" ? "ask_human" : "wait_budget";
      const paused = submit(issue(), {
        ...audit, outcome, next_action: { ...audit.next_action, type: nextActionType },
      });
      expect(paused.status).toBe(outcome);
      expect(transition(paused, { type: "resume" }).status).toBe("ready");
    }
    expect(() => transition(state, { type: "resume" })).toThrow();
  });
  it("allows a new approved spec revision only while no round is active", () => {
    const approved = transition(state, { type: "approve_spec", revision: 2, spec_sha256: digest });
    expect(approved).toMatchObject({ spec_revision: 2, spec_sha256: digest });
    expect(() => transition(issue(), { type: "approve_spec", revision: 2, spec_sha256: digest })).toThrow();
    expect(() => transition(state, { type: "approve_spec", revision: 1, spec_sha256: digest })).toThrow();
  });
  it("cannot abort a completed or already aborted loop", () => {
    const aborted = transition(state, { type: "abort" });
    expect(aborted.status).toBe("aborted");
    expect(() => transition(aborted, { type: "abort" })).toThrow();
  });
});
