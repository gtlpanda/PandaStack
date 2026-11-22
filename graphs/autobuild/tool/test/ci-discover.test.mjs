// ci-optimizer CO-01 implementation tests: the edges the frozen acceptance file does not pin
// (root selection, config errors, state-name and state-path safety, unsized matrices, odd
// manifests). Offline: throwaway git repos and a private AUTOBUILD_STATE_HOME per test.
import assert from "node:assert/strict";
import { test } from "node:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { CLI } from "../test-fixtures/project.mjs";
import { ciFiles, ciProviderOf, CI_FILE_PROVIDERS } from "../lib/ci-parity.mjs";
import { ciStateDir, readState, writeState } from "../lib/ci/state.mjs";
import { ciPolicy } from "../lib/ci/policy.mjs";
import { discoverRepo, loadProfile } from "../lib/ci/discover.mjs";
import { ciMain, ciRoot } from "../lib/ci/command.mjs";

const GIT_ENV = {
  GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", LANG: "C",
  GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.invalid", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.invalid",
};

function tempDir(t, prefix = "ci-discover-") {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), prefix)));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function write(root, files) {
  for (const [rel, content] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    writeFileSync(path.join(root, rel), typeof content === "string" ? content : `${JSON.stringify(content, null, 2)}\n`);
  }
}

