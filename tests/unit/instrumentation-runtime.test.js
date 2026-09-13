import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(process.cwd(), "..");
const instrumentation = readFileSync(join(root, "src/instrumentation.js"), "utf8");

describe("server instrumentation", () => {
  it("keeps console capture, catalog hooks, and delayed Headroom startup together", () => {
    expect(instrumentation).toContain("initConsoleLogCapture");
    expect(instrumentation).toContain("installCatalogSource");
    expect(instrumentation).toContain("startModelCatalogSync");
    expect(instrumentation).toContain("autoStartHeadroom");
    expect(instrumentation).toContain("setTimeout");
  });

  it("uses only the JavaScript instrumentation entry", () => {
    expect(existsSync(join(root, "src/instrumentation.ts"))).toBe(false);
  });
});
