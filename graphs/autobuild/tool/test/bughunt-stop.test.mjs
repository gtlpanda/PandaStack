// A stop request (SIGTERM / Ctrl-C) that arrives while the hunt's landing checks run must be honoured:
// exit 130, nothing landed, the fix branch kept (lib/bughunt.mjs asks stopped() after landHunt).
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { CLI, loopEnv, project } from "../test-fixtures/project.mjs";

const git = (root, ...args) => execFileSync("git", ["-C", root, ...args], { encoding: "utf8" }).trim();

test("a stop requested during the hunt's landing checks exits 130 and lands nothing", async () => {
  const root = project(["F-1"]);
  git(root, "branch", "main");
  // The unit runner passes, but when it runs with HEAD detached (the landing verify checks the fix
  // branch out detached) it first sends the loop a SIGTERM, as a user's `kill` or Ctrl-C would.
  const file = path.join(root, "autobuild.json");
  const config = JSON.parse(readFileSync(file, "utf8"));
  config.runners.unit.command = `bash -c 'git symbolic-ref -q HEAD >/dev/null || kill -TERM $(cat "${root}/.harness/loop.pid"); for f in "$@"; do id=$(basename "$f" .test); test -f "$id.done" || exit 1; done' _`;
  writeFileSync(file, JSON.stringify(config, null, 2));
  git(root, "commit", "-qam", "runner signals the loop during the landing verify");
  const before = git(root, "rev-parse", "HEAD");

  const scriptFile = path.join(root, ".harness-script.json");
  const step = { hunt: "done", commits: [{ subject: "bughunt: fix F1", files: { "src/a.js": "fixed\n" } }], findings: [{ status: "reproduced", fix: "verified" }] };
  writeFileSync(scriptFile, JSON.stringify([{ build: "F-1" }, step]));
  const loop = spawn(process.execPath, [CLI, "run"], { cwd: root, env: { ...loopEnv(scriptFile), AUTOBUILD_BUGHUNT: "1" }, stdio: "ignore" });
  const code = await new Promise((resolve) => {
    const timer = setTimeout(() => loop.kill("SIGKILL"), 100_000);
    loop.on("close", (c, signal) => {
      clearTimeout(timer);
      resolve(c ?? signal);
    });
  });

  const landed = git(root, "log", "--format=%s", `${before}..HEAD`);
  assert.equal(landed.includes("bughunt: fix F1"), false, `BUGHUNT-F6 fixes were landed after the stop request:\n${landed}`);
  assert.equal(code, 130, `BUGHUNT-F6 a stop during the hunt's landing checks was dropped (exit ${code}, not 130)`);
  assert.equal(git(root, "rev-parse", "--abbrev-ref", "HEAD"), "autobuild", "the stop leaves the build branch checked out, not the hunt's detached fix commit");
  assert.match(git(root, "branch", "--list", "attempt/bughunt-*"), /attempt\/bughunt-/, "the hunt's branch is kept");
});
