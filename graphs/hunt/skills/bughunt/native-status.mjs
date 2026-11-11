// Host-owned refusal evidence and provisional presentation. No scheduler or release API.
import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { types } from 'node:util';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { constants, openSync, closeSync, readSync, fstatSync, lstatSync, realpathSync,
  writeFileSync, renameSync, linkSync, unlinkSync, chmodSync } from 'node:fs';
import { LENSES, MOVES, emptyLedger, ledgerProblems } from '../../../../core/skills/findings/findings.mjs';
import { readCodexResult } from '../../../autobuild/tool/lib/codex.mjs';

const RECEIPT = 'native-hunt-refusal.json';
const RECEIPT_LIMIT = 65536, STATUS_LIMIT = 1048576;
const ROLES = ['impact-mapper', 'hunter', 'skeptic', 'advisor', 'reproducer', 'repairer', 'fix-verifier'];
const STATES = ['completed', 'pending', 'active', 'failed', 'blocked'];
const HASH = /^[a-f0-9]{64}$/;
const OID = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const hash = v => typeof v === 'string' && HASH.test(v);
const oid = v => typeof v === 'string' && OID.test(v);
const COMPONENT = /^[a-zA-Z0-9_-][a-zA-Z0-9_.-]*$/;
export const refusalMessage = 'Provider declined this work; automatic retry is blocked.';
const invalid = () => Object.assign(new Error('Native refusal state is invalid; retained work requires inspection.'), { code: 'REFUSAL_STATE_INVALID' });
function requireValue(ok) { if (!ok) throw invalid(); }
const string = (v, max = 4096) => typeof v === 'string' && v.length > 0 && Buffer.byteLength(v) <= max && !/[\x00-\x1f\x7f]/.test(v);
const integer = v => Number.isSafeInteger(v) && v >= 0;
export const nativeArtifactHash = bytes => createHash('sha256').update(bytes).digest('hex');

