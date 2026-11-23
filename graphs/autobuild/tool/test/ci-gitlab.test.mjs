// ci-optimizer CO-02 implementation tests: the GitLab reader edges the frozen acceptance file
// does not pin (odd top levels, malformed needs/parallel/script/stages, the `image: { name }`
// form, an unreadable file, top-level `cache`). Offline: throwaway directories and a private
// AUTOBUILD_STATE_HOME per test that stores a profile.
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { readGitlabPipeline } from "../lib/ci/gitlab.mjs";
import { discoverRepo, loadProfile } from "../lib/ci/discover.mjs";
import { TEST_COMMAND, wholeNumberOf } from "../lib/ci/patterns.mjs";

function tempDir(t, prefix = "ci-gitlab-") {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), prefix)));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function gitlabRepo(t, source) {
  const dir = tempDir(t);
  writeFileSync(path.join(dir, ".gitlab-ci.yml"), source);
  return dir;
}

const pipelineOf = (t, source) => readGitlabPipeline(gitlabRepo(t, source));
const jobOf = (t, source, id = "job") => pipelineOf(t, source).jobs.find((job) => job.id === id);

// ---------- whole-file shapes ----------

test("gitlab: an empty or comment-only file parses to the default stages and no jobs", (t) => {
  for (const source of ["", "# nothing yet\n"]) {
    assert.deepEqual(pipelineOf(t, source), { file: ".gitlab-ci.yml", stages: ["build", "test", "deploy"], jobs: [] }, JSON.stringify(source));
  }
});

test("gitlab: a top level that is a list or a scalar is unparsed, not thrown", (t) => {
  const list = pipelineOf(t, "- a\n- b\n");
  assert.deepEqual(Object.keys(list).sort(), ["error", "file"]);
  assert.equal(list.error, ".gitlab-ci.yml: the top level is not a mapping", "a list parses, then is refused by the reader");
  const scalar = pipelineOf(t, "just-a-string\n");
  assert.deepEqual(Object.keys(scalar).sort(), ["error", "file"]);
  assert.match(scalar.error, /^\.gitlab-ci\.yml: line 1: /, "a bare scalar is refused by the parser itself");
});

test("gitlab: a parser refusal carries the file name and the parser's line message", (t) => {
  const result = pipelineOf(t, "job:\n  script: !reference [.x, script]\n");
  assert.equal(result.file, ".gitlab-ci.yml");
  assert.match(result.error, /^\.gitlab-ci\.yml: line 2: /, "error is `<file>: line N: why`");
});

test("gitlab: an unreadable .gitlab-ci.yml (a directory) is reported as an error, never thrown", (t) => {
  const dir = tempDir(t);
  mkdirSync(path.join(dir, ".gitlab-ci.yml"));
  const result = readGitlabPipeline(dir);
  assert.equal(result.file, ".gitlab-ci.yml");
  assert.match(result.error, /^\.gitlab-ci\.yml: .*EISDIR/);
});

test("gitlab: a non-list stages key falls back to the default stages; non-string stage entries are dropped", (t) => {
  assert.deepEqual(pipelineOf(t, "stages: build\n").stages, ["build", "test", "deploy"]);
  assert.deepEqual(pipelineOf(t, "stages:\n  - a\n  - {b: c}\n  - d\n").stages, ["a", "d"]);
});

// ---------- per-job fields ----------

test("gitlab: needs that is not a list is null; non-name entries are dropped", (t) => {
  assert.strictEqual(jobOf(t, "job:\n  needs: build\n  script: x\n").needs, null, "a bare string is not a list");
  assert.deepEqual(jobOf(t, "job:\n  needs:\n    - a\n    - {job: b}\n    - {pipeline: other}\n    - [c]\n  script: x\n").needs, ["a", "b"],
    "an object without a string `job` and a nested list name nothing");
});

test("gitlab: parallel forms that are not a whole number or a sizable matrix are null", (t) => {
  const cases = {
    "-1": null,
    "1e3": null,
    "{matrix: []}": null,
    "{matrix: [a, b]}": null,
    "{matrix: x}": null,
    "{other: 1}": null,
    "[2]": null,
    "1": 1,
    "12": 12,
  };
  for (const [value, expected] of Object.entries(cases)) {
    assert.strictEqual(jobOf(t, `job:\n  parallel: ${value}\n  script: x\n`).parallel, expected, `parallel: ${value}`);
  }
});

test("gitlab: a matrix entry of scalars only counts 1; entries are summed", (t) => {
  const source = "job:\n  parallel:\n    matrix:\n      - A: one\n      - B: [x, y, z]\n        C: [1, 2]\n  script: x\n";
  assert.strictEqual(jobOf(t, source).parallel, 1 + 6);
});

