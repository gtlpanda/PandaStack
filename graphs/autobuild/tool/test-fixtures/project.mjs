// A throwaway git project for autobuild's end-to-end tests, and a loop run against the fake
// `claude` (test-fixtures/fake-claude.mjs). Shared by test/loop.test.mjs and test/bughunt.test.mjs.
import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

export const KIT = path.resolve(import.meta.dirname, "..");
const REPO = path.resolve(KIT, "..", "..", "..");

/** A copy of the PandaStack layout the kit imports from (including shared configuration) at `root`; returns the copied kit. */
export function copyKit(root) {
  for (const dir of ["core", "graphs", "scripts", "agent-config.json"]) cpSync(path.join(REPO, dir), path.join(root, dir), { recursive: true });
  return path.join(root, "graphs", "autobuild", "tool");
}
export const CLI = path.join(KIT, "lib", "cli.mjs");
export const FAKE = path.join(KIT, "test-fixtures", "fake-claude.mjs");

export function project(featureIds, limits = {}) {
  const root = mkdtempSync(path.join(tmpdir(), "autobuild-loop-"));
  const git = (...args) => execFileSync("git", args, { cwd: root });
  git("init", "-q", "-b", "autobuild");
  git("config", "user.email", "test@example.com");
  git("config", "user.name", "Test");
  writeFileSync(path.join(root, "autobuild.json"), JSON.stringify({
    branch: "autobuild",
    hooks: "inject",
    limits: { maxIterations: 5, noProgressLimit: 2, reviewEvery: 99, finalReview: false, probeEveryMinutes: 1, transientWaitMinutes: 1, maxTransientRetries: 1, ...limits },
    runners: { unit: { group: "unit", command: "bash -c 'for f in \"$@\"; do id=$(basename \"$f\" .test); test -f \"$id.done\" || exit 1; done' _" } },
    frozen: ["tests"],
    allowedTools: ["Read"],
  }, null, 2));
  writeFileSync(path.join(root, "features.json"), JSON.stringify({ features: featureIds.map((id, i) => ({ id, title: `feature ${id}`, dependencies: i ? [featureIds[i - 1]] : [], test: `tests/${id}.test`, testKind: "unit", passes: false })) }, null, 2));
  writeFileSync(path.join(root, "PROGRESS.md"), "# progress\n");
  execFileSync("mkdir", ["-p", path.join(root, "tests")]);
  for (const id of featureIds) writeFileSync(path.join(root, "tests", `${id}.test`), "frozen\n");
  // The fake claude's script and call records live in the project: out of git and the frozen check.
  writeFileSync(path.join(root, ".gitignore"), "/logs/\n/.harness/\n/.harness-script.json*\n");
  git("add", "-A");
  git("commit", "-q", "-m", "init");
  return root;
}

export function run(root, script, env = {}) {
  const scriptFile = path.join(root, ".harness-script.json");
  writeFileSync(scriptFile, JSON.stringify(script));
  execFileSync("git", ["-C", root, "update-index", "--assume-unchanged", "features.json"], { stdio: "ignore" });
  execFileSync("git", ["-C", root, "update-index", "--no-assume-unchanged", "features.json"], { stdio: "ignore" });
  const result = spawnSync(process.execPath, [CLI, "run"], { cwd: root, encoding: "utf8", env: { ...loopEnv(scriptFile), ...env }, timeout: 120_000 });
  const calls = existsSync(`${scriptFile}.calls`) ? readFileSync(`${scriptFile}.calls`, "utf8").trim().split("\n").map((line) => JSON.parse(line)) : [];
  const logDir = path.join(root, "logs");
  const loopLog = existsSync(logDir) ? readdirSync(logDir).filter((name) => name.startsWith("loop-")).map((name) => readFileSync(path.join(logDir, name), "utf8")).join("\n") : "";
  return { code: result.status, out: `${result.stdout}${result.stderr}`, calls, loopLog };
}

// The bug hunt is off unless a test turns it on (test/bughunt.test.mjs).
export function loopEnv(scriptFile) {
  return { ...process.env, AUTOBUILD_CLAUDE_BIN: FAKE, FAKE_CLAUDE_SCRIPT: scriptFile, AUTOBUILD_CLI: CLI, AUTOBUILD_MAX_SLEEP_MS: "300", AUTOBUILD_BUGHUNT: "0" };
}

export function head(root) {
  return execFileSync("git", ["-C", root, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
}
