// An active autobuild session whose autobuild.json cannot be loaded must still be guarded: the
// guard denies instead of letting every Edit, Write and Bash call through.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

const GUARD = path.resolve(import.meta.dirname, "..", "hooks", "guard.mjs");
const root = mkdtempSync(path.join(tmpdir(), "autobuild-guard-config-"));
mkdirSync(path.join(root, "tests"));
const configFile = path.join(root, "autobuild.json");

function decide(tool, input) {
  const result = spawnSync(process.execPath, [GUARD], {
    input: JSON.stringify({ tool_name: tool, tool_input: input }),
    encoding: "utf8",
    env: { ...process.env, AUTOBUILD_ACTIVE: "1", HARNESS_ACTIVE: "", AUTOBUILD_ROLE: "builder", CLAUDE_PROJECT_DIR: root },
  });
  return result.stdout.includes('"deny"') ? "deny" : "allow";
}

const CALLS = [
  ["Write", { file_path: path.join(root, "tests", "x.test.js"), content: "x" }],
  ["Write", { file_path: path.join(root, ".git", "hooks", "pre-commit"), content: "x" }],
  ["Bash", { command: "git push origin main" }],
  ["Bash", { command: "rm -rf /" }],
];

test("a loadable config denies the guarded calls (control)", () => {
  writeFileSync(configFile, JSON.stringify({ frozen: ["tests"] }));
  for (const [tool, input] of CALLS) {
    assert.equal(decide(tool, input), "deny", `BUGHUNT-F21 control: ${tool} ${JSON.stringify(input)} must be denied with a valid config`);
  }
});

for (const [label, content] of [
  ["unparseable JSON", "{ not json"],
  ["an invalid hooks value", JSON.stringify({ frozen: ["tests"], hooks: "bogus" })],
]) {
  test(`a config that cannot be loaded (${label}) still denies guarded calls in an active session`, () => {
    writeFileSync(configFile, content);
    for (const [tool, input] of CALLS) {
      assert.equal(
        decide(tool, input),
        "deny",
        `BUGHUNT-F21 guard fails open: ${tool} ${JSON.stringify(input)} is allowed when autobuild.json cannot be loaded (${label})`,
      );
    }
  });
}
