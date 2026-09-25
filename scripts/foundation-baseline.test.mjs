import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createInheritedCheck, generateBaseline, loadBaseline } from "./foundation-baseline.mjs";
import { checkReport } from "./foundation-gates.mjs";

const secret = (file, RuleID = "generic-api-key", StartLine = 1) => ({
  File: `/scan/${file}`,
  RuleID,
  StartLine,
});
const sarif = (results) => ({
  runs: [
    {
      tool: {
        driver: {
          name: "CodeQL",
          rules: [
            { id: "js/risk", properties: { "security-severity": "8.1" } },
            { id: "js/minor", properties: { "security-severity": "3.0" } },
          ],
        },
      },
      results,
    },
  ],
});
const codeql = (ruleId, uri, startLine = 1) => ({
  ruleId,
  locations: [{ physicalLocation: { artifactLocation: { uri }, region: { startLine } } }],
});
const osPackage = { Name: "libc6", Version: "2.41", Release: "12+deb13u4" };
const image = (osFindings = [], nodeFindings = [], nodePackages = [{ Name: "next", Version: "16.3.5" }]) => ({
  SchemaVersion: 2,
  ArtifactType: "container_image",
  Results: [
    { Class: "os-pkgs", Type: "debian", Packages: [osPackage], Vulnerabilities: osFindings },
    { Class: "lang-pkgs", Type: "node-pkg", Packages: nodePackages, Vulnerabilities: nodeFindings },
  ],
});
const vuln = (PkgName, InstalledVersion, VulnerabilityID, Severity = "HIGH") => ({
  PkgName,
  InstalledVersion,
  VulnerabilityID,
  Severity,
});
const dependencies = (findings, packages = [{ Name: "axios", Version: "1.12.0" }]) => ({
  SchemaVersion: 2,
  ArtifactType: "filesystem",
  Results: [{ Class: "lang-pkgs", Type: "yarn", Packages: packages, Vulnerabilities: findings }],
});

const baseline = generateBaseline(
  {
    gitleaks: [secret("docs/api.md"), secret("docs/api.md"), secret("apps/web/.env.example", "jwt")],
    codeql: sarif([codeql("js/risk", "apps/web/lib/url.ts"), codeql("js/minor", "apps/web/lib/low.ts")]),
    dependencies: dependencies([vuln("axios", "1.12.0", "CVE-OLD-1")]),
    image: image(
      [vuln("libc6", "2.41-12+deb13u4", "CVE-OS-1", "UNKNOWN")],
      [vuln("next", "16.3.5", "CVE-NEXT-1")]
    ),
  },
  { baseSha: "fixture" },
  checkReport
);
const sourceMerge = (kind, report) => checkReport(kind, report, createInheritedCheck(kind, baseline));

test("the inventory contains exactly what the strict gate blocks", () => {
  assert.equal(baseline.gitleaks.findings.length, 3);
  assert.deepEqual(baseline.codeql.findings, [JSON.stringify(["js/risk", "apps/web/lib/url.ts"])]);
  assert.ok(baseline.image.packages.includes(JSON.stringify(["os-pkgs:debian", "libc6", "2.41-12+deb13u4"])));
});

test("inherited findings pass source merge but still block publication", () => {
  const secrets = [secret("docs/api.md", undefined, 9), secret("docs/api.md", undefined, 30)];
  sourceMerge("gitleaks", secrets);
  assert.throws(() => checkReport("gitleaks", secrets));
  const moved = sarif([codeql("js/risk", "apps/web/lib/url.ts", 200)]);
  sourceMerge("codeql", moved);
  assert.throws(() => checkReport("codeql", moved));
  const inheritedImage = image([vuln("libc6", "2.41-12+deb13u4", "CVE-OS-1", "UNKNOWN")]);
  sourceMerge("image", inheritedImage);
  assert.throws(() => checkReport("image", inheritedImage));
});

test("a new secret, or another instance of an inherited one, blocks source merge", () => {
  assert.throws(() => sourceMerge("gitleaks", [secret("apps/web/new.ts")]), /Gitleaks/);
  assert.throws(() => sourceMerge("gitleaks", [secret("docs/api.md", "jwt")]), /Gitleaks/);
  const tooMany = [secret("docs/api.md"), secret("docs/api.md"), secret("docs/api.md")];
  assert.throws(() => sourceMerge("gitleaks", tooMany), /Gitleaks/);
  assert.throws(() => sourceMerge("gitleaks", [{ File: "docs/api.md", RuleID: "x" }]), /outside/);
});

