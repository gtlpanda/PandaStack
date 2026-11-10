import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'
const ROOT=process.env.PANDASTACK_CANDIDATE_ROOT||fileURLToPath(new URL('../../',import.meta.url));
const {createSuiteExport,sandboxEnv}=await import(pathToFileURL(join(ROOT,'graphs/hunt/skills/bughunt/evidence.mjs')).href);

for (const format of ['sha1', 'sha256']) {
  await test(`suite export uses ${format} source format for full and abbreviated identifiers`, () => {
    const root = mkdtempSync(join(tmpdir(), 'suite-source-format-'))
    const previousTmpdir = process.env.TMPDIR
    let exported
    try {
      process.env.TMPDIR = root
      const env = {
        ...sandboxEnv(), GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
      }
      const git = (cwd, ...args) => {
        const result = spawnSync('git', [
          '-C', cwd, '-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', ...args,
        ], { env, encoding: 'utf8', timeout: 5000, maxBuffer: 1024 * 1024 })
        assert.equal(result.status, 0, result.stderr)
        return result.stdout.trim()
      }
      const repo = join(root, 'source')
      mkdirSync(repo)
      git(repo, 'init', '-q', '--template=', `--object-format=${format}`)
      const bytes = Buffer.from([0, 255, 13, 10, 65])
      writeFileSync(join(repo, 'entry.bin'), bytes)
      git(repo, 'add', 'entry.bin')
      const tree = git(repo, 'write-tree')
      const before = git(repo, 'status', '--porcelain')
      // SHA-256 prefixes overlap SHA-1's full identifier length, so length
      // cannot identify the repository's storage format.
      const identifiers = format === 'sha256'
        ? [tree, tree.slice(0, 40), tree.slice(0, 48), tree.slice(0, 63)] : [tree]
      for (const identifier of identifiers) {
        exported = createSuiteExport({ repo, tree: identifier })
        try {
          assert.equal(git(exported.directory, 'rev-parse', '--show-object-format'), format)
          assert.equal(git(exported.directory, 'rev-parse', 'HEAD^{tree}'), tree)
          assert.deepEqual(readFileSync(join(exported.directory, 'entry.bin')), bytes)
        } finally {
          exported.cleanup()
        }
      }
      assert.equal(git(repo, 'status', '--porcelain'), before)
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
}


