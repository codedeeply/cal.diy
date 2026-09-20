import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import process from "node:process";
import { pathToFileURL } from "node:url";

/** Missing or malformed evidence must not turn a security check green. */
function requireArray(value, label) {
  if (!Array.isArray(value)) throw new Error(`Missing/invalid ${label}`);
  return value;
}

/** No inherited-finding allowance is approved; raw high/critical findings remain blocking. */
function checkReport(kind, report) {
  if (kind === "gitleaks") {
    if (requireArray(report, "Gitleaks findings").length) throw new Error("Gitleaks findings require review");
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
        if (!Number.isFinite(score) || score < 0 || score >= 7 || finding.level === "error") {
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
      if (["UNKNOWN", "HIGH", "CRITICAL"].includes(finding.Severity)) {
        throw new Error(`Unapproved ${kind} finding: ${finding.VulnerabilityID ?? finding.ID}`);
      }
    }
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
  // Report-only jobs must remain usable without installing the workspace dependency graph.
  const { parseDocument } = createRequire(import.meta.url)("yaml");
  const document = parseDocument(workflow, { strict: true, uniqueKeys: true, stringKeys: true });
  if (document.errors.length || document.warnings.length || document.directives.yaml.version !== "1.2") {
    throw new Error("Invalid or ambiguous workflow YAML");
  }
  const root = document.toJS({ mapAsMap: true, maxAliasCount: 0 });
  if (!(root instanceof Map) || !root.size) throw new Error("Missing workflow mapping");
  const pending = [root];
  while (pending.length) {
    const value = pending.pop();
    if (value instanceof Map) {
      for (const [key, child] of value) {
        if (
          ["<<", "pull_request_target", "continue-on-error"].includes(key.toLowerCase()) ||
          (key.toLowerCase() === "secrets" && value !== root.get("jobs"))
        ) {
          throw new Error(`Unsafe workflow key: ${key}`);
        }
        if (
          key.toLowerCase() === "uses" &&
          (typeof child !== "string" || !/^[a-zA-Z0-9-]+\/[\w.-]+(?:\/[\w.-]+)*@[a-f0-9]{40}$/.test(child))
        ) {
          throw new Error("Actions must use an external repository and full commit SHA");
        }
        if (key.toLowerCase() === "runs-on" && child !== "ubuntu-24.04") {
          throw new Error("Bootstrap jobs require the fixed GitHub-hosted runner");
        }
        pending.push(key, child);
      }
    } else if (Array.isArray(value)) {
      pending.push(...value);
    } else if (typeof value === "string") {
      const usesSecrets = [...value.matchAll(/\$\{\{([\s\S]*?)\}\}/g)].some((match) =>
        /\bsecrets\b/i.test(match[1])
      );
      if (usesSecrets || /pull_request_target|self-hosted|secrets\./i.test(value)) {
        throw new Error("Unsafe bootstrap workflow capability");
      }
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [kind, file] = process.argv.slice(2);
  if (kind === "pins") {
    checkPins(readFileSync("Dockerfile", "utf8"), readFileSync(file, "utf8"));
  } else {
    checkReport(kind, JSON.parse(readFileSync(file, "utf8")));
  }
  console.log(`${kind}: PASS`);
}

export { checkPins, checkReport };
