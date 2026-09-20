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
The existing unit-suite configuration remains unchanged, including standard per-file
isolation. Disabling isolation contaminates shared mocks. No failing test is waived.

Embed asset copying uses Node's built-in recursive copy rather than downloading
undeclared `shx` through `npx` during the build. A regression fixture exercises the
actual manifest command, nested assets, preserved declarations, repeated copying
and failure on missing input. No package or lockfile change is required.

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

Workflow validation uses Sierra-approved `yaml` 2.9.1 as a CI-only development
dependency. It checks decoded keys and values, requires SHA-pinned external
actions and the literal `ubuntu-24.04` runner, and rejects privileged events,
secret access, continue-on-error, aliases, merge keys, duplicate keys, unsupported
YAML versions, parse warnings and malformed documents. Actionlint independently
checks workflow syntax. Report-only scan evaluation does not load the YAML parser.

The parser fix is reviewed in a dependent draft PR targeting the CI bootstrap
branch. The workflow includes that exact PR base so the dependent revision gets
real checks. Neither PR is merge eligible while required checks or reviews fail;
the additional branch trigger is not a gate exception or a publication trigger.

The build harness uses only synthetic credentials and an isolated disposable
database. It publishes no ports, image, tag, deployment, signature or release.
It refuses existing task resources and cleans up only resources it creates.
No production or real integration credentials are available to these jobs.

## Permission hardening and unresolved trusted enforcement

The follow-up validator requires exactly the five Foundation jobs, root
`contents: read`, and exactly `contents: read` plus `security-events: write`
for CodeQL. Other jobs inherit the root grant or explicitly set only
`contents: read`. All other permission mappings, scalar shorthands and invalid
scopes are rejected. This does not change the workflow's actual token grants.

Workflow, ordinary job and executable-step conditions are rejected. The only
allowed conditions are the existing literal `always()` on eligibility and the
pinned diagnostic artifact uploads. Those conditions are mandatory: failed
scans must retain evidence, and failed dependencies must still be evaluated.
No security threshold, scanner disposition or dependency changes here.

**This is defense in depth, not tamper-resistant merge enforcement.** A PR still
controls the workflow and validator. The regression suite deliberately records
that removing the validator invocation is not detected by its own local check.
CodeRabbit's trusted-enforcement finding therefore remains open:
https://github.com/codedeeply/cal.diy/pull/5#discussion_r4057260938

On 2026-09-20, repository readback showed a public personal repository and
Foundation required-check contexts bound to GitHub Actions app 15368. That binds
the producer app, not the workflow path or trusted source revision. Adding a
same-app `pull_request_target` check alone is not a demonstrated fix. PR content
must never be executed in a privileged trusted-policy job.

### Sierra decision required before deploying trusted enforcement

Proposed routes (neither is approved or deployed):

1. Keep the current owner and use a separately authenticated policy-check App,
   with credentials unavailable to PR jobs and policy hosted outside PR control.
   Define hosting, credential custody, exact least-privilege permissions, recovery
   and monthly maintenance cost before requesting installation authority.
2. If Sierra separately chooses organization ownership and an eligible plan,
   evaluate organization-required workflows pinned to protected policy source.
   Do not transfer the repository or change billing to obtain this capability.

The trusted evaluator must read exact-head/merge workflow and relevant policy
inputs as bounded data; execute only approved immutable policy; reject missing
or replaced validation, unauthorized permissions, new executable workflows,
and conditional gate skipping; bind the verdict to the exact candidate and
trusted policy revision; and require fresh evaluation after either changes.
An App route must bind the required check to that distinct App identity.
Missing, stale or unavailable trusted evidence must block, not waive, merge.
Bootstrap must use reviewed PRs and preserve all existing required checks.

Before closing the finding, demonstrate that a PR removing validation, editing
the validator or adding a same-name passing check still cannot merge. Do not
perform a merge attempt or enable a privileged event as an unapproved probe.
All current draft/security/signing/recovery restrictions remain in effect.

GitHub documentation reviewed for this design boundary:
- https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/available-rules-for-rulesets
- https://docs.github.com/en/enterprise-cloud@latest/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/available-rules-for-rulesets#require-workflows-to-pass-before-merging
- https://docs.github.com/en/actions/reference/security/securely-using-pull_request_target

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
