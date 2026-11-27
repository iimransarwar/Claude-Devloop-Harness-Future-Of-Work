import { expect, test } from 'claude-code/testing'

import { ACTIONS, failureText } from '../hooks/actions'
import { HELP } from '../hooks/commands'

import { devloop, start, world } from './world'

test('ACTIONS covers every /devloop <word> in HELP except init, plus help', () => {
  const words = new Set([...HELP.matchAll(/^\/devloop ([a-z]+)/gm)].map(m => m[1]))
  words.delete('init'); words.add('help')
  expect(new Set(ACTIONS.map(a => a.name))).toEqual(words)
  expect(ACTIONS.length).toBe(33)
})
test('set up: all 33 register', async ($, on) => {
  const w = world(on); await start($)
  expect(w.registered.filter(n => n.startsWith('devloop-')).length).toBe(33)
})
test('not set up: only the four policy-free ones', async ($, on) => {
  const w = world(on, null); await start($)
  expect(w.registered.filter(n => n.startsWith('devloop-')).sort()).toEqual(['devloop-cache', 'devloop-doctor', 'devloop-help', 'devloop-library'])
})
test('after setup in a session the rest register', async ($, on) => {
  const w = world(on, null); await start($)
  await devloop($, '')
  expect(w.registered).toContain('devloop-review')
})
test('a taken name is skipped and the others still register', async ($, on) => {
  const w = world(on); w.takenCommands = ['devloop-doctor']; await start($)
  expect(w.registered).toContain('devloop-review')
})
test('a menu entry runs the same action with its arguments', async ($, on) => {
  world(on); await start($)
  expect((await $.command.run({ command: 'devloop-help', args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 80 } })).text).toBe(HELP)
})
test('a menu entry passes its arguments through', async ($, on) => {
  world(on); await start($)
  const run = (command: string, args: string) => $.command.run({ command, args, origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 80 } })
  expect((await run('devloop-audit', '5')).text).toBe((await run('devloop', 'audit 5')).text)
})
test('failureText strips the engine lead from a message', () => {
  expect(failureText('x', { kind: 'throw', message: 'devloop: $.fs.exists: disk unavailable.' })).toMatch(/failed: disk unavailable\. If/)
})
test('a person-only action through its entry is refused for the agent as /devloop is', async ($, on) => {
  world(on); await start($)
  const run = (command: string, args: string) => $.command.run({ command, args, origin: { kind: 'sdk' }, presentation: { isFullscreen: false, columns: 80 } })
  expect((await run('devloop-approve', '')).text).toBe((await run('devloop', 'approve')).text)
})
test('failureText names the command and the error, or took too long', () => {
  expect(failureText('verify', { kind: 'throw', message: 'boom' })).toBe('devloop: /devloop verify failed: boom. If it keeps happening, start Claude with --debug and share the log.')
  expect(failureText('verify', { kind: 'timeout' })).toMatch(/failed: took too long\./)
  expect(failureText('', { kind: 'throw', message: 'boom' })).toMatch(/^devloop: \/devloop failed: boom/)
})
test('a throwing /devloop shows the real error, not the engine line', async ($, on) => {
  const w = world(on, null); w.failing['fs.exists'] = 'disk unavailable'; await start($)
  expect(await devloop($, 'init')).toMatch(/^devloop: \/devloop init failed: disk unavailable\. If it keeps/)
})
test('a person typing /devloop in a set-up repo opens the panel', async ($, on) => {
  const w = world(on); await start($); w.opened.length = 0
  await devloop($, '')
  expect(w.opened).toContain('devloop')
})
test('a menu entry or another action answers in the chat and leaves a closed panel closed', async ($, on) => {
  const w = world(on); await start($); w.opened.length = 0
  await $.command.run({ command: 'devloop-help', args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 80 } })
  await $.command.run({ command: 'devloop', args: 'audit 3', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 80 } })
  expect(w.opened).not.toContain('devloop')
})
test('the agent running /devloop does not open the panel', async ($, on) => {
  const w = world(on); await start($); w.opened.length = 0
  await devloop($, '', { kind: 'sdk' })
  expect(w.opened).not.toContain('devloop')
})
test('a ui.open that throws leaves the command answer unchanged', async ($, on) => {
  const w = world(on); await start($)
  const before = await devloop($, 'help')
  w.failOpen = true
  expect(await devloop($, 'help')).toBe(before)
})
test('a person in a repo not set up does not get the panel from doctor', async ($, on) => {
  const w = world(on, null); await start($); w.opened.length = 0
  await devloop($, 'doctor')
  expect(w.opened).not.toContain('devloop')
})
test('a menu entry whose command throws shows the readable failure (doctor reaches fs.exists)', async ($, on) => {
  const w = world(on, null); w.failing['fs.exists'] = 'disk unavailable'; await start($)
  const r = await $.command.run({ command: 'devloop-doctor', args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 80 } })
  expect(r.text).toMatch(/^devloop: \/devloop doctor failed: disk unavailable\. If it keeps/)
})

test('the panel\'s Close button closes the Dev loop panel', async ($, on) => {
  const w = world(on); await start($)
  const ui = await $.ui.mount({ plugin: 'devloop', surface: 'terminal', component: 'Pane', requestId: 'devloop', props: { title: 'Dev loop', isFocused: true, bodyColumns: 80, placement: 'dock', scroll: { offset: 0, bodyRows: 40 }, view: {}, id: 'devloop', plugin: 'devloop' } } as never)
  await ui.press({ key: 'close' })
  await Promise.resolve(); await Promise.resolve()
  expect(w.closed).toContain('devloop')
})
