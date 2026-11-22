// ci-optimizer CO-03 implementation tests: the edges the frozen acceptance file does not pin
// (gh port failure shapes, repository-name safety, flag parsing, import file errors and
// projection, merge purity, the `new` count under the cap, stored-record validation).
// Offline: a synthetic fake gh, throwaway git repos and a private AUTOBUILD_STATE_HOME per test.
import assert from "node:assert/strict";
import { test } from "node:test";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { CLI } from "../test-fixtures/project.mjs";
import { ciStateDir, writeState } from "../lib/ci/state.mjs";
import { fetchGithubHistory, githubRepo, HISTORY_CAP, importedAttempts, isGithubRepo, mergeHistory, readHistory } from "../lib/ci/history.mjs";

const GIT_ENV = {
  GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", LANG: "C",
  GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.invalid", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.invalid",
};
const REPO = "acme/widgets";

function tempDir(t, prefix = "ci-history-") {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), prefix)));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function gitRepo(t, origin = null) {
  const dir = tempDir(t);
  const run = (...args) => {
    const r = spawnSync("git", args, { cwd: dir, env: { ...process.env, ...GIT_ENV }, encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
  };
  run("init", "-q");
  if (origin) run("remote", "add", "origin", origin);
  return dir;
}

/**
 * A fake gh answering `responses` ({ JSON argument vector: body string | { exit, stderr } });
 * any other vector exits 1. Returns { bin, calls() }.
 */
function fakeGh(t, responses) {
  const dir = tempDir(t, "ci-history-gh-");
  const log = path.join(dir, "calls.jsonl");
  const table = path.join(dir, "responses.json");
  const bin = path.join(dir, "gh");
  writeFileSync(log, "");
  writeFileSync(table, JSON.stringify(responses));
  writeFileSync(bin, `#!${process.execPath}
const fs = require('node:fs')
const args = process.argv.slice(2)
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(args) + '\\n')
const entry = JSON.parse(fs.readFileSync(${JSON.stringify(table)}, 'utf8'))[JSON.stringify(args)]
if (entry === undefined) { process.stderr.write('unknown call\\n'); process.exit(1) }
if (typeof entry === 'object') { process.stderr.write(entry.stderr ?? ''); process.exit(entry.exit) }
process.stdout.write(entry)
`);
  chmodSync(bin, 0o755);
  return { bin, calls: () => readFileSync(log, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line)) };
}

const runsCall = (limit, repo = REPO) => JSON.stringify(["api", `repos/${repo}/actions/runs?per_page=${limit}&status=completed`]);
const attemptCall = (id, k) => JSON.stringify(["api", `repos/${REPO}/actions/runs/${id}/attempts/${k}`]);
const jobsCall = (id, a) => JSON.stringify(["api", `repos/${REPO}/actions/runs/${id}/attempts/${a}/jobs?per_page=100`]);

const ghRun = (id, runAttempt, startedAt, extra = {}) => ({
  id, run_attempt: runAttempt, name: "ci", path: ".github/workflows/ci.yml", event: "push", head_sha: "f".repeat(40),
  head_branch: "main", conclusion: "success", created_at: startedAt, run_started_at: startedAt, updated_at: startedAt, ...extra,
});
const jobsDoc = (name = "unit") => JSON.stringify({ jobs: [{ name, conclusion: "success", created_at: null, started_at: null, completed_at: null, labels: ["ubuntu-latest"], steps: [] }] });

/** Responses for one run (single attempt) of the given limit. */
const oneRun = (limit = 5) => ({
  [runsCall(limit)]: JSON.stringify({ workflow_runs: [ghRun(11, 1, "2026-11-20T10:00:00Z")] }),
  [jobsCall(11, 1)]: jobsDoc(),
});

const record = (runId, startedAt, overrides = {}) => ({
  provider: "buildkite", runId, attempt: 1, workflow: "pipeline", workflowPath: null, event: "push", headSha: null, branch: "main",
  conclusion: "success", createdAt: startedAt, startedAt, updatedAt: startedAt,
  jobs: [{ name: "unit", conclusion: "success", createdAt: null, startedAt: null, completedAt: null, labels: [], steps: [{ number: 1, name: "test", conclusion: "success", startedAt: null, completedAt: null }] }],
  ...overrides,
});
const minuteAt = (i) => new Date(Date.UTC(2026, 10, 1, 0, i)).toISOString();

function cli(cwd, args, env) {
  const r = spawnSync(process.execPath, [CLI, "ci", "history", ...args], { cwd, env: { ...process.env, ...GIT_ENV, ...env }, encoding: "utf8" });
  return { code: r.status, stdout: r.stdout, stderr: r.stderr, json: () => JSON.parse(r.stdout) };
}

const stateEnv = (t, gh) => ({ AUTOBUILD_STATE_HOME: tempDir(t, "ci-history-state-"), ...(gh ? { AUTOBUILD_GH_BIN: gh.bin } : {}) });
const historyPath = (root, env) => path.join(ciStateDir(root, env), "history.json");

function importFile(t, doc, name = "attempts.json") {
  const file = path.join(tempDir(t, "ci-history-import-"), name);
  writeFileSync(file, typeof doc === "string" ? doc : JSON.stringify(doc));
  return file;
}

const rejectsWith = (code) => (error) => error.code === code;

// ---------- the gh port ----------

test("fetchGithubHistory: a gh binary that does not exist is GH_FAILED", (t) => {
  assert.throws(() => fetchGithubHistory({ repo: REPO, ghBin: path.join(tempDir(t), "no-such-gh"), limit: 5, env: process.env }), rejectsWith("GH_FAILED"));
});

test("fetchGithubHistory: valid JSON of the wrong shape is GH_FAILED, and the fetch stops there", (t) => {
  const noList = fakeGh(t, { [runsCall(5)]: JSON.stringify({ total_count: 0 }) });
  assert.throws(() => fetchGithubHistory({ repo: REPO, ghBin: noList.bin, limit: 5 }), (e) => e.code === "GH_FAILED" && /workflow_runs/.test(e.message));

  const badRun = fakeGh(t, { [runsCall(5)]: JSON.stringify({ workflow_runs: [{ id: "11", run_attempt: 1 }] }) });
  assert.throws(() => fetchGithubHistory({ repo: REPO, ghBin: badRun.bin, limit: 5 }), rejectsWith("GH_FAILED"));
  assert.equal(badRun.calls().length, 1, "no further call after a malformed run");

  const badJobs = fakeGh(t, { ...oneRun(), [jobsCall(11, 1)]: JSON.stringify({ jobs: "unit" }) });
  assert.throws(() => fetchGithubHistory({ repo: REPO, ghBin: badJobs.bin, limit: 5 }), (e) => e.code === "GH_FAILED" && /jobs/.test(e.message));
});

test("fetchGithubHistory: the message names the call and exit status, with gh's stderr line cleaned", (t) => {
  const gh = fakeGh(t, { [runsCall(5)]: { exit: 4, stderr: "HTTP 404: Not Found\x1b[31m\n" } });
  assert.throws(() => fetchGithubHistory({ repo: REPO, ghBin: gh.bin, limit: 5 }), (e) => {
    assert.equal(e.code, "GH_FAILED");
    assert.equal(e.exit, 3);
    assert.ok(e.message.includes(`repos/${REPO}/actions/runs?per_page=5&status=completed`), e.message);
    assert.match(e.message, /exit status 4/);
    assert.match(e.message, /HTTP 404: Not Found/);
    assert.ok(!e.message.includes("\x1b"), "control characters are removed");
    return true;
  });
});

test("fetchGithubHistory: an earlier attempt's number is the one requested, and an empty runs list is no attempts", (t) => {
  const gh = fakeGh(t, {
    [runsCall(5)]: JSON.stringify({ workflow_runs: [ghRun(11, 2, "2026-11-20T10:05:00Z")] }),
    // The attempt-1 response claims run_attempt 2 (a server quirk); the stored attempt is still 1.
    [attemptCall(11, 1)]: JSON.stringify(ghRun(11, 2, "2026-11-20T10:00:00Z", { conclusion: "failure" })),
    [jobsCall(11, 1)]: jobsDoc("first"),
    [jobsCall(11, 2)]: jobsDoc("second"),
  });
  const attempts = fetchGithubHistory({ repo: REPO, ghBin: gh.bin, limit: 5 });
  assert.deepEqual(attempts.map((a) => [a.attempt, a.conclusion, a.jobs[0].name]), [[1, "failure", "first"], [2, "success", "second"]]);

  const empty = fakeGh(t, { [runsCall(5)]: JSON.stringify({ workflow_runs: [] }) });
  assert.deepEqual(fetchGithubHistory({ repo: REPO, ghBin: empty.bin, limit: 5 }), []);
});

test("fetchGithubHistory: a bad repository or limit is USAGE and gh is never called", (t) => {
  const gh = fakeGh(t, oneRun());
  for (const repo of ["acme/widgets/actions", "../x", "acme/..", "acme", "", null]) {
    assert.throws(() => fetchGithubHistory({ repo, ghBin: gh.bin, limit: 5 }), rejectsWith("USAGE"), `repo ${repo}`);
  }
  for (const limit of [0, 101, 2.5, "5"]) {
    assert.throws(() => fetchGithubHistory({ repo: REPO, ghBin: gh.bin, limit }), rejectsWith("USAGE"), `limit ${limit}`);
  }
  assert.deepEqual(gh.calls(), []);
});

// ---------- repository names ----------

test("githubRepo and isGithubRepo: only the two exact remote forms with a safe owner/name", (t) => {
  assert.equal(githubRepo(gitRepo(t, "https://github.com/acme/widgets.js.git")), "acme/widgets.js", "dots in the name are kept; only a final .git is dropped");
  for (const url of [
    "https://github.com/acme/widgets/extra", "https://github.com/acme/widgets/", "http://github.com/acme/widgets",
    "ssh://git@github.com/acme/widgets.git", "https://github.com/acme/..", "https://github.com/-acme/widgets",
    "https://user@github.com/acme/widgets", " https://github.com/acme/widgets",
  ]) assert.strictEqual(githubRepo(gitRepo(t, url)), null, url);
  assert.strictEqual(githubRepo(tempDir(t)), null, "not a git repository");

  for (const ok of ["acme/widgets", "a/b", "acme-co/w_i.d-g"]) assert.equal(isGithubRepo(ok), true, ok);
  for (const bad of ["acme/widgets?per_page=1", "acme/wid gets", "acme//widgets", "acme/.", "acme-/w", 7, undefined]) assert.equal(isGithubRepo(bad), false, String(bad));
});

// ---------- the command line ----------

test("ci history: --limit takes digits only (leading zero ok), and a missing value is USAGE", (t) => {
  const gh = fakeGh(t, oneRun(40));
  const repo = gitRepo(t);
  const env = stateEnv(t, gh);
  const ok = cli(repo, ["--from-gh", "--repo", REPO, "--limit", "040", "--json"], env);
  assert.equal(ok.code, 0, ok.stderr);
  assert.equal(gh.calls()[0][1], `repos/${REPO}/actions/runs?per_page=40&status=completed`);

  for (const args of [["--from-gh", "--repo", REPO, "--limit", "1e2"], ["--from-gh", "--repo", REPO, "--limit", " 5"], ["--from-gh", "--repo", REPO, "--limit"], ["--from-gh", "--repo", "--json"]]) {
    const run = cli(repo, args, env);
    assert.equal(run.code, 2, `${args.join(" ")}: ${run.stderr}`);
    assert.match(run.stderr, /^autobuild ci: USAGE: /m);
  }
  assert.equal(gh.calls().length, 2, "only the successful run called gh");
});

test("ci history: flag combinations and --repo shapes are checked before any gh call", (t) => {
  const gh = fakeGh(t, oneRun());
  const repo = gitRepo(t);
  const env = stateEnv(t, gh);
  for (const args of [
    ["--from-gh", "--import", "x.json"], ["--repo", REPO], ["--limit", "5"], ["--import", "a.json", "--repo", REPO],
    ["--from-gh", "--repo", REPO, "--limit", "5", "--limit", "6"], ["--from-gh", "--repo", "acme/widgets/../../orgs"], ["stray"],
  ]) {
    const run = cli(repo, args, env);
    assert.equal(run.code, 2, `${args.join(" ")}: ${run.stderr}`);
    assert.match(run.stderr, /^autobuild ci: USAGE: /m, args.join(" "));
  }
  const asJson = cli(repo, ["--repo", REPO, "--json"], env);
  assert.equal(asJson.json().error, "USAGE");
  assert.deepEqual(gh.calls(), []);
  assert.ok(!existsSync(ciStateDir(repo, env)), "nothing was created");
});

test("ci history: a fetch that fails leaves no state directory behind", (t) => {
  const gh = fakeGh(t, {});
  const repo = gitRepo(t);
  const env = stateEnv(t, gh);
  const run = cli(repo, ["--from-gh", "--repo", REPO, "--limit", "5"], env);
  assert.equal(run.code, 3, run.stderr);
  assert.ok(!existsSync(ciStateDir(repo, env)));
});

test("ci history: a relative --import path resolves against the working directory; the line names it as given", (t) => {
  const repo = gitRepo(t);
  const env = stateEnv(t);
  mkdirSync(path.join(repo, "sub"));
  writeFileSync(path.join(repo, "sub", "runs.json"), JSON.stringify({ attempts: [record(1, minuteAt(1))] }));
  const run = cli(path.join(repo, "sub"), ["--import", "runs.json"], env);
  assert.equal(run.code, 0, run.stderr);
  assert.equal(run.stdout, "history: 1 attempts (1 new) from import runs.json\n");
  assert.deepEqual(readHistory(repo, env).source, { provider: "import", file: "runs.json" });
});

test("ci history: an unreadable, non-JSON or list-less import file is IMPORT_INVALID without quoting the file", (t) => {
  const repo = gitRepo(t);
  const env = stateEnv(t);
  const cases = {
    missing: path.join(tempDir(t), "absent.json"),
    "not json": importFile(t, "SECRET-LOOKING-TEXT {"),
    "no attempts list": importFile(t, { runs: [] }),
    "attempts not a list": importFile(t, { attempts: {} }),
    directory: tempDir(t),
  };
  for (const [label, file] of Object.entries(cases)) {
    const run = cli(repo, ["--import", file], env);
    assert.equal(run.code, 2, `${label}: ${run.stderr}`);
    assert.match(run.stderr, /^autobuild ci: IMPORT_INVALID: /m, label);
    assert.ok(!run.stderr.includes("SECRET-LOOKING-TEXT"), `${label}: the file's text is not echoed`);
  }
  assert.ok(!existsSync(historyPath(repo, env)));
});

test("ci history: --json without a source and without history reports source null", (t) => {
  const run = cli(gitRepo(t), ["--json"], stateEnv(t));
  assert.equal(run.code, 0, run.stderr);
  assert.deepEqual(run.json(), { total: 0, new: 0, source: null, attempts: [] });
});

test("ci history: new counts only records stored now, so the cap's drops are not new", (t) => {
  const repo = gitRepo(t);
  const env = stateEnv(t);
  const recent = Array.from({ length: HISTORY_CAP }, (_, i) => record(1000 + i, minuteAt(100 + i)));
  assert.equal(cli(repo, ["--import", importFile(t, { attempts: recent })], env).code, 0);
  const older = Array.from({ length: 5 }, (_, i) => record(i + 1, minuteAt(i)));
  const run = cli(repo, ["--import", importFile(t, { attempts: older }), "--json"], env);
  assert.equal(run.code, 0, run.stderr);
  assert.equal(run.json().total, HISTORY_CAP);
  assert.equal(run.json().new, 0, "all five older records fell past the cap");
});

test("ci history: a stored history holding a malformed attempt reads as none and is replaced", (t) => {
  const repo = gitRepo(t);
  const env = stateEnv(t);
  writeState(repo, "history", { schemaVersion: 1, source: { provider: "import", file: "x" }, attempts: [record(1, minuteAt(1)), { runId: 2 }] }, env);
  assert.equal(readHistory(repo, env), null);
  assert.equal(cli(repo, [], env).stdout, "history: none\n");
  const run = cli(repo, ["--import", importFile(t, { attempts: [record(3, minuteAt(3))] }), "--json"], env);
  assert.deepEqual(run.json().attempts.map((a) => a.runId), [3]);
});

// ---------- import validation and merge ----------

test("importedAttempts: unknown keys are dropped and nested jobs and steps are validated with their position", () => {
  const [kept] = importedAttempts({ attempts: [{ ...record(1, minuteAt(1)), token: "x", jobs: [{ ...record(1, null).jobs[0], extra: 1 }] }] });
  assert.ok(!("token" in kept), "unknown run key dropped");
  assert.ok(!("extra" in kept.jobs[0]), "unknown job key dropped");
  assert.deepEqual(kept, record(1, minuteAt(1)));

  const bad = (attempts, pattern) => assert.throws(() => importedAttempts({ attempts }), (e) => e.code === "IMPORT_INVALID" && e.exit === 2 && pattern.test(e.message), String(pattern));
  const job = record(1, null).jobs[0];
  bad([record(1, null), record(2, null, { jobs: [{ ...job, labels: [7] }] })], /record 1: job 0: labels/);
  bad([record(1, null, { jobs: [{ ...job, steps: [{ ...job.steps[0], number: "1" }] }] })], /record 0: job 0 step 0: number/);
  bad([record(1, null, { jobs: [{ name: "unit" }] })], /record 0: job 0: missing key conclusion/);
  bad([record(1, null, { runId: 1.5 })], /record 0: runId must be an integer/);
  bad([record(1, null, { headSha: 7 })], /record 0: headSha must be a string or null/);
  bad([record(1, null, { createdAt: undefined })], /record 0: createdAt must be a string or null/);
  bad([[]], /record 0: not an object/);
});

test("mergeHistory: the inputs are not mutated", () => {
  const existing = [record(2, minuteAt(1)), record(1, minuteAt(2))];
  const incoming = [record(3, minuteAt(0))];
  const snapshot = JSON.stringify([existing, incoming]);
  const merged = mergeHistory(existing, incoming);
  assert.deepEqual(merged.map((a) => a.runId), [1, 2, 3]);
  assert.equal(JSON.stringify([existing, incoming]), snapshot);
});
