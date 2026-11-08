// vendored-upstream.test.mjs - Cloudflare's own tests for its two validators, run unmodified from the
// vendored tree: proof the validators work on this machine and Node, before anything gates on them.
// Read in full before they were first run: they use only node: modules, write only inside their own
// mkdtemp dirs (here under a TMPDIR of ours), spawn only node and mkfifo, and make no network call.
import { join } from 'node:path'
import { mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { spawnSync } from 'node:child_process'
import assert from 'node:assert/strict'
import { test } from '../../../scripts/workflow-harness.mjs'
import { VENDOR_SKILL_DIR } from '../skills/security-audit/upstream.mjs'

const TIMEOUT_MS = 60_000  // measured at about half a second; this only stops a hang

console.log('== vendored upstream tests')
await test('upstream\'s own validate-findings and validate-coverage-ledger tests pass, none skipped', () => {
  const files = readdirSync(VENDOR_SKILL_DIR).filter(f => f.endsWith('.test.cjs')).sort().map(f => join(VENDOR_SKILL_DIR, f))
  assert.equal(files.length, 2, `expected two vendored test files, found ${files.length}`)
  const scratch = mkdtempSync(join(tmpdir(), 'vendored-tests-'))
  try {
    // NODE_TEST_CONTEXT is how a parent test runner marks its children; without it, a run under
    // `node --test` would confuse this inner one.
    const { NODE_TEST_CONTEXT, ...env } = process.env
    const started = Date.now()
    const r = spawnSync(process.execPath, ['--test', '--test-reporter=tap', ...files], { encoding: 'utf8', timeout: TIMEOUT_MS, env: { ...env, TMPDIR: scratch } })
    const ms = Date.now() - started
    assert.equal(r.error, undefined, String(r.error))
    const count = name => Number((r.stdout.match(new RegExp(`^# ${name} (\\d+)$`, 'm')) || [])[1])
    const summary = `pass ${count('pass')}, fail ${count('fail')}, skipped ${count('skipped')}`
    assert.ok(count('pass') > 0 && count('fail') === 0 && count('skipped') === 0, `${summary}\n${r.stdout.slice(-2000)}${r.stderr.slice(-500)}`)
    assert.equal(r.status, 0, r.stderr)
    console.log(`       (${summary} in ${ms} ms)`)
  } finally { rmSync(scratch, { recursive: true, force: true }) }
})
