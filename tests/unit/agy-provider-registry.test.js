import { describe, it, expect } from "vitest";
import { PROVIDERS, PROVIDER_OAUTH } from "../../open-sse/config/providers.js";
import { PROVIDER_MODELS } from "../../open-sse/providers/index.js";
import { getExecutor } from "../../open-sse/executors/index.js";
import { AGY_CONFIG } from "../../src/lib/oauth/constants/oauth.js";
import agyOAuthProvider from "../../src/lib/oauth/providers/agy.js";

describe("Antigravity CLI (agy) Provider Registry", () => {
  it("registers agy in PROVIDERS with antigravity format and correct endpoints", () => {
    expect(PROVIDERS.agy).toBeDefined();
    expect(PROVIDERS.agy.format).toBe("antigravity");
    expect(PROVIDERS.agy.baseUrls).toContain("https://daily-cloudcode-pa.googleapis.com");
    expect(PROVIDERS.agy.clientId).toBe("1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com");
  });

  it("registers models under agy alias", () => {
    const models = PROVIDER_MODELS.agy;
    expect(models).toBeDefined();
    expect(Array.isArray(models)).toBe(true);

    const modelIds = models.map((m) => m.id);
    expect(modelIds).toContain("gemini-3.7-flash-high");
    expect(modelIds).toContain("gemini-3.7-flash-medium");
    expect(modelIds).toContain("gemini-3.7-flash-low");
    expect(modelIds).toContain("gemini-pro-agent");
    expect(modelIds).toContain("claude-sonnet-4-6");
    expect(modelIds).toContain("claude-opus-4-6-thinking");
  });

  it("resolves AntigravityExecutor for agy provider", () => {
    const executor = getExecutor("agy");
    expect(executor).toBeDefined();
    expect(executor.provider).toBe("agy");
    expect(executor.constructor.name).toBe("AntigravityExecutor");
  });

  it("configures agy in PROVIDER_OAUTH and AGY_CONFIG", () => {
    expect(PROVIDER_OAUTH.agy).toBeDefined();
    expect(PROVIDER_OAUTH.agy.tokenUrl).toBe("https://oauth2.googleapis.com/token");
    expect(AGY_CONFIG).toBeDefined();
    expect(AGY_CONFIG.clientId).toBe("1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com");
  });

  it("provides agy OAuth provider with required lifecycle methods", () => {
    expect(agyOAuthProvider).toBeDefined();
    expect(typeof agyOAuthProvider.buildAuthUrl).toBe("function");
    expect(typeof agyOAuthProvider.exchangeToken).toBe("function");
    expect(typeof agyOAuthProvider.postExchange).toBe("function");
    expect(typeof agyOAuthProvider.mapTokens).toBe("function");
  });
});
