import assert from "node:assert/strict";
import { test } from "node:test";
import { checkPins, checkReport } from "./foundation-gates.mjs";

const image = (findings = []) => ({ Results: [{ Class: "os-pkgs", Vulnerabilities: findings }] });
const sarif = (results = [], score = "9.8") => ({
  runs: [
    {
      tool: {
        driver: { name: "CodeQL", rules: [{ id: "risk", properties: { "security-severity": score } }] },
      },
      results,
    },
  ],
});

test("missing and malformed reports fail closed", () => {
  for (const kind of ["image", "config", "dependencies", "gitleaks", "codeql", "unknown"]) {
    assert.throws(() => checkReport(kind, {}));
  }
  assert.throws(() => checkReport("image", image([{}])));
  assert.throws(() => checkReport("image", { Results: [] }));
  assert.throws(() => checkReport("codeql", { runs: [] }));
});

test("unapproved image findings cannot be hidden by fixability or a fabricated approval", () => {
  for (const Severity of ["HIGH", "CRITICAL", "UNKNOWN"]) {
    for (const FixedVersion of ["", "2.0"]) {
      assert.throws(() => checkReport("image", image([{ Severity, FixedVersion, approved: true }])));
    }
  }
  checkReport("image", image());
  assert.throws(() => checkReport("dependencies", image()));
  assert.throws(() =>
    checkReport("dependencies", {
      Results: [{ Class: "lang-pkgs", Vulnerabilities: [{ Severity: "CRITICAL" }] }],
    })
  );
});

test("configuration failures and secret findings block eligibility", () => {
  const report = { Results: [{ Class: "config", Misconfigurations: [{ Severity: "HIGH", ID: "unsafe" }] }] };
  assert.throws(() => checkReport("config", report));
  assert.throws(() => checkReport("gitleaks", [{ RuleID: "fixture" }]));
  checkReport("gitleaks", []);
});

test("CodeQL high findings, missing metadata and failed analysis block eligibility", () => {
  checkReport("codeql", sarif());
  assert.throws(() => checkReport("codeql", sarif([{ ruleId: "risk" }])));
  assert.throws(() => checkReport("codeql", sarif([{ ruleId: "missing" }])));
  assert.throws(() => checkReport("codeql", sarif([{ ruleId: "risk" }], "invalid")));
  const failed = sarif();
  failed.runs[0].invocations = [{ executionSuccessful: false }];
  assert.throws(() => checkReport("codeql", failed));
});

test("mutable actions/images and privileged workflow shortcuts are rejected", () => {
  const pinnedBase = `FROM node:24@sha256:${"a".repeat(64)}`;
  assert.throws(() => checkPins("", ""));
  assert.throws(() => checkPins("   FROM node:24", ""));
  assert.throws(() => checkPins("FROM node", ""));
  assert.throws(() => checkPins("FROM --platform=linux/amd64 node:24 AS builder", ""));
  assert.throws(() => checkPins("FROM node:24", ""));
  assert.throws(() => checkPins(pinnedBase, "uses: actions/checkout@v5"));
  assert.throws(() => checkPins(pinnedBase, "uses : actions/checkout@v5"));
  for (const unsafe of [
    "pull_request_target:",
    "runs-on: self-hosted",
    "continue-on-error: true",
    "continue-on-error : true",
    "secrets.TOKEN",
    `\${{ secrets['TOKEN'] }}`,
    `\${{ toJSON(secrets) }}`,
  ]) {
    assert.throws(() => checkPins(pinnedBase, unsafe));
  }
  checkPins(pinnedBase, `uses: actions/checkout@${"b".repeat(40)}`);
});

test("CodeQL extension rule references retain the same severity gate", () => {
  const report = sarif([{ ruleId: "risk", rule: { id: "risk", index: 0, toolComponent: { index: 0 } } }]);
  const run = report.runs[0];
  run.tool.extensions = [{ name: "codeql/javascript-queries", rules: run.tool.driver.rules }];
  run.tool.driver.rules = [];
  assert.throws(() => checkReport("codeql", report));
  run.tool.extensions[0].rules[0].properties["security-severity"] = "4.0";
  checkReport("codeql", report);
  run.results[0].rule.index = 1;
  assert.throws(() => checkReport("codeql", report));
  run.results[0].rule.index = 0;
  run.results[0].rule.toolComponent.index = 1;
  assert.throws(() => checkReport("codeql", report));
});
