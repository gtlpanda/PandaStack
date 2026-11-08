// A loop session must not plant a git hook: it would run outside every guard check on the
// session's next allowed `git commit`.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

const GUARD = path.resolve(import.meta.dirname, "..", "hooks", "guard.mjs");
const root = mkdtempSync(path.join(tmpdir(), "autobuild-guard-githooks-"));
writeFileSync(path.join(root, "autobuild.json"), JSON.stringify({ frozen: ["tests", "SPEC.md", ".env*"], writable: ["PROGRESS.md"] }));
mkdirSync(path.join(root, ".git", "hooks"), { recursive: true });
mkdirSync(path.join(root, "tests"));

function decide(tool, input) {
  const result = spawnSync(process.execPath, [GUARD], {
    input: JSON.stringify({ tool_name: tool, tool_input: input }),
    encoding: "utf8",
    env: { ...process.env, AUTOBUILD_ACTIVE: "1", HARNESS_ACTIVE: "", AUTOBUILD_ROLE: "builder", CLAUDE_PROJECT_DIR: root },
  });
  return result.stdout.includes('"deny"') ? "deny" : "allow";
}

test("a builder cannot write a git hook", () => {
  assert.equal(decide("Write", { file_path: path.join(root, "tests", "x.test.js") }), "deny", "BUGHUNT-F5 control: direct frozen write must be denied");
  assert.equal(
    decide("Write", { file_path: ".git/hooks/pre-commit", content: "#!/bin/sh\ngit push\n" }),
    "deny",
    "BUGHUNT-F5 Write to .git/hooks/pre-commit is allowed, so a planted hook runs outside the guard on the next git commit",
  );
  assert.equal(
    decide("Bash", { command: "printf '#!/bin/sh\\ngit push\\n' > .git/hooks/pre-commit; chmod +x .git/hooks/pre-commit" }),
    "deny",
    "BUGHUNT-F5 Bash redirect into .git/hooks/pre-commit is allowed, so a planted hook runs outside the guard on the next git commit",
  );
});
