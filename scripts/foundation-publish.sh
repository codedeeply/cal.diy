#!/usr/bin/env bash
# SLE-119 publish job steps. Nothing is pushed until every SLE-116 D2 publication verdict passes.
set -euo pipefail

: "${RELEASE_DIR:?}" "${IMAGE_REPO:?}" "${VERSION:?}" "${GITHUB_SHA:?}" "${GITHUB_REPOSITORY:?}"
verdicts="$RELEASE_DIR/verdicts"
mkdir -p "$verdicts"

gate() {
  node scripts/foundation-gates.mjs publication "$@" > "$verdicts/$1.json"
}

case "${1:-}" in
  gate-source)
    # CodeQL and Gitleaks already ran on this exact commit in the required push run on main;
    # their raw reports are re-evaluated here rather than trusting that run's recorded verdicts.
    read -r run_id attempt < <(gh api \
      "repos/$GITHUB_REPOSITORY/actions/workflows/foundation-ci.yml/runs?head_sha=$GITHUB_SHA&event=push&branch=main&status=success&per_page=1" \
      --jq '.workflow_runs[0] | "\(.id) \(.run_attempt)"')
    [[ "$run_id" =~ ^[0-9]+$ && "$attempt" =~ ^[0-9]+$ ]] || {
      echo "No successful Foundation CI push run on main for $GITHUB_SHA"
      exit 1
    }
    echo "https://github.com/$GITHUB_REPOSITORY/actions/runs/$run_id/attempts/$attempt" > "$RELEASE_DIR/ci-run.txt"
    for evidence in secrets codeql; do
      # "Re-run failed jobs" keeps passing jobs' artifacts under their original attempt number.
      name=$(gh api "repos/$GITHUB_REPOSITORY/actions/runs/$run_id/artifacts?per_page=100" --jq \
        "[.artifacts[] | select(.expired | not) | .name | select(startswith(\"foundation-$evidence-$run_id-\"))]
          | sort_by(split(\"-\") | last | tonumber) | last")
      [[ "$name" =~ ^foundation-$evidence-$run_id-[0-9]+$ ]]
      gh run download "$run_id" -R "$GITHUB_REPOSITORY" -n "$name" -D "$RELEASE_DIR/ci/$evidence"
    done
    scan="${RUNNER_TEMP:?}/publish-scan"
    mkdir -p "$scan"
    git archive "$GITHUB_SHA" | tar -x -C "$scan"
    report="$RELEASE_DIR/ci/secrets/gitleaks.json"
    status=$(cat "$RELEASE_DIR/ci/secrets/gitleaks-status")
    gate gitleaks "$report" "$status" "$scan"
    mapfile -d '' sarif < <(find "$RELEASE_DIR/ci/codeql" -name '*.sarif' -print0)
    [[ "${#sarif[@]}" -eq 1 ]]
    gate codeql "${sarif[0]}"
    ;;
  push)
    : "${LOCAL_IMAGE:?}" "${GH_TOKEN:?}" "${GITHUB_ACTOR:?}" "${GITHUB_OUTPUT:?}"
    gate config "$RELEASE_DIR/image/trivy-config.json"
    gate dependencies "$RELEASE_DIR/image/trivy-lock.json"
    gate image "$RELEASE_DIR/image/trivy-image.json"
    echo "$GH_TOKEN" | docker login ghcr.io -u "$GITHUB_ACTOR" --password-stdin
    # Release tags are write-once, so a re-run can never silently repoint a published version.
    # Only a definite "not found" counts as absent; any other registry error stops the job.
    if lookup=$(docker buildx imagetools inspect "$IMAGE_REPO:$VERSION" 2>&1); then
      echo "Refusing to replace existing tag $IMAGE_REPO:$VERSION"
      exit 1
    fi
    grep -qiE 'not found|manifest unknown' <<< "$lookup" || { echo "$lookup"; exit 1; }
    docker tag "$LOCAL_IMAGE" "$IMAGE_REPO:$VERSION"
    docker push "$IMAGE_REPO:$VERSION"
    # The digest comes from our own push, not a later registry read someone else could race.
    repo_digest=$(docker image inspect "$IMAGE_REPO:$VERSION" --format '{{index .RepoDigests 0}}')
    [[ "$repo_digest" == "$IMAGE_REPO@"* ]]
    digest=${repo_digest#"$IMAGE_REPO@"}
    [[ "$digest" =~ ^sha256:[a-f0-9]{64}$ ]]
    echo "$digest" > "$RELEASE_DIR/digest.txt"
    echo "digest=$digest" >> "$GITHUB_OUTPUT"
    ;;
  notes)
    : "${DIGEST:?}" "${GITHUB_STEP_SUMMARY:?}"
    SBOM_SHA256=$(sha256sum "$RELEASE_DIR/image/sbom.cdx.json" | cut -d' ' -f1)
    CI_RUN=$(cat "$RELEASE_DIR/ci-run.txt")
    export SBOM_SHA256 CI_RUN
    node scripts/foundation-gates.mjs release-notes "$verdicts" > "$RELEASE_DIR/release-notes.md"
    cat "$RELEASE_DIR/release-notes.md" >> "$GITHUB_STEP_SUMMARY"
    ;;
  *)
    echo "Usage: foundation-publish.sh gate-source|push|notes"
    exit 1
    ;;
esac
