import assert from 'node:assert/strict'
import fs from 'node:fs'
import crypto from 'node:crypto'
import { syncBuiltinESMExports } from 'node:module'
import { createRunStore } from '../../core/skills/run-records/store.mjs'
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { test } from 'node:test'

test('doctor uses the selected installation when its source checkout has no central config', async () => {
  const root = mkdtempSync(join(tmpdir(), 'doctor-alternate-root-'))
  const source = join(root, 'source')
  const pandaRoot = join(root, 'selected')
  const repo = join(root, 'project')
  const checkout = fileURLToPath(new URL('../../', import.meta.url))
  try {
    // Copy the actual entry point and its dependencies unchanged, preserving
    // module-relative paths but deliberately omitting source/agent-config.json.
    for (const file of [
      'core/skills/run-records/doctor.mjs',
      'core/skills/run-records/records.mjs',
      'core/skills/decisions/config.mjs',
      'core/skills/decisions/records.mjs',
      'graphs/autobuild/tool/lib/config.mjs',
      'graphs/autobuild/tool/lib/codex-installs.mjs',
      'scripts/agent-config.mjs',
      'scripts/configure-agents.mjs',
    ]) {
      mkdirSync(dirname(join(source, file)), { recursive: true })
      cpSync(join(checkout, file), join(source, file))
    }
    mkdirSync(repo)
    mkdirSync(join(pandaRoot, 'graphs'), { recursive: true })
    const central = {
      maxConcurrentSubagents: 3,
      claude: {
        orchestrator: { model: 'opus', effort: 'high' },
        advisor: { model: 'fable', effort: 'high' },
        subagents: { model: 'sonnet', effort: 'high' },
        agentOverrides: {},
      },
    }
    writeFileSync(join(pandaRoot, 'agent-config.json'), JSON.stringify(central))
    writeFileSync(join(pandaRoot, 'settings.json'), '{}')
    const { renderAgentConfig } = await import(pathToFileURL(join(source, 'scripts/configure-agents.mjs')).href)
    for (const [file, text] of renderAgentConfig(pandaRoot, central)) {
      writeFileSync(join(pandaRoot, file), text)
    }
    const { inspectDoctor } = await import(pathToFileURL(join(source, 'core/skills/run-records/doctor.mjs')).href)
    const report = await inspectDoctor({
      repo, pandaRoot, backend: 'codex', env: {},
      capabilityProbe: async () => ({
        version: 'fixture-1.0',
        controls: Object.fromEntries(['model', 'effort', 'concurrency'].map(key => [key, {
          status: 'supported', evidence: 'Trusted fixture proves control.',
        }])),
      }),
    })
    assert.equal(report.status, 'ready',
      'BUGHUNT-F1 doctor must inspect a valid selected installation without reading source checkout defaults')
    assert.equal(report.settings.values.maxConcurrentSubagents, central.maxConcurrentSubagents,
      'BUGHUNT-F1 doctor must retain the selected central settings')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

const run = { schemaVersion: 1, id: 'r1', repo: '/tmp/project', revision: null,
  runnerRoot: '/tmp/runner', runnerRevision: null, workflow: 'autobuild', backend: 'codex',
  parentRunId: null, startedAt: '2026-11-09T12:00:00Z', settings: {} }

await test('temporary records are removed when close releases the descriptor and reports EIO', () => {
  const root = fs.mkdtempSync(join(tmpdir(), 'run-store-close-'))
  const originalOpen = fs.openSync
  const originalClose = fs.closeSync
  const originalUUID = crypto.randomUUID
  let temporaryFd
  let injected = false
  try {
    fs.openSync = (...args) => {
      const fd = originalOpen(...args)
      if (String(args[0]).includes('/.tmp-')) temporaryFd = fd
      return fd
    }
    fs.closeSync = fd => {
      // Linux may release a descriptor even when close reports an I/O error.
      originalClose(fd)
      if (fd === temporaryFd && !injected) {
        injected = true
        throw Object.assign(new Error('injected close failure'), { code: 'EIO' })
      }
    }
    crypto.randomUUID = () => '00000000-0000-4000-8000-000000000002'
    syncBuiltinESMExports()
    const store = createRunStore(join(root, 'store'))
    assert.throws(() => store.putRun(run), { code: 'IO_ERROR' }, 'BUGHUNT-F2 close failure must surface as IO_ERROR')
    assert.equal(injected, true, 'BUGHUNT-F2 temporary-file close fault must be exercised')
    assert.deepEqual(fs.readdirSync(join(root, 'store/runs')), [],
      'BUGHUNT-F2 temporary-file removal must run even when closing its descriptor fails')
  } finally {
    fs.openSync = originalOpen
    fs.closeSync = originalClose
    crypto.randomUUID = originalUUID
    syncBuiltinESMExports()
    fs.rmSync(root, { recursive: true, force: true })
  }
})
