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

## Second patch: NextAuth v4 security repair

Both `apps/web` and `packages/features/auth` pin next-auth **4.24.15**, replacing
4.24.13. The only coupled lockfile addition is its required UUID 11.1.1 dependency;
other UUID consumers stay unchanged. No Prisma, React, auth callback, schema,
migration or runtime policy edit is included. Approval B covers this patch;
Approval A does not, so the executable magic-link lifetime stays **36,000 seconds
(10 hours)**. The existing misleading source comment is not authority to shorten it.

The upstream patch repairs normalization-before-validation of email identifiers,
malformed percent-encoded Bearer handling and provider binding of state/nonce/PKCE:
https://github.com/advisories/GHSA-7rqj-j65f-68wh
https://github.com/advisories/GHSA-xmf8-cvqr-rfgj
https://github.com/advisories/GHSA-x445-f3h2-j279
https://github.com/nextauthjs/next-auth/releases/tag/next-auth@4.24.15

**Upgrade behavior:** OAuth sign-ins started before the patch have unbound check
cookies and must restart after upgrading. Do not bypass the provider binding to
accept legacy cookies. Existing JWT sessions are tested separately. No real
OAuth provider, email transport or user data is used during these tests.

`scripts/auth-security-regression.test.mjs` exercises the installed vendor code:
version pins, malformed Bearer rejection, JWT validity/expiry, OAuth check-cookie
round trips and negative cases, Unicode email normalization, hashed single-use
magic links, expiry/identifier rejection, denied sign-in and CSRF verification.
The in-memory token adapter models atomic consumption; it does not prove actual
Prisma concurrency or database recovery. Application tests additionally assert
the configured lifetime, default normalizer, JWT strategy, callback host checks
and existing Secure/HttpOnly/SameSite/path/domain cookie behavior. Existing
credential/2FA/account-linking tests remain required.

These are bounded regressions, not complete OAuth endpoint, tenant-isolation or
database/rollback proof. In particular, the current redirect callback compares
hostname, not full origin; this patch does not tighten scheme/port policy. Existing
embed cookies use SameSite=None in HTTPS. Neither behavior is newly approved or
waived. Further threat review and isolated runtime/database checks remain before
merge. The immediate Auth comparison baseline is
`3c247747fce22258c6744fc140fa05c728c1b90a` (draft PR #6), not a production rollback
target. Restore both auth manifests and their lockfile through a reviewed revert
for development comparison only; the old version is vulnerable.

Foundation CI explicitly runs the Node regressions and permits this dependent
PR's exact base branch. No gate or vulnerability finding is suppressed. The whole
graph, image, Gitleaks and CodeQL gates still apply; tar/websocket remediation,
remaining security findings and prerequisite PR #5 review blockers remain open.
