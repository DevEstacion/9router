# AGENTS.md — 9Router (DevEstacion fork)

This file contains instructions for AI coding agents working on the `DevEstacion/9router` fork. Track upstream at `decolua/9router:master`; rebase/merge cadence is monthly or on security-tag pushes.

Current fork version tracks upstream **v0.5.12** (commit `cce47dd`) plus local patches documented below.

---

## Project overview

9Router is a Next.js 16 web dashboard that acts as an AI router — it proxies
LLM API requests across 40+ providers with token compression, quota tracking,
and auto-fallback. The project ships as an npm CLI (`9router`) but we run it
from source via systemd.

- **Repo**: https://github.com/DevEstacion/9router (fork of https://github.com/decolua/9router)
- **Dashboard**: http://localhost:20128/dashboard
- **API base**: http://localhost:20128/v1
- **Health check**: `curl http://localhost:20128/api/health`

The DevEstacion fork is **production-deployed and OpenCode-first**: the
gateway sits behind OpenCode as the sole proxy for Codex (3 OAuth logins)
and Cursor (1 OAuth). xAI, minimax (M3), and opencode-go (deepseek-v4-pro,
kimi, qwen, etc.) are reached directly from OpenCode, bypassing 9router.

---

## Critical: how the build works

The project has TWO build paths:

1. **Default build** (`npm run build` → `next build --webpack`): produces
   `.next/standalone/` with `distDir: "./.next"`. **Static files
   (`_next/static/*`) return 404 in this mode.** Next.js 16.2 standalone simply
   does not serve them from the default dist dir unless the exact CLI-style
   layout is used.

2. **CLI build** (used by `cli/scripts/build-cli.js`): sets
   `NEXT_DIST_DIR=.next-cli-build` and `NEXT_TRACING_ROOT_MODE=workspace`,
   then hard-copies `.next-cli-build/static/` into the standalone output's
   `.next-cli-build/static/`. This is the only configuration that serves
   static CSS/JS reliably. The CLI build also detects the nested
   `.next-cli-build/standalone/9router/` layout introduced by
   `NEXT_TRACING_ROOT_MODE=workspace`.

**Always use the CLI build params** when rebuilding for the systemd service:

```bash
NEXT_DIST_DIR=.next-cli-build NEXT_TRACING_ROOT_MODE=workspace npm run build
```

After the build, copy static files into the standalone dist dir:

```bash
STANDALONE=./.next-cli-build/standalone/9router
cp -r .next-cli-build/static "$STANDALONE/.next-cli-build/static"
cp custom-server.js "$STANDALONE/"
cp -r open-sse "$STANDALONE/"
cp -r public "$STANDALONE/"
```

## Build & setup commands

```bash
# Install deps
npm install

# Build (CLI mode — required for working static files)
NEXT_DIST_DIR=.next-cli-build NEXT_TRACING_ROOT_MODE=workspace npm run build

# Copy static files + runtime assets into standalone output
STANDALONE=./.next-cli-build/standalone/9router
cp -r .next-cli-build/static "$STANDALONE/.next-cli-build/static"
cp custom-server.js "$STANDALONE/"
cp -r open-sse "$STANDALONE/"
cp -r public "$STANDALONE/"
cp -r src/mitm "$STANDALONE/src/" 2>/dev/null
cp -r node_modules/node-forge "$STANDALONE/node_modules/" 2>/dev/null

# Copy .env to standalone dir
cp .env "$STANDALONE/.env"

# Run manually for testing
cd "$STANDALONE"
PORT=20128 node server.js
```

Do **not** use `npm run start` / `next start` — it prints a warning that it
doesn't work with `output: "standalone"`.

## Setup commands (fork)

- Install dependencies: `npm install` in the root, and `cd cli && npm install`
- Build the CLI package: `cd cli && npm run build` (Required after ANY changes to `src/` or `open-sse/`)
- Restart the background service: `systemctl --user daemon-reload && systemctl --user restart 9router`

## Environment (.env)

Key variables in `.env` at the project root:

```
PORT=20128
NODE_ENV=production
DATA_DIR=/home/ron/Documents/Projects/9router/data
JWT_SECRET=<random>
INITIAL_PASSWORD=<only used on first DB init — once set, password lives in SQLite>
```

