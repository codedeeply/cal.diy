import fs from "node:fs/promises";
import process from "node:process";
import { chromium } from "playwright";

const baseUrl = process.env.BASE_URL ?? "http://sgy971-app:3000";
const evidenceDir = process.env.EVIDENCE_DIR ?? "/artifacts";
const bookingPath = "/sgy-971-host/30-min";

await fs.mkdir(evidenceDir, { recursive: true });

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ locale: "en-US", timezoneId: "UTC" });
await context.addCookies([
  {
    name: "calcom-timezone-dialog",
    value: "1",
    url: baseUrl,
  },
]);

const page = await context.newPage();

try {
  const response = await page.goto(`${baseUrl}${bookingPath}`, { waitUntil: "domcontentloaded" });
  if (!response?.ok()) throw new Error(`Booking page returned HTTP ${response?.status() ?? "unknown"}`);

  const incrementMonth = page.getByTestId("incrementMonth");
  await incrementMonth.waitFor({ state: "visible", timeout: 60_000 });
  await page.locator('[data-testid="day"][data-disabled="false"]').first().waitFor({ timeout: 60_000 });

  const scheduleResponse = page.waitForResponse(
    (candidate) => candidate.url().includes("getSchedule") && candidate.status() === 200,
    { timeout: 60_000 }
  );
  await incrementMonth.click();
  await scheduleResponse;

  const firstAvailableDay = page.locator('[data-testid="day"][data-disabled="false"]').first();
  await firstAvailableDay.waitFor({ state: "visible", timeout: 60_000 });
  await firstAvailableDay.click();

  const firstTime = page.locator('[data-testid="time"]').first();
  await firstTime.waitFor({ state: "visible", timeout: 60_000 });
  await firstTime.click();

  await page.locator('[name="name"]').fill("SGY-971 Synthetic Attendee");
  await page.locator('[name="email"]').fill("sgy-971-attendee@example.invalid");

  const bookingResponse = page.waitForResponse((candidate) => candidate.url().includes("/api/book/event"), {
    timeout: 60_000,
  });
  await page.getByTestId("confirm-book-button").click();
  const booked = await bookingResponse;
  if (!booked.ok()) throw new Error(`Booking request returned HTTP ${booked.status()}`);

  await page.getByTestId("success-page").waitFor({ state: "visible", timeout: 60_000 });
  await page.screenshot({ path: `${evidenceDir}/booking-success.png`, fullPage: true });
  await fs.writeFile(
    `${evidenceDir}/booking-proof.json`,
    `${JSON.stringify(
      {
        bookingPath,
        bookingStatus: booked.status(),
        successVisible: true,
        completedAt: new Date().toISOString(),
      },
      null,
      2
    )}\n`
  );
  console.log("SGY-971 isolated booking proof: PASS");
} catch (error) {
  await page.screenshot({ path: `${evidenceDir}/booking-failure.png`, fullPage: true }).catch(() => {});
  throw error;
} finally {
  await browser.close();
}
