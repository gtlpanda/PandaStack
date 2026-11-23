#!/usr/bin/env node
// A fake `codex` for the source-only profile's tests. No model, no network beyond loopback.
//   --version               -> codex-cli <FAKE_CODEX_VERSION, default 0.167.0>
//   debug models --bundled  -> a catalog holding FAKE_CODEX_MODELS (comma list, default gpt-6.1-sol)
//   exec ... (preflight)    -> argv carries model_providers.preflight.base_url: POST one Responses
//                              body whose tool inventory follows FAKE_CODEX_WIRE (clean | exec_command |
//                              no_request | gzip)
//   exec ... (leaf)         -> read the prompt from stdin, answer with the object the module named by
//                              FAKE_CODEX_ANSWER returns (default export (prompt) => object), write it to
//                              --output-last-message and print the JSONL a real run prints.
// Every invocation appends {argv, env} (env limited to FAKE_CODEX_ENV_KEYS) to FAKE_CODEX_RECORD.
import { appendFileSync, writeFileSync } from 'node:fs'
import { gzipSync } from 'node:zlib'
import { pathToFileURL } from 'node:url'

const argv = process.argv.slice(2)
const env = process.env
if (env.FAKE_CODEX_RECORD) {
  const keys = (env.FAKE_CODEX_ENV_KEYS ?? '').split(',').filter(Boolean)
  appendFileSync(env.FAKE_CODEX_RECORD, JSON.stringify({ argv, env: Object.fromEntries(keys.map(k => [k, env[k] ?? null])), cwd: process.cwd() }) + '\n')
}
const after = flag => argv[argv.indexOf(flag) + 1]
if (argv[0] === '--version') { console.log(`codex-cli ${env.FAKE_CODEX_VERSION ?? '0.167.0'}`); process.exit(0) }
if (argv[0] === 'debug' && argv[1] === 'models') {
  const models = (env.FAKE_CODEX_MODELS ?? 'gpt-6.1-sol').split(',').map(slug => ({ slug, apply_patch_tool_type: 'freeform',
    experimental_supported_tools: ['clock'], multi_agent_version: 'v2', tool_mode: 'code_mode_only', shell_type: 'unified_exec' }))
  console.log(JSON.stringify({ models }))
  process.exit(0)
}
if (argv[0] !== 'exec') process.exit(2)

let stdin = ''
for await (const chunk of process.stdin) stdin += chunk
const configs = argv.flatMap((a, i) => (a === '-c' ? [argv[i + 1]] : []))
const baseUrl = configs.map(c => /^model_providers\.preflight\.base_url="(.*)"$/.exec(c)?.[1]).find(Boolean)

if (baseUrl) {
  const mode = env.FAKE_CODEX_WIRE ?? 'clean'
  if (mode === 'no_request') process.exit(0)
  const nested = ['list_mcp_resource_templates', 'list_mcp_resources', 'read_mcp_resource', ...(mode === 'exec_command' ? ['exec_command', 'write_stdin'] : [])]
  const body = { model: after('--model'), input: [
    { type: 'additional_tools', role: 'developer', tools: [{ type: 'namespace', name: 'functions', tools: [
      { name: 'exec', description: nested.map(n => `### \`${n}\`\ndescription`).join('\n') }, { name: 'wait', description: 'wait' }] }] },
    { type: 'message', role: 'developer', content: [{ type: 'input_text', text: '<tools>\nDeferred tool namespaces:\n- mcp__reader\n</tools>' }] },
  ], tools: [] }
  const raw = Buffer.from(JSON.stringify(body))
  const gz = mode === 'gzip'
  const res = await fetch(`${baseUrl}/responses`, { method: 'POST', headers: { 'content-type': 'application/json', ...(gz ? { 'content-encoding': 'gzip' } : {}) }, body: gz ? gzipSync(raw) : raw })
  await res.text()
  process.exit(0)
}

const answer = await (await import(pathToFileURL(env.FAKE_CODEX_ANSWER).href)).default(stdin, { argv, env })
const out = after('--output-last-message')
if (out) writeFileSync(out, JSON.stringify(answer))
console.log(JSON.stringify({ type: 'thread.started', thread_id: 'fake' }))
console.log(JSON.stringify({ type: 'item.completed', item: { id: 'item_0', type: 'agent_message', text: JSON.stringify(answer) } }))
console.log(JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 10, cached_input_tokens: 0, output_tokens: 5, reasoning_output_tokens: 0 } }))
