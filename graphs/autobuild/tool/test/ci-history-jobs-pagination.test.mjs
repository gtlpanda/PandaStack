// ci-optimizer CO-03 regression (bug hunt F1): an attempt with more than 100 jobs (a wide
// matrix) must not be stored as a silent first page. Later pages are fetched while total_count
// says jobs are missing; a list that ends early or never ends is GH_FAILED.
// Offline: a synthetic fake gh that serves the jobs endpoint page by page and logs each call.
import assert from "node:assert/strict";
import { test } from "node:test";
import { chmodSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fetchGithubHistory } from "../lib/ci/history.mjs";

const REPO = "acme/widgets";
const JOBS_PATH = `repos/${REPO}/actions/runs/11/attempts/1/jobs`;

/**
 * A fake gh with one completed run (id 11, one attempt). `total` jobs exist; `reportTotal`
 * controls the total_count field (a number, or null to omit it); `stopAfter` makes every page
 * past that index return no jobs; `endless` makes every page full regardless of `total`.
 */
function fakeGh(t, { total, reportTotal = total, stopAfter = Infinity, endless = false }) {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), "ci-history-jobs-")));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const log = path.join(dir, "calls.log");
  const bin = path.join(dir, "gh");
  writeFileSync(bin, `#!${process.execPath}
const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(args) + "\\n");
const url = args.find((a) => a.startsWith("repos/")) ?? "";
const [pathPart, query = ""] = url.split("?");
const params = new URLSearchParams(query);
if (pathPart === "repos/${REPO}/actions/runs") {
  const run = { id: 11, run_attempt: 1, name: "ci", path: ".github/workflows/ci.yml", event: "push", head_sha: "f".repeat(40),
    head_branch: "main", conclusion: "success", created_at: "2026-11-20T10:00:00Z", run_started_at: "2026-11-20T10:00:00Z", updated_at: "2026-11-20T10:00:00Z" };
  process.stdout.write(JSON.stringify({ total_count: 1, workflow_runs: [run] }));
} else if (pathPart === ${JSON.stringify(JOBS_PATH)}) {
  const perPage = Number(params.get("per_page") ?? 30);
  const page = Number(params.get("page") ?? 1);
  const last = ${endless} ? page * perPage : Math.min(page * perPage, ${total});
  const jobs = [];
  if (page <= ${Number.isFinite(stopAfter) ? stopAfter : 1e9}) {
    for (let i = (page - 1) * perPage; i < last; i++) jobs.push({ name: "job-" + i, conclusion: "success", labels: [], steps: [] });
  }
  const doc = { jobs };
  if (${reportTotal === null ? "false" : "true"}) doc.total_count = ${reportTotal ?? 0};
  process.stdout.write(JSON.stringify(doc));
} else {
  process.stderr.write("unknown call\\n");
  process.exit(1);
}
`);
  chmodSync(bin, 0o755);
  const jobCalls = () => readFileSync(log, "utf8").trim().split("\n").map((line) => JSON.parse(line)[1]).filter((u) => u.startsWith(JOBS_PATH));
  return { bin, jobCalls };
}

test("an attempt with 150 jobs is fetched over two pages, in order", (t) => {
  const gh = fakeGh(t, { total: 150 });
  const [attempt] = fetchGithubHistory({ repo: REPO, ghBin: gh.bin, limit: 5 });
  assert.equal(attempt.jobs.length, 150);
  assert.equal(attempt.jobs[0].name, "job-0");
  assert.equal(attempt.jobs[149].name, "job-149");
  assert.deepEqual(gh.jobCalls(), [`${JOBS_PATH}?per_page=100`, `${JOBS_PATH}?per_page=100&page=2`]);
});

test("exactly 100 jobs with total_count 100 makes only the contract's single call", (t) => {
  const gh = fakeGh(t, { total: 100 });
  const [attempt] = fetchGithubHistory({ repo: REPO, ghBin: gh.bin, limit: 5 });
  assert.equal(attempt.jobs.length, 100);
  assert.deepEqual(gh.jobCalls(), [`${JOBS_PATH}?per_page=100`]);
});

test("a small attempt makes one call (the frozen call sequence is unchanged)", (t) => {
  const gh = fakeGh(t, { total: 4 });
  const [attempt] = fetchGithubHistory({ repo: REPO, ghBin: gh.bin, limit: 5 });
  assert.equal(attempt.jobs.length, 4);
  assert.deepEqual(gh.jobCalls(), [`${JOBS_PATH}?per_page=100`]);
});

test("without total_count, full pages are followed until a short page", (t) => {
  const gh = fakeGh(t, { total: 230, reportTotal: null });
  const [attempt] = fetchGithubHistory({ repo: REPO, ghBin: gh.bin, limit: 5 });
  assert.equal(attempt.jobs.length, 230);
  assert.equal(gh.jobCalls().length, 3);
});

test("without total_count, a full last page costs one empty extra call and no error", (t) => {
  const gh = fakeGh(t, { total: 200, reportTotal: null });
  const [attempt] = fetchGithubHistory({ repo: REPO, ghBin: gh.bin, limit: 5 });
  assert.equal(attempt.jobs.length, 200);
  assert.equal(gh.jobCalls().length, 3);
});

test("a page that ends before total_count is GH_FAILED, not a partial attempt", (t) => {
  const gh = fakeGh(t, { total: 250, stopAfter: 1 });
  assert.throws(
    () => fetchGithubHistory({ repo: REPO, ghBin: gh.bin, limit: 5 }),
    (error) => error.code === "GH_FAILED" && /returned no jobs after 100 of 250/.test(error.message),
  );
});

test("a jobs list that never ends stops at the page cap with GH_FAILED", (t) => {
  const gh = fakeGh(t, { total: 0, reportTotal: null, endless: true });
  assert.throws(
    () => fetchGithubHistory({ repo: REPO, ghBin: gh.bin, limit: 5 }),
    (error) => error.code === "GH_FAILED" && /more than 50 pages of jobs/.test(error.message),
  );
  assert.equal(gh.jobCalls().length, 50);
});
