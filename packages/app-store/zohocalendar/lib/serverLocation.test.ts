import { describe, expect, it } from "vitest";
import { getZohoServerLocation } from "./serverLocation";

describe("getZohoServerLocation", () => {
  it("defaults to the US data center when Zoho omits the location", () => {
    expect(getZohoServerLocation(undefined)).toBe("com");
    expect(getZohoServerLocation("")).toBe("com");
  });

  it("maps every known Zoho data center to its domain", () => {
    expect(getZohoServerLocation("us")).toBe("com");
    expect(getZohoServerLocation("eu")).toBe("eu");
    expect(getZohoServerLocation("in")).toBe("in");
    expect(getZohoServerLocation("au")).toBe("com.au");
    expect(getZohoServerLocation("jp")).toBe("jp");
    expect(getZohoServerLocation("cn")).toBe("com.cn");
    expect(getZohoServerLocation("sa")).toBe("sa");
    expect(getZohoServerLocation("uk")).toBe("uk");
  });

  it("rejects locations that would send credentials to another host", () => {
    for (const location of [
      "attacker.example",
      "com.attacker.example",
      "eu/../x",
      "EU",
      "__proto__",
      "constructor",
    ]) {
      expect(getZohoServerLocation(location)).toBeNull();
    }
  });
});
