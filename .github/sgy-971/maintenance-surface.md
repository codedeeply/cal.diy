# SGY-971 maintenance-surface record

Recorded before baseline fixes on 2026-09-20.

## Frozen source

- Upstream: `calcom/cal.diy`
- Default branch: `main`
- Source SHA: `6bc45298226f96ff79e0c070c8b2ce39727e8477`
- Commit date: `2026-09-14T08:35:09Z`
- Selection reason: the current post-split upstream `main` head at preflight; it was also the newly created fork's head.
- Latest release: `v6.2.0`, published 2026-03-01; it predates the source split and is not used.
- Registry check: Docker Hub reports zero tags; the legacy Scarf `latest` reference is absent; anonymous GHCR inspection is denied, so no usable public GHCR image was established.

## Runtime and build surface

- Required for this proof: the Next.js web image and PostgreSQL 16. The upstream web container depends only on PostgreSQL and runs Prisma migrations itself.
- Not required: API v2, Redis, workers, or scheduled jobs. The booking UI uses the web application's own routes for this isolated path.
- Toolchain: Node 20, Yarn 4.12.0, Turborepo, Next.js, Prisma migrations, Vitest, and Playwright.
- Size indicators: 117 workspace package manifests, about 3,935 unique lockfile resolutions, and 595 Prisma migration directories.
- Upstream CI inventory: 50 workflow files. All are relocated outside `.github/workflows`; the fork retains one `workflow_dispatch`-only spike workflow.

## Security surface

- Fork Dependabot alerts are disabled, so no alert inventory is available without changing repository security settings.
- Fork code scanning reports no analysis; fork secret scanning reports zero alerts.
- Upstream PR #30101, constant-time webhook-secret comparison, remains open.
- Upstream PR #30158, validation of ICS/avatar fetch URLs, remains open.
- Neither security PR is part of the frozen baseline. Both concern future webhook or remote-fetch threat surfaces excluded from this isolated booking proof.

## Proposed normal-month routine

1. Spend 45 minutes reviewing upstream releases, merged security changes, open security reports, and dependency advisories.
2. Spend 45 minutes selecting one narrow update and reviewing its diff against the pinned source.
3. Spend 75 minutes running the frozen workflow twice and reviewing build, booking, Gitleaks, Trivy, and SBOM evidence.
4. Spend 45 minutes on human review, recording the new digest, and retaining the prior digest as rollback.

Estimated Sierra attention: 3.5 hours in a normal update month. Stop and defer any update that changes schema, auth, payment, calendar, or timezone behavior until it receives a separate review card.
