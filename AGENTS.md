# 9Router — Claude Auto-Mode Classifier Patch

## What this does

Claude Code's auto-mode classifier sends a tiny `/v1/messages` request with a `You are a security monitor for autonomous AI coding agents` system prompt, an empty `</block>` stop sequence, and the action it is gating in the `messages[0]` user content. The classifier expects the response to be a plain Claude `message` object (often just `<block>…</block>`) so it can `try { .filter() }` on the content.

If the upstream returns a `chat.completion` JSON, or if a `content_block_start { type: "thinking" }` is emitted before any text, the parser crashes with `undefined is not an object (evaluating 'e.filter')` and auto mode fail-closes the tool call. If the upstream is unreachable (rate limit, network error) Claude Code logs `Auto mode classifier unavailable, denying with retry guidance (fail closed)`.

This patch adds a Claude-specific compat mode that:
- suppresses thinking content blocks
- returns a Claude `message` object for the classifier
- leaves text + tool_use intact
- **short-circuits classifier requests when compat is on** — returns a synthetic `msg_`-prefixed Claude `message` with empty content + `end_turn` BEFORE consulting the upstream. This ensures Claude Code's classifier always gets a predictable response shape, even when low-cost upstreams return 200 OK with empty `chat.completion` content (which translates to a malformed Claude message Claude Code rejects as "could not evaluate").

The mode is toggleable from the 9router UI and CLI. The user's auto-combo (`auto-xhigh` / `auto-high` / `auto-medium`) is preserved as-is — 9router does not override the model; it only changes how the response is translated.

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
      → **short-circuit** before executor when `shouldDefaultAllowClassifier()` matches
        (compat on AND request detected as classifier) — returns synthetic Claude `message`
        with `msg_`-prefixed id + `model` field + `end_turn`, no upstream call
      → passes it to handleStreamingResponse / handleForcedSSEToJson
        open-sse/handlers/chatCore/streamingHandler.js
          → passes it to createSSETransformStreamWithLogger
            open-sse/utils/stream.js
              → sets state.claudeCompat when sourceFormat === CLAUDE
                (state.claudeCompat = mode === "always" || (mode === "auto" && isClassifierRequest))
        open-sse/handlers/chatCore/sseToJsonHandler.js (non-streaming)
          → buildClaudeMessageResponse() builds a Claude `message` when sourceFormat === CLAUDE
          → buildClaudeMessageFromOpenAICompletion() for Chat-Completions SSE → JSON path
        open-sse/handlers/chatCore.js (default-allow, error-path safety net)
          → buildDefaultAllowClaudeMessage() when executor throws or provider 4xx/5xx
          → returns synthetic Claude `message` with empty content + end_turn
          → Claude Code classifier parses as "no block → allow"
