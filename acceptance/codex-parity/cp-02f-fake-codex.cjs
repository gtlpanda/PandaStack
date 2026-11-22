#!/usr/bin/env node
// CP-02f fake `codex` (spec/contracts/codex-parity-cp-02f.md). A fixture, frozen
// with acceptance/codex-parity/cp-02f-native-graphs.test.mjs. It is a fake: no
// network, no model, no child process. It is driven by one environment variable,
// FAKE_CODEX_DIR, and reads only the script the test wrote there. It records its whole
// environment in calls.jsonl as evidence.
//
// <FAKE_CODEX_DIR>/script.json is
//   { "roles": [{ "role": <name>, "prefix": <assembled role instructions + "\n\n"> }],
//     "replies": { <name>: <reply> | [<reply>, ...] } }
//   <reply> = { "json": <string>, "writes"?: { <relative path>: <utf8 content> } } | { "refuse": true }
// The role of a spawn is the one whose prefix starts its stdin (the longest match).
// An array reply gives one entry per spawn of that role, in order; its last repeats.
// Every spawn appends one JSON line to <FAKE_CODEX_DIR>/calls.jsonl, including the
// bytes of the --output-schema file it was handed (`schema`, or null).
// - unknown role, or no reply for it: no output, exit 3 (the provider fails the leaf);
// - { "refuse": true }: a turn.failed provider refusal, exit 1;
// - { "json": s }: writes {"json": s} to --output-last-message when handed the NR-01
//   wire schema, and s itself (the bare object) for any other schema (CP-02h); then
//   prints turn.completed, exit 0.
// - "writes" (amended additively at the tier-4 freeze for CP-05e, W2-9): before the
//   reply, each entry is written under the spawn's cwd, creating parent directories. A
//   path that is not relative, uses a backslash, or has an empty, "." or ".." segment
//   makes the fake write nothing and exit 3. A reply without "writes" is unchanged.
'use strict'
const fs = require('node:fs')
const path = require('node:path')

const dir = process.env.FAKE_CODEX_DIR
const NR01_WIRE = '{"type":"object","properties":{"json":{"type":"string"}},"required":["json"],"additionalProperties":false}'
const argv = process.argv.slice(2)
const flag = name => { const i = argv.indexOf(name); return i < 0 || i + 1 >= argv.length ? null : argv[i + 1] }
const chunks = []
process.stdin.on('data', chunk => chunks.push(chunk))
process.stdin.on('end', () => {
  const stdin = Buffer.concat(chunks).toString('utf8')
  const script = JSON.parse(fs.readFileSync(path.join(dir, 'script.json'), 'utf8'))
  let role = null, best = -1
  for (const entry of script.roles) {
    if (stdin.startsWith(entry.prefix) && entry.prefix.length > best) { role = entry.role; best = entry.prefix.length }
  }
  const callsFile = path.join(dir, 'calls.jsonl')
  const earlier = !fs.existsSync(callsFile) ? 0 : fs.readFileSync(callsFile, 'utf8').split('\n').filter(Boolean)
    .filter(line => JSON.parse(line).role === role).length
  const given = role !== null && Object.hasOwn(script.replies, role) ? script.replies[role] : null
  const reply = !Array.isArray(given) ? given : given.length ? given[Math.min(earlier, given.length - 1)] : null
  const schemaFile = flag('--output-schema')
  const schema = schemaFile !== null && fs.existsSync(schemaFile) ? fs.readFileSync(schemaFile, 'utf8') : null
  fs.appendFileSync(callsFile, JSON.stringify({
    role, argv, cwd: process.cwd(), env: { ...process.env }, pid: process.pid, stdin,
    sandbox: flag('--sandbox'), model: flag('--model'), schema,
  }) + '\n')
  if (reply === null) { process.exitCode = 3; return }
  if (reply.writes !== undefined) {
    if (reply.writes === null || typeof reply.writes !== 'object' || Array.isArray(reply.writes)) { process.exitCode = 3; return }
    const entries = Object.entries(reply.writes)
    const safe = rel => typeof rel === 'string' && rel.length > 0 && !rel.startsWith('/') && !rel.includes('\\') &&
      rel.split('/').every(part => part !== '' && part !== '.' && part !== '..')
    if (!entries.every(([rel, text]) => safe(rel) && typeof text === 'string')) { process.exitCode = 3; return }
    for (const [rel, text] of entries) {
      const target = path.join(process.cwd(), ...rel.split('/'))
      fs.mkdirSync(path.dirname(target), { recursive: true })
      fs.writeFileSync(target, text)
    }
  }
  if (reply.refuse === true) {
    process.stdout.write(JSON.stringify({ type: 'turn.failed',
      error: { message: 'This content was flagged for possible cybersecurity risk. (fake codex fixture)' } }) + '\n')
    process.exitCode = 1
    return
  }
  fs.writeFileSync(flag('--output-last-message'), schema === NR01_WIRE ? JSON.stringify({ json: reply.json }) : reply.json)
  process.stdout.write(JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1 } }) + '\n')
  process.exitCode = 0
})
