// Run evidence (verification logs, provenance, QA output) belongs outside git:
// sessions write it to config.evidenceDir (a gitignored project path), and only a
// small manifest of hashes is committed. The commit guard refuses new or changed
// files that are declared evidence (.gitattributes as of the session's base, or
// evidence.paths globs; non-code kinds only) or larger than evidence.maxFileBytes.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { declaredAt, evidenceReason } from "../../../../scripts/evidence-paths.mjs";
import { SAFE_GIT, evidenceRel } from "./proc.mjs";

const MAX_LISTED = 50;
const MiB = 1024 * 1024;

const nul = (text) => text.split("\0").filter(Boolean);

// Git with the loop's safety flags, stdout only (paths are NUL-separated), optional stdin.
function git(config, args, { input } = {}) {
  const r = spawnSync("git", [...SAFE_GIT, ...args], { cwd: config.root, encoding: "utf8", input, maxBuffer: 256 * 1024 * 1024 });
  return { ok: r.status === 0, stdout: r.stdout ?? "" };
}

// Files a commit would add relative to base: files added since base (committed or
// not) plus untracked files git does not ignore. Edits to files already tracked at
// base are never refused: a lockfile or generated doc the project keeps is not run evidence.
function addedSince(config, baseSha) {
  const tracked = git(config, ["-c", "core.quotepath=off", "diff", "--name-only", "-z", "--no-renames", "--diff-filter=A", baseSha]);
  const untracked = git(config, ["-c", "core.quotepath=off", "ls-files", "--others", "--exclude-standard", "-z"]);
  if (!tracked.ok || !untracked.ok) return null;
  return [...new Set([...nul(tracked.stdout), ...nul(untracked.stdout)])].sort();
}

/** Problems with where evidence lives: a gitignored, unfrozen directory inside the project. */
export function evidenceDirProblem(config) {
  const rel = evidenceRel(config);
  if (rel === "" || rel.startsWith("..") || path.isAbsolute(rel)) return `evidence.dir must be inside the project`;
  if (rel === ".git" || rel.startsWith(".git/")) return `evidence.dir ${rel} is inside .git`;
  const frozen = (config.frozen ?? []).find((entry) => rel === entry || rel.startsWith(`${entry.replace(/\/$/, "")}/`));
  if (frozen) return `evidence.dir ${rel} is inside the frozen ${frozen}, so sessions cannot write to it; choose a gitignored path that is not frozen`;
  const ignored = git(config, ["check-ignore", "-q", "--no-index", `${rel}/probe`]);
  return ignored.ok ? null : `evidence.dir ${rel} is not gitignored; add it to .gitignore`;
}

/** The commit guard: {ok, output}. */
export function checkEvidence(config, baseSha) {
  const problems = [];
  const dirProblem = evidenceDirProblem(config);
  if (dirProblem) problems.push(dirProblem);
  const changed = addedSince(config, baseSha);
  if (!changed) return { ok: false, output: `could not list the files added since ${baseSha}`, warnings: [] };
  const { declared, read } = declaredAt((args, opts) => git(config, args, opts), baseSha, changed);
  const warnings = read ? [] : [`.gitattributes could not be read as of ${baseSha.slice(0, 12)} (git check-attr --source needs git 2.40+), so only evidence.paths and the size limit were checked`];
  const refused = [];
  for (const file of changed) {
    const reason = evidenceReason(file, declared, config.evidence.paths, (glob) => `evidence.paths ${glob}`);
    if (reason) { refused.push(`${file} (declared evidence: ${reason})`); continue; }
    let size = 0;
    try { const stat = lstatSync(path.join(config.root, file)); if (stat.isFile()) size = stat.size; } catch { /* deleted since */ }
    if (size > config.evidence.maxFileBytes) refused.push(`${file} (${(size / MiB).toFixed(1)} MiB, over evidence.maxFileBytes ${(config.evidence.maxFileBytes / MiB).toFixed(1)} MiB)`);
  }
  if (refused.length) {
    problems.push(`${refused.length} file(s) would put run evidence or bulky output in git:`);
    problems.push(...refused.slice(0, MAX_LISTED).map((line) => `  ${line}`));
    if (refused.length > MAX_LISTED) problems.push(`  … and ${refused.length - MAX_LISTED} more`);
    problems.push(`Write verification, provenance and QA output under ${evidenceRel(config)}/ instead (gitignored), and commit only a manifest of hashes: \`autobuild evidence manifest --out <file>\`.`);
  }
  return { ok: problems.length === 0, output: [...problems, ...warnings].join("\n"), warnings };
}

// ---------- manifest ----------

function walk(dir, base = dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, base, out);
    else if (entry.isFile()) out.push(path.relative(base, full).split(path.sep).join("/"));
  }
  return out;
}

const sha256 = (file) => createHash("sha256").update(readFileSync(file)).digest("hex");

/** {schemaVersion, files: [{path, bytes, sha256}]} for every file under dir, in path order. */
export function evidenceManifest(dir) {
  if (!existsSync(dir)) throw new Error(`no evidence directory at ${dir}`);
  return {
    schemaVersion: 1,
    files: walk(dir).map((rel) => {
      const full = path.join(dir, rel);
      return { path: rel, bytes: statSync(full).size, sha256: sha256(full) };
    }),
  };
}

/** Compares dir with a manifest: {ok, missing, changed, extra}. Extra files are reported, not failed. */
export function verifyEvidence(dir, manifest) {
  if (!manifest || manifest.schemaVersion !== 1 || !Array.isArray(manifest.files)) throw new Error("not an evidence manifest (schemaVersion 1)");
  const missing = [], changed = [];
  const listed = new Set();
  for (const entry of manifest.files) {
    if (!entry || typeof entry.path !== "string" || entry.path.split("/").includes("..") || path.isAbsolute(entry.path)) throw new Error("manifest entries must be relative paths inside the evidence directory");
    listed.add(entry.path);
    const full = path.join(dir, entry.path);
    if (!existsSync(full)) { missing.push(entry.path); continue; }
    if (sha256(full) !== entry.sha256) changed.push(entry.path);
  }
  const extra = existsSync(dir) ? walk(dir).filter((rel) => !listed.has(rel)) : [];
  return { ok: missing.length === 0 && changed.length === 0, missing, changed, extra };
}
