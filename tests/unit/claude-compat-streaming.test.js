import { describe, expect, it, vi } from "vitest";

const { createSSETransformStreamWithLogger } = vi.hoisted(() => ({
  createSSETransformStreamWithLogger: vi.fn(() => new TransformStream()),
}));

vi.mock("../../open-sse/config/providers.js", () => ({
  PROVIDERS: {
    codex: { format: "openai-responses" },
    openai: { format: "openai" },
  },
}));

vi.mock("../../open-sse/translator/index.js", () => ({
  needsTranslation: () => true,
}));

vi.mock("../../open-sse/utils/stream.js", () => ({
  createSSETransformStreamWithLogger,
  createPassthroughStreamWithLogger: vi.fn(),
}));

vi.mock("../../open-sse/utils/streamHandler.js", () => ({
  pipeWithDisconnect: () => new ReadableStream(),
}));

vi.mock("../../open-sse/handlers/chatCore/requestDetail.js", () => ({
  buildRequestDetail: vi.fn(() => ({})),
  extractRequestConfig: vi.fn(() => ({})),
  saveUsageStats: vi.fn(),
  formatDoneLine: vi.fn(),
}));

vi.mock("@/lib/usageDb.js", () => ({
  saveRequestDetail: vi.fn(async () => {}),
}));

const { handleStreamingResponse } = await import("../../open-sse/handlers/chatCore/streamingHandler.js");

function streamingContext({ provider, targetFormat }) {
  return {
    providerResponse: new Response("", { headers: { "content-type": "text/event-stream" } }),
    provider,
    model: "test-model",
    sourceFormat: "claude",
    targetFormat,
    body: { system: [{ type: "text", text: "regular Claude request" }] },
    stream: true,
    requestStartTime: Date.now(),
    connectionId: "test-connection",
    claudeClassifierCompat: "always",
  };
}

describe("streaming Claude classifier compatibility plumbing", () => {
  it("forwards compat after existing PXPIPE factory args for Responses translation", async () => {
    await handleStreamingResponse(streamingContext({ provider: "codex", targetFormat: "openai-responses" }));

    expect(createSSETransformStreamWithLogger).toHaveBeenCalledWith(
      "openai-responses", "claude", "codex", undefined, undefined, "test-model", "test-connection",
      expect.any(Object), undefined, undefined, "always",
    );
  });

  it("forwards compat after existing PXPIPE factory args for normal translation", async () => {
    await handleStreamingResponse(streamingContext({ provider: "openai", targetFormat: "openai" }));

    expect(createSSETransformStreamWithLogger).toHaveBeenCalledWith(
      "openai", "claude", "openai", undefined, undefined, "test-model", "test-connection",
      expect.any(Object), undefined, undefined, "always",
    );
  });
});