test("gitlab: image takes the `{ name }` form, for a job and for the top level", (t) => {
  assert.strictEqual(jobOf(t, "job:\n  image:\n    name: alpine:3\n    entrypoint: [\"\"]\n  script: x\n").image, "alpine:3");
  assert.strictEqual(jobOf(t, "image:\n  name: node:22\njob:\n  script: x\n").image, "node:22");
  assert.strictEqual(jobOf(t, "image: node:22\njob:\n  image:\n    entrypoint: [\"\"]\n  script: x\n").image, "node:22",
    "a job image object without a name inherits the top-level image");
});

test("gitlab: a job without script has no lines; non-string script entries are dropped", (t) => {
  assert.deepEqual(jobOf(t, "job:\n  stage: build\n").script, []);
  assert.deepEqual(jobOf(t, "job:\n  script:\n    - pytest\n    - [nested]\n    - {a: b}\n").script, ["pytest"]);
});

test("gitlab: a non-string stage defaults to test", (t) => {
  assert.strictEqual(jobOf(t, "job:\n  stage: [a]\n  script: x\n").stage, "test");
});

test("gitlab: only the job's own or default's cache key marks a job cached, as the contract states", (t) => {
  const source = "cache:\n  key: global\njob:\n  script: x\ncached:\n  cache: []\n  script: x\n";
  const pipeline = pipelineOf(t, source);
  assert.strictEqual(pipeline.jobs.find((j) => j.id === "job").cache, false, "a top-level `cache` key is reserved and not inherited");
  assert.strictEqual(pipeline.jobs.find((j) => j.id === "cached").cache, true, "the key's presence counts, whatever its value");
});

test("gitlab: a key that is a job name but maps to a list or scalar is not a job", (t) => {
  assert.deepEqual(pipelineOf(t, "a: [1, 2]\nb: x\nc:\n  script: y\n").jobs.map((j) => j.id), ["c"]);
});

// ---------- shared patterns ----------

test("patterns: TEST_COMMAND matches test runners and not look-alikes", () => {
  for (const line of ["pytest -q", "npm test", "pnpm run test", "go test ./...", "cargo test", "bash scripts/test-all.sh", "node --test"]) {
    assert.ok(TEST_COMMAND.test(line), line);
  }
  for (const line of ["echo pytester", "make contest", "npm run build", "ruff check .", "attest.sh"]) {
    assert.ok(!TEST_COMMAND.test(line), line);
  }
});

test("patterns: wholeNumberOf accepts only digit strings", () => {
  assert.strictEqual(wholeNumberOf("0"), 0);
  assert.strictEqual(wholeNumberOf("15"), 15);
  for (const value of ["", "1.5", "-2", " 3", "3 ", "x", 3, null, undefined, {}, []]) {
    assert.strictEqual(wholeNumberOf(value), null, JSON.stringify(value));
  }
});

// ---------- discovery ----------

test("discovery: a GitLab file alongside GitHub workflows models both; one unparsed does not taint the other", async (t) => {
  const dir = gitlabRepo(t, "unit:\n  image: *img\n  script: pytest\n");
  mkdirSync(path.join(dir, ".github", "workflows"), { recursive: true });
  writeFileSync(path.join(dir, ".github", "workflows", "ci.yml"), "name: ci\non: push\njobs:\n  a:\n    runs-on: ubuntu-latest\n    steps:\n      - run: npm test\n");
  const profile = await discoverRepo(dir);
  const byId = Object.fromEntries(profile.ci.providers.map((p) => [p.id, p]));
  assert.equal(byId.github.status, "parsed");
  assert.equal(byId.gitlab.status, "unparsed");
  assert.equal(byId.gitlab.error, profile.ci.pipelines[0].error, "the provider error is the pipeline error");
  assert.equal(profile.ci.workflows.length, 1, "the GitHub workflow is still modeled");
  assert.equal(profile.ci.workflows[0].jobs[0].steps[0].kind, "test", "GitHub step kinds still use the shared test pattern");
});

test("discovery: the stored profile carries the pipeline and is reused until the GitLab file changes", async (t) => {
  const env = { AUTOBUILD_STATE_HOME: tempDir(t, "ci-gitlab-state-") };
  const dir = gitlabRepo(t, "unit:\n  parallel: 2\n  script: pytest\n");
  const first = await loadProfile(dir, { env });
  assert.equal(first.reused, false);
  assert.deepEqual(first.profile.ci.pipelines[0].jobs.map((j) => [j.id, j.parallel, j.test]), [["unit", 2, true]]);
  const second = await loadProfile(dir, { env });
  assert.equal(second.reused, true);
  assert.deepEqual(second.profile.ci.pipelines, first.profile.ci.pipelines, "the reused profile holds the same pipeline");
  writeFileSync(path.join(dir, ".gitlab-ci.yml"), "unit:\n  parallel: 4\n  script: pytest\n");
  const third = await loadProfile(dir, { env });
  assert.equal(third.reused, false);
  assert.equal(third.profile.ci.pipelines[0].jobs[0].parallel, 4);
});
