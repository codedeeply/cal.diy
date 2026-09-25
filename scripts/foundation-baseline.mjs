import { createHash } from "node:crypto";
import { lstatSync, readFileSync } from "node:fs";
import { join } from "node:path";

const baselinePath = ".github/sle-119/inherited-baseline.json";
// Pinning the approved inventory in code makes any edit to it a reviewable gate change.
const baselineHash = "9fec7e33793fbd5bf0ecb54f7307652966a0e7dc3394960e8271bb96ef0b0f82";
const kinds = ["gitleaks", "codeql", "dependencies", "image"];
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const key = (...parts) => JSON.stringify(parts);

function requireString(value, label) {
  if (typeof value !== "string" || !value) throw new Error(`Missing/invalid ${label}`);
  return value;
}

const scopeOf = (result) => `${result.Class}:${result.Type ?? ""}`;

/** Reads a scanned file without following links that could point outside the tree. */
function readScannedFile(root, file) {
  let path = requireString(root, "scanned source root");
  for (const segment of file.split("/")) {
    if (!segment || segment === "." || segment === "..") throw new Error("Invalid scanned path");
    path = join(path, segment);
    if (lstatSync(path).isSymbolicLink()) throw new Error("Symlinked scanned file");
  }
  return readFileSync(path, "utf8").split("\n");
}

/**
 * Identities omit line numbers so edits near an inherited finding do not make it look new.
 * Secrets also carry a hash of the flagged lines: replacing an inherited example value with a
 * different (possibly live) one must be a new finding, while a moved line stays inherited.
 */
function identityOf(kind, finding, context) {
  if (kind === "gitleaks") {
    const file = requireString(finding?.File, "Gitleaks file");
    if (!file.startsWith("/scan/") || finding.SymlinkFile)
      throw new Error("Gitleaks file outside the scanned tree");
    const { StartLine, EndLine } = finding;
    if (!Number.isInteger(StartLine) || !Number.isInteger(EndLine) || StartLine < 1 || EndLine < StartLine) {
      throw new Error("Malformed Gitleaks line range");
    }
    const lines = context.readLines(file.slice(6));
    if (EndLine > lines.length) throw new Error("Gitleaks line range outside the scanned file");
    const flagged = digest(lines.slice(StartLine - 1, EndLine).join("\n"));
    return key(file.slice(6), requireString(finding.RuleID, "Gitleaks rule"), flagged);
  }
  if (kind === "codeql") {
    // CodeQL's content-based line hash survives edits elsewhere in the file, so a new result
    // cannot reuse the allowance of a fixed one that shares its rule and file.
    return key(
      requireString(finding?.ruleId ?? finding?.rule?.id, "CodeQL rule"),
      requireString(finding.locations?.[0]?.physicalLocation?.artifactLocation?.uri, "CodeQL location"),
      requireString(finding.partialFingerprints?.primaryLocationLineHash, "CodeQL result fingerprint")
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

function sourceReader(sourceRoot) {
  const cache = new Map();
  return (file) => {
    if (!cache.has(file)) cache.set(file, readScannedFile(sourceRoot, file));
    return cache.get(file);
  };
}

/**
 * Source merge accepts only inherited findings (SLE-116 v0.1.1 addendum). Each inherited
 * identity is consumed once, so a PR cannot add another instance of an existing finding. A
 * Trivy advisory absent from the inventory is still inherited when it affects a package version
 * already shipped at baseline: an advisory published later then blocks publication, not an
 * unrelated PR.
 */
function createInheritedCheck(kind, baseline, { sourceRoot } = {}) {
  if (!kinds.includes(kind)) throw new Error(`No inherited inventory for ${kind}`);
  const remaining = new Map();
  for (const identity of baseline[kind].findings) remaining.set(identity, (remaining.get(identity) ?? 0) + 1);
  const consume = (identity) => {
    if (!(remaining.get(identity) > 0)) return false;
    remaining.set(identity, remaining.get(identity) - 1);
    return true;
  };
  const readLines = sourceReader(sourceRoot);
  if (kind === "codeql" || kind === "gitleaks") {
    return (finding, context) => consume(identityOf(kind, finding, { ...context, readLines }));
  }
  const shippedPackages = new Set(baseline[kind].packages ?? []);
  const isShipped = (finding, result) =>
    shippedPackages.has(
      key(
        scopeOf(result),
        requireString(finding?.PkgName, "vulnerable package"),
        requireString(finding.InstalledVersion, "installed version")
      )
    );
  const inventoried = new Set(baseline[kind].findings);
  // Counting every instance of an inventoried advisory keeps the verdict independent of report
  // order and stops an added copy, of any version, from reusing an allowance.
  return (finding, result) => {
    const identity = identityOf(kind, finding, result);
    return inventoried.has(identity) ? consume(identity) : isShipped(finding, result);
  };
}

/**
 * `collect(kind, report, onBlocking)` must enumerate exactly the findings the strict gate
 * blocks, so the inventory can never cover more than the gate would have rejected.
 */
function generateBaseline(reports, metadata, collect, sourceRoot) {
  const baseline = { ...metadata };
  const readLines = sourceReader(sourceRoot);
  for (const kind of kinds) {
    const findings = [];
    collect(kind, reports[kind], (finding, context) => {
      findings.push(identityOf(kind, finding, { ...context, readLines }));
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
