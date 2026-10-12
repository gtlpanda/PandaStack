// The settings file injected into every session.
import assert from "node:assert/strict";
import { test } from "node:test";
import { sessionSettings } from "../lib/loop.mjs";

const config = { hooks: "inject", frozen: ["tests"], writable: [], subagentModel: "claude-haiku-4-5-20251001" };

test("the subagent model is set through the injected settings, so a user-level pin cannot override it", () => {
  // Settings `env` beats the process environment, and --settings beats ~/.claude/settings.json.
  const { env } = sessionSettings(config);
  assert.equal(env.CLAUDE_CODE_SUBAGENT_MODEL, "claude-haiku-4-5-20251001");
  assert.equal(env.CLAUDE_CODE_SUBAGENT_MODEL_FORCE, "1");
  assert.equal(env.CLAUDE_CODE_WORKFLOW_SUBAGENT_MODEL, "claude-haiku-4-5-20251001");
});
