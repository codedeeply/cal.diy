import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import process from "node:process";
import { test } from "node:test";

const root = createRequire(resolve("package.json"));

function via(parent, dependency) {
  try {
    return createRequire(parent.resolve(`${dependency}/package.json`));
  } catch (error) {
    if (error.code !== "ERR_PACKAGE_PATH_NOT_EXPORTED") throw error;
    return createRequire(parent.resolve(dependency));
  }
}

function workspace(path) {
  return createRequire(resolve(path, "package.json"));
}

function version(required) {
  return required("postcss/package.json").version;
}

const web = workspace("apps/web");
const embedCore = workspace("packages/embeds/embed-core");
const atoms = workspace("packages/platform/atoms");
const docs = workspace("apps/docs");
const platformBase = workspace("packages/platform/examples/base");
const postcss = web("postcss");
const sourceContentMarker = ".source-content-marker { color: rebeccapurple }";

const expectedResolutions = {
  "postcss@8.4.31": "8.5.28",
  "postcss@8.5.6": "8.5.28",
  "postcss@8.5.23": "8.5.28",
  "postcss@^8.3.11": "8.5.28",
  "postcss@^8.4.23": "8.5.28",
  "postcss@^8.4.41": "8.5.28",
  "postcss@^8.5.3": "8.5.28",
};

const expectedDependencySelectors = ["8.4.31", "8.5.23", "8.5.6", "^8.3.11", "^8.4.23", "^8.4.41", "^8.5.3"];

test("the exact PostCSS resolutions cover every installed dependency selector", async () => {
  const manifest = root("./package.json");
  assert.deepEqual(
    Object.fromEntries(
      Object.entries(manifest.resolutions).filter(([selector]) => selector.startsWith("postcss@"))
    ),
    expectedResolutions
  );
  assert.equal(manifest.dependencies?.postcss, undefined);
  assert.equal(manifest.devDependencies?.postcss, undefined);

  const yaml = root("yaml");
  const lock = yaml.parse(await readFile(resolve("yarn.lock"), "utf8"));
  const postcssEntries = Object.values(lock).filter((entry) => entry.resolution?.startsWith("postcss@npm:"));
  assert.equal(postcssEntries.length, 1);
  assert.equal(postcssEntries[0].version, "8.5.28");
  assert.equal(postcssEntries[0].resolution, "postcss@npm:8.5.28");

  const dependencySelectors = Object.values(lock)
    .map((entry) => entry.dependencies?.postcss)
    .filter(Boolean)
    .map((selector) => selector.replace(/^npm:/, ""));
  assert.deepEqual([...new Set(dependencySelectors)].sort(), expectedDependencySelectors.toSorted());

  const installedVersions = [
    version(web),
    version(embedCore),
    version(atoms),
    version(via(docs, "next")),
    version(via(platformBase, "next")),
    version(via(atoms, "vite")),
    version(via(web, "@tailwindcss/postcss")),
  ];
  assert.deepEqual(new Set(installedVersions), new Set(["8.5.28"]));
});

