// Project configuration: autobuild.json at the project root, merged over defaults.
// Env overrides (for one-off runs): AUTOBUILD_<NAME> or the legacy loop.sh names
// (MAX_ITERATIONS, MAX_TURNS, MAX_BUDGET_USD, NO_PROGRESS_LIMIT, REVIEW_EVERY, MODEL, SUBAGENT_MODEL).

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

import { readAgentConfig, validateConcurrency } from "../../../../scripts/agent-config.mjs";
import { validateDecisionConfig } from "../../../../core/skills/decisions/config.mjs";

export const CONFIG_FILE = "autobuild.json";

const STATIC_DEFAULTS = {
  featuresFile: "features.json",
  progressFile: "PROGRESS.md",
  stateDir: ".harness",
  logsDir: "logs",
  branch: null,
  prompt: "Read CLAUDE.md, SPEC.md, features.json, PROGRESS.md. Build the next feature.",
  systemPrompt: null,
  subagentModelForce: false,
  probeModel: "claude-haiku-5-5",
  claudeBin: "claude",
  backend: "claude",
  codexBin: "codex",
  codex: { reasoningEffort: "medium", sessionTimeoutMinutes: 90 },
  hooks: "inject",
  bughunt: true,
  bughuntBase: null,
  limits: {
    maxIterations: 40,
    maxTurns: 200,
    maxBudgetUsd: 50,
    totalBudgetUsd: null,
    noProgressLimit: 3,
    reviewEvery: 5,
    finalReview: true,
    bughuntBudgetUsd: 100,
    bughuntTimeoutMinutes: 360,
    reviewMaxTurns: 80,
    reviewBudgetUsd: 25,
    maxStopBlocks: 6,
    maxLimitWaitHours: 26,
    limitMarginMinutes: 3,
    probeEveryMinutes: 30,
    transientWaitMinutes: 10,
    maxTransientRetries: 3,
    watchdogMaxWaitMs: 1_800_000,
  },
  env: { pathPrepend: [], ldLibraryPath: [], vars: {} },
  install: null,
  preflight: [],
  runners: {},
  gate: [],
  deliveryMode: "full",
  commitGate: [],
  browser: null,
  frozen: [],
  writable: ["PROGRESS.md", "DECISIONS.md"],
  allowedTools: [],
  disallowedTools: [
    "AskUserQuestion", "EnterPlanMode", "ExitPlanMode", "Skill", "Workflow", "Artifact", "SendUserFile", "PushNotification",
    "RemoteTrigger", "CronCreate", "ScheduleWakeup", "EnterWorktree", "WebFetch", "WebSearch", "mcp__*",
  ],
  reviewTools: [
    "Read", "Glob", "Grep", "Edit", "Write", "TodoWrite", "Agent", "Task",
    "Bash(git status*)", "Bash(git diff*)", "Bash(git log*)", "Bash(git show*)", "Bash(git add *)", "Bash(git commit *)",
    "Bash(autobuild *)", "Bash(ls*)", "Bash(cat *)", "Bash(head *)", "Bash(tail *)", "Bash(grep *)", "Bash(rg *)", "Bash(find *)", "Bash(wc *)", "Bash(jq *)",
  ],
  review: { prompt: null },
};

// Preserve lazy public defaults without consulting this installation when a caller
// supplies the central configuration belonging to another installation.
export const DEFAULTS = {
  ...STATIC_DEFAULTS,
  get model() { return readAgentConfig().claude.orchestrator.model; },
  get subagentModel() { return readAgentConfig().claude.subagents.model; },
  get maxConcurrentSubagents() { return readAgentConfig().maxConcurrentSubagents; },
};

const LEGACY_ENV = {
  maxIterations: ["AUTOBUILD_MAX_ITERATIONS", "MAX_ITERATIONS"],
  maxTurns: ["AUTOBUILD_MAX_TURNS", "MAX_TURNS"],
  maxBudgetUsd: ["AUTOBUILD_MAX_BUDGET_USD", "MAX_BUDGET_USD"],
  totalBudgetUsd: ["AUTOBUILD_TOTAL_BUDGET_USD", "TOTAL_BUDGET_USD"],
  noProgressLimit: ["AUTOBUILD_NO_PROGRESS_LIMIT", "NO_PROGRESS_LIMIT"],
  reviewEvery: ["AUTOBUILD_REVIEW_EVERY", "REVIEW_EVERY"],
};

export function expandHome(value) {
  if (typeof value !== "string") return value;
  if (value === "~") return homedir();
  if (value.startsWith("~/")) return path.join(homedir(), value.slice(2));
  return value.replace(/^\$HOME(?=\/|$)/, homedir()).replace(/^\$\{HOME\}(?=\/|$)/, homedir());
}

/** The nearest directory at or above `start` that holds autobuild.json. */
export function findProjectRoot(start = process.cwd()) {
  let dir = path.resolve(start);
  for (;;) {
    if (existsSync(path.join(dir, CONFIG_FILE))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) throw new Error(`No ${CONFIG_FILE} found in ${start} or any parent. Run \`autobuild init\` in the project root.`);
    dir = parent;
  }
}

