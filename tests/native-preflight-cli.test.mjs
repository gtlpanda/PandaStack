import assert from 'node:assert/strict'
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, existsSync,
  readdirSync, lstatSync, readlinkSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createHash } from 'node:crypto'
import { test, REPO } from '../scripts/workflow-harness.mjs'

const CLI_FILE = join(REPO, 'core/skills/native-runtime/preflight-cli.mjs')
const cliModule = () => import('../core/skills/native-runtime/preflight-cli.mjs')
const sha = value => createHash('sha256').update(value).digest('hex')
const skillText = id => `# inert ${id}\n`
const catalogFixture = () => JSON.parse(readFileSync(join(REPO, 'acceptance/native-runtime/oc-01-catalog.fixture.json'), 'utf8'))
const realConfigText = () => readFileSync(join(REPO, 'agent-config.json'), 'utf8')

// A temp installation root holding a catalog built from real fixture rows, the
// repository's real agent-config.json and inert SKILL files. Nothing here touches
// REPO/spec, so the tests stay valid once a production catalog exists.
async function fixture(fn, { ids = ['autobuild'], dependencies = {}, overrides = {}, catalog = true, config = true } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'native-preflight-cli-'))
  try {
    const installationRoot = join(root, 'install'), skillsRoot = join(root, 'skills')
    mkdirSync(installationRoot); mkdirSync(skillsRoot)
    const full = catalogFixture()
    full.offerings = ids.map(id => {
      const row = full.offerings.find(candidate => candidate.id === id)
      assert.ok(row, `fixture row ${id}`)
      mkdirSync(join(installationRoot, 'source', id), { recursive: true })
      if (row.entrySkill) writeFileSync(join(installationRoot, 'source', id, 'SKILL.md'), skillText(id))
      return { ...row, source: `source/${id}`, entrySha256: row.entrySkill ? sha(skillText(id)) : null,
        dependencies: dependencies[id] ?? [], ...(overrides[id] ?? {}) }
    })
    for (const key of ['assets', 'workflows', 'installerTargets', 'fixedTargets', 'aliases']) full[key] = []
    if (catalog) {
      mkdirSync(join(installationRoot, 'spec'))
      writeFileSync(join(installationRoot, 'spec/offering-capabilities.json'), catalog === true ? JSON.stringify(full) : catalog)
    }
    if (config) writeFileSync(join(installationRoot, 'agent-config.json'), config === true ? realConfigText() : config)
    const source = id => join(installationRoot, 'source', id)
    const link = id => symlinkSync(source(id), join(skillsRoot, id), 'dir')
    return await fn({ root, installationRoot, skillsRoot, source, link })
  } finally { rmSync(root, { recursive: true, force: true }) }
}
const argv = (x, { backend = 'codex', offering = 'autobuild' } = {}) =>
  ['--installation-root', x.installationRoot, '--skills-root', x.skillsRoot, '--backend', backend, '--offering', offering]

async function run(args, options = { env: {} }) {
  const { preflightMain } = await cliModule()
  const out = [], err = [], log = console.log, error = console.error
  console.log = value => out.push(value); console.error = value => err.push(value)
  try { return { status: await preflightMain(args, options), out, err } }
  finally { console.log = log; console.error = error }
}
const report = result => {
  assert.equal(result.out.length, 1); assert.deepEqual(result.err, [])
  return JSON.parse(result.out[0])
}
const failure = (result, code) => {
  assert.equal(result.status, 1); assert.deepEqual(result.out, []); assert.equal(result.err.length, 1)
  const body = JSON.parse(result.err[0])
  assert.deepEqual(Object.keys(body), ['error', 'message']); assert.equal(body.error, code)
  return result.err[0]
}
async function realSettings(backend, env = {}) {
  const { resolveSettings } = await import('../core/skills/run-records/doctor.mjs')
  return resolveSettings({ backend, central: JSON.parse(realConfigText()), project: {}, env, overrides: {} })
}
function snapshot(dir) {
  const lines = []
  const walk = path => {
    for (const name of readdirSync(path).sort()) {
      const file = join(path, name), stat = lstatSync(file)
      if (stat.isSymbolicLink()) lines.push(`${file} -> ${readlinkSync(file)}`)
      else if (stat.isDirectory()) { lines.push(`${file}/`); walk(file) }
      else lines.push(`${file} ${sha(readFileSync(file))}`)
    }
  }
  walk(dir)
  return lines
}

