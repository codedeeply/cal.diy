import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import process from "node:process";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";

const root = createRequire(resolve("package.json"));
function via(parent, dependency) {
  // Some parents expose only metadata; others hide metadata but export a runtime entry.
  try {
    return createRequire(parent.resolve(`${dependency}/package.json`));
  } catch (error) {
    if (error.code !== "ERR_PACKAGE_PATH_NOT_EXPORTED") throw error;
    return createRequire(parent.resolve(dependency));
  }
}
const tarRequire = via(root, "node-gyp");
const tar = tarRequire("tar");
const salesforce = createRequire(resolve("packages/app-store/salesforce/package.json"));
const faye = via(via(salesforce, "@jsforce/jsforce-node"), "faye");
const socketRequire = via(faye, "faye-websocket");
const Driver = socketRequire("websocket-driver");

function archiveEntry(path, data, type = "File") {
  const header = new tar.Header({ path, size: data.length, type, mode: 0o600, mtime: new Date(0) });
  header.encode();
  return Buffer.concat([header.block, data, Buffer.alloc((512 - (data.length % 512)) % 512)]);
}

async function selectedLongPath(command) {
  const directory = mkdtempSync(join(tmpdir(), "sle118-member-selection-"));
  try {
    const path = `${"a/".repeat(12_000)}fixture.txt`;
    const archive = Buffer.concat([
      archiveEntry("././@LongLink", Buffer.from(`${path}\0`), "NextFileHasLongPath"),
      archiveEntry("fixture.txt", Buffer.from("synthetic")),
      Buffer.alloc(1024),
    ]);
    assert.ok(archive.length < 32 * 1024);
    const file = join(directory, "fixture.tgz");
    const cwd = join(directory, "output");
    mkdirSync(cwd);
    writeFileSync(file, gzipSync(archive));
    const selected = [];
    await tar[command]({ file, cwd, onReadEntry: (entry) => selected.push(entry.path) }, ["selected"]);
    assert.deepEqual(selected, []);
    assert.deepEqual(readdirSync(cwd), []);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

function request(headers = {}) {
  return {
    method: "GET",
    url: "/synthetic",
    connection: {},
    headers: {
      host: "socket.example.test",
      origin: "https://example.test",
      connection: "Upgrade",
      upgrade: "websocket",
      ...headers,
    },
  };
}

if (process.argv[2]) {
  assert.ok(["t", "x"].includes(process.argv[2]));
  await selectedLongPath(process.argv[2]);
} else {
  test("approved resolutions match the lock graph and actual dependency paths", () => {
    assert.equal(root("./package.json").resolutions.tar, "7.5.21");
    assert.equal(root("./package.json").resolutions["faye-websocket/websocket-driver"], "0.7.5");
    const graph = root("yaml").parse(readFileSync("yarn.lock", "utf8"));
    for (const [name, version] of [
      ["tar", "7.5.21"],
      ["websocket-driver", "0.7.5"],
    ]) {
      const entries = Object.values(graph).filter((entry) => entry.resolution?.startsWith(`${name}@npm:`));
      assert.equal(entries.length, 1);
      assert.equal(entries[0].version, version);
    }
    const features = createRequire(resolve("packages/features/package.json"));
    const trigger = via(features, "trigger.dev");
    const web = createRequire(resolve("apps/web/package.json"));
    const sqlite = via(via(web, "@boxyhq/saml-jackson"), "sqlite3");
    const consumers = [
      tarRequire,
      via(via(tarRequire, "make-fetch-happen"), "cacache"),
      trigger,
      via(via(trigger, "c12"), "giget"),
      sqlite,
      via(sqlite, "node-gyp"),
    ];
    for (const consumer of consumers) assert.equal(consumer("tar/package.json").version, "7.5.21");
    assert.equal(socketRequire("websocket-driver/package.json").version, "0.7.5");
  });

  test("tar retains normal gzip creation, selected listing and async/sync extraction", async () => {
    const directory = mkdtempSync(join(tmpdir(), "sle118-archive-"));
    try {
      const source = join(directory, "source");
      mkdirSync(source);
      mkdirSync(join(source, "selected"));
      writeFileSync(join(source, "selected", "fixture.txt"), "synthetic archive content");
      writeFileSync(join(source, "other.txt"), "not selected");
      const file = join(directory, "fixture.tgz");
      await tar.c({ cwd: source, file, gzip: true }, ["selected/fixture.txt", "other.txt"]);
      for (const sync of [false, true]) {
        const entries = [];
        await tar.t({ file, sync, onReadEntry: (entry) => entries.push(entry.path) }, ["selected"]);
        assert.deepEqual(entries, ["selected/fixture.txt"]);
        const cwd = join(directory, String(sync));
        mkdirSync(cwd);
        await tar.x({ file, cwd, sync }, ["selected"]);
        assert.equal(readFileSync(join(cwd, "selected", "fixture.txt"), "utf8"), "synthetic archive content");
        assert.deepEqual(readdirSync(cwd), ["selected"]);
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("tar aborts excessive decompression by default using an eight-MiB memory-only fixture", () => {
    const archive = Buffer.concat([
      archiveEntry("fixture.bin", Buffer.alloc(8 * 1024 * 1024)),
      Buffer.alloc(1024),
    ]);
    const compressed = gzipSync(archive);
    assert.ok(archive.length / compressed.length > 1000);
    const parser = new tar.Parser({ onReadEntry: (entry) => entry.resume() });
    let aborts = 0;
    parser.on("abort", () => {
      aborts += 1;
    });
    assert.throws(
      () => parser.end(compressed),
      (error) =>
        error.tarCode === "TAR_ABORT" &&
        error.recoverable === false &&
        /max decompression ratio exceeded/.test(error.message)
    );
    parser.write(compressed);
    assert.equal(aborts, 1);
  });

  for (const command of ["t", "x"]) {
    test(`tar.${command}: selected long-path entries cannot exhaust the process stack`, () => {
      // A vulnerable parser can throw outside its promise; keep the comparison in a bounded child process.
      const child = spawnSync(
        process.execPath,
        ["--max-old-space-size=128", fileURLToPath(import.meta.url), command],
        { encoding: "utf8", timeout: 10_000, maxBuffer: 64 * 1024 }
      );
      assert.ifError(child.error);
      assert.equal(child.status, 0, child.stderr || child.stdout);
    });
  }

  for (const draft of [75, 76]) {
    const open = () => {
      const headers = draft === 76 ? { "sec-websocket-key1": "12 34", "sec-websocket-key2": "56 78" } : {};
      const driver = Driver.http(request(headers), { maxLength: 1024 });
      driver.start();
      if (draft === 76) driver.io.write(Buffer.alloc(8));
      assert.equal(driver.getState(), "open");
      assert.equal(driver.version, `hixie-${draft}`);
      return driver;
    };
    test(`WebSocket draft ${draft} preserves normal text frames`, () => {
      const driver = open();
      const messages = [];
      driver.on("message", (event) => messages.push(event.data));
      driver.io.write(Buffer.from([0, 0x6f, 0x6b, 0xff]));
      assert.deepEqual(messages, ["ok"]);
      driver.close();
    });
    test(`WebSocket draft ${draft} rejects an oversized length header before a body arrives`, () => {
      const driver = open();
      const messages = [];
      driver.on("message", (event) => messages.push(event.data));
      driver.io.write(Buffer.from([0x80, 0xff]));
      assert.equal(driver.getState(), "open");
      driver.io.write(Buffer.from([0xff]));
      assert.equal(driver.getState(), "closed");
      assert.deepEqual(messages, []);
    });
  }

  test(
    "modern WebSocket handshake, text, binary and ping work entirely in memory",
    { timeout: 5000 },
    async () => {
      const server = Driver.server({ maxLength: 1024 });
      const client = Driver.client("ws://socket.example.test/synthetic");
      server.on("connect", () => server.start());
      // Real socket delivery cannot re-enter start() before its state transition completes.
      client.io.on("data", (chunk) => queueMicrotask(() => server.io.write(chunk)));
      server.io.on("data", (chunk) => queueMicrotask(() => client.io.write(chunk)));
      const opened = once(client, "open");
      client.start();
      await opened;
      let received = once(server, "message");
      client.text("synthetic");
      assert.equal((await received)[0].data, "synthetic");
      received = once(server, "message");
      client.binary(Buffer.from([1, 2, 3]));
      assert.deepEqual((await received)[0].data, Buffer.from([1, 2, 3]));
      await new Promise((done) => client.ping("probe", done));
      const closed = once(client, "close");
      client.close();
      await closed;
      assert.equal(client.getState(), "closed");
    }
  );

  test("modern WebSocket enforces maximum size after extension processing", { timeout: 5000 }, async () => {
    const driver = Driver.http(
      request({
        "sec-websocket-version": "13",
        "sec-websocket-key": randomBytes(16).toString("base64"),
        "sec-websocket-extensions": "fixture-expand",
      }),
      { maxLength: 32 }
    );
    driver.addExtension({
      name: "fixture-expand",
      type: "permessage",
      rsv1: true,
      rsv2: false,
      rsv3: false,
      createServerSession: () => ({
        generateResponse: () => ({}),
        processIncomingMessage: (message, done) => done(null, { ...message, data: Buffer.alloc(33) }),
        processOutgoingMessage: (message, done) => done(null, message),
        close() {},
      }),
    });
    const errors = [];
    const messages = [];
    driver.on("error", (error) => errors.push(error.message));
    driver.on("message", (event) => messages.push(event.data));
    const outcome = new Promise((done) => {
      driver.once("close", (event) => done({ kind: "close", event }));
      driver.once("message", (event) => done({ kind: "message", event }));
    });
    driver.start();
    driver.io.write(Buffer.from([0xc1, 0x81, 0, 0, 0, 0, 0x61]));
    const result = await outcome;
    assert.equal(result.kind, "close");
    assert.equal(result.event.code, 1009);
    assert.deepEqual(messages, []);
    assert.equal(errors.length, 1);
    assert.match(errors[0], /too large/);
  });
}
