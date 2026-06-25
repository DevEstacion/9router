# AGENTS.md

## Project overview

9Router is a Next.js 16 web dashboard that acts as an AI router — it proxies
LLM API requests across 40+ providers with token compression, quota tracking,
and auto-fallback. The project ships as an npm CLI (`9router`) but we run it
from source via systemd.

- **Repo**: https://github.com/decolua/9router
- **Dashboard**: http://localhost:20128/dashboard
- **API base**: http://localhost:20128/v1
- **Health check**: `curl http://localhost:20128/api/health`

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
   static CSS/JS reliably.

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


## Data directory

The `data/` directory in the project root contains:
```
data/
└── db/
    ├── data.sqlite       # main DB
    └── backups/          # auto backups
```

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
