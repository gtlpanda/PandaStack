// The guard must deny `sed -i` against frozen or outside-project files whatever flags precede -i.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

const KIT = path.resolve(import.meta.dirname, "..");
const GUARD = path.join(KIT, "hooks", "guard.mjs");
const root = mkdtempSync(path.join(tmpdir(), "autobuild-guard-sed-"));
writeFileSync(path.join(root, "autobuild.json"), JSON.stringify({ frozen: ["tests", "spec", "SPEC.md", "CLAUDE.md", ".claude", ".env*"], writable: ["PROGRESS.md", "DECISIONS.md"] }));

function decide(command) {
  const result = spawnSync(process.execPath, [GUARD], {
    input: JSON.stringify({ tool_name: "Bash", tool_input: { command } }),
    encoding: "utf8",
    env: { ...process.env, AUTOBUILD_ACTIVE: "1", HARNESS_ACTIVE: "", AUTOBUILD_ROLE: "builder", CLAUDE_PROJECT_DIR: root },
  });
  return result.stdout.includes('"deny"') ? "deny" : "allow";
}

test("sed -i with other options before -i against frozen or outside paths is denied", () => {
  const commands = [
    "sed -i 's/A/B/' .env",
    "sed -E -i '$a export X=1' ~/.bashrc",
    "sed -e 's/A/B/' -i .env",
    "sed -n -i 's/A/B/' tests/foo.test.ts",
    "sed --in-place 's/A/B/' ~/.bashrc",
  ];
  const allowed = commands.filter((command) => decide(command) !== "deny");
  assert.deepEqual(allowed, [], `BUGHUNT-F7 sed -i with leading flags on frozen/outside-project files was allowed: ${JSON.stringify(allowed)}`);
});
