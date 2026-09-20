# SLE-117: isolated platform hardening

This is a platform remediation candidate, not a production release. SLE-116 policy v0.1 applies.
Hosted Cal.com remains production. SLE-118 owns application dependency upgrades; SLE-119 owns
required PR checks, artifact signing and publication. Do not waive those gates to merge this change.

## Image boundaries

The Dockerfile pins Node 24.21.0 and Debian Bookworm image digests. The build uses the target
architecture so native modules match the final linux/amd64 image. All workspace manifests are
present for `yarn install --immutable`; the existing Yarn 4.12.0 and lockfile remain authoritative.

`runner` uses Next.js standalone output and UID 1000 (`node`). Build dependencies and package
managers are excluded. Only the Next.js server configuration, output/cache and public assets are writable for the
existing URL-substitution mechanism. OpenSSL and CA certificates are explicitly versioned
because Prisma's existing native engine requires OpenSSL in the slim base.

The exact OS package pins were resolved with `apt-cache policy` and successfully installed in
the linux/amd64 runtime-base build on 2026-09-20: OpenSSL/libssl3 `3.0.20-1~deb12u2` and
CA certificates `20250419~deb12u1`. If a repository retires these versions, the build intentionally
fails rather than silently changing its security inputs. Update pins through a reviewed PR;
do not remove them to accept arbitrary future package versions.

`maintenance` contains the existing Prisma migration and app-store seed tooling. Run it as a
separate, short-lived prerequisite against disposable data before starting the web image. Its
default command fails if migration or seed invocation fails. This target retains development
dependencies, is not a hardened serving image, and is not approved for publication or production.
The serving image no longer performs schema changes automatically at startup. No schema or
application dependency was changed by this patch.

## Local validation contract

Use Sierra's Mac and the local OrbStack context only. Use a task-specific isolated Docker network
and disposable PostgreSQL 16, with fake database/auth values; never bind production credentials.
Do not publish a registry tag or expose a public port during these checks.

1. Build both targets from one clean source revision using `--platform linux/amd64` and
   `--target runner` / `--target maintenance`. Record source SHA, Dockerfile checksum, exact
   command, build arguments without secrets, image IDs and build-tool versions.
2. Run `yarn type-check:ci --force` in the installed build environment, Biome on changed supported
   files, and `node --test scripts/check-platform-scan.test.mjs`. Run the maintenance target with
   `DATABASE_URL` and `DATABASE_DIRECT_URL` pointing only to the disposable database.
3. Start the runner against that database. Verify `process.getuid()` is 1000, architecture is
   amd64, its health check succeeds, static assets load, and URL replacement works as non-root.
   Assert package managers and build CLIs are absent. Booking proof remains SLE-122's work.
4. Generate a CycloneDX SBOM and full Trivy report for the exact final image. Keep the original
   SGY-971 report and scan timestamp; distinguish historical counts from a same-database rescan.
   Run `node scripts/check-platform-scan.mjs candidate-trivy.json baseline-trivy.json`.
5. Attach reports, checksums, commands, limitations and rollback references to SLE-117 and its
   draft PR. Require CI, CodeRabbit and the R2 deep review before merge. Local checks alone
   cannot replace the required PR checks.

The platform gate includes OS packages and bundled Go binaries. It fails on any fixable critical
platform finding or an increase in total critical platform findings, and rejects missing OS scans.
It reports application criticals separately: passing this scoped gate does not pass the complete
release security gate. Unfixable findings require documented Sierra review under the release policy.

## Baseline and rollback

The upstream application baseline is `6bc45298226f96ff79e0c070c8b2ce39727e8477`.
The pre-change downstream source is `41eb60a3cf25d01a501dac8d7216e2cb93ecde93`.
The historical scan has 76 platform critical findings (44 fixable) and 10 application critical
findings; 39 of the fixable platform findings are OS packages and five are bundled Go tools.
The baseline's runner-local image ID was
`sha256:085b4d265644f19dd19450b297bbb61e02123b10bc3864398a61aa20602ecdd8`.
It was not published, so no retrievable GHCR rollback digest exists.

For isolated source rollback, revert this bounded PR through review and rebuild the recorded
pre-change source against disposable data. The unchanged schema permits the existing migration
path; verify that claim in a rehearsal before promotion. The vulnerable baseline is not a qualified
production rollback artifact. SLE-121 must establish a safe, retrievable recovery target.

References: [Node lifecycle](https://nodejs.org/en/about/eol),
[official Node images](https://github.com/nodejs/docker-node),
[Next.js standalone output](https://nextjs.org/docs/app/api-reference/config/next-config-js/output).
