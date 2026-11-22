// FROZEN acceptance tests for CO-07, the fast validation tier (spec/contracts/ci-optimizer-co-07.md).
// Written from the contract before any implementation exists. Offline: throwaway git repos, a private
// state home, commands that log to a calls file outside the tree.
//
// Contract readings chosen where the text is silent or ambiguous (all listed in the author's report):
//  - Reasons that overlap (package-lock.json is a lockfile AND matched by no `paths` pattern) are all
//    reported, so overlapping cases assert `includes`, never an exact list.
//  - An escalated fast request records under the tier that actually ran (`full`), keyed by record.tier.
//  - Where "a path-match reason" is the whole spec for a skip, the tests match /path match/.
//  - "Existing autobuild suite stays green" (case 6) is not testable here; it is a property of the
//    builder's own run of graphs/autobuild/tool/test.
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'
import { LIB, ci, git, makeRepo, runCi, sha256hex, stateHome, tempDir, writeFiles } from './support.mjs'

const lazy = (file) => import(path.join(LIB, file))
const lines = (text) => text.split('\n').filter((line) => line !== '')
const names = (gate) => gate.steps.map((step) => step.name)
const PARITY = 'CI parity configuration'
const ALL = ['api', 'lint', 'web']

// NOTE: this builder is duplicated in co-11-status.test.mjs on purpose. Each frozen test file is
// self-contained (support.mjs and shared fixtures may not be edited by the test authors).
//
// A minimal but valid autobuild project on `main`, with a work branch checked out. Gate: api
// (paths ["api"]), web (paths ["web/**"]), lint (no paths); every command appends its name to a calls
// file outside the tree. `api` also fails while the flag file (also outside the tree) exists.
function fixture(t, { paths = true } = {}) {
  const home = stateHome(t)
  const scratch = tempDir(t, 'ci-opt-co07-')
  const callsFile = path.join(scratch, 'calls')
  const failFlag = path.join(scratch, 'fail-api')
  const command = (name) => `printf '%s\\n' ${name} >> '${callsFile}'${name === 'api' ? `; test ! -e '${failFlag}'` : ''}`
  const entry = (name, entryPaths) => ({ name, command: command(name), ...(paths && entryPaths ? { paths: entryPaths } : {}) })
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
  return {
    repo, home, stateDir,
    calls: () => (existsSync(callsFile) ? readFileSync(callsFile, 'utf8').split('\n').filter(Boolean) : []),
    resetCalls: () => writeFileSync(callsFile, ''),
    setFailing: (on) => { if (on) writeFileSync(failFlag, ''); else rmSync(failFlag, { force: true }) },
    commit: (files, message = 'work') => { writeFiles(repo, files); git(repo, 'add', '-A'); git(repo, 'commit', '-q', '-m', message) },
    run: (args, env = {}) => runCi(repo, args, { AUTOBUILD_STATE_HOME: home, ...env }),
    validation: () => JSON.parse(readFileSync(path.join(stateDir, 'validation.json'), 'utf8')),
    mergeBase: (ref = 'main') => git(repo, 'merge-base', ref, 'HEAD'),
  }
}

// ---------- CO-07 case 1 ----------

test('CO-07 case 1: a change under api/ validates in the fast tier: api and lint run, web is skipped, no frozen-file step', async (t) => {
  const fx = fixture(t)
  fx.commit({ 'api/x.js': 'changed\n' })
  const base = fx.mergeBase()

  const human = fx.run(['validate', '--base', 'main'])
  const out = lines(human.stdout)
  assert.equal(human.code, 0, `CO-07 case 1: exit 0 on pass; stderr: ${human.stderr}`)
  assert.match(out[0], new RegExp(`^validation tier: fast \\(affected; base main ${base.slice(0, 12)}; 1 files changed\\)$`), 'CO-07 case 1: first line names the fast tier, base ref, 12-char sha and changed count')
  assert.equal(out.at(-1), 'VALIDATION: PASS (fast tier, not merge validation)', 'CO-07 case 1: last line')
  assert.ok(!out.some((line) => /frozen/i.test(line)), 'CO-07 case 1: no frozen-file step line appears although `frozen` lists a changed file')
  assert.deepEqual(fx.calls().sort(), ['api', 'lint'], 'CO-07 case 1: only api and lint commands ran')

  fx.resetCalls()
  const json = fx.run(['validate', '--base', 'main', '--json'])
  assert.equal(json.code, 0, 'CO-07 case 1: --json exit 0')
  const doc = json.json()
  assert.deepEqual(Object.keys(doc).sort(), ['gate', 'ok', 'plan'], 'CO-07 case 1: --json prints { plan, gate, ok }')
  assert.equal(doc.ok, true, 'CO-07 case 1: ok')
  assert.equal(doc.plan.tier, 'fast', 'CO-07 case 1: tier')
  assert.equal(doc.plan.requested, 'fast', 'CO-07 case 1: requested')
  assert.equal(doc.plan.escalated, false, 'CO-07 case 1: not escalated')
  assert.deepEqual(doc.plan.reasons, [], 'CO-07 case 1: no escalation reasons')
  assert.deepEqual([...doc.plan.steps.run].sort(), ['api', 'lint'], 'CO-07 case 1: plan.steps.run')
  assert.equal(doc.plan.steps.skip.length, 1, 'CO-07 case 1: exactly one skipped step')
  assert.equal(doc.plan.steps.skip[0].name, 'web', 'CO-07 case 1: web is the skipped step')
  assert.match(doc.plan.steps.skip[0].reason, /path match/, 'CO-07 case 1: skip reason is a path-match reason')
  assert.deepEqual(names(doc.gate).sort(), ['api', 'lint'], 'CO-07 case 1: the gate ran api and lint only (no frozen-file step, no CI parity step)')
  assert.equal(doc.gate.scope, 'affected', 'CO-07 case 1: gate scope')
  assert.deepEqual(doc.gate.skipped.map((entry) => entry.name), ['web'], 'CO-07 case 1: the gate reports web skipped')
  assert.deepEqual(fx.calls().sort(), ['api', 'lint'], 'CO-07 case 1: calls under --json')
})

