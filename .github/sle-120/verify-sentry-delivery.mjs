import process from "node:process";

// Polls the Sentry API until the proof's server, edge and browser errors are stored in this run's
// environment with this run's release, or fails after the deadline.
const { SENTRY_AUTH_TOKEN, SENTRY_ORG, SENTRY_PROJECT } = process.env;
const environment = process.env.SENTRY_PROOF_ENVIRONMENT;
const release = process.env.SENTRY_PROOF_RELEASE;
const label = process.env.SENTRY_PROOF_LABEL;
const expected = {
  nodejs: "SLE-120 Sentry verification (nodejs)",
  edge: "SLE-120 Sentry verification (edge)",
  browser: `SLE-120 Sentry verification (browser ${label})`,
};

async function api(path) {
  const response = await fetch(`https://sentry.io/api/0${path}`, {
    headers: { Authorization: `Bearer ${SENTRY_AUTH_TOKEN}` },
  });
  if (!response.ok) throw new Error(`Sentry API ${path.split("?")[0]} returned HTTP ${response.status}`);
  return response.json();
}

async function storedSources() {
  const query = encodeURIComponent(`environment:${environment} release:${release}`);
  const issues = await api(
    `/projects/${SENTRY_ORG}/${SENTRY_PROJECT}/issues/?query=${query}&environment=${environment}&statsPeriod=24h`
  );
  return Object.keys(expected).filter((source) =>
    issues.some((issue) => issue.title.includes(expected[source]))
  );
}

const deadline = Date.now() + 120_000;
let found = [];
while (Date.now() < deadline) {
  found = await storedSources();
  if (found.length === Object.keys(expected).length) break;
  await new Promise((resolve) => setTimeout(resolve, 10_000));
}
const missing = Object.keys(expected).filter((source) => !found.includes(source));
console.log(JSON.stringify({ environment, release, stored: found, missing }));
if (missing.length) {
  console.error(`Sentry did not store: ${missing.join(", ")}`);
  process.exitCode = 1;
}
