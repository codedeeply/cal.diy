//biome-ignore-all lint/style/noProcessEnv: Server side
//biome-ignore-all lint/correctness/noProcessGlobal: Server side

// This file configures the initialization of Sentry on the server.
// The config you add here will be used whenever the server handles a request.
// https://docs.sentry.io/platforms/javascript/guides/nextjs/
import * as Sentry from "@sentry/nextjs";
import { scrubBreadcrumb, scrubEvent } from "./lib/sentryPrivacy";

Sentry.init({
  debug: !!process.env.SENTRY_DEBUG,
  // Runtime settings let one published image report to any (or no) Sentry project; the
  // NEXT_PUBLIC_ value is baked in at build time and kept only for existing deployments.
  dsn: process.env.SENTRY_DSN || process.env.NEXT_PUBLIC_SENTRY_DSN,
  release: process.env.SENTRY_RELEASE || process.env.NEXT_PUBLIC_SENTRY_RELEASE,
  environment: process.env.SENTRY_ENVIRONMENT || process.env.NEXT_PUBLIC_SENTRY_ENVIRONMENT,
  sampleRate: parseFloat(process.env.SENTRY_SAMPLE_RATE ?? "1.0") || 1.0,
  tracesSampleRate: parseFloat(process.env.SENTRY_TRACES_SAMPLE_RATE ?? "0.0") || 0.0,
  integrations: [Sentry.prismaIntegration(), Sentry.httpIntegration()],
  sendDefaultPii: false,
  // Metrics attach scope user fields and have no scrubbing hook in this configuration.
  enableMetrics: false,
  beforeSend(event) {
    event.tags = {
      ...event.tags,
      errorSource: "server",
    };
    return scrubEvent(event);
  },
  beforeSendTransaction: scrubEvent,
  beforeBreadcrumb: scrubBreadcrumb,
});
