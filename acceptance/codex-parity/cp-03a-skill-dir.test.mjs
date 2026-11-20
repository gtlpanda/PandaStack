// CP-03a frozen acceptance: provider-neutral SKILL_DIR helper invocation in the
// backlog, findings, gtm-brief and verify SKILL.md files
// (spec/contracts/codex-parity-cp-03a.md). The documented commands are read from
// the candidate's SKILL.md files and run for real through bash in owned temp
// directories, with a HOME built here: never the real HOME, no network, no
// provider. Claude Code's substitution of `${CLAUDE_SKILL_DIR}` is modeled two
// ways (text replaced, or the variable set); neither is a run of Claude Code.
import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync, chmodSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'

const ROOT = process.env.PANDASTACK_CANDIDATE_ROOT || fileURLToPath(new URL('../../', import.meta.url))
const sha = bytes => createHash('sha256').update(bytes).digest('hex')
const TOKEN = '${CLAUDE_SKILL_DIR}'
const IDIOM = /^(node|bash) "\$\{SKILL_DIR:-\$\{CLAUDE_SKILL_DIR\}\}\/([A-Za-z0-9._-]+)"(?: (.*))?$/
const PARAGRAPH = "`SKILL_DIR` is the directory that holds this SKILL.md. Claude Code fills it in " +
  'through its `CLAUDE_SKILL_DIR` substitution, so there the helper commands in this file run as written. ' +
  'Anywhere else (Codex, or this file read without that substitution), start each command with ' +
  "`SKILL_DIR='<dir>';`, where `<dir>` is the absolute path of the folder that holds this SKILL.md. " +
  'A set `SKILL_DIR` wins. With neither set, the command fails.'
const VERDICT = /^(BACKLOG|FINDINGS|GTM-BRIEF|VERIFY): /m
const NOT_FOUND = /Cannot find module|ERR_MODULE_NOT_FOUND|No such file or directory/
const DIRECT_LINE = /\n {2}capture: direct \(no \/proc on this platform: steps ran without process-group ownership\)\nVERIFY: (PASS|FAIL)\n$/

// The documented commands: helper, interpreter, and argument tails, in file order.
const SKILLS = {
  backlog: { run: 'node', helper: 'backlog.mjs', tails: ['check docs/backlog.json', 'task docs/backlog.json S2 [build state dir]'] },
  findings: { run: 'node', helper: 'findings.mjs', tails: ['check <ledger.json>', 'save <ledger.json> <intake.json> <result.json> [--repo <tree>]', 'report <ledger.json> [evidence dir]'] },
  'gtm-brief': { run: 'node', helper: 'gtm-brief.mjs', tails: ['check docs/gtm.md'] },
  verify: { run: 'bash', helper: 'verify.sh', tails: [''] },
}
const NAMES = Object.keys(SKILLS)
// What main (d80d9c5) documented, run from a Claude-layout HOME: the unchanged-behavior baseline.
const LEGACY = {
  backlog: 'node ~/.claude/skills/backlog/backlog.mjs',
  findings: 'node ~/.claude/skills/findings/findings.mjs',
  'gtm-brief': 'node ~/.claude/skills/gtm-brief/gtm-brief.mjs',
  verify: `bash "${TOKEN}/verify.sh"`,
}

const skillFile = name => resolve(ROOT, 'core/skills', name, 'SKILL.md')
const normalize = text => text.replace(/\s+/g, ' ').trim()

