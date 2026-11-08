// The hunt session's guard rules file (HARNESS_BUILD_GUARD) must not be a file the session can use to
// switch its own guard off: either the guard denies writing to it, or a corrupted file still denies.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { project, run } from "../test-fixtures/project.mjs";

const HOOK = path.resolve(import.meta.dirname, "..", "..", "..", "build", "skills", "build-app", "driver", "hooks", "guard.mjs");

function verdict(guardFile, tool, input) {
  const r = spawnSync(process.execPath, [HOOK], {
    input: JSON.stringify({ tool_name: tool, tool_input: input }),
    encoding: "utf8",
    env: { ...process.env, HARNESS_BUILD_ACTIVE: "1", HARNESS_BUILD_GUARD: guardFile },
  });
  return r.stdout.includes('"deny"') ? "deny" : "allow";
}

test("a hunt session cannot disable its own guard by overwriting the guard rules file", () => {
  const root = project(["F-1"]);
  execFileSync("git", ["-C", root, "branch", "main"]);
  const r = run(root, [{ build: "F-1" }, { hunt: "done" }], { AUTOBUILD_BUGHUNT: "1" });
  assert.equal(r.code, 0, r.out);
  const huntCalls = readFileSync(path.join(root, ".harness-script.json.hunt.calls"), "utf8").trim().split("\n").map((line) => JSON.parse(line));
  const huntCall = huntCalls.find((call) => call.env && call.env.HARNESS_BUILD_GUARD);
  assert.ok(huntCall, "the hunt session was started with a guard file");
  const guardFile = huntCall.env.HARNESS_BUILD_GUARD;

  // Sanity: the guard is live and denies a push.
  assert.equal(verdict(guardFile, "Bash", { command: "git push origin main" }), "deny");

  // The session's Write to the rules file: if the guard lets it through, apply it as the tool would.
  const write = verdict(guardFile, "Write", { file_path: guardFile, content: "x" });
  if (write === "allow") writeFileSync(guardFile, "x");

  const after = verdict(guardFile, "Bash", { command: "git push origin main" });
  assert.equal(after, "deny", "BUGHUNT-F14 the session overwrote its guard rules file and the guard now allows git push");
});
