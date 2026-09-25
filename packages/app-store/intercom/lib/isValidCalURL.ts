import { CAL_URL } from "@calcom/lib/constants";
import type { TextComponent } from "../lib";

/**
 * Check if the url is a valid cal.com url
 * @param url
 * @returns IsValid
 */
export async function isValidCalURL(url: string) {
  const error: TextComponent = {
    type: "text",
    text: `This is not a valid ${CAL_URL.replace("https://", "")} link`,
    style: "error",
    align: "left",
  };

  let candidate: URL;
  try {
    candidate = new URL(url);
  } catch {
    return { isValid: false, error };
  }

  const configured = new URL(CAL_URL);
  const subdomain = candidate.hostname.endsWith(`.${configured.hostname}`)
    ? candidate.hostname.slice(0, -configured.hostname.length - 1)
    : "";
  const matchesHost = candidate.hostname === configured.hostname || /^[a-z0-9-]+$/i.test(subdomain);
  const pathPrefix = configured.pathname.endsWith("/") ? configured.pathname : `${configured.pathname}/`;

  if (
    configured.protocol !== "https:" ||
    candidate.protocol !== "https:" ||
    candidate.username ||
    candidate.password ||
    candidate.port !== configured.port ||
    !matchesHost ||
    !candidate.pathname.startsWith(pathPrefix)
  )
    return {
      isValid: false,
      error,
    };

  // Construct the destination from the configured origin, never from the submitted URL's authority.
  const destination = new URL(configured.origin);
  if (subdomain) destination.hostname = `${subdomain}.${configured.hostname}`;
  destination.pathname = candidate.pathname;
  destination.search = candidate.search;
  destination.hash = candidate.hash;

  // A valid Cal link can itself redirect to an unrelated host; never follow that redirect.
  const response = await fetch(destination, { redirect: "manual" });

  if (response.status !== 200)
    return {
      isValid: false,
      error,
    };

  return {
    isValid: true,
  };
}
