import process from "node:process";

export function isAuthorizedCronSecret(authorization: string | null): boolean {
  const secret = process.env.CRON_SECRET;
  return Boolean(secret?.trim()) && authorization === `Bearer ${secret}`;
}
