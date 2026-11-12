import assert from "node:assert/strict";
import { test } from "node:test";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { loadConfig } from "../lib/config.mjs";
import { checkEvidence, evidenceDirProblem, evidenceManifest, verifyEvidence } from "../lib/evidence.mjs";
import { buildEnv } from "../lib/proc.mjs";
import { CLI, project as loopProject, run as runLoop } from "../test-fixtures/project.mjs";

const put = (root, file, text) => { mkdirSync(path.dirname(path.join(root, file)), { recursive: true }); writeFileSync(path.join(root, file), text); };
const git = (root, ...args) => execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...args], { cwd: root, encoding: "utf8" }).trim();

// A project whose base declares its run-evidence directory, then a session's changes.
function project(config = {}) {
  const root = mkdtempSync(path.join(tmpdir(), "evidence-"));
  git(root, "init", "-q", "-b", "autobuild");
  put(root, "autobuild.json", JSON.stringify({ branch: "autobuild", hooks: "inject", frozen: [], ...config }));
  put(root, "features.json", JSON.stringify({ features: [] }));
  put(root, ".gitignore", "/logs/\n/.harness/\n/out/\n");
  put(root, ".gitattributes", "runs/*/evidence/** bughunt-skip\npackage-lock.json linguist-generated\n");
  put(root, "src/app.js", "export const a = 1\n");
  put(root, "package-lock.json", "{}\n");
  git(root, "add", "-A");
  git(root, "commit", "-qm", "base");
  return { root, base: git(root, "rev-parse", "HEAD") };
}