The systemd service reads `.env` via `EnvironmentFile`.

## Systemd service

Service file: `9router.service` in the project root, symlinked from
`~/.config/systemd/user/9router.service`.

```bash
# Control
systemctl --user start|stop|restart 9router
systemctl --user status 9router

# Logs
journalctl --user -u 9router -f        # follow
journalctl --user -u 9router -n 50     # last 50 lines
journalctl --user -u 9router --since today

# Enable/disable
systemctl --user enable 9router
systemctl --user disable 9router

# Linger (survives logout, starts at boot)
loginctl enable-linger
```

The service is configured with `Restart=always`, `RestartSec=5`, and
`StartLimitBurst=0` — it never gives up restarting.

Service: Node 25 + `systemctl --user restart 9router` after `cd cli && npm run build`. Legacy `ai-tools` systemd unit removed.

## Authentication

Login is currently **disabled** (`requireLogin = false` in the SQLite DB).
The dashboard loads at http://localhost:20128/dashboard without credentials.

To re-enable auth, set it in the settings table:

```bash
node -e "
const Database = require('better-sqlite3');
const db = new Database('data/db/data.sqlite');
db.prepare(\"INSERT INTO settings (id, data) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data\").run(JSON.stringify({ requireLogin: true }));
db.close();
"
```

## Key file paths

```
9router.service                  # systemd unit (symlinked into ~/.config/systemd/user/)
.env                             # environment variables
data/db/data.sqlite              # SQLite database (providers, keys, settings, usage)
.next-cli-build/standalone/9router/  # working standalone output
.next-cli-build/standalone/9router/.next-cli-build/static/  # client JS/CSS bundles
```

## Data directory

The `data/` directory in the project root contains:
```
data/
└── db/
    ├── data.sqlite       # main DB
    └── backups/          # auto backups
```

## Models and variants

9router exposes a curated set of models (the upstream provider surface is
hidden). Always list them before adding new aliases — the model name on 9router
may differ from the upstream provider's name.

```bash
curl -s http://127.0.0.1:20128/v1/models \
  -H "Authorization: Bearer $API_KEY" | jq '.data[].id'
```

Key models:
- `auto-medium`, `auto-high`, `auto-xhigh` — **9router fallback combos**.
  Each tries the matching `cx/gpt-5.5-*` first, then falls back to
  `ocg/deepseek-v4-pro` on failure. **Use these in opencode profiles.**
- `cx/gpt-5.5-medium`, `cx/gpt-5.5-high`, `cx/gpt-5.5-xhigh` — OpenAI
  gpt-5.5 variants accessed via Codex OAuth. Suffix encodes
  `reasoning_effort`. **400K context window** (Codex product limit, NOT
  the 1M API limit — confirmed by the 9router `providerConnections`
  table which has `type: 'codex'`).
- `cx/gpt-5.5` (no suffix) — bare GPT-5.5 via Codex, default reasoning.
- `ocg/glm-5.2` — GLM 5.2 (this is the only glm-5.2 model; there is **no**
  `deepseek/glm-5.2` on 9router)
- `ocg/deepseek-v4-pro`, `ocg/deepseek-v4-flash` — DeepSeek V4 via
  OpenCode Zen Go. **1M context window, 384K max output.**
- `ocg/minimax-m3`, `ocg/minimax-m2.7`, `ocg/minimax-m2.5` — MiniMax
  variants via OpenCode Zen Go (Anthropic-format endpoint, uses
  `x-api-key` auth). Note: the 9router `minimax/*` provider prefix
  rejects tool payloads (see Common issues); prefer the direct opencode
  `minimax` provider for agent mode.

### Reasoning effort

`reasoning_effort` is passed through to the upstream provider. Verified
behavior on `ocg/deepseek-v4-pro`:

| `reasoning_effort` | Result | Notes |
|---|---|---|
| `low` | Works | Use for simple tasks; minimal reasoning |
| `medium` | ⚠️ Unreliable | Burns the full `max_tokens` budget on reasoning, often no content delivered |
| `high` | Works | Good default for most tasks |
| `max` | Works with `max_tokens ≥ 2000` | Very deep reasoning; budget must be large or content gets cut off |

When using `max`, configure the opencode model with a high `maxTokens` (e.g.
4000) or the response will be `finish_reason: "length"` with empty content.

