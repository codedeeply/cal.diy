import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import process from "node:process";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const root = createRequire(resolve("package.json"));

function via(parent, dependency) {
  try {
    return createRequire(parent.resolve(`${dependency}/package.json`));
  } catch (error) {
    if (error.code !== "ERR_PACKAGE_PATH_NOT_EXPORTED") throw error;
    return createRequire(parent.resolve(dependency));
  }
}

const c8 = via(root, "c8");
const rimraf = via(c8, "rimraf");
const glob7 = via(rimraf, "glob");
const minimatch3 = via(glob7, "minimatch");
const web = createRequire(resolve("apps/web/package.json"));
const glob10 = via(web, "glob");
const minimatch9 = via(glob10, "minimatch");
const features = createRequire(resolve("packages/features/package.json"));
const trigger = via(features, "trigger.dev");
const minimatch10 = via(trigger, "minimatch");

const consumers = {
  1: { minimatch: minimatch3, minimatchVersion: "3.1.5", braceVersion: "1.1.18" },
  2: { minimatch: minimatch9, minimatchVersion: "9.0.9", braceVersion: "2.1.4" },
  5: { minimatch: minimatch10, minimatchVersion: "10.2.5", braceVersion: "5.0.9" },
};

const modeTimeouts = {
  "literal-groups": 1_000,
  "chained-intermediates": 2_000,
  "deep-chained-groups": 2_000,
  "comma-intermediates": 5_000,
  "padded-sequence": 1_000,
};

function braceExpand(requireFromMinimatch) {
  const imported = requireFromMinimatch("brace-expansion");
  if (typeof imported === "function") return imported;
  return imported.expand;
}

function minimatchApi(requireFromConsumer) {
  const imported = requireFromConsumer("minimatch");
  let match = imported.minimatch;
  if (typeof imported === "function") match = imported;
  return {
    match,
    expand: imported.braceExpand,
  };
}

function totalLength(expanded) {
  return expanded.reduce((total, value) => total + value.length, 0);
}

function assertTokensInOrder(source, tokens, entry) {
  let previousIndex = -1;
  for (const token of tokens) {
    const index = source.indexOf(token, previousIndex + 1);
    assert.notEqual(index, -1, `${entry} is missing ${JSON.stringify(token)} after offset ${previousIndex}`);
    previousIndex = index;
  }
}

function runRegression(line, mode) {
  const requireFromMinimatch = consumers[line].minimatch;
  const inheritedExpand = minimatchApi(requireFromMinimatch).expand;
  const directExpand = braceExpand(requireFromMinimatch);
  assert.equal(typeof inheritedExpand, "function");

  if (mode === "literal-groups") {
    const input = "a" + "{},".repeat(29) + "{}";
    assert.deepEqual(inheritedExpand(input), [input]);
    return;
  }

  if (mode === "chained-intermediates") {
    const expanded = inheritedExpand("{a,b}".repeat(48));
    assert.ok(expanded.length > 0 && expanded.length < 100_000);
    assert.ok(totalLength(expanded) <= 4_000_000);
    return;
  }

  if (mode === "deep-chained-groups") {
    const expanded = inheritedExpand("{a,b}".repeat(512));
    assert.ok(expanded.length > 0);
    assert.ok(totalLength(expanded) <= 4_000_000);
    assert.ok(expanded.every((value) => value.length === 512));
    return;
  }

  if (mode === "comma-intermediates") {
    const alternatives = Array.from({ length: 24 }, (_, index) => `a${String(index).padStart(2, "0")}`);
    const input = `{${alternatives.join(",")}}`;
    const inherited = inheritedExpand(input);
    assert.deepEqual(inherited, alternatives);

    const sequenceAlternative = "{00000001..00000008}";
    const intermediateInput = `{${Array.from({ length: 16 }, () => sequenceAlternative).join(",")}}`;
    // Sixteen alternatives retain bounded public maxLength output compatibility.
    const bounded = directExpand(intermediateInput, { max: 1_000_000_000, maxLength: 64 });
    assert.equal(bounded.length, 8);
    assert.equal(totalLength(bounded), 64);
    return;
  }

  assert.equal(mode, "padded-sequence");
  const input = "{00000001..00000040}";
  const inherited = inheritedExpand(input);
  assert.equal(inherited.length, 40);
  assert.equal(inherited[0], "00000001");
  assert.equal(inherited.at(-1), "00000040");

  const intermediateInput = "{00000001..99999999}";
  // max exceeds the range endpoint, so only maxLength can stop padded-sequence generation after eight values.
  const bounded = directExpand(intermediateInput, { max: 1_000_000_000, maxLength: 64 });
  assert.equal(bounded.length, 8);
  assert.equal(bounded[0], "00000001");
  assert.equal(bounded.at(-1), "00000008");
  assert.equal(totalLength(bounded), 64);
}

function runBoundedChild(line, mode) {
  const child = spawnSync(
    process.execPath,
    ["--max-old-space-size=64", "--stack-size=256", fileURLToPath(import.meta.url), line, mode],
    { encoding: "utf8", timeout: modeTimeouts[mode], maxBuffer: 64 * 1024 }
  );
  assert.ifError(child.error);
  assert.equal(child.signal, null, child.stderr || child.stdout);
  assert.equal(child.status, 0, child.stderr || child.stdout);
}

