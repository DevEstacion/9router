import { describe, expect, it } from "vitest";
import sharp from "sharp";
import { normalizeInlineImages, INLINE_IMAGE_MAX_EDGE } from "../../open-sse/translator/concerns/inlineImage.js";
import { parseDataUri } from "../../open-sse/translator/concerns/image.js";
import { FORMATS } from "../../open-sse/translator/formats.js";

const dataUri = (mimeType, buffer) => `data:${mimeType};base64,${buffer.toString("base64")}`;
const outputMetadata = async (url) => {
  const parsed = parseDataUri(url);
  return { parsed, metadata: await sharp(Buffer.from(parsed.base64, "base64")).metadata() };
};

describe("normalizeInlineImages", () => {
  it("downscales opaque PNG and converts it to JPEG", async () => {
    const png = await sharp({
      create: { width: 2400, height: 1200, channels: 4, background: { r: 30, g: 90, b: 180, alpha: 1 } },
    }).png().toBuffer();
    const body = { messages: [{ role: "user", content: [{ type: "image_url", image_url: { url: dataUri("image/png", png) } }] }] };

    const stats = await normalizeInlineImages(body, FORMATS.OPENAI);
    const { parsed, metadata } = await outputMetadata(body.messages[0].content[0].image_url.url);

    expect(stats.converted).toBe(1);
    expect(stats.preservedAlpha).toBe(0);
    expect(parsed.mimeType).toBe("image/jpeg");
    expect(Math.max(metadata.width, metadata.height)).toBe(INLINE_IMAGE_MAX_EDGE);
  });

  it("normalizes Grok image blocks that store the URI in url", async () => {
    const png = await sharp({
      create: { width: 2000, height: 1000, channels: 3, background: { r: 100, g: 30, b: 20 } },
    }).png().toBuffer();
    const body = { messages: [{ role: "user", content: [{ type: "image", url: dataUri("image/png", png) }] }] };

    const stats = await normalizeInlineImages(body, FORMATS.OPENAI);
    const { parsed } = await outputMetadata(body.messages[0].content[0].url);

    expect(stats.converted).toBe(1);
    expect(parsed.mimeType).toBe("image/jpeg");
  });

  it("preserves transparency by keeping PNG", async () => {
    const png = await sharp({
      create: { width: 1800, height: 900, channels: 4, background: { r: 20, g: 100, b: 200, alpha: 0.4 } },
    }).png().toBuffer();
    const body = { input: [{ role: "user", content: [{ type: "input_image", image_url: dataUri("image/png", png) }] }] };

    const stats = await normalizeInlineImages(body, FORMATS.OPENAI_RESPONSES);
    const { parsed, metadata } = await outputMetadata(body.input[0].content[0].image_url);

    expect(stats.converted).toBe(1);
    expect(stats.preservedAlpha).toBe(1);
    expect(parsed.mimeType).toBe("image/png");
    expect(metadata.hasAlpha).toBe(true);
    expect(Math.max(metadata.width, metadata.height)).toBe(INLINE_IMAGE_MAX_EDGE);
  });

  it("fails open for invalid image data", async () => {
    const url = "data:image/png;base64,bm90LWFuLWltYWdl";
    const body = { messages: [{ role: "user", content: [{ type: "image_url", image_url: { url } }] }] };

    const stats = await normalizeInlineImages(body, FORMATS.OPENAI);

    expect(stats.failed).toBe(1);
    expect(body.messages[0].content[0].image_url.url).toBe(url);
  });
});
