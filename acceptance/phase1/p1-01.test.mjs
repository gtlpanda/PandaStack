import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mod, baseRun, event } from './support.mjs';

test('valid records and events are versioned and do not mutate input', async () => {
  const { createRun, validateRun, validateEvent } = await mod('records');
  const input = baseRun(); delete input.schemaVersion; delete input.parentRunId;
  const before = structuredClone(input); const result = createRun(input);
  assert.equal(result.schemaVersion, 1); assert.equal(result.parentRunId, null);
  assert.deepEqual(validateRun(result), []); assert.deepEqual(validateEvent(event()), []);
  assert.deepEqual(input, before);
});
test('settings snapshot excludes raw env, prompt and unknown fields', async () => {
  const { sanitizeSettings, createRun } = await mod('records');
  const input = { model: 'opus', effort: 'high', maxConcurrentSubagents: 3, sources: { model: 'central', token: 'env' }, env: { PRIVATE_VALUE: 'SENSITIVE_SENTINEL' }, prompt: 'SENSITIVE_SENTINEL', authorization: 'SENSITIVE_SENTINEL' };
  assert.deepEqual(sanitizeSettings(input), { model: 'opus', effort: 'high', maxConcurrentSubagents: 3, sources: { model: 'central' } });
  assert.ok(!JSON.stringify(createRun(baseRun({ settings: input }))).includes('SENSITIVE_SENTINEL'));
});
test('malformed and traversal-shaped records are rejected without validator crashes', async () => {
  const { createRun, validateRun } = await mod('records');
  for (const x of [null, [], 7, 'run']) assert.ok(validateRun(x).length);
  for (const patch of [{ id: '../escape' }, { id: 'a/b' }, { id: '' }, { id: 'x'.repeat(81) }, { repo: 'relative' }, { runnerRoot: 'relative' }, { revision: 'not-a-sha' }, { parentRunId: 'run-1' }, { backend: 'other' }, { workflow: 'other' }, { startedAt: 'not-a-date' }, { startedAt: '2026-11-09T12:00:00' }, { schemaVersion: 99 }, { extra: 'SENSITIVE_SENTINEL' }]) {
    assert.ok(validateRun(baseRun(patch)).length, JSON.stringify(patch));
    assert.throws(() => createRun(baseRun(patch)), e => e.code === 'INVALID_RECORD');
  }
  for (const n of [0, -1, 1.5, '8', NaN]) assert.ok(validateRun(baseRun({ settings: { maxConcurrentSubagents: n } })).length);
});
test('event status and exit code must agree; extra payload never persists', async () => {
  const { validateEvent } = await mod('records');
  for (const x of [null, [], event({ runId: '../escape' }), event({ type: 'finished', exitCode: 2 }), event({ type: 'failed', exitCode: 0 }), event({ exitCode: 0 }), event({ output: 'SENSITIVE_SENTINEL' })]) assert.ok(validateEvent(x).length);
  for (const x of [event({ type: 'finished', exitCode: 0 }), event({ type: 'failed', exitCode: 127 }), event({ type: 'cancelled', exitCode: 130 })]) assert.deepEqual(validateEvent(x), []);
});
