// A builder session that runs `autobuild mark-passed` but ends without a feat(<ID>) commit
// must not leave the feature counted as passing.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import { CLI, project, run } from "../test-fixtures/project.mjs";

test("a passes flag left uncommitted by the session is not counted as passing", () => {
  const root = project(["F-1"]);
  // A stand-in `claude` that flags F-1 as passing, then ends without committing anything.
  const bin = path.join(mkdtempSync(path.join(tmpdir(), "autobuild-fake-")), "claude-no-commit.mjs");
  writeFileSync(bin, [
    "#!/usr/bin/env node",
    'import { execFileSync } from "node:child_process";',
    'import { writeFileSync } from "node:fs";',
    'writeFileSync("F-1.done", "built");',
    'execFileSync(process.execPath, [process.env.AUTOBUILD_CLI, "mark-passed", "F-1"], { stdio: "ignore" });',
    'console.log(JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "done", num_turns: 1, total_cost_usd: 0.01, permission_denials: [] }));',
    "",
  ].join("\n"));
  chmodSync(bin, 0o755);

  const { code, loopLog } = run(root, [], { AUTOBUILD_CLAUDE_BIN: bin, AUTOBUILD_CLI: CLI });

  const committed = execFileSync("git", ["-C", root, "log", "--format=%s"], { encoding: "utf8" }).split("\n").some((line) => line.startsWith("feat(F-1):"));
  assert.equal(committed, false, "test setup: the session must not have committed F-1");
  assert.doesNotMatch(loopLog, /every feature passes\. Done\./, `BUGHUNT-F8 the loop reports done although F-1 has no feat(F-1) commit\n${loopLog}`);
  assert.notEqual(code, 0, `BUGHUNT-F8 the loop exits 0 with F-1 passing only in the uncommitted tree\n${loopLog}`);
});
