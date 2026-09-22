import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { isValidCalURL } from "./isValidCalURL";

const { configuredURL } = vi.hoisted(() => ({ configuredURL: { value: "https://cal.com" } }));

vi.mock("@calcom/lib/constants", () => ({
  get CAL_URL() {
    return configuredURL.value;
  },
}));

describe("Intercom Cal link validation", () => {
  const fetchMock = vi.fn<typeof fetch>();

  beforeEach(() => {
    configuredURL.value = "https://cal.com";
    fetchMock.mockResolvedValue({ status: 200 } as Response);
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it.each([
    "https://calxcom/alice/meeting",
    "https://cal.com.attacker.example/alice/meeting",
    "https://cal.com@attacker.example/alice/meeting",
    "https://user:pass@cal.com/alice/meeting",
    "http://cal.com/alice/meeting",
    "https://cal.com:8443/alice/meeting",
    "https://nested.team.cal.com/alice/meeting",
    "not-a-url",
  ])("rejects an untrusted or non-booking URL without fetching: %s", async (url) => {
    expect(await isValidCalURL(url)).toMatchObject({ isValid: false });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    "https://cal.com/alice/meeting",
    "https://team.cal.com/alice/meeting",
    "https://cal.com/",
  ])("checks a legitimate link without following a redirect: %s", async (url) => {
    expect(await isValidCalURL(url)).toEqual({ isValid: true });
    expect(fetchMock).toHaveBeenCalledExactlyOnceWith(url, { redirect: "manual" });
  });

  it("rejects a redirect response without contacting its destination", async () => {
    fetchMock.mockResolvedValueOnce({
      status: 302,
      headers: new Headers({ location: "http://127.0.0.1/" }),
    } as Response);

    expect(await isValidCalURL("https://cal.com/alice/meeting")).toMatchObject({ isValid: false });
    expect(fetchMock).toHaveBeenCalledExactlyOnceWith("https://cal.com/alice/meeting", {
      redirect: "manual",
    });
  });

  it("keeps non-200 responses invalid", async () => {
    fetchMock.mockResolvedValueOnce({ status: 404 } as Response);

    expect(await isValidCalURL("https://cal.com/alice/missing")).toMatchObject({ isValid: false });
  });

  it("uses the configured HTTPS host, port, and base path instead of the default host", async () => {
    configuredURL.value = "https://booking.example:8443/base";
    const validURL = "https://team.booking.example:8443/base/alice/meeting";

    expect(await isValidCalURL(validURL)).toEqual({ isValid: true });
    expect(fetchMock).toHaveBeenCalledExactlyOnceWith(validURL, { redirect: "manual" });

    fetchMock.mockClear();
    for (const url of [
      "https://cal.com/alice/meeting",
      "https://booking.example/base/alice/meeting",
      "https://booking.example:8443/baseline/alice/meeting",
      "https://nested.team.booking.example:8443/base/alice/meeting",
    ]) {
      expect(await isValidCalURL(url)).toMatchObject({ isValid: false });
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("does not enable HTTP-configured origins or reinterpret them as HTTPS", async () => {
    configuredURL.value = "http://localhost:3000";

    expect(await isValidCalURL("http://localhost:3000/alice/meeting")).toMatchObject({ isValid: false });
    expect(await isValidCalURL("https://localhost:3000/alice/meeting")).toMatchObject({ isValid: false });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
