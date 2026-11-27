import { describe, expect, test } from 'claude-code/testing'

import { applyChanges, changedKeys, effectLine, readSettings } from '../hooks/settings'
import type { RowKey, SettingsView } from '../hooks/settings'

import { devloop, start, world } from './world'

const BASE = '{\n  "mode": "observe",\n  "defaultBranch": "main",\n  "verify": ["npm test"],\n  "zeta": 1\n}\n'

describe('settings model', () => {
  test('readSettings shows effective values with defaults filled in', () => {
    const v = readSettings(BASE) as SettingsView
    const row = (k: RowKey) => v.rows.find(r => r.key === k)!
    expect(row('mode').current).toBe('observe')
    expect(row('approvals').current).toBe('two')
    expect(row('grounding').current).toBe('same')
    expect(row('learning').current).toBe('trial')
    expect(row('tests').current).toBe('npm test')
  })
  test('approvals: {0,1,1} is me, {0,1,2} two, anything else custom', () => {
    const at = (a: object) => (readSettings(JSON.stringify({ approvals: a })) as SettingsView).rows.find(r => r.key === 'approvals')!.current
    expect(at({ low: 0, medium: 1, high: 1 })).toBe('me')
    expect(at({ low: 0, medium: 1, high: 2 })).toBe('two')
    expect(at({ low: 0, medium: 2, high: 3 })).toBe('custom')
  })
  test('an invalid value shows the Invalid option and its error', () => {
    const v = readSettings('{ "testing": { "scope": "sometimes" } }') as SettingsView
    const row = v.rows.find(r => r.key === 'scope')!
    expect(row.current).toBe('invalid')
    expect(row.options.some(o => o.label === 'Invalid in devloop.json: sometimes')).toBe(true)
    expect(row.error).not.toBeNull()
  })
  test('text that is not one JSON object is an error', () => {
    expect('error' in readSettings('{ nope')).toBe(true)
  })
  test('applyChanges writes only changed keys, keeps order and unknown fields', () => {
    const out = applyChanges(BASE, { mode: 'enforce', learning: 'off' })
    expect(Object.keys(JSON.parse(out))).toEqual(['mode', 'defaultBranch', 'verify', 'zeta', 'learning'])
    expect(JSON.parse(out)).toMatchObject({ mode: 'enforce', zeta: 1, learning: { auto: 'off' } })
    expect(out.endsWith('}\n')).toBe(true)
  })
  test('applyChanges merges nested objects and maps option values', () => {
    const text = '{ "learning": { "auto": "trial", "repeats": 5 } }'
    expect(JSON.parse(applyChanges(text, { learning: 'propose' })).learning).toEqual({ auto: 'propose', repeats: 5 })
    expect(JSON.parse(applyChanges('{}', { approvals: 'me' })).approvals).toEqual({ low: 0, medium: 1, high: 1 })
    expect(JSON.parse(applyChanges('{}', { autoReview: 'false' })).autoReview).toBe(false)
    expect('mode' in (JSON.parse(applyChanges('{ "grounding": { "mode": "off" } }', { grounding: 'same' })).grounding ?? {})).toBe(false)
    expect(JSON.parse(applyChanges('{ "verify": ["a"] }', { verify: [] })).verify).toEqual([])
  })
  test('custom and invalid are never written', () => {
    expect(applyChanges(BASE, { approvals: 'custom', scope: 'invalid' })).toBe(BASE)
  })
  test('changedKeys names devloop.json paths', () => {
    expect(changedKeys({ mode: 'enforce', learning: 'off', verify: [] })).toEqual(['mode', 'learning.auto', 'verify'])
  })
  test('a bad parent shows the value it holds, not undefined', () => {
    const view = readSettings('{"learning":"yes"}') as SettingsView
    const row = view.rows.find(one => one.key === 'learning')
    expect(row?.current).toBe('invalid')
    expect(row?.options.at(-1)?.label).toBe('Invalid in devloop.json: yes')
  })
  test('Same as mode over a grounding that is not an object replaces it, and is listed', () => {
    const text = '{"grounding":"bad","mode":"observe"}'
    expect(changedKeys({ grounding: 'same' })).toEqual(['grounding.mode'])
    expect(JSON.parse(applyChanges(text, { grounding: 'same' }))).toEqual({ grounding: {}, mode: 'observe' })
  })
  test('effectLine with the governing copy unknown never says now', () => {
    expect(effectLine('main', null, false)).toBe('devloop will use these settings once they are in force.')
    expect(effectLine('main', null, true)).toBe('Saved to devloop.json. devloop will use these settings once they are in force.')
  })
  test('effectLine', () => {
    expect(effectLine('main', false, true)).toBe('Saved. devloop uses these settings now.')
    expect(effectLine('main', true, true)).toBe("Saved to devloop.json. devloop keeps using main's copy until you commit this change to main.")
    expect(effectLine('main', true, false)).toBe("devloop keeps using main's copy until you commit this change to main.")
  })
})

