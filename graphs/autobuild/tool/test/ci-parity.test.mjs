import assert from "node:assert/strict";
import { test } from "node:test";
import { spawn, spawnSync, execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { parseWorkflowYaml, WorkflowYamlError } from "../lib/workflow-yaml.mjs";
import { assignments, optionValues, shellWords, simpleCommands } from "../lib/shell-words.mjs";
import { appearsAsCommand, parityEnv, resolveCiParity, runParityStep, toolOf } from "../lib/ci-parity.mjs";
import { KIT, CLI } from "../test-fixtures/project.mjs";

const CHERRY_WORKFLOW = readFileSync(path.join(KIT, "test-fixtures", "ci", "cherry-crm-test.yml"), "utf8");
// cherry-crm's actual gate command for prior server acceptance (origin/dev autobuild.json).
const CHERRY_ACCEPTANCE_GATE = `flock /tmp/cherry-autobuild-db.lock bash -c 'builtin cd server && ./node_modules/.bin/vitest run --config vitest.acceptance.config.js --configLoader runner --no-cache --no-file-parallelism --exclude '"'"'tests/acceptance/p16/**'"'"' --exclude '"'"'tests/acceptance/p114/**'"'"''`;
const CHERRY_UNIT_GATE = `flock /tmp/cherry-autobuild-db.lock bash -c 'builtin cd server && node tests/support/resetDb.js secfix_unit_p114 && env -u DB_NAME DATABASE_URL=postgresql://ci:ci@127.0.0.1:55462/secfix_unit_p114 SCRATCH_DB_REQUIRED=1 ./node_modules/.bin/vitest run --configLoader runner --no-cache --no-file-parallelism'`; // # allow-secret: placeholder credentials

// ---------- workflow YAML ----------

test("reads cherry-crm's real workflow: steps, directories, step env and service settings", () => {
  const doc = parseWorkflowYaml(CHERRY_WORKFLOW);
  assert.deepEqual(Object.keys(doc.jobs), ["client-tests", "db-tests"]);
  assert.deepEqual(doc.on.pull_request.branches, ["main"]);
  const db = doc.jobs["db-tests"];
  const unit = db.steps.find((s) => s.name === "Unit suite on the scratch DB");
  assert.equal(unit["working-directory"], "server");
  assert.deepEqual(unit.env, { DATABASE_URL: "postgres://ci:ci@127.0.0.1:55462/secfix_unit", SCRATCH_DB_REQUIRED: "1" }); // # allow-secret: placeholder credentials
  assert.equal(unit.run, "./node_modules/.bin/vitest run");
  const acceptance = db.steps.find((s) => s.name === "Acceptance suite (autobuild, booted server)");
  assert.equal(acceptance.env, undefined, "CI gives the acceptance step no env of its own");
  assert.equal(db.services.postgres.env.POSTGRES_DB, "secfix_template");
  assert.match(db.services.postgres.options, /^--health-cmd "pg_isready -U secfix -d secfix_template" --health-interval 5s/, "folded block scalar");
  assert.equal(doc.jobs["client-tests"].steps[1].with["cache-dependency-path"], "package-lock.json\nclient/package-lock.json\n", "literal block scalar keeps lines");
});

test("reads PandaStack's own workflow", () => {
  const doc = parseWorkflowYaml(readFileSync(path.join(KIT, "..", "..", "..", ".github", "workflows", "test.yml"), "utf8"));
  assert.ok(doc.jobs.test.steps.some((s) => s.run && s.run.includes("check --phase full")));
});

test("scalars, comments, block chomping and flow collections", () => {
  const doc = parseWorkflowYaml([
    "a: plain value # a comment",
    "b: 'it''s # not a comment'",
    'c: "tab\\there"',
    "d: [x, 'y z', \"w\"]",
    "e: {k: v, 'q': r}",
    "f: |-",
    "  one",
    "",
    "  two",
    "g: >",
    "  folded",
    "  line",
    "h:",
    "- seq at key indent",
    "i: url#fragment",
  ].join("\n"));
  assert.deepEqual(doc, { a: "plain value", b: "it's # not a comment", c: "tab\there", d: ["x", "y z", "w"], e: { k: "v", q: "r" }, f: "one\n\ntwo", g: "folded line\n", h: ["seq at key indent"], i: "url#fragment" });
});

test("unsupported YAML fails loudly instead of being misread", () => {
  for (const [source, why] of [
    ["a: &anchor x", /anchors, aliases and tags/],
    ["a: *alias", /anchors, aliases and tags/],
    ["a: !!str x", /anchors, aliases and tags/],
    ["<<: x", /merge keys/],
    ["a: [x,\n  y]", /multi-line flow/],
    ["a: 1\n---\nb: 2", /multiple documents/],
    ["a: 1\na: 2", /duplicate key a/],
    ["a:\n\tb: 1", /tab indentation/],
    ["a: 'open", /unterminated/],
    ["  a: 1", /column 0/],
  ]) assert.throws(() => parseWorkflowYaml(source), (e) => e instanceof WorkflowYamlError && why.test(e.message), source);
});

// ---------- shell words ----------

test("splits cherry-crm's gate commands, including the bash -c script and '\"'\"' quoting", () => {
  const [run] = simpleCommands(CHERRY_ACCEPTANCE_GATE).filter((c) => c.words.some((w) => w.endsWith("vitest")));
  assert.equal(run.cwd, "server");
  assert.deepEqual(optionValues(run.words, "--config"), ["vitest.acceptance.config.js"]);
  assert.deepEqual(optionValues(run.words, "--exclude"), ["tests/acceptance/p16/**", "tests/acceptance/p114/**"]);
  const unit = simpleCommands(CHERRY_UNIT_GATE).find((c) => c.words.includes("env"));
  assert.deepEqual(assignments(unit.words), [
    { name: "DATABASE_URL", value: "postgresql://ci:ci@127.0.0.1:55462/secfix_unit_p114" }, // # allow-secret: placeholder credentials
    { name: "SCRATCH_DB_REQUIRED", value: "1" },
  ]);
});

test("shell words: quotes, escapes, operators, cd tracking and option forms", () => {
  assert.deepEqual(shellWords(`a "b c" 'd e'f g\\ h`), ["a", "b c", "d ef", "g h"]);
  assert.deepEqual(shellWords("x&&y||z;w|v"), ["x", "&&", "y", "||", "z", ";", "w", "|", "v"]);
  assert.deepEqual(shellWords('echo "a\\"b" # comment'), ["echo", 'a"b']);
  assert.deepEqual(simpleCommands("cd a && cd ../b/c && run; cd /abs && run2").map((c) => [c.cwd, c.words[0]]), [["b/c", "run"], ["/abs", "run2"]]);
  assert.deepEqual(optionValues(["x", "--config=a.js", "--config", "b.js", "--configLoader", "r"], "--config"), ["a.js", "b.js"]);
  assert.deepEqual(assignments(["A=1", "B=", "cmd", "C=3"]), [{ name: "A", value: "1" }, { name: "B", value: "" }]);
  assert.deepEqual(assignments(["env", "-u", "X", "-i", "D=4", "cmd"]), [{ name: "D", value: "4" }]);
  assert.throws(() => shellWords("echo 'open"), /unterminated/);
});

// ---------- resolving ciParity ----------

function repo(files) {
  const root = mkdtempSync(path.join(tmpdir(), "ci-parity-"));
  for (const [file, text] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    writeFileSync(path.join(root, file), text);
  }
  return root;
}
const CHERRY_PARITY = {
  workflow: ".github/workflows/test.yml",
  steps: [
    { job: "client-tests", step: "Test" },
    { job: "client-tests", step: "Acceptance (autobuild, frozen)" },
    { job: "client-tests", step: "Build" },
    { job: "db-tests", step: "Create and migrate secfix_unit" },
    { job: "db-tests", step: "Unit suite on the scratch DB" },
    { job: "db-tests", step: "Security + e2e suite (booted server)" },
    { job: "db-tests", step: "Acceptance suite (autobuild, booted server)" },
  ],
  skip: ["Install root deps", "Install client deps", "Install shared deps", "Install server deps", "Install mcp-server deps"].map((step) => ({ step, reason: "dependencies are installed locally" })),
};

test("cherry-crm's CI steps resolve exactly: commands, directories and CI-only env", () => {
  const root = repo({ ".github/workflows/test.yml": CHERRY_WORKFLOW });
  const result = resolveCiParity({ root, ciParity: CHERRY_PARITY, env: { vars: {} }, gate: [] });
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.steps.map((s) => [s.job, s.cwd, s.run.trim()]), [
    ["client-tests", "client", "npm test"],
    ["client-tests", "client", "./node_modules/.bin/vitest run --config vitest.acceptance.config.js --passWithNoTests"],
    ["client-tests", "client", "npx vite build"],
    ["db-tests", "server", "node tests/support/resetDb.js secfix_unit"],
    ["db-tests", "server", "./node_modules/.bin/vitest run"],
    ["db-tests", "server", "./node_modules/.bin/vitest run --config vitest.security.config.js"],
    ["db-tests", "server", "./node_modules/.bin/vitest run --config vitest.acceptance.config.js --passWithNoTests"],
  ]);
  const acceptance = result.steps.at(-1);
  assert.deepEqual(acceptance.env, { CI: "true", GITHUB_ACTIONS: "true", TZ: "UTC" }, "no DATABASE_URL: CI sets it only on the unit step");
  const env = parityEnv(acceptance, { HOME: "/h", PATH: "/bin", SECFIX_SUITE_DB: "secfix_p114", DB_NAME: "x", NODE_OPTIONS: "--x" }, "/p");
  assert.deepEqual(env, { HOME: "/h", PATH: "/p", CI: "true", GITHUB_ACTIONS: "true", TZ: "UTC" }, "host and run-specific variables never reach a parity step");
});

