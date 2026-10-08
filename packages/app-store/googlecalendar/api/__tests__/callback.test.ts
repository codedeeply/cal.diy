import type { NextApiRequest, NextApiResponse } from "next";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  create: vi.fn(),
  deleteById: vi.fn(),
  getPrimaryCalendar: vi.fn(),
  upsertSelectedCalendar: vi.fn(),
  getToken: vi.fn(),
}));

vi.mock("@googleapis/calendar", () => ({ calendar_v3: { Calendar: class {} } }));
vi.mock("googleapis-common", () => ({
  OAuth2Client: class {
    getToken = mocks.getToken;
    setCredentials() {}
  },
}));
vi.mock("@calcom/app-store/googlecalendar/lib/CalendarService", () => ({
  createGoogleCalendarServiceWithGoogleType: () => ({
    getPrimaryCalendar: mocks.getPrimaryCalendar,
    upsertSelectedCalendar: mocks.upsertSelectedCalendar,
  }),
}));
vi.mock("@calcom/features/credentials/repositories/CredentialRepository", () => ({
  CredentialRepository: { create: mocks.create, deleteById: mocks.deleteById },
}));
vi.mock("@calcom/features/credentials/services/CredentialDataService", () => ({
  buildCredentialCreateData: () => ({ userId: 1, type: "google_calendar", key: {} }),
}));
vi.mock("@calcom/lib/connectedCalendar", () => ({ renewSelectedCalendarCredentialId: vi.fn() }));
vi.mock("@calcom/lib/constants", () => ({
  GOOGLE_CALENDAR_SCOPES: ["calendar"],
  SCOPE_USERINFO_PROFILE: "profile",
  WEBAPP_URL: "https://example.com",
  WEBAPP_URL_FOR_OAUTH: "https://example.com",
}));
vi.mock("@calcom/lib/getSafeRedirectUrl", () => ({ getSafeRedirectUrl: (url: string) => url }));
vi.mock("@calcom/lib/server/defaultHandler", () => ({
  defaultHandler:
    ({ GET }: { GET: Promise<{ default: (req: NextApiRequest, res: NextApiResponse) => Promise<void> }> }) =>
    async (req: NextApiRequest, res: NextApiResponse) =>
      (await GET).default(req, res),
}));
vi.mock("@calcom/lib/server/defaultResponder", () => ({ defaultResponder: (handler: unknown) => handler }));
vi.mock("@calcom/prisma/client", () => ({ Prisma: { PrismaClientKnownRequestError: class {} } }));
vi.mock("../../../_utils/getInstalledAppPath", () => ({ default: () => "/apps/installed" }));
vi.mock("../../../_utils/oauth/decodeOAuthState", () => ({ decodeOAuthState: () => ({}) }));
vi.mock("../../../_utils/oauth/updateProfilePhotoGoogle", () => ({ updateProfilePhotoGoogle: vi.fn() }));
vi.mock("../../lib/getGoogleAppKeys", () => ({
  getGoogleAppKeys: async () => ({ client_id: "client", client_secret: "secret" }),
}));

import handler from "../callback";

describe("Google Calendar OAuth callback", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getToken.mockResolvedValue({ tokens: { scope: "calendar" } });
    mocks.create.mockResolvedValue({ id: 42, userId: 1, type: "google_calendar", key: {} });
  });

  it("deletes only the newly created credential when fetching the primary calendar fails", async () => {
    const error = new Error("Google returned 403");
    mocks.getPrimaryCalendar.mockRejectedValue(error);
    const req = { query: { code: "oauth-code" }, session: { user: { id: 1 } } } as NextApiRequest;
    const res = { redirect: vi.fn() } as unknown as NextApiResponse;

    await expect(handler(req, res)).rejects.toThrow("Google returned 403");

    expect(mocks.create).toHaveBeenCalledOnce();
    expect(mocks.deleteById).toHaveBeenCalledExactlyOnceWith({ id: 42 });
    expect(mocks.deleteById).not.toHaveBeenCalledWith({ id: 41 });
    expect(mocks.upsertSelectedCalendar).not.toHaveBeenCalled();
  });

  it("keeps the credential and selects the primary calendar on success", async () => {
    mocks.getPrimaryCalendar.mockResolvedValue({ id: "primary" });
    const req = { query: { code: "oauth-code" }, session: { user: { id: 1 } } } as NextApiRequest;
    const res = { redirect: vi.fn() } as unknown as NextApiResponse;

    await handler(req, res);

    expect(mocks.create).toHaveBeenCalledOnce();
    expect(mocks.upsertSelectedCalendar).toHaveBeenCalledExactlyOnceWith({
      eventTypeId: null,
      externalId: "primary",
    });
    expect(mocks.deleteById).not.toHaveBeenCalled();
    expect(res.redirect).toHaveBeenCalledWith("/apps/installed");
  });

  it("keeps the credential when no primary calendar is returned", async () => {
    mocks.getPrimaryCalendar.mockResolvedValue(null);
    const req = { query: { code: "oauth-code" }, session: { user: { id: 1 } } } as NextApiRequest;
    const res = { redirect: vi.fn() } as unknown as NextApiResponse;

    await handler(req, res);

    expect(mocks.deleteById).not.toHaveBeenCalled();
    expect(mocks.upsertSelectedCalendar).not.toHaveBeenCalled();
    expect(res.redirect).toHaveBeenCalledWith("/apps/installed");
  });
});
