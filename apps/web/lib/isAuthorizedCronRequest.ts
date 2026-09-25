import process from "node:process";

type CronAuthOptions = {
  /** Routes invoked by Vercel Cron also accept `Authorization: Bearer <CRON_SECRET>`. */
  allowCronSecret?: boolean;
};

/**
 * An empty or unset credential must never authenticate: `CRON_API_KEY=` copied from
 * `.env.example` would otherwise match `?apiKey=`, and an unset `CRON_SECRET` would match the
 * literal header `Bearer undefined`.
 */
export function isAuthorizedCronRequest(
  apiKey: string | null,
  { allowCronSecret = false }: CronAuthOptions = {}
): boolean {
  if (!apiKey) return false;
  // A deliberately quoted blank value is as unconfigured as an empty one.
  const cronApiKey = process.env.CRON_API_KEY?.trim();
  if (cronApiKey && apiKey === cronApiKey) return true;
  const cronSecret = process.env.CRON_SECRET?.trim();
  return allowCronSecret && Boolean(cronSecret) && apiKey === `Bearer ${cronSecret}`;
}
