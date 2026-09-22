import { ErrorCode } from "@calcom/lib/errorCodes";
import type { NextApiRequest, NextApiResponse } from "next";
import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  checkCfTurnstileToken: vi.fn(),
  checkRateLimitAndThrowError: vi.fn(),
  createBooking: vi.fn(),
  getServerSession: vi.fn(),
}));

vi.mock("@calcom/features/auth/lib/getServerSession", () => ({
  getServerSession: mocks.getServerSession,
}));

vi.mock("@calcom/features/bookings/di/RecurringBookingService.container", () => ({
  getRecurringBookingService: () => ({ createBooking: mocks.createBooking }),
}));

vi.mock("@calcom/lib/checkRateLimitAndThrowError", () => ({
  checkRateLimitAndThrowError: mocks.checkRateLimitAndThrowError,
}));

vi.mock("@calcom/lib/getIP", () => ({ default: () => "127.0.0.1" }));

vi.mock("@calcom/lib/server/checkCfTurnstileToken", () => ({
  checkCfTurnstileToken: mocks.checkCfTurnstileToken,
}));

vi.mock("@calcom/lib/server/PiiHasher", () => ({
  piiHasher: { hash: () => "hashed-ip" },
}));

import process from "node:process";
import recurringEventHandler, { handleRecurringEventBooking } from "./recurring-event";

const turnstileEnvironmentVariable = "NEXT_PUBLIC_CLOUDFLARE_USE_TURNSTILE_IN_BOOKER";
const originalTurnstileSetting = process.env[turnstileEnvironmentVariable];

function createRequest(body: unknown): NextApiRequest {
  return { body, headers: {}, method: "POST", url: "/api/book/recurring-event" } as unknown as NextApiRequest;
}

function createResponse() {
  const response = {
    json: vi.fn(),
    setHeader: vi.fn(),
    status: vi.fn(),
    writableEnded: false,
  };
  response.status.mockReturnValue(response);
  return response;
}

function expectNoBookingSideEffects() {
  expect(mocks.checkCfTurnstileToken).not.toHaveBeenCalled();
  expect(mocks.checkRateLimitAndThrowError).not.toHaveBeenCalled();
  expect(mocks.getServerSession).not.toHaveBeenCalled();
  expect(mocks.createBooking).not.toHaveBeenCalled();
}

afterEach(() => {
  vi.clearAllMocks();
  if (originalTurnstileSetting === undefined) {
    delete process.env[turnstileEnvironmentVariable];
  } else {
    process.env[turnstileEnvironmentVariable] = originalTurnstileSetting;
  }
});

describe("recurring booking request structure", () => {
  describe.each(["0", "1"])("with Turnstile setting %s", (turnstileSetting) => {
    it.each([
      ["null", null],
      ["string", "booking"],
      ["number", 1],
      ["object", {}],
      ["empty array", []],
      ["null item", [null]],
      ["primitive item", ["booking"]],
      ["array item", [[]]],
      ["mixed valid and malformed items", [{ start: "2026-01-01T00:00:00.000Z" }, null]],
    ])("rejects %s before side effects", async (_label, body) => {
      process.env[turnstileEnvironmentVariable] = turnstileSetting;

      await expect(handleRecurringEventBooking(createRequest(body))).rejects.toMatchObject({
        code: ErrorCode.BadRequest,
      });

      expectNoBookingSideEffects();
    });
  });

  it("maps invalid structure to HTTP 400", async () => {
    process.env[turnstileEnvironmentVariable] = "0";
    const response = createResponse();

    await recurringEventHandler(createRequest([]), response as unknown as NextApiResponse);

    expect(response.status).toHaveBeenCalledWith(400);
    expect(response.json).toHaveBeenCalledWith(
      expect.objectContaining({ message: "Recurring booking data must be a non-empty array of objects" })
    );
    expectNoBookingSideEffects();
  });

  it("checks Turnstile before preserving valid booking data", async () => {
    process.env[turnstileEnvironmentVariable] = "1";
    const bookingData = [
      {
        cfToken: "synthetic-token",
        responses: { customQuestion: "custom response" },
        schedulingType: "ROUND_ROBIN",
      },
    ];
    mocks.createBooking.mockResolvedValue([]);

    await handleRecurringEventBooking(createRequest(bookingData));

    expect(mocks.checkCfTurnstileToken).toHaveBeenCalledWith({
      remoteIp: "127.0.0.1",
      token: "synthetic-token",
    });
    expect(mocks.createBooking).toHaveBeenCalledWith(expect.objectContaining({ bookingData }));
    expect(mocks.checkCfTurnstileToken.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.createBooking.mock.invocationCallOrder[0]
    );
  });

  it("skips Turnstile and preserves multiple valid booking objects when disabled", async () => {
    process.env[turnstileEnvironmentVariable] = "0";
    const bookingData = [
      { responses: { customQuestion: "first" } },
      { responses: { customQuestion: "second" } },
    ];
    mocks.createBooking.mockResolvedValue([]);

    await handleRecurringEventBooking(createRequest(bookingData));

    expect(mocks.checkCfTurnstileToken).not.toHaveBeenCalled();
    expect(mocks.createBooking).toHaveBeenCalledWith(expect.objectContaining({ bookingData }));
  });
});