### Opencode model aliases

The opencode provider config (in `~/.config/opencode/opencode.json`) lets you
register multiple alias entries that all map to the same upstream model with
different `options`. There are two patterns:

**Direct model aliases** (single upstream model, custom reasoning effort):

```json
"deepseek-v4-pro-high": {
  "name": "ocg/deepseek-v4-pro",
  "options": {
    "reasoningEffort": "high",
    "textVerbosity": "low",
    "reasoningSummary": "auto"
  },
  "modalities": { "input": ["text", "image"], "output": ["text"] }
},
"deepseek-v4-pro-max": {
  "name": "ocg/deepseek-v4-pro",
  "options": {
    "reasoningEffort": "max",
    "textVerbosity": "low",
    "reasoningSummary": "auto",
    "maxTokens": 4000
  },
  "modalities": { "input": ["text", "image"], "output": ["text"] }
}
```

**Combo aliases** (point at a 9router fallback combo, with `reasoningEffort`
set so the deepseek fallback inherits the matching level):

```json
"auto-medium": {
  "name": "auto-medium",
  "options": { "reasoningEffort": "medium" },
  "limit": { "context": 400000, "output": 128000 }
},
"auto-high": {
  "name": "auto-high",
  "options": { "reasoningEffort": "high" },
  "limit": { "context": 400000, "output": 128000 }
},
"auto-xhigh": {
  "name": "auto-xhigh",
  "options": { "reasoningEffort": "xhigh" },
  "limit": { "context": 400000, "output": 128000 }
}
```

The 400K `context` limit on the auto-* entries reflects the primary's
Codex product ceiling. The fallback `ocg/deepseek-v4-pro` itself has 1M
context, but the combo's effective context is capped at the primary.

**Why set `reasoningEffort` on the combo entry?** The 9router combo
(`combo.js`) calls each model with the same `body` it received. The codex
executor reads effort from the model name suffix (e.g. `gpt-5.5-medium`
→ medium), so the primary works either way. But on fallback, deepseek
gets the **original request body** — and if opencode didn't include
`reasoning_effort`, deepseek falls back to its default (low). Setting
`options.reasoningEffort` on the opencode side ensures the value is in
the body and propagates to the deepseek fallback.

Notes:
- The key (`deepseek-v4-pro-high` or `auto-medium`) is the opencode-side reference.
- The `name` field is what 9router receives as the model identifier — it MUST
  match an actual model on 9router (verify with `/v1/models`).
- `reasoningEffort` is camelCase in opencode's options (not `reasoning_effort`
  as the API sends it).
- After registering a new model in the global provider, profiles can reference
  it as `9router/<key>`.

---

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

---

## Opencode integration

9router is configured as an opencode provider to route OpenAI/DeepSeek traffic.
MiniMax is **excluded** from 9router and uses the opencode direct `minimax`
provider instead (see issue below).

### Global provider config

`~/.config/opencode/opencode.json` defines the `9router` provider and
model aliases. DeepSeek aliases map different `reasoningEffort` levels,
and `auto-*` aliases point at 9router fallback combos:

```json
"9router": {
  "baseURL": "http://localhost:20128/v1",
  "apiKey": "…",
  "api": "openai-completions",
  "models": {
    "auto-medium": { "options": { "reasoningEffort": "medium" }, "limit": { "context": 400000, "output": 128000 } },
    "auto-high":   { "options": { "reasoningEffort": "high"   }, "limit": { "context": 400000, "output": 128000 } },
    "auto-xhigh":  { "options": { "reasoningEffort": "xhigh"  }, "limit": { "context": 400000, "output": 128000 } },
    "deepseek-v4-pro-high": {
      "name": "ocg/deepseek-v4-pro",
      "options": { "reasoningEffort": "high", … }
    },
    "deepseek-v4-pro-max": {
      "name": "ocg/deepseek-v4-pro",
      "options": { "reasoningEffort": "max", … },
      "maxTokens": 4000
    }
  }
}
```

Profiles reference models as `9router/<key>` (e.g. `9router/auto-medium`,
`9router/deepseek-v4-pro-high`).

### Profile locations

OpenCode profiles are in a separate repo and symlinked into `~/.config/opencode/`:

