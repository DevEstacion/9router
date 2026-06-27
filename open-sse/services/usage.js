/**
 * Usage Fetcher - Get usage data from provider APIs
 */

import { getGitHubUsage } from "./usage/github.js";
import { getGeminiUsage, getAntigravityUsage } from "./usage/google.js";
import { getClaudeUsage } from "./usage/claude.js";
import { getCodexUsage, consumeCodexRateLimitResetCredit } from "./usage/codex.js";

export { consumeCodexRateLimitResetCredit };
import { getKiroUsage } from "./usage/kiro.js";
import { getMiniMaxUsage } from "./usage/minimax.js";
import { getCodeBuddyCnUsage } from "./usage/codebuddy-cn.js";
import {
  getQwenUsage,
  getIflowUsage,
  getOllamaUsage,
  getGlmUsage,
  getVercelAiGatewayUsage,
  getQoderUsage,
} from "./usage/misc.js";

/**
 * Get usage data for a provider connection
 * @param {Object} connection - Provider connection with accessToken
 * @returns {Object} Usage data with quotas
 */
// provider → usage handler (ctx carries every arg each handler needs)
const USAGE_HANDLERS = {
  github: (c) => getGitHubUsage(c.accessToken, c.providerSpecificData, c.proxyOptions),
  "gemini-cli": (c) => getGeminiUsage(c.accessToken, c.providerDataWithProjectId, c.proxyOptions),
  antigravity: (c) => getAntigravityUsage(c.accessToken, c.providerSpecificData, c.proxyOptions),
  claude: (c) => getClaudeUsage(c.accessToken, c.proxyOptions),
  codex: (c) => getCodexUsage(c.accessToken, c.proxyOptions),
  kiro: (c) => getKiroUsage(c.accessToken, c.providerSpecificData, c.proxyOptions),
  qoder: (c) => getQoderUsage(c.accessToken, c.proxyOptions),
  qwen: (c) => getQwenUsage(c.accessToken, c.providerSpecificData),
  iflow: (c) => getIflowUsage(c.accessToken),
  ollama: (c) => getOllamaUsage(c.accessToken),
  glm: (c) => getGlmUsage(c.apiKey, c.provider, c.proxyOptions),
  "glm-cn": (c) => getGlmUsage(c.apiKey, c.provider, c.proxyOptions),
  minimax: (c) => getMiniMaxUsage(c.apiKey, c.provider, c.proxyOptions),
  "minimax-cn": (c) => getMiniMaxUsage(c.apiKey, c.provider, c.proxyOptions),
  "vercel-ai-gateway": (c) => getVercelAiGatewayUsage(c.apiKey, c.proxyOptions),
  // xAI has no public quota API. Aggregate from local usageHistory instead.
  xai: (c) => getXaiLocalUsage(c.provider, c.connectionId, "xAI / Grok Build"),
  "codebuddy-cn": (c) => getCodeBuddyCnUsage(c.accessToken, c.apiKey, c.providerSpecificData, c.proxyOptions),
};

export async function getUsageForProvider(connection, proxyOptions = null) {
  const { provider, accessToken, apiKey, providerSpecificData, projectId } = connection;
  const providerDataWithProjectId = {
    ...(providerSpecificData || {}),
    ...(projectId ? { projectId } : {}),
  };

  const handler = USAGE_HANDLERS[provider];
  if (!handler) return { message: `Usage API not implemented for ${provider}` };
  return await handler({
    provider,
    connectionId: connection.id,
    accessToken,
    apiKey,
    providerSpecificData,
    providerDataWithProjectId,
    proxyOptions,
  });
}

/**
 * xAI / Grok local-aggregate usage.
 *
 * xAI does not publish a public quota/usage API. We synthesize a "30-day"
 * usage view from the local usageHistory SQLite table so the dashboard can
 * still render spend + token totals for the connection.
 *
 * Rows are tagged with `unlimited: true` + `remaining: 100` so the existing
 * QuotaTable renders a green "100%" badge (no progress bar) — these are
 * cumulative-since-day-zero numbers with no upstream cap to compare against.
 */
async function getXaiLocalUsage(provider, connectionId, label) {
  const [{ DatabaseSync }, pathModule, osModule] = await Promise.all([
    import("node:sqlite"),
    import("node:path"),
    import("node:os"),
  ]);
  const path = pathModule.default || pathModule;
  const os = osModule.default || osModule;
  const dataDir = process.env.DATA_DIR?.trim() || path.join(os.homedir(), ".9router");
  const dbPath = path.join(dataDir, "db", "data.sqlite");
  const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
  const db = new DatabaseSync(dbPath, { open: true, readOnly: true });
  const rows = db.prepare(
    `SELECT model, connectionId, promptTokens, completionTokens, cost, tokens
       FROM usageHistory
      WHERE provider = ? AND timestamp >= ?`
  ).all(provider, since);
  db.close();

  const filtered = rows.filter((row) => !connectionId || row.connectionId === connectionId);

  if (!filtered.length) {
    return {
      plan: label,
      message: `${label} connected. No requests recorded in the last 30 days.`,
      quotas: {},
      displayMessage: `${label} connected. No usage yet.`,
    };
  }

  const totals = filtered.reduce(
    (acc, row) => {
      const tokens = typeof row.tokens === "string" && row.tokens ? JSON.parse(row.tokens) : (row.tokens || {});
      const prompt = Number(row.promptTokens || tokens?.prompt_tokens || tokens?.promptTokens || 0);
      const completion = Number(row.completionTokens || tokens?.completion_tokens || tokens?.completionTokens || 0);
      acc.prompt += prompt;
      acc.completion += completion;
      acc.cost += Number(row.cost) || 0;
      return acc;
    },
    { prompt: 0, completion: 0, cost: 0 },
  );

  const byModel = {};
  for (const row of filtered) {
    const tokens = typeof row.tokens === "string" && row.tokens ? JSON.parse(row.tokens) : (row.tokens || {});
    const used = Number(row.promptTokens || tokens?.prompt_tokens || tokens?.promptTokens || 0)
      + Number(row.completionTokens || tokens?.completion_tokens || tokens?.completionTokens || 0);
    byModel[row.model] = (byModel[row.model] || 0) + used;
  }

  const unlimited = { remaining: 100, resetAt: null, unlimited: true };
  const quotas = {
    "Total spend (30d)": {
      used: Number(totals.cost.toFixed(4)),
      total: 0,
      unit: "usd",
      ...unlimited,
    },
    "Total tokens (30d)": {
      used: totals.prompt + totals.completion,
      total: 0,
      ...unlimited,
    },
  };

  for (const [model, used] of Object.entries(byModel)) {
    quotas[`${model} (30d)`] = {
      used,
      total: 0,
      ...unlimited,
    };
  }

  return {
    plan: label,
    quotas,
  };
}
