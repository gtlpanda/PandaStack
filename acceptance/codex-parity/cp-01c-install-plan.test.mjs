// CP-01c frozen acceptance: the Codex install plan comes from the catalog
// (spec/contracts/codex-parity-cp-01c.md). install-plan.mjs and install.sh are taken
// from PANDASTACK_CANDIDATE_ROOT (default: the repo root). install.sh runs only from
// owned temp fixture roots, each with an owned temp HOME and an explicit
// PANDASTACK_CODEX_SKILLS_DIR, so the real HOME is never touched. No network,
// provider, codex or claude process.
import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmodSync, cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync,
  realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = process.env.PANDASTACK_CANDIDATE_ROOT || fileURLToPath(new URL('../../', import.meta.url))
const PLAN = 'core/skills/native-runtime/install-plan.mjs'
const loadPlan = () => import(pathToFileURL(resolve(ROOT, PLAN)).href)
const loadCatalog = () => import(pathToFileURL(resolve(ROOT, 'core/skills/native-runtime/catalog.mjs')).href)
// macOS keeps the temp dir under /var -> /private/var; --codex refuses symlinked ancestors.
const TMP = realpathSync(tmpdir())
const NODE_DIR = dirname(process.execPath)
const BASH = spawnSync('bash', ['-c', 'command -v bash'], { encoding: 'utf8' }).stdout.trim() || '/bin/bash'
const sha = bytes => createHash('sha256').update(bytes).digest('hex')
const coded = code => e => e instanceof Error && e.code === code
const isLink = p => { try { return lstatSync(p).isSymbolicLink() } catch { return false } }

const PRODUCTION_LINES = 'skills/autobuild\tgraphs/autobuild/skills/autobuild\nskills/bughunt\tgraphs/hunt/skills/bughunt\n'
const PRODUCTION_PLAN = [
  { dest: 'skills/autobuild', src: 'graphs/autobuild/skills/autobuild' },
  { dest: 'skills/bughunt', src: 'graphs/hunt/skills/bughunt' },
]
// Amended at the CP-04e freeze (W2-10): CP-04e makes blueprint Codex install-eligible.
// The candidate-root case accepts exactly today's plan or CP-04e's (pinned by its own
// test), and every fixture root sets blueprint's codex row unavailable itself.
const CP04E_LINES = 'skills/autobuild\tgraphs/autobuild/skills/autobuild\n' +
  'skills/blueprint\tgraphs/blueprint/skills/blueprint\nskills/bughunt\tgraphs/hunt/skills/bughunt\n'
const CP04E_PLAN = [
  { dest: 'skills/autobuild', src: 'graphs/autobuild/skills/autobuild' },
  { dest: 'skills/blueprint', src: 'graphs/blueprint/skills/blueprint' },
  { dest: 'skills/bughunt', src: 'graphs/hunt/skills/bughunt' },
]
// Amended for CP-06: dev joins the installed set once its codex row is partial. Fixture
// roots set dev's row unavailable themselves (the skills/dev --skip case needs it absent).
const CP06_LINE = 'skills/dev\tgraphs/dev/skills/dev\n'
const THIRD_SRC = 'graphs/fixture/skills/third'
const THREE_LINES = PRODUCTION_LINES + `skills/third\t${THIRD_SRC}\n`
// The frozen tests/install-codex.test.mjs, byte for byte.
const INSTALL_CODEX_SHA256 = '1863b084ec849c24ca98670a724d8cdd250157070458aae41f29749015e394f6'
const INSTALL_CODEX_CASES = 7

// ---------------------------------------------------------------- fixtures

