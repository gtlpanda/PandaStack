// The source-only Codex leaf profile: argv, the restricted model catalog, the wire inventory check and
// the wire preflight. The preflight tests run a fake `codex` (tests/fixtures/fake-source-only-codex.mjs)
// that posts a scripted tool inventory to the loopback Responses API: wiring proof, not a claim about a
// real Codex. The real-Codex observation is in docs/evidence/codex-security-audit-live-*.md.
import assert from 'node:assert/strict'
import { chmodSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from '../scripts/workflow-harness.mjs'

const so = () => import('../core/skills/native-runtime/codex-source-only.mjs')
const exec = () => import('../core/skills/native-runtime/codex-exec.mjs')
const FAKE = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'fake-source-only-codex.mjs')
const WORK = realpathSync(mkdtempSync(join(tmpdir(), 'native-source-only-')))
const BIN = join(WORK, 'codex')
writeFileSync(BIN, `#!/bin/sh\nexec ${process.execPath} ${FAKE} "$@"\n`)
chmodSync(BIN, 0o755)
const READER = { url: 'http://127.0.0.1:41234/mcp', authEnv: 'PANDASTACK_AUDIT_READER_KEY' }
const INPUT = { model: 'gpt-6.1-sol', reasoningEffort: 'high', catalogFile: '/run/cat.json', reader: READER, outputFile: '/run/o.json', schemaFile: '/run/s.json' }
const coded = error => error.code === 'INVALID_SOURCE_ONLY_INPUT'
const env = (extra = {}) => ({ PATH: process.env.PATH, ...extra })

await test('argv: exactly the codexExecArgs read-only argv plus the restrictions, prompt last', async () => {
  const { codexSourceOnlyArgs } = await so()
  const { codexExecArgs } = await exec()
  const base = codexExecArgs({ sandbox: 'read-only', model: 'gpt-6.1-sol', reasoningEffort: 'high', outputFile: '/run/o.json', schemaFile: '/run/s.json' })
  assert.deepEqual(codexSourceOnlyArgs(INPUT), [...base.slice(0, -1), '--ephemeral',
    '-c', 'model_catalog_json="/run/cat.json"',
    '--disable', 'shell_tool', '--disable', 'unified_exec', '--disable', 'view_image', '--disable', 'goals', '--disable', 'image_generation',
    '--disable', 'apps', '--disable', 'plugins', '--disable', 'tool_suggest', '--disable', 'skill_search', '--disable', 'multi_agent',
    '--disable', 'multi_agent_v2', '--disable', 'browser_use', '--disable', 'computer_use',
    '-c', 'mcp_servers.reader.url="http://127.0.0.1:41234/mcp"', '-c', 'mcp_servers.reader.bearer_token_env_var="PANDASTACK_AUDIT_READER_KEY"', // allow-secret
    '-c', 'mcp_servers.reader.enabled_tools=["list_source","read_source","search_source"]',
    '-c', 'web_search="disabled"', '-c', 'tools.update_plan.enabled=false', '-c', 'tools.experimental_request_user_input.enabled=false', '-'])
})

await test('argv: read-only sandbox, user config ignored, no network or write widening, and no bearer value anywhere', async () => {
  const { codexSourceOnlyArgs } = await so()
  const args = codexSourceOnlyArgs(INPUT)
  assert.equal(args[args.indexOf('--sandbox') + 1], 'read-only')
  assert.equal(args.filter(a => a === '--ignore-user-config').length, 1)
  assert.ok(!args.some(a => /workspace-write|danger|network_access|bypass/.test(a)))
  assert.ok(!args.some(a => /bearer ?[0-9a-f]{16}/i.test(a)))
})

await test('argv: the other profiles are untouched (codexExecArgs gives the same argv with and without this module loaded)', async () => {
  const { codexExecArgs } = await exec()
  const before = codexExecArgs({ sandbox: 'workspace-write', networkAccess: true, model: 'm', reasoningEffort: 'low', outputFile: '/o' })
  await so()
  assert.deepEqual(codexExecArgs({ sandbox: 'workspace-write', networkAccess: true, model: 'm', reasoningEffort: 'low', outputFile: '/o' }), before)
  assert.ok(!before.includes('--ephemeral') && !before.includes('--disable') && !before.some(a => a.includes('mcp_servers')))
})

