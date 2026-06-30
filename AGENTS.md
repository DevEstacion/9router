# 9Router — Claude Auto-Mode Classifier Patch

## What this does

Claude Code's auto-mode classifier sends a tiny `/v1/messages` request with a `You are a security monitor for autonomous AI coding agents` system prompt, an empty `</block>` stop sequence, and the action it is gating in the `messages[0]` user content. The classifier expects the response to be a plain Claude `message` object (often just `<block>…</block>`) so it can `try { .filter() }` on the content.

If the upstream returns a `chat.completion` JSON, or if a `content_block_start { type: "thinking" }` is emitted before any text, the parser crashes with `undefined is not an object (evaluating 'e.filter')` and auto mode fail-closes the tool call.

This patch adds a Claude-specific compat mode that:
- suppresses thinking content blocks
- returns a Claude `message` object for the classifier
- leaves text + tool_use intact

The mode is toggleable from the 9router UI and CLI.

## Setting

- Key: `claudeClassifierCompat`
- Default: `"off"`
- Values: `"off"` | `"auto"` | `"always"`
- Storage: `src/lib/db/repos/settingsRepo.js:45` (single-row `settings` JSON blob)
- API: `GET/PATCH /api/settings` (no schema change required; the route accepts arbitrary keys and merges into the existing JSON)

`auto` auto-detects the classifier by checking the request body for:
- `system` array containing the security-monitor prompt, OR
- `stop_sequences` containing `</block>`

## Runtime path

```
src/sse/handlers/chat.js
  → reads chatSettings.claudeClassifierCompat from getSettings()
  → passes it to handleChatCore(...)
    open-sse/handlers/chatCore.js
      → threads it into sharedCtx
      → passes it to handleStreamingResponse / handleForcedSSEToJson
        open-sse/handlers/chatCore/streamingHandler.js
          → passes it to createSSETransformStreamWithLogger
            open-sse/utils/stream.js
              → sets state.claudeCompat when sourceFormat === CLAUDE
                (state.claudeCompat = mode === "always" || (mode === "auto" && isClassifierRequest))
        open-sse/handlers/chatCore/sseToJsonHandler.js (non-streaming)
          → buildClaudeMessageResponse() builds a Claude `message` when sourceFormat === CLAUDE
          → buildClaudeMessageFromOpenAICompletion() for Chat-Completions SSE → JSON path
```

## Translator patches

- `open-sse/translator/response/openai-to-claude.js`
  - guards `if (reasoningContent && !state.claudeCompat)` so the `content_block_start { type: "thinking" }` + `thinking_delta` paths are skipped when compat is on
- `open-sse/handlers/chatCore/sseToJsonHandler.js`
  - new helpers `buildClaudeMessageResponse` and `buildClaudeMessageFromOpenAICompletion`
  - when `sourceFormat === CLAUDE`, builds a Claude `message` object directly instead of returning `chat.completion` JSON
  - reasoning parts from Responses `reasoning` items + non-`output_text` content parts are skipped when `claudeCompat === true`

## UI surfaces

- Dashboard: `src/app/(dashboard)/dashboard/token-saver/TokenSaverClient.js`
  - `SegmentedControl` with `Off / Auto / Always`
  - mirrors `claudeClassifierCompat` from `GET /api/settings`, PATCHes on change
- CLI menu: `cli/src/cli/menus/settings.js`
  - cycles `off → auto → always → off` via `api.updateSettings`
  - header shows current mode color-coded (red = off, yellow = auto, green = always)

## Tests

- `tests/unit/openai-to-claude.test.js` — 4 new compat-mode cases (suppress thinking / preserve text / preserve tool_use / mixed)
- `tests/translator/golden-response-stream.test.js` — new compat-mode case for the stream-level path
- `tests/unit/claude-compat-nonstreaming.test.js` — new case for the non-streaming Claude `message` path

## Deploy

Use the project-root `run.sh` script — it does the full build + static sync + service restart + smoke test in one command:

```bash
./run.sh
```

Internally it runs:
```bash
cd cli && node scripts/build-cli.js
cp -r cli/app/.next-cli-build/static .next-cli-build/standalone/9router/.next-cli-build/static
systemctl --user restart 9router.service
```

### Why the static copy step is needed

The cli build script writes the static assets to `cli/app/.next-cli-build/static`, but the running service reads from `<repo>/.next-cli-build/standalone/9router/.next-cli-build/static`. The bundle's `server.js` has `distDir: "./.next-cli-build"`. Without copying static across, `/_next/static/*` returns 404 and the dashboard renders unstyled / missing assets. `run.sh` automates this.

`npm run build` alone is **not** sufficient; use `./run.sh`.

## Rollback

Set `claudeClassifierCompat` to `"off"` via the dashboard, CLI, or:
```bash
curl -X PATCH http://127.0.0.1:20128/api/settings \
  -H 'Content-Type: application/json' \
  -d '{"claudeClassifierCompat":"off"}'
```

Behavior reverts to legacy (thinking blocks emitted, OpenAI JSON shape to Claude clients).

## Preserving across rebase

The patch lives entirely in source files plus `run.sh` and this `AGENTS.md`. There is **no remote** — `git remote -v` returns nothing. To preserve across future upstream-style rebase of `dev` (or a new release branch), keep this contract:

1. Never delete `run.sh` or `AGENTS.md` during a rebase. They are part of the deployment surface, not vendored dependencies.
2. On rebase, after resolving, always run `./run.sh` and re-verify:
   - `GET /api/settings` returns the new key `claudeClassifierCompat` (proof the setting still exists)
   - Browser at `/dashboard/token-saver` shows the `Off / Auto / Always` segmented control (proof the UI patch is still applied)
   - One classifier replay with `always` returns a Claude `message` object with no `thinking` block (proof the translator patch is still applied)
3. If any of those three fail after a rebase, the patch was lost during conflict resolution and must be reapplied from the file paths listed above.

Source-file footprint of the patch (keep this list when reviewing a rebase):

```
src/lib/db/repos/settingsRepo.js
src/sse/handlers/chat.js
open-sse/handlers/chatCore.js
open-sse/handlers/chatCore/streamingHandler.js
open-sse/handlers/chatCore/sseToJsonHandler.js
open-sse/handlers/chatCore/nonStreamingHandler.js
open-sse/utils/stream.js
open-sse/translator/response/openai-to-claude.js
src/app/(dashboard)/dashboard/token-saver/TokenSaverClient.js
cli/src/cli/menus/settings.js
tests/unit/openai-to-claude.test.js
tests/translator/golden-response-stream.test.js
tests/unit/claude-compat-nonstreaming.test.js
run.sh
AGENTS.md
```
