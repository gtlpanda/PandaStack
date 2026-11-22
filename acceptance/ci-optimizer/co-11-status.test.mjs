// FROZEN acceptance tests for CO-11, validation status for HEAD (spec/contracts/ci-optimizer-co-11.md).
// Written from the contract before any implementation exists. Offline: throwaway git repos, a private
// state home, a fake `gh` that must never be called.
//
// Contract readings chosen where the text is silent or ambiguous (all listed in the author's report):
//  - A local entry whose record was taken dirty, at the same head, with the tree now clean, is stale with
//    staleReason "uncommitted-changes" (the contract's "else uncommitted-changes", read literally).
//  - Status works in a git repository without autobuild.json (priority rules: only validate/apply need it).
//  - `validationStatus` accepts `validation: null` (no validation.json) and treats it as no local entries.
//  - A stored history that is non-empty but has no attempt for HEAD gets NO_CI_RESULT_FOR_HEAD only; an empty
//    history gets both NO_HISTORY and NO_CI_RESULT_FOR_HEAD.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'
import { ci, fakeGh, git, importFile, makeRepo, recordedAttempts, runCi, sha256hex, stateHome, tempDir, writeFiles } from './support.mjs'

const lines = (text) => text.split('\n').filter((line) => line !== '')
const MERGE_LINE = "merge: decided by the repository's required CI check"

// NOTE: this builder is duplicated from co-07-validate.test.mjs on purpose. Each frozen test file is
// self-contained (support.mjs and shared fixtures may not be edited by the test authors).
//
// A minimal but valid autobuild project on `main`, with a work branch checked out. Gate: api
// (paths ["api"]), web (paths ["web/**"]), lint (no paths); every command appends its name to a calls
// file outside the tree. `api` also fails while the flag file (also outside the tree) exists.
function fixture(t) {
  const home = stateHome(t)
  const scratch = tempDir(t, 'ci-opt-co11-')
  const callsFile = path.join(scratch, 'calls')
  const failFlag = path.join(scratch, 'fail-api')
  const command = (name) => `printf '%s\\n' ${name} >> '${callsFile}'${name === 'api' ? `; test ! -e '${failFlag}'` : ''}`
  const entry = (name, paths) => ({ name, command: command(name), ...(paths ? { paths } : {}) })
  const repo = makeRepo(t, {
    'autobuild.json': {
      frozen: ['api'],
      gate: [entry('api', ['api']), entry('web', ['web/**']), entry('lint', null)],
      ciParityOptOut: 'acceptance fixture: CI parity is out of scope',
    },
    'features.json': { schemaVersion: 1, features: [] },
    'PROGRESS.md': '# progress\n',
    '.gitignore': 'logs/\n.harness/\n',
    'api/x.js': 'base\n',
    'web/index.js': 'base\n',
    'package-lock.json': '{}\n',
  })
  git(repo, 'checkout', '-q', '-b', 'work')
  const stateDir = path.join(home, 'autobuild', 'ci', sha256hex(repo).slice(0, 24))
  const fx = {
    repo, home, stateDir, scratch,
    head: () => git(repo, 'rev-parse', 'HEAD'),
    commit: (files, message = 'work') => { writeFiles(repo, files); git(repo, 'add', '-A'); git(repo, 'commit', '-q', '-m', message) },
    setFailing: (on) => { if (on) writeFileSync(failFlag, ''); else rmSync(failFlag, { force: true }) },
    run: (args, env = {}) => runCi(repo, args, { AUTOBUILD_STATE_HOME: home, ...env }),
    validate: (...args) => fx.run(['validate', '--base', 'main', ...args]),
    status: (env = {}) => fx.run(['status', '--json'], env),
    statusJson: (env = {}) => fx.status(env).json(),
  }
  return fx
}

// An imported CI attempt for `head`, shaped exactly like a recorded one so it cannot trip IMPORT_INVALID.
function attemptFor(head, { conclusion, runId, attempt = 1, startedAt = '2026-11-22T12:00:00Z' }) {
  return { ...recordedAttempts()[0], runId, attempt, headSha: head, conclusion, startedAt, createdAt: startedAt, updatedAt: startedAt }
}