test('CO-07 case 1: without --base the base resolves from the default refs and the header names it', (t) => {
  const fx = fixture(t)
  fx.commit({ 'api/x.js': 'changed\n' })
  const run = fx.run(['validate'])
  const first = lines(run.stdout)[0]
  assert.match(first, new RegExp(`^validation tier: fast \\(affected; base main ${fx.mergeBase().slice(0, 12)}; 1 files changed\\)$`), 'CO-07 case 1: default base is main (merge-base with HEAD)')
  assert.equal(run.code, 0, 'CO-07 case 1: exit 0 with the default tier')
})

// ---------- CO-07 case 2 ----------

test('CO-07 case 2: an unmapped change escalates to the full gate and all three steps run', (t) => {
  const fx = fixture(t)
  fx.commit({ 'docs/notes.md': 'notes\n' })
  const human = fx.run(['validate', '--base', 'main'])
  const out = lines(human.stdout)
  assert.equal(human.code, 0, `CO-07 case 2: exit 0; stderr: ${human.stderr}`)
  assert.equal(out[0], 'validation tier: full (escalated: UNMAPPED_CHANGE:docs/notes.md)', 'CO-07 case 2: first line')
  assert.equal(out.at(-1), 'VALIDATION: PASS (full gate)', 'CO-07 case 2: last line')
  assert.deepEqual(fx.calls().sort(), ALL, 'CO-07 case 2: api, web and lint all ran')

  fx.resetCalls()
  const doc = fx.run(['validate', '--base', 'main', '--json']).json()
  assert.equal(doc.plan.tier, 'full', 'CO-07 case 2: tier')
  assert.equal(doc.plan.requested, 'fast', 'CO-07 case 2: requested stays fast')
  assert.equal(doc.plan.escalated, true, 'CO-07 case 2: escalated')
  assert.deepEqual(doc.plan.reasons, ['UNMAPPED_CHANGE:docs/notes.md'], 'CO-07 case 2: exact reason list for a plain unmapped file')
  assert.ok(ALL.every((name) => names(doc.gate).includes(name)), 'CO-07 case 2: the full gate reports all three steps')
  assert.ok(names(doc.gate).includes(PARITY), 'CO-07 case 2: the full tier includes CI parity')
  assert.deepEqual(doc.gate.skipped, [], 'CO-07 case 2: nothing skipped in the full gate')
  assert.equal(doc.gate.scope, 'full', 'CO-07 case 2: gate scope is full')

  // The record keys by the tier that ran; the escalated run is a full-tier record.
  const record = fx.validation()
  assert.equal(record.full.tier, 'full', 'CO-07 case 2: escalated run is recorded as a full-tier record')
  assert.deepEqual(record.full.reasons, ['UNMAPPED_CHANGE:docs/notes.md'], 'CO-07 case 2: record carries the reasons')
  assert.equal(record.fast, null, 'CO-07 case 2: no fast record was written by an escalated run')
})

for (const [label, files, code] of [
  ['a lockfile', { 'package-lock.json': '{"changed":true}\n' }, 'LOCKFILE_CHANGED:package-lock.json'],
  ['a CI workflow', { '.github/workflows/ci.yml': 'name: ci\non: push\njobs:\n  t:\n    runs-on: ubuntu-22.04\n    steps:\n      - run: echo hi\n' }, 'CI_CONFIG_CHANGED:.github/workflows/ci.yml'],
  ['a GitLab CI file (a ciFiles entry outside .github/)', { '.gitlab-ci.yml': 'test:\n  script: echo hi\n' }, 'CI_CONFIG_CHANGED:.gitlab-ci.yml'],
  ['autobuild.json', { 'autobuild.json': 'EDIT_OPT_OUT_REASON' }, 'AUTOBUILD_CONFIG_CHANGED'],
]) {
  test(`CO-07 case 2: changing ${label} escalates with ${code}`, (t) => {
    const fx = fixture(t)
    let changes = files
    if (files['autobuild.json']) {
      // Keep the config valid: only the opt-out reason text changes.
      const base = JSON.parse(readFileSync(path.join(fx.repo, 'autobuild.json'), 'utf8'))
      changes = { 'autobuild.json': { ...base, ciParityOptOut: 'a different reason, same config' } }
    }
    fx.commit(changes)
    const run = fx.run(['validate', '--base', 'main', '--json'])
    assert.equal(run.code, 0, `CO-07 case 2: exit 0; stderr: ${run.stderr}`)
    const doc = run.json()
    assert.equal(doc.plan.tier, 'full', `CO-07 case 2 (${label}): tier full`)
    assert.equal(doc.plan.escalated, true, `CO-07 case 2 (${label}): escalated`)
    // Overlap: a lockfile or CI file is also matched by no `paths` pattern, so UNMAPPED_* may accompany it.
    assert.ok(doc.plan.reasons.includes(code), `CO-07 case 2 (${label}): reasons include ${code}; got ${JSON.stringify(doc.plan.reasons)}`)
    assert.deepEqual([...doc.plan.reasons].sort(), doc.plan.reasons, `CO-07 case 2 (${label}): reasons are sorted`)
    assert.equal(new Set(doc.plan.reasons).size, doc.plan.reasons.length, `CO-07 case 2 (${label}): reasons are listed once each`)
    assert.deepEqual(fx.calls().sort(), ALL, `CO-07 case 2 (${label}): all three steps ran`)
  })
}

