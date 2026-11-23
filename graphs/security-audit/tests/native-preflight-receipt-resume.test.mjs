// A prepare() that fails leaves a receipt that says so: on resume, a codex that can no longer be verified must not leave the earlier run's
// passing native-codex/preflight.json standing as the record of the latest attempt.
import assert from 'node:assert/strict'
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test, NO_LINUX_STORES } from '../../../scripts/workflow-harness.mjs'
import { sandbox } from './audit-fixtures.mjs'
import { newInit } from './stage-fixtures.mjs'
import { createNativeCodexHost, NATIVE_DIR } from '../skills/security-audit/native-codex.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const FAKE = join(HERE, '..', '..', '..', 'tests', 'fixtures', 'fake-source-only-codex.mjs')
const ANSWERS = join(HERE, 'native-e2e-answers.mjs')
const work = mkdtempSync(join(sandbox, 'native-receipt-'))
const authFile = join(work, 'auth.json'); writeFileSync(authFile, 'not-a-real-login-file', { mode: 0o600 })
const readJson = f => JSON.parse(readFileSync(f, 'utf8'))

function script(name, body) {
  const bin = join(work, name)
  writeFileSync(bin, `#!/bin/sh\n${body}\n`)
  chmodSync(bin, 0o755)
  return bin
}

await test('a resume whose prepare fails does not leave the earlier passing preflight receipt as the latest record', { skip: NO_LINUX_STORES }, async () => {
  const { runDir } = newInit()
  const good = script('codex-ok', `FAKE_CODEX_ANSWER='${ANSWERS}' exec ${process.execPath} ${FAKE} "$@"`)
  const receiptFile = join(runDir, NATIVE_DIR, 'preflight.json')

  // First attempt: preflight passes and writes a passing receipt.
  const first = createNativeCodexHost({ runDir, codexBin: good, authFile })
  try { await first.prepare() } finally { first.close() }
  const earlier = readJson(receiptFile)
  assert.equal(earlier.receipts.every(r => r.ok), true, 'setup: the first preflight passed')
  assert.equal(earlier.error, undefined)

  // Resume with a codex whose version cannot be read: prepare() refuses.
  const broken = script('codex-broken', 'echo not-a-version')
  const second = createNativeCodexHost({ runDir, codexBin: broken, authFile })
  try {
    await assert.rejects(() => second.prepare(), { code: 'SOURCE_ONLY_VERSION_UNKNOWN' })
  } finally { second.close() }

  const latest = readJson(receiptFile)
  assert.ok(latest.error !== undefined,
    `BUGHUNT-F2 the refused resume left the stale passing receipt on disk: ${JSON.stringify({ codexVersion: latest.codexVersion, versionPinned: latest.versionPinned, error: latest.error })}`)
})

await test('every attempt is kept: the history holds the passing attempt, then the refused one, in order, and a later pass records no error', { skip: NO_LINUX_STORES }, async () => {
  const { runDir } = newInit()
  const good = script('codex-ok-2', `FAKE_CODEX_ANSWER='${ANSWERS}' exec ${process.execPath} ${FAKE} "$@"`)
  const broken = script('codex-broken-2', 'echo not-a-version')
  const attempt = async bin => { const h = createNativeCodexHost({ runDir, codexBin: bin, authFile }); try { await h.prepare() } catch { /* recorded */ } finally { h.close() } }
  await attempt(good); await attempt(broken); await attempt(good)
  const history = readFileSync(join(runDir, NATIVE_DIR, 'preflight-history.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l))
  assert.deepEqual(history.map(h => h.error), [undefined, 'SOURCE_ONLY_VERSION_UNKNOWN', undefined])
  assert.equal(history[0].receipts[0].ok, true)
  assert.equal(readJson(join(runDir, NATIVE_DIR, 'preflight.json')).error, undefined)
  // A refused model check is recorded too, with its receipts.
  const none = script('codex-nomodel', `FAKE_CODEX_MODELS=other FAKE_CODEX_ANSWER='${ANSWERS}' exec ${process.execPath} ${FAKE} "$@"`)
  await attempt(none)
  const latest = readJson(join(runDir, NATIVE_DIR, 'preflight.json'))
  assert.equal(latest.error, 'SOURCE_ONLY_UNVERIFIED')
  assert.equal(latest.receipts[0].ok, false)
})
