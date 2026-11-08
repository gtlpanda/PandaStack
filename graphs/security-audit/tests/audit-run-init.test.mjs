// audit-run-init.test.mjs - audit-run.mjs init, against throwaway git repos: every refusal, the read-only
// hook-free snapshot, the run metadata, events.jsonl, and the drift check on the copied git flags.
import { join, dirname, basename } from 'node:path'
import { writeFileSync, readFileSync, mkdirSync, existsSync, readdirSync, lstatSync, symlinkSync, chmodSync, rmSync, statSync, utimesSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import assert from 'node:assert/strict'
import { test, REPO } from '../../../scripts/workflow-harness.mjs'
import { appendEvent, advanceState, parseInitArgs, claimRunDir, nextRunNumber, SAFE_GIT, EXECUTION_BLOCKERS, EXECUTION_POLICY, STEPS } from '../skills/security-audit/audit-run.mjs'
import { VENDOR_SKILL_DIR } from '../skills/security-audit/upstream.mjs'
import { AUDIT_RUN, ENV, fresh, sh, put, FILES, mkRepo, init, runsOf, meta, listFiles } from './audit-fixtures.mjs'

console.log('== init: the gates')
await test('init refuses without --full, says why, and creates nothing', () => {
  const repo = mkRepo()
  const r = init([repo])
  assert.equal(r.status, 1)
  assert.match(r.last, /^AUDIT: FAIL a full audit needs --full/)
  assert.deepEqual(runsOf(repo), [])
})
await test('init refuses a directory that is not a git repository, and one that does not exist', () => {
  const plain = fresh('plain')
  put(join(plain, 'a.txt'), 'x\n')
  const r = init([plain, '--full'])
  assert.equal(r.status, 1)
  assert.match(r.last, /^AUDIT: FAIL .*is not inside a git working tree/)
  assert.deepEqual(readdirSync(plain), ['a.txt'])
  assert.match(init([join(plain, 'nope'), '--full']).last, /^AUDIT: FAIL .* does not exist$/)
})
await test('init refuses a repository with no commits', () => {
  const empty = fresh('empty')
  sh(empty, 'init', '-q', '-b', 'main')
  assert.match(init([empty, '--full']).last, /^AUDIT: FAIL .*has no commits/)
  assert.deepEqual(runsOf(empty), [])
})
await test('init refuses profiles quick and deep instead of running them as standard, and rejects an unknown one as usage', () => {
  const repo = mkRepo()
  for (const profile of ['quick', 'deep']) {
    const r = init([repo, '--full', '--profile', profile])
    assert.equal(r.status, 1, profile)
    assert.match(r.last, new RegExp(`^AUDIT: FAIL profile ${profile} is not available yet`))
  }
  assert.equal(init([repo, '--full', '--profile', 'fast']).status, 2)
  assert.equal(init([repo, '--full', '--profile', 'Standard']).status, 2)
  assert.deepEqual(runsOf(repo), [])
})
await test('init refuses an unsafe --out and creates nothing: inside the target and not ignored, by .., by symlink, existing, partly ignored', () => {
  const repo = mkRepo({ ...FILES, '.gitignore': '*.json\nignored-out/\n' })
  const outside = fresh('outside')
  symlinkSync(join(repo, 'src'), join(outside, 'link'))                 // outside/link -> repo/src
  symlinkSync(join(outside, 'nowhere'), join(outside, 'dangling'))
  put(join(outside, 'taken', 'x'), 'x\n')
  const cases = {
    'inside, not ignored': [join(repo, 'audit-out'), /inside the target and version control does not ignore it/],
    'inside, deep and not ignored': [join(repo, 'a', 'b', 'c'), /inside the target/],
    'inside through ..': [join(repo, 'src', '..', 'audit-out'), /inside the target/],
    'inside through a symlink': [join(outside, 'link', 'run'), /inside the target/],
    'only some file names ignored (*.json)': [join(repo, 'json-only'), /inside the target/],
    'inside .git but not under security-audit': [join(repo, '.git', 'hooks', 'run'), /inside the target/],
    'the target itself': [repo, /already exists/],
    'an existing directory': [join(outside, 'taken'), /already exists: a full audit writes to a new directory/],
    'a dangling symlink': [join(outside, 'dangling'), /already exists/],
  }
  for (const [name, [out, why]] of Object.entries(cases)) {
    const r = init([repo, '--full', '--out', out])
    assert.equal(r.status, 1, name)
    assert.match(r.last, new RegExp(`^AUDIT: FAIL .*${why.source}`), name)
  }
  assert.ok(!existsSync(join(repo, 'audit-out')) && !existsSync(join(repo, 'a')) && !existsSync(join(repo, 'json-only')) && !existsSync(join(repo, 'src', 'run')), 'a refused --out created a directory in the target')
  assert.deepEqual(runsOf(repo), [])
})
await test('init accepts --out outside the target, inside it when wholly ignored, and the default under .git', () => {
  const repo = mkRepo({ ...FILES, '.gitignore': 'ignored-out/\n' })
  const outside = join(fresh('outside'), 'deep', 'run-a')                // parents are created
  for (const [out, name] of [[outside, 'outside'], [join(repo, 'ignored-out', 'run'), 'ignored']]) {
    const r = init([repo, '--full', '--out', out])
    assert.equal(r.status, 0, `${name}: ${r.stdout}`)
    assert.equal(r.runDir, out)
    assert.ok(existsSync(join(out, 'tree', 'src', 'app.js')), name)
  }
  const d = init([repo, '--full'])
  assert.equal(d.runDir, join(repo, '.git', 'security-audit', 'run-1'))
  assert.equal(sh(repo, 'status', '--porcelain'), '', 'the audit left something in the target')
})
await test('run directories are numbered from the highest existing run-<N>, and a taken number is skipped, never reused', () => {
  const parent = fresh('runs')
  assert.equal(nextRunNumber(parent), 1)
  mkdirSync(join(parent, 'run-1')); mkdirSync(join(parent, 'run-4')); writeFileSync(join(parent, 'run-7'), 'a file holds the number too')
  mkdirSync(join(parent, 'run-0')); mkdirSync(join(parent, 'run-02')); mkdirSync(join(parent, 'run-x')); mkdirSync(join(parent, 'xrun-9')); mkdirSync(join(parent, 'run-3-old'))
  assert.equal(nextRunNumber(parent), 8)
  assert.deepEqual(claimRunDir(parent, 1), { runDir: join(parent, 'run-2'), runId: 'run-2' })
  assert.equal(claimRunDir(parent, 4).runId, 'run-5')
  assert.equal(claimRunDir(parent, 7).runId, 'run-8')
  assert.ok(existsSync(join(parent, 'run-2')) && existsSync(join(parent, 'run-5')))
  const repo = mkRepo()
  assert.deepEqual([1, 2, 3].map(() => init([repo, '--full']).runDir), [1, 2, 3].map(n => join(repo, '.git', 'security-audit', `run-${n}`)))
})
await test('a linked worktree target puts its runs under the main repository\'s git directory, outside the target', () => {
  const main = mkRepo()
  const linked = join(fresh('linked'), 'wt')
  sh(main, 'worktree', 'add', '-q', '-b', 'side', linked)
  const r = init([linked, '--full'])
  assert.equal(r.status, 0, r.stdout)
  assert.equal(r.runDir, join(main, '.git', 'security-audit', 'run-1'))
  assert.equal(meta(r.runDir).target, linked)
  assert.ok(existsSync(join(r.runDir, 'tree', 'src', 'app.js')))
})
await test('init runs through a symlinked skill directory, as install.sh links it into ~/.claude/skills', () => {
  const link = join(fresh('home'), 'security-audit')
  symlinkSync(dirname(AUDIT_RUN), link)
  const repo = mkRepo()
  const r = spawnSync(process.execPath, [join(link, 'audit-run.mjs'), 'init', repo, '--full'], { encoding: 'utf8', env: { ...process.env, ...ENV } })
  assert.equal(r.status, 0, r.stdout + r.stderr)
  assert.match(r.stdout.trim().split('\n').at(-1), /^AUDIT: OK run=run-1 /)
})
await test('init rejects malformed command lines as usage (exit 2), including inherited property names', () => {
  const repo = mkRepo()
  const bad = [
    ['--budget', '1e3'], ['--max-parallel'], ['--max-parallel', '--full'], ['--max-parallel', 'abc'], ['--max-parallel', '0'],
    ['--max-parallel', ' 5'], ['--max-parallel', '-1'], ['--max-parallel', '08'], ['--max-parallel', '5.5'],
    ['--max-units-per-hunter', '0'], ['--max-units-per-hunter', '99999999999999999999'],
    ['--scope', 'a,,b'], ['--scope', ''], ['--bogus'], ['--constructor', 'x'], ['--__proto__', 'x'], ['--toString'],
    ['one', 'two'], ['--out'], ['--out', '--full'],
  ]
  for (const args of bad) assert.equal(init([repo, '--full', ...args]).status, 2, args.join(' '))
  assert.throws(() => parseInitArgs(['--full', '--toString', 'x']))
  assert.deepEqual(runsOf(repo), [])
})

console.log('== init: the snapshot')
await test('the snapshot is the committed bytes: working-tree edits, new files, and .gitattributes (eol, ignored files) do not leak in', () => {
  const repo = mkRepo({ ...FILES, '.gitattributes': 'src/app.js text eol=crlf\nREADME.md export-ignore\n', 'bin/tool.sh': '#!/bin/sh\necho hi\n' })
  chmodSync(join(repo, 'bin/tool.sh'), 0o755)
  sh(repo, 'add', '-A'); sh(repo, 'commit', '-qm', 'tool')
  put(join(repo, 'src/app.js'), 'export const a = 999 // uncommitted\n')
  put(join(repo, 'untracked.js'), 'x\n')
  put(join(repo, '.gitattributes'), 'src/app.js text eol=crlf\nsrc/db.js text eol=crlf\n')   // the working tree adds a rule the commit does not have
  sh(repo, 'config', 'core.autocrlf', 'true')                              // the user's own setting must not reach the snapshot either
  const r = init([repo, '--full'])
  assert.equal(r.status, 0, r.stdout)
  const tree = join(r.runDir, 'tree')
  const committed = sh(repo, 'ls-tree', '-r', '--name-only', 'HEAD').split('\n')
  assert.deepEqual(listFiles(tree).sort(), committed.sort(), 'the snapshot holds exactly the committed files (export-ignore does not apply)')
  for (const f of committed) assert.equal(readFileSync(join(tree, f)).toString('latin1'), spawnSync('git', ['-C', repo, 'cat-file', 'blob', `HEAD:${f}`], { encoding: 'latin1' }).stdout, f)
  for (const f of ['src/app.js', 'src/db.js']) assert.ok(!readFileSync(join(tree, f), 'utf8').includes('\r'), `eol=crlf was applied to ${f}`)
  assert.ok(statSync(join(tree, 'bin/tool.sh')).mode & 0o100, 'the executable bit is kept')
})
await test('the snapshot is read-only: no write bit anywhere, and a write fails (unless root)', () => {
  const repo = mkRepo({ ...FILES, 'deep/er/file.txt': 'x\n' })
  const r = init([repo, '--full'])
  const tree = join(r.runDir, 'tree')
  const walk = d => readdirSync(d, { withFileTypes: true }).flatMap(e => [join(d, e.name), ...(e.isDirectory() ? walk(join(d, e.name)) : [])])
  for (const p of [tree, ...walk(tree)]) assert.equal(lstatSync(p).mode & 0o222, 0, `${p} is writable`)
  if (process.getuid() === 0) return console.log('       (running as root: the write-attempt half is skipped, mode bits are asserted above)')
  assert.throws(() => writeFileSync(join(tree, 'src/app.js'), 'x'), { code: 'EACCES' })
  assert.throws(() => writeFileSync(join(tree, 'new.txt'), 'x'), { code: 'EACCES' })
  assert.throws(() => rmSync(join(tree, 'src/app.js')), { code: 'EACCES' })
})
await test('a committed symlink is not kept in the snapshot, is listed with its target, and chmod never reaches its target', () => {
  const victim = join(fresh('victim'), 'secret.txt')
  put(victim, 'host file\n', 0o644)
  const repo = mkRepo()
  symlinkSync(victim, join(repo, 'escape'))                                // absolute, outside the repo
  symlinkSync('../../../../etc/hostname', join(repo, 'src', 'relative-escape'))
  symlinkSync('app.js', join(repo, 'src', 'inside'))                       // even a harmless one is not kept
  sh(repo, 'add', '-A'); sh(repo, 'commit', '-qm', 'links')
  const r = init([repo, '--full'])
  assert.equal(r.status, 0, r.stdout)
  const tree = join(r.runDir, 'tree')
  const kinds = []
  const walk = d => readdirSync(d, { withFileTypes: true }).forEach(e => { kinds.push(e.isSymbolicLink() ? 'symlink' : e.isDirectory() ? 'dir' : e.isFile() ? 'file' : 'other'); if (e.isDirectory()) walk(join(d, e.name)) })
  walk(tree)
  assert.ok(!kinds.includes('symlink') && !kinds.includes('other'), `tree/ holds only files and directories: ${[...new Set(kinds)]}`)
  assert.equal(statSync(victim).mode & 0o777, 0o644, 'the symlink target was chmod-ed')
  const m = meta(r.runDir)
  assert.equal(m.snapshot.skipped_total, 3)
  assert.deepEqual(m.snapshot.skipped.map(s => [s.path, s.kind, s.target]).sort(), [['escape', 'symlink', victim], ['src/inside', 'symlink', 'app.js'], ['src/relative-escape', 'symlink', '../../../../etc/hostname']])
  assert.match(r.stdout, /note: 3 symlink\(s\) and submodule\(s\) are not in tree\//)
})
await test('a submodule (gitlink) is listed as not audited', () => {
  const repo = mkRepo()
  sh(repo, 'update-index', '--add', '--cacheinfo', `160000,${'a'.repeat(40)},vendor/lib`)
  sh(repo, 'commit', '-qm', 'gitlink')
  const r = init([repo, '--full'])
  assert.equal(r.status, 0, r.stdout)
  assert.deepEqual(meta(r.runDir).snapshot.skipped, [{ path: 'vendor/lib', kind: 'submodule' }])
})
await test('a sparse-checkout repository still gets the whole committed tree', () => {
  const repo = mkRepo({ 'a/x.txt': '1\n', 'b/y.txt': '2\n' })
  sh(repo, 'sparse-checkout', 'init', '--cone')
  sh(repo, 'sparse-checkout', 'set', 'a')
  assert.ok(!existsSync(join(repo, 'b')))
  const r = init([repo, '--full'])
  assert.deepEqual(listFiles(join(r.runDir, 'tree')).sort(), ['a/x.txt', 'b/y.txt'])
})
await test('init never runs a hook or fsmonitor script the target committed (read-tree, checkout-index, and status each would)', () => {
  const repo = mkRepo()
  const trap = join(fresh('trap'), 'ran')
  for (const hook of ['post-checkout', 'post-index-change', 'reference-transaction', 'post-commit', 'fsmon']) {
    put(join(repo, '.githooks', hook), `#!/bin/sh\necho ${hook} >> ${trap}\nexit 1\n`, 0o755)
  }
  sh(repo, 'add', '-A'); sh(repo, 'commit', '-q', '--no-verify', '-m', 'hooks')
  sh(repo, 'config', 'core.hooksPath', '.githooks')                        // relative: resolves inside the checkout
  sh(repo, 'config', 'core.fsmonitor', '.githooks/fsmon')
  put(join(repo, 'src/app.js'), 'dirty\n')                                 // a dirty tree makes status do real work
  const planted = spawnSync('git', ['-C', repo, 'status', '--porcelain'], { encoding: 'utf8', env: { ...process.env, ...ENV } })
  assert.equal(planted.status, 0)
  assert.ok(existsSync(trap), 'the fixture is wrong: an unprotected git call did not trip the trap')
  rmSync(trap)
  const r = init([repo, '--full'])
  assert.equal(r.status, 0, r.stdout)
  assert.ok(!existsSync(trap), `a repo script ran during init: ${existsSync(trap) ? readFileSync(trap, 'utf8') : ''}`)
})
await test('init leaves the target alone: its index is byte-identical even when git status would have refreshed it', () => {
  const repo = mkRepo()
  const old = new Date(Date.now() - 60_000)
  utimesSync(join(repo, 'src/app.js'), old, old)                           // stale stat data: a plain status rewrites .git/index
  const before = readFileSync(join(repo, '.git', 'index'))
  const r = init([repo, '--full'])
  assert.equal(r.status, 0, r.stdout)
  assert.ok(before.equals(readFileSync(join(repo, '.git', 'index'))), 'init rewrote .git/index')
  assert.equal(sh(repo, 'rev-parse', 'HEAD'), meta(r.runDir).source_ref.commit)
})
await test('a failure after the run directory is claimed removes it, sealed parts included', () => {
  const repo = mkRepo()
  const blob = sh(repo, 'rev-parse', 'HEAD:src/db.js')
  rmSync(join(repo, '.git', 'objects', blob.slice(0, 2), blob.slice(2)))   // the tree is readable, one blob is not
  const r = init([repo, '--full'])
  assert.equal(r.status, 1)
  assert.match(r.last, /^AUDIT: FAIL checking out [0-9a-f]{40} failed/)
  assert.deepEqual(runsOf(repo), [])
})

console.log('== init: what it records')
await test('run-metadata.json has every field upstream requires and the defaults of decision D9', () => {
  const repo = mkRepo()
  put(join(repo, 'src/app.js'), 'changed\n')                               // tracked change
  put(join(repo, 'new1.js'), 'x\n'); put(join(repo, 'new2.js'), 'x\n')      // untracked
  const r = init([join(repo, 'src'), '--full', '--scope', 'src/db.js,src/app.js/'])
  assert.equal(r.status, 0, r.stdout)
  const m = meta(r.runDir)
  for (const k of ['run_id', 'repo', 'target', 'source_ref', 'profile', 'scope_paths', 'budget', 'execution_policy', 'selected_companion_files', 'prior_run_paths', 'shared_file_owners', 'run_status']) assert.ok(k in m, k)
  assert.equal(m.run_id, 'run-1')
  assert.equal(m.repo, basename(repo))
  assert.equal(m.target, repo, 'a subdirectory target resolves to the repository root')
  assert.deepEqual(m.scope_paths, ['src/app.js', 'src/db.js'])
  assert.equal(m.source_ref.commit, sh(repo, 'rev-parse', 'HEAD'))
  assert.equal(m.source_ref.tree, sh(repo, 'rev-parse', 'HEAD^{tree}'))
  assert.deepEqual([m.source_ref.dirty, m.source_ref.uncommitted], [true, { tracked: 1, untracked: 2 }])
  assert.match(r.stdout, /note: the working tree has uncommitted changes \(1 tracked, 2 untracked\)/)
  assert.deepEqual([m.profile, m.budget, m.run_status, m.incomplete_reason, m.agents_spent], ['standard', null, 'in_progress', null, 0])
  assert.deepEqual(m.limits, { max_parallel: 8, max_units_per_hunter: 4 })
  assert.equal(m.execution_policy, 'sandboxed-source-and-local-only')
  assert.equal(m.execution_policy, EXECUTION_POLICY)
  assert.equal(m.execution_capability, 'none')
  assert.deepEqual(m.execution_blockers, EXECUTION_BLOCKERS)
  assert.equal(m.upstream_pin.commit, JSON.parse(readFileSync(join(VENDOR_SKILL_DIR, '..', '..', 'UPSTREAM.json'), 'utf8')).commit)
  assert.deepEqual(m.snapshot, { path: 'tree', files: 3, bytes: Object.values(FILES).reduce((n, t) => n + Buffer.byteLength(t), 0), skipped_total: 0, skipped: [] })
  assert.deepEqual(readdirSync(r.runDir).sort(), ['events.jsonl', 'prior-runs.json', 'run-metadata.json', 'stage-state.json', 'tree'])
  assert.ok(!existsSync(join(r.runDir, 'agents')), 'v1 creates no agent directories')
  const { updated, ...state } = JSON.parse(readFileSync(join(r.runDir, 'stage-state.json'), 'utf8'))
  assert.deepEqual(state, { version: 1, last: 'init', wave: 0, critic_kind: null })
  assert.match(updated, /^\d{4}-/)
})
await test('a clean tree is not dirty, and the repo name comes from origin without credentials', () => {
  const repo = mkRepo()
  sh(repo, 'remote', 'add', 'origin', 'https://user:hunter2hunter2@example.com/acme/payments-api.git')   // allow-secret: a made-up credential, to prove it is never copied
  const r = init([repo, '--full'])
  const m = meta(r.runDir)
  assert.deepEqual([m.source_ref.dirty, m.source_ref.uncommitted, m.repo], [false, { tracked: 0, untracked: 0 }, 'payments-api'])
  assert.ok(!readFileSync(join(r.runDir, 'run-metadata.json'), 'utf8').includes('hunter2'))
})
await test('--scope refuses an unsafe path, one that is not committed, and a Windows device name; --max-parallel is clamped to 16', () => {
  const repo = mkRepo({ ...FILES, 'src/aux.js': 'x\n' })
  for (const bad of ['../x', '/etc', 'src/../README.md', 'src\\app.js', 'src/nope.js', 'src/aux.js', 'C:/x', '~/x', 'src//app.js']) {
    const r = init([repo, '--full', '--scope', bad])
    assert.equal(r.status, 1, bad)
    assert.match(r.last, /^AUDIT: FAIL --scope /, bad)
  }
  assert.deepEqual(runsOf(repo), [])
  const r = init([repo, '--full', '--max-parallel', '99', '--max-units-per-hunter', '2'])
  assert.deepEqual(meta(r.runDir).limits, { max_parallel: 16, max_units_per_hunter: 2 })
})

console.log('== events.jsonl and stage-state.json')
await test('init writes one parseable event line, and appending never rewrites an earlier line', () => {
  const repo = mkRepo()
  const r = init([repo, '--full'])
  const file = join(r.runDir, 'events.jsonl')
  const first = readFileSync(file, 'utf8')
  assert.equal(first.split('\n').filter(Boolean).length, 1)
  const e = JSON.parse(first)
  assert.deepEqual([e.cmd, e.stage, e.result, e.reason], ['init', 'init', 'ok', null])
  assert.match(e.at, /^\d{4}-\d\d-\d\dT[\d:.]+Z$/)
  assert.equal(typeof e.duration_ms, 'number')
  appendEvent(r.runDir, { cmd: 'merge-wave', stage: 'merge-wave', result: 'fail', reason: 'unit "x"\nnewline', agents_spent: 3 })
  const lines = readFileSync(file, 'utf8').split('\n')
  assert.equal(lines.pop(), '', 'every line ends in a newline')
  assert.equal(lines.length, 2)
  assert.equal(lines[0] + '\n', first)
  assert.deepEqual(lines.map(l => JSON.parse(l).stage), ['init', 'merge-wave'])
  assert.equal(JSON.parse(lines[1]).reason, 'unit "x"\nnewline')
})
await test('appendEvent and advanceState reject what is not an event or a step (null, numbers, objects, empty strings)', () => {
  const dir = fresh('events')
  for (const bad of [null, undefined, 0, 'x', [], {}, { cmd: 'a', stage: 'b' }, { cmd: 'a', stage: 'b', result: '' }, { cmd: 'a', stage: 5, result: 'ok' }, { cmd: {}, stage: 'b', result: 'ok' }]) {
    assert.throws(() => appendEvent(dir, bad), TypeError, JSON.stringify(bad))
  }
  assert.ok(!existsSync(join(dir, 'events.jsonl')))
  for (const bad of [null, 0, 'start', 'done', '', 'Init', ['init'], {}]) assert.throws(() => advanceState(dir, bad), TypeError, JSON.stringify(bad))
  assert.ok(!existsSync(join(dir, 'stage-state.json')))
})
await test('advanceState keeps wave and critic_kind, takes updates, and writes atomically', () => {
  const dir = fresh('state')
  advanceState(dir, 'init')
  advanceState(dir, 'plan-wave', { wave: 2 })
  advanceState(dir, 'critic', { critic_kind: 'final-clean' })
  advanceState(dir, 'mint')
  const s = JSON.parse(readFileSync(join(dir, 'stage-state.json'), 'utf8'))
  assert.deepEqual([s.version, s.last, s.wave, s.critic_kind], [1, 'mint', 2, 'final-clean'])
  assert.deepEqual(readdirSync(dir), ['stage-state.json'], 'no temp file is left behind')
  assert.deepEqual(STEPS.slice(0, 3), ['init', 'recon', 'seed'])
})

console.log('== the copied git flags have not drifted from /bughunt')
await test('SAFE_GIT equals the flags in evidence.mjs (and gate.mjs, review-status.mjs where they still define them)', () => {
  const dir = join(REPO, 'graphs', 'hunt', 'skills', 'bughunt')
  const literal = file => {
    const m = readFileSync(join(dir, file), 'utf8').match(/^const SAFE_GIT = (\[.*\])$/m)
    return m && new Function(`return ${m[1]}`)()
  }
  assert.deepEqual(literal('evidence.mjs'), SAFE_GIT, 'evidence.mjs no longer defines SAFE_GIT as one array literal: reconcile audit-run.mjs and this test')
  for (const file of ['gate.mjs', 'review-status.mjs']) if (literal(file)) assert.deepEqual(literal(file), SAFE_GIT, file)
  assert.match(readFileSync(join(dir, 'intake.mjs'), 'utf8'), /\['-c', 'core\.hooksPath=\/dev\/null', '-c', 'core\.fsmonitor=false', \.\.\.args\]/, 'intake.mjs no longer carries the same two flags')
  assert.deepEqual(SAFE_GIT, ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false'])
})
await test('the tree export keeps the shape of evidence.mjs exportTree: a private index, read-tree, then checkout-index -a -f', () => {
  const ev = readFileSync(join(REPO, 'graphs', 'hunt', 'skills', 'bughunt', 'evidence.mjs'), 'utf8')
  const mine = readFileSync(AUDIT_RUN, 'utf8')
  for (const [name, re] of Object.entries({ privateIndex: /GIT_INDEX_FILE/, readTree: /'read-tree'/, checkoutIndex: /'checkout-index', '-a', '-f'/ })) {
    assert.match(ev, re, `evidence.mjs lost ${name}: reconcile exportTree in audit-run.mjs`)
    assert.match(mine, re, `audit-run.mjs lost ${name}`)
  }
  assert.match(mine, /--attr-source=\$\{EMPTY_TREE\}/, 'the deliberate difference from evidence.mjs is gone')
})
