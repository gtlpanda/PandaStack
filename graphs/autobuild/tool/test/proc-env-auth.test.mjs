import assert from "node:assert/strict";
import { test } from "node:test";
import { buildEnv } from "../lib/proc.mjs";

const AUTH = {
  CLAUDE_CODE_OAUTH_TOKEN: "token",
  CLAUDE_CODE_USE_BEDROCK: "1",
  CLAUDE_CODE_USE_VERTEX: "1",
};
const IDENTITY = { CLAUDECODE: "1", CLAUDE_CODE_ENTRYPOINT: "cli", CLAUDE_PID: "9", CLAUDE_EFFORT: "high" };

test("buildEnv keeps auth and provider variables and drops session identity", () => {
  const saved = { ...process.env };
  Object.assign(process.env, AUTH, IDENTITY);
  let env;
  try {
    env = buildEnv({ env: {} });
  } finally {
    for (const key of Object.keys({ ...AUTH, ...IDENTITY })) {
      if (key in saved) process.env[key] = saved[key];
      else delete process.env[key];
    }
  }
  for (const [key, value] of Object.entries(AUTH)) {
    assert.equal(env[key], value, `BUGHUNT-F10 buildEnv stripped ${key}, so an unattended claude -p has no credentials`);
  }
  for (const key of Object.keys(IDENTITY)) {
    assert.equal(env[key], undefined, `BUGHUNT-F10 buildEnv should still drop ${key}`);
  }
});
