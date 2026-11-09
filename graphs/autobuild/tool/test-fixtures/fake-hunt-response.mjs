// Deterministic structured leaves for integration tests. The actual graph owns
// routing, validation, ledger construction and shared PR gate semantics.
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
const put = (file, content) => { mkdirSync(path.dirname(file), { recursive: true }); writeFileSync(file, content); };
const reproTest = `import { test } from 'node:test';
import assert from 'node:assert/strict';
import { feature } from '../src/feature.js';
test('nonnegative total', () => assert.equal(feature(), 0, 'BUGHUNT-F1 negative total'));
`;
const tokens = {
  logic: 'logic-q4m7', contract: 'contract-r8v2', concurrency: 'concurrency-t3x9',
  security: 'security-w6h1', errors: 'errors-b5n4', regression: 'regression-k2c8',
};
export function fakeHuntResponse(role, label, mode) {
  if (mode === 'malformed') return { invented: 'not the required schema' };
  if (role === 'impact-mapper') return {
    summary: 'The fixture adds feature()', changes: [], callers: [], contracts: [], tests: [], protections: [],
    lenses: Object.keys(tokens).map(lens => ({ lens, relevant: false, why: 'Use intake routing', focus: [] })),
  };
  if (role === 'hunter') {
    const lens = label.replace(/^hunt: /, '');
    return {
      lens_token: tokens[lens],
      coverage: [{ area: 'src/feature.js', status: mode === 'partial' ? 'not_covered' : 'clean', note: 'Scripted fixture coverage' }],
      findings: ['unresolved', 'repair', 'reject-fix'].includes(mode) && lens === 'logic' ? [{
        file_path: 'src/feature.js', line_range: [1, 1], bug_category: 'logic', severity: 'HIGH', confidence: 90,
        title: 'Negative result violates total contract', description: 'feature() returns a negative total.',
        failure_scenario: { trigger: 'Call feature()', path: 'src/feature.js:1', observable: 'Returns -1' },
        expected_behavior: 'A nonnegative result', actual_behavior: 'Returns -1',
        evidence: [{ file: 'src/feature.js', line: 1, quote: 'export function feature() { return -1; }' }],
      }] : [],
    };
  }
  if (role === 'skeptic') return {
    verdict: 'confirmed', refute_confidence: 0, reason: 'Direct return path', execution_path: 'feature() -> -1',
    introduced_by_change: 'yes', severity: 'HIGH', duplicate_of: '',
  };
  if (role === 'reproducer' && ['repair', 'reject-fix'].includes(mode)) {
    put('repro.json', JSON.stringify({ test_file: 'tests/bughunt-f1.test.mjs' }));
    put('files/tests/bughunt-f1.test.mjs', reproTest);
    return { written: true, test_file: 'tests/bughunt-f1.test.mjs', how_it_fails: 'BUGHUNT-F1 expected 0, got -1', reason: '' };
  }
  if (role === 'repairer') {
    put('src/feature.js', 'export function feature() { return 0; }\n');
    return { root_cause: 'negative constant', why_it_exists: 'regressed return value', files_changed: ['src/feature.js'], interfaces_changed: false, summary: 'Return the correct total' };
  }
  if (role === 'fix-verifier') {
    put('adversarial.json', JSON.stringify({ test_files: ['tests/bughunt-f1-adversarial.test.mjs'] }));
    put('files/tests/bughunt-f1-adversarial.test.mjs', reproTest.replace('nonnegative total', 'independent repeat-call check'));
    return { verdict: mode === 'reject-fix' ? 'reject' : 'accept', root_cause_addressed: true, callers_preserved: true, unrelated_changes: [], problems: mode === 'reject-fix' ? ['Fixture independent reviewer rejects repair'] : [], adversarial_tests: ['tests/bughunt-f1-adversarial.test.mjs'], remaining_risks: [] };
  }
  if (role === 'reproducer') return { written: false, test_file: '', how_it_fails: '', reason: 'Reproduction intentionally unavailable in this fixture' };
  throw new Error(`Unexpected test leaf ${role}: ${label}`);
}