const entryOf = (ok, current, staleReason = null, at = '2026-11-22T10:00:00.000Z') => ({ ok, at, current, staleReason })
const record = ({ head, dirty = false, tier, ok, at = '2026-11-22T10:00:00.000Z' }) => ({ schemaVersion: 1, head, dirty, tier, ok, at, base: null, reasons: [] })
const HEAD = 'a'.repeat(40)
const OTHER = 'b'.repeat(40)
const status = async (input) => (await ci('status')).validationStatus({ root: '/unused', head: HEAD, dirty: false, validation: null, attempts: [], ...input })

// ---------- pure function: local entries ----------

test('CO-11 case 1/2 (module): local entries are current only for the same clean head with a clean tree', async () => {
  const validation = { schemaVersion: 1, fast: record({ head: HEAD, tier: 'fast', ok: true }), full: record({ head: HEAD, tier: 'full', ok: false }) }
  const s = await status({ validation })
  assert.equal(s.head, HEAD, 'CO-11 module: head is echoed')
  assert.deepEqual(s.local.fast, entryOf(true, true), 'CO-11 case 1: a clean record for HEAD is current')
  assert.deepEqual(s.local.full, entryOf(false, true), 'CO-11 case 1: a failed record is still reported, as current')

  const moved = await status({ head: OTHER, validation })
  assert.equal(moved.local.fast.current, false, 'CO-11 case 2: a different head is stale')
  assert.equal(moved.local.fast.staleReason, 'head-changed', 'CO-11 case 2: staleReason head-changed')
  assert.equal(moved.local.full.staleReason, 'head-changed', 'CO-11 case 2: staleReason head-changed (full)')

  const edited = await status({ dirty: true, validation })
  assert.equal(edited.local.fast.current, false, 'CO-11 case 2: a dirty tree is stale')
  assert.equal(edited.local.fast.staleReason, 'uncommitted-changes', 'CO-11 case 2: staleReason uncommitted-changes')

  const both = await status({ head: OTHER, dirty: true, validation })
  assert.equal(both.local.fast.staleReason, 'head-changed', 'CO-11 case 2: heads differing wins over a dirty tree')

  const dirtyRecord = { schemaVersion: 1, fast: record({ head: HEAD, dirty: true, tier: 'fast', ok: true }), full: null }
  const cleanNow = await status({ dirty: false, validation: dirtyRecord })
  assert.equal(cleanNow.local.fast.current, false, 'CO-11 case 2: a record taken on a dirty tree is never current')
  assert.equal(cleanNow.local.fast.staleReason, 'uncommitted-changes', 'CO-11 case 2: same head, so the reason is uncommitted-changes')
  assert.equal(cleanNow.local.full, null, 'CO-11 case 2: a missing tier is null')
})

test('CO-11 (module): no validation.json and no history give empty local entries and both notes', async () => {
  for (const validation of [null, { schemaVersion: 1, fast: null, full: null }]) {
    const s = await status({ validation })
    assert.deepEqual(s.local, { fast: null, full: null }, 'CO-11 module: no local entries')
    assert.equal(s.ci, null, 'CO-11 module: no ci result')
    assert.ok(s.notes.includes('NO_HISTORY'), 'CO-11 module: NO_HISTORY for empty attempts')
    assert.ok(s.notes.includes('NO_CI_RESULT_FOR_HEAD'), 'CO-11 module: NO_CI_RESULT_FOR_HEAD')
    assert.equal(s.advice, 'run-fast', 'CO-11 module: nothing known means run-fast')
  }
  assert.deepEqual(Object.keys(await status({})).sort(), ['advice', 'ci', 'head', 'local', 'notes'], 'CO-11 module: result fields')
})

// ---------- pure function: ci ----------

