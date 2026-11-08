// The guard's git policy (no push, no history- or work-discarding commands) must also hold when git is
// run by another command, such as `find ... -exec git push origin HEAD \;`.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

const KIT = path.resolve(import.meta.dirname, "..");
const GUARD = path.join(KIT, "hooks", "guard.mjs");
const root = mkdtempSync(path.join(tmpdir(), "autobuild-guard-findexec-"));
writeFileSync(path.join(root, "autobuild.json"), JSON.stringify({ frozen: ["tests", "spec", "SPEC.md", "CLAUDE.md", ".claude", ".env*"], writable: ["PROGRESS.md", "DECISIONS.md"] }));

function decide(command) {
  const result = spawnSync(process.execPath, [GUARD], {
    input: JSON.stringify({ tool_name: "Bash", tool_input: { command } }),
    encoding: "utf8",
    env: { ...process.env, AUTOBUILD_ACTIVE: "1", HARNESS_ACTIVE: "", AUTOBUILD_ROLE: "builder", CLAUDE_PROJECT_DIR: root },
  });
  return result.stdout.includes('"deny"') ? "deny" : "allow";
}

test("git push and work-discarding git commands run through find -exec are denied", () => {
  // Precondition (not the bug): the guard is in place and denies the plain spellings.
  assert.equal(decide("git push origin HEAD"), "deny", "precondition: the guard must deny plain git push");
  assert.equal(decide("git reset --hard"), "deny", "precondition: the guard must deny plain git reset");
  const commands = [
    "find . -maxdepth 0 -exec git push origin HEAD \;",
    "find . -maxdepth 0 -exec git reset --hard \;",
    "find . -maxdepth 0 -exec git clean -fdx \;",
    "find . -maxdepth 0 -exec git checkout . \;",
  ];
  const allowed = commands.filter((command) => decide(command) !== "deny");
  assert.deepEqual(allowed, [], `BUGHUNT-F2 guard allowed git run through find -exec (push/discard bypass): ${JSON.stringify(allowed)}`);
});
