import process from "node:process";
import { createSentryVerificationError, isAuthorizedSentryVerification } from "@lib/sentryVerification";
import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

// Throws on purpose so the error travels the real onRequestError → Sentry path (SLE-120).
export async function POST(request: NextRequest) {
  const token = process.env.SENTRY_VERIFICATION_TOKEN;
  if (!isAuthorizedSentryVerification(request.headers.get("x-sentry-verification"), token)) {
    return new NextResponse(null, { status: 404 });
  }
  throw createSentryVerificationError("nodejs");
}
