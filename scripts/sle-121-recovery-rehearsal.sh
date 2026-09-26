#!/usr/bin/env bash
# SLE-121: rehearse backup/restore and artifact rollback with disposable data only.
#   1. Build the candidate (HEAD), migrate, seed and book booking A through the public page.
#   2. Back up with pg_dump (recovery point), then book booking B (lost on restore by design).
#   3. Restore into a brand-new database, start the candidate, and time recovery.
#   4. Roll the running app back to the previous signed image on the restored data, then forward.
# Usage: scripts/sle-121-recovery-rehearsal.sh <run-label> [evidence-root]
# PREVIOUS_IMAGE defaults to the signed caldiy-2026.10.1-rc.1 digest.
set -euo pipefail

label=${1:?Usage: sle-121-recovery-rehearsal.sh <run-label> [evidence-root]}
[[ "$label" =~ ^[a-z0-9-]+$ ]] || { echo "Run label must be lowercase letters, digits and dashes"; exit 1; }
PREVIOUS_IMAGE=${PREVIOUS_IMAGE:-ghcr.io/codedeeply/cal.diy@sha256:fa7b9f0e51e2ce8957f27b8b56a2636562803398fa74a19f691b27434a0ed062}
POSTGRES_IMAGE=postgres:16@sha256:a85daf0dbd5e79586e850e3fe4b21b796799828ad015ce2166aeb98cc24da61c
BUILDKIT_IMAGE=moby/buildkit@sha256:28a898719c18a33f4e8000685287fa36fd0dd9560c6440227d3a732d79bb41d8
[[ "$PREVIOUS_IMAGE" =~ @sha256:[a-f0-9]{64}$ ]] || { echo "PREVIOUS_IMAGE must be pinned by digest"; exit 1; }

for tool in docker git openssl; do command -v "$tool" > /dev/null || { echo "Missing required tool: $tool"; exit 1; }; done
docker info > /dev/null || { echo "Docker engine is unavailable"; exit 1; }
repo=$(git rev-parse --show-toplevel)
sha=$(git -C "$repo" rev-parse HEAD)
evidence_root="${2:-${TMPDIR:-/tmp}/sle-121-rehearsal}"
mkdir -p "$evidence_root/$sha"
evidence="$(cd "$evidence_root/$sha" && pwd)/$label"
mkdir "$evidence" || { echo "Refusing to overwrite evidence: $evidence"; exit 1; }
exec > >(tee "$evidence/rehearsal.log") 2>&1