/** A git repo (not committed: discovery reads the working tree) holding `files`. */
function repo(t, files = {}, dir = tempDir(t)) {
  write(dir, files);
  const r = spawnSync("git", ["init", "-q", dir], { env: { ...process.env, ...GIT_ENV }, encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  return dir;
}

const stateEnv = (t) => ({ AUTOBUILD_STATE_HOME: tempDir(t, "ci-discover-state-") });

function cli(cwd, args, env) {
  const r = spawnSync(process.execPath, [CLI, "ci", ...args], { cwd, env: { ...process.env, ...GIT_ENV, ...env }, encoding: "utf8" });
  return { code: r.status, stdout: r.stdout, stderr: r.stderr };
}

/** ciMain in-process with captured streams. */
async function inProcess(cwd, args, env) {
  let stdout = "", stderr = "";
  const code = await ciMain(args, { cwd, env: { ...process.env, ...GIT_ENV, ...env }, out: { write: (s) => { stdout += s; } }, err: { write: (s) => { stderr += s; } } });
  return { code, stdout, stderr };
}

const workflow = (jobs) => `name: w\non: push\njobs:\n${jobs}`;

// ---------- root selection ----------

test("ci root: an autobuild.json in a subdirectory of the work tree is the root; one above the work tree is not", (t) => {
  const outer = tempDir(t);
  write(outer, { "autobuild.json": {} });   // above the git top level: ignored
  const top = repo(t, { "app/autobuild.json": {}, "app/src/x.js": "x\n", "other/y.txt": "y\n" }, path.join(outer, "repo"));
  assert.equal(ciRoot(path.join(top, "app", "src"), process.env), path.join(top, "app"), "autobuild.json inside the work tree wins");
  assert.equal(ciRoot(path.join(top, "other"), process.env), top, "the git top level when the nearest autobuild.json is outside the work tree");
});

// ---------- CLI errors ----------

test("ci CLI: usage errors print one JSON document under --json and nothing is written", async (t) => {
  const env = stateEnv(t);
  const dir = repo(t);
  for (const args of [["bogus", "--json"], ["--json"], ["discover", "extra", "--json"]]) {
    const r = await inProcess(dir, args, env);
    assert.equal(r.code, 2, `${args.join(" ")} exits 2`);
    assert.equal(JSON.parse(r.stdout).error, "USAGE", `${args.join(" ")}: one JSON error document on stdout`);
    assert.match(r.stderr, /^autobuild ci: USAGE: /, `${args.join(" ")}: stderr shape`);
  }
  const bare = await inProcess(dir, [], env);
  assert.equal(bare.code, 2, "no subcommand exits 2");
  assert.equal(bare.stdout, "", "without --json nothing goes to stdout");
  assert.deepEqual(readdirSync(env.AUTOBUILD_STATE_HOME), [], "usage errors write no state");
});

test("ci CLI: outside a git repository the --json error code is NOT_A_GIT_REPOSITORY", async (t) => {
  const dir = tempDir(t, "ci-discover-nogit-");
  const r = await inProcess(dir, ["discover", "--json"], { ...stateEnv(t), GIT_CEILING_DIRECTORIES: path.dirname(dir) });
  assert.equal(r.code, 2);
  assert.equal(r.stderr, "autobuild ci: not in a git repository\n");
  assert.deepEqual(JSON.parse(r.stdout), { error: "NOT_A_GIT_REPOSITORY", message: "not in a git repository" });
});

test("ci CLI: an invalid autobuild.json is CONFIG_INVALID (exit 2) naming the bad key", (t) => {
  const dir = repo(t, { "autobuild.json": { ciOptimizer: { historyLimit: 0 } } });
  const r = cli(dir, ["discover"], stateEnv(t));
  assert.equal(r.code, 2);
  assert.match(r.stderr, /^autobuild ci: CONFIG_INVALID: autobuild\.json: ciOptimizer\.historyLimit must be a whole number from 1 to 100$/m);
});

// ---------- state safety ----------

test("state: names that are not plain contract names are refused and nothing is written", (t) => {
  const env = stateEnv(t);
  const dir = repo(t);
  for (const name of ["../escape", "Profile", "", "a/b", "profile.json", null]) {
    assert.throws(() => writeState(dir, name, { schemaVersion: 1 }, env), (e) => e.code === "STATE_IO", `${JSON.stringify(name)} is refused`);
  }
  assert.ok(!existsSync(path.join(path.dirname(ciStateDir(dir, env)), "escape.json")), "no traversal write");
  assert.ok(!existsSync(ciStateDir(dir, env)), "a refused name creates no state directory");
  assert.throws(() => readState(dir, "../escape", env), (e) => e.code === "STATE_IO", "reads refuse it too");
});

test("state: a JSON array or scalar is treated as absent; a state path that is a regular file is STATE_UNSAFE", (t) => {
  const env = stateEnv(t);
  const dir = repo(t);
  writeState(dir, "history", { schemaVersion: 1 }, env);
  const file = path.join(ciStateDir(dir, env), "history.json");
  for (const junk of ["[1]", "1", "null", '"x"']) {
    writeFileSync(file, junk);
    assert.equal(readState(dir, "history", env), null, `${junk} reads as absent`);
  }
  const other = repo(t);
  const stateDir = ciStateDir(other, env);
  mkdirSync(path.dirname(stateDir), { recursive: true });
  writeFileSync(stateDir, "not a directory");
  assert.throws(() => readState(other, "profile", env), (e) => e.code === "STATE_UNSAFE" && /STATE_UNSAFE/.test(e.message));
  assert.throws(() => writeState(other, "profile", { schemaVersion: 1 }, env), (e) => e.code === "STATE_UNSAFE");
});

test("loadProfile: a root reached through a symlink shares the real root's state and stored profile", async (t) => {
  const env = stateEnv(t);
  const dir = repo(t, { "go.mod": "module x\n" });
  const link = path.join(tempDir(t), "link");
  symlinkSync(dir, link);
  assert.equal((await loadProfile(dir, { env })).reused, false);
  assert.equal((await loadProfile(link, { env })).reused, true, "same realpath, same digest: reused");
  assert.deepEqual(readdirSync(path.dirname(ciStateDir(dir, env))), [path.basename(ciStateDir(dir, env))], "one state directory");
});

test("loadProfile: without a config argument the gate is read from autobuild.json", async (t) => {
  const env = stateEnv(t);
  const dir = repo(t, { "autobuild.json": { gate: [{ name: "unit", command: "node --test", shardWeight: 2 }] } });
  const { profile } = await loadProfile(dir, { env });
  assert.deepEqual(profile.gate, {
    concurrency: 1, cache: false, order: "config",
    steps: [{ name: "unit", command: "node --test", paths: null, resources: null, shardable: false, shardWeight: 2 }],
  });
});

// ---------- workflow models ----------

test("workflow: a matrix with no list-valued key, or an expression-valued key, has matrixSize null with its reason", async (t) => {
  const dir = repo(t, {
    ".github/workflows/m.yml": workflow(`  inc:
    runs-on: ubuntu-latest
    strategy:
      matrix:
        include:
          - os: a
          - os: b
    steps:
      - run: echo
  expr:
    runs-on: ubuntu-latest
    strategy:
      matrix:
        os: \${{ fromJson(needs.x.outputs.os) }}
        node: [1, 2]
    steps:
      - run: echo
`),
  });
  const profile = await discoverRepo(dir);
  const [inc, expr] = profile.ci.workflows[0].jobs;
  assert.equal(inc.matrixSize, null, "include-only matrix is not guessed");
  assert.equal(expr.matrixSize, null, "a dimension given as an expression is not guessed");
  assert.ok(profile.unknowns.includes("MATRIX_UNSIZED:.github/workflows/m.yml#inc"));
  assert.ok(profile.unknowns.includes("MATRIX_EXPRESSION:.github/workflows/m.yml#expr"));
});

test("workflow: a file without jobs is unparsed and its error names the file once; the other file is still modeled", async (t) => {
  const dir = repo(t, {
    ".github/workflows/a.yml": "name: a\non: push\n",
    ".github/workflows/b.yml": workflow("  x:\n    runs-on: ubuntu-latest\n    strategy:\n      matrix: ${{ fromJson('[]') }}\n"),
  });
  const profile = await discoverRepo(dir);
  const github = profile.ci.providers.find((p) => p.id === "github");
  assert.equal(github.status, "unparsed");
  assert.equal(github.error, ".github/workflows/a.yml has no jobs");
  assert.deepEqual(profile.ci.workflows.map((w) => w.file), [".github/workflows/b.yml"], "the parsable workflow is still modeled");
  assert.ok(profile.unknowns.includes("MATRIX_EXPRESSION:.github/workflows/b.yml#x"), "the modeled file's unknowns are kept");
});

test("workflow: a YAML error is prefixed with the file name", async (t) => {
  const dir = repo(t, { ".github/workflows/bad.yml": "jobs:\n  a: *alias\n" });
  const github = (await discoverRepo(dir)).ci.providers[0];
  assert.match(github.error, /^\.github\/workflows\/bad\.yml: line 2: /);
});

// ---------- detection edges ----------

test("detection: an unparsable package.json is still javascript, with PACKAGE_JSON_UNPARSED", async (t) => {
  const dir = repo(t, { "package.json": "{ nope", "package-lock.json": "{}\n" });
  const profile = await discoverRepo(dir);
  assert.deepEqual(profile.languages, [{ name: "javascript", evidence: ["package.json"] }]);
  assert.ok(profile.unknowns.includes("PACKAGE_JSON_UNPARSED:."));
  assert.ok(profile.unknowns.includes("NO_TEST_FRAMEWORK"));
});

test("detection: a symlinked manifest is not followed", async (t) => {
  const outside = tempDir(t, "ci-discover-outside-");
  write(outside, { "package.json": { devDependencies: { jest: "1" } } });
  const dir = repo(t);
  symlinkSync(path.join(outside, "package.json"), path.join(dir, "package.json"));
  const profile = await discoverRepo(dir);
  assert.deepEqual(profile.languages, [], "the link is not read as a manifest");
});

test("detection: several lockfiles each name their tool; a stray node_modules manifest is ignored", async (t) => {
  const dir = repo(t, { "package.json": {}, "yarn.lock": "", "package-lock.json": "{}\n", "node_modules/x/package.json": {} });
  const profile = await discoverRepo(dir);
  assert.deepEqual(profile.buildTools, [{ name: "npm", evidence: ["package-lock.json"] }, { name: "yarn", evidence: ["yarn.lock"] }]);
});

// ---------- shared pieces ----------

test("ci-parity: every non-GitHub CI file maps to its provider id, and ciFiles still lists them all", (t) => {
  const dir = tempDir(t);
  write(dir, Object.fromEntries(Object.keys(CI_FILE_PROVIDERS).map((file) => [file, "x\n"])));
  write(dir, { ".github/workflows/ci.yaml": "x\n" });
  assert.deepEqual(ciFiles(dir), [".github/workflows/ci.yaml", ...Object.keys(CI_FILE_PROVIDERS)]);
  assert.equal(ciProviderOf(".github/workflows/ci.yaml"), "github");
  for (const [file, id] of Object.entries(CI_FILE_PROVIDERS)) assert.equal(ciProviderOf(file), id);
  assert.equal(ciProviderOf("README.md"), null);
});

test("ciPolicy: an invalid raw ciOptimizer throws naming the key, as config load does", () => {
  assert.throws(() => ciPolicy({ ciOptimizer: { historyLimit: 0 } }), /ciOptimizer\.historyLimit/);
  assert.throws(() => ciPolicy({ ciOptimizer: { ratesPerMinute: { "": 1 } } }), /ciOptimizer\.ratesPerMinute/);
  assert.throws(() => ciPolicy({ ciOptimizer: null }), /ciOptimizer must be an object/);
  const a = ciPolicy({ ciOptimizer: { targets: { fastSeconds: 9 } } });
  assert.deepEqual(a.targets, { fastSeconds: 9, fullSeconds: 600 }, "targets merge key by key");
});
