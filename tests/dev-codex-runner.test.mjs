// cp-06-dev-codex (proofRef) implementation edges: the `## Codex runner` section of
// graphs/dev/skills/dev/SKILL.md is all a Codex session reads, so these cases hold it to the
// CLI it describes. Wiring proof, not runtime certification: no codex, claude or network.
// - the Claude path is byte-identical: SKILL.md without the section hashes to the entry hash
//   the catalog pinned before CP-06;
// - the section sits before `## When to ask`, names the modes, the command and the roots,
//   and holds no Claude-only string;
// - each mode row lists exactly the keys dev-native.mjs accepts: all pass the key checks (a
//   non-repo then refuses with NOT_A_REPO), an unlisted key is INVALID_ARGS, each required
//   key is needed;
// - the roots block resolves through two symlinks with spaces, prints nothing, and leaves
//   CODEX empty without codex on PATH.
// The CLI reaches version control only through `rev-parse` in an owned non-repo directory.
// Owned temp directories only.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { test } from '../scripts/workflow-harness.mjs'

const ROOT = realpathSync(resolve(import.meta.dirname, '..'))
const SKILL_DIR = join(ROOT, 'graphs/dev/skills/dev')
const SKILL_MD = join(SKILL_DIR, 'SKILL.md')
const WORK = realpathSync(mkdtempSync(join(tmpdir(), 'dev codex runner ')))
process.on('exit', () => rmSync(WORK, { recursive: true, force: true }))
let dirNo = 0
const ownedDir = prefix => { const dir = join(WORK, `${prefix} ${++dirNo}`); mkdirSync(dir); return dir }
// The entry hash the catalog pinned before CP-06, i.e. of SKILL.md with no Codex section.
const CLAUDE_ONLY_SHA256 = '1e7d0b75fa3c85c6ec3b5161f979818d85bc0776b39635d0dc15db175dde5b7f'
const HEADING = '## Codex runner'

