// FROZEN acceptance tests for CO-03 (spec/contracts/ci-optimizer-co-03.md): CI history through
// a gh port. Written from the contract only, before any implementation exists. Every
// ci-optimizer module is imported lazily through support.mjs. Offline: a private state home,
// throwaway repositories and a fake `gh` that serves the recorded GitHub responses.
//
// Reading notes (contract ambiguities resolved here, all listed in the author's report):
//  - The gh call order is the literal phased order of the contract's numbered list: the runs
//    call, then every earlier-attempt call, then every jobs call.
//  - fetchGithubHistory's return order is unspecified, so it is compared by `runId#attempt`.
//    The stored and CLI order IS specified, and is computed here independently.
//  - normalizeAttempt(run, jobsDoc) takes the attempt number from `run.run_attempt`.
//  - IMPORT_INVALID names the record index 0-based (the literal array index).
//  - The GH_FAILED message format is unspecified: the argument vector is matched by its API
//    path string, and the exit status by the digit.
//  - Exit-code-2 cases always pair the code with the `autobuild ci:` stderr shape, because the
//    pre-existing CLI already exits 2 for an unknown command.
//  - Every CLI call sets AUTOBUILD_GH_BIN to a fake gh, so a mistaken call can never reach a real gh.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync, realpathSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { GITHUB_FIXTURE, REPO, ci, fakeGh, git, importFile, makeRepo, recordedAttempts, runCi, sha256hex, stateHome, tempDir, writeFiles } from './support.mjs'

// ---------- helpers (expected values are computed here, never from the code under test) ----------

const readFixture = (file) => JSON.parse(readFileSync(path.join(GITHUB_FIXTURE, file), 'utf8'))

const expectedStateDir = (home, root) => path.join(home, 'autobuild', 'ci', sha256hex(realpathSync(root)).slice(0, 24))
const historyFile = (home, root) => path.join(expectedStateDir(home, root), 'history.json')
const mode = (file) => statSync(file).mode & 0o777
const PAST = new Date('2020-01-01T00:00:00Z')

const runsCall = (limit) => ['api', `repos/${REPO}/actions/runs?per_page=${limit}&status=completed`]

/** The contract's gh call sequence for the recorded runs: runs, all earlier attempts, all jobs. */
function expectedCalls(limit) {
  const runs = readFixture('runs.json').workflow_runs
  const calls = [runsCall(limit)]
  for (const run of runs) for (let k = 1; k < run.run_attempt; k++) calls.push(['api', `repos/${REPO}/actions/runs/${run.id}/attempts/${k}`])
  for (const run of runs) for (let a = 1; a <= run.run_attempt; a++) calls.push(['api', `repos/${REPO}/actions/runs/${run.id}/attempts/${a}/jobs?per_page=100`])
  return calls
}

const keyOf = (attempt) => `${attempt.runId}#${attempt.attempt}`
const byKey = (list) => [...list].sort((a, b) => (keyOf(a) < keyOf(b) ? -1 : 1))

/** startedAt descending, then runId descending, then attempt descending; null startedAt last. */
function sortedPerContract(list) {
  return [...list].sort((x, y) => {
    if ((x.startedAt === null) !== (y.startedAt === null)) return x.startedAt === null ? 1 : -1
    if (x.startedAt !== y.startedAt) return x.startedAt < y.startedAt ? 1 : -1
    if (x.runId !== y.runId) return y.runId - x.runId
    return y.attempt - x.attempt
  })
}

const fetchFrom = async (gh, limit = 40) => (await ci('history')).fetchGithubHistory({ repo: REPO, ghBin: gh.bin, limit, env: process.env })

/** A well-formed normalized record from a non-GitHub provider. */
const gitlabRecord = (runId, startedAt, overrides = {}) => ({
  provider: 'gitlab', runId, attempt: 1, workflow: 'pipeline', workflowPath: '.gitlab-ci.yml', event: 'push',
  headSha: 'a'.repeat(40), branch: 'main', conclusion: 'success',
  createdAt: '2026-11-20T09:59:00Z', startedAt, updatedAt: '2026-11-22T10:10:00Z',
  jobs: [{
    name: 'unit', conclusion: 'success', createdAt: '2026-11-20T10:00:00Z', startedAt: '2026-11-20T10:00:05Z', completedAt: '2026-11-20T10:02:00Z',
    labels: ['docker'], steps: [{ number: 1, name: 'script', conclusion: 'success', startedAt: '2026-11-20T10:00:06Z', completedAt: '2026-11-20T10:02:00Z' }],
  }],
  ...overrides,
})

const GITLAB_TWO = [gitlabRecord(9001, '2026-11-20T10:00:05Z'), gitlabRecord(9002, '2026-11-21T10:00:05Z')]

/** Runs `autobuild ci history <args>` against the fake gh. */
const history = (repo, gh, args, env = {}) => runCi(repo, ['history', ...args], { AUTOBUILD_GH_BIN: gh.bin, ...env })

const repoWithOrigin = (t, url) => {
  const repo = makeRepo(t, {})
  if (url) git(repo, 'remote', 'add', 'origin', url)
  return repo
}

