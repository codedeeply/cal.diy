import { NextRequest } from "next/server";
import { afterEach, describe, expect, it, vi } from "vitest";

const { processQueue, cleanup } = vi.hoisted(() => ({
  processQueue: vi.fn().mockResolvedValue(undefined),
  cleanup: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../task-processor", () => ({
  TaskProcessor: class {
    processQueue = processQueue;
  },
}));

vi.mock("..", () => ({ default: { cleanup } }));

import { GET as cleanupGET } from "./cleanup";
import { GET as cronGET, POST as cronPOST } from "./cron";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});

describe.each([
  ["GET cron", cronGET, processQueue],
  ["POST cron", cronPOST, processQueue],
  ["GET cleanup", cleanupGET, cleanup],
] as const)("%s authorization", (_name, handler, protectedOperation) => {
  const request = (authorization?: string): NextRequest => {
    const headers = new Headers();
    if (authorization !== undefined) headers.set("authorization", authorization);
    return new NextRequest("http://localhost/api/tasker", { headers });
  };

  it.each([
    ["missing secret", undefined, "Bearer undefined"],
    ["missing secret with blank bearer", undefined, "Bearer "],
    ["empty secret", "", "Bearer "],
    ["empty secret with undefined bearer", "", "Bearer undefined"],
    ["whitespace secret", "   ", "Bearer    "],
    ["whitespace secret with undefined bearer", "   ", "Bearer undefined"],
    ["wrong token", "configured-secret", "Bearer wrong-secret"],
  ])("denies %s before protected operations", async (_case, secret, authorization) => {
    vi.stubEnv("CRON_SECRET", secret);

    const response = await handler(request(authorization));

    expect(response.status).toBe(401);
    expect(await response.text()).toBe("Unauthorized");
    expect(protectedOperation).not.toHaveBeenCalled();
  });

  it("does not use CRON_API_KEY when CRON_SECRET is absent", async () => {
    vi.stubEnv("CRON_SECRET", undefined);
    vi.stubEnv("CRON_API_KEY", "api-key");

    const response = await handler(request("Bearer api-key"));

    expect(response.status).toBe(401);
    expect(await response.text()).toBe("Unauthorized");
    expect(protectedOperation).not.toHaveBeenCalled();
  });

  it.each([
    ["missing Authorization header", undefined],
    ["wrong bearer scheme", "Basic configured-secret"],
    ["wrong bearer case", "bearer configured-secret"],
    ["raw secret", "configured-secret"],
    ["CRON_API_KEY bearer", "Bearer api-key"],
  ])("denies %s with CRON_SECRET configured", async (_case, authorization) => {
    vi.stubEnv("CRON_SECRET", "configured-secret");
    vi.stubEnv("CRON_API_KEY", "api-key");

    const response = await handler(request(authorization));

    expect(response.status).toBe(401);
    expect(await response.text()).toBe("Unauthorized");
    expect(protectedOperation).not.toHaveBeenCalled();
  });

  it("runs the protected operation with the exact configured secret", async () => {
    vi.stubEnv("CRON_SECRET", "configured-secret");

    const response = await handler(request("Bearer configured-secret"));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ success: true });
    expect(protectedOperation).toHaveBeenCalledOnce();
  });

  it("does not trim a non-blank configured secret during comparison", async () => {
    vi.stubEnv("CRON_SECRET", "  configured-secret");

    const denied = await handler(request("Bearer configured-secret"));
    expect(denied.status).toBe(401);
    expect(protectedOperation).not.toHaveBeenCalled();

    const allowed = await handler(request("Bearer   configured-secret"));
    expect(allowed.status).toBe(200);
    expect(protectedOperation).toHaveBeenCalledOnce();
  });
});
