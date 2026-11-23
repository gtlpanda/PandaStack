// ci-optimizer CO-07 regression (bug hunt F2): `ci validate` refuses an unusable state home before
// the gate runs, instead of running the whole gate and then losing its verdict when the validation
// record cannot be written. Offline: throwaway git repos with a private state home each.
import assert from "node:assert/strict";
import { test } from "node:test";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { CLI } from "../test-fixtures/project.mjs";

const GIT_ENV = {
  GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", LANG: "C",
  GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.invalid", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.invalid",
};

function git(cwd, ...args) {
  const r = spawnSync("git", ["-c", "init.defaultBranch=main", ...args], { cwd, env: { ...process.env, ...GIT_ENV }, encoding: "utf8" });
  assert.equal(r.status, 0, `git ${args.join(" ")}: ${r.stderr}`);
}

/** A committed fixture repo whose single gate step touches `marker`, so a run is observable. */
function fixture(t) {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), "ci-validate-state-")));
  t.after(() => {
    // Restore write permission first, or the tests' read-only directories cannot be removed.
    spawnSync("chmod", ["-R", "u+rwx", dir]);
    rmSync(dir, { recursive: true, force: true });
  });
  const repo = path.join(dir, "repo");
  const marker = path.join(dir, "gate-ran");
  mkdirSync(repo);
  writeFileSync(path.join(repo, "autobuild.json"), `${JSON.stringify({ gate: [{ name: "lint", command: `touch ${JSON.stringify(marker)}` }], ciParityOptOut: "fixture" }, null, 2)}\n`);
  writeFileSync(path.join(repo, "features.json"), `${JSON.stringify({ schemaVersion: 1, features: [] })}\n`);
  writeFileSync(path.join(repo, "PROGRESS.md"), "# progress\n");
  writeFileSync(path.join(repo, ".gitignore"), "logs/\n.harness/\n");
  git(repo, "init", "-q");
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "fixture");
  return { dir, repo, marker };
}

function validate(repo, stateHome) {
  return spawnSync(process.execPath, [CLI, "ci", "validate", "--tier", "full", "--json"], {
    cwd: repo, encoding: "utf8", timeout: 120_000,
    env: { ...process.env, ...GIT_ENV, AUTOBUILD_STATE_HOME: stateHome },
  });
}

test("a state home below a regular file is STATE_IO before the gate runs", (t) => {
  const { dir, repo, marker } = fixture(t);
  // A regular file where a directory is needed: nothing under it can be created, even as root.
  const blocker = path.join(dir, "blocker");
  writeFileSync(blocker, "not a directory\n");
  const r = validate(repo, path.join(blocker, "state"));
  assert.equal(r.status, 3, r.stderr);
  assert.match(r.stderr, /STATE_IO: /);
  assert.equal(existsSync(marker), false, "the gate must not run when its record cannot be stored");
});

test("a state home in a read-only directory is STATE_IO before the gate runs", (t) => {
  if (process.getuid?.() === 0) return t.skip("root ignores directory write permission");
  const { dir, repo, marker } = fixture(t);
  const parent = path.join(dir, "ro-parent");
  mkdirSync(parent, { mode: 0o500 });
  const r = validate(repo, path.join(parent, "state"));
  assert.equal(r.status, 3, r.stderr);
  assert.match(r.stderr, /STATE_IO: cannot create state directory/);
  assert.equal(existsSync(marker), false, "the gate must not run when its record cannot be stored");
});

test("a state home that exists but is not writable is STATE_IO before the gate runs", (t) => {
  if (process.getuid?.() === 0) return t.skip("root ignores directory write permission");
  const { dir, repo, marker } = fixture(t);
  const stateHome = path.join(dir, "ro");
  // The repo's state directory exists already, read-only, so only the writability check catches it.
  const first = validate(repo, stateHome);
  assert.equal(first.status, 0, first.stderr);
  rmSync(marker);
  const ciDir = path.join(stateHome, "autobuild", "ci");
  const [hash] = readdirSync(ciDir);
  const stateDir = path.join(ciDir, hash);
  chmodSync(stateDir, 0o500);
  const r = validate(repo, stateHome);
  assert.equal(r.status, 3, r.stderr);
  assert.match(r.stderr, /STATE_IO: cannot write state directory/);
  assert.equal(existsSync(marker), false, "the gate must not run when its record cannot be stored");
});

test("a usable state home still runs the gate and records the verdict", (t) => {
  const { dir, repo, marker } = fixture(t);
  const r = validate(repo, path.join(dir, "state"));
  assert.equal(r.status, 0, r.stderr);
  assert.equal(JSON.parse(r.stdout).ok, true);
  assert.equal(existsSync(marker), true);
});
