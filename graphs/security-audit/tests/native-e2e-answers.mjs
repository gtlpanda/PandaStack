// native-e2e-answers.mjs - the answers of the fake `codex` leaves of the native end-to-end test: the toy audit's scripted agents (toy-agents.mjs), chosen by
// the agent ID in the prompt and fed the stage input the run has on disk. The fake codex process runs with the leaf's working directory, which is
// `<run>/native-codex/cwd`, so the run is found from there. Not a test file.
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { answer } from './toy-agents.mjs'

const ID = [/agent ID (\S+?)\)/, /Your agent ID is (\S+?);/, /agent ID (\S+?)[ .]/]
export default function answerFor(prompt) {
  const label = ID.map(re => re.exec(prompt)?.[1]).find(Boolean)
  if (!label) throw new Error('no agent ID in the prompt')
  const runDir = join(process.cwd(), '..', '..')
  const stages = join(runDir, 'stages')
  const last = readdirSync(stages).filter(n => /^\d{2,}-/.test(n)).sort().at(-1)
  const input = JSON.parse(readFileSync(join(stages, last, 'input.json'), 'utf8'))
  return answer(label, { stage: input.stage, input })
}
