import { describe, expect, it } from "vitest";
import { getCrossSiteRejection } from "./rejectCrossSiteRequest";

describe("getCrossSiteRejection", () => {
  it("allows same-origin JSON mutations, including a charset parameter", () => {
    expect(
      getCrossSiteRejection("POST", { "content-type": "application/json", "sec-fetch-site": "same-origin" })
    ).toBeNull();
    expect(getCrossSiteRejection("POST", { "content-type": "Application/JSON; charset=utf-8" })).toBeNull();
  });

  it("rejects the simple-request content types that skip CORS preflight", () => {
    for (const contentType of [
      "text/plain",
      "application/x-www-form-urlencoded",
      "multipart/form-data",
      "application/jsonp",
      "application/json-patch+json",
    ]) {
      expect(getCrossSiteRejection("POST", { "content-type": contentType })).toMatch(/application\/json/);
    }
    expect(getCrossSiteRejection("POST", {})).toMatch(/application\/json/);
  });

  it("rejects browser-marked cross-site mutations even with a JSON content type", () => {
    expect(
      getCrossSiteRejection("POST", { "content-type": "application/json", "sec-fetch-site": "cross-site" })
    ).toMatch(/Cross-site/);
  });

  it("leaves queries alone", () => {
    expect(getCrossSiteRejection("GET", { "sec-fetch-site": "cross-site" })).toBeNull();
  });
});