task="sle121-${sha:0:12}-$label"
image="caldiy-sle121:${sha:0:12}-$label"
source_dir=$(mktemp -d)
remove_environment() {
  docker rm -f "$task-web" "$task-db" "$task-db-restored" > /dev/null 2>&1 || true
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

now() { date -u +%Y-%m-%dT%H:%M:%SZ; }
seconds() { date -u +%s; }
git -C "$repo" archive "$sha" | tar -x -C "$source_dir"
{
  echo "source_sha=$sha"
  echo "candidate_image=built from source_sha (target runner)"
  echo "previous_image=$PREVIOUS_IMAGE"
  echo "started_at=$(now)"
  echo "docker=$(docker version --format '{{.Server.Version}} {{.Server.Os}}/{{.Server.Arch}}')"
} | tee "$evidence/environment.txt"

# One set of disposable secrets for every app start: a restore is only usable with the same
# CALENDSO_ENCRYPTION_KEY, so it belongs in the backup set alongside the dump.
nextauth_secret=$(openssl rand -hex 32)
encryption_key=$(openssl rand -hex 16)

wait_for_database() {
  for _ in {1..30}; do
    if docker exec "$1" pg_isready -U postgres -d calendso > /dev/null 2>&1; then return 0; fi
    sleep 2
  done
  return 1
}
start_web() {
  local app_image=$1 database=$2 platform=()
  [[ "$app_image" == "$PREVIOUS_IMAGE" ]] && platform=(--platform linux/amd64)
  local db="postgresql://postgres:postgres@$database:5432/calendso"
  docker run -d ${platform[@]+"${platform[@]}"} --name "$task-web" --network "$task" -e "DATABASE_URL=$db" -e "DATABASE_DIRECT_URL=$db" \
    -e "NEXTAUTH_SECRET=$nextauth_secret" -e "CALENDSO_ENCRYPTION_KEY=$encryption_key" \
    -e NEXTAUTH_URL=http://localhost:3000 -e NEXT_PUBLIC_WEBAPP_URL=http://localhost:3000 -e CALCOM_TELEMETRY_DISABLED=1 \
    "$app_image" > /dev/null
  for _ in {1..150}; do
    if [[ "$(docker inspect "$task-web" --format '{{.State.Health.Status}}')" == healthy ]]; then return 0; fi
    sleep 2
  done
  echo "App did not become healthy: $app_image"
  return 1
}
bookings() {
  docker exec "$1" psql -U postgres -d calendso -tAc \
    "SELECT COALESCE(string_agg(b.uid, ',' ORDER BY b.id), '') FROM \"Booking\" b JOIN users u ON u.id = b.\"userId\" WHERE u.username = 'sgy-971-host' AND b.status = 'accepted';"
}
book() {
  mkdir -p "$evidence/$1"
  docker run --rm --network "container:$task-web" -e BASE_URL=http://localhost:3000 -e EVIDENCE_DIR=/artifacts \
    -v "$evidence/$1:/artifacts" "$task-playwright"
}
booking_page_ok() {
  docker run --rm --network "container:$task-web" --entrypoint node "$task-playwright" -e \
    'fetch("http://localhost:3000/sgy-971-host/30-min").then(async r=>{const b=await r.text();process.exit(r.ok&&b.includes("30-min")?0:1)}).catch(()=>process.exit(1))'
}

set -x
docker network create "$task"
docker run -d --name "$task-db" --network "$task" -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=calendso "$POSTGRES_IMAGE"
wait_for_database "$task-db"
docker pull --platform linux/amd64 "$PREVIOUS_IMAGE"
docker buildx create --name "$task" --driver docker-container --driver-opt "network=container:$task-db" --driver-opt "image=$BUILDKIT_IMAGE"
build_args=(--build-arg DATABASE_URL=postgresql://postgres:postgres@localhost:5432/calendso
  --build-arg NEXT_PUBLIC_LICENSE_CONSENT=agree --build-arg CALCOM_TELEMETRY_DISABLED=1
  --build-arg NEXT_PUBLIC_WEBAPP_URL=http://localhost:3000
  --build-arg NEXTAUTH_SECRET=sle121-disposable-build-only
  --build-arg "CALENDSO_ENCRYPTION_KEY=$(openssl rand -hex 16)")
docker buildx build --builder "$task" --target runner --load -t "$image" "${build_args[@]}" "$source_dir"
docker buildx build --builder "$task" --target maintenance --load -t "$image-maintenance" "${build_args[@]}" "$source_dir"
docker build --file "$source_dir/.github/sgy-971/Dockerfile.playwright" --tag "$task-playwright" "$source_dir/.github/sgy-971"

db="postgresql://postgres:postgres@$task-db:5432/calendso"
maintenance=(docker run --rm --network "$task" -e "DATABASE_URL=$db" -e "DATABASE_DIRECT_URL=$db" "$image-maintenance")
"${maintenance[@]}" > "$evidence/migrations.log" 2>&1
"${maintenance[@]}" yarn workspace @calcom/prisma ts-node --transpile-only ../../scripts/sgy-971-seed.ts > "$evidence/seed.json"
start_web "$image" "$task-db"
book booking-a
booking_a=$(bookings "$task-db")
[[ -n "$booking_a" && "$booking_a" != *,* ]]

# Backup: the dump plus the configuration a restore needs (names only; values stay in the vault).
backup_at=$(now)
docker exec "$task-db" pg_dump -U postgres -d calendso -Fc > "$evidence/backup.dump"
[[ -s "$evidence/backup.dump" ]]
{
  echo "backup_taken_at=$backup_at"
  echo "backup_sha256=$(shasum -a 256 "$evidence/backup.dump" | cut -d' ' -f1)"
  echo "backup_bytes=$(wc -c < "$evidence/backup.dump" | tr -d ' ')"
  echo "migrations_applied=$(docker exec "$task-db" psql -U postgres -d calendso -tAc 'SELECT count(*) FROM _prisma_migrations WHERE finished_at IS NOT NULL')"
  echo "required_with_backup=CALENDSO_ENCRYPTION_KEY (decrypts stored credentials), NEXTAUTH_SECRET (sessions), NEXT_PUBLIC_WEBAPP_URL (must equal the image's built URL), image digest"
} | tee "$evidence/backup-manifest.txt"

book booking-b
after_backup=$(bookings "$task-db")
[[ "$after_backup" == "$booking_a",* ]]

# Restore into a brand-new database and time it until the app serves again.
docker rm -f "$task-web" > /dev/null
restore_started=$(seconds)
docker run -d --name "$task-db-restored" --network "$task" -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=calendso "$POSTGRES_IMAGE"
wait_for_database "$task-db-restored"
docker exec -i "$task-db-restored" pg_restore -U postgres -d calendso --no-owner < "$evidence/backup.dump"
start_web "$image" "$task-db-restored"
restore_seconds=$(( $(seconds) - restore_started ))
restored=$(bookings "$task-db-restored")
[[ "$restored" == "$booking_a" ]]
booking_page_ok

# Roll back to the previous signed image on the restored data, then forward again.
docker rm -f "$task-web" > /dev/null
rollback_started=$(seconds)
start_web "$PREVIOUS_IMAGE" "$task-db-restored"
rollback_seconds=$(( $(seconds) - rollback_started ))
booking_page_ok
[[ "$(bookings "$task-db-restored")" == "$booking_a" ]]
docker rm -f "$task-web" > /dev/null
forward_started=$(seconds)
start_web "$image" "$task-db-restored"
forward_seconds=$(( $(seconds) - forward_started ))
booking_page_ok
set +x

printf '{"sourceSha":"%s","previousImage":"%s","backupTakenAt":"%s","bookingKept":"%s","bookingLostAfterBackup":"%s","restoreToHealthySeconds":%s,"rollbackToHealthySeconds":%s,"rollForwardToHealthySeconds":%s,"result":"PASS"}\n' \
  "$sha" "$PREVIOUS_IMAGE" "$backup_at" "$booking_a" "${after_backup#"$booking_a",}" \
  "$restore_seconds" "$rollback_seconds" "$forward_seconds" | tee "$evidence/result.json"
echo "SLE-121 recovery rehearsal $label: PASS. Evidence: $evidence"
