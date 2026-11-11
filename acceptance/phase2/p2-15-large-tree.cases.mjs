import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'
const ROOT=process.env.PANDASTACK_CANDIDATE_ROOT||fileURLToPath(new URL('../../',import.meta.url));
const {createSuiteExport}=await import(pathToFileURL(join(ROOT,'graphs/hunt/skills/bughunt/evidence.mjs')).href);

await test('suite export restores exact bytes when tracked contents exceed 128 MiB', () => {
  const root = mkdtempSync(join(tmpdir(), 'suite-export-large-tree-'))
  const savedTmpdir = process.env.TMPDIR
  let exported
  try {
    // Keep both the fixture and the implementation's temporary export under
    // this test's private directory. No verifier or capture runner is invoked.
    process.env.TMPDIR = root
    const repo = join(root, 'source')
    const home = join(root, 'home')
    mkdirSync(repo)
    mkdirSync(home)
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')))
    Object.assign(env, {
      HOME: home, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
      GIT_AUTHOR_NAME: 'test', GIT_AUTHOR_EMAIL: 'test@localhost',
      GIT_COMMITTER_NAME: 'test', GIT_COMMITTER_EMAIL: 'test@localhost',
      GIT_AUTHOR_DATE: '2000-01-01T00:00:00Z', GIT_COMMITTER_DATE: '2000-01-01T00:00:00Z',
    })
    const git = (...args) => {
      const result = spawnSync('git', [
        '-C', repo, '-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false',
        '-c', 'core.autocrlf=false', '-c', 'commit.gpgsign=false', ...args,
      ], { env, encoding: 'utf8', timeout: 30000 })
      assert.equal(result.status, 0, `fixture git ${args.join(' ')}: ${result.stderr || result.error || ''}`)
      return result.stdout.trim()
    }
    git('init', '-q', '--template=')

    // Each blob is comfortably below the limit; only the combined 136 MiB
    // exceeds it. Distinct contents ensure these are seventeen distinct blobs.
    const bytes = Buffer.alloc(8 * 1024 * 1024)
    const content = index => {
      bytes.fill(index)
      bytes.set([0, 255, 13, 10, index])
      return bytes
    }
    const names = Array.from({ length: 17 }, (_, index) => `blob-${String(index).padStart(2, '0')}.bin`)
    for (const [index, name] of names.entries()) writeFileSync(join(repo, name), content(index))
    git('add', '--', ...names)
    const tree = git('write-tree')

    assert.doesNotThrow(() => {
      exported = createSuiteExport({ repo, tree })
    }, 'BUGHUNT-F1 suite export must support trees larger than the 128 MiB subprocess output buffer')
    for (const [index, name] of names.entries()) {
      assert.ok(readFileSync(join(exported.directory, name)).equals(content(index)),
        `BUGHUNT-F1 suite export must preserve every byte of ${name}`)
    }
  } finally {
    try {
      exported?.cleanup()
    } finally {
      if (savedTmpdir === undefined) delete process.env.TMPDIR
      else process.env.TMPDIR = savedTmpdir
      rmSync(root, { recursive: true, force: true })
    }
  }
})


