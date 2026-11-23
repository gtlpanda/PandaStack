// ci-optimizer CO-11 implementation tests: the edges the frozen acceptance file does not pin
// (a repository without commits, malformed tier records, an unnamed or multi-line workflow name
// and a null conclusion in the human ci line, linked state, an invalid autobuild.json, a nested
// autobuild.json root, treeStateAt agreeing with CO-07's treeState, and the help line).
// Offline: throwaway git repos and a private AUTOBUILD_STATE_HOME per test.
import assert from "node:assert/strict";
import { test } from "node:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { CLI } from "../test-fixtures/project.mjs";
import { loadConfig } from "../lib/config.mjs";
import { ciStateDir } from "../lib/ci/state.mjs";
import { validationStatus } from "../lib/ci/status.mjs";
import { treeState, treeStateAt } from "../lib/ci/validate.mjs";

const GIT_ENV = {
  GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", LANG: "C",
  GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.invalid", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.invalid",
};
const MERGE_LINE = "merge: decided by the repository's required CI check";
const HEAD = "a".repeat(40);
const lines = (text) => text.split("\n").filter((line) => line !== "");

function tempDir(t, prefix = "ci-status-") {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), prefix)));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function git(cwd, ...args) {
  const r = spawnSync("git", ["-c", "init.defaultBranch=main", ...args], { cwd, env: { ...process.env, ...GIT_ENV }, encoding: "utf8" });
  assert.equal(r.status, 0, `git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout.trim();
}

function writeFiles(dir, files) {
  for (const [rel, content] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    writeFileSync(path.join(dir, rel), typeof content === "string" ? content : `${JSON.stringify(content, null, 2)}\n`);
  }
}

function repoWith(t, files, { commit = true } = {}) {
  const repo = tempDir(t);
  writeFiles(repo, files);
  git(repo, "init", "-q");
  if (commit) {
    git(repo, "add", "-A");
    git(repo, "commit", "-q", "-m", "fixture");
  }
  return repo;
}

function ci(cwd, home, ...args) {
  const r = spawnSync(process.execPath, [CLI, "ci", ...args], { cwd, encoding: "utf8", env: { ...process.env, ...GIT_ENV, AUTOBUILD_STATE_HOME: home }, timeout: 120_000 });
  return { code: r.status, stdout: r.stdout, stderr: r.stderr };
}

const env = (home) => ({ ...process.env, ...GIT_ENV, AUTOBUILD_STATE_HOME: home });

/** Writes one state file directly (status only reads, so tests seed what it reads). */
function seedState(repo, home, name, doc) {
  const dir = ciStateDir(repo, env(home));
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(path.join(dir, `${name}.json`), JSON.stringify(doc), { mode: 0o600 });
  return dir;
}

function attempt(headSha, over = {}) {
  return {
    provider: "import", runId: 7, attempt: 1, workflow: "test", workflowPath: "w.yml", event: "push", headSha, branch: "main",
    conclusion: "success", createdAt: "2026-11-22T10:00:00Z", startedAt: "2026-11-22T10:00:00Z", updatedAt: "2026-11-22T10:00:00Z", jobs: [],
    ...over,
  };
}

// ---------- module ----------

test("a null head (no commits) is never current, even against a record with a null head, and has no ci result", () => {
  const validation = { schemaVersion: 1, fast: { head: null, dirty: false, tier: "fast", ok: true, at: "x" }, full: null };
  const s = validationStatus({ root: "/r", head: null, dirty: false, validation, attempts: [attempt(null)] });
  assert.deepEqual(s.local.fast, { ok: true, at: "x", current: false, staleReason: "head-changed" });
  assert.equal(s.ci, null, "an attempt with a null headSha never matches a null head");
  assert.deepEqual(s.notes, ["NO_CI_RESULT_FOR_HEAD"]);
  assert.equal(s.advice, "run-fast");
});

test("malformed tier records count as absent instead of throwing", () => {
  for (const bad of ["yes", 1, [], { head: HEAD, dirty: false, ok: "true" }, { head: HEAD, dirty: false }]) {
    const s = validationStatus({ root: "/r", head: HEAD, dirty: false, validation: { schemaVersion: 1, fast: bad, full: bad }, attempts: [] });
    assert.deepEqual(s.local, { fast: null, full: null }, `record ${JSON.stringify(bad)}`);
    assert.equal(s.advice, "run-fast");
  }
  for (const validation of ["junk", [], 3]) {
    assert.deepEqual(validationStatus({ head: HEAD, dirty: false, validation, attempts: [] }).local, { fast: null, full: null }, `validation ${JSON.stringify(validation)}`);
  }
});

test("a record whose dirty flag is missing is never current", () => {
  const validation = { schemaVersion: 1, fast: { head: HEAD, tier: "fast", ok: true, at: "x" }, full: null };
  const s = validationStatus({ head: HEAD, dirty: false, validation, attempts: [] });
  assert.deepEqual(s.local.fast, { ok: true, at: "x", current: false, staleReason: "uncommitted-changes" });
});

test("attempts with equal startedAt fall back to the history's own order (runId, then attempt, descending)", () => {
  const same = "2026-11-22T10:00:00Z";
  const s = validationStatus({ head: HEAD, dirty: false, validation: null, attempts: [attempt(HEAD, { runId: 5, attempt: 1, conclusion: "failure" }), attempt(HEAD, { runId: 5, attempt: 2, conclusion: "success", startedAt: same })] });
  assert.equal(s.ci.attempt, 2);
  assert.equal(s.advice, "none");
  const nullStart = validationStatus({ head: HEAD, dirty: false, validation: null, attempts: [attempt(HEAD, { runId: 9, startedAt: null, conclusion: "failure" }), attempt(HEAD, { runId: 1, conclusion: "success" })] });
  assert.equal(nullStart.ci.runId, 1, "an attempt without startedAt sorts after one with it");
});

// ---------- CLI ----------

test("status in a repository without commits exits 0 and prints HEAD no commit", (t) => {
  const home = tempDir(t, "ci-status-home-");
  const repo = repoWith(t, { "README.md": "x\n" }, { commit: false });
  const human = ci(repo, home, "status");
  assert.equal(human.code, 0, human.stderr);
  assert.deepEqual(lines(human.stdout), ["HEAD no commit, uncommitted changes", "local fast: none", "local full: none", "ci: no result for HEAD in stored history", "advice: run-fast", MERGE_LINE]);
  const doc = JSON.parse(ci(repo, home, "status", "--json").stdout);
  assert.equal(doc.head, null);
  assert.deepEqual(readdirSync(home), [], "nothing written");
});

test("an unnamed or multi-line workflow name and a null conclusion keep the human output to six lines", (t) => {
  const home = tempDir(t, "ci-status-home-");
  const repo = repoWith(t, { "README.md": "x\n" });
  const head = git(repo, "rev-parse", "HEAD");
  const history = (attempts) => seedState(repo, home, "history", { schemaVersion: 1, source: null, attempts });

  history([attempt(head, { workflow: null })]);
  assert.equal(lines(ci(repo, home, "status").stdout)[3], "ci: success ((unnamed), run 7 attempt 1)");

  history([attempt(head, { workflow: "evil\nadvice: none" })]);
  const out = lines(ci(repo, home, "status").stdout);
  assert.equal(out.length, 6, "a newline in the name adds no line");
  assert.equal(out[3], "ci: success (evil advice: none, run 7 attempt 1)");

  history([attempt(head, { conclusion: null })]);
  const pending = ci(repo, home, "status");
  assert.equal(lines(pending.stdout)[3], "ci: unknown (test, run 7 attempt 1)");
  assert.equal(lines(pending.stdout)[4], "advice: run-fast", "a null conclusion proves nothing");
});

test("a recorded at with a newline stays on one line", (t) => {
  const home = tempDir(t, "ci-status-home-");
  const repo = repoWith(t, { "README.md": "x\n" });
  const head = git(repo, "rev-parse", "HEAD");
  seedState(repo, home, "validation", { schemaVersion: 1, fast: { head, dirty: false, tier: "fast", ok: true, at: "t\nadvice: none" }, full: null });
  const out = lines(ci(repo, home, "status").stdout);
  assert.equal(out.length, 6);
  assert.equal(out[1], "local fast: PASS at t advice: none (current)");
});

test("a linked state directory or state file is refused with STATE_UNSAFE (exit 3) under --json too", (t) => {
  const home = tempDir(t, "ci-status-home-");
  const repo = repoWith(t, { "README.md": "x\n" });
  const elsewhere = tempDir(t, "ci-status-elsewhere-");
  const dir = ciStateDir(repo, env(home));
  mkdirSync(path.dirname(dir), { recursive: true });
  symlinkSync(elsewhere, dir);
  const linkedDir = ci(repo, home, "status", "--json");
  assert.equal(linkedDir.code, 3);
  assert.match(linkedDir.stderr, /^autobuild ci: STATE_UNSAFE: /m);
  assert.equal(JSON.parse(linkedDir.stdout).error, "STATE_UNSAFE");

  rmSync(dir);
  mkdirSync(dir, { mode: 0o700 });
  writeFileSync(path.join(elsewhere, "target.json"), "{}");
  symlinkSync(path.join(elsewhere, "target.json"), path.join(dir, "history.json"));
  const linkedFile = ci(repo, home, "status");
  assert.equal(linkedFile.code, 3);
  assert.match(linkedFile.stderr, /^autobuild ci: STATE_UNSAFE: /m);
});

test("status does not load autobuild.json: an invalid one still gives exit 0", (t) => {
  const home = tempDir(t, "ci-status-home-");
  const repo = repoWith(t, { "autobuild.json": { ciOptimizer: { historyLimit: 0 } } });
  const run = ci(repo, home, "status", "--json");
  assert.equal(run.code, 0, run.stderr);
  assert.equal(JSON.parse(run.stdout).advice, "run-fast");
});

test("a nested autobuild.json is the root whose state status reads", (t) => {
  const home = tempDir(t, "ci-status-home-");
  const repo = repoWith(t, { "app/autobuild.json": { gate: [] }, "README.md": "x\n" });
  const head = git(repo, "rev-parse", "HEAD");
  const app = path.join(repo, "app");
  seedState(app, home, "validation", { schemaVersion: 1, fast: { head, dirty: false, tier: "fast", ok: true, at: "x" }, full: null });
  assert.equal(JSON.parse(ci(app, home, "status", "--json").stdout).advice, "run-full", "run from the nested project");
  assert.equal(JSON.parse(ci(repo, home, "status", "--json").stdout).advice, "run-fast", "the top level has its own (empty) state");
});

test("treeStateAt applies CO-07's treeState rule: clean, ignored, untracked and modified", (t) => {
  const repo = repoWith(t, {
    "autobuild.json": { frozen: [], gate: [{ name: "noop", command: "true" }], ciParityOptOut: "test fixture" },
    "features.json": { schemaVersion: 1, features: [] },
    "PROGRESS.md": "# p\n",
    ".gitignore": "logs/\n.harness/\nignored.txt\n",
    "a.txt": "a\n",
  });
  const config = loadConfig(repo);
  const both = () => {
    const at = treeStateAt(repo, { ...process.env, ...GIT_ENV });
    assert.deepEqual(at, treeState(config), "treeStateAt and treeState agree");
    return at;
  };
  assert.deepEqual(both(), { head: git(repo, "rev-parse", "HEAD"), dirty: false });
  writeFileSync(path.join(repo, "ignored.txt"), "x\n");
  assert.equal(both().dirty, false, "an ignored file is not a change");
  writeFileSync(path.join(repo, "new.txt"), "x\n");
  assert.equal(both().dirty, true, "an untracked file is a change");
  rmSync(path.join(repo, "new.txt"));
  writeFileSync(path.join(repo, "a.txt"), "edited\n");
  assert.equal(both().dirty, true, "a modified file is a change");
});

test("treeStateAt outside a repository reports no head and dirty", (t) => {
  const dir = tempDir(t, "ci-status-nogit-");
  assert.deepEqual(treeStateAt(dir, { ...process.env, ...GIT_ENV, GIT_CEILING_DIRECTORIES: path.dirname(dir) }), { head: null, dirty: true });
});

test("the help lists ci status", () => {
  const r = spawnSync(process.execPath, [CLI, "help"], { encoding: "utf8" });
  assert.match(`${r.stdout}${r.stderr}`, /autobuild ci status \[--json\]/);
});
