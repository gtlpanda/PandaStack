// Inert protocol and static metadata only; no target code or child processes.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import cp from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, lstatSync, symlinkSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { test } from '../../../scripts/workflow-harness.mjs';
import { readCodexResult } from '../../autobuild/tool/lib/codex.mjs';
import { classifyOutcome } from '../../autobuild/tool/lib/limits.mjs';
import { adoptNativeHuntRefusal } from '../skills/bughunt/native-runner.mjs';
import { publishNativeRefusal, publishNativePartialStatus, readRefusalAtCommon, readPartialStatusAtCommon,
  renderNativeHuntPartialStatus, nativeArtifactReference, nativeArtifactHash, prepareRefusalAdoption, assertNativeData, assertNativeHuntAdmission } from '../skills/bughunt/native-status.mjs';

const message = 'This content was flagged for possible cybersecurity risk.';
const events = rows => rows.map(r => JSON.stringify(r)).join('\n') + '\n';
function fixture(fn) {
  const root = mkdtempSync(join(tmpdir(), 'native-refusal-static-'));
  const common = join(root, 'common'), stateDir = join(common, 'bughunt', 'ordinary'), runDir = join(stateDir, 'native', 'saved-fixture');
  mkdirSync(runDir, { recursive: true, mode: 0o700 }); mkdirSync(join(stateDir, 'tree'));
  const leaf = { id: '001-impact-mapper', role: 'impact-mapper', label: 'impact-map' };
  const intake = { version: 1, key: 'ordinary', repo: root, stateDir, tree: join(stateDir, 'tree'), target: { kind: 'branch', label: 'ordinary', base: 'main', head: 'a'.repeat(40) } };
  const file = join(runDir, `${leaf.id}.jsonl`), intakeFile = join(stateDir, 'intake.json'), resultFile = join(runDir, 'result.json');
  writeFileSync(file, events([{ type: 'turn.failed', error: { message } }]), { mode: 0o600 });
  writeFileSync(intakeFile, JSON.stringify(intake));
  const result = { status: 'escalate', reason: 'Generic saved fixture', mode: 'discover', head: intake.target.head, findings: [], added: [], merged: [], dropped: [], coverage: [], routing: null, impact: null, history: [] };
  writeFileSync(resultFile, JSON.stringify(result));
  const reference = nativeArtifactReference(common, file), protocol = { ...reference, event: 'turn.failed', line: 1 };
  const rows = [{ ...leaf, state: 'blocked', protocol: reference, output: null }];
  const args = { common, intake, runDir, leaf, protocol };
  const publish = () => publishNativeRefusal(args);
  const adoption = () => ({ repo: root, common, intakeFile, runDir, leaf,
    expected: { intakeSha256: nativeArtifactHash(readFileSync(intakeFile)), protocolSha256: nativeArtifactHash(readFileSync(file)), resultSha256: nativeArtifactHash(readFileSync(resultFile)) } });
  try { return fn({ root, common, stateDir, runDir, intakeFile, resultFile, file, leaf, intake, result, rows, args, publish, adoption }); }
  finally { rmSync(root, { recursive: true, force: true }); }
}
const receiptFile = f => join(f.common, 'native-hunt-refusal.json');
const statusFile = f => join(f.runDir, 'status.json');
const writeStatus = (f, s) => writeFileSync(statusFile(f), JSON.stringify(s));
const invalid = { code: 'REFUSAL_STATE_INVALID' };

