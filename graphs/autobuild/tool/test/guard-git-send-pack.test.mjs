// The guard's "git push is not allowed" policy must also cover the plumbing command that pushes: git send-pack.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

const KIT = path.resolve(import.meta.dirname, "..");
const GUARD = path.join(KIT, "hooks", "guard.mjs");
const root = mkdtempSync(path.join(tmpdir(), "autobuild-guard-sendpack-"));
writeFileSync(path.join(root, "autobuild.json"), JSON.stringify({ frozen: ["tests", "spec", "SPEC.md", "CLAUDE.md", ".claude", ".env*"], writable: ["PROGRESS.md", "DECISIONS.md"] }));

function decide(command) {
  const result = spawnSync(process.execPath, [GUARD], {
    input: JSON.stringify({ tool_name: "Bash", tool_input: { command } }),
    encoding: "utf8",
    env: { ...process.env, AUTOBUILD_ACTIVE: "1", HARNESS_ACTIVE: "", AUTOBUILD_ROLE: "builder", CLAUDE_PROJECT_DIR: root },
  });
  return result.stdout.includes('"deny"') ? "deny" : "allow";
}

test("git send-pack, which pushes commits to a remote, is denied", () => {
  // Precondition (not the bug): the guard is in place and denies a plain git push.
  assert.equal(decide("git push origin autobuild"), "deny", "precondition: the guard must deny plain git push");
  const commands = [
    "git send-pack origin refs/heads/autobuild:refs/heads/autobuild",
    "timeout 60 git send-pack origin refs/heads/autobuild:refs/heads/autobuild",
  ];
  const allowed = commands.filter((command) => decide(command) !== "deny");
  assert.deepEqual(allowed, [], `BUGHUNT-F2 guard allowed git send-pack (a push bypass): ${JSON.stringify(allowed)}`);
});
