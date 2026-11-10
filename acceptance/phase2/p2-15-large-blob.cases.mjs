import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmodSync, closeSync, createReadStream, ftruncateSync, mkdirSync, mkdtempSync, openSync, rmSync, statSync, writeSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'
const ROOT=process.env.PANDASTACK_CANDIDATE_ROOT||fileURLToPath(new URL('../../',import.meta.url));
const {createSuiteExport}=await import(pathToFileURL(join(ROOT,'graphs/hunt/skills/bughunt/evidence.mjs')).href);

async function digest(path) {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path)) hash.update(chunk)
  return hash.digest('hex')
}

await test('suite export streams a single blob larger than the subprocess buffer', async () => {
  const root = mkdtempSync(join(tmpdir(), 'suite-export-large-blob-'))
  const savedTmpdir = process.env.TMPDIR
  let exported
  try {
    process.env.TMPDIR = root
    const repo = join(root, 'source'), home = join(root, 'home')
    mkdirSync(repo)
    mkdirSync(home)
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')))
    Object.assign(env, { HOME: home, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' })
    const git = (...args) => {
      const result = spawnSync('git', ['-C', repo, '-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', '-c', 'core.autocrlf=false', ...args], { env, encoding: 'utf8', timeout: 30000 })
      assert.equal(result.status, 0, `fixture git ${args.join(' ')}: ${result.stderr || result.error || ''}`)
      return result.stdout.trim()
    }
    git('init', '-q', '--template=')
    const path = join(repo, 'large.bin'), size = 129 * 1024 * 1024
    const fd = openSync(path, 'wx', 0o600)
    try {
      ftruncateSync(fd, size)
      const bytes = Buffer.from([0, 255, 13, 10, 65])
      writeSync(fd, bytes, 0, bytes.length, 0)
      writeSync(fd, bytes, 0, bytes.length, size - bytes.length)
    } finally { closeSync(fd) }
    chmodSync(path, 0o755)
    git('add', '--', 'large.bin')
    exported = createSuiteExport({ repo, tree: git('write-tree') })
    const restored = join(exported.directory, 'large.bin')
    assert.equal(statSync(restored).size, size)
    assert.equal(statSync(restored).mode & 0o777, 0o755)
    assert.equal(await digest(restored), await digest(path))
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


