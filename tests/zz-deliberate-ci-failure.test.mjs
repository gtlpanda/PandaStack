// Deliberate failure to prove the sharded CI's required "test" job fails when one shard fails.
// Reverted in the next commit.
import { test } from '../scripts/workflow-harness.mjs'
await test('deliberate failure: the test aggregator must go red', () => { throw new Error('deliberate') })