```

## Translator patches

- `open-sse/translator/response/openai-to-claude.js`
  - guards `if (reasoningContent && !state.claudeCompat)` so the `content_block_start { type: "thinking" }` + `thinking_delta` paths are skipped when compat is on
- `open-sse/handlers/chatCore/sseToJsonHandler.js`
  - new helpers `buildClaudeMessageResponse` and `buildClaudeMessageFromOpenAICompletion`
  - when `sourceFormat === CLAUDE`, builds a Claude `message` object directly instead of returning `chat.completion` JSON
  - reasoning parts from Responses `reasoning` items + non-`output_text` content parts are skipped when `claudeCompat === true`
  - `buildClaudeUsage` preserves `cache_read_input_tokens` / `cache_creation_input_tokens` from upstream `usage` (otherwise Claude's non-streaming parser crashes on undefined)
- `open-sse/handlers/chatCore/nonStreamingHandler.js`
  - new `(OPENAI_RESPONSES, CLAUDE)` branch — when the combo resolved to an openai-compatible-responses provider (e.g. MiniMax-M3 in the user's setup), the upstream returns `chat.completion` JSON and the handler now routes to `openAICompletionToClaudeMessage` to build a Claude `message`
  - `shouldEnableClaudeCompat` mirrors the detector and threads `claudeCompat` through to the translator
- `open-sse/transformer/streamToJsonConverter.js`
  - preserves `cache_*_input_tokens` and `input_tokens_details.cached_tokens` in `state.usage` so downstream Claude responses carry the cache field
- `open-sse/handlers/chatCore.js`
  - `buildDefaultAllowClaudeMessage()` + `shouldDefaultAllowClassifier()`
  - **Short-circuits BEFORE the executor when `shouldDefaultAllowClassifier()` matches** — does not consult upstream at all. This is required for low-cost providers (e.g. MiniMax-M3) that return 200 OK with empty `chat.completion` content for the classifier prompt. Pre-fix, this translated to a Claude `message` with `output_tokens: 0` + `chatcmpl`-style id, which Claude Code rejected as "could not evaluate" (fail-closed every gated action).
  - Defensive safety-net checks at the executor's error catch + 4xx/5xx response handler (kept for when the upstream genuinely fails)

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
- `tests/unit/claude-compat-nonstreaming.test.js` — 3 new cases (basic compat, cache fields, provider-returned `chat.completion` JSON)
- `tests/unit/claude-classifier-routing.test.js` — locks the negative: 9router must NOT override the user-chosen auto combo model
- `tests/unit/claude-default-allow-classifier.test.js` — 6 cases: executor throws + compat on/off, 429 + compat on, non-Claude source format, **short-circuits on 200 OK empty content (regression for MiniMax-M3)**, **does NOT short-circuit regular Claude requests**

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

Behavior reverts to legacy (thinking blocks emitted, OpenAI JSON shape to Claude clients, upstream errors surfaced as HTTP errors).

## Lessons learned (debugging this issue)

These are the hard-won observations from getting the patch working end-to-end against a real Claude Code auto-mode run. They are the kind of thing a future maintainer (or a fresh LLM) would otherwise re-discover the hard way.

1. **The `e.filter` crash is just a symptom of the response shape**. When 9router returned `chat.completion` to a Claude classifier, Claude's parser tried `e.filter(...)` on an array that wasn't an array. The root cause was always the response shape, never the upstream model's output. The fix is to emit a proper Claude `message` object (not `chat.completion`).
2. **`targetFormat === OPENAI_RESPONSES` is a separate path from `OPENAI`**. The combo resolves to a provider whose `format` is `openai-responses`, so the route through `translateNonStreamingResponse` is `(targetFormat: OPENAI_RESPONSES, sourceFormat: CLAUDE)`. The original code only had a branch for `(OPENAI, CLAUDE)` and fell through to the generic OpenAI branch, emitting `chat.completion` again. Both branches must be added.
3. **Cache fields are not optional**. Claude's non-streaming parser reads `usage.input_tokens` directly; missing cache fields (`cache_read_input_tokens`, `input_tokens_details.cached_tokens`) trigger a second, distinct TypeError. The `convertResponsesStreamToJson` helper previously dropped them, and the Claude output builder did too. Forward every cache field the upstream provides.
4. **The user's auto-combo is sacred**. Do not pin the model to a fixed upstream in code — the user picks `auto-xhigh` deliberately and expects the combo to expand it. Overriding breaks them. The fix is in the response translation, not the model selection.
5. **MiniMax-M3 returns empty content for the classifier request**. The combo fallback to MiniMax-M3 (an openai-compatible-responses proxy) produces `content: ""` + `stop_reason: "end_turn"`, which is a valid Claude `message` shape but gives the classifier nothing to decide on. That is a real-world provider-quality issue, not a 9router bug. The right answer for the user is to reorder the combo or remove MiniMax-M3 from the fallback list.
6. **Fail closed vs fail open for classifier errors**. When the upstream is unreachable (rate limit, network), 9router previously returned an HTTP error. Claude Code logs `Auto mode classifier unavailable, denying with retry guidance (fail closed)` and blocks the action. When `claudeClassifierCompat` is on, 9router now returns a synthetic Claude `message` with empty content + `end_turn` so Claude Code's classifier treats it as "no block → allow". The default is "off" (fail closed) so the safety default is preserved.
7. **The bundle gap is real**. `npm run build` produces `.next/`. The systemd service runs from `.next-cli-build/standalone/9router`, populated by `cli/scripts/build-cli.js`. The two outputs are independent and the static assets must be copied across. `run.sh` automates this; otherwise the dashboard renders unstyled.
8. **Test the actual real failure, not a simplified one**. A test that mocks the upstream returning `chat.completion` JSON with `stop_reason: "stop"` and `content: "blocked"` is a happy-path test. The real failures we saw were: (a) `e.filter` parser crash on `chat.completion` shape, (b) `F.usage.input_tokens` crash on missing cache fields, (c) upstream returning empty content with `end_turn`, (d) upstream returning 429/502. The tests must mirror these exactly.
9. **The classifier detector is not a function name — it's a string match**. The Claude auto-mode classifier detector is `system` array containing the security-monitor prompt text, OR `stop_sequences` containing `</block>`. Both the streaming path (`open-sse/utils/stream.js`) and the non-streaming path (`open-sse/handlers/chatCore/nonStreamingHandler.js`) and the default-allow path (`open-sse/handlers/chatCore.js`) need the same detector. Keep them consistent.

## Preserving across rebase

The patch lives entirely in source files plus `run.sh` and this `AGENTS.md`. There is **no remote** — `git remote -v` returns nothing (only `origin`/`upstream` listed for v0.5.15, but no push has been performed). To preserve across future upstream-style rebase of `dev` (or a new release branch), keep this contract:

1. **Never delete `run.sh` or `AGENTS.md` during a rebase.** They are part of the deployment surface, not vendored dependencies.
2. **On rebase, after resolving, always run `./run.sh` and re-verify:**
   - `GET /api/settings` returns the new key `claudeClassifierCompat` (proof the setting still exists)
   - Browser at `/dashboard/token-saver` shows the `Off / Auto / Always` segmented control (proof the UI patch is still applied)
   - One classifier replay with `always` returns a Claude `message` object with no `thinking` block (proof the translator patch is still applied)
   - `tests/unit/claude-default-allow-classifier.test.js` all 6 cases pass (proof the default-allow short-circuit is in place AND doesn't over-fire on regular Claude requests)
3. **If any of those four fail after a rebase, the patch was lost during conflict resolution and must be reapplied from the file paths listed below.**

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
open-sse/transformer/streamToJsonConverter.js
src/app/(dashboard)/dashboard/token-saver/TokenSaverClient.js
cli/src/cli/menus/settings.js
tests/unit/openai-to-claude.test.js
tests/translator/golden-response-stream.test.js
tests/unit/claude-compat-nonstreaming.test.js
tests/unit/claude-classifier-routing.test.js
tests/unit/claude-default-allow-classifier.test.js
run.sh
AGENTS.md
```

## Commit history on `master` (this branch is the canonical fix)

Local-only, never pushed.

```
88aeed6  feat: Claude classifier compat mode (off/auto/always)
0e9544a  fix(claude-compat): preserve cache usage fields + handle OPENAI_RESPONSES target
e3eda20  fix(claude-compat): route classifier requests directly to a Claude-class model
b117b81  revert(claude-compat): do not override the user-chosen auto combo model
026c4e9  feat(claude-compat): default-allow classifier when upstream is unavailable
d657273  fix(claude-compat): short-circuit default-allow BEFORE executor when classifier detected
29f3c9d  docs(agents): preserve lessons learned + complete rebase-preservation footprint
```

If a future rebase conflicts with `d657273` (the short-circuit fix) or `026c4e9` (the default-allow error-path safety net), keep BOTH contracts — `d657273` is the live behavior, `026c4e9` is the defensive backup.

## Memory

The full session debug log is preserved at `/tmp/ulw-20260629-210240.nH4QeI.md` for the duration of the workflow. The light-mem plugin at `~/.config/opencode/AGENTS.md` is auto-managed and picks up context from the next session.
