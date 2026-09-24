import { describe, expect, it } from "vitest";
import type { JudgeResponse } from "../src/domain/schemas.js";
import { ProtocolError } from "../src/domain/errors.js";
import { LocalJudge, SemIfJudge, type LocalScoreRequest, type SemIfChatRequest } from "../src/judge.js";
import { rankCandidates } from "../src/policy.js";
import { buildQuestionPlan, type QuestionPlan } from "../src/questions.js";
import { buildCampaign } from "../src/workflow/campaign.js";
import { decideCampaign } from "../src/workflow/decide.js";
import { buildDecidePlan } from "../src/workflow/decide-questions.js";
import { prepareDecision, summarizeMetric } from "../src/workflow/evidence.js";
import type { Campaign, EvidenceBundle, EvidencePacket } from "../src/workflow/schemas.js";
import { makeResponse, minimalRequest } from "./fixtures.js";

function campaignFixture(): Campaign {
  const request = structuredClone(minimalRequest);
  request.budget.max_survivors = 2;
  const plan = buildQuestionPlan(request);
  return buildCampaign(request, rankCandidates(request, makeResponse(plan)));
}

function packetFixture(
  campaign: Campaign,
  index: number,
  options: { commandExit?: number; status?: "completed" | "failed" | "stopped" } = {},
): EvidencePacket {
  const workOrder = campaign.work_orders[index]!;
  return {
    kind: "jevrev.evidence-packet",
    schema_version: "1",
    campaign_id: campaign.campaign_id,
    candidate_id: workOrder.candidate_id,
    candidate_sha256: workOrder.candidate_sha256,
    revision: { base_commit: "base-commit", head_commit: `head-${index}` },
    development: {
      status: options.status ?? "completed",
      wall_ms: 30_000,
    },
    observations: [
      {
        id: "tests",
        kind: "command",
        argv: ["npm", "test"],
        exit_code: options.commandExit ?? 0,
        duration_ms: 1_000,
        required: true,
        termination: "exited",
      },
    ],
    metrics: [
      {
        id: "throughput",
        kind: "metric",
        criterion_id: "speed",
        unit: "ops/s",
        direction: "higher",
        baseline_samples: [99, 100, 101],
        candidate_samples: index === 0 ? [220, 222, 224] : [205, 206, 207],
      },
    ],
    requirement_results: [
      {
        criterion_id: "api",
        kind: "constraint",
        status: "pass",
        observation_ids: ["tests"],
        metric_ids: [],
      },
      {
        criterion_id: "speed",
        kind: "success",
        status: "pass",
        observation_ids: [],
        metric_ids: ["throughput"],
      },
    ],
    probe_results: workOrder.required_evidence.map((evidence) => ({
      evidence_id: evidence.id,
      status: "pass" as const,
      observation_ids: ["tests"],
      metric_ids: ["throughput"],
    })),
    changed_files: [`src/candidate-${index}.ts`],
    known_failures: [],
  };
}

function bundleFixture(campaign: Campaign, packets?: EvidencePacket[]): EvidenceBundle {
  return {
    kind: "jevrev.evidence-bundle",
    schema_version: "1",
    campaign_id: campaign.campaign_id,
    packets: packets ?? campaign.work_orders.map((_workOrder, index) => packetFixture(campaign, index)),
  };
}

interface DecideSignals {
  support?: number;
  reproducibility?: number;
  risk?: number;
  shipping?: number;
  confidence?: number;
}

function scoreAnswer(score: number, confidence = 0.9) {
  return {
    type: "score" as const,
    score,
    confidence,
    legend: { "0": "bad", "1": "weak", "2": "good", "3": "strong" },
    probabilities: { "0": 0, "1": 0, "2": 0, "3": 1 },
  };
}