// ---------- case 1 and 2: fetch and normalize ----------

test('CO-03 case 1: fetchGithubHistory makes exactly the contract call sequence and returns 41 attempts', async (t) => {
  const gh = fakeGh(t)
  const attempts = await fetchFrom(gh)

  const expected = expectedCalls(40)
  assert.equal(expected.length, 43, 'test sanity: 1 runs call + 1 earlier-attempt call + 41 jobs calls')
  assert.deepEqual(gh.calls(), expected,
    'CO-03 case 1: calls are the runs call, then the earlier-attempt call for run 44929986613, then 41 jobs calls, in the contract order')
  assert.equal(attempts.length, 41, 'CO-03 case 1: 41 attempts')
  assert.deepEqual(byKey(attempts), byKey(recordedAttempts()), 'CO-03 case 1: every attempt matches the independently normalized fixture')

  const rerun = (n) => attempts.find((a) => a.runId === 44929986613 && a.attempt === n)
  assert.equal(rerun(1).conclusion, 'failure', 'CO-03 case 1: run 44929986613 attempt 1 is a failure')
  assert.equal(rerun(2).conclusion, 'success', 'CO-03 case 1: run 44929986613 attempt 2 succeeded')
})

test('CO-03 case 2: the newest attempt (run 45056977608) maps every field', async (t) => {
  const attempts = await fetchFrom(fakeGh(t))
  const newest = attempts.find((a) => a.runId === 45056977608 && a.attempt === 1)
  assert.ok(newest, 'CO-03 case 2: run 45056977608 attempt 1 is present')

  assert.deepEqual(Object.keys(newest).sort(),
    ['attempt', 'branch', 'conclusion', 'createdAt', 'event', 'headSha', 'jobs', 'provider', 'runId', 'startedAt', 'updatedAt', 'workflow', 'workflowPath'],
    'CO-03 case 2: exactly the normalized attempt keys')
  assert.equal(newest.provider, 'github', 'CO-03 case 2: provider')
  assert.equal(newest.workflow, 'test', 'CO-03 case 2: workflow')
  assert.equal(newest.event, 'push', 'CO-03 case 2: event')
  assert.equal(newest.branch, 'main', 'CO-03 case 2: branch')
  assert.deepEqual(newest.jobs.map((j) => j.name), ['gate shard 2', 'gate shard 1', 'gate shard 3', 'test'], 'CO-03 case 2: four jobs in API order')
  assert.ok(newest.jobs.every((j) => JSON.stringify(j.labels) === '["ubuntu-22.04"]'), 'CO-03 case 2: labels ["ubuntu-22.04"]')
  assert.deepEqual(Object.keys(newest.jobs[0]).sort(), ['completedAt', 'conclusion', 'createdAt', 'labels', 'name', 'startedAt', 'steps'], 'CO-03 case 2: job keys')
  assert.deepEqual(Object.keys(newest.jobs[0].steps[0]).sort(), ['completedAt', 'conclusion', 'name', 'number', 'startedAt'], 'CO-03 case 2: step keys')

  // Step names and timestamps exactly as the raw fixture holds them (read here, not through the code under test).
  const raw = readFixture('jobs-45056977608-1.json').jobs[0]
  assert.deepEqual(newest.jobs[0].steps.map((s) => [s.number, s.name, s.conclusion, s.startedAt, s.completedAt]),
    raw.steps.map((s) => [s.number, s.name, s.conclusion, s.started_at, s.completed_at]), 'CO-03 case 2: steps keep names and timestamps')
  assert.deepEqual([newest.jobs[0].createdAt, newest.jobs[0].startedAt, newest.jobs[0].completedAt], [raw.created_at, raw.started_at, raw.completed_at],
    'CO-03 case 2: job timestamps')
  const run = readFixture('runs.json').workflow_runs.find((r) => r.id === 45056977608)
  assert.deepEqual([newest.createdAt, newest.startedAt, newest.updatedAt, newest.headSha, newest.workflowPath],
    [run.created_at, run.run_started_at, run.updated_at, run.head_sha, run.path], 'CO-03 case 2: run timestamps, headSha and path')
})

test('CO-03 case 2: an earlier attempt takes its run fields from the attempt response, via normalizeAttempt', async () => {
  const { normalizeAttempt } = await ci('history')
  const one = await normalizeAttempt(readFixture('run-44929986613-1.json'), readFixture('jobs-44929986613-1.json'))
  const expected = recordedAttempts().find((a) => a.runId === 44929986613 && a.attempt === 1)
  assert.deepEqual(one, expected, 'CO-03 case 2: normalizeAttempt of the earlier attempt equals the independently normalized record')
  assert.equal(one.attempt, 1, 'CO-03 case 2: attempt comes from run.run_attempt')
  assert.equal(one.conclusion, 'failure', 'CO-03 case 2: the earlier attempt keeps its own conclusion')
})