// Headings outside code fences: [{ at, line }] (at = index into the lines).
function headingsOf(all) {
  let fenced = false
  const headings = []
  all.forEach((line, at) => {
    if (/^```/.test(line)) fenced = !fenced
    if (!fenced && /^## /.test(line)) headings.push({ at, line: line.trimEnd() })
  })
  return headings
}
function readSection() {
  const all = readFileSync(SKILL_MD, 'utf8').split('\n')
  const headings = headingsOf(all)
  const runner = headings.filter(h => h.line === HEADING)
  assert.equal(runner.length, 1, 'SKILL.md has exactly one "## Codex runner" section')
  const ask = headings.find(h => h.line === '## When to ask')
  assert.ok(ask && runner[0].at < ask.at, '"## Codex runner" comes before "## When to ask"')
  const next = headings.find(h => h.at > runner[0].at)
  const body = all.slice(runner[0].at + 1, next.at).join('\n')
  const blocks = [...body.matchAll(/^```bash[ \t]*\n([\s\S]*?)\n```[ \t]*$/gm)].map(m => m[1])
  return { all, start: runner[0].at, end: next.at, body, blocks, after: headings.filter(h => h.at > runner[0].at).map(h => h.line) }
}

await test('the Claude path is byte-identical: SKILL.md without the Codex runner section is the pre-CP-06 file', () => {
  const { all, start, end } = readSection()
  const without = [...all.slice(0, start), ...all.slice(end)].join('\n')
  assert.equal(createHash('sha256').update(without).digest('hex'), CLAUDE_ONLY_SHA256)
})

await test('the section: before `## When to ask`, the three modes, the command, the roots, the leaf env, outputs, exits, held leaves; no Claude-only string', () => {
  const { body: raw, after } = readSection()
  const body = raw.replace(/\s+/g, ' ') // the prose wraps lines
  for (const text of ['`new`', '`plan`', '`resume`', 'node "$SKILL_DIR/dev-native.mjs" run --args-file <file>', '`installationRoot` (`ROOT`)', '`codexBin` (`CODEX`)',
    '`HOME`', '`CODEX_HOME` when it is set', '`PATH`', 'never a secret', '{status, invocationId, stateDir}', '`ledger.json`', '`plan.json`',
    'Exit 1 is bad input, 2 a refusal, 3 a failure', '`{"error"}`', 'never retried with another provider', '`CHECKPOINT_UNCERTAIN`',
    'graph-reconcile.mjs', '`invocationId`', 'replays every finished leaf', '`NO_SAVED_PLAN`', '`NO_SAVED_LEDGER`', '`--review`', 'Workflow tool',
    'core/skills/verify/verify.sh', 'core/skills/backlog/backlog.mjs']) {
    assert.ok(body.includes(text), `the section says ${JSON.stringify(text)}`)
  }
  for (const text of ['.claude', 'CLAUDE_CONFIG_DIR', 'CLAUDE_SKILL_DIR', 'AskUserQuestion']) assert.ok(!body.includes(text), `the section holds no ${text}`)
  assert.deepEqual(after, ['## When to ask', '## 1. Preflight', '## 2. Run the graph', '## 3. On `plan-ready` (only with `--review`)',
    '## 4. On `needs-human`', '## 5. On `escalate`', '## 6. On `done`'])
})

// ---------------------------------------------------------------- the steps table

const HOST = ['repo', 'mode', 'installationRoot', 'codexBin', 'env', 'timeoutMs']
const OPTIONAL = ['base', 'maxFixRounds', 'knownStuckSigs', 'requiredCriteria', 'invocationId']
const CONTRACT = { new: [[...HOST, 'task', 'approval'], OPTIONAL], plan: [HOST, OPTIONAL] }
// A key is a backticked name; one in [brackets] is optional. `(ROOT)` style notes are not keys.
function keysOf(cell) {
  const required = [], optional = []
  for (const m of cell.matchAll(/(\[)?`([A-Za-z0-9]+)`(\])?/g)) {
    if (cell.slice(m.index - 1, m.index) === '(') continue
    ;(m[1] && m[3] ? optional : required).push(m[2])
  }
  return { required, optional }
}
function stepsTable(body) {
  const rows = body.split('\n').filter(line => /^\|/.test(line)).map(line => line.split('|').slice(1, -1).map(cell => cell.trim()))
  assert.deepEqual(rows[0], ['mode', 'replaces', 'args file keys (optional in brackets)'], 'the steps table header')
  const steps = {}
  for (const [modeCell, , keysCell] of rows.slice(2)) {
    const mode = modeCell.replace(/`/g, '')
    steps[mode] = keysCell === 'the same keys as `plan`' ? 'plan' : keysOf(keysCell)
  }
  return steps
}

await test('the steps table has new, plan and resume in order with exactly the CLI\'s keys (resume: the same as plan)', () => {
  const steps = stepsTable(readSection().body)
  assert.deepEqual(Object.keys(steps), ['new', 'plan', 'resume'])
  for (const mode of ['new', 'plan']) assert.deepEqual([steps[mode].required, steps[mode].optional], CONTRACT[mode], mode)
  assert.equal(steps.resume, 'plan')
})

const VALUES = repo => ({ repo, mode: 'new', installationRoot: ROOT, codexBin: join(WORK, 'codex'), env: { PATH: '/usr/bin:/bin' }, timeoutMs: 3600000,
  task: 'A greeting', approval: 'advisor', base: 'main', maxFixRounds: 3, knownStuckSigs: [], requiredCriteria: [{ id: 'AC1', criterion: 'holds' }],
  invocationId: 'dev-20261122T010203Z-0123abcd' })
function runCli(args) {
  const dir = ownedDir('args')
  const argsPath = join(dir, 'args.json')
  writeFileSync(argsPath, JSON.stringify(args))
  const r = spawnSync(process.execPath, [join(SKILL_DIR, 'dev-native.mjs'), 'run', '--args-file', argsPath], {
    encoding: 'utf8', cwd: WORK, timeout: 60000,
    env: { PATH: process.env.PATH, LANG: 'C', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CEILING_DIRECTORIES: WORK, HOME: WORK },
  })
  return [r.status, r.stdout, r.stderr]
}
const refused = code => [code === 'INVALID_ARGS' ? 1 : 2, '', `${JSON.stringify({ error: code })}\n`]

await test('each mode row lists exactly the keys the CLI accepts: all pass, one more is INVALID_ARGS, each required one is needed', () => {
  const repo = ownedDir('not a repo')
  const values = VALUES(repo)
  for (const mode of ['new', 'plan', 'resume']) {
    const [required, optional] = CONTRACT[mode === 'resume' ? 'plan' : mode]
    const all = { ...Object.fromEntries([...required, ...optional].map(key => [key, values[key]])), mode }
    assert.deepEqual(runCli(all), refused('NOT_A_REPO'), `${mode}: every listed key is accepted`)
    assert.deepEqual(runCli({ ...all, unlisted: 'x' }), refused('INVALID_ARGS'), `${mode}: an unlisted key is refused`)
    for (const key of required) {
      const { [key]: _dropped, ...rest } = all
      assert.deepEqual(runCli(rest), refused('INVALID_ARGS'), `${mode}: ${key} is required`)
    }
    const onlyRequired = Object.fromEntries(required.map(key => [key, key === 'mode' ? mode : values[key]]))
    assert.deepEqual(runCli(onlyRequired), refused('NOT_A_REPO'), `${mode}: ${optional.join(', ')} may be left out`)
  }
  // task and approval belong to `new` alone.
  assert.deepEqual(runCli({ ...Object.fromEntries(CONTRACT.plan[0].map(key => [key, values[key]])), mode: 'plan', task: 'x' }), refused('INVALID_ARGS'))
})

// ---------------------------------------------------------------- the roots block

const BASH = spawnSync('/bin/sh', ['-c', 'command -v bash'], { encoding: 'utf8' }).stdout.trim()
function deriveRoots(block, installedDir, path) {
  const home = ownedDir('home')
  const script = `${block.split('<installed-skill-dir>').join(installedDir)}\nprintf '%s\\n' "SKILL_DIR=$SKILL_DIR" "ROOT=$ROOT" "CODEX=$CODEX"\n`
  const r = spawnSync(BASH, ['-c', script], { encoding: 'utf8', cwd: home, env: { HOME: home, PATH: path, CDPATH: WORK } })
  return [r.status, r.stderr, r.stdout]
}

await test('the roots block resolves through two symlinks with spaces, prints nothing, and leaves CODEX empty without codex', () => {
  assert.ok(BASH.startsWith('/'), 'a usable bash')
  const [roots, command] = readSection().blocks
  assert.ok(roots.includes('<installed-skill-dir>') && command.includes('dev-native.mjs'), 'the first block is the roots, the second the command')
  const links = ownedDir('skills dir')
  symlinkSync(SKILL_DIR, join(links, 'inner link'))
  symlinkSync(join(links, 'inner link'), join(links, 'dev skill'))
  const bin = ownedDir('bin dir')
  writeFileSync(join(bin, 'codex'), '#!/bin/sh\nexit 0\n', { mode: 0o755 })
  assert.deepEqual(deriveRoots(roots, join(links, 'dev skill'), bin), [0, '', `SKILL_DIR=${SKILL_DIR}\nROOT=${ROOT}\nCODEX=${join(bin, 'codex')}\n`])
  assert.deepEqual(deriveRoots(roots, join(links, 'dev skill'), ownedDir('empty bin')), [0, '', `SKILL_DIR=${SKILL_DIR}\nROOT=${ROOT}\nCODEX=\n`])
})
