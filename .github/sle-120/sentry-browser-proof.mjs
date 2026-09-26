import fs from "node:fs/promises";
import process from "node:process";
import { chromium } from "playwright";

// Throws a synthetic-booker error in a real page and waits for Sentry to accept the envelope.
const baseUrl = process.env.BASE_URL ?? "http://localhost:3000";
const evidenceDir = process.env.EVIDENCE_DIR ?? "/artifacts";
const marker = process.env.PROOF_MARKER ?? "browser";

const ingestHost = new URL(process.env.SENTRY_DSN ?? "").hostname;
const errorText = `SLE-120 Sentry verification (browser ${marker})`;

// Parsing the URL keeps the match to the configured DSN's ingest host, and the payload check makes
// sure the accepted envelope is the one carrying this run's synthetic error.
function isProofEnvelope(response) {
  const request = response.request();
  const url = new URL(response.url());
  return (
    request.method() === "POST" &&
    url.hostname === ingestHost &&
    /^\/api\/\d+\/envelope\/$/.test(url.pathname) &&
    (request.postData() ?? "").includes(errorText)
  );
}

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();
try {
  await page.goto(`${baseUrl}/auth/login`, { waitUntil: "networkidle" });
  const accepted = page.waitForResponse((response) => isProofEnvelope(response), { timeout: 60_000 });
  await page.evaluate((text) => {
    setTimeout(() => {
      throw new Error(
        `${text} for {"name":"Quinn Synthetic-Booker","email":"quinn.booker@example.invalid","phone":"+1 415 555 0142"}`
      );
    });
  }, errorText);
  const response = await accepted;
  const result = { envelopeStatus: response.status(), marker };
  await fs.writeFile(`${evidenceDir}/browser-proof.json`, `${JSON.stringify(result)}\n`);
  if (response.status() !== 200) throw new Error(`Sentry envelope returned HTTP ${response.status()}`);
  console.log(`SLE-120 browser Sentry proof: PASS ${JSON.stringify(result)}`);
} finally {
  await browser.close();
}
