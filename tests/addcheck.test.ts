import { expect, test } from 'claude-code/testing'
import { start, world } from './world'

test('devloop_add_check adds a check, marks a slow one background, never duplicates', async ($, on) => {
  const w = world(on, { verify: [], mode: 'enforce' })
  await start($)
  const add = async (input: object) => String((await $.tool.call({ tool: 'mcp__devloop__devloop_add_check', ...input } as never)).result)
  expect(await add({ run: 'npm test' })).toMatch(/^Added `npm test`/)
  expect(await add({ run: 'bash tests/e2e.sh', background: true })).toMatch(/as a background check/)
  expect(await add({ run: 'npm test' })).toMatch(/already a check/)
  expect(JSON.parse(w.files['/repo/devloop.json'] ?? '{}').verify).toEqual(['npm test', { run: 'bash tests/e2e.sh', background: true }])
})

test('devloop_add_check refuses a subagent and an empty command', async ($, on) => {
  world(on, { verify: [], mode: 'enforce' })
  await start($)
  expect(String((await $.tool.call({ tool: 'mcp__devloop__devloop_add_check', run: '', } as never)).result)).toMatch(/^Not added/)
  expect(String((await $.tool.call({ tool: 'mcp__devloop__devloop_add_check', run: 'npm test', agentId: 'sub-1' } as never)).result)).toMatch(/Only the main agent/)
})
