import assert from 'node:assert/strict'
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createHash } from 'node:crypto'
import { test, REPO } from '../scripts/workflow-harness.mjs'

const api = () => import('../core/skills/native-runtime/catalog.mjs')
const full = () => JSON.parse(readFileSync(join(REPO, 'acceptance/native-runtime/oc-01-catalog.fixture.json')))
const sha = value => createHash('sha256').update(value).digest('hex')
const coded = code => e => e.code === code && !e.message.includes('PRIVATE')
function fixture(fn) {
  const root = mkdtempSync(join(tmpdir(), 'oc01-implementation-'))
  try {
    const installationRoot = join(root, 'install'), skillsRoot = join(root, 'skills')
    const source = join(installationRoot, 'source', 'security-audit')
    mkdirSync(source, { recursive: true }); mkdirSync(skillsRoot)
    writeFileSync(join(source, 'SKILL.md'), '# inert catalog entry\n')
    const catalog = full()
    catalog.offerings = [{ ...catalog.offerings.find(x => x.id === 'security-audit'),
      source: 'source/security-audit', entrySha256: sha('# inert catalog entry\n') }]
    for (const key of ['assets', 'workflows', 'installerTargets', 'fixedTargets', 'aliases']) catalog[key] = []
    return fn({ root, source, installationRoot, skillsRoot, catalog, backend: 'codex' })
  } finally { rmSync(root, { recursive: true, force: true }) }
}
const args = x => ({ catalog: x.catalog, installationRoot: x.installationRoot, skillsRoot: x.skillsRoot, backend: x.backend })
const preflight = (a, x, discovery, settings = { values: {}, sources: {} }) => a.projectOfferingPreflight({
  catalog: x.catalog, discovery, offeringId: 'security-audit', backend: x.backend, settings,
})

await test('catalog rejects inert-data boundary violations without invoking any hooks', async () => {
  const a = await api(); let calls = 0
  const getter = {}; Object.defineProperty(getter, 'schemaVersion', { enumerable: true, get() { calls++; return 1 } })
  const proxy = new Proxy({}, { get() { calls++ }, ownKeys() { calls++; return [] }, getPrototypeOf() { calls++ } })
  const revoked = Proxy.revocable({}, {}); revoked.revoke()
  const cycle = {}; cycle.x = cycle
  for (const value of [null, undefined, 0, getter, proxy, revoked.proxy, cycle, new Date(),
    { toJSON() { calls++; return full() } }, Object.create({ schemaVersion: 1 })]) {
    assert.ok(a.validateCatalog(value).length)
    assert.throws(() => a.discoverOfferings(value), coded('INVALID_CATALOG_INPUT'))
  }
  const nested = full(); nested.offerings[0].aliases = [proxy]
  assert.ok(a.validateCatalog(nested).length)
  assert.equal(calls, 0)
  assert.deepEqual(a.validateCatalog(Object.assign(Object.create(null), full())), [])
})

await test('catalog enforces exact entry schemas, reference bindings and path grammar', async () => {
  const { validateCatalog } = await api()
  const mutations = [
    c => c.offerings[0].extra = true, c => delete c.offerings[0].requirementsComplete,
    c => c.offerings[0].entrySha256 = 'A'.repeat(64), c => c.offerings[0].nativeReadiness = 'ready',
    c => c.offerings[0].id += '\n', c => c.offerings[0].entrySha256 += '\n',
    c => c.inventorySha256 += '\n',
    c => c.offerings[0].dependencies = ['PRIVATE'], c => c.offerings[0].aliases = ['PRIVATE'],
    c => c.offerings[0].aliases = [c.offerings[0].id],
    c => c.aliases[0].targetOffering = 'PRIVATE', c => c.assets.push(c.assets[0]),
    c => c.workflows.push(c.workflows[0]), c => c.fixedTargets.push(c.fixedTargets[0]),
    c => c.installerTargets[0].source = 'other/source',
    c => c.offerings[1].installTargets = c.offerings[0].installTargets,
    c => c.offerings[0].source = 'source//PRIVATE', c => c.offerings[0].source = 'source/./PRIVATE',
    c => c.offerings[0].source = 'source/../PRIVATE', c => c.offerings[0].source = '/PRIVATE',
    c => c.offerings[0].source = 'C:\\PRIVATE', c => c.offerings[0].source = 'source/PRIVATE\n',
  ]
  for (const mutate of mutations) {
    const c = full(); mutate(c); const errors = validateCatalog(c)
    assert.ok(errors.length > 0 && errors.length <= 100)
    assert.ok(errors.every(e => typeof e === 'string' && !e.includes('PRIVATE')))
  }
})