test('CO-03 case 2: missing values become null', async () => {
  const { normalizeAttempt } = await ci('history')
  const run = { id: 7, name: 'w', path: '.github/workflows/w.yml', event: 'push', head_sha: 'abc', conclusion: 'cancelled', run_attempt: 2, created_at: '2026-01-01T00:00:00Z' }
  const jobs = { jobs: [{ name: 'j', created_at: '2026-01-01T00:00:01Z', labels: ['x'], steps: [{ name: 's', number: 1, conclusion: 'skipped' }] }] }
  const out = await normalizeAttempt(run, jobs)

  assert.equal(out.attempt, 2, 'CO-03 case 2: attempt is run.run_attempt')
  assert.strictEqual(out.branch, null, 'CO-03 case 2: missing head_branch -> null')
  assert.strictEqual(out.startedAt, null, 'CO-03 case 2: missing run_started_at -> null')
  assert.strictEqual(out.updatedAt, null, 'CO-03 case 2: missing updated_at -> null')
  assert.strictEqual(out.jobs[0].startedAt, null, 'CO-03 case 2: missing job started_at -> null')
  assert.strictEqual(out.jobs[0].completedAt, null, 'CO-03 case 2: missing job completed_at -> null')
  assert.strictEqual(out.jobs[0].conclusion, null, 'CO-03 case 2: missing job conclusion -> null')
  assert.strictEqual(out.jobs[0].steps[0].startedAt, null, 'CO-03 case 2: missing step started_at -> null')
  assert.strictEqual(out.jobs[0].steps[0].completedAt, null, 'CO-03 case 2: missing step completed_at -> null')
})

// ---------- case 3: the store ----------

test('CO-03 case 3: --from-gh stores 41 attempts, a second run adds none, and history.json is 0600 in ciStateDir', async (t) => {
  const home = stateHome(t)
  const gh = fakeGh(t)
  const repo = makeRepo(t, {})
  const args = ['--from-gh', '--repo', REPO, '--limit', '40', '--json']

  const first = history(repo, gh, args)
  assert.equal(first.code, 0, `CO-03 case 3: first run exits 0 (stderr: ${first.stderr})`)
  const doc = first.json()
  assert.deepEqual(Object.keys(doc).sort(), ['attempts', 'new', 'source', 'total'], 'CO-03 case 3: --json document keys')
  assert.equal(doc.total, 41, 'CO-03 case 3: total 41')
  assert.equal(doc.new, 41, 'CO-03 case 3: new 41')
  assert.deepEqual(doc.source, { provider: 'github', repo: REPO }, 'CO-03 case 3: source')
  const expected = sortedPerContract(recordedAttempts())
  assert.deepEqual(doc.attempts, expected, 'CO-03 case 3: attempts sorted by startedAt desc, runId desc, attempt desc')
  assert.deepEqual(gh.calls(), expectedCalls(40), 'CO-03 case 3: the CLI makes the contract call sequence')

  const file = historyFile(home, repo)
  assert.equal(mode(file).toString(8), '600', 'CO-03 case 3: history.json mode 0600')
  assert.equal(mode(path.dirname(file)).toString(8), '700', 'CO-03 case 3: state directory mode 0700')
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), { schemaVersion: 1, source: { provider: 'github', repo: REPO }, attempts: expected },
    'CO-03 case 3: stored document is { schemaVersion, source, attempts }')

  const second = history(repo, gh, args)
  assert.equal(second.code, 0, 'CO-03 case 3: second run exits 0')
  assert.equal(second.json().new, 0, 'CO-03 case 3: second run reports new 0')
  assert.equal(second.json().total, 41, 'CO-03 case 3: second run still has 41')
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).attempts.length, 41, 'CO-03 case 3: the store still holds 41')

  const human = history(repo, gh, ['--from-gh', '--repo', REPO, '--limit', '40'])
  assert.equal(human.stdout.trimEnd(), `history: 41 attempts (0 new) from github ${REPO}`, 'CO-03 case 3: human output line')
})

test('CO-03 case 3: the first human line reports new attempts', async (t) => {
  stateHome(t)
  const out = history(makeRepo(t, {}), fakeGh(t), ['--from-gh', '--repo', REPO, '--limit', '40'])
  assert.equal(out.code, 0, `CO-03 case 3: exit 0 (stderr: ${out.stderr})`)
  assert.equal(out.stdout.trimEnd(), `history: 41 attempts (41 new) from github ${REPO}`, 'CO-03 case 3: `history: <total> attempts (<new> new) from github <owner/name>`')
})

// ---------- case 4: a failed fetch changes nothing ----------

