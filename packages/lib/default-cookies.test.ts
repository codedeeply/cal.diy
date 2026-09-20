import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe("existing auth cookie policy", () => {
  it.each([true, false])("preserves secure=%s, scope and embed behavior", async (secure) => {
    vi.stubEnv("NEXTAUTH_COOKIE_DOMAIN", ".example.test");
    vi.resetModules();
    const { defaultCookies } = await import("./default-cookies");
    const cookies = defaultCookies(secure);
    for (const key of ["sessionToken", "csrfToken", "pkceCodeVerifier", "state"] as const) {
      expect(cookies[key]?.name.startsWith("__Secure-")).toBe(secure);
      expect(cookies[key]?.options).toEqual({
        domain: ".example.test",
        sameSite: secure ? "none" : "lax",
        path: "/",
        secure,
        httpOnly: true,
      });
    }
    expect(cookies.callbackUrl?.options.httpOnly).toBeUndefined();
    expect(cookies.nonce?.options).toEqual({ httpOnly: true, sameSite: "lax", path: "/", secure });
  });

  it("leaves cookies host-only when no domain is configured", async () => {
    vi.stubEnv("NEXTAUTH_COOKIE_DOMAIN", "");
    vi.resetModules();
    const { defaultCookies } = await import("./default-cookies");
    for (const cookie of Object.values(defaultCookies(true))) {
      expect(cookie.options.domain).toBeUndefined();
    }
  });
});
