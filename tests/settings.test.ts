import { describe, expect, test } from 'claude-code/testing'

import { applyChanges, changedKeys, effectLine, readSettings } from '../hooks/settings'
import type { RowKey, SettingsView } from '../hooks/settings'

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
  test('effectLine', () => {
    expect(effectLine('main', false, true)).toBe('Saved. devloop uses these settings now.')
    expect(effectLine('main', true, true)).toBe("Saved to devloop.json. devloop keeps using main's copy until you commit this change to main.")
    expect(effectLine('main', true, false)).toBe("devloop keeps using main's copy until you commit this change to main.")
  })
})
