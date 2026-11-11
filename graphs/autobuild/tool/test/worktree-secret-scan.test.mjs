import assert from "node:assert/strict";
import { test } from "node:test";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync, renameSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
const scanner = path.resolve(import.meta.dirname, "../../../../scripts/check-secrets.sh");
function fixture(t) {
  const root = mkdtempSync(path.join(tmpdir(), "ordinary-secret-scan-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  execFileSync("git", ["init", "-q", root]);
  const file = path.join(root, "tracked.txt");
  writeFileSync(file, "ordinary fixture\n");
  execFileSync("git", ["-C", root, "add", "tracked.txt"]);
  return { root, file };
}
function scan(root, args = ["--worktree"]) {
  const result = spawnSync("bash", [scanner, ...args], { cwd: root, encoding: "utf8", timeout: 10000 });
  return { status: result.status, output: result.stdout + result.stderr };
}
const syntheticSecret = () => "sk-" + "A".repeat(40); // Generated inert pattern, not a credential.

test("worktree scan accepts an unstaged tracked deletion", t => {
  const { root, file } = fixture(t); rmSync(file);
  const result = scan(root); assert.equal(result.status, 0, result.output);
});
test("worktree scan includes a rename destination while allowing the removed indexed path", t => {
  const { root, file } = fixture(t);
  const renamed = path.join(root, "renamed file.txt"); renameSync(file, renamed);
  assert.equal(scan(root).status, 0);
  writeFileSync(renamed, syntheticSecret());
  const result = scan(root); assert.equal(result.status, 1); assert.match(result.output, /renamed file.txt/);
});
test("worktree scan does not omit secrets in newly added nonignored files", t => {
  const { root } = fixture(t);
  writeFileSync(path.join(root, "new file.txt"), syntheticSecret());
  const result = scan(root); assert.equal(result.status, 1); assert.match(result.output, /new file.txt/);
});
test("worktree scan rejects an indexed path replaced by an ordinary directory", t => {
  const { root, file } = fixture(t); rmSync(file); mkdirSync(file);
  const result = scan(root); assert.equal(result.status, 1); assert.match(result.output, /not a readable regular file/);
});
test("worktree scan respects nonignored scope and keeps default and staged scan behavior", t => {
  const { root } = fixture(t);
  writeFileSync(path.join(root, ".gitignore"), "ignored.txt\n");
  writeFileSync(path.join(root, "ignored.txt"), syntheticSecret());
  assert.equal(scan(root).status, 0);
  writeFileSync(path.join(root, "new.txt"), syntheticSecret());
  assert.equal(scan(root, []).status, 0, "default still scans tracked files only");
  assert.equal(scan(root, ["--staged"]).status, 0, "staged scan sees indexed clean content");
  execFileSync("git", ["-C", root, "add", "new.txt"]);
  assert.equal(scan(root, ["--staged"]).status, 1);
});
