// CP-01b frozen acceptance: the production catalog as v2, with a drift guard
// (spec/contracts/codex-parity-cp-01b.md). Offline and static: no HOME, network,
// provider or child process. The production checks read the candidate root's own
// files and derive the dependency edges here; the guard cases use owned temp roots.
// The v1 reference is the frozen OC-01 fixture, byte-identical to the v1 catalog.
import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join, posix, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createHash } from 'node:crypto'

const ROOT = process.env.PANDASTACK_CANDIDATE_ROOT || fileURLToPath(new URL('../../', import.meta.url))
const loadCatalog = () => import(pathToFileURL(resolve(ROOT, 'core/skills/native-runtime/catalog.mjs')))
const loadRoles = () => import(pathToFileURL(resolve(ROOT, 'core/skills/native-runtime/role-files.mjs')))
const sha = bytes => createHash('sha256').update(bytes).digest('hex')
const production = () => JSON.parse(readFileSync(resolve(ROOT, 'spec/offering-capabilities.json'), 'utf8'))
const v1Snapshot = () => JSON.parse(readFileSync(new URL('../native-runtime/oc-01-catalog.fixture.json', import.meta.url), 'utf8'))
const coded = code => e => e instanceof Error && e.code === code

async function guard() {
  const api = await loadCatalog()
  assert.equal(typeof api.checkCatalogDrift, 'function', 'catalog.mjs exports checkCatalogDrift')
  return api.checkCatalogDrift
}

const TRANSPORTS = [
  { id: 'claude-code', provider: 'claude', entry: 'install.sh' },
  { id: 'codex-autobuild', provider: 'codex', entry: 'graphs/autobuild/tool/lib/codex.mjs' },
  { id: 'codex-bughunt', provider: 'codex', entry: 'graphs/hunt/skills/bughunt/native-runner.mjs' },
]
const CODEX_PARTIAL = { autobuild: 'codex-autobuild', bughunt: 'codex-bughunt' }
// Amended at the CP-04e freeze (W2-10). CP-04e flips blueprint's codex row and adds one
// shared transport. These pins accept exactly two states: today's, or exactly CP-04e's.
// acceptance/codex-parity/cp-04e-blueprint-codex.test.mjs pins the CP-04e state itself.
const CP04E_TRANSPORT = { id: 'codex-graph-host', provider: 'codex', entry: 'core/skills/native-runtime/graph-host.mjs' }
const CP04E_BLUEPRINT_CODEX = { implementation: 'partial', transportId: 'codex-graph-host',
  limitations: ['LIVE_PROOF_MISSING', 'NATIVE_UNVERIFIED', 'REQUIREMENTS_INCOMPLETE'] }
// Amended for CP-06: dev's flipped row is exactly blueprint's (same transport, same limitations).
const cp04eFlipped = row => (row.id === 'blueprint' || row.id === 'dev') &&
  JSON.stringify(row.providers.codex) === JSON.stringify(CP04E_BLUEPRINT_CODEX)
const SHARED_FIELDS = ['id', 'kind', 'source', 'entrySkill', 'installTargets', 'nativeReadiness',
  'evidenceOwners', 'requiredRuntimes', 'aliases', 'requirementsComplete']

// ---- the contract's derivation rules, written independently of the guard ----