export function loadConfig(root = findProjectRoot(), env = process.env, overrides = {}) {
  const file = path.join(root, CONFIG_FILE);
  const raw = JSON.parse(readFileSync(file, "utf8"));
  return resolveManagedConfig({ project: raw, env, overrides, root });
}

// Shared, read-only managed launch validation for the launcher and doctor.
export function resolveManagedConfig({ project: raw = {}, env = {}, overrides = {}, root, central = readAgentConfig() } = {}) {
  const config = {
    ...STATIC_DEFAULTS,
    model: central.claude.orchestrator.model,
    subagentModel: central.claude.subagents.model,
    maxConcurrentSubagents: central.maxConcurrentSubagents,
    ...raw,
    limits: { ...DEFAULTS.limits, ...(raw.limits ?? {}) },
    env: { ...DEFAULTS.env, ...(raw.env ?? {}) },
    review: { ...DEFAULTS.review, ...(raw.review ?? {}) },
    codex: { ...DEFAULTS.codex, ...(raw.codex ?? {}) },
    root,
  };
  for (const [key, names] of Object.entries(LEGACY_ENV)) {
    const name = names.find((candidate) => env[candidate] !== undefined && env[candidate] !== "");
    if (name) config.limits[key] = Number(env[name]);
  }
  config.deliveryMode = overrides.deliveryMode ?? env.AUTOBUILD_DELIVERY_MODE ?? config.deliveryMode;
  if (!["full", "pr-first"].includes(config.deliveryMode)) throw new Error('deliveryMode must be "full" or "pr-first"');
  if (!Array.isArray(config.commitGate) || config.commitGate.some(step => !step || typeof step.name !== "string" || !step.name.trim() || typeof step.command !== "string" || !step.command.trim())) {
    throw new Error("commitGate must be an array of named commands");
  }
  config.backend = overrides.backend || env.AUTOBUILD_BACKEND || config.backend;
  if (!["claude", "codex"].includes(config.backend)) throw new Error('backend must be "claude" or "codex"');
  Object.assign(config, resolveManagedModels({ backend: config.backend, central, project: raw, env, overrides }).values);
  if (env.AUTOBUILD_CLAUDE_BIN) config.claudeBin = env.AUTOBUILD_CLAUDE_BIN;
  if (env.AUTOBUILD_CODEX_BIN) config.codexBin = env.AUTOBUILD_CODEX_BIN;
  const bin = config[`${config.backend}Bin`];
  if (typeof bin !== "string" || !bin.trim() || /[\x00-\x1f\x7f]/.test(bin)) throw new Error("Invalid managed provider binary");
  if (config.backend === "codex") {
    if (!Number.isFinite(config.codex.sessionTimeoutMinutes) || config.codex.sessionTimeoutMinutes <= 0) throw new Error("codex.sessionTimeoutMinutes must be positive");
    if (config.limits.totalBudgetUsd != null) throw new Error("Codex does not report dollar cost; remove totalBudgetUsd and use maxIterations/sessionTimeoutMinutes instead");
  }
  validateConcurrency(config.maxConcurrentSubagents);
  if (config.decisions !== undefined) config.decisions = validateDecisionConfig(config.decisions);
  validateCiParityConfig(config);
  if (env.EXPECTED_BRANCH) config.branch = env.EXPECTED_BRANCH;
  config.env.pathPrepend = (config.env.pathPrepend ?? []).map(expandHome);
  config.env.ldLibraryPath = (config.env.ldLibraryPath ?? []).map(expandHome);
  // The config file and the harness state are always frozen for builders.
  config.frozen = [...new Set([CONFIG_FILE, config.featuresFile, config.stateDir, ...(config.backend === "codex" ? ["AGENTS.md", ".codex"] : []), ...(config.frozen ?? [])])];
  if (!["inject", "project"].includes(config.hooks)) throw new Error(`${CONFIG_FILE}: "hooks" must be "inject" or "project"`);
  return config;
}

export const WORKFLOW_DIR = ".github/workflows";
const text = (value) => typeof value === "string" && value.trim() !== "";