function decideResponse(
  plan: QuestionPlan,
  signals: DecideSignals[] = [],
  complementary = 0.05,
): JudgeResponse {
  const answers: JudgeResponse["answers"] = {};
  for (const [key, type] of Object.entries(plan.expectedTypes)) {
    const finalist = /^finalist_(\d+)_(.+)$/.exec(key);
    if (finalist !== null) {
      const fixture = signals[Number(finalist[1])] ?? {};
      const signal = finalist[2];
      if (type === "score") {
        answers[key] = scoreAnswer(
          signal === "evidence_support"
            ? fixture.support ?? 2.7
            : fixture.reproducibility ?? 2.7,
          fixture.confidence,
        );
      } else {
        answers[key] = {
          type: "noul",
          noul: signal === "residual_risk_acceptance"
            ? fixture.risk ?? 0.9
            : fixture.shipping ?? 0.9,
        };
      }
      continue;
    }
    if (/^finalist_pair_\d+_\d+_complementary$/.test(key)) {
      answers[key] = { type: "noul", noul: complementary };
      continue;
    }
    throw new Error(`Unhandled decide question: ${key}`);
  }
  return {
    model: "jev-decide-test",
    answers,
    usage: { input_tokens: 250, output_tokens: Object.keys(answers).length * 4 },
  };
}

