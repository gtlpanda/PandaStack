// autobuild: an autonomous, test-gated build loop for Claude Code or Codex projects.
// Usage: autobuild <command> [args]   (run from anywhere inside a project with autobuild.json)

import { spawnSync } from "node:child_process";
import { appendFileSync, copyFileSync, existsSync, readFileSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CONFIG_FILE, findProjectRoot, loadConfig, statePath } from "./config.mjs";
import { blockedClosure, countPassing, featureById, nextFeature, readBlockers, readFeatures, readProgress, writeFeatures } from "./features.mjs";
import { failureExcerpt, runGate } from "./gate.mjs";
import { runLoop } from "./loop.mjs";
import { huntStatus } from "./bughunt.mjs";
import { readSession } from "./session.mjs";
import { runFeatureTests } from "./tests.mjs";
import { tail } from "./proc.mjs";
import { evidenceManifest, verifyEvidence } from "./evidence.mjs";
import { flushDecisionOutput } from '../../../../core/skills/decisions/output.mjs';

const HOME = path.resolve(import.meta.dirname, "..");

const HELP = `autobuild — autonomous, test-gated build loop for Claude Code or Codex

  autobuild run [--backend claude|codex] [--model MODEL] [--max-iterations N] [--delivery-mode full|pr-first]   run the loop (one headless session per feature)
  autobuild next                       print the feature the next session builds
  autobuild status                     passing count, next feature, blockers, last log lines
  autobuild test <ID> [ID...]          run features' frozen acceptance tests
  autobuild check [--phase full|commit] [--feature ID] [--base SHA] [--fail-fast] [--json] [--skip-browser]
                                       run the full gate
  autobuild mark-passed <ID>           rerun a feature's test; set passes:true only if it passes
  autobuild init [--backend claude|codex] scaffold autobuild.json, PROGRESS.md and the CLAUDE.md rules
  autobuild selftest                   test the kit (limit parsing, guard) against this machine
  autobuild evidence manifest [--out FILE]   hash every file in the evidence dir (JSON, to commit instead of the files)
  autobuild evidence verify FILE       check the evidence dir against a manifest

Exit codes of \`run\`: 0 verified completion or PR-first handoff, 2 no progress, 3 blocked, 4 frozen files changed, 5 preflight,
6 total budget, 7 max iterations, 8 usage limit resets too far away, 9 billing, 10 auth,
11 another loop running, 12 the bug hunt needs a human, 13 the final review did not finish,
14 managed decision stopped, 15 provider refusal (nonretryable), 130 interrupted.
Docs: ${path.join(HOME, "README.md")}`;

function flag(args, name) {
  return args.includes(name);
}
function value(args, name) {
  const index = args.indexOf(name);
  if (index >= 0 && (!args[index + 1] || args[index + 1].startsWith("--"))) throw new Error(`${name} requires a value`);
  return index >= 0 ? args[index + 1] : undefined;
}

