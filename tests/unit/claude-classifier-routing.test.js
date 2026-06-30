import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * The classifier-routing override lives in `src/sse/handlers/chat.js`. It
 * inspects the raw body and pins the model to `cx/gpt-5.4-high` when
 * `claudeClassifierCompat !== "off"` and the request looks like a Claude
 * auto-mode classifier. We cannot easily import the route handler (it
 * pulls in Next.js + auth), so we re-read the source file and assert the
 * override logic is present and syntactically wired to the right
 * detectors. This guards against a future refactor that silently drops
 * the classifier-routing override.
 */
describe("chat.js classifier-routing override", () => {
  const src = readFileSync(
    join(process.cwd(), "..", "src/sse/handlers/chat.js"),
    "utf8",
  );

  it("contains the classifier detector constants", () => {
    expect(src).toMatch(/You are a security monitor for autonomous AI coding agents/);
    expect(src).toMatch(/<\/block>/);
  });

  it("pins the model to cx/gpt-5.4-high when classifier + compat is on", () => {
    expect(src).toMatch(/cx\/gpt-5\.4-high/);
  });

  it("threads the compat mode and detection together before model override", () => {
    // The check must come BEFORE the model reassignment, otherwise the
    // override fires on every request including non-classifier ones.
    const compatIndex = src.indexOf("claudeClassifierCompat");
    const detectionIndex = src.indexOf("security monitor");
    const overrideIndex = src.indexOf("modelStr = \"cx/gpt-5.4-high\"");
    expect(compatIndex).toBeGreaterThan(-1);
    expect(detectionIndex).toBeGreaterThan(-1);
    expect(overrideIndex).toBeGreaterThan(-1);
    expect(compatIndex).toBeLessThan(detectionIndex);
    expect(detectionIndex).toBeLessThan(overrideIndex);
  });

  it("gates the override on the compat mode being non-off", () => {
    // The override must NOT fire for users who have compat off.
    const overrideBlock = src.match(/compatMode !== "off"[\s\S]{0,500}/);
    expect(overrideBlock).toBeTruthy();
    expect(overrideBlock?.[0]).toMatch(/looksLikeClassifier/);
  });
});
