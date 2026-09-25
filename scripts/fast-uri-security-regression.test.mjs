import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
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

const ajvRequire = via(root, "ajv");
const fastUri = ajvRequire("fast-uri");

test("the exact fast-uri resolution matches AJV's installed dependency graph", () => {
  const manifest = root("./package.json");
  assert.deepEqual(
    Object.fromEntries(
      Object.entries(manifest.resolutions).filter(([selector]) => selector.startsWith("fast-uri"))
    ),
    { "fast-uri@^3.0.1": "3.1.8" }
  );
  assert.equal(manifest.dependencies?.["fast-uri"], undefined);
  assert.equal(manifest.devDependencies?.["fast-uri"], undefined);
  assert.equal(ajvRequire("ajv/package.json").dependencies["fast-uri"], "^3.0.1");
  assert.equal(ajvRequire("fast-uri/package.json").version, "3.1.8");

  const lock = root("yaml").parse(readFileSync(resolve("yarn.lock"), "utf8"));
  const fastUriEntries = Object.values(lock).filter((entry) => entry.resolution?.startsWith("fast-uri@npm:"));
  assert.equal(fastUriEntries.length, 1);
  assert.equal(fastUriEntries[0].version, "3.1.8");
  assert.equal(fastUriEntries[0].resolution, "fast-uri@npm:3.1.8");

  const consumers = Object.values(lock).filter((entry) => entry.dependencies?.["fast-uri"]);
  assert.equal(consumers.length, 1);
  assert.equal(consumers[0].dependencies["fast-uri"], "npm:^3.0.1");
});

test("GHSA-hrr3-gc8f-f4qj: encoded uppercase host octets normalize consistently", () => {
  const encoded = "//%41.example/path";
  const normalized = "//a.example/path";

  assert.equal(fastUri.parse(encoded).host, "a.example");
  assert.equal(fastUri.normalize(encoded), normalized);
  assert.equal(fastUri.normalize(normalized), normalized);
  assert.equal(fastUri.equal(encoded, normalized), true);
  assert.equal(fastUri.normalize("//%2541.example/path"), "//%2541.example/path");
});

test("GHSA-qw65-cvwx-89v3: serialize rejects authority injection through a port", () => {
  assert.throws(() =>
    fastUri.serialize({
      scheme: "https",
      host: "trusted.example",
      port: "@alternate.example:8443",
      path: "/v1",
    })
  );
  assert.equal(
    fastUri.serialize({ scheme: "https", host: "trusted.example", port: "8443", path: "/v1" }),
    "https://trusted.example:8443/v1"
  );
});

test("patched normalization keeps malformed and nested authority data inert", () => {
  const malformedIpv6 = "https://[::not-valid]/private";
  assert.ok(fastUri.parse(malformedIpv6).error);
  assert.equal(fastUri.normalize(malformedIpv6), malformedIpv6);

  const nestedHost = "https://%2573%2561%2566%2565.example/private";
  assert.equal(fastUri.normalize(nestedHost), nestedHost);
  assert.equal(fastUri.equal(nestedHost, "https://safe.example/private"), false);

  const backslashAuthority = String.raw`https://alternate.example\@trusted.example/private`;
  assert.ok(fastUri.parse(backslashAuthority).error);
  assert.equal(fastUri.normalize(backslashAuthority), backslashAuthority);
});

test("valid URI parsing, serialization, and normalization remain compatible", () => {
  const parsed = fastUri.parse("https://User@Example.COM:8443/a%2Fb?mode=test#section");
  assert.equal(parsed.error, undefined);
  assert.equal(parsed.host, "example.com");
  assert.equal(parsed.port, 8443);
  assert.equal(parsed.path, "/a%2Fb");
  assert.equal(
    fastUri.serialize({ scheme: "https", host: "example.com", path: "/calendar", query: "view=week" }),
    "https://example.com/calendar?view=week"
  );
  assert.equal(fastUri.normalize("HTTPS://Example.COM/calendar"), "https://example.com/calendar");
});

test("AJV compiles and validates relative schema references with the installed URI resolver", () => {
  const Ajv = root("ajv");
  const ajv = new Ajv();
  assert.equal(ajv.opts.uriResolver, fastUri);
  ajv.addSchema({
    $id: "https://schemas.example/person.json",
    type: "object",
    required: ["name"],
    properties: { name: { type: "string", minLength: 1 } },
    additionalProperties: false,
  });

  const validate = ajv.compile({
    $id: "https://schemas.example/people.json",
    type: "array",
    items: { $ref: "person.json" },
  });

  assert.equal(validate([{ name: "Ada" }]), true);
  assert.equal(validate([{ name: "" }]), false);
  assert.equal(validate([{ name: "Ada", extra: true }]), false);
});
