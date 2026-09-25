/**
 * SLE-116 D2 publication thresholds, confirmed by Sierra on 2026-09-25 ("policy as written"):
 * fixable CRITICAL findings, CodeQL security-severity >= 9.0 and undispositioned secrets block a
 * release. HIGH, MEDIUM and UNKNOWN findings are published as residual risk (burned down in
 * SLE-126). No residual-critical approval exists yet, so an unfixable CRITICAL also blocks;
 * adding one is a Sierra A2 policy change, not an edit to this evaluator.
 */
const codeqlSeverity = (score) => {
  if (score >= 9) return "CRITICAL";
  if (score >= 7) return "HIGH";
  if (score >= 4) return "MEDIUM";
  return "LOW";
};

/**
 * `checkReport` is injected to reuse the gate's report validation without an import cycle.
 * Malformed reports and missing scan coverage still throw, which the caller treats as blocked.
 */
function evaluatePublication(kind, report, checkReport) {
  if (kind === "config") {
    // Dockerfile misconfigurations are never residual risk: any HIGH or worse still throws.
    checkReport(kind, report);
    return { kind, eligible: true, counts: {}, blocking: [] };
  }
  if (!["codeql", "dependencies", "image"].includes(kind)) throw new Error(`Unknown report kind: ${kind}`);
  const counts = {};
  const blocking = [];
  checkReport(kind, report, (finding, _scope, score) => {
    const severity = kind === "codeql" ? codeqlSeverity(score) : finding.Severity;
    counts[severity] = (counts[severity] ?? 0) + 1;
    if (severity === "CRITICAL") {
      blocking.push(
        kind === "codeql"
          ? (finding.ruleId ?? finding.rule?.id)
          : `${finding.VulnerabilityID} (${finding.PkgName}, fix: ${finding.FixedVersion || "none"})`
      );
    }
    return true;
  });
  return { kind, eligible: blocking.length === 0, counts, blocking };
}

const labels = {
  gitleaks: "Secrets (Gitleaks)",
  codeql: "Source (CodeQL)",
  dependencies: "Dependencies (Trivy, yarn.lock)",
  image: "Image (Trivy)",
  config: "Dockerfile (Trivy config)",
};

function renderReleaseNotes({ version, sourceSha, image, digest, ciRun, sbomSha256, verdicts }) {
  for (const [name, value] of Object.entries({ version, sourceSha, image, digest, ciRun, sbomSha256 })) {
    if (typeof value !== "string" || !value) throw new Error(`Missing release field: ${name}`);
  }
  if (!/^sha256:[a-f0-9]{64}$/.test(digest)) throw new Error("Invalid image digest");
  const blocked = verdicts.filter((verdict) => !verdict.eligible);
  if (blocked.length)
    throw new Error(`Release notes require eligible verdicts: ${blocked.map((v) => v.kind)}`);
  const rows = verdicts.map((verdict) => {
    const counts = Object.entries(verdict.counts ?? {})
      .map(([severity, count]) => `${severity} ${count}`)
      .join(", ");
    return `| ${labels[verdict.kind] ?? verdict.kind} | PASS | ${counts || "none"} |`;
  });
  return `# ${version}

- Source: \`${sourceSha}\`
- Image: \`${image}@${digest}\`
- Foundation CI evidence: ${ciRun}
- CycloneDX SBOM SHA-256: \`${sbomSha256}\` (attached to the image as a GitHub SBOM attestation)
- Signature and SLSA provenance: keyless Sigstore, issued to \`.github/workflows/foundation-publish.yml\` on \`refs/heads/main\`

## Publication gate (SLE-116 D2)

| Scan | Verdict | Residual findings |
| --- | --- | --- |
${rows.join("\n")}

Residual findings are below the publication threshold and are tracked for burn-down in SLE-126.
Secret counts cover only the approved non-credential dispositions; Trivy counts cover HIGH and
UNKNOWN advisories and CodeQL counts cover scores of 7.0 or more.

## Verify

\`\`\`sh
cosign verify ${image}@${digest} \\
  --certificate-identity https://github.com/codedeeply/cal.diy/.github/workflows/foundation-publish.yml@refs/heads/main \\
  --certificate-oidc-issuer https://token.actions.githubusercontent.com
gh attestation verify oci://${image}@${digest} --repo codedeeply/cal.diy
gh attestation verify oci://${image}@${digest} --repo codedeeply/cal.diy --predicate-type https://cyclonedx.org/bom
\`\`\`
`;
}

export { codeqlSeverity, evaluatePublication, renderReleaseNotes };
