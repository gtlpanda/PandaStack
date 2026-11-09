import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { runNativeHunt, runNativeProcess, nativeLeafArgs, schemaProblems } from '../skills/bughunt/native-runner.mjs';
import { prepareHunt } from '../skills/bughunt/land.mjs';
import { reviewStatus } from '../skills/bughunt/review-status.mjs';
import { DEFAULTS, codexModel } from '../../autobuild/tool/lib/config.mjs';
const tokens = { logic: 'logic-q4m7', contract: 'contract-r8v2', concurrency: 'concurrency-t3x9', security: 'security-w6h1', errors: 'errors-b5n4', regression: 'regression-k2c8' };
function repoFixture() {
  const repo = mkdtempSync(join(tmpdir(), 'native-hunt-test-'));
  const git = (...argv) => { const r = spawnSync('git', ['-C', repo, '-c', 'core.hooksPath=/dev/null', ...argv], { encoding: 'utf8' }); assert.equal(r.status, 0, r.stderr); return r.stdout.trim(); };
  git('init', '-q', '-b', 'main'); git('config', 'user.name', 'Test'); git('config', 'user.email', 'test@localhost');
  writeFileSync(join(repo, 'index.mjs'), 'export const add = (a, b) => a + b;\n'); git('add', '.'); git('commit', '-qm', 'base');
  git('switch', '-qc', 'feature/test'); writeFileSync(join(repo, 'index.mjs'), 'export const add = (a, b) => Number(a) + Number(b);\n'); git('add', '.'); git('commit', '-qm', 'feature');
  const prep = prepareHunt({ repo, target: 'feature/test', base: 'main', stamp: 'test' }); assert.ok(prep.stateDir, JSON.stringify(prep));
  const config = { ...structuredClone(DEFAULTS), root: repo, codexBin: 'scripted-codex', backend: 'codex', model: codexModel(DEFAULTS.model), subagentModel: codexModel(DEFAULTS.subagentModel), probeModel: codexModel(DEFAULTS.probeModel) };
  return { repo, prep, config, git, close: () => rmSync(repo, { recursive: true, force: true }) };
}
const sample = schema => schema.type === 'object' ? Object.fromEntries(Object.entries(schema.properties).map(([k, s]) => [k, sample(s)])) : schema.type === 'array' ? [] : schema.enum ? schema.enum[0] : schema.type === 'string' ? '' : schema.type === 'boolean' ? false : 0;
function leaves(mode, calls) {
  return async (bin, argv, opts) => {
    if (bin !== 'scripted-codex') return runNativeProcess(bin, argv, opts);
    calls.push({ argv, cwd: opts.cwd, role: opts.env.PANDASTACK_HUNT_ROLE, prompt: opts.input });
    writeFileSync(opts.logFile + '.stderr', '');
    if (mode === 'usage') { writeFileSync(opts.logFile, JSON.stringify({ type: 'turn.failed', error: { message: 'usage limit reached' } }) + '\n'); return 1; }
    writeFileSync(opts.logFile, JSON.stringify({ type: 'turn.completed', usage: {} }) + '\n');
    const output = argv[argv.indexOf('--output-last-message') + 1];
    if (mode === 'missing') return 0;
    const schema = JSON.parse(readFileSync(argv[argv.indexOf('--output-schema') + 1], 'utf8'));
    let result = sample(schema);
    if (opts.env.PANDASTACK_HUNT_ROLE === 'hunter') {
      const lens = opts.input.match(/Your lens: (\w+)/)[1];
      result = { lens_token: tokens[lens], coverage: [{ area: 'add', status: 'clean', note: 'scripted inspection' }], findings: [] };
    }
    if (mode === 'invalid') result = {};
    writeFileSync(output, JSON.stringify(result));
    return 0;
  };
}
async function runCase(f, mode, calls = [], stopped = () => false) {
  return runNativeHunt({ repo: f.repo, tree: join(f.prep.stateDir, 'tree'), stateDir: f.prep.stateDir, config: f.config, mode: 'discover', stopped, processRunner: leaves(mode, calls) });
}

