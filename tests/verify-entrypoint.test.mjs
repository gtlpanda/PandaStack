import assert from 'node:assert/strict'
import fs from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { Worker } from 'node:worker_threads'
import { test } from '../scripts/workflow-harness.mjs'

const source = fileURLToPath(new URL('../core/skills/verify/retention.mjs', import.meta.url))

// Exercise the actual module entry guard with fresh module caches and argv.
// These workers never invoke step/relay or launch any child process.
async function probe(modulePath, entry, args = ['invalid-operation']) {
  const worker = new Worker(`
    const { parentPort, workerData } = require('node:worker_threads');
    process.argv = [process.execPath];
    if (workerData.entry !== null) process.argv.push(workerData.entry, ...workerData.args);
    const lines = [], errors = [];
    console.log = value => lines.push(String(value));
    console.error = value => errors.push(String(value));
    import(workerData.url).then(module => {
      parentPort.postMessage({ code: process.exitCode ?? 0, lines, errors, exports: Object.keys(module) });
      process.exitCode = 0;
    }).catch(error => { throw error; });
  `, { eval: true, execArgv: [], workerData: { url: pathToFileURL(modulePath).href, entry, args } })
  let timer
  try {
    return await new Promise((resolve, reject) => {
      let result
      timer = setTimeout(() => reject(new Error('verification entry worker deadline')), 5000)
      worker.on('message', value => { result = value })
      worker.once('error', reject)
      worker.once('exit', code => code === 0 && result ? resolve(result) : reject(new Error(`verification entry worker exited ${code}`)))
    })
  } finally { clearTimeout(timer); await worker.terminate() }
}

async function fixture(run) {
  const root = fs.mkdtempSync(join(tmpdir(), 'verify-entry-'))
  try {
    const skills = join(root, '.claude', 'skills')
    fs.mkdirSync(skills, { recursive: true })
    const directory = join(skills, 'verify')
    fs.symlinkSync(fileURLToPath(new URL('../core/skills/verify/', import.meta.url)), directory, 'dir')
    const linked = join(directory, 'retention.mjs'), file = join(root, 'helper link.mjs')
    fs.symlinkSync(linked, file)
    const evidence = join(root, 'evidence')
    fs.mkdirSync(evidence, { mode: 0o700 })
    await run({ root, linked, file, evidence })
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
}

await test('retention rejects invalid operations through canonical, directory and file symlink entries', async () => {
  await fixture(async ({ linked, file, evidence }) => {
    for (const entry of [source, linked, file, relative(process.cwd(), linked)]) {
      const result = await probe(linked, entry)
      assert.equal(result.code, 125, entry)
      assert.deepEqual(result.lines, [])
      assert.deepEqual(result.errors, ['Verification evidence capture failed'])
    }
    assert.deepEqual(fs.readdirSync(evidence), [])
  })
})

await test('retention imports stay inert with absent, unrelated and unresolvable argv entries', async () => {
  await fixture(async ({ root, linked, file, evidence }) => {
    const unrelated = join(root, 'unrelated.mjs'), missing = join(root, 'missing.mjs')
    fs.writeFileSync(unrelated, '')
    const broken = join(root, 'broken.mjs')
    fs.symlinkSync(missing, broken)
    for (const modulePath of [source, linked, file]) {
      for (const entry of [null, '', unrelated, missing, broken]) {
        const result = await probe(modulePath, entry, ['init', evidence])
        assert.equal(result.code, 0)
        assert.deepEqual(result.lines, [])
        assert.deepEqual(result.errors, [])
        assert.ok(result.exports.includes('verifyManifest'))
        assert.deepEqual(fs.readdirSync(evidence), [])
      }
    }
  })
})

await test('installed retention init and finalize dispatch retain a private real manifest', async () => {
  await fixture(async ({ linked, evidence }) => {
    const result = await probe(linked, linked, ['init', evidence])
    assert.equal(result.code, 0)
    assert.deepEqual(result.errors, [])
    assert.equal(result.lines.length, 1)
    const dir = result.lines[0]
    assert.equal(fs.realpathSync(dir), dir)
    assert.equal(relative(evidence, dir).split('/').length, 1)
    assert.match(relative(evidence, dir), /^run-/)
    assert.equal(fs.statSync(dir).mode & 0o777, 0o700)
    const manifest = join(dir, 'manifest.json')
    assert.equal(fs.statSync(manifest).mode & 0o777, 0o600)
    assert.deepEqual(JSON.parse(fs.readFileSync(manifest, 'utf8')), { schemaVersion: 1, steps: [] })
    assert.equal(fs.readFileSync(join(dir, '.budget'), 'utf8'), '0')
    const finalized = await probe(linked, linked, ['finalize', dir, dir])
    assert.equal(finalized.code, 0)
    assert.deepEqual(finalized.errors, [])
    assert.deepEqual(JSON.parse(fs.readFileSync(manifest, 'utf8')), { schemaVersion: 1, steps: [], children: [] })
  })
})

await test('installed retention keeps capture failures safe and nonzero', async () => {
  await fixture(async ({ linked, evidence }) => {
    fs.chmodSync(evidence, 0o755)
    const result = await probe(linked, linked, ['init', evidence])
    assert.equal(result.code, 125)
    assert.deepEqual(result.lines, [])
    assert.deepEqual(result.errors, ['Verification evidence capture failed'])
    assert.deepEqual(fs.readdirSync(evidence), [])
  })
})
