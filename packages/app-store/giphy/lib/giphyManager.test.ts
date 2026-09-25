import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getGiphyById } from "./giphyManager";

vi.mock("../../_utils/getAppKeysFromSlug", () => ({
  default: vi.fn().mockResolvedValue({ api_key: "test-api-key" }),
}));

const fetchMock = vi.fn();

describe("getGiphyById", () => {
  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("looks up a well-formed ID on the Giphy API", async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ data: { images: { fixed_height_downsampled: { url: "gif-url" } } } }))
    );

    await expect(getGiphyById("xT9IgG50Fb7Mi0prBC")).resolves.toBe("gif-url");
    const url = new URL(fetchMock.mock.calls[0][0]);
    expect(url.origin + url.pathname).toBe("https://api.giphy.com/v1/gifs/xT9IgG50Fb7Mi0prBC");
  });

  it("rejects an ID that would change the request path", async () => {
    for (const giphyId of ["../trending", "id/../../v2/emoji", "id?x=1", ""]) {
      await expect(getGiphyById(giphyId)).rejects.toMatchObject({ statusCode: 400 });
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
