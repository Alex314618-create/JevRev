import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { buildQuestionPlan } from "../src/questions.js";
import { makeResponse, minimalRequest } from "./fixtures.js";

const root = resolve(import.meta.dirname, "..");
const tsx = resolve(root, "node_modules", "tsx", "dist", "cli.mjs");
const cli = resolve(root, "src", "cli.ts");
const request = resolve(root, "examples", "parser-speedup.json");
const replay = resolve(root, "examples", "parser-jev-response.json");

function run(args: string[], stdin?: string, env = process.env) {
  return spawnSync(process.execPath, [tsx, cli, ...args], {
    cwd: root,
    encoding: "utf8",
    env,
    ...(stdin === undefined ? {} : { input: stdin }),
  });
}

describe("jevrev CLI", () => {
  it("runs the shadow activation policy without a provider", () => {
    const result = run([
      "activation",
      "--input",
      "-",
      "--format",
      "json",
    ], JSON.stringify({
      kind: "jevrev.activation-request",
      schema_version: "1",
      task: { goal: "Choose a safe cache implementation" },
      assessment: {
        candidate_count: 4,
        wrong_path_loss: 0.85,
        exploration_cost: 0.2,
        mechanism_diversity: 0.8,
        constraint_interaction: 0.8,
        uncertainty: 0.8,
        probeability: 0.8,
        reversibility: 0.2,
        existing_evidence: 0.1,
      },
    }));
    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    expect(JSON.parse(result.stdout)).toMatchObject({
      kind: "jevrev.activation-decision",
      decision: "sift",
      shadow: true,
    });
  });

  it("fails closed for malformed activation input", () => {
    const result = run(["activate", "--input", "-"], "{\"kind\":\"wrong\"}");
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("Invalid activation request");
    expect(result.stdout).toBe("");
  });

  it("runs through a symlinked CLI path", () => {
    const directory = mkdtempSync(join(tmpdir(), "jevrev-cli-link-"));
    try {
      const linkedRoot = join(directory, "linked-root");
      symlinkSync(root, linkedRoot, process.platform === "win32" ? "junction" : "dir");
      const link = join(linkedRoot, "src", "cli.ts");
      const result = spawnSync(process.execPath, [tsx, link, "--version"], { cwd: root, encoding: "utf8" });
      expect(result.status).toBe(0);
      expect(result.stdout.trim()).toBe("0.2.0");
      expect(result.stderr).toBe("");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("emits a probe campaign from the sift command", () => {
    const result = run([
      "sift",
      "--input",
      request,
      "--replay",
      replay,
    ]);

    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    expect(JSON.parse(result.stdout)).toMatchObject({
      kind: "jevrev.campaign",
      schema_version: "1",
      sift: { selected: ["allocation-cut", "byte-fast-path"] },
      work_orders: [
        { candidate_id: "allocation-cut", required_evidence: expect.any(Array) },
        { candidate_id: "byte-fast-path", required_evidence: expect.any(Array) },
      ],
    });
  });

  it("writes the full Sift campaign to a file and emits only a compact summary", () => {
    const output = resolve(root, "tests", "tmp-sift-summary-campaign.json");
    const result = run([
      "sift", "--input", request, "--replay", replay, "--summary", "--output", output,
    ]);
    try {
      expect(result.status).toBe(0);
      expect(result.stderr).toBe("");
      expect(result.stdout.length).toBeLessThan(1_000);
      expect(result.stdout).toContain("kept 2/7");
      expect(result.stdout).toContain("allocation-cut");
      expect(JSON.parse(readFileSync(output, "utf8"))).toMatchObject({ kind: "jevrev.campaign" });
    } finally {
      rmSync(output, { force: true });
    }
  });

  it("rejects Sift summary without a JSON output target", () => {
    const result = run(["sift", "--input", request, "--replay", replay, "--summary"]);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("--summary requires --output and --format json");
    expect(result.stdout).toBe("");
  });

  it("records command evidence through the CLI and returns the child exit code", () => {
    const sift = run(["sift", "--input", request, "--replay", replay]);
    expect(sift.status).toBe(0);
    const campaign = JSON.parse(sift.stdout) as {
      campaign_id: string;
      work_orders: Array<{
        candidate_id: string;
        candidate_sha256: string;
        required_evidence: Array<{ id: string }>;
      }>;
      request: {
        task: {
          success: Array<{ id: string }>;
          constraints: Array<{ id: string; kind: string }>;
        };
      };
    };
    const workOrder = campaign.work_orders[0]!;
    const campaignPath = resolve(root, "tests", "tmp-recorder-campaign.json");
    const evidencePath = resolve(root, "tests", "tmp-recorder-evidence.json");
    writeFileSync(campaignPath, `${JSON.stringify(campaign)}\n`, "utf8");
    const template = spawnSync(process.execPath, [
      resolve(root, "scripts", "create-evidence-template.mjs"),
      "--campaign", campaignPath,
      "--output", evidencePath,
      "--base-commit", "test-base",
    ], { cwd: root, encoding: "utf8" });
    expect(template.status).toBe(0);

    try {
      const result = run([
        "evidence", "run",
        "--evidence", evidencePath,
        "--candidate", workOrder.candidate_id,
        "--id", "failing-test",
        "--probe", workOrder.required_evidence[0]!.id,
        "--requirement", `constraint:${campaign.request.task.constraints.find((item) => item.kind === "hard")!.id}`,
        "--quiet",
        "--",
        process.execPath,
        "-e",
        "process.exit(7)",
      ]);
      expect(result.status).toBe(7);
      expect(result.stderr).toContain("recorded failing-test");
      const evidence = JSON.parse(readFileSync(evidencePath, "utf8"));
      expect(evidence.packets[0].observations[0]).toMatchObject({
        id: "failing-test",
        exit_code: 7,
        termination: "exited",
      });
      expect(evidence.packets[0].probe_results[0].status).toBe("fail");
    } finally {
      rmSync(campaignPath, { force: true });
      rmSync(evidencePath, { force: true });
    }
  });

  it("runs evidence-backed decide through a replay provider", () => {
    const sift = run(["sift", "--input", request, "--replay", replay]);
    expect(sift.status).toBe(0);
    const campaign = JSON.parse(sift.stdout) as {
      campaign_id: string;
      work_orders: Array<{ candidate_id: string; candidate_sha256: string }>;
    };
    const campaignPath = resolve(root, "tests", "tmp-campaign.json");
    const evidencePath = resolve(root, "tests", "tmp-evidence.json");
    const replayPath = resolve(root, "tests", "tmp-decide-replay.json");
    const packets = campaign.work_orders.map((workOrder, index) => ({
      kind: "jevrev.evidence-packet",
      schema_version: "1",
      campaign_id: campaign.campaign_id,
      candidate_id: workOrder.candidate_id,
      candidate_sha256: workOrder.candidate_sha256,
      revision: { base_commit: "base", head_commit: `head-${index}` },
      development: { status: "completed", wall_ms: 30_000 },
      observations: [{
        id: "tests",
        kind: "command",
        argv: ["npm", "test"],
        exit_code: 0,
        duration_ms: 1_000,
        required: true,
      }],
      metrics: [
        {
          id: "throughput",
          kind: "metric",
          criterion_id: "throughput",
          unit: "ops/s",
          direction: "higher",
          baseline_samples: [100, 101, 99],
          candidate_samples: index === 0 ? [220, 222, 224] : [160, 161, 159],
        },
      ],
      requirement_results: [
        { criterion_id: "public-api", kind: "constraint", status: "pass", observation_ids: ["tests"], metric_ids: [] },
        { criterion_id: "compatibility", kind: "constraint", status: "pass", observation_ids: ["tests"], metric_ids: [] },
        { criterion_id: "throughput", kind: "success", status: "pass", observation_ids: [], metric_ids: ["throughput"] },
        { criterion_id: "correctness", kind: "success", status: "pass", observation_ids: ["tests"], metric_ids: [] },
      ],
      probe_results: campaign.work_orders[index]!.required_evidence.map((evidence) => ({
        evidence_id: evidence.id,
        status: "pass",
        observation_ids: ["tests"],
        metric_ids: ["throughput"],
      })),
      changed_files: [`src/probe-${index}.ts`],
      known_failures: [],
    }));
    const decideAnswers: Record<string, unknown> = {};
    campaign.work_orders.forEach((_workOrder, index) => {
      const strong = index === 0;
      decideAnswers[`finalist_${index}_evidence_support`] = {
        type: "score", score: strong ? 3 : 2, confidence: 0.9,
        legend: { "0": "bad", "1": "weak", "2": "good", "3": "strong" },
        probabilities: { "0": 0, "1": 0, "2": strong ? 0 : 1, "3": strong ? 1 : 0 },
      };
      decideAnswers[`finalist_${index}_reproducibility`] = {
        type: "score", score: strong ? 3 : 2, confidence: 0.9,
        legend: { "0": "bad", "1": "weak", "2": "good", "3": "strong" },
        probabilities: { "0": 0, "1": 0, "2": strong ? 0 : 1, "3": strong ? 1 : 0 },
      };
      decideAnswers[`finalist_${index}_residual_risk_acceptance`] = { type: "noul", noul: strong ? 0.95 : 0.7 };
      decideAnswers[`finalist_${index}_shipping_value`] = { type: "noul", noul: strong ? 0.95 : 0.7 };
    });
    decideAnswers.finalist_pair_0_1_complementary = { type: "noul", noul: 0.05 };

    writeFileSync(campaignPath, `${JSON.stringify(campaign)}\n`, "utf8");
    writeFileSync(evidencePath, `${JSON.stringify({
      kind: "jevrev.evidence-bundle",
      schema_version: "1",
      campaign_id: campaign.campaign_id,
      packets,
    })}\n`, "utf8");
    writeFileSync(replayPath, `${JSON.stringify({
      model: "jev-decide-demo",
      candidate_order: campaign.work_orders.map((workOrder) => workOrder.candidate_id),
      answers: decideAnswers,
      usage: { input_tokens: 200, output_tokens: 20 },
    })}\n`, "utf8");

    try {
      const result = run([
        "decide",
        "--campaign", campaignPath,
        "--evidence", evidencePath,
        "--replay", replayPath,
      ]);
      expect(result.status).toBe(0);
      expect(result.stderr).toBe("");
      expect(JSON.parse(result.stdout)).toMatchObject({
        kind: "jevrev.decide-result",
        decision: "winner",
        winner: "allocation-cut",
        next_action: { type: "integrate_winner" },
      });
    } finally {
      rmSync(campaignPath, { force: true });
      rmSync(evidencePath, { force: true });
      rmSync(replayPath, { force: true });
    }
  });

  it("runs the parser demonstration in JSON mode", () => {
    const result = run([
      "rank",
      "--input",
      request,
      "--replay",
      replay,
      "--format",
      "json",
    ]);

    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    const output = JSON.parse(result.stdout) as {
      selected: string[];
      policy: { provider_profile: string };
    };
    expect(output.selected).toEqual(["allocation-cut", "byte-fast-path"]);
    expect(output.policy.provider_profile).toBe("replay");
  });

  it("keeps replay mode independent from provider configuration", () => {
    const result = run([
      "rank",
      "--input",
      request,
      "--replay",
      replay,
      "--provider",
      "local",
      "--local-url",
      "not-a-url",
      "--format",
      "json",
    ]);

    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout).selected).toEqual([
      "allocation-cut",
      "byte-fast-path",
    ]);
  });

  it("accepts the rank request from stdin", () => {
    const result = run(
      ["rank", "--input", "-", "--replay", replay, "--format", "json"],
      readFileSync(request, "utf8"),
    );

    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      summary: { evaluated: 7, kept: 2, shortlisted: 2, rejected: 5 },
    });
  });

  it("reconsiders a review candidate and emits one bounded probe order", () => {
    const requestPath = resolve(root, "tests", "tmp-reconsider-request.json");
    const siftReplayPath = resolve(root, "tests", "tmp-reconsider-sift-replay.json");
    const campaignPath = resolve(root, "tests", "tmp-reconsider-campaign.json");
    const reconsiderReplayPath = resolve(root, "tests", "tmp-reconsider-replay.json");
    const promotedCampaignPath = resolve(root, "tests", "tmp-promoted-campaign.json");
    const plan = buildQuestionPlan(minimalRequest, { canonicalize: true });
    const siftReplay = {
      ...makeResponse(plan, [
        { goal: 2.5, goalConfidence: 0.1, constraint: 0.9, value: 0.9 },
        { goal: 3, constraint: 0.9, value: 0.9 },
      ]),
      candidate_order: plan.candidateIds,
    };
    const reviewAnswers = Object.fromEntries([
      ["reconsider_candidate_goal_fit", { type: "score", score: 3, confidence: 0.9, legend: { "0": "bad", "1": "weak", "2": "good", "3": "strong" }, probabilities: { "0": 0, "1": 0, "2": 0, "3": 1 } }],
      ["reconsider_candidate_constraint_fit", { type: "noul", noul: 0.9 }],
      ["reconsider_candidate_feasibility", { type: "score", score: 3, confidence: 0.9, legend: { "0": "bad", "1": "weak", "2": "good", "3": "strong" }, probabilities: { "0": 0, "1": 0, "2": 0, "3": 1 } }],
      ["reconsider_candidate_validation_quality", { type: "score", score: 3, confidence: 0.9, legend: { "0": "bad", "1": "weak", "2": "good", "3": "strong" }, probabilities: { "0": 0, "1": 0, "2": 0, "3": 1 } }],
      ["reconsider_candidate_execution_value", { type: "score", score: 3, confidence: 0.9, legend: { "0": "bad", "1": "weak", "2": "good", "3": "strong" }, probabilities: { "0": 0, "1": 0, "2": 0, "3": 1 } }],
    ]);
    writeFileSync(requestPath, JSON.stringify(minimalRequest));
    writeFileSync(siftReplayPath, JSON.stringify(siftReplay));
    try {
      const sift = run(["sift", "--input", requestPath, "--replay", siftReplayPath]);
      expect(sift.status).toBe(0);
      writeFileSync(campaignPath, sift.stdout);
      writeFileSync(reconsiderReplayPath, JSON.stringify({
        model: "jev-reconsider-cli", candidate_order: ["allocation-cut"],
        answers: reviewAnswers, usage: { input_tokens: 20, output_tokens: 5 },
      }));
      const reconsider = run([
        "reconsider", "--campaign", campaignPath, "--candidate", "allocation-cut",
        "--replay", reconsiderReplayPath, "--format", "json", "--promoted-campaign-output", promotedCampaignPath,
      ]);
      expect(reconsider.status).toBe(0);
      expect(JSON.parse(reconsider.stdout)).toMatchObject({
        decision: "promote_to_probe",
        work_order: { candidate_id: "allocation-cut" },
      });
      expect(JSON.parse(readFileSync(promotedCampaignPath, "utf8"))).toMatchObject({
        review_work_orders: [{ candidate_id: "allocation-cut" }],
      });
    } finally {
      for (const path of [requestPath, siftReplayPath, campaignPath, reconsiderReplayPath, promotedCampaignPath]) rmSync(path, { force: true });
    }
  });

  it("accepts a PowerShell-style UTF-16LE input file", () => {
    const input = resolve(root, "tests", "tmp-utf16-request.json");
    writeFileSync(input, Buffer.concat([
      Buffer.from([0xff, 0xfe]),
      Buffer.from(readFileSync(request, "utf8"), "utf16le"),
    ]));
    try {
      const result = run(["rank", "--input", input, "--replay", replay, "--format", "json"]);
      expect(result.status).toBe(0);
      expect(JSON.parse(result.stdout).selected).toEqual(["allocation-cut", "byte-fast-path"]);
    } finally {
      rmSync(input, { force: true });
    }
  });

  it("rejects replay against a differently ordered request", () => {
    const reorderedRequest = resolve(root, "tests", "tmp-reordered-request.json");
    const parsed = JSON.parse(readFileSync(request, "utf8")) as {
      candidates: unknown[];
    };
    parsed.candidates.reverse();
    writeFileSync(reorderedRequest, `${JSON.stringify(parsed)}\n`, "utf8");

    try {
      const result = run([
        "rank",
        "--input",
        reorderedRequest,
        "--replay",
        replay,
      ]);

      expect(result.status).toBe(4);
      expect(result.stderr).toContain("candidate_order");
    } finally {
      rmSync(reorderedRequest, { force: true });
    }
  });

  it("uses the documented invalid-input exit code", () => {
    const result = run(["rank", "--input", "-", "--replay", replay], "{}");

    expect(result.status).toBe(2);
    expect(result.stderr).toContain("Invalid rank request");
    expect(result.stderr).toContain("input:");
    expect(result.stderr).toContain("See examples/parser-speedup.json");
    expect(result.stderr).not.toContain("[{\"code\"");
    expect(result.stdout).toBe("");
  });

  it("honors a survivor-budget override", () => {
    const result = run([
      "rank",
      "--input",
      request,
      "--replay",
      replay,
      "--format",
      "json",
      "--top",
      "1",
    ]);

    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout).selected).toEqual(["allocation-cut"]);
  });

  it("reports a missing live API key as a provider failure", () => {
    const env = { ...process.env };
    delete env.TYPESAFE_API_KEY;
    delete env.JEVREV_JEV_API_KEY;
    const result = run(["rank", "--input", request], undefined, env);

    expect(result.status).toBe(3);
    expect(result.stderr).toContain("provider error");
    expect(result.stderr).toContain("JEVREV_JEV_API_KEY");
    expect(result.stderr).toContain("TYPESAFE_API_KEY");
  });

  it("rejects an unknown provider", () => {
    const result = run([
      "rank",
      "--input",
      request,
      "--replay",
      replay,
      "--provider",
      "unknown",
    ]);

    expect(result.status).toBe(2);
    expect(result.stderr).toContain("must be jev, semif, or local");
  });

  it("supports the primary run command with JSON as its default format", () => {
    const result = run([
      "run",
      "--input",
      request,
      "--replay",
      replay,
    ]);

    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      run_id: expect.stringMatching(/^jvr_/),
      selected: ["allocation-cut", "byte-fast-path"],
    });
  });

  it("prints the configured Jev input address", () => {
    const result = run(["doctor", "--format", "json"]);

    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      endpoints: {
        jev: {
          request_url: "https://api.typesafe.ai/v1/systemone",
        },
      },
    });
  });

  it("returns a failing health-check status for an unreachable selected local provider", () => {
    const result = run([
      "doctor",
      "--provider",
      "local",
      "--check",
      "--format",
      "json",
      "--local-url",
      "http://127.0.0.1:1",
    ]);

    expect(result.status).toBe(3);
    expect(result.stderr).toBe("");
    expect(JSON.parse(result.stdout)).toMatchObject({
      provider: "local",
      endpoints: { local: { state: expect.stringMatching(/^unreachable:/) } },
    });
  });

  it("normalizes local provider URLs that already include /v1", () => {
    const result = run([
      "doctor",
      "--format",
      "json",
      "--semif-url",
      "http://localhost:4878/v1/",
      "--local-url",
      "http://localhost:4877/v1",
    ]);

    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      endpoints: {
        semif: {
          request_url: "http://localhost:4878/v1/chat/completions",
        },
        local: {
          request_url: "http://localhost:4877/v1/score",
        },
      },
    });
  });

  it("rejects malformed doctor endpoint overrides", () => {
    const result = run(["doctor", "--semif-url", "not-a-url"]);

    expect(result.status).toBe(2);
    expect(result.stderr).toContain("Invalid SemIf URL");
  });

  it("accepts the JevRev API key environment name", () => {
    const env = { ...process.env, JEVREV_JEV_API_KEY: "test-key" };
    delete env.TYPESAFE_API_KEY;
    const result = run(
      ["run", "--input", request, "--jev-url", "not-a-url"],
      undefined,
      env,
    );

    expect(result.status).toBe(3);
    expect(result.stderr).toContain("provider error");
  });

  it("writes a JSON handoff to --output without contaminating stdout", () => {
    const output = resolve(root, "tests", "tmp-result.json");
    const result = run([
      "run",
      "--input",
      request,
      "--replay",
      replay,
      "--output",
      output,
    ]);

    try {
      expect(result.status).toBe(0);
      expect(result.stdout).toBe("");
      expect(JSON.parse(readFileSync(output, "utf8"))).toMatchObject({
        run_id: expect.stringMatching(/^jvr_/),
      });
    } finally {
      rmSync(output, { force: true });
    }
  });

  it("reports an invalid local scorer URL as a provider failure", () => {
    const result = run([
      "rank",
      "--input",
      request,
      "--provider",
      "local",
      "--local-url",
      "not-a-url",
    ]);

    expect(result.status).toBe(3);
    expect(result.stderr).toContain("Invalid local scorer URL");
  });

  it("reads the default local scorer URL from the environment", () => {
    const result = run(
      ["rank", "--input", request, "--provider", "local"],
      undefined,
      { ...process.env, SPECJEV_LOCAL_URL: "from-environment" },
    );

    expect(result.status).toBe(3);
    expect(result.stderr).toContain("Invalid local scorer URL: from-environment");
  });

  it("accepts a SemIf URL override", () => {
    const result = run([
      "rank",
      "--input",
      request,
      "--provider",
      "semif",
      "--semif-url",
      "not-a-url",
    ]);

    expect(result.status).toBe(3);
    expect(result.stderr).toContain("Invalid SemIf server URL");
  });

  it("reports a missing input file as invalid input", () => {
    const result = run([
      "rank",
      "--input",
      resolve(root, "examples", "does-not-exist.json"),
      "--replay",
      replay,
    ]);

    expect(result.status).toBe(2);
    expect(result.stderr).toContain("Could not read");
  });

  it("returns exit code 2 for Commander usage errors", () => {
    const result = run(["run"]);

    expect(result.status).toBe(2);
    expect(result.stderr).toContain("required option");
  });
});