test('CO-07 case 2: the progress file and the features file are exempt from UNMAPPED_CHANGE', (t) => {
  const fx = fixture(t)
  fx.commit({ 'api/x.js': 'changed\n', 'PROGRESS.md': '# progress\nmore\n', 'features.json': { schemaVersion: 1, features: [] } })
  writeFileSync(path.join(fx.repo, 'PROGRESS.md'), '# progress\nmore\nand more\n')
  const doc = fx.run(['validate', '--base', 'main', '--json']).json()
  assert.equal(doc.plan.tier, 'fast', 'CO-07 case 2: progress-file changes do not escalate')
  assert.deepEqual(doc.plan.reasons, [], 'CO-07 case 2: no reasons for the progress file or featuresFile')
  assert.deepEqual([...doc.plan.steps.run].sort(), ['api', 'lint'], 'CO-07 case 2: api still selected by its path')
})

test('CO-07 case 2: planValidation reason codes for manifests, lockfiles and CI paths (and look-alikes that must not match)', async (t) => {
  const fx = fixture(t)
  const { planValidation } = await ci('validate')
  const { loadConfig } = await lazy('config.mjs')
  const config = loadConfig(fx.repo, {})
  const plan = (changed, tier = 'fast') => planValidation({ config, root: fx.repo, changed, tier })

  // Every basename here sits under api/, which `paths: ["api"]` maps, so the only reason is the code itself.
  const manifests = ['package.json', 'pyproject.toml', 'setup.py', 'setup.cfg', 'go.mod', 'Cargo.toml', 'Gemfile', 'pom.xml', 'build.gradle', 'build.gradle.kts', 'requirements.txt', 'requirements-dev.txt']
  for (const base of manifests) {
    const p = plan([`api/${base}`])
    assert.equal(p.tier, 'full', `CO-07 case 2: ${base} escalates`)
    assert.deepEqual(p.reasons, [`MANIFEST_CHANGED:api/${base}`], `CO-07 case 2: ${base} is a manifest`)
  }
  const lockfiles = ['package-lock.json', 'pnpm-lock.yaml', 'yarn.lock', 'bun.lock', 'bun.lockb', 'poetry.lock', 'Pipfile.lock', 'go.sum', 'Cargo.lock', 'Gemfile.lock']
  for (const base of lockfiles) {
    const p = plan([`api/${base}`])
    assert.equal(p.tier, 'full', `CO-07 case 2: ${base} escalates`)
    assert.deepEqual(p.reasons, [`LOCKFILE_CHANGED:api/${base}`], `CO-07 case 2: ${base} is a lockfile`)
  }
  // Basename matching, not substring matching.
  for (const lookalike of ['my-package.json', 'package.json.bak', 'requirements.md', 'requirements', 'notes-yarn.lock.txt', 'go.summary', 'Gemfile.md']) {
    const p = plan([`api/${lookalike}`])
    assert.equal(p.tier, 'fast', `CO-07 case 2: ${lookalike} is not a manifest or lockfile`)
    assert.deepEqual(p.reasons, [], `CO-07 case 2: ${lookalike} gives no reason`)
  }
  assert.ok(plan(['.github/CODEOWNERS']).reasons.includes('CI_CONFIG_CHANGED:.github/CODEOWNERS'), 'CO-07 case 2: any path under .github/ is a CI config change')
  assert.ok(plan(['.github/workflows/other.yml']).reasons.includes('CI_CONFIG_CHANGED:.github/workflows/other.yml'), 'CO-07 case 2: workflow files')
  assert.deepEqual(plan(['docs/a.md', 'docs/b.md']).reasons, ['UNMAPPED_CHANGE:docs/a.md', 'UNMAPPED_CHANGE:docs/b.md'], 'CO-07 case 2: one UNMAPPED reason per unmapped path, sorted')
  assert.deepEqual(plan(['docs/a.md', 'docs/a.md']).reasons, ['UNMAPPED_CHANGE:docs/a.md'], 'CO-07 case 2: reasons are listed once each')
  assert.deepEqual(plan(['apix/y.js']).reasons, ['UNMAPPED_CHANGE:apix/y.js'], 'CO-07 case 2: a plain `paths` entry covers its directory, not a name prefix')
  assert.equal(plan(['api/deep/er/y.js']).tier, 'fast', 'CO-07 case 2: a plain `paths` entry covers everything under it')
  assert.equal(plan(['web/a/b/c.js']).tier, 'fast', 'CO-07 case 2: web/** covers nested files')

  // An empty change set with a resolved base is a fast tier with every `paths` step skipped.
  const empty = plan([])
  assert.equal(empty.tier, 'fast', 'CO-07 case 2: empty change set stays fast')
  assert.equal(empty.escalated, false, 'CO-07 case 2: empty change set is not escalated')
  assert.deepEqual(empty.steps.run, ['lint'], 'CO-07 case 2: only the step without paths runs')
  assert.deepEqual(empty.steps.skip.map((entry) => entry.name).sort(), ['api', 'web'], 'CO-07 case 2: every paths step is skipped')
  assert.ok(empty.steps.skip.every((entry) => /path match/.test(entry.reason)), 'CO-07 case 2: skip reasons name the path match')

  // A full request is never escalated.
  const full = plan(['package-lock.json', 'docs/a.md', '.github/workflows/ci.yml', 'autobuild.json'], 'full')
  assert.equal(full.tier, 'full', 'CO-07 case 2: requested full stays full')
  assert.equal(full.requested, 'full', 'CO-07 case 2: requested')
  assert.equal(full.escalated, false, 'CO-07 case 2: a full request is never escalated')
  assert.deepEqual(full.reasons, [], 'CO-07 case 2: a full request has no reasons')
  assert.ok(ALL.every((name) => full.steps.run.includes(name)), 'CO-07 case 2: the full tier runs every gate step')
  assert.deepEqual(full.steps.skip, [], 'CO-07 case 2: the full tier skips nothing')
})

// ---------- CO-07 case 3 ----------

