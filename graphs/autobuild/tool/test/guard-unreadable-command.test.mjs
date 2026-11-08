// The guard denies a command it cannot read (a script piped into a shell, or nested too deeply to
// check) instead of approving it, as /build-app's guard does.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

const KIT = path.resolve(import.meta.dirname, "..");
const GUARD = path.join(KIT, "hooks", "guard.mjs");
const root = mkdtempSync(path.join(tmpdir(), "autobuild-guard-unreadable-"));
writeFileSync(path.join(root, "autobuild.json"), JSON.stringify({ frozen: ["tests", "spec", "SPEC.md", "CLAUDE.md", ".claude", ".env*"], writable: ["PROGRESS.md", "DECISIONS.md"] }));

function decide(command) {
  const result = spawnSync(process.execPath, [GUARD], {
    input: JSON.stringify({ tool_name: "Bash", tool_input: { command } }),
    encoding: "utf8",
    env: { ...process.env, AUTOBUILD_ACTIVE: "1", HARNESS_ACTIVE: "", AUTOBUILD_ROLE: "builder", CLAUDE_PROJECT_DIR: root },
  });
  return result.stdout.includes('"deny"') ? "deny" : "allow";
}

const nest = (levels, inner) => {
  let command = inner;
  for (let i = 0; i < levels; i += 1) command = `bash -c '${command.replace(/'/g, "'\\''")}'`;
  return command;
};

test("the guard is live: a plain git push is denied", () => {
  assert.equal(decide("git push origin HEAD"), "deny");
});

test("a push piped into a shell, or nested too deeply to read, is not approved", () => {
  const commands = ["echo 'git push origin HEAD' | bash", nest(7, "git push origin HEAD")];
  const allowed = commands.filter((command) => decide(command) !== "deny").map((command) => command.slice(0, 60));
  assert.deepEqual(allowed, [], `BUGHUNT-F2 guard approved commands it could not read: ${JSON.stringify(allowed)}`);
});
