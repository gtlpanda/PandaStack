// upstream.mjs - the one place that knows where the vendored Cloudflare skill lives and how to
// run its two validators. Nothing else reaches into vendor/ on its own.
//
// Two ways in, both reading the vendored files exactly as they are:
//   - run a validator the way a person would (node <file>) and gate on what it printed and its
//     exit code: validateFindingsFile(path), validateLedgerFile(path) -> { lastLine, exitCode, valid }
//   - call the functions the validators export: canonicalCoverageId, isSafeAgentId,
//     validateFindingsDocument, validateLedgerDocument
// Vendored code loads on first use, never at import, so the drift check (vendor/check-vendor.mjs)
// can still name a missing validator instead of failing to start.
import { createRequire } from 'node:module'
import { existsSync, realpathSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

// install.sh links this directory into ~/.claude, so find the repo from the real file, not the link.
const HERE = dirname(realpathSync(fileURLToPath(import.meta.url)))
export const VENDOR_DIR = join(HERE, '..', '..', 'vendor', 'cloudflare-security-audit')
export const VENDOR_SKILL_DIR = join(VENDOR_DIR, 'skills', 'security-audit')

const require = createRequire(import.meta.url)
const vendored = name => require(join(VENDOR_SKILL_DIR, name))

export const canonicalCoverageId = refs => vendored('validate-coverage-ledger.cjs').canonicalCoverageId(refs)
export const isSafeAgentId = value => vendored('validate-coverage-ledger.cjs').isSafeAgentId(value)
// Each validator exports a validateDocument, with different signatures: (ledger) and (findings,
// schema). They get distinct names here, and the findings one reads the co-located schema itself.
export const validateLedgerDocument = ledger => vendored('validate-coverage-ledger.cjs').validateDocument(ledger)
export const validateFindingsDocument = findings => vendored('validate-findings.cjs').validateDocument(findings, vendored('report-schema.json'))

const VALIDATOR_TIMEOUT_MS = 30_000

// The last non-empty line of a validator's output. Only a pass writes to stdout (PASS: N ... valid).
// A validation failure writes ERROR lines and then FAIL: N validation error(s) to stderr; a read or
// parse failure writes one message to stderr and no FAIL line. Callers pass stdout then stderr, so
// the verdict is the last line either way.
export function lastLine(text) {
  const lines = text.split('\n').map(l => l.trimEnd()).filter(Boolean)
  return lines.length ? lines[lines.length - 1] : ''
}

// A run is valid only on exit 0 and a last stdout line that is the validator's PASS line. Anything
// else (a message on stderr, a clean exit with other output) is not a pass.
export function passed(exitCode, stdout) {
  return exitCode === 0 && /^PASS: \d+ (findings|coverage units) valid$/.test(lastLine(stdout))
}

// Run one vendored validator on one file: { lastLine, exitCode, valid }. A run that gave no verdict
// (the validator is missing, timed out, or was killed) throws, so no caller can mistake it for a fail.
export function runValidator(script, file, { timeoutMs = VALIDATOR_TIMEOUT_MS } = {}) {
  if (typeof file !== 'string' || file === '') throw new TypeError(`${script}: a file path is required`)
  const path = join(VENDOR_SKILL_DIR, script)
  if (!existsSync(path)) throw new Error(`${script}: vendored validator is missing (${path}); run vendor/check-vendor.mjs`)
  const r = spawnSync(process.execPath, [path, file], { encoding: 'utf8', timeout: timeoutMs })
  if (r.error) throw new Error(`${script}: ${r.error.code === 'ETIMEDOUT' ? `no answer in ${timeoutMs} ms` : r.error.message}`)
  if (r.status === null) throw new Error(`${script}: ended by signal ${r.signal}`)
  return { lastLine: lastLine(r.stdout + r.stderr), exitCode: r.status, valid: passed(r.status, r.stdout) }
}

export const validateFindingsFile = (file, options) => runValidator('validate-findings.cjs', file, options)
export const validateLedgerFile = (file, options) => runValidator('validate-coverage-ledger.cjs', file, options)