test('CO-11 case 3 (module): ci is the newest attempt for HEAD by startedAt, with exactly the contract fields', async () => {
  const mk = (runId, headSha, conclusion, startedAt, attempt = 1) => ({ provider: 'github', runId, attempt, workflow: 'test', workflowPath: '.github/workflows/test.yml', event: 'push', headSha, branch: 'main', conclusion, createdAt: startedAt, startedAt, updatedAt: startedAt, jobs: [] })
  const attempts = [
    mk(1, HEAD, 'failure', '2026-11-22T10:00:00Z'),
    mk(3, OTHER, 'success', '2026-11-22T13:00:00Z'),
    mk(2, HEAD, 'success', '2026-11-22T11:00:00Z', 2),
  ]
  const s = await status({ attempts })
  assert.deepEqual(s.ci, { workflow: 'test', conclusion: 'success', runId: 2, attempt: 2, startedAt: '2026-11-22T11:00:00Z' }, 'CO-11 case 3: newest attempt for HEAD (not newest overall, not first listed)')
  assert.ok(!s.notes.includes('NO_CI_RESULT_FOR_HEAD'), 'CO-11 case 3: a result exists')
  assert.ok(!s.notes.includes('NO_HISTORY'), 'CO-11 case 3: history is non-empty')
  assert.equal(s.advice, 'none', 'CO-11 case 3: success gives none')

  const rerun = await status({ attempts: [mk(1, HEAD, 'success', '2026-11-22T10:00:00Z'), mk(1, HEAD, 'failure', '2026-11-22T11:00:00Z', 2)] })
  assert.equal(rerun.ci.conclusion, 'failure', 'CO-11 case 3: the newer attempt wins, even though it failed')
  assert.equal(rerun.advice, 'fix-failure', 'CO-11 case 3: failure gives fix-failure')

  const elsewhere = await status({ attempts: [mk(3, OTHER, 'success', '2026-11-22T13:00:00Z')] })
  assert.equal(elsewhere.ci, null, 'CO-11 case 3: an attempt for another SHA leaves ci null')
  assert.deepEqual(elsewhere.notes, ['NO_CI_RESULT_FOR_HEAD'], 'CO-11 case 3: only NO_CI_RESULT_FOR_HEAD, since history is not empty')
  assert.equal(elsewhere.advice, 'run-fast', 'CO-11 case 3: another SHA proves nothing')
})

// ---------- pure function: advice rules, in order ----------

test('CO-11 (module): advice follows the first matching rule', async () => {
  const mk = (conclusion) => ({ provider: 'github', runId: 1, attempt: 1, workflow: 'test', workflowPath: 'w.yml', event: 'push', headSha: HEAD, branch: 'main', conclusion, createdAt: '2026-11-22T10:00:00Z', startedAt: '2026-11-22T10:00:00Z', updatedAt: '2026-11-22T10:00:00Z', jobs: [] })
  const rec = (tier, ok, extra = {}) => record({ head: HEAD, tier, ok, ...extra })
  const v = (fast, full) => ({ schemaVersion: 1, fast, full })
  const cases = [
    // [label, input, expected advice]
    ['rule 1: current local fast failure', { validation: v(rec('fast', false), null) }, 'fix-failure'],
    ['rule 1: current local full failure', { validation: v(null, rec('full', false)) }, 'fix-failure'],
    ['rule 1 beats a CI success', { validation: v(null, rec('full', false)), attempts: [mk('success')] }, 'fix-failure'],
    ['rule 1: CI failure with a passing current local full', { validation: v(null, rec('full', true)), attempts: [mk('failure')] }, 'fix-failure'],
    ['rule 1: CI failure alone', { attempts: [mk('failure')] }, 'fix-failure'],
    ['a stale local failure is not rule 1 (head changed)', { head: OTHER, validation: v(rec('fast', false), null) }, 'run-fast'],
    ['a stale local failure is not rule 1 (dirty tree)', { dirty: true, validation: v(rec('fast', false), null) }, 'run-fast'],
    ['rule 2: CI success alone', { attempts: [mk('success')] }, 'none'],
    ['rule 2 beats a current passing fast entry', { validation: v(rec('fast', true), null), attempts: [mk('success')] }, 'none'],
    ['rule 2 beats stale local state', { dirty: true, validation: v(rec('fast', true), null), attempts: [mk('success')] }, 'none'],
    ['rule 3: current passing full', { validation: v(null, rec('full', true)) }, 'wait-for-ci'],
    ['rule 3 before rule 4: both passing and current', { validation: v(rec('fast', true), rec('full', true)) }, 'wait-for-ci'],
    ['rule 3 with a non-terminal CI conclusion', { validation: v(null, rec('full', true)), attempts: [mk('cancelled')] }, 'wait-for-ci'],
    ['rule 4: current passing fast', { validation: v(rec('fast', true), null) }, 'run-full'],
    ['rule 4 with a stale full entry', { validation: v(rec('fast', true), { ...rec('full', true), head: OTHER }) }, 'run-full'],
    ['rule 4 with a non-terminal CI conclusion', { validation: v(rec('fast', true), null), attempts: [mk('cancelled')] }, 'run-full'],
    ['rule 5: nothing current', { validation: v(null, null) }, 'run-fast'],
    ['rule 5: only stale entries', { head: OTHER, validation: v(rec('fast', true), rec('full', true)) }, 'run-fast'],
    ['rule 5: a cancelled CI run proves nothing', { attempts: [mk('cancelled')] }, 'run-fast'],
  ]
  for (const [label, input, expected] of cases) {
    const got = await status(input)
    assert.equal(got.advice, expected, `CO-11 advice (${label}): ${JSON.stringify(got.advice)}`)
    assert.ok(['none', 'run-fast', 'run-full', 'wait-for-ci', 'fix-failure'].includes(got.advice), `CO-11 advice (${label}): advice is one of the contract values`)
  }
})

