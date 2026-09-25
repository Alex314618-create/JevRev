import { describe, expect, it } from "vitest";
import {
  activationRequestSchema,
  evaluateActivation,
  renderActivationHuman,
} from "../src/index.js";

function request(overrides: Record<string, unknown> = {}) {
  return activationRequestSchema.parse({
    kind: "jevrev.activation-request",
    schema_version: "1",
    task: { goal: "Improve parser throughput without changing its public behavior" },
    assessment: {
      candidate_count: 5,
      wrong_path_loss: 0.9,
      exploration_cost: 0.25,
      mechanism_diversity: 0.9,
      constraint_interaction: 0.8,
      uncertainty: 0.85,
      probeability: 0.8,
      reversibility: 0.2,
      existing_evidence: 0.1,
      ...overrides,
    },
  });
}

describe("activation policy", () => {
  it("opens Sift when wrong-path loss is high and bounded probes are worthwhile", () => {
    const result = evaluateActivation(request());
    expect(result.decision).toBe("sift");
    expect(result.shadow).toBe(true);
    expect(result.policy.mode).toBe("shadow");
    expect(result.reasons.map((item) => item.code)).toContain("LOSS_OUTWEIGHS_EXPLORATION_COST");
    expect(result.reasons.map((item) => item.code)).toContain("INTERACTING_CONSTRAINTS");
    expect(result.run_id).toMatch(/^jva_[a-f0-9]{12}$/);
  });

  it("bypasses an obvious, reversible task even when an agent reports candidates", () => {
    const result = evaluateActivation(request({
      candidate_count: 4,
      wrong_path_loss: 0.2,
      exploration_cost: 0.1,
      mechanism_diversity: 0.1,
      constraint_interaction: 0.1,
      uncertainty: 0.1,
      probeability: 0.2,
      reversibility: 0.95,
      existing_evidence: 0.9,
    }));
    expect(result.decision).toBe("bypass");
    expect(result.reasons.map((item) => item.code)).toEqual(expect.arrayContaining([
      "LOW_WRONG_PATH_LOSS",
      "HIGH_REVERSIBILITY",
      "STRONG_EXISTING_EVIDENCE",
    ]));
    expect(result.reasons.map((item) => item.code)).toContain("EXPLORATION_COST_TOO_HIGH");
  });

  it("bypasses when there are not enough alternatives", () => {
    const result = evaluateActivation(request({ candidate_count: 1, wrong_path_loss: 1, exploration_cost: 0 }));
    expect(result.decision).toBe("bypass");
    expect(result.reasons.map((item) => item.code)).toContain("INSUFFICIENT_ALTERNATIVES");
  });

  it("is deterministic for shadow evaluation and renders an explicit warning", () => {
    const first = evaluateActivation(request());
    const second = evaluateActivation(request());
    expect(second).toEqual(first);
    expect(renderActivationHuman(first)).toContain("shadow-only");
    expect(renderActivationHuman(first)).toContain("no workflow change");
  });

  it("rejects unbounded or unknown assessment fields", () => {
    expect(() => activationRequestSchema.parse({
      ...request(),
      assessment: { ...request().assessment, uncertainty: 1.1 },
    })).toThrow();
    expect(() => activationRequestSchema.parse({
      ...request(),
      unexpected: true,
    })).toThrow();
  });
});
