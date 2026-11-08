// audit-skill.test.mjs - the entry skill cannot drift from the code: the description does not fire on an ordinary security question,
// every command SKILL.md names is one the code accepts (each is run, with paths that do not exist, and a usage error fails it), every flag it documents is one `init`
// takes and every one `init` takes is documented, and every step `next` can say has its row. Negatives: the checks are run against a skill with a mistyped
// subcommand, flag, script and step, and each is caught.
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import assert from 'node:assert/strict'
import { test, REPO } from '../../../scripts/workflow-harness.mjs'
import { INIT_FLAGS, RUNNERS, STEPS } from '../skills/security-audit/audit-run.mjs'
import { SKILL_DIR, commandProblem, frontmatter, runCommand, skillCommands, skillText, stepCommands, usageFlags } from './skill-commands.mjs'

const text = skillText()
const fm = frontmatter(text)
const SESSION_FLAGS = ['--unattended', '--guidance']   // read by the session, not by init: there is no code to check them against

// A sandbox of paths that do not exist: a command that parses is refused for its state, and nothing is written.
const box = mkdtempSync(join(tmpdir(), 'audit-skill-test-'))
process.on('exit', () => rmSync(box, { recursive: true, force: true }))
const VARS = { AUDIT: SKILL_DIR, REPO: join(box, 'no-repo'), RUN: join(box, 'no-run'), OUT: join(box, 'no-output.json'), FINGERPRINT: 'a-fingerprint' }
const problems = body => skillCommands(body).map(c => commandProblem(c, VARS, box)).filter(Boolean)

// The phrases an ordinary security question matches in the kit `security` skill, read from its own description, so a trigger added there is checked here.
const kit = frontmatter(readFileSync(join(REPO, 'kit', 'skills', 'security', 'SKILL.md'), 'utf8'))
const ORDINARY = [...kit.description.matchAll(/"([^"]+)"/g)].map(m => m[1].toLowerCase()).filter(p => p !== 'security audit')
// What of an ordinary question's wording a description holds. 'security audit' is the one phrase both skills may hold, and only qualified by "full".
export const triggersIn = description => {
  const d = description.toLowerCase()
  const bare = d.replace(/full(, end-to-end)? security audit/g, '')
  return [...ORDINARY.filter(p => d.includes(p)), ...(bare.includes('security audit') ? ['security audit'] : [])]
}

console.log('== the entry skill: frontmatter and the explicit-request rule')
await test('SKILL.md has a name equal to its directory and a one-line description that gates on the explicit request', () => {
  assert.equal(fm?.name, 'security-audit')
  assert.ok(fm.description && !fm.description.includes('\n'))
  for (const need of ['/security-audit --full', 'explicitly', 'never starts for an ordinary security question', '`security` skill']) assert.ok(fm.description.includes(need), `the description names ${need}`)
})
await test('the description holds none of an ordinary question\'s trigger phrases (the kit security skill\'s own), and "security audit" only as a full audit', () => {
  assert.ok(ORDINARY.length >= 10, `read ${ORDINARY.length} kit phrases`)
  assert.deepEqual(triggersIn(fm.description), [])
  assert.ok(!/use when the user (says|asks)/i.test(fm.description), 'a description that lists what the user says is a trigger list')
})
await test('negative: the check fires on wording it must refuse (an ordinary question, a bare "security audit", a kit phrase) and passes the explicit wording', () => {
  assert.deepEqual(triggersIn('Use when the user says "is this secure" or asks to "threat model this".'), ['is this secure', 'threat model this'])
  assert.deepEqual(triggersIn('Run a security audit of the repo.'), ['security audit'])
  assert.deepEqual(triggersIn('Run a Full Security Audit when asked, and "/security-audit --full".'), [])
  assert.deepEqual(triggersIn('a full, end-to-end security audit, or "security review this"'), ['security review this'])
})
await test('the body states the explicit-request rule, the guidance route, the ask-once rule with its --unattended exception, and the three gates', () => {
  for (const need of ['Run a full audit only when the user explicitly asks for one', '**Ordinary security questions never start an audit.**', 'blocks.mjs" guidance', 'ask once with AskUserQuestion', 'Under `--unattended` nobody is there: never ask', 'also refuses without `--full`'])
    assert.ok(text.includes(need), `SKILL.md names: ${need}`)
})

