import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync, accessSync, statSync, constants } from 'node:fs'
import { tmpdir, homedir } from 'node:os'
import { join, relative } from 'node:path'
import { test } from '../scripts/workflow-harness.mjs'
import { ROOT } from '../scripts/configure-agents.mjs'
import { loadConfig } from '../graphs/autobuild/tool/lib/config.mjs'
import { buildEnv } from '../graphs/autobuild/tool/lib/proc.mjs'
import { inspectDoctor } from '../core/skills/run-records/doctor.mjs'

async function fixture(backend, work, repoName = 'repo') {
  const root = mkdtempSync(join(tmpdir(), 'doctor search '))
  const repo = join(root, repoName), outside = join(root, 'outside'), bins = join(root, 'bins')
  const cwd = process.cwd(), inherited = process.env.PATH
  for (const dir of [repo, outside, bins, join(repo, 'local'), join(root, 'external/child'), join(root, 'external/bin'), join(repo, 'bin')]) {
    mkdirSync(dir, { recursive: true })
  }
  symlinkSync(join(root, 'external/child'), join(repo, 'link'))
  const binary = (directory, name, mode = 0o700) => writeFileSync(join(directory, name), 'inert executable fixture', { mode })
  async function inspect({ prefixes = [], path = '', override, bin, expected }) {
    const project = { backend, [`${backend}Bin`]: bin, env: { pathPrepend: prefixes, vars: {} } }
    if (override !== undefined) project.env.vars.PATH = override
    writeFileSync(join(repo, 'autobuild.json'), JSON.stringify(project))
    process.env.PATH = path
    process.chdir(repo)
    const config = loadConfig(repo, { PATH: path })
    const managedPath = buildEnv(config).PATH
    // Pass the raw search path to the filesystem from the managed cwd. Neither
    // the launcher nor this oracle lexically collapses symlink/parent traversal.
    const candidates = bin.includes('/') ? [bin] : managedPath.split(':').map(dir => `${dir || '.'}/${bin}`)
    const found = candidates.some(file => {
      try { accessSync(file, constants.X_OK); return statSync(file).isFile() } catch { return false }
    })
    assert.equal(found, expected, 'fixture establishes managed presence')
    for (const inspector of [repo, outside]) {
      process.chdir(inspector)
      const env = { PATH: path }, before = structuredClone(env)
      const result = await inspectDoctor({ repo, backend, pandaRoot: ROOT, env })
      assert.equal(result.checks.find(c => c.id === 'configuration').status, 'pass')
      assert.equal(result.checks.find(c => c.id === 'binary').status, expected ? 'pass' : 'fail', JSON.stringify({ project, inspector }))
      assert.equal(result.status, expected ? 'degraded' : 'blocked')
      assert.equal(result.runtime.version, null)
      assert.ok(Object.values(result.runtime.controls).every(c => c.status === 'unknown'))
      assert.deepEqual(env, before)
      assert.equal(process.cwd(), inspector)
    }
  }
  try { await work({ root, repo, bins, binary, inspect }) }
  finally {
    process.chdir(cwd)
    if (inherited === undefined) delete process.env.PATH
    else process.env.PATH = inherited
    rmSync(root, { recursive: true, force: true })
  }
}

