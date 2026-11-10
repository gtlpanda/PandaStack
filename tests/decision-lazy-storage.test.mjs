import assert from 'node:assert/strict'
import { Worker } from 'node:worker_threads'
import { test } from '../scripts/workflow-harness.mjs'

// Each worker has a fresh ESM cache, even when the aggregate runner has already
// loaded SQLite. Deny only the real builtin, without replacing any product API.
async function probe(mode, deny = true) {
  const worker = new Worker(`
    const { parentPort, workerData } = require('node:worker_threads');
    (async () => {
      const { registerHooks } = await import('node:module');
      const fs = await import('node:fs');
      const { tmpdir } = await import('node:os');
      const { join } = await import('node:path');
      const root = fs.mkdtempSync(join(tmpdir(), 'decision-lazy-'));
      const store = join(root, 'queue');
      const imports = [], observed = [];
      let reads = 0;
      const hook = registerHooks({ resolve(specifier, context, nextResolve) {
        if (specifier === 'node:sqlite') {
          imports.push(specifier);
          if (workerData.deny) throw Object.assign(new Error('No such built-in module: node:sqlite'), { code: 'ERR_UNKNOWN_BUILTIN_MODULE' });
        }
        return nextResolve(specifier, context);
      }});
      try {
        if (workerData.mode === 'help') {
          // Eval workers invent a non-file argv[1]; use Node -e's absent entry
          // path while importing the CLI as a library, then call main explicitly.
          process.argv = [process.execPath];
          const { main } = await import(workerData.cli);
          const lines = [], originalLog = console.log;
          let status;
          try { console.log = line => lines.push(line); status = await main(['--help']); }
          finally { console.log = originalLog; }
          parentPort.postMessage({ status, lines, imports, storeExists: fs.existsSync(store) });
          return;
        }
        const { prepareDecisionGate, validateDecisionFeature, decisionRevision } = await import(workerData.gate);
        const { resolveManagedConfig } = await import(workerData.config);
        const decisions = { store, runId: 'logical', featureId: 'F-1', ids: ['choice'], timeoutMs: 0 };
        const feature = { id: 'F-1', passes: false };
        const config = { root, decisions };
        if (workerData.mode === 'pure') {
          validateDecisionFeature(config, { features: [feature] });
          const resolved = resolveManagedConfig({ project: { decisions } });
          parentPort.postMessage({ imports, storeExists: fs.existsSync(store), decisions: resolved.decisions, revisionHelper: typeof decisionRevision });
          return;
        }
        if (workerData.mode === 'disabled') delete config.decisions;
        if (workerData.mode.includes('completed')) feature.passes = true;
        if (workerData.mode.includes('unassigned')) feature.id = 'F-2';
        if (workerData.mode.startsWith('invalid')) decisions.ids = [];
        const trace = new Proxy({}, { get: (_, method) => () => { observed.push(String(method)); } });
        let result;
        try {
          const gate = await prepareDecisionGate({ config, feature, trace, readRevision: () => { reads++; return 'a'.repeat(40); } });
          result = { returnedNull: gate === null };
          gate?.close();
        } catch (error) { result = { code: error.code }; }
        parentPort.postMessage({ ...result, imports, reads, observed, storeExists: fs.existsSync(store) });
      } finally {
        hook.deregister();
        fs.rmSync(root, { recursive: true, force: true });
      }
    })().catch(error => { throw error; });
  `, { eval: true, execArgv: [], workerData: { mode, deny,
    cli: new URL('../graphs/autobuild/tool/lib/cli.mjs', import.meta.url).href,
    gate: new URL('../graphs/autobuild/tool/lib/decisions.mjs', import.meta.url).href,
    config: new URL('../graphs/autobuild/tool/lib/config.mjs', import.meta.url).href } })
  let timer
  try {
    return await new Promise((resolve, reject) => {
      let result
      timer = setTimeout(() => reject(new Error('lazy storage worker deadline')), 10000)
      worker.on('message', value => { result = value })
      worker.once('error', reject)
      worker.once('exit', code => code === 0 && result ? resolve(result) : reject(new Error(`lazy storage worker exited ${code}`)))
    })
  } finally { clearTimeout(timer); await worker.terminate() }
}

await test('pure managed inspection validates enabled decisions with SQLite unavailable', async () => {
  const result = await probe('pure')
  assert.deepEqual(result.imports, [])
  assert.equal(result.storeExists, false)
  assert.equal(result.revisionHelper, 'function')
  assert.deepEqual(result.decisions.ids, ['choice'])
  assert.equal(result.decisions.featureId, 'F-1')
})

await test('imported CLI help keeps usage output with SQLite unavailable', async () => {
  const result = await probe('help')
  assert.equal(result.status, 0)
  assert.match(result.lines.join('\n'), /autobuild run/)
  assert.deepEqual(result.imports, [])
  assert.equal(result.storeExists, false)
})

await test('skipped gates avoid storage resolution, HEAD and observations', async () => {
  for (const mode of ['disabled', 'completed', 'unassigned']) {
    assert.deepEqual(await probe(mode), { returnedNull: true, imports: [], reads: 0, observed: [], storeExists: false })
  }
})

await test('invalid decisions cannot bypass validation on completed or unassigned gates', async () => {
  for (const mode of ['invalid-completed', 'invalid-unassigned', 'invalid-assigned']) {
    assert.deepEqual(await probe(mode), { code: 'INVALID_DECISION', imports: [], reads: 0, observed: [], storeExists: false })
  }
})

await test('assigned gate attempts SQLite and preserves real queue failure with storage available', async () => {
  const denied = await probe('assigned')
  assert.ok(['ERR_UNKNOWN_BUILTIN_MODULE', 'IO_ERROR'].includes(denied.code))
  assert.ok(denied.imports.length > 0)
  assert.equal(denied.storeExists, false)
  assert.deepEqual(denied.observed, [])
  const allowed = await probe('assigned', false)
  assert.equal(allowed.code, 'NOT_FOUND')
  assert.ok(allowed.imports.length > 0)
  assert.equal(allowed.storeExists, true)
  assert.equal(allowed.reads, 1)
  assert.deepEqual(allowed.observed, ['startWait'])
})
