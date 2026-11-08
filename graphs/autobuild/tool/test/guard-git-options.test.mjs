// The guard denies git push and work-discarding git commands however global options or aliases are spelled.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

const KIT = path.resolve(import.meta.dirname, "..");
const GUARD = path.join(KIT, "hooks", "guard.mjs");
const root = mkdtempSync(path.join(tmpdir(), "autobuild-guard-git-"));
writeFileSync(path.join(root, "autobuild.json"), JSON.stringify({ frozen: ["tests", "spec", "SPEC.md", "CLAUDE.md", ".claude", ".env*"], writable: ["PROGRESS.md", "DECISIONS.md"] }));

function decide(command) {
  const result = spawnSync(process.execPath, [GUARD], {
    input: JSON.stringify({ tool_name: "Bash", tool_input: { command } }),
    encoding: "utf8",
    env: { ...process.env, AUTOBUILD_ACTIVE: "1", HARNESS_ACTIVE: "", AUTOBUILD_ROLE: "builder", CLAUDE_PROJECT_DIR: root },
  });
  return result.stdout.includes('"deny"') ? "deny" : "allow";
}

const BYPASSES = [
  "git -P push origin HEAD",
  "git -ccore.pager=cat push origin HEAD",
  "git -c alias.p=push p origin HEAD",
  "git -P reset --hard",
  "git -P checkout .",
];

test("git push and discarding subcommands are denied regardless of option spelling", () => {
  const allowed = BYPASSES.filter((command) => decide(command) !== "deny");
  assert.deepEqual(allowed, [], `BUGHUNT-F3 guard allowed git commands that should be denied: ${JSON.stringify(allowed)}`);
});
