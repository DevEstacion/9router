import { describe, it, expect } from "vitest";
import { normalizeThinkingConfig } from "../../open-sse/services/provider.js";
import { getModelInfoCore } from "../../open-sse/services/model.js";
import { getModelUpstreamId } from "../../open-sse/config/providerModels.js";
import { translateRequest } from "../../open-sse/translator/index.js";
import { stripThinkingSuffix } from "../../open-sse/translator/concerns/thinkingUnified.js";
import { DefaultExecutor } from "../../open-sse/executors/default.js";

describe("xAI Grok hyphenated effort aliases", () => {
  it.each(["none", "minimal", "low", "medium", "high", "xhigh"])("maps grok-4.6-%s to grok-4.6 plus reasoning_effort", async (effort) => {
    const { provider, model } = await getModelInfoCore(`xai/grok-4.6-${effort}`);
    expect(provider).toBe("xai");
    const upstreamModel = getModelUpstreamId(provider, model);
    expect(upstreamModel).toBe(`grok-4.6(${effort})`);
    const translated = translateRequest("openai", "openai", upstreamModel, {
      model,
      messages: [{ role: "user", content: "hello" }],
      max_tokens: 100,
      stream: false,
    }, false, {}, provider);
    translated.model = stripThinkingSuffix(upstreamModel);
    const outbound = new DefaultExecutor(provider).transformRequest(model, translated);
    expect(outbound.model).toBe("grok-4.6");
    expect(outbound.reasoning_effort).toBe(effort);
  });

  it.each(["openai", "claude", "openai-responses"])("resolves grok-4.6-medium through %s translation and default dispatch", async (format) => {
    const { provider, model } = await getModelInfoCore("xai/grok-4.6-medium");
    expect(provider).toBe("xai");
    const upstreamModel = getModelUpstreamId(provider, model);
    expect(upstreamModel).toBe("grok-4.6(medium)");
    const body = format === "openai-responses"
      ? { model, input: "hello", stream: false }
      : { model, messages: [{ role: "user", content: "hello" }], max_tokens: 100, stream: false };
    const translated = translateRequest(format, "openai", upstreamModel, body, false, {}, provider);
    translated.model = stripThinkingSuffix(upstreamModel);
    const executor = new DefaultExecutor(provider);
    const outbound = executor.transformRequest(model, translated);
    expect(outbound.model).toBe("grok-4.6");
    expect(outbound.reasoning_effort).toBe("medium");
    expect(outbound.messages).toEqual([{
      role: "user",
      content: format === "openai-responses" ? [{ type: "text", text: "hello" }] : "hello",
    }]);
    expect(executor.buildUrl(model, false)).toBe("https://api.x.ai/v1/chat/completions");
  });

  it("maps grok-4.5 hyphenated efforts and preserves parenthesized overrides", () => {
    expect(getModelUpstreamId("xai", "grok-4.5-low")).toBe("grok-4.5(low)");
    expect(getModelUpstreamId("xai", "grok-4.6-medium(high)")).toBe("grok-4.6(high)");
    const body = translateRequest("openai", "openai", "grok-4.6(high)", {
      messages: [{ role: "user", content: "hello" }],
      reasoning_effort: "low",
    }, false, {}, "xai");
    expect(body.reasoning_effort).toBe("high");
  });

  it("leaves base models, non-effort suffixes, and other providers unchanged", () => {
    expect(getModelUpstreamId("xai", "grok-4.6")).toBe("grok-4.6");
    expect(getModelUpstreamId("xai", "grok-4.6(medium)")).toBe("grok-4.6(medium)");
    expect(getModelUpstreamId("xai", "grok-4-fast-reasoning")).toBe("grok-4-fast-reasoning");
    expect(getModelUpstreamId("openai", "grok-4.6-low")).toBe("grok-4.6-low");
    expect(getModelUpstreamId("gcli", "grok-4.6-medium")).toBe("grok-4.6-medium");
    expect(getModelUpstreamId("gcli", "grok-4.5-medium")).toBe("grok-4.5");
  });
});

describe("normalizeThinkingConfig", () => {
  it("keeps openai reasoning_effort on non-user turns", () => {
    const body = {
      messages: [{ role: "assistant", content: "ok" }],
      reasoning_effort: "xhigh",
      thinking: { type: "enabled" },
    };

    normalizeThinkingConfig(body);

    expect(body.reasoning_effort).toBe("xhigh");
    expect(body.thinking).toBeUndefined();
  });
});
