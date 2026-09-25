import { beforeEach, describe, expect, it, vi } from "vitest";
import http from "../../lib/http";
import { useBooking } from "./useBooking";

vi.mock("@tanstack/react-query", () => ({
  useQuery: (options: { queryFn: () => Promise<unknown> }) => options,
}));
vi.mock("../../lib/http", () => ({ default: { get: vi.fn() } }));

const getMock = vi.mocked(http.get);

async function requestedPathFor(uid: string) {
  const { queryFn } = useBooking(uid) as unknown as { queryFn: () => Promise<unknown> };
  await queryFn();
  return getMock.mock.calls[0][0];
}

describe("useBooking", () => {
  beforeEach(() => {
    getMock.mockReset();
    getMock.mockResolvedValue({ data: { status: "success", data: {} } });
  });

  it("requests the booking by its uid", async () => {
    expect(await requestedPathFor("abc123")).toBe("/bookings/abc123");
  });

  it("keeps a uid taken from the page URL inside the bookings path", async () => {
    expect(await requestedPathFor("../me?x=1")).toBe("/bookings/..%2Fme%3Fx%3D1");
  });
});
