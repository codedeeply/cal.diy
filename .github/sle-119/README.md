# SLE-119: deterministic CI bootstrap

Status: draft implementation, not a release authorization. The approved policy is
[SLE-116 v0.1](https://linear.app/sam-thacker-studios/issue/SLE-116/define-the-downstream-release-policy-and-solastrasierra-authority#comment-0cda4175-3db2-4585-925d-4451e3022127).
Track acceptance and evidence on SLE-119, milestone **Deterministic Release Pipeline**.

## Checks in this PR

| Check | Required evidence |
| --- | --- |
| Foundation quality | Pinned workflow syntax, negative gate fixtures, immutable Yarn install, forced type check, changed-file Biome lint, existing unit suite |
| Foundation secrets | Redacted Gitleaks scan of the complete tracked source tree |
| Foundation CodeQL | JavaScript/TypeScript security-extended SARIF and blocking severity evaluation |
| Foundation artifact | Isolated AMD64 build, disposable database, non-root/immutable-code assertions, image ID, CycloneDX SBOM, Trivy image, full Yarn lockfile and Dockerfile reports |
| Foundation eligibility | Every preceding job succeeded; failed, missing, cancelled and skipped jobs are not eligible |

CodeRabbit remains a separate mandatory PR review. These checks must be required
in repository protection before source merge; merely adding a workflow does not
enforce protection. PR checks evaluate GitHub's synthetic merge revision. Record
both PR head and checked merge SHA; rerun after either head or base changes.

The Node test files under `scripts/` run through `node --test`, not Vitest. Biome
checks supported changed files; this does not reformat unrelated upstream files.
The existing unit-suite configuration remains unchanged. No failing test is waived.

## Fail-closed boundary

No inherited-finding inventory or security exception is approved. Raw high and
critical image/configuration findings block; unknown severities, malformed reports,
CodeQL scores >=7 and any Gitleaks finding also block. Fixability does not erase a
finding. Known application criticals therefore keep this bootstrap red. A false
positive or source-only inherited allowance needs Sierra's explicit A2 decision
and a separately reviewed, machine-readable inventory; do not weaken this gate.

Negative fixtures prove report rejection, including deliberately unsafe image,
action, secret, vulnerability and CodeQL inputs. They do not substitute for real
scanner runs or a later controlled demonstration of repository merge blocking.

The build harness uses only synthetic credentials and an isolated disposable
database. It publishes no ports, image, tag, deployment, signature or release.
It refuses existing task resources and cleans up only resources it creates.
No production or real integration credentials are available to these jobs.

## Remaining SLE-119 acceptance

This bootstrap is intentionally not the complete signed-release pipeline:

1. Obtain passing exact-revision checks and CodeRabbit; enforce repository rules
   without bypass actors, then demonstrate that deliberate failures block merge.
2. Verify Dependabot alerts/security updates and explicitly enabled fork version
   updates after the reviewed configuration lands. Dependabot only opens PRs;
   schema/auth/dependency authority still follows SLE-116. No auto-merge is configured.
3. Add a separately reviewed publication path only after candidate gates pass:
   immutable digest, provenance, SBOM binding, signing and independent verification.
4. Assemble release notes, changed-file inventory, source SHA, tested rollback
   target and fresh scans (<=24 hours). Bind all evidence to the exact artifact.
5. Retain the final evidence at least 180 days after support ends. The 90-day
   GitHub diagnostic artifacts here are not sufficient durable release evidence.

SLE-119 stays open until its complete acceptance is demonstrated. Source merge,
candidate publication and Sierra's production promotion are distinct decisions.
