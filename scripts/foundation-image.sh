#!/usr/bin/env bash
set -euo pipefail

: "${EVIDENCE_DIR:?}" "${SLE119_RUN_ID:?}" "${TRIVY_IMAGE:?}" "${SYFT_IMAGE:?}" "${POSTGRES_IMAGE:?}" "${BUILDKIT_IMAGE:?}"
for input in "$TRIVY_IMAGE" "$SYFT_IMAGE" "$POSTGRES_IMAGE" "$BUILDKIT_IMAGE"; do
  [[ "$input" =~ @sha256:[a-f0-9]{64}$ ]] || { echo "Unpinned tool image"; exit 1; }
done
[[ "$SLE119_RUN_ID" =~ ^[a-z0-9-]+$ ]] || exit 1
task="sle119-$SLE119_RUN_ID"
image="caldiy-sle119:$SLE119_RUN_ID"
for name in "$task-db" "$task-web" "buildx_buildkit_${task}0"; do
  if docker container inspect "$name" >/dev/null 2>&1; then echo "Refusing existing container: $name"; exit 1; fi
done
if docker network inspect "$task" >/dev/null 2>&1; then echo "Refusing existing network: $task"; exit 1; fi
if docker buildx inspect "$task" >/dev/null 2>&1; then echo "Refusing existing builder: $task"; exit 1; fi
mkdir -p "$EVIDENCE_DIR"
docker network create "$task"
cleanup() {
  docker logs "$task-web" > "$EVIDENCE_DIR/runtime.log" 2>&1 || true
  docker rm -f "$task-web" "$task-db" >/dev/null 2>&1 || true
  docker buildx rm "$task" >/dev/null 2>&1 || true
  docker network rm "$task" >/dev/null 2>&1 || true
}
trap cleanup EXIT
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
  --build-arg NEXTAUTH_SECRET=sle119-disposable-build-only
  --build-arg "CALENDSO_ENCRYPTION_KEY=$(openssl rand -hex 16)")
docker buildx build --builder "$task" --platform linux/amd64 --target runner --load -t "$image" "${build_args[@]}" --metadata-file "$EVIDENCE_DIR/build-metadata.json" .
docker buildx build --builder "$task" --platform linux/amd64 --target maintenance --load -t "$image-maintenance" "${build_args[@]}" .
db="postgresql://postgres:postgres@$task-db:5432/calendso"
docker run --rm --network "$task" -e "DATABASE_URL=$db" -e "DATABASE_DIRECT_URL=$db" "$image-maintenance" > "$EVIDENCE_DIR/maintenance.log" 2>&1
docker run -d --name "$task-web" --network "$task" -e "DATABASE_URL=$db" -e "DATABASE_DIRECT_URL=$db" -e NEXTAUTH_SECRET=sle119-disposable-runtime-only -e "CALENDSO_ENCRYPTION_KEY=$(openssl rand -hex 16)" -e NEXTAUTH_URL=http://localhost:3000 -e CALCOM_TELEMETRY_DISABLED=1 "$image"
healthy=false
for _ in {1..60}; do
  if [[ "$(docker inspect "$task-web" --format '{{.State.Health.Status}}')" == healthy ]]; then healthy=true; break; fi
  sleep 2
done
[[ "$healthy" == true ]]
docker exec "$task-web" node -e 'if(process.getuid()!==1000||process.arch!=="x64")process.exit(1);const fs=require("node:fs");for(const p of ["apps/web/server.js","apps/web/public","apps/web/.next/static"]){try{fs.accessSync(p,fs.constants.W_OK);process.exit(1)}catch(e){if(e.code!=="EACCES")throw e}}console.log("non-root, amd64, immutable application: PASS")' > "$EVIDENCE_DIR/runtime-assertion.txt"
docker image inspect "$image" > "$EVIDENCE_DIR/image.json"
docker run --rm -v /var/run/docker.sock:/var/run/docker.sock -v "$EVIDENCE_DIR:/out" "$SYFT_IMAGE" "docker:$image" -o cyclonedx-json=/out/sbom.cdx.json
docker run --rm -v /var/run/docker.sock:/var/run/docker.sock -v "$EVIDENCE_DIR:/out" "$TRIVY_IMAGE" image --disable-telemetry --no-progress --scanners vuln --format json --output /out/trivy-image.json "$image"
docker run --rm -v "$PWD:/repo:ro" -v "$EVIDENCE_DIR:/out" "$TRIVY_IMAGE" config --format json --output /out/trivy-config.json /repo/Dockerfile
docker run --rm -v "$PWD/yarn.lock:/scan/yarn.lock:ro" -v "$EVIDENCE_DIR:/out" "$TRIVY_IMAGE" fs --no-progress --scanners vuln --format json --output /out/trivy-lock.json /scan
node scripts/foundation-gates.mjs config "$EVIDENCE_DIR/trivy-config.json"
node scripts/foundation-gates.mjs dependencies "$EVIDENCE_DIR/trivy-lock.json"
node scripts/foundation-gates.mjs image "$EVIDENCE_DIR/trivy-image.json"
