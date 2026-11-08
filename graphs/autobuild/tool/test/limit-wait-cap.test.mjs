// The limit-wait cap (limits.maxLimitWaitHours) must hold when the reset time is unknown and the
// probe model is available while the real session keeps hitting the limit.
import assert from "node:assert/strict";
import { test } from "node:test";

import { project, run } from "../test-fixtures/project.mjs";

test("probe retries stop with exit 8 once maxLimitWaitHours is spent", () => {
  // 0.0003 h is about 1.1 s of waiting; the harness caps every sleep at 300 ms.
  const root = project(["F-1"], { maxLimitWaitHours: 0.0003 });
  const script = [];
  for (let i = 0; i < 25; i += 1) script.push({ limit: "You've hit your session limit" }, { ok: true });
  const { code, calls, loopLog } = run(root, script);
  assert.equal(
    code,
    8,
    `BUGHUNT-F4 the loop kept probing and retrying past the wait cap instead of exiting 8 (exit ${code}, ${calls.length} fake claude calls)\n${loopLog}`,
  );
});
