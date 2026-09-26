#!/usr/bin/env bash
# SLE-120: send deliberate synthetic-booker errors from the server, edge and browser runtimes of a
# locally built image to a non-production Sentry project.
# Usage: SENTRY_DSN=... scripts/sle-120-sentry-proof.sh <run-label> [evidence-root]
set -euo pipefail

label=${1:?Usage: sle-120-sentry-proof.sh <run-label> [evidence-root]}
[[ "$label" =~ ^[a-z0-9-]+$ ]] || { echo "Run label must be lowercase letters, digits and dashes"; exit 1; }
: "${SENTRY_DSN:?Set SENTRY_DSN to the non-production project DSN}"
# Delivery is confirmed by reading the events back, so a read token for the same project is required.
: "${SENTRY_AUTH_TOKEN:?Set SENTRY_AUTH_TOKEN to a token with event:read on the project}"
: "${SENTRY_ORG:?Set SENTRY_ORG to the Sentry organization slug}" "${SENTRY_PROJECT:?Set SENTRY_PROJECT to the Sentry project slug}"
POSTGRES_IMAGE=postgres:16@sha256:a85daf0dbd5e79586e850e3fe4b21b796799828ad015ce2166aeb98cc24da61c
BUILDKIT_IMAGE=moby/buildkit@sha256:28a898719c18a33f4e8000685287fa36fd0dd9560c6440227d3a732d79bb41d8

for tool in docker git openssl curl node; do command -v "$tool" > /dev/null || { echo "Missing required tool: $tool"; exit 1; }; done
docker info > /dev/null || { echo "Docker engine is unavailable"; exit 1; }
repo=$(git rev-parse --show-toplevel)
sha=$(git -C "$repo" rev-parse HEAD)
evidence_root="${2:-${TMPDIR:-/tmp}/sle-120-proof}"
mkdir -p "$evidence_root/$sha"
evidence="$(cd "$evidence_root/$sha" && pwd)/$label"
mkdir "$evidence" || { echo "Refusing to overwrite evidence: $evidence"; exit 1; }
exec > >(tee "$evidence/proof.log") 2>&1

task="sle120-${sha:0:12}-$label"
image="caldiy-sle120:${sha:0:12}-$label"
environment="sle120-proof-$label"
source_dir=$(mktemp -d)
remove_environment() {
  docker rm -f "$task-web" "$task-db" > /dev/null 2>&1 || true
  docker buildx rm "$task" > /dev/null 2>&1 || true
  docker network rm "$task" > /dev/null 2>&1 || true
  docker image rm -f "$image" "$image-maintenance" "$task-playwright" > /dev/null 2>&1 || true
}
cleanup() {
  docker logs "$task-web" > "$evidence/runtime.log" 2>&1 || true
  remove_environment
  rm -rf "$source_dir"
}
remove_environment
trap cleanup EXIT

git -C "$repo" archive "$sha" | tar -x -C "$source_dir"
{
  echo "source_sha=$sha"
  echo "sentry_release=$sha"
  echo "sentry_environment=$environment"
  echo "started_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "docker=$(docker version --format '{{.Server.Version}} {{.Server.Os}}/{{.Server.Arch}}')"
} | tee "$evidence/environment.txt"

docker network create "$task"
docker run -d --name "$task-db" --network "$task" -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=calendso "$POSTGRES_IMAGE"
for _ in {1..30}; do
  if docker exec "$task-db" pg_isready -U postgres -d calendso > /dev/null; then break; fi
  sleep 2
done
docker buildx create --name "$task" --driver docker-container --driver-opt "network=container:$task-db" --driver-opt "image=$BUILDKIT_IMAGE"
build_args=(--build-arg DATABASE_URL=postgresql://postgres:postgres@localhost:5432/calendso
  --build-arg NEXT_PUBLIC_LICENSE_CONSENT=agree --build-arg CALCOM_TELEMETRY_DISABLED=1
  --build-arg NEXT_PUBLIC_WEBAPP_URL=http://localhost:3000
  --build-arg NEXTAUTH_SECRET=sle120-disposable-build-only
  --build-arg "CALENDSO_ENCRYPTION_KEY=$(openssl rand -hex 16)"
  --build-arg "NEXT_PUBLIC_SENTRY_DSN_CLIENT=$SENTRY_DSN"
  --build-arg "NEXT_PUBLIC_SENTRY_RELEASE=$sha"
  --build-arg "NEXT_PUBLIC_SENTRY_ENVIRONMENT=$environment")
