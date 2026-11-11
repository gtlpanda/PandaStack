import assert from 'node:assert/strict';
import { test } from '../../../scripts/workflow-harness.mjs';

const current = Object.freeze([
  Object.freeze({ id: 'A', passes: true }),
  Object.freeze({ id: 'B', passes: true }),
  Object.freeze({ id: 'C', passes: false }),
]);
async function count(features, history) {
  const { countUnreviewed } = await import('../tool/lib/review-baseline.mjs');
  return countUnreviewed(features, history);
}
const snapshot = features => JSON.stringify({ features });

await test('review baseline: unavailable or invalid JSON leaves all passing work outstanding', async () => {
  for (const history of [undefined, null, '', '{']) assert.equal(await count(current, history), 2);
});

await test('review baseline: wrong document or features types grant no review credit', async () => {
  for (const doc of [null, false, 0, 'text', [], {}, { features: null }, { features: {} }, { features: 'rows' }]) {
    assert.equal(await count(current, JSON.stringify(doc)), 2);
  }
});

await test('review baseline: any invalid row invalidates all historical credit in either order', async () => {
  const valid = { id: 'A', passes: true };
  for (const row of [null, [], false, 0, 'A', {}, { id: '', passes: false }, { id: 1, passes: true }, { id: 'B' }]) {
    for (const rows of [[valid, row], [row, valid]]) assert.equal(await count(current, snapshot(rows)), 2);
  }
});

await test('review baseline: passes must be a historical boolean, even on removed rows', async () => {
  for (const passes of [null, 0, 1, '', 'false', [], {}]) {
    assert.equal(await count(current, snapshot([{ id: 'A', passes: true }, { id: 'OLD', passes }])), 2);
  }
});

await test('review baseline: duplicate historical IDs invalidate true and false rows alike', async () => {
  for (const passes of [true, false]) {
    assert.equal(await count(current, snapshot([{ id: 'A', passes: true }, { id: 'A', passes }])), 2);
    assert.equal(await count(current, snapshot([{ id: 'A', passes: true }, { id: 'OLD', passes: false }, { id: 'OLD', passes }])), 2);
  }
});

await test('review baseline: valid history credits only matching passing IDs', async () => {
  assert.equal(await count(current, snapshot([{ id: 'A', passes: true, legacy: { anything: null } }, { id: 'B', passes: false }, { id: 'OLD', passes: true }])), 1);
  assert.equal(await count(current, snapshot(current)), 0);
  assert.equal(await count(current, snapshot([])), 2);
});

await test('review baseline: IDs remain exact strings without case or whitespace normalization', async () => {
  assert.equal(await count(current, snapshot([{ id: 'a', passes: true }, { id: ' A', passes: true }])), 2);
  assert.equal(await count([{ id: ' ', passes: true }], snapshot([{ id: ' ', passes: true }])), 0);
  assert.equal(await count([{ id: '__proto__', passes: true }], snapshot([{ id: '__proto__', passes: true }])), 0);
});

await test('review baseline: current truthy passing semantics and row counts are preserved', async () => {
  const rows = [{ id: 'A', passes: 'yes' }, { id: 'A', passes: 1 }, { id: 'B', passes: [] }, { id: 'C', passes: 0 }, { id: 'D', passes: null }];
  assert.equal(await count(rows, null), 3);
  assert.equal(await count(rows, snapshot([{ id: 'A', passes: true }])), 1);
  assert.equal(await count(rows, snapshot([{ id: 'A', passes: false }])), 3);
});

await test('review baseline: no current passing work needs no review even without history', async () => {
  for (const history of [null, '{', snapshot([{ id: 'OLD', passes: true }])]) {
    assert.equal(await count([], history), 0);
    assert.equal(await count([{ id: 'A', passes: false }], history), 0);
  }
});

await test('review baseline: malformed current rows are not silently repaired', async () => {
  for (const history of [null, snapshot([])]) {
    await assert.rejects(count([null], history), TypeError);
  }
});
