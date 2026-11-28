// The field report from a long branch in another repository (0.8.0): each
// test pins one of the fixes it led to.
import { describe, expect, test } from 'claude-code/testing'

import { DEFAULTS } from '../hooks/config'
import { pressureLevels } from '../hooks/context'
import { parseReview, reviewPrompt } from '../hooks/findings'
import { isQuestionOfFact, ownWords } from '../hooks/grounding'
import { isWideDelta } from '../hooks/review'
import { credentialKinds, scanCredentials } from '../hooks/scan'
import { brief, FRESH } from '../hooks/state'
import type { Loop } from '../types'
import { change, devloop, edit, start, world } from './world'

describe('field report fixes', () => {
  test('the question note reads only the person\'s own words', async () => {
    const relayed = '<cross-session-message from="x">Field report. Does the review read the branch? It should.</cross-session-message>'
    expect(ownWords(relayed)).toBe('')
    expect(isQuestionOfFact(relayed)).toBe(false)
    expect(isQuestionOfFact(`${relayed}\nis the gate green?`)).toBe(true)
    expect(isQuestionOfFact('<task-notification><summary>done?</summary></task-notification>')).toBe(false)
  })

  test('a long instruction with a question mark inside is not a question; one that ends on a question is', async () => {
    const body = 'Start Merge of the feature branch into main after the checks pass, and keep the history linear. '.repeat(4)
    expect(isQuestionOfFact(`${body}Watch for the flag (is it still set?) while you go. Then push.`)).toBe(false)
    expect(isQuestionOfFact(`${body}Make sure nothing breaks.`)).toBe(false)
    expect(isQuestionOfFact(`${body}Will the gate pass after that?`)).toBe(true)
    expect(isQuestionOfFact('make sure the tests pass')).toBe(true)
  })

  test('a million-token window is not called nearly full with most of it left', async () => {
    const levels = pressureLevels(1_000_000, DEFAULTS)
    expect(levels.warn).toBeLessThanOrEqual(400_000)
    expect(levels.save).toBeLessThanOrEqual(250_000)
    expect(DEFAULTS.context.debounceCalls).toBeGreaterThanOrEqual(200)
  })

  test('a wide delta since the last round is reviewed whole, a small fix only as its delta', async () => {
    const one = (n: number, lines: number): string => `diff --git a/src/f${n}.ts b/src/f${n}.ts\n--- a/src/f${n}.ts\n+++ b/src/f${n}.ts\n${'+x\n'.repeat(lines)}`
    expect(isWideDelta(one(1, 5))).toBe(false)
    expect(isWideDelta(Array.from({ length: 9 }, (_, n) => one(n, 2)).join(''))).toBe(true)
    expect(isWideDelta(one(1, 700))).toBe(true)
  })

  test('a finding whose evidence is a person\'s decision is routed to the person', async () => {
    const parsed = parseReview('F3 | high | ioc.yaml:1 | ioc: list | untracked notes in the change | decision: whether these files belong in the change\nVERDICT: FAIL')
    expect(parsed.findings[0]?.route).toBe('decision')
    expect(parseReview('F1 | high | src/a.ts:1 | a || b | short-circuits | a test\nVERDICT: FAIL').findings[0]?.route).toBe('fix')
  })

  test('the reviewer is told which files are devloop\'s own and which are untracked', async () => {
    const text = reviewPrompt({
      brief: 'b', reviewMd: null, spec: null, base: 'abc', diff: null, tier: 'high', changed: ['src/a.ts', 'devloop.json', 'notes/ioc.yaml', 'evals/x.json'],
      untracked: ['notes/ioc.yaml', 'evals/x.json'], checks: [], round: 1, maxRounds: 2, open: [], nextId: 1,
    } as Parameters<typeof reviewPrompt>[0])
    expect(text).toContain('devloop\'s own files (devloop.json, evals/x.json)')
    expect(text).toContain('Untracked, not committed (1): notes/ioc.yaml')
  })

  test('labels, code and test fixtures named like secrets are not credentials; a real-looking value still is', async () => {
    expect(credentialKinds('private const val S_BACKUP_F_SECRET_KEY = "wv/backup/f/secretkey/v1"')).toEqual([])
    expect(credentialKinds('secretKey = typedSecretBytes(_secretKey.text);')).toEqual([])
    const fixture = { file: 'test/vault/rotate_test.dart', line: 3, text: "rotatedSecretKey = 'S1-ZYXWVT-SRQPNM-KJHGFE-DCBA98'" }
    expect(scanCredentials([fixture])).toEqual([])
    expect(scanCredentials([{ ...fixture, file: 'lib/vault/rotate.dart' }]).map(one => one.kind)).toEqual(['API key or secret assignment'])
    expect(scanCredentials([{ file: 'test/a_test.dart', line: 1, text: 'token = "ghp_' + 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8"' }]).map(one => one.kind)).toEqual(['GitHub token'])
  })

  test('spent review rounds read as spent, not as not run', async () => {
    const loop = { ...FRESH, tier: 'high', review: { ...FRESH.review, status: 'none', round: 2, cycle: { ...FRESH.review.cycle, ended: 'cap' } } } as Loop
    expect(brief(loop)).toContain('review rounds spent (2)')
    expect(brief({ ...loop, review: { ...loop.review, round: 0, cycle: FRESH.review.cycle } } as Loop)).toContain('review not run')
  })

  test('a change closed with the gate open keeps its base, so the next review reads that work too', async ($, on) => {
    const w = world(on)
    await start($)
    change(w, 'src/a.ts')
    await edit($, '/repo/src/a.ts')
    const before = (w.store['loop:/repo'] as { value: Loop }).value.base
    w.answer = 'Close anyway'
    const text = await devloop($, 'done')
    expect((w.store['loop:/repo'] as { value: Loop }).value.base).toBe(before)
    expect(text).toContain('this work stays in the next change')
  })
})
