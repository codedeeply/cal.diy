import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import process from "node:process";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const workspaces = {
  "apps/web": "16.3.5",
  "apps/docs": "15.5.24",
  "packages/platform/examples/base": "16.3.5",
  "example-apps/credential-sync": "15.5.24",
};

async function checkWorkspace(workspace) {
  const require = createRequire(resolve(workspace, "package.json"));
  const version = workspaces[workspace];
  assert.ok(version, "workspace must have an approved Next.js version");
  assert.equal(require("./package.json").dependencies.next, version);
  assert.equal(require("next/package.json").version, version);
  const nextRequire = createRequire(require.resolve("next/package.json"));
  const sharp = nextRequire("sharp");
  assert.equal(sharp.versions.sharp, "0.35.4");
  const { imageOptimizer, detectContentType } = require("next/dist/server/image-optimizer");
  const source = { create: { width: 4, height: 4, channels: 3, background: "#123456" } };
  const png = await sharp(source).png().toBuffer();
  const avif = await sharp(source).avif().toBuffer();
  const optimize = (buffer) =>
    imageOptimizer(
      { buffer, etag: "isolated-fixture", cacheControl: "max-age=60" },
      { href: "/synthetic-image", width: 2, quality: 75, mimeType: "image/webp" },
      { images: { minimumCacheTTL: 60, dangerouslyAllowSVG: false }, experimental: {} },
      { isDev: false, silent: true }
    );

  const optimizedPng = await optimize(png);
  assert.equal(optimizedPng.contentType, "image/webp");
  assert.equal(await detectContentType(optimizedPng.buffer), "image/webp");
  assert.equal((await sharp(optimizedPng.buffer).metadata()).width, 2);

  const optimizedAvif = await optimize(avif);
  if (version.startsWith("15.")) {
    assert.equal(optimizedAvif.contentType, "image/avif");
    assert.deepEqual(optimizedAvif.buffer, avif);
  } else {
    // Next 16.3.4 restored AVIF only after requiring the repaired Sharp decoder.
    assert.equal(optimizedAvif.contentType, "image/webp");
    assert.equal(await detectContentType(optimizedAvif.buffer), "image/webp");
    assert.equal((await sharp(optimizedAvif.buffer).metadata()).width, 2);
  }
  await assert.rejects(
    optimize(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="4" height="4"></svg>')),
    (error) => error.statusCode === 400 && /not allowed/.test(error.message)
  );
}

if (process.argv[2]) {
  await checkWorkspace(process.argv[2]);
} else {
  for (const [workspace, version] of Object.entries(workspaces)) {
    test(`${workspace}: locked Next ${version}, native decoder and safe image behavior`, () => {
      // Sharp loader policy is process-global, so each Next branch needs isolation.
      const result = spawnSync(process.execPath, [fileURLToPath(import.meta.url), workspace], {
        encoding: "utf8",
        timeout: 30_000,
      });
      assert.ifError(result.error);
      assert.equal(result.status, 0, result.stderr || result.stdout);
    });
  }
}
