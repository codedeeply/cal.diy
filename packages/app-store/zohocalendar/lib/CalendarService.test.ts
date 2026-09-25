import type { CredentialPayload } from "@calcom/types/Credential";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import BuildCalendarService from "./CalendarService";

vi.mock("@calcom/prisma", () => ({ default: { credential: { update: vi.fn() } } }));
vi.mock("../../_utils/getAppKeysFromSlug", () => ({
  default: vi.fn().mockResolvedValue({ client_id: "test-client-id", client_secret: "test-client-secret" }),
}));

const fetchMock = vi.fn();

function credentialFor(serverLocation: string, expiresIn: number): CredentialPayload {
  return {
    id: 1,
    type: "zoho_calendar",
    key: {
      access_token: "access-token",
      refresh_token: "refresh-token",
      expires_in: expiresIn,
      server_location: serverLocation,
    },
  } as unknown as CredentialPayload;
}

const expired = 0;
const valid = Math.round(Date.now() / 1000) + 3600;

describe("ZohoCalendarService stored server location", () => {
  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it.each([
    ["refreshing", expired],
    ["using", valid],
  ])("refuses to contact an unknown host when %s a stored token", async (_, expiresIn) => {
    const calendar = BuildCalendarService(credentialFor("attacker.example", expiresIn));

    await expect(calendar.listCalendars()).rejects.toMatchObject({ code: "bad_request_error" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("refreshes a token with the stored Zoho data center", async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({})));
    const calendar = BuildCalendarService(credentialFor("eu", expired));

    await calendar.listCalendars().catch(() => undefined);
    expect(new URL(fetchMock.mock.calls[0][0]).origin).toBe("https://accounts.zoho.eu");
  });
});