await test('native refusal protocol: exact slots, first line and sticky outcome', () => fixture(f => {
  writeFileSync(f.file, '\n' + events([null, { type: 'error', message: message + ' ignored tail' }, { type: 'turn.failed', error: { message } }, { type: 'turn.completed' }]));
  const result = readCodexResult(f.file);
  assert.deepEqual(result.providerRefusal, { kind: 'provider_refusal', retryable: false, event: 'error', line: 3 });
  assert.equal(result.is_error, true); assert.doesNotMatch(result.result, /ignored tail/);
  assert.equal(classifyOutcome({ result, text: 'overloaded', stopFailure: { error: 'rate_limit' } }).kind, 'provider_refusal');
}));
await test('native refusal protocol: nested or near-match text is not a refusal; ordinary terminal ordering survives', () => fixture(f => {
  for (const row of [{ type: 'error', error: { message } }, { type: 'turn.failed', message }, { type: 'error', message: 'quote ' + message }, { type: 'error', message: message.toLowerCase() }, { type: 'item.completed', item: { type: 'agent_message', text: message } }]) {
    writeFileSync(f.file, events([row, { type: 'turn.completed' }]));
    const r = readCodexResult(f.file); assert.equal(r.providerRefusal, undefined); assert.equal(r.subtype, 'success');
  }
  writeFileSync(f.file, events([{ type: 'turn.completed' }, { type: 'error', message: 'ordinary failure' }]));
  assert.equal(readCodexResult(f.file).is_error, true);
  assert.equal(classifyOutcome({ result: { result: message } }).kind, 'normal');
}));
await test('native refusal receipt: first publication is immutable, private and retained without evidence', () => fixture(f => {
  const r = f.publish(), bytes = readFileSync(receiptFile(f));
  assert.deepEqual(f.publish(), r); assert.deepEqual(readFileSync(receiptFile(f)), bytes);
  assert.equal(lstatSync(receiptFile(f)).mode & 0o777, 0o600);
  unlinkSync(f.file);
  assert.deepEqual(readRefusalAtCommon(f.common), r);
  assert.deepEqual(readPartialStatusAtCommon(f.common).report, { state: 'pending', text: null });
}));
await test('native refusal receipt: malformed, oversized, linked and nonregular data fail closed', () => fixture(f => {
  assert.equal(readRefusalAtCommon(f.common), null);
  for (const contents of ['{}', '{', ' '.repeat(65537)]) {
    writeFileSync(receiptFile(f), contents); assert.throws(() => readRefusalAtCommon(f.common), invalid);
  }
  unlinkSync(receiptFile(f)); mkdirSync(receiptFile(f)); assert.throws(() => readRefusalAtCommon(f.common), invalid);
  rmSync(receiptFile(f), { recursive: true }); symlinkSync(f.file, receiptFile(f)); assert.throws(() => readRefusalAtCommon(f.common), invalid);
}));
await test('native refusal receipt: unknown fields, paths and identities are rejected', () => fixture(f => {
  const r = f.publish();
  for (const mutate of [r => { r.extra = true; }, r => { r.retryable = true; }, r => { r.run.directory = '../outside'; }, r => { r.statusPath += '.extra'; }, r => { r.protocol.path = 'bughunt/other/native/run/001-hunter.jsonl'; }, r => { r.leaf.role = 'runner'; }, r => { r.protocol.line = 0; }, r => { r.observedAt = 'invalid'; }]) {
    const bad = structuredClone(r); mutate(bad); writeFileSync(receiptFile(f), JSON.stringify(bad));
    assert.throws(() => readRefusalAtCommon(f.common), invalid);
  }
}));
await test('native partial report: private bounded status, honest counts and exact semantic freshness', () => fixture(f => {
  const r = f.publish(); publishNativePartialStatus(r, f.rows, f.resultFile, f.result);
  const view = readPartialStatusAtCommon(f.common);
  assert.equal(view.report.state, 'current'); assert.equal(view.report.text, renderNativeHuntPartialStatus(view.status));
  assert.deepEqual(view.status.counts, { completed: 0, pending: 0, active: 0, failed: 0, blocked: 1 });
  assert.equal(view.status.result.sha256, nativeArtifactHash(readFileSync(f.resultFile)));
  for (const path of [statusFile(f), join(f.runDir, 'partial-report.md')]) assert.equal(lstatSync(path).mode & 0o777, 0o600);
  assert.match(view.report.text, /source-only/); assert.match(view.report.text, /unknown/);
  assert.doesNotMatch(view.report.text, /rerun|rephrase|remove[^\n]*lock/);
  const changed = structuredClone(view.status); changed.coverage = [{ lens: 'logic', status: 'partial', areas: 1 }]; writeStatus(f, changed);
  assert.deepEqual(readPartialStatusAtCommon(f.common).report, { state: 'stale', text: null });
}));
await test('native partial report: report tampering/missing/linked prose never clears receipt', () => fixture(f => {
  const r = f.publish(); publishNativePartialStatus(r, f.rows);
  const report = join(f.runDir, 'partial-report.md');
  writeFileSync(report, 'old prose'); assert.equal(readPartialStatusAtCommon(f.common).report.state, 'stale');
  unlinkSync(report); assert.equal(readPartialStatusAtCommon(f.common).report.state, 'unavailable');
  symlinkSync(f.file, report); assert.equal(readPartialStatusAtCommon(f.common).report.state, 'unavailable');
  assert.deepEqual(readRefusalAtCommon(f.common), r);
}));
await test('native partial report: ordinary prose publication failure leaves pending machine status', () => fixture(f => {
  const r = f.publish(); mkdirSync(join(f.runDir, 'partial-report.md'));
  publishNativePartialStatus(r, f.rows);
  assert.equal(readPartialStatusAtCommon(f.common).report.state, 'pending');
  assert.equal(readPartialStatusAtCommon(f.common).status.counts.blocked, 1);
}));
await test('native partial report: completed, active, failed and queued inventory stay distinct', () => fixture(f => {
  const r = f.publish();
  const outputFile = join(f.runDir, '002.result.json'), protocolFile = join(f.runDir, '002-hunter.jsonl');
  writeFileSync(outputFile, '{}'); writeFileSync(protocolFile, events([{ type: 'turn.completed' }]));
  const leaves = [...f.rows, { id: '002-hunter', role: 'hunter', label: 'ordinary complete', state: 'completed', protocol: nativeArtifactReference(f.common, protocolFile), output: nativeArtifactReference(f.common, outputFile) },
    ...['active', 'failed', 'pending'].map((state, i) => ({ id: `00${i + 3}-hunter`, role: 'hunter', label: state, state, protocol: null, output: null }))];
  publishNativePartialStatus(r, leaves);
  const view = readPartialStatusAtCommon(f.common);
  assert.deepEqual(view.status.counts, { completed: 1, pending: 1, active: 1, failed: 1, blocked: 1 });
  assert.match(view.report.text, /active \(unknown terminal\)/);
}));
await test('native partial status: count, binding, artifact and schema corruption cannot become current', () => fixture(f => {
  const r = f.publish(); publishNativePartialStatus(r, f.rows);
  const original = readPartialStatusAtCommon(f.common).status;
  for (const mutate of [s => { s.extra = 1; }, s => { s.counts.blocked = 0; }, s => { s.refusalSha256 = 'f'.repeat(64); }, s => { s.run.head = 'b'.repeat(40); }, s => { s.leaves[0].protocol.path = 'outside.jsonl'; }, s => { s.report.path = 'outside.md'; }, s => { s.leaves.push(s.leaves[0]); }, s => { s.leaves[0].state = 'completed'; }]) {
    const bad = structuredClone(original); mutate(bad); writeStatus(f, bad);
    assert.throws(() => readPartialStatusAtCommon(f.common), invalid);
  }
}));
await test('native status: inert rendering rejects accessors and Proxies without invoking hooks', () => fixture(f => {
  const r = f.publish(); publishNativePartialStatus(r, f.rows);
  const s = readPartialStatusAtCommon(f.common).status; let hooks = 0;
  const getter = { ...s }; Object.defineProperty(getter, 'leaves', { enumerable: true, get() { hooks++; return []; } });
  const proxy = new Proxy(s, { ownKeys() { hooks++; return Reflect.ownKeys(s); } });
  for (const bad of [getter, proxy]) assert.throws(() => renderNativeHuntPartialStatus(bad), invalid);
  assert.equal(hooks, 0);
  const tooMany = Array.from({ length: 1001 }, () => null); assert.throws(() => assertNativeData(tooMany), invalid);
}));
await test('native adoption: static generic hashes and host identities are all required', () => fixture(f => {
  const args = f.adoption(), evidence = prepareRefusalAdoption(args);
  assert.equal(evidence.leaves.length, 1); assert.equal(evidence.leaves[0].state, 'blocked');
  assert.equal(evidence.candidate.target.head, f.intake.target.head);
  for (const key of Object.keys(args.expected)) assert.throws(() => prepareRefusalAdoption({ ...args, expected: { ...args.expected, [key]: '0'.repeat(64) } }), { code: 'REFUSAL_ADOPTION_INVALID' });
  assert.equal(readRefusalAtCommon(f.common), null);
}));
await test('native adoption: wrong root/head, successful result or non-refusal protocol reject without publication', () => fixture(f => {
  writeFileSync(f.resultFile, JSON.stringify({ ...f.result, head: 'b'.repeat(40) }));
  assert.throws(() => prepareRefusalAdoption(f.adoption()), { code: 'REFUSAL_ADOPTION_INVALID' });
  writeFileSync(f.resultFile, JSON.stringify({ ...f.result, status: 'done' }));
  assert.throws(() => prepareRefusalAdoption(f.adoption()), { code: 'REFUSAL_ADOPTION_INVALID' });
  writeFileSync(f.resultFile, JSON.stringify(f.result)); writeFileSync(f.file, events([{ type: 'turn.completed' }]));
  assert.throws(() => prepareRefusalAdoption(f.adoption()), { code: 'REFUSAL_ADOPTION_INVALID' });
  writeFileSync(f.file, events([{ type: 'error', message }]));
  writeFileSync(f.intakeFile, JSON.stringify({ ...f.intake, repo: f.common }));
  assert.throws(() => prepareRefusalAdoption(f.adoption()), { code: 'REFUSAL_ADOPTION_INVALID' });
  assert.equal(readRefusalAtCommon(f.common), null);
}));
await test('native adoption: forged, proxied and accessor owner inputs reject before any evidence access', () => {
  let hooks = 0;
  const options = { repo: '/nonexistent', lockToken: {}, intakeFile: '/nonexistent' };
  const proxy = new Proxy(options, { get() { hooks++; throw new Error('hook'); } });
  const getter = { get repo() { hooks++; return '/nonexistent'; } };
  for (const bad of [options, proxy, getter, { ...options, lockToken: new Proxy({}, {}) }]) assert.throws(() => adoptNativeHuntRefusal(bad), { code: 'INVALID_NATIVE_HUNT_OWNER' });
  assert.equal(hooks, 0);
});
await test('native refusal receipt: impossible canonical timestamp fails with the public corruption code', () => fixture(f => {
  const r = f.publish(); r.observedAt = '2026-99-01T00:00:00.000Z';
  writeFileSync(receiptFile(f), JSON.stringify(r)); assert.throws(() => readRefusalAtCommon(f.common), invalid);
}));
await test('native adoption: index-shaped findings without owning schema evidence are malformed results', () => fixture(f => {
  writeFileSync(f.resultFile, JSON.stringify({ ...f.result, findings: [{ finding_id: 'F1', verification_status: 'confirmed', fix_status: 'none' }] }));
  assert.throws(() => prepareRefusalAdoption(f.adoption()), { code: 'REFUSAL_ADOPTION_INVALID' });
  assert.equal(readRefusalAtCommon(f.common), null);
}));
await test('native partial status: capacity failure invalidates earlier prose instead of calling it current', () => fixture(f => {
  const r = f.publish(); publishNativePartialStatus(r, f.rows);
  assert.equal(readPartialStatusAtCommon(f.common).report.state, 'current');
  const rows = [...f.rows, ...Array.from({ length: 1000 }, (_, i) => ({ id: `${String(i + 2).padStart(3, '0')}-hunter`, role: 'hunter', label: 'pending', state: 'pending', protocol: null, output: null }))];
  assert.throws(() => publishNativePartialStatus(r, rows), invalid);
  assert.notEqual(readPartialStatusAtCommon(f.common).report.state, 'current');
}));
await test('native refusal schemas: hashes and Git identities must be strings without coercion', () => fixture(f => {
  const r = f.publish(), receipt = readFileSync(receiptFile(f));
  for (const mutate of [r => { r.protocol.sha256 = [r.protocol.sha256]; }, r => { r.target.head = [r.target.head]; }]) {
    const bad = structuredClone(r); mutate(bad); writeFileSync(receiptFile(f), JSON.stringify(bad));
    assert.throws(() => readRefusalAtCommon(f.common), invalid);
  }
  writeFileSync(receiptFile(f), receipt); publishNativePartialStatus(r, f.rows);
  const status = readPartialStatusAtCommon(f.common).status;
  for (const mutate of [s => { s.report.sha256 = [s.report.sha256]; }, s => { s.leaves[0].protocol.sha256 = [s.leaves[0].protocol.sha256]; }]) {
    const bad = structuredClone(status); mutate(bad); writeStatus(f, bad); assert.throws(() => readPartialStatusAtCommon(f.common), invalid);
  }
}));