test('CO-03 case 4: a gh failure on the tenth call exits 3 with GH_FAILED and leaves history.json byte-for-byte', async (t) => {
  const home = stateHome(t)
  const repo = makeRepo(t, {})
  const seeded = history(repo, fakeGh(t), ['--from-gh', '--repo', REPO, '--limit', '40'])
  assert.equal(seeded.code, 0, `test sanity: the seeding fetch succeeds (stderr: ${seeded.stderr})`)
  const file = historyFile(home, repo)
  const bytes = readFileSync(file)
  utimesSync(file, PAST, PAST)
  const mtime = statSync(file).mtimeMs

  const failing = fakeGh(t, { failOnCall: 10 })
  const run = history(repo, failing, ['--from-gh', '--repo', REPO, '--limit', '40'])
  assert.equal(run.code, 3, `CO-03 case 4: exit 3 (stderr: ${run.stderr})`)
  assert.match(run.stderr, /^autobuild ci: GH_FAILED: /m, 'CO-03 case 4: stderr is `autobuild ci: GH_FAILED: <message>`')
  const calls = failing.calls()
  assert.equal(calls.length, 10, 'CO-03 case 4: the fetch stops at the failing call')
  assert.ok(run.stderr.includes(calls[9][1]), 'CO-03 case 4: the message names the failing argument vector (its API path)')
  assert.match(run.stderr.replace(calls[9][1], ''), /\b1\b/, 'CO-03 case 4: the message names the exit status 1 (checked with the argument vector removed first, as it contains digits)')
  assert.ok(readFileSync(file).equals(bytes), 'CO-03 case 4: history.json bytes are unchanged')
  assert.equal(statSync(file).mtimeMs, mtime, 'CO-03 case 4: history.json was not rewritten')

  const jsonFailing = fakeGh(t, { failOnCall: 10 })
  const asJson = history(repo, jsonFailing, ['--from-gh', '--repo', REPO, '--limit', '40', '--json'])
  assert.equal(asJson.code, 3, 'CO-03 case 4: --json also exits 3')
  const doc = JSON.parse(asJson.stdout)
  assert.equal(doc.error, 'GH_FAILED', 'CO-03 case 4: --json prints {"error":"GH_FAILED",...}')
  assert.equal(typeof doc.message, 'string', 'CO-03 case 4: --json error has a message')
})

test('CO-03 case 4: a failed first fetch creates no history.json (a partial fetch is never merged)', async (t) => {
  const home = stateHome(t)
  const repo = makeRepo(t, {})
  const run = history(repo, fakeGh(t, { failOnCall: 5 }), ['--from-gh', '--repo', REPO, '--limit', '40'])
  assert.equal(run.code, 3, `CO-03 case 4: exit 3 (stderr: ${run.stderr})`)
  assert.match(run.stderr, /^autobuild ci: GH_FAILED: /m, 'CO-03 case 4: GH_FAILED')
  assert.ok(!existsSync(historyFile(home, repo)), 'CO-03 case 4: nothing stored from the partial fetch')
})

test('CO-03 case 4: the module API throws GH_FAILED on a non-zero exit and on invalid JSON', async (t) => {
  await ci('history') // load it first, so a missing module is reported as such rather than as a wrong error
  const isGhFailed = (err) => err.code === 'GH_FAILED' || /GH_FAILED/.test(String(err.message))
  await assert.rejects(() => fetchFrom(fakeGh(t, { failOnCall: 3 })), isGhFailed, 'CO-03 case 4: a failing call -> GH_FAILED')

  const fixture = tempDir(t, 'ci-opt-badjson-')
  writeFiles(fixture, { 'index.json': { [JSON.stringify(runsCall(5))]: 'runs.json' }, 'runs.json': 'this is not json{' })
  await assert.rejects(() => fetchFrom(fakeGh(t, { fixture }), 5), isGhFailed, 'CO-03 case 4: invalid JSON output -> GH_FAILED')
})

// ---------- case 5: repository resolution and limits ----------

test('CO-03 case 5: without --repo the repo comes from the origin remote', async (t) => {
  stateHome(t)
  const gh = fakeGh(t)
  const repo = repoWithOrigin(t, 'git@github.com:example/pandastack.git')
  const run = history(repo, gh, ['--from-gh', '--limit', '40', '--json'])

  assert.equal(run.code, 0, `CO-03 case 5: exit 0 (stderr: ${run.stderr})`)
  assert.deepEqual(run.json().source, { provider: 'github', repo: REPO }, 'CO-03 case 5: repo resolved from origin')
  assert.deepEqual(gh.calls()[0], runsCall(40), 'CO-03 case 5: the first gh call uses the resolved repo')
})

test('CO-03 case 5: with no origin the command exits 2 with REPO_UNKNOWN and calls nothing', async (t) => {
  const home = stateHome(t)
  const gh = fakeGh(t)
  const repo = repoWithOrigin(t, null)

  const run = history(repo, gh, ['--from-gh', '--limit', '40'])
  assert.equal(run.code, 2, `CO-03 case 5: exit 2 (stderr: ${run.stderr})`)
  assert.match(run.stderr, /^autobuild ci: REPO_UNKNOWN: /m, 'CO-03 case 5: stderr is `autobuild ci: REPO_UNKNOWN: <message>`')
  const asJson = history(repo, gh, ['--from-gh', '--json'])
  assert.equal(asJson.code, 2, 'CO-03 case 5: --json exits 2 too')
  assert.equal(JSON.parse(asJson.stdout).error, 'REPO_UNKNOWN', 'CO-03 case 5: --json prints {"error":"REPO_UNKNOWN",...}')
  assert.deepEqual(gh.calls(), [], 'CO-03 case 5: gh was never called')
  assert.ok(!existsSync(historyFile(home, repo)), 'CO-03 case 5: nothing stored')
})

