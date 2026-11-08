// The guard denies `git branch -d/-D/-m/-M` and `git tag -d` wherever the flag appears among the arguments.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

const KIT = path.resolve(import.meta.dirname, "..");
const GUARD = path.join(KIT, "hooks", "guard.mjs");
const root = mkdtempSync(path.join(tmpdir(), "autobuild-guard-branch-"));
writeFileSync(path.join(root, "autobuild.json"), JSON.stringify({ frozen: ["tests", "spec", "SPEC.md", "CLAUDE.md", ".claude", ".env*"], writable: ["PROGRESS.md", "DECISIONS.md"] }));

function decide(command) {
  const result = spawnSync(process.execPath, [GUARD], {
    input: JSON.stringify({ tool_name: "Bash", tool_input: { command } }),
    encoding: "utf8",
    env: { ...process.env, AUTOBUILD_ACTIVE: "1", HARNESS_ACTIVE: "", AUTOBUILD_ROLE: "builder", CLAUDE_PROJECT_DIR: root },
  });
  return result.stdout.includes('"deny"') ? "deny" : "allow";
}

const DESTRUCTIVE = [
  "git branch -D attempt/bughunt-20260101T000000Z",
  "git branch -d attempt/bughunt-20260101T000000Z",
  "git branch -m autobuild other",
  "git branch -M autobuild other",
  "git tag -d v1",
];

test("git branch/tag delete and rename are denied when the flag comes first", () => {
  const allowed = DESTRUCTIVE.filter((command) => decide(command) !== "deny");
  assert.deepEqual(allowed, [], `BUGHUNT-F12 guard allowed branch/tag delete or rename commands: ${JSON.stringify(allowed)}`);
});
