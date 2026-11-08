// cd into a project subdirectory stays allowed, even when that directory is frozen or the session is
// read-only (review role); only cd into .git, outside the project or a computed target is denied.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

const KIT = path.resolve(import.meta.dirname, "..");
const GUARD = path.join(KIT, "hooks", "guard.mjs");
const root = mkdtempSync(path.join(tmpdir(), "autobuild-guard-cd-"));
writeFileSync(path.join(root, "autobuild.json"), JSON.stringify({ frozen: ["tests", "spec", "SPEC.md", "CLAUDE.md", ".claude", ".env*"], writable: ["PROGRESS.md", "DECISIONS.md"] }));
mkdirSync(path.join(root, "packages", "api"), { recursive: true });
mkdirSync(path.join(root, "tests"), { recursive: true });

function decide(command, role) {
  const result = spawnSync(process.execPath, [GUARD], {
    input: JSON.stringify({ tool_name: "Bash", tool_input: { command } }),
    encoding: "utf8",
    env: { ...process.env, AUTOBUILD_ACTIVE: "1", HARNESS_ACTIVE: "", AUTOBUILD_ROLE: role, CLAUDE_PROJECT_DIR: root },
  });
  return result.stdout.includes('"deny"') ? "deny" : "allow";
}

test("review session may cd into a project subdirectory", () => {
  const decision = decide("cd packages/api && pnpm test", "review");
  assert.equal(decision, "allow", "BUGHUNT-F13 review session was denied `cd packages/api && pnpm test`");
});

test("builder may cd into a frozen directory to run a test", () => {
  const decision = decide("cd tests && pnpm vitest run A-1", "builder");
  assert.equal(decision, "allow", "BUGHUNT-F13 builder was denied `cd tests && pnpm vitest run A-1` (tests is frozen)");
});
