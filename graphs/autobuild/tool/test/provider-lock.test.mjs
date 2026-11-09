// Shared hunt preparation mutates detached analysis/repair trees. Both provider
// entrypoints must reject an existing owner BEFORE that preparation begins.
import assert from "node:assert/strict";
import { test } from "node:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { project } from "../test-fixtures/project.mjs";
import { loadConfig } from "../lib/config.mjs";
import { runBughunt } from "../lib/bughunt.mjs";
import { prepareHunt } from "../../../hunt/skills/bughunt/land.mjs";
import { withNativeRepoLock } from "../../../hunt/skills/bughunt/native-runner.mjs";

const git = (root, ...args) => execFileSync("git", ["-C", root, ...args], { encoding: "utf8" }).trim();
function fixture(t, backend) {
  const root = project(["F-1"]);
  t.after(() => rmSync(root, { recursive: true, force: true }));
  git(root, "branch", "main");
  writeFileSync(path.join(root, "feature.mjs"), "export const value = 2;\n");
  git(root, "add", "feature.mjs"); git(root, "commit", "-qm", "feature");
  const prep = prepareHunt({ repo: root, target: "autobuild", base: "main", stamp: "initial" });
  assert.ok(prep.stateDir, JSON.stringify(prep));
  const sentinel = path.join(prep.fixDir, "active-repair.mjs");
  writeFileSync(sentinel, "export const unfinished = true;\n");
  const originalHead = git(root, "rev-parse", "HEAD");
  const fixHead = git(prep.fixDir, "rev-parse", "HEAD");
  const intake = readFileSync(path.join(prep.stateDir, "intake.json"), "utf8");
  const config = loadConfig(root, { AUTOBUILD_BACKEND: backend, AUTOBUILD_CODEX_BIN: "/no/such/codex", AUTOBUILD_CLAUDE_BIN: "/no/such/claude" });
  config.bughuntBase = "main";
  const logs = [];
  const invoke = () => runBughunt(config, { log: line => logs.push(line), runId: "competing-hunt" });
  const assertUntouched = () => {
    assert.equal(readFileSync(sentinel, "utf8"), "export const unfinished = true;\n", "active repair remains at its original location");
    assert.equal(git(root, "rev-parse", "HEAD"), originalHead);
    assert.equal(git(prep.fixDir, "rev-parse", "HEAD"), fixHead, "active work was not silently committed");
    assert.equal(readFileSync(path.join(prep.stateDir, "intake.json"), "utf8"), intake);
    assert.equal(git(root, "branch", "--list", "attempt/*"), "", "active work was not moved to an attempt branch");
    assert.equal(git(root, "status", "--porcelain"), "");
  };
  return { root, prep, logs, invoke, assertUntouched };
}
for (const backend of ["claude", "codex"]) {
  test(`${backend} cannot prepare while another provider owns the repository hunt lock`, async t => {
    const f = fixture(t, backend);
    await withNativeRepoLock(f.root, async () => {
      assert.equal(await f.invoke(), 12);
      assert.match(f.logs.join("\n"), /owns this repository|hunt.*lock/i);
      f.assertUntouched();
    });
  });
  test(`${backend} refuses an interrupted per-target lock before replacing its repair worktree`, async t => {
    const f = fixture(t, backend);
    mkdirSync(path.join(f.prep.stateDir, "native.lock"));
    writeFileSync(path.join(f.prep.stateDir, "native.lock", "owner.json"), JSON.stringify({ pid: process.pid, at: "2026-11-09T00:00:00Z" }));
    assert.equal(await f.invoke(), 12);
    assert.match(f.logs.join("\n"), /Existing hunt lock/);
    f.assertUntouched();
  });
}