async function withFixture(run) {
  const parent = process.env.CALCOM_SECURITY_TEST_TMP_ROOT || tmpdir();
  const directory = await mkdtemp(join(parent, "cal-postcss-security-"));
  try {
    await run(directory);
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
}

function sourceMap(source) {
  return JSON.stringify({
    version: 3,
    file: "input.css",
    sources: [source],
    sourcesContent: [sourceContentMarker],
    names: [],
    mappings: "AAAA",
  });
}

async function generatedMap(css, options) {
  const result = await postcss().process(css, { ...options, map: { inline: false } });
  return result.map.toJSON();
}

test("GHSA-r28c-9q8g-f849 rejects traversal to a source map outside the CSS directory", async () => {
  await withFixture(async (directory) => {
    const cssDirectory = join(directory, "css");
    await mkdir(cssDirectory);
    await writeFile(join(directory, "outside.map"), sourceMap("outside-marker.scss"));

    const map = await generatedMap("a{}\n/*# sourceMappingURL=../outside.map */", {
      from: join(cssDirectory, "input.css"),
      to: join(cssDirectory, "output.css"),
    });
    assert.ok(!map.sources.some((source) => source.includes("outside-marker.scss")));
    assert.ok(!map.sourcesContent?.includes(sourceContentMarker));
  });
});

test("source map symlinks cannot escape the CSS directory", async () => {
  await withFixture(async (directory) => {
    const cssDirectory = join(directory, "css");
    await mkdir(cssDirectory);
    await writeFile(join(directory, "outside.map"), sourceMap("symlink-outside-marker.scss"));
    await symlink("../outside.map", join(cssDirectory, "outside-link.map"));

    const escapedMap = await generatedMap("a{}\n/*# sourceMappingURL=outside-link.map */", {
      from: join(cssDirectory, "input.css"),
      to: join(cssDirectory, "output.css"),
    });
    assert.ok(!escapedMap.sources.some((source) => source.includes("symlink-outside-marker.scss")));
    assert.ok(!escapedMap.sourcesContent?.includes(sourceContentMarker));

    await writeFile(join(cssDirectory, "inside.map"), sourceMap("symlink-inside-marker.scss"));
    await symlink("inside.map", join(cssDirectory, "inside-link.map"));
    const inTreeMap = await generatedMap("a{}\n/*# sourceMappingURL=inside-link.map */", {
      from: join(cssDirectory, "input.css"),
      to: join(cssDirectory, "inside-output.css"),
    });
    assert.ok(inTreeMap.sources.some((source) => source.includes("symlink-inside-marker.scss")));
    assert.ok(inTreeMap.sourcesContent?.includes(sourceContentMarker));
  });
});

test("GHSA-6g55-p6wh-862q rejects non-map annotations without exposing file content", async () => {
  await withFixture(async (directory) => {
    const marker = "SYNTHETIC_NON_MAP_CONTENT_MARKER";
    const input = join(directory, "input.css");
    await writeFile(join(directory, "not-a-map.json"), marker);

    let result;
    let processingError;
    try {
      result = await postcss().process("a{}\n/*# sourceMappingURL=not-a-map.json */", {
        from: input,
        to: join(directory, "output.css"),
        map: { inline: false },
      });
    } catch (error) {
      processingError = error;
    }

    assert.ok(!String(processingError ?? "").includes(marker));
    assert.equal(processingError, undefined);
    assert.ok(!result.css.includes(marker));
    assert.ok(!result.map.toString().includes(marker));
    assert.ok(!result.map.toJSON().sourcesContent?.includes(marker));
  });
});

test("GHSA-fxqj-rqcc-2cmp rejects absolute and traversal source maps without from", async () => {
  await withFixture(async (directory) => {
    const nested = join(directory, "nested");
    const mapPath = join(directory, "outside.map");
    await mkdir(nested);
    await writeFile(mapPath, sourceMap("outside-marker.scss"));

    const absoluteMap = await generatedMap(`a{}\n/*# sourceMappingURL=${mapPath} */`, {
      from: undefined,
      to: join(directory, "absolute-output.css"),
    });
    assert.ok(!absoluteMap.sources.some((source) => source.includes("outside-marker.scss")));
    assert.ok(!absoluteMap.sourcesContent?.includes(sourceContentMarker));

    const originalDirectory = process.cwd();
    process.chdir(nested);
    try {
      const traversalMap = await generatedMap("a{}\n/*# sourceMappingURL=../outside.map */", {
        from: undefined,
        to: join(directory, "traversal-output.css"),
      });
      assert.ok(!traversalMap.sources.some((source) => source.includes("outside-marker.scss")));
      assert.ok(!traversalMap.sourcesContent?.includes(sourceContentMarker));
    } finally {
      process.chdir(originalDirectory);
    }
  });
});

test("legitimate same-directory and inline source maps remain compatible", async () => {
  await withFixture(async (directory) => {
    const input = join(directory, "input.css");
    await writeFile(join(directory, "input.css.map"), sourceMap("original.scss"));

    const externalMap = await generatedMap("a{}\n/*# sourceMappingURL=input.css.map */", {
      from: input,
      to: join(directory, "output.css"),
    });
    assert.ok(externalMap.sources.some((source) => source.includes("original.scss")));
    assert.ok(externalMap.sourcesContent?.includes(sourceContentMarker));

    const inline = Buffer.from(sourceMap("inline.scss")).toString("base64");
    const inlineMap = await generatedMap(
      `a{}\n/*# sourceMappingURL=data:application/json;base64,${inline} */`,
      { from: input, to: join(directory, "inline-output.css") }
    );
    assert.ok(inlineMap.sources.some((source) => source.includes("inline.scss")));
    assert.ok(inlineMap.sourcesContent?.includes(sourceContentMarker));
  });
});

test("normal PostCSS transforms remain compatible", async () => {
  const plugin = {
    postcssPlugin: "synthetic-color-transform",
    Declaration(declaration) {
      if (declaration.prop === "color") declaration.value = "blue";
    },
  };
  const result = await postcss([plugin]).process("a { color: red }", { from: undefined });
  assert.equal(result.css, "a { color: blue }");
});
