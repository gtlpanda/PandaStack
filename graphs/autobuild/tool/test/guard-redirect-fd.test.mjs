// The guard must deny output redirects into frozen or outside-project paths whatever the fd prefix.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

const KIT = path.resolve(import.meta.dirname, "..");
const GUARD = path.join(KIT, "hooks", "guard.mjs");
const root = mkdtempSync(path.join(tmpdir(), "autobuild-guard-fd-"));
writeFileSync(path.join(root, "autobuild.json"), JSON.stringify({ frozen: ["tests", "spec", "SPEC.md", "CLAUDE.md", ".claude", ".env*"], writable: ["PROGRESS.md", "DECISIONS.md"] }));

function decide(command) {
  const result = spawnSync(process.execPath, [GUARD], {
    input: JSON.stringify({ tool_name: "Bash", tool_input: { command } }),
    encoding: "utf8",
    env: { ...process.env, AUTOBUILD_ACTIVE: "1", HARNESS_ACTIVE: "", AUTOBUILD_ROLE: "builder", CLAUDE_PROJECT_DIR: root },
  });
  return result.stdout.includes('"deny"') ? "deny" : "allow";
}

test("redirects with an fd prefix, &> or >| into frozen or outside paths are denied", () => {
  const commands = [
    "echo x > tests/foo.test.ts",
    "echo x 1>tests/foo.test.ts",
    "echo x 1> tests/foo.test.ts",
    "some-cmd &> tests/foo.test.ts",
    "some-cmd 2> tests/foo.test.ts",
    "echo x >| tests/foo.test.ts",
    "echo 'alias a=b' 1> ~/.bashrc",
  ];
  const allowed = commands.filter((command) => decide(command) !== "deny");
  assert.deepEqual(allowed, [], `BUGHUNT-F2 redirects into frozen/outside-project files were allowed: ${JSON.stringify(allowed)}`);
});
