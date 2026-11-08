// The guard resolves write targets through symlinks, so a link cannot hide a frozen path.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

const GUARD = path.resolve(import.meta.dirname, "..", "hooks", "guard.mjs");
const root = mkdtempSync(path.join(tmpdir(), "autobuild-guard-link-"));
writeFileSync(path.join(root, "autobuild.json"), JSON.stringify({ frozen: ["tests", "SPEC.md", ".env*"], writable: ["PROGRESS.md"] }));
mkdirSync(path.join(root, "tests"));
symlinkSync("tests", path.join(root, "d"));

function decide(tool, input) {
  const result = spawnSync(process.execPath, [GUARD], {
    input: JSON.stringify({ tool_name: tool, tool_input: input }),
    encoding: "utf8",
    env: { ...process.env, AUTOBUILD_ACTIVE: "1", HARNESS_ACTIVE: "", AUTOBUILD_ROLE: "builder", CLAUDE_PROJECT_DIR: root },
  });
  return result.stdout.includes('"deny"') ? "deny" : "allow";
}

test("a write through a symlink to a frozen directory is denied", () => {
  assert.equal(decide("Write", { file_path: path.join(root, "tests", "x.test.js") }), "deny", "BUGHUNT-F5 control: direct frozen write must be denied");
  assert.equal(
    decide("Write", { file_path: path.join(root, "d", "x.test.js") }),
    "deny",
    "BUGHUNT-F5 Write through symlink d -> tests bypasses the frozen check (paths are resolved lexically, not with realpath)",
  );
});