function owned(t, prefix = 'cp01c-') {
  const dir = mkdtempSync(join(TMP, prefix))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

const candidate = () => JSON.parse(readFileSync(join(ROOT, 'spec/offering-capabilities.json'), 'utf8'))
const row = (catalog, id) => catalog.offerings.find(o => o.id === id)
// The fixture base: the candidate catalog with blueprint's and dev's codex rows as they are before CP-04e and CP-06.
const production = () => {
  const catalog = candidate()
  codexUnavailable(row(catalog, 'blueprint'))
  codexUnavailable(row(catalog, 'dev'))
  return catalog
}

// Works for either catalog version: the accessor decides, so the test must not care.
function codexUnavailable(offering) {
  if (offering.providers) {
    offering.providers.codex = { implementation: 'unavailable', transportId: null,
      limitations: ['NATIVE_UNVERIFIED', 'NO_PROVIDER_TRANSPORT', 'REQUIREMENTS_INCOMPLETE'] }
  } else {
    offering.codexInstallEligible = false
    offering.nativeImplementation = 'not-certified'
  }
}

// A third install-eligible entry, cloned from autobuild (same provider rows), placed
// first in the catalog so catalog order differs from dest order. skills/dev is marked
// codexInstaller in installerTargets while its provider stays unavailable: a decoy
// for a plan that reads codexInstaller instead of installEligible.
function withThird(catalog, dependencies = ['verify']) {
  const third = structuredClone(row(catalog, 'autobuild'))
  Object.assign(third, { id: 'third', source: THIRD_SRC, installTargets: ['skills/third'], dependencies,
    evidenceOwners: [], aliases: [] })
  catalog.offerings.unshift(third)
  catalog.installerTargets.find(t => t.target === 'skills/dev').codexInstaller = true
  return catalog
}

// A fixture repo root: the candidate's install.sh and core/, the two shipped Codex
// entry sources, a third entry source, and the given catalog.
function makeRoot(parent, name, catalog = production()) {
  const root = join(parent, name)
  mkdirSync(join(root, 'spec'), { recursive: true })
  cpSync(join(ROOT, 'install.sh'), join(root, 'install.sh'))
  chmodSync(join(root, 'install.sh'), 0o755)
  cpSync(join(ROOT, 'core'), join(root, 'core'), { recursive: true, verbatimSymlinks: true })
  for (const src of ['graphs/autobuild/skills/autobuild', 'graphs/hunt/skills/bughunt']) {
    cpSync(join(ROOT, src), join(root, src), { recursive: true, verbatimSymlinks: true })
  }
  mkdirSync(join(root, THIRD_SRC), { recursive: true })
  writeFileSync(join(root, THIRD_SRC, 'SKILL.md'), '---\nname: third\n---\nfixture entry\n')
  writeCatalog(root, catalog)
  return root
}
const writeCatalog = (root, catalog) =>
  writeFileSync(join(root, 'spec/offering-capabilities.json'), JSON.stringify(catalog, null, 2) + '\n')

function baseEnv(extra = {}) {
  const env = { ...process.env, PATH: `${NODE_DIR}:${process.env.PATH}`, TMPDIR: TMP, HARNESS_NO_GIT_CONFIG: '1' }
  for (const k of ['CLAUDE_CONFIG_DIR', 'PANDASTACK_BIN_DIR', 'PANDASTACK_CODEX_SKILLS_DIR']) delete env[k]
  return { ...env, ...extra }
}

// install-plan CLI, from planRoot's copy of the module.
function plan(root, args = ['--installation-root', root, '--backend', 'codex'], planRoot = ROOT) {
  return spawnSync(process.execPath, [join(planRoot, PLAN), ...args], { encoding: 'utf8', env: baseEnv(), cwd: TMP })
}
const planOk = (r, lines) => {
  assert.equal(r.stderr, '', 'stderr is empty on success')
  assert.equal(r.status, 0, 'install-plan exits 0')
  assert.equal(r.stdout, lines)
}
const planFails = (r, code, status = 2) => {
  assert.equal(r.status, status, `install-plan exits ${status} for ${code}: ${r.stderr}`)
  assert.equal(r.stdout, '', 'stdout is empty on failure')
  assert.equal(r.stderr, `install-plan: ${code}\n`)
}

// install.sh --codex from a fixture root.
function install(root, home, skills, args = [], extra = {}) {
  return spawnSync(BASH, [join(root, 'install.sh'), '--codex', ...args],
    { encoding: 'utf8', cwd: TMP, env: baseEnv({ HOME: home, PANDASTACK_CODEX_SKILLS_DIR: skills, ...extra }) })
}
const ok = r => assert.equal(r.status, 0, r.stdout + r.stderr)

// Every path, link target, file hash and mode under dir.
function snapshot(dir) {
  const out = []
  const walk = (p, rel) => {
    let st
    try { st = lstatSync(p) } catch { out.push(`${rel} absent`); return }
    if (st.isSymbolicLink()) out.push(`${rel} -> ${readlinkSync(p)}`)
    else if (st.isDirectory()) {
      out.push(`${rel}/ ${st.mode & 0o777}`)
      for (const n of readdirSync(p).sort()) walk(join(p, n), `${rel}/${n}`)
    } else out.push(`${rel} = ${sha(readFileSync(p))} ${st.mode & 0o777}`)
  }
  walk(dir, '.')
  return out.join('\n')
}

// ---------------------------------------------------------------- cases

test('install-plan prints exactly the two current dest<TAB>src lines for the candidate root (three once CP-04e flips blueprint)', async () => {
  const flipped = row(candidate(), 'blueprint').providers?.codex?.implementation === 'partial'
  const devFlipped = row(candidate(), 'dev').providers?.codex?.implementation === 'partial'
  const lines = (flipped ? CP04E_LINES : PRODUCTION_LINES) + (devFlipped ? CP06_LINE : '')
  planOk(plan(ROOT), lines)
  planOk(plan(ROOT, ['--backend', 'codex', '--installation-root', ROOT]), lines)

  const { installPlan } = await loadPlan()
  assert.equal(typeof installPlan, 'function', 'install-plan.mjs exports installPlan')
  const result = installPlan({ installationRoot: ROOT, backend: 'codex' })
  assert.deepEqual(result, [...(flipped ? CP04E_PLAN : PRODUCTION_PLAN), ...(devFlipped ? [{ dest: 'skills/dev', src: 'graphs/dev/skills/dev' }] : [])])
  for (const entry of result) assert.deepEqual(Object.keys(entry), ['dest', 'src'])
  assert.deepEqual(installPlan({ installationRoot: ROOT, backend: 'codex' }), result, 'same result on every call')

  // The plan is the accessor's answer over the catalog, nothing else.
  const { loadOfferingCatalog, installEligible } = await loadCatalog()
  const catalog = loadOfferingCatalog({ installationRoot: ROOT })
  const expected = catalog.offerings.filter(o => installEligible(o, 'codex'))
    .flatMap(o => o.installTargets.map(dest => ({ dest, src: o.source })))
    .sort((a, b) => (a.dest < b.dest ? -1 : a.dest > b.dest ? 1 : 0))
  assert.deepEqual(result, expected)
})

test('tests/install-codex.test.mjs is unchanged and passes', t => {
  const file = join(ROOT, 'tests/install-codex.test.mjs')
  assert.equal(sha(readFileSync(file)), INSTALL_CODEX_SHA256, 'tests/install-codex.test.mjs is the frozen file')
  const home = owned(t, 'cp01c-home-')
  const r = spawnSync(process.execPath, [file], { encoding: 'utf8', cwd: ROOT, env: baseEnv({ HOME: home }), timeout: 180000 })
  assert.equal(r.status, 0, r.stdout + r.stderr)
  const lines = r.stdout.split('\n')
  assert.equal(lines.filter(l => l.startsWith('  FAIL ')).length, 0, r.stdout)
  assert.equal(lines.filter(l => l.startsWith('  ok   ')).length, INSTALL_CODEX_CASES, r.stdout)
  assert.deepEqual(readdirSync(home), [], 'the inherited HOME stays untouched')
})

test('the plan follows installEligible: not catalog order, codexInstaller, entry hashes or entry presence', async t => {
  const parent = owned(t)

  // A third eligible entry, first in the catalog, plus the skills/dev codexInstaller decoy.
  const three = makeRoot(parent, 'three', withThird(production()))
  const before = snapshot(three)
  planOk(plan(three), THREE_LINES)
  planOk(plan(three, undefined, three), THREE_LINES)
  assert.equal(snapshot(three), before, 'the plan writes nothing')

  // autobuild loses Codex eligibility: its fixed line is gone.
  const catalog = production(); codexUnavailable(row(catalog, 'autobuild'))
  planOk(plan(makeRoot(parent, 'no-autobuild', catalog)), 'skills/bughunt\tgraphs/hunt/skills/bughunt\n')

  // No eligible offering: an empty plan is valid.
  const none = production(); for (const id of ['autobuild', 'bughunt']) codexUnavailable(row(none, id))
  planOk(plan(makeRoot(parent, 'none', none)), '')

  // The v1 snapshot (same inventory, v1 shape) gives the same plan.
  const v1 = JSON.parse(readFileSync(new URL('../native-runtime/oc-01-catalog.fixture.json', import.meta.url), 'utf8'))
  planOk(plan(makeRoot(parent, 'v1', v1)), PRODUCTION_LINES)

  // A drifted SKILL.md is not the installer's concern (the drift guard owns hashes).
  const drifted = makeRoot(parent, 'drifted')
  writeFileSync(join(drifted, 'graphs/autobuild/skills/autobuild/SKILL.md'), 'edited without a catalog update\n')
  planOk(plan(drifted), PRODUCTION_LINES)

  // A missing entry source stays in the plan; install.sh keeps skipping it.
  const gone = makeRoot(parent, 'gone')
  rmSync(join(gone, 'graphs/autobuild/skills/autobuild'), { recursive: true })
  planOk(plan(gone), PRODUCTION_LINES)
  const home = join(parent, 'home-gone'), skills = join(home, '.agents/skills')
  mkdirSync(home)
  const r = install(gone, home, skills); ok(r)
  assert.match(r.stdout, /skip \(missing in repo\): skills\/autobuild/)
  assert.deepEqual(readdirSync(skills), ['bughunt'])
})

test('install.sh --codex links a third eligible entry once, honors --skip, and restores a conflict on --uninstall', t => {
  const parent = owned(t)
  const root = makeRoot(parent, 'repo', withThird(production()))
  const home = join(parent, 'home'), skills = join(home, '.agents/skills')
  mkdirSync(join(skills, 'third'), { recursive: true })
  mkdirSync(join(skills, 'foreign'))
  writeFileSync(join(skills, 'third/SKILL.md'), 'mine')
  writeFileSync(join(skills, 'foreign/SKILL.md'), 'foreign')

  // A node shim counts install.sh's node calls.
  const shim = join(parent, 'shim'), log = join(parent, 'node-calls.log')
  mkdirSync(shim)
  writeFileSync(join(shim, 'node'), `#!/bin/sh\nprintf '%s\\n' "$*" >> '${log}'\nexec '${process.execPath}' "$@"\n`)
  chmodSync(join(shim, 'node'), 0o755)
  const counted = { PATH: `${shim}:${NODE_DIR}:${process.env.PATH}` }
  const calls = () => (existsSync(log) ? readFileSync(log, 'utf8').split('\n').filter(Boolean) : [])
  const backups = join(home, '.agents/.pandastack-codex-backups-skills')

  const seeded = snapshot(home)
  const notInPlan = install(root, home, skills, ['--skip=skills/dev'])
  assert.notEqual(notInPlan.status, 0, 'skills/dev is not in the plan')
  assert.match(notInPlan.stderr, /is not an install target/)
  assert.equal(snapshot(home), seeded)

  ok(install(root, home, skills, ['--dry-run']))
  assert.equal(snapshot(home), seeded, 'dry-run changes nothing')

  const skipped = install(root, home, skills, ['--skip=skills/third']); ok(skipped)
  assert.match(skipped.stdout, /skip \(--skip\): skills\/third/)
  assert.equal(readFileSync(join(skills, 'third/SKILL.md'), 'utf8'), 'mine', '--skip leaves the conflict alone')
  assert.equal(existsSync(backups), false, 'a skipped entry is never backed up')
  assert.deepEqual(readdirSync(skills).sort(), ['autobuild', 'bughunt', 'foreign', 'third'])

  rmSync(log, { force: true })
  const full = install(root, home, skills, [], counted); ok(full)
  const planCalls = calls()
  assert.equal(planCalls.length, 1, `install.sh runs node exactly once: ${planCalls.join(' | ')}`)
  assert.match(planCalls[0], /install-plan\.mjs/)
  assert.match(full.stdout, /backed up: skills\/third/)
  assert.match(full.stdout, /done: 1 linked, 2 already linked/)
  for (const [name, src] of [['autobuild', 'graphs/autobuild/skills/autobuild'], ['bughunt', 'graphs/hunt/skills/bughunt'],
    ['third', THIRD_SRC]]) {
    assert.equal(readlinkSync(join(skills, name)), join(root, src))
  }
  const dirs = readdirSync(backups)
  assert.equal(dirs.length, 1)
  assert.equal(readFileSync(join(backups, dirs[0], 'skills/third/SKILL.md'), 'utf8'), 'mine')

  const again = install(root, home, skills); ok(again)
  assert.match(again.stdout, /done: 0 linked, 3 already linked/)
  assert.deepEqual(readdirSync(skills).sort(), ['autobuild', 'bughunt', 'foreign', 'third'])
  assert.equal(readdirSync(backups).length, 1)

  const dry = install(root, home, skills, ['--uninstall', '--dry-run']); ok(dry)
  assert.equal(isLink(join(skills, 'third')), true, 'dry-run uninstall changes nothing')
  const un = install(root, home, skills, ['--uninstall']); ok(un)
  assert.match(un.stdout, /restored: skills\/third/)
  assert.deepEqual(readdirSync(skills).sort(), ['foreign', 'third'])
  assert.equal(readFileSync(join(skills, 'third/SKILL.md'), 'utf8'), 'mine')
  assert.equal(readFileSync(join(skills, 'foreign/SKILL.md'), 'utf8'), 'foreign')
})

test('paths with spaces and colons work through the plan, install and uninstall', async t => {
  const parent = owned(t)
  const root = makeRoot(parent, 'repo dir: one', withThird(production()))
  const home = join(parent, 'home: two'), skills = join(home, 'agent skills: x')
  planOk(plan(root), THREE_LINES)
  const { installPlan } = await loadPlan()
  assert.equal(installPlan({ installationRoot: root, backend: 'codex' }).length, 3)

  mkdirSync(join(skills, 'autobuild'), { recursive: true })
  writeFileSync(join(skills, 'autobuild/SKILL.md'), 'mine')
  ok(install(root, home, skills))
  for (const [name, src] of [['autobuild', 'graphs/autobuild/skills/autobuild'], ['bughunt', 'graphs/hunt/skills/bughunt'],
    ['third', THIRD_SRC]]) {
    assert.equal(readlinkSync(join(skills, name)), join(root, src))
  }
  const backups = join(home, '.pandastack-codex-backups-agent skills: x')
  assert.equal(readFileSync(join(backups, readdirSync(backups)[0], 'skills/autobuild/SKILL.md'), 'utf8'), 'mine')
  ok(install(root, home, skills, ['--uninstall']))
  assert.deepEqual(readdirSync(skills), ['autobuild'])
  assert.equal(readFileSync(join(skills, 'autobuild/SKILL.md'), 'utf8'), 'mine')
})

test('a missing dependency source exits 2 with DEPENDENCY_MISSING, empty stdout and an untouched target', async t => {
  const parent = owned(t)
  const { installPlan } = await loadPlan()
  const refuses = (root, code = 'DEPENDENCY_MISSING') => {
    planFails(plan(root), code)
    assert.throws(() => installPlan({ installationRoot: root, backend: 'codex' }), e => {
      assert.equal(e.code, code)
      assert.ok(!String(e.message).includes(root), 'the message never echoes the root')
      return true
    })
  }

  // Direct: bughunt's declared dependency verify (CP-01b) is gone.
  assert.ok(row(production(), 'bughunt').dependencies.includes('verify'), 'CP-01b declares bughunt -> verify')
  const root = makeRoot(parent, 'repo')
  const home = join(parent, 'home'), skills = join(home, '.agents/skills')
  mkdirSync(join(skills, 'foreign'), { recursive: true })
  writeFileSync(join(skills, 'foreign/SKILL.md'), 'foreign')
  ok(install(root, home, skills))
  mkdirSync(join(parent, 'fresh'))
  rmSync(join(root, 'core/skills/verify'), { recursive: true })
  refuses(root)
  const installed = snapshot(home)
  for (const args of [[], ['--dry-run'], ['--uninstall'], ['--uninstall', '--dry-run']]) {
    const r = install(root, home, skills, args)
    assert.equal(r.status, 2, `install.sh ${args.join(' ')} exits 2: ${r.stdout}${r.stderr}`)
    assert.ok(r.stderr.includes('install-plan: DEPENDENCY_MISSING'), r.stderr)
    assert.equal(snapshot(home), installed, `install.sh ${args.join(' ')} leaves the target untouched`)
    const fresh = install(root, join(parent, 'fresh'), join(parent, 'fresh/.agents/skills'), args)
    assert.equal(fresh.status, 2)
    assert.deepEqual(readdirSync(join(parent, 'fresh')), [], 'no skills directory or backup root is created')
  }

  // Two hops: third -> gtm-brief -> harness-review, and harness-review is gone.
  const chain = withThird(production(), ['gtm-brief'])
  row(chain, 'gtm-brief').dependencies = ['harness-review']
  const twoHop = makeRoot(parent, 'two-hop', chain)
  planOk(plan(twoHop), THREE_LINES)
  rmSync(join(twoHop, 'core/skills/harness-review'), { recursive: true })
  refuses(twoHop)

  // A regular file or a symlink is not a real directory.
  const file = makeRoot(parent, 'file')
  rmSync(join(file, 'core/skills/verify'), { recursive: true })
  writeFileSync(join(file, 'core/skills/verify'), 'not a directory')
  refuses(file)
  const link = makeRoot(parent, 'link')
  cpSync(join(link, 'core/skills/verify'), join(parent, 'verify-elsewhere'), { recursive: true })
  rmSync(join(link, 'core/skills/verify'), { recursive: true })
  symlinkSync(join(parent, 'verify-elsewhere'), join(link, 'core/skills/verify'))
  refuses(link)

  // Any other lstat failure is IO_ERROR, not DEPENDENCY_MISSING.
  if (typeof process.getuid === 'function' && process.getuid() !== 0) {
    const locked = makeRoot(parent, 'locked')
    chmodSync(join(locked, 'core/skills'), 0o000)
    try { refuses(locked, 'IO_ERROR') } finally { chmodSync(join(locked, 'core/skills'), 0o755) }
  }
})

test('uninstall never restores anything outside the plan', t => {
  const parent = owned(t)
  const root = makeRoot(parent, 'repo', withThird(production()))
  const home = join(parent, 'home'), agents = join(home, '.agents'), skills = join(agents, 'skills')
  mkdirSync(join(skills, 'third'), { recursive: true })
  writeFileSync(join(skills, 'third/SKILL.md'), 'mine')
  ok(install(root, home, skills))
  const backups = join(agents, '.pandastack-codex-backups-skills')
  const [made] = readdirSync(backups)
  assert.equal(readFileSync(join(backups, made, '.harness-manifest'), 'utf8'), 'skills/third\n')

  // A newer backup naming one target outside the plan. Each is refused and never restored.
  const outside = [
    ['skills/foreign', join(skills, 'foreign')],
    ['skills/../escape', join(agents, 'escape')],
    ['skills/third/../../escape', join(agents, 'escape')],
    ['local-bin/autobuild', join(home, '.local/bin/autobuild')],
    ['settings.json', join(agents, 'settings.json')],
  ]
  for (const [rel, dest] of outside) {
    const newer = join(backups, 'zz-newest')
    mkdirSync(dirname(resolve(newer, rel)), { recursive: true })
    writeFileSync(resolve(newer, rel), 'outside')
    writeFileSync(join(newer, '.harness-manifest'), `${rel}\n`)
    for (const args of [['--uninstall', '--dry-run'], ['--uninstall']]) {
      const r = install(root, home, skills, args)
      assert.notEqual(r.status, 0, `${rel} is refused (${args.join(' ')})`)
      assert.match(r.stderr, /unsupported Codex backup target/)
      assert.equal(existsSync(dest) || isLink(dest), false, `${rel} is never restored`)
      assert.equal(readFileSync(resolve(newer, rel), 'utf8'), 'outside', 'its backup copy stays')
    }
    rmSync(newer, { recursive: true })
    ok(install(root, home, skills))
  }

  // The real backup, with an outside line appended after the planned one.
  writeFileSync(join(backups, made, '.harness-manifest'), 'skills/third\nskills/foreign\n')
  mkdirSync(join(backups, made, 'skills/foreign'))
  writeFileSync(join(backups, made, 'skills/foreign/SKILL.md'), 'outside')
  const r = install(root, home, skills, ['--uninstall'])
  assert.notEqual(r.status, 0)
  assert.match(r.stderr, /unsupported Codex backup target/)
  assert.equal(existsSync(join(skills, 'foreign')), false, 'skills/foreign is never restored')
  assert.equal(readFileSync(join(backups, made, 'skills/foreign/SKILL.md'), 'utf8'), 'outside')
})

test('install-plan rejects bad input with exit 1 and passes catalog errors through with exit 2, never echoing input', async t => {
  const parent = owned(t, 'cp01c-SENTINEL-')
  const SENTINEL = 'SENTINEL'
  const valid = makeRoot(parent, 'repo')

  for (const args of [
    [],
    ['--installation-root', valid],
    ['--backend', 'codex'],
    ['--installation-root', valid, '--backend'],
    ['--installation-root', valid, '--backend', 'codex', 'extra'],
    ['--installation-root', valid, '--backend', 'codex', '--backend', 'codex'],
    ['--installation-root', valid, '--installation-root', valid],
    [`--installation-root=${valid}`, '--backend', 'codex'],
    ['--installation-root', valid, '--backend=codex'],
    ['--installation-root', valid, '--skip', 'codex'],
    ['--installation-root', `relative/${SENTINEL}`, '--backend', 'codex'],
    ['--installation-root', '', '--backend', 'codex'],
    ['--installation-root', `${valid}/\u0007${SENTINEL}`, '--backend', 'codex'],
    ['--installation-root', valid, '--backend', 'claude'],
    ['--installation-root', valid, '--backend', 'CODEX'],
  ]) planFails(plan(valid, args), 'INVALID_INSTALL_PLAN_INPUT', 1)

  const { installPlan } = await loadPlan()
  let hookRan = false
  const getter = Object.defineProperty({ backend: 'codex' }, 'installationRoot',
    { enumerable: true, get() { hookRan = true; return valid } })
  for (const input of [
    undefined, null, 'codex', 42, [], {},
    { installationRoot: valid },
    { installationRoot: valid, backend: 'codex', extra: true },
    { installationRoot: `relative/${SENTINEL}`, backend: 'codex' },
    { installationRoot: `/${SENTINEL}/`.padEnd(5000, 'x'), backend: 'codex' },
    { installationRoot: `${valid}\n${SENTINEL}`, backend: 'codex' },
    { installationRoot: 42, backend: 'codex' },
    { installationRoot: valid, backend: 'claude' },
    getter,
    new Proxy({ installationRoot: valid, backend: 'codex' }, {}),
    Object.assign(Object.create({ inherited: true }), { installationRoot: valid, backend: 'codex' }),
  ]) {
    assert.throws(() => installPlan(input), e => {
      assert.equal(e.code, 'INVALID_INSTALL_PLAN_INPUT')
      assert.ok(!String(e.message).includes(SENTINEL), 'the message never echoes input')
      return true
    })
  }
  assert.equal(hookRan, false, 'no getter runs')

  const absent = join(parent, `absent-${SENTINEL}`)
  planFails(plan(absent), 'NOT_FOUND')
  const empty = join(parent, 'empty'); mkdirSync(empty)
  planFails(plan(empty), 'NOT_FOUND')
  const garbled = join(parent, 'garbled'); mkdirSync(join(garbled, 'spec'), { recursive: true })
  writeFileSync(join(garbled, 'spec/offering-capabilities.json'), `{"${SENTINEL}": `)
  planFails(plan(garbled), 'INVALID_CATALOG')
  const future = join(parent, 'future'); mkdirSync(join(future, 'spec'), { recursive: true })
  writeFileSync(join(future, 'spec/offering-capabilities.json'), JSON.stringify({ ...production(), schemaVersion: 3 }))
  planFails(plan(future), 'INVALID_CATALOG')
  const regular = join(parent, 'regular-file'); writeFileSync(regular, SENTINEL)
  planFails(plan(regular), 'INVALID_CATALOG_INPUT')
  assert.throws(() => installPlan({ installationRoot: absent, backend: 'codex' }), coded('NOT_FOUND'))
})

test('install.sh --codex without node on PATH exits 2 and changes nothing', t => {
  const parent = owned(t)
  const root = makeRoot(parent, 'repo')
  // Every system tool except node.
  const farm = join(parent, 'farm'); mkdirSync(farm)
  for (const dir of ['/usr/bin', '/bin', '/usr/sbin', '/sbin']) {
    let names = []
    try { names = readdirSync(dir) } catch { continue }
    for (const name of names) {
      if (/^node(js)?$/.test(name) || existsSync(join(farm, name))) continue
      try { symlinkSync(join(dir, name), join(farm, name)) } catch {}
    }
  }
  assert.equal(spawnSync(BASH, ['-c', 'command -v node'], { env: { PATH: farm } }).status, 1, 'node is not on the farm PATH')
  const home = join(parent, 'home'), skills = join(home, '.agents/skills')
  mkdirSync(join(skills, 'autobuild'), { recursive: true })
  writeFileSync(join(skills, 'autobuild/SKILL.md'), 'mine')
  const seeded = snapshot(home)
  for (const args of [[], ['--dry-run'], ['--uninstall']]) {
    const r = install(root, home, skills, args, { PATH: farm })
    assert.equal(r.status, 2, `${args.join(' ')}: ${r.stdout}${r.stderr}`)
    assert.match(r.stderr, /--codex needs node/)
    assert.equal(snapshot(home), seeded)
  }
})
