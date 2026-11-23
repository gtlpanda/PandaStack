// ci-optimizer CO-03 regression (bug hunt F3): `ci history --from-gh` must merge into the history
// as it is at write time, so a history write that lands during the (slow) gh fetch survives.
// Here the fake gh runs a complete `ci history --import` on its first call.
// Offline: a fake gh, a throwaway git repo and a private AUTOBUILD_STATE_HOME.
import assert from "node:assert/strict";
import { test } from "node:test";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { CLI } from "../test-fixtures/project.mjs";

const GIT_ENV = {
  GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", LANG: "C",
  GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.invalid", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.invalid",
};
const REPO = "acme/widgets";

function tempDir(t, prefix) {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), prefix)));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const importedRecord = {
  provider: "buildkite", runId: 500, attempt: 1, workflow: "pipeline", workflowPath: null, event: "push", headSha: null, branch: "main",
  conclusion: "success", createdAt: "2026-11-21T10:00:00Z", startedAt: "2026-11-21T10:00:00Z", updatedAt: "2026-11-21T10:00:00Z",
  jobs: [{ name: "unit", conclusion: "success", createdAt: null, startedAt: null, completedAt: null, labels: [], steps: [] }],
};

const ghRun = {
  id: 11, run_attempt: 1, name: "ci", path: ".github/workflows/ci.yml", event: "push", head_sha: "f".repeat(40),
  head_branch: "main", conclusion: "success", created_at: "2026-11-20T10:00:00Z", run_started_at: "2026-11-20T10:00:00Z", updated_at: "2026-11-20T10:00:00Z",
};
const jobsDoc = { jobs: [{ name: "unit", conclusion: "success", created_at: null, started_at: null, completed_at: null, labels: ["ubuntu-latest"], steps: [] }] };

function cli(cwd, args, env) {
  const r = spawnSync(process.execPath, [CLI, "ci", "history", ...args], { cwd, env: { ...process.env, ...GIT_ENV, ...env }, encoding: "utf8" });
  return { code: r.status, stdout: r.stdout, stderr: r.stderr };
}

test("ci history --from-gh keeps attempts another history write stored while gh was fetching", (t) => {
  const repo = tempDir(t, "ci-history-race-repo-");
  const git = spawnSync("git", ["init", "-q"], { cwd: repo, env: { ...process.env, ...GIT_ENV }, encoding: "utf8" });
  assert.equal(git.status, 0, git.stderr);
  const stateHome = tempDir(t, "ci-history-race-state-");
  const env = { AUTOBUILD_STATE_HOME: stateHome };

  const dir = tempDir(t, "ci-history-race-gh-");
  const importFile = path.join(dir, "other.json");
  const marker = path.join(dir, "import-ran");
  const bin = path.join(dir, "gh");
  writeFileSync(importFile, JSON.stringify({ attempts: [importedRecord] }));
  const responses = {
    [JSON.stringify(["api", `repos/${REPO}/actions/runs?per_page=5&status=completed`])]: JSON.stringify({ workflow_runs: [ghRun] }),
    [JSON.stringify(["api", `repos/${REPO}/actions/runs/11/attempts/1/jobs?per_page=100`])]: JSON.stringify(jobsDoc),
  };
  // On its first call gh runs a complete `ci history --import` (run B) before answering, which is
  // a history write finishing while run A is still fetching.
  writeFileSync(bin, `#!${process.execPath}
const fs = require('node:fs')
const { spawnSync } = require('node:child_process')
const args = process.argv.slice(2)
if (!fs.existsSync(${JSON.stringify(marker)})) {
  fs.writeFileSync(${JSON.stringify(marker)}, '')
  const b = spawnSync(process.execPath, [${JSON.stringify(CLI)}, 'ci', 'history', '--import', ${JSON.stringify(importFile)}], {
    cwd: ${JSON.stringify(repo)}, encoding: 'utf8',
    env: { ...process.env, ...${JSON.stringify(GIT_ENV)}, AUTOBUILD_STATE_HOME: ${JSON.stringify(stateHome)} },
  })
  if (b.status !== 0) { process.stderr.write('import failed: ' + b.stderr); process.exit(9) }
}
const entry = ${JSON.stringify(responses)}[JSON.stringify(args)]
if (entry === undefined) { process.stderr.write('unknown call\\n'); process.exit(1) }
process.stdout.write(entry)
`);
  chmodSync(bin, 0o755);

  const a = cli(repo, ["--from-gh", "--repo", REPO, "--limit", "5", "--json"], { ...env, AUTOBUILD_GH_BIN: bin });
  assert.equal(a.code, 0, a.stderr);
  assert.ok(existsSync(marker), "the fake gh ran the concurrent import");

  const stored = cli(repo, ["--json"], env);
  assert.equal(stored.code, 0, stored.stderr);
  const keys = JSON.parse(stored.stdout).attempts.map((attempt) => `${attempt.runId}#${attempt.attempt}`).sort();
  assert.deepEqual(keys, ["11#1", "500#1"], "--from-gh overwrote history.json from a snapshot read before the fetch, losing the attempts a concurrent --import stored");
});
