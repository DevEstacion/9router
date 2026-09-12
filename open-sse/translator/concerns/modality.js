// Strip multimodal content blocks a model cannot read, BEFORE translation.
// Driven by getCapabilitiesForModel: vision/audioInput/pdf. Replaces removed
// media with a short text placeholder so messages never become empty.
import { FORMATS } from "../formats.js";

// Placeholder text inserted where a media block was removed.
// Current turn: explain the active model can't read what the user just sent.
const PLACEHOLDER_CURRENT = {
  vision: "[image omitted: model has no vision support]",
  audioInput: "[audio omitted: model has no audio support]",
  pdf: "[file omitted: model has no document support]",
};
// Earlier turns: neutral (a combo may route to a different model each turn).
const PLACEHOLDER_PREV = {
  vision: "[Previous image omitted from context.]",
  audioInput: "[Previous audio omitted from context.]",
  pdf: "[Previous file omitted from context.]",
};
const ph = (cap, isLast) => (isLast ? PLACEHOLDER_CURRENT : PLACEHOLDER_PREV)[cap];

// Grok Build can retain every prior screenshot as a base64 data URI while its
// context meter charges only vision tokens. Keep current-turn pixels, but bound
// historical inline image bytes before they make fallback payloads exceed model limits.
export const HISTORICAL_INLINE_IMAGE_CHAR_LIMIT = 1_000_000;
const HISTORICAL_IMAGE_PLACEHOLDER = "[Previous image omitted from context; use its saved file path if needed.]";

const dataImageLength = (value) =>
  typeof value === "string" && value.startsWith("data:image/") ? value.length : 0;

function openAIImageUrl(block) {
  if (block?.type === "image") return block.url;
  if (block?.type !== "image_url" && block?.type !== "input_image") return null;
  return typeof block.image_url === "string" ? block.image_url : block.image_url?.url;
}

/**
 * Remove old inline image bytes only when their combined size is pathological.
 * Latest user turn remains untouched so new image-analysis requests still work.
 */
export function pruneHistoricalInlineImages(body, sourceFormat, charLimit = HISTORICAL_INLINE_IMAGE_CHAR_LIMIT) {
  const items = sourceFormat === FORMATS.OPENAI ? body?.messages
    : sourceFormat === FORMATS.OPENAI_RESPONSES ? body?.input
    : null;
  if (!Array.isArray(items)) return { removed: 0, savedChars: 0 };

  const isAssistantOrTool = (item) => {
    const role = item?.role;
    if (role === "assistant" || role === "model" || role === "tool" || role === "function") return true;
    return ["function_call", "custom_tool_call", "function_call_output", "custom_tool_call_output"].includes(item?.type);
  };
  let lastAssistantOrTool = -1;
  items.forEach((item, index) => {
    if (isAssistantOrTool(item)) lastAssistantOrTool = index;
  });
  const currentUsers = new Set();
  items.forEach((item, index) => {
    if (index > lastAssistantOrTool && item?.role === "user") currentUsers.add(index);
  });

  const candidates = [];
  let historicalChars = 0;
  items.forEach((item, index) => {
    if (!item || currentUsers.has(index)) return;
    for (const block of Array.isArray(item.content) ? item.content : []) {
      const chars = dataImageLength(openAIImageUrl(block));
      if (chars) { historicalChars += chars; candidates.push({ item, block, chars, key: "content" }); }
    }
    for (const key of ["images", "attachments", "experimental_attachments"]) {
      for (const value of Array.isArray(item[key]) ? item[key] : []) {
        const chars = dataImageLength(typeof value === "string" ? value : value?.url);
        if (chars) { historicalChars += chars; candidates.push({ item, value, chars, key }); }
      }
    }
  });
  if (historicalChars <= charLimit) return { removed: 0, savedChars: 0 };

  let removed = 0;
  let savedChars = 0;
  const touched = new Set();
  for (const candidate of candidates) {
    if (historicalChars <= charLimit) break;
    const { item, block, value, chars, key } = candidate;
    item[key] = item[key].filter((entry) => entry !== (key === "content" ? block : value));
    if (item[key].length === 0 && key !== "content") delete item[key];
    historicalChars -= chars;
    savedChars += chars;
    removed += 1;
    touched.add(item);
  }
  for (const item of touched) {
    const marker = { type: sourceFormat === FORMATS.OPENAI_RESPONSES ? "input_text" : "text", text: HISTORICAL_IMAGE_PLACEHOLDER };
    if (Array.isArray(item.content)) item.content.push(marker);
    else item.content = [marker];
  }
  return { removed, savedChars };
}

// Map gemini inlineData/fileData mime prefix -> capability it requires.
function capForMime(mime) {
  if (typeof mime !== "string") return null;
  if (mime.startsWith("image/")) return "vision";
  if (mime.startsWith("audio/")) return "audioInput";
  if (mime === "application/pdf") return "pdf";
  return null;
}

// OpenAI chat content block -> required capability (null = plain text/other, keep).
function capForOpenAIBlock(block) {
  const t = block?.type;
  if (t === "image_url" || t === "image") return "vision";
  if (t === "input_audio" || t === "audio_url") return "audioInput";
  if (t === "file") return "pdf";
  return null;
}

