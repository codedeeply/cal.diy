import { readFileSync } from "node:fs";
import process from "node:process";
import { pathToFileURL } from "node:url";

/**
 * Keep application risk visible without confusing this platform-only gate with
 * full release approval; incomplete scanner evidence must never imply safety.
 */
function summarizePlatform(report) {
  if (!Array.isArray(report.Results) || !report.Results.some((result) => result.Class === "os-pkgs")) {
    throw new Error("Trivy report must contain an OS package scan");
  }
  const summary = { critical: 0, fixableCritical: 0, applicationCritical: 0 };
  for (const result of report.Results) {
    if (!Array.isArray(result.Vulnerabilities ?? [])) {
      throw new Error("Invalid Trivy vulnerability inventory");
    }
    for (const finding of result.Vulnerabilities ?? []) {
      if (typeof finding.Severity !== "string") throw new Error("Missing vulnerability severity");
      if (finding.Severity !== "CRITICAL") continue;
      if (result.Class === "os-pkgs" || result.Type === "gobinary") {
        summary.critical++;
        if (finding.FixedVersion) summary.fixableCritical++;
      } else {
        summary.applicationCritical++;
      }
    }
  }
  return summary;
}

/**
 * Enforce remediation and non-regression together so an unfixed critical cannot
 * be accepted merely because the historical baseline was more vulnerable.
 */
function checkPlatform(candidate, baseline) {
  const current = summarizePlatform(candidate);
  const previous = summarizePlatform(baseline);
  if (current.fixableCritical !== 0) {
    throw new Error(`Platform gate failed: ${current.fixableCritical} fixable CRITICAL findings`);
  }
  if (current.critical > previous.critical) {
    throw new Error(`Platform CRITICAL count increased: ${previous.critical} -> ${current.critical}`);
  }
  return { current, previous };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [candidatePath, baselinePath] = process.argv.slice(2);
  if (!candidatePath || !baselinePath) {
    throw new Error(
      "Usage: node scripts/check-platform-scan.mjs <candidate-trivy.json> <baseline-trivy.json>"
    );
  }
  console.log(
    JSON.stringify(
      checkPlatform(
        JSON.parse(readFileSync(candidatePath, "utf8")),
        JSON.parse(readFileSync(baselinePath, "utf8"))
      ),
      null,
      2
    )
  );
}

export { checkPlatform };
