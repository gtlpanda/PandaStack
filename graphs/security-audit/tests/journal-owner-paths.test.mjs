import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { test } from '../../../scripts/workflow-harness.mjs'
import { openAuditJournal, readAuditJournal, assertAuditJournalOwner } from '../skills/security-audit/dispatch-journal.mjs'

// Ordinary STATIC path and identity regressions for assertAuditJournalOwner, using actual
// openAuditJournal owners over inert run directories. The two symlinks are created once and
// never replaced or retargeted; nothing here races a writer, spawns a process, captures
// output or executes target code. It proves refusal of fixed spellings only, not hardlink,
// bind-mount, case-insensitive-alias or hostile same-user replacement resistance.
const code = expected => error => error?.code === expected && error.message === `Audit journal: ${expected}`
const safe = error => /^Audit journal: [A-Z_]+$/.test(error?.message ?? '')

const META = { version: 1, run_id: 'owner-paths', repo: 'fixture', target: 'fixture',
  source_ref: { commit: 'a'.repeat(40), tree: 'b'.repeat(40), dirty: false, uncommitted: { tracked: 0, untracked: 0 } },
  run_status: 'in_progress' }
const STATE = { version: 1, last: 'init', wave: 0, critic_kind: null }
function writeRun(dir) {
  writeFileSync(join(dir, 'run-metadata.json'), JSON.stringify(META) + '\n')
  writeFileSync(join(dir, 'stage-state.json'), JSON.stringify(STATE))
}

// base/real/run is the opened run root. base/alias -> real/run aliases the run directory
// itself; base/via -> real aliases an ancestor of it. No link points at its own parent.
async function fixture(check) {
  const base = mkdtempSync(join(tmpdir(), 'journal-owner-paths-'))
  const handles = []
  try {
    const runDir = join(base, 'real', 'run')
    mkdirSync(runDir, { recursive: true })
    writeRun(runDir)
    const alias = join(base, 'alias'), via = join(base, 'via')
    symlinkSync(runDir, alias, 'dir')
    symlinkSync(join(base, 'real'), via, 'dir')
    await check({
      base, runDir, alias, via,
      metadata: join(runDir, 'run-metadata.json'),
      file: join(runDir, 'native-dispatch', 'journal.sqlite'),
      open: (dir = runDir) => { const handle = openAuditJournal({ runDir: dir, invocationLimit: 4 }); handles.push(handle); return handle },
      // Another run directory with byte-identical bound metadata, i.e. identical identity.
      copy: name => { const dir = join(base, name); mkdirSync(dir); writeRun(dir); return dir },
    })
  } finally {
    for (const handle of handles) handle.close()
    rmSync(base, { recursive: true, force: true })
  }
}

// Spellings the owning grammar refuses (explicit dot components) and symlink aliases of
// the opened root or of one of its ancestors.
const dots = x => [`${x.runDir}/.`, `${x.base}/real/./run`, `${x.runDir}/native-dispatch/..`, `${x.base}/real/run/../run`, `${x.runDir}/..`]
const aliases = x => [x.alias, `${x.alias}/`, join(x.via, 'run'), `${join(x.via, 'run')}/`]
const refuseAll = (x, owner) => {
  for (const spelling of [...dots(x), ...aliases(x), join(x.base, 'missing'), 'journal-owner-paths-absent/run', '', 'a\0b', undefined, null, 0, {}]) {
    assert.throws(() => assertAuditJournalOwner(owner, spelling), safe)
  }
}

await test('owner assertion accepts the opened root under equivalent separator spellings', () => fixture(x => {
  const owner = x.open(`${x.runDir}/`)
  for (const spelling of [x.runDir, `${x.runDir}/`, `${x.runDir}//`, `${x.base}//real/run`]) {
    assert.equal(assertAuditJournalOwner(owner, spelling), undefined, spelling)
    assert.doesNotThrow(() => readAuditJournal(spelling), spelling)
  }
}))

await test('explicit dot components are refused with the owning grammar, not normalized away', () => fixture(x => {
  const owner = x.open()
  for (const spelling of dots(x)) {
    assert.throws(() => assertAuditJournalOwner(owner, spelling), code('INVALID_JOURNAL_INPUT'), spelling)
    // Same provided-path grammar as the owning read.
    assert.throws(() => readAuditJournal(spelling), code('INVALID_JOURNAL_INPUT'), spelling)
  }
  assert.equal(assertAuditJournalOwner(owner, x.runDir), undefined)
}))

await test('symlink alias spellings of the root or an ancestor are not the opened root', () => fixture(x => {
  // Owning open refuses an alias spelling, so no owner can ever be registered under one.
  assert.throws(() => openAuditJournal({ runDir: x.alias, invocationLimit: 4 }), code('CORRUPT'))
  const owner = x.open()
  for (const spelling of aliases(x)) {
    assert.throws(() => assertAuditJournalOwner(owner, spelling), code('CONFLICT'), spelling)
    // The owning read refuses the same spelling.
    assert.throws(() => readAuditJournal(spelling), code('CORRUPT'), spelling)
  }
  assert.equal(assertAuditJournalOwner(owner, x.runDir), undefined)
}))

