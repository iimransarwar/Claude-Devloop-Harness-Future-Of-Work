import { describe, expect, test } from 'claude-code/testing'
import { cycleSummary } from '../hooks/findings'
import type { Finding } from '../types'

const finding = (id: string, status: Finding['status'], route: Finding['route'], problem: string): Finding =>
  ({ id, status, route, problem, file: 'a.ts', line: 1, quote: '', severity: 'high', reviewer: 'general', evidence: '', isBlocking: true, round: 1, seen: 1 } as unknown as Finding)

describe('the review summary (spec §5)', () => {
  test('a pass names the round, the fixes, what is open for a person and the tests', () => {
    const text = cycleSummary({ ended: 'pass', round: 2, cap: 2, discarded: 0, from: 1, findings: [finding('F1', 'closed', 'fix', 'slide title says 8 phases but the table has 9 rows'), finding('F2', 'open', 'decision', 'which repo slug')], tests: ['✓ passed: npm test'] })
    expect(text.split('\n')).toEqual([
      'Review done: passed in round 2 of 2.',
      'Fixed: F1 slide title says 8 phases but the table has 9 rows.',
      'Still open for you: F2.',
      'Tests: ✓ passed: npm test',
    ])
  })
  test('the cap, discarded rounds, and only this cycle\'s findings', () => {
    const text = cycleSummary({ ended: 'cap', round: 2, cap: 2, discarded: 1, from: 3, findings: [finding('F1', 'closed', 'fix', 'old cycle'), finding('F3', 'open', 'fix', 'still broken')], tests: [] })
    expect(text).toMatch(/^Review done: all 2 rounds used and it still fails; a person reads the change\./)
    expect(text).toMatch(/Fixed: none\./)
    expect(text).toMatch(/1 round was discarded because the code changed during review\./)
    expect(text).toMatch(/Tests: none set/)
    expect(text).not.toMatch(/old cycle/)
  })
})
