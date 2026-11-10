import assert from 'node:assert/strict'
import fs from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { Worker } from 'node:worker_threads'
import { test } from '../scripts/workflow-harness.mjs'

const source = fileURLToPath(new URL('../core/skills/verify/retention.mjs', import.meta.url))
const boot = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
const record = `1\t11111111-2222-3333-4444-555555555555\t${boot}\t101\t1\t202\t2\t202\n`

// Each worker has fresh ESM bindings and a spawn stub. These checks never run
// capture-owner.sh or a payload. Synthetic observations test admission only.
async function probe(scope, receipt, { fifo = false, observed = false } = {}) {
  const worker = new Worker(`
    const { parentPort, workerData } = require('node:worker_threads');
    const fs = require('node:fs'), childProcess = require('node:child_process');
    const { syncBuiltinESMExports } = require('node:module');
    const { EventEmitter } = require('node:events');
    const { PassThrough } = require('node:stream');
    const calls = [], errors = [], lines = [];
    process.env.VERIFY_CAPTURE_SCOPE_DIR = workerData.scope;
    process.argv = [process.execPath, workerData.source, 'relay', '--receipt', workerData.receipt, '--', 'INERT_PAYLOAD'];
    console.error = value => errors.push(String(value));
    console.log = value => lines.push(String(value));
    const lstat = fs.lstatSync, read = fs.readFileSync;
    if (workerData.fifo) fs.lstatSync = function(path, ...args) {
      const st = lstat.call(fs, path, ...args);
      if (path === workerData.scope + '/stop') st.isFIFO = () => true;
      return st;
    };
    if (workerData.observed) fs.readFileSync = function(path, ...args) {
      if (path === '/proc/sys/kernel/random/boot_id') return workerData.boot + '\\n';
      const match = /^\\/proc\\/([0-9]+)\\/stat$/.exec(String(path));
      if (match) {
        const pid = Number(match[1]), rows = {
          101: [90, 90, '1'], 202: [101, 202, '2'], [process.pid]: [202, 202, '3']
        }, row = rows[pid];
        if (!row) throw Error('unexpected synthetic proc read');
        const fields = Array(20).fill('0'); fields[0] = 'S'; fields[1] = String(row[0]);
        fields[2] = String(row[1]); fields[19] = row[2];
        return pid + ' (inert fixture) ' + fields.join(' ');
      }
      return read.call(fs, path, ...args);
    };
    childProcess.spawn = (command, args, options) => {
      calls.push({ command, args, detached: options.detached, stdio: options.stdio });
      const child = new EventEmitter(); child.stdout = new PassThrough();
      queueMicrotask(() => { child.stdout.end(); child.emit('close', 0); });
      return child;
    };
    syncBuiltinESMExports();
    import(workerData.url).then(() => {
      parentPort.postMessage({ code: process.exitCode ?? 0, calls, errors, lines });
      process.exitCode = 0;
    }).catch(error => { throw error; });
  `, { eval: true, execArgv: [], workerData: { scope, receipt, source, url: pathToFileURL(source).href, fifo, observed, boot } })
  let timer
  try {
    return await new Promise((resolve, reject) => {
      let result
      timer = setTimeout(() => reject(Error('scope admission worker deadline')), 5000)
      worker.on('message', value => { result = value })
      worker.once('error', reject)
      worker.once('exit', code => code === 0 && result ? resolve(result) : reject(Error(`scope admission worker exited ${code}`)))
    })
  } finally { clearTimeout(timer); await worker.terminate() }
}

async function fixture(work) {
  const root = fs.mkdtempSync(join(tmpdir(), 'verify-scope-adapter-'))
  fs.chmodSync(root, 0o700)
  const scope = join(root, 'scope'), receipt = join(root, 'capture.json')
  fs.mkdirSync(scope, { mode: 0o700 })
  fs.writeFileSync(join(scope, 'scope-v1.tsv'), record, { mode: 0o600 })
  fs.writeFileSync(join(scope, 'stop'), '', { mode: 0o600 })
  try { await work({ root, scope, receipt }) } finally { fs.rmSync(root, { recursive: true, force: true }) }
}

