# AGENTS.md — 9Router (DevEstacion fork)

This file contains instructions for AI coding agents working on the `DevEstacion/9router` fork. Track upstream at `decolua/9router:master`; rebase/merge cadence is monthly or on security-tag pushes.

Current fork version tracks upstream v0.5.2 (commit `5da508a`).

## Project overview

9Router is an AI proxy gateway (Next.js + Node.js) that routes CLI tool requests (Claude Code, Cursor, Codex, OpenCode) to upstream providers. It translates formats (e.g. OpenAI to ConnectRPC for Cursor, or NDJSON for Grok) and tracks token usage.

The DevEstacion fork is **production-deployed and OpenCode-first**: the gateway sits behind OpenCode as the sole proxy for Codex (3 OAuth logins) and Cursor (1 OAuth). xAI, minimax (M3), and opencode-go (deepseek-v4-pro, kimi, qwen, etc.) are reached directly from OpenCode, bypassing 9router.

## Key Fork Differences vs Upstream (`decolua/9router`)

### Code additions (in-repo)

| File | Purpose |
|---|---|
| `open-sse/translator/response/openai-to-claude-json.js` | **NEW** — `translateOpenAIToClaudeIfNeeded()`. Converts non-streaming OpenAI Chat Completions → Anthropic Messages for the Claude→OpenAI code path. Fixes the Claude Code auto-mode classifier crash when `gpt-5.5-9router` combo routes to an OpenAI-format upstream. Bypasses the standard translator registry (see Translator quirks below). |
| `open-sse/executors/xai.js` | **NEW** — `XaiExecutor` (suffixed-reasoning parser + allow/deny list). `grok-build`/`grok-composer-2.5-fast` strip `reasoning_effort`; `grok-4.3` accepts standard `reasoning_effort`. Suffix parser maps `grok-4.3-{low,medium,high,xhigh}` → `reasoning_effort={low,medium,high,xhigh}`. |
| `open-sse/utils/cursorToolMapping.js` | Bidirectional Cursor tool name translation (`bash` ↔ `shell`, etc.). OpenCode uses Cursor's native tool names. |
| `src/app/api/usage/[connectionId]/route.js` | Added `backfillCursorIdentity(connection)` call at line 140, before OAuth/apikey eligibility check. Wraps `backfillCursorConnectionIdentity()` from `@/lib/oauth/services/cursorLocalStore.js` to hydrate missing identity fields. |
| `open-sse/services/usage.js` | `getXaiLocalUsage(provider, connectionId, label)` — aggregates 30-day xAI usage from the local `usageHistory` SQLite table. Called by `USAGE_HANDLERS.xai` in the dispatcher. Returns `unlimited: true, remaining: 100` for cumulative rows (see xAI Quota rows below). |
| `open-sse/executors/opencode-go.js` | Forked executor variant. Adds `deepseek-v4-pro` reasoning-effort parsing: `deepseek-v4-pro-{low,medium,high,max}` → `reasoning_effort={low,medium,high,max}`. Maps to the opencode-go API's DeepSeek hosting. |
| `src/app/(dashboard)/dashboard/usage/components/ProviderLimits/index.js` | Kept `AI_PROVIDERS` import (line 41) for `providerColor` lookup at line 916. Upstream removed this in favour of Kiro UI helpers — we kept both. |

### Database-side configuration (this deployment)

The SQLite DB at `~/.9router/db/data.sqlite` is **manually curated on this fork** (not purely upstream-managed). The user maintains:

| Table | State |
|---|---|
| `providerConnections` | **4 rows**: 3× codex + 1× cursor. The `xai`, `opencode-go`, `minimax`, `gemini-cli` connections were **removed** (these providers are reached direct from OpenCode via `~/.local/share/opencode/auth.json`). |
| `combos` | **4 combos**, each trimmed to **same-tier rotation only**: codex-pool + cursor. No cross-tier chains inside combos (cross-tier is enforced by OpenCode `oh-my-opencode.json` `fallback_models` instead). |
| `combos.kind` | `round-robin` on the 3 codex combos, `fallback` on `composer-9router` (single-cursor model, no rotation). |
| `apiKeys` | 1 key: `sk-0dbe8d85...` (name `test`). |

