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

## Fail-closed boundary

Two verdicts are computed from the same validated reports (SLE-123):

- **Source merge** (enforced by these required checks) accepts only findings in
  `inherited-baseline.json`, the inventory Sierra approved in the
  [SLE-116 v0.1.1 addendum](https://linear.app/sam-thacker-studios/issue/SLE-116#comment-773bac72-ec5e-4f2a-bcc0-02d90e8ed1f7).
  It was generated from full scans of `main` `0c80ce1` and is pinned by SHA-256 in
  `scripts/foundation-baseline.mjs`. Secret identities are `(file, rule, hash of
  the flagged lines)` and CodeQL identities `(rule, file, CodeQL line hash)`,
  each counted, so a moved finding stays inherited while a replaced value, a new
  result or an extra instance blocks. Trivy identities are `(scope, package,
  advisory)`, counted across every installed version; an advisory absent from the
  inventory is inherited only on a package version already shipped at baseline. In-tree Gitleaks config, ignore files and inline allow markers
  are rejected so a PR cannot silence the scanner instead.
- **Publication** stays strict: raw high, critical and unknown image/dependency
  findings, CodeQL scores >=7 and any Gitleaks finding block. Every run records
  `publication-verdict-<kind>.json` in its evidence artifact and prints
  `<kind> publication: BLOCKED (...)`. A green Foundation CI is **not**
  publication eligibility; the SLE-119 publish job must re-run the strict gate
  before anything is signed.

Malformed reports and missing scan coverage fail both. Dockerfile configuration
findings are never inherited: HIGH, CRITICAL and UNKNOWN ones fail both verdicts.
Changing the inventory or its hash is a Sierra A2 policy decision. Today that is
enforced by review only, because checks run the PR's own gate code; SLE-127
tracks making it tamper-resistant. Lowering the inventory after a remediation
(ratchet down) is the only routine edit; regenerate it with
`node scripts/foundation-gates.mjs generate-baseline <reports...> <metadata> <source-tree>`.

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