test("cherry-crm's gate config: run-specific env and the per-slice excludes are reported", () => {
  const root = repo({ ".github/workflows/test.yml": CHERRY_WORKFLOW });
  const env = { vars: { SECFIX_SUITE_DB: "secfix_p114", DB_NAME: "secfix_p114", CI: "1", ANTHROPIC_API_KEY: "" } };
  const gate = [{ name: "server unit", command: CHERRY_UNIT_GATE }, { name: "all prior server acceptance", command: CHERRY_ACCEPTANCE_GATE }];
  const declared = resolveCiParity({ root, ciParity: CHERRY_PARITY, env, gate });
  assert.deepEqual(declared.errors, [], "the parity acceptance step runs that suite with nothing excluded");
  assert.deepEqual(declared.warnings.sort(), [
    "env.vars (every gate step) sets 1 variable(s) CI never sets to an empty value: ANTHROPIC_API_KEY",
    "env.vars (every gate step) sets CI to a different value than CI",
    "env.vars (every gate step) sets DB_NAME, which CI never sets",
    "env.vars (every gate step) sets SECFIX_SUITE_DB, which CI never sets",
    'gate "server unit" sets DATABASE_URL to a different value than CI',
  ]);
  assert.ok(!declared.warnings.join("\n").includes("secfix_local"), "values (credentials) are never printed");
  const optedOut = resolveCiParity({ root, ciParityOptOut: "testing", env, gate });
  assert.match(optedOut.warnings.join("\n"), /gate "all prior server acceptance" leaves out tests\/acceptance\/p16\/\*\*, tests\/acceptance\/p114\/\*\* \(vitest in server, --config vitest.acceptance.config.js\), and no CI-parity step runs that suite with nothing left out/);
  assert.deepEqual(optedOut.errors, []);
});