// Reject hooks before inspecting values; pure rendering also accepts only inert JSON.
export function assertNativeData(value) {
  let nodes = 0;
  const seen = new Set();
  function walk(v, depth) {
    requireValue(++nodes <= 50000 && depth <= 30);
    if (v === null || typeof v === 'boolean') return;
    if (typeof v === 'string') { requireValue(Buffer.byteLength(v) <= STATUS_LIMIT); return; }
    if (typeof v === 'number') { requireValue(Number.isSafeInteger(v)); return; }
    requireValue(typeof v === 'object' && !types.isProxy(v) && !seen.has(v));
    const array = Array.isArray(v);
    requireValue(Object.getPrototypeOf(v) === (array ? Array.prototype : Object.prototype));
    seen.add(v);
    const descriptors = Object.getOwnPropertyDescriptors(v);
    requireValue(Reflect.ownKeys(descriptors).every(k => typeof k === 'string'));
    if (array) requireValue(v.length <= 1000 && Object.keys(v).length === v.length);
    for (const [key, d] of Object.entries(descriptors)) {
      if (array && key === 'length') continue;
      requireValue('value' in d && d.enumerable && (!array || /^(0|[1-9][0-9]*)$/.test(key)));
      walk(d.value, depth + 1);
    }
    seen.delete(v);
  }
  walk(value, 0);
}
function exact(v, keys) {
  requireValue(v !== null && typeof v === 'object' && !Array.isArray(v));
  requireValue(Object.keys(v).sort().join('\0') === [...keys].sort().join('\0'));
}
function relativePath(v) {
  requireValue(string(v) && !isAbsolute(v) && v.split('/').every(c => string(c, 256) && COMPONENT.test(c) && c !== '.' && c !== '..'));
  return v;
}
export function nativeCommonDirectory(repo) {
  const result = spawnSync('git', ['-C', repo, '-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false',
    'rev-parse', '--path-format=absolute', '--git-common-dir'], { encoding: 'utf8', timeout: 15000 });
  if (result.error || result.status !== 0) throw invalid();
  return realpathSync(result.stdout.trim());
}
// Static component checks; this is not hostile same-user race containment.
export function nativeArtifactPath(common, path) {
  relativePath(path);
  let current = common;
  const parts = path.split('/');
  for (let i = 0; i < parts.length; i++) {
    current = join(current, parts[i]);
    let st;
    try { st = lstatSync(current); } catch (e) { if (e.code === 'ENOENT') continue; throw invalid(); }
    requireValue(!st.isSymbolicLink() && (i === parts.length - 1 || st.isDirectory()));
  }
  return current;
}
export function nativeRelativePath(common, file) {
  requireValue(isAbsolute(file) && resolve(file) === file);
  const path = relative(common, file);
  requireValue(nativeArtifactPath(common, path) === file);
  return path;
}
export function readNativeArtifact(common, path, limit, { absent = false } = {}) {
  const file = nativeArtifactPath(common, path);
  let fd;
  try {
    fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const st = fstatSync(fd);
    requireValue(st.isFile() && integer(st.size) && st.size <= limit);
    const bytes = Buffer.alloc(st.size + 1);
    let used = 0, n;
    while (used < bytes.length && (n = readSync(fd, bytes, used, bytes.length - used, null))) used += n;
    requireValue(used === st.size);
    return bytes.subarray(0, used);
  } catch (e) { if (absent && e.code === 'ENOENT') return null; throw invalid(); }
  finally { if (fd !== undefined) closeSync(fd); }
}
export function nativeArtifactReference(common, file) {
  const path = nativeRelativePath(common, file);
  let fd;
  try {
    fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const st = fstatSync(fd);
    requireValue(st.isFile() && integer(st.size));
    const hash = createHash('sha256'), block = Buffer.alloc(65536);
    let bytes = 0, n;
    while ((n = readSync(fd, block, 0, block.length, null))) { bytes += n; hash.update(block.subarray(0, n)); }
    requireValue(bytes === st.size && integer(bytes));
    return { path, sha256: hash.digest('hex'), bytes };
  } finally { if (fd !== undefined) closeSync(fd); }
}
function parse(bytes) { try { const v = JSON.parse(bytes.toString('utf8')); assertNativeData(v); return v; } catch { throw invalid(); } }
function ref(v) { exact(v, ['path', 'sha256', 'bytes']); relativePath(v.path); requireValue(hash(v.sha256) && integer(v.bytes)); }
function leafIdentity(v, runner = false) {
  requireValue(string(v.id, 256) && string(v.label, 256) && [...ROLES, ...(runner ? ['runner'] : [])].includes(v.role));
  requireValue(new RegExp(`^[0-9]{3,}-${v.role === 'runner' ? 'evidence' : v.role}$`).test(v.id));
}
function runDirectory(v) {
  relativePath(v);
  const parts = v.split('/');
  requireValue(parts.length === 4 && parts[0] === 'bughunt' && parts[2] === 'native');
}
function validateRefusal(r, common) {
  assertNativeData(r);
  exact(r, ['version', 'kind', 'retryable', 'repository', 'run', 'target', 'leaf', 'protocol', 'observedAt', 'statusPath']);
  requireValue(r.version === 1 && r.kind === 'provider_refusal' && r.retryable === false && r.repository === common && string(common) && isAbsolute(common));
  exact(r.run, ['id', 'directory']); runDirectory(r.run.directory);
  requireValue(r.run.id === basename(r.run.directory) && r.statusPath === `${r.run.directory}/status.json`);
  exact(r.target, ['kind', 'label', 'base', 'head']);
  requireValue(['branch', 'pr', 'range', 'detached'].includes(r.target.kind) && string(r.target.label) && string(r.target.base) && oid(r.target.head));
  exact(r.leaf, ['id', 'role', 'label']); leafIdentity(r.leaf);
  exact(r.protocol, ['path', 'sha256', 'bytes', 'event', 'line']);
  ref({ path: r.protocol.path, sha256: r.protocol.sha256, bytes: r.protocol.bytes });
  requireValue(r.protocol.path === `${r.run.directory}/${r.leaf.id}.jsonl` && ['error', 'turn.failed'].includes(r.protocol.event) && integer(r.protocol.line) && r.protocol.line > 0);
  requireValue(typeof r.observedAt === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(r.observedAt) && Number.isFinite(Date.parse(r.observedAt)) && new Date(r.observedAt).toISOString() === r.observedAt);
  requireValue(Buffer.byteLength(JSON.stringify(r)) <= RECEIPT_LIMIT);
  return r;
}
function receiptBytes(common) { return readNativeArtifact(common, RECEIPT, RECEIPT_LIMIT, { absent: true }); }
export function readRefusalAtCommon(common) {
  const bytes = receiptBytes(common);
  return bytes === null ? null : validateRefusal(parse(bytes), common);
}
export function readNativeHuntRefusal(repo) { return readRefusalAtCommon(nativeCommonDirectory(repo)); }
export function nativeRefusalOutcome(r) {
  return { kind: 'provider_refusal', retryable: false, refusalFile: join(r.repository, RECEIPT),
    statusFile: join(r.repository, r.statusPath), reportFile: join(r.repository, r.run.directory, 'partial-report.md') };
}
export function assertNativeHuntAdmission(repo) {
  const r = readNativeHuntRefusal(repo);
  if (r) {
    const outcome = nativeRefusalOutcome(r);
    let reportState = 'unavailable';
    try { reportState = readPartialStatusAtCommon(r.repository).report.state; }
    catch { /* Optional presentation corruption never replaces the known refusal. */ }
    throw Object.assign(new Error(`${refusalMessage} Nonretryable; status=${outcome.statusFile}; report=${outcome.reportFile}. Partial report: ${reportState}; inspect saved status. A separately reviewed future resolution is required.`),
      { code: 'NATIVE_HUNT_REFUSED', outcome });
  }
}
function atomicWrite(common, path, bytes, exclusive = false) {
  const file = nativeArtifactPath(common, path);
  const temp = join(dirname(file), `.native-status-${randomUUID()}.tmp`);
  let created = false;
  try {
    writeFileSync(temp, bytes, { flag: 'wx', mode: 0o600 }); created = true;
    chmodSync(temp, 0o600);
    if (exclusive) linkSync(temp, file); else renameSync(temp, file);
  } finally { if (created) { try { unlinkSync(temp); } catch (e) { if (e.code !== 'ENOENT') throw e; } } }
}
export function publishNativeRefusal({ common, intake, runDir, leaf, protocol }) {
  const directory = nativeRelativePath(common, runDir);
  const r = { version: 1, kind: 'provider_refusal', retryable: false, repository: common,
    run: { id: basename(runDir), directory },
    target: { kind: intake.target.kind, label: intake.target.label, base: intake.target.base, head: intake.target.head },
    leaf, protocol, observedAt: new Date().toISOString(), statusPath: `${directory}/status.json` };
  validateRefusal(r, common);
  const prior = readRefusalAtCommon(common);
  if (prior) return prior;
  try { atomicWrite(common, RECEIPT, JSON.stringify(r) + '\n', true); }
  catch (e) { if (e.code !== 'EEXIST') throw e; return readRefusalAtCommon(common); }
  return r;
}
function canonical(v) {
  if (Array.isArray(v)) return v.map(canonical);
  if (v && typeof v === 'object') return Object.fromEntries(Object.keys(v).sort().map(k => [k, canonical(v[k])]));
  return v;
}
function semanticHash(status) { const { report, ...semantic } = status; return nativeArtifactHash(JSON.stringify(canonical(semantic))); }
export function nativeLeafCounts(leaves) {
  const counts = Object.fromEntries(STATES.map(s => [s, 0]));
  for (const row of leaves) { requireValue(STATES.includes(row.state)); counts[row.state]++; }
  return counts;
}
export function assertNativeInventoryCapacity(leaves, directory) {
  assertNativeData(leaves); runDirectory(directory);
  const reserved = leaves.map(row => {
    leafIdentity(row, true);
    const protocol = { path: `${directory}/${row.id}.jsonl`, sha256: '0'.repeat(64), bytes: Number.MAX_SAFE_INTEGER };
    const output = row.role === 'runner' ? null : { ...protocol, path: `${directory}/${row.id.split('-')[0]}.result.json` };
    return { ...row, protocol, output };
  });
  requireValue(Buffer.byteLength(JSON.stringify(reserved)) <= STATUS_LIMIT - RECEIPT_LIMIT);
}
function validateStatus(s, r = null, bytes = null) {
  assertNativeData(s);
  exact(s, ['version', 'refusalSha256', 'run', 'state', 'retryable', 'leaves', 'counts', 'unplannedWork', 'result', 'coverage', 'provisionalFindings', 'report']);
  requireValue(s.version === 1 && s.state === 'blocked' && s.retryable === false && s.unplannedWork === 'unknown' && hash(s.refusalSha256));
  exact(s.run, ['id', 'head']); requireValue(string(s.run.id, 256) && COMPONENT.test(s.run.id) && oid(s.run.head));
  requireValue(Array.isArray(s.leaves) && s.leaves.length <= 1000);
  const ids = new Set();
  for (const row of s.leaves) {
    exact(row, ['id', 'role', 'label', 'state', 'protocol', 'output']); leafIdentity(row, true);
    requireValue(!ids.has(row.id) && STATES.includes(row.state)); ids.add(row.id);
    for (const key of ['protocol', 'output']) if (row[key] !== null) ref(row[key]);
    if (row.state === 'completed') requireValue(row.protocol !== null && (row.role === 'runner' || row.output !== null));
    if (row.state === 'blocked') requireValue(row.role !== 'runner' && row.protocol !== null);
    if (r) {
      if (row.protocol) requireValue(row.protocol.path === `${r.run.directory}/${row.id}.jsonl`);
      if (row.output) requireValue(row.output.path === `${r.run.directory}/${row.id.split('-')[0]}.result.json`);
    }
  }
  exact(s.counts, STATES);
  const counts = nativeLeafCounts(s.leaves);
  requireValue(STATES.every(k => integer(s.counts[k]) && s.counts[k] === counts[k]) && counts.blocked > 0);
  if (s.result !== null) { ref(s.result); if (r) requireValue(s.result.path === `${r.run.directory}/result.json`); }
  requireValue(Array.isArray(s.coverage) && Array.isArray(s.provisionalFindings));
  for (const c of s.coverage) {
    exact(c, ['lens', 'status', 'areas']);
    requireValue(LENSES.includes(c.lens) && ['covered', 'partial', 'not_covered'].includes(c.status) && (c.areas === null || integer(c.areas)));
  }
  for (const f of s.provisionalFindings) {
    exact(f, ['findingId', 'verificationStatus', 'fixStatus']);
    requireValue(typeof f.findingId === 'string' && /^F[1-9][0-9]*$/.test(f.findingId) && string(f.findingId, 256));
    requireValue(Object.hasOwn(MOVES.verification_status, f.verificationStatus));
    requireValue(Object.hasOwn(MOVES.fix_status, f.fixStatus));
  }
  exact(s.report, ['state', 'path', 'sha256', 'bytes', 'semanticSha256']); relativePath(s.report.path);
  requireValue(['pending', 'current', 'unavailable'].includes(s.report.state));
  if (s.report.state === 'current') requireValue(hash(s.report.sha256) && hash(s.report.semanticSha256) && integer(s.report.bytes) && s.report.bytes <= STATUS_LIMIT);
  else requireValue(s.report.sha256 === null && s.report.bytes === null && s.report.semanticSha256 === null);
  if (r) {
    requireValue(s.refusalSha256 === nativeArtifactHash(bytes) && s.run.id === r.run.id && s.run.head === r.target.head);
    requireValue(s.report.path === `${r.run.directory}/partial-report.md`);
    const blocked = s.leaves.find(l => l.id === r.leaf.id);
    requireValue(blocked?.state === 'blocked' && blocked.role === r.leaf.role && blocked.label === r.leaf.label && blocked.protocol?.path === r.protocol.path && blocked.protocol.sha256 === r.protocol.sha256 && blocked.protocol.bytes === r.protocol.bytes);
  }
  requireValue(Buffer.byteLength(JSON.stringify(s)) <= STATUS_LIMIT);
  return s;
}
const display = text => String(text).replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]).replace(/[\\`*_{}\[\]()#+.!|~-]/g, '\\$&');
export function renderNativeHuntPartialStatus(status) {
  validateStatus(status);
  const lines = ['# Provisional native hunt — incomplete', '', `${refusalMessage} provider_refusal; retryable: false.`,
    'A separately reviewed future resolution is required. Separately selected ordinary builds and static review remain independent work.',
    'Artifact hashes describe publication-time evidence; source streams are not revalidated by this view. Missing or changed source evidence never releases the stop.',
    'These source-only indexes are provisional, not reproduced vulnerabilities, verified fixes or complete review evidence.',
    'Completed means a schema-valid model response (or returned host command); active means terminal result unknown. Unplanned future work: unknown.', '',
    `Run: ${display(status.run.id)}; head: ${status.run.head}`, '', ...STATES.map(k => `- ${k}: ${status.counts[k]}`), '', '## Admitted and pending work'];
  for (const l of status.leaves) lines.push(`- ${display(l.id)} / ${display(l.role)} / ${display(l.label)}: ${l.state}${l.state === 'active' ? ' (unknown terminal)' : ''}`);
  lines.push('', '## Provisional coverage');
  for (const c of status.coverage) lines.push(`- ${c.lens}: ${c.status}; areas: ${c.areas ?? 'unknown'}`);
  if (!status.coverage.length) lines.push('Coverage unavailable; no complete future schedule is claimed.');
  lines.push('', '## Provisional finding indexes');
  for (const f of status.provisionalFindings) lines.push(`- ${f.findingId}: ${f.verificationStatus}; fix: ${f.fixStatus}`);
  if (!status.provisionalFindings.length) lines.push('No finding indexes available; this is not a clean-hunt claim.');
  return lines.join('\n') + '\n';
}
const publicationMarker = directory => `${directory}/status-publication-pending`;
function publicationHeld(common, directory) {
  // A retained owner lock also covers failure to write the publication marker.
  // While a live owner drains work, conservatively withhold a current-prose claim.
  for (const path of [publicationMarker(directory), 'native-hunt.lock']) {
    try { lstatSync(nativeArtifactPath(common, path)); return true; }
    catch (error) { if (error.code !== 'ENOENT') return true; }
  }
  return false;
}
function pendingReport(directory) {
  return { state: 'pending', path: `${directory}/partial-report.md`, sha256: null, bytes: null, semanticSha256: null };
}
function makeStatus(refusal, refusalSha256, leaves, resultReference, result) {
  return { version: 1, refusalSha256, run: { id: refusal.run.id, head: refusal.target.head }, state: 'blocked', retryable: false,
    leaves, counts: nativeLeafCounts(leaves), unplannedWork: 'unknown', result: resultReference,
    coverage: (result?.coverage || []).map(c => ({ lens: c.lens, status: c.status, areas: c.areas ?? null })),
    provisionalFindings: (result?.findings || []).map(f => ({ findingId: f.finding_id, verificationStatus: f.verification_status, fixStatus: f.fix_status })),
    report: pendingReport(refusal.run.directory) };
}
export function publishNativePartialStatus(refusal, leaves, resultFile = null, result = null) {
  const common = refusal.repository, bytes = receiptBytes(common);
  requireValue(bytes !== null);
  const saved = validateRefusal(parse(bytes), common);
  requireValue(JSON.stringify(saved) === JSON.stringify(refusal));
  // Mark publication before any fallible projection or pending-status replacement.
  // A failed update leaves this private marker, so old self-consistent prose is stale.
  const marker = publicationMarker(refusal.run.directory);
  atomicWrite(common, marker, 'Native partial status publication is pending.\n');
  // Invalidate old prose before computing or validating the next projection.
  // If capacity/index admission fails, the prior snapshot remains explicitly pending.
  const priorBytes = readNativeArtifact(common, refusal.statusPath, STATUS_LIMIT, { absent: true });
  if (priorBytes !== null) {
    const prior = validateStatus(parse(priorBytes), refusal, bytes);
    prior.report = pendingReport(refusal.run.directory);
    atomicWrite(common, refusal.statusPath, JSON.stringify(prior) + '\n');
  }
  const status = makeStatus(refusal, nativeArtifactHash(bytes), leaves,
    resultFile ? nativeArtifactReference(common, resultFile) : null, result);
  validateStatus(status, refusal, bytes);
  atomicWrite(common, refusal.statusPath, JSON.stringify(status) + '\n');
  try {
    const prose = renderNativeHuntPartialStatus(status);
    requireValue(Buffer.byteLength(prose) <= STATUS_LIMIT);
    atomicWrite(common, status.report.path, prose);
    status.report = { state: 'current', path: status.report.path, sha256: nativeArtifactHash(prose), bytes: Buffer.byteLength(prose), semanticSha256: semanticHash(status) };
    atomicWrite(common, refusal.statusPath, JSON.stringify(status) + '\n');
    unlinkSync(nativeArtifactPath(common, marker));
  } catch { status.report = pendingReport(refusal.run.directory); /* Disk retains the pending descriptor. */ }
  return status;
}
export function readPartialStatusAtCommon(common) {
  const bytes = receiptBytes(common);
  if (bytes === null) return { refusal: null, status: null, report: { state: 'absent', text: null } };
  const refusal = validateRefusal(parse(bytes), common);
  const data = readNativeArtifact(common, refusal.statusPath, STATUS_LIMIT, { absent: true });
  if (data === null) return { refusal, status: null, report: { state: 'pending', text: null } };
  const status = validateStatus(parse(data), refusal, bytes);
  let state = status.report.state, text = null;
  if (state === 'current' && publicationHeld(common, refusal.run.directory)) state = 'unavailable';
  if (state === 'current') {
    try {
      const prose = readNativeArtifact(common, status.report.path, STATUS_LIMIT);
      if (prose.length !== status.report.bytes || nativeArtifactHash(prose) !== status.report.sha256 || semanticHash(status) !== status.report.semanticSha256 || prose.toString('utf8') !== renderNativeHuntPartialStatus(status)) state = 'stale';
      else text = prose.toString('utf8');
    } catch { state = 'unavailable'; }
  }
  return { refusal, status, report: { state, text } };
}
export function readNativeHuntPartialStatus(repo) { return readPartialStatusAtCommon(nativeCommonDirectory(repo)); }

// Only the runner's live branded repository owner may call this composition.
export function prepareRefusalAdoption({ repo, common, intakeFile, runDir, leaf, expected }) {
  try {
    assertNativeData({ repo, intakeFile, runDir, leaf, expected });
    exact(leaf, ['id', 'role', 'label']); leafIdentity(leaf);
    exact(expected, ['intakeSha256', 'protocolSha256', 'resultSha256']);
    requireValue(Object.values(expected).every(hash));
    const directory = nativeRelativePath(common, runDir); runDirectory(directory);
    const stateDir = dirname(dirname(runDir));
    requireValue(intakeFile === join(stateDir, 'intake.json') && realpathSync(repo) === repo);
    const intakeBytes = readNativeArtifact(common, nativeRelativePath(common, intakeFile), 8 * 1024 * 1024);
    const resultFile = join(runDir, 'result.json');
    const resultBytes = readNativeArtifact(common, nativeRelativePath(common, resultFile), 16 * 1024 * 1024);
    requireValue(nativeArtifactHash(intakeBytes) === expected.intakeSha256 && nativeArtifactHash(resultBytes) === expected.resultSha256);
    const intake = JSON.parse(intakeBytes), result = JSON.parse(resultBytes);
    requireValue(intake.version === 1 && intake.repo === repo && intake.stateDir === stateDir && intake.tree === join(stateDir, 'tree') && intake.key === basename(stateDir));
    requireValue(realpathSync(stateDir) === stateDir && realpathSync(intake.tree) === intake.tree && realpathSync(runDir) === runDir);
    requireValue(result && result.status === 'escalate' && result.head === intake.target.head && ['discover', 'propose', 'fix'].includes(result.mode));
    for (const field of ['findings', 'added', 'merged', 'dropped', 'coverage', 'history']) requireValue(Array.isArray(result[field]));
    requireValue(ledgerProblems({ ...emptyLedger(intake.key), findings: result.findings, coverage: result.coverage }).length === 0);
    requireValue(typeof result.reason === 'string' && result.reason.length > 0 && 'routing' in result && 'impact' in result);
    const file = join(runDir, `${leaf.id}.jsonl`), reference = nativeArtifactReference(common, file);
    requireValue(reference.sha256 === expected.protocolSha256);
    const parsed = readCodexResult(file);
    requireValue(parsed?.providerRefusal?.kind === 'provider_refusal' && parsed.is_error === true);
    const protocol = { ...reference, event: parsed.providerRefusal.event, line: parsed.providerRefusal.line };
    // Validate every publication index before creating the immutable receipt.
    const candidate = { version: 1, kind: 'provider_refusal', retryable: false, repository: common,
      run: { id: basename(runDir), directory }, target: { kind: intake.target.kind, label: intake.target.label, base: intake.target.base, head: intake.target.head },
      leaf, protocol, observedAt: new Date().toISOString(), statusPath: `${directory}/status.json` };
    validateRefusal(candidate, common);
    const leaves = [{ ...leaf, state: 'blocked', protocol: reference, output: null }];
    const trial = makeStatus(candidate, '0'.repeat(64), leaves, nativeArtifactReference(common, resultFile), result);
    validateStatus(trial);
    return { intake, protocol, leaves, resultFile, result, candidate };
  } catch { throw Object.assign(new Error('Saved refusal evidence does not match the reviewed binding.'), { code: 'REFUSAL_ADOPTION_INVALID' }); }
}
