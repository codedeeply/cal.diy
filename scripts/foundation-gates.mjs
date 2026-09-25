import { readFileSync } from "node:fs";
import process from "node:process";
import { pathToFileURL } from "node:url";
import { createInheritedCheck, generateBaseline, loadBaseline } from "./foundation-baseline.mjs";

/** Missing or malformed evidence must not turn a security check green. */
function requireArray(value, label) {
  if (!Array.isArray(value)) throw new Error(`Missing/invalid ${label}`);
  return value;
}

/**
 * Without `isInherited` this is the strict publication gate. Source merge passes the approved
 * inherited-finding check instead; report validation is identical in both modes.
 */
function checkReport(kind, report, isInherited = () => false) {
  if (kind === "gitleaks") {
    for (const finding of requireArray(report, "Gitleaks findings")) {
      if (!isInherited(finding)) throw new Error("Gitleaks findings require review");
    }
    return;
  }
  if (kind === "codeql") {
    const runs = requireArray(report.runs, "SARIF runs");
    if (!runs.length) throw new Error("Missing CodeQL analysis");
    for (const run of runs) {
      if (run.tool?.driver?.name !== "CodeQL") throw new Error("Unexpected SARIF producer");
      requireArray(run.tool.driver.rules, "CodeQL driver rules");
      for (const invocation of run.invocations ?? []) {
        if (invocation.executionSuccessful === false) throw new Error("CodeQL execution failed");
      }
      for (const finding of requireArray(run.results, "CodeQL results")) {
        let component = run.tool.driver;
        const extensionIndex = finding.rule?.toolComponent?.index;
        if (extensionIndex !== undefined) {
          if (!Number.isInteger(extensionIndex) || extensionIndex < 0)
            throw new Error("Invalid rule component");
          component = requireArray(run.tool.extensions, "CodeQL extensions")[extensionIndex];
        }
        const rules = requireArray(component?.rules, "CodeQL component rules");
        const ruleId = finding.ruleId ?? finding.rule?.id;
        const rule = rules.find((item) => item.id === ruleId);
        if (!rule) throw new Error("Missing CodeQL rule metadata");
        const ruleIndex = finding.ruleIndex ?? finding.rule?.index;
        if (ruleIndex !== undefined && (!Number.isInteger(ruleIndex) || rules[ruleIndex] !== rule)) {
          throw new Error("Inconsistent CodeQL rule reference");
        }
        if (finding.rule?.id !== undefined && finding.rule.id !== ruleId)
          throw new Error("Conflicting rule ID");
        const rawScore = rule.properties?.["security-severity"];
        if (typeof rawScore !== "string" || !rawScore.trim()) throw new Error("Missing CodeQL severity");
        const score = Number(rawScore);
        if (!Number.isFinite(score) || score < 0) throw new Error("Invalid CodeQL severity");
        if ((score >= 7 || finding.level === "error") && !isInherited(finding, run)) {
          throw new Error(`Unapproved CodeQL finding: ${finding.ruleId}`);
        }
      }
    }
    return;
  }
  if (!["image", "config", "dependencies"].includes(kind)) throw new Error(`Unknown report kind: ${kind}`);
  const artifactType = kind === "image" ? "container_image" : "filesystem";
  if (report.SchemaVersion !== 2 || report.ArtifactType !== artifactType) {
    throw new Error("Missing/invalid Trivy report identity");
  }
  const results = requireArray(report.Results, "Trivy results");
  const expected = {
    image: [["os-pkgs"], ["lang-pkgs", "node-pkg"]],
    config: [["config", "dockerfile"]],
    dependencies: [["lang-pkgs", "yarn"]],
  }[kind];
  for (const [scanClass, type] of expected) {
    const scan = results.find((result) => result.Class === scanClass && (!type || result.Type === type));
    if (!scan) throw new Error(`Missing ${type ?? scanClass} scan`);
    if (kind !== "config" && !requireArray(scan.Packages, "scanned packages").length) {
      throw new Error("Empty package inventory cannot prove scan coverage");
    }
  }
  for (const result of results) {
    const findings = kind === "config" ? result.Misconfigurations : result.Vulnerabilities;
    for (const finding of requireArray(findings ?? [], "Trivy findings")) {
      if (!["UNKNOWN", "LOW", "MEDIUM", "HIGH", "CRITICAL"].includes(finding.Severity)) {
        throw new Error("Missing/invalid finding severity");
      }
      if (["UNKNOWN", "HIGH", "CRITICAL"].includes(finding.Severity) && !isInherited(finding, result)) {
        throw new Error(`Unapproved ${kind} finding: ${finding.VulnerabilityID ?? finding.ID}`);
      }
    }
  }
}

