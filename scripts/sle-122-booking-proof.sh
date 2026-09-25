#!/usr/bin/env bash
# SLE-122: one clean, isolated build-and-book proof from the committed source.
# Usage: scripts/sle-122-booking-proof.sh <run-label> [evidence-root]
# Only synthetic data is used; no external service, credential or integration is contacted.
set -euo pipefail

label=${1:?Usage: sle-122-booking-proof.sh <run-label> [evidence-root]}
[[ "$label" =~ ^[a-z0-9-]+$ ]] || { echo "Run label must be lowercase letters, digits and dashes"; exit 1; }
POSTGRES_IMAGE=postgres:16@sha256:a85daf0dbd5e79586e850e3fe4b21b796799828ad015ce2166aeb98cc24da61c
BUILDKIT_IMAGE=moby/buildkit@sha256:28a898719c18a33f4e8000685287fa36fd0dd9560c6440227d3a732d79bb41d8

# Fail closed on missing prerequisites instead of producing a partial proof.
for tool in docker git openssl; do command -v "$tool" > /dev/null || { echo "Missing required tool: $tool"; exit 1; }; done
docker info > /dev/null || { echo "Docker engine is unavailable"; exit 1; }
repo=$(git rev-parse --show-toplevel)
sha=$(git -C "$repo" rev-parse HEAD)
evidence="${2:-${TMPDIR:-/tmp}/sle-122-proof}/$sha/$label"
if [[ -e "$evidence" ]]; then echo "Refusing to overwrite evidence: $evidence"; exit 1; fi
mkdir -p "$evidence"
exec > >(tee "$evidence/proof.log") 2>&1

task="sle122-$label"
image="caldiy-sle122:$label"
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
# Remove anything a previous run with this label left behind, so no hidden state carries over.
remove_environment
trap cleanup EXIT

# A tracked-files-only export is the clean checkout: no node_modules, build caches or local .env.
git -C "$repo" archive "$sha" | tar -x -C "$source_dir"
{
  echo "source_sha=$sha"
  echo "run_label=$label"
  echo "started_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "host=$(uname -sm)"
  echo "docker=$(docker version --format '{{.Server.Version}} {{.Server.Os}}/{{.Server.Arch}}')"
  echo "postgres_image=$POSTGRES_IMAGE"
  echo "buildkit_image=$BUILDKIT_IMAGE"
} | tee "$evidence/environment.txt"

set -x
docker network create "$task"
docker run -d --name "$task-db" --network "$task" -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=calendso "$POSTGRES_IMAGE"
for _ in {1..30}; do
  if docker exec "$task-db" pg_isready -U postgres -d calendso; then break; fi
  sleep 2
done
docker exec "$task-db" pg_isready -U postgres -d calendso
docker buildx create --name "$task" --driver docker-container --driver-opt "network=container:$task-db" --driver-opt "image=$BUILDKIT_IMAGE"
build_args=(--build-arg DATABASE_URL=postgresql://postgres:postgres@localhost:5432/calendso
  --build-arg NEXT_PUBLIC_LICENSE_CONSENT=agree --build-arg CALCOM_TELEMETRY_DISABLED=1
  --build-arg NEXT_PUBLIC_WEBAPP_URL=http://localhost:3000
  --build-arg NEXTAUTH_SECRET=sle122-disposable-build-only
  --build-arg "CALENDSO_ENCRYPTION_KEY=$(openssl rand -hex 16)")
docker buildx build --builder "$task" --no-cache --target runner --load -t "$image" "${build_args[@]}" "$source_dir"
docker buildx build --builder "$task" --target maintenance --load -t "$image-maintenance" "${build_args[@]}" "$source_dir"

db="postgresql://postgres:postgres@$task-db:5432/calendso"
maintenance=(docker run --rm --network "$task" -e "DATABASE_URL=$db" -e "DATABASE_DIRECT_URL=$db" "$image-maintenance")
"${maintenance[@]}" > "$evidence/migrations.log" 2>&1
# The seed runs in the maintenance image, which holds the full workspace and ts-node; the
# serving image deliberately ships neither, which is why the SGY-971 harness could not seed.
"${maintenance[@]}" yarn workspace @calcom/prisma ts-node --transpile-only ../../scripts/sgy-971-seed.ts \
  | tee "$evidence/seed.json"

docker run -d --name "$task-web" --network "$task" -e "DATABASE_URL=$db" -e "DATABASE_DIRECT_URL=$db" \
  -e NEXTAUTH_SECRET=sle122-disposable-runtime-only -e "CALENDSO_ENCRYPTION_KEY=$(openssl rand -hex 16)" \
  -e NEXTAUTH_URL=http://localhost:3000 -e NEXT_PUBLIC_WEBAPP_URL=http://localhost:3000 \
  -e CALCOM_TELEMETRY_DISABLED=1 "$image"
healthy=false
for _ in {1..90}; do
  if [[ "$(docker inspect "$task-web" --format '{{.State.Health.Status}}')" == healthy ]]; then healthy=true; break; fi
  sleep 2
done
[[ "$healthy" == true ]]

# Sharing the app's network namespace keeps the browser on the URL the image was built for.
docker build --file "$source_dir/.github/sgy-971/Dockerfile.playwright" --tag "$task-playwright" "$source_dir/.github/sgy-971"
docker run --rm --network "container:$task-web" -e BASE_URL=http://localhost:3000 -e EVIDENCE_DIR=/artifacts \
  -v "$evidence:/artifacts" "$task-playwright"

count=$(docker exec "$task-db" psql -U postgres -d calendso -tAc \
  "SELECT COUNT(DISTINCT b.id) FROM \"Booking\" b JOIN \"Attendee\" a ON a.\"bookingId\" = b.id JOIN \"EventType\" e ON e.id = b.\"eventTypeId\" JOIN users u ON u.id = e.\"userId\" WHERE a.email = 'sgy-971-attendee@example.invalid' AND u.username = 'sgy-971-host' AND e.slug = '30-min' AND b.status = 'accepted';")
set +x
[[ "$count" == 1 ]] || { echo "Expected exactly one accepted synthetic booking; found $count"; exit 1; }
printf '{"sourceSha":"%s","run":"%s","acceptedBookings":%s,"result":"PASS"}\n' "$sha" "$label" "$count" \
  | tee "$evidence/result.json"
echo "SLE-122 booking proof $label: PASS (evidence: $evidence)"