await test('help documents the offline semantics and exit codes without loading anything', async () => {
  let loads = 0
  for (const flag of ['--help', '-h']) {
    const result = await run([flag], { env: {}, load: async () => { loads++; throw new Error('must not load') } })
    assert.equal(result.status, 0); assert.deepEqual(result.err, []); assert.equal(result.out.length, 1)
    for (const phrase of [/offline/i, /writes nothing/i, /no provider/i, /authentication/i, /unknown/i,
      /not readiness/i, /Exit codes/, /--installation-root/, /--skills-root/, /--backend/, /--offering/]) {
      assert.match(result.out[0], phrase)
    }
  }
  assert.equal(loads, 0)
})

await test('invalid or incomplete arguments fail with one fixed error before any module loads', async () => {
  let loads = 0
  const options = { env: {}, load: async () => { loads++; throw new Error('must not load') } }
  const base = ['--installation-root', '/abs/install', '--skills-root', '/abs/skills', '--backend', 'codex', '--offering', 'autobuild']
  const swap = (index, value) => base.map((item, i) => i === index ? value : item)
  const cases = [[], ['doctor'], base.slice(0, 6), base.slice(0, 7), [...base, 'extra'], [...base, '--backend', 'codex'],
    ['--help', ...base], ['--help', '--backend', 'codex'], swap(0, '--bogus'), swap(0, '--backend'), swap(0, '--__proto__'),
    swap(1, 'relative/install'), swap(1, '--skills-root'), swap(3, 'relative/skills'), swap(5, 'fallback'),
    swap(5, ''), swap(7, ''), swap(7, '--backend'), swap(5, 'PRIVATE-backend')]
  for (const args of cases) {
    const raw = failure(await run(args, options), 'INVALID_USAGE')
    assert.ok(!raw.includes('PRIVATE') && !raw.includes('/abs/'))
  }
  assert.equal(loads, 0)
  assert.equal((await run(null, options)).status, 1)
})

await test('an unavailable module fails clearly without echoing the load error', async () => {
  await fixture(async x => {
    const before = snapshot(x.root)
    const broken = [async () => { throw new Error('PRIVATE load detail') }, async () => null, async () => ({}),
      async () => ({ loadOfferingCatalog() {}, discoverOfferings() {}, projectOfferingPreflight() {}, resolveSettings() {}, readAgentConfig: 'no' })]
    for (const load of broken) {
      const raw = failure(await run(argv(x), { env: {}, load }), 'DEPENDENCY_UNAVAILABLE')
      assert.ok(!raw.includes('PRIVATE'))
    }
    assert.deepEqual(snapshot(x.root), before)
  })
})

await test('a missing catalog is never fabricated and nothing is created', async () => {
  await fixture(async x => {
    const before = snapshot(x.root)
    failure(await run(argv(x)), 'CATALOG_NOT_FOUND')
    assert.deepEqual(snapshot(x.root), before); assert.equal(existsSync(join(x.installationRoot, 'spec')), false)
    const absent = join(x.root, 'no-such-install')
    failure(await run(argv({ ...x, installationRoot: absent })), 'CATALOG_NOT_FOUND')
    assert.equal(existsSync(absent), false)
  }, { catalog: false })
})

await test('an unusable catalog or installation root fails without echoing its bytes', async () => {
  await fixture(async x => {
    for (const bytes of ['PRIVATE', '{"schemaVersion":1,"PRIVATE":true}']) {
      writeFileSync(join(x.installationRoot, 'spec/offering-capabilities.json'), bytes)
      assert.ok(!failure(await run(argv(x)), 'CATALOG_INVALID').includes('PRIVATE'))
    }
    const file = join(x.installationRoot, 'agent-config.json')
    failure(await run(argv({ ...x, installationRoot: file })), 'INVALID_USAGE')
  })
})

