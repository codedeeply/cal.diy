import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import process from "node:process";
import { test } from "node:test";
import { evaluateGitleaks } from "./foundation-secret-dispositions.mjs";

const policy = ".github/sle-119";
const now = Date.parse("2026-09-21T00:00:00Z");
const rows = readFileSync(`${policy}/noncredential-dispositions.tsv`, "utf8").trimEnd().split("\n").slice(1);
const findings = rows.map((row) => {
  const [file, rule, start, end, column, endColumn] = row.split("\t");
  return {
    File: `/scan/${file}`,
    RuleID: rule,
    StartLine: +start,
    EndLine: +end,
    StartColumn: +column,
    EndColumn: +endColumn,
  };
});
const evaluate = (report = findings, status = 1, root = ".", policyRoot = ".", at = now) =>
  evaluateGitleaks(report, status, root, policyRoot, at);
function fixture(run) {
  const directory = mkdtempSync(join(tmpdir(), "sle119-disposition-"));
  try {
    for (const file of new Set([
      ...rows.map((row) => row.split("\t")[0]),
      `${policy}/noncredential-approval.json`,
      `${policy}/noncredential-dispositions.tsv`,
    ])) {
      mkdirSync(dirname(join(directory, file)), { recursive: true });
      cpSync(file, join(directory, file));
    }
    run(directory);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

test("only the 167 approved exact-source findings are dispositioned", () => {
  assert.equal(findings.length, 167);
  assert.deepEqual(evaluate(), { total: 167, dispositioned: 167, blocking: 0 });
  assert.deepEqual(evaluate([], 0), { total: 0, dispositioned: 0, blocking: 0 });
});
test("new secret, fabricated approval and duplicate finding remain blocking", () => {
  const secret = { ...findings[0], RuleID: "github-pat", approved: true };
  assert.deepEqual(evaluate([...findings, secret]), { total: 168, dispositioned: 167, blocking: 1 });
  assert.equal(evaluate([...findings, findings[0]]).blocking, 1);
});
for (const field of ["RuleID", "File", "StartLine", "EndLine", "StartColumn", "EndColumn"]) {
  test(`changed ${field} cannot borrow an approval`, () => {
    const original = findings[1];
    const changed = {
      ...original,
      [field]: typeof original[field] === "number" ? original[field] + 1 : `${original[field]}-changed`,
    };
    // Inconsistent ranges are malformed, not an accepted false positive.
    try {
      assert.equal(evaluate([changed]).blocking, 1);
    } catch (error) {
      assert.match(error.message, /Malformed/);
    }
  });
}
test("missing, malformed or inconsistent scanner evidence fails closed", () => {
  for (const report of [
    null,
    {},
    [null],
    [{}],
    [{ ...findings[0], StartLine: "203" }],
    [{ ...findings[0], SymlinkFile: "elsewhere" }],
  ]) {
    assert.throws(() => evaluate(report));
  }
  for (const status of [-1, 2, 127, undefined, NaN])
    assert.throws(() => evaluateGitleaks(findings, status, ".", ".", now));
  assert.throws(() => evaluate(findings, 0));
  assert.throws(() => evaluate([], 1));
});
test("expiry, before-approval time and invalid clock reject the complete inventory", () => {
  for (const at of [Date.parse("2026-10-20T00:00:00Z"), Date.parse("2026-09-19"), NaN]) {
    assert.throws(() => evaluate(findings, 1, ".", ".", at));
  }
});
test("missing or fabricated approval and altered proof inventory fail closed", () =>
  fixture((directory) => {
    const approval = join(directory, policy, "noncredential-approval.json");
    const original = readFileSync(approval);
    for (const replacement of [
      "{}",
      original.toString().replace("APPROVED", "PROPOSED_NOT_APPROVED"),
      original.toString().replace("2026-10-20", "2099-10-20"),
    ]) {
      writeFileSync(approval, replacement);
      assert.throws(() => evaluate(findings, 1, directory, directory));
    }
    rmSync(approval);
    assert.throws(() => evaluate(findings, 1, directory, directory));
    writeFileSync(approval, original);
    const inventory = join(directory, policy, "noncredential-dispositions.tsv");
    writeFileSync(
      inventory,
      readFileSync(inventory, "utf8").replace("REPRODUCED_CURRENT", "FABRICATED_CURRENT")
    );
    assert.throws(() => evaluate(findings, 1, directory, directory));
  }));
test("injected source bytes and symlink replacement invalidate the source proof", () =>
  fixture((directory) => {
    const file = join(directory, "i18n.lock");
    const bytes = readFileSync(file);
    writeFileSync(file, Buffer.concat([bytes, Buffer.from("\ninjected-credential-fixture\n")]));
    assert.throws(() => evaluate(findings, 1, directory, directory));
    rmSync(file);
    writeFileSync(join(directory, "outside"), bytes);
    symlinkSync("outside", file);
    assert.throws(() => evaluate(findings, 1, directory, directory));
  }));
test("CLI rejects unapproved findings, scanner errors and missing report", () =>
  fixture((directory) => {
    const report = join(directory, "report.json");
    writeFileSync(report, JSON.stringify(findings));
    const accepted = spawnSync(
      process.execPath,
      ["scripts/foundation-gates.mjs", "gitleaks", report, "1", "."],
      { encoding: "utf8" }
    );
    assert.equal(accepted.status, 0, accepted.stderr);
    assert.match(accepted.stdout, /"dispositioned":167,"blocking":0/);
    writeFileSync(report, JSON.stringify([...findings, { ...findings[0], RuleID: "injected-secret" }]));
    for (const [path, status] of [
      [report, "1"],
      [report, "2"],
      [join(directory, "absent.json"), "1"],
    ]) {
      const result = spawnSync(
        process.execPath,
        ["scripts/foundation-gates.mjs", "gitleaks", path, status, "."],
        { encoding: "utf8" }
      );
      assert.notEqual(result.status, 0);
    }
  }));
