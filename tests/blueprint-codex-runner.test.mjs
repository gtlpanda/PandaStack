// CP-04e implementation edges the frozen acceptance does not pin. The `## Codex runner`
// section of graphs/blueprint/skills/blueprint/SKILL.md is the only thing a Codex session
// reads, so these cases hold its table and prose to the CLIs they describe:
// - every verb row lists exactly the keys its CLI accepts: all of them together pass the
//   key checks (the CLI goes on to refuse a non-repo with NOT_A_REPO), one extra key is
//   INVALID_ARGS, and dropping any key the row marks required is INVALID_ARGS;
// - the roots block resolves through a chain of two symlinks whose paths hold spaces,
//   prints nothing (CDPATH set), and leaves CODEX empty when codex is not on PATH;
// - the prose names the leaf env, exit codes, approval and held-leaf rules (items 5 to 8);
// - the eight Claude sections follow it unchanged, in order.
// No CLI here reaches git beyond `rev-parse` in an owned non-repo directory; no codex,
// claude or network. Owned temp directories only.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { test } from '../scripts/workflow-harness.mjs'

const ROOT = realpathSync(resolve(import.meta.dirname, '..'))
const SKILL_DIR = join(ROOT, 'graphs/blueprint/skills/blueprint')
const SKILL_MD = join(SKILL_DIR, 'SKILL.md')
const WORK = realpathSync(mkdtempSync(join(tmpdir(), 'blueprint codex runner ')))
process.on('exit', () => rmSync(WORK, { recursive: true, force: true }))
let dirNo = 0
const ownedDir = prefix => { const dir = join(WORK, `${prefix} ${++dirNo}`); mkdirSync(dir); return dir }

