import { afterEach, describe, expect, it, vi } from "vitest";
import { isAuthorizedCronRequest } from "./isAuthorizedCronRequest";

describe("isAuthorizedCronRequest", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("accepts the configured API key", () => {
    vi.stubEnv("CRON_API_KEY", "configured-key");
    expect(isAuthorizedCronRequest("configured-key")).toBe(true);
    expect(isAuthorizedCronRequest("other-key")).toBe(false);
  });

  it("rejects an empty key when CRON_API_KEY is empty, as copied from .env.example", () => {
    vi.stubEnv("CRON_API_KEY", "");
    expect(isAuthorizedCronRequest("")).toBe(false);
    expect(isAuthorizedCronRequest(null)).toBe(false);
  });

  it("rejects the coerced strings and any real-looking key when CRON_API_KEY is unset", () => {
    vi.stubEnv("CRON_API_KEY", undefined);
    vi.stubEnv("CRON_SECRET", undefined);
    for (const key of ["undefined", "null", "a-real-looking-key"]) {
      expect(isAuthorizedCronRequest(key)).toBe(false);
    }
  });

  it("treats whitespace-only credentials as unconfigured", () => {
    vi.stubEnv("CRON_API_KEY", " ");
    vi.stubEnv("CRON_SECRET", " ");
    expect(isAuthorizedCronRequest(" ")).toBe(false);
    expect(isAuthorizedCronRequest("Bearer  ", { allowCronSecret: true })).toBe(false);
  });

  it("accepts the bearer secret only on routes that allow it", () => {
    vi.stubEnv("CRON_API_KEY", undefined);
    vi.stubEnv("CRON_SECRET", "vercel-secret");
    expect(isAuthorizedCronRequest("Bearer vercel-secret", { allowCronSecret: true })).toBe(true);
    expect(isAuthorizedCronRequest("Bearer vercel-secret")).toBe(false);
    expect(isAuthorizedCronRequest("Bearer other", { allowCronSecret: true })).toBe(false);
  });

  it("rejects the literal bearer header produced by an unset or empty CRON_SECRET", () => {
    vi.stubEnv("CRON_SECRET", undefined);
    expect(isAuthorizedCronRequest("Bearer undefined", { allowCronSecret: true })).toBe(false);
    vi.stubEnv("CRON_SECRET", "");
    expect(isAuthorizedCronRequest("Bearer ", { allowCronSecret: true })).toBe(false);
  });
});
