import { describe, expect, test } from 'claude-code/testing'

import { foundLabel, readApprovers, readStrictness, readVerify, summary } from '../hooks/setup'
import { configFile } from '../hooks/templates'

describe('setup answer readers and summary', () => {
  test('readStrictness reads labels and typed words, any case and spacing', () => {
    expect(readStrictness('Watch only (recommended)')).toBe('observe')
    expect(readStrictness('Block from the start')).toBe('enforce')
    expect(readStrictness('  WATCH ')).toBe('observe')
    expect(readStrictness('enforce')).toBe('enforce')
    expect(readStrictness('observe')).toBe('observe')
    expect(readStrictness('sometimes')).toBeNull()
  })
  test('readApprovers reads labels and me/1/one/two/2', () => {
    expect(readApprovers('Just me (recommended)')).toBe('me')
    for (const t of ['me', 'Just me', '1', 'one']) expect(readApprovers(t)).toBe('me')
    for (const t of ['Two people', 'two', '2']) expect(readApprovers(t)).toBe('two')
    expect(readApprovers('3 people')).toBeNull()
  })
  test('readVerify: found label keeps objects whole; typed replaces all, trimmed; none/no/empty/later mean none', () => {
    const found = ['npm test --silent', { run: 'go test ./...', when: ['**/*.go'] }]
    expect(readVerify(foundLabel(found), found)).toEqual({ verify: found, isLater: false })
    expect(readVerify('  make check  ', found)).toEqual({ verify: ['make check'], isLater: false })
    for (const t of ['None for now', 'none', ' NO ', '']) expect(readVerify(t, found)).toEqual({ verify: [], isLater: false })
    expect(readVerify("I'll add it later", [])).toEqual({ verify: [], isLater: true })
  })
  test('foundLabel joins with " + " and cuts at 60 characters with …', () => {
    expect(foundLabel(['npm test --silent', 'npm run --silent lint'])).toBe('npm test --silent + npm run --silent lint')
    const long = foundLabel(['npm run --silent typecheck', 'npm run --silent lint', 'npm test --silent'])
    expect(long.length).toBe(60)
    expect(long.endsWith('…')).toBe(true)
  })
  test('summary names mode, checks, approvers, only written files, and the guessed branch', () => {
    const text = summary({ mode: 'observe', verify: ['npm test --silent'], isVerifyLater: false, approvers: 'me' }, ['devloop.json', 'evals/README.md'], ['REVIEW.md'], { name: 'main', isGuessed: true })
    expect(text.split('\n')[0]).toBe('devloop is set up.')
    expect(text).toMatch(/Watch only/)
    expect(text).toMatch(/runs: npm test --silent/)
    expect(text).toMatch(/just you/)
    expect(text).toMatch(/devloop\.json/)
    expect(text).not.toMatch(/AGENTS\.md/)
    expect(text).toMatch(/left as is: REVIEW\.md/)
    expect(text).toMatch(/main.*guessed/)
    expect(text).toMatch(/"mode", "verify", "approvals"/)
  })
  test('summary with no checks says nothing is checked and where to add one', () => {
    const text = summary({ mode: 'enforce', verify: [], isVerifyLater: true, approvers: 'two' }, ['devloop.json'], [], { name: 'main', isGuessed: false })
    expect(text).toMatch(/nothing will be checked/i)
    expect(text).toMatch(/"verify"/)
    expect(text).toMatch(/two people/i)
    expect(text).not.toMatch(/guessed/)
  })
  test('configFile writes mode and approvals only when given', () => {
    expect(JSON.parse(configFile([], 'main')).mode).toBe('observe')
    expect('approvals' in JSON.parse(configFile([], 'main'))).toBe(false)
    const both = JSON.parse(configFile(['x'], 'main', { mode: 'enforce', approvals: { low: 0, medium: 1, high: 1 } }))
    expect(both.mode).toBe('enforce')
    expect(both.approvals).toEqual({ low: 0, medium: 1, high: 1 })
  })
})
