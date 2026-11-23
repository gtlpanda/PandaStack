#!/usr/bin/env node
// A stub for graphs/qa/tool/qa-loop.mjs, for the Codex driver tests (wiring proof, not runtime
// certification: the real CLI has its own tests). It records its argv and its args file in
// $FAKE_QA_LOG, then acts out $FAKE_QA_STEP, a JSON object:
//   { status: 'done'|'escalate', reason, writes: {path: text} }   writes files in the repo, prints the report line
//   { exit: <n>, error: 'CODE' }                                  prints {"error": CODE} on stderr and exits
import { appendFileSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

const argv = process.argv.slice(2)
const argsFile = argv[argv.indexOf('--args-file') + 1]
const args = JSON.parse(readFileSync(argsFile, 'utf8'))
appendFileSync(process.env.FAKE_QA_LOG, `${JSON.stringify({ argv, args, cwd: process.cwd(), mode: statSync(argsFile).mode & 0o777 })}\n`)
const step = JSON.parse(process.env.FAKE_QA_STEP || '{}')
if (step.exit) {
  console.error(JSON.stringify({ error: step.error || 'HOST_FAILED' }))
  process.exit(step.exit)
}
const writes = step.writes || {}
for (const [path, text] of Object.entries(writes)) {
  mkdirSync(dirname(join(args.repo, path)), { recursive: true })
  writeFileSync(join(args.repo, path), text)
}
console.log(JSON.stringify({
  status: step.status || 'done', graphStatus: step.status || 'done', invocationId: 'qa-20260101T000000Z-0badc0de', resumed: false, recorded: true,
  reason: step.reason || 'VERIFY: PASS and no HIGH/CRITICAL findings', stuckSig: null, fixRounds: 0, touched: Object.keys(writes).sort(), checks: null, ledgerWarning: null,
}))
