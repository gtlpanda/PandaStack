// driver-codex-bare-bin.test.mjs: /build-app --backend codex with no HARNESS_BUILD_CODEX_BIN / AUTOBUILD_CODEX_BIN,
// `codex` found on PATH. The final QA runs the REAL qa-loop.mjs, which requires an absolute codexBin in its args
// file. Uses node:test directly so a failure sets the exit code. No network, no real codex, no claude.
import { execFileSync, spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import assert from 'node:assert/strict'
import { test } from 'node:test'

const here = dirname(fileURLToPath(import.meta.url))
const DRIVER = join(here, '..', 'skills', 'build-app', 'driver', 'driver.mjs')
const FAKE_CODEX = join(here, '..', '..', '..', 'acceptance', 'codex-parity', 'cp-02f-fake-codex.cjs')
const APP = 'toy'
const INT = `integration/${APP}`
const VERIFY = 'if [ -e FAILVERIFY ]; then echo "VERIFY: FAIL"; else echo "VERIFY: PASS"; fi'

const slice = { id: 'S1', title: 'slice 1', goal: 'build 1', requirements: ['R1'], depends_on: [],
  acceptance: [{ id: 'S1-AC1', criterion: 'S1 works', fails_when: 'S1 breaks' }] }
const BACKLOG = { version: 1, app: APP, integrationBranch: INT, requirements: ['R1'], slices: [slice] }

function repo() {
  const root = mkdtempSync(join(tmpdir(), 'build-bare-'))
  const git = (...a) => execFileSync('git', a, { cwd: root, stdio: 'pipe' })
  git('init', '-q', '-b', 'main')
  git('config', 'user.email', 'test@example.com')
  git('config', 'user.name', 'Test')
  writeFileSync(join(root, 'README.md'), 'toy\n')
  git('add', '-A')
  git('commit', '-q', '-m', 'init')
  git('switch', '-q', '-c', INT)
  mkdirSync(join(root, 'docs'))
  writeFileSync(join(root, 'docs', 'backlog.json'), JSON.stringify(BACKLOG, null, 2))
  git('add', '-A')
  git('commit', '-q', '-m', 'blueprint: design and backlog for toy')
  return root
}

test('a default Codex build (codex on PATH, no *_CODEX_BIN) hands the QA loop an absolute codexBin, so the final QA is not refused as INVALID_LOOP_INPUT', () => {
  const dir = mkdtempSync(join(tmpdir(), 'build-bare-box-'))
  const bin = join(dir, 'bin')
  const fake = join(dir, 'fake-codex')
  const home = join(dir, 'home')
  for (const d of [bin, fake, home]) mkdirSync(d)
  writeFileSync(join(bin, 'codex'), `#!/bin/sh\nFAKE_CODEX_DIR="${fake}" exec "${process.execPath}" "${FAKE_CODEX}" "$@"\n`)
  writeFileSync(join(bin, 'claude'), '#!/bin/sh\nexit 97\n')
  chmodSync(join(bin, 'codex'), 0o755)
  chmodSync(join(bin, 'claude'), 0o755)
  const good = { json: JSON.stringify({ status: 'done', reason: 'done', questions: [] }),
    writes: { 'src/S1.js': 'export const S1 = 1\n', 'tests/S1.test.js': 'test S1\n' } }
  writeFileSync(join(fake, 'script.json'), JSON.stringify({
    roles: [{ role: 'S1', prefix: 'UNATTENDED BUILD (PandaStack /build-app, Codex). Slice S1:' }, { role: 'probe', prefix: 'Reply OK.' }],
    replies: { S1: good },
  }))

  const root = repo()
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, HOME: home, HARNESS_BUILD_VERIFY: VERIFY,
    HARNESS_BUILD_MAX_SLEEP_MS: '50', PANDASTACK_NOTIFY: '', HARNESS_BUILD_BUGHUNT: '0' }
  for (const k of ['HARNESS_BUILD_CODEX_BIN', 'AUTOBUILD_CODEX_BIN', 'HARNESS_BUILD_QA_LOOP', 'HARNESS_BUILD_HUNT_CLI']) delete env[k]
  const r = spawnSync(process.execPath, [DRIVER, 'run', '--repo', root, '--app', APP, '--no-pr', '--backend', 'codex'],
    { encoding: 'utf8', env, timeout: 120_000 })
  const stateDir = join(root, '.git', 'harness-build', APP)
  const message = JSON.parse(readFileSync(join(stateDir, 'status.json'), 'utf8')).message
  const ledger = JSON.parse(readFileSync(join(stateDir, 'ledger.json'), 'utf8'))

  assert.equal(ledger.slices.S1.status, 'done', `the slice landed first: ${r.stdout}${r.stderr}`)
  assert.ok(existsSync(join(stateDir, 'final-qa-args.json')), 'the driver reached the final QA')
  const args = JSON.parse(readFileSync(join(stateDir, 'final-qa-args.json'), 'utf8'))
  assert.ok(args.codexBin.startsWith('/'),
    `the final-QA args file carries codexBin ${JSON.stringify(args.codexBin)}, not an absolute path; qa-loop refuses it. Driver said: ${message}`)
  assert.doesNotMatch(message, /INVALID_LOOP_INPUT/, 'the real QA loop refused the driver\'s args file')
})
