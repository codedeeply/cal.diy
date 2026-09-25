# SLE-118: bounded runtime dependency remediation

## Approved follow-up: booking authorization

Sierra separately approved the bounded booking-authorization repair and regression
tests on 2026-09-20. No schema, dependency, secret, merge or production change is
authorized by that approval:
https://linear.app/sam-thacker-studios/issue/SLE-118/upgrade-vulnerable-nextjsauthprisma-runtime-dependencies-with#comment-f92dea9e-c549-4e05-bf39-b8f85e80db8c

`BookingAccessService` previously used a local permission stub returning `true`.
This fork has no PBAC implementation: administrative access now requires a real,
accepted ADMIN/OWNER membership in the event's team or its parent organization.
The same check applies to managed events. Personal bookings require the organizer's
accepted team/org membership as well as the requester's administrative membership.
Organizer and participating-host access is preserved. An attendee, unused host-pool
member, pending invitee or unrelated organization's admin gains no access by that
status alone. No other permission service or authentication policy is changed.

The new `BookingAccessService.integration-test.ts` uses actual Prisma, repositories
and permission checks, not the old unit test's private permission mock. Its 48
cases cover team/managed/personal bookings, allowed roles, denied roles, pending
memberships on both sides, immediate revocation/demotion, UID/ID lookup, missing
bookings/organizers, legacy participating hosts and non-organization parents.
The unchanged implementation fails 22 of these cases; the repair passes all 48.

Foundation quality applies existing migrations to a fresh pinned PostgreSQL 16
service and explicitly runs the integration file with `VITEST_MODE=integration`
and `--passWithNoTests=false`. The fixture refuses any database except
`sle118_authz_test` on loopback or the task's disposable database hostname; cleanup
targets only IDs created by that run. No production credentials or network calls
are needed. Existing quality, security, review and eligibility gates are retained.

This is service-level authorization evidence, not a complete HTTP exploit test or
the general session/booking smoke harness. Those previously published local proofs
remain identified separately. The repair is a single focused dependent diff from
PR #10 (`a651b04`), not an expansion of that nearly-full CI PR or a stack rewrite.
Reverting this repair would restore the known bypass and is not a safe operational
rollback. No database-format change is involved; any rollback still needs Sierra.

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

## Third patch: archive and WebSocket transitive dependencies

The existing global `tar` resolution advances from 7.5.11 to **7.5.21**. Sierra
explicitly approved replacing the earlier 7.5.19 target after a fresh advisory
check found a remaining high-severity member-selection recursion flaw:
https://linear.app/sam-thacker-studios/issue/SLE-118/upgrade-vulnerable-nextjsauthprisma-runtime-dependencies-with#comment-36651ee2-450d-4fc3-bd64-4a6e1d36504d
https://github.com/advisories/GHSA-r292-9mhp-454m

Tar's earlier critical decompression fix starts in 7.5.19. The selected 7.5.21
also includes complete decompressor disposal on abort and bounded recursion.
Node >=18 and dependency ranges are unchanged between those target patches.
The existing major-version override is not expanded to other packages.
https://github.com/advisories/GHSA-23hp-3jrh-7fpw
https://github.com/isaacs/node-tar/compare/v7.5.19...v7.5.21

The full 7.5.11→7.5.21 series also changes symlink/hardlink protection, PAX
header handling and archive-creation error propagation. The bounded regressions
below do not claim exhaustive verification of every upstream repair:
https://github.com/isaacs/node-tar/compare/v7.5.11...v7.5.21

`yarn why -R tar` identifies node-gyp/cacache, sqlite3 (through SAML Jackson),
trigger.dev and giget consumers, with workspace/tooling paths feeding those
parents. These remain installed; no parent is replaced or removed. Regression
tests assert the whole locked tar graph and representative installed consumer
paths, normal archive creation/listing and async/sync selected extraction.

`websocket-driver` advances from 0.7.4 to **0.7.5** using the scoped resolution
`faye-websocket/websocket-driver`, satisfying its existing `>=0.5.1` range. The
observed path is Salesforce → jsforce 3.10.10 → Faye 1.4.0 → faye-websocket
0.11.4 → websocket-driver. No real Salesforce connection is made. Tests resolve
the driver through that actual installed parent chain rather than a new direct
dependency. Both legacy length-header bounds and post-extension message-size
checks are exercised, alongside ordinary text/binary/ping behavior.
https://github.com/advisories/GHSA-xv26-6w52-cph6
https://github.com/faye/websocket-driver-node/releases/tag/0.7.5

`scripts/transitive-security-regression.test.mjs` runs explicitly in Foundation
CI. Decompression uses an eight-MiB memory-only payload; long-path archives stay
under 32 KiB and run in time/memory-bounded child processes. Filesystem fixtures
are unique disposable directories; WebSocket transports are in-memory streams.
These tests must fail on the vulnerable comparison versions and pass on the
approved graph. No real integration, oversized disk workload or production
resource is involved.

Compatibility cautions: tar now rejects compressed input over its default
1000:1 expansion ratio. Member selection caps ancestor recursion at 100 levels,
so exceptionally deep selections may be skipped. Do not disable either guard
to accommodate an archive without a new security decision. Library fixes do
not impose a universal archive disk/entry quota or application payload policy.
Full isolated builds, runtime/recovery proof and all whole-tree/image gates
remain required; these bounded tests alone do not complete SLE-118.

The immediate comparison baseline is Auth PR #8 head
`9d9fe18272d257e73ce378cd4f37d9abb322adef`. A reviewed development revert restores
the previous root resolutions and lockfile; the old vulnerable graph is not an
approved production rollback target. Schema, auth behavior and migrations stay
unchanged. Keep this dependent PR draft until genuinely review-ready; Sierra's
R1 merge approval is still mandatory.
