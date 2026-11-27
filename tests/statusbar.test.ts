import { expect, test } from 'claude-code/testing'

import type { Loop } from '../types'
import { DEFAULTS } from '../hooks/config'
import type { Step } from '../hooks/config'
import { FRESH } from '../hooks/fresh'
import type { Check } from '../hooks/gate'
import { barParts } from '../hooks/statusbar'

import { change, devloop, start, stop, world } from './world'

const step = (run: string): Step => ({ run, profile: 'full', when: null })
const CHANGED = ['src/a.ts']
const PASSING = { ...FRESH.verify, status: 'pass' as const }

test('no row when idle with no change', () => {
  expect(barParts({ ...FRESH, phase: 'idle', changed: [] } as Loop, DEFAULTS, [])).toBeNull()
})
test('small fix, tests passed in green, review not run dim, gate counts, risk colored', () => {
  const checks: Check[] = [{ label: 'a', isMet: true, note: '' }, { label: 'b', isMet: false, note: '' }]
  const p = barParts({ ...FRESH, phase: 'idle', changed: ['hooks/gate.ts', 'devloop.json'], verify: PASSING } as Loop, { ...DEFAULTS, verify: [step('npm test')] }, checks)!
  expect(p.phase).toBe('Small fix')
  expect(p.tests).toEqual({ text: '✓ passed', color: 'success' })
  expect(p.review).toEqual({ text: 'not run', color: 'subtle' })
  expect(p.gate).toEqual({ met: 1, total: 2 })
  expect(p.risk).toEqual({ text: 'high', color: 'error' })
})
test('no test command reads not set, not "not run"', () => {
  const p = barParts({ ...FRESH, changed: CHANGED } as Loop, { ...DEFAULTS, verify: [] }, [])!
  expect(p.tests).toEqual({ text: 'not set', color: 'subtle' })
})
test('failing tests are red; build phase shows features', () => {
  const p = barParts({ ...FRESH, phase: 'build', spec: 'login', changed: CHANGED, verify: { ...FRESH.verify, status: 'fail' } } as Loop, { ...DEFAULTS, verify: [step('npm test')] }, [])!
  expect(p.tests.color).toBe('error')
  expect(p.phase).toMatch(/^Building "login" · \d+\/\d+ features$/)
})
test('low risk hides review', () => {
  expect(barParts({ ...FRESH, changed: ['README.md'] } as Loop, { ...DEFAULTS, verify: [step('x')] }, [])!.review).toBeNull()
})
test('the pinned status line is no longer set (no doubled devloop:)', async ($, on) => {
  const w = world(on); await start($); await devloop($, 'status')
  expect(w.statusLines.some(line => line?.includes('devloop:') === true)).toBe(false)
  expect(w.statusLines.length === 0 || w.statusLines[w.statusLines.length - 1] === undefined).toBe(true)
})
test('the AbovePrompt row shows the phase and passing tests', async ($, on) => {
  const w = world(on); await start($)
  change(w, 'src/a.ts')
  await stop($)
  await devloop($, 'verify')
  const ui = await $.ui.mount({ plugin: 'devloop', surface: 'terminal', component: 'AbovePrompt', props: { hasSurvey: false } } as never)
  const text = JSON.stringify(await ui.findAll({ type: 'Text' }))
  expect(text).toContain('Small fix')
  expect(text).toContain('✓ passed')
})

test('both panes open with a transparent background', async ($, on) => {
  const w = world(on); await start($); w.openArgs.length = 0
  await devloop($, ''); await devloop($, 'settings')
  expect(w.openArgs.map(a => a.backgroundColor)).toEqual(['transparent', 'transparent'])
})
test('the Dev loop pane uses no dimColor', async ($, on) => {
  world(on); await start($)
  const ui = await $.ui.mount({ plugin: 'devloop', surface: 'terminal', component: 'Pane', requestId: 'devloop', props: { title: 'Dev loop', isFocused: true, bodyColumns: 80, placement: 'dock', scroll: { offset: 0, bodyRows: 40 }, view: {}, id: 'devloop', plugin: 'devloop' } } as never)
  expect((await ui.findAll({ type: 'Text' })).some(t => t.props.dimColor === true)).toBe(false)
})
