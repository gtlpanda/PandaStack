// The guard must deny shell writes into .git or outside the project whatever the spelling:
// every tee operand, and file-writing options of otherwise allowed tools (git log --output).
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

const KIT = path.resolve(import.meta.dirname, "..");
const GUARD = path.join(KIT, "hooks", "guard.mjs");
const root = mkdtempSync(path.join(tmpdir(), "autobuild-guard-operands-"));
writeFileSync(path.join(root, "autobuild.json"), JSON.stringify({ frozen: ["tests", "spec", "SPEC.md", "CLAUDE.md", ".claude", ".env*"], writable: ["PROGRESS.md", "DECISIONS.md"] }));

function decide(command) {
  const result = spawnSync(process.execPath, [GUARD], {
    input: JSON.stringify({ tool_name: "Bash", tool_input: { command } }),
    encoding: "utf8",
    env: { ...process.env, AUTOBUILD_ACTIVE: "1", HARNESS_ACTIVE: "", AUTOBUILD_ROLE: "builder", CLAUDE_PROJECT_DIR: root },
  });
  return result.stdout.includes('"deny"') ? "deny" : "allow";
}

test("tee operands after the first and git --output into .git or outside the project are denied", () => {
  const commands = [
    "echo x | tee /tmp/ok ../../home/user/.bashrc",
    "echo x | tee /tmp/ok .git/config",
    "git log -1 --output=.git/config --format=x",
    "git log -1 --output=../../home/user/.bashrc --format=x",
  ];
  const allowed = commands.filter((command) => decide(command) !== "deny");
  assert.deepEqual(allowed, [], `BUGHUNT-F16 writes into .git or outside the project via extra tee operands or git --output were allowed: ${JSON.stringify(allowed)}`);
});