await test('catalog accepts bounded references but rejects cycles and representation excess', async () => {
  const { validateCatalog } = await api()
  const c = full(); c.offerings[0].dependencies = [c.offerings[1].id]
  c.aliases[0].targetOffering = c.offerings[0].id
  assert.deepEqual(validateCatalog(c), [])
  c.offerings[1].dependencies = [c.offerings[0].id]
  assert.ok(validateCatalog(c).length)
  for (const mutate of [
    c => c.limits = ['é'.repeat(600000)],
    c => c.offerings[0].source = 'x'.repeat(4097),
    c => c.offerings[0].dependencies = Array(33).fill('backlog'),
    c => c.offerings = Array(257).fill(c.offerings[0]),
    c => c.assets = Array(513).fill(c.assets[0]),
    c => c.workflows = Array(33).fill(c.workflows[0]),
  ]) { const value = full(); mutate(value); assert.ok(validateCatalog(value).length) }
})

await test('loader validates bounded inert files, exact options and detached output', async () => {
  const a = await api()
  fixture(x => {
    mkdirSync(join(x.installationRoot, 'spec'))
    const path = join(x.installationRoot, 'spec/offering-capabilities.json')
    for (const bytes of ['PRIVATE', '{"x":1e400}', ' '.repeat(1048577)]) {
      writeFileSync(path, bytes)
      assert.throws(() => a.loadOfferingCatalog({ installationRoot: x.installationRoot }), coded('INVALID_CATALOG'))
    }
    writeFileSync(path, JSON.stringify(x.catalog))
    const value = a.loadOfferingCatalog({ installationRoot: x.installationRoot })
    value.offerings[0].source = 'changed'
    assert.deepEqual(a.loadOfferingCatalog({ installationRoot: x.installationRoot }), x.catalog)
    assert.throws(() => a.loadOfferingCatalog({ installationRoot: '.', extra: true }), coded('INVALID_CATALOG_INPUT'))
    assert.throws(() => a.loadOfferingCatalog({ installationRoot: path }), coded('INVALID_CATALOG_INPUT'))
  })
})

await test('source and SKILL symlink escapes refuse before accepting matching outside bytes', async () => {
  const a = await api()
  fixture(x => {
    const outside = join(x.root, 'outside'); mkdirSync(outside)
    writeFileSync(join(outside, 'SKILL.md'), '# inert catalog entry\n')
    rmSync(x.source, { recursive: true }); symlinkSync(outside, x.source, 'dir')
    symlinkSync(outside, join(x.skillsRoot, 'security-audit'), 'dir')
    let row = a.discoverOfferings(args(x)).offerings[0]
    assert.equal(row.sourceStatus, 'unreadable'); assert.ok(row.blockers.includes('SOURCE_UNREADABLE'))
    assert.notEqual(row.visibility, 'linked')
    rmSync(x.source); mkdirSync(x.source)
    symlinkSync(join(outside, 'SKILL.md'), join(x.source, 'SKILL.md'))
    row = a.discoverOfferings(args(x)).offerings[0]
    assert.equal(row.sourceStatus, 'unreadable')
    assert.equal(preflight(a, x, a.discoverOfferings(args(x))).readiness, 'degraded')
  })
})

await test('contained source aliases and exact installed aliases support ordinary linked discovery', async () => {
  const a = await api()
  fixture(x => {
    const alias = join(x.installationRoot, 'alias'); symlinkSync(x.source, alias, 'dir')
    x.catalog.offerings[0].source = 'alias'
    symlinkSync(x.source, join(x.skillsRoot, 'security-audit'), 'dir')
    const result = a.discoverOfferings(args(x))
    assert.equal(result.offerings[0].sourceStatus, 'present')
    assert.equal(result.offerings[0].visibility, 'linked')
    assert.equal(preflight(a, x, result).readiness, 'unknown')
  })
})

