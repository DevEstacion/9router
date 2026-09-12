import sharp from "sharp";
import { FORMATS } from "../formats.js";
import { encodeDataUri, parseDataUri } from "./image.js";

export const INLINE_IMAGE_MAX_EDGE = 1600;
export const INLINE_IMAGE_JPEG_QUALITY = 80;
export const INLINE_IMAGE_MAX_DECODED_BYTES = 20 * 1024 * 1024;

const SUPPORTED_INPUT_MIMES = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/tiff",
  "image/avif",
]);

function imageUrlAccessor(block) {
  if (!block || typeof block !== "object") return null;
  if (block.type === "image_url") {
    if (typeof block.image_url === "string") {
      return { get: () => block.image_url, set: (url) => { block.image_url = url; } };
    }
    if (block.image_url && typeof block.image_url === "object") {
      return { get: () => block.image_url.url, set: (url) => { block.image_url.url = url; } };
    }
  }
  if (block.type === "input_image") {
    return { get: () => block.image_url, set: (url) => { block.image_url = url; } };
  }
  if (block.type === "image" && typeof block.url === "string") {
    return { get: () => block.url, set: (url) => { block.url = url; } };
  }
  return null;
}

function collectInlineImageAccessors(body, sourceFormat) {
  const items = sourceFormat === FORMATS.OPENAI ? body?.messages
    : sourceFormat === FORMATS.OPENAI_RESPONSES ? body?.input
    : null;
  if (!Array.isArray(items)) return [];

  const accessors = [];
  for (const item of items) {
    for (const block of Array.isArray(item?.content) ? item.content : []) {
      const accessor = imageUrlAccessor(block);
      if (accessor) accessors.push(accessor);
    }
    for (const key of ["images", "attachments", "experimental_attachments"]) {
      if (!Array.isArray(item?.[key])) continue;
      item[key].forEach((value, index) => {
        if (typeof value === "string") {
          accessors.push({ get: () => item[key][index], set: (url) => { item[key][index] = url; } });
        } else if (value && typeof value === "object" && typeof value.url === "string") {
          accessors.push({ get: () => value.url, set: (url) => { value.url = url; } });
        }
      });
    }
  }
  return accessors;
}

function decodedSize(base64) {
  const compactLength = base64.replace(/\s/g, "").length;
  return Math.floor(compactLength * 3 / 4);
}

async function normalizeDataImage(url) {
  const parsed = parseDataUri(url);
  if (!parsed || !SUPPORTED_INPUT_MIMES.has(parsed.mimeType)) return null;
  if (decodedSize(parsed.base64) > INLINE_IMAGE_MAX_DECODED_BYTES) return null;

  const input = Buffer.from(parsed.base64, "base64");
  if (!input.length) return null;
  const image = sharp(input, { animated: false, failOn: "warning" }).rotate();
  const metadata = await image.metadata();
  const width = metadata.autoOrient?.width || metadata.width || 0;
  const height = metadata.autoOrient?.height || metadata.height || 0;
  if (Math.max(width, height) > INLINE_IMAGE_MAX_EDGE) {
    image.resize({ width: INLINE_IMAGE_MAX_EDGE, height: INLINE_IMAGE_MAX_EDGE, fit: "inside", withoutEnlargement: true });
  }

  // PNG/WebP often carry an alpha channel even when every pixel is opaque.
  // Preserve PNG only when pixel statistics show transparency is actually used.
  let hasAlpha = false;
  if (metadata.hasAlpha === true) {
    const stats = await sharp(input, { animated: false, failOn: "warning" }).rotate().stats();
    const alpha = stats.channels[stats.channels.length - 1];
    hasAlpha = stats.isOpaque === false || alpha?.min < 255;
  }
  const output = hasAlpha
    ? await image.png({ compressionLevel: 9, adaptiveFiltering: true }).toBuffer()
    : await image.jpeg({ quality: INLINE_IMAGE_JPEG_QUALITY, mozjpeg: true }).toBuffer();
  const mimeType = hasAlpha ? "image/png" : "image/jpeg";
  const normalizedUrl = encodeDataUri(mimeType, output.toString("base64"));

  // Re-encoding tiny or already-efficient images can increase wire size.
  if (normalizedUrl.length >= url.length) return null;
  return { url: normalizedUrl, mimeType, hasAlpha, inputBytes: input.length, outputBytes: output.length };
}

/**
 * Normalize inline images in-place. Opaque inputs become bounded JPEGs;
 * transparency-bearing inputs stay PNG. Any decode error fails open.
 */
export async function normalizeInlineImages(body, sourceFormat) {
  const accessors = collectInlineImageAccessors(body, sourceFormat);
  const stats = { converted: 0, preservedAlpha: 0, savedBytes: 0, failed: 0 };
  const cache = new Map();

  for (const accessor of accessors) {
    const original = accessor.get();
    if (typeof original !== "string" || !original.startsWith("data:image/")) continue;
    let result = cache.get(original);
    if (result === undefined) {
      try { result = await normalizeDataImage(original); }
      catch { result = false; }
      cache.set(original, result || false);
    }
    if (!result) { stats.failed += 1; continue; }
    accessor.set(result.url);
    stats.converted += 1;
    if (result.hasAlpha) stats.preservedAlpha += 1;
    stats.savedBytes += result.inputBytes - result.outputBytes;
  }
  return stats;
}
