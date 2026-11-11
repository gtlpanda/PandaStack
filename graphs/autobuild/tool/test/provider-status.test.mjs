import assert from "node:assert/strict";
import { test } from "node:test";
import { spawnSync, execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { project, CLI } from "../test-fixtures/project.mjs";
import { codexModel } from "../lib/config.mjs";

test("Fable referee maps to Astra; explicit model IDs stay explicit", () => {
  assert.equal(codexModel("fable"), "gpt-6-astra");
  assert.equal(codexModel("gpt-6.1-sol"), "gpt-6.1-sol");
  assert.throws(() => codexModel("claude-unknown"), /No Codex equivalent/);
});

test("completed features do not imply reviewed code", () => {
  const root = project(["F-1"]);
  execFileSync("git", ["-C", root, "branch", "main"]);
  writeFileSync(path.join(root, "features.json"), JSON.stringify({features:[{id:"F-1",title:"one",test:"tests/F-1.test",testKind:"unit",passes:true}]}));
  writeFileSync(path.join(root, "code.js"), "export const answer = 42;\n");
  execFileSync("git", ["-C", root, "add", "."]);
  execFileSync("git", ["-C", root, "commit", "-qm", "build"]);
  const next = spawnSync(process.execPath, [CLI, "next"], {cwd:root,encoding:"utf8"});
  assert.equal(next.status, 10, next.stderr);
  const data = JSON.parse(next.stdout);
  assert.equal(data.done, true);
  assert.equal(data.review.hunted, false);
  assert.equal(data.review.docsOnly, false);
  const status = spawnSync(process.execPath, [CLI, "status"], {cwd:root,encoding:"utf8"});
  assert.equal(status.status, 0, status.stderr);
  assert.match(status.stdout, /review coverage: pending/);
});
