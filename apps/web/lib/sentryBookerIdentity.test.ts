import { beforeEach, describe, expect, it, vi } from "vitest";

const { setUser } = vi.hoisted(() => ({ setUser: vi.fn() }));
vi.mock("@sentry/nextjs", () => ({ setUser }));

import { identifyBookerForSentry } from "./sentryBookerIdentity";

describe("identifyBookerForSentry", () => {
  beforeEach(() => setUser.mockReset());

  it("uses the booker's email and full name", () => {
    identifyBookerForSentry({
      email: "quinn@example.invalid",
      name: { firstName: "Quinn", lastName: "Booker" },
      notes: "private",
      attendeePhoneNumber: "+14155550142",
    });
    expect(setUser).toHaveBeenCalledWith({ email: "quinn@example.invalid", username: "Quinn Booker" });
  });

  it("accepts a plain-string name", () => {
    identifyBookerForSentry({ email: "quinn@example.invalid", name: "Quinn Booker" });
    expect(setUser).toHaveBeenCalledWith({ email: "quinn@example.invalid", username: "Quinn Booker" });
  });

  it("ignores malformed or missing responses", () => {
    identifyBookerForSentry(undefined);
    identifyBookerForSentry("not an object");
    expect(setUser).not.toHaveBeenCalled();
    identifyBookerForSentry({ email: 42, name: { unexpected: true } });
    expect(setUser).toHaveBeenCalledWith({ email: undefined, username: undefined });
  });
});
