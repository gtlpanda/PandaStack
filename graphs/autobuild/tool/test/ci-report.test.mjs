// ci-optimizer CO-10 implementation tests: the edges the frozen acceptance file does not pin
// (Markdown injection through names and summaries, an unnamed workflow, the validation line,
// first-run trigger visibility, an invalid baseline file) and the --out refusals and writes it
// does not cover (a linked parent into .git, a nested autobuild.json root, a linked work tree's
// .git file, an existing file with another mode, a missing parent directory, a FIFO).
// Offline: throwaway git repos and a private AUTOBUILD_STATE_HOME.
import assert from "node:assert/strict";
import { test } from "node:test";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { CLI } from "../test-fixtures/project.mjs";
import { buildReport, renderReport } from "../lib/ci/report.mjs";
import { ciStateDir } from "../lib/ci/state.mjs";

const GIT_ENV = {
  GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", LANG: "C",
  GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.invalid", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.invalid",
};
const WORKFLOW = "name: test\non: push\njobs:\n  unit:\n    runs-on: ubuntu-22.04\n    steps:\n      - uses: actions/checkout@v4\n      - run: npm test\n";
const HEADINGS = ["# CI performance report", "## Repository", "## CI configuration", "## Measurements", "## Baseline and regressions", "## Findings", "## Triggers", "## Unknowns"];
const headings = (md) => md.split("\n").filter((l) => /^#{1,2} /.test(l));

function tempDir(t, prefix = "ci-report-") {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), prefix)));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function git(cwd, ...args) {
  const r = spawnSync("git", ["-c", "init.defaultBranch=main", ...args], { cwd, env: { ...process.env, ...GIT_ENV }, encoding: "utf8" });
  assert.equal(r.status, 0, `git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout.trim();
}

function repoWith(t, files) {
  const repo = tempDir(t);
  for (const [rel, content] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(repo, rel)), { recursive: true });
    writeFileSync(path.join(repo, rel), typeof content === "string" ? content : `${JSON.stringify(content, null, 2)}\n`);
  }
  git(repo, "init", "-q");
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "fixture");
  return repo;
}

function ci(cwd, home, ...args) {
  const r = spawnSync(process.execPath, [CLI, "ci", ...args], { cwd, encoding: "utf8", env: { ...process.env, ...GIT_ENV, AUTOBUILD_STATE_HOME: home }, timeout: 120_000 });
  return { code: r.status, stdout: r.stdout, stderr: r.stderr };
}

// ---------- module: renderReport ----------

const EMPTY_WORKFLOW = {
  runs: 1, wallSeconds: { p50: 10.4, p90: 10.6 }, queueSeconds: { p50: null }, criticalPathSeconds: { p50: null },
  parallelEfficiency: { p50: null }, runnerMinutes: { total: 2.6 }, reliability: { flakeRate: null },
};

function render(over = {}) {
  const report = buildReport({
    profile: { root: "/r", languages: [], testFrameworks: [], ci: { providers: [] }, unknowns: [] },
    metrics: { workflows: [], gate: null, unknowns: [] },
    findings: [], baseline: null, regression: null, triggers: { fire: false, triggers: [] }, validation: null,
    generatedAt: "2026-11-22T00:00:00Z",
    ...over,
  });
  return renderReport(report);
}

test("names and summaries cannot add headings, table columns or finding bullets", () => {
  const md = render({
    metrics: { workflows: [{ ...EMPTY_WORKFLOW, workflow: "evil | x\n## Injected" }, { ...EMPTY_WORKFLOW, workflow: null }], gate: null, unknowns: [] },
    findings: [{ rule: "r", risk: "high", action: "propose", target: "t.yml", job: "j\n- **fake**", summary: "one\n# two\n- three", evidence: [], estimatedSavingSeconds: null }],
    triggers: { fire: true, triggers: [{ id: "explicit", detail: "a\n## b" }] },
  });
  assert.deepEqual(headings(md), HEADINGS, "the eight headings, and no injected one");
  const rows = md.split("\n").filter((l) => l.startsWith("| ") && !l.startsWith("| Workflow") && !l.startsWith("| ---"));
  assert.equal(rows.length, 2, "one row per workflow");
  assert.ok(rows[0].startsWith("| evil \\| x ## Injected | "), `the pipe is escaped and the newline flattened: ${rows[0]}`);
  assert.ok(rows[1].startsWith("| (unnamed) | 1 | 10s | 11s | unknown | unknown | unknown | 3 | unknown |"), `a null name prints (unnamed); figures round: ${rows[1]}`);
  const proposed = md.slice(md.indexOf("### Proposed for review"), md.indexOf("## Triggers")).split("\n").filter((l) => l.startsWith("- "));
  assert.deepEqual(proposed, ["- **r** (high) t.yml#j - **fake**: one # two - three"], "one bullet, on one line");
});

test("the validation line reports each tier, and none recorded without validation.json", () => {
  assert.ok(render().includes("- Validation of HEAD: none recorded"));
  const md = render({ validation: { schemaVersion: 1, fast: { head: "a".repeat(40), dirty: true, ok: true, at: "2026-11-22T01:00:00Z" }, full: { head: "b".repeat(40), dirty: false, ok: false, at: "2026-11-22T02:00:00Z" } } });
  assert.ok(md.includes(`- Validation of HEAD: fast tier passed at 2026-11-22T01:00:00Z on ${"a".repeat(12)} with uncommitted changes; full tier failed at 2026-11-22T02:00:00Z on ${"b".repeat(12)}`), md);
  assert.ok(render({ validation: { schemaVersion: 1, fast: null } }).includes("fast tier not recorded; full tier not recorded"));
});

test("a baseline without a computed regression, and an empty unknowns list", () => {
  const md = render({ baseline: { capturedAt: "2026-11-21T00:00:00Z", head: null } });
  assert.ok(md.includes("Baseline captured at 2026-11-21T00:00:00Z on no commit."), md);
  assert.ok(md.includes("Regressions: not evaluated."), md);
  const unknowns = md.slice(md.indexOf("## Unknowns")).split("\n").filter((l) => l.startsWith("- "));
  assert.deepEqual(unknowns, ["- none"]);
});

test("a regressed workflow lists its slower steps as nested bullets", () => {
  const regression = {
    regressed: true,
    workflows: [{ workflow: "test", status: "regressed", baselineP50: 100, recentP50: 200, deltaPercent: 100, overTarget: false, topSteps: [{ job: "unit", step: "npm test", baselineP50: 50, recentP50: 140, deltaSeconds: 90 }] }],
  };
  const md = render({ baseline: { capturedAt: "x", head: "c".repeat(40) }, regression });
  const lines = md.split("\n");
  assert.ok(lines.includes("- test: baseline p50 100s, recent p50 200s (+100%) REGRESSED"), md);
  assert.ok(lines.includes("  - unit / npm test: 50s → 140s (+90s)"), md);
  assert.ok(lines.includes("Regression: yes."), md);
});

// ---------- CLI ----------

test("first report shows onboarding (evaluated before the profile is stored); the next one does not", (t) => {
  const home = tempDir(t, "ci-report-state-");
  const repo = repoWith(t, { ".github/workflows/test.yml": WORKFLOW });
  const first = ci(repo, home, "report");
  const second = ci(repo, home, "report");
  assert.equal(first.code, 0, first.stderr);
  assert.match(first.stdout, /- \*\*onboarding\*\*: no CI profile for this repository/);
  assert.equal(second.code, 0, second.stderr);
  assert.match(second.stdout, /## Triggers\n\nNo trigger fired\./);
});

test("a baseline.json that is not a baseline document is treated as no baseline", (t) => {
  const home = tempDir(t, "ci-report-state-");
  const repo = repoWith(t, { ".github/workflows/test.yml": WORKFLOW });
  const dir = ciStateDir(repo, { AUTOBUILD_STATE_HOME: home });
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(path.join(dir, "baseline.json"), JSON.stringify({ schemaVersion: 1, workflows: "nope" }));
  const r = ci(repo, home, "report", "--json");
  assert.equal(r.code, 0, r.stderr);
  const doc = JSON.parse(r.stdout);
  assert.equal(doc.baseline, null);
  assert.equal(doc.regression, null);
});

test("--out refuses a path whose parent is a symbolic link into .git, and writes nothing", (t) => {
  const home = tempDir(t, "ci-report-state-");
  const repo = repoWith(t, { ".github/workflows/test.yml": WORKFLOW });
  symlinkSync(path.join(repo, ".git"), path.join(repo, "gitlink"));
  const outside = tempDir(t, "ci-report-out-");
  symlinkSync(path.join(repo, ".git", "hooks"), path.join(outside, "hooks"));
  for (const arg of ["gitlink/report.md", path.join(outside, "hooks", "report.md"), "gitlink/new-dir/report.md", ".git"]) {
    const r = ci(repo, home, "report", "--out", arg);
    assert.equal(r.code, 2, `${arg}: ${r.stderr}`);
    assert.match(r.stderr, /^autobuild ci: OUT_UNSAFE: /, arg);
  }
  assert.ok(!existsSync(path.join(repo, ".git", "report.md")));
  assert.ok(!existsSync(path.join(repo, ".git", "hooks", "report.md")));
});

test("--out with a nested autobuild.json root still refuses the git top level's .git, and resolves against cwd", (t) => {
  const home = tempDir(t, "ci-report-state-");
  const repo = repoWith(t, { ".github/workflows/test.yml": WORKFLOW, "app/autobuild.json": {}, "app/package.json": { name: "a", scripts: { test: "node --test" } } });
  const app = path.join(repo, "app");
  const refused = ci(app, home, "report", "--out", "../.git/report.md");
  assert.equal(refused.code, 2, refused.stderr);
  assert.match(refused.stderr, /OUT_UNSAFE/);
  assert.ok(!existsSync(path.join(repo, ".git", "report.md")));
  const ok = ci(app, home, "report", "--out", "r.md");
  assert.equal(ok.code, 0, ok.stderr);
  assert.equal(ok.stdout, "report: wrote r.md\n");
  assert.deepEqual(headings(readFileSync(path.join(app, "r.md"), "utf8")), HEADINGS);
});

test("--out refuses a linked work tree's .git file and the main repository's git directory", (t) => {
  const home = tempDir(t, "ci-report-state-");
  const repo = repoWith(t, { ".github/workflows/test.yml": WORKFLOW });
  const worktree = path.join(tempDir(t, "ci-report-wt-"), "wt");
  git(repo, "worktree", "add", "-q", "-b", "side", worktree);
  const before = readFileSync(path.join(worktree, ".git"), "utf8");
  for (const arg of [".git", path.join(repo, ".git", "report.md")]) {
    const r = ci(worktree, home, "report", "--out", arg);
    assert.equal(r.code, 2, `${arg}: ${r.stderr}`);
    assert.match(r.stderr, /OUT_UNSAFE/, arg);
  }
  assert.equal(readFileSync(path.join(worktree, ".git"), "utf8"), before, "the .git file is untouched");
  assert.ok(!existsSync(path.join(repo, ".git", "report.md")));
});

test("--out replaces an existing file's content and sets mode 0644", (t) => {
  const home = tempDir(t, "ci-report-state-");
  const repo = repoWith(t, { ".github/workflows/test.yml": WORKFLOW });
  const out = path.join(tempDir(t, "ci-report-out-"), "report.json");
  writeFileSync(out, "x".repeat(200_000));
  chmodSync(out, 0o600);
  const r = ci(repo, home, "report", "--json", "--out", out);
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout), { wrote: out }, "--json prints {wrote} in place of the line");
  assert.equal(JSON.parse(readFileSync(out, "utf8")).schemaVersion, 1, "the old, longer content is gone");
  assert.equal(statSync(out).mode & 0o777, 0o644);
});

test("--out into a missing directory is an I/O error (exit 3) and creates nothing", (t) => {
  const home = tempDir(t, "ci-report-state-");
  const repo = repoWith(t, { ".github/workflows/test.yml": WORKFLOW });
  const missing = path.join(tempDir(t, "ci-report-out-"), "no", "such");
  const r = ci(repo, home, "report", "--out", path.join(missing, "r.md"));
  assert.equal(r.code, 3, r.stderr);
  assert.match(r.stderr, /^autobuild ci: OUT_IO: cannot write /);
  assert.ok(!existsSync(missing));
});

test("--out refuses a FIFO without blocking", (t) => {
  const home = tempDir(t, "ci-report-state-");
  const repo = repoWith(t, { ".github/workflows/test.yml": WORKFLOW });
  const fifo = path.join(tempDir(t, "ci-report-out-"), "pipe");
  if (spawnSync("mkfifo", [fifo]).status !== 0) {
    t.skip("mkfifo is not available");
    return;
  }
  const r = ci(repo, home, "report", "--out", fifo);
  assert.equal(r.code, 2, r.stderr);
  assert.match(r.stderr, /OUT_UNSAFE: --out .* is not a regular file/);
});

test("--out needs a value", (t) => {
  const home = tempDir(t, "ci-report-state-");
  const repo = repoWith(t, { ".github/workflows/test.yml": WORKFLOW });
  const usage = ci(repo, home, "report", "--out");
  assert.equal(usage.code, 2);
  assert.match(usage.stderr, /autobuild ci: USAGE: --out needs a value/);
});
