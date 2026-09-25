import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { createInheritedCheck, generateBaseline, loadBaseline } from "./foundation-baseline.mjs";
import { checkNoScannerSuppression, checkReport, checkScannerStatus } from "./foundation-gates.mjs";

function sourceTree(files) {
  const root = mkdtempSync(join(tmpdir(), "scan-"));
  for (const [file, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, file)), { recursive: true });
    writeFileSync(join(root, file), text);
  }
  return root;
}
const secret = (file, StartLine, RuleID = "generic-api-key") => ({
  File: `/scan/${file}`,
  RuleID,
  StartLine,
  EndLine: StartLine,
});
const sarif = (results, score = "8.1") => ({
  runs: [
    {
      tool: {
        driver: {
          name: "CodeQL",
          rules: [
            { id: "js/risk", properties: { "security-severity": score } },
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
const osPackages = [
  { Name: "libc6", Version: "2.41", Release: "12+deb13u4" },
  { Name: "bsdutils", Version: "2.41.5", Release: "0+deb13u1", Epoch: 1 },
];
const image = (osFindings = [], nodeFindings = [], nodePackages = [{ Name: "next", Version: "16.3.5" }]) => ({
  SchemaVersion: 2,
  ArtifactType: "container_image",
  Results: [
    { Class: "os-pkgs", Type: "debian", Packages: osPackages, Vulnerabilities: osFindings },
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

const baseRoot = sourceTree({
  "docs/api.md": "# API\nKEY=example-one\nKEY=example-two\n",
  "apps/web/.env.example": "JWT=example-jwt\n",
});
const baseline = generateBaseline(
  {
    gitleaks: [secret("docs/api.md", 2), secret("docs/api.md", 3), secret("apps/web/.env.example", 1, "jwt")],
    codeql: sarif([codeql("js/risk", "apps/web/lib/url.ts"), codeql("js/minor", "apps/web/lib/low.ts")]),
    dependencies: dependencies([vuln("axios", "1.12.0", "CVE-OLD-1")]),
    image: image(
      [vuln("libc6", "2.41-12+deb13u4", "CVE-OS-1", "UNKNOWN")],
      [vuln("next", "16.3.5", "CVE-NEXT-1")]
    ),
  },
  { baseSha: "fixture" },
  checkReport,
  baseRoot
);
const sourceMerge = (kind, report, root = baseRoot) =>
  checkReport(kind, report, createInheritedCheck(kind, baseline, root));

test("the inventory contains exactly what the strict gate blocks", () => {
  assert.equal(baseline.gitleaks.findings.length, 3);
  assert.deepEqual(baseline.codeql.findings, [JSON.stringify(["js/risk", "apps/web/lib/url.ts"])]);
  for (const version of ["2.41-12+deb13u4", "1:2.41.5-0+deb13u1"]) {
    const name = version.startsWith("1:") ? "bsdutils" : "libc6";
    assert.ok(baseline.image.packages.includes(JSON.stringify(["os-pkgs:debian", name, version])));
  }
});

test("inherited findings pass source merge, even when moved, but still block publication", () => {
  const moved = sourceTree({ "docs/api.md": "# API\n\nIntro\n\nKEY=example-two\nKEY=example-one\n" });
  const secrets = [secret("docs/api.md", 5), secret("docs/api.md", 6)];
  assert.doesNotThrow(() => sourceMerge("gitleaks", secrets, moved));
  assert.throws(() => checkReport("gitleaks", secrets));
  const movedCodeql = sarif([codeql("js/risk", "apps/web/lib/url.ts", 200)]);
  assert.doesNotThrow(() => sourceMerge("codeql", movedCodeql));
  assert.throws(() => checkReport("codeql", movedCodeql));
  const inheritedImage = image([vuln("libc6", "2.41-12+deb13u4", "CVE-OS-1", "UNKNOWN")]);
  assert.doesNotThrow(() => sourceMerge("image", inheritedImage));
  assert.throws(() => checkReport("image", inheritedImage));
});

test("a new, replaced or duplicated secret blocks source merge", () => {
  assert.throws(() => sourceMerge("gitleaks", [secret("docs/api.md", 1)]), /Gitleaks/);
  const replaced = sourceTree({ "docs/api.md": "# API\nKEY=live-credential\nKEY=example-two\n" });
  assert.throws(() => sourceMerge("gitleaks", [secret("docs/api.md", 2)], replaced), /Gitleaks/);
  const duplicated = sourceTree({ "docs/api.md": "KEY=example-one\nKEY=example-one\n" });
  const twice = [secret("docs/api.md", 1), secret("docs/api.md", 2)];
  assert.throws(() => sourceMerge("gitleaks", twice, duplicated), /Gitleaks/);
  assert.throws(() => sourceMerge("gitleaks", [secret("docs/api.md", 2, "jwt")]), /Gitleaks/);
});

test("secret findings must resolve to real lines inside the scanned tree", () => {
  assert.throws(
    () => sourceMerge("gitleaks", [{ ...secret("docs/api.md", 2), File: "docs/api.md" }]),
    /outside/
  );
  assert.throws(() => sourceMerge("gitleaks", [secret("docs/api.md", 99)]), /outside the scanned file/);
  assert.throws(() => sourceMerge("gitleaks", [secret("../etc/passwd", 1)]), /Invalid scanned path/);
  assert.throws(() => sourceMerge("gitleaks", [{ ...secret("docs/api.md", 2), EndLine: 1 }]), /line range/);
  const linked = sourceTree({});
  mkdirSync(join(linked, "docs"));
  symlinkSync(join(baseRoot, "docs/api.md"), join(linked, "docs/api.md"));
  assert.throws(() => sourceMerge("gitleaks", [secret("docs/api.md", 2)], linked), /Symlinked/);
});

test("a new blocking CodeQL rule, file or instance blocks; low scores stay allowed", () => {
  assert.throws(() => sourceMerge("codeql", sarif([codeql("js/risk", "apps/web/lib/new.ts")])), /js\/risk/);
  const twice = sarif([codeql("js/risk", "apps/web/lib/url.ts"), codeql("js/risk", "apps/web/lib/url.ts")]);
  assert.throws(() => sourceMerge("codeql", twice), /js\/risk/);
  assert.doesNotThrow(() => sourceMerge("codeql", sarif([codeql("js/minor", "apps/web/lib/anywhere.ts")])));
  const invalidScore = sarif([codeql("js/risk", "apps/web/lib/url.ts")], "NaN");
  assert.throws(() => checkReport("codeql", invalidScore, () => true), /Invalid CodeQL severity/);
});

test("vulnerable versions are judged independently of report order", () => {
  const added = vuln("axios", "0.21.0", "CVE-OLD-1");
  const shipped = vuln("axios", "1.12.0", "CVE-OLD-1");
  const packages = [
    { Name: "axios", Version: "0.21.0" },
    { Name: "axios", Version: "1.12.0" },
  ];
  for (const order of [
    [added, shipped],
    [shipped, added],
  ]) {
    assert.doesNotThrow(() => sourceMerge("dependencies", dependencies(order, packages)));
  }
  const newAdvisory = vuln("axios", "0.21.0", "CVE-NEW-2");
  for (const order of [
    [newAdvisory, shipped],
    [shipped, newAdvisory],
  ]) {
    assert.throws(() => sourceMerge("dependencies", dependencies(order, packages)), /CVE-NEW-2/);
  }
});

test("a new vulnerable package version blocks; an advisory on a shipped version does not", () => {
  const bumped = dependencies([vuln("axios", "1.13.0", "CVE-NEW-2")], [{ Name: "axios", Version: "1.13.0" }]);
  assert.throws(() => sourceMerge("dependencies", bumped), /CVE-NEW-2/);
  const later = dependencies([vuln("axios", "1.12.0", "CVE-PUBLISHED-LATER", "CRITICAL")]);
  assert.doesNotThrow(() => sourceMerge("dependencies", later));
  // An upgrade that fixes some advisories but still carries an inherited one is not a regression.
  const partial = dependencies(
    [vuln("axios", "1.13.0", "CVE-OLD-1")],
    [{ Name: "axios", Version: "1.13.0" }]
  );
  assert.doesNotThrow(() => sourceMerge("dependencies", partial));
  const epochFinding = image([vuln("bsdutils", "1:2.41.5-0+deb13u1", "CVE-OS-LATER", "UNKNOWN")]);
  assert.doesNotThrow(() => sourceMerge("image", epochFinding));
  assert.throws(() => sourceMerge("image", image([], [vuln("sharp", "0.35.4", "CVE-SHARP")])), /CVE-SHARP/);
  const nodeAsOs = image([vuln("next", "16.3.5", "CVE-SCOPE")]);
  assert.throws(() => sourceMerge("image", nodeAsOs), /CVE-SCOPE/);
});

test("malformed reports and unsupported kinds still fail closed", () => {
  assert.throws(() => sourceMerge("image", { ...image(), SchemaVersion: 1 }), /identity/);
  assert.throws(() => sourceMerge("dependencies", dependencies([], [])), /Empty package inventory/);
  assert.throws(() => sourceMerge("codeql", { runs: [] }), /Missing CodeQL/);
  const badSeverity = { ...vuln("libc6", "2.41-12+deb13u4", "CVE-OS-1"), Severity: "BAD" };
  assert.throws(() => sourceMerge("image", image([badSeverity])));
  const unnamed = { Severity: "HIGH", VulnerabilityID: "CVE-X", InstalledVersion: "1" };
  assert.throws(() => sourceMerge("image", image([unnamed])), /vulnerable package/);
  assert.throws(() => createInheritedCheck("config", baseline), /No inherited inventory/);
});

test("scanner status must be exactly 0 or 1 and agree with the report", () => {
  for (const status of ["2", "", undefined, " 1", "0x1", "125"]) {
    assert.throws(() => checkScannerStatus([], status), /Invalid scanner result/);
  }
  assert.throws(() => checkScannerStatus([{}], "0"), /mismatch/);
  assert.throws(() => checkScannerStatus([], "1"), /mismatch/);
  assert.doesNotThrow(() => checkScannerStatus([], "0"));
  assert.doesNotThrow(() => checkScannerStatus([{}], "1"));
});

test("scanner configuration and inline suppressions in the scanned tree are rejected", () => {
  assert.doesNotThrow(() => checkNoScannerSuppression(baseRoot));
  assert.throws(() => checkNoScannerSuppression(sourceTree({ ".gitleaks.toml": "" })), /configuration/);
  assert.throws(() => checkNoScannerSuppression(sourceTree({ "a/.gitleaksignore": "" })), /configuration/);
  const inline = sourceTree({ "src/key.ts": 'const key = "x"; // gitleaks:allow\n' });
  assert.throws(() => checkNoScannerSuppression(inline), /Inline scanner suppression/);
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
