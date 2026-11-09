import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, symlinkSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { fix } from '../skills/bughunt/evidence.mjs'

const root = fileURLToPath(new URL('../../../', import.meta.url))
const verify = join(root, 'core/skills/verify/verify.sh')
const intake = join(root, 'graphs/hunt/skills/bughunt/intake.mjs')
const env = { ...process.env, GIT_AUTHOR_NAME: 'test', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 'test', GIT_COMMITTER_EMAIL: 't@t' }
const put = (path, body) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, body) }
function git(repo, ...args) {
  const r = spawnSync('git', ['-c', 'core.hooksPath=/dev/null', '-C', repo, ...args], { encoding: 'utf8', env })
  assert.equal(r.status, 0, r.stderr); return r.stdout.trim()
}
function fixture(t, baselineFailure = null) {
  const repo = mkdtempSync(join(tmpdir(), 'mono-evidence-'))
  t.after(() => rmSync(repo, { recursive: true, force: true }))
  git(repo, 'init', '-q', '-b', 'main')
  put(join(repo, '.gitignore'), 'node_modules/\n')
  put(join(repo, 'package.json'), '{"private":true}')
  for (const pkg of ['server', 'client', 'shared']) {
    put(join(repo, pkg, 'package.json'), JSON.stringify({ type: 'module', ...(pkg === 'shared' ? {} : { scripts: { test: 'node --test check.test.mjs' } }) }))
  }
  put(join(repo, 'shared/value.mjs'), "import n from 'fixture-value'; export default n\n")
  put(join(repo, 'server/value.mjs'), 'export default 4\n')
  put(join(repo, 'client/value.mjs'), `export default ${baselineFailure === 'client' ? 0 : 4}\n`)
  for (const pkg of ['server', 'client']) put(join(repo, pkg, 'check.test.mjs'), `import { mkdirSync, writeFileSync } from 'node:fs'; mkdirSync('node_modules/.vite-temp',{recursive:true}); writeFileSync('node_modules/.vite-temp/sentinel','export-only'); import assert from 'node:assert/strict'; import n from './value.mjs'; import shared from '../shared/value.mjs'; assert.equal(n,4); assert.equal(shared,4); console.log('${pkg} executed')\n`)
  git(repo, 'add', '.'); git(repo, 'commit', '-qm', 'base'); git(repo, 'checkout', '-qb', 'feature')
  put(join(repo, 'feature.txt'), 'feature'); git(repo, 'add', '.'); git(repo, 'commit', '-qm', 'feature')
  for (const pkg of ['server', 'client']) put(join(repo, pkg, 'node_modules/.vite-temp/sentinel'), 'installed-unchanged')
  put(join(repo, 'shared/node_modules/fixture-value/package.json'), '{"type":"module","main":"index.js"}')
  put(join(repo, 'shared/node_modules/fixture-value/index.js'), 'export default 4\n')
  const r = spawnSync(process.execPath, [intake, repo], { encoding: 'utf8' })
  assert.equal(r.status, 0, r.stderr)
  const state = dirname(r.stdout.split('\n')[0]); const wt = join(state, 'fix')
  const key = JSON.parse(readFileSync(join(state, 'intake.json'))).key
  git(repo, 'worktree', 'add', '-qb', `bughunt/${key}`, wt, 'HEAD')
  put(join(wt, 'server/value.mjs'), 'export default 4 // repaired\n')
  return { repo, state, wt }
}

