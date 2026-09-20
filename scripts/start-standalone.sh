#!/bin/sh
set -eu

# Schema deployment is an explicit prerequisite, performed with the maintenance target.
sh scripts/replace-placeholder.sh "$BUILT_NEXT_PUBLIC_WEBAPP_URL" "$NEXT_PUBLIC_WEBAPP_URL"
if [ "$BUILT_NEXT_PUBLIC_WEBAPP_URL" != "$NEXT_PUBLIC_WEBAPP_URL" ]; then
  # Standalone serializes the rewrite configuration outside the .next directory.
  node -e 'const fs = require("node:fs"); const path = "apps/web/server.js"; const from = JSON.stringify(process.env.BUILT_NEXT_PUBLIC_WEBAPP_URL).slice(1, -1); const to = JSON.stringify(process.env.NEXT_PUBLIC_WEBAPP_URL).slice(1, -1); fs.writeFileSync(path, fs.readFileSync(path, "utf8").replaceAll(from, to));'
fi
exec node apps/web/server.js
