import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { test } from "node:test";

const manifest = JSON.parse(
  readFileSync(new URL("../packages/embeds/embed-core/package.json", import.meta.url), "utf8")
);
const copyCommand = manifest.scripts.__build.split(" && ").at(-1);

test("embed build copies assets recursively without an undeclared package download", (t) => {
  const match = /^node -e '([^']+)'$/.exec(copyCommand);
  assert.ok(match, "asset copy must use only the installed Node executable");
  const root = mkdtempSync(join(tmpdir(), "embed-build-copy-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const workspace = join(root, "packages/embeds/embed-core");
  const source = join(root, "apps/web/public/embed");
  mkdirSync(join(workspace, "dist"), { recursive: true });
  mkdirSync(join(source, "nested"), { recursive: true });
  writeFileSync(join(workspace, "dist/index.d.ts"), "export {};\n");
  writeFileSync(join(source, "embed.js"), "synthetic embed");
  writeFileSync(join(source, "nested/asset.css"), "synthetic css");
  const copy = () => spawnSync(process.execPath, ["-e", match[1]], { cwd: workspace, encoding: "utf8" });
  const first = copy();
  assert.ifError(first.error);
  assert.equal(first.status, 0, first.stderr);
  assert.equal(readFileSync(join(workspace, "dist/embed/embed.js"), "utf8"), "synthetic embed");
  assert.equal(readFileSync(join(workspace, "dist/embed/nested/asset.css"), "utf8"), "synthetic css");
  assert.equal(readFileSync(join(workspace, "dist/index.d.ts"), "utf8"), "export {};\n");
  writeFileSync(join(source, "embed.js"), "updated embed");
  const repeated = copy();
  assert.ifError(repeated.error);
  assert.equal(repeated.status, 0, repeated.stderr);
  assert.equal(readFileSync(join(workspace, "dist/embed/embed.js"), "utf8"), "updated embed");
  rmSync(source, { recursive: true });
  const missing = copy();
  assert.ifError(missing.error);
  assert.notEqual(missing.status, 0, "missing source assets must fail the build");
});