test('isolated repair executes both subproject suites with sibling library dependencies', t => {
  const { state, repo } = fixture(t)
  const result = fix(state, 'F1')
  assert.equal(result.verdict, 'PASS', result.reason)
  const rec = JSON.parse(readFileSync(join(state, 'evidence/F1.json')))
  assert.match(rec.runs[0].tail, /verify subproject client/)
  assert.match(rec.runs[0].tail, /verify subproject server/)
  assert.match(rec.runs[0].tail, /npm run test/)
  for (const pkg of ['server', 'client']) assert.equal(readFileSync(join(repo,pkg,'node_modules/.vite-temp/sentinel'),'utf8'),'installed-unchanged')
})
for (const pkg of ['server', 'client']) test(`a regression in ${pkg} fails against passing baseline`, t => {
  const { state, wt } = fixture(t)
  put(join(wt, pkg, 'value.mjs'), 'export default 0\n')
  const result = fix(state, 'F1')
  assert.equal(result.verdict, 'FAIL', result.reason)
  assert.match(result.reason, new RegExp(`verify subproject ${pkg}`))
})
test('repair cannot replace an existing child test script', t => {
  const { state, wt } = fixture(t)
  put(join(wt, 'server/package.json'), '{"scripts":{"test":"true"}}')
  const result = fix(state, 'F1'); assert.equal(result.verdict, 'FAIL'); assert.match(result.reason, /defines what the suite runs/)
})
test('no-suite repositories and malformed or symlinked subprojects fail closed', t => {
  const repo = mkdtempSync(join(tmpdir(), 'verify-mono-')); t.after(() => rmSync(repo, { recursive: true, force: true }))
  put(join(repo, 'package.json'), '{}')
  const run = () => spawnSync('bash', [verify, repo], { encoding: 'utf8' })
  assert.equal(run().status, 1)
  put(join(repo, 'bad/package.json'), '{broken')
  assert.equal(run().status, 1)
  rmSync(join(repo, 'bad'), { recursive: true })
  symlinkSync(repo, join(repo, 'escape'))
  const result = run(); assert.equal(result.status, 1); assert.match(result.stderr, /unsafe package path/)
})
for (const supported of [true, false]) test(`Vitest serial flag follows installed capability (${supported})`, t => {
  const repo = mkdtempSync(join(tmpdir(), 'verify-vitest-')); t.after(() => rmSync(repo, { recursive: true, force: true }))
  put(join(repo, 'app/package.json'), '{"scripts":{"test":"vitest run"}}')
  const expected = supported ? ['run', '--no-file-parallelism'] : ['run']
  put(join(repo, 'app/node_modules/.bin/vitest'), `#!/usr/bin/env node\nconst a=process.argv.slice(2); if(a[0]==='--help'){console.log(${JSON.stringify(supported ? '--fileParallelism' : 'old runner')});process.exit(0)} if(JSON.stringify(a)!==${JSON.stringify(JSON.stringify(expected))}) process.exit(1); console.log('all tests selected')\n`)
  spawnSync('chmod', ['+x', join(repo, 'app/node_modules/.bin/vitest')])
  const result = spawnSync('bash', [verify, repo], { encoding: 'utf8' }); assert.equal(result.status, 0, result.stdout+result.stderr); assert.match(result.stdout, /all tests selected/)
})

test('installed skill symlink still discovers and executes subprojects', t => {
  const repo = mkdtempSync(join(tmpdir(), 'verify-installed-')); t.after(() => rmSync(repo, { recursive: true, force: true }))
  put(join(repo, 'app/package.json'), JSON.stringify({ scripts: { test: 'node -e "console.log(42)"' } }))
  symlinkSync(dirname(verify), join(repo, '.installed'))
  const r = spawnSync('bash', [join(repo, '.installed/verify.sh'), repo], { encoding: 'utf8' })
  assert.equal(r.status, 0, r.stdout+r.stderr); assert.match(r.stdout, /verify subproject app/)
})

test('a baseline client failure cannot hide a newly regressed server suite', t => {
  const { state, wt } = fixture(t, 'client')
  put(join(wt, 'client/value.mjs'), 'export default 4\n')
  put(join(wt, 'server/value.mjs'), 'export default 0\n')
  const result = fix(state, 'F1')
  assert.equal(result.verdict, 'FAIL', result.reason)
  assert.match(result.reason, /verify subproject server/)
  const rec = JSON.parse(readFileSync(join(state, 'evidence/F1.json')))
  assert.ok(rec.runs.find(r => r.arm === 'suite with the repair').failing.includes('verify subproject server'))
  assert.ok(rec.runs.find(r => r.arm === 'suite without the repair').failing.includes('verify subproject client'))
})