test("the guard refuses declared evidence and bulky files, committed or not, and allows code", () => {
  const { root, base } = project({ evidence: { paths: ["reports/**"], maxFileBytes: 1024 } });
  put(root, "runs/r1/evidence/gate.json", "{}\n");            // declared at base, committed below
  put(root, "runs/r1/evidence/check.mjs", "export {}\n");     // code inside the evidence dir: allowed
  put(root, "runs/r1/SPEC.md", "# spec\n");                    // run docs outside it: allowed
  put(root, "reports/qa.md", "# qa\n");                        // evidence.paths glob
  put(root, "src/app.js", "export const a = 2\n");             // ordinary change
  put(root, "package-lock.json", `{"v":"${"x".repeat(4096)}"}\n`); // tracked at base: an edit is never refused, declared or large
  put(root, "assets/bundle.js", "x".repeat(2048));              // code, but over maxFileBytes
  put(root, ".gitattributes", "runs/*/evidence/** bughunt-skip\nsrc/** bughunt-skip\n"); // the session's own declaration: no effect
  put(root, "src/data.json", "{}\n");
  git(root, "add", "-A");
  git(root, "commit", "-qm", "session");
  put(root, "runs/r1/evidence/shot.png", "PNG\n");              // untracked, not ignored: `git add .` would take it
  put(root, "out/ignored.json", "{}\n");                        // ignored: never committed
  const result = checkEvidence(loadConfig(root, {}), base);
  assert.equal(result.ok, false);
  const refused = result.output.split("\n").filter((line) => line.startsWith("  ")).map((line) => line.trim().split(" ")[0]).sort();
  assert.deepEqual(refused, ["assets/bundle.js", "reports/qa.md", "runs/r1/evidence/gate.json", "runs/r1/evidence/shot.png"]);
  assert.match(result.output, /runs\/r1\/evidence\/gate\.json \(declared evidence: bughunt-skip\)/);
  assert.match(result.output, /reports\/qa\.md \(declared evidence: evidence\.paths reports\/\*\*\)/);
  assert.match(result.output, /assets\/bundle\.js \(0\.0 MiB, over evidence\.maxFileBytes/);
  assert.match(result.output, /Write verification, provenance and QA output under logs\/evidence\/ instead/);
});

test("nothing is refused by location alone: an undeclared repo only has the size limit", () => {
  const { root, base } = project();
  writeFileSync(path.join(root, ".gitattributes"), "");
  put(root, "docs/autobuild/r1/verification/gate.json", "{}\n");
  put(root, "src/app.js", "export const a = 3\n");
  assert.deepEqual(checkEvidence(loadConfig(root, {}), base), { ok: true, output: "", warnings: [] });
});

test("the evidence directory must be a gitignored, unfrozen project path outside .git", () => {
  const { root } = project();
  assert.equal(evidenceDirProblem(loadConfig(root, {})), null, "the default sits in the ignored logs dir");
  const frozen = project({ evidence: { dir: ".harness/evidence" } });
  assert.match(evidenceDirProblem(loadConfig(frozen.root, {})), /evidence\.dir \.harness\/evidence is inside the frozen \.harness, so sessions cannot write to it/);
  const tracked = project({ evidence: { dir: "evidence-out" } });
  assert.match(evidenceDirProblem(loadConfig(tracked.root, {})), /evidence\.dir evidence-out is not gitignored; add it to \.gitignore/);
  const dotGit = project({ evidence: { dir: ".git/evidence" } });
  assert.match(evidenceDirProblem(loadConfig(dotGit.root, {})), /evidence\.dir \.git\/evidence is inside \.git/);
});

test("the session prompt names the evidence directory by its literal project path", async () => {
  const { root } = project({ evidence: { dir: "out/run-evidence" } });
  const config = loadConfig(root, {});
  const { codexArgs } = await import("../lib/codex.mjs");
  const { input } = codexArgs(config, { prompt: "build" });
  assert.match(input, /under out\/run-evidence\/ \(gitignored; scripts also get its absolute path as AUTOBUILD_EVIDENCE_DIR\)/);
  assert.doesNotMatch(input, /\$AUTOBUILD_EVIDENCE_DIR/, "never a variable the guard cannot resolve");
});

test("sessions get the evidence directory as AUTOBUILD_EVIDENCE_DIR", () => {
  const { root } = project();
  const config = loadConfig(root, {});
  assert.equal(config.evidenceDir, path.join(root, "logs", "evidence"));
  assert.equal(buildEnv(config).AUTOBUILD_EVIDENCE_DIR, config.evidenceDir);
});

test("a manifest binds the evidence by hash; verify reports missing, changed and extra files", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "evidence-files-"));
  put(dir, "gate.log", "PASS\n");
  put(dir, "qa/shot.png", "PNG\n");
  const manifest = evidenceManifest(dir);
  assert.deepEqual(manifest.files.map((f) => [f.path, f.bytes]), [["gate.log", 5], ["qa/shot.png", 4]]);
  assert.match(manifest.files[0].sha256, /^[0-9a-f]{64}$/);
  assert.deepEqual(verifyEvidence(dir, manifest), { ok: true, missing: [], changed: [], extra: [] });
  writeFileSync(path.join(dir, "gate.log"), "FAIL\n");
  rmSync(path.join(dir, "qa/shot.png"));
  put(dir, "new.txt", "x");
  assert.deepEqual(verifyEvidence(dir, manifest), { ok: false, missing: ["qa/shot.png"], changed: ["gate.log"], extra: ["new.txt"] });
  assert.throws(() => verifyEvidence(dir, { schemaVersion: 1, files: [{ path: "../x", sha256: "" }] }), /relative paths inside/);
  assert.throws(() => verifyEvidence(dir, { files: [] }), /not an evidence manifest/);
  assert.throws(() => evidenceManifest(path.join(dir, "nope")), /no evidence directory/);
});

const cli = (root, ...args) => {
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  const r = spawnSync(process.execPath, [CLI, ...args], { cwd: root, env, encoding: "utf8", timeout: 120_000 });
  return { code: r.status, out: `${r.stdout}${r.stderr}` };
};