test('CO-03 case 5: githubRepo parses both GitHub remote forms and rejects look-alikes', async (t) => {
  const { githubRepo } = await ci('history')
  const accepted = [
    'https://github.com/example/pandastack', 'https://github.com/example/pandastack.git',
    'git@github.com:example/pandastack', 'git@github.com:example/pandastack.git',
  ]
  for (const url of accepted) assert.equal(await githubRepo(repoWithOrigin(t, url)), REPO, `CO-03 case 5: ${url} -> example/pandastack`)

  const rejected = [
    'https://gitlab.com/example/pandastack.git', 'https://notgithub.com/example/pandastack',
    'https://github.com.evil.example/example/pandastack.git', 'git@github.com.evil.example:example/pandastack.git',
  ]
  for (const url of rejected) assert.strictEqual(await githubRepo(repoWithOrigin(t, url)), null, `CO-03 case 5: ${url} is not a GitHub remote`)

  assert.strictEqual(await githubRepo(repoWithOrigin(t, null)), null, 'CO-03 case 5: no origin -> null')
  const other = repoWithOrigin(t, null)
  git(other, 'remote', 'add', 'upstream', 'https://github.com/example/pandastack.git')
  assert.strictEqual(await githubRepo(other), null, 'CO-03 case 5: only the origin remote counts')
})

test('CO-03 case 5: --limit outside 1..100 or not a whole number exits 2 without calling gh', async (t) => {
  stateHome(t)
  const gh = fakeGh(t)
  const repo = makeRepo(t, {})
  for (const limit of ['0', '101', '-1', 'abc', '2.5']) {
    const run = history(repo, gh, ['--from-gh', '--repo', REPO, '--limit', limit])
    assert.equal(run.code, 2, `CO-03 case 5: --limit ${limit} exits 2 (stderr: ${run.stderr})`)
    assert.match(run.stderr, /^autobuild ci: /m, `CO-03 case 5: --limit ${limit} is reported as an \`autobuild ci:\` error`)
  }
  assert.deepEqual(gh.calls(), [], 'CO-03 case 5: gh was never called for a bad limit')
})

test('CO-03 case 5: the limits 1 and 100 are accepted (the fetch reaches gh and fails there, exit 3)', async (t) => {
  stateHome(t)
  const repo = makeRepo(t, {})
  for (const limit of [1, 100]) {
    const gh = fakeGh(t)
    const run = history(repo, gh, ['--from-gh', '--repo', REPO, '--limit', String(limit)])
    assert.equal(run.code, 3, `CO-03 case 5: --limit ${limit} is valid; the recorded fixture has no such page, so gh fails (stderr: ${run.stderr})`)
    assert.match(run.stderr, /^autobuild ci: GH_FAILED: /m, `CO-03 case 5: --limit ${limit} -> GH_FAILED`)
    assert.deepEqual(gh.calls()[0], runsCall(limit), `CO-03 case 5: --limit ${limit} is sent as per_page=${limit}`)
  }
})

test('CO-03 case 5: the limit defaults to ciOptimizer.historyLimit (30 by default)', async (t) => {
  stateHome(t)
  const defaulted = fakeGh(t)
  const run = history(makeRepo(t, {}), defaulted, ['--from-gh', '--repo', REPO])
  assert.equal(run.code, 3, 'CO-03 case 5: the default limit 30 is not in the recorded fixture, so gh fails')
  assert.deepEqual(defaulted.calls()[0], runsCall(30), 'CO-03 case 5: the default is per_page=30')

  const gh = fakeGh(t)
  const configured = makeRepo(t, { 'autobuild.json': { ciOptimizer: { historyLimit: 40 } } })
  const ok = history(configured, gh, ['--from-gh', '--repo', REPO, '--json'])
  assert.equal(ok.code, 0, `CO-03 case 5: historyLimit 40 from autobuild.json is the default limit (stderr: ${ok.stderr})`)
  assert.equal(ok.json().new, 41, 'CO-03 case 5: 41 attempts fetched with the configured limit')
  assert.deepEqual(gh.calls()[0], runsCall(40), 'CO-03 case 5: per_page=40')
})

test('CO-03: the gh binary is ciOptimizer.ghBin, and AUTOBUILD_GH_BIN overrides it', async (t) => {
  stateHome(t)
  const gh = fakeGh(t)

  const viaConfig = makeRepo(t, { 'autobuild.json': { ciOptimizer: { ghBin: gh.bin, historyLimit: 40 } } })
  const a = runCi(viaConfig, ['history', '--from-gh', '--repo', REPO, '--json'], { AUTOBUILD_GH_BIN: undefined })
  assert.equal(a.code, 0, `CO-03 policy: ciOptimizer.ghBin is used when the variable is unset (stderr: ${a.stderr})`)
  assert.equal(a.json().new, 41, 'CO-03 policy: fetched through the configured ghBin')

  const gh2 = fakeGh(t)
  const overridden = makeRepo(t, { 'autobuild.json': { ciOptimizer: { ghBin: '/nonexistent/gh', historyLimit: 40 } } })
  const b = runCi(overridden, ['history', '--from-gh', '--repo', REPO, '--json'], { AUTOBUILD_GH_BIN: gh2.bin })
  assert.equal(b.code, 0, `CO-03 policy: AUTOBUILD_GH_BIN overrides ciOptimizer.ghBin (stderr: ${b.stderr})`)
  assert.deepEqual(gh2.calls()[0], runsCall(40), 'CO-03 policy: the environment binary was the one called')
})