test('CO-11 (module): validationStatus does not mutate its inputs', async () => {
  const validation = { schemaVersion: 1, fast: record({ head: HEAD, tier: 'fast', ok: true }), full: null }
  const attempts = [{ provider: 'github', runId: 1, attempt: 1, workflow: 'test', workflowPath: 'w.yml', event: 'push', headSha: HEAD, branch: 'main', conclusion: 'success', createdAt: 'x', startedAt: '2026-11-22T10:00:00Z', updatedAt: 'x', jobs: [] }]
  const before = JSON.stringify({ validation, attempts })
  await status({ validation, attempts })
  assert.equal(JSON.stringify({ validation, attempts }), before, 'CO-11 module: inputs are unchanged')
})

// ---------- CO-11 case 1 ----------

test('CO-11 case 1: after a passing fast validation on a clean tree the entry is current and advice is run-full', (t) => {
  const fx = fixture(t)
  fx.commit({ 'api/x.js': 'changed\n' })
  assert.equal(fx.validate().code, 0, 'fixture: the fast validation passes')
  assert.equal(git(fx.repo, 'status', '--porcelain'), '', 'fixture: the tree is clean after validation')

  const run = fx.status()
  assert.equal(run.code, 0, `CO-11 case 1: exit 0; stderr: ${run.stderr}`)
  const doc = run.json()
  assert.deepEqual(Object.keys(doc).sort(), ['advice', 'ci', 'head', 'local', 'notes'], 'CO-11 case 1: --json prints the status object')
  assert.equal(doc.head, fx.head(), 'CO-11 case 1: head')
  assert.equal(doc.local.fast.ok, true, 'CO-11 case 1: local.fast.ok')
  assert.equal(doc.local.fast.current, true, 'CO-11 case 1: local.fast.current is true')
  assert.equal(doc.local.fast.staleReason, null, 'CO-11 case 1: staleReason null when current')
  assert.equal(new Date(doc.local.fast.at).toISOString(), doc.local.fast.at, 'CO-11 case 1: at is an ISO timestamp')
  assert.equal(doc.local.full, null, 'CO-11 case 1: no full entry yet')
  assert.equal(doc.ci, null, 'CO-11 case 1: no CI result')
  assert.ok(doc.notes.includes('NO_HISTORY') && doc.notes.includes('NO_CI_RESULT_FOR_HEAD'), 'CO-11 case 1: notes say there is no history')
  assert.equal(doc.advice, 'run-full', 'CO-11 case 1: a current passing fast entry advises run-full')

  assert.equal(fx.validate('--tier', 'full').code, 0, 'fixture: the full validation passes')
  const after = fx.statusJson()
  assert.equal(after.local.full.ok, true, 'CO-11 case 1: local.full.ok')
  assert.equal(after.local.full.current, true, 'CO-11 case 1: local.full.current')
  assert.equal(after.local.fast.current, true, 'CO-11 case 1: the fast entry is still current')
  assert.equal(after.advice, 'wait-for-ci', 'CO-11 case 1: after a passing full validation advice is wait-for-ci')
})

