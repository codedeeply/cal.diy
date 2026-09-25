import { V2_ENDPOINTS } from "@calcom/platform-constants";

// Booking uids are URL-safe tokens (short UUIDs or UUIDs) that often come straight from the page
// URL. Anything else, including "." and "..", which survive encoding and are then resolved as
// dot segments, could point an authenticated API request at another endpoint.
const bookingUidRegexp = /^[A-Za-z0-9_-]+$/;

export function isBookingUid(uid: string | undefined): uid is string {
  return !!uid && bookingUidRegexp.test(uid);
}

export function getBookingPath(uid: string, action = ""): string {
  if (!isBookingUid(uid)) throw new Error(`Invalid booking uid: ${JSON.stringify(uid)}`);
  return `/${V2_ENDPOINTS.bookings}/${encodeURIComponent(uid)}${action}`;
}
