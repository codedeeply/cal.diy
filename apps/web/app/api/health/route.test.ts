import { beforeEach, describe, expect, it, vi } from "vitest";

// A plain stub rather than vi.fn(): the spy wrapper re-raises rejections the route already handled.
const database = vi.hoisted(() => ({ reachable: true }));
vi.mock("@calcom/prisma", () => ({
  default: {
    $queryRaw: async () => {
      if (!database.reachable) throw new Error("connect ECONNREFUSED 10.0.0.5:5432 password=hunter2");
      return [{ "?column?": 1 }];
    },
  },
}));

import { GET } from "./route";

describe("GET /api/health", () => {
  beforeEach(() => {
    database.reachable = true;
  });

  it("reports ok when the database answers", async () => {
    const response = await GET();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "ok" });
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it("reports 503 without error details when the database is unreachable", async () => {
    database.reachable = false;
    const response = await GET();
    expect(response.status).toBe(503);
    expect(await response.text()).toBe('{"status":"unavailable"}');
  });
});
