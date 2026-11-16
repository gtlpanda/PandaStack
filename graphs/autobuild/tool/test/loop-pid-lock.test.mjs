// A stale loop.pid whose pid now belongs to an unrelated live process must not block the loop.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";

import { isOurs } from "../../../build/skills/build-app/driver/proc.mjs";
import { project, run } from "../test-fixtures/project.mjs";

const PROC_URL = new URL("../../../build/skills/build-app/driver/proc.mjs", import.meta.url).href;

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

test("isOurs reads a live pid's command line on every platform, and keeps the lock when it cannot", async () => {
  const marker = `autobuild-isours-${process.pid}-${Date.now()}`;
  const ours = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)", marker], { stdio: "ignore" });
  try {
    await new Promise((resolve, reject) => {
      ours.once("spawn", resolve);
      ours.once("error", reject);
    });
    assert.equal(isOurs(ours.pid, marker), true, "a live process whose command line carries the marker");
    assert.equal(isOurs(process.pid, marker), false, "a live process without the marker");
    assert.equal(isOurs(999999999, marker), false, "a pid that is not running");
    // With no ps (and no /proc) to read the command line, a live pid keeps the lock.
    const probe = `import { isOurs } from ${JSON.stringify(PROC_URL)}; process.stdout.write(String(isOurs(${process.pid}, ${JSON.stringify(marker)})));`;
    const blind = spawnSync(process.execPath, ["--input-type=module", "-e", probe], { env: { PATH: "" }, encoding: "utf8" });
    const expected = existsSync("/proc/self/cmdline") ? "false" : "true";
    assert.equal(blind.stdout, expected, blind.stderr);
  } finally {
    ours.kill("SIGKILL");
  }
});
