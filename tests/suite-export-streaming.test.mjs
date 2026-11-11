import assert from 'node:assert/strict'
import childProcess from 'node:child_process'
import { syncBuiltinESMExports } from 'node:module'
import { mkdtempSync, rmSync, readdirSync, existsSync, writeFileSync, readFileSync, fstatSync, statSync, readlinkSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { test } from '../scripts/workflow-harness.mjs'
import { createSuiteExport } from '../graphs/hunt/skills/bughunt/evidence.mjs'

// Ordinary, sequential fake Git boundary and owned output files only. This does
// not start a child, execute source code, or model a filesystem replacement race.
function fixture(options, work) {
  const root = mkdtempSync(join(tmpdir(), 'suite-streaming-'))
  const previousTmpdir = process.env.TMPDIR, original = childProcess.spawnSync
  const format = options.format ?? 'sha1'
  const repo = '/inert/source'
  const tree = 'a'.repeat(40), fullTree = 'a'.repeat(format === 'sha256' ? 64 : 40)
  const blob = 'b'.repeat(fullTree.length), commit = 'c'.repeat(fullTree.length)
  const bytes = options.bytes ?? Buffer.from([0, 255, 13, 10, 65])
  const mode = options.mode ?? '100755', calls = []
  let directory, streamFd
  process.env.TMPDIR = root
  childProcess.spawnSync = (command, args, config) => {
    assert.equal(command, 'git')
    let at = 2
    while (args[at] === '-c') at += 2
    const argv = args.slice(at), source = args[1] === repo
    calls.push({ source, argv, config })
    let stdout = ''
    if (source) {
      if (argv[1] === '--show-object-format') stdout = options.formatOutput ?? format + '\n'
      else { assert.deepEqual(argv, ['rev-parse', '--path-format=absolute', '--git-path', 'objects']); stdout = repo + '/.git/objects\n' }
    } else {
      directory = args[1]
      assert.equal(config.maxBuffer, 128 * 1024 * 1024)
      assert.equal(config.timeout, 30000)
      switch (argv[0]) {
        case 'init': assert.ok(argv.includes('--object-format=' + format)); break
        case 'read-tree': assert.equal(argv[1], tree); break
        case 'ls-files': stdout = `${mode} ${blob} 0\tentry.bin\0`; break
        case 'cat-file':
          if (argv[1] === '--batch-check') {
            assert.deepEqual(config.input, Buffer.from(blob + '\n'))
            stdout = `${blob} blob ${bytes.length + (options.sizeDelta ?? 0)}\n`
          } else if (argv[1] === '--batch') {
            assert.ok(bytes.length <= 1024 * 1024, 'large data must not use buffered batch stdout')
            stdout = Buffer.concat([Buffer.from(`${options.badHeader ? 'd'.repeat(blob.length) : blob} blob ${bytes.length}\n`), bytes, Buffer.from('\n')])
          } else {
            assert.deepEqual(argv, ['cat-file', 'blob', blob])
            assert.equal(config.encoding, null)
            assert.equal(config.stdio[0], 'ignore'); assert.equal(config.stdio[2], 'pipe')
            streamFd = config.stdio[1]
            assert.equal(Number.isInteger(streamFd), true)
            assert.equal(fstatSync(streamFd).mode & 0o777, 0o600)
            writeFileSync(streamFd, bytes)
            if (options.failStream) return { status: 1, stdout: null, stderr: 'inert failure' }
            stdout = null
          }
          break
        case 'rev-parse': stdout = fullTree + '\n'; break
        case 'commit-tree': assert.equal(argv[1], fullTree); stdout = commit + '\n'; break
        case 'update-ref': break
        case 'repack': break
        default: assert.fail('unexpected owned Git command: ' + argv[0])
      }
    }
    return { status: 0, stdout, stderr: '' }
  }
  syncBuiltinESMExports()
  try { work({ root, repo, tree, bytes, calls, getDirectory: () => directory, getStreamFd: () => streamFd }) }
  finally {
    childProcess.spawnSync = original; syncBuiltinESMExports()
    if (previousTmpdir === undefined) delete process.env.TMPDIR
    else process.env.TMPDIR = previousTmpdir
    rmSync(root, { recursive: true, force: true })
  }
}

await test('suite export selects queried SHA256 format for a 40-character source prefix', () => fixture({ format: 'sha256' }, x => {
  const exported = createSuiteExport(x)
  try {
    assert.deepEqual(readFileSync(join(exported.directory, 'entry.bin')), x.bytes)
    assert.equal(statSync(join(exported.directory, 'entry.bin')).mode & 0o777, 0o755)
    assert.deepEqual(x.calls.filter(c => c.source).map(c => c.argv), [
      ['rev-parse', '--show-object-format'], ['rev-parse', '--path-format=absolute', '--git-path', 'objects'],
    ])
  } finally { exported.cleanup() }
}))

await test('suite export refuses unknown or malformed source formats and cleans its private allocation', () => {
  for (const formatOutput of ['sha512\n', 'sha1\nextra\n', 'sha256 \n', '']) fixture({ formatOutput }, x => {
    assert.throws(() => createSuiteExport(x), /source object format is unavailable/)
    assert.equal(x.calls.length, 1)
    assert.deepEqual(readdirSync(x.root), [])
  })
})

await test('large suite blob streams to a private fd and closes it before returning exact bytes and mode', () => fixture({ bytes: Buffer.alloc(1024 * 1024 + 17, 193) }, x => {
  const exported = createSuiteExport(x)
  try {
    assert.deepEqual(readFileSync(join(exported.directory, 'entry.bin')), x.bytes)
    assert.equal(statSync(join(exported.directory, 'entry.bin')).mode & 0o777, 0o755)
    assert.throws(() => fstatSync(x.getStreamFd()), e => e.code === 'EBADF')
    assert.equal(x.calls.some(c => c.argv[0] === 'cat-file' && c.argv[1] === '--batch'), false)
  } finally { exported.cleanup() }
}))

await test('failed or truncated streaming export closes its fd and removes only the owned export', () => {
  for (const defect of [{ failStream: true }, { sizeDelta: 1 }]) fixture({ bytes: Buffer.alloc(1024 * 1024 + 1), ...defect }, x => {
    assert.throws(() => createSuiteExport(x), /Suite Git export failed|Incomplete exported blob/)
    assert.throws(() => fstatSync(x.getStreamFd()), e => e.code === 'EBADF')
    assert.equal(existsSync(x.getDirectory()), false)
    assert.deepEqual(readdirSync(x.root), [])
  })
})

await test('small suite blob framing must identify the requested object before accepting bytes', () => fixture({ badHeader: true }, x => {
  assert.throws(() => createSuiteExport(x), /Incomplete exported blob/)
  assert.equal(existsSync(x.getDirectory()), false)
}))

await test('suite export preserves literal non-UTF8 symlink target bytes', () => fixture({ mode: '120000', bytes: Buffer.from([102, 255]) }, x => {
  const exported = createSuiteExport(x)
  try { assert.deepEqual(readlinkSync(join(exported.directory, 'entry.bin'), { encoding: 'buffer' }), x.bytes) }
  finally { exported.cleanup() }
}))
