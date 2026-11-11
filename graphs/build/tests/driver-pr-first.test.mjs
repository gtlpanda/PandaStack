// PR-first finalization over ordinary already-landed local fixtures.
// Fake git intercepts push, fake gh records arguments, and the provider must not run.
import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, chmodSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import assert from 'node:assert/strict'
import { test } from '../../../scripts/workflow-harness.mjs'
const DRIVER = fileURLToPath(new URL('../skills/build-app/driver/driver.mjs', import.meta.url))
const REAL_GIT = spawnSync('which', ['git'], { encoding: 'utf8' }).stdout.trim()
const ENV = { ...process.env, GIT_AUTHOR_NAME: 'fixture', GIT_AUTHOR_EMAIL: 'fixture@example.invalid', GIT_COMMITTER_NAME: 'fixture', GIT_COMMITTER_EMAIL: 'fixture@example.invalid' }
function fixture(work) {
  const root = mkdtempSync(join(tmpdir(), 'draft-build-')), repo = join(root, 'repo'), bin = join(root, 'bin')
  mkdirSync(repo); mkdirSync(bin)
  const put = (path, text, executable = false) => { writeFileSync(path, text); if (executable) chmodSync(path, 0o755) }
  const git = (...args) => { const r = spawnSync(REAL_GIT, ['-C', repo, ...args], { env: ENV, encoding: 'utf8' }); assert.equal(r.status, 0, r.stderr); return r.stdout.trim() }
  try {
    git('init', '-q', '-b', 'main'); put(join(repo, 'README.md'), 'fixture\n'); git('add', '.'); git('commit', '-qm', 'base')
    git('checkout', '-qb', 'integration/toy'); mkdirSync(join(repo, 'docs'))
    put(join(repo, 'docs', 'backlog.json'), JSON.stringify({ version: 1, app: 'toy', integrationBranch: 'integration/toy', requirements: ['R1'], slices: [{ id: 'S1', title: 'one', goal: 'one', requirements: ['R1'], depends_on: [], acceptance: [{ id: 'S1-AC1', criterion: 'works', fails_when: 'broken' }] }] }))
    put(join(repo, 'autobuild.json'), JSON.stringify({ deliveryMode: 'pr-first' })); git('add', '.'); git('commit', '-qm', 'blueprint')
    put(join(repo, 'app.js'), 'export const fixture = true\n'); git('add', '.'); git('commit', '-qm', 'S1: landed ordinary fixture')
    git('remote', 'add', 'origin', 'https://github.com/example/fixture.git')
    const providerTrace = join(root, 'provider-called'), pushTrace = join(root, 'pushes'), ghTrace = join(root, 'gh-calls')
    put(join(bin, 'provider'), `#!/bin/sh\nprintf called > '${providerTrace}'\nexit 71\n`, true)
    put(join(bin, 'git'), `#!/usr/bin/env node
import {spawnSync} from 'node:child_process';import {appendFileSync} from 'node:fs';
const args=process.argv.slice(2);if(args.includes('push')){appendFileSync(${JSON.stringify(pushTrace)},JSON.stringify(args)+${JSON.stringify('\n')});process.exit(0)}
const r=spawnSync(${JSON.stringify(REAL_GIT)},args,{stdio:'inherit'});process.exit(r.status??1);
`, true)
    put(join(bin, 'gh'), `#!/usr/bin/env node
import {appendFileSync} from 'node:fs';const args=process.argv.slice(2);appendFileSync(${JSON.stringify(ghTrace)},JSON.stringify(args)+${JSON.stringify('\n')});
if(args[0]==='pr'&&args[1]==='list')console.log(process.env.FAKE_EXISTING_PRS||'[]');
else if(args[0]==='pr'&&args[1]==='create')console.log('https://github.com/example/fixture/pull/1');else process.exit(72);
`, true)
    const trace = file => existsSync(file) ? readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : []
    const drive = (flags = ['--no-pr'], extra = {}) => {
      const r = spawnSync(process.execPath, [DRIVER, 'run', '--repo', repo, '--app', 'toy', ...flags], { encoding: 'utf8', timeout: 30000,
        env: { ...ENV, PATH: bin + ':' + process.env.PATH, HARNESS_BUILD_CLAUDE_BIN: join(bin, 'provider'), HARNESS_BUILD_GH: join(bin, 'gh'), HARNESS_BUILD_BUGHUNT: '1', HARNESS_BUILD_VERIFY: 'echo VERIFY: PASS', PANDASTACK_NOTIFY: '', ...extra } })
      return { code: r.status, output: r.stdout + r.stderr, state: JSON.parse(readFileSync(join(repo, '.git/harness-build/toy/status.json'), 'utf8')) }
    }
    work({ repo, git, drive, trace, providerTrace, pushTrace, ghTrace })
  } finally { rmSync(root, { recursive: true, force: true }) }
}
await test('build-app PR-first no-pr returns ready_for_pr with pending checks and no final session, branch or push', () => fixture(f => {
  const before = f.git('rev-parse', 'HEAD'), result = f.drive()
  assert.equal(result.code, 0, result.output); assert.equal(result.state.state, 'ready_for_pr')
  assert.deepEqual(result.state.pendingChecks, ['full-regressions', 'final-qa', 'bughunt', 'review'])
  assert.equal(existsSync(f.providerTrace), false); assert.deepEqual(f.trace(f.pushTrace), []); assert.deepEqual(f.trace(f.ghTrace), [])
  assert.equal(f.git('rev-parse', 'HEAD'), before); assert.equal(f.git('rev-parse', '--abbrev-ref', 'HEAD'), 'integration/toy')
  assert.equal(f.git('branch', '--list', 'slice/final'), ''); assert.match(result.state.message, /nothing was pushed/)
}))
await test('build-app PR-first opens a draft before QA/hunt using only fake push and gh', () => fixture(f => {
  const result = f.drive(['--pr'])
  assert.equal(result.code, 0, result.output); assert.equal(result.state.state, 'awaiting_review'); assert.equal(result.state.draft, true)
  assert.equal(existsSync(f.providerTrace), false); assert.equal(f.git('branch', '--list', 'slice/final'), '')
  assert.equal(f.trace(f.pushTrace).length, 1)
  const calls = f.trace(f.ghTrace); assert.equal(calls.length, 2)
  const create = calls[1]; assert.deepEqual(create.slice(0, 3), ['pr', 'create', '--draft'])
  assert.equal(create[create.indexOf('--head') + 1], 'integration/toy'); assert.equal(create[create.indexOf('--base') + 1], 'main')
  assert.match(create[create.indexOf('--body') + 1], /Pending: final QA and full regressions/)
  assert.match(create[create.indexOf('--body') + 1], /Pending: bug hunt and review/)
  assert.match(result.state.message, /pending/); assert.equal(result.state.pr, 'https://github.com/example/fixture/pull/1')
}))
await test('build-app PR-first reuses a confirmed draft and never mislabels an existing ready PR', () => fixture(f => {
  const url = 'https://github.com/example/fixture/pull/2'
  const first = f.drive(['--pr'], { FAKE_EXISTING_PRS: JSON.stringify([{ url, isDraft: true }]) })
  assert.equal(first.code, 0, first.output); assert.equal(first.state.pr, url); assert.equal(f.trace(f.ghTrace).length, 1)
  const ready = f.drive(['--pr'], { FAKE_EXISTING_PRS: JSON.stringify([{ url, isDraft: false }]) })
  assert.equal(ready.code, 13, ready.output); assert.equal(ready.state.state, 'failed'); assert.match(ready.state.message, /not a verified draft/)
  assert.equal(f.trace(f.ghTrace).length, 2); assert.equal(existsSync(f.providerTrace), false)
}))
await test('build-app full mode still enters final QA instead of claiming a PR-first outcome', () => fixture(f => {
  writeFileSync(join(f.repo, 'autobuild.json'), JSON.stringify({ deliveryMode: 'full' })); f.git('add', '.'); f.git('commit', '-qm', 'full delivery')
  const result = f.drive()
  assert.equal(result.code, 3, result.output); assert.equal(result.state.state, 'braked'); assert.match(result.state.message, /final QA session wrote no report/)
  assert.equal(existsSync(f.providerTrace), true); assert.deepEqual(f.trace(f.pushTrace), []); assert.deepEqual(f.trace(f.ghTrace), [])
}))
