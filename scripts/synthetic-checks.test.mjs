import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { test } from "node:test";
import { promisify } from "node:util";
import { parseDsn } from "./synthetic-checks.mjs";

const run = promisify(execFile);

function listen(handler) {
  return new Promise((resolve) => {
    const server = createServer(handler).listen(0, "127.0.0.1", () => resolve(server));
  });
}

async function fixture({ databaseUp, pageBody = "<html>30min booking</html>" }) {
  const app = await listen((request, response) => {
    if (request.url === "/api/health") {
      response
        .writeHead(databaseUp ? 200 : 503)
        .end(JSON.stringify({ status: databaseUp ? "ok" : "unavailable" }));
    } else if (request.url === "/owner/30min") {
      response.writeHead(200).end(pageBody);
    } else response.writeHead(200).end("page");
  });
  const envelopes = [];
  const sentry = await listen((request, response) => {
    let body = "";
    request.on("data", (chunk) => (body += chunk));
    request.on("end", () => {
      envelopes.push({ url: request.url, auth: request.headers["x-sentry-auth"], body });
      response.writeHead(200).end("{}");
    });
  });
  const env = {
    ...process.env,
    BASE_URL: `http://127.0.0.1:${app.address().port}`,
    SENTRY_DSN: `http://publickey@127.0.0.1:${sentry.address().port}/42`,
    CANARY_BOOKING_PATH: "/owner/30min",
    SENTRY_ENVIRONMENT: "test",
  };
  const close = () => Promise.all([app, sentry].map((server) => new Promise((done) => server.close(done))));
  return { env, envelopes, close };
}

const items = (body) =>
  body
    .trim()
    .split("\n")
    .slice(1)
    .map((line) => JSON.parse(line));

test("a healthy instance reports one ok check-in", async () => {
  const { env, envelopes, close } = await fixture({ databaseUp: true });
  try {
    const { stdout } = await run("node", ["scripts/synthetic-checks.mjs"], { env });
    assert.equal(JSON.parse(stdout).status, "ok");
    assert.equal(envelopes.length, 1);
    assert.equal(envelopes[0].url, "/api/42/envelope/");
    assert.match(envelopes[0].auth, /sentry_key=publickey/);
    const [header, checkIn] = items(envelopes[0].body);
    assert.deepEqual(header, { type: "check_in" });
    assert.equal(checkIn.status, "ok");
    assert.equal(checkIn.monitor_slug, "caldiy-synthetic");
    assert.equal(checkIn.environment, "test");
    assert.equal(items(envelopes[0].body).length, 2);
  } finally {
    await close();
  }
});

test("a database outage reports an error check-in and a named failure event", async () => {
  const { env, envelopes, close } = await fixture({ databaseUp: false });
  try {
    await assert.rejects(run("node", ["scripts/synthetic-checks.mjs"], { env }), (error) => error.code === 1);
    const [, checkIn, eventHeader, event] = items(envelopes[0].body);
    assert.equal(checkIn.status, "error");
    assert.deepEqual(eventHeader, { type: "event" });
    assert.equal(event.message.formatted, "Synthetic check failed: database (HTTP 503)");
    assert.equal(event.tags.failed_checks, "database");
  } finally {
    await close();
  }
});

test("a 200 booking page without the event marker fails the booking check", async () => {
  const { env, envelopes, close } = await fixture({ databaseUp: true, pageBody: "<html>Bad gateway</html>" });
  try {
    await assert.rejects(run("node", ["scripts/synthetic-checks.mjs"], { env }), (error) => error.code === 1);
    const [, , , event] = items(envelopes[0].body);
    assert.equal(event.tags.failed_checks, "booking_page");
  } finally {
    await close();
  }
});

test("missing configuration and malformed DSNs fail closed", async () => {
  await assert.rejects(
    run("node", ["scripts/synthetic-checks.mjs"], { env: { PATH: process.env.PATH } }),
    (error) => error.code === 2
  );
  assert.throws(() => parseDsn("https://o1.ingest.sentry.io/42"));
  assert.throws(() => parseDsn("https://key@o1.ingest.sentry.io/not-a-project"));
});
