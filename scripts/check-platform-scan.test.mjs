import assert from "node:assert/strict";
import { test } from "node:test";
import { checkPlatform } from "./check-platform-scan.mjs";

const report = (findings = [], extra = []) => ({
  Results: [{ Class: "os-pkgs", Type: "debian", Vulnerabilities: findings }, ...extra],
});
const critical = { Severity: "CRITICAL", FixedVersion: "2.0" };

test("fails closed without an OS scan or with malformed findings", () => {
  assert.throws(() => checkPlatform({ Results: [] }, report()), /OS package scan/);
  assert.throws(() => checkPlatform(report([{}]), report()), /severity/);
});

test("blocks every fixable critical OS finding", () => {
  assert.throws(() => checkPlatform(report([critical]), report([critical])), /fixable CRITICAL/);
});

test("includes bundled Go build tools in the platform gate", () => {
  const candidate = report([], [{ Class: "lang-pkgs", Type: "gobinary", Vulnerabilities: [critical] }]);
  assert.throws(() => checkPlatform(candidate, report()), /fixable CRITICAL/);
});

test("blocks an increase in unfixable critical findings", () => {
  assert.throws(() => checkPlatform(report([{ Severity: "CRITICAL" }]), report()), /count increased/);
});

test("reports application findings without claiming full release eligibility", () => {
  const candidate = report([], [{ Class: "lang-pkgs", Type: "node-pkg", Vulnerabilities: [critical] }]);
  assert.deepEqual(checkPlatform(candidate, report([critical])).current, {
    critical: 0,
    fixableCritical: 0,
    applicationCritical: 1,
  });
});
