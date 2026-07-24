import { describe, expect, it } from "vitest";
import { inspectGrokWire } from "../../open-sse/executors/codex.js";

function streamFromText(text) {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(text));
      controller.close();
    },
  });
}

describe("Codex Grok wire debug", () => {
  it("replays every inspected stream byte", async () => {
    const text = "event: response.completed\ndata: {\"secret\":\"not logged\"}\n\n";
    const source = new Response(streamFromText(text), {
      headers: { "Content-Type": "text/event-stream" },
    });

    const inspected = await inspectGrokWire(source, {
      model: "grok-high",
      url: "https://example.test/responses",
      bodyBytes: 12,
      inputItems: 1,
      toolCount: 0,
    });

    await expect(inspected.text()).resolves.toBe(text);
  });
});
