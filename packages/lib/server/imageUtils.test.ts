import { createRequire } from "node:module";
import { resolve } from "node:path";
import sharp from "sharp";
import { describe, expect, it, vi } from "vitest";
import { convertSvgToPng, detectContentType, resizeImage } from "./imageUtils";

const source = { create: { width: 8, height: 4, channels: 3 as const, background: "#123456" } };
const formats = ["png", "jpeg", "webp", "avif"] as const;

describe("approved native Sharp dependency", () => {
  it.each(["apps/web", "packages/lib"])("%s directly resolves exact Sharp 0.35.4", (workspace) => {
    const require = createRequire(resolve(workspace, "package.json"));
    expect(require("./package.json").dependencies.sharp).toBe("0.35.4");
    expect(require("sharp").versions.sharp).toBe("0.35.4");
  });

  it("loads the repaired prebuilt libvips and libheif", () => {
    expect(sharp.versions.vips).toBe("8.18.6");
    expect(sharp.versions.heif).toBe("1.23.2");
  });
});

describe("native image helpers", () => {
  it.each(formats)("decodes and resizes real %s bytes without changing the format", async (format) => {
    const buffer = await sharp(source).toFormat(format).toBuffer();
    expect(await detectContentType(buffer)).toBe(`image/${format}`);
    const result = await resizeImage({ buffer, width: 4, quality: 80 });
    expect(result.contentType).toBe(`image/${format}`);
    expect(await detectContentType(result.buffer)).toBe(`image/${format}`);
    const decoded = await sharp(result.buffer).raw().toBuffer({ resolveWithObject: true });
    expect(decoded.info.width).toBe(4);
    expect(decoded.info.height).toBe(2);
    expect(decoded.data.length).toBeGreaterThan(0);
  });

  it("detects generated AVIF from canonical Sharp metadata", async () => {
    const buffer = await sharp(source).avif().toBuffer();
    expect(await sharp(buffer).metadata()).toMatchObject({
      format: "heif",
      compression: "av1",
    });
    expect(await detectContentType(buffer)).toBe("image/avif");
  });

  it("does not classify unrelated HEIF compression as AVIF", async () => {
    const buffer = await sharp(source).avif().toBuffer();
    const unrelatedHeifBuffer = Buffer.from(buffer);
    unrelatedHeifBuffer.write("mif1", 8, "ascii");

    expect(await sharp(unrelatedHeifBuffer).metadata()).toMatchObject({
      format: "heif",
      compression: "hevc",
      mediaType: "image/heic",
    });
    expect((await sharp(unrelatedHeifBuffer).raw().toBuffer()).length).toBeGreaterThan(0);
    expect(await detectContentType(unrelatedHeifBuffer)).toBeNull();
  });

  it("does not enlarge small images unless a height is explicitly requested", async () => {
    const buffer = await sharp(source).png().toBuffer();
    const unchanged = await resizeImage({ buffer, width: 16 });
    expect((await sharp(unchanged.buffer).metadata()).width).toBe(8);
    const resized = await resizeImage({ buffer, width: 16, height: 16 });
    expect(await sharp(resized.buffer).metadata()).toMatchObject({ width: 16, height: 16 });
  });

  it("applies EXIF orientation before resizing", async () => {
    const buffer = await sharp(source).withMetadata({ orientation: 6 }).jpeg().toBuffer();
    const result = await resizeImage({ buffer, width: 2 });
    expect(await sharp(result.buffer).metadata()).toMatchObject({ width: 2, height: 4 });
  });

  it("converts SVG avatar and logo inputs to PNG", async () => {
    const svg = Buffer.from(
      '<svg xmlns="http://www.w3.org/2000/svg" width="8" height="4"><rect width="8" height="4" fill="red"/></svg>'
    );
    const avatar = await convertSvgToPng(`data:image/svg+xml;base64,${svg.toString("base64")}`);
    expect(avatar.startsWith("data:image/png;base64,")).toBe(true);
    expect(await sharp(Buffer.from(avatar.split(",")[1], "base64")).metadata()).toMatchObject({
      format: "png",
      width: 8,
      height: 4,
    });
    const logo = await resizeImage({ buffer: svg, width: 4 });
    expect(logo.contentType).toBe("image/png");
    expect(await sharp(logo.buffer).metadata()).toMatchObject({ format: "png", width: 4, height: 2 });
  });

  it.each(formats)("rejects a truncated %s rather than returning image output", async (format) => {
    const encoded = await sharp(source).toFormat(format).toBuffer();
    await expect(resizeImage({ buffer: encoded.subarray(0, 16), width: 2 })).rejects.toThrow();
  });

  it("rejects non-image data and leaves non-SVG avatar data unchanged", async () => {
    const buffer = Buffer.from("not an image");
    expect(await detectContentType(buffer)).toBeNull();
    await expect(resizeImage({ buffer, width: 2 })).rejects.toThrow();
    expect(await convertSvgToPng("data:image/png;base64,unchanged")).toBe("data:image/png;base64,unchanged");
  });

  it.each([
    "invalid SVG",
    "x".repeat(5 * 1024 * 1024 + 1),
  ])("returns a valid placeholder for malformed or oversized SVG input", async (input) => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const result = await convertSvgToPng(
        `data:image/svg+xml;base64,${Buffer.from(input).toString("base64")}`
      );
      expect(await sharp(Buffer.from(result.split(",")[1], "base64")).metadata()).toMatchObject({
        format: "png",
        width: 1,
        height: 1,
      });
      expect(consoleError).toHaveBeenCalledOnce();
    } finally {
      consoleError.mockRestore();
    }
  });
});
