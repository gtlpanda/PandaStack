import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, rmSync, mkdirSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { project, run, KIT, CLI, loopEnv } from "../test-fixtures/project.mjs";

const git = (root, ...args) => execFileSync("git", ["-C", root, ...args], { encoding: "utf8" }).trim();
const fakeEnv = { AUTOBUILD_BACKEND: "codex", AUTOBUILD_CODEX_BIN: path.join(KIT, "test-fixtures/fake-codex.mjs"), AUTOBUILD_CLAUDE_BIN: "/no/claude" };
function fixture(t, patch = {}, ids = ["F-1"]) {
  const root = project(ids, { maxIterations: 3, reviewEvery: 1, finalReview: true });
  t.after(() => rmSync(root, { recursive: true, force: true }));
  git(root, "branch", "main");
  const file = path.join(root, "autobuild.json");
  const config = JSON.parse(readFileSync(file, "utf8"));
  Object.assign(config, { bughunt: true, bughuntBase: "main", gate: [{ name: "deferred regression", command: "exit 71" }], commitGate: [{ name: "focused secrets", command: "exit 0" }] }, patch);
  writeFileSync(file, JSON.stringify(config));
  git(root, "add", "autobuild.json"); git(root, "commit", "-qm", "ordinary fixture config");
  return root;
}
function completedFixture(root) {
  const file = path.join(root, "features.json");
  const doc = JSON.parse(readFileSync(file, "utf8"));
  doc.features.forEach(feature => { feature.passes = true; });
  writeFileSync(file, JSON.stringify(doc));
  git(root, "add", "features.json"); git(root, "commit", "-qm", "ordinary completed fixture");
}
const handoffPath = root => path.join(root, ".harness/delivery-status.json");
function assertPendingHandoff(root, result) {
  assert.equal(result.code, 0, result.out);
  assert.equal(result.calls.length, 1, "only the fake builder is dispatched");
  assert.equal(existsSync(path.join(root, ".harness-script.json.hunt-calls")), false);
  assert.equal(git(root, "log", "--format=%s", "--grep=^chore(review):"), "");
  assert.match(result.out, /full regressions and broad review remain pending/);
  assert.doesNotMatch(result.out, /every feature passes\. Done\.|bug hunt:.*pass/);
  const handoff = JSON.parse(readFileSync(handoffPath(root), "utf8"));
  assert.equal(handoff.status, "ready_for_pr"); assert.equal(handoff.head, git(root, "rev-parse", "HEAD"));
  assert.equal(handoff.mergeReady, false); assert.equal(handoff.fullGate, "pending");
  assert.equal(handoff.review, "pending"); assert.equal(handoff.hunt, "deferred");
}

test("PR-first dispatches no periodic/final review or hunt and reports a pending PR handoff", t => {
  const root = fixture(t, { deliveryMode: "pr-first" });
  const result = run(root, [{ build: "F-1" }, { review: true }], { ...fakeEnv, AUTOBUILD_BUGHUNT: "1" });
  assertPendingHandoff(root, result);
});

test("a failed commit gate blocks feature acceptance and PR handoff", t => {
  const root = fixture(t, { deliveryMode: "pr-first", commitGate: [{ name: "focused secrets", command: "exit 7" }] });
  const base = git(root, "rev-parse", "HEAD");
  const result = run(root, [{ build: "F-1" }, { ok: true }], { ...fakeEnv, AUTOBUILD_BUGHUNT: "1" });
  assert.notEqual(result.code, 0, result.out);
  assert.match(result.out, /focused secrets/);
  assert.equal(existsSync(handoffPath(root)), false);
  assert.equal(git(root, "rev-parse", "HEAD"), base);
  assert.equal(JSON.parse(readFileSync(path.join(root, "features.json"), "utf8")).features[0].passes, false);
  assert.doesNotMatch(result.out, /ready for a draft PR|every feature passes\. Done\./);
});

