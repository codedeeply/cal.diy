import { createHash } from "node:crypto";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";
import { createInheritedCheck, generateBaseline, loadBaseline } from "./foundation-baseline.mjs";
import { evaluatePublication, renderReleaseNotes } from "./foundation-publication.mjs";
import { evaluateGitleaks } from "./foundation-secret-dispositions.mjs";

/** Missing or malformed evidence must not turn a security check green. */
function requireArray(value, label) {
  if (!Array.isArray(value)) throw new Error(`Missing/invalid ${label}`);
  return value;
}

/**
 * Without `isInherited` this is the strict publication gate. Source merge passes the approved
 * inherited-finding check instead; report validation is identical in both modes, and neither
 * infers an approval from a finding's own fields.
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
        if ((score >= 7 || finding.level === "error") && !isInherited(finding, run, score)) {
          throw new Error(`Unapproved CodeQL finding: ${ruleId}`);
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

/** Unfiltered PR events keep required checks present for future stack bases. */
function checkWorkflowEvents(root) {
  const events = root.get("on");
  if (
    !(events instanceof Map) ||
    events.size !== 3 ||
    ["pull_request", "push", "workflow_dispatch"].some((event) => !events.has(event))
  ) {
    throw new Error("Expected only the required Foundation events");
  }
  const pullRequest = events.get("pull_request");
  if (pullRequest !== null && (!(pullRequest instanceof Map) || pullRequest.size !== 0)) {
    throw new Error("Pull requests must be unfiltered for every target branch and default activity");
  }
  const push = events.get("push");
  if (
    !(push instanceof Map) ||
    push.size !== 1 ||
    !Array.isArray(push.get("branches")) ||
    push.get("branches").length !== 1 ||
    push.get("branches")[0] !== "main"
  ) {
    throw new Error("Push must remain limited to main");
  }
  const dispatch = events.get("workflow_dispatch");
  if (dispatch !== null && (!(dispatch instanceof Map) || dispatch.size !== 0)) {
    throw new Error("Workflow dispatch must remain unfiltered");
  }
}

/** Explicit scopes prevent inherited token grants and conditional gate skipping. */
function checkWorkflowScopes(root) {
  const jobs = root.get("jobs");
  const requiredJobs = ["quality", "secrets", "codeql", "artifact", "eligibility"];
  if (
    !(jobs instanceof Map) ||
    jobs.size !== requiredJobs.length ||
    requiredJobs.some((id) => !jobs.has(id))
  ) {
    throw new Error("Expected exactly the five Foundation jobs");
  }
  const permissionScopes = new Set([root]);
  const conditionScopes = new Set();
  const checkPermissions = (value, expected) => {
    if (
      !(value instanceof Map) ||
      value.size !== expected.length ||
      expected.some(([key, grant]) => value.get(key) !== grant)
    ) {
      throw new Error("Unapproved workflow permissions");
    }
  };
  checkPermissions(root.get("permissions"), [["contents", "read"]]);
  for (const [id, job] of jobs) {
    if (!(job instanceof Map)) throw new Error("Invalid Foundation job");
    permissionScopes.add(job);
    if (id === "codeql") {
      checkPermissions(job.get("permissions"), [
        ["contents", "read"],
        ["security-events", "write"],
      ]);
    } else if (job.has("permissions")) {
      checkPermissions(job.get("permissions"), [["contents", "read"]]);
    }
    if (id === "eligibility") {
      if (job.get("if") !== "always()") throw new Error("Eligibility must always evaluate dependencies");
      conditionScopes.add(job);
    }
    const steps = requireArray(job.get("steps"), "Foundation steps");
    if (!steps.length) throw new Error("Empty Foundation job");
    for (const step of steps) {
      if (!(step instanceof Map)) throw new Error("Invalid Foundation step");
      // Diagnostic uploads must still run after a scan fails; executable gates may not be conditional.
      if (
        step.get("uses") === "actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02" &&
        !step.has("run")
      ) {
        if (step.get("if") !== "always()") throw new Error("Evidence upload must always run");
        conditionScopes.add(step);
      }
    }
  }
  const pending = [root];
  while (pending.length) {
    const value = pending.pop();
    if (value instanceof Map) {
      if (value.has("permissions") && !permissionScopes.has(value))
        throw new Error("Invalid permissions scope");
      if (value.has("if") && !conditionScopes.has(value))
        throw new Error("Conditional Foundation execution is forbidden");
      pending.push(...value.values());
    } else if (Array.isArray(value)) pending.push(...value);
  }
}

const toolPins = ["POSTGRES_IMAGE", "TRIVY_IMAGE", "SYFT_IMAGE", "BUILDKIT_IMAGE"];
// Pins every step, order, env, `needs` and concurrency setting: the structural checks below explain
// the intent, but reordering a push before its gate would otherwise pass them.
const publishWorkflowHash = "5051093bb652463b82460911d47dc77905aa901e77830f5eea41432034a4a65b";