await test('argv: near-miss input is refused, never coerced', async () => {
  const { codexSourceOnlyArgs } = await so()
  const bad = [{ ...INPUT, catalogFile: 'cat.json' }, { ...INPUT, catalogFile: '/a\0b' }, { ...INPUT, reader: { ...READER, url: 'http://localhost:1/mcp' } },
    { ...INPUT, reader: { ...READER, url: 'https://127.0.0.1:1/mcp' } }, { ...INPUT, reader: { ...READER, url: 'http://127.0.0.1:1/mcp?x=1' } },
    { ...INPUT, reader: { ...READER, url: 'http://127.0.0.1:1/mcp/' } }, { ...INPUT, reader: { ...READER, authEnv: 'lower' } },
    { ...INPUT, reader: { ...READER, authEnv: 'A B' } }, { ...INPUT, reader: null }, { ...INPUT, reader: [] }, null, 'x', []]
  for (const input of bad) assert.throws(() => codexSourceOnlyArgs(input), error => coded(error) || error.code === 'INVALID_RUNTIME_INPUT', JSON.stringify(input)?.slice(0, 60))
  assert.throws(() => codexSourceOnlyArgs({ ...INPUT, model: '-m' }), error => error.code === 'INVALID_CODEX_EXEC_INPUT')
  let ran = false
  const trap = Object.defineProperty({ ...INPUT }, 'model', { get() { ran = true; return 'm' }, enumerable: true })
  assert.throws(() => codexSourceOnlyArgs(trap))
  assert.equal(ran, false)
})

await test('catalog: only the model entry, with apply_patch, experimental tools and multi-agent removed and tool_mode kept', async () => {
  const { restrictedModelCatalog } = await so()
  const catalog = { models: [{ slug: 'a', tool_mode: 'code_mode_only', apply_patch_tool_type: 'freeform', experimental_supported_tools: ['clock'], multi_agent_version: 'v2', keep: 1 },
    { slug: 'b', apply_patch_tool_type: 'freeform' }] }
  const out = JSON.parse(restrictedModelCatalog(catalog, 'a'))
  assert.deepEqual(out, { models: [{ slug: 'a', tool_mode: 'code_mode_only', apply_patch_tool_type: null, experimental_supported_tools: [], multi_agent_version: null, keep: 1 }] })
  assert.equal(catalog.models[0].apply_patch_tool_type, 'freeform', 'the input is not edited')
  assert.throws(() => restrictedModelCatalog(catalog, 'c'), e => e.code === 'SOURCE_ONLY_MODEL_MISSING')
  assert.throws(() => restrictedModelCatalog(catalog, 'A'), e => e.code === 'SOURCE_ONLY_MODEL_MISSING')
  assert.throws(() => restrictedModelCatalog({ models: 'x' }, 'a'), coded)
})

const body = ({ nested = ['list_mcp_resource_templates', 'list_mcp_resources', 'read_mcp_resource'], top = ['exec', 'wait'], deferred = ['mcp__reader'], tools = [] } = {}) => ({
  tools,
  input: [{ type: 'additional_tools', tools: [{ type: 'namespace', name: 'functions', tools: top.map(name => ({ name, description: name === 'exec' ? nested.map(n => `### \`${n}\`\nx`).join('\n') : '' })) }] },
    { type: 'message', content: [{ type: 'input_text', text: `<tools>\nDeferred tool namespaces:\n${deferred.map(d => `- ${d}`).join('\n')}\n</tools>` }] }],
})

await test('wire: the restricted inventory passes; every extra tool, anywhere, is a problem', async () => {
  const { wireInventoryProblems } = await so()
  assert.deepEqual(wireInventoryProblems(body()), [])
  const cases = [
    [body({ nested: ['list_mcp_resources', 'exec_command'] }), /nested-in-exec.*exec_command/],
    [body({ nested: ['apply_patch'] }), /nested-in-exec.*apply_patch/],
    [body({ top: ['exec', 'wait', 'spawn_agent'] }), /top-level.*spawn_agent/],
    [body({ deferred: ['mcp__reader', 'mcp__codex_apps__github'] }), /deferred-namespaces.*mcp__codex_apps__github/],
    [body({ tools: [{ type: 'web_search' }] }), /request\.tools\[\] is not empty/],
    [body({ deferred: [] }), /reader namespace is missing/],
  ]
  for (const [input, pattern] of cases) assert.match(wireInventoryProblems(input).join('\n'), pattern)
})