test("autobuild evidence manifest and verify, and the gate step that refuses evidence", () => {
  const { root, base } = project();
  const dir = path.join(root, "logs", "evidence");
  put(dir, "run/gate.log", "PASS\n");
  const manifest = path.join(root, "EVIDENCE-MANIFEST.json");
  assert.equal(cli(root, "evidence", "manifest", "--out", manifest).code, 0);
  assert.equal(JSON.parse(readFileSync(manifest, "utf8")).files[0].path, "run/gate.log");
  const ok = cli(root, "evidence", "verify", manifest);
  assert.equal(ok.code, 0, ok.out);
  assert.match(ok.out, /EVIDENCE: MATCHES/);
  writeFileSync(path.join(dir, "run/gate.log"), "FAIL\n");
  const bad = cli(root, "evidence", "verify", manifest);
  assert.equal(bad.code, 1);
  assert.match(bad.out, /CHANGED {2}run\/gate\.log[\s\S]*EVIDENCE: DIFFERS/);
  put(root, "runs/r1/evidence/gate.json", "{}\n");
  const gate = cli(root, "check", "--phase", "full", "--base", base);
  assert.equal(gate.code, 1, gate.out);
  assert.match(gate.out, /FAIL {2}run evidence kept out of git/);
  rmSync(path.join(root, "runs"), { recursive: true });
  rmSync(manifest);
  const clean = cli(root, "check", "--phase", "full", "--base", base);
  assert.match(clean.out, /PASS {2}run evidence kept out of git/, clean.out);
});

test("malformed evidence settings are refused when the config loads", () => {
  for (const [evidence, why] of [
    [[], /evidence must be an object/],
    [{ dir: "" }, /evidence\.dir must be a relative path inside the project/],
    [{ dir: "/var/tmp/evidence" }, /evidence\.dir must be a relative path inside the project/],
    [{ dir: "../evidence" }, /evidence\.dir must be a relative path inside the project/],
    [{ dir: "logs/../../evidence" }, /evidence\.dir must be a relative path inside the project/],
    [{ dir: "logs\\..\\..\\evidence" }, /evidence\.dir must be a relative path inside the project/],
    [{ paths: "x" }, /evidence\.paths must be an array of globs/],
    [{ maxFileBytes: 0 }, /positive integer/],
    [{ extra: 1 }, /unknown keys: extra/],
  ]) {
    const { root } = project({ evidence });
    assert.throws(() => loadConfig(root, {}), why, JSON.stringify(evidence));
  }
});

test("builder sessions may write to the default evidence directory", async () => {
  const { root } = project();
  const config = loadConfig(root, {});
  const rel = path.relative(root, config.evidenceDir);
  assert.ok(!config.frozen.some((entry) => rel === entry || rel.startsWith(`${entry}/`)), `${rel} is not frozen`);
  const { sessionSettings } = await import("../lib/loop.mjs");
  const deny = sessionSettings(config).permissions.deny;
  assert.ok(!deny.some((rule) => rule.includes("logs")), "no deny rule covers it");
  const guard = spawnSync(process.execPath, [new URL("../hooks/guard.mjs", import.meta.url).pathname], {
    cwd: root, encoding: "utf8", env: { ...process.env, AUTOBUILD_ACTIVE: "1", AUTOBUILD_ROLE: "builder" },
    input: JSON.stringify({ tool_name: "Write", tool_input: { file_path: path.join(config.evidenceDir, "gate.log"), content: "x" }, cwd: root }),
  });
  assert.equal(guard.status, 0, guard.stdout + guard.stderr);
  assert.doesNotMatch(guard.stdout, /"permissionDecision":\s*"deny"/);
});

test("an evidence directory that cannot be created fails preflight with exit 5", () => {
  const root = loopProject(["F-1"]);
  writeFileSync(path.join(root, "blocker"), "a file, not a directory\n");
  const file = path.join(root, "autobuild.json");
  writeFileSync(file, JSON.stringify({ ...JSON.parse(readFileSync(file, "utf8")), evidence: { dir: "blocker/evidence" } }));
  git(root, "add", "-A");
  git(root, "commit", "-qm", "evidence dir under a file");
  const result = runLoop(root, []);
  assert.equal(result.code, 5, result.out);
  assert.match(result.loopLog, /preflight: cannot create the evidence directory .*blocker\/evidence: ENOTDIR/);
  assert.match(result.loopLog, /preflight FAILED/);
});

