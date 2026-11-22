// Stale-lock takeover must never hide a live owner's loop lock (bughunt F2), and the
// break lock that makes the takeover safe (spec/contracts/codex-parity-cp-05d.md step 2a).
//
// qa-loop.mjs is run for real (the CLI) against an owned temp repo whose loop lock holds a
// dead owner's bytes S. A preload (--import) wraps two fs calls so the interleaving is
// forced instead of raced:
//   - right after this process opens the lock to read S, another iteration "A" completes
//     its takeover: the lock file now holds A's live bytes (the test process's pid);
//   - if the lock file is ever absent right after qa-loop renames it, a third iteration
//     "C" links its own lock into that gap, exactly as linkExclusive would.
// Expected: the live lock is never hidden, so C can never acquire it, and this iteration
// refuses with OWNER_BUSY because A is alive.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { test } from '../scripts/workflow-harness.mjs'

const ROOT = resolve(import.meta.dirname, '..')
const QA_LOOP = join(ROOT, 'graphs/qa/tool/qa-loop.mjs')
const WORK = realpathSync(mkdtempSync(join(tmpdir(), 'qa loop stale lock ')))

const HOOK = `import fs from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
const { QA_HOOK_LOCK: LOCK, QA_HOOK_A_BYTES: A_BYTES, QA_HOOK_C_BYTES: C_BYTES, QA_HOOK_LOG: LOG } = process.env
const realOpen = fs.openSync
const realRename = fs.renameSync
const realLink = fs.linkSync
const realExists = fs.existsSync
const realWrite = fs.writeFileSync
const realAppend = fs.appendFileSync
const note = line => realAppend(LOG, line + '\\n')
let aTookOver = false
fs.openSync = function (path, ...rest) {
  const fd = realOpen.call(this, path, ...rest)
  if (path === LOCK && !aTookOver) {
    // The stale bytes are read through fd; A's takeover lands right after.
    aTookOver = true
    realWrite(LOCK + '.a-temp', A_BYTES)
    realRename(LOCK + '.a-temp', LOCK)
    note('A-took-over')
  }
  return fd
}
fs.renameSync = function (from, to) {
  const result = realRename.call(this, from, to)
  if (from === LOCK && !realExists(LOCK)) {
    note('lock-hidden')
    realWrite(LOCK + '.c-temp', C_BYTES)
    try { realLink(LOCK + '.c-temp', LOCK); note('C-acquired') } catch { note('C-refused') }
  }
  return result
}
syncBuiltinESMExports()
`

const GIT_ENV = { PATH: process.env.PATH, LANG: 'C', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', HOME: WORK,
  GIT_AUTHOR_NAME: 'qa', GIT_AUTHOR_EMAIL: 'qa@example.invalid', GIT_COMMITTER_NAME: 'qa', GIT_COMMITTER_EMAIL: 'qa@example.invalid' }
function git(repo, ...args) {
  const r = spawnSync('git', ['-c', 'init.defaultBranch=main', ...args], { cwd: repo, env: GIT_ENV, encoding: 'utf8' })
  assert.equal(r.status, 0, `fixture: git ${args.join(' ')}: ${r.stderr}`)
}

const lockBytes = pid => `${JSON.stringify({ schemaVersion: 1, pid, token: `${String(pid).padStart(16, '0').slice(-16)}` })}\n`

// A pid that is certainly dead: a child that has already been reaped.
function deadPid() {
  const r = spawnSync(process.execPath, ['-e', ''])
  assert.equal(r.status, 0, 'fixture: dead pid child')
  return r.pid
}