test("CLI delivery override selects PR-first despite a full project and full inherited setting", t => {
  const root = fixture(t, { deliveryMode: "full" });
  const script = path.join(root, ".harness-script.json");
  writeFileSync(script, JSON.stringify([{ build: "F-1" }, { review: true }]));
  const result = spawnSync(process.execPath, [CLI, "run", "--delivery-mode", "pr-first"], {
    cwd: root, encoding: "utf8", timeout: 20000,
    env: { ...process.env, ...loopEnv(script), ...fakeEnv, AUTOBUILD_DELIVERY_MODE: "full", AUTOBUILD_BUGHUNT: "1" },
  });
  const calls = readFileSync(`${script}.calls`, "utf8").trim().split("\n").map(JSON.parse);
  assertPendingHandoff(root, { code: result.status, out: `${result.stdout}${result.stderr}`, calls });
});

test("CLI check remains full by default and commit phase requires explicit selection", t => {
  const root = fixture(t, { deliveryMode: "pr-first" }, []);
  const check = args => spawnSync(process.execPath, [CLI, "check", ...args], { cwd: root, encoding: "utf8", timeout: 10000 });
  const full = check([]);
  assert.equal(full.status, 1); assert.match(full.stdout, /deferred regression/);
  const commit = check(["--phase", "commit"]);
  assert.equal(commit.status, 0); assert.match(commit.stdout, /COMMIT GATE: PASS/);
  assert.match(commit.stdout, /Pending PR checks: deferred regression/);
});

test("default full delivery still performs its final review before reporting Done", t => {
  const root = fixture(t, { gate: [], bughunt: false });
  const result = run(root, [{ build: "F-1" }, { review: true }], fakeEnv);
  assert.equal(result.code, 0, result.out);
  assert.equal(result.calls.length, 2);
  assert.notEqual(git(root, "log", "--format=%s", "--grep=^chore(review):"), "");
  assert.match(result.out, /every feature passes\. Done\./);
  assert.equal(existsSync(handoffPath(root)), false);
});


test("a new failed run invalidates an earlier ready-for-PR record", t => {
  const root = fixture(t, { deliveryMode: "pr-first", commitGate: [{ name: "focused failure", command: "exit 7" }] });
  completedFixture(root);
  mkdirSync(path.join(root, ".harness"), { recursive: true });
  writeFileSync(handoffPath(root), JSON.stringify({ version: 1, status: "ready_for_pr", head: git(root, "rev-parse", "HEAD") }));
  const result = run(root, [], fakeEnv);
  assert.notEqual(result.code, 0, result.out);
  assert.equal(result.calls.length, 0);
  assert.match(result.out, /PR handoff checks failed.*focused failure/);
  assert.equal(existsSync(handoffPath(root)), false);
  assert.doesNotMatch(result.out, /is ready for a draft PR/);
});

test("ordinary gate output that changes the working tree cannot certify the old committed head", t => {
  const root = fixture(t, { deliveryMode: "pr-first", commitGate: [{ name: "ordinary generated file", command: "printf 'ordinary fixture\\n' > generated.txt" }] });
  completedFixture(root);
  const base = git(root, "rev-parse", "HEAD");
  const result = run(root, [], fakeEnv);
  assert.notEqual(result.code, 0, result.out);
  assert.equal(result.calls.length, 0);
  assert.equal(existsSync(handoffPath(root)), false);
  assert.equal(git(root, "rev-parse", "HEAD"), base);
  assert.equal(existsSync(path.join(root, "generated.txt")), true, result.out);
  assert.equal(readFileSync(path.join(root, "generated.txt"), "utf8"), "ordinary fixture\n");
  assert.doesNotMatch(result.out, /is ready for a draft PR/);
});


test("PR-first finalizes after the last allowed builder without dispatching another session", t => {
  const root = fixture(t, { deliveryMode: "pr-first", limits: { maxIterations: 1, reviewEvery: 1, finalReview: true } });
  const result = run(root, [{ build: "F-1" }, { review: true }], { ...fakeEnv, AUTOBUILD_BUGHUNT: "1" });
  assertPendingHandoff(root, result);
  assert.doesNotMatch(result.out, /maxIterations=1 reached/);
  assert.deepEqual(JSON.parse(readFileSync(path.join(root, ".harness-script.json"), "utf8")), [{ review: true }]);
});