test('CO-07 case 3: a gate with no paths anywhere escalates with NO_PATHS_DECLARED', (t) => {
  const fx = fixture(t, { paths: false })
  const empty = fx.run(['validate', '--base', 'main', '--json'])
  assert.equal(empty.code, 0, `CO-07 case 3: exit 0; stderr: ${empty.stderr}`)
  const doc = empty.json()
  assert.equal(doc.plan.tier, 'full', 'CO-07 case 3: tier full')
  assert.equal(doc.plan.escalated, true, 'CO-07 case 3: escalated')
  assert.deepEqual(doc.plan.reasons, ['NO_PATHS_DECLARED'], 'CO-07 case 3: with no changes the only reason is NO_PATHS_DECLARED')
  assert.deepEqual(fx.calls().sort(), ALL, 'CO-07 case 3: all three steps ran')

  fx.commit({ 'api/x.js': 'changed\n' })
  fx.resetCalls()
  const human = fx.run(['validate', '--base', 'main'])
  const first = lines(human.stdout)[0]
  assert.match(first, /^validation tier: full \(escalated: .*NO_PATHS_DECLARED.*\)$/, `CO-07 case 3: header names the reason; got ${first}`)
  assert.equal(lines(human.stdout).at(-1), 'VALIDATION: PASS (full gate)', 'CO-07 case 3: last line')
})

test('CO-07 case 3: a repository whose base cannot resolve escalates with NO_BASE', (t) => {
  const fx = fixture(t)
  fx.commit({ 'api/x.js': 'changed\n' })
  // Only one branch exists now, named trunk: none of origin/HEAD, origin/main, origin/master, main, master resolves.
  git(fx.repo, 'branch', '-m', 'main', 'trunk')
  git(fx.repo, 'branch', '-m', 'work', 'feature')
  const human = fx.run(['validate'])
  const out = lines(human.stdout)
  assert.equal(human.code, 0, `CO-07 case 3: exit 0; stderr: ${human.stderr}`)
  assert.equal(out[0], 'validation tier: full (escalated: NO_BASE)', 'CO-07 case 3: header')
  assert.equal(out.at(-1), 'VALIDATION: PASS (full gate)', 'CO-07 case 3: last line')
  assert.deepEqual(fx.calls().sort(), ALL, 'CO-07 case 3: all three steps ran')
  fx.resetCalls()
  const doc = fx.run(['validate', '--json']).json()
  assert.deepEqual(doc.plan.reasons, ['NO_BASE'], 'CO-07 case 3: NO_BASE is the only reason')
  const record = fx.validation()
  assert.equal(record.full.base, null, 'CO-07 case 3: record.base is null when no base resolved')
  assert.deepEqual(record.full.reasons, ['NO_BASE'], 'CO-07 case 3: record.reasons')
})

test('CO-07 case 3: --tier full gives no reasons and the (requested) header, and is never escalated', (t) => {
  const fx = fixture(t)
  fx.commit({ 'docs/notes.md': 'notes\n', 'package-lock.json': '{"changed":true}\n' })
  const human = fx.run(['validate', '--tier', 'full', '--base', 'main'])
  const out = lines(human.stdout)
  assert.equal(human.code, 0, `CO-07 case 3: exit 0; stderr: ${human.stderr}`)
  assert.equal(out[0], 'validation tier: full (requested)', 'CO-07 case 3: header')
  assert.equal(out.at(-1), 'VALIDATION: PASS (full gate)', 'CO-07 case 3: last line')
  assert.deepEqual(fx.calls().sort(), ALL, 'CO-07 case 3: all three steps ran')
  fx.resetCalls()
  const doc = fx.run(['validate', '--tier', 'full', '--json']).json()
  assert.equal(doc.plan.tier, 'full', 'CO-07 case 3: tier')
  assert.equal(doc.plan.requested, 'full', 'CO-07 case 3: requested')
  assert.equal(doc.plan.escalated, false, 'CO-07 case 3: escalated false')
  assert.deepEqual(doc.plan.reasons, [], 'CO-07 case 3: reasons []')
  assert.ok(names(doc.gate).includes(PARITY), 'CO-07 case 3: the full tier runs CI parity')
  assert.equal(doc.gate.scope, 'full', 'CO-07 case 3: no path selection in the full tier')
  assert.equal(fx.validation().full.tier, 'full', 'CO-07 case 3: recorded as a full-tier record')
  assert.deepEqual(fx.validation().full.reasons, [], 'CO-07 case 3: record.reasons is []')
})

test('CO-07 case 3: --tier full with no resolvable base is still a requested full tier', (t) => {
  const fx = fixture(t)
  git(fx.repo, 'branch', '-m', 'main', 'trunk')
  const doc = fx.run(['validate', '--tier', 'full', '--json']).json()
  assert.equal(doc.plan.escalated, false, 'CO-07 case 3: a full request is never escalated, even without a base')
  assert.deepEqual(doc.plan.reasons, [], 'CO-07 case 3: reasons []')
})

test('CO-07 case 3: an empty change set with a resolved base runs only the steps without paths', (t) => {
  const fx = fixture(t)
  const base = fx.mergeBase()
  const human = fx.run(['validate', '--base', 'main'])
  const out = lines(human.stdout)
  assert.equal(human.code, 0, `CO-07 case 3: exit 0; stderr: ${human.stderr}`)
  assert.match(out[0], new RegExp(`^validation tier: fast \\(affected; base main ${base.slice(0, 12)}; 0 files changed\\)$`), 'CO-07 case 3: header with 0 files')
  assert.equal(out.at(-1), 'VALIDATION: PASS (fast tier, not merge validation)', 'CO-07 case 3: last line')
  assert.deepEqual(fx.calls(), ['lint'], 'CO-07 case 3: only lint ran')
})

// ---------- CO-07 case 4 ----------

