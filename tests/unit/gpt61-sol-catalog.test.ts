import test from "node:test";
import assert from "node:assert/strict";

import { getModelsByProviderId } from "../../open-sse/config/providerModels.ts";
import { CodexExecutor } from "../../open-sse/executors/codex.ts";
import { openaiToOpenAIResponsesRequest } from "../../open-sse/translator/request/openai-responses/toResponses.ts";
import { getPricingForModel } from "../../src/shared/constants/pricing.ts";
import { getModelSpec, capMaxOutputTokens } from "../../src/shared/constants/modelSpecs.ts";
import {
  computeCostFromPricing,
  getCodexFastCostMultiplier,
} from "../../src/lib/usage/costCalculator.ts";
import { extendCodexGpt56EffortValues } from "../../src/shared/reasoning/effortStandardization.ts";
import { isCodexExtendedEffortBaseModel } from "../../src/shared/reasoning/codexExtendedEffort.ts";
import * as reasoningMetadata from "../../src/lib/vscode/reasoningMetadata.ts";
import { supportsVscodeServiceTierVariants } from "../../src/lib/vscode/serviceTierVariants.ts";

const MODEL = "gpt-6.1-sol";
const EFFORTS = ["low", "medium", "high", "xhigh", "max", "ultra"];
const IDS = [MODEL, ...EFFORTS.map((effort) => `${MODEL}-${effort}`)];

test.after(async () => {
  const { resetDbInstance } = await import("../../src/lib/db/core.ts");
  resetDbInstance();
});

type ResponsesBody = Record<string, unknown> & {
  reasoning?: { effort?: string; summary?: string };
};

function transform(model: string, body: Record<string, unknown> = {}): ResponsesBody {
  return new CodexExecutor().transformRequest(model, { model, input: [], ...body }, false, {
    requestEndpointPath: "/responses",
  }) as ResponsesBody;
}

test("GPT-6.1 Sol has separate API and Codex catalog limits", () => {
  for (const provider of ["codex", "codex-app-server"]) {
    const entries = getModelsByProviderId(provider).filter((entry) => entry.id.startsWith(MODEL));
    assert.deepEqual(entries.map((entry) => entry.id).sort(), [...IDS].sort());
    for (const entry of entries) {
      assert.equal(entry.contextLength, 872000);
      assert.equal(entry.maxInputTokens, 872000);
      assert.equal(entry.maxOutputTokens, 128000);
      assert.equal(entry.targetFormat, "openai-responses");
      assert.equal(entry.supportsVision, true);
      assert.equal(entry.supportsReasoning, true);
      assert.equal(entry.toolCalling, true);
    }
  }
  const api = getModelsByProviderId("openai").find((entry) => entry.id === MODEL);
  assert.ok(api);
  assert.equal(api.contextLength, 1050000);
  assert.equal(api.maxOutputTokens, 128000);
  assert.equal(api.targetFormat, "openai-responses");
  assert.deepEqual(api.supportedThinkingEfforts, EFFORTS.slice(0, -1));
  assert.equal(getModelSpec(`openai/${MODEL}`)?.contextWindow, 1050000);
  assert.equal(capMaxOutputTokens(MODEL, 200000), 128000);
});

test("GPT-6.1 Sol aliases and chat translation preserve max on the Codex wire", () => {
  for (const effort of EFFORTS) {
    const result = transform(`${MODEL}-${effort}`);
    assert.equal(result.model, MODEL);
    assert.equal(result.reasoning.effort, effort === "ultra" ? "max" : effort);
  }
  for (const effort of ["max", "ultra"]) {
    assert.equal(isCodexExtendedEffortBaseModel(`cx/${MODEL}`, effort as "max" | "ultra"), true);
    const result = transform(`${MODEL}(${effort})`, { reasoning: { summary: "detailed" } });
    assert.equal(result.model, MODEL);
    assert.equal(result.reasoning.effort, "max");
    assert.equal(result.reasoning.summary, "detailed");
  }
  const translated = openaiToOpenAIResponsesRequest(
    MODEL,
    {
      model: MODEL,
      messages: [{ role: "user", content: "test" }],
      reasoning_effort: "max",
    },
    true,
    {}
  ) as ResponsesBody;
  assert.equal(translated.reasoning.effort, "max");
  assert.equal(transform(MODEL, translated).reasoning.effort, "max");
});