test("an exclude not covered by a parity step fails when ciParity is declared", () => {
  const root = repo({ ".github/workflows/test.yml": CHERRY_WORKFLOW });
  const parity = { ...CHERRY_PARITY, steps: CHERRY_PARITY.steps.filter((s) => !s.step.startsWith("Acceptance suite")), skip: [...CHERRY_PARITY.skip, { step: "Acceptance suite (autobuild, booted server)", reason: "test" }] };
  const result = resolveCiParity({ root, ciParity: parity, env: { vars: {} }, gate: [{ name: "all prior server acceptance", command: CHERRY_ACCEPTANCE_GATE }] });
  assert.equal(result.errors.length, 1);
  assert.match(result.errors[0], /leaves out .* no CI-parity step runs that suite with nothing left out/);
});

test("ciParity is required when a workflow exists, and every CI run step must be run or skipped with a reason", () => {
  const root = repo({ ".github/workflows/test.yml": CHERRY_WORKFLOW });
  const base = { root, env: { vars: {} }, gate: [] };
  assert.match(resolveCiParity(base).errors[0], /CI configuration \.github\/workflows\/test\.yml found, but autobuild\.json declares no ciParity: a green gate could still mean a red CI/);
  assert.deepEqual(resolveCiParity({ ...base, ciParityOptOut: "reason" }).errors, []);
  assert.deepEqual(resolveCiParity({ root: repo({}), env: { vars: {} }, gate: [] }).errors, [], "no workflow, nothing required");
  const missing = resolveCiParity({ ...base, ciParity: { ...CHERRY_PARITY, skip: CHERRY_PARITY.skip.slice(1) } });
  assert.ok(missing.errors.includes("CI step client-tests / Install root deps is neither run by ciParity nor listed in ciParity.skip with a reason"));
  const stale = resolveCiParity({ ...base, ciParity: { ...CHERRY_PARITY, skip: [...CHERRY_PARITY.skip, { step: "Gone", reason: "x" }] } });
  assert.ok(stale.errors.includes("ciParity.skip Gone matches no run step in .github/workflows/test.yml"));
});