```
/home/ron/Documents/Projects/opencode/   # git repo
  profiles/default/opencode.jsonc
  profiles/kdco/opencode.jsonc
  profiles/omo/opencode.jsonc
  profiles/omo/oh-my-opencode.json

~/.config/opencode/profiles/default -> …/opencode/profiles/default
~/.config/opencode/profiles/kdco   -> …/opencode/profiles/kdco
~/.config/opencode/profiles/omo    -> …/opencode/profiles/omo
```

### Routing pattern

- **Primary model**: `9router/auto-medium` (9router combo: `cx/gpt-5.5-medium` → `ocg/deepseek-v4-pro`)
- **Small model**: `minimax/MiniMax-M3` (direct MiniMax provider, NOT through 9router)
- **Two-level fallback**:
  1. 9router internal: `cx/gpt-5.5-*` → `ocg/deepseek-v4-pro` (when GPT fails)
  2. opencode `fallback_models`: `9router/deepseek-v4-pro-high` → `minimax/MiniMax-M3` (when the whole combo fails)
- DeepSeek and GPT models go through 9router; MiniMax uses opencode's direct `minimax` provider.

---

## OpenCode integration (this deployment)

The OpenCode-side configuration is **out of this repo** (lives in `/home/ron/Documents/Projects/opencode/`, separate `DevEstacion/opencode-config` repo). Three OCX profiles:

| Profile | Default model | Use |
|---|---|---|
| `omo` (`oh-my-opencode.json`) | `9router/gpt-5.5-9router` (medium) | Primary dev profile. Agents: sisyphus/hephaestus/prometheus/oracle/atlas/multimodal-looker → 9router combo (medium); momus/ultrabrain → xhigh; librarian/explore/quick/writing/unspecified-low → M3 direct; metis → deepseek-medium direct; visual-engineering/artistry → xai-grok-high. |
| `kdco` (`opencode.jsonc`) | `minimax/MiniMax-M3` | Custom agent set (plan/build/coder/explore/researcher/scribe/reviewer). Most on 9router combo medium; reviewer on xhigh; scribe on M3. |
| `default` (`opencode.jsonc`) | inherits `9router/gpt-5.5-9router` | Vanilla OpenCode agents (build/plan/general/explore) — all on combo medium; explore on M3. |

Combo alias: **`9router/gpt-5.5-9router`** (not `openai/gpt-5.5-9router`).

Cross-tier fallback is enforced by `fallback_models` chains in each profile — each chain resolves to `[deepseek direct (opencode-go), xai direct, minimax direct (M3)]`. **Do not move cross-tier chains back into the 9router combo.**

---

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

---

## Common issues

- **Static files 404**: Build was done without `NEXT_DIST_DIR=.next-cli-build` or
  static files weren't copied into the standalone `.next-cli-build/static/`
  directory. Rebuild with the CLI params above.

- **Service won't start (status=218/CAPABILITIES)**: Security sandboxing in the
  service file is too aggressive for nvm-managed Node. Remove `ProtectSystem`,
  `ProtectHome`, etc.

- **Login page stuck at "Loading..."**: Static JS/CSS bundles aren't being
  served. Check `curl -o /dev/null -w "%{http_code}" http://localhost:20128/_next/static/css/*.css`.

- **Port already in use**: `fuser -k 20128/tcp`

- **DB initialized without password**: Delete `data/db/data.sqlite` and restart;
  the server will reinitialize with `INITIAL_PASSWORD` from `.env`.

- **MiniMax fails with tools through 9router**: 9router's MiniMax provider rejects
  tool payloads (`invalid params, invalid tool type: (2013)`). Plain chat works,
  but opencode's agent-mode tool calls fail. **Use the direct opencode `minimax`
  provider instead** — do not route MiniMax through 9router.

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
- When merging upstream, expected conflict files are typically: `src/app/api/usage/[connectionId]/route.js` (backfillCursorIdentity vs upstream apikey list), `src/app/(dashboard)/dashboard/usage/components/ProviderLimits/index.js` (AI_PROVIDERS import vs Kiro helpers), `open-sse/services/usage.js` (fork `xai` handler vs upstream `codebuddy-cn` handler), `cli/scripts/build-cli.js` (recursive vs nested-package detection), `AGENTS.md` (additive merge).

---

## Approved Models (pinned to fork's curated set)

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