/** Formatting- and comment-independent form of a parsed workflow, for pinning. */
function canonicalWorkflow(value) {
  if (value instanceof Map) {
    return Object.fromEntries(
      [...value].sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, v]) => [k, canonicalWorkflow(v)])
    );
  }
  if (Array.isArray(value)) return value.map(canonicalWorkflow);
  return value;
}

function publishWorkflowDigest(root) {
  return createHash("sha256")
    .update(JSON.stringify(canonicalWorkflow(root)))
    .digest("hex");
}

function imageStepPins(root, jobId) {
  const steps = requireArray(root.get("jobs")?.get(jobId)?.get("steps"), "image build steps");
  const step = steps.find(
    (item) => item instanceof Map && item.get("run") === "bash scripts/foundation-image.sh"
  );
  if (!(step?.get("env") instanceof Map)) throw new Error("Missing image build step");
  return toolPins.map((name) => step.get("env").get(name));
}

/**
 * The publish workflow is the only one allowed to write packages and mint OIDC tokens, so it
 * may run only on manual dispatch, with exactly these grants, and must scan with the same tool
 * images the required checks use.
 */
function checkPublishWorkflow(workflow, ciWorkflow) {
  const root = parseWorkflow(workflow);
  checkWorkflowSafety(root);
  const events = root.get("on");
  const inputs = events instanceof Map ? events.get("workflow_dispatch")?.get("inputs") : undefined;
  if (!(events instanceof Map) || events.size !== 1 || !(inputs instanceof Map) || inputs.size !== 1) {
    throw new Error("Publishing must be a manual dispatch with only a version input");
  }
  if (!inputs.has("version")) throw new Error("Publishing requires a version input");
  const grants = (value) => (value instanceof Map ? JSON.stringify([...value].sort()) : "");
  const expected = {
    publish: [
      ["actions", "read"],
      ["attestations", "write"],
      ["contents", "read"],
      ["id-token", "write"],
      ["packages", "write"],
    ],
    verify: [
      ["attestations", "read"],
      ["contents", "read"],
      ["packages", "read"],
    ],
  };
  if (grants(root.get("permissions")) !== JSON.stringify([["contents", "read"]])) {
    throw new Error("Unapproved workflow permissions");
  }
  const jobs = root.get("jobs");
  if (!(jobs instanceof Map) || jobs.size !== 2 || Object.keys(expected).some((id) => !jobs.has(id))) {
    throw new Error("Expected exactly the publish and verify jobs");
  }
  const conditions = new Set();
  for (const [id, job] of jobs) {
    if (grants(job.get("permissions")) !== JSON.stringify(expected[id])) {
      throw new Error("Unapproved workflow permissions");
    }
    for (const step of requireArray(job.get("steps"), "publish steps")) {
      // Expressions expand inside the shell script itself; inputs must arrive through `env`.
      if (step instanceof Map && typeof step.get("run") === "string" && step.get("run").includes("${{")) {
        throw new Error("Expressions in publish run scripts are forbidden");
      }
      if (
        step instanceof Map &&
        step.get("uses") === "actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02" &&
        step.get("if") === "always()"
      ) {
        conditions.add(step);
      }
    }
  }
  const pending = [root];
  while (pending.length) {
    const value = pending.pop();
    if (value instanceof Map) {
      if (value.has("if") && !conditions.has(value)) throw new Error("Conditional publishing is forbidden");
      pending.push(...value.values());
    } else if (Array.isArray(value)) pending.push(...value);
  }
  const ciPins = JSON.stringify(imageStepPins(parseWorkflow(ciWorkflow), "artifact"));
  if (JSON.stringify(imageStepPins(root, "publish")) !== ciPins) {
    throw new Error("Publish tool images must match the required checks");
  }
  if (publishWorkflowDigest(root) !== publishWorkflowHash) {
    throw new Error("Publish workflow differs from the reviewed pin; update the pin in the same PR");
  }
}

/** Gitleaks exits 1 on findings; any other status, or a mismatched report, is a failed scan. */
function checkScannerStatus(report, rawStatus) {
  if (!["0", "1"].includes(rawStatus)) throw new Error("Invalid scanner result");
  if (requireArray(report, "Gitleaks findings").length > 0 !== (rawStatus === "1")) {
    throw new Error("Scanner/report status mismatch");
  }
}

/**
 * Gitleaks honours config, ignore files and inline allow markers from the scanned tree, so a
 * PR could otherwise silence a new secret without touching the approved inventory.
 */
