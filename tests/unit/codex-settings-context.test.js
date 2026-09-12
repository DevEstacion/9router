import { describe, expect, it } from "vitest";
import { __test__ } from "../../src/app/api/cli-tools/codex-settings/route.js";

const { isCodexGpt56, applyCodexGpt56Window, removeManagedCodexGpt56Window } = __test__;

describe("Codex GPT-5.6 managed context settings", () => {
  it("matches only supported exact model IDs and effort variants", () => {
    expect(isCodexGpt56("grok-main/gpt-5.6-sol-medium")).toBe(true);
    expect(isCodexGpt56("gpt-5.6-terra-review-xhigh")).toBe(true);
    expect(isCodexGpt56("prefix-gpt-5.6-sol-medium-extra")).toBe(false);
    expect(isCodexGpt56("gpt-5.6-solar")).toBe(false);
  });

  it("does not delete user context settings for another model", () => {
    const parsed = { model_context_window: 500000, model_auto_compact_token_limit: 450000 };
    applyCodexGpt56Window(parsed, "gpt-6-astra");
    expect(parsed).toEqual({ model_context_window: 500000, model_auto_compact_token_limit: 450000 });
  });

  it("removes only values managed by 9Router", () => {
    const managed = { model_context_window: 872000, model_auto_compact_token_limit: 780000 };
    removeManagedCodexGpt56Window(managed);
    expect(managed).toEqual({});

    const custom = { model_context_window: 900000, model_auto_compact_token_limit: 800000 };
    removeManagedCodexGpt56Window(custom);
    expect(custom).toEqual({ model_context_window: 900000, model_auto_compact_token_limit: 800000 });
  });
});
