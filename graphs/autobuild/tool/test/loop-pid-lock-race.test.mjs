// Two loops taking over a stale loop.pid must not both run: a loop that read the stale pid must
// not delete a lock another loop took in the meantime.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import { CLI, project, run } from "../test-fixtures/project.mjs";

// Preloaded into the loop process. The first time the loop reads loop.pid (the stale one), the
// rival loop "wins the race": it replaces the file with its own live pid before the read returns.
const PRELOAD = `
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
const read = fs.readFileSync;
let fired = false;
fs.readFileSync = function (file, ...rest) {
  if (!fired && typeof file === "string" && file.endsWith("loop.pid")) {
    fired = true;
    const stale = read.call(this, file, ...rest);
    fs.writeFileSync(file, process.env.RIVAL_PID);
    return stale;
  }
  return read.call(this, file, ...rest);
};
syncBuiltinESMExports();
`;

const spawned = (child) => new Promise((resolve, reject) => {
  child.once("spawn", resolve);
  child.once("error", reject);
});

test("a loop taking over a stale loop.pid does not delete the lock a rival loop just took", async () => {
  const root = project(["F-1"]);
  const tmp = mkdtempSync(path.join(tmpdir(), "autobuild-pid-race-"));
  const preload = path.join(tmp, "preload.mjs");
  writeFileSync(preload, PRELOAD);

  // A dead pid for the stale file.
  const dead = spawn(process.execPath, ["-e", "0"], { stdio: "ignore" });
  await spawned(dead);
  await new Promise((resolve) => dead.once("exit", resolve));
  // The rival: a live process whose command line is this tool's cli.mjs, i.e. a running autobuild loop.
  const rival = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)", CLI], { stdio: "ignore" });
  try {
    await spawned(rival);
    mkdirSync(path.join(root, ".harness"), { recursive: true });
    const pidFile = path.join(root, ".harness", "loop.pid");
    writeFileSync(pidFile, String(dead.pid));

    const { code, loopLog, out } = run(root, [{ build: "F-1" }], {
      NODE_OPTIONS: `--import=${preload}`,
      RIVAL_PID: String(rival.pid),
    });

    assert.equal(code, 11, `BUGHUNT-F11 two loops run at once: the takeover deleted the lock rival loop ${rival.pid} had just taken\n${loopLog}`);
    assert.equal(readFileSync(pidFile, "utf8"), String(rival.pid), "BUGHUNT-F11 the rival loop's pid file was removed or overwritten");
  } finally {
    rival.kill("SIGKILL");
  }
});