const MENTION = /skills\/([a-z0-9][a-z0-9-]*)\//g
const STATIC_IMPORT = /^[ \t]*(?:import|export)\b[^;'"`]*?\bfrom[ \t]*(['"])([^'"\n]+)\1|^[ \t]*import[ \t]*(['"])([^'"\n]+)\3/gm

// Real skill directories under core/skills, kit/skills and graphs/<g>/skills.
function skillDirectories(root) {
  const realDirs = rel => existsSync(join(root, rel))
    ? readdirSync(join(root, rel), { withFileTypes: true }).filter(d => d.isDirectory()).map(d => d.name) : []
  const containers = ['core/skills', 'kit/skills', ...realDirs('graphs').map(g => `graphs/${g}/skills`)]
  return containers.flatMap(c => realDirs(c).map(name => `${c}/${name}`)).sort()
}

function codeFiles(root, rel) {
  return readdirSync(join(root, rel), { withFileTypes: true }).flatMap(d => {
    const path = `${rel}/${d.name}`
    if (d.isDirectory()) return codeFiles(root, path)
    return d.isFile() && /\.(mjs|js|cjs)$/.test(d.name) ? [path] : []
  })
}

// Map of offering id -> Map of dependency id -> reasons.
async function derivedEdges(root, catalog) {
  const { loadRoleFile } = await loadRoles()
  const ids = new Set(catalog.offerings.map(o => o.id))
  const edges = new Map(catalog.offerings.map(o => [o.id, new Map()]))
  const add = (from, to, why) => {
    if (to === from || !ids.has(to)) return
    const reasons = edges.get(from)
    reasons.set(to, [...(reasons.get(to) ?? []), why])
  }
  for (const workflow of catalog.workflows) {
    const graph = /^graphs\/([^/]+)\/workflows\//.exec(workflow.source)?.[1]
    const owners = catalog.offerings.filter(o => graph && o.entrySkill && o.source.startsWith(`graphs/${graph}/skills/`))
    for (const role of workflow.roles) {
      const { skills } = loadRoleFile({ installationRoot: root, name: role }).frontmatter
      for (const owner of owners) for (const skill of skills) add(owner.id, skill, `role ${role}`)
    }
  }
  for (const offering of catalog.offerings) {
    if (offering.entrySkill) {
      for (const m of readFileSync(join(root, offering.source, 'SKILL.md'), 'utf8').matchAll(MENTION)) add(offering.id, m[1], 'SKILL.md mention')
    }
    for (const file of codeFiles(root, offering.source)) {
      for (const m of readFileSync(join(root, file), 'utf8').matchAll(STATIC_IMPORT)) {
        const specifier = m[2] ?? m[4]
        if (!specifier.startsWith('.')) continue
        const target = /^core\/skills\/([^/]+)\//.exec(posix.join(posix.dirname(file), specifier))?.[1]
        if (target) add(offering.id, target, `import in ${file}`)
      }
    }
  }
  return edges
}

// ---- production catalog --------------------------------------------------------

test('the production catalog is v2 and valid, with the v1 counts', async () => {
  const api = await loadCatalog()
  const catalog = production()
  assert.equal(catalog.schemaVersion, 2, 'spec/offering-capabilities.json is v2')
  assert.deepEqual(api.validateCatalog(catalog), [])
  assert.deepEqual(api.loadOfferingCatalog({ installationRoot: ROOT }), catalog)
  assert.equal(catalog.offerings.length, 46)
  assert.equal(catalog.workflows.length, 6)
  assert.equal(catalog.assets.length, 46)
  assert.equal(catalog.fixedTargets.length, 4)
})

test('offering ids and sources equal the skill directories on disk', () => {
  const catalog = production()
  assert.deepEqual(catalog.offerings.map(o => o.source).sort(), skillDirectories(ROOT))
  for (const offering of catalog.offerings) assert.equal(offering.id, basename(offering.source), offering.source)
})

test('same inventory and derived values as the v1 snapshot', async () => {
  const api = await loadCatalog()
  const catalog = production(), v1 = v1Snapshot()
  assert.equal(catalog.schemaVersion, 2)
  for (const key of ['status', 'inventorySha256', 'limits', 'assets', 'fixedTargets', 'installerTargets', 'aliases']) {
    assert.deepEqual(catalog[key], v1[key], key)
  }
  assert.equal(catalog.inventorySha256, sha(readFileSync(resolve(ROOT, 'spec/codex-parity-inventory.json'))))
  assert.deepEqual(catalog.workflows.map(({ source, roles, nativeReadiness }) => ({ source, roles, nativeReadiness })), v1.workflows)
  assert.deepEqual(catalog.offerings.map(o => o.id), v1.offerings.map(o => o.id))
  catalog.offerings.forEach((row, i) => {
    const old = v1.offerings[i]
    for (const field of SHARED_FIELDS) assert.deepEqual(row[field], old[field], `${row.id} ${field}`)
    assert.ok(!Object.hasOwn(row, 'codexInstallEligible') && !Object.hasOwn(row, 'nativeImplementation'), `${row.id} has no v1-only field`)
    assert.ok(old.dependencies.every(d => row.dependencies.includes(d)), `${row.id} keeps its v1 dependencies`)
    assert.equal(api.installEligible(row, 'claude'), true, `${row.id} claude eligibility`)
    if (cp04eFlipped(row)) return // CP-04e's own test pins the flipped row's derived values
    assert.equal(api.installEligible(row, 'codex'), old.codexInstallEligible, `${row.id} codex eligibility`)
    assert.equal(api.nativeImplementationOf(row), old.nativeImplementation, `${row.id} nativeImplementation`)
  })
})

test('entry and workflow hashes equal the bytes on disk, and every transport entry exists', () => {
  const catalog = production()
  for (const offering of catalog.offerings) {
    const expected = offering.entrySkill ? sha(readFileSync(resolve(ROOT, offering.source, 'SKILL.md'))) : null
    assert.equal(offering.entrySha256, expected, offering.id)
  }
  for (const workflow of catalog.workflows) {
    assert.equal(workflow.sha256, sha(readFileSync(resolve(ROOT, workflow.source))), workflow.source)
  }
  assert.ok([JSON.stringify(TRANSPORTS), JSON.stringify([...TRANSPORTS, CP04E_TRANSPORT])]
    .includes(JSON.stringify(catalog.transports)), 'transports are the three rows, or those plus CP-04e\'s')
  for (const transport of catalog.transports) {
    assert.ok(lstatSync(resolve(ROOT, transport.entry)).isFile(), `${transport.id} entry is a regular file`)
  }
})

test('declared dependencies are a superset of the derived edges', async () => {
  const catalog = production()
  const edges = await derivedEdges(ROOT, catalog)
  // The derivation itself must see each rule at work, so an empty result cannot pass.
  assert.ok(edges.get('bughunt').get('bug-lenses')?.includes('role hunter'), 'role rule finds bughunt -> bug-lenses')
  assert.ok(edges.get('dev').get('workflow-state')?.includes('SKILL.md mention'), 'mention rule finds dev -> workflow-state')
  assert.ok(edges.get('security-audit').has('native-runtime'), 'import rule finds security-audit -> native-runtime')
  const missing = []
  for (const offering of catalog.offerings) {
    for (const [dependency, reasons] of edges.get(offering.id)) {
      if (!offering.dependencies.includes(dependency)) missing.push(`${offering.id} -> ${dependency} (${[...new Set(reasons)].join('; ')})`)
    }
  }
  assert.deepEqual(missing, [], 'undeclared derived edges')
})

test('no supported anywhere; codex is partial only for autobuild and bughunt (and blueprint once CP-04e flips it)', () => {
  const catalog = production()
  assert.equal(catalog.schemaVersion, 2)
  for (const offering of catalog.offerings) {
    const { claude, codex } = offering.providers
    const library = !offering.entrySkill
    for (const [name, entry] of [['claude', claude], ['codex', codex]]) {
      assert.notEqual(entry.implementation, 'supported', `${offering.id} ${name}`)
      assert.equal(entry.limitations.includes('LIBRARY_ONLY'), library, `${offering.id} ${name} LIBRARY_ONLY`)
      assert.ok(entry.limitations.includes('REQUIREMENTS_INCOMPLETE'), `${offering.id} ${name} REQUIREMENTS_INCOMPLETE`)
    }
    assert.deepEqual([claude.implementation, claude.transportId], ['partial', 'claude-code'], `${offering.id} claude`)
    assert.ok(codex.limitations.includes('NATIVE_UNVERIFIED'), `${offering.id} codex NATIVE_UNVERIFIED`)
    if (cp04eFlipped(offering)) {
      // CP-04e's state: exactly CP04E_BLUEPRINT_CODEX (checked by cp04eFlipped), pinned by its own test.
    } else if (Object.hasOwn(CODEX_PARTIAL, offering.id)) {
      assert.deepEqual([codex.implementation, codex.transportId], ['partial', CODEX_PARTIAL[offering.id]], `${offering.id} codex`)
      assert.ok(codex.limitations.includes('LIVE_PROOF_MISSING'), `${offering.id} codex LIVE_PROOF_MISSING`)
    } else {
      assert.deepEqual([codex.implementation, codex.transportId], ['unavailable', null], `${offering.id} codex`)
      assert.ok(codex.limitations.includes('NO_PROVIDER_TRANSPORT'), `${offering.id} codex NO_PROVIDER_TRANSPORT`)
    }
    assert.equal(offering.permissionProfile, null, `${offering.id} permissionProfile`)
  }
  const audit = catalog.offerings.find(o => o.id === 'security-audit').providers.codex.limitations
  assert.ok(audit.includes('PROFILE_UNSUPPORTED') && audit.includes('NO_NATIVE_ENTRY'), 'security-audit records decision 2')
  assert.ok(!readFileSync(resolve(ROOT, 'spec/offering-capabilities.json'), 'utf8').includes('"supported"'), 'no "supported" string')
})

test('the drift guard passes on the production root', async () => {
  const checkCatalogDrift = await guard()
  assert.deepEqual(checkCatalogDrift({ installationRoot: ROOT }), { ok: true, problems: [] })
})

// ---- drift guard on owned fixture roots -----------------------------------------

const FIXTURE_FILES = {
  'install.sh': '#!/bin/sh\n',
  'core/skills/lib/x.mjs': 'export const a = 1, b = 2\n',
  'core/skills/ref/SKILL.md': '# ref\n',
  'core/skills/guide/SKILL.md': '# guide\n',
  'core/skills/spare/SKILL.md': '# spare\n',
  'core/skills/spare/z.mjs': 'export default 0\n',
  // One edge per rule: helper's skills (guide), a mention (ref), a multi-line import (lib).
  // Never edges: a non-catalog mention, a commented import, a dynamic import, a local import.
  'graphs/g/skills/app/SKILL.md': '# app\nRun `~/.claude/skills/ref/tool.mjs`. Not an offering: skills/unknown-name/.\n',
  'graphs/g/skills/app/run.mjs': [
    'import {', '  a,', '  b', "} from '../../../../core/skills/lib/x.mjs'",
    "// import z from '../../../../core/skills/spare/z.mjs'",
    "const later = () => import('../../../../core/skills/spare/z.mjs')",
    "import local from './local.mjs'", 'export { a, b, later, local }', '',
  ].join('\n'),
  'graphs/g/skills/app/local.mjs': 'export default 1\n',
  'graphs/g/workflows/w.js': "export const meta = { name: 'w' }\n",
  'graphs/g/agents/helper.md': '---\nname: helper\ndescription: d\nmodel: sonnet\nskills:\n  - guide\n---\nbody\n',
  // A graph with a workflow but no skill directory: its role skills are no one's edge.
  'graphs/h/workflows/v.js': "export const meta = { name: 'v' }\n",
  'graphs/h/agents/other.md': '---\nname: other\ndescription: d\nmodel: sonnet\nskills:\n  - spare\n---\nbody\n',
}

function offeringRow(id, kind, source, entrySha256, dependencies = []) {
  const library = entrySha256 === null ? ['LIBRARY_ONLY'] : []
  return {
    id, kind, source, entrySkill: entrySha256 !== null, installTargets: [`skills/${id}`], nativeReadiness: 'unknown',
    dependencies, evidenceOwners: [], requiredRuntimes: [], aliases: [], requirementsComplete: false, entrySha256,
    providers: {
      claude: { implementation: 'partial', transportId: 'claude-code', limitations: [...library, 'REQUIREMENTS_INCOMPLETE'] },
      codex: { implementation: 'unavailable', transportId: null,
        limitations: [...library, 'NATIVE_UNVERIFIED', 'NO_PROVIDER_TRANSPORT', 'REQUIREMENTS_INCOMPLETE'] },
    },
    permissionProfile: null, proofRefs: [],
  }
}

function fixtureCatalog() {
  const fileSha = path => sha(FIXTURE_FILES[path])
  return {
    schemaVersion: 2, status: 'PROPOSED_CATALOG_NOT_RUNTIME_CERTIFICATION', inventorySha256: 'a'.repeat(64),
    offerings: [
      offeringRow('lib', 'shared-library-no-entry-skill', 'core/skills/lib', null),
      offeringRow('ref', 'shared-reference-contract', 'core/skills/ref', fileSha('core/skills/ref/SKILL.md')),
      offeringRow('guide', 'shared-reference-contract', 'core/skills/guide', fileSha('core/skills/guide/SKILL.md')),
      offeringRow('spare', 'shared-reference-contract', 'core/skills/spare', fileSha('core/skills/spare/SKILL.md')),
      offeringRow('app', 'executable-graph-or-cli', 'graphs/g/skills/app', fileSha('graphs/g/skills/app/SKILL.md'), ['guide', 'lib', 'ref']),
    ],
    workflows: [
      { source: 'graphs/g/workflows/w.js', roles: ['helper'], nativeReadiness: 'unknown', sha256: fileSha('graphs/g/workflows/w.js') },
      { source: 'graphs/h/workflows/v.js', roles: ['other'], nativeReadiness: 'unknown', sha256: fileSha('graphs/h/workflows/v.js') },
    ],
    assets: [], fixedTargets: [], installerTargets: [], aliases: [],
    transports: [{ id: 'claude-code', provider: 'claude', entry: 'install.sh' }],
    limits: [],
  }
}

function fixtureRoot(t, mutateCatalog = () => {}) {
  const dir = mkdtempSync(join(tmpdir(), 'cp-01b-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const root = join(dir, 'install')
  for (const [path, text] of Object.entries(FIXTURE_FILES)) {
    mkdirSync(join(root, posix.dirname(path)), { recursive: true })
    writeFileSync(join(root, path), text)
  }
  const catalog = fixtureCatalog()
  mutateCatalog(catalog)
  const writeCatalog = value => {
    mkdirSync(join(root, 'spec'), { recursive: true })
    writeFileSync(join(root, 'spec/offering-capabilities.json'), JSON.stringify(value, null, 2))
  }
  writeCatalog(catalog)
  return { root, catalog, writeCatalog }
}

function flipOneByte(path) {
  const bytes = readFileSync(path)
  bytes[0] ^= 1
  writeFileSync(path, bytes)
}

function tree(root, rel = '') {
  return readdirSync(join(root, rel), { withFileTypes: true }).flatMap(d => {
    const path = rel ? `${rel}/${d.name}` : d.name
    return d.isDirectory() ? [path + '/', ...tree(root, path)] : [`${path} ${sha(readFileSync(join(root, path)))}`]
  }).sort()
}

const problem = (code, ref, dependency = null) => ({ code, ref, dependency })

test('the fixture root passes the guard and the test derivation, read-only and repeatable', async t => {
  const checkCatalogDrift = await guard()
  const api = await loadCatalog()
  const x = fixtureRoot(t)
  assert.deepEqual(api.validateCatalog(x.catalog), [])
  const edges = await derivedEdges(x.root, x.catalog)
  assert.deepEqual([...edges.get('app').keys()].sort(), ['guide', 'lib', 'ref'])
  const before = tree(x.root)
  const first = checkCatalogDrift({ installationRoot: x.root })
  assert.deepEqual(first, { ok: true, problems: [] })
  assert.deepEqual(checkCatalogDrift({ installationRoot: x.root }), first)
  assert.deepEqual(tree(x.root), before)
})

test('a one-byte workflow change fails the drift check', async t => {
  const checkCatalogDrift = await guard()
  const x = fixtureRoot(t)
  flipOneByte(join(x.root, 'graphs/g/workflows/w.js'))
  assert.deepEqual(checkCatalogDrift({ installationRoot: x.root }),
    { ok: false, problems: [problem('WORKFLOW_SHA_MISMATCH', 'graphs/g/workflows/w.js')] })
})

test('each drift has its own fixed code', async t => {
  const checkCatalogDrift = await guard()
  const cases = {
    'SKILL.md byte': [x => flipOneByte(join(x.root, 'core/skills/ref/SKILL.md')), [problem('ENTRY_SHA_MISMATCH', 'ref')]],
    'SKILL.md removed': [x => rmSync(join(x.root, 'core/skills/guide/SKILL.md')), [problem('ENTRY_SHA_MISMATCH', 'guide')]],
    'workflow removed': [x => rmSync(join(x.root, 'graphs/h/workflows/v.js')), [problem('WORKFLOW_SHA_MISMATCH', 'graphs/h/workflows/v.js')]],
    'transport entry removed': [x => rmSync(join(x.root, 'install.sh')), [problem('TRANSPORT_ENTRY_MISSING', 'claude-code')]],
    'transport entry is a directory': [x => { rmSync(join(x.root, 'install.sh')); mkdirSync(join(x.root, 'install.sh')) },
      [problem('TRANSPORT_ENTRY_MISSING', 'claude-code')]],
    'source removed': [x => rmSync(join(x.root, 'core/skills/spare'), { recursive: true }), [problem('SOURCE_MISSING', 'spare')]],
    'unlisted skill directory': [x => mkdirSync(join(x.root, 'kit/skills/extra'), { recursive: true }),
      [problem('SOURCE_UNLISTED', 'kit/skills/extra')]],
    'unlisted directory with an unsafe name': [x => mkdirSync(join(x.root, 'graphs/g/skills/Bad_Name')),
      [problem('SOURCE_UNLISTED', null)]],
  }
  for (const [name, [mutate, expected]] of Object.entries(cases)) {
    await t.test(name, t2 => {
      const x = fixtureRoot(t2)
      mutate(x)
      const result = checkCatalogDrift({ installationRoot: x.root })
      assert.deepEqual(result, { ok: false, problems: expected })
      assert.ok(!JSON.stringify(result).includes('Bad_Name'), 'no unsafe name echoed')
    })
  }
})

test('an undeclared edge from each derivation rule is reported', async t => {
  const checkCatalogDrift = await guard()
  for (const [dependency, rule] of [['guide', 'role skills'], ['ref', 'SKILL.md mention'], ['lib', 'multi-line static import']]) {
    await t.test(rule, t2 => {
      const x = fixtureRoot(t2, c => { const app = c.offerings.find(o => o.id === 'app'); app.dependencies = app.dependencies.filter(d => d !== dependency) })
      assert.deepEqual(checkCatalogDrift({ installationRoot: x.root }),
        { ok: false, problems: [problem('DEPENDENCY_UNDECLARED', 'app', dependency)] })
    })
  }
})

test('non-edges stay non-edges: ownerless graphs, nested child skills, comments, dynamic and local imports', async t => {
  const checkCatalogDrift = await guard()
  // app never declares spare, yet spare is reachable through every excluded route.
  const x = fixtureRoot(t)
  assert.ok(!x.catalog.offerings.find(o => o.id === 'app').dependencies.includes('spare'))
  writeFileSync(join(x.root, 'graphs/g/skills/app/more.mjs'), "export const s = 'skills/spare/'\nconst y = await import(`../../../../core/skills/spare/z.mjs`)\n")
  assert.deepEqual(checkCatalogDrift({ installationRoot: x.root }), { ok: true, problems: [] })
})

test('problems are sorted by code, then ref, then dependency', async t => {
  const checkCatalogDrift = await guard()
  const x = fixtureRoot(t, c => { c.offerings.find(o => o.id === 'app').dependencies = [] })
  flipOneByte(join(x.root, 'graphs/g/workflows/w.js'))
  flipOneByte(join(x.root, 'core/skills/ref/SKILL.md'))
  flipOneByte(join(x.root, 'core/skills/guide/SKILL.md'))
  rmSync(join(x.root, 'install.sh'))
  assert.deepEqual(checkCatalogDrift({ installationRoot: x.root }), {
    ok: false,
    problems: [
      problem('DEPENDENCY_UNDECLARED', 'app', 'guide'),
      problem('DEPENDENCY_UNDECLARED', 'app', 'lib'),
      problem('DEPENDENCY_UNDECLARED', 'app', 'ref'),
      problem('ENTRY_SHA_MISMATCH', 'guide'),
      problem('ENTRY_SHA_MISMATCH', 'ref'),
      problem('TRANSPORT_ENTRY_MISSING', 'claude-code'),
      problem('WORKFLOW_SHA_MISMATCH', 'graphs/g/workflows/w.js'),
    ],
  })
})

test('input, load, version and role-file errors are fixed codes that echo nothing', async t => {
  const checkCatalogDrift = await guard()
  const x = fixtureRoot(t)
  const quiet = code => e => coded(code)(e) && !e.message.includes(x.root) && !e.message.includes('helper')
  assert.throws(() => checkCatalogDrift({ installationRoot: x.root, extra: true }), quiet('INVALID_CATALOG_INPUT'))
  assert.throws(() => checkCatalogDrift({ installationRoot: 'relative/root' }), coded('INVALID_CATALOG_INPUT'))
  assert.throws(() => checkCatalogDrift(null), coded('INVALID_CATALOG_INPUT'))
  assert.throws(() => checkCatalogDrift({ installationRoot: join(x.root, 'graphs') }), quiet('NOT_FOUND'))

  const v1 = structuredClone(x.catalog)
  v1.schemaVersion = 1
  delete v1.transports
  v1.workflows = v1.workflows.map(({ sha256, ...row }) => row)
  v1.offerings = v1.offerings.map(({ providers, permissionProfile, proofRefs, ...row }) =>
    ({ ...row, codexInstallEligible: false, nativeImplementation: 'not-certified' }))
  x.writeCatalog(v1)
  assert.throws(() => checkCatalogDrift({ installationRoot: x.root }), quiet('CATALOG_NO_PINS'))

  x.writeCatalog({ ...x.catalog, schemaVersion: 3 })
  assert.throws(() => checkCatalogDrift({ installationRoot: x.root }), quiet('INVALID_CATALOG'))

  x.writeCatalog(x.catalog)
  rmSync(join(x.root, 'graphs/g/agents/helper.md'))
  assert.throws(() => checkCatalogDrift({ installationRoot: x.root }), quiet('ROLE_NOT_FOUND'))
})
