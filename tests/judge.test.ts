import { describe, expect, it } from "vitest";
import { ProtocolError, ProviderError } from "../src/domain/errors.js";
import {
  LocalJudge,
  ReplayJudge,
  SemIfJudge,
  type SemIfChatRequest,
  TypeSafeJudge,
  type LocalScoreRequest,
} from "../src/judge.js";
import { buildQuestionPlan } from "../src/questions.js";
import { makeResponse, minimalRequest } from "./fixtures.js";

describe("judge adapters", () => {
  it("replays a complete captured response", async () => {
    const plan = buildQuestionPlan(minimalRequest);
    const response = makeResponse(plan);
    const replay = {
      ...response,
      candidate_order: [...plan.candidateIds],
    };

    await expect(new ReplayJudge(replay).evaluate(plan)).resolves.toEqual(response);
  });

  it("rejects a response with a missing answer", async () => {
    const plan = buildQuestionPlan(minimalRequest);
    const response = makeResponse(plan);
    delete response.answers[Object.keys(response.answers)[0]!];
    const replay = {
      ...response,
      candidate_order: [...plan.candidateIds],
    };

    await expect(new ReplayJudge(replay).evaluate(plan)).rejects.toBeInstanceOf(
      ProtocolError,
    );
  });

  it("rejects a response with an unexpected answer", async () => {
    const plan = buildQuestionPlan(minimalRequest);
    const response = makeResponse(plan);
    response.answers.unexpected = { type: "noul", noul: 0.5 };
    const replay = {
      ...response,
      candidate_order: [...plan.candidateIds],
    };

    await expect(new ReplayJudge(replay).evaluate(plan)).rejects.toBeInstanceOf(
      ProtocolError,
    );
  });

  it("rejects a replay fixture without candidate order metadata", async () => {
    const plan = buildQuestionPlan(minimalRequest);
    const response = makeResponse(plan);

    await expect(new ReplayJudge(response).evaluate(plan)).rejects.toThrow(
      "candidate_order",
    );
  });

  it("rejects a replay fixture captured with a different candidate order", async () => {
    const plan = buildQuestionPlan(minimalRequest);
    const response = makeResponse(plan);
    const replay = {
      ...response,
      candidate_order: ["byte-fast-path", "allocation-cut"],
    };

    await expect(new ReplayJudge(replay).evaluate(plan)).rejects.toThrow(
      "does not match the request",
    );
  });

  it("passes the full plan to the configured client", async () => {
    const plan = buildQuestionPlan(minimalRequest);
    const response = makeResponse(plan);
    const calls: unknown[] = [];
    const client = {
      async systemOne(request: unknown) {
        calls.push(request);
        return response;
      },
    };

    await new TypeSafeJudge({ client, model: "jev-test" }).evaluate(plan);

    expect(calls).toEqual([
      { state: plan.state, questions: plan.questions, model: "jev-test" },
    ]);
  });

  it("forwards an explicit Jev API root to the official client", async () => {
    const plan = buildQuestionPlan(minimalRequest);
    const response = makeResponse(plan);
    let capturedUrl = "";
    const fetch = async (input: string | URL | Request) => {
      capturedUrl = String(input);
      return new Response(JSON.stringify(response), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };
    await expect(
      new TypeSafeJudge({
        apiKey: "test-key",
        baseUrl: "https://jev.example.test",
        fetch,
      }).evaluate(plan),
    ).resolves.toEqual(response);
    expect(capturedUrl).toBe("https://jev.example.test/v1/systemone");
  });

  it("maps SDK client failures to a provider error", async () => {
    const plan = buildQuestionPlan(minimalRequest);
    const client = {
      async systemOne() {
        throw new Error("network down");
      },
    };

    await expect(new TypeSafeJudge({ client }).evaluate(plan)).rejects.toBeInstanceOf(
      ProviderError,
    );
  });

  it("maps one local batch into the existing judge response", async () => {
    const plan = buildQuestionPlan(minimalRequest);
    let capturedUrl = "";
    let capturedRequest: LocalScoreRequest | undefined;
    const fetch = async (input: string | URL | Request, init?: RequestInit) => {
      capturedUrl = String(input);
      capturedRequest = JSON.parse(String(init?.body)) as LocalScoreRequest;
      return new Response(
        JSON.stringify({
          model: "local-jev-test",
          device: "cpu",
          scores: capturedRequest.items.map(({ id }) => ({
            id,
            score: id === "candidate_0_goal_fit" ? 0.5 : 0.8,
          })),
          input_tokens: 187,
          duration_ms: 12.5,
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    };

    const response = await new LocalJudge({ fetch }).evaluate(plan);

    expect(capturedUrl).toBe("http://127.0.0.1:4877/v1/score");
    expect(capturedRequest?.batch_size).toBe(8);
    expect(capturedRequest?.items).toHaveLength(11);
    expect(capturedRequest?.items.map(({ id }) => id)).toContain(
      "candidate_0_execution_readiness",
    );
    expect(capturedRequest?.items.map(({ id }) => id)).not.toContain(
      "candidate_0_execution_value",
    );
    expect(capturedRequest?.items.map(({ id }) => id)).toContain("pair_0_1_duplicate");
    expect(capturedRequest?.items[0]?.query).toContain("Make a parser faster");
    expect(capturedRequest?.items[0]?.document).toContain("Reduce allocations");
    expect(
      capturedRequest?.items.every(
        ({ instruction }) =>
          instruction.startsWith("Judge whether") && instruction.includes("Answer yes"),
      ),
    ).toBe(true);

    expect(response).toMatchObject({
      model: "local-jev-test",
      usage: { input_tokens: 187, output_tokens: 0 },
      answers: {
        candidate_0_constraint_fit: { type: "noul", noul: 0.8 },
        candidate_0_execution_value: { type: "noul", noul: 0.8 },
        pair_0_1_duplicate: { type: "noul", noul: 0.8 },
      },
    });
    const goalFit = response.answers.candidate_0_goal_fit;
    expect(goalFit?.type).toBe("score");
    if (goalFit?.type === "score") {
      expect(goalFit.score).toBeCloseTo(1.5);
      expect(goalFit.confidence).toBe(0);
    }
  });

  it("rejects missing local scorer results", async () => {
    const plan = buildQuestionPlan(minimalRequest);
    const fetch = async (_input: string | URL | Request, init?: RequestInit) => {
      const request = JSON.parse(String(init?.body)) as LocalScoreRequest;
      const scores = request.items.slice(1).map(({ id }) => ({ id, score: 0.8 }));
      return new Response(
        JSON.stringify({
          model: "local-jev-test",
          device: "cpu",
          count: scores.length,
          scores,
        }),
      );
    };

    await expect(new LocalJudge({ fetch }).evaluate(plan)).rejects.toBeInstanceOf(
      ProtocolError,
    );
  });

  it("maps local HTTP failures to a provider error", async () => {
    const plan = buildQuestionPlan(minimalRequest);
    const fetch = async () => new Response("unavailable", { status: 503 });

    await expect(new LocalJudge({ fetch }).evaluate(plan)).rejects.toBeInstanceOf(
      ProviderError,
    );
  });

  it("times out a local scorer that never completes", async () => {
    const plan = buildQuestionPlan(minimalRequest);
    const fetch = async (_input: string | URL | Request, init?: RequestInit) =>
      new Promise<Response>((_, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      });

    await expect(new LocalJudge({ fetch, timeoutMs: 10 }).evaluate(plan))
      .rejects.toThrow("timed out after 10ms");
  });

  it("maps SemIf option logits into score and noul answers", async () => {
    const plan = buildQuestionPlan(minimalRequest);
    const requests: SemIfChatRequest[] = [];
    const fetch = async (_input: string | URL | Request, init?: RequestInit) => {
      const request = JSON.parse(String(init?.body)) as SemIfChatRequest;
      requests.push(request);
      const payload = JSON.parse(request.messages[1]!.content) as {
        options: Array<{ letter: string }>;
      };
      const best = payload.options.length === 2 ? "A" : "C";
      return new Response(
        JSON.stringify({
          model: "semif-test",
          choices: [
            {
              logprobs: {
                content: [
                  {
                    token: best,
                    top_logprobs: payload.options.map(({ letter }) => ({
                      token: letter,
                      logprob: letter === best ? 0 : -2,
                    })),
                  },
                ],
              },
            },
          ],
          usage: { prompt_tokens: 42, completion_tokens: 1 },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    };

    const response = await new SemIfJudge({ fetch }).evaluate(plan);

    expect(requests).toHaveLength(Object.keys(plan.expectedTypes).length);
    expect(requests[0]).toMatchObject({
      model: "Qwen3.5-4B-Q4_K_M",
      max_tokens: 1,
      temperature: 0,
      logprobs: true,
      top_logprobs: 20,
      chat_template_kwargs: { enable_thinking: false },
    });
    expect(requests[0]?.messages[0]?.content).toContain("Choose exactly one");
    const constraintPayload = JSON.parse(requests[1]!.messages[1]!.content) as {
      evidence: Record<string, unknown>;
      criterion: { decision_rule?: string };
    };
    expect(constraintPayload.evidence).toHaveProperty("hard_constraints");
    expect(constraintPayload.evidence).toHaveProperty("candidate");
    expect(constraintPayload.evidence).not.toHaveProperty("candidate_index");
    expect(constraintPayload.criterion.decision_rule).toContain(
      "does not violate any listed hard constraint",
    );
    expect(response.model).toBe("semif-test");
    expect(response.usage).toEqual({
      input_tokens: 42 * requests.length,
      output_tokens: requests.length,
    });

    const goal = response.answers.candidate_0_goal_fit;
    expect(goal?.type).toBe("score");
    if (goal?.type === "score") {
      expect(goal.score).toBeGreaterThan(1.8);
      expect(goal.score).toBeLessThan(2.1);
      expect(goal.probabilities["2"]).toBeGreaterThan(0.7);
      expect(goal.legend["2"]).toContain("material contribution");
    }

    const constraint = response.answers.candidate_0_constraint_fit;
    expect(constraint).toMatchObject({ type: "noul" });
    if (constraint?.type === "noul") {
      expect(constraint.noul).toBeCloseTo(1 / (1 + Math.exp(-2)), 8);
    }
  });

  it("accepts a base URL that already ends in /v1", async () => {
    const plan = buildQuestionPlan(minimalRequest);
    let capturedUrl = "";
    const fetch = async (input: string | URL | Request) => {
      capturedUrl = String(input);
      return new Response(
        JSON.stringify({
          model: "semif-test",
          choices: [
            {
              logprobs: {
                content: [
                  {
                    token: "A",
                    top_logprobs: [
                      { token: "A", logprob: 0 },
                      { token: "B", logprob: -1 },
                      { token: "C", logprob: -1 },
                      { token: "D", logprob: -1 },
                    ],
                  },
                ],
              },
            },
          ],
        }),
        { status: 200 },
      );
    };

    await new SemIfJudge({ baseUrl: "http://localhost:4878/v1", fetch }).evaluate(plan);
    expect(capturedUrl).toBe("http://localhost:4878/v1/chat/completions");
  });

  it("normalizes the legacy local scorer base URL when it already ends in /v1", async () => {
    const plan = buildQuestionPlan(minimalRequest);
    let capturedUrl = "";
    const fetch = async (input: string | URL | Request, init?: RequestInit) => {
      capturedUrl = String(input);
      const request = JSON.parse(String(init?.body)) as {
        items: Array<{ id: string }>;
      };
      return new Response(
        JSON.stringify({
          model: "legacy-test",
          device: "cpu",
          scores: request.items.map((item) => ({
            id: item.id,
            score: 0.8,
          })),
        }),
        { status: 200 },
      );
    };

    await new LocalJudge({ baseUrl: "http://localhost:4877/v1", fetch }).evaluate(plan);
    expect(capturedUrl).toBe("http://localhost:4877/v1/score");
  });

  it("rejects SemIf responses that omit a declared option", async () => {
    const plan = buildQuestionPlan(minimalRequest);
    const fetch = async () =>
      new Response(
        JSON.stringify({
          model: "semif-test",
          choices: [
            {
              logprobs: {
                content: [
                  {
                    token: "A",
                    top_logprobs: [{ token: "A", logprob: 0 }],
                  },
                ],
              },
            },
          ],
        }),
        { status: 200 },
      );

    await expect(new SemIfJudge({ fetch }).evaluate(plan)).rejects.toBeInstanceOf(
      ProtocolError,
    );
  });
});