for (const backend of ['claude', 'codex']) {
  for (const repoName of ['repo:part', 'repo with spaces']) {
    await test(`${backend} doctor preserves PATH serialization in ${repoName}`, () => fixture(backend, async ({ repo, bins, binary, inspect }) => {
      binary(join(repo, 'local'), 'local-provider')
      binary(repo, 'root-provider')
      for (const prefixes of [['local'], ['./local'], ['', 'missing', 'local']]) {
        await inspect({ prefixes, bin: 'local-provider', expected: true })
      }
      await inspect({ prefixes: ['.'], bin: 'root-provider', expected: true })
      await inspect({ prefixes: ['', 'missing'], bin: 'root-provider', expected: false })
      await inspect({ path: 'local', bin: 'local-provider', expected: true })
      await inspect({ override: 'local', bin: 'local-provider', expected: true })
      await inspect({ prefixes: ['local'], override: 'missing', bin: 'local-provider', expected: false })
      await inspect({ override: '', bin: 'root-provider', expected: true })
      await inspect({ path: ':missing:', bin: 'root-provider', expected: false })

      // Colons in actual PATH strings split entries; colons in an explicit
      // executable pathname remain ordinary pathname bytes.
      const absolute = join(repo, 'local'), expected = !repoName.includes(':')
      await inspect({ prefixes: [absolute], bin: 'local-provider', expected })
      await inspect({ path: absolute, bin: 'local-provider', expected })
      await inspect({ override: absolute, bin: 'local-provider', expected })
      for (const dir of ['left', 'left:right', 'with spaces']) mkdirSync(join(repo, dir))
      binary(join(repo, 'left'), 'split-provider')
      binary(join(repo, 'left:right'), 'literal-provider')
      binary(join(repo, 'with spaces'), 'space-provider')
      await inspect({ prefixes: ['left:right'], bin: 'split-provider', expected: true })
      await inspect({ prefixes: ['left:right'], bin: 'literal-provider', expected: false })
      await inspect({ prefixes: ['left:missing'], bin: 'split-provider', expected: false })
      await inspect({ prefixes: ['with spaces'], bin: 'space-provider', expected: true })
      for (const bin of ['local/local-provider', `${absolute}/local-provider`, 'left:right/literal-provider', `${repo}/left:right/literal-provider`]) {
        await inspect({ override: 'missing', bin, expected: true })
      }
      binary(bins, 'external-provider')
      await inspect({ prefixes: [bins], bin: 'external-provider', expected: true })
    }, repoName))
  }

  await test(`${backend} doctor preserves empty prefix and inherited/explicit PATH distinctions`, () => fixture(backend, async ({ repo, binary, inspect }) => {
    const bin = 'root-only-provider'
    binary(repo, bin)
    for (const prefixes of [[], [''], ['', 'missing'], ['missing/..']]) {
      await inspect({ prefixes, path: ':missing::', bin, expected: false })
    }
    await inspect({ prefixes: ['.'], bin, expected: true })
    await inspect({ prefixes: ['.'], override: 'missing', bin, expected: false })
    await inspect({ override: '', bin, expected: true })
    await inspect({ override: 'missing::', bin, expected: true })
  }))

  await test(`${backend} doctor uses expanded prefixes and executable regular files`, () => fixture(backend, async ({ repo, bins, binary, inspect }) => {
    const bin = 'prefix-provider'
    binary(bins, bin)
    for (const prefix of [bins, `~/${relative(homedir(), bins)}`, `$HOME/${relative(homedir(), bins)}`, '${HOME}/' + relative(homedir(), bins)]) {
      await inspect({ prefixes: [prefix], bin, expected: true })
    }
    await inspect({ path: bins, bin, expected: true })
    await inspect({ prefixes: [bins], path: bins, override: 'missing', bin, expected: false })
    binary(join(repo, 'local'), bin, 0o600)
    mkdirSync(join(repo, 'local/directory-provider'))
    writeFileSync(join(repo, 'prefix-file'), 'not a directory')
    await inspect({ prefixes: ['local'], bin, expected: false })
    await inspect({ prefixes: ['local'], bin: 'directory-provider', expected: false })
    await inspect({ prefixes: ['prefix-file'], bin, expected: false })
    await inspect({ prefixes: ['local', bins], bin, expected: true })
  }))

  await test(`${backend} doctor preserves kernel symlink/parent traversal in every search source`, () => fixture(backend, async ({ root, repo, binary, inspect }) => {
    binary(join(root, 'external/bin'), 'physical-provider')
    binary(join(repo, 'bin'), 'lexical-provider')
    for (const dir of ['link/../bin', `${repo}/link/../bin`]) {
      for (const [bin, expected] of [['physical-provider', true], ['lexical-provider', false]]) {
        await inspect({ prefixes: [dir], bin, expected })
        await inspect({ path: dir, bin, expected })
        await inspect({ override: dir, bin, expected })
        await inspect({ override: 'missing', bin: `${dir}/${bin}`, expected })
      }
    }
  }))
}
