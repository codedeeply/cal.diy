// Zoho sends its data-center code in the OAuth callback's `location` parameter. That value
// selects the host that receives our client secret and the user's tokens, so only known
// Zoho domains may be derived from it.
const zohoDomainByLocation = new Map<string, string>([
  ["us", "com"],
  ["eu", "eu"],
  ["in", "in"],
  ["au", "com.au"],
  ["jp", "jp"],
  ["cn", "com.cn"],
  ["sa", "sa"],
  ["uk", "uk"],
]);

export function getZohoServerLocation(location: string | undefined): string | null {
  if (!location) return "com";
  return zohoDomainByLocation.get(location) ?? null;
}
