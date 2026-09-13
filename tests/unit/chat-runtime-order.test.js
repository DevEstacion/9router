import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const chatSource = readFileSync(join(process.cwd(), "..", "src/sse/handlers/chat.js"), "utf8");

describe("chat runtime preprocessing order", () => {
  it("validates auth, model, and bypass before Sharp image normalization", () => {
    const normalizeAt = chatSource.indexOf("await normalizeInlineImages(body, sourceFormat)");

    expect(normalizeAt).toBeGreaterThan(chatSource.indexOf("await isValidApiKey(apiKey)"));
    expect(normalizeAt).toBeGreaterThan(chatSource.indexOf("if (!modelStr)"));
    expect(normalizeAt).toBeGreaterThan(chatSource.indexOf("if (bypassResponse) return"));
  });

  it("passes source format and effective stream mode to every chat combo fallback", () => {
    const calls = [...chatSource.matchAll(/return handleComboChat\(\{([\s\S]*?)\n\s*\}\);/g)];

    expect(calls).toHaveLength(3);
    for (const [, options] of calls) {
      expect(options).toMatch(/sourceFormat,/);
      expect(options).toMatch(/stream: body\.stream !== false/);
    }
  });
});