describe("evidence-backed decide policy", () => {
  it("rejects a duplicated or out-of-range finalist order", () => {
    const campaign = campaignFixture();
    const prepared = prepareDecision(campaign, bundleFixture(campaign));
    const plan = buildDecidePlan(prepared);
    const response = decideResponse(plan);
    expect(() => decideCampaign(prepared, response, [0, 0])).toThrow("permutation");
    expect(() => decideCampaign(prepared, response, [0, 2])).toThrow("permutation");
  });

  it("represents an empty sift as no winner without calling a judge", () => {
    const request = structuredClone(minimalRequest);
    const plan = buildQuestionPlan(request);
    const sift = rankCandidates(request, makeResponse(plan, [
      { goal: 0, constraint: 0.9, feasibility: 0, value: 0.1 },
      { goal: 0, constraint: 0.9, feasibility: 0, value: 0.1 },
    ]));
    const campaign = buildCampaign(request, sift);
    const bundle: EvidenceBundle = {
      kind: "jevrev.evidence-bundle",
      schema_version: "1",
      campaign_id: campaign.campaign_id,
      packets: [],
    };
    const prepared = prepareDecision(campaign, bundle);
    const result = decideCampaign(prepared, undefined);

    expect(result.decision).toBe("no_winner");
    expect(result.next_action.type).toBe("revise_ideas");
  });

  it("accepts optional evidence about a soft constraint", () => {
    const request = structuredClone(minimalRequest);
    request.budget.max_survivors = 2;
    request.task.constraints.push({
      id: "memory",
      text: "Avoid excessive memory growth",
      kind: "soft",
    });
    const siftPlan = buildQuestionPlan(request);
    const campaign = buildCampaign(
      request,
      rankCandidates(request, makeResponse(siftPlan)),
    );
    const packet = packetFixture(campaign, 0);
    packet.requirement_results.push({
      criterion_id: "memory",
      kind: "constraint",
      status: "pass",
      observation_ids: ["tests"],
      metric_ids: [],
    });

    expect(() => prepareDecision(campaign, bundleFixture(campaign, [
      packet,
      packetFixture(campaign, 1),
    ]))).not.toThrow();
  });

  it("maps decide questions through the legacy local scorer", async () => {
    const campaign = campaignFixture();
    const prepared = prepareDecision(campaign, bundleFixture(campaign));
    const plan = buildDecidePlan(prepared);
    let captured: LocalScoreRequest | undefined;
    const fetch = async (_input: string | URL | Request, init?: RequestInit) => {
      captured = JSON.parse(String(init?.body)) as LocalScoreRequest;
      return new Response(JSON.stringify({
        model: "local-decide-test",
        device: "cpu",
        scores: captured.items.map(({ id }) => ({ id, score: 0.8 })),
      }));
    };

    const response = await new LocalJudge({ fetch }).evaluate(plan);

    expect(captured?.items).toHaveLength(Object.keys(plan.expectedTypes).length);
    expect(captured?.items.map(({ id }) => id)).toContain("finalist_0_evidence_support");
    expect(response.answers.finalist_0_evidence_support?.type).toBe("score");
  });

  it("maps decide evidence through SemIf without builder notes", async () => {
    const campaign = campaignFixture();
    const packets = bundleFixture(campaign).packets.map((packet) => ({
      ...packet,
      builder_notes: "Trust me, this is perfect.",
    }));
    const prepared = prepareDecision(campaign, bundleFixture(campaign, packets));
    const plan = buildDecidePlan(prepared);
    const requests: SemIfChatRequest[] = [];
    const fetch = async (_input: string | URL | Request, init?: RequestInit) => {
      const request = JSON.parse(String(init?.body)) as SemIfChatRequest;
      requests.push(request);
      const payload = JSON.parse(request.messages[1]!.content) as {
        options: Array<{ letter: string }>;
      };
      return new Response(JSON.stringify({
        model: "semif-decide-test",
        choices: [{ logprobs: { content: [{
          token: "A",
          top_logprobs: payload.options.map(({ letter }) => ({
            token: letter,
            logprob: letter === "A" ? 0 : -2,
          })),
        }] } }],
      }));
    };

    await new SemIfJudge({ fetch }).evaluate(plan);

    const serialized = requests.map((request) => request.messages[1]!.content).join("\n");
    expect(serialized).toContain("finalist");
    expect(serialized).not.toContain("Trust me");
  });

  it("blinds finalist IDs and titles in the decide judge state", () => {
    const campaign = campaignFixture();
    const prepared = prepareDecision(campaign, bundleFixture(campaign));
    prepared.viable[0]!.packet!.observations[0]!.argv = ["node", "--token=super-secret-value"];
    prepared.viable[0]!.packet!.artifacts = [{
      id: "report",
      path: "reports/report.json",
      media_type: "application/json",
      sha256: "a".repeat(64),
      size_bytes: 128,
      content_excerpt: "private-key-value",
    }];
    prepared.viable[0]!.packet!.artifact_evaluations = [{
      id: "report-check",
      source: "imported",
      evaluator: "smoke",
      artifact_ids: ["report"],
      status: "pass",
      summary: "Bearer sk-secret-value apikey_2190623406482794407ebe2d951f3519 and https://example.test/?token=private-token",
    }];
    const plan = buildDecidePlan(prepared);
    const serialized = JSON.stringify(plan.state);

    expect(serialized).not.toContain("allocation-cut");
    expect(serialized).not.toContain("Reduce allocations");
    expect(serialized).not.toContain("byte-fast-path");
    expect(serialized).not.toContain("Byte fast path");
    expect(serialized).not.toContain("super-secret-value");
    expect(serialized).not.toContain("private-key-value");
    expect(serialized).not.toContain("sk-secret-value");
    expect(serialized).not.toContain("apikey_2190623406482794407ebe2d951f3519");
    expect(serialized).not.toContain("private-token");
    expect(serialized).toContain("[REDACTED]");
    expect(serialized).toContain('"command":"node"');
    expect(serialized).toContain('"sha256":"' + "a".repeat(64) + '"');
  });

  it("recomputes sample statistics from raw values", () => {
    const summary = summarizeMetric({
      id: "latency",
      kind: "metric",
      criterion_id: "speed",
      unit: "ms",
      direction: "lower",
      baseline_samples: [10, 12, 14],
      candidate_samples: [5, 6, 7],
    });

    expect(summary.baseline_mean).toBe(12);
    expect(summary.baseline_sample_sd).toBe(2);
    expect(summary.candidate_mean).toBe(6);
    expect(summary.candidate_sample_sd).toBe(1);
    expect(summary.relative_improvement).toBe(0.5);
  });

  it("fails closed when evidence uses the wrong candidate hash", () => {
    const campaign = campaignFixture();
    const bundle = bundleFixture(campaign);
    bundle.packets[0]!.candidate_sha256 = "0".repeat(64);

    expect(() => prepareDecision(campaign, bundle)).toThrow(ProtocolError);
  });

  it("fails closed when the frozen campaign content no longer matches its ID", () => {
    const campaign = campaignFixture();
    campaign.request.task.goal = "A tampered goal";

    expect(() => prepareDecision(campaign, bundleFixture(campaign))).toThrow(
      "Campaign ID does not match",
    );
  });

  it("fails closed when a frozen work-order budget is changed", () => {
    const campaign = campaignFixture();
    campaign.work_orders[0]!.budget.max_wall_ms += 1;

    expect(() => prepareDecision(campaign, bundleFixture(campaign))).toThrow(
      "Campaign ID does not match",
    );
  });

  it("rejects a failed command cited by mandatory evidence even when marked optional", () => {
    const campaign = campaignFixture();
    const packet = packetFixture(campaign, 0);
    packet.observations[0]!.required = false;
    packet.observations[0]!.exit_code = 1;
    const prepared = prepareDecision(campaign, bundleFixture(campaign, [
      packet,
      packetFixture(campaign, 1, { status: "failed" }),
    ]));

    const evaluation = prepared.evaluations[0]!;
    expect(evaluation.status).toBe("rejected");
    expect(evaluation.reasons).toContain("REQUIRED_COMMAND_FAILED");
  });

  it("rejects internally inconsistent wall-time evidence", () => {
    const campaign = campaignFixture();
    const packet = packetFixture(campaign, 0);
    packet.development.wall_ms = 1;

    expect(() => prepareDecision(campaign, bundleFixture(campaign, [
      packet,
      packetFixture(campaign, 1),
    ]))).toThrow("wall_ms is less than recorded command duration");
  });

  it("does not treat the absence of a required command as passed", () => {
    const campaign = campaignFixture();
    const packet = packetFixture(campaign, 0);
    packet.observations = [];
    packet.metrics.push({
      id: "api-evidence",
      kind: "metric",
      criterion_id: "api",
      unit: "violations",
      direction: "lower",
      baseline_samples: [0, 0],
      candidate_samples: [0, 0],
    });
    packet.requirement_results.forEach((result) => {
      result.observation_ids = [];
      result.metric_ids = [result.criterion_id === "api" ? "api-evidence" : "throughput"];
    });
    packet.probe_results.forEach((result) => {
      result.observation_ids = [];
      result.metric_ids = ["throughput"];
    });
    const prepared = prepareDecision(campaign, bundleFixture(campaign, [
      packet,
      packetFixture(campaign, 1, { status: "failed" }),
    ]));

    expect(prepared.evaluations[0]?.status).toBe("incomplete");
    expect(prepared.evaluations[0]?.reasons).toContain("MISSING_REQUIRED_COMMAND");
  });

  it("rejects a requirement that cites a metric for another criterion", () => {
    const campaign = campaignFixture();
    const packet = packetFixture(campaign, 0);
    packet.metrics[0]!.criterion_id = "api";

    expect(() => prepareDecision(campaign, bundleFixture(campaign, [
      packet,
      packetFixture(campaign, 1),
    ]))).toThrow("does not measure requirement speed");
  });

  it("lets hard evidence reverse the paper ranking", () => {
    const campaign = campaignFixture();
    const first = packetFixture(campaign, 0, { commandExit: 1 });
    const second = packetFixture(campaign, 1);
    const prepared = prepareDecision(campaign, bundleFixture(campaign, [first, second]));
    const plan = buildDecidePlan(prepared);
    const result = decideCampaign(prepared, decideResponse(plan), plan.candidateOrder);

    expect(campaign.sift.selected[0]).toBe(first.candidate_id);
    expect(result.winner).toBe(second.candidate_id);
    expect(result.evaluations.find((item) => item.candidate_id === first.candidate_id)?.reasons)
      .toContain("REQUIRED_COMMAND_FAILED");
  });

  it("does not treat a timed-out zero exit as passed evidence", () => {
    const campaign = campaignFixture();
    const packet = packetFixture(campaign, 0);
    packet.observations[0]!.termination = "timed_out";
    const prepared = prepareDecision(campaign, bundleFixture(campaign, [packet, packetFixture(campaign, 1)]));

    expect(prepared.evaluations.find((item) => item.candidate_id === packet.candidate_id)?.reasons)
      .toContain("REQUIRED_COMMAND_FAILED");
  });

  it("rejects a wall budget that is smaller than total recorded command time", () => {
    const campaign = campaignFixture();
    const packet = packetFixture(campaign, 0);
    packet.observations.push({
      id: "second-test",
      kind: "command",
      argv: ["npm", "test", "--second"],
      exit_code: 0,
      duration_ms: 1_000,
      required: true,
      termination: "exited",
    });
    packet.development.wall_ms = 1_500;

    expect(() => prepareDecision(campaign, bundleFixture(campaign, [packet, packetFixture(campaign, 1)])))
      .toThrow("recorded command duration total");
  });

  it("replays a decide plan after deterministic gates leave one finalist", async () => {
    const campaign = campaignFixture();
    const prepared = prepareDecision(campaign, bundleFixture(campaign, [
      packetFixture(campaign, 0, { commandExit: 1 }),
      packetFixture(campaign, 1),
    ]));
    const plan = buildDecidePlan(prepared);
    const response = decideResponse(plan);
    const replay = { ...response, candidate_order: [...plan.candidateIds] };

    await expect(import("../src/judge.js").then(({ ReplayJudge }) =>
      new ReplayJudge(replay).evaluate(plan))).resolves.toEqual(response);
  });

  it("asks for more evidence instead of forcing a winner", () => {
    const campaign = campaignFixture();
    const prepared = prepareDecision(
      campaign,
      bundleFixture(campaign, [packetFixture(campaign, 0)]),
    );
    const plan = buildDecidePlan(prepared);
    const result = decideCampaign(prepared, decideResponse(plan), plan.candidateOrder);

    expect(result.decision).toBe("probe_more");
    expect(result.next_action.candidate_ids).toEqual([campaign.work_orders[1]!.candidate_id]);
  });

  it("recommends a combined probe for close complementary finalists", () => {
    const campaign = campaignFixture();
    const first = packetFixture(campaign, 0);
    const second = packetFixture(campaign, 1);
    first.development.wall_ms = 45_000;
    second.development.wall_ms = 30_000;
    const prepared = prepareDecision(campaign, bundleFixture(campaign, [first, second]));
    const plan = buildDecidePlan(prepared);
    const result = decideCampaign(
      prepared,
      decideResponse(plan, [{ support: 2.8 }, { support: 2.7 }], 0.9),
      plan.candidateOrder,
    );

    expect(result.decision).toBe("merge");
    expect(result.merge_candidates).toHaveLength(2);
    expect(result.next_action.type).toBe("probe_combination");
  });

  it("returns no winner when every viable probe fails semantic evidence gates", () => {
    const campaign = campaignFixture();
    const prepared = prepareDecision(campaign, bundleFixture(campaign));
    const plan = buildDecidePlan(prepared);
    const result = decideCampaign(
      prepared,
      decideResponse(plan, [{ support: 0.5 }, { support: 0.5 }]),
      plan.candidateOrder,
    );

    expect(result.decision).toBe("no_winner");
    expect(result.winner).toBeNull();
  });

  it("routes uncertain semantic evidence to human review", () => {
    const campaign = campaignFixture();
    const prepared = prepareDecision(campaign, bundleFixture(campaign));
    const plan = buildDecidePlan(prepared);
    const response = decideResponse(plan, [
      { confidence: 0.05, risk: 0.51 },
      { confidence: 0.05, risk: 0.51 },
    ]);
    const result = decideCampaign(prepared, response, plan.candidateOrder);

    expect(result.decision).toBe("human_review");
  });

  it("does not declare a winner while a competing finalist remains in review", () => {
    const campaign = campaignFixture();
    const prepared = prepareDecision(campaign, bundleFixture(campaign));
    const plan = buildDecidePlan(prepared);
    const response = decideResponse(plan, [
      { support: 3, reproducibility: 3, risk: 0.95, shipping: 0.95 },
      { confidence: 0.05, risk: 0.51 },
    ]);
    const result = decideCampaign(prepared, response, plan.candidateOrder);

    expect(result.decision).toBe("human_review");
    expect(result.winner).toBeNull();
    expect(result.next_action.candidate_ids).toEqual([
      campaign.work_orders[0]!.candidate_id,
      campaign.work_orders[1]!.candidate_id,
    ]);
  });

  it("applies objective Pareto dominance before semantic score ordering", () => {
    const campaign = campaignFixture();
    const first = packetFixture(campaign, 0);
    const second = packetFixture(campaign, 1);
    first.metrics[0]!.candidate_samples = [150, 151, 149];
    first.development.wall_ms = 60_000;
    first.changed_files = ["src/a.ts", "src/b.ts"];
    second.metrics[0]!.candidate_samples = [220, 221, 219];
    second.development.wall_ms = 30_000;
    second.changed_files = ["src/c.ts"];
    const prepared = prepareDecision(campaign, bundleFixture(campaign, [first, second]));
    const plan = buildDecidePlan(prepared);
    const result = decideCampaign(
      prepared,
      decideResponse(plan, [
        { support: 3, reproducibility: 3, risk: 0.95, shipping: 0.95 },
        { support: 2, reproducibility: 2, risk: 0.7, shipping: 0.7 },
      ]),
      plan.candidateOrder,
    );

    expect(result.decision).toBe("winner");
    expect(result.winner).toBe(second.candidate_id);
    expect(result.evaluations.find((item) => item.candidate_id === first.candidate_id)?.reasons)
      .toContain("OBJECTIVELY_DOMINATED");
  });
});