export async function main(argv = process.argv.slice(2)) {
  const [command, ...args] = argv;
  switch (command) {
    case "run": {
      const config = loadConfig(undefined, process.env, { backend: value(args, "--backend"), model: value(args, "--model"), deliveryMode: value(args, "--delivery-mode") });
      const max = value(args, "--max-iterations");
      if (max) config.limits.maxIterations = Number(max);
      return runLoop(config);
    }
    case "next": {
      const config = loadConfig();
      const doc = readFeatures(config);
      const blockers = readBlockers(readProgress(config));
      if (doc.features.length === 0) {
        console.log(JSON.stringify({ empty: true, message: `${config.featuresFile} lists no features` }));
        return 1;
      }
      const next = nextFeature(doc, blockers);
      if (next) {
        console.log(JSON.stringify({ id: next.id, title: next.title, test: next.test, testKind: next.testKind, contract: next.contract }, null, 2));
        return 0;
      }
      if (doc.features.every((feature) => feature.passes)) {
        console.log(JSON.stringify({ done: true, passing: doc.features.length, review: huntStatus(config) }));
        return 10;
      }
      console.log(JSON.stringify({ stuck: true, blocked: [...blockedClosure(doc, blockers)] }, null, 2));
      return 11;
    }
    case "status": {
      const config = loadConfig();
      const doc = readFeatures(config);
      const blockers = readBlockers(readProgress(config));
      const next = nextFeature(doc, blockers);
      console.log(`${countPassing(doc)}/${doc.features.length} features passing`);
      console.log(`delivery: ${config.deliveryMode}${config.deliveryMode === "pr-first" ? " (full PR checks and review pending; not merge-ready)" : ""}`);
      console.log(`next: ${next ? `${next.id} — ${next.title}` : "none"}`);
      const review = huntStatus(config);
      console.log(`review coverage: ${review.hunted ? review.disposition : review.docsOnly ? "docs only" : "pending"}${review.dirty ? " (uncommitted changes are not reviewed)" : ""}`);
      if (review.reason) console.log(`review: ${review.reason}`);
      if (blockers.size) console.log(`blocked: ${[...blockers].join(", ")}`);
      const pidFile = statePath(config, "loop.pid");
      console.log(`loop running: ${existsSync(pidFile) ? `yes (pid ${readFileSync(pidFile, "utf8").trim()})` : "no"}`);
      const session = readSession(config);
      if (session) console.log(`last session: ${session.role} ${session.featureId}, started ${session.startedAt}, stop attempts ${session.stopAttempts ?? 0}`);
      const logsDir = path.join(config.root, config.logsDir);
      const loopLogs = existsSync(logsDir) ? readdirSync(logsDir).filter((name) => name.startsWith("loop-")).sort() : [];
      if (loopLogs.length) console.log(`\n${loopLogs.at(-1)}:\n${tail(readFileSync(path.join(logsDir, loopLogs.at(-1)), "utf8"), 1500)}`);
      return 0;
    }
    case "test": {
      const config = loadConfig();
      if (args.length === 0) throw new Error("usage: autobuild test <ID> [ID...]");
      const doc = readFeatures(config);
      let ok = true;
      for (const step of runFeatureTests(config, args.map((id) => featureById(doc, id)))) {
        console.log(`\n=== ${step.name}: ${step.ok ? "PASS" : "FAIL"} (${Math.round(step.ms / 1000)}s)`);
        console.log(step.ok ? tail(step.output, 1500) : failureExcerpt(step.output, 12000));
        ok &&= step.ok;
      }
      return ok ? 0 : 1;
    }
    case "check": {
      const config = loadConfig();
      const session = readSession(config);
      const summary = runGate(config, {
        phase: value(args, "--phase") ?? "full",
        featureId: value(args, "--feature") ?? (session?.role === "builder" ? session.featureId : null),
        baseSha: value(args, "--base") ?? (session?.role === "builder" ? session.baseSha : null),
        failFast: flag(args, "--fail-fast"),
        skipBrowser: flag(args, "--skip-browser") || flag(args, "--skip-e2e"),
      });
      if (flag(args, "--json")) {
        console.log(JSON.stringify(summary));
      } else {
        for (const step of summary.steps) {
          console.log(`${step.ok ? "PASS" : "FAIL"}  ${step.name} (${step.seconds}s)`);
          if (!step.ok) console.log(step.tail);
        }
        for (const warning of summary.warnings ?? []) console.log(`WARN  ${warning}`);
        console.log(summary.ok ? `\n${summary.phase === "commit" ? "COMMIT GATE" : "GATE"}: PASS` : "\nGATE: FAIL");
        if (summary.deferred.length) console.log(`Pending PR checks: ${summary.deferred.map(step => step.name).join(", ")}`);
      }
      return summary.ok ? 0 : 1;
    }
    case "mark-passed": {
      const config = loadConfig();
      const id = args[0];
      if (!id) throw new Error("usage: autobuild mark-passed <ID>");
      const doc = readFeatures(config);
      const feature = featureById(doc, id);
      const failingDeps = (feature.dependencies ?? []).filter((dep) => !featureById(doc, dep).passes);
      if (failingDeps.length > 0) {
        console.error(`${id}: dependencies not passing yet: ${failingDeps.join(", ")}`);
        return 1;
      }
      for (const step of runFeatureTests(config, [feature])) {
        console.log(`=== ${step.name}: ${step.ok ? "PASS" : "FAIL"}`);
        if (!step.ok) {
          console.log(failureExcerpt(step.output, 12000));
          console.error(`${id}: acceptance test failed; passes stays false.`);
          return 1;
        }
      }
      feature.passes = true;
      writeFeatures(config, doc);
      console.log(`${id}: acceptance test passed; ${config.featuresFile} now has passes: true. Commit it with the code (feat(${id}): …).`);
      return 0;
    }
    case "init":
      return init(value(args, "--backend") || process.env.AUTOBUILD_BACKEND || "claude");
    case "evidence": {
      const config = loadConfig();
      const [action, file] = args;
      if (action === "manifest") {
        const json = `${JSON.stringify(evidenceManifest(config.evidenceDir), null, 2)}\n`;
        const out = value(args, "--out");
        if (out) writeFileSync(out, json); else process.stdout.write(json);
        return 0;
      }
      if (action === "verify" && file) {
        const result = verifyEvidence(config.evidenceDir, JSON.parse(readFileSync(file, "utf8")));
        for (const p of result.missing) console.log(`MISSING  ${p}`);
        for (const p of result.changed) console.log(`CHANGED  ${p}`);
        for (const p of result.extra) console.log(`EXTRA    ${p} (not in the manifest)`);
        console.log(result.ok ? "EVIDENCE: MATCHES" : "EVIDENCE: DIFFERS");
        return result.ok ? 0 : 1;
      }
      throw new Error("usage: autobuild evidence manifest [--out FILE] | autobuild evidence verify FILE");
    }
    case "selftest": {
      const result = spawnSync(process.execPath, ["--test", ...readdirSync(path.join(HOME, "test")).filter((f) => f.endsWith(".test.mjs")).map((f) => path.join(HOME, "test", f))], { stdio: "inherit" });
      return result.status ?? 1;
    }
    case undefined:
    case "help":
    case "--help":
    case "-h":
      console.log(HELP);
      return 0;
    default:
      console.error(`Unknown command: ${command}\n\n${HELP}`);
      return 2;
  }
}