async function refuse(scope, receipt, options) {
  const result = await probe(scope, receipt, { fifo: true, observed: true, ...options })
  assert.equal(result.code, 125)
  assert.deepEqual(result.calls, [])
  assert.ok(result.errors.every(value => value === 'Verification evidence capture failed'))
  assert.deepEqual(result.lines, [])
  if (fs.existsSync(receipt)) assert.deepEqual(JSON.parse(fs.readFileSync(receipt, 'utf8')),
    { schemaVersion: 1, exitCode: 125, bytes: 0, complete: false })
}

await test('Node scope admission refuses empty, relative and nonnormalized present hints before spawn', async () => {
  for (const select of [() => '', () => 'relative/scope', ({ scope }) => scope + '/',
    ({ scope }) => scope + '/.', ({ scope }) => scope + '/..', ({ scope }) => scope + '\n']) {
    await fixture(async value => { await refuse(select(value), value.receipt) })
  }
})

await test('Node scope admission refuses symlink components and nonprivate leaves before spawn', async () => {
  await fixture(async ({ root, scope, receipt }) => {
    const alias = join(root, 'alias'); fs.symlinkSync(scope, alias, 'dir')
    await refuse(alias, receipt)
    const parentAlias = join(root, 'parent-alias'); fs.symlinkSync(root, parentAlias, 'dir')
    await refuse(join(parentAlias, 'scope'), receipt)
  })
  for (const mode of [0o755, 0o1700, 0o2700, 0o4700]) {
    await fixture(async ({ scope, receipt }) => { fs.chmodSync(scope, mode); await refuse(scope, receipt) })
  }
})

await test('Node scope admission refuses nonregular records and nonFIFO or unsafe stop metadata before spawn', async () => {
  await fixture(async ({ scope, receipt }) => { await refuse(scope, receipt, { fifo: false }) })
  await fixture(async ({ scope, receipt }) => {
    fs.chmodSync(join(scope, 'stop'), 0o644)
    await refuse(scope, receipt, { fifo: true })
  })
  for (const type of ['directory', 'symlink', 'unsafe-mode']) {
    await fixture(async ({ root, scope, receipt }) => {
      const path = join(scope, 'scope-v1.tsv')
      if (type === 'unsafe-mode') fs.chmodSync(path, 0o644)
      else {
        fs.unlinkSync(path)
        if (type === 'directory') fs.mkdirSync(path, { mode: 0o600 })
        else { const target = join(root, 'record'); fs.writeFileSync(target, record, { mode: 0o600 }); fs.symlinkSync(target, path) }
      }
      await refuse(scope, receipt, { fifo: true })
    })
  }
})

await test('Node scope admission refuses malformed and oversized inert records before spawn', async () => {
  for (const bytes of [record.slice(0, -1), record + '\n', 'x'.repeat(257)]) {
    await fixture(async ({ scope, receipt }) => {
      fs.writeFileSync(join(scope, 'scope-v1.tsv'), bytes)
      await refuse(scope, receipt, { fifo: true })
    })
  }
})

await test('Node valid synthetic scope observations select inherited nondetached spawn', async () => {
  await fixture(async ({ scope, receipt }) => {
    const result = await probe(scope, receipt, { fifo: true, observed: true })
    assert.equal(result.code, 0)
    assert.deepEqual(result.errors, [])
    assert.equal(result.calls.length, 1)
    assert.equal(result.calls[0].command, 'bash')
    assert.equal(result.calls[0].detached, false)
    assert.deepEqual(result.calls[0].args.slice(1), ['run', scope, '--', 'INERT_PAYLOAD'])
    assert.deepEqual(result.calls[0].stdio, ['ignore', 'pipe', 'ignore'])
    assert.deepEqual(JSON.parse(fs.readFileSync(receipt, 'utf8')), { schemaVersion: 1, exitCode: 0, bytes: 0, complete: true })
  })
})