// Claude content block -> required capability.
function capForClaudeBlock(block) {
  const t = block?.type;
  if (t === "image") return "vision";
  if (t === "document") return "pdf";
  return null;
}

// Filter an array of content blocks; drop unsupported, inject one placeholder per kind.
// isLast = block belongs to the current user turn (picks the explanatory placeholder).
function filterBlocks(blocks, capOf, caps, removed, isLast) {
  const out = [];
  for (const block of blocks) {
    const cap = capOf(block);
    if (cap && caps[cap] === false) { removed.add(cap); continue; }
    out.push(block);
  }
  for (const cap of removed) out.push({ type: "text", text: ph(cap, isLast) });
  return out;
}

// OpenAI / OpenAI-compatible chat messages[].content[].
function stripOpenAI(body, caps) {
  if (!Array.isArray(body.messages)) return;
  const last = body.messages.length - 1;
  body.messages.forEach((msg, i) => {
    if (caps.vision === false) {
      if (Array.isArray(msg.images)) delete msg.images;
      if (Array.isArray(msg.experimental_attachments)) {
        msg.experimental_attachments = msg.experimental_attachments.filter(
          (a) => !(a?.contentType?.startsWith("image/") || (typeof a?.url === "string" && a.url.startsWith("data:image/")))
        );
      }
      if (Array.isArray(msg.attachments)) {
        msg.attachments = msg.attachments.filter(
          (a) => !(a?.contentType?.startsWith("image/") || (typeof a?.url === "string" && a.url.startsWith("data:image/")))
        );
      }
    }
    if (!Array.isArray(msg.content)) return;
    const removed = new Set();
    msg.content = filterBlocks(msg.content, capForOpenAIBlock, caps, removed, i === last);
  });
}

// Claude messages[].content[].
function stripClaude(body, caps) {
  if (!Array.isArray(body.messages)) return;
  const last = body.messages.length - 1;
  body.messages.forEach((msg, i) => {
    if (!Array.isArray(msg.content)) return;
    const removed = new Set();
    msg.content = filterBlocks(msg.content, capForClaudeBlock, caps, removed, i === last);
  });
}

// OpenAI Responses input[].content[] (input_image / input_file).
function stripResponses(body, caps) {
  if (!Array.isArray(body.input)) return;
  const last = body.input.length - 1;
  body.input.forEach((item, i) => {
    if (!Array.isArray(item.content)) return;
    const removed = new Set();
    item.content = item.content.filter((b) => {
      const cap = b?.type === "input_image" ? "vision" : b?.type === "input_file" ? "pdf" : null;
      if (cap && caps[cap] === false) { removed.add(cap); return false; }
      return true;
    });
    for (const cap of removed) item.content.push({ type: "input_text", text: ph(cap, i === last) });
  });
}

// Gemini / gemini-cli contents[].parts[] (inlineData / fileData by mime).
function stripGeminiParts(contents, caps) {
  if (!Array.isArray(contents)) return;
  const last = contents.length - 1;
  contents.forEach((c, i) => {
    if (!Array.isArray(c.parts)) return;
    const removed = new Set();
    c.parts = c.parts.filter((p) => {
      const mime = p?.inlineData?.mimeType || p?.fileData?.mimeType;
      const cap = capForMime(mime);
      if (cap && caps[cap] === false) { removed.add(cap); return false; }
      return true;
    });
    for (const cap of removed) c.parts.push({ text: ph(cap, i === last) });
  });
}

/**
 * Remove media blocks the model can't read, in-place on the source-format body.
 * @param {object} body - request body (source format)
 * @param {string} sourceFormat - one of FORMATS
 * @param {object} caps - capabilities from getCapabilitiesForModel
 * @returns {boolean} true if anything was stripped-eligible (cap false for some modality)
 */
export function stripUnsupportedModalities(body, sourceFormat, caps) {
  if (!body || !caps) return false;
  // Fast exit: model supports everything we'd strip.
  if (caps.vision !== false && caps.audioInput !== false && caps.pdf !== false) return false;

  switch (sourceFormat) {
    case FORMATS.OPENAI:
    case FORMATS.OLLAMA:
    case FORMATS.KIRO:
    case FORMATS.CURSOR:
    case FORMATS.COMMANDCODE:
      stripOpenAI(body, caps);
      break;
    case FORMATS.CLAUDE:
      stripClaude(body, caps);
      break;
    case FORMATS.OPENAI_RESPONSES:
    case FORMATS.OPENAI_RESPONSE:
    case FORMATS.CODEX:
      stripResponses(body, caps);
      break;
    case FORMATS.GEMINI:
    case FORMATS.GEMINI_CLI:
    case FORMATS.VERTEX:
      stripGeminiParts(body.contents, caps);
      break;
    case FORMATS.ANTIGRAVITY:
      stripGeminiParts(body?.request?.contents, caps);
      break;
    default:
      stripOpenAI(body, caps);
  }
  return true;
}