function init(backend) {
  if (!["claude", "codex"].includes(backend)) throw new Error("backend must be claude or codex");
  const root = process.cwd();
  const created = [];
  if (!existsSync(path.join(root, CONFIG_FILE))) {
    copyFileSync(path.join(HOME, "templates", "autobuild.json"), path.join(root, CONFIG_FILE));
    if (backend === "codex") {
      const file = path.join(root, CONFIG_FILE);
      const config = JSON.parse(readFileSync(file, "utf8"));
      Object.assign(config, { backend, model: "gpt-6-astra", subagentModel: "gpt-6.1-sol", probeModel: "gpt-6-luna" });
      config.frozen.push("AGENTS.md", ".codex");
      writeFileSync(file, `${JSON.stringify(config, null, 2)}\n`);
    }
    created.push(CONFIG_FILE);
  }
  if (!existsSync(path.join(root, "PROGRESS.md"))) {
    copyFileSync(path.join(HOME, "templates", "PROGRESS.md"), path.join(root, "PROGRESS.md"));
    created.push("PROGRESS.md");
  }
  const claudeMd = path.join(root, "CLAUDE.md");
  const section = readFileSync(path.join(HOME, "templates", "CLAUDE-section.md"), "utf8");
  const existing = existsSync(claudeMd) ? readFileSync(claudeMd, "utf8") : "";
  if (!existing.includes("## Autonomous build")) {
    appendFileSync(claudeMd, `${existing && !existing.endsWith("\n") ? "\n" : ""}\n${section}`);
    created.push("CLAUDE.md (Autonomous build section)");
  }
  if (backend === "codex") {
    const agents = path.join(root, "AGENTS.md");
    const existing = existsSync(agents) ? readFileSync(agents, "utf8") : "";
    if (!existing.includes("## Autobuild with Codex")) {
      appendFileSync(agents, "\n## Autobuild with Codex\nRead CLAUDE.md for the shared project rules. In AUTOBUILD_ACTIVE=1 sessions with AUTOBUILD_BACKEND=codex, leave features.json flags, git staging and commits to the outer harness. Implement, test, and append progress; the harness independently gates and commits. Do not invoke Claude or its hooks.\n");
      created.push("AGENTS.md (Codex rules)");
    }
  }
  const gitignore = path.join(root, ".gitignore");
  const ignore = existsSync(gitignore) ? readFileSync(gitignore, "utf8") : "";
  const missing = ["/logs/", "/.harness/"].filter((entry) => !ignore.split("\n").includes(entry));
  if (missing.length) {
    appendFileSync(gitignore, `${ignore && !ignore.endsWith("\n") ? "\n" : ""}\n# autobuild loop logs and session state\n${missing.join("\n")}\n`);
    created.push(".gitignore entries");
  }
  if (!existsSync(path.join(root, "features.json"))) {
    writeFileSync(path.join(root, "features.json"), `${JSON.stringify({ schemaVersion: 1, features: [] }, null, 2)}\n`);
    created.push("features.json (empty)");
  }
  console.log(created.length ? `Created: ${created.join(", ")}` : "Nothing to create; already initialised.");
  console.log(`Next: fill in ${CONFIG_FILE} (runners, gate, preflight, frozen), write the spec, features and frozen tests, then \`autobuild run --max-iterations 1\` as a dry run.\nThe setup playbook is the /autobuild skill.`);
  return 0;
}

// Compare real paths: the URL form percent-encodes a space or non-ASCII character, the argv path does not.
const isEntry = (() => {
  try {
    return Boolean(process.argv[1]) && realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1]);
  } catch {
    return false;
  }
})();
if (isEntry) {
  main()
    .catch((error) => {
      console.error(error instanceof Error ? error.message : error);
      return 1;
    })
    .then(async (code) => {
      try { await flushDecisionOutput(); } catch { /* Output cannot replace the workflow result. */ }
      process.exit(code ?? 0);
    });
}