test("declared steps must exist, be run steps, keep CI's order, and be runnable exactly", () => {
  const workflow = [
    "jobs:",
    "  a:",
    "    steps:",
    "      - uses: actions/checkout@v4",
    "        name: Checkout",
    "      - name: One",
    "        run: echo one",
    "      - name: Two",
    "        run: echo ${{ github.sha }}",
    "      - name: Three",
    "        if: always()",
    "        run: echo three",
    "      - name: Four",
    "        run: echo four",
    "  m:",
    "    strategy:",
    "      matrix: {node: [20, 22]}",
    "    steps:",
    "      - name: Matrix",
    "        run: echo m",
  ].join("\n");
  const root = repo({ ".github/workflows/ci.yml": workflow });
  const errors = resolveCiParity({ root, env: { vars: {} }, gate: [], ciParity: { workflow: ".github/workflows/ci.yml", steps: [
    { job: "a", step: "Four" }, { job: "a", step: "One" }, { job: "a", step: "Two" }, { job: "a", step: "Three" },
    { job: "a", step: "Checkout" }, { job: "a", step: "Nope" }, { job: "m", step: "Matrix" },
  ] } }).errors;
  assert.ok(errors.includes("ciParity step a / One is listed after a / Four, which CI runs later; keep CI's order"), errors.join("\n"));
  assert.ok(errors.includes("ciParity step a / Two uses a ${{ }} expression; skip it with a reason instead"));
  assert.ok(errors.includes("ciParity step a / Three has an if: condition; skip it with a reason instead"));
  assert.ok(errors.includes("ciParity step a / Checkout: is not a run step"));
  assert.ok(errors.includes("ciParity step a / Nope: not found in .github/workflows/ci.yml"));
  assert.ok(errors.includes("ciParity step m / Matrix its job uses a strategy/matrix; skip it with a reason instead"));
});

// ---------- end to end: the P114-03 pattern ----------

// The test's helpers write its login token to the suite database named by
// SUITE_DB (default suite_test); the server it boots always reads the p114
// database. The gate's env.vars sets SUITE_DB=p114, so the gate passes; CI sets
// nothing, so the server sees no token: 401.
const P114_FILES = {
  ".github/workflows/test.yml": [
    "name: Tests",
    "on:",
    "  pull_request:",
    "    branches: [main]",
    "jobs:",
    "  db-tests:",
    "    runs-on: ubuntu-latest",
    "    steps:",
    "      - uses: actions/checkout@v4",
    "      - name: Install server deps",
    "        working-directory: server",
    "        run: npm ci",
    "      - name: Acceptance suite (booted server)",
    "        working-directory: server",
    "        run: node --test tests/acceptance/lifecycle.test.mjs",
    "",
  ].join("\n"),
  "server/tests/support/db.mjs": "import { mkdirSync, writeFileSync } from 'node:fs'\nexport const suiteDb = () => process.env.SUITE_DB ?? 'suite_test'\nexport function saveToken(db, token) { mkdirSync('.db', { recursive: true }); writeFileSync(`.db/${db}.json`, JSON.stringify({ token })) }\n",
  "server/src/server.mjs": "import { existsSync, readFileSync } from 'node:fs'\nconst DB = 'p114'\nexport function login(token) {\n  const file = `.db/${DB}.json`\n  return existsSync(file) && JSON.parse(readFileSync(file, 'utf8')).token === token ? 200 : 401\n}\n",
  "server/tests/acceptance/lifecycle.test.mjs": "import { test } from 'node:test'\nimport assert from 'node:assert/strict'\nimport { randomUUID } from 'node:crypto'\nimport { saveToken, suiteDb } from '../support/db.mjs'\nimport { login } from '../../src/server.mjs'\ntest('the booted server accepts the token the helpers minted', () => {\n  const token = randomUUID()\n  saveToken(suiteDb(), token)\n  assert.equal(login(token), 200)\n})\n",
  "features.json": JSON.stringify({ features: [] }),
  ".gitignore": "/logs/\n/.harness/\n.db/\n",
};
function p114Repo(parity = true) {
  const root = repo({ ...P114_FILES, "autobuild.json": JSON.stringify({
    branch: "autobuild", hooks: "inject", frozen: [],
    env: { vars: { SUITE_DB: "p114" } },
    gate: [{ name: "prior server acceptance (gate env)", command: "cd server && node --test tests/acceptance/lifecycle.test.mjs" }],
    ...(parity ? { ciParity: { workflow: ".github/workflows/test.yml", steps: [{ job: "db-tests", step: "Acceptance suite (booted server)" }], skip: [{ step: "Install server deps", reason: "dependencies are installed locally" }] } } : {}),
  }) });
  const git = (...args) => execFileSync("git", args, { cwd: root, stdio: "ignore" });
  git("init", "-q", "-b", "autobuild");
  git("-c", "user.email=t@t", "-c", "user.name=t", "add", "-A");
  git("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "fixture");
  return root;
}
function check(root) {
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT; // a nested node --test must report to its own process, not to this runner
  delete env.SUITE_DB;
  const r = spawnSync(process.execPath, [CLI, "check", "--phase", "full"], { cwd: root, env, encoding: "utf8", timeout: 120_000 });
  return { code: r.status, out: `${r.stdout}${r.stderr}` };
}

test("a test that passes under the gate's env and fails under CI's env fails the full gate", () => {
  const root = p114Repo();
  const r = check(root);
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /PASS {2}prior server acceptance \(gate env\)/, "the run-specific gate passes");
  assert.match(r.out, /PASS {2}CI parity configuration/);
  assert.match(r.out, /FAIL {2}CI parity: db-tests \/ Acceptance suite \(booted server\)/, "CI's own command, in CI's env, fails");
  assert.match(r.out, /401/);
  assert.match(r.out, /WARN {2}env\.vars \(every gate step\) sets SUITE_DB, which CI never sets/);
  assert.match(r.out, /GATE: FAIL/);
  // The P114-03 fix: the test points its helpers at the database its server uses.
  const testFile = path.join(root, "server/tests/acceptance/lifecycle.test.mjs");
  writeFileSync(testFile, readFileSync(testFile, "utf8").replace("saveToken(suiteDb(), token)", "saveToken('p114', token)"));
  const fixed = check(root);
  assert.equal(fixed.code, 0, fixed.out);
  assert.match(fixed.out, /PASS {2}CI parity: db-tests \/ Acceptance suite \(booted server\)/);
});

