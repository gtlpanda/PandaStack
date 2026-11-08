// The guard must deny redirects into ~/.bashrc however $HOME is spelled (quoted or braced), not
// resolve them literally under the project root.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

const KIT = path.resolve(import.meta.dirname, "..");
const GUARD = path.join(KIT, "hooks", "guard.mjs");
const root = mkdtempSync(path.join(tmpdir(), "autobuild-guard-home-"));
writeFileSync(path.join(root, "autobuild.json"), JSON.stringify({ frozen: ["tests", "spec", "SPEC.md", "CLAUDE.md", ".claude", ".env*"], writable: ["PROGRESS.md", "DECISIONS.md"] }));

function decide(command) {
  const result = spawnSync(process.execPath, [GUARD], {
    input: JSON.stringify({ tool_name: "Bash", tool_input: { command } }),
    encoding: "utf8",
    env: { ...process.env, AUTOBUILD_ACTIVE: "1", HARNESS_ACTIVE: "", AUTOBUILD_ROLE: "builder", CLAUDE_PROJECT_DIR: root },
  });
  return result.stdout.includes('"deny"') ? "deny" : "allow";
}

test("redirects into a quoted $HOME/.bashrc are denied", () => {
  const commands = [
    `echo 'alias git="sh -c evil"' >> "$HOME"/.bashrc`,
    `echo x > "\${HOME}"/.bashrc`,
  ];
  const allowed = commands.filter((command) => decide(command) !== "deny");
  assert.deepEqual(allowed, [], `BUGHUNT-F25 redirects into the real ~/.bashrc via a quoted $HOME were allowed: ${JSON.stringify(allowed)}`);
});