test('CO-11 case 1: human output lists HEAD, both local entries, ci, advice and the merge line', (t) => {
  const fx = fixture(t)
  fx.commit({ 'api/x.js': 'changed\n' })
  const empty = lines(fx.run(['status']).stdout)
  assert.deepEqual(empty, [
    `HEAD ${fx.head().slice(0, 12)}`,
    'local fast: none',
    'local full: none',
    'ci: no result for HEAD in stored history',
    'advice: run-fast',
    MERGE_LINE,
  ], 'CO-11 case 1: human output with nothing recorded')

  assert.equal(fx.validate().code, 0, 'fixture: fast passes')
  const at = fx.statusJson().local.fast.at
  assert.deepEqual(lines(fx.run(['status']).stdout), [
    `HEAD ${fx.head().slice(0, 12)}`,
    `local fast: PASS at ${at} (current)`,
    'local full: none',
    'ci: no result for HEAD in stored history',
    'advice: run-full',
    MERGE_LINE,
  ], 'CO-11 case 1: human output after a passing fast validation')
})

// ---------- CO-11 case 2 ----------

test('CO-11 case 2: a new commit makes both entries stale with head-changed, and advice is run-fast', (t) => {
  const fx = fixture(t)
  fx.commit({ 'api/x.js': 'changed\n' })
  assert.equal(fx.validate().code, 0, 'fixture: fast passes')
  assert.equal(fx.validate('--tier', 'full').code, 0, 'fixture: full passes')
  fx.commit({ 'web/index.js': 'next commit\n' }, 'new commit')

  const doc = fx.statusJson()
  for (const tier of ['fast', 'full']) {
    assert.equal(doc.local[tier].ok, true, `CO-11 case 2: ${tier} keeps its recorded result`)
    assert.equal(doc.local[tier].current, false, `CO-11 case 2: ${tier} is stale after a new commit`)
    assert.equal(doc.local[tier].staleReason, 'head-changed', `CO-11 case 2: ${tier} staleReason`)
  }
  assert.equal(doc.advice, 'run-fast', 'CO-11 case 2: advice after a new commit')
  assert.equal(doc.head, fx.head(), 'CO-11 case 2: head is the new HEAD')

  const human = lines(fx.run(['status']).stdout)
  assert.match(human[1], /^local fast: PASS at \S+ \(stale: head-changed\)$/, `CO-11 case 2: human fast line; got ${human[1]}`)
  assert.match(human[2], /^local full: PASS at \S+ \(stale: head-changed\)$/, `CO-11 case 2: human full line; got ${human[2]}`)
})

test('CO-11 case 2: an uncommitted edit makes the entries stale with uncommitted-changes', (t) => {
  const fx = fixture(t)
  fx.commit({ 'api/x.js': 'changed\n' })
  assert.equal(fx.validate().code, 0, 'fixture: fast passes')
  assert.equal(fx.validate('--tier', 'full').code, 0, 'fixture: full passes')
  writeFileSync(path.join(fx.repo, 'api/x.js'), 'edited after validation\n')

  const doc = fx.statusJson()
  for (const tier of ['fast', 'full']) {
    assert.equal(doc.local[tier].current, false, `CO-11 case 2: ${tier} is stale with an uncommitted edit`)
    assert.equal(doc.local[tier].staleReason, 'uncommitted-changes', `CO-11 case 2: ${tier} staleReason`)
  }
  assert.equal(doc.advice, 'run-fast', 'CO-11 case 2: advice with an uncommitted edit')
  const human = lines(fx.run(['status']).stdout)
  assert.equal(human[0], `HEAD ${fx.head().slice(0, 12)}, uncommitted changes`, 'CO-11 case 2: the HEAD line says so')
  assert.match(human[1], /\(stale: uncommitted-changes\)$/, 'CO-11 case 2: human stale line')
})

test('CO-11 case 2: an untracked file counts as uncommitted, an ignored file does not', (t) => {
  const fx = fixture(t)
  fx.commit({ 'api/x.js': 'changed\n' })
  assert.equal(fx.validate().code, 0, 'fixture: fast passes')
  mkdirSync(path.join(fx.repo, 'logs'), { recursive: true })
  writeFileSync(path.join(fx.repo, 'logs/ignored.txt'), 'ignored\n')
  assert.equal(fx.statusJson().local.fast.current, true, 'CO-11 case 2: an ignored file does not make the tree dirty')
  writeFileSync(path.join(fx.repo, 'untracked.txt'), 'new\n')
  const doc = fx.statusJson()
  assert.equal(doc.local.fast.current, false, 'CO-11 case 2: an untracked file makes the entry stale')
  assert.equal(doc.local.fast.staleReason, 'uncommitted-changes', 'CO-11 case 2: staleReason')
})