test("without ciParity a repo with a CI workflow fails the full gate until it opts out with a reason", () => {
  const root = p114Repo(false);
  const r = check(root);
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /FAIL {2}CI parity configuration/);
  assert.match(r.out, /declares no ciParity/);
  const file = path.join(root, "autobuild.json");
  writeFileSync(file, JSON.stringify({ ...JSON.parse(readFileSync(file, "utf8")), ciParityOptOut: "CI runs this gate itself" }));
  const optedOut = check(root);
  assert.equal(optedOut.code, 0, optedOut.out);
  assert.match(optedOut.out, /WARN {2}CI parity opted out: CI runs this gate itself/);
});

test("malformed ciParity settings are refused when the config loads", () => {
  for (const [patch, why] of [
    [{ ciParity: { workflow: "ci.yml", steps: [{ job: "a", step: "b" }] } }, /must be a file under \.github\/workflows/],
    [{ ciParity: { workflow: ".github/workflows/../x.yml", steps: [{ job: "a", step: "b" }] } }, /must be a file under/],
    [{ ciParity: { workflow: ".github/workflows/t.yml", steps: [] } }, /non-empty array/],
    [{ ciParity: { workflow: ".github/workflows/t.yml", steps: [{ job: "a", step: "b" }], skip: [{ step: "x" }] } }, /skip must be/],
    [{ ciParity: { workflow: ".github/workflows/t.yml", steps: [{ job: "a", step: "b" }], lockFile: "rel.lock" } }, /absolute path/],
    [{ ciParity: { workflow: ".github/workflows/t.yml", steps: [{ job: "a", step: "b" }], extra: 1 } }, /unknown keys: extra/],
    [{ ciParityOptOut: " " }, /non-empty reason/],
    [{ ciParityOptOut: "x", ciParity: { workflow: ".github/workflows/t.yml", steps: [{ job: "a", step: "b" }] } }, /either ciParity or ciParityOptOut/],
  ]) {
    const root = p114Repo(false);
    const file = path.join(root, "autobuild.json");
    writeFileSync(file, JSON.stringify({ ...JSON.parse(readFileSync(file, "utf8")), ...patch }));
    const r = check(root);
    assert.notEqual(r.code, 0, JSON.stringify(patch));
    assert.match(r.out, why, JSON.stringify(patch));
  }
});

// ---------- agnostic: other CI systems and test runners ----------

const GITLAB_CI = [
  "stages: [test]",
  "api-tests:",
  "  stage: test",
  "  services: [postgres:16]",
  "  variables:",
  "    DATABASE_URL: postgres://ci@postgres/ci_test",
  "  script:",
  "    - pip install -r requirements.txt",
  "    - cd api && pytest -c pytest.ini",
  "web-tests:",
  "  script:",
  "    - cd web && npx jest --config jest.config.js",
  "",
].join("\n");
const GITLAB_PARITY = {
  ciFile: ".gitlab-ci.yml",
  env: { CI: "true", GITLAB_CI: "true" },
  steps: [
    { name: "api tests", run: "cd api && pytest -c pytest.ini", env: { DATABASE_URL: "postgres://ci@localhost/ci_test" } },
    { name: "web tests", run: "cd web && npx jest --config jest.config.js" },
  ],
};

