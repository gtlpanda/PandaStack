// The guard must deny a redirect into a bare file name after `cd` into .git or the home directory:
// the target token has no path separator, so it must not be judged against the project root alone.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

const KIT = path.resolve(import.meta.dirname, "..");
const GUARD = path.join(KIT, "hooks", "guard.mjs");
const root = mkdtempSync(path.join(tmpdir(), "autobuild-guard-cd-"));
writeFileSync(path.join(root, "autobuild.json"), JSON.stringify({ frozen: ["tests", "spec", "SPEC.md", "CLAUDE.md", ".claude", ".env*"], writable: ["PROGRESS.md", "DECISIONS.md"] }));

function decide(command) {
  const result = spawnSync(process.execPath, [GUARD], {
    input: JSON.stringify({ tool_name: "Bash", tool_input: { command } }),
    encoding: "utf8",
    env: { ...process.env, AUTOBUILD_ACTIVE: "1", HARNESS_ACTIVE: "", AUTOBUILD_ROLE: "builder", CLAUDE_PROJECT_DIR: root },
  });
  return result.stdout.includes('"deny"') ? "deny" : "allow";
}

test("cd into .git or ~ then redirecting into a bare file name is denied", () => {
  const commands = [
    "cd .git && cat >> config <<'EOF'\n[core]\n\tfsmonitor = sh -c 'touch /tmp/pwned; true'\nEOF",
    "cd ~ && cat > .bashrc <<'EOF'\nalias ls='sh -c evil'\nEOF",
  ];
  const allowed = commands.filter((command) => decide(command) !== "deny");
  assert.deepEqual(allowed, [], `BUGHUNT-F7 cd into .git/~ then redirect into a bare file name was allowed: ${JSON.stringify(allowed)}`);
});