// ---------- case 6: import ----------

test('CO-03 case 6: --import merges a two-record GitLab-provider file with source.provider "import"', async (t) => {
  const home = stateHome(t)
  const gh = fakeGh(t)
  const repo = makeRepo(t, {})
  const file = importFile(t, GITLAB_TWO)

  const run = history(repo, gh, ['--import', file, '--json'])
  assert.equal(run.code, 0, `CO-03 case 6: exit 0 (stderr: ${run.stderr})`)
  const doc = run.json()
  assert.equal(doc.total, 2, 'CO-03 case 6: total 2')
  assert.equal(doc.new, 2, 'CO-03 case 6: new 2')
  assert.deepEqual(doc.source, { provider: 'import', file: path.basename(file) }, 'CO-03 case 6: source is { provider: "import", file: <basename> }')
  assert.deepEqual(doc.attempts, sortedPerContract(GITLAB_TWO), 'CO-03 case 6: records stored, newest first')
  assert.deepEqual(JSON.parse(readFileSync(historyFile(home, repo), 'utf8')).source, { provider: 'import', file: path.basename(file) }, 'CO-03 case 6: stored source')
  assert.equal(mode(historyFile(home, repo)).toString(8), '600', 'CO-03 case 6: history.json 0600')
  assert.deepEqual(gh.calls(), [], 'CO-03 case 6: import never calls gh')

  const human = history(repo, gh, ['--import', file])
  const escaped = path.basename(file).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  assert.match(human.stdout.trimEnd(), new RegExp(`^history: 2 attempts \\(0 new\\) from import (?:.*[\\\\/])?${escaped}$`), 'CO-03 case 6: human line `history: <total> attempts (<new> new) from import FILE`')
})

test('CO-03 case 6: an import and a GitHub fetch merge into one history', async (t) => {
  stateHome(t)
  const gh = fakeGh(t)
  const repo = makeRepo(t, {})
  const file = importFile(t, GITLAB_TWO)
  assert.equal(history(repo, gh, ['--import', file]).code, 0, 'test sanity: import succeeds')

  const fetched = history(repo, gh, ['--from-gh', '--repo', REPO, '--limit', '40', '--json'])
  assert.equal(fetched.code, 0, `CO-03 case 6: fetch after import exits 0 (stderr: ${fetched.stderr})`)
  assert.equal(fetched.json().total, 43, 'CO-03 case 6: 41 GitHub + 2 imported')
  assert.equal(fetched.json().new, 41, 'CO-03 case 6: only the GitHub attempts are new')
  assert.deepEqual(fetched.json().source, { provider: 'github', repo: REPO }, 'CO-03 case 6: the source is the last one used')
  assert.deepEqual(fetched.json().attempts, sortedPerContract([...recordedAttempts(), ...GITLAB_TWO]), 'CO-03 case 6: merged and sorted')

  const again = history(repo, gh, ['--import', file, '--json'])
  assert.equal(again.json().new, 0, 'CO-03 case 6: re-importing the same records adds none')
  assert.equal(again.json().total, 43, 'CO-03 case 6: total unchanged')
})

test('CO-03 case 6: a record with no runId refuses the whole file (exit 2, IMPORT_INVALID, index named) and changes nothing', async (t) => {
  const home = stateHome(t)
  const gh = fakeGh(t)
  const repo = makeRepo(t, {})
  const good = importFile(t, GITLAB_TWO)
  assert.equal(history(repo, gh, ['--import', good]).code, 0, 'test sanity: seed import succeeds')
  const stored = historyFile(home, repo)
  const bytes = readFileSync(stored)
  utimesSync(stored, PAST, PAST)

  const { runId: _omit, ...noRunId } = gitlabRecord(9003, '2026-11-22T10:00:05Z')
  const bad = importFile(t, [gitlabRecord(9004, '2026-11-22T11:00:05Z'), gitlabRecord(9005, '2026-11-22T12:00:05Z'), noRunId])
  const run = history(repo, gh, ['--import', bad])
  assert.equal(run.code, 2, `CO-03 case 6: exit 2 (stderr: ${run.stderr})`)
  assert.match(run.stderr, /^autobuild ci: IMPORT_INVALID: /m, 'CO-03 case 6: stderr is `autobuild ci: IMPORT_INVALID: <message>`')
  assert.match(run.stderr, /\b2\b/, 'CO-03 case 6: the message names the bad record index (0-based, the third record)')
  assert.ok(readFileSync(stored).equals(bytes), 'CO-03 case 6: history.json bytes are unchanged, the two valid records were not merged')
  assert.equal(statSync(stored).mtimeMs, PAST.getTime(), 'CO-03 case 6: history.json was not rewritten')

  const asJson = history(repo, gh, ['--import', bad, '--json'])
  assert.equal(asJson.code, 2, 'CO-03 case 6: --json also exits 2')
  assert.equal(JSON.parse(asJson.stdout).error, 'IMPORT_INVALID', 'CO-03 case 6: --json prints {"error":"IMPORT_INVALID",...}')
})