await test('a missing or invalid agent config fails with fixed codes and no echo', async () => {
  await fixture(async x => failure(await run(argv(x)), 'CONFIG_NOT_FOUND'), { config: false })
  for (const config of ['PRIVATE{', '{"maxConcurrentSubagents":0,"PRIVATE":1}', '[]']) {
    await fixture(async x => assert.ok(!failure(await run(argv(x)), 'CONFIG_INVALID').includes('PRIVATE')), { config })
  }
})

await test('an offering outside the catalog is refused without echoing the requested name', async () => {
  await fixture(async x => {
    const raw = failure(await run(argv(x, { offering: 'no-such-offering' })), 'UNKNOWN_OFFERING')
    assert.ok(!raw.includes('no-such-offering'))
  })
})

await test('settings equal the real resolver for both backends and nothing reports ready', async () => {
  await fixture(async x => {
    x.link('autobuild')
    for (const backend of ['codex', 'claude']) {
      const result = await run(argv(x, { backend })), out = report(result)
      assert.equal(result.status, 0)
      assert.deepEqual(out.settings, await realSettings(backend))
      for (const key of ['model', 'effort', 'maxConcurrentSubagents']) {
        assert.deepEqual(out.configured[key], { value: out.settings.values[key], source: out.settings.sources[key] })
      }
      assert.equal(out.configured.effort.source, backend === 'codex' ? 'default' : 'central')
      assert.equal(out.configured.maxConcurrentSubagents.source, 'central')
      assert.deepEqual([out.mode, out.backend, out.offeringId, out.implementation, out.visibility, out.installEligible, out.readiness],
        ['offline-static-preflight', backend, 'autobuild', 'present-limited', 'linked', true, 'unknown'])
      assert.deepEqual(out.runtimes, ['node', 'git'].map(name => ({ name, status: 'unknown', version: null })))
      for (const key of ['auth', 'account', 'payer']) assert.deepEqual(out[key], { status: 'unknown', value: null })
      assert.deepEqual(out.refusal, { refused: false, reasons: [] }); assert.deepEqual(out.dependencies, [])
      assert.ok(out.blockers.includes('NATIVE_UNVERIFIED')); assert.match(out.semantics, /not readiness or certification/)
      assert.doesNotMatch(result.out[0], /"(?:ready|supported|certified)"/)
    }
  }, { overrides: { autobuild: { requiredRuntimes: ['node', 'git'] } } })
})

await test('model variables flow through the resolver with provenance and bad values fail closed', async () => {
  await fixture(async x => {
    x.link('autobuild')
    const env = { AUTOBUILD_MODEL: 'test-model' }, out = report(await run(argv(x), { env }))
    assert.deepEqual(out.configured.model, { value: 'test-model', source: 'env' })
    assert.deepEqual(out.settings, await realSettings('codex', env))
    const saved = process.env.AUTOBUILD_MODEL
    try {
      process.env.AUTOBUILD_MODEL = 'ambient-model'
      assert.deepEqual(report(await run(argv(x), {})).configured.model, { value: 'ambient-model', source: 'env' })
    } finally { if (saved === undefined) delete process.env.AUTOBUILD_MODEL; else process.env.AUTOBUILD_MODEL = saved }
    const raw = failure(await run(argv(x), { env: { AUTOBUILD_MODEL: 'PRIVATE bad model!' } }), 'CONFIG_INVALID')
    assert.ok(!raw.includes('PRIVATE'))
  })
})