try {
  await test('a stale-lock takeover never hides a live owner\'s lock, so a third iteration cannot enter (F2)', () => {
    const repo = join(WORK, 'repo')
    mkdirSync(repo, { recursive: true })
    git(repo, 'init', '-q')
    writeFileSync(join(repo, 'a.txt'), 'a\n')
    git(repo, 'add', '-A')
    git(repo, 'commit', '-q', '-m', 'fixture')
    const install = join(WORK, 'install')
    mkdirSync(install)
    const ledgerDir = join(repo, '.git', 'harness-loop')
    mkdirSync(ledgerDir, { mode: 0o700 })
    const lock = join(ledgerDir, 'native-loop.lock')
    const stale = lockBytes(deadPid())
    const liveA = lockBytes(process.pid)
    const liveC = lockBytes(process.pid + 1)
    writeFileSync(lock, stale)

    const hook = join(WORK, 'hook.mjs')
    const log = join(WORK, 'hook.log')
    writeFileSync(hook, HOOK)
    writeFileSync(log, '')
    const argsFile = join(WORK, 'args.json')
    writeFileSync(argsFile, JSON.stringify({ schemaVersion: 1, repo, installationRoot: install, codexBin: join(WORK, 'no-codex'),
      env: { PATH: '/usr/bin' }, timeoutMs: 60000 }))
    const env = { ...GIT_ENV, QA_HOOK_LOCK: lock, QA_HOOK_A_BYTES: liveA, QA_HOOK_C_BYTES: liveC, QA_HOOK_LOG: log }
    const r = spawnSync(process.execPath, ['--import', pathToFileURL(hook).href, QA_LOOP, '--args-file', argsFile],
      { env, encoding: 'utf8', timeout: 120000 })

    const events = readFileSync(log, 'utf8').split('\n').filter(Boolean)
    assert.ok(events.includes('A-took-over'), `fixture: the preload never ran: ${r.stderr}`)
    assert.ok(!events.includes('C-acquired'),
      `BUGHUNT-F2 the stale-lock takeover hid live owner A's lock and a third iteration acquired it (events: ${events.join(', ')})`)
    assert.equal(r.status, 4, `BUGHUNT-F2 a live lock owner must be refused with OWNER_BUSY (exit 4), got exit ${r.status}: ${r.stderr}`)
    assert.equal(readFileSync(lock, 'utf8'), liveA, 'BUGHUNT-F2 the live owner\'s lock must still be in place')
  })

  // The break lock (step 2a): a stale loop lock is removed only by the holder of
  // native-loop.lock.break. These cases plant one next to a dead owner's loop lock.
  function plantedCase(name, breakBytes) {
    const repo = join(WORK, name)
    mkdirSync(repo, { recursive: true })
    git(repo, 'init', '-q')
    const ledgerDir = join(repo, '.git', 'harness-loop')
    mkdirSync(ledgerDir, { mode: 0o700 })
    const lock = join(ledgerDir, 'native-loop.lock')
    const stale = lockBytes(deadPid())
    writeFileSync(lock, stale)
    writeFileSync(join(ledgerDir, 'native-loop.lock.break'), breakBytes)
    const argsFile = join(WORK, `${name}.json`)
    writeFileSync(argsFile, JSON.stringify({ schemaVersion: 1, repo, installationRoot: join(WORK, 'install'),
      codexBin: join(WORK, 'no-codex'), env: { PATH: '/usr/bin' }, timeoutMs: 60000 }))
    const r = spawnSync(process.execPath, [QA_LOOP, '--args-file', argsFile], { env: GIT_ENV, encoding: 'utf8', timeout: 120000 })
    return { r, lock, stale, ledgerDir }
  }

  await test('a live process holding the break lock is about to take the lock: refused as busy, nothing removed', () => {
    const live = lockBytes(process.pid)
    const { r, lock, stale, ledgerDir } = plantedCase('live breaker', live)
    assert.equal(r.status, 4, r.stderr)
    assert.equal(r.stdout, '')
    assert.deepEqual(JSON.parse(r.stderr), { error: 'OWNER_BUSY', invocationId: null,
      hint: `another qa-loop iteration (pid ${process.pid}) is running in this repository; run it again after that one exits` })
    assert.equal(readFileSync(lock, 'utf8'), stale, 'the stale loop lock stays for the breaker')
    assert.equal(readFileSync(join(ledgerDir, 'native-loop.lock.break'), 'utf8'), live)
    assert.equal(existsSync(join(ledgerDir, 'native-inflight.json')), false)
  })

  await test('a break lock left by a dead process is exit 3 IO_ERROR, for an operator; nothing removed', () => {
    const dead = lockBytes(deadPid())
    const { r, lock, stale, ledgerDir } = plantedCase('dead breaker', dead)
    assert.equal(r.status, 3, r.stderr)
    assert.equal(r.stderr, '{"error":"IO_ERROR"}\n')
    assert.equal(readFileSync(lock, 'utf8'), stale)
    assert.equal(readFileSync(join(ledgerDir, 'native-loop.lock.break'), 'utf8'), dead)
    assert.equal(existsSync(join(ledgerDir, 'native-inflight.json')), false)
  })
} finally {
  rmSync(WORK, { recursive: true, force: true })
}
