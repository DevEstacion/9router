import { describe, expect, it } from "vitest";

import { handleComboChat } from "../../open-sse/services/combo.js";

const log = { info() {}, warn() {} };
const failedModel = async () => new Response(
  JSON.stringify({ error: { message: "context limit" } }),
  { status: 400, statusText: "Bad Request", headers: { "Content-Type": "application/json" } },
);

describe("combo Responses terminal failure", () => {
  it("emits response.failed SSE for streamed Responses requests", async () => {
    const result = await handleComboChat({
      body: {},
      models: ["broken/model"],
      sourceFormat: "openai-responses",
      stream: true,
      handleSingleModel: failedModel,
      log,
    });

    expect(result.status).toBe(200);
    expect(result.headers.get("content-type")).toContain("text/event-stream");
    const body = await result.text();
    expect(body).toContain("event: response.failed");
    expect(body).toMatch(/"id":"resp_/);
    expect(body).toContain('"message":"context limit"');
    expect(body).toContain("data: [DONE]");
  });

  it("keeps generic JSON failure for non-stream Responses requests", async () => {
    const result = await handleComboChat({
      body: {},
      models: ["broken/model"],
      sourceFormat: "openai-responses",
      stream: false,
      handleSingleModel: failedModel,
      log,
    });

    expect(result.status).toBe(400);
    expect(result.headers.get("content-type")).toContain("application/json");
    await expect(result.json()).resolves.toEqual({ error: { message: "context limit" } });
  });
});
