# SLE-118: bounded runtime dependency remediation

Status: implementation draft, R1 / A2, assigned to Sierra. Approval B authorizes
the scoped implementation and isolated tests, not merge or production. Hosted
Cal.com remains production. No real integrations, new schema/migration, security
exception, artifact publication, deployment or cutover is authorized.

Proposal and approval scope:
https://linear.app/sam-thacker-studios/issue/SLE-118/upgrade-vulnerable-nextjsauthprisma-runtime-dependencies-with#comment-e9fcc5ef-1e78-404b-9279-708d0bf7002a

## First patch: framework only

| Consumer | Previous Next.js | Exact target |
| --- | --- | --- |
| Web and platform base example | 16.2.3 | 16.3.5 |
| Docs | ^15.1.0 (locked 15.5.15) | 15.5.24 |
| Credential-sync example | 15.5.15 | 15.5.24 |

The docs manifest previously allowed `^15.1.0`; exact pins now identify both
maintained major branches. Yarn 4.12.0 generated the lockfile. Coupled changes are
Next/SWC/environment packages, SWC helpers, PostCSS/nanoid, and Sharp/native image
dependencies including libvips, colour, emnapi and semver. No unrelated dependency
refresh or React/Prisma major upgrade is included. Next 16 accepts Node >=20.9
and the existing React 18.2 peer range; the supported toolchain is Node 24.21.0.

The AVIF advisory fixes start at Next 15.5.24 and 16.3.3:
https://github.com/advisories/GHSA-2xp9-vwfh-vxw4

Next 15.5.24 bypasses AVIF optimization. Next 16.3.4 restored AVIF optimization
with Sharp >=0.35.4; 16.3.5 retains that repair. The locked native decoder is
Sharp 0.35.4, libheif 1.23.2 and libvips 8.18.6 on Linux AMD64. Do not confuse
the two branches' intentional behavior or restore the vulnerable decoder.
https://github.com/vercel/next.js/pull/97949
https://github.com/vercel/next.js/releases/tag/v16.3.5
https://github.com/vercel/next.js/releases/tag/v15.5.24

GitHub reviewed-advisory queries for both exact Next versions returned no matches
on 2026-09-20. This is point-in-time package evidence, not a clean transitive-graph
or image verdict. Whole-tree Gitleaks, CodeQL, lockfile/image Trivy and SBOM gates
remain mandatory; existing failures are not waived.

## Regression and review contract

`node --test scripts/next-security-regression.test.mjs` checks every consuming
workspace's manifest and installed version, the actual loaded Sharp version,
benign PNG conversion, branch-specific AVIF behavior and SVG rejection. Each
workspace runs in a separate process because native loader policy is global.
Fixtures are synthetic, generated in memory, with no network or real user data.
These compatibility tests do not claim comprehensive exploit verification.

Foundation CI runs these tests explicitly because Vitest excludes `scripts/`.
Existing org rewrite/booking route tests and the unit suite remain required,
as do immutable installation, forced type check, changed-file Biome and isolated
build/runtime checks. The workflow names the dependent PR's exact base branch
so this patch can receive real checks before its prerequisites merge.

No auth callbacks, cookies, sessions, CSRF controls, tenant checks, Prisma schema
or migrations are edited. Dependency changes still require runtime regressions;
absence of source edits is not proof of unchanged behavior. Auth v4, websocket
and tar remediation are separate small patches. The observed 10-hour magic-link
lifetime remains unchanged: Approval A is separate and has not been inferred.

Record exact head and checked merge SHAs, raw validation reports, artifact IDs
and CodeRabbit/deep-review results on SLE-118, milestone **2 — Secure Build and
Runtime**. PRs remain draft while required gates fail. Prerequisite PR #5 has
unresolved trusted-policy enforcement and permission-allowlist review issues:
https://github.com/codedeeply/cal.diy/pull/5

## Rollback and acceptance boundary

The immediate source/lockfile comparison baseline is
`03b9cf84d969d115cd2c12a4dab5c8739e81feaa`. Revert this bounded patch through review
to restore its four manifests and lockfile; do not rewrite shared history.
Schema and migrations must remain byte-identical. Rehearse source/lockfile and
disposable database recovery before recommending merge; a source revert alone
does not prove database rollback. The vulnerable comparison baseline is not an
approved production recovery artifact. SLE-121 owns production recovery proof.

Sierra's explicit R1 merge approval, tested rollback and all deterministic gates
are still required. This first patch does not complete SLE-118 or authorize
SLE-119 artifact publication. Track agent/CI time separately from Sierra minutes;
the maintenance target remains 3–6 Sierra hours/month.