test('CO-07 case 4: an uncommitted edit counts toward the change set', (t) => {
  const fx = fixture(t)
  writeFileSync(path.join(fx.repo, 'api/x.js'), 'uncommitted\n')
  const run = fx.run(['validate', '--base', 'main'])
  assert.match(lines(run.stdout)[0], /; 1 files changed\)$/, 'CO-07 case 4: the uncommitted edit is counted')
  assert.deepEqual(fx.calls().sort(), ['api', 'lint'], 'CO-07 case 4: api selected by the uncommitted edit')
})

test('CO-07 case 4: an untracked file counts toward the change set', (t) => {
  const fx = fixture(t)
  writeFileSync(path.join(fx.repo, 'web/new.js'), 'untracked\n')
  const run = fx.run(['validate', '--base', 'main'])
  assert.match(lines(run.stdout)[0], /; 1 files changed\)$/, 'CO-07 case 4: the untracked file is counted')
  assert.deepEqual(fx.calls().sort(), ['lint', 'web'], 'CO-07 case 4: web selected by the untracked file, api skipped')
})

test('CO-07 case 4: committed, staged, edited and untracked changes all count; ignored files do not', (t) => {
  const fx = fixture(t)
  fx.commit({ 'web/a.js': 'committed\n' })
  writeFileSync(path.join(fx.repo, 'api/staged.js'), 'staged\n')
  git(fx.repo, 'add', 'api/staged.js')
  writeFileSync(path.join(fx.repo, 'api/x.js'), 'edited\n')
  writeFileSync(path.join(fx.repo, 'web/b.js'), 'untracked\n')
  mkdirSync(path.join(fx.repo, 'logs'), { recursive: true })
  writeFileSync(path.join(fx.repo, 'logs/scratch.txt'), 'ignored\n')
  const run = fx.run(['validate', '--base', 'main', '--json'])
  assert.equal(run.code, 0, `CO-07 case 4: exit 0; stderr: ${run.stderr}`)
  const doc = run.json()
  assert.equal(doc.plan.tier, 'fast', 'CO-07 case 4: stays in the fast tier')
  assert.deepEqual([...doc.plan.steps.run].sort(), ALL, 'CO-07 case 4: all three steps are selected')
  const human = fx.run(['validate', '--base', 'main'])
  assert.match(lines(human.stdout)[0], /; 4 files changed\)$/, 'CO-07 case 4: web/a.js, api/staged.js, api/x.js and web/b.js are counted; logs/scratch.txt is not')
})

test('CO-07 case 4: changedFiles returns the same list as changedSince', async (t) => {
  const fx = fixture(t)
  fx.commit({ 'web/a.js': 'committed\n' })
  writeFileSync(path.join(fx.repo, 'api/x.js'), 'edited\n')
  writeFileSync(path.join(fx.repo, 'docs-untracked.md'), 'u\n')
  const { changedFiles } = await ci('validate')
  const { changedSince } = await lazy('gate.mjs')
  const { loadConfig } = await lazy('config.mjs')
  const config = loadConfig(fx.repo, {})
  const base = fx.mergeBase()
  assert.deepEqual([...changedFiles(config, base)].sort(), [...changedSince(config, base)].sort(), 'CO-07 case 4: changedFiles equals changedSince')
  assert.deepEqual([...changedFiles(config, base)].sort(), ['api/x.js', 'docs-untracked.md', 'web/a.js'], 'CO-07 case 4: committed, edited and untracked files')
})

// ---------- resolveBase ----------

test('CO-07 resolveBase: an explicit ref gives the merge-base with HEAD, not the ref tip', async (t) => {
  const fx = fixture(t)
  fx.commit({ 'api/x.js': 'work\n' })
  const forkPoint = git(fx.repo, 'rev-parse', 'main')
  git(fx.repo, 'checkout', '-q', 'main')
  writeFiles(fx.repo, { 'web/index.js': 'main moved on\n' })
  git(fx.repo, 'commit', '-q', '-am', 'main advances')
  git(fx.repo, 'checkout', '-q', 'work')
  const mainTip = git(fx.repo, 'rev-parse', 'main')
  assert.notEqual(mainTip, forkPoint, 'fixture: main moved')
  const { resolveBase } = await ci('validate')
  const { loadConfig } = await lazy('config.mjs')
  const config = loadConfig(fx.repo, {})
  const got = resolveBase(config, 'main')
  assert.equal(got.ref, 'main', 'CO-07 resolveBase: ref')
  assert.equal(got.sha, forkPoint, 'CO-07 resolveBase: the merge-base of main and HEAD, not the tip of main')
  assert.equal(got.sha, fx.mergeBase('main'), 'CO-07 resolveBase: equals git merge-base')
})

test('CO-07 resolveBase: the default order is origin/HEAD, origin/main, origin/master, main, master', async (t) => {
  const fx = fixture(t)
  fx.commit({ 'api/x.js': 'work\n' })
  const { resolveBase } = await ci('validate')
  const { loadConfig } = await lazy('config.mjs')
  const config = loadConfig(fx.repo, {})
  const main = git(fx.repo, 'rev-parse', 'main')
  assert.equal(resolveBase(config).ref, 'main', 'CO-07 resolveBase: only main exists')

  git(fx.repo, 'branch', 'master', 'main')
  assert.equal(resolveBase(config).ref, 'main', 'CO-07 resolveBase: main before master')

  git(fx.repo, 'update-ref', 'refs/remotes/origin/master', main)
  assert.equal(resolveBase(config).ref, 'origin/master', 'CO-07 resolveBase: origin/master before main')

  git(fx.repo, 'update-ref', 'refs/remotes/origin/main', main)
  assert.equal(resolveBase(config).ref, 'origin/main', 'CO-07 resolveBase: origin/main before origin/master')

  git(fx.repo, 'update-ref', 'refs/remotes/origin/develop', main)
  git(fx.repo, 'symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/develop')
  assert.equal(resolveBase(config).ref, 'origin/HEAD', 'CO-07 resolveBase: origin/HEAD first')
  assert.equal(resolveBase(config).sha, main, 'CO-07 resolveBase: sha is the merge-base with HEAD')
})