**Do not auto-restore the dropped connections or expand combos back to cross-tier** — the OpenCode-side `fallback_models` chain now owns cross-tier policy.

### Translator quirks

The fork adds `openai-to-claude-json.js` as a **direct route translator** for a specific edge case. Unlike the standard translators (which self-register via `register(from, to, reqFn, resFn)` import side-effects in `translator/index.js`), this one is called **directly from `nonStreamingHandler.js`** at lines 23–25:

```js
if (sourceFormat === FORMATS.CLAUDE && targetFormat === FORMATS.OPENAI) {
  return translateOpenAIToClaudeIfNeeded(responseBody, sourceFormat);
}
```

Why direct, not registered: the non-streaming path returns a parsed JSON body (not SSE chunks), and the registered OpenAI→Claude translator expects SSE-shaped data. Calling directly keeps the conversion local and synchronous. **Do not move this to the registry** without also rewriting it for SSE inputs.

### xAI Quota rows

Cumulative xAI quota rows (Total spend, Total tokens) have no hard cap. They **MUST** include `unlimited: true` and `remaining: 100` so the UI renders the green "100%" badge and hides the progress bar instead of showing a misleading "0%". Set in `getXaiLocalUsage()` in `open-sse/services/usage.js`.

## Setup commands

- Install dependencies: `npm install` in the root, and `cd cli && npm install`
- Build the CLI package: `cd cli && npm run build` (Required after ANY changes to `src/` or `open-sse/`)
- Restart the background service: `systemctl --user daemon-reload && systemctl --user restart 9router`

## Testing instructions

- Run unit tests: `cd tests && ./node_modules/.bin/vitest run --config ./vitest.config.js` (local vitest; `/tmp/node_modules` is unpopulated on this machine)
- Test files live in `tests/unit/` and `tests/translator/`. When modifying tool mapping, usage aggregation, or the new `openai-to-claude-json.js` translator, run the corresponding `.test.js` file.
- The `tests/translator/AGENTS.md` contains specific instructions for the translator test suite.
- Pre-existing baseline: ~38 test failures (env drift, missing `lowdb`, missing `cloud/` dir, snapshot drift). Not caused by recent merges — do not chase.

## Code style and Architecture

- Use ES Modules (`import`/`export`).
- **Separation of concerns:** `open-sse/` is the proxy/streaming layer. Do NOT import Next.js specific code or `better-sqlite3` directly into `open-sse/` files, as it will break the Node 25 runtime service (ABI mismatch).
- **Database access:** Database operations must go through `src/lib/db/` via `src/lib/localDb.js`.
- **`open-sse/AGENTS.md` is authoritative** for `open-sse/` conventions: config-driven, no hardcoded values, translators self-register (with the documented `openai-to-claude-json.js` exception), direct routes for lossy pairs.

## PR instructions

- Title format: `type(scope): description` (e.g., `feat(cursor): add identity backfill`)
- Atomic commits: 3+ files changed MUST be split into multiple logical commits. Never group unrelated changes.
- Ensure `npm run build` succeeds before pushing.
- When merging upstream, expected conflict files are typically: `src/app/api/usage/[connectionId]/route.js` (backfillCursorIdentity vs upstream apikey list), `src/app/(dashboard)/dashboard/usage/components/ProviderLimits/index.js` (AI_PROVIDERS import vs Kiro helpers).

## Approved Models

Agents must use the following models only when routing requests. This file is the **single source of truth** for the curated set on this fork — **do not add `MODELS.md`** or duplicate lists elsewhere.