console.log('== the entry skill: every command is one the code accepts')
await test('SKILL.md names a command for every helper script it uses, and each parses (no usage error), loads, and is refused only for state, writing nothing', () => {
  const cmds = skillCommands(text)
  assert.ok(cmds.length >= 15, `extracted ${cmds.length} commands`)
  const scripts = new Set(cmds.map(c => c.match(/\$AUDIT\/([^"]+)"/)[1]))
  for (const s of ['audit-run.mjs', 'audit-ledger.mjs', 'audit-findings.mjs', 'audit-stage.mjs', 'audit-report.mjs', 'blocks.mjs']) assert.ok(scripts.has(s), `${s} appears in a command`)
  for (const c of cmds) assert.equal(commandProblem(c, VARS, box), null)
  assert.deepEqual(readdirSync(box), [], 'a command written something')
})
await test('every script a command names is a file of the skill, and every audit-*.mjs of the skill that a stage runs is named (no helper the skill forgot)', () => {
  const named = new Set(skillCommands(text).map(c => c.match(/\$AUDIT\/([^"]+)"/)[1]))
  for (const s of named) assert.ok(existsSync(join(SKILL_DIR, s)), s)
  // audit-facts, audit-inputs, audit-md, audit-verdicts, audit-verify, audit-verdicts and upstream are libraries; the five commands are the ones with a command line
  for (const s of ['audit-run.mjs', 'audit-ledger.mjs', 'audit-findings.mjs', 'audit-stage.mjs', 'audit-report.mjs']) assert.ok(named.has(s), `${s} is a command the skill must name`)
})
await test('the flags the usage block documents are exactly the flags init takes (plus the two the session reads), so neither can drift', () => {
  const flags = usageFlags(text)
  assert.deepEqual(flags.filter(f => !SESSION_FLAGS.includes(f)).sort(), [...INIT_FLAGS].sort())
  for (const f of SESSION_FLAGS) assert.ok(flags.includes(f), `${f} is documented`)
  // and init does take each one with a value it accepts (a dry parse, not a name list)
  for (const f of INIT_FLAGS.filter(f => f !== '--full')) assert.equal(commandProblem(`node "$AUDIT/audit-run.mjs" init "$REPO" --full ${f} ${{ '--out': '/x', '--profile': 'standard', '--scope': 'a,b', '--prior': '/p' }[f] ?? '3'}`, VARS, box), null, f)
})
await test('every step next can name has a row in the table, or is a Workflow step the skill lists; a step the table names exists', () => {
  const rows = stepCommands(text)
  for (const step of STEPS) {
    if (RUNNERS[step] === 'helper') assert.ok(rows.has(step), `helper step ${step} has no row in the table`)
    if (RUNNERS[step] === 'workflow') assert.ok(text.includes(`\`${step}\``), `workflow step ${step} is not named`)
  }
  for (const [step, command] of rows) {
    if (step === 'done') continue
    assert.ok(STEPS.includes(step), `the table names ${step}, which is not a step`)
    assert.equal(RUNNERS[step], 'helper', `${step} is in the table but is not a helper step`)
    assert.equal(commandProblem(command, VARS, box), null)
  }
  assert.ok(!rows.has('init'), 'init is not a step next ever names after the run exists')
})
await test('the report row and the remediation commands exist; the remediation section says the skill never fixes anything', () => {
  assert.ok(skillCommands(text).some(c => /audit-report\.mjs" task "\$RUN" "\$FINGERPRINT"/.test(c)))
  assert.ok(skillCommands(text).some(c => /audit-report\.mjs" export-remediation "\$RUN"/.test(c)))
  assert.ok(text.includes('This skill never fixes anything.'))
  assert.ok(text.includes('**Never edit the audited repository.**'))
})

console.log('== the helpers the session runs are not the audited repository\'s')
await test('AUDIT is the directory the skill was loaded from or the config dir, never a directory of the audited repository the skill was not loaded from: a hostile repository can ship its own .claude/skills/security-audit/audit-run.mjs', () => {
  const bullet = text.slice(text.indexOf('- `AUDIT` is'), text.indexOf('- `REPO` is')).replace(/\s+/g, ' ')
  assert.ok(bullet.length > 100, 'found the AUDIT bullet')
  assert.ok(bullet.includes('the base directory') && bullet.includes('${CLAUDE_CONFIG_DIR:-$HOME/.claude}/skills/security-audit'), 'the printed base directory, then the config dir')
  assert.ok(!/\.\/\.claude|\$PWD|\$REPO\/\.claude|project-local/.test(bullet), `no fallback inside the audited repository: ${bullet}`)
  assert.ok(/Never a directory of the audited repository/i.test(bullet) && /ship its own/.test(bullet), 'the rule and its reason are stated')
  assert.ok(!/\.\/\.claude\/skills/.test(text), 'no other place in the skill sends the session to ./.claude/skills')
})

console.log('== what the session passes where, and what it says it did')
const flat = text.replace(/\s+/g, ' ')
await test('the session\'s own flags (--unattended, --guidance) are never passed to init, which refuses them with a usage error; the skill says so, where it says what to pass', () => {
  for (const f of SESSION_FLAGS) {
    assert.ok(commandProblem(`node "$AUDIT/audit-run.mjs" init "$REPO" --full ${f}`, VARS, box)?.startsWith('usage error (exit 2)'), `init refuses ${f}`)
    assert.ok(commandProblem(`node "$AUDIT/audit-run.mjs" init "$REPO" ${f} x --full`, VARS, box)?.startsWith('usage error (exit 2)'), `init refuses ${f} with a value`)
  }
  assert.ok(/Pass the flags the user gave, except `--unattended` and `--guidance`/.test(flat) && /`init` refuses them/.test(flat), 'section 3 names the exception')
  assert.ok(!/Add the flags the user gave/.test(flat), 'the old unqualified sentence is gone')
})
await test('the guidance question is single-quoted in the command (it can hold text that is not the session\'s, which double quotes would let the shell run), and the skill says why', () => {
  const g = skillCommands(text).filter(c => /blocks\.mjs" guidance/.test(c))
  assert.ok(g.length >= 1)
  for (const c of g) assert.match(c, /^node "\$AUDIT\/blocks\.mjs" guidance '[^'"`$]*'$/, c)
  assert.ok(/single quotes/.test(flat) && /shell/.test(flat))
  // and run through the shell, a question with command syntax in it is text, not a command
  const marker = join(box, 'ran-by-question')
  const r = runCommand(`node "$AUDIT/blocks.mjs" guidance 'what about $(touch ${marker}) and \`touch ${marker}\` in cors'`, VARS, box)
  assert.equal(r.status, 0, r.stderr)
  assert.ok(!existsSync(marker), 'the question was not run')
})
await test('the skill says what to do with a failure none of its recovery rules covers (stop, say the reason and the run directory, repair nothing), and that a deferred wave can still end complete', () => {
  assert.ok(/`NEXT: FAIL`/.test(flat) && /stop, say the reason and the run directory, and repair nothing/.test(flat), 'a damaged run is the user\'s to decide')
  assert.ok(!/A budget the run could not fund ends it/.test(flat), 'the old claim is gone')
  assert.ok(/refused at `init`/.test(flat) && /can still end `complete`/.test(flat) && /partial pass/.test(flat), 'what a budget does: refused at init, deferred in a wave, complete with deferred coverage is a partial pass')
  assert.ok(/ends the run `incomplete`; `next` then goes on to validate what was found/.test(flat), 'a given-up stage does not jump to the report')
  assert.ok(!/and that the reports are not in the repository/.test(flat) && /under the repository's git directory/.test(flat), 'where the reports are, exactly')
})

console.log('== negative: a skill that drifted is caught')
await test('a mistyped subcommand, a mistyped flag, a missing script, a wrong argument count and a step the code does not have are each refused', () => {
  const broke = (from, to) => { assert.ok(text.includes(from), `fixture: ${from}`); return text.replace(from, to) }
  const cases = [
    ['audit-run.mjs" next', 'audit-run.mjs" nxt'], ['audit-ledger.mjs" plan-wave', 'audit-ledger.mjs" plan-waves'], ['audit-findings.mjs" write', 'audit-findings.mjs" writes'],
    ['audit-stage.mjs" apply "$RUN" "$OUT"', 'audit-stage.mjs" apply "$RUN"'], ['audit-ledger.mjs" seed "$RUN" "$RUN/recon.json"', 'audit-ledger.mjs" seed "$RUN"'],
    ['audit-report.mjs" report', 'audit-report.mjs" reprot'], ['init "$REPO" --full', 'init "$REPO" --ful'], ['audit-stage.mjs" plan', 'audit-planner.mjs" plan'],
    ['audit-ledger.mjs" apply-critic "$RUN" "$RUN/critic.json" "$RUN/mint.json"', 'audit-ledger.mjs" apply-critic "$RUN" "$RUN/critic.json"'],
  ]
  for (const [from, to] of cases) assert.ok(problems(broke(from, to)).length > 0, `not caught: ${from} -> ${to}`)
  assert.deepEqual(problems(text), [], 'the real skill is clean')
  // a table row for a step the code does not have, and a documented flag init does not take, are caught by the cross-checks
  const ghost = text.replace('| `seed` |', '| `sneed` | `node "$AUDIT/audit-ledger.mjs" seed "$RUN" "$RUN/recon.json"` |\n| `seed` |')
  assert.ok([...stepCommands(ghost).keys()].some(s => !STEPS.includes(s) && s !== 'done'))
  assert.ok(usageFlags(text.replace('[--budget N]', '[--budget N] [--changed a..b]')).some(f => !INIT_FLAGS.includes(f) && !SESSION_FLAGS.includes(f)))
  assert.ok(!usageFlags(text.replace('[--budget N]', '')).includes('--budget'))
})
