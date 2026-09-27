import type { NextApiRequest, NextApiResponse } from "next";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import handler from "./callback";

vi.mock("@calcom/prisma", () => ({ default: {} }));
vi.mock("../../_utils/getAppKeysFromSlug", () => ({
  default: vi.fn().mockResolvedValue({ client_id: "test-client-id", client_secret: "test-client-secret" }),
}));

const fetchMock = vi.fn();

function createResponse() {
  const res = {
    status: vi.fn().mockReturnThis(),
    json: vi.fn().mockReturnThis(),
    redirect: vi.fn().mockReturnThis(),
    setHeader: vi.fn().mockReturnThis(),
    end: vi.fn().mockReturnThis(),
  };
  return res;
}

function createRequest(location: string): NextApiRequest {
  return {
    method: "GET",
    query: { code: "auth-code", location },
    session: { user: { id: 1 } },
  } as unknown as NextApiRequest;
}

describe("zohocalendar OAuth callback", () => {
  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("refuses an unknown location without contacting any host", async () => {
    const res = createResponse();
    await handler(createRequest("attacker.example"), res as unknown as NextApiResponse);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(400);
  });

  it("exchanges the code with the Zoho data center Zoho reported", async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ error: "invalid_code" }), { status: 400 }));
    const res = createResponse();
    await handler(createRequest("au"), res as unknown as NextApiResponse);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const url = new URL(fetchMock.mock.calls[0][0]);
    expect(url.origin).toBe("https://accounts.zoho.com.au");
    expect(url.pathname).toBe("/oauth/v2/token");
  });
});