test("any CI: declared commands must appear verbatim in the CI file, and run with only the declared env", () => {
  const root = repo({ ".gitlab-ci.yml": GITLAB_CI });
  const ok = resolveCiParity({ root, ciParity: GITLAB_PARITY, env: { vars: {} }, gate: [] });
  assert.deepEqual(ok.errors, []);
  assert.deepEqual(ok.steps.map((s) => [s.label, s.cwd, s.run]), [["api tests", ".", "cd api && pytest -c pytest.ini"], ["web tests", ".", "cd web && npx jest --config jest.config.js"]]);
  assert.deepEqual(parityEnv(ok.steps[0], { HOME: "/h", PATH: "/bin", SECRET: "x" }), { HOME: "/h", PATH: "/bin", CI: "true", GITLAB_CI: "true", DATABASE_URL: "postgres://ci@localhost/ci_test" });
  const drifted = resolveCiParity({ root, ciParity: { ...GITLAB_PARITY, steps: [{ name: "api tests", run: "cd api && pytest" }] }, env: { vars: {} }, gate: [] });
  assert.deepEqual(drifted.errors, ["ciParity step api tests: its command does not appear verbatim in .gitlab-ci.yml; update one to match the other"]);
  const missing = resolveCiParity({ root, ciParity: { ...GITLAB_PARITY, ciFile: "ci/none.yml" }, env: { vars: {} }, gate: [] });
  assert.deepEqual(missing.errors, ["ciParity.ciFile ci/none.yml: not found"]);
});

test("ciParity is required for any recognised CI system, not only GitHub Actions", () => {
  for (const file of [".gitlab-ci.yml", ".circleci/config.yml", "azure-pipelines.yml", "bitbucket-pipelines.yml", "Jenkinsfile", ".buildkite/pipeline.yml", ".travis.yml"]) {
    const errors = resolveCiParity({ root: repo({ [file]: "x" }), env: { vars: {} }, gate: [] }).errors;
    assert.equal(errors.length, 1, file);
    assert.ok(errors[0].startsWith(`CI configuration ${file} found`), errors[0]);
  }
});

test("left-out tests are recognised across runners: pytest, jest, mocha, go test", () => {
  const root = repo({ ".gitlab-ci.yml": GITLAB_CI });
  const gate = [
    { name: "api fast", command: "cd api && pytest -c pytest.ini --ignore=tests/slow --deselect tests/test_a.py::test_b" },
    { name: "web fast", command: "cd web && npx jest --config jest.config.js --testPathIgnorePatterns e2e" },
    { name: "other suite", command: "cd api && pytest -c other.ini --ignore=tests/slow" },
    { name: "go", command: "go test ./... -skip TestSlow" },
  ];
  const errors = resolveCiParity({ root, ciParity: GITLAB_PARITY, env: { vars: {} }, gate }).errors;
  assert.deepEqual(errors, [
    'gate "other suite" leaves out tests/slow (pytest in api, -c other.ini), and no CI-parity step runs that suite with nothing left out',
    'gate "go" leaves out TestSlow (go in .), and no CI-parity step runs that suite with nothing left out',
  ], "api fast and web fast are covered by the parity steps for the same tool, directory and config");
  const custom = resolveCiParity({ root, ciParity: { ...GITLAB_PARITY, excludeFlags: ["--grep-invert"] }, env: { vars: {} }, gate: [{ name: "mocha", command: "mocha --grep-invert slow" }, ...gate] }).errors;
  assert.deepEqual(custom, ['gate "mocha" leaves out slow (mocha in .), and no CI-parity step runs that suite with nothing left out'], "a configured list replaces the defaults");
});

test("toolOf names the runner behind assignments and wrappers", () => {
  assert.equal(toolOf(["./node_modules/.bin/vitest", "run"]), "vitest");
  assert.equal(toolOf(["npx", "jest", "--ci"]), "jest");
  assert.equal(toolOf(["env", "-u", "DB_NAME", "DATABASE_URL=x", "SCRATCH=1", "./node_modules/.bin/vitest", "run"]), "vitest");
  assert.equal(toolOf(["A=1", "time", "pytest"]), "pytest");
  assert.equal(toolOf(["A=1"]), null);
});

test("malformed settings for other CI systems are refused when the config loads", () => {
  for (const [patch, why] of [
    [{ ciParity: { ciFile: ".gitlab-ci.yml", workflow: ".github/workflows/t.yml", steps: [{ name: "a", run: "b" }] } }, /exactly one of workflow/],
    [{ ciParity: { steps: [{ name: "a", run: "b" }] } }, /exactly one of workflow/],
    [{ ciParity: { ciFile: "../ci.yml", steps: [{ name: "a", run: "b" }] } }, /inside the repository/],
    [{ ciParity: { ciFile: ".gitlab-ci.yml", steps: [{ name: "a" }] } }, /"name", "run"/],
    [{ ciParity: { ciFile: ".gitlab-ci.yml", steps: [{ name: "a", run: "b", cwd: "../x" }] } }, /"name", "run"/],
    [{ ciParity: { ciFile: ".gitlab-ci.yml", steps: [{ name: "a", run: "b", env: { A: 1 } }] } }, /"name", "run"/],
    [{ ciParity: { ciFile: ".gitlab-ci.yml", steps: [{ name: "a", run: "b" }], env: [] } }, /env must map names to strings/],
    [{ ciParity: { ciFile: ".gitlab-ci.yml", steps: [{ name: "a", run: "b" }], skip: [] } }, /unknown keys: skip/],
    [{ ciParity: { ciFile: ".gitlab-ci.yml", steps: [{ name: "a", run: "b" }], excludeFlags: ["exclude"] } }, /array of option names/],
  ]) {
    const root = p114Repo(false);
    const file = path.join(root, "autobuild.json");
    writeFileSync(file, JSON.stringify({ ...JSON.parse(readFileSync(file, "utf8")), ...patch }));
    const r = check(root);
    assert.notEqual(r.code, 0, JSON.stringify(patch));
    assert.match(r.out, why, JSON.stringify(patch));
  }
});