function checkNoScannerSuppression(root) {
  // Built at runtime so this gate's own source does not contain the marker it rejects.
  const allowMarker = ["gitleaks", "allow"].join(":");
  for (const entry of readdirSync(root, { recursive: true, withFileTypes: true })) {
    // Names are checked before type: Gitleaks follows a symlinked config file.
    if ([".gitleaks.toml", ".gitleaksignore"].includes(entry.name)) {
      throw new Error("Scanner configuration in the scanned tree");
    }
    if (!entry.isFile()) continue;
    if (readFileSync(join(entry.parentPath, entry.name)).includes(allowMarker)) {
      throw new Error("Inline scanner suppression in the scanned tree");
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
  const root = parseWorkflow(workflow);
  checkWorkflowSafety(root);
  checkWorkflowEvents(root);
  checkWorkflowScopes(root);
}

function parseWorkflow(workflow) {
  // Report-only jobs must remain usable without installing the workspace dependency graph.
  const { parseDocument } = createRequire(import.meta.url)("yaml");
  const document = parseDocument(workflow, { strict: true, uniqueKeys: true, stringKeys: true });
  if (document.errors.length || document.warnings.length || document.directives.yaml.version !== "1.2") {
    throw new Error("Invalid or ambiguous workflow YAML");
  }
  const root = document.toJS({ mapAsMap: true, maxAliasCount: 0 });
  if (!(root instanceof Map) || !root.size) throw new Error("Missing workflow mapping");
  return root;
}

function checkWorkflowSafety(root) {
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

/** Evaluates one report against the SLE-116 D2 publication thresholds. */
function publicationVerdict(kind, report, gitleaksStatus, sourceRoot, log = () => {}) {
  try {
    if (kind !== "gitleaks") return evaluatePublication(kind, report, checkReport);
    checkScannerStatus(report, gitleaksStatus);
    checkNoScannerSuppression(sourceRoot);
    // Publication honours only the 167 exact-source non-credential dispositions Sierra approved.
    const secrets = evaluateGitleaks(report, Number(gitleaksStatus), sourceRoot);
    log(JSON.stringify(secrets));
    return {
      kind,
      eligible: secrets.blocking === 0,
      counts: { dispositioned: secrets.dispositioned },
      blocking: secrets.blocking ? [`${secrets.blocking} undispositioned Gitleaks findings`] : [],
    };
  } catch (error) {
    return { kind, eligible: false, counts: {}, blocking: [error.message] };
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [kind, file] = process.argv.slice(2);
  const readJson = (path) => JSON.parse(readFileSync(path, "utf8"));
  if (kind === "pins") {
    checkPins(readFileSync("Dockerfile", "utf8"), readFileSync(file, "utf8"));
  } else if (kind === "publish-policy") {
    checkPublishWorkflow(readFileSync(file, "utf8"), readFileSync(process.argv[4], "utf8"));
  } else if (kind === "generate-baseline") {
    const [gitleaks, codeql, dependencies, image, metadata] = process.argv.slice(3, 8).map(readJson);
    const reports = { gitleaks, codeql, dependencies, image };
    const baseline = generateBaseline(reports, metadata, checkReport, process.argv[8]);
    process.stdout.write(`${JSON.stringify(baseline, null, 2)}\n`);
    process.exit(0);
  } else if (kind === "publication") {
    // The publish job's gate: `publication <kind> <report> [gitleaks-status source-root]`.
    const [reportKind, reportFile, gitleaksStatus, sourceRoot] = process.argv.slice(3);
    const verdict = publicationVerdict(reportKind, readJson(reportFile), gitleaksStatus, sourceRoot);
    process.stdout.write(`${JSON.stringify(verdict)}\n`);
    process.exit(verdict.eligible ? 0 : 1);
  } else if (kind === "release-notes") {
    // `release-notes <verdict-dir>`; release identity comes from the publish job environment.
    const { VERSION, GITHUB_SHA, IMAGE_REPO, DIGEST, CI_RUN, SBOM_SHA256 } = process.env;
    const kinds = ["gitleaks", "codeql", "dependencies", "image", "config"];
    const verdicts = kinds.map((reportKind) => readJson(join(file, `${reportKind}.json`)));
    process.stdout.write(
      renderReleaseNotes({
        version: VERSION,
        sourceSha: GITHUB_SHA,
        image: IMAGE_REPO,
        digest: DIGEST,
        ciRun: CI_RUN,
        sbomSha256: SBOM_SHA256,
        verdicts,
      })
    );
    process.exit(0);
  } else if (["gitleaks", "codeql", "dependencies", "image"].includes(kind)) {
    const report = readJson(file);
    const sourceRoot = process.argv[5];
    if (kind === "gitleaks") {
      checkScannerStatus(report, process.argv[4]);
      checkNoScannerSuppression(sourceRoot);
    }
    // A green source-merge check is not publication eligibility; the publish job re-runs the
    // publication gate, and this evidence records its verdict for every run.
    const publication = publicationVerdict(kind, report, process.argv[4], sourceRoot, console.log);
    writeFileSync(
      join(dirname(file), `publication-verdict-${kind}.json`),
      `${JSON.stringify(publication)}\n`
    );
    console.log(
      `${kind} publication: ${publication.eligible ? "PASS" : `BLOCKED (${publication.blocking.join("; ")})`}`
    );
    checkReport(kind, report, createInheritedCheck(kind, loadBaseline(), { sourceRoot }));
  } else {
    checkReport(kind, readJson(file));
  }
  console.log(`${kind}: PASS`);
}

export {
  checkNoScannerSuppression,
  checkPins,
  checkPublishWorkflow,
  parseWorkflow,
  publishWorkflowDigest,
  checkReport,
  checkScannerStatus,
};
