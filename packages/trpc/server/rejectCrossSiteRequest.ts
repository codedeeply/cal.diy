import type { IncomingHttpHeaders } from "node:http";

/**
 * Session cookies are SameSite=None on HTTPS (so embeds keep working), which means a page on another
 * site can make the browser send them. tRPC also falls back to parsing non-JSON bodies as JSON, so a
 * cross-site `text/plain` form post — which skips CORS preflight — would otherwise run mutations as
 * the signed-in user. Requiring a JSON content type forces preflight (which our `*` CORS policy never
 * passes with credentials), and `Sec-Fetch-Site`, set by the browser, rejects cross-site callers
 * outright.
 */
export function getCrossSiteRejection(
  method: string | undefined,
  headers: IncomingHttpHeaders
): string | null {
  if (method !== "POST") return null;
  if (headers["sec-fetch-site"] === "cross-site") return "Cross-site tRPC requests are not allowed";
  const contentType = headers["content-type"];
  if (!contentType?.toLowerCase().startsWith("application/json")) {
    return "tRPC mutations require an application/json content type";
  }
  return null;
}