function fencedLines(text) {
  const out = []
  let inside = false
  for (const line of text.split('\n')) {
    if (/^```/.test(line)) { inside = !inside; continue }
    if (inside) out.push(line)
  }
  return out
}

// A fenced line that names a helper, a skill directory variable or a skills path, or runs an interpreter.
function touchesHelper(line, helper) {
  return line.includes('SKILL_DIR') || /\.claude\b|\.agents\b|skills\//.test(line) || line.includes(helper) ||
    /^\s*(node|bash|sh)\s/.test(line)
}

// The prefixes (`node "${SKILL_DIR:-${CLAUDE_SKILL_DIR}}/x.mjs"`) and tails, exactly as the candidate documents them.
function documented(name) {
  const spec = SKILLS[name]
  const text = readFileSync(skillFile(name), 'utf8')
  const lines = fencedLines(text).filter(line => touchesHelper(line, spec.helper))
  const commands = lines.map(line => {
    const m = IDIOM.exec(line)
    assert.ok(m, `${name}: a fenced helper command deviates from the SKILL_DIR idiom: ${line}`)
    assert.equal(m[1], spec.run, `${name}: interpreter`)
    assert.equal(m[2], spec.helper, `${name}: helper`)
    return { prefix: line.slice(0, line.length - (m[3] === undefined ? 0 : m[3].length + 1)), tail: m[3] ?? '' }
  })
  assert.deepEqual(commands.map(c => c.tail), spec.tails, `${name}: the documented command set`)
  return { text, prefix: commands[0].prefix }
}

// ---- sandboxes: owned temp dirs, a HOME with a space in its path, decoys that must never run ----

function sandbox(t) {
  const base = realpathSync(mkdtempSync(join(realpathSync(tmpdir()), 'cp03a-')))
  t.after(() => rmSync(base, { recursive: true, force: true }))
  const dir = (...parts) => { const p = join(base, ...parts); mkdirSync(p, { recursive: true }); return p }
  return { base, dir }
}

function link(home, layout, name) {
  const parent = join(home, layout, 'skills')
  mkdirSync(parent, { recursive: true })
  const path = join(parent, name)
  symlinkSync(resolve(ROOT, 'core/skills', name), path, 'dir')
  return path
}

function decoy(dir, helper) {
  mkdirSync(dir, { recursive: true })
  const body = helper.endsWith('.sh') ? 'echo DECOY\nexit 0\n' : "console.log('DECOY')\n"
  writeFileSync(join(dir, helper), body)
  return dir
}

function writeExec(path, body) {
  writeFileSync(path, body)
  chmodSync(path, 0o755)
}

const H1 = 'a'.repeat(40)
const H2 = 'b'.repeat(40)
const BACKLOG = {
  version: 1, app: 'reading-list', integrationBranch: 'integration/reading-list', requirements: ['R1', 'R2'],
  slices: [
    { id: 'S1', title: 'Book list', goal: 'Store and list books.', requirements: ['R1'],
      acceptance: [{ id: 'S1-AC1', criterion: 'A saved book is listed', fails_when: 'the list is empty after saving' }], depends_on: [] },
    { id: 'S2', title: 'Mark read', goal: 'Toggle a book read.', requirements: ['R2'],
      acceptance: [{ id: 'S2-AC1', criterion: 'Marking moves it to read', fails_when: 'it stays in to-read' }], depends_on: ['S1'] },
  ],
}
const BRIEF = `# Shelf GTM brief

## Product
Shelf keeps a reading list per person.

## Customer
Readers who lose track of books friends recommend.

## Positioning
A notes app today. We win because a book is one tap.

## Voice
Do: plain and warm. Don't: hype.

## Proof
- Adding a book takes one tap - source: https://example.com/demo

## Never claim
- That it syncs offline, because it does not

## Compliance
none
`

// A fresh work tree per run: the skill's inputs, plus decoy helpers where a relative or
// project-local lookup would find them.
function workTree(box, label, name) {
  const work = box.dir(label, 'work tree')
  const helper = SKILLS[name].helper
  for (const rel of [`.claude/skills/${name}`, `.agents/skills/${name}`, `skills/${name}`, '.']) decoy(join(work, rel), helper)
  if (name === 'backlog') {
    mkdirSync(join(work, 'docs'))
    writeFileSync(join(work, 'docs/backlog.json'), JSON.stringify(BACKLOG))
    writeFileSync(join(work, 'docs/bad.json'), JSON.stringify({ ...BACKLOG, version: 2 }))
  }
  if (name === 'findings') {
    writeFileSync(join(work, 'intake.json'), JSON.stringify({ key: 'pr-7', target: { head: H1, mergeBase: H2, label: 'PR #7', base: 'main' } }))
    writeFileSync(join(work, 'result.json'), JSON.stringify({ status: 'done', mode: 'discover', findings: [], coverage: [{ lens: 'logic', status: 'covered' }] }))
    writeFileSync(join(work, 'bad.json'), JSON.stringify({ version: 2, key: 'K!', findings: [] }))
  }
  if (name === 'gtm-brief') {
    mkdirSync(join(work, 'docs'))
    writeFileSync(join(work, 'docs/gtm.md'), BRIEF)
    writeFileSync(join(work, 'docs/bad.md'), BRIEF.replace('## Compliance\nnone\n', ''))
  }
  if (name === 'verify') {
    mkdirSync(join(work, 'scripts'))
    writeExec(join(work, 'scripts/test.sh'), '#!/bin/sh\necho fixture-pass\nexit 0\n')
    mkdirSync(join(work, 'failing/scripts'), { recursive: true })
    writeExec(join(work, 'failing/scripts/test.sh'), '#!/bin/sh\necho fixture-fail\nexit 3\n')
  }
  return work
}

// The documented exits, in order. Each step: argument string, exit, and a check of the output.
const lastLine = out => out.trimEnd().split('\n').at(-1)
const STEPS = {
  backlog: [
    { args: 'check docs/backlog.json', exit: 0, last: 'BACKLOG: PASS' },
    { args: 'check docs/bad.json', exit: 1, last: 'BACKLOG: FAIL' },
    { args: 'task docs/backlog.json S2', exit: 0, check: out => assert.equal(JSON.parse(out).slice, 'S2') },
    { args: "task docs/backlog.json S2 'build state'", exit: 0, check: out => assert.equal(JSON.parse(out).app, 'reading-list') },
    { args: 'check', exit: 2 },
  ],
  findings: [
    { args: 'save hunt/ledger.json intake.json result.json', exit: 0, check: out => assert.match(lastLine(out), /^FINDINGS: SAVED 0 finding\(s\), disposition [a-z_]+$/) },
    { args: 'check hunt/ledger.json', exit: 0, last: 'FINDINGS: PASS' },
    { args: 'report hunt/ledger.json', exit: 0, check: out => assert.match(out, /# Bug hunt: PR #7/) },
    { args: 'check bad.json', exit: 1, last: 'FINDINGS: FAIL' },
    { args: 'report missing.json', exit: 1 },
    { args: 'report', exit: 2 },
  ],
  'gtm-brief': [
    { args: 'check docs/gtm.md', exit: 0, last: 'GTM-BRIEF: PASS' },
    { args: 'check docs/bad.md', exit: 1, last: 'GTM-BRIEF: FAIL' },
  ],
  verify: [
    { args: '', exit: 0, last: 'VERIFY: PASS', check: out => { assert.match(out, /\n {2}\[0\] scripts\/test\.sh\n/); capture(out) } },
    { args: 'failing', exit: 1, last: 'VERIFY: FAIL', check: out => { assert.match(out, /\n {2}\[3\] scripts\/test\.sh\n/); capture(out) } },
  ],
}

// D123: Linux runs owned capture; elsewhere (macOS, no /proc) steps run directly and the summary says so.
function capture(out) {
  if (process.platform === 'linux') assert.doesNotMatch(out, /capture: direct/)
  else assert.match(out, DIRECT_LINE)
}

function env(home, tmp, extra = {}) {
  return { PATH: process.env.PATH, HOME: home, TMPDIR: tmp, LC_ALL: 'C', ...extra }
}

function sh(command, cwd, environment) {
  const r = spawnSync('bash', ['-c', command], { cwd, env: environment, encoding: 'utf8', timeout: 120_000 })
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '', error: r.error }
}

const command = (prefix, args) => (args ? `${prefix} ${args}` : prefix)
const quote = path => { assert.ok(!path.includes("'")); return `'${path}'` }

// Runs every step of a skill with one command form; asserts the documented exits; returns the results.
function runSteps(name, form, cwd, environment) {
  return STEPS[name].map(step => {
    const r = sh(form(step.args), cwd, environment)
    const where = `${name} ${JSON.stringify(step.args)}\nstdout: ${r.stdout.slice(-800)}\nstderr: ${r.stderr.slice(-800)}`
    assert.equal(r.error, undefined, where)
    assert.equal(r.status, step.exit, where)
    assert.doesNotMatch(r.stdout + r.stderr, /DECOY/, where)
    assert.doesNotMatch(r.stderr, NOT_FOUND, where)
    if (step.last) assert.equal(lastLine(r.stdout), step.last, where)
    if (step.check) step.check(r.stdout)
    return r
  })
}

// ---- static: one idiom, one paragraph, no ~/.claude ----

for (const name of NAMES) {
  test(`${name}: SKILL.md documents its helper only through the pinned SKILL_DIR idiom`, () => {
    const { text } = documented(name)
    assert.doesNotMatch(text, /\.claude\b/, `${name}: no .claude path anywhere in the file`)
    const helperLines = fencedLines(text).filter(line => touchesHelper(line, SKILLS[name].helper))
    const tokens = text.split(TOKEN).length - 1
    assert.equal(tokens, helperLines.length, `${name}: ${TOKEN} appears only inside idiom commands`)
    assert.equal((text.match(/\$\{?CLAUDE_SKILL_DIR/g) ?? []).length, tokens, `${name}: CLAUDE_SKILL_DIR is read only as ${TOKEN}`)
    assert.ok(normalize(text).includes(PARAGRAPH), `${name}: the pinned SKILL_DIR paragraph`)
  })
}

// ---- Codex layout: a clean HOME with only ~/.agents/skills/<name>, SKILL_DIR set as documented ----

for (const name of NAMES) {
  test(`${name}: the documented commands run from a Codex-layout symlink in a clean HOME with no .claude`, t => {
    const { prefix } = documented(name)
    const box = sandbox(t)
    const home = box.dir('home dir'), tmp = box.dir('tmp')
    const skillDir = link(home, '.agents', name)
    const work = workTree(box, 'codex', name)
    runSteps(name, args => `SKILL_DIR=${quote(skillDir)}; ${command(prefix, args)}`, work, env(home, tmp))
    assert.equal(existsSync(join(home, '.claude')), false, 'nothing created a .claude directory')
  })
}

// ---- Claude layout: unchanged against the main-era command ----

for (const name of NAMES) {
  test(`${name}: Claude layout gives the same exits and verdicts as the main-era command`, t => {
    const { prefix } = documented(name)
    const box = sandbox(t)
    const home = box.dir('home dir'), tmp = box.dir('tmp')
    const skillDir = link(home, '.claude', name)
    const substitute = form => form.split(TOKEN).join(skillDir)
    const legacy = runSteps(name, args => substitute(command(LEGACY[name], args)), workTree(box, 'legacy', name), env(home, tmp))
    // Claude Code replaces the text `${CLAUDE_SKILL_DIR}` in the skill's markdown.
    const replaced = runSteps(name, args => substitute(command(prefix, args)), workTree(box, 'replaced', name), env(home, tmp))
    // The variable form the main-era verify SKILL.md described.
    const variable = runSteps(name, args => command(prefix, args), workTree(box, 'variable', name), env(home, tmp, { CLAUDE_SKILL_DIR: skillDir }))
    for (const got of [replaced, variable]) {
      assert.deepEqual(got.map(r => [r.status, lastLine(r.stdout)]), legacy.map(r => [r.status, lastLine(r.stdout)]))
    }
  })
}

// ---- fail closed, and a set SKILL_DIR wins ----

for (const name of NAMES) {
  test(`${name}: with neither variable the command fails and runs no other copy; a set SKILL_DIR wins`, t => {
    const { prefix } = documented(name)
    const box = sandbox(t)
    const home = box.dir('home dir'), tmp = box.dir('tmp')
    const skillDir = link(home, '.agents', name)
    const other = decoy(box.dir('other skill'), SKILLS[name].helper)
    const work = workTree(box, 'neither', name)
    for (const step of STEPS[name]) {
      const r = sh(command(prefix, step.args), work, env(home, tmp))
      assert.notEqual(r.status, 0, `${name} ${step.args}: fails with neither set`)
      assert.doesNotMatch(r.stdout, VERDICT)
      assert.doesNotMatch(r.stdout + r.stderr, /DECOY/)
    }
    assert.equal(existsSync(join(work, 'hunt')), false, 'nothing was written')
    // SKILL_DIR beats a CLAUDE_SKILL_DIR variable and a substituted path that point elsewhere.
    runSteps(name, args => `SKILL_DIR=${quote(skillDir)}; ${command(prefix, args)}`, workTree(box, 'wins-variable', name),
      env(home, tmp, { CLAUDE_SKILL_DIR: other }))
    runSteps(name, args => `SKILL_DIR=${quote(skillDir)}; ${command(prefix, args).split(TOKEN).join(other)}`,
      workTree(box, 'wins-replaced', name), env(home, tmp))
  })
}

// ---- the catalog follows the edit ----

test('the four entrySha256 values equal the SKILL.md bytes and checkCatalogDrift stays ok', async () => {
  const catalog = JSON.parse(readFileSync(resolve(ROOT, 'spec/offering-capabilities.json'), 'utf8'))
  for (const name of NAMES) {
    const row = catalog.offerings.find(o => o.id === name)
    assert.equal(row.source, `core/skills/${name}`)
    assert.equal(row.entrySha256, sha(readFileSync(skillFile(name))), `${name}: entrySha256`)
  }
  const api = await import(pathToFileURL(resolve(ROOT, 'core/skills/native-runtime/catalog.mjs')))
  assert.equal(typeof api.checkCatalogDrift, 'function', 'catalog.mjs exports checkCatalogDrift (CP-01b)')
  assert.deepEqual(api.checkCatalogDrift({ installationRoot: ROOT }), { ok: true, problems: [] })
})
