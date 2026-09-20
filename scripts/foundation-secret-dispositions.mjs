import { createHash } from "node:crypto";
import { lstatSync, readFileSync } from "node:fs";
import { join } from "node:path";

const policyDirectory = ".github/sle-119";
const approvalHash = "67786a5d5bca8d13cb8e0f57cfad11e9a2a185537481198f43d6f5507c83c2ce";
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const key = (file, rule, start, end, column, endColumn) =>
  JSON.stringify([file, rule, start, end, column, endColumn]);

/** Source hashes bind the approved proof, not an entire path or a credential-shaped value. */
export function evaluateGitleaks(report, scannerExit, root, policyRoot = ".", now = Date.now()) {
  if (!Array.isArray(report) || ![0, 1].includes(scannerExit)) throw new Error("Invalid scanner result");
  if (report.length > 0 !== (scannerExit === 1)) throw new Error("Scanner/report status mismatch");
  const approvalBytes = readFileSync(join(policyRoot, policyDirectory, "noncredential-approval.json"));
  if (digest(approvalBytes) !== approvalHash) throw new Error("Missing or changed Sierra approval");
  const approval = JSON.parse(approvalBytes);
  if (
    !Number.isFinite(now) ||
    now < Date.parse(approval.approvedAt) ||
    now >= Date.parse(approval.expiresAt)
  ) {
    throw new Error("Disposition approval is not currently valid");
  }
  const inventoryBytes = readFileSync(join(policyRoot, policyDirectory, "noncredential-dispositions.tsv"));
  if (digest(inventoryBytes) !== approval.inventorySha256) throw new Error("Changed disposition inventory");
  const rows = inventoryBytes.toString("utf8").trimEnd().split("\n").slice(1);
  if (rows.length !== approval.count) throw new Error("Incomplete disposition inventory");
  const approved = new Set();
  const files = new Map();
  for (const row of rows) {
    const [file, rule, start, end, column, endColumn, hash] = row.split("\t");
    if (!files.has(file)) {
      let path = root;
      for (const segment of file.split("/")) {
        if (!segment || segment === "." || segment === "..") throw new Error("Invalid source path");
        path = join(path, segment);
        if (lstatSync(path).isSymbolicLink()) throw new Error("Symlinked disposition source");
      }
      if (digest(readFileSync(path)) !== hash) throw new Error("Disposition source changed");
      files.set(file, hash);
    }
    if (files.get(file) !== hash) throw new Error("Conflicting source hashes");
    const identity = key(file, rule, Number(start), Number(end), Number(column), Number(endColumn));
    if (approved.has(identity)) throw new Error("Duplicate disposition identity");
    approved.add(identity);
  }
  let dispositioned = 0;
  for (const finding of report) {
    const { File, RuleID, StartLine, EndLine, StartColumn, EndColumn, SymlinkFile } = finding ?? {};
    if (
      typeof File !== "string" ||
      !File.startsWith("/scan/") ||
      typeof RuleID !== "string" ||
      !RuleID ||
      ![StartLine, EndLine, StartColumn, EndColumn].every((value) => Number.isInteger(value) && value > 0) ||
      EndLine < StartLine ||
      (EndLine === StartLine && EndColumn < StartColumn) ||
      SymlinkFile
    )
      throw new Error("Malformed Gitleaks finding");
    // Consuming an identity once prevents duplicate findings from borrowing a single disposition.
    if (approved.delete(key(File.slice(6), RuleID, StartLine, EndLine, StartColumn, EndColumn)))
      dispositioned++;
  }
  return { total: report.length, dispositioned, blocking: report.length - dispositioned };
}
