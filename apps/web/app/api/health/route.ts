import prisma from "@calcom/prisma";
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

// Liveness plus database reachability for uptime monitors and container health checks. The body
// is deliberately minimal so an unauthenticated caller learns nothing beyond up or down.
export async function GET() {
  try {
    await prisma.$queryRaw`SELECT 1`;
    return NextResponse.json({ status: "ok" }, { headers: { "cache-control": "no-store" } });
  } catch {
    return NextResponse.json(
      { status: "unavailable" },
      { status: 503, headers: { "cache-control": "no-store" } }
    );
  }
}
