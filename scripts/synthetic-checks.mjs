#!/usr/bin/env node
// SLE-120 synthetic checks for a running Cal.diy: uptime, database reachability and the public
// booking page. Each run reports one Sentry cron check-in, so Sentry raises an issue when a run
// fails or stops arriving and resolves it when checks recover. The free Sentry plan allows one
// monitor, hence one check-in covering all three checks.
//
// Read-only on purpose: creating a booking every few minutes would fill the owner's calendar and
// send email. The full create-a-booking proof runs per release (scripts/sle-122-booking-proof.sh).
//
// Env: BASE_URL, SENTRY_DSN, CANARY_BOOKING_PATH (e.g. /owner/30min), SENTRY_ENVIRONMENT,
// SENTRY_RELEASE, MONITOR_SLUG (default caldiy-synthetic), CHECK_INTERVAL_MINUTES (default 5),
// CANARY_BOOKING_MARKER (text the booking page must contain; defaults to the event slug).
import { randomUUID } from "node:crypto";
import process from "node:process";
import { pathToFileURL } from "node:url";

const TIMEOUT_MS = 10_000;

function required(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable ${name}`);
  return value;
}

async function probe(url, accept) {
  try {
    const response = await fetch(url, { redirect: "manual", signal: AbortSignal.timeout(TIMEOUT_MS) });
    const body = await response.text();
    return accept(response, body) ? null : `HTTP ${response.status}`;
  } catch (error) {
    return error.name === "TimeoutError" ? "timeout" : "unreachable";
  }
}

async function runChecks(baseUrl, canaryPath, canaryMarker) {
  const checks = {
    uptime: () => probe(`${baseUrl}/auth/login`, (response) => response.status === 200),
    database: () =>
      probe(`${baseUrl}/api/health`, (response, body) => response.status === 200 && body.includes('"ok"')),
    // A proxy or error page can also answer 200, so the page must contain the event's marker.
    booking_page: () =>
      probe(
        `${baseUrl}${canaryPath}`,
        (response, body) => response.status === 200 && body.includes(canaryMarker)
      ),
  };
  const results = {};
  for (const [name, check] of Object.entries(checks)) results[name] = await check();
  return results;
}

function parseDsn(dsn) {
  const url = new URL(dsn);
  const projectId = url.pathname.replace(/^\//, "");
  if (!url.username || !/^\d+$/.test(projectId)) throw new Error("SENTRY_DSN is not a valid Sentry DSN");
  return { key: url.username, endpoint: `${url.protocol}//${url.host}/api/${projectId}/envelope/` };
}

async function sendEnvelope(dsn, items) {
  const { key, endpoint } = parseDsn(dsn);
  const lines = [JSON.stringify({ sent_at: new Date().toISOString(), dsn })];
  for (const [type, payload] of items) lines.push(JSON.stringify({ type }), JSON.stringify(payload));
  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      "content-type": "application/x-sentry-envelope",
      "x-sentry-auth": `Sentry sentry_version=7, sentry_key=${key}, sentry_client=caldiy-synthetic/1.0`,
    },
    body: `${lines.join("\n")}\n`,
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`Sentry rejected the check-in: HTTP ${response.status}`);
}

async function main() {
  const baseUrl = required("BASE_URL").replace(/\/$/, "");
  const dsn = required("SENTRY_DSN");
  const canaryPath = required("CANARY_BOOKING_PATH");
  // Defaults to the event slug (last path segment), which Cal renders into the booking page.
  const canaryMarker = process.env.CANARY_BOOKING_MARKER || canaryPath.split("/").filter(Boolean).pop();
  const environment = process.env.SENTRY_ENVIRONMENT || "production";
  const release = process.env.SENTRY_RELEASE || undefined;
  const slug = process.env.MONITOR_SLUG || "caldiy-synthetic";
  const interval = Number(process.env.CHECK_INTERVAL_MINUTES || 5);

  const started = Date.now();
  const results = await runChecks(baseUrl, canaryPath, canaryMarker);
  const failed = Object.entries(results).filter(([, failure]) => failure);
  const status = failed.length ? "error" : "ok";
  const items = [
    [
      "check_in",
      {
        check_in_id: randomUUID().replaceAll("-", ""),
        monitor_slug: slug,
        status,
        duration: (Date.now() - started) / 1000,
        environment,
        release,
        monitor_config: {
          schedule: { type: "interval", value: interval, unit: "minute" },
          checkin_margin: interval,
          max_runtime: 2,
          failure_issue_threshold: 1,
          recovery_threshold: 1,
        },
      },
    ],
  ];
  if (failed.length) {
    // The event names the failing checks so the alert is actionable; it carries no request data.
    const summary = failed.map(([name, failure]) => `${name} (${failure})`).join(", ");
    items.push([
      "event",
      {
        event_id: randomUUID().replaceAll("-", ""),
        timestamp: Date.now() / 1000,
        level: "error",
        platform: "node",
        environment,
        release,
        message: { formatted: `Synthetic check failed: ${summary}` },
        tags: { monitor: slug, failed_checks: failed.map(([name]) => name).join(",") },
        fingerprint: ["synthetic-check", ...failed.map(([name]) => name)],
      },
    ]);
  }
  await sendEnvelope(dsn, items);
  console.log(JSON.stringify({ monitor: slug, environment, status, results }));
  if (failed.length) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(`synthetic-checks: ${error.message}`);
    process.exitCode = 2;
  });
}

export { parseDsn, runChecks };