test('CO-11 case 2: a validation run on a dirty tree is never current, even for the same head', (t) => {
  const fx = fixture(t)
  fx.commit({ 'api/x.js': 'changed\n' })
  writeFileSync(path.join(fx.repo, 'api/x.js'), 'dirty at validation time\n')
  assert.equal(fx.validate().code, 0, 'fixture: fast passes on a dirty tree')
  assert.equal(fx.statusJson().local.fast.current, false, 'CO-11 case 2: dirty now, so stale')
  git(fx.repo, 'checkout', '--', 'api/x.js')
  const clean = fx.statusJson()
  assert.equal(clean.local.fast.current, false, 'CO-11 case 2: the record was taken dirty, so it is not current once the tree is clean either')
  assert.equal(clean.local.fast.staleReason, 'uncommitted-changes', 'CO-11 case 2: same head, so uncommitted-changes (literal reading)')
  assert.equal(clean.advice, 'run-fast', 'CO-11 case 2: advice')
})

// ---------- CO-11 case 3 ----------

function withHistory(t, conclusion, { sha = null, runId = 9000000001 } = {}) {
  const fx = fixture(t)
  fx.commit({ 'api/x.js': 'changed\n' })
  const file = importFile(t, [attemptFor(sha ?? fx.head(), { conclusion, runId })])
  const imported = fx.run(['history', '--import', file])
  assert.equal(imported.code, 0, `fixture: history --import succeeds (CO-03); stderr: ${imported.stderr}`)
  return fx
}

test('CO-11 case 3: an imported success for HEAD fills ci and gives advice none', (t) => {
  const fx = withHistory(t, 'success')
  const doc = fx.statusJson()
  assert.deepEqual(doc.ci, { workflow: 'test', conclusion: 'success', runId: 9000000001, attempt: 1, startedAt: '2026-11-22T12:00:00Z' }, 'CO-11 case 3: ci fields')
  assert.equal(doc.advice, 'none', 'CO-11 case 3: success gives none (even with no local validation)')
  assert.ok(!doc.notes.includes('NO_CI_RESULT_FOR_HEAD') && !doc.notes.includes('NO_HISTORY'), 'CO-11 case 3: no notes when a result exists')
  const human = lines(fx.run(['status']).stdout)
  assert.equal(human[3], 'ci: success (test, run 9000000001 attempt 1)', 'CO-11 case 3: human ci line')
  assert.equal(human[4], 'advice: none', 'CO-11 case 3: human advice line')
})

test('CO-11 case 3: an imported failure for HEAD gives fix-failure', (t) => {
  const fx = withHistory(t, 'failure')
  const doc = fx.statusJson()
  assert.equal(doc.ci.conclusion, 'failure', 'CO-11 case 3: ci.conclusion')
  assert.equal(doc.advice, 'fix-failure', 'CO-11 case 3: failure gives fix-failure')
  assert.equal(lines(fx.run(['status']).stdout)[3], 'ci: failure (test, run 9000000001 attempt 1)', 'CO-11 case 3: human ci line')
})

test('CO-11 case 3: a CI failure beats a passing local validation', (t) => {
  const fx = withHistory(t, 'failure')
  assert.equal(fx.validate().code, 0, 'fixture: fast passes')
  assert.equal(fx.validate('--tier', 'full').code, 0, 'fixture: full passes')
  assert.equal(fx.statusJson().advice, 'fix-failure', 'CO-11 case 3: CI failure with passing current local full')
})

test('CO-11 case 3: a CI result for an older HEAD does not count once HEAD moves', (t) => {
  const fx = withHistory(t, 'success')
  assert.equal(fx.validate().code, 0, 'fixture: fast passes')
  fx.commit({ 'web/index.js': 'moved\n' }, 'moves HEAD so the imported CI result no longer matches')
  const doc = fx.statusJson()
  assert.equal(doc.ci, null, 'CO-11 case 3: the imported attempt belongs to the old HEAD')
  assert.equal(doc.advice, 'run-fast', 'CO-11 case 3: everything is stale, so run-fast')
})

