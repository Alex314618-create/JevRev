import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_MAX_ARTIFACT_BYTES, recordArtifact } from "../src/evidence/artifact.js";
import { recordMetric } from "../src/evidence/metric.js";
import { evidenceNext, evidenceStatus, renderEvidenceStatus } from "../src/evidence/status.js";
import { buildCampaign } from "../src/workflow/campaign.js";
import { evidenceBundleSchema, type EvidenceBundle } from "../src/workflow/schemas.js";
import { buildQuestionPlan } from "../src/questions.js";
import { rankCandidates } from "../src/policy.js";
import { makeResponse, minimalRequest } from "./fixtures.js";

const root = resolve(import.meta.dirname, "..");
const temporaryFiles: string[] = [];

afterEach(() => {
  for (const path of temporaryFiles.splice(0)) rmSync(path, { force: true });
});

function fixture() {
  const request = structuredClone(minimalRequest);
  const plan = buildQuestionPlan(request);
  const campaign = buildCampaign(request, rankCandidates(request, makeResponse(plan)));
  const workOrder = campaign.work_orders[0]!;
  const bundle: EvidenceBundle = {
    kind: "jevrev.evidence-bundle",
    schema_version: "1",
    campaign_id: campaign.campaign_id,
    packets: [{
      kind: "jevrev.evidence-packet",
      schema_version: "1",
      campaign_id: campaign.campaign_id,
      candidate_id: workOrder.candidate_id,
      candidate_sha256: workOrder.candidate_sha256,
      revision: { base_commit: "base" },
      development: { status: "not_started", wall_ms: 0 },
      observations: [],
      metrics: [],
      requirement_results: [
        { criterion_id: "speed", kind: "success", status: "unknown", observation_ids: [], metric_ids: [] },
        { criterion_id: "api", kind: "constraint", status: "unknown", observation_ids: [], metric_ids: [] },
      ],
      probe_results: workOrder.required_evidence.map((evidence) => ({
        evidence_id: evidence.id,
        status: "unknown",
        observation_ids: [],
        metric_ids: [],
      })),
      artifacts: [],
      artifact_evaluations: [],
      changed_files: [],
      known_failures: ["TEMPLATE: fill evidence"],
    }],
  };
  const suffix = Math.random().toString(16).slice(2);
  const campaignPath = resolve(root, "tests", `tmp-tools-campaign-${suffix}.json`);
  const evidencePath = resolve(root, "tests", `tmp-tools-evidence-${suffix}.json`);
  temporaryFiles.push(campaignPath, evidencePath);
  writeFileSync(campaignPath, `${JSON.stringify(campaign, null, 2)}\n`, "utf8");
  writeFileSync(evidencePath, `${JSON.stringify(bundle, null, 2)}\n`, "utf8");
  return { campaign, workOrder, campaignPath, evidencePath };
}