const GUARD = new URL("../hooks/guard.mjs", import.meta.url).pathname;
function decide(root, tool, input, role = "builder") {
  const r = spawnSync(process.execPath, [GUARD], {
    cwd: root, encoding: "utf8", env: { ...process.env, AUTOBUILD_ACTIVE: "1", AUTOBUILD_ROLE: role, CLAUDE_PROJECT_DIR: root },
    input: JSON.stringify({ tool_name: tool, tool_input: input, cwd: root }),
  });
  return /"permissionDecision":\s*"deny"/.test(r.stdout) ? "deny" : "allow";
}

test("when .gitattributes cannot be read at the base, the guard says the declared check did not run", () => {
  const { root, base } = project();
  put(root, "runs/r1/evidence/gate.json", "{}\n");
  const shim = mkdtempSync(path.join(tmpdir(), "git-shim-"));
  const realGit = execFileSync("bash", ["-c", "command -v git"], { encoding: "utf8" }).trim();
  writeFileSync(path.join(shim, "git"), `#!/bin/sh\nfor a in "$@"; do [ "$a" = check-attr ] && exit 129; done\nexec ${realGit} "$@"\n`, { mode: 0o755 });
  const oldPath = process.env.PATH;
  process.env.PATH = `${shim}:${oldPath}`;
  try {
    const result = checkEvidence(loadConfig(root, {}), base);
    assert.equal(result.ok, true, "declared evidence cannot be judged, so it is not refused");
    assert.match(result.warnings.join("\n"), /\.gitattributes could not be read as of [0-9a-f]{12} .*only evidence\.paths and the size limit were checked/);
  } finally { process.env.PATH = oldPath; }
});

test("a symlink swapped into the evidence path never opens what it points at", () => {
  const { root } = project();
  const dir = loadConfig(root, {}).evidenceDir;      // <root>/logs/evidence
  mkdirSync(path.dirname(dir), { recursive: true });
  const write = (file) => decide(root, "Write", { file_path: file, content: "x" });
  // Swapped for a link to the project: frozen files stay frozen.
  symlinkSync(root, dir);
  assert.equal(write(path.join(dir, "autobuild.json")), "deny");
  // Swapped for a link to the frozen state dir.
  rmSync(dir);
  mkdirSync(path.join(root, ".harness"), { recursive: true });
  symlinkSync(path.join(root, ".harness"), dir);
  assert.equal(write(path.join(dir, "session.json")), "deny");
  // A real evidence dir holding a link to a frozen file: the write lands in the frozen file, so it is denied.
  rmSync(dir);
  mkdirSync(dir);
  symlinkSync(path.join(root, "autobuild.json"), path.join(dir, "cfg.json"));
  assert.equal(write(path.join(dir, "cfg.json")), "deny");
  assert.equal(write(path.join(dir, "ok.log")), "allow", "ordinary evidence still works");
});

test("a command cannot widen the guard by naming the evidence variable", () => {
  const { root } = project();
  for (const command of [
    "AUTOBUILD_EVIDENCE_DIR=/etc; echo x > $AUTOBUILD_EVIDENCE_DIR/passwd-test",
    "export AUTOBUILD_EVIDENCE_DIR=$HOME; echo x > $AUTOBUILD_EVIDENCE_DIR/.bashrc",
    "echo x > $AUTOBUILD_EVIDENCE_DIR/../../autobuild.json",
  ]) assert.equal(decide(root, "Bash", { command }), "deny", command);
  assert.equal(decide(root, "Bash", { command: "echo x > logs/evidence/gate.log" }), "allow", "the literal project path works");
});