test('CO-03 case 6: other malformed records are refused too, and a null startedAt is accepted', async (t) => {
  const home = stateHome(t)
  const gh = fakeGh(t)
  const repo = makeRepo(t, {})
  const malformed = {
    'empty provider': gitlabRecord(9101, '2026-11-22T10:00:05Z', { provider: '' }),
    'string attempt': gitlabRecord(9102, '2026-11-22T10:00:05Z', { attempt: '1' }),
    'jobs not a list': gitlabRecord(9103, '2026-11-22T10:00:05Z', { jobs: 'unit' }),
    'record is null': null,
  }
  for (const [label, record] of Object.entries(malformed)) {
    const run = history(repo, gh, ['--import', importFile(t, [record])])
    assert.equal(run.code, 2, `CO-03 case 6: ${label} exits 2 (stderr: ${run.stderr})`)
    assert.match(run.stderr, /^autobuild ci: IMPORT_INVALID: /m, `CO-03 case 6: ${label} -> IMPORT_INVALID`)
    assert.ok(!existsSync(historyFile(home, repo)), `CO-03 case 6: ${label} stored nothing`)
  }

  const ok = history(repo, gh, ['--import', importFile(t, [gitlabRecord(9201, null), gitlabRecord(9202, '2026-11-22T10:00:05Z', { provider: 'circleci' })]), '--json'])
  assert.equal(ok.code, 0, `CO-03 case 6: any non-empty provider and a null startedAt are valid (stderr: ${ok.stderr})`)
  assert.deepEqual(ok.json().attempts.map((a) => a.runId), [9202, 9201], 'CO-03 case 6: the null-startedAt record sorts last')
})

// ---------- case 7: merge rules and offline behavior ----------

test('CO-03 case 7: mergeHistory replaces a record with the same runId#attempt', async () => {
  const { mergeHistory } = await ci('history')
  const existing = [gitlabRecord(1, '2026-11-20T10:00:00Z', { conclusion: 'failure' }), gitlabRecord(2, '2026-11-20T11:00:00Z')]
  const incoming = [gitlabRecord(1, '2026-11-20T10:00:00Z', { conclusion: 'success' })]

  const merged = await mergeHistory(existing, incoming)
  assert.equal(merged.length, 2, 'CO-03 case 7: same key replaces, it does not duplicate')
  assert.equal(merged.find((a) => a.runId === 1).conclusion, 'success', 'CO-03 case 7: the incoming record wins')
  assert.deepEqual((await mergeHistory([gitlabRecord(1, '2026-11-20T10:00:00Z')], [gitlabRecord(1, '2026-11-20T10:00:00Z', { attempt: 2 })])).map(keyOf).sort(), ['1#1', '1#2'],
    'CO-03 case 7: a different attempt of the same run is a different record')
  assert.deepEqual(await mergeHistory([], []), [], 'CO-03 case 7: empty merge')
})

test('CO-03 case 7: mergeHistory sorts by startedAt desc, runId desc (numerically), attempt desc, null startedAt last', async () => {
  const { mergeHistory } = await ci('history')
  const T2 = '2026-11-21T00:00:00Z'
  const A = gitlabRecord(5, T2)
  const B = gitlabRecord(5, T2, { attempt: 2 })
  const C = gitlabRecord(9, T2)
  const D = gitlabRecord(10, T2)
  const E = gitlabRecord(1, '2026-11-22T00:00:00Z')
  const F = gitlabRecord(7, null)
  const G = gitlabRecord(8, null)

  const merged = await mergeHistory([A, F, C], [G, E, B, D])
  assert.deepEqual(merged.map(keyOf), ['1#1', '10#1', '9#1', '5#2', '5#1', '8#1', '7#1'],
    'CO-03 case 7: newest startedAt first; ties by runId desc (10 before 9, so numeric not textual) then attempt desc; nulls last')
  assert.deepEqual(merged.map(keyOf), sortedPerContract([A, B, C, D, E, F, G]).map(keyOf), 'CO-03 case 7: agrees with the independent sort')
})

test('CO-03 case 7: mergeHistory caps the result at 200, keeping the newest', async () => {
  const { mergeHistory } = await ci('history')
  const at = (i) => new Date(Date.UTC(2026, 10, 1, 0, i)).toISOString()
  const all = Array.from({ length: 270 }, (_, i) => gitlabRecord(i + 1, at(i)))
  const existing = all.slice(0, 120)
  const incoming = all.slice(120)

  const merged = await mergeHistory(existing, incoming)
  assert.equal(merged.length, 200, 'CO-03 case 7: capped at 200')
  assert.deepEqual(merged.map(keyOf), sortedPerContract(all).slice(0, 200).map(keyOf), 'CO-03 case 7: the 200 newest records, sorted')
  assert.equal(merged.at(-1).runId, 71, 'CO-03 case 7: runs 1..70 (the oldest) were dropped')
  assert.equal((await mergeHistory(merged, merged)).length, 200, 'CO-03 case 7: merging the result with itself stays at 200')
})

