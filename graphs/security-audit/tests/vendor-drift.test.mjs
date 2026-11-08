// vendor-drift.test.mjs - the drift check for the vendored Cloudflare skill (vendor/check-vendor.mjs):
// the real tree matches its pin, and a changed, missing, extra, or swapped file fails by name.
// Mutations are made in a copy under tmpdir, never in the real tree.
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { mkdtempSync, mkdirSync, cpSync, readFileSync, writeFileSync, rmSync, symlinkSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { spawnSync } from 'node:child_process'
import assert from 'node:assert/strict'
import { test, REPO } from '../../../scripts/workflow-harness.mjs'
import { VENDOR_DIR } from '../skills/security-audit/upstream.mjs'
import { checkVendor, checkOnline, gitBlobHash, MANIFEST } from '../vendor/check-vendor.mjs'

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), '..', 'vendor', 'check-vendor.mjs')
const HUNTING = 'skills/security-audit/HUNTING.md'
const GIT_ENV = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' }

// Run fn(copy of the vendored tree) and delete the copy.
function withCopy(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'check-vendor-test-'))
  try {
    const copy = join(dir, 'tree')
    cpSync(VENDOR_DIR, copy, { recursive: true })
    return fn(copy)
  } finally { rmSync(dir, { recursive: true, force: true }) }
}
const edit = (copy, rel, f) => writeFileSync(join(copy, rel), f(readFileSync(join(copy, rel))))
const rewriteManifest = (copy, f) => writeFileSync(join(copy, MANIFEST), JSON.stringify(f(JSON.parse(readFileSync(join(copy, MANIFEST), 'utf8')))))
const cli = (...args) => spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8' })
const git = (cwd, ...args) => {
  const r = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8', env: GIT_ENV })
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`)
  return r.stdout.trim()
}

console.log('== vendor drift: the pinned tree')
await test('the vendored tree is exactly what UPSTREAM.json pins, and the MIT notice travels with it', () => {
  const r = checkVendor()
  assert.deepEqual(r.problems, [])
  assert.equal(r.count, 22)
  const m = JSON.parse(readFileSync(join(VENDOR_DIR, MANIFEST), 'utf8'))
  assert.match(m.commit, /^[0-9a-f]{40}$/)
  assert.equal(m.license.spdx, 'MIT')
  const license = readFileSync(join(VENDOR_DIR, m.license.file), 'utf8')
  assert.match(license, /^MIT License\n/)
  assert.ok(license.includes(m.license.copyright), 'the copyright line in LICENSE matches UPSTREAM.json')
  assert.match(readFileSync(join(VENDOR_DIR, '..', 'README.md'), 'utf8'), /Cloudflare, Inc\., MIT licensed/)
})
await test('the counts UPSTREAM.json and the vendor README state are the counts of the pinned file list', () => {
  const m = JSON.parse(readFileSync(join(VENDOR_DIR, MANIFEST), 'utf8'))
  const sum = entries => ({ files: entries.length, bytes: entries.reduce((n, [, f]) => n + f.size, 0) })
  const all = sum(Object.entries(m.files))
  const skill = sum(Object.entries(m.files).filter(([path]) => path.startsWith('skills/security-audit/')))
  assert.deepEqual([m.vendored.totalFiles, m.vendored.totalBytes, m.vendored.skillFiles, m.vendored.skillBytes], [all.files, all.bytes, skill.files, skill.bytes])
  assert.deepEqual([all.files, skill.files], [22, 20], 'LICENSE and README.md plus the 20 files of the skill directory')
  const readme = readFileSync(join(VENDOR_DIR, '..', 'README.md'), 'utf8')
  const n = x => x.toLocaleString('en-US')
  for (const claim of [`${all.files} files, ${n(all.bytes)} bytes`, `the ${skill.files} files (${n(skill.bytes)} bytes)`]) assert.ok(readme.includes(claim), `vendor README states: ${claim}`)
})
await test('gitBlobHash is what git hash-object prints, for empty, ASCII, and arbitrary bytes', () => {
  assert.equal(gitBlobHash(Buffer.alloc(0)), 'e69de29bb2d1d6434b8b29ae775ad8c2e48c5391')
  assert.equal(gitBlobHash(Buffer.from('hello\n')), 'ce013625030ba8dba906f756967f9e9ca394464a')
  const odd = Buffer.concat([Buffer.from('café 日本語\r\n'), Buffer.from([0, 255, 128, 10])])
  const r = spawnSync('git', ['hash-object', '--stdin'], { input: odd, encoding: 'utf8' })
  assert.equal(r.status, 0, r.stderr)
  assert.equal(gitBlobHash(odd), r.stdout.trim())
})
await test('line endings are protected: .gitattributes turns text conversion off for the vendored tree', () => {
  const r = spawnSync('git', ['-C', REPO, 'check-attr', 'text', '--', 'graphs/security-audit/vendor/cloudflare-security-audit/skills/security-audit/SKILL.md'], { encoding: 'utf8' })
  assert.equal(r.status, 0, r.stderr)
  assert.match(r.stdout.trim(), /: text: unset$/)
})

console.log('== vendor drift: a tree that no longer matches')
await test('one flipped byte in one file fails, naming that file and no other', () => {
  withCopy(copy => {
    edit(copy, HUNTING, b => { const c = Buffer.from(b); c[100] ^= 1; return c })
    const r = checkVendor(copy)
    assert.equal(r.problems.length, 1, r.problems.join('\n'))
    assert.match(r.problems[0], new RegExp(`^changed: ${HUNTING} \\(blob [0-9a-f]{40}, pinned [0-9a-f]{40}\\)$`))
    const out = cli(copy)
    assert.equal(out.status, 1)
    assert.match(out.stdout, new RegExp(`^changed: ${HUNTING} `, 'm'))
    assert.match(out.stdout, /^check-vendor: FAIL, 1 problem\(s\) against UPSTREAM\.json$/m)
  })
})
await test('a line-ending change (what a Windows checkout would do) and a one-byte truncation both fail', () => {
  withCopy(copy => {
    edit(copy, 'README.md', b => Buffer.from(b.toString('utf8').replace(/\n/g, '\r\n')))
    edit(copy, 'LICENSE', b => b.subarray(0, b.length - 1))
    assert.deepEqual(checkVendor(copy).problems.map(p => p.split(' ')[1]), ['LICENSE', 'README.md'])
  })
})
await test('a file in the tree that UPSTREAM.json does not list fails, however deep', () => {
  withCopy(copy => {
    writeFileSync(join(copy, 'skills/security-audit/EXTRA.md'), 'x')
    mkdirSync(join(copy, 'a/b'), { recursive: true })
    writeFileSync(join(copy, 'a/b/c.txt'), 'x')
    assert.deepEqual(checkVendor(copy).problems, [
      `extra: a/b/c.txt is not listed in ${MANIFEST}`,
      `extra: skills/security-audit/EXTRA.md is not listed in ${MANIFEST}`,
    ])
  })
})
await test('UPSTREAM.json itself is never an extra file, and a deleted file fails, naming it', () => {
  withCopy(copy => {
    assert.deepEqual(checkVendor(copy).problems, [])
    rmSync(join(copy, 'skills/security-audit/validate-coverage-ledger.cjs'))
    assert.deepEqual(checkVendor(copy).problems, ['missing: skills/security-audit/validate-coverage-ledger.cjs'])
    const out = cli(copy)
    assert.equal(out.status, 1)
    assert.match(out.stdout, /^missing: skills\/security-audit\/validate-coverage-ledger\.cjs$/m)
  })
})
await test('a symlink is never followed: a listed file swapped for a link, and a stray link, both fail', () => {
  withCopy(copy => {
    rmSync(join(copy, 'LICENSE'))
    symlinkSync(join(copy, 'README.md'), join(copy, 'LICENSE'))
    symlinkSync(join(copy, 'README.md'), join(copy, 'LINK.md'))
    assert.deepEqual(checkVendor(copy).problems, ['missing: LICENSE', 'not a regular file: LICENSE', 'not a regular file: LINK.md'])
  })
})
await test('UPSTREAM.json that is wrong in the file list, a size, or its shape is a problem, never a crash', () => {
  withCopy(copy => {
    rewriteManifest(copy, m => { m.files[HUNTING].size += 1; return m })
    assert.deepEqual(checkVendor(copy).problems, [`size: ${HUNTING} is ${readFileSync(join(copy, HUNTING)).length} bytes, ${MANIFEST} says ${readFileSync(join(copy, HUNTING)).length + 1}`])
  })
  const broken = [
    ['not JSON', copy => writeFileSync(join(copy, MANIFEST), '{')],
    ['missing', copy => rmSync(join(copy, MANIFEST))],
    ['an array', copy => rewriteManifest(copy, () => [])],
    ['null', copy => rewriteManifest(copy, () => null)],
    ['no files', copy => rewriteManifest(copy, m => { m.files = {}; return m })],
    ['files is a list', copy => rewriteManifest(copy, m => { m.files = []; return m })],
    ['a short blob', copy => rewriteManifest(copy, m => { m.files[HUNTING].blob = 'abc'; return m })],
    ['an upper-case blob', copy => rewriteManifest(copy, m => { m.files[HUNTING].blob = m.files[HUNTING].blob.toUpperCase(); return m })],
    ['a string size', copy => rewriteManifest(copy, m => { m.files[HUNTING].size = '5'; return m })],
    ['an entry that is not an object', copy => rewriteManifest(copy, m => { m.files[HUNTING] = 5; return m })],
    ['a bad commit', copy => rewriteManifest(copy, m => { m.commit = 'main'; return m })],
  ]
  for (const [what, mutate] of broken) {
    withCopy(copy => {
      mutate(copy)
      const r = checkVendor(copy)
      assert.ok(r.problems.length > 0 && r.problems.every(p => p.startsWith(`${MANIFEST}:`)), `${what}: ${r.problems.join('; ')}`)
    })
  }
})
await test('the CLI: 0 on the real tree, 1 on a bad one, 2 on a bad command line or a directory with no pin', () => {
  const ok = cli()
  assert.equal(ok.status, 0, ok.stdout + ok.stderr)
  assert.match(ok.stdout, /^check-vendor: 22 files match UPSTREAM\.json \([0-9a-f]{12}\)$/m)
  for (const args of [['--nope'], ['a', 'b'], ['--online', 'a']]) {
    const r = cli(...args)
    assert.equal(r.status, 2, args.join(' '))
    assert.match(r.stderr, /^usage: check-vendor\.mjs/)
  }
  const empty = mkdtempSync(join(tmpdir(), 'check-vendor-empty-'))
  try {
    const r = cli(empty)
    assert.equal(r.status, 1)
    assert.match(r.stdout, /^UPSTREAM\.json: cannot be read as JSON/m)
  } finally { rmSync(empty, { recursive: true, force: true }) }
})

console.log('== vendor drift: --online (a local repo stands in for the remote; the network is never used)')
await test('--online reports current, how far behind with subjects, or that the pin left the history', () => {
  const dir = mkdtempSync(join(tmpdir(), 'check-vendor-online-'))
  try {
    const upstream = join(dir, 'upstream')
    const other = join(dir, 'other')
    for (const d of [upstream, other]) mkdirSync(d)
    git(upstream, 'init', '-q', '-b', 'main')
    const commit = (repo, subject) => { writeFileSync(join(repo, 'f'), subject); git(repo, 'add', '.'); git(repo, 'commit', '-qm', subject); return git(repo, 'rev-parse', 'HEAD') }
    const first = commit(upstream, 'first')
    commit(upstream, 'second')
    const third = commit(upstream, 'third')
    git(other, 'init', '-q', '-b', 'main')
    const stranger = commit(other, 'unrelated')
    const opts = { remote: upstream, protocol: 'file' }
    const m = commit => ({ repo: upstream, branch: 'main', commit })
    assert.deepEqual(checkOnline(m(third), opts), { state: 'current', head: third, ahead: 0, subjects: [] })
    assert.deepEqual(checkOnline(m(first), opts), { state: 'behind', head: third, ahead: 2, subjects: ['third', 'second'] })
    assert.deepEqual(checkOnline(m(first), { ...opts, limit: 1 }).subjects, ['third'])
    assert.deepEqual(checkOnline(m(stranger), opts), { state: 'diverged', head: third, ahead: null, subjects: [] })
    assert.deepEqual(checkOnline(m('0'.repeat(40)), opts), { state: 'diverged', head: third, ahead: null, subjects: [] })
    assert.throws(() => checkOnline(m(first), { remote: join(dir, 'nowhere'), protocol: 'file' }), /git fetch/)
    assert.equal(existsSync(join(upstream, '.git', 'FETCH_HEAD')), false, 'the source repo is only read')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
await test('--online refuses a repo that is not an https URL, and a branch that could pass as an option', () => {
  const m = { repo: 'https://github.com/cloudflare/security-audit-skill', branch: 'main', commit: '0'.repeat(40) }
  for (const repo of ['/tmp/some/repo', 'file:///tmp/repo', 'ext::sh -c id', '-oProxyCommand=id', 'http://github.com/x/y', 'https://', 'https://a b']) {
    assert.throws(() => checkOnline({ ...m, repo }), /repo must be an https URL/, repo)
  }
  for (const branch of ['--upload-pack=id', '-x', 'a b', 'a;b']) {
    assert.throws(() => checkOnline({ ...m, branch }), /not a plain branch name/, branch)
  }
})
