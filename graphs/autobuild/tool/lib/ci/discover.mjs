// ci-optimizer discovery (spec/contracts/ci-optimizer-co-01.md): what a repository is built and
// tested with, how its CI is shaped, and its gate, as a profile stored per machine and reused
// until one of its inputs (CI files, the manifests detection read, autobuild.json) changes.
// Offline and read-only inside the repository: only the state directory is written.

import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { CONFIG_FILE, DEFAULTS, loadConfig } from "../config.mjs";
import { ciFiles, ciProviderOf, GITHUB_PROVIDER, readWorkflow, workflowFiles } from "../ci-parity.mjs";
import { GITLAB_PROVIDER, readGitlabPipeline } from "./gitlab.mjs";
import { INSTALL_COMMAND, TEST_COMMAND, wholeNumberOf } from "./patterns.mjs";
import { CiError, readState, STATE_SCHEMA_VERSION, writeState } from "./state.mjs";

const sha256hex = (value) => createHash("sha256").update(value).digest("hex");
const byName = (a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
const sortedUnique = (items) => [...new Set(items)].sort();
const plainObject = (value) => Boolean(value) && typeof value === "object" && !Array.isArray(value);
const textOrNull = (value) => (typeof value === "string" ? value : null);
const EXPRESSION = "${{";
const isExpression = (value) => typeof value === "string" && value.includes(EXPRESSION);

// ---------- detection: manifests at the root and in each immediate child directory ----------

const NODE_LOCKFILES = [["pnpm-lock.yaml", "pnpm"], ["yarn.lock", "yarn"], ["bun.lock", "bun"], ["bun.lockb", "bun"], ["package-lock.json", "npm"]];
const NODE_FRAMEWORKS = [["vitest", "vitest", () => "threads"], ["jest", "jest", () => "workers"],
  ["mocha", "mocha", (test) => (test?.includes("--parallel") ? "files" : null)], ["@playwright/test", "playwright", () => "workers"]];
const PYTHON_FILE = /^(pyproject\.toml|setup\.py|setup\.cfg|requirements.*\.txt|pytest\.ini|tox\.ini)$/;
// Single-manifest ecosystems: file → [language, build tool, test framework or null].
const SIMPLE_MANIFESTS = [
  ["go.mod", "go", "go", { name: "go-test", command: "go test ./...", parallel: "packages" }],
  ["Cargo.toml", "rust", "cargo", { name: "cargo-test", command: "cargo test", parallel: "threads" }],
  ["pom.xml", "java", "maven", { name: "maven-test", command: null, parallel: null }],
  ["build.gradle", "java", "gradle", { name: "gradle-test", command: null, parallel: null }],
  ["build.gradle.kts", "java", "gradle", { name: "gradle-test", command: null, parallel: null }],
];

/** Accumulates detections across directories: one entry per name, with every evidence path. */
function collector() {
  const languages = new Map(), buildTools = new Map(), frameworks = new Map();
  const unknowns = new Set(), read = new Set();
  const addNamed = (map, name, evidence) => {
    if (!map.has(name)) map.set(name, new Set());
    for (const file of evidence) { map.get(name).add(file); read.add(file); }
  };
  return {
    unknowns,
    read,
    language: (name, evidence) => addNamed(languages, name, evidence),
    tool: (name, evidence) => addNamed(buildTools, name, evidence),
    framework: ({ name, command, parallel }, evidence) => {
      const entry = frameworks.get(name) ?? { name, command: null, parallel: null, evidence: new Set() };
      entry.command ??= command;
      entry.parallel ??= parallel;
      for (const file of evidence) { entry.evidence.add(file); read.add(file); }
      frameworks.set(name, entry);
    },
    result: () => {
      const named = (map) => [...map].map(([name, files]) => ({ name, evidence: [...files].sort() })).sort(byName);
      return {
        languages: named(languages),
        buildTools: named(buildTools),
        testFrameworks: [...frameworks.values()].map((f) => ({ ...f, evidence: [...f.evidence].sort() })).sort(byName),
        unknowns,
        read,
      };
    },
  };
}

/** The directories scanned: the root, then each immediate child that is not hidden or node_modules. */
function scannedDirs(root, unknowns) {
  let entries;
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch (error) {
    throw new CiError("IO_ERROR", `cannot list ${root}: ${error.message}`);
  }
  const children = entries.filter((e) => e.isDirectory() && !e.name.startsWith(".") && e.name !== "node_modules").map((e) => e.name).sort();
  return [".", ...children].map((dir) => ({ dir, files: filesIn(root, dir, unknowns) }));
}

// Regular files only: a symbolic link is never followed out of the repository.
function filesIn(root, dir, unknowns) {
  try {
    return new Set(readdirSync(path.join(root, dir), { withFileTypes: true }).filter((e) => e.isFile()).map((e) => e.name));
  } catch {
    unknowns.add(`DIR_UNREADABLE:${dir}`);
    return new Set();
  }
}

const relPath = (dir, name) => (dir === "." ? name : `${dir}/${name}`);

function readText(root, rel, unknowns) {
  try {
    return readFileSync(path.join(root, rel), "utf8");
  } catch {
    unknowns.add(`FILE_UNREADABLE:${rel}`);
    return "";
  }
}

function detectNode(root, dir, files, found) {
  if (!files.has("package.json")) return;
  const manifest = relPath(dir, "package.json");
  found.language("javascript", [manifest]);
  if (files.has("tsconfig.json")) found.language("typescript", [relPath(dir, "tsconfig.json")]);
  const lockfiles = NODE_LOCKFILES.filter(([file]) => files.has(file));
  for (const [file, tool] of lockfiles) found.tool(tool, [relPath(dir, file)]);
  if (!lockfiles.length) {
    found.tool("npm", [manifest]);
    found.unknowns.add(`NODE_LOCKFILE_MISSING:${dir}`);
  }
  let pkg;
  try {
    pkg = JSON.parse(readText(root, manifest, found.unknowns));
  } catch {
    pkg = null;
  }
  if (!plainObject(pkg)) {
    found.unknowns.add(`PACKAGE_JSON_UNPARSED:${dir}`);
    return;
  }
  const test = textOrNull(plainObject(pkg.scripts) ? pkg.scripts.test : null);
  const deps = new Set([pkg.dependencies, pkg.devDependencies].filter(plainObject).flatMap((d) => Object.keys(d)));
  for (const [dep, name, parallel] of NODE_FRAMEWORKS) {
    if (deps.has(dep)) found.framework({ name, command: test, parallel: parallel(test) }, [manifest]);
  }
  if (test?.includes("node --test")) found.framework({ name: "node-test", command: test, parallel: "files" }, [manifest]);
}

function detectPython(root, dir, files, found) {
  const names = [...files].filter((name) => PYTHON_FILE.test(name)).sort();
  if (!names.length) return;
  const manifests = names.map((name) => relPath(dir, name));
  found.language("python", manifests);
  if (files.has("poetry.lock")) found.tool("poetry", [relPath(dir, "poetry.lock")]);
  else found.tool("pip", manifests);
  const texts = new Map(manifests.map((rel) => [rel, readText(root, rel, found.unknowns)]));
  const pytestEvidence = manifests.filter((rel) => path.posix.basename(rel) === "pytest.ini"
    || (path.posix.basename(rel) === "pyproject.toml" && texts.get(rel).includes("[tool.pytest"))
    || /\bpytest\b/.test(texts.get(rel)));
  if (!pytestEvidence.length) return;
  const xdist = [...texts.values()].some((text) => text.includes("pytest-xdist"));
  found.framework({ name: "pytest", command: null, parallel: xdist ? "pytest-xdist" : null }, pytestEvidence);
}

function detectRuby(root, dir, files, found) {
  if (!files.has("Gemfile")) return;
  const gemfile = relPath(dir, "Gemfile");
  found.language("ruby", [gemfile]);
  found.tool("bundler", [gemfile]);
  if (/\brspec\b/.test(readText(root, gemfile, found.unknowns))) found.framework({ name: "rspec", command: null, parallel: null }, [gemfile]);
}

function detectSimple(dir, files, found) {
  for (const [file, language, tool, framework] of SIMPLE_MANIFESTS) {
    if (!files.has(file)) continue;
    const evidence = [relPath(dir, file)];
    found.language(language, evidence);
    found.tool(tool, evidence);
    found.framework(framework, evidence);
  }
}

function detectTerraform(dir, files, found) {
  const tf = [...files].filter((name) => name.endsWith(".tf")).sort().map((name) => relPath(dir, name));
  if (!tf.length) return;
  found.language("terraform", tf);
  found.tool("terraform", tf);
}

/** Languages, build tools and test frameworks, the unknowns met, and every evidence file read. */
function detect(root) {
  const found = collector();
  for (const { dir, files } of scannedDirs(root, found.unknowns)) {
    detectNode(root, dir, files, found);
    detectPython(root, dir, files, found);
    detectRuby(root, dir, files, found);
    detectSimple(dir, files, found);
    detectTerraform(dir, files, found);
  }
  return found.result();
}

// ---------- the inputs digest ----------

function digestOf(root, evidenceFiles) {
  const files = sortedUnique([...ciFiles(root), ...evidenceFiles, ...(existsSync(path.join(root, CONFIG_FILE)) ? [CONFIG_FILE] : [])]);
  const lines = files.map((file) => {
    let bytes;
    try {
      bytes = readFileSync(path.join(root, file));
    } catch (error) {
      throw new CiError("IO_ERROR", `cannot read ${file}: ${error.message}`);
    }
    return `${file}\0${sha256hex(bytes)}`;
  });
  return { digest: sha256hex(lines.join("\n")), files };
}

/** `{ digest, files }` over the CI files, the evidence files detection reads, and autobuild.json. */
export async function inputsDigest(root) {
  const resolved = path.resolve(root);
  return digestOf(resolved, detect(resolved).read);
}

// ---------- GitHub workflow models ----------

const STEP_KINDS = [
  ["checkout", (s) => s.uses?.startsWith("actions/checkout")],
  ["cache", (s) => s.uses?.startsWith("actions/cache")],
  ["setup", (s) => s.uses?.startsWith("actions/setup-")],
  ["artifact-upload", (s) => s.uses?.startsWith("actions/upload-artifact")],
  ["artifact-download", (s) => s.uses?.startsWith("actions/download-artifact")],
  ["install", (s) => s.run !== null && INSTALL_COMMAND.test(s.run)],
  ["test", (s) => s.run !== null && TEST_COMMAND.test(s.run)],
];

function stepModel(raw, index) {
  const step = plainObject(raw) ? raw : {};
  const fields = { name: textOrNull(step.name), uses: textOrNull(step.uses), run: textOrNull(step.run) };
  const kind = STEP_KINDS.find(([, matches]) => matches(fields))?.[0] ?? "other";
  const withCache = plainObject(step.with) && typeof step.with.cache === "string" && step.with.cache !== "";
  return { index: index + 1, ...fields, kind, cache: withCache || kind === "cache" };
}

function branchesOf(filter) {
  const branches = plainObject(filter) ? filter.branches : undefined;
  if (typeof branches === "string") return [branches];
  if (Array.isArray(branches)) return branches.filter((b) => typeof b === "string");
  return null;
}

function triggersOf(on) {
  let triggers = [];
  if (typeof on === "string") triggers = [{ event: on, branches: null }];
  else if (Array.isArray(on)) triggers = on.filter((e) => typeof e === "string").map((event) => ({ event, branches: null }));
  else if (plainObject(on)) triggers = Object.entries(on).map(([event, filter]) => ({ event, branches: branchesOf(filter) }));
  return triggers.sort((a, b) => (a.event < b.event ? -1 : a.event > b.event ? 1 : 0));
}

function concurrencyOf(value) {
  if (typeof value === "string") return { group: value, cancelInProgress: false };
  if (!plainObject(value)) return null;
  const cancel = value["cancel-in-progress"];
  return {
    group: textOrNull(value.group),
    cancelInProgress: isExpression(cancel) ? "expression" : cancel === true || cancel === "true",
  };
}

function runsOnOf(value) {
  if (typeof value === "string") return isExpression(value) ? "expression" : value;
  if (Array.isArray(value)) {
    const labels = value.filter((label) => typeof label === "string");
    return labels.some(isExpression) ? "expression" : labels;
  }
  return null;   // absent, or the { group, labels } form this model does not describe
}

function needsOf(value) {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.filter((need) => typeof need === "string");
  return [];
}

// The product of the list-valued matrix keys (include/exclude not counted). A size that cannot
// be computed is null with its reason in `unknowns`, never a guess.
function matrixSizeOf(strategy, where, unknowns) {
  const matrix = plainObject(strategy) ? strategy.matrix : undefined;
  if (matrix === undefined || matrix === null) return null;
  if (isExpression(matrix)) { unknowns.push(`MATRIX_EXPRESSION:${where}`); return null; }
  if (!plainObject(matrix)) { unknowns.push(`MATRIX_UNSIZED:${where}`); return null; }
  let size = 1, dimensions = 0;
  for (const [key, value] of Object.entries(matrix)) {
    if (key === "include" || key === "exclude") continue;
    if (isExpression(value)) { unknowns.push(`MATRIX_EXPRESSION:${where}`); return null; }
    if (Array.isArray(value)) { size *= value.length; dimensions++; }
  }
  if (!dimensions) { unknowns.push(`MATRIX_UNSIZED:${where}`); return null; }
  return size;
}

function jobModel(file, id, raw, unknowns) {
  const job = plainObject(raw) ? raw : {};
  return {
    id,
    name: textOrNull(job.name),
    runsOn: runsOnOf(job["runs-on"]),
    needs: needsOf(job.needs),
    matrixSize: matrixSizeOf(job.strategy, `${file}#${id}`, unknowns),
    timeoutMinutes: wholeNumberOf(job["timeout-minutes"]),
    steps: (Array.isArray(job.steps) ? job.steps : []).map(stepModel),
  };
}

/** One workflow file's model, and the unknowns it adds; throws when the file does not parse. */
function workflowModel(root, file) {
  const doc = readWorkflow(root, file);
  const unknowns = [];
  const jobs = Object.entries(doc.jobs).map(([id, job]) => jobModel(file, id, job, unknowns));
  return { model: { file, name: textOrNull(doc.name), triggers: triggersOf(doc.on), concurrency: concurrencyOf(doc.concurrency), jobs }, unknowns };
}

// ---------- CI providers ----------

function readCi(root) {
  const unknowns = [];
  const byProvider = new Map();
  for (const file of ciFiles(root)) {
    const id = ciProviderOf(file);
    if (!byProvider.has(id)) byProvider.set(id, []);
    byProvider.get(id).push(file);
  }
  if (!byProvider.size) unknowns.push("NO_CI");
  const workflows = [];
  let firstError = null;
  for (const file of workflowFiles(root)) {
    try {
      const { model, unknowns: own } = workflowModel(root, file);
      workflows.push(model);
      unknowns.push(...own);
    } catch (error) {
      const message = String(error?.message ?? error);
      firstError ??= message.startsWith(file) ? message : `${file}: ${message}`;
    }
  }
  const pipelines = byProvider.has(GITLAB_PROVIDER) ? [readGitlabPipeline(root)] : [];
  const gitlabError = pipelines.find((pipeline) => "error" in pipeline)?.error ?? null;
  const parseStatus = (error) => (error === null ? { status: "parsed" } : { status: "unparsed", error });
  const providers = [...byProvider].map(([id, files]) => {
    if (id === GITHUB_PROVIDER) return { id, files: files.sort(), ...parseStatus(firstError) };
    if (id === GITLAB_PROVIDER) return { id, files: files.sort(), ...parseStatus(gitlabError) };
    return { id, files: files.sort(), status: "detected" };
  }).sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return { ci: { providers, workflows, pipelines }, unknowns };
}

// ---------- the gate ----------

const listOrNull = (value) => (Array.isArray(value) ? [...value] : null);

function gateOf(config) {
  return {
    concurrency: config.gateConcurrency ?? DEFAULTS.gateConcurrency,
    cache: config.gateCache ?? DEFAULTS.gateCache,
    order: config.gateOrder ?? DEFAULTS.gateOrder,
    steps: (Array.isArray(config.gate) ? config.gate : []).map((step) => ({
      name: step.name,
      command: step.command,
      paths: listOrNull(step.paths),
      resources: listOrNull(step.resources),
      shardable: step.shardable === true,
      shardWeight: Number.isInteger(step.shardWeight) ? step.shardWeight : null,
    })),
  };
}

/** The loaded autobuild.json of `root`, or null without one. An invalid one is CONFIG_INVALID (exit 2). */
export function projectConfig(root, env = process.env) {
  if (!existsSync(path.join(root, CONFIG_FILE))) return null;
  try {
    return loadConfig(root, env);
  } catch (error) {
    throw new CiError("CONFIG_INVALID", `${CONFIG_FILE}: ${error.message}`, 2);
  }
}

// ---------- the profile ----------

function assembleProfile(root, config, detection, digest) {
  const hasConfig = existsSync(path.join(root, CONFIG_FILE));
  const { ci, unknowns: ciUnknowns } = readCi(root);
  const unknowns = [...detection.unknowns, ...ciUnknowns];
  if (!detection.testFrameworks.length) unknowns.push("NO_TEST_FRAMEWORK");
  if (!hasConfig) unknowns.push("NO_AUTOBUILD_CONFIG");
  const loaded = hasConfig ? config ?? projectConfig(root) : null;
  return {
    schemaVersion: STATE_SCHEMA_VERSION,
    root,
    inputsDigest: digest.digest,
    generatedAt: new Date().toISOString(),
    languages: detection.languages,
    buildTools: detection.buildTools,
    testFrameworks: detection.testFrameworks,
    ci,
    gate: loaded ? gateOf(loaded) : null,
    unknowns: sortedUnique(unknowns),
  };
}

/** The repository's profile, discovered now. `config` is the loaded autobuild.json, when the caller has it. */
export async function discoverRepo(root, { config = null } = {}) {
  const resolved = path.resolve(root);
  const detection = detect(resolved);
  return assembleProfile(resolved, config, detection, digestOf(resolved, detection.read));
}

/**
 * `{ profile, reused }`: the stored profile when its schema and inputs digest still match
 * (and `refresh` is false), without writing; otherwise a fresh discovery, stored.
 */
export async function loadProfile(root, { env = process.env, refresh = false, config = null } = {}) {
  const resolved = path.resolve(root);
  const detection = detect(resolved);
  const digest = digestOf(resolved, detection.read);
  if (!refresh) {
    const stored = readState(resolved, "profile", env);
    if (stored && stored.inputsDigest === digest.digest) return { profile: stored, reused: true };
  }
  const profile = assembleProfile(resolved, config, detection, digest);
  writeState(resolved, "profile", profile, env);
  return { profile, reused: false };
}