// Shape checks for ciParity / ciParityOptOut (resolved against the CI files in ci-parity.mjs).
// GitHub Actions: {workflow, steps: [{job, step}], skip?}. Any other CI: {ciFile, steps: [{name, run, cwd?, env?}], env?}.
function validateCiParityConfig(raw) {
  const { ciParity, ciParityOptOut } = raw;
  if (ciParityOptOut !== undefined && !text(ciParityOptOut)) throw new Error("ciParityOptOut must be a non-empty reason");
  if (ciParity === undefined) return;
  if (ciParityOptOut !== undefined) throw new Error("set either ciParity or ciParityOptOut, not both");
  if (!ciParity || typeof ciParity !== "object" || Array.isArray(ciParity)) throw new Error("ciParity must be an object");
  const github = ciParity.workflow !== undefined;
  if (github === (ciParity.ciFile !== undefined)) throw new Error("ciParity needs exactly one of workflow (GitHub Actions) or ciFile (any other CI)");
  const shared = ["steps", "lockFile", "excludeFlags", "suiteFlags"];
  const known = new Set(github ? ["workflow", "skip", ...shared] : ["ciFile", "env", ...shared]);
  const unknown = Object.keys(ciParity).filter((key) => !known.has(key));
  if (unknown.length) throw new Error(`ciParity has unknown keys: ${unknown.join(", ")}`);
  const relative = (value) => text(value) && !path.isAbsolute(value) && !value.split(/[\\/]/).includes("..");
  const stringMap = (value) => value === undefined || (value && typeof value === "object" && !Array.isArray(value) && Object.values(value).every((v) => typeof v === "string"));
  if (github) {
    if (!relative(ciParity.workflow) || !ciParity.workflow.startsWith(`${WORKFLOW_DIR}/`)) throw new Error(`ciParity.workflow must be a file under ${WORKFLOW_DIR}/`);
    if (!Array.isArray(ciParity.steps) || !ciParity.steps.length || ciParity.steps.some((s) => !s || !text(s.job) || !text(s.step) || Object.keys(s).some((k) => !["job", "step"].includes(k)))) {
      throw new Error('ciParity.steps must be a non-empty array of { "job", "step" }');
    }
    if (ciParity.skip !== undefined && (!Array.isArray(ciParity.skip) || ciParity.skip.some((s) => !s || !text(s.step) || !text(s.reason) || (s.job !== undefined && !text(s.job)) || Object.keys(s).some((k) => !["job", "step", "reason"].includes(k))))) {
      throw new Error('ciParity.skip must be an array of { "step", "reason", optional "job" }');
    }
  } else {
    if (!relative(ciParity.ciFile)) throw new Error("ciParity.ciFile must be a path inside the repository");
    if (!Array.isArray(ciParity.steps) || !ciParity.steps.length || ciParity.steps.some((s) => !s || !text(s.name) || !text(s.run) || (s.cwd !== undefined && !relative(s.cwd)) || !stringMap(s.env) || Object.keys(s).some((k) => !["name", "run", "cwd", "env"].includes(k)))) {
      throw new Error('ciParity.steps must be a non-empty array of { "name", "run", optional "cwd" and "env" }');
    }
    if (!stringMap(ciParity.env)) throw new Error("ciParity.env must map names to strings");
  }
  for (const key of ["excludeFlags", "suiteFlags"]) {
    if (ciParity[key] !== undefined && (!Array.isArray(ciParity[key]) || ciParity[key].some((flag) => typeof flag !== "string" || !/^-{1,2}[A-Za-z]/.test(flag)))) throw new Error(`ciParity.${key} must be an array of option names`);
  }
  if (ciParity.lockFile !== undefined && (!text(ciParity.lockFile) || !path.isAbsolute(ciParity.lockFile))) throw new Error("ciParity.lockFile must be an absolute path");
}

export function statePath(config, ...parts) {
  return path.join(config.root, config.stateDir, ...parts);
}

// Role equivalents, not claims of identical capability. Explicit OpenAI model IDs pass through.
export function codexModel(model) {
  if (model === "fable" || /^(?:claude-)?opus(?:-|$)/i.test(model)) return "gpt-6-astra";
  if (/^(?:claude-)?sonnet(?:-|$)/i.test(model)) return "gpt-6.1-sol";
  if (/^(?:claude-)?haiku(?:-|$)/i.test(model)) return "gpt-6-luna";
  if (/^claude-/i.test(model)) throw new Error(`No Codex equivalent for ${model}; set an explicit OpenAI model`);
  return model;
}

// Shared launch precedence with provenance for read-only configuration inspection.
export function resolveManagedModels({ backend, central, project = {}, env = {}, overrides = {} }) {
  const values = {}, sources = {};
  const choose = (key, candidates) => {
    const [value, source] = candidates.find(([value]) => value !== undefined);
    // Launch roles require identifiers; null remains valid only in observational
    // records. Match agent-config's grammar before provider mapping can coerce it.
    if (typeof value !== "string" || !/^[A-Za-z0-9]/.test(value) || /[^A-Za-z0-9._:/-]/.test(value)) {
      throw new Error(`${key} must be a nonempty model identifier`);
    }
    values[key] = backend === "codex" ? codexModel(value) : value;
    sources[key] = source;
  };
  choose("model", [
    [overrides.model || undefined, "cli"], [env.AUTOBUILD_MODEL || env.MODEL || undefined, "env"],
    [project.model, "project"], [backend === "codex" ? "opus" : central.claude.orchestrator.model, backend === "codex" ? "default" : "central"],
  ]);
  choose("subagentModel", [
    [env.AUTOBUILD_SUBAGENT_MODEL || env.SUBAGENT_MODEL || undefined, "env"], [project.subagentModel, "project"],
    [backend === "codex" ? "sonnet" : central.claude.subagents.model, backend === "codex" ? "default" : "central"],
  ]);
  choose("probeModel", [[env.AUTOBUILD_PROBE_MODEL || undefined, "env"], [project.probeModel, "project"], [DEFAULTS.probeModel, "default"]]);
  return { values, sources };
}
