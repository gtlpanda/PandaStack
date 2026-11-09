// Project configuration: autobuild.json at the project root, merged over defaults.
// Env overrides (for one-off runs): AUTOBUILD_<NAME> or the legacy loop.sh names
// (MAX_ITERATIONS, MAX_TURNS, MAX_BUDGET_USD, NO_PROGRESS_LIMIT, REVIEW_EVERY, MODEL, SUBAGENT_MODEL).

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

export const CONFIG_FILE = "autobuild.json";

export const DEFAULTS = {
  featuresFile: "features.json",
  progressFile: "PROGRESS.md",
  stateDir: ".harness",
  logsDir: "logs",
  branch: null,
  prompt: "Read CLAUDE.md, SPEC.md, features.json, PROGRESS.md. Build the next feature.",
  systemPrompt: null,
  model: "claude-opus-5-5",
  subagentModel: "claude-sonnet-5-5",
  subagentModelForce: true,
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
  const config = {
    ...DEFAULTS,
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
  if (env.AUTOBUILD_MODEL || env.MODEL) config.model = env.AUTOBUILD_MODEL || env.MODEL;
  if (env.AUTOBUILD_SUBAGENT_MODEL || env.SUBAGENT_MODEL) config.subagentModel = env.AUTOBUILD_SUBAGENT_MODEL || env.SUBAGENT_MODEL;
  if (env.AUTOBUILD_CLAUDE_BIN) config.claudeBin = env.AUTOBUILD_CLAUDE_BIN;
  config.backend = overrides.backend || env.AUTOBUILD_BACKEND || config.backend;
  if (!["claude", "codex"].includes(config.backend)) throw new Error('backend must be "claude" or "codex"');
  if (env.AUTOBUILD_CODEX_BIN) config.codexBin = env.AUTOBUILD_CODEX_BIN;
  if (env.AUTOBUILD_PROBE_MODEL) config.probeModel = env.AUTOBUILD_PROBE_MODEL;
  if (overrides.model) config.model = overrides.model;
  if (config.backend === "codex") {
    for (const key of ["model", "subagentModel", "probeModel"]) config[key] = codexModel(config[key]);
    if (!Number.isFinite(config.codex.sessionTimeoutMinutes) || config.codex.sessionTimeoutMinutes <= 0) throw new Error("codex.sessionTimeoutMinutes must be positive");
    if (config.limits.totalBudgetUsd != null) throw new Error("Codex does not report dollar cost; remove totalBudgetUsd and use maxIterations/sessionTimeoutMinutes instead");
  }
  if (env.EXPECTED_BRANCH) config.branch = env.EXPECTED_BRANCH;
  config.env.pathPrepend = (config.env.pathPrepend ?? []).map(expandHome);
  config.env.ldLibraryPath = (config.env.ldLibraryPath ?? []).map(expandHome);
  // The config file and the harness state are always frozen for builders.
  config.frozen = [...new Set([CONFIG_FILE, config.featuresFile, config.stateDir, ...(config.backend === "codex" ? ["AGENTS.md", ".codex"] : []), ...(config.frozen ?? [])])];
  if (!["inject", "project"].includes(config.hooks)) throw new Error(`${CONFIG_FILE}: "hooks" must be "inject" or "project"`);
  return config;
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
