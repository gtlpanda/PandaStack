// `autobuild run` inside Codex, in a project whose autobuild.json chose its own backend: an unrelated config
// error must not be blamed on the host-derived default backend.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

const CLI = path.resolve(import.meta.dirname, "..", "lib", "cli.mjs");

test("autobuild run: a bad commitGate in a project that sets backend is not blamed on the host default", () => {
  const root = mkdtempSync(path.join(tmpdir(), "autobuild-hint-"));
  try {
    writeFileSync(path.join(root, "autobuild.json"), JSON.stringify({ backend: "claude", commitGate: "not-an-array" }));
    const env = { ...process.env, PANDASTACK_PROVIDER: "codex" };
    delete env.AUTOBUILD_BACKEND;
    const result = spawnSync(process.execPath, [CLI, "run"], { cwd: root, env, encoding: "utf8" });
    const output = `${result.stdout}${result.stderr}`;
    assert.match(output, /commitGate must be an array of named commands/, `the commitGate error should be reported: ${output}`);
    assert.doesNotMatch(output, /took "codex" as its default/, `the host-backend hint is appended although autobuild.json chose the backend and the error is about commitGate: ${output}`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
