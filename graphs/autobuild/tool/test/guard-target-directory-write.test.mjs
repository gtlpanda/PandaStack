// The guard must deny shell writes outside the project or into .git whatever the spelling,
// including the file-writing options of otherwise allowed tools (cp/mv/install --target-directory, -t).
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

const KIT = path.resolve(import.meta.dirname, "..");
const GUARD = path.join(KIT, "hooks", "guard.mjs");
const root = mkdtempSync(path.join(tmpdir(), "autobuild-guard-target-dir-"));
writeFileSync(path.join(root, "autobuild.json"), JSON.stringify({ frozen: ["tests", "spec", "SPEC.md", "CLAUDE.md", ".claude", ".env*"], writable: ["PROGRESS.md", "DECISIONS.md"] }));

function decide(command) {
  const result = spawnSync(process.execPath, [GUARD], {
    input: JSON.stringify({ tool_name: "Bash", tool_input: { command } }),
    encoding: "utf8",
    env: { ...process.env, AUTOBUILD_ACTIVE: "1", HARNESS_ACTIVE: "", AUTOBUILD_ROLE: "builder", CLAUDE_PROJECT_DIR: root },
  });
  return result.stdout.includes('"deny"') ? "deny" : "allow";
}

test("cp/mv/install --target-directory and -t into .ssh or .git are denied", () => {
  const ssh = path.join(homedir(), ".ssh");
  const commands = [
    `cp --target-directory=${ssh} /tmp/authorized_keys`,
    `cp -t${ssh} /tmp/authorized_keys`,
    `mv --target-directory=${ssh} /tmp/authorized_keys`,
    `install --target-directory=${ssh} /tmp/authorized_keys`,
    "cp --target-directory=.git/hooks /tmp/pre-commit",
    "cp -t.git/hooks /tmp/pre-commit",
  ];
  const allowed = commands.filter((command) => decide(command) !== "deny");
  assert.deepEqual(allowed, [], `BUGHUNT-F16 writes outside the project or into .git via --target-directory / -t were allowed: ${JSON.stringify(allowed)}`);
});
