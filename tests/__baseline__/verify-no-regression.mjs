// Gate: compare current Vitest JSON with committed baseline results.
// PASS when no previously passing test or suite fails now. New tests are allowed.
// Usage: node tests/__baseline__/verify-no-regression.mjs <current-results.json>
import { readFileSync } from "node:fs";

function testPath(name) {
  const normalized = String(name || "").replaceAll("\\", "/");
  const marker = "/tests/";
  const index = normalized.lastIndexOf(marker);
  return index >= 0 ? `tests/${normalized.slice(index + marker.length)}` : normalized;
}

function assertionKey(path, assertion) {
  return `${path} :: ${assertion.fullName}`;
}

const resultsPath = process.argv[2];
if (!resultsPath) { console.error("Missing results.json path"); process.exit(2); }

const current = JSON.parse(readFileSync(resultsPath, "utf8"));
const baseline = JSON.parse(readFileSync(new URL("./baseline-results.json", import.meta.url), "utf8"));
const knownFails = new Set(
  readFileSync(new URL("./known-fails.txt", import.meta.url), "utf8")
    .split("\n").map((line) => line.trim()).filter(Boolean)
);

const baselineAssertions = new Map();
const baselineSuites = new Map();
for (const file of baseline.testResults || []) {
  const path = testPath(file.name);
  baselineSuites.set(path, file.status);
  for (const assertion of file.assertionResults || []) {
    baselineAssertions.set(assertionKey(path, assertion), assertion.status);
  }
}

const regressions = [];
for (const file of current.testResults || []) {
  const path = testPath(file.name);
  const assertionFails = (file.assertionResults || []).filter((assertion) => assertion.status === "failed");
  for (const assertion of assertionFails) {
    const key = assertionKey(path, assertion);
    if (baselineAssertions.get(key) === "passed" && !knownFails.has(key)) regressions.push(key);
  }
  if (file.status === "failed" && assertionFails.length === 0 && baselineSuites.get(path) === "passed") {
    regressions.push(`${path} :: <suite>`);
  }
}

if (regressions.length) {
  console.error(`\n❌ REGRESSION: ${regressions.length} test pass→fail:\n`);
  regressions.forEach((failure) => console.error(`  - ${failure}`));
  process.exit(1);
}
console.log(`✅ No regression. (current failures=${current.numFailedTests || 0}, baseline assertions=${baselineAssertions.size}, known=${knownFails.size})`);
