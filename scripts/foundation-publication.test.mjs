import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { parse, stringify } from "yaml";
import { checkPublishWorkflow, checkReport } from "./foundation-gates.mjs";
import { evaluatePublication, renderReleaseNotes } from "./foundation-publication.mjs";

const publishWorkflow = readFileSync(".github/workflows/foundation-publish.yml", "utf8");
const ciWorkflow = readFileSync(".github/workflows/foundation-ci.yml", "utf8");

const image = (findings = []) => ({
  SchemaVersion: 2,
  ArtifactType: "container_image",
  Results: [
    { Class: "os-pkgs", Packages: [{ Name: "os-fixture" }], Vulnerabilities: findings },
    { Class: "lang-pkgs", Type: "node-pkg", Packages: [{ Name: "node-fixture" }] },
  ],
});
const sarif = (score) => ({
  runs: [
    {
      tool: {
        driver: { name: "CodeQL", rules: [{ id: "risk", properties: { "security-severity": score } }] },
      },
      results: [{ ruleId: "risk" }],
    },
  ],
});
const finding = (Severity, FixedVersion = "") => ({
  VulnerabilityID: "CVE-0000-0001",
  PkgName: "fixture",
  Severity,
  FixedVersion,
});
const evaluate = (kind, report) => evaluatePublication(kind, report, checkReport);

test("fixable and unapproved unfixable critical image findings block publication", () => {
  for (const fixed of ["2.0", ""]) {
    const verdict = evaluate("image", image([finding("CRITICAL", fixed)]));
    assert.equal(verdict.eligible, false);
    assert.deepEqual(verdict.counts, { CRITICAL: 1 });
    assert.match(verdict.blocking[0], /CVE-0000-0001 \(fixture, fix: (2\.0|none)\)/);
  }
});

test("high, medium and unknown findings are published as counted residual risk", () => {
  const verdict = evaluate(
    "image",
    image([finding("HIGH", "2.0"), finding("HIGH"), finding("UNKNOWN"), finding("MEDIUM", "2.0")])
  );
  assert.deepEqual(verdict, { kind: "image", eligible: true, counts: { HIGH: 2, UNKNOWN: 1 }, blocking: [] });
});

test("CodeQL blocks from security-severity 9.0 and counts lower high findings", () => {
  assert.deepEqual(evaluate("codeql", sarif("9.0")).blocking, ["risk"]);
  assert.deepEqual(evaluate("codeql", sarif("8.9")), {
    kind: "codeql",
    eligible: true,
    counts: { HIGH: 1 },
    blocking: [],
  });
});

test("malformed reports, Dockerfile findings and unknown kinds still fail closed", () => {
  assert.throws(() => evaluate("image", { Results: [] }));
  assert.throws(() => evaluate("codeql", { runs: [] }));
  assert.throws(() => evaluate("gitleaks", []));
  const config = {
    SchemaVersion: 2,
    ArtifactType: "filesystem",
    Results: [{ Class: "config", Type: "dockerfile", Misconfigurations: [{ Severity: "HIGH", ID: "x" }] }],
  };
  assert.throws(() => evaluate("config", config));
  config.Results[0].Misconfigurations = [];
  assert.equal(evaluate("config", config).eligible, true);
});

const release = {
  version: "caldiy-2026.10.1-rc.1",
  sourceSha: "f".repeat(40),
  image: "ghcr.io/codedeeply/cal.diy",
  digest: `sha256:${"a".repeat(64)}`,
  ciRun: "https://github.com/codedeeply/cal.diy/actions/runs/1/attempts/1",
  sbomSha256: "b".repeat(64),
  verdicts: [{ kind: "image", eligible: true, counts: { HIGH: 2 }, blocking: [] }],
};

test("release notes bind the digest and residual counts", () => {
  const notes = renderReleaseNotes(release);
  assert.match(notes, /ghcr\.io\/codedeeply\/cal\.diy@sha256:a{64}/);
  assert.match(notes, /\| Image \(Trivy\) \| PASS \| HIGH 2 \|/);
});

test("release notes refuse blocked verdicts, bad digests and missing fields", () => {
  assert.throws(() => renderReleaseNotes({ ...release, digest: "sha256:short" }));
  assert.throws(() => renderReleaseNotes({ ...release, sbomSha256: "" }));
  assert.throws(() =>
    renderReleaseNotes({ ...release, verdicts: [{ kind: "image", eligible: false, blocking: ["x"] }] })
  );
});

test("checked-in publish workflow satisfies its policy", () => {
  checkPublishWorkflow(publishWorkflow, ciWorkflow);
});

const publishCases = [
  [
    "a pull request trigger",
    (w) => {
      w.on.pull_request = {};
    },
  ],
  [
    "a second input",
    (w) => {
      w.on.workflow_dispatch.inputs.ref = { type: "string" };
    },
  ],
  [
    "a root write grant",
    (w) => {
      w.permissions.packages = "write";
    },
  ],
  [
    "a verify write grant",
    (w) => {
      w.jobs.verify.permissions.packages = "write";
    },
  ],
  [
    "an extra publish grant",
    (w) => {
      w.jobs.publish.permissions.contents = "write";
    },
  ],
  [
    "an extra job",
    (w) => {
      w.jobs.other = { "runs-on": "ubuntu-24.04", steps: [{ run: "true" }] };
    },
  ],
  [
    "a conditional step",
    (w) => {
      w.jobs.publish.steps[0].if = "false";
    },
  ],
  [
    "a conditional job",
    (w) => {
      w.jobs.verify.if = "false";
    },
  ],
  [
    "a different scanner image",
    (w) => {
      const step = w.jobs.publish.steps.find((s) => s.run === "bash scripts/foundation-image.sh");
      step.env.TRIVY_IMAGE = `aquasec/trivy@sha256:${"0".repeat(64)}`;
    },
  ],
  [
    "an unpinned action",
    (w) => {
      w.jobs.verify.steps[0].uses = "sigstore/cosign-installer@v4";
    },
  ],
  [
    "a repository secret",
    (w) => {
      w.env.TOKEN = `\${{ secrets.TOKEN }}`;
    },
  ],
];
for (const [name, mutate] of publishCases) {
  test(`publish workflow policy rejects ${name}`, () => {
    const workflow = parse(publishWorkflow);
    mutate(workflow);
    assert.throws(() => checkPublishWorkflow(stringify(workflow), ciWorkflow));
  });
}