docker buildx build --builder "$task" --target runner --load -t "$image" "${build_args[@]}" "$source_dir"
docker buildx build --builder "$task" --target maintenance --load -t "$image-maintenance" "${build_args[@]}" "$source_dir"

db="postgresql://postgres:postgres@$task-db:5432/calendso"
docker run --rm --network "$task" -e "DATABASE_URL=$db" -e "DATABASE_DIRECT_URL=$db" "$image-maintenance" > "$evidence/migrations.log" 2>&1
token=$(openssl rand -hex 24)
docker run -d --name "$task-web" --network "$task" -e "DATABASE_URL=$db" -e "DATABASE_DIRECT_URL=$db" \
  -e NEXTAUTH_SECRET=sle120-disposable-runtime-only -e "CALENDSO_ENCRYPTION_KEY=$(openssl rand -hex 16)" \
  -e NEXTAUTH_URL=http://localhost:3000 -e NEXT_PUBLIC_WEBAPP_URL=http://localhost:3000 -e CALCOM_TELEMETRY_DISABLED=1 \
  -e "SENTRY_DSN=$SENTRY_DSN" -e "SENTRY_RELEASE=$sha" -e "SENTRY_ENVIRONMENT=$environment" \
  -e SENTRY_TRACES_SAMPLE_RATE=1.0 -e "SENTRY_VERIFICATION_TOKEN=$token" "$image"
healthy=false
for _ in {1..90}; do
  if [[ "$(docker inspect "$task-web" --format '{{.State.Health.Status}}')" == healthy ]]; then healthy=true; break; fi
  sleep 2
done
[[ "$healthy" == true ]]

# Requests run inside the app's network namespace; the synthetic personal data rides in every
# place a real booking request carries it: query, body, forwarded IP and referer.
call() {
  docker run --rm --network "container:$task-web" curlimages/curl@sha256:c1fe1679c34d9784c1b0d1e5f62ac0a79fca01fb6377cdd33e90473c6f9f9a69 -s -o /dev/null -w '%{http_code}' \
    -X POST "http://localhost:3000$1?email=quinn.booker%40example.invalid&name=Quinn" \
    -H 'content-type: application/json' -H 'x-forwarded-for: 203.0.113.7' \
    -H 'referer: http://localhost:3000/team/demo?notes=Please+bring+the+synthetic+contract' \
    "${@:2}" --data '{"name":"Quinn Synthetic-Booker","notes":"Please bring the synthetic contract"}'
}
unauthorised=$(call /api/sentry-verification)
server=$(call /api/sentry-verification -H "x-sentry-verification: $token")
edge=$(call /api/sentry-verification/edge -H "x-sentry-verification: $token")
printf '{"unauthorised":%s,"server":%s,"edge":%s}\n' "$unauthorised" "$server" "$edge" | tee "$evidence/route-results.json"
[[ "$unauthorised" == 404 && "$server" == 500 && "$edge" == 500 ]]

docker build --file "$source_dir/.github/sgy-971/Dockerfile.playwright" --tag "$task-playwright" "$source_dir/.github/sgy-971"
docker run --rm --network "container:$task-web" -e BASE_URL=http://localhost:3000 -e EVIDENCE_DIR=/artifacts \
  -e "PROOF_MARKER=$label" -e "SENTRY_DSN=$SENTRY_DSN" -v "$evidence:/artifacts" \
  -v "$source_dir/.github/sle-120/sentry-browser-proof.mjs:/proof/sentry-browser-proof.mjs:ro" \
  --entrypoint node "$task-playwright" sentry-browser-proof.mjs
# A 500 only proves each route threw; success requires every event to be stored by Sentry.
SENTRY_PROOF_ENVIRONMENT="$environment" SENTRY_PROOF_RELEASE="$sha" SENTRY_PROOF_LABEL="$label" \
  node "$source_dir/.github/sle-120/verify-sentry-delivery.mjs" | tee "$evidence/delivery.json"
echo "SLE-120 Sentry proof $label: PASS (server, edge and browser events stored with release $sha, environment $environment). Evidence: $evidence"
