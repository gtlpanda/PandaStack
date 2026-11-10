import assert from 'node:assert/strict'
import childProcess from 'node:child_process'
import { syncBuiltinESMExports } from 'node:module'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { test } from '../scripts/workflow-harness.mjs'
import { createSuiteExport } from '../graphs/hunt/skills/bughunt/evidence.mjs'

const tree = 'a'.repeat(40)
const blob = 'b'.repeat(40)
const commit = 'c'.repeat(40)
const bytes = Buffer.from([0, 255, 13, 10, 65])

// Model only the Git process boundary. Real export directory creation, literal
// blob restoration and cleanup run in the implementation. No child is launched;
// frozen acceptance separately proves actual Git decoding and object retention.
function withGitBoundary(repo, alternate, check, { failRepack = false } = {}) {
  const original = childProcess.spawnSync
  const calls = []
  let directory
  childProcess.spawnSync = (command, args, options) => {
    assert.equal(command, 'git')
    assert.ok(options.timeout > 0)
    assert.ok(options.maxBuffer > 0)
    assert.ok(args.includes('core.hooksPath=/dev/null'))
    assert.ok(args.includes('core.fsmonitor=false'))
    let at = 2
    while (args[at] === '-c') at += 2
    const operation = args[at]
    calls.push({ operation, cwd: args[1], env: { ...options.env } })
    let stdout = ''
    if (args[1] === repo) {
      assert.deepEqual(args.slice(at), ['rev-parse', '--path-format=absolute', '--git-path', 'objects'])
      stdout = join(repo, '.git', 'objects') + '\n'
    } else {
      directory = args[1]
      if (operation !== 'init') assert.equal(options.env.GIT_ALTERNATE_OBJECT_DIRECTORIES, alternate)
      switch (operation) {
        case 'init': break
        case 'read-tree': assert.equal(args[at + 1], tree); break
        case 'ls-files': stdout = `100755 ${blob} 0\tentry.txt\0`; break
        case 'checkout-index': break
        case 'cat-file':
          assert.deepEqual(options.input, Buffer.from(blob + '\n'))
          stdout = Buffer.concat([Buffer.from(`${blob} blob ${bytes.length}\n`), bytes, Buffer.from('\n')])
          break
        case 'rev-parse': assert.equal(args[at + 1], tree + '^{tree}'); stdout = tree + '\n'; break
        case 'commit-tree': assert.equal(args[at + 1], tree); stdout = commit + '\n'; break
        case 'update-ref': assert.deepEqual(args.slice(at), ['update-ref', 'HEAD', commit]); break
        case 'repack':
          assert.deepEqual(args.slice(at), ['repack', '-a', '-d'])
          if (failRepack) return { status: 1, stdout: '', stderr: 'synthetic transfer failure' }
          break
        default: assert.fail(`Unexpected Git operation: ${operation}`)
      }
    }
    return { status: 0, stdout, stderr: '' }
  }
  syncBuiltinESMExports()
  try { check(calls, () => directory) }
  finally {
    childProcess.spawnSync = original
    syncBuiltinESMExports()
  }
}

const paths = [
  ['ordinary', '/source/project', '"/source/project/.git/objects"'],
  ['spaces and quotes', '/source/project space "quoted"', '"/source/project space \\042quoted\\042/.git/objects"'],
  ['colon', '/source/project:one', '"/source/project:one/.git/objects"'],
  ['colon with spaces and quotes', '/source/project:space "quoted"', '"/source/project:space \\042quoted\\042/.git/objects"'],
  ['literal backslash', '/source/project:back\\slash', '"/source/project:back\\134slash/.git/objects"'],
  ['control characters and Unicode', '/source/雪:\t\n\u001b', '"/source/雪:\\011\\012\\033/.git/objects"'],
]

for (const [label, repo, alternate] of paths) {
  await test(`suite export passes one literal alternate: ${label}`, () => {
    withGitBoundary(repo, alternate, calls => {
      const exported = createSuiteExport({ repo, tree })
      try {
        assert.notEqual(exported.directory, repo)
        assert.equal(statSync(exported.directory).mode & 0o777, 0o700)
        assert.deepEqual(readFileSync(join(exported.directory, 'entry.txt')), bytes)
        assert.equal(statSync(join(exported.directory, 'entry.txt')).mode & 0o777, 0o755)
        assert.equal(existsSync(join(exported.directory, '.git', 'objects', 'info', 'alternates')), false)
        assert.deepEqual(calls.filter(call => call.cwd === repo).map(call => call.operation), ['rev-parse'])
        assert.equal(calls.at(-1).operation, 'repack')
      } finally {
        exported.cleanup()
        exported.cleanup()
      }
      assert.equal(existsSync(exported.directory), false)
    })
  })
}

await test('suite export refuses failed object transfer and removes its owned directory', () => {
  withGitBoundary('/source/project:one', '"/source/project:one/.git/objects"', (calls, directory) => {
    assert.throws(() => createSuiteExport({ repo: '/source/project:one', tree }), /Suite Git export failed/)
    assert.equal(calls.at(-1).operation, 'repack')
    assert.equal(existsSync(directory()), false)
  }, { failRepack: true })
})