await test('installed copies cannot adopt an escaping SKILL symlink or a non-file entry', async () => {
  const a = await api()
  fixture(x => {
    const installed = join(x.skillsRoot, 'security-audit'); mkdirSync(installed)
    symlinkSync(join(x.source, 'SKILL.md'), join(installed, 'SKILL.md'))
    assert.equal(a.discoverOfferings(args(x)).offerings[0].visibility, 'unreadable')
    rmSync(join(installed, 'SKILL.md')); mkdirSync(join(installed, 'SKILL.md'))
    assert.equal(a.discoverOfferings(args(x)).offerings[0].visibility, 'unreadable')
  })
})

await test('library inventory and missing roots never imply runnable support or create directories', async () => {
  const a = await api()
  fixture(x => {
    x.catalog.offerings[0].entrySkill = false; x.catalog.offerings[0].entrySha256 = null
    x.catalog.offerings[0].kind = 'shared-library-no-entry-skill'
    for (const backend of ['codex', 'claude']) {
      x.backend = backend
      const row = a.discoverOfferings(args(x)).offerings[0]
      assert.equal(row.visibility, 'library-only'); assert.equal(row.nativeReadiness, 'unknown')
      assert.ok(row.blockers.includes('LIBRARY_ONLY'))
    }
    x.installationRoot = join(x.root, 'missing-install'); x.skillsRoot = join(x.root, 'missing-skills')
    assert.equal(a.discoverOfferings(args(x)).offerings[0].sourceStatus, 'missing')
    assert.equal(existsSync(x.installationRoot), false); assert.equal(existsSync(x.skillsRoot), false)
  })
})

await test('preflight rejects mismatched discovery and secret-bearing settings without inference', async () => {
  const a = await api()
  fixture(x => {
    const discovery = a.discoverOfferings(args(x))
    for (const mutate of [d => d.backend = 'claude', d => d.offerings[0].id = 'other',
      d => d.offerings[0].nativeReadiness = 'ready', d => d.offerings[0].blockers = [],
      d => d.offerings.push(d.offerings[0]), d => d.extra = true]) {
      const d = structuredClone(discovery); mutate(d)
      assert.throws(() => preflight(a, x, d), coded('INVALID_CATALOG_INPUT'))
    }
    for (const settings of [{ values: {}, sources: {}, auth: 'PRIVATE' },
      { values: { credential: 'PRIVATE' }, sources: {} },
      { values: {}, sources: { model: 'PRIVATE' } }]) {
      assert.throws(() => preflight(a, x, discovery, settings), coded('INVALID_CATALOG_INPUT'))
    }
    const settings = { values: { model: 'test-model', effort: 'high' }, sources: { model: 'central', effort: 'default' } }
    const report = preflight(a, x, discovery, settings)
    assert.deepEqual(report.settings, settings); report.settings.values.model = 'changed'
    assert.equal(settings.values.model, 'test-model')
    assert.equal(report.readiness, 'degraded')
  })
})

await test('unknown entry names and blockers are stable, sorted and safe', async () => {
  const a = await api()
  fixture(x => {
    for (const name of ['z.txt', 'a.txt', 'unsafe\nname']) writeFileSync(join(x.skillsRoot, name), 'inert')
    symlinkSync(join(x.root, 'not-present'), join(x.skillsRoot, 'security-audit'))
    const d = a.discoverOfferings(args(x))
    assert.deepEqual(d.unknownEntries, ['a.txt', 'z.txt'])
    assert.deepEqual(d.offerings[0].blockers, [...d.offerings[0].blockers].sort())
    assert.equal(d.offerings[0].visibility, 'broken')
    assert.deepEqual(a.discoverOfferings(args(x)), d)
  })
})

await test('linked visibility stays distinct from missing or changed source SKILL bytes', async () => {
  const a = await api()
  fixture(x => {
    symlinkSync(x.source, join(x.skillsRoot, 'security-audit'), 'dir')
    for (const state of ['drifted', 'missing']) {
      if (state === 'drifted') writeFileSync(join(x.source, 'SKILL.md'), 'different bytes')
      else rmSync(join(x.source, 'SKILL.md'))
      const discovery = a.discoverOfferings(args(x)), row = discovery.offerings[0]
      assert.equal(row.visibility, 'linked'); assert.equal(row.sourceStatus, state)
      assert.equal(preflight(a, x, discovery).readiness, 'degraded')
    }
  })
})