### Codex (cx/)
- gpt-5.5 (all reasoning levels: low, medium, high, xhigh)
- gpt-5.4 (all reasoning levels: low, medium, high, xhigh)
- **Effort ceiling: high** — Codex's `thinkingConfig.options` are `["auto","none","low","medium","high"]`. `cx/gpt-5.4-xhigh` is **invalid**; the `gpt-5.5-9router-xhigh` combo falls back to cursor's `cu/gpt-5.4-xhigh` instead.

### Cursor (cu/)
- composer-2.5
- claude-opus-4-8 (high, thinking-high, high-fast, thinking-high-fast, xhigh, thinking-xhigh, xhigh-fast, thinking-xhigh-fast)
- claude-opus-4-7 (high, thinking-high, high-fast, thinking-high-fast, xhigh, thinking-xhigh, xhigh-fast, thinking-xhigh-fast)
- claude-opus-4-6 (high, thinking-high, high-fast, thinking-high-fast) — **no `max` / `thinking-max` variants** on this fork
- gpt-5.4 (medium, high, xhigh) — exposed by Cursor's API; used in `gpt-5.5-9router-xhigh` combo

### Gemini CLI (gc/)
- gemini-3.1-pro-preview
- gemini-3.1-flash-preview
- gemini-3.1-flash-lite
- gemini-3-flash-preview
- gemini-2.5-pro
- gemini-2.5-flash

### xAI / Grok (xai/) — **direct from OpenCode, not via 9router**
- grok-build
- grok-composer-2.5-fast
- grok-4.3 (medium, high, xhigh) — exposed via direct OAuth in OpenCode; used as fallback tier in omo

### opencode-go (ocg/) — **direct from OpenCode, not via 9router**
- deepseek-v4-pro (medium, high, max) — exposed via opencode-go API; omo fallback tier 2
- kimi-k2.6, glm-5.1, qwen3.6-plus, mimo-v2-pro, etc. (other opencode-go hosted models)

### minimax (mm/) — **direct from OpenCode, not via 9router**
- MiniMax-M3 (bedrock tier — never fails)

## Dashboard model curation (this fork)

Per-provider **Available Models** in the UI come from `modelLock_*` keys inside `providerConnections.data` (JSON in `~/.9router/db/data.sqlite`), not from shrinking the global catalog in `open-sse/config/providerModels.js`.

- **UPDATE existing rows only** — do not create new tables or schema.
- After changing the approved list, prune each connection's `modelLock_*` to match **Approved Models** above.
- Keep **combos** and **aliases** (`PUT /api/models/alias`) aligned with the same set (e.g. `gpt-5.5-9router`, `composer-9router`).

## OpenCode integration (this deployment)

The OpenCode-side configuration is **out of this repo** (lives in `/home/ron/Documents/Projects/opencode/`, separate `DevEstacion/opencode-config` repo). Three OCX profiles:

| Profile | Default model | Use |
|---|---|---|
| `omo` (`oh-my-opencode.json`) | `9router/gpt-5.5-9router` (medium) | Primary dev profile. Agents: sisyphus/hephaestus/prometheus/oracle/atlas/multimodal-looker → 9router combo (medium); momus/ultrabrain → xhigh; librarian/explore/quick/writing/unspecified-low → M3 direct; metis → deepseek-medium direct; visual-engineering/artistry → xai-grok-high. |
| `kdco` (`opencode.jsonc`) | `minimax/MiniMax-M3` | Custom agent set (plan/build/coder/explore/researcher/scribe/reviewer). Most on 9router combo medium; reviewer on xhigh; scribe on M3. |
| `default` (`opencode.jsonc`) | inherits `9router/gpt-5.5-9router` | Vanilla OpenCode agents (build/plan/general/explore) — all on combo medium; explore on M3. |

Combo alias: **`9router/gpt-5.5-9router`** (not `openai/gpt-5.5-9router`).

