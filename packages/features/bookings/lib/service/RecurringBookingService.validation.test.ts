import type { BookingResponse } from "@calcom/features/bookings/types";
import { ErrorCode } from "@calcom/lib/errorCodes";
import { SchedulingType } from "@calcom/prisma/enums";
import { describe, expect, it, vi } from "vitest";
import { handleNewRecurringBooking, RecurringBookingService } from "./RecurringBookingService";
import type { RegularBookingService } from "./RegularBookingService";

function createSubject() {
  const createBooking = vi.fn();
  const dependencies = {
    regularBookingService: { createBooking } as unknown as RegularBookingService,
  };
  const service = new RecurringBookingService(dependencies);

  const invokeCreate = (bookingData: unknown) =>
    Reflect.apply(service.createBooking, service, [{ bookingData, creationSource: "WEBAPP" }]) as Promise<
      BookingResponse[]
    >;
  const invokeReschedule = (bookingData: unknown) =>
    Reflect.apply(service.rescheduleBooking, service, [{ bookingData, creationSource: "WEBAPP" }]) as Promise<
      BookingResponse[]
    >;
  const invokeSharedEntry = (bookingData: unknown) =>
    Reflect.apply(handleNewRecurringBooking, service, [
      {
        creationSource: "WEBAPP",
        deps: dependencies,
        input: { bookingData },
      },
    ]) as Promise<BookingResponse[]>;

  return { createBooking, invokeCreate, invokeReschedule, invokeSharedEntry };
}

const malformedBookingData: [string, unknown][] = [
  ["null", null],
  ["string", "booking"],
  ["number", 1],
  ["object", {}],
  ["empty array", []],
  ["null item", [null]],
  ["primitive item", [1]],
  ["array item", [[]]],
  ["mixed valid and malformed items", [{ start: "2026-01-01T00:00:00.000Z" }, null]],
];

describe("RecurringBookingService request structure", () => {
  it.each(
    malformedBookingData
  )("createBooking rejects %s without booking side effects", async (_label, data) => {
    const { createBooking, invokeCreate } = createSubject();

    await expect(invokeCreate(data)).rejects.toMatchObject({ code: ErrorCode.BadRequest });

    expect(createBooking).not.toHaveBeenCalled();
  });

  it.each(
    malformedBookingData
  )("rescheduleBooking rejects %s without booking side effects", async (_label, data) => {
    const { createBooking, invokeReschedule } = createSubject();

    await expect(invokeReschedule(data)).rejects.toMatchObject({ code: ErrorCode.BadRequest });

    expect(createBooking).not.toHaveBeenCalled();
  });

  it.each(
    malformedBookingData
  )("the exported shared entry rejects %s without booking side effects", async (_label, data) => {
    const { createBooking, invokeSharedEntry } = createSubject();

    await expect(invokeSharedEntry(data)).rejects.toMatchObject({ code: ErrorCode.BadRequest });

    expect(createBooking).not.toHaveBeenCalled();
  });

  it("the exported shared entry rejects a sparse array without booking side effects", async () => {
    const { createBooking, invokeSharedEntry } = createSubject();
    const sparseBookingData = Array(2);
    sparseBookingData[0] = { start: "2026-01-01T00:00:00.000Z" };

    await expect(invokeSharedEntry(sparseBookingData)).rejects.toMatchObject({ code: ErrorCode.BadRequest });

    expect(createBooking).not.toHaveBeenCalled();
  });

  it("preserves one valid booking object and its custom responses", async () => {
    const { createBooking, invokeCreate } = createSubject();
    createBooking.mockResolvedValueOnce({ id: 1, references: [] });
    const responses = { customQuestion: "single response" };

    await invokeCreate([{ end: "2026-01-01T00:30:00.000Z", responses, start: "2026-01-01T00:00:00.000Z" }]);

    expect(createBooking).toHaveBeenCalledTimes(1);
    expect(createBooking).toHaveBeenCalledWith(
      expect.objectContaining({
        bookingData: expect.objectContaining({ responses }),
      })
    );
  });

  it("preserves multiple valid booking objects with custom responses", async () => {
    const { createBooking, invokeCreate } = createSubject();
    createBooking
      .mockResolvedValueOnce({ id: 1, references: [] })
      .mockResolvedValueOnce({ id: 2, references: [] });
    const firstResponses = { customQuestion: "first response" };
    const secondResponses = { customQuestion: "second response" };

    await invokeCreate([
      { end: "2026-01-01T00:30:00.000Z", responses: firstResponses, start: "2026-01-01T00:00:00.000Z" },
      { end: "2026-01-08T00:30:00.000Z", responses: secondResponses, start: "2026-01-08T00:00:00.000Z" },
    ]);

    expect(createBooking).toHaveBeenCalledTimes(2);
    expect(createBooking).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        bookingData: expect.objectContaining({ responses: firstResponses }),
      })
    );
    expect(createBooking).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        bookingData: expect.objectContaining({ responses: secondResponses }),
      })
    );
  });

  it("preserves round-robin luckyUsers behavior", async () => {
    const { createBooking, invokeCreate } = createSubject();
    createBooking
      .mockResolvedValueOnce({ id: 1, luckyUsers: [42], references: [] })
      .mockResolvedValueOnce({ id: 2, references: [] });

    await invokeCreate([
      { schedulingType: SchedulingType.ROUND_ROBIN, start: "2026-01-01T00:00:00.000Z" },
      { schedulingType: SchedulingType.ROUND_ROBIN, start: "2026-01-08T00:00:00.000Z" },
    ]);

    expect(createBooking).toHaveBeenCalledTimes(2);
    expect(createBooking).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        bookingData: expect.objectContaining({ luckyUsers: [42] }),
      })
    );
  });
});