test("appearsAsCommand matches whole commands in common CI file shapes, never a prefix", () => {
  const ci = ["script:", "  - cd api && pytest -c pytest.ini", "  - 'npm test'", "steps:", "  - command: make ci", "run: |", "  npm ci", "  npm test -- --ci"].join("\n");
  assert.ok(appearsAsCommand(ci, "cd api && pytest -c pytest.ini"));
  assert.ok(appearsAsCommand(ci, "npm test"), "quoted list item");
  assert.ok(appearsAsCommand(ci, "make ci"), "key: value");
  assert.ok(appearsAsCommand(ci, "npm ci\nnpm test -- --ci"), "multi-line block");
  assert.ok(!appearsAsCommand(ci, "cd api && pytest"), "a prefix of a longer command");
  assert.ok(!appearsAsCommand(ci, "pytest -c pytest.ini"), "a suffix");
  assert.ok(!appearsAsCommand(ci, "npm ci\nnpm test"), "a block whose last line differs");
});

test("unnamed run steps are addressed by their position in the job", () => {
  const workflow = ["jobs:", "  ci:", "    steps:", "      - uses: actions/checkout@v4", "      - run: npm ci", "      - run: npm test", ""].join("\n");
  const root = repo({ ".github/workflows/ci.yml": workflow });
  const base = { root, env: { vars: {} }, gate: [] };
  const unlisted = resolveCiParity({ ...base, ciParity: { workflow: ".github/workflows/ci.yml", steps: [{ job: "ci", step: "#3" }] } });
  assert.deepEqual(unlisted.errors, ['CI step ci / #2 is neither run by ciParity nor listed in ciParity.skip with a reason (address it as "#2", or give it a name: in the workflow)']);
  const ok = resolveCiParity({ ...base, ciParity: { workflow: ".github/workflows/ci.yml", steps: [{ job: "ci", step: "#3" }], skip: [{ job: "ci", step: "#2", reason: "installed locally" }] } });
  assert.deepEqual(ok.errors, []);
  assert.deepEqual(ok.steps.map((s) => [s.label, s.run]), [["ci / #3", "npm test"]]);
  const usesStep = resolveCiParity({ ...base, ciParity: { workflow: ".github/workflows/ci.yml", steps: [{ job: "ci", step: "#1" }], skip: [{ step: "#2", reason: "x" }, { step: "#3", reason: "x" }] } });
  assert.deepEqual(usesStep.errors, ["ciParity step ci / #1: is not a run step"]);
});

test("each GitHub step runs with GitHub's shell: bash -e by default, pipefail only for shell: bash", () => {
  const workflow = ["jobs:", "  ci:", "    steps:", "      - name: default shell", "        run: false | true", "      - name: explicit bash", "        shell: bash", "        run: false | true", ""].join("\n");
  const root = repo({ ".github/workflows/ci.yml": workflow });
  const config = { root, env: { vars: {} }, gate: [], ciParity: { workflow: ".github/workflows/ci.yml", steps: [{ job: "ci", step: "default shell" }, { job: "ci", step: "explicit bash" }] } };
  const { steps, errors } = resolveCiParity(config);
  assert.deepEqual(errors, []);
  assert.deepEqual(steps.map((s) => s.shellArgs), [["bash", "-e"], ["bash", "--noprofile", "--norc", "-eo", "pipefail"]]);
  assert.equal(runParityStep(config, steps[0]).ok, true, "GitHub's default shell has no pipefail, so CI passes this step");
  assert.equal(runParityStep(config, steps[1]).ok, false, "shell: bash sets pipefail, so CI fails this step");
});

