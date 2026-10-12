// The settings file injected into every session.
import assert from "node:assert/strict";
import { test } from "node:test";
import { sessionSettings } from "../lib/loop.mjs";

const config = { hooks: "inject", frozen: ["tests"], writable: [], subagentModel: "claude-haiku-5-5" };

test("the subagent model is set through the injected settings, so a user-level pin cannot override it", () => {
  // Settings `env` beats the process environment, and --settings beats ~/.claude/settings.json.
  const { env } = sessionSettings(config);
  assert.equal(env.CLAUDE_CODE_SUBAGENT_MODEL, "claude-haiku-5-5");
  assert.equal(env.CLAUDE_CODE_SUBAGENT_MODEL_FORCE, "1");
  assert.equal(env.CLAUDE_CODE_WORKFLOW_SUBAGENT_MODEL, "claude-haiku-5-5");
});

test("subagentModelForce: false makes the model a default that a single Agent call may override", () => {
  // Proven with real claude: FORCE=0 ran an unspecified subagent on the default and a `model: "sonnet"` call on Sonnet.
  assert.equal(sessionSettings({ ...config, subagentModelForce: false }).env.CLAUDE_CODE_SUBAGENT_MODEL_FORCE, "0");
  assert.equal(sessionSettings({ ...config, subagentModelForce: true }).env.CLAUDE_CODE_SUBAGENT_MODEL_FORCE, "1");
});
