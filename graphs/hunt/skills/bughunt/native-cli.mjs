#!/usr/bin/env node
// Standalone Codex entrypoint for the shared hunt graph. No Claude installation,
// branch switch, PR write or automatic landing is needed for discover mode.
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, realpathSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runNativeHunt } from './native-runner.mjs';
import { prepareHunt } from './land.mjs';
import { DEFAULTS, loadConfig, codexModel } from '../../../autobuild/tool/lib/config.mjs';
import { defaultBase } from '../../../build/skills/build-app/driver/finish.mjs';
import { disposition } from '../../../../core/skills/findings/findings.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
export async function main(argv) {
  const opts = {};
  for (let i = 0; i < argv.length; i += 2) {
    if (!['--repo', '--base', '--backend', '--mode', '--codex-bin'].includes(argv[i]) || !argv[i + 1] || argv[i + 1].startsWith('--')) throw new Error('usage: native-cli.mjs --repo <repo> [--base <ref>] [--backend codex] [--mode discover|propose|fix] [--codex-bin <path>]');
    opts[argv[i].slice(2)] = argv[i + 1];
  }
  if (opts.backend && opts.backend !== 'codex') throw new Error('Native CLI currently accepts --backend codex; Claude uses the same graph through Workflow');
  const repo = realpathSync(opts.repo || process.cwd());
  const common = spawnSync('git', ['-C', repo, '-c', 'core.hooksPath=/dev/null', 'rev-parse', '--path-format=absolute', '--git-common-dir'], { encoding: 'utf8' });
  if (common.status !== 0) throw new Error('Cannot locate repository git directory');
  const lock = join(common.stdout.trim(), 'native-hunt-cli.lock');
  try { mkdirSync(lock); } catch (e) { if (e.code === 'EEXIST') throw new Error('Another native hunt owns this repository, or left an interrupted lock; inspect native-hunt-cli.lock'); throw e; }
  try {
  writeFileSync(join(lock, 'owner.json'), JSON.stringify({ pid: process.pid, at: new Date().toISOString() }));
  const mode = opts.mode || 'discover';
  if (!['discover', 'propose', 'fix'].includes(mode)) throw new Error('mode must be discover, propose or fix');
  const config = existsSync(join(repo, 'autobuild.json'))
    ? loadConfig(repo, process.env, { backend: 'codex' })
    : { ...structuredClone(DEFAULTS), root: repo, backend: 'codex', codexBin: process.env.AUTOBUILD_CODEX_BIN || DEFAULTS.codexBin,
      model: codexModel(DEFAULTS.model), subagentModel: codexModel(DEFAULTS.subagentModel), probeModel: codexModel(DEFAULTS.probeModel) };
  if (opts['codex-bin']) config.codexBin = opts['codex-bin'];
  const base = opts.base || config.bughuntBase || defaultBase(repo);
  let stateDir, fixBranch;
  if (mode === 'discover') {
    const p = spawnSync(process.execPath, [join(HERE, 'intake.mjs'), repo, '--base', base], { encoding: 'utf8', timeout: 120_000, maxBuffer: 8 * 1024 * 1024 });
    if (p.status !== 0 || !/^INTAKE: OK/m.test(p.stdout || '')) throw new Error(`intake failed: ${p.stdout || p.stderr || p.error?.message}`);
    stateDir = dirname(p.stdout.split('\n')[0].trim());
    for (const line of p.stdout.split('\n').filter(line => line.startsWith('note:'))) console.log(line);
  } else {
    const target = spawnSync('git', ['-C', repo, 'rev-parse', '--abbrev-ref', 'HEAD'], { encoding: 'utf8' });
    if (target.status !== 0 || target.stdout.trim() === 'HEAD') throw new Error('Repair modes require a branch');
    const prep = prepareHunt({ repo, target: target.stdout.trim(), base, stamp: new Date().toISOString().replace(/[^0-9TZ]/g, ''), log: console.log });
    if (prep.error || prep.skip) throw new Error(`hunt preparation: ${prep.error || prep.skip}`);
    stateDir = prep.stateDir;
    fixBranch = prep.branch;
  }
  const intake = JSON.parse(readFileSync(join(stateDir, 'intake.json'), 'utf8'));
  console.log(`Native hunt: ${mode}; lenses=${intake.lenses.routed.join(',')}; state=${stateDir}`);
  console.log('Reproduction and repair checks execute the reviewed code in isolated exports through evidence.mjs. No push or landing.');
  let stopping = false;
  const stop = () => { stopping = true; };
  process.on('SIGINT', stop); process.on('SIGTERM', stop);
  try {
    const result = await runNativeHunt({ repo, tree: join(stateDir, 'tree'), stateDir, mode, fixBranch, config, log: console.log, stopped: () => stopping });
    if (result.ledger) console.log(`HUNT: ${result.ledger.status === 'done' && result.code === 0 ? disposition(result.ledger).disposition : 'incomplete'}; ledger=${join(stateDir, 'ledger.json')}`);
    return result.code || (disposition(result.ledger).disposition === 'pass' ? 0 : 12);
  } finally { process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop); }
  } finally { rmSync(lock, { recursive: true }); }
}
if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  main(process.argv.slice(2)).then(code => { process.exitCode = code; }).catch(error => { console.error(error.message); process.exitCode = 12; });
}