test("a timed-out parity step leaves no process behind and releases its lock", () => {
  const root = repo({});
  const lockFile = path.join(root, "parity.lock");
  const marker = `parity-orphan-${process.pid}-${Date.now()}`;
  const step = { label: "slow", run: `sleep 30 # ${marker}`, cwd: ".", env: {}, shellArgs: ["bash", "-e"] };
  for (const config of [{ root, ciParity: { lockFile } }, { root, ciParity: {} }]) {
    const started = Date.now();
    const result = runParityStep(config, step, { timeoutSeconds: 1, lockWaitSeconds: 5 });
    assert.equal(result.ok, false);
    assert.equal(result.status, 124);
    assert.match(result.output, /timed out after \d+s.*; its process group was killed/);
    assert.ok(Date.now() - started < 10_000, "the step ends at its own timeout");
    const left = spawnSync("pgrep", ["-f", marker], { encoding: "utf8" });
    assert.equal(left.stdout.trim(), "", "no process of the step survives");
  }
  assert.equal(spawnSync("flock", ["-n", lockFile, "true"]).status, 0, "the lock is free again");
});

test("waiting for a busy lock is bounded and reported, not charged to the step", () => {
  const root = repo({});
  const lockFile = path.join(root, "busy.lock");
  const holder = spawn("flock", [lockFile, "sleep", "10"], { stdio: "ignore" });
  const until = Date.now() + 3000;
  while (spawnSync("flock", ["-n", lockFile, "true"]).status === 0) {
    assert.ok(Date.now() < until, "the holder took the lock");
    spawnSync("sleep", ["0.05"]);
  }
  const result = runParityStep({ root, ciParity: { lockFile } }, { label: "quick", run: "true", cwd: ".", env: {}, shellArgs: ["bash", "-e"] }, { timeoutSeconds: 1, lockWaitSeconds: 1 });
  assert.equal(result.ok, false);
  assert.equal(result.status, 75);
  assert.match(result.output, /stayed busy for 1s/);
  holder.kill();
});

test("a terminal Ctrl-C during a parity step stops the step and the gate promptly", async () => {
  const dir = repo({});
  const marker = `parity-ctrl-c-${process.pid}-${Date.now()}`;
  const script = path.join(dir, "run-step.mjs");
  writeFileSync(script, `import { runParityStep } from ${JSON.stringify(new URL("../lib/ci-parity.mjs", import.meta.url).href)};
process.on("SIGINT", () => process.exit(130));
runParityStep({ root: process.env.ROOT, ciParity: { lockFile: process.env.LOCK } }, { label: "slow", run: "sleep 30 # " + process.env.MARKER, cwd: ".", env: {}, shellArgs: ["bash", "-e"] }, { timeoutSeconds: 30, lockWaitSeconds: 5 });
await new Promise((resolve) => setTimeout(resolve, 200)); // the loop's next turn, where its SIGINT handler runs
process.exit(0);
`);
  const lock = path.join(dir, "ctrl-c.lock");
  // detached: the child leads its own process group, like a terminal's foreground job.
  const child = spawn(process.execPath, [script], { env: { ...process.env, ROOT: dir, MARKER: marker, LOCK: lock }, detached: true, stdio: "ignore" });
  const exited = new Promise((resolve) => child.on("exit", (code) => resolve(code)));
  const until = Date.now() + 10_000;
  while (!spawnSync("pgrep", ["-f", marker], { encoding: "utf8" }).stdout.trim()) {
    assert.ok(Date.now() < until, "the step started");
    spawnSync("sleep", ["0.05"]);
  }
  const started = Date.now();
  process.kill(-child.pid, "SIGINT"); // what Ctrl-C does: the whole foreground group
  assert.equal(await exited, 130);
  assert.ok(Date.now() - started < 5000, "the gate stops without waiting for the step");
  assert.equal(spawnSync("pgrep", ["-f", marker], { encoding: "utf8" }).stdout.trim(), "", "no process of the step survives");
  assert.equal(spawnSync("flock", ["-n", lock, "true"]).status, 0, "the lock is free");
});

test("the Stop hook's gate defers CI parity; autobuild check still runs it", async () => {
  const { runGate } = await import("../lib/gate.mjs");
  const { loadConfig } = await import("../lib/config.mjs");
  const root = p114Repo();
  const config = loadConfig(root, {});
  const hook = runGate(config, { phase: "full", ciParity: false });
  assert.ok(!hook.steps.some((step) => step.name.startsWith("CI parity")), "no parity step runs in the hook");
  assert.deepEqual(hook.deferred, [{ kind: "ci-parity", name: "CI parity", reason: "runs in the loop's final full gate and autobuild check" }]);
  const full = runGate(config, { phase: "full" });
  assert.ok(full.steps.some((step) => step.name === "CI parity: db-tests / Acceptance suite (booted server)"));
  const hookSource = readFileSync(new URL("../hooks/stop-gate.mjs", import.meta.url), "utf8");
  assert.match(hookSource, /runGate\([^)]*ciParity: false/, "the Stop hook asks for the gate without parity");
});

