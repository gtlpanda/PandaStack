// CP-01c implementation cases beyond the frozen acceptance: install.sh --codex with a
// plan that shrinks after a backup, plan failures of every exit code, and installPlan's
// closure, ordering and input bounds. install.sh runs only from owned temp roots with
// an owned HOME and an explicit PANDASTACK_CODEX_SKILLS_DIR.
import { join, dirname } from 'node:path'
import { cpSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync,
  writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { spawnSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'
import assert from 'node:assert/strict'
import { test, REPO } from '../scripts/workflow-harness.mjs'
import { installPlan, installPlanMain } from '../core/skills/native-runtime/install-plan.mjs'

const PLAN = join(REPO, 'core/skills/native-runtime/install-plan.mjs')
// --codex refuses symlinked ancestors, and macOS keeps tmpdir under /var -> /private/var.
const TMP = realpathSync(tmpdir())
const NODE_DIR = dirname(process.execPath)
const row = (catalog, id) => catalog.offerings.find(o => o.id === id)
// The fixture base: this checkout's catalog with blueprint's codex row as it is before
// CP-04e (amended at the tier-4 freeze, W2-10), so these cases hold before and after it.
const production = () => {
  const catalog = JSON.parse(readFileSync(join(REPO, 'spec/offering-capabilities.json'), 'utf8'))
  row(catalog, 'blueprint').providers.codex = { implementation: 'unavailable', transportId: null,
    limitations: ['NATIVE_UNVERIFIED', 'NO_PROVIDER_TRANSPORT', 'REQUIREMENTS_INCOMPLETE'] }
  return catalog
}
const codeIs = code => e => { assert.equal(e.code, code); return true }

function owned(fn) {
  const dir = mkdtempSync(join(TMP, 'install-plan-'))
  try { return fn(dir) } finally { rmSync(dir, { recursive: true, force: true }) }
}

// A fixture repo: this checkout's install.sh and core/, the two shipped Codex entry
// sources, and the given catalog.
function makeRoot(parent, name, catalog = production()) {
  const root = join(parent, name)
  mkdirSync(join(root, 'spec'), { recursive: true })
  cpSync(join(REPO, 'install.sh'), join(root, 'install.sh'))
  cpSync(join(REPO, 'core'), join(root, 'core'), { recursive: true, verbatimSymlinks: true })
  for (const src of ['graphs/autobuild/skills/autobuild', 'graphs/hunt/skills/bughunt']) {
    cpSync(join(REPO, src), join(root, src), { recursive: true, verbatimSymlinks: true })
  }
  writeCatalog(root, catalog)
  return root
}
const writeCatalog = (root, catalog) =>
  writeFileSync(join(root, 'spec/offering-capabilities.json'), JSON.stringify(catalog, null, 2) + '\n')

// An extra install-eligible offering cloned from autobuild (same provider rows), first
// in the catalog. Its entry source is not created here.
function addOffering(catalog, id, dependencies) {
  const offering = structuredClone(row(catalog, 'autobuild'))
  Object.assign(offering, { id, source: `graphs/fixture/skills/${id}`, installTargets: [`skills/${id}`], dependencies,
    evidenceOwners: [], aliases: [] })
  catalog.offerings.unshift(offering)
  return catalog
}
function codexUnavailable(offering) {
  offering.providers.codex = { implementation: 'unavailable', transportId: null,
    limitations: ['NATIVE_UNVERIFIED', 'NO_PROVIDER_TRANSPORT', 'REQUIREMENTS_INCOMPLETE'] }
}

const env = extra => {
  const base = { ...process.env, PATH: `${NODE_DIR}:${process.env.PATH}`, TMPDIR: TMP, HARNESS_NO_GIT_CONFIG: '1' }
  for (const k of ['CLAUDE_CONFIG_DIR', 'PANDASTACK_BIN_DIR', 'PANDASTACK_CODEX_SKILLS_DIR']) delete base[k]
  return { ...base, ...extra }
}
const install = (root, home, skills, args = []) => spawnSync('bash', [join(root, 'install.sh'), '--codex', ...args],
  { encoding: 'utf8', cwd: TMP, env: env({ HOME: home, PANDASTACK_CODEX_SKILLS_DIR: skills }) })
const cli = args => spawnSync(process.execPath, [PLAN, ...args], { encoding: 'utf8', cwd: TMP, env: env() })
const ok = r => assert.equal(r.status, 0, r.stdout + r.stderr)
const isLink = p => { try { return lstatSync(p).isSymbolicLink() } catch { return false } }

await test('a backup whose entry later left the plan is refused at uninstall, never restored', () => owned(parent => {
  const root = makeRoot(parent, 'repo')
  const home = join(parent, 'home'), skills = join(home, '.agents/skills')
  mkdirSync(join(skills, 'autobuild'), { recursive: true })
  writeFileSync(join(skills, 'autobuild/SKILL.md'), 'mine')
  ok(install(root, home, skills))
  const backups = join(home, '.agents/.pandastack-codex-backups-skills')
  const [made] = readdirSync(backups)

  // autobuild loses Codex eligibility after its conflict was backed up.
  const catalog = production(); codexUnavailable(row(catalog, 'autobuild')); writeCatalog(root, catalog)
  const skip = install(root, home, skills, ['--skip=skills/autobuild'])
  assert.equal(skip.status, 1, 'a dest no longer in the plan is not a --skip name')
  assert.match(skip.stderr, /'skills\/autobuild' is not an install target/)
  for (const args of [['--uninstall', '--dry-run'], ['--uninstall']]) {
    const r = install(root, home, skills, args)
    assert.equal(r.status, 1, r.stdout + r.stderr)
    assert.match(r.stderr, /unsupported Codex backup target: skills\/autobuild/)
    assert.equal(readFileSync(join(backups, made, 'skills/autobuild/SKILL.md'), 'utf8'), 'mine', 'the backup copy stays')
  }
  // The uninstall loop unlinks planned entries before it reads the manifest (today's order).
  assert.equal(isLink(join(skills, 'bughunt')), false)
  assert.equal(isLink(join(skills, 'autobuild')), true, 'a link outside the plan is no longer ours to remove')
}))

await test('an empty plan installs and uninstalls nothing, and exits 0', () => owned(parent => {
  const catalog = production()
  for (const id of ['autobuild', 'bughunt']) codexUnavailable(row(catalog, id))
  const root = makeRoot(parent, 'repo', catalog)
  const home = join(parent, 'home'), skills = join(home, '.agents/skills')
  const r = install(root, home, skills); ok(r)
  assert.match(r.stdout, /done: 0 linked, 0 already linked/)
  // Today's install creates only the skills directory's parent; with nothing planned,
  // the skills directory itself is never made.
  assert.deepEqual(readdirSync(join(home, '.agents')), [])
  const un = install(root, home, skills, ['--uninstall']); ok(un)
  assert.match(un.stdout, /done: 0 unlinked/)
}))

await test('install.sh exits 2 on every plan failure, input refusal included, before any change', () => owned(parent => {
  // A control character in the repo path: the plan refuses its own input (exit 1).
  const odd = makeRoot(parent, 'repo\u0001ctl')
  const missingCatalog = makeRoot(parent, 'no-catalog')
  rmSync(join(missingCatalog, 'spec/offering-capabilities.json'))
  for (const [root, code] of [[odd, 'INVALID_INSTALL_PLAN_INPUT'], [missingCatalog, 'NOT_FOUND']]) {
    const home = join(parent, `home-${code}`); mkdirSync(home)
    for (const args of [[], ['--dry-run'], ['--uninstall']]) {
      const r = install(root, home, join(home, '.agents/skills'), args)
      assert.equal(r.status, 2, `${code} ${args.join(' ')}: ${r.stdout}${r.stderr}`)
      assert.equal(r.stdout, '', 'nothing is logged before the plan')
      assert.equal(r.stderr, `install-plan: ${code}\n`)
      assert.deepEqual(readdirSync(home), [], 'no skills directory, parent or backup root is created')
    }
  }
}))

await test('the dependency closure checks a planned offering that another one depends on', () => owned(parent => {
  // Diamond: a-b -> {ab, verify}, ab -> verify. Catalog order is ab first.
  const catalog = addOffering(addOffering(production(), 'a-b', ['ab', 'verify']), 'ab', ['verify'])
  const root = makeRoot(parent, 'repo', catalog)
  for (const id of ['ab', 'a-b']) {
    mkdirSync(join(root, 'graphs/fixture/skills', id), { recursive: true })
  }
  // Code-unit order: '-' (0x2d) sorts before 'b', and 'ab' before 'autobuild'.
  const expected = [
    { dest: 'skills/a-b', src: 'graphs/fixture/skills/a-b' },
    { dest: 'skills/ab', src: 'graphs/fixture/skills/ab' },
    { dest: 'skills/autobuild', src: 'graphs/autobuild/skills/autobuild' },
    { dest: 'skills/bughunt', src: 'graphs/hunt/skills/bughunt' },
  ]
  assert.deepEqual(installPlan({ installationRoot: root, backend: 'codex' }), expected)

  // a-b's own missing source is install.sh's concern; ab's is a missing dependency.
  rmSync(join(root, 'graphs/fixture/skills/a-b'), { recursive: true })
  assert.deepEqual(installPlan({ installationRoot: root, backend: 'codex' }), expected)
  rmSync(join(root, 'graphs/fixture/skills/ab'), { recursive: true })
  assert.throws(() => installPlan({ installationRoot: root, backend: 'codex' }), codeIs('DEPENDENCY_MISSING'))
}))

await test('a symlinked installation root plans and checks dependencies through its canonical root', () => owned(parent => {
  const root = makeRoot(parent, 'repo')
  const alias = join(parent, 'alias')
  symlinkSync(root, alias)
  const viaAlias = cli(['--installation-root', alias, '--backend', 'codex'])
  ok(viaAlias)
  assert.equal(viaAlias.stdout, 'skills/autobuild\tgraphs/autobuild/skills/autobuild\nskills/bughunt\tgraphs/hunt/skills/bughunt\n')
  rmSync(join(root, 'core/skills/verify'), { recursive: true })
  assert.throws(() => installPlan({ installationRoot: alias, backend: 'codex' }), codeIs('DEPENDENCY_MISSING'))
}))

await test('the root bound is 4096 bytes, and C0, DEL and C1 characters are refused', () => {
  const at = n => '/' + 'x'.repeat(n - 1)
  // Within bounds the input passes to the loader, whose realpath then fails: NOT_FOUND,
  // or IO_ERROR where the path exceeds the platform's PATH_MAX (macOS: 1024).
  assert.throws(() => installPlan({ installationRoot: at(4096), backend: 'codex' }),
    e => ['NOT_FOUND', 'IO_ERROR'].includes(e.code))
  assert.throws(() => installPlan({ installationRoot: at(4097), backend: 'codex' }), codeIs('INVALID_INSTALL_PLAN_INPUT'))
  // A multi-byte character counts by bytes: 4096 code units, 4097 bytes.
  assert.throws(() => installPlan({ installationRoot: at(4095) + 'é', backend: 'codex' }), codeIs('INVALID_INSTALL_PLAN_INPUT'))
  for (const c of ['\u0000', '\u0009', '\u001f', '\u007f', '\u0085', '\u009f']) {
    assert.throws(() => installPlan({ installationRoot: `/tmp/a${c}b`, backend: 'codex' }), codeIs('INVALID_INSTALL_PLAN_INPUT'))
  }
  assert.throws(() => installPlan({ installationRoot: '/tmp/no-such- -root', backend: 'codex' }), codeIs('NOT_FOUND'))
  assert.throws(() => installPlan(Object.assign(Object.create(null), { installationRoot: '/tmp/no-such-root', backend: 'codex' })),
    codeIs('NOT_FOUND'), 'a null-prototype object is a plain input')
  assert.throws(() => installPlan({ installationRoot: '/tmp/x', backend: 'codex', [Symbol('k')]: 1 }), codeIs('INVALID_INSTALL_PLAN_INPUT'))
})

await test('installPlanMain writes only the plan or one error line, and importing has no side effect', () => {
  const sink = () => { const chunks = []; return { chunks, write: s => { chunks.push(s); return true } } }
  const run = argv => { const out = sink(), err = sink(); return { status: installPlanMain(argv, out, err), out: out.chunks.join(''), err: err.chunks.join('') } }

  // This checkout's own plan: blueprint's line appears once CP-04e flips its codex row.
  const flipped = row(JSON.parse(readFileSync(join(REPO, 'spec/offering-capabilities.json'), 'utf8')), 'blueprint')
    .providers.codex.implementation === 'partial'
  assert.deepEqual(run(['--installation-root', REPO, '--backend', 'codex']), { status: 0,
    out: 'skills/autobuild\tgraphs/autobuild/skills/autobuild\n' +
      (flipped ? 'skills/blueprint\tgraphs/blueprint/skills/blueprint\n' : '') +
      'skills/bughunt\tgraphs/hunt/skills/bughunt\n', err: '' })
  assert.deepEqual(run(['--backend', 'codex', '--backend', 'codex']), { status: 1, out: '', err: 'install-plan: INVALID_INSTALL_PLAN_INPUT\n' })
  assert.deepEqual(run(['--installation-root', '/tmp/no-such-root', '--backend', 'codex']), { status: 2, out: '', err: 'install-plan: NOT_FOUND\n' })

  const imported = spawnSync(process.execPath, ['--input-type=module', '-e', `await import(${JSON.stringify(pathToFileURL(PLAN).href)})`],
    { encoding: 'utf8', cwd: TMP, env: env() })
  assert.deepEqual([imported.status, imported.stdout, imported.stderr], [0, '', ''])
})
