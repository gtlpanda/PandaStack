import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'
const ROOT=process.env.PANDASTACK_CANDIDATE_ROOT||fileURLToPath(new URL('../../',import.meta.url));
const {createSuiteExport,sandboxEnv}=await import(pathToFileURL(join(ROOT,'graphs/hunt/skills/bughunt/evidence.mjs')).href);

await test('suite export preserves a SHA-256 source under the normal SHA-1 default', () => {
  const root = mkdtempSync(join(tmpdir(), 'suite-object-format-'))
  const previousTmpdir = process.env.TMPDIR
  let exported
  try {
    // The implementation allocates its private export under tmpdir() too.
    process.env.TMPDIR = root
    const env = {
      ...sandboxEnv(),
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_DEFAULT_HASH: 'sha1',
    }
    const git = (cwd, ...args) => {
      const result = spawnSync('git', [
        '-C', cwd, '-c', 'core.hooksPath=/dev/null',
        '-c', 'core.fsmonitor=false', ...args,
      ], { env, encoding: 'utf8', timeout: 5000 })
      assert.equal(result.status, 0, `fixture git ${args.join(' ')}: ${result.stderr}`)
      return result.stdout.trim()
    }
    const repo = join(root, 'source')
    mkdirSync(repo)
    git(repo, 'init', '-q', '--template=', '--object-format=sha256')
    assert.equal(git(repo, 'rev-parse', '--show-object-format'), 'sha256')
    const bytes = Buffer.from('selected SHA-256 tree\n')
    writeFileSync(join(repo, 'entry.txt'), bytes)
    git(repo, 'add', 'entry.txt')
    const tree = git(repo, 'write-tree')
    assert.equal(tree.length, 64)

    assert.doesNotThrow(() => {
      exported = createSuiteExport({ repo, tree })
    }, 'BUGHUNT-F2 exporting a SHA-256 tree must preserve its object format instead of failing with Suite Git export failed')
    assert.equal(git(exported.directory, 'rev-parse', '--show-object-format'), 'sha256',
      'BUGHUNT-F2 private suite repository must use the source object format')
    assert.equal(git(exported.directory, 'rev-parse', 'HEAD^{tree}'), tree,
      'BUGHUNT-F2 suite snapshot must contain the selected source tree')
    assert.deepEqual(readFileSync(join(exported.directory, 'entry.txt')), bytes,
      'BUGHUNT-F2 selected tree contents must be available to the suite')
  } finally {
    try {
      exported?.cleanup()
    } finally {
      if (previousTmpdir === undefined) delete process.env.TMPDIR
      else process.env.TMPDIR = previousTmpdir
      rmSync(root, { recursive: true, force: true })
    }
  }
})