await test('wire: a hosted tool, an unnamed tool, a garbage body and a changed shape all fail closed', async () => {
  const { wireInventoryProblems } = await so()
  const hosted = body(); hosted.input[0].tools.push({ type: 'web_search' })
  assert.match(wireInventoryProblems(hosted).join(), /top-level.*<web_search>/)
  const unnamed = body(); unnamed.input[0].tools[0].tools.push({ description: 'x' })
  assert.match(wireInventoryProblems(unnamed).join(), /top-level.*<unnamed>/)
  for (const junk of [null, undefined, 0, 'x', [], {}, { input: 'x' }, { input: [] }, { input: [null, 3] }]) assert.ok(wireInventoryProblems(junk).length > 0, JSON.stringify(junk))
  assert.ok(wireInventoryProblems({ tools: 'legacy', input: body().input }).length > 0)
  const noTools = body(); noTools.input[0].tools = 'x'
  assert.ok(wireInventoryProblems(noTools).length > 0)
})

await test('preflight: the clean fake passes with one request, on the exact leaf argv plus only the loopback provider', async () => {
  const { runWirePreflight, codexSourceOnlyArgs } = await so()
  const record = join(WORK, 'clean.jsonl')
  const args = codexSourceOnlyArgs(INPUT)
  const result = await runWirePreflight({ codexBin: BIN, args, cwd: WORK, env: env({ FAKE_CODEX_RECORD: record, FAKE_CODEX_WIRE: 'clean' }) })
  assert.deepEqual(result, { ok: true, problems: [], requests: 1 })
  const { readFileSync } = await import('node:fs')
  const argv = JSON.parse(readFileSync(record, 'utf8').trim().split('\n').at(-1)).argv
  const withoutProvider = argv.filter((a, i) => !/^model_provider/.test(a) && !(a === '-c' && /^model_provider/.test(argv[i + 1])))
  assert.deepEqual(withoutProvider, args)
})

await test('preflight: exec_command on the wire refuses; so does no request, an unreadable encoding and a missing trailing prompt flag', async () => {
  const { runWirePreflight, codexSourceOnlyArgs } = await so()
  const args = codexSourceOnlyArgs(INPUT)
  const run = wire => runWirePreflight({ codexBin: BIN, args, cwd: WORK, env: env({ FAKE_CODEX_WIRE: wire }) })
  const bad = await run('exec_command')
  assert.equal(bad.ok, false)
  assert.match(bad.problems.join(), /nested-in-exec.*exec_command.*write_stdin|nested-in-exec.*write_stdin.*exec_command/)
  assert.match((await run('no_request')).problems.join(), /no Responses request/)
  assert.equal((await run('gzip')).ok, true, 'a gzip body is decoded, not guessed at')
  await assert.rejects(runWirePreflight({ codexBin: BIN, args: args.slice(0, -1), cwd: WORK, env: env() }), coded)
  await assert.rejects(runWirePreflight({ codexBin: 'codex', args, cwd: WORK, env: env() }), coded)
})

await test('version and bundled catalog readers: parsed from the CLI, unknown output refused', async () => {
  const { codexVersion, readBundledCatalog, SOURCE_ONLY_PINNED_VERSIONS } = await so()
  assert.equal(codexVersion({ codexBin: BIN, env: env() }), '0.167.0')
  assert.ok(SOURCE_ONLY_PINNED_VERSIONS.includes('0.167.0'))
  assert.equal(codexVersion({ codexBin: BIN, env: env({ FAKE_CODEX_VERSION: '9.9.9-beta.1' }) }), '9.9.9-beta.1')
  assert.deepEqual(readBundledCatalog({ codexBin: BIN, env: env({ FAKE_CODEX_MODELS: 'a,b' }) }).models.map(m => m.slug), ['a', 'b'])
  const junk = join(WORK, 'junk'); writeFileSync(junk, '#!/bin/sh\necho not-codex\n'); chmodSync(junk, 0o755)
  assert.throws(() => codexVersion({ codexBin: junk, env: env() }), e => e.code === 'SOURCE_ONLY_VERSION_UNKNOWN')
  assert.throws(() => readBundledCatalog({ codexBin: junk, env: env() }), e => e.code === 'SOURCE_ONLY_CATALOG_UNREADABLE')
})
