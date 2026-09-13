import { afterEach, describe, expect, it } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const verifier = new URL("../__baseline__/verify-no-regression.mjs", import.meta.url).pathname;

const fixtureDirs = [];
afterEach(() => {
  for (const dir of fixtureDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function fixture(testResults) {
  const dir = mkdtempSync(join(tmpdir(), "9router-baseline-"));
  fixtureDirs.push(dir);
  const path = join(dir, "results.json");
  writeFileSync(path, JSON.stringify({ testResults }));
  return path;
}

describe("no-regression baseline verifier", () => {
  it("normalizes Linux test paths and accepts a failure already recorded in the committed baseline", () => {
    const path = fixture([{ name: "/home/user/9router/tests/unit/rtk.test.js", status: "failed", assertionResults: [{ status: "failed", fullName: "RTK flag default off, toggle works" }] }]);
    expect(execFileSync(process.execPath, [verifier, path], { encoding: "utf8" })).toContain("No regression");
  });

  it("allows failures from tests absent from the baseline", () => {
    const path = fixture([{ name: "C:\\repo\\tests\\unit\\new.test.js", status: "failed", assertionResults: [{ status: "failed", fullName: "new failure" }] }]);
    const result = spawnSync(process.execPath, [verifier, path], { encoding: "utf8" });
    expect(result.status).toBe(0);
  });

  it("reports a portable path when a baseline pass becomes a failure", () => {
    const path = fixture([{ name: "C:\\repo\\tests\\translator\\bugs-antigravity.test.js", status: "failed", assertionResults: [{ status: "failed", fullName: "Antigravity → OpenAI functionResponse + functionCall in same content keeps both" }] }]);
    const result = spawnSync(process.execPath, [verifier, path], { encoding: "utf8" });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("tests/translator/bugs-antigravity.test.js :: Antigravity → OpenAI functionResponse + functionCall in same content keeps both");
  });
});
