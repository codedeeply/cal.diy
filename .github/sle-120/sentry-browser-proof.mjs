import fs from "node:fs/promises";
import process from "node:process";
import { chromium } from "playwright";

// Throws a synthetic-booker error in a real page and waits for Sentry to accept the envelope.
const baseUrl = process.env.BASE_URL ?? "http://localhost:3000";
const evidenceDir = process.env.EVIDENCE_DIR ?? "/artifacts";
const marker = process.env.PROOF_MARKER ?? "browser";

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();
try {
  await page.goto(`${baseUrl}/auth/login`, { waitUntil: "networkidle" });
  const accepted = page.waitForResponse(
    (response) => /\.sentry\.io\/api\/\d+\/envelope\//.test(response.url()) && response.request().method() === "POST",
    { timeout: 60_000 }
  );
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