test("a new blocking CodeQL rule or file blocks source merge; low scores stay allowed", () => {
  assert.throws(() => sourceMerge("codeql", sarif([codeql("js/risk", "apps/web/lib/new.ts")])), /js\/risk/);
  const twice = sarif([codeql("js/risk", "apps/web/lib/url.ts"), codeql("js/risk", "apps/web/lib/url.ts")]);
  assert.throws(() => sourceMerge("codeql", twice), /js\/risk/);
  sourceMerge("codeql", sarif([codeql("js/minor", "apps/web/lib/anywhere.ts")]));
});

test("a new vulnerable package version blocks; an advisory on a shipped version does not", () => {
  const bumped = dependencies([vuln("axios", "1.13.0", "CVE-NEW-2")], [{ Name: "axios", Version: "1.13.0" }]);
  assert.throws(() => sourceMerge("dependencies", bumped), /CVE-NEW-2/);
  sourceMerge("dependencies", dependencies([vuln("axios", "1.12.0", "CVE-PUBLISHED-LATER", "CRITICAL")]));
  // An upgrade that fixes some advisories but still carries an inherited one is not a regression.
  sourceMerge(
    "dependencies",
    dependencies([vuln("axios", "1.13.0", "CVE-OLD-1")], [{ Name: "axios", Version: "1.13.0" }])
  );
  sourceMerge("image", image([vuln("libc6", "2.41-12+deb13u4", "CVE-OS-LATER", "UNKNOWN")]));
  assert.throws(() => sourceMerge("image", image([], [vuln("sharp", "0.35.4", "CVE-SHARP")])), /CVE-SHARP/);
  const nodeAsOs = image([vuln("next", "16.3.5", "CVE-SCOPE")]);
  assert.throws(() => sourceMerge("image", nodeAsOs), /CVE-SCOPE/);
});

test("malformed reports and configuration findings still fail closed", () => {
  assert.throws(() => sourceMerge("image", { ...image(), SchemaVersion: 1 }), /identity/);
  assert.throws(() => sourceMerge("dependencies", dependencies([], [])), /Empty package inventory/);
  assert.throws(() => sourceMerge("codeql", { runs: [] }), /Missing CodeQL/);
  assert.throws(() =>
    sourceMerge("image", image([{ ...vuln("libc6", "2.41-12+deb13u4", "CVE-OS-1"), Severity: "BAD" }]))
  );
  assert.throws(
    () => sourceMerge("image", image([{ Severity: "HIGH", VulnerabilityID: "CVE-X" }])),
    /vulnerable package/
  );
  assert.throws(() => createInheritedCheck("config", baseline), /No inherited inventory/);
});

test("the pinned inventory rejects edits, missing files and incomplete sections", () => {
  const root = mkdtempSync(join(tmpdir(), "baseline-"));
  mkdirSync(join(root, ".github/sle-119"), { recursive: true });
  const path = join(root, ".github/sle-119/inherited-baseline.json");
  assert.throws(() => loadBaseline(root, "0".repeat(64)));
  const bytes = JSON.stringify(baseline);
  writeFileSync(path, bytes);
  const hash = createHash("sha256").update(bytes).digest("hex");
  assert.equal(loadBaseline(root, hash).baseSha, "fixture");
  writeFileSync(path, bytes.replace("fixture", "edited"));
  assert.throws(() => loadBaseline(root, hash), /changed/);
  const incomplete = JSON.stringify({ ...baseline, codeql: {} });
  writeFileSync(path, incomplete);
  assert.throws(
    () => loadBaseline(root, createHash("sha256").update(incomplete).digest("hex")),
    /Incomplete/
  );
});

test("the committed inventory matches its pinned hash", () => {
  const committed = loadBaseline();
  assert.equal(committed.baseSha, "0c80ce1adc95d1bdd48ab47af487db0023c38316");
  assert.ok(readFileSync(".github/sle-119/inherited-baseline.json", "utf8").endsWith("\n"));
});