describe("evidence metric, artifact, and status tools", () => {
  it("records raw metric samples and links an explicit result", async () => {
    const { workOrder, evidencePath } = fixture();
    const summary = await recordMetric({
      evidencePath,
      candidateId: workOrder.candidate_id,
      metric: {
        id: "throughput",
        kind: "metric",
        criterion_id: "speed",
        unit: "ops/s",
        direction: "higher",
        baseline_samples: [99, 100, 101],
        candidate_samples: [199, 200, 201],
      },
      resultStatus: "pass",
      probeIds: ["probe-1"],
      requirementRefs: ["success:speed"],
    });
    const bundle = evidenceBundleSchema.parse(JSON.parse(readFileSync(evidencePath, "utf8")));

    expect(summary.relative_improvement).toBe(1);
    expect(bundle.packets[0]?.metrics[0]?.baseline_samples).toEqual([99, 100, 101]);
    expect(bundle.packets[0]?.requirement_results[0]).toMatchObject({
      status: "pass",
      metric_ids: ["throughput"],
    });
    expect(bundle.packets[0]?.probe_results[0]).toMatchObject({
      status: "pass",
      metric_ids: ["throughput"],
    });
  });

  it("rejects a metric linked to a different criterion", async () => {
    const { workOrder, evidencePath } = fixture();
    await expect(recordMetric({
      evidencePath,
      candidateId: workOrder.candidate_id,
      metric: {
        id: "latency",
        kind: "metric",
        criterion_id: "speed",
        unit: "ms",
        direction: "lower",
        baseline_samples: [10, 11],
        candidate_samples: [8, 9],
      },
      resultStatus: "pass",
      requirementRefs: ["constraint:api"],
    })).rejects.toThrow("measures speed, not api");
  });

  it("records a content-addressed artifact and links its evaluation", async () => {
    const { workOrder, evidencePath } = fixture();
    const artifactPath = resolve(root, "tests", `tmp-artifact-${Math.random().toString(16).slice(2)}.txt`);
    temporaryFiles.push(artifactPath);
    writeFileSync(artifactPath, "verified demo output", "utf8");

    const artifact = await recordArtifact({
      evidencePath,
      candidateId: workOrder.candidate_id,
      artifactId: "demo",
      file: artifactPath,
      workspace: root,
      evaluation: {
        id: "demo-check",
        evaluator: "playwright-smoke",
        criterionId: "api",
        status: "pass",
        score: 0.9,
        summary: "The demo preserves the expected interface.",
      },
      probeIds: ["probe-1"],
      requirementRefs: ["constraint:api"],
    });
    const bundle = evidenceBundleSchema.parse(JSON.parse(readFileSync(evidencePath, "utf8")));
    const packet = bundle.packets[0]!;

    expect(artifact.path).toMatch(/^tests\//);
    expect(artifact.content_excerpt).toBe("verified demo output");
    expect(packet.artifact_evaluations?.[0]).toMatchObject({
      id: "demo-check",
      source: "imported",
      artifact_ids: ["demo"],
    });
    expect(packet.requirement_results.find((item) => item.criterion_id === "api"))
      .toMatchObject({ status: "pass", artifact_evaluation_ids: ["demo-check"] });
  });

  it("requires a fresh evaluation when replacing an evaluated artifact", async () => {
    const { workOrder, evidencePath } = fixture();
    const artifactPath = resolve(root, "tests", `tmp-replace-artifact-${Math.random().toString(16).slice(2)}.txt`);
    temporaryFiles.push(artifactPath);
    writeFileSync(artifactPath, "first", "utf8");
    await recordArtifact({
      evidencePath,
      candidateId: workOrder.candidate_id,
      artifactId: "report",
      file: artifactPath,
      workspace: root,
      evaluation: { id: "report-check", evaluator: "smoke", criterionId: "api", status: "pass", summary: "first" },
      requirementRefs: ["constraint:api"],
    });
    writeFileSync(artifactPath, "second", "utf8");

    await expect(recordArtifact({
      evidencePath,
      candidateId: workOrder.candidate_id,
      artifactId: "report",
      file: artifactPath,
      workspace: root,
      replace: true,
    })).rejects.toThrow("requires a replacement evaluation");
    await recordArtifact({
      evidencePath,
      candidateId: workOrder.candidate_id,
      artifactId: "report",
      file: artifactPath,
      workspace: root,
      replace: true,
      evaluation: { id: "report-check", evaluator: "smoke", criterionId: "api", status: "fail", summary: "second" },
      requirementRefs: ["constraint:api"],
    });
    const bundle = evidenceBundleSchema.parse(JSON.parse(readFileSync(evidencePath, "utf8")));
    expect(bundle.packets[0]?.requirement_results.find((item) => item.criterion_id === "api")?.status).toBe("fail");
  });

  it("requires a fresh result when replacing a linked metric", async () => {
    const { workOrder, evidencePath } = fixture();
    const metric = { id: "throughput", kind: "metric" as const, criterion_id: "speed", unit: "ops/s", direction: "higher" as const, baseline_samples: [10, 11], candidate_samples: [20, 21] };
    await recordMetric({ evidencePath, candidateId: workOrder.candidate_id, metric, resultStatus: "pass", requirementRefs: ["success:speed"] });
    await expect(recordMetric({
      evidencePath,
      candidateId: workOrder.candidate_id,
      metric: { ...metric, candidate_samples: [1, 2] },
      replace: true,
    })).rejects.toThrow("requires --result");
  });

  it("rejects artifacts above the configured byte limit", async () => {
    const { workOrder, evidencePath } = fixture();
    const artifactPath = resolve(root, "tests", `tmp-large-artifact-${Math.random().toString(16).slice(2)}.txt`);
    temporaryFiles.push(artifactPath);
    writeFileSync(artifactPath, "12345", "utf8");
    expect(DEFAULT_MAX_ARTIFACT_BYTES).toBeGreaterThan(5);
    await expect(recordArtifact({
      evidencePath,
      candidateId: workOrder.candidate_id,
      artifactId: "large",
      file: artifactPath,
      workspace: root,
      maxBytes: 4,
    })).rejects.toThrow("exceeds the 4-byte limit");
  });

  it("shows missing evidence and a concrete next action", async () => {
    const { campaignPath, evidencePath } = fixture();
    const status = await evidenceStatus(campaignPath, evidencePath);
    const human = renderEvidenceStatus(status);

    expect(status.summary.incomplete).toBe(1);
    expect(status.candidates[0]?.next_action).toBe("collect_evidence");
    expect(human).toContain("success:speed — unknown");
    expect(human).toContain("probe-1 — unknown");
    expect(human).toContain("next: collect_evidence");
    expect(evidenceNext(status)).toMatchObject({
      candidate_id: status.candidates[0]?.candidate_id,
      action: "collect_evidence",
      item: { kind: "requirement", id: "success:speed" },
    });
  });

  it("serializes concurrent metric updates without losing either metric", async () => {
    const { workOrder, evidencePath } = fixture();
    await Promise.all([
      recordMetric({ evidencePath, candidateId: workOrder.candidate_id, metric: { id: "metric-a", kind: "metric", criterion_id: "speed", unit: "ops/s", direction: "higher", baseline_samples: [10, 11], candidate_samples: [20, 21] } }),
      recordMetric({ evidencePath, candidateId: workOrder.candidate_id, metric: { id: "metric-b", kind: "metric", criterion_id: "speed", unit: "ops/s", direction: "higher", baseline_samples: [12, 13], candidate_samples: [22, 23] } }),
    ]);
    const bundle = evidenceBundleSchema.parse(JSON.parse(readFileSync(evidencePath, "utf8")));
    expect(bundle.packets[0]?.metrics.map((item) => item.id)).toEqual(expect.arrayContaining(["metric-a", "metric-b"]));
  });

  it("serializes concurrent artifact updates without losing either artifact", async () => {
    const { workOrder, evidencePath } = fixture();
    const first = resolve(root, "tests", `tmp-artifact-a-${Math.random().toString(16).slice(2)}.txt`);
    const second = resolve(root, "tests", `tmp-artifact-b-${Math.random().toString(16).slice(2)}.txt`);
    temporaryFiles.push(first, second);
    writeFileSync(first, "artifact a", "utf8");
    writeFileSync(second, "artifact b", "utf8");

    await Promise.all([
      recordArtifact({ evidencePath, candidateId: workOrder.candidate_id, artifactId: "artifact-a", file: first, workspace: root }),
      recordArtifact({ evidencePath, candidateId: workOrder.candidate_id, artifactId: "artifact-b", file: second, workspace: root }),
    ]);
    const bundle = evidenceBundleSchema.parse(JSON.parse(readFileSync(evidencePath, "utf8")));
    expect(bundle.packets[0]?.artifacts?.map((item) => item.id)).toEqual(expect.arrayContaining(["artifact-a", "artifact-b"]));
  });

  it("fails closed on a stale evidence lock instead of taking it over", async () => {
    const { workOrder, evidencePath } = fixture();
    const lockPath = `${evidencePath}.lock`;
    temporaryFiles.push(lockPath);
    writeFileSync(lockPath, JSON.stringify({ pid: 2_147_483_647, token: "stale-owner" }), "utf8");

    await expect(recordMetric({
      evidencePath,
      candidateId: workOrder.candidate_id,
      metric: { id: "blocked", kind: "metric", criterion_id: "speed", unit: "ops/s", direction: "higher", baseline_samples: [1], candidate_samples: [2] },
    })).rejects.toThrow("stale lock");
    expect(readFileSync(lockPath, "utf8")).toContain("stale-owner");
    const bundle = evidenceBundleSchema.parse(JSON.parse(readFileSync(evidencePath, "utf8")));
    expect(bundle.packets[0]?.metrics).toHaveLength(0);
  });
});