Cross-tier fallback is enforced by `fallback_models` chains in each profile — each chain resolves to `[deepseek direct (opencode-go), xai direct, minimax direct (M3)]`. **Do not move cross-tier chains back into the 9router combo.**

Service: Node 25 + `systemctl --user restart 9router` after `cd cli && npm run build`. Legacy `ai-tools` systemd unit removed.

## Provider compatibility gotchas

Some upstream models reject parameters that clients (Claude Code, OpenCode, etc.) send by default. 9Router strips them automatically; do not add them back to translator output.

### xAI / Grok
- `grok-build` accepts standard OpenAI `reasoning_effort`.
- `grok-composer-2.5-fast` (and any `*composer*` / `*fast*` xAI model) **does not** support `reasoning_effort`. Dedicated `XaiExecutor` (open-sse/executors/xai.js) handles suffix parsing (`grok-4.3-high` → effort=high) and strips the param for denied models. `grok-4.3` accepts `reasoning_effort` (per official docs).
- Tool calling works on `grok-composer-2.5-fast` (verified: returns a `function` tool_call for a `calculator` tool, and a `bash` tool for the OpenCode `bash` agent).
- `grok-composer-2.5-fast` is the recommended agent model (tool calling + fast). `grok-build` is the recommended chat model.

### Gemini CLI
- `gemini-3.1-flash-preview` currently returns `404 NOT_FOUND` from the upstream Google API even though it is listed in the Gemini CLI's model picker. Prefer `gemini-3.1-pro-preview` (verified OK) and `gemini-3-flash-preview` until Google rolls out 3.1-flash properly.
- `gemini-2.5-pro` and `gemini-2.5-flash` are still safe fallbacks.

### Codex
- `cx/gpt-5.5-high` and `cx/gpt-5.4-high` are reliable; the `*-review` variants are auto-generated by the provider and are not curated here.
- **`cx/gpt-5.4-xhigh` is invalid** — Codex's `thinkingConfig.options` caps at `high`. The `gpt-5.5-9router-xhigh` combo falls through to `cu/gpt-5.4-xhigh`.

### Cursor
- Tool names are remapped via `cursorToolMapping.js` for OpenCode compatibility.
- `backfillCursorIdentity()` runs before the usage endpoint checks OAuth/apikey eligibility — needed for OAuth connections missing `providerSpecificData.sub`/`email`.

### opencode-go (DeepSeek)
- `deepseek-v4-pro-{low,medium,high,max}` suffix → `reasoning_effort` parameter (parsed in `opencode-go.js` executor). `max` is the top tier (not `xhigh`).
- `opencode-go` executor routes through `https://opencode.ai/zen/go/v1/chat/completions` (or `/messages` for `minimax-m2.x` Claude-format models).

## Testing checklist (after model or executor changes)

Upstream **429** rate limits when quotas are exhausted are expected; that is not a routing bug.

Use `POST /v1/chat/completions` with an active key from the `apiKeys` table, and/or dashboard **Test Connection** (`POST /api/models/test`). Register combo aliases with `PUT /api/models/alias` when needed.

When touching model lists, executors, or request transformers, at minimum verify:

- `xai/grok-build` basic completion
- `xai/grok-composer-2.5-fast` basic completion + tool calling (with `reasoning_effort` in the request)
- At least one `cx/gpt-5.5-*` and one `cx/gpt-5.4-*` variant
- At least one high/thinking Cursor model under `cu/`
- At least one Gemini model under `gc/`
- The non-streaming Claude→OpenAI path (the `openai-to-claude-json.js` translator): send a Claude-format request to `9router/gpt-5.5-9router` with `stream: false`, verify the response is Anthropic Messages shape (`type: "message"`, `content: [{type:"text"}]`) not leaked Chat Completions shape.

When touching model lists, executors, or request transformers, at minimum verify the above plus any newly added models.