// ---------- CO-07 case 5 ----------

test('CO-07 case 5: a failing api command gives VALIDATION: FAIL, exit 1, and a failed fast record', (t) => {
  const fx = fixture(t)
  fx.commit({ 'api/x.js': 'committed\n' })
  writeFileSync(path.join(fx.repo, 'api/x.js'), 'dirty\n') // an uncommitted edit: dirty must be true
  fx.setFailing(true)
  const human = fx.run(['validate', '--base', 'main'])
  const out = lines(human.stdout)
  assert.equal(human.code, 1, 'CO-07 case 5: exit 1 on failure')
  assert.equal(out.at(-1), 'VALIDATION: FAIL', 'CO-07 case 5: last line')
  assert.match(out[0], /^validation tier: fast \(affected; base main [0-9a-f]{12}; 1 files changed\)$/, 'CO-07 case 5: header still printed')
  const record = fx.validation()
  assert.equal(record.schemaVersion, 1, 'CO-07 case 5: schemaVersion')
  assert.equal(record.full, null, 'CO-07 case 5: no full record')
  assert.equal(record.fast.ok, false, 'CO-07 case 5: fast.ok is false')
  assert.equal(record.fast.tier, 'fast', 'CO-07 case 5: record.tier')
  assert.equal(record.fast.head, git(fx.repo, 'rev-parse', 'HEAD'), 'CO-07 case 5: record.head is the HEAD sha')
  assert.equal(record.fast.dirty, true, 'CO-07 case 5: record.dirty is true with an uncommitted edit')
  assert.equal(record.fast.base, fx.mergeBase(), 'CO-07 case 5: record.base is the merge-base sha')
  assert.deepEqual(record.fast.reasons, [], 'CO-07 case 5: record.reasons')
  assert.ok(!Number.isNaN(Date.parse(record.fast.at)) && new Date(record.fast.at).toISOString() === record.fast.at, 'CO-07 case 5: record.at is an ISO timestamp')
  assert.deepEqual(Object.keys(record.fast).sort(), ['at', 'base', 'dirty', 'head', 'ok', 'reasons', 'schemaVersion', 'tier'], 'CO-07 case 5: the record has exactly the contract fields')
  assert.deepEqual(fx.calls().sort(), ['api', 'lint'], 'CO-07 case 5: without --fail-fast every selected step still ran')

  fx.resetCalls()
  const json = fx.run(['validate', '--base', 'main', '--json'])
  assert.equal(json.code, 1, 'CO-07 case 5: --json exit 1')
  const doc = json.json()
  assert.equal(doc.ok, false, 'CO-07 case 5: --json ok false')
  assert.equal(doc.gate.ok, false, 'CO-07 case 5: gate.ok false')
  assert.equal(doc.gate.steps.find((step) => step.name === 'api').ok, false, 'CO-07 case 5: api step failed')
})

test('CO-07 case 5: a clean tree records dirty false, and ignored output does not make it dirty', (t) => {
  const fx = fixture(t)
  fx.commit({ 'api/x.js': 'committed\n' })
  const run = fx.run(['validate', '--base', 'main'])
  assert.equal(run.code, 0, `CO-07 case 5: exit 0; stderr: ${run.stderr}`)
  assert.equal(git(fx.repo, 'status', '--porcelain'), '', 'fixture: the gate left the tree clean (logs/ is ignored)')
  const record = fx.validation().fast
  assert.equal(record.ok, true, 'CO-07 case 5: fast.ok true')
  assert.equal(record.dirty, false, 'CO-07 case 5: dirty is false when git status --porcelain is empty')
  assert.equal(record.head, git(fx.repo, 'rev-parse', 'HEAD'), 'CO-07 case 5: head')
  assert.equal(record.base, fx.mergeBase(), 'CO-07 case 5: base is the merge-base sha')
})

test('CO-07 case 5: --fail-fast passes through in the fast tier and in the full tier', (t) => {
  const fx = fixture(t)
  fx.commit({ 'api/x.js': 'committed\n' })
  fx.setFailing(true)
  const fast = fx.run(['validate', '--base', 'main', '--fail-fast', '--json'])
  assert.equal(fast.code, 1, 'CO-07 case 5: fast --fail-fast exit 1')
  assert.deepEqual(fx.calls(), ['api'], 'CO-07 case 5: fast tier stopped after the first failing step')
  assert.ok(fast.json().gate.notRun.includes('lint'), 'CO-07 case 5: lint is reported not run')

  fx.resetCalls()
  const full = fx.run(['validate', '--tier', 'full', '--fail-fast', '--json'])
  assert.equal(full.code, 1, 'CO-07 case 5: full --fail-fast exit 1')
  assert.deepEqual(fx.calls(), ['api'], 'CO-07 case 5: full tier stopped after the first failing step')
})

test('CO-07 case 5: validation.json keeps one record per tier, each replaced by the next run of that tier', (t) => {
  const fx = fixture(t)
  fx.commit({ 'api/x.js': 'committed\n' })
  fx.setFailing(true)
  assert.equal(fx.run(['validate', '--base', 'main']).code, 1, 'fast fails')
  const failedAt = fx.validation().fast.at
  fx.setFailing(false)
  assert.equal(fx.run(['validate', '--base', 'main']).code, 0, 'fast passes')
  let doc = fx.validation()
  assert.equal(doc.fast.ok, true, 'CO-07 record: the passing fast run replaced the failing one')
  assert.ok(doc.fast.at >= failedAt, 'CO-07 record: at moves forward')
  assert.equal(doc.full, null, 'CO-07 record: full is still null')
  assert.equal(fx.run(['validate', '--tier', 'full']).code, 0, 'full passes')
  doc = fx.validation()
  assert.equal(doc.schemaVersion, 1, 'CO-07 record: schemaVersion')
  assert.equal(doc.fast.ok, true, 'CO-07 record: fast kept')
  assert.equal(doc.full.ok, true, 'CO-07 record: full written beside it')
  assert.equal(doc.full.tier, 'full', 'CO-07 record: full.tier')
  fx.setFailing(true)
  assert.equal(fx.run(['validate', '--base', 'main']).code, 1, 'fast fails again')
  doc = fx.validation()
  assert.equal(doc.fast.ok, false, 'CO-07 record: fast now failed')
  assert.equal(doc.full.ok, true, 'CO-07 record: a fast run leaves the full record alone')
})

