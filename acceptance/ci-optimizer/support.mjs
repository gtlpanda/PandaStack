// Shared helpers for the ci-optimizer acceptance tests (spec/contracts/ci-optimizer-*.md).
// Every helper is offline: throwaway git repositories, a private state home, and a fake `gh`
// that serves the recorded GitHub API responses in fixtures/github/pandastack/.
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmodSync, cpSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

export const ROOT = path.resolve(import.meta.dirname, '..', '..')
export const FIXTURES = path.join(import.meta.dirname, 'fixtures')
export const GITHUB_FIXTURE = path.join(FIXTURES, 'github', 'pandastack')
export const CLI = path.join(ROOT, 'graphs', 'autobuild', 'tool', 'lib', 'cli.mjs')
export const LIB = path.join(ROOT, 'graphs', 'autobuild', 'tool', 'lib')
export const REPO = 'example/pandastack'

/** Imports a ci-optimizer module lazily, so a test file loads before its feature exists. */
export const ci = (name) => import(path.join(LIB, 'ci', `${name}.mjs`))

const GIT_ENV = {
  GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', LANG: 'C',
  GIT_AUTHOR_NAME: 'fixture', GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
  GIT_COMMITTER_NAME: 'fixture', GIT_COMMITTER_EMAIL: 'fixture@example.invalid',
}

/** A temp directory removed after the test. */
export function tempDir(t, prefix = 'ci-opt-') {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), prefix)))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

/** A private state home for one test; also set on process.env for in-process module calls. */
export function stateHome(t) {
  const dir = tempDir(t, 'ci-opt-state-')
  const before = process.env.AUTOBUILD_STATE_HOME
  process.env.AUTOBUILD_STATE_HOME = dir
  t.after(() => { if (before === undefined) delete process.env.AUTOBUILD_STATE_HOME; else process.env.AUTOBUILD_STATE_HOME = before })
  return dir
}

export function git(repo, ...args) {
  const r = spawnSync('git', ['-c', 'init.defaultBranch=main', ...args], { cwd: repo, env: { ...process.env, ...GIT_ENV }, encoding: 'utf8' })
  if (r.status !== 0) throw new Error(`fixture: git ${args.join(' ')}: ${r.stderr}`)
  return r.stdout.trim()
}

/**
 * A committed git repository holding `files` ({ relpath: string content }), on branch main.
 * `copy` lists fixture directories (relative to fixtures/) whose contents are copied in first.
 */
export function makeRepo(t, files = {}, { copy = [] } = {}) {
  const repo = tempDir(t, 'ci-opt-repo-')
  for (const dir of copy) cpSync(path.join(FIXTURES, dir), repo, { recursive: true })
  writeFiles(repo, files)
  git(repo, 'init', '-q')
  git(repo, 'add', '-A')
  git(repo, 'commit', '-q', '--allow-empty', '-m', 'fixture')
  return repo
}

export function writeFiles(repo, files) {
  for (const [rel, content] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(repo, rel)), { recursive: true })
    writeFileSync(path.join(repo, rel), typeof content === 'string' ? content : `${JSON.stringify(content, null, 2)}\n`)
  }
}

/** PandaStack's own CI workflow, as recorded at the freeze (fixtures/workflows/pandastack-test.yml). */
export const PANDASTACK_WORKFLOW = readFileSync(path.join(FIXTURES, 'workflows', 'pandastack-test.yml'), 'utf8')

/**
 * Writes a fake `gh` into `dir` and returns { bin, calls() }. It answers an argument vector
 * found in `<fixture>/index.json` with that file's bytes; any other vector exits 1. With
 * `failOnCall: n`, the n-th call (1-based) exits 1. Every call is logged.
 */
export function fakeGh(t, { fixture = GITHUB_FIXTURE, failOnCall = 0 } = {}) {
  const dir = tempDir(t, 'ci-opt-gh-')
  const log = path.join(dir, 'calls.jsonl')
  const bin = path.join(dir, 'gh')
  writeFileSync(log, '')
  writeFileSync(bin, `#!${process.execPath}
const fs = require('node:fs'), path = require('node:path')
const args = process.argv.slice(2)
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(args) + '\\n')
const n = fs.readFileSync(${JSON.stringify(log)}, 'utf8').split('\\n').filter(Boolean).length
if (${Number(failOnCall)} && n === ${Number(failOnCall)}) { process.stderr.write('fake gh: planned failure\\n'); process.exit(1) }
const index = JSON.parse(fs.readFileSync(${JSON.stringify(path.join(fixture, 'index.json'))}, 'utf8'))
const file = index[JSON.stringify(args)]
if (!file) { process.stderr.write('fake gh: unknown call ' + JSON.stringify(args) + '\\n'); process.exit(1) }
process.stdout.write(fs.readFileSync(path.join(${JSON.stringify(fixture)}, file)))
`)
  chmodSync(bin, 0o755)
  const calls = () => readFileSync(log, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line))
  return { bin, calls }
}

/** Runs `autobuild ci <args>` in `cwd`. Returns { code, stdout, stderr, json() }. */
export function runCi(cwd, args, env = {}) {
  const r = spawnSync(process.execPath, [CLI, 'ci', ...args], { cwd, encoding: 'utf8', env: { ...process.env, ...GIT_ENV, ...env }, timeout: 120_000 })
  return { code: r.status, stdout: r.stdout, stderr: r.stderr, json: () => JSON.parse(r.stdout) }
}

/** Runs any autobuild subcommand (for `status`, `run`) in `cwd`. */
export function runAutobuild(cwd, args, env = {}) {
  const r = spawnSync(process.execPath, [CLI, ...args], { cwd, encoding: 'utf8', env: { ...process.env, ...GIT_ENV, ...env }, timeout: 120_000 })
  return { code: r.status, stdout: r.stdout, stderr: r.stderr }
}

/**
 * The recorded attempts, normalized exactly as CO-03 specifies, computed here from the raw
 * fixture so tests do not depend on the code under test for their expected values.
 */
export function recordedAttempts() {
  const read = (file) => JSON.parse(readFileSync(path.join(GITHUB_FIXTURE, file), 'utf8'))
  const runs = read('runs.json').workflow_runs
  const attempts = []
  for (const run of runs) {
    for (let a = 1; a <= run.run_attempt; a++) {
      const r = a < run.run_attempt ? read(`run-${run.id}-${a}.json`) : run
      const jobs = read(`jobs-${run.id}-${a}.json`).jobs
      attempts.push({
        provider: 'github', runId: run.id, attempt: a, workflow: r.name, workflowPath: r.path, event: r.event,
        headSha: r.head_sha, branch: r.head_branch, conclusion: r.conclusion,
        createdAt: r.created_at, startedAt: r.run_started_at, updatedAt: r.updated_at,
        jobs: jobs.map((j) => ({
          name: j.name, conclusion: j.conclusion, createdAt: j.created_at ?? null, startedAt: j.started_at ?? null,
          completedAt: j.completed_at ?? null, labels: j.labels ?? [],
          steps: (j.steps ?? []).map((s) => ({ number: s.number, name: s.name, conclusion: s.conclusion, startedAt: s.started_at ?? null, completedAt: s.completed_at ?? null })),
        })),
      })
    }
  }
  return attempts
}

/** Writes `{ attempts }` to a file for `autobuild ci history --import`. */
export function importFile(t, attempts) {
  const file = path.join(tempDir(t, 'ci-opt-import-'), 'attempts.json')
  writeFileSync(file, JSON.stringify({ attempts }))
  return file
}

export const sha256hex = (bytes) => createHash('sha256').update(bytes).digest('hex')
