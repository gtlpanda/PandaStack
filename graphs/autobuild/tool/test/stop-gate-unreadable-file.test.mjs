// The stop hook digests the working tree before it runs the gate. An untracked, unreadable file in
// the tree must not crash the hook: the digest is then null ("cannot digest the tree") and the gate still runs.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { KIT, project } from "../test-fixtures/project.mjs";

const HOOK = path.join(KIT, "hooks", "stop-gate.mjs");

test("the stop hook still runs the gate when the tree holds an untracked unreadable file", (t) => {
  const root = project(["f1"]);
  const unreadable = path.join(root, "restricted-artifact.bin");
  t.after(() => {
    try { chmodSync(unreadable, 0o600); } catch { /* already gone */ }
    rmSync(root, { recursive: true, force: true });
  });
  const stateDir = path.join(root, ".harness");
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(path.join(stateDir, "session.json"), JSON.stringify({ role: "builder", featureId: "f1", progressAtStart: "" }));
  // Untracked and not git-ignored, so `git ls-files -o --exclude-standard` lists it; mode 000 makes readFileSync throw EACCES.
  writeFileSync(unreadable, "restricted\n");
  chmodSync(unreadable, 0o000);

  const result = spawnSync(process.execPath, [HOOK], {
    cwd: root,
    input: "{}",
    encoding: "utf8",
    env: { ...process.env, AUTOBUILD_ACTIVE: "1", CLAUDE_PROJECT_DIR: root },
    timeout: 60_000,
  });
  assert.equal(result.status, 0, `BUGHUNT-F4 the stop hook crashed on an unreadable untracked file: ${result.stderr}`);
  const session = JSON.parse(readFileSync(path.join(stateDir, "session.json"), "utf8"));
  assert.ok(session.lastGate, "BUGHUNT-F4 the gate did not run: session.lastGate was never written");
});