await test('native refusal receipt: supported detached intake retains its exact target', () => fixture(f => {
  f.intake.target.kind = 'detached';
  const receipt = f.publish();
  assert.equal(receipt.target.kind, 'detached');
  assert.deepEqual(readRefusalAtCommon(f.common).target, f.intake.target);
}));
function failStatusRename(f, ordinal, action) {
  const original = fs.renameSync; let seen = 0;
  fs.renameSync = (from, to) => {
    if (to === statusFile(f) && ++seen === ordinal) throw Object.assign(new Error('ordinary fixture write failure'), { code: 'EIO' });
    return original(from, to);
  };
  syncBuiltinESMExports();
  try { return action(); }
  finally { fs.renameSync = original; syncBuiltinESMExports(); }
}
await test('native partial status: failed pending replacement cannot advertise older prose as current', () => fixture(f => {
  const r = f.publish(); publishNativePartialStatus(r, f.rows);
  const prior = readFileSync(statusFile(f));
  assert.throws(() => failStatusRename(f, 1, () => publishNativePartialStatus(r, f.rows)), { code: 'EIO' });
  assert.deepEqual(readFileSync(statusFile(f)), prior, 'the saved prior snapshot remains intact');
  assert.deepEqual(readPartialStatusAtCommon(f.common).report, { state: 'unavailable', text: null });
  assert.deepEqual(readRefusalAtCommon(f.common), r);
  publishNativePartialStatus(r, f.rows);
  assert.equal(readPartialStatusAtCommon(f.common).report.state, 'current');
}));
await test('native partial status: failed final descriptor returns the durable pending state', () => fixture(f => {
  const r = f.publish();
  const returned = failStatusRename(f, 2, () => publishNativePartialStatus(r, f.rows));
  assert.equal(returned.report.state, 'pending');
  assert.equal(readPartialStatusAtCommon(f.common).report.state, 'pending');
}));
await test('native partial status: retained owner lock withholds old current prose', () => fixture(f => {
  const r = f.publish(); publishNativePartialStatus(r, f.rows);
  mkdirSync(join(f.common, 'native-hunt.lock'));
  assert.deepEqual(readPartialStatusAtCommon(f.common).report, { state: 'unavailable', text: null });
  assert.deepEqual(readRefusalAtCommon(f.common), r);
}));

await test('native admission: corrupt optional status preserves the known typed refusal', () => fixture(f => {
  const r = f.publish(); writeFileSync(statusFile(f), '{}');
  assert.throws(() => readPartialStatusAtCommon(f.common), invalid, 'the public status reader still rejects corruption');
  const original = cp.spawnSync;
  cp.spawnSync = (bin, args) => {
    assert.equal(bin, 'git');
    assert.deepEqual(args, ['-C', f.root, '-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', 'rev-parse', '--path-format=absolute', '--git-common-dir']);
    return { status: 0, stdout: f.common + '\n' };
  };
  syncBuiltinESMExports();
  try {
    assert.throws(() => assertNativeHuntAdmission(f.root), error => {
      assert.equal(error.code, 'NATIVE_HUNT_REFUSED');
      assert.equal(error.outcome.kind, 'provider_refusal');
      assert.equal(error.outcome.retryable, false);
      assert.equal(error.outcome.statusFile, statusFile(f));
      assert.match(error.message, /Partial report: unavailable/);
      return true;
    });
  } finally { cp.spawnSync = original; syncBuiltinESMExports(); }
  assert.deepEqual(readRefusalAtCommon(f.common), r);
}));