// ---------------------------------------------------------------- the popup

const MOUNT = {
  plugin: 'devloop', surface: 'terminal' as const, component: 'Pane' as const, requestId: 'devloop-settings',
  props: { title: 'devloop settings', isFocused: true, bodyColumns: 80, placement: 'dock' as const, scroll: { offset: 0, bodyRows: 40 }, view: {}, id: 'devloop-settings', plugin: 'devloop' },
}
const HOME = '/home/u'

describe('settings popup', () => {
  test('a person opens settings in a set-up repo', async ($, on) => {
    const w = world(on); await start($); w.opened.length = 0
    expect(await devloop($, 'settings')).toBe('Settings are open.')
    // Only the settings pane, not the Dev loop pane.
    expect(w.opened).toEqual(['devloop-settings'])
    expect(w.openArgs.at(-1)).toEqual({ id: 'devloop-settings', title: 'devloop settings', focus: true, closeOnEscape: true, backgroundColor: 'transparent' })
  })
  test('a person opens settings from the menu entry too', async ($, on) => {
    const w = world(on); await start($); w.opened.length = 0
    const run = await $.command.run({ command: 'devloop-settings', args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 80 } })
    expect(run.text).toBe('Settings are open.')
    expect(w.opened).toEqual(['devloop-settings'])
  })
  test('the agent cannot open settings, by either command', async ($, on) => {
    const w = world(on); await start($); w.opened.length = 0
    expect(await devloop($, 'settings', { kind: 'sdk' })).toBe("Settings are a person's: type /devloop settings.")
    const run = await $.command.run({ command: 'devloop-settings', args: '', origin: { kind: 'sdk' }, presentation: { isFullscreen: false, columns: 80 } })
    expect(run.text).toBe("Settings are a person's: type /devloop settings.")
    expect(w.opened).toEqual([])
  })
  test('in a repo not set up, settings runs setup', async ($, on) => {
    world(on, null); await start($)
    expect((await devloop($, 'settings')).split('\n')[0]).toBe('devloop is set up.')
  })
  test('pick, save: devloop.json changes, audit written, panel closes', async ($, on) => {
    // The world's devloop.json is in enforce mode, so the pick is observe.
    const w = world(on); await start($); await devloop($, 'settings')
    const ui = await $.ui.mount(MOUNT)
    expect(await ui.find({ text: /• Mode/ })).toBeUndefined()
    await ui.select({ key: 'row-mode', value: 'observe' })
    expect(await ui.find({ text: /• Mode/ })).toBeDefined()
    await ui.press({ key: 'save' })
    expect(JSON.parse(w.files['/repo/devloop.json'] ?? '{}').mode).toBe('observe')
    expect(await devloop($, 'audit 3')).toMatch(/settings-changed[\s\S]*mode/)
    expect(w.closed).toEqual(['devloop-settings'])
    // The world's base branch holds a devloop.json, so the change waits for it.
    expect(w.toasts).toContain("Saved to devloop.json. devloop keeps using main's copy until you commit this change to main.")
  })
  test('with no devloop.json on the base branch, Save says it applies now', async ($, on) => {
    const w = world(on); w.basePolicy = null; await start($); await devloop($, 'settings')
    const ui = await $.ui.mount(MOUNT)
    expect(await ui.find({ text: 'devloop uses these settings now.' })).toBeDefined()
    await ui.select({ key: 'row-autoReview', value: 'false' })
    await ui.press({ key: 'save' })
    expect(JSON.parse(w.files['/repo/devloop.json'] ?? '{}').autoReview).toBe(false)
    expect(w.toasts).toContain('Saved. devloop uses these settings now.')
  })
  test('picking the value it opened with again is no change', async ($, on) => {
    const w = world(on); await start($); const before = w.files['/repo/devloop.json']; await devloop($, 'settings')
    const ui = await $.ui.mount(MOUNT)
    await ui.select({ key: 'row-mode', value: 'observe' })
    await ui.select({ key: 'row-mode', value: 'enforce' })
    expect(await ui.find({ text: /• Mode/ })).toBeUndefined()
    await ui.press({ key: 'save' })
    expect(w.files['/repo/devloop.json']).toBe(before)
  })
  test('reopening after save shows the saved value', async ($, on) => {
    const w = world(on); await start($); await devloop($, 'settings')
    let ui = await $.ui.mount(MOUNT); await ui.select({ key: 'row-learning', value: 'off' }); await ui.press({ key: 'save' })
    await devloop($, 'settings'); await ui.unmount(); ui = await $.ui.mount(MOUNT)
    expect(await ui.find({ key: 'row-learning' })).toMatchObject({ props: { value: 'off' } })
    expect(await ui.find({ text: /• Learn from mistakes/ })).toBeUndefined()
    expect(JSON.parse(w.files['/repo/devloop.json'] ?? '{}').learning.auto).toBe('off')
  })
  test('cancel after a pick writes nothing and drops the draft', async ($, on) => {
    const w = world(on); await start($); const before = w.files['/repo/devloop.json']
    await devloop($, 'settings'); let ui = await $.ui.mount(MOUNT)
    await ui.select({ key: 'row-mode', value: 'observe' }); await ui.press({ key: 'cancel' })
    expect(w.files['/repo/devloop.json']).toBe(before)
    expect(w.closed).toEqual(['devloop-settings'])
    // Drawn again without opening it again: Cancel left no draft.
    await ui.unmount(); ui = await $.ui.mount(MOUNT)
    expect(await ui.find({ text: /• Mode/ })).toBeUndefined()
    expect(await ui.find({ key: 'row-mode' })).toMatchObject({ props: { value: 'enforce' } })
  })
  test('a draft left behind is never shown when settings open again', async ($, on) => {
    // As after an Esc, which the kit cannot raise (its engine has no ui.close): the popup was left with a pick in it.
    const w = world(on); await start($); const before = w.files['/repo/devloop.json']
    await devloop($, 'settings'); let ui = await $.ui.mount(MOUNT)
    await ui.select({ key: 'row-mode', value: 'observe' })
    await devloop($, 'settings'); await ui.unmount(); ui = await $.ui.mount(MOUNT)
    expect(await ui.find({ text: /• Mode/ })).toBeUndefined()
    expect(await ui.find({ key: 'row-mode' })).toMatchObject({ props: { value: 'enforce' } })
    expect(w.files['/repo/devloop.json']).toBe(before)
  })
  test('unreadable devloop.json: error shown, only Cancel, file untouched', async ($, on) => {
    const w = world(on); w.files['/repo/devloop.json'] = '{ nope'; await start($)
    await devloop($, 'settings'); const ui = await $.ui.mount(MOUNT)
    expect(await ui.find({ key: 'save' })).toBeUndefined()
    expect(await ui.find({ key: 'row-mode' })).toBeUndefined()
    expect(await ui.find({ key: 'cancel' })).toBeDefined()
    expect((await ui.findAll({ type: 'Text' })).some(one => one.props.color === 'error' && /devloop\.json/.test(one.text))).toBe(true)
    await ui.press({ key: 'cancel' })
    expect(w.files['/repo/devloop.json']).toBe('{ nope')
  })
  test('an invalid value shows selected as Invalid, with its error under the row', async ($, on) => {
    world(on, { verify: ['npm test'], mode: 'enforce', testing: { scope: 'sometimes' } }); await start($); await devloop($, 'settings')
    const ui = await $.ui.mount(MOUNT)
    expect(await ui.find({ key: 'row-scope' })).toMatchObject({ props: { value: 'invalid' } })
    expect((await ui.findAll({ type: 'Text' })).some(one => one.props.color === 'error' && /testing\.scope/.test(one.text))).toBe(true)
  })
  test('the footer and effect line are shown', async ($, on) => {
    world(on); await start($); await devloop($, 'settings'); const ui = await $.ui.mount(MOUNT)
    expect(await ui.find({ text: /Tiers, protected paths, reviewers and the rest: edit devloop\.json\./ })).toBeDefined()
    // The world's base branch holds a devloop.json.
    expect(await ui.find({ type: 'Text', text: "devloop keeps using main's copy until you commit this change to main." })).toMatchObject({ props: { color: 'subtle' } })
  })
  test('every row is drawn with its label, the tests row with its checks and a Change button', async ($, on) => {
    world(on); await start($); await devloop($, 'settings'); const ui = await $.ui.mount(MOUNT)
    for (const label of ['Mode', 'Tests', 'Which tests', 'Auto review', 'Risky merges', 'Check before answering', 'Learn from mistakes', 'Save specs to library', 'cache-guard']) {
      expect(await ui.find({ type: 'Text', text: new RegExp(`^ ${label}`) })).toBeDefined()
    }
    expect(await ui.find({ key: 'row-mode' })).toMatchObject({ props: { value: 'enforce', options: [{ value: 'observe', label: 'Watch only' }, { value: 'enforce', label: 'Block' }] } })
    expect(await ui.find({ text: /npm test/ })).toBeDefined()
    expect(await ui.find({ key: 'tests-change' })).toMatchObject({ type: 'Button', props: { label: 'Change' } })
  })
  test('cache-guard: without Python it says so and draws no button', async ($, on) => {
    world(on); await start($); await devloop($, 'settings'); const ui = await $.ui.mount(MOUNT)
    expect(await ui.find({ text: /needs Python 3\.8\+/ })).toBeDefined()
    expect(await ui.find({ key: 'cache-install' })).toBeUndefined()
    expect(await ui.find({ key: 'cache-remove' })).toBeUndefined()
  })
  test('cache-guard: not installed draws Install, installed draws Remove', async ($, on) => {
    const w = world(on); w.pythonVersion = '3.12'; await start($); await devloop($, 'settings')
    let ui = await $.ui.mount(MOUNT)
    expect(await ui.find({ text: /not installed/ })).toBeDefined()
    expect(await ui.find({ key: 'cache-install' })).toMatchObject({ props: { label: 'Install' } })
    w.files[`${HOME}/.claude/cache-guard/config.json`] = '{}'
    w.files[`${HOME}/.claude/settings.json`] = JSON.stringify({ statusLine: { type: 'command', command: `python3 "${HOME}/.claude/cache-guard/cache_guard.py" statusline` } })
    await devloop($, 'settings'); await ui.unmount(); ui = await $.ui.mount(MOUNT)
    expect(await ui.find({ key: 'cache-remove' })).toMatchObject({ props: { label: 'Remove' } })
    expect(await ui.find({ key: 'cache-install' })).toBeUndefined()
  })
  test('only theme keys color the popup', async ($, on) => {
    world(on); await start($); await devloop($, 'settings'); const ui = await $.ui.mount(MOUNT)
    await ui.select({ key: 'row-mode', value: 'observe' })
    const texts = await ui.findAll({ type: 'Text' })
    expect(texts.some(one => one.text === '•' && one.props.color === 'suggestion')).toBe(true)
    expect(texts.every(one => one.props.dimColor === undefined)).toBe(true)
    expect(texts.every(one => one.props.color === undefined || ['suggestion', 'error', 'subtle', 'text'].includes(one.props.color as string))).toBe(true)
  })
  test('Change → Keep the current checks leaves the draft alone', async ($, on) => {
    const w = world(on); w.answer = 'Keep the current checks'; await start($); await devloop($, 'settings')
    const ui = await $.ui.mount(MOUNT); await ui.press({ key: 'tests-change' })
    expect(await ui.find({ text: /• Tests/ })).toBeUndefined()
  })
  test('Change → typed command replaces verify on Save', async ($, on) => {
    const w = world(on); w.answer = 'make check'; await start($); await devloop($, 'settings')
    const ui = await $.ui.mount(MOUNT); await ui.press({ key: 'tests-change' })
    expect(await ui.find({ text: /• Tests/ })).toBeDefined()
    await ui.press({ key: 'save' })
    expect(JSON.parse(w.files['/repo/devloop.json'] ?? '{}').verify).toEqual(['make check'])
  })
  test('Change → None for now empties verify, only after Save', async ($, on) => {
    const w = world(on); w.answer = 'None for now'; await start($); await devloop($, 'settings')
    const before = w.files['/repo/devloop.json']
    const ui = await $.ui.mount(MOUNT); await ui.press({ key: 'tests-change' })
    expect(w.files['/repo/devloop.json']).toBe(before)
    await ui.press({ key: 'save' })
    expect(JSON.parse(w.files['/repo/devloop.json'] ?? '{}').verify).toEqual([])
  })
  test('Change warns when it would replace scoped or full checks', async ($, on) => {
    const w = world(on); w.files['/repo/devloop.json'] = JSON.stringify({ verify: ['a', { run: 'b', profile: 'full' }] }); w.answer = 'Keep the current checks'
    await start($); await devloop($, 'settings')
    const ui = await $.ui.mount(MOUNT); await ui.press({ key: 'tests-change' })
    expect(w.questions.at(-1)).toMatch(/This replaces your 2 checks, including ones that run before shipping or only for some files\./)
  })
  test('cache-guard Install asks its own confirmation and runs --all', async ($, on) => {
    const w = world(on); w.pythonVersion = '3.12'; w.answer = 'Install it'; await start($); await devloop($, 'settings')
    const ui = await $.ui.mount(MOUNT); await ui.press({ key: 'cache-install' })
    expect(w.cacheInstalls).toEqual([['install', '--all', '--keepwarm']])
  })
  test('cache-guard Install declined changes nothing', async ($, on) => {
    const w = world(on); w.pythonVersion = '3.12'; w.answer = 'Leave it'; await start($); await devloop($, 'settings')
    const ui = await $.ui.mount(MOUNT); await ui.press({ key: 'cache-install' })
    expect(w.cacheInstalls).toEqual([])
  })
  test('a pick is kept when devloop.json changed while the popup was open', async ($, on) => {
    const w = world(on); await start($); await devloop($, 'settings')
    const ui = await $.ui.mount(MOUNT)
    // Opened on enforce; a hand edit makes it observe; picking enforce is now a change.
    w.files['/repo/devloop.json'] = JSON.stringify({ ...JSON.parse(w.files['/repo/devloop.json'] ?? '{}'), mode: 'observe' })
    await ui.select({ key: 'row-mode', value: 'enforce' })
    await ui.press({ key: 'save' })
    expect(JSON.parse(w.files['/repo/devloop.json'] ?? '{}').mode).toBe('enforce')
  })
  test('a pick keeps the base branch as the policy in force', async ($, on) => {
    // Working copy observes; the base branch's copy enforces and governs.
    const w = world(on, { verify: ['npm test'], mode: 'observe' }); w.basePolicy = JSON.stringify({ verify: ['npm test'], mode: 'enforce' })
    await start($); await devloop($, 'settings')
    const ui = await $.ui.mount(MOUNT)
    expect(await ui.find({ type: 'Text', text: /keeps using main's copy/ })).toBeDefined()
    await ui.select({ key: 'row-learning', value: 'off' })
    expect(await ui.find({ type: 'Text', text: /keeps using main's copy/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /uses these settings now/ })).toBeUndefined()
  })
  test('only on the base branch: Cancel only, and it says how to restore the file', async ($, on) => {
    const w = world(on); w.basePolicy = JSON.stringify({ verify: ['npm test'], mode: 'enforce' }); delete w.files['/repo/devloop.json']
    await start($); await devloop($, 'settings')
    const ui = await $.ui.mount(MOUNT)
    expect(await ui.find({ type: 'Text', text: 'devloop.json is only on main. Restore it to this working tree (git checkout main -- devloop.json), then open settings again.' })).toBeDefined()
    expect(await ui.find({ key: 'save' })).toBeUndefined()
  })
  test('cache-guard Remove runs uninstall after its own confirmation', async ($, on) => {
    const w = world(on); w.pythonVersion = '3.12'; w.answer = 'Uninstall it'
    w.files[`${HOME}/.claude/cache-guard/config.json`] = '{}'
    w.files[`${HOME}/.claude/settings.json`] = JSON.stringify({ statusLine: { type: 'command', command: `python3 "${HOME}/.claude/cache-guard/cache_guard.py" statusline` } })
    await start($); await devloop($, 'settings')
    const ui = await $.ui.mount(MOUNT); await ui.press({ key: 'cache-remove' })
    expect(w.cacheInstalls).toEqual([['uninstall']])
  })
  test('Change offers the detected commands, and picking them is saved', async ($, on) => {
    const w = world(on); w.files['/repo/package.json'] = JSON.stringify({ scripts: { test: 'vitest' } }); w.answer = 'npm test --silent'
    w.files['/repo/devloop.json'] = JSON.stringify({ verify: ['make check'], mode: 'enforce' })
    await start($); await devloop($, 'settings')
    const ui = await $.ui.mount(MOUNT); await ui.press({ key: 'tests-change' })
    expect(w.questions.length).toBeGreaterThan(0)
    expect(await ui.find({ text: /• Tests/ })).toBeDefined()
    await ui.press({ key: 'save' })
    expect(JSON.parse(w.files['/repo/devloop.json'] ?? '{}').verify).toEqual(['npm test --silent'])
  })
  test('Risky merges Custom is selected and left alone by a Save', async ($, on) => {
    const w = world(on); w.files['/repo/devloop.json'] = JSON.stringify({ verify: ['npm test'], mode: 'enforce', approvals: { low: 0, medium: 2, high: 3 } })
    await start($); await devloop($, 'settings')
    const ui = await $.ui.mount(MOUNT)
    expect(await ui.find({ key: 'row-approvals' })).toMatchObject({ props: { value: 'custom' } })
    expect(((await ui.find({ key: 'row-approvals' }))?.props.options as { label: string }[]).map(one => one.label)).toContain('Custom (as in devloop.json)')
    await ui.select({ key: 'row-mode', value: 'observe' }); await ui.press({ key: 'save' })
    const saved = JSON.parse(w.files['/repo/devloop.json'] ?? '{}')
    expect(saved.mode).toBe('observe')
    expect(saved.approvals).toEqual({ low: 0, medium: 2, high: 3 })
  })
})