test('same graph saves a real ledger that the unchanged PR gate accepts', async () => {
  const f = repoFixture();
  try {
    const calls = []; const r = await runCase(f, 'clean', calls);
    assert.equal(r.code, 0); assert.equal(r.ledger.status, 'done');
    const gate = reviewStatus(f.repo, 'HEAD', { base: 'main' });
    assert.equal(gate.hunted, true); assert.equal(gate.disposition, 'pass');
    assert.ok(calls.some(c => c.role === 'impact-mapper')); assert.ok(calls.filter(c => c.role === 'hunter').length >= 2);
    for (const c of calls) { assert.equal(c.argv[c.argv.indexOf('--sandbox') + 1], 'read-only'); assert.equal(c.argv[c.argv.indexOf('--model') + 1], 'gpt-6.1-sol'); }
    assert.equal(f.git('status', '--porcelain'), '');
  } finally { f.close(); }
});
for (const mode of ['missing', 'invalid', 'usage']) test(`${mode} leaf output cannot authorize a PR`, async () => {
  const f = repoFixture();
  try { const r = await runCase(f, mode); assert.notEqual(r.code, 0); assert.equal(r.ledger.status, 'escalate'); assert.equal(reviewStatus(f.repo, 'HEAD', { base: 'main' }).hunted, false); }
  finally { f.close(); }
});
test('pre-stopped run invokes no model and cannot finish review', async () => {
  const f = repoFixture();
  try { const calls = []; const r = await runCase(f, 'clean', calls, () => true); assert.equal(r.code, 130); assert.equal(calls.length, 0); assert.equal(reviewStatus(f.repo, 'HEAD', { base: 'main' }).hunted, false); }
  finally { f.close(); }
});
test('schema validator rejects malformed nested output rather than accepting model prose', () => {
  const schema = { type: 'object', properties: { values: { type: 'array', items: { type: 'integer', minimum: 0 } } }, required: ['values'], additionalProperties: false };
  assert.deepEqual(schemaProblems({ values: [0, 1] }, schema), []);
  for (const value of [null, {}, { values: ['1'] }, { values: [-1] }, { values: [], extra: true }]) assert.ok(schemaProblems(value, schema).length);
});
test('writing leaves get workspace-write and correct model, never full access', () => {
  const config = { model: 'gpt-6-astra', subagentModel: 'gpt-6.1-sol', probeModel: 'gpt-6-luna', codex: { reasoningEffort: 'medium' } };
  const args = nativeLeafArgs(config, { agentType: 'repairer', model: 'sonnet', effort: 'high' }, { schema: '/tmp/s', output: '/tmp/o' });
  assert.equal(args[args.indexOf('--sandbox') + 1], 'workspace-write'); assert.ok(!args.includes('--dangerously-bypass-approvals-and-sandbox'));
  const referee = nativeLeafArgs(config, { agentType: 'advisor', model: 'fable', effort: 'high' }, { schema: '/tmp/s', output: '/tmp/o' });
  assert.equal(referee[referee.indexOf('--model') + 1], 'gpt-6-astra');
});

for (const stop of [false, true]) test(`process ${stop ? 'stop' : 'timeout'} terminates a live leaf`, async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'native-hunt-process-'));
  try {
    const start = Date.now();
    const code = await runNativeProcess(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { cwd, env: process.env, logFile: join(cwd, 'leaf.log'), timeoutMs: 200, stopped: () => stop && Date.now() - start > 100 });
    assert.equal(code, stop ? 130 : 124);
    assert.ok(Date.now() - start < 3000);
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});

test('ledger remains incomplete during host recheck and when report write fails', async () => {
  const f = repoFixture();
  try {
    mkdirSync(join(f.prep.stateDir, 'report.md'));
    let observed = false;
    const base = leaves('clean', []);
    const runner = async (bin, argv, opts) => {
      if (argv.includes('recheck')) { observed = true; assert.equal(reviewStatus(f.repo, 'HEAD', { base: 'main' }).hunted, false); }
      return base(bin, argv, opts);
    };
    const r = await runNativeHunt({ repo: f.repo, tree: join(f.prep.stateDir, 'tree'), stateDir: f.prep.stateDir, config: f.config, mode: 'discover', processRunner: runner });
    assert.equal(observed, true); assert.equal(r.code, 12); assert.equal(r.ledger.status, 'escalate');
    assert.equal(reviewStatus(f.repo, 'HEAD', { base: 'main' }).hunted, false);
  } finally { f.close(); }
});
test('an owned state lock refuses concurrent execution without touching the ledger', async () => {
  const f = repoFixture();
  try {
    mkdirSync(join(f.prep.stateDir, 'native.lock'));
    const calls = []; const r = await runCase(f, 'clean', calls);
    assert.equal(r.code, 12); assert.equal(r.ledger, null); assert.equal(calls.length, 0);
  } finally { f.close(); }
});
