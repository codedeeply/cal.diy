#!/bin/sh
set -eu

# A root-owned record prevents environment overrides from bypassing immutable public configuration.
if [ "$(cat /calcom/built-public-url)" != "${NEXT_PUBLIC_WEBAPP_URL:?Public URL required}" ]; then
  echo "Public URL differs from this artifact; rebuild with NEXT_PUBLIC_WEBAPP_URL set to the intended URL." >&2
  exit 1
fi
# Schema deployment is an explicit prerequisite, performed with the maintenance target.
exec node apps/web/server.js
