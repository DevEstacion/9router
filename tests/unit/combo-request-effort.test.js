import { describe, expect, it } from "vitest";
import { handleComboChat } from "../../open-sse/services/combo.js";
import { getModelUpstreamId } from "../../open-sse/config/providerModels.js";
import { translateRequest } from "../../open-sse/translator/index.js";
import { CodexExecutor } from "../../open-sse/executors/codex.js";

const models = ["cx/gpt-6-sol", "gcli/grok-4.6", "xai/grok-4.6", "agy/gemini-3.8-flash-high"];
const log = { info() {}, warn() {} };

describe("request-controlled effort across grok-main fallbacks", () => {
  it.each(["low", "high"])("retains %s across fallback and Codex/xAI translation", async (effort) => {
    const attempted = [];
    const body = {
      model: "grok-main",
      messages: [{ role: "user", content: "hello" }],
      reasoning_effort: effort,
      stream: false,
    };
    const response = await handleComboChat({
      body,
      models,
      comboName: "grok-main",
      comboStrategy: "fallback",
      sourceFormat: "openai",
      stream: false,
      log,
      handleSingleModel: async (request, model) => {
        attempted.push([model, request.reasoning_effort]);
        return model === "xai/grok-4.6"
          ? new Response("ok")
          : new Response(JSON.stringify({ error: { message: "upstream unavailable" } }), { status: 503 });
      },
    });
    expect(response.ok).toBe(true);
    expect(attempted).toEqual(models.slice(0, 3).map((model) => [model, effort]));

    const codex = new CodexExecutor().transformRequest("gpt-6-sol", {
      model: "gpt-6-sol",
      input: "hello",
      reasoning_effort: effort,
    });
    expect(codex.reasoning.effort).toBe(effort);

    const xai = translateRequest("openai", "openai", getModelUpstreamId("xai", "grok-4.6"), body, false, {}, "xai");
    expect(xai.reasoning_effort).toBe(effort);
  });
});