await test('all declared current sources discover present without certifying any offering', async () => {
  const a = await api()
  fixture(x => {
    x.catalog = full(); x.installationRoot = REPO
    const discovery = a.discoverOfferings(args(x))
    assert.equal(discovery.offerings.length, x.catalog.offerings.length)
    for (const row of discovery.offerings) {
      assert.equal(row.sourceStatus, 'present', row.id)
      assert.equal(row.nativeReadiness, 'unknown', row.id)
      assert.ok(row.blockers.includes('NATIVE_UNVERIFIED'))
    }
  })
})

await test('declared eligibility and runtime requirements do not become observed runtime support', async () => {
  const a = await api()
  fixture(x => {
    x.catalog.offerings[0].requiredRuntimes = ['node', 'git']
    symlinkSync(x.source, join(x.skillsRoot, 'security-audit'), 'dir')
    for (const backend of ['codex', 'claude']) {
      x.backend = backend
      const d = a.discoverOfferings(args(x)), report = preflight(a, x, d)
      assert.equal(d.offerings[0].installEligible, backend === 'claude')
      assert.deepEqual(report.runtimes, ['node', 'git'].map(name => ({ name, status: 'unknown', version: null })))
      assert.equal(report.readiness, 'unknown')
      for (const key of ['auth', 'account', 'payer']) assert.deepEqual(report[key], { status: 'unknown', value: null })
    }
  })
})

await test('loader refuses a static external manifest and malformed UTF-8 without adopting bytes', async () => {
  const a = await api()
  fixture(x => {
    const external = join(x.root, 'outside.json')
    writeFileSync(external, JSON.stringify(x.catalog)); mkdirSync(join(x.installationRoot, 'spec'))
    const manifest = join(x.installationRoot, 'spec/offering-capabilities.json')
    symlinkSync(external, manifest)
    assert.throws(() => a.loadOfferingCatalog({ installationRoot: x.installationRoot }), coded('INVALID_CATALOG'))
    rmSync(manifest); writeFileSync(manifest, Buffer.from([0xff]))
    assert.throws(() => a.loadOfferingCatalog({ installationRoot: x.installationRoot }), coded('INVALID_CATALOG'))
  })
})

await test('static source refusal and wrong targets never open their external SKILL contents', async () => {
  const a = await api(), { default: fs } = await import('node:fs')
  const { syncBuiltinESMExports } = await import('node:module')
  fixture(x => {
    const external = join(x.root, 'outside'); mkdirSync(external)
    writeFileSync(join(external, 'SKILL.md'), '# inert catalog entry\n')
    symlinkSync(external, join(x.skillsRoot, 'security-audit'), 'dir')
    const saved = fs.openSync, opened = []
    try {
      fs.openSync = (...argv) => { opened.push(argv[0]); return saved(...argv) }
      syncBuiltinESMExports()
      assert.equal(a.discoverOfferings(args(x)).offerings[0].visibility, 'wrong-target')
      assert.deepEqual(opened, [join(x.source, 'SKILL.md')])
      rmSync(x.source, { recursive: true }); symlinkSync(external, x.source, 'dir')
      opened.length = 0
      assert.equal(a.discoverOfferings(args(x)).offerings[0].sourceStatus, 'unreadable')
      assert.deepEqual(opened, [])
    } finally { fs.openSync = saved; syncBuiltinESMExports() }
  })
})

await test('ordinary I/O failures have fixed diagnostics and conservative visibility', async () => {
  const a = await api(), { default: fs } = await import('node:fs')
  const { syncBuiltinESMExports } = await import('node:module')
  fixture(x => {
    mkdirSync(join(x.installationRoot, 'spec'))
    writeFileSync(join(x.installationRoot, 'spec/offering-capabilities.json'), JSON.stringify(x.catalog))
    const savedOpen = fs.openSync, savedClose = fs.closeSync
    try {
      fs.openSync = () => { throw Object.assign(Error('PRIVATE'), { code: 'EACCES' }) }
      syncBuiltinESMExports()
      assert.throws(() => a.loadOfferingCatalog({ installationRoot: x.installationRoot }), coded('IO_ERROR'))
      assert.equal(a.discoverOfferings(args(x)).offerings[0].sourceStatus, 'unreadable')
      fs.openSync = savedOpen
      fs.closeSync = fd => { savedClose(fd); throw Error('PRIVATE') }
      syncBuiltinESMExports()
      assert.throws(() => a.loadOfferingCatalog({ installationRoot: x.installationRoot }), coded('IO_ERROR'))
    } finally { fs.openSync = savedOpen; fs.closeSync = savedClose; syncBuiltinESMExports() }
  })
})
