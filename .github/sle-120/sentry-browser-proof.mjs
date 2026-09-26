import fs from "node:fs/promises";
import process from "node:process";
import { chromium } from "playwright";

// Throws a synthetic-booker error in a real page and waits for Sentry to accept the envelope.
const baseUrl = process.env.BASE_URL ?? "http://localhost:3000";
const evidenceDir = process.env.EVIDENCE_DIR ?? "/artifacts";
const marker = process.env.PROOF_MARKER ?? "browser";

// Parsing the URL keeps the match to Sentry's ingest host rather than any URL containing it.
function isSentryEnvelope(response) {
  const url = new URL(response.url());
  return (
    response.request().method() === "POST" &&
    url.hostname.endsWith(".ingest.us.sentry.io") &&
    /^\/api\/\d+\/envelope\/$/.test(url.pathname)
  );
}

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();
try {
  await page.goto(`${baseUrl}/auth/login`, { waitUntil: "networkidle" });
  const accepted = page.waitForResponse((response) => isSentryEnvelope(response), { timeout: 60_000 });
  await page.evaluate((id) => {
    setTimeout(() => {
      throw new Error(
        `SLE-120 Sentry verification (browser ${id}) for {"name":"Quinn Synthetic-Booker","email":"quinn.booker@example.invalid","phone":"+1 415 555 0142"}`
      );
    });
  }, marker);
  const response = await accepted;
  const result = { envelopeStatus: response.status(), marker };
  await fs.writeFile(`${evidenceDir}/browser-proof.json`, `${JSON.stringify(result)}\n`);
  if (response.status() !== 200) throw new Error(`Sentry envelope returned HTTP ${response.status()}`);
  console.log(`SLE-120 browser Sentry proof: PASS ${JSON.stringify(result)}`);
} finally {
  await browser.close();
}
