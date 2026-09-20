FROM node:24.21.0-bookworm@sha256:64af3819f9275802414d7cdc38c27e9d82bd564dec4d4da87d008255d36c63b4 AS builder

WORKDIR /calcom

## If we want to read any ENV variable from .env file, we need to first accept and pass it as an argument to the Dockerfile
ARG NEXT_PUBLIC_LICENSE_CONSENT
ARG NEXT_PUBLIC_WEBSITE_TERMS_URL
ARG NEXT_PUBLIC_WEBSITE_PRIVACY_POLICY_URL
ARG CALCOM_TELEMETRY_DISABLED
ARG DATABASE_URL
ARG NEXTAUTH_SECRET=secret
ARG CALENDSO_ENCRYPTION_KEY=secret
ARG MAX_OLD_SPACE_SIZE=6144
ARG NEXT_PUBLIC_API_V2_URL
ARG CSP_POLICY

## We need these variables as required by Next.js build to create rewrites
ARG NEXT_PUBLIC_SINGLE_ORG_SLUG
ARG ORGANIZATIONS_ENABLED

ENV NEXT_PUBLIC_WEBAPP_URL=http://NEXT_PUBLIC_WEBAPP_URL_PLACEHOLDER \
  NEXT_PUBLIC_API_V2_URL=$NEXT_PUBLIC_API_V2_URL \
  NEXT_PUBLIC_LICENSE_CONSENT=$NEXT_PUBLIC_LICENSE_CONSENT \
  NEXT_PUBLIC_WEBSITE_TERMS_URL=$NEXT_PUBLIC_WEBSITE_TERMS_URL \
  NEXT_PUBLIC_WEBSITE_PRIVACY_POLICY_URL=$NEXT_PUBLIC_WEBSITE_PRIVACY_POLICY_URL \
  CALCOM_TELEMETRY_DISABLED=$CALCOM_TELEMETRY_DISABLED \
  DATABASE_URL=$DATABASE_URL \
  DATABASE_DIRECT_URL=$DATABASE_URL \
  NEXTAUTH_SECRET=${NEXTAUTH_SECRET} \
  CALENDSO_ENCRYPTION_KEY=${CALENDSO_ENCRYPTION_KEY} \
  NEXT_PUBLIC_SINGLE_ORG_SLUG=$NEXT_PUBLIC_SINGLE_ORG_SLUG \
  ORGANIZATIONS_ENABLED=$ORGANIZATIONS_ENABLED \
  NODE_OPTIONS=--max-old-space-size=${MAX_OLD_SPACE_SIZE} \
  BUILD_STANDALONE=true \
  CSP_POLICY=$CSP_POLICY

COPY package.json yarn.lock .yarnrc.yml playwright.config.ts turbo.json i18n.json ./
COPY .yarn ./.yarn
COPY apps ./apps
COPY example-apps ./example-apps
COPY packages ./packages

RUN yarn config set httpTimeout 1200000
RUN yarn install --immutable
# Build and make embed servable from web/public/embed folder
RUN yarn workspace @calcom/trpc run build
RUN yarn --cwd packages/embeds/embed-core workspace @calcom/embed-core run build
RUN yarn --cwd apps/web workspace @calcom/web run copy-app-store-static
RUN NEXT_TELEMETRY_DISABLED=1 yarn --cwd apps/web workspace @calcom/web run build
RUN rm -rf node_modules/.cache .yarn/cache apps/web/.next/cache

FROM node:24.21.0-bookworm-slim@sha256:0e0ff40c39bc087845bfb27465a0df4ea419520094bc35842ff83dd8cbe6f9b6 AS runtime-base

# Prisma's existing Debian engine needs OpenSSL even though Node itself does not.
RUN apt-get update \
  && apt-get install -y --no-install-recommends libssl3=3.0.20-1~deb12u2 openssl=3.0.20-1~deb12u2 ca-certificates=20250419~deb12u1 \
  && rm -rf /var/lib/apt/lists/*

FROM runtime-base AS builder-two

WORKDIR /calcom
ARG NEXT_PUBLIC_WEBAPP_URL=http://localhost:3000

ENV NODE_ENV=production

COPY --from=builder /calcom/apps/web/.next/standalone ./apps/web/.next/standalone
COPY --from=builder /calcom/apps/web/.next/static ./apps/web/.next/static
COPY --from=builder /calcom/apps/web/public ./apps/web/public
COPY scripts/replace-placeholder.sh ./scripts/replace-placeholder.sh

# Save value used during this build stage. If NEXT_PUBLIC_WEBAPP_URL and BUILT_NEXT_PUBLIC_WEBAPP_URL differ at
# run-time, then start.sh will find/replace static values again.
ENV NEXT_PUBLIC_WEBAPP_URL=$NEXT_PUBLIC_WEBAPP_URL \
  BUILT_NEXT_PUBLIC_WEBAPP_URL=$NEXT_PUBLIC_WEBAPP_URL

RUN sh scripts/replace-placeholder.sh http://NEXT_PUBLIC_WEBAPP_URL_PLACEHOLDER "${NEXT_PUBLIC_WEBAPP_URL}"

FROM builder AS maintenance

# Migration and seed tooling must not be shipped in the serving image.
COPY scripts ./scripts
ENV DATABASE_URL=""
ENV DATABASE_DIRECT_URL=""
ENV NEXTAUTH_SECRET=""
ENV CALENDSO_ENCRYPTION_KEY=""
USER node
CMD ["sh", "-ec", ": \"${DATABASE_URL:?Disposable database URL required}\" \"${DATABASE_DIRECT_URL:?Disposable database URL required}\"; yarn workspace @calcom/prisma prisma migrate deploy && yarn workspace @calcom/prisma seed-app-store"]

FROM runtime-base AS runner

WORKDIR /calcom

# The standalone server needs neither a package manager nor build/migration CLIs.
RUN rm -rf /usr/local/lib/node_modules /opt/yarn-* \
  && rm -f /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/yarn /usr/local/bin/yarnpkg /usr/local/bin/corepack

COPY --from=builder-two /calcom/apps/web/.next/standalone ./
COPY --from=builder-two --chown=node:node /calcom/apps/web/.next/static ./apps/web/.next/static
COPY --from=builder-two --chown=node:node /calcom/apps/web/public ./apps/web/public
COPY scripts/replace-placeholder.sh scripts/start-standalone.sh ./scripts/
RUN mkdir -p apps/web/.next/cache \
  && chown -R node:node apps/web/.next apps/web/server.js \
  && chmod 755 scripts/start-standalone.sh
ARG NEXT_PUBLIC_WEBAPP_URL=http://localhost:3000
ENV NEXT_PUBLIC_WEBAPP_URL=$NEXT_PUBLIC_WEBAPP_URL \
  BUILT_NEXT_PUBLIC_WEBAPP_URL=$NEXT_PUBLIC_WEBAPP_URL

ENV NODE_ENV=production HOSTNAME=0.0.0.0 PORT=3000 NEXT_TELEMETRY_DISABLED=1
USER node
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=30s --retries=5 \
  CMD node -e 'fetch("http://127.0.0.1:3000/auth/login").then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))'

CMD ["/calcom/scripts/start-standalone.sh"]
