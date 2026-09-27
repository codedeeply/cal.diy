import { getFullName } from "@calcom/features/form-builder/utils";
import * as Sentry from "@sentry/nextjs";

type NameResponse = string | { firstName: string; lastName?: string } | undefined;

function isNameResponse(value: unknown): value is NameResponse {
  if (value === undefined || typeof value === "string") return true;
  return typeof value === "object" && value !== null && typeof Reflect.get(value, "firstName") === "string";
}

/**
 * The owner chose (SLE-120, 2026-09-26) to see which bookers an error affected, so the booker's
 * email and name become the Sentry user for this request. Only these two fields are exempt from
 * scrubbing; phone, notes, request bodies and IP addresses are still removed.
 */
function identifyBookerForSentry(responses: unknown): void {
  if (typeof responses !== "object" || responses === null) return;
  const email = Reflect.get(responses, "email");
  const name = Reflect.get(responses, "name");
  Sentry.setUser({
    email: typeof email === "string" && email ? email : undefined,
    username: isNameResponse(name) ? getFullName(name) || undefined : undefined,
  });
}

export { identifyBookerForSentry };
