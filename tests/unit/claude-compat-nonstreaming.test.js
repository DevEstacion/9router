import { describe, it, expect, vi, beforeEach } from "vitest";
import { FORMATS } from "../../open-sse/translator/formats.js";

const { executeMock } = vi.hoisted(() => ({
  executeMock: vi.fn(),
}));

vi.mock("../../open-sse/executors/index.js", () => ({
  getExecutor: () => ({
    noAuth: true,
    execute: executeMock,
  }),
}));

vi.mock("../../open-sse/utils/requestLogger.js", () => ({
  createRequestLogger: async () => ({
    logClientRawRequest: vi.fn(),
    logRawRequest: vi.fn(),
    logTargetRequest: vi.fn(),
    logProviderResponse: vi.fn(),
    logConvertedResponse: vi.fn(),
    logError: vi.fn(),
  }),
}));

vi.mock("@/lib/usageDb.js", () => ({
  trackPendingRequest: vi.fn(),
  appendRequestLog: vi.fn(async () => {}),
  saveRequestDetail: vi.fn(async () => {}),
}));

vi.mock("../../open-sse/handlers/chatCore/requestDetail.js", async () => {
  const actual = await vi.importActual("../../open-sse/handlers/chatCore/requestDetail.js");
  return {
    ...actual,
    saveUsageStats: vi.fn(),
  };
});

const { handleChatCore } = await import("../../open-sse/handlers/chatCore.js");

describe("handleChatCore Claude classifier compat non-streaming", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    const sse = [
      'event: response.created',
      'data: {"type":"response.created","response":{"id":"resp_compat_nonstream","object":"response","created_at":1,"status":"in_progress"}}',
      '',
      'event: response.output_item.done',
      'data: {"type":"response.output_item.done","output_index":0,"item":{"type":"reasoning","summary":[{"type":"summary_text","text":"internal reasoning that should be suppressed"}]}}',
      '',
      'event: response.output_item.done',
      'data: {"type":"response.output_item.done","output_index":1,"item":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"<block>no</block>"}]}}',
      '',
      'event: response.completed',
      'data: {"type":"response.completed","response":{"id":"resp_compat_nonstream","status":"completed","usage":{"input_tokens":10,"output_tokens":5,"total_tokens":15}}}',
      '',
      'data: [DONE]',
      ''
    ].join("\n");
    executeMock.mockResolvedValue({
      response: new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } }),
      url: "https://chatgpt.com/backend-api/codex/responses",
      headers: {},
      transformedBody: null,
    });
  });

  it("returns a Claude message object without thinking blocks for non-streaming classifier compatibility responses", async () => {
    const log = { debug: vi.fn(), info: vi.fn(), warn: vi.fn() };

    const result = await handleChatCore({
      body: {
        model: "auto-xhigh",
        stream: false,
        system: [{ type: "text", text: "You are a security monitor for autonomous AI coding agents." }],
        stop_sequences: ["</block>"],
        messages: [{ role: "user", content: [{ type: "text", text: "<transcript>...</transcript>" }] }],
      },
      modelInfo: { provider: "codex", model: "gpt-5.4-high" },
      credentials: { apiKey: "test-key", providerSpecificData: {} },
      log,
      connectionId: "test-conn",
      headroomEnabled: false,
      headroomUrl: "http://localhost:8787",
      headroomCompressUserMessages: false,
      rtkEnabled: false,
      cavemanEnabled: false,
      ponytailEnabled: false,
      claudeClassifierCompat: "always",
      sourceFormatOverride: FORMATS.CLAUDE,
      clientRawRequest: {
        endpoint: "/v1/messages",
        body: {},
        headers: { accept: "application/json" },
      },
    });

    expect(result.success).toBe(true);
    const payload = await result.response.json();
    expect(payload.type).toBe("message");
    expect(payload.content.some((block) => block.type === "thinking")).toBe(false);
    expect(payload.content.some((block) => block.type === "text" && block.text === "<block>no</block>")).toBe(true);
  });
});