test('CO-03 case 7: readHistory and writeHistory round-trip with mode 0600', async (t) => {
  const { readHistory, writeHistory } = await ci('history')
  const home = stateHome(t)
  const env = { AUTOBUILD_STATE_HOME: home }
  const repo = makeRepo(t, {})
  const doc = { schemaVersion: 1, source: { provider: 'import', file: 'x.json' }, attempts: sortedPerContract(recordedAttempts().slice(0, 3)) }

  await writeHistory(repo, doc, env)
  assert.deepEqual(await readHistory(repo, env), doc, 'CO-03 case 7: readHistory returns what writeHistory stored')
  assert.equal(mode(historyFile(home, repo)).toString(8), '600', 'CO-03 case 7: history.json mode 0600')
  assert.deepEqual(JSON.parse(readFileSync(historyFile(home, repo), 'utf8')), doc, 'CO-03 case 7: the file holds the document')
})

test('CO-03 case 7: without a source flag the command prints what is stored, changes nothing and never calls gh', async (t) => {
  const home = stateHome(t)
  const gh = fakeGh(t)
  const repo = makeRepo(t, {})

  const empty = history(repo, gh, [])
  assert.equal(empty.code, 0, `CO-03 case 7: exit 0 with no history (stderr: ${empty.stderr})`)
  assert.equal(empty.stdout.trimEnd(), 'history: none', 'CO-03 case 7: `history: none`')
  const emptyJson = history(repo, gh, ['--json'])
  assert.equal(emptyJson.json().total, 0, 'CO-03 case 7: --json total 0')
  assert.deepEqual(emptyJson.json().attempts, [], 'CO-03 case 7: --json attempts []')
  assert.ok(!existsSync(historyFile(home, repo)), 'CO-03 case 7: reading creates no history.json')

  assert.equal(history(repo, gh, ['--import', importFile(t, GITLAB_TWO)]).code, 0, 'test sanity: import succeeds')
  const stored = historyFile(home, repo)
  const bytes = readFileSync(stored)
  utimesSync(stored, PAST, PAST)

  const shown = history(repo, gh, [])
  assert.equal(shown.stdout.trimEnd(), 'history: 2 attempts stored', 'CO-03 case 7: `history: <total> attempts stored`')
  const shownJson = history(repo, gh, ['--json']).json()
  assert.equal(shownJson.total, 2, 'CO-03 case 7: --json total')
  assert.equal(shownJson.new, 0, 'CO-03 case 7: --json new is 0 when nothing was fetched')
  assert.deepEqual(shownJson.attempts, sortedPerContract(GITLAB_TWO), 'CO-03 case 7: --json attempts are the stored ones')
  assert.ok(readFileSync(stored).equals(bytes), 'CO-03 case 7: stored bytes unchanged')
  assert.equal(statSync(stored).mtimeMs, PAST.getTime(), 'CO-03 case 7: history.json not rewritten')
  assert.deepEqual(gh.calls(), [], 'CO-03 case 7: the fake gh log is empty: no gh call without --from-gh')
})

test('CO-03 common: a junk or wrong-schema history.json is treated as absent and replaced on the next write', async (t) => {
  const home = stateHome(t)
  const gh = fakeGh(t)
  const repo = makeRepo(t, {})
  const file = historyFile(home, repo)
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })

  writeFileSync(file, '{ junk', { mode: 0o600 })
  assert.equal(history(repo, gh, []).stdout.trimEnd(), 'history: none', 'CO-03 common: junk reads as no history')
  const one = history(repo, gh, ['--import', importFile(t, GITLAB_TWO), '--json'])
  assert.equal(one.code, 0, `CO-03 common: an import replaces junk (stderr: ${one.stderr})`)
  assert.equal(one.json().total, 2, 'CO-03 common: only the imported records remain')
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).schemaVersion, 1, 'CO-03 common: replaced with schemaVersion 1')

  writeFileSync(file, JSON.stringify({ schemaVersion: 2, source: { provider: 'import', file: 'old.json' }, attempts: [gitlabRecord(1, '2026-01-01T00:00:00Z')] }))
  assert.equal(history(repo, gh, []).stdout.trimEnd(), 'history: none', 'CO-03 common: another schemaVersion reads as no history')
  const two = history(repo, gh, ['--import', importFile(t, [GITLAB_TWO[0]]), '--json'])
  assert.equal(two.json().total, 1, 'CO-03 common: the old-schema records are not merged')
})

test('CO-03: an unknown flag or form exits 2 with an `autobuild ci:` error and calls nothing', async (t) => {
  stateHome(t)
  const gh = fakeGh(t)
  const run = history(makeRepo(t, {}), gh, ['--bogus'])
  assert.equal(run.code, 2, `CO-03 usage: exit 2 (stderr: ${run.stderr})`)
  assert.match(run.stderr, /^autobuild ci: /m, 'CO-03 usage: reported as an `autobuild ci:` error')
  assert.deepEqual(gh.calls(), [], 'CO-03 usage: gh was never called')
})
