import { execFileSync } from "node:child_process";
import process from "node:process";

const base = process.env.BASE_SHA;
if (!/^[a-f0-9]{40}$/.test(base ?? "")) throw new Error("A full lint comparison SHA is required");
const files = execFileSync("git", ["diff", "--name-only", "--diff-filter=ACMR", "-z", base, "HEAD"], {
  encoding: "utf8",
})
  .split("\0")
  .filter((file) => /\.(?:[cm]?[jt]sx?|jsonc?|css)$/.test(file));
if (files.length) {
  execFileSync("yarn", ["biome", "ci", "--files-ignore-unknown=true", "--", ...files], { stdio: "inherit" });
} else {
  console.log("No changed Biome-supported files; workflow syntax and gate tests remain required.");
}