// The section: from its heading to the next "## " heading outside a code fence.
function readSection() {
  const all = readFileSync(SKILL_MD, 'utf8').split('\n')
  let fenced = false
  const headings = []
  all.forEach((line, i) => {
    if (/^```/.test(line)) fenced = !fenced
    if (!fenced && /^## /.test(line)) headings.push({ i, line })
  })
  const at = headings.findIndex(h => h.line === '## Codex runner')
  assert.ok(at >= 0, 'SKILL.md has a "## Codex runner" section')
  const body = all.slice(headings[at].i + 1, headings[at + 1].i).join('\n')
  const blocks = [...body.matchAll(/^```bash[ \t]*\n([\s\S]*?)\n```[ \t]*$/gm)].map(m => m[1])
  return { body, blocks, after: headings.slice(at + 1).map(h => h.line) }
}

// The steps table: verb -> { module, required, optional }. Bracketed keys are optional.
const APPROVE_VERBS = new Set(['show', 'approve'])
function stepsTable(body) {
  const rows = body.split('\n').filter(line => /^\|/.test(line)).map(line => line.split('|').slice(1, -1).map(cell => cell.trim()))
  assert.deepEqual(rows[0], ['verb', 'replaces', 'args file keys (optional in brackets)'], 'the steps table header')
  const steps = {}
  for (const [verbCell, , keysCell] of rows.slice(2)) {
    const verb = verbCell.replace(/`/g, '')
    const required = [], optional = []
    // A key is a backticked name; one in [brackets] is optional. `(ROOT)` style notes are not keys.
    for (const m of keysCell.matchAll(/(\[)?`([A-Za-z0-9]+)`(\])?/g)) {
      if (keysCell.slice(m.index - 1, m.index) === '(') continue
      ;(m[1] && m[3] ? optional : required).push(m[2])
    }
    steps[verb] = { module: APPROVE_VERBS.has(verb) ? 'blueprint-approve.mjs' : 'blueprint-native.mjs', required, optional }
  }
  return steps
}

// A value that passes each key's own check. The CLI checks only repo, the host keys and
// the args file's key set before git; the rest are checked after the repo, which here is
// never reached.
const VALUES = repo => ({
  repo, installationRoot: ROOT, codexBin: join(WORK, 'codex'), env: { PATH: '/usr/bin:/bin' }, timeoutMs: 3600000,
  request: 'A reading list', docs: [], restart: true, answers: [{ id: 'Q1', answer: 'yes' }], have: [], overrides: [],
  edit: 'Use SQLite', approvalSha256: '0',
})
function runCli(module, verb, args) {
  const dir = ownedDir('args')
  const argsPath = join(dir, 'args.json')
  writeFileSync(argsPath, JSON.stringify(args))
  const r = spawnSync(process.execPath, [join(SKILL_DIR, module), verb, '--args-file', argsPath], {
    encoding: 'utf8', cwd: WORK, timeout: 60000,
    env: { PATH: process.env.PATH, LANG: 'C', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CEILING_DIRECTORIES: WORK, HOME: WORK },
  })
  return [r.status, r.stdout, r.stderr]
}
// A required key the CLI checks only after the repo: CP-04d refuses an absent
// approvalSha256 at its hash step as APPROVAL_MISMATCH, so on a non-repo NOT_A_REPO wins.
const CHECKED_AFTER_REPO = { 'approve.approvalSha256': 'NOT_A_REPO' }
const refused = code =>[code === 'INVALID_ARGS' ? 1 : 2, '', `${JSON.stringify({ error: code })}\n`]

// The CP-04c and CP-04d key tables, so a key the section leaves out is caught too (the
// CLI case below proves only that every listed key is accepted).
const HOST = ['repo', 'installationRoot', 'codexBin', 'env', 'timeoutMs']
const CONTRACT_KEYS = {
  start: [['repo'], ['request', 'docs', 'restart']], interview: [HOST, []], answer: [['repo', 'answers'], ['have', 'overrides']],
  design: [HOST, []], gate: [['repo', 'answers'], []], backlog: [HOST, []], show: [['repo'], []], approve: [['repo', 'approvalSha256'], []],
  edit: [['repo', 'edit'], []],
}

await test('the steps table has the nine verbs in order with exactly the contracts\' keys', () => {
  const steps = stepsTable(readSection().body)
  assert.deepEqual(Object.keys(steps), Object.keys(CONTRACT_KEYS))
  for (const [verb, [required, optional]] of Object.entries(CONTRACT_KEYS)) {
    assert.deepEqual([steps[verb].required, steps[verb].optional], [required, optional], verb)
  }
})

await test('each verb row lists exactly the keys its CLI accepts: all pass, one more is INVALID_ARGS, each required one is needed', () => {
  const steps = stepsTable(readSection().body)
  const repo = ownedDir('not a repo')
  const values = VALUES(repo)
  for (const [verb, { module, required, optional }] of Object.entries(steps)) {
    const all = Object.fromEntries([...required, ...optional].map(key => [key, values[key]]))
    assert.deepEqual(runCli(module, verb, all), refused('NOT_A_REPO'), `${verb}: every listed key is accepted`)
    assert.deepEqual(runCli(module, verb, { ...all, unlisted: 'x' }), refused('INVALID_ARGS'), `${verb}: an unlisted key is refused`)
    for (const key of required) {
      const { [key]: _dropped, ...rest } = all
      assert.deepEqual(runCli(module, verb, rest), refused(CHECKED_AFTER_REPO[`${verb}.${key}`] ?? 'INVALID_ARGS'), `${verb}: ${key} is required`)
    }
    if (optional.length > 0) {
      const onlyRequired = Object.fromEntries(required.map(key => [key, values[key]]))
      assert.deepEqual(runCli(module, verb, onlyRequired), refused('NOT_A_REPO'), `${verb}: ${optional.join(', ')} may be left out`)
    }
  }
})

// Runs the roots block with <installed-skill-dir> replaced, then prints the three variables.
// bash runs by absolute path, so PATH can be exactly the directory under test.
const BASH = spawnSync('/bin/sh', ['-c', 'command -v bash'], { encoding: 'utf8' }).stdout.trim()
function deriveRoots(block, installedDir, path) {
  const home = ownedDir('home')
  const script = `${block.split('<installed-skill-dir>').join(installedDir)}\nprintf '%s\\n' "SKILL_DIR=$SKILL_DIR" "ROOT=$ROOT" "CODEX=$CODEX"\n`
  const r = spawnSync(BASH, ['-c', script], { encoding: 'utf8', cwd: home, env: { HOME: home, PATH: path, CDPATH: WORK } })
  return [r.status, r.stderr, r.stdout]
}

await test('the roots block resolves through two symlinks with spaces, prints nothing, and leaves CODEX empty without codex', () => {
  assert.ok(BASH.startsWith('/'), 'a usable bash')
  const [roots] = readSection().blocks
  const links = ownedDir('skills dir')
  symlinkSync(SKILL_DIR, join(links, 'inner link'))
  symlinkSync(join(links, 'inner link'), join(links, 'blueprint skill'))
  const installed = join(links, 'blueprint skill')
  const bin = ownedDir('bin dir')
  writeFileSync(join(bin, 'codex'), '#!/bin/sh\nexit 0\n', { mode: 0o755 })
  assert.deepEqual(deriveRoots(roots, installed, bin), [0, '', `SKILL_DIR=${SKILL_DIR}\nROOT=${ROOT}\nCODEX=${join(bin, 'codex')}\n`])
  assert.deepEqual(deriveRoots(roots, installed, ownedDir('empty bin')), [0, '', `SKILL_DIR=${SKILL_DIR}\nROOT=${ROOT}\nCODEX=\n`],
    'no codex on PATH: CODEX is empty (the prose says stop), and the block is still silent')
})

await test('the prose states the leaf env, outputs, exit codes, approval and held-leaf rules with no Claude-only path', () => {
  const { body } = readSection()
  for (const text of ['`HOME`', '`CODEX_HOME` when it is set', '`PATH`', 'never a secret', '{status, file, invocationId, redacted}', 'already redacted',
    'Exit 1 is bad input, 2 a refusal, 3 a failure', 'Exit 4', 'rollback step failed', '`{"error"}`', '`ids`', 'never retried', 'another provider',
    'chose `Approve`', '`integration/<app>`', 'never pushes', '`CHECKPOINT_UNCERTAIN`', 'never\nresumed', 'new invocation', 'Workflow tool']) {
    assert.ok(body.includes(text), `the section says ${JSON.stringify(text)}`)
  }
  for (const text of ['.claude', 'CLAUDE_CONFIG_DIR', 'CLAUDE_SKILL_DIR', 'AskUserQuestion']) assert.ok(!body.includes(text), `the section holds no ${text}`)
})

await test('the eight Claude sections follow the runner section unchanged and in order', () => {
  assert.deepEqual(readSection().after, ['## When to ask', '## 1. Preflight', '## 2. Run the interview graph', '## 3. On `needs-human`: the interview',
    '## 4. Design (run 2)', '## 5. Backlog (run 3)', '## 6. The one approval', '## 7. On `escalate`', '## 8. Report'])
})