await test('an uncertified offering prints its report and exits 2 with backend-specific reasons', async () => {
  await fixture(async x => {
    x.link('security-audit')
    let result = await run(argv(x, { offering: 'security-audit' })), out = report(result)
    assert.equal(result.status, 2)
    assert.deepEqual([out.implementation, out.visibility, out.installEligible, out.readiness], ['not-certified', 'linked', false, 'unknown'])
    assert.deepEqual(out.refusal, { refused: true, reasons: ['IMPLEMENTATION_NOT_CERTIFIED', 'NOT_INSTALL_ELIGIBLE'] })
    assert.deepEqual(out.settings, await realSettings('codex'))
    result = await run(argv(x, { backend: 'claude', offering: 'security-audit' })); out = report(result)
    assert.equal(result.status, 2); assert.deepEqual(out.refusal.reasons, ['IMPLEMENTATION_NOT_CERTIFIED'])
  }, { ids: ['security-audit'] })
})

await test('a library-only entry is refused as library-only and never as runnable', async () => {
  await fixture(async x => {
    const result = await run(argv(x, { offering: 'decisions' })), out = report(result)
    assert.equal(result.status, 2); assert.equal(out.visibility, 'library-only')
    assert.deepEqual(out.refusal.reasons, ['IMPLEMENTATION_NOT_CERTIFIED', 'NOT_INSTALL_ELIGIBLE', 'LIBRARY_ONLY'])
    assert.ok(out.blockers.includes('LIBRARY_ONLY'))
  }, { ids: ['decisions'] })
})

await test('absent, drifted and missing-root installs degrade readiness and exit 2 without creating anything', async () => {
  await fixture(async x => {
    const before = snapshot(x.root)
    let result = await run(argv(x)), out = report(result)
    assert.equal(result.status, 2); assert.equal(out.visibility, 'absent'); assert.equal(out.readiness, 'degraded')
    assert.deepEqual(out.refusal.reasons, ['READINESS_DEGRADED'])
    const missing = join(x.root, 'missing-skills')
    result = await run(['--installation-root', x.installationRoot, '--skills-root', missing, '--backend', 'codex', '--offering', 'autobuild'])
    assert.equal(result.status, 2); assert.equal(report(result).visibility, 'absent')
    assert.equal(existsSync(missing), false); assert.deepEqual(snapshot(x.root), before)
    x.link('autobuild'); writeFileSync(join(x.source('autobuild'), 'SKILL.md'), 'changed bytes')
    result = await run(argv(x)); out = report(result)
    assert.equal(result.status, 2); assert.equal(out.visibility, 'linked'); assert.equal(out.readiness, 'degraded')
    assert.ok(out.blockers.includes('SOURCE_DRIFTED')); assert.deepEqual(out.refusal.reasons, ['READINESS_DEGRADED'])
  })
})

await test('transitive dependencies are reported and a missing dependency source refuses execution', async () => {
  const dependencies = { autobuild: ['bughunt'], bughunt: ['decisions'] }
  await fixture(async x => {
    x.link('autobuild')
    let result = await run(argv(x)), out = report(result)
    assert.equal(result.status, 0)
    assert.deepEqual(out.dependencies, [{ id: 'bughunt', visibility: 'absent', sourceStatus: 'present' },
      { id: 'decisions', visibility: 'library-only', sourceStatus: 'present' }])
    rmSync(x.source('decisions'), { recursive: true })
    result = await run(argv(x)); out = report(result)
    assert.equal(result.status, 2); assert.equal(out.dependencies[1].sourceStatus, 'missing')
    assert.deepEqual(out.refusal, { refused: true, reasons: ['DEPENDENCY_SOURCE_NOT_PRESENT'] })
    assert.equal(out.readiness, 'unknown')
  }, { ids: ['autobuild', 'bughunt', 'decisions'], dependencies })
})

await test('runs leave installation and skills roots byte-identical and the CLI imports no fs, process or network module', async () => {
  await fixture(async x => {
    x.link('autobuild')
    const before = snapshot(x.root)
    assert.equal((await run(argv(x))).status, 0); assert.equal((await run(argv(x, { backend: 'claude' }))).status, 0)
    assert.deepEqual(snapshot(x.root), before)
  })
  const source = readFileSync(CLI_FILE, 'utf8')
  assert.doesNotMatch(source, /node:(?:fs|child_process|net|http|https|dns|tls|dgram)|\bfetch\(|process\.env\.[A-Za-z]/)
})
