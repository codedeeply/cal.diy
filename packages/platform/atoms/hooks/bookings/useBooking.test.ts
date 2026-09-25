import { beforeEach, describe, expect, it, vi } from "vitest";
import http from "../../lib/http";
import { useBooking } from "./useBooking";

vi.mock("@tanstack/react-query", () => ({
  useQuery: (options: unknown) => options,
}));
vi.mock("../../lib/http", () => ({ default: { get: vi.fn() } }));

const getMock = vi.mocked(http.get);

type QueryOptions = { queryFn: () => Promise<unknown>; enabled: boolean };
const queryFor = (uid: string) => useBooking(uid) as unknown as QueryOptions;

describe("useBooking", () => {
  beforeEach(() => {
    getMock.mockReset();
    getMock.mockResolvedValue({ data: { status: "success", data: {} } });
  });

  it("requests the booking by its uid", async () => {
    const query = queryFor("2bRAAeWf8Kx9GpN7vWkYGm");
    expect(query.enabled).toBe(true);
    await query.queryFn();
    expect(getMock.mock.calls[0][0]).toBe("/bookings/2bRAAeWf8Kx9GpN7vWkYGm");
  });

  it.each(["../me?x=1", ".", ".."])("never requests another endpoint for the uid %j", async (uid) => {
    const query = queryFor(uid);
    expect(query.enabled).toBe(false);
    await expect(query.queryFn()).rejects.toThrow("Invalid booking uid");
    expect(getMock).not.toHaveBeenCalled();
  });
});
