// A stale loop.pid whose pid now belongs to an unrelated live process must not block the loop.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";

import { project, run } from "../test-fixtures/project.mjs";

test("a stale loop.pid reused by an unrelated process does not block the loop", async () => {
  const root = project(["F-1"]);
  // An unrelated, live process stands in for a reused pid after a SIGKILL or reboot.
  const unrelated = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], { stdio: "ignore" });
  try {
    await new Promise((resolve, reject) => {
      unrelated.once("spawn", resolve);
      unrelated.once("error", reject);
    });
    mkdirSync(path.join(root, ".harness"), { recursive: true });
    writeFileSync(path.join(root, ".harness", "loop.pid"), String(unrelated.pid));

    const { code, loopLog } = run(root, [{ build: "F-1" }]);

    assert.doesNotMatch(loopLog, /another autobuild loop/, `BUGHUNT-F11 the loop refuses to start because pid ${unrelated.pid} is alive, although it is not an autobuild loop\n${loopLog}`);
    assert.notEqual(code, 11, `BUGHUNT-F11 autobuild run exits 11 for a stale pid file held by an unrelated process\n${loopLog}`);
  } finally {
    unrelated.kill("SIGKILL");
  }
});
