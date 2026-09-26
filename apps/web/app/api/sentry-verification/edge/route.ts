import { createSentryVerificationError, isAuthorizedSentryVerification } from "@lib/sentryVerification";
import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";

export const runtime = "edge";
export const dynamic = "force-dynamic";

// Edge counterpart of ../route.ts, proving the edge Sentry configuration end to end.
export async function POST(request: NextRequest) {
  const token = process.env.SENTRY_VERIFICATION_TOKEN;
  if (!isAuthorizedSentryVerification(request.headers.get("x-sentry-verification"), token)) {
    return new NextResponse(null, { status: 404 });
  }
  throw createSentryVerificationError("edge");
}
