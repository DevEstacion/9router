import { describe, it, expect } from "vitest";
import { getAgyCliUserAgent, AGY_CLI_VERSION, AGY_CLI_CL } from "../../open-sse/providers/shared.js";
import { PROVIDERS } from "../../open-sse/config/providers.js";
import { AGY_CONFIG } from "../../src/lib/oauth/constants/oauth.js";
import { AntigravityExecutor } from "../../open-sse/executors/antigravity.js";
import { rewriteAntigravityUserAgent } from "../../src/mitm/antigravityIdeVersion.js";

describe("Antigravity CLI (agy) Traffic & Request Signature", () => {
  it("formats getAgyCliUserAgent according to official aidev_client specification", () => {
    const ua = getAgyCliUserAgent();
    expect(ua).toMatch(
      /^antigravity\/cli\/1\.1\.27 \(aidev_client; os_type=(linux|darwin|windows); arch=(amd64|arm64|x64); cl=976543523; auth_method=consumer\)$/
    );
    expect(ua).toContain(`antigravity/cli/${AGY_CLI_VERSION}`);
    expect(ua).toContain(`cl=${AGY_CLI_CL}`);
    expect(ua).toContain("auth_method=consumer");
  });

  it("sets the agy provider User-Agent to the official CLI signature", () => {
    expect(PROVIDERS.agy.headers["User-Agent"]).toBe(getAgyCliUserAgent());
  });

  it("configures AGY_CONFIG to send official CLI metadata and User-Agent", () => {
    expect(AGY_CONFIG.loadCodeAssistUserAgent).toBe(getAgyCliUserAgent());
    expect(AGY_CONFIG.loadCodeAssistClientMetadata).toBe(
      JSON.stringify({ metadata: { ideType: "ANTIGRAVITY" } })
    );
  });

  it("ensures AntigravityExecutor('agy') includes labels and authentic agent structure", () => {
    const executor = new AntigravityExecutor("agy");
    const credentials = {
      accessToken: "ya29.test",
      projectId: "aicode-consumers",
      email: "test@example.com",
    };

    const transformed = executor.transformRequest(
      "gemini-3.8-flash-low",
      {
        model: "gemini-3.8-flash-low",
        request: {
          contents: [{ role: "user", parts: [{ text: "Hello" }] }],
        },
      },
      true,
      credentials
    );

    // Top-level structure verification
    expect(transformed.project).toBe("aicode-consumers");
    expect(transformed.model).toBe("gemini-3.8-flash-low");
    expect(transformed.userAgent).toBe("antigravity");
    expect(transformed.requestType).toBe("agent");
    expect(transformed.requestId).toMatch(/^agent\/[a-f0-9-]+\/\d+\/[a-f0-9-]+\/\d+$/);

    // Nested request labels verification
    expect(transformed.request.labels).toBeDefined();
    expect(transformed.request.labels.last_step_index).toBe("0");
    expect(transformed.request.labels.model_enum).toBe("MODEL_PLACEHOLDER_M320");
    expect(transformed.request.labels.used_claude).toBe("false");
    expect(transformed.request.labels.used_non_gemini_model).toBe("false");
    expect(transformed.request.labels.trajectory_id).toBeDefined();
  });

  it("preserves authentic agy CLI User-Agent in MITM rewrite without replacing with desktop version", () => {
    const agyUa = "antigravity/cli/1.1.27 (aidev_client; os_type=linux; arch=amd64; cl=976543523; auth_method=consumer)";
    const rewrittenAgy = rewriteAntigravityUserAgent(agyUa, "2.11.0");
    expect(rewrittenAgy).toBe(agyUa);

    // Desktop Antigravity User-Agent should still be rewritten
    const desktopUa = "antigravity/2.10.0 (linux; amd64)";
    const rewrittenDesktop = rewriteAntigravityUserAgent(desktopUa, "2.11.0");
    expect(rewrittenDesktop).toBe("antigravity/2.11.0 (linux; amd64)");
  });
});
