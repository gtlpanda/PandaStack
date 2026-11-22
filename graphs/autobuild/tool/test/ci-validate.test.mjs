// ci-optimizer CO-07 implementation tests: the edges the frozen acceptance file does not pin
// (option-like and history-less base refs, deleted and custom CI files, a nested progress file,
// the gate's dead-glob rule in the plan, unknown tiers, linked state, a repo without commits,
// and the human SKIP line), plus the `autobuild check` output after its step lines moved into
// gate.mjs. Offline: throwaway git repos and a private AUTOBUILD_STATE_HOME per test.
import assert from "node:assert/strict";
import { test } from "node:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { CLI } from "../test-fixtures/project.mjs";
import { loadConfig } from "../lib/config.mjs";
import { gateStepLines, pathEntries, selectByPaths } from "../lib/gate.mjs";
import { ciStateDir } from "../lib/ci/state.mjs";
import { planValidation, recordValidation, resolveBase, treeState } from "../lib/ci/validate.mjs";

const GIT_ENV = {
  GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", LANG: "C",
  GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.invalid", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.invalid",
};

function tempDir(t, prefix = "ci-validate-") {
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

/** An autobuild project on main (committed unless `commit` is false), with a work branch checked out. */
function project(t, { config = {}, files = {}, commit = true } = {}) {
  const repo = tempDir(t);
  writeFiles(repo, {
    "autobuild.json": {
      gate: [{ name: "api", command: "true", paths: ["api"] }, { name: "lint", command: "true" }],
      ciParityOptOut: "implementation test",
      ...config,
    },
    "features.json": { schemaVersion: 1, features: [] },
    "PROGRESS.md": "# progress\n",
    ".gitignore": "logs/\n.harness/\n",
    "api/x.js": "base\n",
    ...files,
  });
  git(repo, "init", "-q");
  if (commit) {
    git(repo, "add", "-A");
    git(repo, "commit", "-q", "-m", "fixture");
    git(repo, "checkout", "-q", "-b", "work");
  }
  return repo;
}

function runCli(cwd, args, stateHome) {
  const r = spawnSync(process.execPath, [CLI, ...args], { cwd, encoding: "utf8", env: { ...process.env, ...GIT_ENV, AUTOBUILD_STATE_HOME: stateHome }, timeout: 120_000 });
  return { code: r.status, stdout: r.stdout, stderr: r.stderr };
}

const plan = (repo, changed, extra = {}) => planValidation({ config: loadConfig(repo, {}), root: repo, changed, tier: "fast", ...extra });

test("resolveBase: an option-like ref, an unknown ref and a ref with no shared history all give null", (t) => {
  const repo = project(t);
  const config = loadConfig(repo, {});
  assert.equal(resolveBase(config, "-h"), null, "a value starting with - is never passed to git as an option");
  assert.equal(resolveBase(config, "--all"), null);
  assert.equal(resolveBase(config, "no-such-branch"), null);
  assert.equal(resolveBase(config, ""), null);
  git(repo, "checkout", "-q", "--orphan", "island");
  git(repo, "commit", "-q", "-m", "unrelated");
  assert.equal(resolveBase(config, "main"), null, "main resolves but shares no history with HEAD");
  assert.equal(resolveBase(config), null, "the default refs give nothing either");
});

test("planValidation: a deleted CI file and a custom gitlabFile path count as CI configuration changes", (t) => {
  const repo = project(t);
  // .gitlab-ci.yml does not exist (deleted), so ciFiles(root) does not list it.
  assert.ok(plan(repo, [".gitlab-ci.yml"]).reasons.includes("CI_CONFIG_CHANGED:.gitlab-ci.yml"));
  assert.ok(plan(repo, ["Jenkinsfile"]).reasons.includes("CI_CONFIG_CHANGED:Jenkinsfile"));
  assert.deepEqual(plan(repo, ["api/ci/pipeline.yml"]).reasons, [], "without gitlabFile a mapped yml is ordinary");
  assert.deepEqual(plan(repo, ["api/ci/pipeline.yml"], { gitlabFile: "./api/ci/pipeline.yml" }).reasons, ["CI_CONFIG_CHANGED:api/ci/pipeline.yml"]);
  // Look-alikes outside .github/ are not CI configuration.
  assert.deepEqual(plan(repo, ["api/.github-notes.md", "api/github/x.yml"]).reasons, []);
  // Object prototype names are paths like any other, never CI files.
  for (const name of ["constructor", "toString", "__proto__", "hasOwnProperty"]) {
    assert.deepEqual(plan(repo, [name]).reasons, [`UNMAPPED_CHANGE:${name}`], `${name} is an unmapped file, not a CI file`);
  }
});

test("planValidation: a nested progress file and features file are exempt; other files beside them are not", (t) => {
  const repo = project(t, { config: { progressFile: "docs/PROGRESS.md", featuresFile: "docs/features.json" }, files: { "docs/PROGRESS.md": "# p\n", "docs/features.json": { schemaVersion: 1, features: [] } } });
  assert.deepEqual(plan(repo, ["docs/PROGRESS.md", "docs/features.json"]).reasons, []);
  assert.deepEqual(plan(repo, ["PROGRESS.md"]).reasons, ["UNMAPPED_CHANGE:PROGRESS.md"], "the default name is not exempt once progressFile moved");
});

test("planValidation: the plan follows the gate's dead-glob rule (a glob matching no file runs) and lists every reason for overlaps", (t) => {
  const repo = project(t, { config: { gate: [{ name: "api", command: "true", paths: ["api"] }, { name: "typo", command: "true", paths: ["srcc/**"] }, { name: "lint", command: "true" }] } });
  const p = plan(repo, ["api/x.js"]);
  assert.equal(p.tier, "fast");
  assert.deepEqual(p.steps.run, ["api", "typo", "lint"], "typo's glob matches nothing, so the gate runs it and the plan says so");
  assert.deepEqual(p.steps.skip, []);
  assert.deepEqual(plan(repo, ["autobuild.json"]).reasons, ["AUTOBUILD_CONFIG_CHANGED", "UNMAPPED_CHANGE:autobuild.json"]);
  assert.deepEqual(plan(repo, ["api/package.json", "api/package-lock.json"]).reasons, ["LOCKFILE_CHANGED:api/package-lock.json", "MANIFEST_CHANGED:api/package.json"]);
});

test("planValidation: null change means NO_BASE alongside NO_PATHS_DECLARED; an unknown tier throws", (t) => {
  const repo = project(t, { config: { gate: [{ name: "lint", command: "true" }] } });
  assert.deepEqual(plan(repo, null).reasons, ["NO_BASE", "NO_PATHS_DECLARED"]);
  assert.deepEqual(plan(repo, ["x.js"]).reasons, ["NO_PATHS_DECLARED", "UNMAPPED_CHANGE:x.js"]);
  assert.throws(() => plan(repo, [], { tier: "quick" }), /unknown validation tier/);
});

test("pathEntries and selectByPaths: every scope with paths counts, and a null change selects everything", () => {
  const config = { gate: [{ name: "a", paths: ["a"] }, { name: "b" }], runners: { node: { paths: ["n/**"] } }, browser: { paths: ["e2e"] }, ciParity: { paths: [".ci"] } };
  assert.deepEqual(pathEntries(config).map((entry) => entry.paths[0]), ["a", "n/**", "e2e", ".ci"]);
  assert.deepEqual(pathEntries({}), []);
  const jobs = [{ name: "a", paths: ["a"], spec: {} }];
  assert.deepEqual(selectByPaths(config, jobs, null), { selected: jobs, skipped: [], warnings: [] });
});

test("recordValidation: an unknown tier throws before writing; a linked validation.json is refused", (t) => {
  const repo = project(t);
  const home = tempDir(t, "ci-validate-state-");
  const env = { AUTOBUILD_STATE_HOME: home };
  assert.throws(() => recordValidation(repo, { tier: "quick" }, env), /unknown tier/);
  assert.equal(existsSync(path.join(home, "autobuild")), false, "nothing was written");
  const dir = ciStateDir(repo, env);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const elsewhere = path.join(home, "elsewhere.json");
  writeFileSync(elsewhere, "{}");
  symlinkSync(elsewhere, path.join(dir, "validation.json"));
  assert.throws(() => recordValidation(repo, { tier: "fast", ok: true }, env), (error) => error.code === "STATE_UNSAFE");
  assert.equal(readFileSync(elsewhere, "utf8"), "{}", "the link target is untouched");
});

test("treeState: a repository without commits has head null and is dirty", (t) => {
  const repo = project(t, { commit: false });
  assert.deepEqual(treeState(loadConfig(repo, {})), { head: null, dirty: true });
});

test("ci validate: an option-like --base escalates with NO_BASE; the fast tier prints the gate's SKIP line", (t) => {
  const repo = project(t, { config: { gate: [{ name: "api", command: "true", paths: ["api"] }, { name: "web", command: "true", paths: ["web"] }, { name: "lint", command: "true" }] }, files: { "web/a.js": "w\n" } });
  const home = tempDir(t, "ci-validate-state-");
  const escalated = runCli(repo, ["ci", "validate", "--base", "-h"], home);
  assert.equal(escalated.code, 0, escalated.stderr);
  assert.equal(escalated.stdout.split("\n")[0], "validation tier: full (escalated: NO_BASE)");

  writeFiles(repo, { "api/x.js": "changed\n" });
  const fast = runCli(repo, ["ci", "validate"], home);
  const lines = fast.stdout.trim().split("\n");
  assert.equal(fast.code, 0, fast.stderr);
  assert.ok(lines.includes("SKIP  web: skipped (no path match)"), fast.stdout);
  assert.ok(lines.some((line) => /^PASS {2}api \(/.test(line)) && lines.some((line) => /^PASS {2}lint \(/.test(line)), fast.stdout);
  assert.equal(lines.at(-1), "VALIDATION: PASS (fast tier, not merge validation)");
});

test("ci validate: a linked state directory is refused (exit 3) before any gate step runs", (t) => {
  const marker = path.join(tempDir(t, "ci-validate-calls-"), "ran");
  const repo = project(t, { config: { gate: [{ name: "lint", command: `touch '${marker}'` }] } });
  const home = tempDir(t, "ci-validate-state-");
  const dir = ciStateDir(repo, { AUTOBUILD_STATE_HOME: home });
  mkdirSync(path.dirname(dir), { recursive: true });
  symlinkSync(tempDir(t, "ci-validate-elsewhere-"), dir);
  const run = runCli(repo, ["ci", "validate", "--json"], home);
  assert.equal(run.code, 3, run.stderr);
  assert.equal(JSON.parse(run.stdout).error, "STATE_UNSAFE");
  assert.equal(existsSync(marker), false, "the gate did not run");
});

test("autobuild check: step lines are unchanged after moving to gateStepLines", (t) => {
  const repo = project(t, { config: { gate: [{ name: "ok step", command: "true" }, { name: "bad step", command: "echo boom; exit 3" }, { name: "later", command: "true" }] } });
  const home = tempDir(t, "ci-validate-state-");
  const run = runCli(repo, ["check", "--fail-fast"], home);
  assert.equal(run.code, 1);
  const lines = run.stdout.split("\n");
  assert.match(lines[0], /^PASS {2}ok step \(\d+s\)$/);
  assert.match(lines[1], /^FAIL {2}bad step \(\d+s\)$/);
  assert.ok(lines.includes("----  later: not run (stopped at the first failure)"), run.stdout);
  assert.ok(lines.includes("GATE: FAIL"), run.stdout);
  assert.deepEqual(gateStepLines({ steps: [{ name: "s", ok: true, seconds: 0, cached: true, cachedFrom: "abc" }], skipped: [{ name: "k", reason: "r" }], notRun: [], warnings: ["w"] }), ["PASS  s (reused from abc, tree unchanged)", "SKIP  k: r", "WARN  w"]);
});
