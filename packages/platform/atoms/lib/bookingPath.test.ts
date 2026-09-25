import { describe, expect, it } from "vitest";
import { getBookingPath, isBookingUid } from "./bookingPath";

describe("getBookingPath", () => {
  it("builds the bookings path for real booking uids", () => {
    expect(getBookingPath("2bRAAeWf8Kx9GpN7vWkYGm")).toBe("/bookings/2bRAAeWf8Kx9GpN7vWkYGm");
    expect(getBookingPath("0b1c2d3e-4f50-6172-8394-a5b6c7d8e9f0", "/reschedule")).toBe(
      "/bookings/0b1c2d3e-4f50-6172-8394-a5b6c7d8e9f0/reschedule"
    );
  });

  it.each([
    ".",
    "..",
    "",
    "../me",
    "uid/../me",
    "uid?x=1",
    "uid#x",
    "%2e%2e",
  ])("refuses %j, which could leave the booking's own path", (uid) => {
    expect(isBookingUid(uid)).toBe(false);
    expect(() => getBookingPath(uid)).toThrow("Invalid booking uid");
  });
});
