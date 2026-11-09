// Register the node:test suite in the repository's awaited workflow harness.
import { test, REPO } from '../../../scripts/workflow-harness.mjs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import assert from 'node:assert/strict';
await test('native Codex hunt runner integration suite', () => {
  const result = spawnSync(process.execPath, ['--test', join(REPO, 'graphs/hunt/test-native/native-runner.test.mjs')], { encoding: 'utf8', timeout: 120000 });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
});