if (process.argv[2]) {
  assert.ok(Object.hasOwn(consumers, process.argv[2]));
  runRegression(process.argv[2], process.argv[3]);
} else {
  test("approved brace-expansion selectors match lock and installed minimatch consumers", () => {
    const manifest = root("./package.json");
    assert.equal(manifest.resolutions["@isaacs/brace-expansion"], "5.0.1");
    assert.deepEqual(
      Object.fromEntries(
        Object.entries(manifest.resolutions).filter(([selector]) => selector.startsWith("brace-expansion@"))
      ),
      {
        "brace-expansion@^5.0.2": "5.0.9",
        "brace-expansion@^5.0.5": "5.0.9",
        "brace-expansion@^2.0.1": "2.1.4",
        "brace-expansion@^2.0.2": "2.1.4",
        "brace-expansion@^1.1.7": "1.1.18",
      }
    );
    assert.equal(manifest.dependencies?.["brace-expansion"], undefined);
    assert.equal(manifest.devDependencies?.["brace-expansion"], undefined);

    assert.equal(manifest.devDependencies.c8, "7.13.0");
    assert.equal(c8("c8/package.json").dependencies.rimraf, "^3.0.2");
    assert.equal(rimraf("rimraf/package.json").dependencies.glob, "^7.1.3");
    assert.equal(glob7("glob/package.json").dependencies.minimatch, "^3.1.1");
    assert.equal(web("./package.json").devDependencies.glob, "10.4.5");
    assert.equal(glob10("glob/package.json").dependencies.minimatch, "^9.0.4");
    assert.equal(features("./package.json").devDependencies["trigger.dev"], "4.3.2");
    assert.equal(trigger("trigger.dev/package.json").dependencies.minimatch, "^10.0.1");

    const lock = readFileSync(resolve("yarn.lock"), "utf8");
    const versions = [...lock.matchAll(/^\s+resolution: "brace-expansion@npm:([^"]+)"$/gm)]
      .map((match) => match[1])
      .sort();
    assert.deepEqual(versions, ["1.1.18", "2.1.4", "5.0.9"]);
    assert.doesNotMatch(lock, /^\s+resolution: "brace-expansion@npm:(?:1\.1\.11|2\.0\.3|5\.0\.5)"$/m);

    for (const { minimatch, minimatchVersion, braceVersion } of Object.values(consumers)) {
      assert.equal(minimatch("minimatch/package.json").version, minimatchVersion);
      assert.equal(minimatch("brace-expansion/package.json").version, braceVersion);
    }
  });

  test("installed brace-expansion entries enforce cumulative comma maxLength before append", () => {
    const tokens = [
      "valuesLength = 0",
      "outer:",
      "valuesLength + v.length > maxLength",
      "break outer",
      "values.push(v)",
      "valuesLength += v.length",
    ];

    // Patched and prior implementations return identical final values, so source order proves early enforcement safely.
    for (const { minimatch, braceVersion } of Object.values(consumers)) {
      const entry = minimatch.resolve("brace-expansion");
      assertTokensInOrder(
        readFileSync(entry, "utf8"),
        tokens,
        `brace-expansion ${braceVersion} entry ${entry}`
      );
    }
  });

  test("brace expansion and minimatch retain normal compatibility across all three major lines", () => {
    for (const { minimatch } of Object.values(consumers)) {
      const expand = braceExpand(minimatch);
      const consumer = minimatchApi(minimatch);
      assert.deepEqual(expand("file-{a,b}.txt"), ["file-a.txt", "file-b.txt"]);
      assert.deepEqual(expand("v{03..07..2}"), ["v03", "v05", "v07"]);
      assert.deepEqual(consumer.expand("{src,test}/**/*.js"), ["src/**/*.js", "test/**/*.js"]);
      assert.equal(consumer.match("src/a.js", "{src,test}/**/*.js"), true);
      assert.equal(consumer.match("docs/a.js", "{src,test}/**/*.js"), false);
    }
  });

  for (const { mode, advisory, title } of [
    {
      mode: "literal-groups",
      advisory: "CVE-2026-13149",
      title:
        "30 consecutive non-expanding literal groups remain bounded through minimatch-inherited defaults",
    },
    {
      mode: "chained-intermediates",
      advisory: "CVE-2026-14257",
      title: "chained-group intermediate results remain bounded through minimatch-inherited defaults",
    },
    {
      mode: "deep-chained-groups",
      advisory: "CVE-2026-14257",
      title: "deep chained-group stack remains bounded through minimatch-inherited defaults",
    },
    {
      mode: "comma-intermediates",
      advisory: "CVE-2026-69152",
      title: "comma-alternative public API retains bounded maxLength output compatibility",
    },
    {
      mode: "padded-sequence",
      advisory: "CVE-2026-69152",
      title: "padded numeric sequences apply direct maxLength before the timing bound",
    },
  ]) {
    test(`${advisory}: ${title} across all major lines`, { timeout: 35_000 }, () => {
      for (const line of Object.keys(consumers)) runBoundedChild(line, mode);
    });
  }
}