test('CO-07 recordValidation: writes one record per tier with private modes, atomically, and replaces unreadable state', async (t) => {
  const fx = fixture(t)
  const { recordValidation } = await ci('validate')
  const env = { ...process.env, AUTOBUILD_STATE_HOME: fx.home }
  const head = git(fx.repo, 'rev-parse', 'HEAD')
  const rec = (tier, ok) => ({ schemaVersion: 1, head, dirty: false, tier, ok, at: new Date().toISOString(), base: null, reasons: [] })
  recordValidation(fx.repo, rec('fast', true), env)
  const file = path.join(fx.stateDir, 'validation.json')
  assert.equal(statSync(file).mode & 0o777, 0o600, 'CO-07 recordValidation: file mode 0600')
  assert.equal(statSync(fx.stateDir).mode & 0o777, 0o700, 'CO-07 recordValidation: directory mode 0700')
  const first = JSON.parse(readFileSync(file, 'utf8'))
  assert.equal(first.schemaVersion, 1, 'CO-07 recordValidation: schemaVersion')
  assert.equal(first.fast.ok, true, 'CO-07 recordValidation: fast record')
  assert.equal(first.full, null, 'CO-07 recordValidation: full is null')
  recordValidation(fx.repo, rec('full', false), env)
  const second = JSON.parse(readFileSync(file, 'utf8'))
  assert.equal(second.fast.ok, true, 'CO-07 recordValidation: the other tier is kept')
  assert.equal(second.full.ok, false, 'CO-07 recordValidation: full record')
  assert.deepEqual(readdirSync(fx.stateDir), ['validation.json'], 'CO-07 recordValidation: no temporary file is left behind')

  writeFileSync(file, '{ not json')
  recordValidation(fx.repo, rec('full', true), env)
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')).fast, null, 'CO-07 recordValidation: an unparseable file is treated as absent and replaced')
  writeFileSync(file, JSON.stringify({ schemaVersion: 99, fast: rec('fast', true), full: null }))
  recordValidation(fx.repo, rec('full', true), env)
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).fast, null, 'CO-07 recordValidation: a different schemaVersion is treated as absent')
})

// ---------- CO-07 case 6 ----------

test('CO-07 case 6: affectedBase selects steps (with scope affected) and does not enable the frozen-file or evidence checks', async (t) => {
  const fx = fixture(t)
  fx.commit({ 'api/x.js': 'changed\n' }) // api is in `frozen`, so a baseSha-driven gate would object
  const { runGate } = await lazy('gate.mjs')
  const { loadConfig } = await lazy('config.mjs')
  const config = loadConfig(fx.repo, {})
  const summary = runGate(config, { phase: 'full', scope: 'affected', affectedBase: fx.mergeBase(), caller: 'ci-validate', ciParity: false })
  assert.equal(summary.ok, true, 'CO-07 case 6: the gate passes')
  assert.deepEqual(names(summary).sort(), ['api', 'lint'], 'CO-07 case 6: affectedBase selected api and lint, and nothing else ran')
  assert.deepEqual(summary.skipped.map((entry) => entry.name), ['web'], 'CO-07 case 6: web skipped by path selection')
  assert.ok(!names(summary).includes('frozen files unchanged'), 'CO-07 case 6: no frozen-file step from affectedBase')
  assert.ok(!names(summary).includes('run evidence kept out of git'), 'CO-07 case 6: no evidence step from affectedBase')
  assert.deepEqual(fx.calls().sort(), ['api', 'lint'], 'CO-07 case 6: commands that ran')
})

test('CO-07 case 6: affectedBase replaces baseSha for selection, while the frozen check stays tied to baseSha', async (t) => {
  const fx = fixture(t)
  fx.commit({ 'api/x.js': 'changed\n' })
  const head = git(fx.repo, 'rev-parse', 'HEAD')
  const { runGate } = await lazy('gate.mjs')
  const { loadConfig } = await lazy('config.mjs')
  const config = loadConfig(fx.repo, {})
  // baseSha alone = HEAD: nothing changed since HEAD, so api is skipped (existing behaviour).
  const alone = runGate(config, { scope: 'affected', baseSha: head, ciParity: false })
  assert.ok(!names(alone).includes('api'), 'CO-07 case 6: baseSha alone selects by changes since HEAD, so api is skipped')
  fx.resetCalls()
  const both = runGate(config, { scope: 'affected', baseSha: head, affectedBase: fx.mergeBase(), ciParity: false })
  assert.ok(names(both).includes('api'), 'CO-07 case 6: affectedBase is used for selection in place of baseSha, so api runs')
  assert.ok(names(both).includes('frozen files unchanged'), 'CO-07 case 6: the frozen check still runs, tied to baseSha')
  assert.equal(both.steps.find((step) => step.name === 'frozen files unchanged').ok, true, 'CO-07 case 6: frozen check compares with baseSha (HEAD), where nothing changed')
})

test('CO-07 case 6: affectedBase is ignored outside scope affected', async (t) => {
  const fx = fixture(t)
  fx.commit({ 'api/x.js': 'changed\n' })
  const { runGate } = await lazy('gate.mjs')
  const { loadConfig } = await lazy('config.mjs')
  const config = loadConfig(fx.repo, {})
  const summary = runGate(config, { affectedBase: fx.mergeBase(), ciParity: false })
  assert.deepEqual(names(summary).sort(), ALL, 'CO-07 case 6: scope full runs every step even with affectedBase')
  assert.deepEqual(summary.skipped, [], 'CO-07 case 6: nothing skipped')
})

