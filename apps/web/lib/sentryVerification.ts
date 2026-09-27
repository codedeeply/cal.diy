// Synthetic booker data sent through the real error path, so an operator can confirm in Sentry
// that scrubbing works end to end. None of it may appear in the stored event.
const SYNTHETIC_BOOKER = {
  name: "Quinn Synthetic-Booker",
  email: "quinn.booker@example.invalid",
  phone: "+1 415 555 0142",
};

const MIN_TOKEN_LENGTH = 32;

// Constant-time comparison without node:crypto, which the edge runtime does not provide.
function equalsInConstantTime(a: string, b: string): boolean {
  let difference = a.length ^ b.length;
  for (let index = 0; index < Math.max(a.length, b.length); index++) {
    difference |= (a.charCodeAt(index) || 0) ^ (b.charCodeAt(index) || 0);
  }
  return difference === 0;
}

/**
 * The verification routes stay inert (404) unless the operator sets a long per-run token and the
 * request presents it, so a deployment cannot be made to spam its Sentry project.
 */
function isAuthorizedSentryVerification(headerValue: string | null, token: string | undefined): boolean {
  if (!token || token.length < MIN_TOKEN_LENGTH || !headerValue) return false;
  return equalsInConstantTime(headerValue, token);
}

function createSentryVerificationError(runtime: "nodejs" | "edge"): Error {
  return new Error(
    `SLE-120 Sentry verification (${runtime}) for {"name":"${SYNTHETIC_BOOKER.name}","email":"${SYNTHETIC_BOOKER.email}","phone":"${SYNTHETIC_BOOKER.phone}"}`
  );
}

export { createSentryVerificationError, isAuthorizedSentryVerification, SYNTHETIC_BOOKER };