test('CO-11 case 3: an attempt for another SHA leaves ci null with NO_CI_RESULT_FOR_HEAD', (t) => {
  const fx = withHistory(t, 'success', { sha: 'c'.repeat(40) })
  const doc = fx.statusJson()
  assert.equal(doc.ci, null, 'CO-11 case 3: ci is null')
  assert.ok(doc.notes.includes('NO_CI_RESULT_FOR_HEAD'), 'CO-11 case 3: NO_CI_RESULT_FOR_HEAD')
  assert.ok(!doc.notes.includes('NO_HISTORY'), 'CO-11 case 3: history is not empty, so no NO_HISTORY')
  assert.equal(doc.advice, 'run-fast', 'CO-11 case 3: another SHA proves nothing about HEAD')
  assert.equal(lines(fx.run(['status']).stdout)[3], 'ci: no result for HEAD in stored history', 'CO-11 case 3: human ci line')
})

// ---------- CO-11 case 4 ----------

test('CO-11 case 4: a current local fast failure gives fix-failure with no CI result', (t) => {
  const fx = fixture(t)
  fx.commit({ 'api/x.js': 'changed\n' })
  fx.setFailing(true)
  assert.equal(fx.validate().code, 1, 'fixture: the fast validation fails')
  const doc = fx.statusJson()
  assert.equal(doc.local.fast.ok, false, 'CO-11 case 4: local.fast.ok is false')
  assert.equal(doc.local.fast.current, true, 'CO-11 case 4: the failure is current')
  assert.equal(doc.ci, null, 'CO-11 case 4: no CI result')
  assert.equal(doc.advice, 'fix-failure', 'CO-11 case 4: fix-failure')
  const human = lines(fx.run(['status']).stdout)
  assert.match(human[1], /^local fast: FAIL at \S+ \(current\)$/, `CO-11 case 4: human fast line; got ${human[1]}`)
  assert.equal(human[4], 'advice: fix-failure', 'CO-11 case 4: human advice line')
  assert.equal(fx.run(['status']).code, 0, 'CO-11 case 4: status exits 0 whatever the advice')
})

// ---------- CO-11 case 5 ----------

function snapshot(dir) {
  const out = {}
  const walk = (current) => {
    if (!existsSync(current)) return
    for (const name of readdirSync(current).sort()) {
      const file = path.join(current, name)
      const stat = statSync(file)
      if (stat.isDirectory()) { out[`${path.relative(dir, file)}/`] = stat.mtimeMs; walk(file) }
      else out[path.relative(dir, file)] = { sha: createHash('sha256').update(readFileSync(file)).digest('hex'), mtimeMs: stat.mtimeMs, mode: stat.mode }
    }
  }
  walk(dir)
  return out
}

test('CO-11 case 5: status is read-only: exit 0, state files and mtimes unchanged, the merge line printed, gh never invoked', (t) => {
  const fx = fixture(t)
  fx.commit({ 'api/x.js': 'changed\n' })
  const file = importFile(t, [attemptFor(fx.head(), { conclusion: 'success', runId: 9000000002 })])
  assert.equal(fx.run(['history', '--import', file]).code, 0, 'fixture: history import')
  assert.equal(fx.validate().code, 0, 'fixture: fast validation')
  assert.deepEqual(readdirSync(fx.stateDir).sort(), ['history.json', 'validation.json'], 'fixture: the state directory holds history and validation')

  const gh = fakeGh(t)
  const env = { AUTOBUILD_GH_BIN: gh.bin, PATH: `${path.dirname(gh.bin)}${path.delimiter}${process.env.PATH}` }
  const stateBefore = snapshot(fx.stateDir)
  const treeBefore = git(fx.repo, 'status', '--porcelain')
  const headBefore = fx.head()

  const human = fx.run(['status'], env)
  const machine = fx.run(['status', '--json'], env)
  assert.equal(human.code, 0, `CO-11 case 5: exit 0; stderr: ${human.stderr}`)
  assert.equal(machine.code, 0, 'CO-11 case 5: --json exit 0')
  assert.equal(lines(human.stdout).at(-1), MERGE_LINE, 'CO-11 case 5: the last human line is the merge line')
  assert.equal(lines(human.stdout).length, 6, 'CO-11 case 5: six human lines')
  assert.deepEqual(snapshot(fx.stateDir), stateBefore, 'CO-11 case 5: state files, modes and mtimes are unchanged')
  assert.equal(git(fx.repo, 'status', '--porcelain'), treeBefore, 'CO-11 case 5: the working tree is unchanged')
  assert.equal(fx.head(), headBefore, 'CO-11 case 5: HEAD is unchanged')
  assert.deepEqual(gh.calls(), [], 'CO-11 case 5: the fake gh was never invoked')
  const doc = machine.json()
  assert.equal(doc.advice, 'none', 'CO-11 case 5: the stored success is read from local history')
})