// These two pass against today's gate by design: they pin that existing calls stay identical.
test('CO-07 case 6: baseSha alone still runs the frozen-file step (existing behaviour, pinned)', async (t) => {
  const fx = fixture(t)
  fx.commit({ 'api/x.js': 'changed\n' })
  const { runGate } = await lazy('gate.mjs')
  const { loadConfig } = await lazy('config.mjs')
  const config = loadConfig(fx.repo, {})
  const summary = runGate(config, { baseSha: fx.mergeBase(), ciParity: false })
  const frozen = summary.steps.find((step) => step.name === 'frozen files unchanged')
  assert.ok(frozen, 'CO-07 case 6: baseSha adds the frozen-file step')
  assert.equal(frozen.ok, false, 'CO-07 case 6: it fails because api (frozen) changed since the base')
  assert.ok(names(summary).includes('run evidence kept out of git'), 'CO-07 case 6: baseSha adds the evidence step')
  assert.equal(summary.ok, false, 'CO-07 case 6: the gate fails')
  const selecting = runGate(config, { baseSha: fx.mergeBase(), scope: 'affected', ciParity: false })
  assert.deepEqual(selecting.skipped.map((entry) => entry.name), ['web'], 'CO-07 case 6: baseSha with scope affected still selects steps')
})

test('CO-07 case 6: a call with neither option behaves as before, and the gate step names are unchanged (pinned)', async (t) => {
  const fx = fixture(t)
  fx.commit({ 'api/x.js': 'changed\n' })
  const { runGate } = await lazy('gate.mjs')
  const { loadConfig } = await lazy('config.mjs')
  const config = loadConfig(fx.repo, {})
  const plain = runGate(config, { ciParity: false })
  assert.deepEqual(names(plain), ['api', 'web', 'lint'], 'CO-07 case 6: step names and order unchanged')
  assert.deepEqual(plain.skipped, [], 'CO-07 case 6: nothing skipped')
  const explicit = runGate(config, { affectedBase: null, ciParity: false })
  assert.deepEqual(names(explicit), ['api', 'web', 'lint'], 'CO-07 case 6: affectedBase null behaves as absent')
  const affectedNoBase = runGate(config, { scope: 'affected', ciParity: false })
  assert.deepEqual(names(affectedNoBase), ['api', 'web', 'lint'], 'CO-07 case 6: scope affected with no base runs everything, as before')
  const withParity = runGate(config, {})
  assert.deepEqual(names(withParity), ['api', 'web', 'lint', PARITY], 'CO-07 case 6: the CI parity step name is unchanged')
})

// ---------- CO-07 case 7 ----------

test('CO-07 case 7: --json prints exactly one document with plan, gate and ok', (t) => {
  const fx = fixture(t)
  fx.commit({ 'api/x.js': 'changed\n' })
  const run = fx.run(['validate', '--base', 'main', '--json'])
  assert.equal(run.code, 0, `CO-07 case 7: exit 0; stderr: ${run.stderr}`)
  const doc = JSON.parse(run.stdout) // throws unless stdout is exactly one JSON document
  assert.deepEqual(Object.keys(doc).sort(), ['gate', 'ok', 'plan'], 'CO-07 case 7: { plan, gate, ok }')
  assert.deepEqual(Object.keys(doc.plan).sort(), ['escalated', 'reasons', 'requested', 'steps', 'tier'], 'CO-07 case 7: plan fields')
  assert.deepEqual(Object.keys(doc.plan.steps).sort(), ['run', 'skip'], 'CO-07 case 7: plan.steps fields')
  assert.equal(typeof doc.gate.ok, 'boolean', 'CO-07 case 7: gate is the runGate summary')
  assert.ok(Array.isArray(doc.gate.steps), 'CO-07 case 7: gate.steps')
})

test('CO-07 case 7: without autobuild.json the command exits 2 with NO_AUTOBUILD_CONFIG', (t) => {
  const home = stateHome(t)
  const repo = makeRepo(t, { 'README.md': 'plain repo\n' })
  const run = runCi(repo, ['validate'], { AUTOBUILD_STATE_HOME: home })
  assert.equal(run.code, 2, 'CO-07 case 7: exit 2')
  assert.match(run.stderr, /^autobuild ci: NO_AUTOBUILD_CONFIG: .+/m, `CO-07 case 7: stderr carries the exact error code form; got ${run.stderr}`)

  const json = runCi(repo, ['validate', '--json'], { AUTOBUILD_STATE_HOME: home })
  assert.equal(json.code, 2, 'CO-07 case 7: --json exit 2')
  const doc = json.json()
  assert.equal(doc.error, 'NO_AUTOBUILD_CONFIG', 'CO-07 case 7: --json error code on stdout')
  assert.equal(typeof doc.message, 'string', 'CO-07 case 7: --json message')
  assert.match(json.stderr, /^autobuild ci: NO_AUTOBUILD_CONFIG: .+/m, 'CO-07 case 7: stderr too')
  assert.ok(!existsSync(path.join(home, 'autobuild')), 'CO-07 case 7: nothing is written to the state home')
})

test('CO-07 case 7: an unknown tier is a usage error and runs nothing', (t) => {
  const fx = fixture(t)
  fx.commit({ 'api/x.js': 'changed\n' })
  const run = fx.run(['validate', '--tier', 'bogus'])
  assert.equal(run.code, 2, 'CO-07 case 7: exit 2 for a usage error')
  assert.match(run.stderr, /^autobuild ci: [A-Z_]+: /m, `CO-07 case 7: stderr has the autobuild ci: <CODE>: form; got ${run.stderr}`)
  assert.deepEqual(fx.calls(), [], 'CO-07 case 7: no gate step ran')
})