await test('equal bound identity at another directory never satisfies an owner', () => fixture(x => {
  const a = x.open(), otherDir = x.copy('copy-with-journal'), b = x.open(otherDir), bare = x.copy('copy-without-journal')
  assert.equal(assertAuditJournalOwner(a, x.runDir), undefined)
  assert.equal(assertAuditJournalOwner(b, otherDir), undefined)
  for (const [owner, dir] of [[a, otherDir], [b, x.runDir], [a, bare], [b, bare]]) {
    assert.throws(() => assertAuditJournalOwner(owner, dir), code('CONFLICT'))
  }
}))

await test('non-string and malformed provided paths fail as safe journal errors without hooks or leaked paths', () => fixture(x => {
  const owner = x.open(); let hooks = 0
  const exotic = { toString() { hooks++; return x.runDir }, valueOf() { hooks++; return x.runDir }, [Symbol.toPrimitive]() { hooks++; return x.runDir } }
  const getter = Object.defineProperty({}, 'href', { get() { hooks++; return x.runDir } })
  for (const bad of [undefined, null, 0, 1n, true, {}, [], exotic, getter, Buffer.from(x.runDir), pathToFileURL(x.runDir), '', 'a\0b', `${x.runDir}\0`]) {
    assert.throws(() => assertAuditJournalOwner(owner, bad), code('INVALID_JOURNAL_INPUT'))
  }
  assert.equal(hooks, 0)
  // Well-formed but different spellings are an ordinary mismatch, not a raw filesystem error.
  for (const other of [join(x.base, 'missing'), 'journal-owner-paths-absent/run']) {
    assert.throws(() => assertAuditJournalOwner(owner, other), code('CONFLICT'), other)
  }
}))

await test('owner branding and closed state take precedence over provided path validation', () => fixture(x => {
  const owner = x.open(); let hooks = 0
  const forged = { get prepare() { hooks++; throw new Error('forged methods must not be read') },
    get close() { hooks++; throw new Error('forged methods must not be read') } }
  const trap = () => { hooks++; throw new Error('a Proxy must not be inspected') }
  const proxy = new Proxy(owner, { get: trap, has: trap, getPrototypeOf: trap, ownKeys: trap, getOwnPropertyDescriptor: trap })
  const unregistered = [undefined, null, 0, '', 'owner', {}, forged, proxy, { ...owner }, Object.create(owner), () => owner]
  const paths = [x.runDir, undefined, 'a\0b', `${x.runDir}/.`, x.alias]
  for (const journal of unregistered) {
    for (const runDir of paths) {
      assert.throws(() => assertAuditJournalOwner(journal, runDir), code('INVALID_JOURNAL_OWNER'))
    }
  }
  assert.equal(hooks, 0)
  assert.equal(assertAuditJournalOwner(owner, x.runDir), undefined)
  owner.close()
  for (const runDir of paths) {
    assert.throws(() => assertAuditJournalOwner(owner, runDir), code('CLOSED'))
  }
}))

await test('current bound identity is still revalidated after path admission and terminal metadata stays assertable', () => fixture(x => {
  const owner = x.open(), original = readFileSync(x.metadata)
  const write = patch => writeFileSync(x.metadata, JSON.stringify({ ...META, ...patch }))
  try {
    for (const patch of [{ run_id: 'changed' }, { repo: 'changed' }, { target: 'changed' },
      { source_ref: { ...META.source_ref, commit: 'c'.repeat(40) } }, { source_ref: { ...META.source_ref, dirty: true } }]) {
      write(patch)
      assert.throws(() => assertAuditJournalOwner(owner, x.runDir), code('CONFLICT'))
    }
    write({ version: 2 })
    assert.throws(() => assertAuditJournalOwner(owner, x.runDir), code('CORRUPT'))
    for (const run_status of ['complete', 'incomplete']) {
      write({ run_status, incomplete_reason: run_status === 'incomplete' ? 'ordinary fixture limit' : null })
      assert.equal(assertAuditJournalOwner(owner, x.runDir), undefined)
    }
  } finally { writeFileSync(x.metadata, original) }
  assert.equal(assertAuditJournalOwner(owner, x.runDir), undefined)
}))

await test('refused spellings are read-only for rows and bytes and the owner stays usable', () => fixture(x => {
  const owner = x.open()
  const rows = readAuditJournal(x.runDir), bytes = readFileSync(x.file)
  refuseAll(x, owner)
  assert.deepEqual(readAuditJournal(x.runDir), rows)
  assert.deepEqual(readFileSync(x.file), bytes)
  assert.equal(owner.prepare({ id: 'after-refusals', input: { text: 'inert' } }).created, true)
  assert.equal(assertAuditJournalOwner(owner, x.runDir), undefined)
}))

await test('refused spellings leave opted-in control state and rows unchanged', () => fixture(x => {
  const owner = x.open()
  owner.initControl({ initialGrant: 2 })
  const control = owner.getControl(), rows = readAuditJournal(x.runDir), bytes = readFileSync(x.file)
  refuseAll(x, owner)
  assert.deepEqual(owner.getControl(), control)
  assert.deepEqual(readAuditJournal(x.runDir), rows)
  assert.deepEqual(readFileSync(x.file), bytes)
  assert.equal(assertAuditJournalOwner(owner, x.runDir), undefined)
}))
