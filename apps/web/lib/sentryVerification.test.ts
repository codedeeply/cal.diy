import { describe, expect, it } from "vitest";
import { scrubEvent } from "./sentryPrivacy";
import {
  createSentryVerificationError,
  isAuthorizedSentryVerification,
  SYNTHETIC_BOOKER,
} from "./sentryVerification";

const token = "a".repeat(32);

describe("isAuthorizedSentryVerification", () => {
  it("stays inert without a sufficiently long configured token", () => {
    expect(isAuthorizedSentryVerification(token, undefined)).toBe(false);
    expect(isAuthorizedSentryVerification("", "")).toBe(false);
    expect(isAuthorizedSentryVerification("short", "short")).toBe(false);
  });

  it("requires the exact token", () => {
    expect(isAuthorizedSentryVerification(null, token)).toBe(false);
    expect(isAuthorizedSentryVerification(`${token}x`, token)).toBe(false);
    expect(isAuthorizedSentryVerification("b".repeat(32), token)).toBe(false);
    expect(isAuthorizedSentryVerification(token, token)).toBe(true);
  });
});

describe("createSentryVerificationError", () => {
  it("carries synthetic booker data that the scrubber removes", () => {
    const error = createSentryVerificationError("edge");
    const event = scrubEvent({ exception: { values: [{ type: "Error", value: error.message }] } });
    const value = event.exception?.values?.[0].value ?? "";
    expect(value).toContain("SLE-120 Sentry verification (edge)");
    for (const secret of Object.values(SYNTHETIC_BOOKER)) expect(value).not.toContain(secret);
  });
});