/** Gitleaks exits 1 on findings; any other status, or a mismatched report, is a failed scan. */
function checkScannerStatus(report, rawStatus) {
  const status = Number(rawStatus);
  if (![0, 1].includes(status)) throw new Error("Invalid scanner result");
  if (requireArray(report, "Gitleaks findings").length > 0 !== (status === 1)) {
    throw new Error("Scanner/report status mismatch");
  }
}

/** Pin executable inputs so a passing review cannot silently select different upstream code. */
function checkPins(dockerfile, workflow) {
  const stages = new Set();
  const bases = dockerfile
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => /^FROM\s/i.test(line));
  if (!bases.length) throw new Error("Missing base-image declaration");
  for (const line of bases) {
    const match = line.match(/^FROM\s+(?:--platform=\S+\s+)?(\S+)(?:\s+AS\s+(\S+))?$/i);
    if (!match) throw new Error("Unrecognized Docker base-image declaration");
    if (!stages.has(match[1]) && !/@sha256:[a-f0-9]{64}$/.test(match[1])) {
      throw new Error(`Unpinned base image: ${match[1]}`);
    }
    if (match[2]) stages.add(match[2]);
  }
  for (const match of workflow.matchAll(/\buses\s*:\s*(\S+)/g)) {
    if (!/@[a-f0-9]{40}$/.test(match[1])) throw new Error(`Unpinned action: ${match[1]}`);
  }
  const usesSecrets = [...workflow.matchAll(/\$\{\{([\s\S]*?)\}\}/g)].some((match) =>
    /\bsecrets\b/i.test(match[1])
  );
  if (usesSecrets || /pull_request_target|self-hosted|continue-on-error\s*:|secrets\./.test(workflow)) {
    throw new Error("Unsafe bootstrap workflow capability");
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [kind, file] = process.argv.slice(2);
  const readJson = (path) => JSON.parse(readFileSync(path, "utf8"));
  if (kind === "pins") {
    checkPins(readFileSync("Dockerfile", "utf8"), readFileSync(file, "utf8"));
  } else if (kind === "generate-baseline") {
    const [gitleaks, codeql, dependencies, image, metadata] = process.argv.slice(3).map(readJson);
    const reports = { gitleaks, codeql, dependencies, image };
    process.stdout.write(`${JSON.stringify(generateBaseline(reports, metadata, checkReport), null, 1)}\n`);
    process.exit(0);
  } else if (["gitleaks", "codeql", "dependencies", "image"].includes(kind)) {
    const report = readJson(file);
    if (kind === "gitleaks") checkScannerStatus(report, process.argv[4]);
    // The strict verdict stays visible until the SLE-119 publish job enforces it.
    let publication = "PASS";
    try {
      checkReport(kind, report);
    } catch (error) {
      publication = `BLOCKED (${error.message})`;
    }
    console.log(`${kind} publication: ${publication}`);
    checkReport(kind, report, createInheritedCheck(kind, loadBaseline()));
  } else {
    checkReport(kind, readJson(file));
  }
  console.log(`${kind}: PASS`);
}

export { checkPins, checkReport };
