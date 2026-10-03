import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../open-sse/utils/proxyFetch.js", () => ({
  proxyAwareFetch: vi.fn(),
}));

import { proxyAwareFetch } from "../../open-sse/utils/proxyFetch.js";
import { getUsageForProvider } from "../../open-sse/services/usage.js";
import { parseQuotaData } from "@/app/(dashboard)/dashboard/usage/components/ProviderLimits/utils.js";
import { getAgyCliUserAgent, AGY_CLI_VERSION, AGY_CLI_CL } from "../../open-sse/providers/shared.js";
import { PROVIDERS } from "../../open-sse/config/providers.js";
import { AGY_CONFIG } from "../../src/lib/oauth/constants/oauth.js";
import { AntigravityExecutor } from "../../open-sse/executors/antigravity.js";
import { rewriteAntigravityUserAgent } from "../../src/mitm/antigravityIdeVersion.js";

describe("Antigravity CLI (agy) Traffic & Request Signature", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

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
    // Upstream rejects requestType="agent" with false 429 RESOURCE_EXHAUSTED.
    expect(transformed.requestType).toBeUndefined();
    expect(transformed.requestId).toMatch(/^agent\/[a-f0-9-]+\/\d+\/[a-f0-9-]+\/\d+$/);

    // Nested request labels verification
    expect(transformed.request.labels).toBeDefined();
    expect(transformed.request.labels.last_step_index).toBe("0");
    expect(transformed.request.labels.model_enum).toBe("MODEL_PLACEHOLDER_M320");
    expect(transformed.request.labels.used_claude).toBe("false");
    expect(transformed.request.labels.used_non_gemini_model).toBe("false");
    expect(transformed.request.labels.trajectory_id).toBeDefined();
  });

  it("uses connection projectId for Agy usage", async () => {
    proxyAwareFetch.mockResolvedValueOnce(new Response(JSON.stringify({ models: {} }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }));

    await getUsageForProvider({
      provider: "agy",
      accessToken: "ya29.test",
      projectId: "stored-project",
      providerSpecificData: { tierId: "pro-tier" },
    });

    expect(proxyAwareFetch).toHaveBeenCalledWith(
      "https://daily-cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary",
      expect.objectContaining({ body: JSON.stringify({ project: "stored-project" }) }),
      null
    );
  });

  it("renders Agy grouped quota summary as four session and weekly bars", async () => {
    proxyAwareFetch.mockResolvedValueOnce(new Response(JSON.stringify({
      groups: [
        { displayName: "Gemini Models", buckets: [
          { window: "weekly", remainingFraction: 0.75, resetTime: "2026-10-10T08:38:23Z" },
          { window: "5h", remainingFraction: 0.5, resetTime: "2026-10-04T00:02:37Z" },
        ] },
        { displayName: "Claude and GPT models", buckets: [
          { window: "weekly", remainingFraction: 1, resetTime: "2026-10-10T19:09:44Z" },
          { window: "5h", remainingFraction: 0, resetTime: "2026-10-04T00:09:44Z" },
        ] },
      ],
    }), { status: 200, headers: { "Content-Type": "application/json" } }));

    const usage = await getUsageForProvider({
      provider: "agy", accessToken: "ya29.test", providerSpecificData: { tierId: "free-tier" },
    });
    const rows = parseQuotaData("agy", usage);
    expect(rows).toHaveLength(4);
    expect(rows.every((row) => row.percentageOnly === true)).toBe(true);
    expect(Object.fromEntries(rows.map((row) => [row.name, row.remainingPercentage]))).toEqual({
      "Gemini (5h)": 50,
      "Gemini (Weekly)": 75,
      "Claude & GPT (5h)": 0,
      "Claude & GPT (Weekly)": 100,
    });
    expect(rows.find((row) => row.name === "Gemini (5h)").resetAt).toBe("2026-10-04T00:02:37.000Z");
  });

  it("uses the Agy project fallback instead of a random project ID", () => {
    const executor = new AntigravityExecutor("agy");
    const transformed = executor.transformRequest(
      "gemini-3.8-flash-low",
      {
        model: "gemini-3.8-flash-low",
        request: { contents: [{ role: "user", parts: [{ text: "Hello" }] }] },
      },
      true,
      { accessToken: "ya29.test", email: "test@example.com" }
    );

    expect(transformed.project).toBe("aicode-consumers");
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
