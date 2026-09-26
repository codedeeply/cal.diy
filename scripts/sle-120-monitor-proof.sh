#!/usr/bin/env bash
# SLE-120: prove the synthetic checks alert on a controlled database outage and recover, against a
# locally built image reporting to a non-production Sentry project. Synthetic data only.
# Usage: SENTRY_DSN=... scripts/sle-120-monitor-proof.sh <run-label> [evidence-root]
set -euo pipefail

label=${1:?Usage: sle-120-monitor-proof.sh <run-label> [evidence-root]}
[[ "$label" =~ ^[a-z0-9-]+$ ]] || { echo "Run label must be lowercase letters, digits and dashes"; exit 1; }
: "${SENTRY_DSN:?Set SENTRY_DSN to the non-production project DSN}"
POSTGRES_IMAGE=postgres:16@sha256:a85daf0dbd5e79586e850e3fe4b21b796799828ad015ce2166aeb98cc24da61c
BUILDKIT_IMAGE=moby/buildkit@sha256:28a898719c18a33f4e8000685287fa36fd0dd9560c6440227d3a732d79bb41d8
NODE_IMAGE=node:24.21.0-trixie-slim@sha256:8ec5d7557396cfe32d21c3f9c13072355ceab22b584578ca4bb28af31120cffe

for tool in docker git openssl; do command -v "$tool" > /dev/null || { echo "Missing required tool: $tool"; exit 1; }; done
docker info > /dev/null || { echo "Docker engine is unavailable"; exit 1; }
repo=$(git rev-parse --show-toplevel)
sha=$(git -C "$repo" rev-parse HEAD)
evidence_root="${2:-${TMPDIR:-/tmp}/sle-120-monitor-proof}"
mkdir -p "$evidence_root/$sha"
evidence="$(cd "$evidence_root/$sha" && pwd)/$label"
mkdir "$evidence" || { echo "Refusing to overwrite evidence: $evidence"; exit 1; }
exec > >(tee "$evidence/proof.log") 2>&1

task="sle120m-${sha:0:12}-$label"
image="caldiy-sle120m:${sha:0:12}-$label"
environment="sle120-monitor-proof-$label"
source_dir=$(mktemp -d)
remove_environment() {
  docker rm -f "$task-web" "$task-db" > /dev/null 2>&1 || true
  docker buildx rm "$task" > /dev/null 2>&1 || true
  docker network rm "$task" > /dev/null 2>&1 || true
  docker image rm -f "$image" "$image-maintenance" > /dev/null 2>&1 || true
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
  echo "sentry_environment=$environment"
  echo "started_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "docker=$(docker version --format '{{.Server.Version}} {{.Server.Os}}/{{.Server.Arch}}')"
} | tee "$evidence/environment.txt"

wait_for_database() {
  for _ in {1..30}; do
    if docker exec "$task-db" pg_isready -U postgres -d calendso > /dev/null 2>&1; then return 0; fi
    sleep 2
  done
  return 1
}

docker network create "$task"
docker run -d --name "$task-db" --network "$task" -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=calendso "$POSTGRES_IMAGE"
wait_for_database
docker buildx create --name "$task" --driver docker-container --driver-opt "network=container:$task-db" --driver-opt "image=$BUILDKIT_IMAGE"
build_args=(--build-arg DATABASE_URL=postgresql://postgres:postgres@localhost:5432/calendso
  --build-arg NEXT_PUBLIC_LICENSE_CONSENT=agree --build-arg CALCOM_TELEMETRY_DISABLED=1
  --build-arg NEXT_PUBLIC_WEBAPP_URL=http://localhost:3000
  --build-arg NEXTAUTH_SECRET=sle120-disposable-build-only
  --build-arg "CALENDSO_ENCRYPTION_KEY=$(openssl rand -hex 16)")
docker buildx build --builder "$task" --target runner --load -t "$image" "${build_args[@]}" "$source_dir"
docker buildx build --builder "$task" --target maintenance --load -t "$image-maintenance" "${build_args[@]}" "$source_dir"

db="postgresql://postgres:postgres@$task-db:5432/calendso"
maintenance=(docker run --rm --network "$task" -e "DATABASE_URL=$db" -e "DATABASE_DIRECT_URL=$db" "$image-maintenance")
"${maintenance[@]}" > "$evidence/migrations.log" 2>&1
"${maintenance[@]}" yarn workspace @calcom/prisma ts-node --transpile-only ../../scripts/sgy-971-seed.ts > "$evidence/seed.json"
docker run -d --name "$task-web" --network "$task" -e "DATABASE_URL=$db" -e "DATABASE_DIRECT_URL=$db" \
  -e NEXTAUTH_SECRET=sle120-disposable-runtime-only -e "CALENDSO_ENCRYPTION_KEY=$(openssl rand -hex 16)" \
  -e NEXTAUTH_URL=http://localhost:3000 -e NEXT_PUBLIC_WEBAPP_URL=http://localhost:3000 -e CALCOM_TELEMETRY_DISABLED=1 "$image"
healthy=false
for _ in {1..90}; do
  if [[ "$(docker inspect "$task-web" --format '{{.State.Health.Status}}')" == healthy ]]; then healthy=true; break; fi
  sleep 2
done
[[ "$healthy" == true ]]

# Returns the checker's exit status (0 ok, 1 checks failed) and appends its report to the evidence.
check() {
  local status=0
  docker run --rm --network "container:$task-web" -v "$source_dir/scripts/synthetic-checks.mjs:/checks.mjs:ro" \
    -e BASE_URL=http://localhost:3000 -e "SENTRY_DSN=$SENTRY_DSN" -e CANARY_BOOKING_PATH=/sgy-971-host/30-min \
    -e "SENTRY_ENVIRONMENT=$environment" -e "SENTRY_RELEASE=$sha" -e CHECK_INTERVAL_MINUTES=60 \
    "$NODE_IMAGE" node /checks.mjs >> "$evidence/checks.jsonl" || status=$?
  return "$status"
}

check || { echo "Healthy baseline check failed"; exit 1; }
docker stop "$task-db"
outage=0
check || outage=$?
[[ "$outage" == 1 ]] || { echo "Expected the outage check to report failure (exit 1), got $outage"; exit 1; }
# Another probe failing is not enough: the database check itself must detect the outage.
tail -n 1 "$evidence/checks.jsonl" | grep -q '"database":"' || { echo "Outage not detected by the database check"; exit 1; }
docker start "$task-db"
wait_for_database
recovered=false
for _ in {1..30}; do
  if check; then recovered=true; break; fi
  sleep 5
done
[[ "$recovered" == true ]] || { echo "Checks did not recover after the database returned"; exit 1; }
cat "$evidence/checks.jsonl"
echo "SLE-120 monitor proof $label: PASS (ok → error on database outage → ok). Environment $environment. Evidence: $evidence"
