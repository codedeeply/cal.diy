import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const baselinePath = ".github/sle-119/inherited-baseline.json";
// Pinning the approved inventory in code makes any edit to it a reviewable gate change.
const baselineHash = "7421dda5bbbc283735e60ec38420ce2c4a4a1bf4e4ec65a106d36a3ecd4e0e43";
const kinds = ["gitleaks", "codeql", "dependencies", "image"];
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const key = (...parts) => JSON.stringify(parts);

function requireString(value, label) {
  if (typeof value !== "string" || !value) throw new Error(`Missing/invalid ${label}`);
  return value;
}

const scopeOf = (result) => `${result.Class}:${result.Type ?? ""}`;

/** Identities omit line numbers so edits near an inherited finding do not make it look new. */
function identityOf(kind, finding, context) {
  if (kind === "gitleaks") {
    const file = requireString(finding?.File, "Gitleaks file");
    if (!file.startsWith("/scan/")) throw new Error("Gitleaks file outside the scanned tree");
    return key(file.slice(6), requireString(finding.RuleID, "Gitleaks rule"));
  }
  if (kind === "codeql") {
    return key(
      requireString(finding?.ruleId ?? finding?.rule?.id, "CodeQL rule"),
      requireString(finding.locations?.[0]?.physicalLocation?.artifactLocation?.uri, "CodeQL location")
    );
  }
  return key(
    scopeOf(context),
    requireString(finding?.PkgName, "vulnerable package"),
    requireString(finding.VulnerabilityID, "vulnerability ID")
  );
}

/** Trivy reports OS package versions split into epoch/version/release but findings joined. */
function installedVersionOf(pkg) {
  const version = requireString(pkg?.Version, "package version");
  const epoch = pkg.Epoch ? `${pkg.Epoch}:` : "";
  return `${epoch}${version}${pkg.Release ? `-${pkg.Release}` : ""}`;
}

function packagesOf(report) {
  const packages = [];
  for (const result of report.Results) {
    for (const pkg of result.Packages ?? []) {
      packages.push(key(scopeOf(result), requireString(pkg?.Name, "package name"), installedVersionOf(pkg)));
    }
  }
  return packages;
}

function loadBaseline(root = ".", expectedHash = baselineHash) {
  const bytes = readFileSync(join(root, baselinePath));
  if (digest(bytes) !== expectedHash) throw new Error("Missing or changed inherited-finding inventory");
  const baseline = JSON.parse(bytes);
  for (const kind of kinds) {
    if (!Array.isArray(baseline[kind]?.findings)) throw new Error(`Incomplete inventory: ${kind}`);
  }
  return baseline;
}

/**
 * Source merge accepts only inherited findings (SLE-116 v0.1.1 addendum). Each inherited
 * identity is consumed once, so a PR cannot add another instance of an existing finding. A
 * Trivy finding on a package version already shipped at baseline is also inherited: a newly
 * published advisory then blocks publication rather than an unrelated PR.
 */
function createInheritedCheck(kind, baseline) {
  if (!kinds.includes(kind)) throw new Error(`No inherited inventory for ${kind}`);
  const remaining = new Map();
  for (const identity of baseline[kind].findings) remaining.set(identity, (remaining.get(identity) ?? 0) + 1);
  const shippedPackages = new Set(baseline[kind].packages ?? []);
  return (finding, context) => {
    const identity = identityOf(kind, finding, context);
    if (remaining.get(identity) > 0) {
      remaining.set(identity, remaining.get(identity) - 1);
      return true;
    }
    if (kind !== "dependencies" && kind !== "image") return false;
    const version = requireString(finding.InstalledVersion, "installed version");
    return shippedPackages.has(key(scopeOf(context), finding.PkgName, version));
  };
}

/**
 * `collect(kind, report, onBlocking)` must enumerate exactly the findings the strict gate
 * blocks, so the inventory can never cover more than the gate would have rejected.
 */
function generateBaseline(reports, metadata, collect) {
  const baseline = { ...metadata };
  for (const kind of kinds) {
    const findings = [];
    collect(kind, reports[kind], (finding, context) => {
      findings.push(identityOf(kind, finding, context));
      return true;
    });
    baseline[kind] = { findings: findings.sort() };
    if (kind === "dependencies" || kind === "image") {
      baseline[kind].packages = [...new Set(packagesOf(reports[kind]))].sort();
    }
  }
  return baseline;
}

export { createInheritedCheck, generateBaseline, identityOf, loadBaseline };
