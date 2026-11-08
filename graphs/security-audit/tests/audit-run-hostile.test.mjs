// audit-run-hostile.test.mjs - audit-run.mjs against a target that is hostile input: git config and attributes that
// run commands or change bytes, files that block a read, URLs that carry credentials, odd paths and object formats.
// Each case came out of a review of the first version, and was reproduced here before the fix.
import { join } from 'node:path'
import { writeFileSync, readFileSync, appendFileSync, existsSync, readdirSync, mkdirSync, utimesSync, rmSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import assert from 'node:assert/strict'
import { test } from '../../../scripts/workflow-harness.mjs'
import { appendEvent, repoName } from '../skills/security-audit/audit-run.mjs'
import { fresh, sh, put, ENV, mkRepo, init, audit, meta, AUDIT_RUN } from './audit-fixtures.mjs'

const raw = (repo, ref) => spawnSync('git', ['-C', repo, 'cat-file', 'blob', ref], { encoding: 'latin1' }).stdout
const staleStat = (file, text) => { writeFileSync(file, text); const old = new Date(Date.now() - 3_600_000); utimesSync(file, old, old) }

console.log('== a hostile target cannot run commands or change the snapshot bytes')
await test('a filter driver in the target\'s git config never runs, in status or in checkout-index, even when it is required', () => {
  const repo = mkRepo({ 'a.txt': 'one\n', 'b.txt': 'two\n', 'id.txt': '$Id$\n' })
  const trap = fresh('trap')
  const cmd = name => `touch ${trap}/${name}; cat`
  appendFileSync(join(repo, '.git', 'config'), `[filter "x"]\n\tclean = ${cmd('CLEAN')}\n\tsmudge = ${cmd('SMUDGE')}\n\tprocess = ${cmd('PROCESS')}\n\trequired = true\n[filter "dotted.name"]\n\tsmudge = ${cmd('SMUDGE2')}\n`)
  mkdirSync(join(repo, '.git', 'info'), { recursive: true })
  writeFileSync(join(repo, '.git', 'info', 'attributes'), '* filter=x\nb.txt filter=dotted.name\nid.txt ident\n')
  staleStat(join(repo, 'a.txt'), 'changed\n')                              // stat-dirty: status must read it, through the clean filter
  const r = init([repo, '--full'])
  assert.equal(r.status, 0, r.stdout)
  assert.deepEqual(readdirSync(trap), [], `target code ran during init: ${readdirSync(trap)}`)
  assert.equal(meta(r.runDir).source_ref.uncommitted.tracked, 1, 'the dirty flag still sees the change')
  assert.equal(readFileSync(join(r.runDir, 'tree', 'a.txt'), 'utf8'), 'one\n')
})
await test('a submodule\'s own repository (config, filter, attributes) runs nothing either (a probe found status never enters one to compare content)', () => {
  const repo = mkRepo({ 'a.txt': 'x\n' })
  const nested = join(repo, 'sub')
  mkdirSync(nested)
  sh(nested, 'init', '-q', '-b', 'main'); put(join(nested, 'f.txt'), 'inner\n'); sh(nested, 'add', '-A'); sh(nested, 'commit', '-qm', 'inner')
  sh(repo, 'add', '-A'); sh(repo, 'commit', '-qm', 'with a gitlink')                       // sub is now a gitlink in HEAD
  const trap = fresh('trap')
  appendFileSync(join(nested, '.git', 'config'), `[filter "inner"]\n\tclean = touch ${trap}/INNER; cat\n`)
  mkdirSync(join(nested, '.git', 'info'), { recursive: true })
  writeFileSync(join(nested, '.git', 'info', 'attributes'), '* filter=inner\n')
  staleStat(join(nested, 'f.txt'), 'inner, changed\n')
  const r = init([repo, '--full'])
  assert.equal(r.status, 0, r.stdout)
  assert.deepEqual(readdirSync(trap), [], 'a submodule\'s filter ran')
  assert.deepEqual(meta(r.runDir).snapshot.skipped, [{ path: 'sub', kind: 'submodule' }])
})
await test('attributes outside the commit (info/attributes, core.attributesFile) do not change the snapshot bytes: no eol, no $Id$ expansion', () => {
  const repo = mkRepo({ 'a.txt': 'line1\nline2\n', 'id.txt': '$Id$\n', 'b.txt': 'x\ny\n' })
  const extra = join(fresh('attrs'), 'attributes')
  writeFileSync(extra, 'b.txt text eol=crlf\n')
  sh(repo, 'config', 'core.attributesFile', extra)
  mkdirSync(join(repo, '.git', 'info'), { recursive: true })
  writeFileSync(join(repo, '.git', 'info', 'attributes'), '* text eol=crlf\nid.txt ident\n')
  const r = init([repo, '--full'])
  assert.equal(r.status, 0, r.stdout)
  for (const f of ['a.txt', 'id.txt', 'b.txt']) assert.equal(readFileSync(join(r.runDir, 'tree', f)).toString('latin1'), raw(repo, `HEAD:${f}`), f)
})
await test('the user\'s own global attributes file does not change the snapshot bytes either', () => {
  const repo = mkRepo({ 'a.txt': 'line1\nline2\n' })
  const dir = fresh('global')
  writeFileSync(join(dir, 'attributes'), '* text eol=crlf\n')
  writeFileSync(join(dir, 'gitconfig'), `[core]\n\tattributesFile = ${join(dir, 'attributes')}\n\tautocrlf = true\n`)
  const r = spawnSync(process.execPath, [AUDIT_RUN, 'init', repo, '--full'], { encoding: 'utf8', env: { ...process.env, ...ENV, GIT_CONFIG_GLOBAL: join(dir, 'gitconfig') } })
  assert.equal(r.status, 0, r.stdout)
  assert.equal(readFileSync(join(r.stdout.split('\n')[0], 'tree', 'a.txt')).toString('latin1'), 'line1\nline2\n')
})
await test('a repository using the sha256 object format is audited too', () => {
  const dir = fresh('sha256')
  const probe = spawnSync('git', ['init', '-q', '-b', 'main', '--object-format=sha256', dir], { encoding: 'utf8', env: { ...process.env, ...ENV } })
  if (probe.status !== 0) return console.log('       (this git has no sha256 object format: skipped)')
  put(join(dir, 'a.txt'), 'x\n'); sh(dir, 'add', '-A'); sh(dir, 'commit', '-qm', 'c')
  const r = init([dir, '--full'])
  assert.equal(r.status, 0, r.stdout)
  assert.equal(readFileSync(join(r.runDir, 'tree', 'a.txt'), 'utf8'), 'x\n')
  assert.match(meta(r.runDir).source_ref.commit, /^[0-9a-f]{64}$/)
  assert.equal(audit(['check', r.runDir]).status, 0)
})
await test('a target whose directory name ends in a space is audited', () => {
  const dir = join(fresh('space'), 'repo ')
  mkdirSync(dir)
  sh(dir, 'init', '-q', '-b', 'main'); put(join(dir, 'a.txt'), 'x\n'); sh(dir, 'add', '-A'); sh(dir, 'commit', '-qm', 'c')
  const r = init([dir, '--full'])
  assert.equal(r.status, 0, r.stdout)
  assert.equal(meta(r.runDir).target, dir)
})

console.log('== files that block a read, and credentials in a URL')
await test('a symlink planted at .git/security-audit is refused: runs would land wherever it points', () => {
  const repo = mkRepo()
  const elsewhere = fresh('elsewhere')
  mkdirSync(join(repo, '.git'), { recursive: true })
  spawnSync('ln', ['-s', elsewhere, join(repo, '.git', 'security-audit')])
  const r = init([repo, '--full'])
  assert.equal(r.status, 1)
  assert.match(r.last, /^AUDIT: FAIL .*security-audit is a symlink: runs would land wherever it points/)
  assert.deepEqual(readdirSync(elsewhere), [])
  const viaOut = init([repo, '--full', '--out', join(fresh('free'), 'run-1')])           // an explicit --out is the user's own choice
  assert.equal(viaOut.status, 0, viaOut.stdout)
})
await test('a FIFO where a prior run keeps run-metadata.json does not hang init, and the run is recorded incompatible', () => {
  const repo = mkRepo()
  const prior = join(repo, '.git', 'security-audit', 'run-1')
  mkdirSync(prior, { recursive: true })
  assert.equal(spawnSync('mkfifo', [join(prior, 'run-metadata.json')]).status, 0)
  const r = spawnSync(process.execPath, [AUDIT_RUN, 'init', repo, '--full'], { encoding: 'utf8', timeout: 20_000, env: { ...process.env, ...ENV } })
  assert.equal(r.status, 0, `${r.status} ${r.signal} ${r.stdout}${r.stderr}`)
  const run = r.stdout.split('\n')[0]
  assert.equal(JSON.parse(readFileSync(join(run, 'prior-runs.json'), 'utf8'))[0].compatible, false)
})
await test('a FIFO as the run\'s own stage-state.json or events.jsonl is refused, not waited on', () => {
  const runDir = init([mkRepo(), '--full']).runDir
  const run = cmd => spawnSync(process.execPath, [AUDIT_RUN, cmd, runDir], { encoding: 'utf8', timeout: 20_000, env: { ...process.env, ...ENV } })
  for (const file of ['events.jsonl', 'stage-state.json']) {
    const good = readFileSync(join(runDir, file), 'utf8')
    rmSync(join(runDir, file))
    assert.equal(spawnSync('mkfifo', [join(runDir, file)]).status, 0)
    for (const cmd of file === 'events.jsonl' ? ['status', 'check'] : ['next', 'status', 'check']) {
      const r = run(cmd)
      assert.equal(r.status, 1, `${cmd} ${file}: ${r.status} ${r.signal} ${r.stdout}`)
      assert.match(r.stdout, /is not a regular file/, `${cmd} ${file}`)
    }
    // In a child process with a timeout: a regression here would otherwise hang the whole suite.
    const write = file === 'events.jsonl' ? `appendEvent(${JSON.stringify(runDir)}, { cmd: 'a', stage: 'b', result: 'c' })` : `advanceState(${JSON.stringify(runDir)}, 'recon')`
    const w = spawnSync(process.execPath, ['--input-type=module', '-e', `import { appendEvent, advanceState } from ${JSON.stringify(AUDIT_RUN)}; ${write}`], { encoding: 'utf8', timeout: 20_000 })
    assert.equal(w.status, 1, `${file}: ${w.status} ${w.signal} ${w.stderr}`)
    assert.match(w.stderr, /is not a regular file/)
    rmSync(join(runDir, file))
    writeFileSync(join(runDir, file), good)
  }
  assert.equal(run('check').status, 0)
})
await test('appendEvent after a torn last line starts a new line, so the new event still parses', () => {
  const runDir = init([mkRepo(), '--full']).runDir
  const file = join(runDir, 'events.jsonl')
  const whole = readFileSync(file, 'utf8')
  writeFileSync(file, whole.slice(0, -20))                                  // a crash mid-write
  appendEvent(runDir, { cmd: 'recon', stage: 'recon', result: 'ok' })
  const lines = readFileSync(file, 'utf8').split('\n').filter(Boolean)
  assert.equal(lines.length, 2)
  assert.throws(() => JSON.parse(lines[0]), 'the torn line stays torn')
  assert.equal(JSON.parse(lines[1]).stage, 'recon')
  appendEvent(runDir, { cmd: 'seed', stage: 'seed', result: 'ok' })
  assert.equal(readFileSync(file, 'utf8').split('\n').filter(Boolean).length, 3, 'a whole file gets no extra blank line')
})
await test('the repo name never carries a credential, a token, or a query from the origin URL', () => {
  const cases = [
    ['https://user:s3cretpw@host.example', 'top'], ['https://user:s3cretpw@host.example/', 'top'], ['https://h.example/org/repo?access_token=abc123', 'repo'],   // allow-secret: made-up credentials, to prove none is kept
    ['https://tok:x-oauth-basic@github.com/acme/payments-api.git', 'payments-api'], ['git@github.com:acme/payments-api.git', 'payments-api'],   // allow-secret: made-up credentials, to prove none is kept
    ['ssh://git@host:2222/srv/git/svc.git/', 'svc'], ['/srv/git/local-repo.git', 'local-repo'], ['file:///srv/git/other.git', 'other'],
    ['C:\\repos\\win-repo.git', 'win-repo'], ['https://h.example/org/repo.git#frag', 'repo'], ['', 'top'], ['   ', 'top'], ['https://h.example/org/we ird$name', 'we_ird_name'],
  ]
  for (const [url, want] of cases) assert.equal(repoName(url, '/work/top'), want, url)
  const repo = mkRepo()
  sh(repo, 'remote', 'add', 'origin', 'https://u:s3cretpw@host.example/o/r?access_token=abc123')   // allow-secret: made up
  const text = readFileSync(join(init([repo, '--full']).runDir, 'run-metadata.json'), 'utf8')
  assert.ok(!/s3cretpw|abc123|access_token/.test(text), 'a credential reached run-metadata.json')
})
await test('--scope refuses a committed symlink or submodule, which tree/ does not hold, but takes a file, a directory, and a name with glob characters', () => {
  const repo = mkRepo({ 'src/app.js': 'x\n', 'src/we*ird.js': 'y\n', 'src/w1ird.js': 'z\n' })
  spawnSync('ln', ['-s', '/etc', join(repo, 'linkdir')])
  sh(repo, 'add', '-A')
  sh(repo, 'update-index', '--add', '--cacheinfo', `160000,${'a'.repeat(40)},vendor/lib`)   // after add -A, which would drop a gitlink with no directory
  sh(repo, 'commit', '-qm', 'link and gitlink')
  for (const bad of ['linkdir', 'vendor/lib', 'src/we*']) assert.equal(init([repo, '--full', '--scope', bad]).status, 1, bad)
  assert.match(init([repo, '--full', '--scope', 'linkdir']).last, /^AUDIT: FAIL --scope linkdir is a symlink: tree\/ does not hold it/)
  assert.match(init([repo, '--full', '--scope', 'vendor/lib']).last, /^AUDIT: FAIL --scope vendor\/lib is a submodule: tree\/ does not hold it/)
  const ok = init([repo, '--full', '--scope', 'src/app.js,src,src/we*ird.js'])
  assert.equal(ok.status, 0, ok.stdout)
  assert.deepEqual(meta(ok.runDir).scope_paths, ['src', 'src/app.js', 'src/we*ird.js'])
})
