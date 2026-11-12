// CI parity: the full gate also runs the repo's CI test steps the way CI runs
// them, so a green gate cannot hide a red CI. Two providers, chosen by the
// shape of `ciParity` in autobuild.json:
// - GitHub Actions (`workflow`): the named steps' run, working directory and
//   env are read from the workflow file at gate time, never copied.
// - Any other CI (`ciFile`): the steps' commands are declared, and each must
//   appear verbatim in that CI file, so a change on either side is caught.
// A step runs with CI's environment only, plus the few host variables a process
// needs to start. autobuild.json `env.vars` never applies.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { parseWorkflowYaml } from "./workflow-yaml.mjs";
import { assignments, optionValues, simpleCommands } from "./shell-words.mjs";
import { WORKFLOW_DIR } from "./config.mjs";
import { runSpec } from "./proc.mjs";

// Set for every step on a GitHub-hosted runner.
const GITHUB_RUNNER_ENV = Object.freeze({ CI: "true", GITHUB_ACTIONS: "true", TZ: "UTC" });
// What a local process needs to start; nothing that changes what a test does.
const HOST_ENV = ["HOME", "USER", "LOGNAME", "SHELL", "TMPDIR", "TERM", "LANG"];
const EXPRESSION = /\$\{\{/;
const STEP_TIMEOUT_S = 40 * 60;
const LOCK_WAIT_S = 60 * 60;
const LOCK_BUSY = 75;   // flock -E: the lock stayed busy for LOCK_WAIT_S
const TIMED_OUT = 124;  // timeout(1): the step ran past STEP_TIMEOUT_S
// Stays in the gate's foreground process group, so a terminal Ctrl-C reaches it,
// and stops timeout(1)'s group (which the terminal's signal does not reach).
const WRAPPER = 'limit=$1; shift; pid=; trap \'[ -n "$pid" ] && kill -TERM -- "-$pid" 2>/dev/null; [ -n "$pid" ] && wait "$pid"; exit 130\' INT TERM; timeout -k 30 "$limit" "$@" & pid=$!; wait "$pid"';
// CI configuration files whose presence makes ciParity (or an opt-out) required.
const CI_FILES = [".gitlab-ci.yml", ".circleci/config.yml", "azure-pipelines.yml", "bitbucket-pipelines.yml",
  "Jenkinsfile", ".buildkite/pipeline.yml", ".travis.yml", ".drone.yml", ".woodpecker.yml"];
// Options that leave tests out, and options that pick which suite runs, across
// common runners (vitest, jest, pytest, mocha, go test). ciParity can replace either list.
export const EXCLUDE_FLAGS = ["--exclude", "--ignore", "--ignore-glob", "--testPathIgnorePatterns", "--deselect", "--skip", "-skip"];
export const SUITE_FLAGS = ["--config", "-c", "--project", "--selectProjects", "--rootdir"];
// Words that run the real tool rather than being it.
const WRAPPERS = new Set(["env", "exec", "time", "nice", "npx", "bunx", "builtin", "command"]);

export function workflowFiles(root) {
  const dir = path.join(root, WORKFLOW_DIR);
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((name) => /\.ya?ml$/.test(name)).sort().map((name) => `${WORKFLOW_DIR}/${name}`);
}

/** Every CI configuration file in the repo that ciParity is expected to cover. */
export function ciFiles(root) {
  return [...workflowFiles(root), ...CI_FILES.filter((file) => existsSync(path.join(root, file)))];
}

// ---------- GitHub Actions ----------

function readWorkflow(root, file) {
  const doc = parseWorkflowYaml(readFileSync(path.join(root, file), "utf8"));
  if (!doc || typeof doc.jobs !== "object" || Array.isArray(doc.jobs) || !doc.jobs) throw new Error(`${file} has no jobs`);
  return doc;
}

const envOf = (value) => (value && typeof value === "object" && !Array.isArray(value) ? value : {});

// Every `run` step of a workflow, with its resolved directory and CI environment.
function workflowRunSteps(doc) {
  const steps = [];
  for (const [jobId, job] of Object.entries(doc.jobs)) {
    (Array.isArray(job?.steps) ? job.steps : []).forEach((step, index) => {
      if (!step || typeof step.run !== "string") return;
      const cwd = step["working-directory"] ?? job.defaults?.run?.["working-directory"] ?? doc.defaults?.run?.["working-directory"] ?? ".";
      const env = { ...GITHUB_RUNNER_ENV, ...envOf(doc.env), ...envOf(job.env), ...envOf(step.env) };
      const label = `${jobId} / ${step.name ?? `#${index + 1}`}`;
      // GitHub runs a step with no shell: as `bash -e {0}`, and `shell: bash` as
      // `bash --noprofile --norc -eo pipefail {0}`.
      const shell = step.shell ?? job.defaults?.run?.shell ?? doc.defaults?.run?.shell;
      const shellArgs = shell === "bash" ? ["bash", "--noprofile", "--norc", "-eo", "pipefail"] : ["bash", "-e"];
      steps.push({ job: jobId, step: step.name ?? null, index, label, run: step.run, cwd, env, shellArgs, raw: step, jobRaw: job, doc });
    });
  }
  return steps;
}

// Why a declared step cannot be run exactly, or null.
function unsupported(s) {
  const shell = s.raw.shell ?? s.jobRaw.defaults?.run?.shell ?? s.doc.defaults?.run?.shell;
  if (shell !== undefined && shell !== "bash") return `uses shell ${shell}; only the default shell and bash run exactly`;
  if (s.raw.if !== undefined) return "has an if: condition";
  if (s.raw["continue-on-error"] !== undefined) return "has continue-on-error";
  if (s.jobRaw.strategy !== undefined) return "its job uses a strategy/matrix";
  if (s.jobRaw.container !== undefined) return "its job runs in a container";
  const fields = [s.run, s.cwd, ...Object.values(s.env)];
  if (fields.some((v) => typeof v !== "string")) return "has a non-text env value or directory";
  if (fields.some((v) => EXPRESSION.test(v))) return "uses a ${{ }} expression";
  return null;
}

// A step is addressed by its name, or by "#N", its 1-based position in the job (for unnamed steps).
const addressed = (entry, s) => entry.step === s.step || entry.step === `#${s.index + 1}`;
const matches = (entry, s) => addressed(entry, s) && (entry.job === undefined || entry.job === s.job);

function resolveWorkflow(config, parity, errors) {
  let doc;
  try {
    if (!existsSync(path.join(config.root, parity.workflow))) throw new Error("not found");
    doc = readWorkflow(config.root, parity.workflow);
  } catch (error) {
    errors.push(`ciParity.workflow ${parity.workflow}: ${error.message}`);
    return { steps: [], file: parity.workflow };
  }
  const ciSteps = workflowRunSteps(doc);
  const steps = [];
  const lastSeen = new Map();
  for (const entry of parity.steps) {
    const found = ciSteps.filter((s) => s.job === entry.job && addressed(entry, s));
    if (found.length !== 1) {
      const anyStep = Array.isArray(doc.jobs[entry.job]?.steps) && doc.jobs[entry.job].steps.some((s, i) => s?.name === entry.step || entry.step === `#${i + 1}`);
      errors.push(`ciParity step ${entry.job} / ${entry.step}: ${found.length > 1 ? "more than one run step has that name" : anyStep ? "is not a run step" : `not found in ${parity.workflow}`}`);
      continue;
    }
    const s = found[0];
    const why = unsupported(s);
    if (why) { errors.push(`ciParity step ${s.label} ${why}; skip it with a reason instead`); continue; }
    const previous = lastSeen.get(s.job);
    if (previous && previous.index > s.index) errors.push(`ciParity step ${s.label} is listed after ${previous.label}, which CI runs later; keep CI's order`);
    else lastSeen.set(s.job, s);
    steps.push(s);
  }
  const skip = parity.skip ?? [];
  for (const s of ciSteps) {
    if (parity.steps.some((e) => e.job === s.job && addressed(e, s)) || skip.some((e) => matches(e, s))) continue;
    errors.push(`CI step ${s.label} is neither run by ciParity nor listed in ciParity.skip with a reason${s.step === null ? ` (address it as "#${s.index + 1}", or give it a name: in the workflow)` : ""}`);
  }
  for (const entry of skip) {
    if (!ciSteps.some((s) => matches(entry, s))) errors.push(`ciParity.skip ${entry.job ? `${entry.job} / ` : ""}${entry.step} matches no run step in ${parity.workflow}`);
  }
  return { steps, file: parity.workflow, all: ciSteps };
}

// ---------- any other CI: declared commands, checked against the CI file ----------

// The text a CI file line gives as a command: without indentation, a "- " list
// marker, a "key: " prefix and surrounding quotes. Several readings are tried.
function lineReadings(line) {
  const out = new Set();
  const add = (t) => {
    t = t.trim();
    if (!t) return;
    out.add(t);
    const quoted = /^(['"])(.*)\1$/.exec(t);
    if (quoted) out.add(quoted[2]);
  };
  let t = line.trim();
  add(t);
  if (t.startsWith("- ")) { t = t.slice(2); add(t); }
  const keyed = /^[\w.-]+:\s+(.*)$/.exec(t);
  if (keyed) add(keyed[1]);
  return out;
}

/** True when `command` is a whole command in the CI file, not just part of a longer one. */
export function appearsAsCommand(fileText, command) {
  const lines = fileText.split(/\r?\n/);
  const want = command.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (want.length === 1) return lines.some((line) => lineReadings(line).has(want[0]));
  for (let i = 0; i + want.length <= lines.length; i++) {
    if (want.every((w, k) => lines[i + k].trim() === w || (k === 0 && lineReadings(lines[i]).has(w)))) return true;
  }
  return false;
}

function resolveCommands(config, parity, errors) {
  let text;
  try { text = readFileSync(path.join(config.root, parity.ciFile), "utf8"); } catch {
    errors.push(`ciParity.ciFile ${parity.ciFile}: not found`);
    return { steps: [], file: parity.ciFile };
  }
  // Most CI systems run scripts in bash with errexit and pipefail.
  const steps = parity.steps.map((entry) => ({ label: entry.name, run: entry.run, cwd: entry.cwd ?? ".", env: { ...(parity.env ?? {}), ...(entry.env ?? {}) }, shellArgs: ["bash", "-eo", "pipefail"] }));
  for (const s of steps) {
    if (!appearsAsCommand(text, s.run)) errors.push(`ciParity step ${s.label}: its command does not appear verbatim in ${parity.ciFile}; update one to match the other`);
  }
  return { steps, file: parity.ciFile };
}

// ---------- checks ----------

/**
 * Resolves `ciParity` and compares the gate with CI. Returns { steps, errors,
 * warnings }; errors fail the full gate.
 */
export function resolveCiParity(config) {
  const errors = [], warnings = [];
  const found = ciFiles(config.root);
  const parity = config.ciParity;
  let resolved = { steps: [] };
  if (!parity) {
    if (found.length && !config.ciParityOptOut) {
      errors.push(`CI configuration ${found.join(", ")} found, but autobuild.json declares no ciParity: a green gate could still mean a red CI. Declare ciParity, or set ciParityOptOut to the reason.`);
    } else if (config.ciParityOptOut) {
      warnings.push(`CI parity opted out: ${config.ciParityOptOut}`);
    }
  } else {
    resolved = parity.workflow ? resolveWorkflow(config, parity, errors) : resolveCommands(config, parity, errors);
    for (const s of resolved.steps) {
      if (path.isAbsolute(s.cwd) || path.posix.normalize(s.cwd).split("/")[0] === "..") errors.push(`ciParity step ${s.label}: its working directory leaves the repository`);
    }
    for (const file of found.filter((f) => f !== resolved.file)) warnings.push(`${file} is not checked by ciParity`);
  }
  // Without declared steps, GitHub workflows still say what CI sets.
  let ciEnvSteps = resolved.steps;
  if (!parity) {
    for (const file of workflowFiles(config.root)) {
      try { ciEnvSteps = ciEnvSteps.concat(workflowRunSteps(readWorkflow(config.root, file))); } catch (error) { warnings.push(`${file}: ${error.message}; not compared with the gate`); }
    }
  }
  warnings.push(...envWarnings(config, ciEnvSteps));
  for (const problem of uncoveredExcludes(config, resolved.steps, parity)) (parity ? errors : warnings).push(problem);
  return { steps: resolved.steps, errors, warnings };
}

// Variables the gate sets that CI does not, or sets differently. Values are
// never printed: they may be credentials.
function envWarnings(config, ciSteps) {
  const ci = new Map();
  for (const s of ciSteps) for (const [k, v] of Object.entries(s.env)) ci.set(k, new Set([...(ci.get(k) ?? []), String(v)]));
  const check = (name, value, where) => {
    const values = ci.get(name);
    if (!values) return `${where} sets ${name}, which CI never sets`;
    if (!values.has(String(value))) return `${where} sets ${name} to a different value than CI`;
    return null;
  };
  const out = [];
  // Blanking a variable CI never sets (often a secret) is listed once, by name.
  const blanked = [];
  for (const [name, value] of Object.entries(config.env?.vars ?? {})) {
    if (value === "" && !ci.has(name)) { blanked.push(name); continue; }
    const problem = check(name, value, "env.vars (every gate step)");
    if (problem) out.push(problem);
  }
  if (blanked.length) out.push(`env.vars (every gate step) sets ${blanked.length} variable(s) CI never sets to an empty value: ${blanked.join(", ")}`);
  for (const step of config.gate ?? []) {
    let commands;
    try { commands = simpleCommands(step.command); } catch { out.push(`gate "${step.name}": its command could not be split into words; not compared with CI`); continue; }
    for (const command of commands) {
      for (const { name, value } of assignments(command.words)) {
        const problem = check(name, value, `gate "${step.name}"`);
        if (problem) out.push(problem);
      }
    }
  }
  return [...new Set(out)];
}

/** The test tool a simple command runs: the first word after assignments and wrappers, as a basename. */
export function toolOf(words) {
  let k = 0;
  while (k < words.length && (/^[A-Za-z_][A-Za-z0-9_]*=/.test(words[k]) || WRAPPERS.has(path.posix.basename(words[k])) || (k > 0 && words[k].startsWith("-")))) {
    k += words[k] === "-u" ? 2 : 1;   // env -u NAME
  }
  return k < words.length ? path.posix.basename(words[k]) : null;
}

// A gate that leaves tests out is safe only if a CI-parity step runs the same
// suite (same directory, tool and suite options) with nothing left out.
function uncoveredExcludes(config, paritySteps, parity) {
  const excludeFlags = parity?.excludeFlags ?? EXCLUDE_FLAGS;
  const suiteFlags = parity?.suiteFlags ?? SUITE_FLAGS;
  const excludedBy = (words) => excludeFlags.flatMap((flag) => optionValues(words, flag));
  const suiteOf = (words) => suiteFlags.flatMap((flag) => optionValues(words, flag).map((v) => `${flag} ${v}`)).join(" ");
  const covering = [];
  for (const s of paritySteps) {
    try {
      for (const c of simpleCommands(s.run)) {
        if (!excludedBy(c.words).length) covering.push({ cwd: path.posix.normalize(path.posix.join(s.cwd, c.cwd)), tool: toolOf(c.words), suite: suiteOf(c.words) });
      }
    } catch { /* A run script that cannot be split covers nothing. */ }
  }
  const out = [];
  for (const step of config.gate ?? []) {
    let commands;
    try { commands = simpleCommands(step.command); } catch { continue; }
    for (const c of commands) {
      const excluded = excludedBy(c.words);
      if (!excluded.length) continue;
      const cwd = path.posix.normalize(c.cwd);
      const tool = toolOf(c.words);
      const suite = suiteOf(c.words);
      if (covering.some((k) => k.cwd === cwd && k.tool === tool && k.suite === suite)) continue;
      out.push(`gate "${step.name}" leaves out ${excluded.join(", ")} (${tool ?? "?"} in ${cwd}${suite ? `, ${suite}` : ""}), and no CI-parity step runs that suite with nothing left out`);
    }
  }
  return out;
}

// ---------- running ----------

/** The environment a CI-parity step runs with: CI's, plus what a process needs to start. */
export function parityEnv(step, hostEnv = process.env, pathValue = hostEnv.PATH) {
  const env = {};
  for (const key of HOST_ENV) if (hostEnv[key] !== undefined) env[key] = hostEnv[key];
  if (pathValue !== undefined) env.PATH = pathValue;
  return { ...env, ...step.env };
}

/**
 * Runs one resolved step with the shell its CI uses (step.shellArgs). GNU
 * timeout puts the step (and flock, with a lockFile) in its own process group
 * and kills that whole group when time is up; a small wrapper in the gate's
 * process group kills it on INT or TERM (a terminal Ctrl-C, or the backstop),
 * so no test process outlives the step or keeps the lock. The limit is the step's own time plus the lock wait,
 * so waiting for another run never shortens the step.
 */
export function paritySpec(config, step, { hostEnv = process.env, pathValue, timeoutSeconds = STEP_TIMEOUT_S, lockWaitSeconds = LOCK_WAIT_S } = {}) {
  const lockFile = config.ciParity?.lockFile;
  const limit = timeoutSeconds + (lockFile ? lockWaitSeconds : 0);
  return {
    argv: ["bash", "-c", WRAPPER, "ci-parity", String(limit),
      ...(lockFile ? ["flock", "-w", String(lockWaitSeconds), "-E", String(LOCK_BUSY), lockFile] : []),
      ...step.shellArgs, "-c", step.run],
    cwd: path.join(config.root, step.cwd),
    cwdRel: step.cwd,
    env: parityEnv(step, hostEnv, pathValue ?? hostEnv.PATH),
    timeoutMs: (limit + 90) * 1000,   // a backstop; its TERM reaches the wrapper, which stops the group
    // What an exit status means, appended to the step's output.
    notes: {
      [TIMED_OUT]: `CI parity step timed out after ${limit}s${lockFile ? ` (${timeoutSeconds}s to run plus up to ${lockWaitSeconds}s waiting for the lock)` : ""}; its process group was killed.`,
      ...(lockFile ? { [LOCK_BUSY]: `CI parity lock ${lockFile} stayed busy for ${lockWaitSeconds}s.` } : {}),
    },
  };
}

export function runParityStep(config, step, options = {}) {
  return runSpec(paritySpec(config, step, options));
}

export const parityLabel = (step) => step.label;