test('CO-11 case 5: status writes nothing at all when there is no state yet', (t) => {
  const fx = fixture(t)
  fx.commit({ 'api/x.js': 'changed\n' })
  assert.deepEqual(readdirSync(fx.home), [], 'fixture: the state home starts empty')
  const run = fx.status()
  assert.equal(run.code, 0, `CO-11 case 5: exit 0 with no state; stderr: ${run.stderr}`)
  assert.equal(run.json().advice, 'run-fast', 'CO-11 case 5: advice with no state')
  assert.deepEqual(readdirSync(fx.home), [], 'CO-11 case 5: the state home is still empty (no directory created)')
})

test('CO-11 case 5: unparseable state is read as absent and left in place', (t) => {
  const fx = fixture(t)
  fx.commit({ 'api/x.js': 'changed\n' })
  mkdirSync(fx.stateDir, { recursive: true, mode: 0o700 })
  writeFileSync(path.join(fx.stateDir, 'validation.json'), '{ broken')
  writeFileSync(path.join(fx.stateDir, 'history.json'), JSON.stringify({ schemaVersion: 99, source: null, attempts: [attemptFor(fx.head(), { conclusion: 'success', runId: 9000000003 })] }))
  const before = snapshot(fx.stateDir)
  const run = fx.status()
  assert.equal(run.code, 0, `CO-11 case 5: exit 0; stderr: ${run.stderr}`)
  const doc = run.json()
  assert.deepEqual(doc.local, { fast: null, full: null }, 'CO-11 case 5: broken validation.json is treated as absent')
  assert.equal(doc.ci, null, 'CO-11 case 5: a history with a different schemaVersion is treated as absent')
  assert.ok(doc.notes.includes('NO_HISTORY'), 'CO-11 case 5: so the history is empty')
  assert.deepEqual(snapshot(fx.stateDir), before, 'CO-11 case 5: status does not repair or rewrite state')
})

// ---------- CLI prerequisites (priority common rules) ----------

test('CO-11 status works in a git repository without autobuild.json', (t) => {
  const home = stateHome(t)
  const repo = makeRepo(t, { 'README.md': 'plain\n' })
  const run = runCi(repo, ['status', '--json'], { AUTOBUILD_STATE_HOME: home })
  assert.equal(run.code, 0, `CO-11: exit 0 without autobuild.json; stderr: ${run.stderr}`)
  const doc = run.json()
  assert.equal(doc.head, git(repo, 'rev-parse', 'HEAD'), 'CO-11: head')
  assert.equal(doc.advice, 'run-fast', 'CO-11: advice')
})

test('CO-11 status outside a git repository exits 2 with the exact message', (t) => {
  const home = stateHome(t)
  const dir = tempDir(t, 'ci-opt-nogit-')
  const run = runCi(dir, ['status'], { AUTOBUILD_STATE_HOME: home, GIT_CEILING_DIRECTORIES: path.dirname(dir) })
  assert.equal(run.code, 2, 'CO-11: exit 2 outside a git repository')
  assert.match(run.stderr, /^autobuild ci: not in a git repository$/m, `CO-11: stderr; got ${run.stderr}`)
  assert.deepEqual(readdirSync(home), [], 'CO-11: nothing written')
})

test('CO-11 status rejects an unknown flag with a usage error', (t) => {
  const fx = fixture(t)
  const run = fx.run(['status', '--bogus'])
  assert.equal(run.code, 2, 'CO-11: exit 2 for an unknown flag')
  assert.match(run.stderr, /^autobuild ci: [A-Z_]+: /m, `CO-11: stderr has the autobuild ci: <CODE>: form; got ${run.stderr}`)
})