test("GPT-6.1 Sol honors discovered Codex defaults without changing explicit effort or older models", () => {
  const executor = new CodexExecutor();
  const credentials = {
    requestEndpointPath: "/responses",
    providerSpecificData: {
      _omnirouteCodexThinking: {
        model: MODEL,
        supportedThinkingEfforts: EFFORTS,
        defaultThinkingEffort: "low",
      },
    },
  };
  const defaulted = executor.transformRequest(MODEL, { model: MODEL, input: [] }, false, credentials) as ResponsesBody;
  assert.equal(defaulted.reasoning.effort, "low");
  const explicit = executor.transformRequest(
    MODEL,
    { model: MODEL, input: [], reasoning: { effort: "high" } },
    false,
    credentials
  ) as ResponsesBody;
  assert.equal(explicit.reasoning.effort, "high");
  assert.equal(transform("gpt-6-sol").reasoning.effort, "medium");
  for (const provider of ["codex", "cx"]) {
    assert.deepEqual(extendCodexGpt56EffortValues(provider, MODEL, ["none", "high"]), EFFORTS);
    const model = {
      id: `${provider}/${MODEL}`,
      owned_by: provider,
      capabilities: { reasoning: true },
    };
    assert.deepEqual(reasoningMetadata.getReasoningEffortValues(model), EFFORTS);
    assert.equal(reasoningMetadata.getDefaultReasoningEffort(model), "low");
    assert.equal(reasoningMetadata.getReasoningVariantBaseModelId(`${model.id}-ultra`), model.id);
    assert.equal(supportsVscodeServiceTierVariants(model), true);
  }
  assert.deepEqual(extendCodexGpt56EffortValues("kiro", MODEL, ["high"]), ["high"]);
  assert.deepEqual(
    extendCodexGpt56EffortValues("openai", MODEL, ["low", "medium", "high", "xhigh", "max"]),
    EFFORTS.slice(0, -1)
  );
});

test("GPT-6.1 Sol USD pricing uses the current Standard and purchased-credit Fast rates", () => {
  for (const [provider, ids] of [
    ["openai", [MODEL]],
    ["cx", IDS],
  ] as const) {
    for (const id of ids) {
      const price = getPricingForModel(provider, id);
      assert.ok(price, `${provider}/${id}`);
      assert.equal(price.input, 2);
      assert.equal(price.cached, 0.1);
      assert.equal(price.output, 10);
      assert.equal(price.reasoning, 10);
      if (provider === "openai") assert.equal(price.cache_creation, 2.5);
      assert.equal(getCodexFastCostMultiplier(provider, id, "priority"), provider === "cx" ? 2 : 1);
    }
  }
  assert.equal(getCodexFastCostMultiplier("codex", `${MODEL}-ultra`, "fast"), 2);
  assert.equal(getCodexFastCostMultiplier("codex", MODEL, "default"), 1);
  const price = getPricingForModel("cx", MODEL);
  assert.ok(price);
  // 500 uncached input + 500 cached input + 100 output = $0.00205, Fast = $0.0041.
  const tokens = { prompt_tokens: 1000, cached_tokens: 500, completion_tokens: 100 };
  assert.ok(
    Math.abs(
      computeCostFromPricing(price, tokens, {
        provider: "codex",
        model: MODEL,
        serviceTier: "priority",
      }) - 0.0041
    ) < 1e-12
  );
});

test("Responses Lite keeps delegation for GPT-6.1 Sol ultra only", async () => {
  for (const effort of ["ultra", "max"]) {
    const captured: Record<string, unknown>[] = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (_url, init) => {
      captured.push(JSON.parse(String(init?.body || "{}")));
      return new Response(JSON.stringify({ id: "resp_test", object: "response" }), {
        headers: { "Content-Type": "application/json" },
      });
    };
    try {
      await new CodexExecutor().execute({
        model: `${MODEL}-${effort}`,
        body: {
          model: `${MODEL}-${effort}`,
          input: [],
          _nativeCodexPassthrough: true,
          parallel_tool_calls: true,
        },
        stream: true,
        credentials: { accessToken: "test-token" },
        clientHeaders: { "X-OpenAI-Internal-Codex-Responses-Lite": "true" },
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
    assert.equal(captured.length, 1);
    assert.equal(captured[0].model, MODEL);
    assert.equal(captured[0].parallel_tool_calls, effort === "ultra");
  }
});
