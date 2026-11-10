import { readFileSync } from 'node:fs'
import { createDecisionQueue } from '../core/skills/decisions/queue.mjs'
import { queueError } from '../core/skills/decisions/queue-storage.mjs'
import { MAX_WAIT_MS, waitForDecision } from '../core/skills/decisions/routing.mjs'

const commands = {
  request: { required: ['store', 'file'], optional: [] },
  list: { required: ['store'], optional: ['repo', 'run-id'] },
  show: { required: ['store', 'id'], optional: [] },
  answer: { required: ['store', 'id', 'file'], optional: [] },
  wait: { required: ['store', 'id', 'file'], optional: ['timeout-ms'] },
  ack: { required: ['store', 'id', 'file'], optional: [] },
  cancel: { required: ['store', 'id', 'reason'], optional: [] },
}
const codes = new Set(['INVALID_DECISION', 'CONFLICT', 'NOT_FOUND', 'WRONG_RECIPIENT', 'STALE',
  'EXPIRED', 'CANCELLED', 'NOT_READY', 'CORRUPT', 'IO_ERROR', 'TIMEOUT', 'MANUAL_HANDOFF'])

function parse(args) {
  const [command] = args
  if (!Object.hasOwn(commands, command)) throw queueError('INVALID_DECISION')
  const { required, optional } = commands[command], values = {}
  for (let i = 1; i < args.length; i += 2) {
    const flag = args[i], value = args[i + 1]
    const key = typeof flag === 'string' && flag.startsWith('--') ? flag.slice(2) : ''
    if (![...required, ...optional].includes(key) || Object.hasOwn(values, key) ||
        typeof value !== 'string' || !value.length || value.startsWith('--')) throw queueError('INVALID_DECISION')
    values[key] = value
  }
  if (required.some(key => !Object.hasOwn(values, key))) throw queueError('INVALID_DECISION')
  if (Object.hasOwn(values, 'timeout-ms')) {
    const text = values['timeout-ms'], number = Number(text)
    if (/^[0-9]+$/.exec(text)?.[0] !== text || !Number.isSafeInteger(number) || number > MAX_WAIT_MS) throw queueError('INVALID_DECISION')
    values.timeoutMs = number
  }
  return { command, values }
}

function readInput(file) {
  let text
  try { text = readFileSync(file, 'utf8') } catch { throw queueError('IO_ERROR') }
  try { return JSON.parse(text) } catch { throw queueError('INVALID_DECISION') }
}

export async function decisionMain(args) {
  try {
    const { command, values: v } = parse(args)
    const input = v.file === undefined ? undefined : readInput(v.file)
    const queue = createDecisionQueue(v.store)
    let result
    try {
      switch (command) {
        case 'request': result = queue.request(input); break
        case 'list': result = queue.list({ ...(v.repo === undefined ? {} : { repo: v.repo }),
          ...(v['run-id'] === undefined ? {} : { runId: v['run-id'] }) }); break
        case 'show': result = queue.read(v.id); break
        case 'answer': result = queue.answer(v.id, input); break
        case 'wait': result = await waitForDecision({ queue, id: v.id, recipient: input, timeoutMs: v.timeoutMs }); break
        case 'ack': result = queue.acknowledge(v.id, input); break
        case 'cancel': result = queue.cancel(v.id, { reason: v.reason }); break
      }
    } finally { queue.close() }
    console.log(JSON.stringify(result))
    return 0
  } catch (error) {
    console.error(JSON.stringify({ error: codes.has(error?.code) ? error.code : 'IO_ERROR' }))
    return 1
  }
}
