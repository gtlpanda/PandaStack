import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { openSync, closeSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT, temp, cleanup } from './support.mjs';

// The phase-1 build-app driver tests drive the Claude path with a fake claude binary. The driver now
// picks its provider from the launching host (PANDASTACK_PROVIDER or a `codex` ancestor), so those tests
// must pin the provider themselves. Run them as a Codex-launched host would and require them to pass.
const cases = [
  ['p1-13.test.mjs', 'actual build-app fake CLI preserves preflight behavior: clean-internal'],
];

function runNested(args, env, log, ms) {
  return new Promise(resolve => {
    const fd = openSync(log, 'w');
    // Own process group, output to a file: a stuck grandchild can neither outlive the test nor hold a pipe.
    const child = spawn(process.execPath, args, { stdio: ['ignore', fd, fd], env, detached: true });
    closeSync(fd);
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; try { process.kill(-child.pid, 'SIGKILL') } catch { /* already gone */ } }, ms);
    child.on('error', error => { clearTimeout(timer); resolve({ status: null, error, timedOut }) });
    child.on('close', status => { clearTimeout(timer); try { process.kill(-child.pid, 'SIGKILL') } catch { /* nothing left */ } resolve({ status, timedOut }) });
  });
}

for (const [file, name] of cases) {
  test(`${file} build-app driver test passes when launched from Codex`, async () => {
    // HARNESS_BUILD_CODEX_BIN points nowhere so a driver that wrongly takes the Codex branch fails fast and never runs a real codex.
    const env = { ...process.env, PANDASTACK_PROVIDER: 'codex', HARNESS_BUILD_CODEX_BIN: '/nonexistent/codex', AUTOBUILD_CODEX_BIN: '/nonexistent/codex' };
    delete env.NODE_TEST_CONTEXT;
    const dir = temp();
    try {
      const log = join(dir, 'out.log');
      const pattern = `^${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`;
      const out = await runNested(['--test', `--test-name-pattern=${pattern}`, join(ROOT, 'acceptance/phase1', file)], env, log, 40000);
      const tail = readFileSync(log, 'utf8').slice(-1200);
      assert.equal(out.status, 0, `${file} depends on the host app and fails when launched from Codex (PANDASTACK_PROVIDER=codex; status ${out.status}, timedOut ${out.timedOut})\n${tail}`);
    } finally { cleanup(dir); }
  });
}
