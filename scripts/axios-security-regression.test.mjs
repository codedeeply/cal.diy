import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import process from "node:process";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const apiRequire = createRequire(resolve("apps/api/v2/package.json"));
const axios = apiRequire("axios");
const proxyEnvironmentKeys = [
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "ALL_PROXY",
  "NO_PROXY",
  "http_proxy",
  "https_proxy",
  "all_proxy",
  "no_proxy",
];

function snapshotProxyEnvironment() {
  return Object.fromEntries(proxyEnvironmentKeys.map((key) => [key, process.env[key]]));
}

function restoreProxyEnvironment(snapshot) {
  for (const key of proxyEnvironmentKeys) {
    if (snapshot[key] === undefined) delete process.env[key];
    else process.env[key] = snapshot[key];
  }
}

async function listen(server) {
  await new Promise((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolveListen);
  });
  return server.address().port;
}

async function close(server) {
  if (!server.listening) return;
  await new Promise((resolveClose) => {
    server.close(resolveClose);
    server.closeAllConnections?.();
  });
}

function cloneConfig(config) {
  return { ...config, headers: { ...config.headers } };
}

async function inheritedProxyRegression() {
  const environment = snapshotProxyEnvironment();
  let targetRequests = 0;
  let proxyRequests = 0;
  const target = createServer((_request, response) => {
    targetRequests += 1;
    response.end("ok");
  });
  const proxy = createServer((_request, response) => {
    proxyRequests += 1;
    response.end("no");
  });

  try {
    const targetPort = await listen(target);
    const proxyPort = await listen(proxy);
    const proxyUrl = `http://127.0.0.1:${proxyPort}`;
    for (const key of ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy"]) {
      process.env[key] = proxyUrl;
    }
    process.env.NO_PROXY = "127.0.0.1";
    process.env.no_proxy = "127.0.0.1";
    Object.defineProperty(Object.prototype, "proxy", {
      value: { protocol: "http", host: "127.0.0.1", port: proxyPort },
      configurable: true,
      enumerable: true,
      writable: true,
    });

    const client = axios.create();
    client.interceptors.request.use(cloneConfig);
    const response = await client.get(`http://127.0.0.1:${targetPort}/p`, { timeout: 1500 });
    assert.equal(response.data, "ok");
    assert.equal(targetRequests, 1);
    assert.equal(proxyRequests, 0);
  } finally {
    delete Object.prototype.proxy;
    restoreProxyEnvironment(environment);
    await Promise.all([close(target), close(proxy)]);
  }
}

async function inheritedNestedConfigRegression() {
  const environment = snapshotProxyEnvironment();
  let requestUrl;
  let authorizationPresent;
  const target = createServer((request, response) => {
    requestUrl = request.url;
    authorizationPresent = request.headers.authorization !== undefined;
    response.end("ok");
  });

  try {
    const targetPort = await listen(target);
    for (const key of proxyEnvironmentKeys) delete process.env[key];
    Object.defineProperties(Object.prototype, {
      paramsSerializer: {
        value: { serialize: () => "x=y" },
        configurable: true,
        enumerable: true,
        writable: true,
      },
      auth: {
        value: { username: "x", password: "y" },
        configurable: true,
        enumerable: true,
        writable: true,
      },
    });

    const client = axios.create();
    client.interceptors.request.use(cloneConfig);
    const response = await client.get(`http://127.0.0.1:${targetPort}/n`, {
      params: { q: "v" },
      timeout: 1500,
    });
    assert.equal(response.data, "ok");
    assert.equal(requestUrl, "/n?q=v");
    assert.equal(authorizationPresent, false);
  } finally {
    delete Object.prototype.paramsSerializer;
    delete Object.prototype.auth;
    restoreProxyEnvironment(environment);
    await close(target);
  }
}

function runChild(mode) {
  const result = spawnSync(process.execPath, [fileURLToPath(import.meta.url), mode], {
    encoding: "utf8",
    timeout: 5000,
    maxBuffer: 64 * 1024,
  });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr || result.stdout);
}

function nestedValue(depth) {
  let value = "x";
  for (let index = 0; index < depth; index += 1) value = { x: value };
  return value;
}

function collector() {
  const entries = [];
  return {
    entries,
    append(key, value) {
      entries.push([key, value]);
    },
  };
}

if (process.argv[2] === "proxy") {
  await inheritedProxyRegression();
} else if (process.argv[2] === "nested") {
  await inheritedNestedConfigRegression();
} else {
  test("Axios declarations, install and lock graph use exactly 1.18.0", { timeout: 5000 }, () => {
    assert.equal(apiRequire(resolve("package.json")).resolutions.axios, "1.18.0");
    assert.equal(apiRequire("./package.json").dependencies.axios, "1.18.0");
    assert.equal(apiRequire("axios/package.json").version, "1.18.0");
    const lock = readFileSync(resolve("yarn.lock"), "utf8");
    const versions = [...lock.matchAll(/^\s+resolution: "axios@npm:([^"]+)"$/gm)].map((match) => match[1]);
    assert.deepEqual(versions, ["1.18.0"]);
  });

  test("inherited proxy cannot divert an interceptor-cloned request", { timeout: 7000 }, () => {
    runChild("proxy");
  });

  test(
    "inherited nested serializer and auth fields are ignored after interceptor cloning",
    { timeout: 7000 },
    () => {
      runChild("nested");
    }
  );

  test("form serialization accepts shallow data and rejects excessive nesting", { timeout: 5000 }, () => {
    const shallow = collector();
    axios.toFormData({ a: "x", b: ["y", "z"] }, shallow);
    assert.deepEqual(shallow.entries, [
      ["a", "x"],
      ["b[]", "y"],
      ["b[]", "z"],
    ]);

    for (const input of [{ a: nestedValue(102) }, { "a{}": nestedValue(102) }]) {
      assert.throws(
        () => axios.toFormData(input, collector()),
        (error) => error?.code === "ERR_FORM_DATA_DEPTH_EXCEEDED"
      );
    }
  });
}
