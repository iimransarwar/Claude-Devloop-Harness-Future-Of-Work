// The row above the prompt says what agents are doing: a spinner and a
// running agent's own few words, one agent at a time.
import { describe, expect, mock, test } from 'claude-code/testing'

import { activityText, taskWords } from '../hooks/statusbar'
import { CONFIG, start, world } from './world'

describe('activity row', () => {
  test('no running agent, no activity', async () => {
    expect(activityText([], 3)).toBeNull()
  })

  test('a task reads as at most five words, devloop\'s own name dropped', async () => {
    expect(taskWords('devloop review, round 2')).toBe('review round 2')
    expect(taskWords('Find the snapshot parser and its callers')).toBe('Find the snapshot parser and')
    expect(taskWords('   ')).toBe('working')
  })

  test('the spinner turns each tick; the words turn to the next agent every few ticks', async () => {
    const tasks = ['Review the auth diff', 'Run the gradle tests']
    const first = activityText(tasks, 0)
    expect(first).toEqual({ icon: '⠋', text: '2 agents · Review the auth diff' })
    expect(activityText(tasks, 1)?.icon).toBe('⠙')
    expect(activityText(tasks, 1)?.text).toBe(first?.text)
    expect(activityText(tasks, 8)?.text).toBe('2 agents · Run the gradle tests')
    expect(activityText(tasks, 16)?.text).toBe('2 agents · Review the auth diff')
    expect(activityText(['Explore the repo'], 5)?.text).toBe('Explore the repo')
  })

  test('the row above the prompt shows a running agent\'s words and clears when it ends', async ($, on) => {
    const clock = mock.clock(on, { now: 1_000_000 })
    world(on, CONFIG, { isClockMocked: true })
    let agents = [{ id: 'a1', description: 'Map the snapshot callers', type: 'Explore', status: 'running', kind: 'local_agent', taskStatus: 'running', label: '', startTime: 1_000_000, cwd: '/repo', tokenCount: 0, tokenSamples: [], hasRow: true }]
    on('agent.list', () => ({ value: agents }) as never)
    await start($)
    await clock.advance(1_000)
    const row = async (): Promise<string> => JSON.stringify(await (await $.ui.mount({ plugin: 'devloop', surface: 'terminal', component: 'AbovePrompt', props: { hasSurvey: false } } as never)).findAll({ type: 'Text' }))
    expect(await row()).toContain('Map the snapshot callers')
    agents = []
    await clock.advance(1_000)
    expect(await row()).not.toContain('Map the snapshot callers')
  })
})
