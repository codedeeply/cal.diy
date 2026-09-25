import process from "node:process";

type CronAuthOptions = {
  /** Routes invoked by Vercel Cron also accept `Authorization: Bearer <CRON_SECRET>`. */
  allowCronSecret?: boolean;
};

/**
 * An empty or unset credential must never authenticate: the blank API key value shipped in
 * `.env.example` would otherwise match an empty `apiKey` query parameter, and an unset cron
 * secret would match the literal header `Bearer undefined`.
 */
export function isAuthorizedCronRequest(
  apiKey: string | null,
  { allowCronSecret = false }: CronAuthOptions = {}
): boolean {
  if (!apiKey) return false;
  // Trimming only detects a deliberately quoted blank value; matching stays exact so a
  // configured credential is compared byte-for-byte, as before.
  const cronApiKey = process.env.CRON_API_KEY;
  if (cronApiKey?.trim() && apiKey === cronApiKey) return true;
  const cronSecret = process.env.CRON_SECRET;
  return allowCronSecret && Boolean(cronSecret?.trim()) && apiKey === `Bearer ${cronSecret}`;
}
