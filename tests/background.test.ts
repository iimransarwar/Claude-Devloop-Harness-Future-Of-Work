import { describe, expect, test } from 'claude-code/testing'

import { describeStep } from '../hooks/commands'
import { DEFAULTS, parseConfig } from '../hooks/config'
import type { Config, Step } from '../hooks/config'
import { policyFacts } from '../hooks/context'
import { gate, NO_FACTS } from '../hooks/gate'
import { checksForChange } from '../hooks/limits'
import { infraAdvice } from '../hooks/output'
import { checksFor } from '../hooks/portable'
import { backgroundFor, stepsFor } from '../hooks/rules'
import { FRESH } from '../hooks/state'
import { ago } from '../hooks/testruns'
import type { CheckRecord, Loop } from '../types'

// Background checks (agent-driven review design, section 3 and rules 1, 3,
// 12): a verify entry marked "background" leaves both foreground profiles,
// and the gate's Verification row wants its recorded pass on the tree.

const fast = (run: string, when: string[] | null = null): Step => ({ run, profile: 'fast', when })
const full = (run: string): Step => ({ run, profile: 'full', when: null })
const bg = (run: string, when: string[] | null = null): Step => ({ run, profile: 'fast', when, background: true })
const FAILED: CheckRecord = { tree: 't1', outcome: 'fail', at: 0, durationMs: 1, lines: 'x', isOlderTree: false, saved: null }

describe('background checks in the policy', () => {
  test('a verify entry may be a background check', () => {
    const { cfg, errors } = parseConfig(JSON.stringify({ verify: ['npm test', { run: 'bash tests/run-all.sh', background: true }] }))
    expect(errors).toEqual([])
    expect(cfg.verify).toEqual([fast('npm test'), bg('bash tests/run-all.sh')])
  })
  test('background that is not true or false is named, and the check stays in the foreground', () => {
    const { cfg, errors } = parseConfig(JSON.stringify({ verify: [{ run: 'x', background: 'yes' }] }))
    expect(errors).toEqual(['verify[0].background: expected true or false; it runs in the foreground'])
    expect(cfg.verify).toEqual([fast('x')])
  })
  test('verifyTimeoutSec over 600 says to mark long checks background', () => {
    const { cfg, errors } = parseConfig(JSON.stringify({ verifyTimeoutSec: 3600 }))
    expect(cfg.verifyTimeoutSec).toBe(300)
    expect(errors).toEqual(['verifyTimeoutSec: expected a number from 0 to 600; using 300. Mark long checks "background": true in verify: they run with no time limit, and only shipping waits for them'])
    expect(parseConfig(JSON.stringify({ verifyTimeoutSec: -1 })).errors).toEqual(['verifyTimeoutSec: expected a number from 0 to 600; using 300'])
  })
  test('background checks are in neither profile; backgroundFor applies when', () => {
    const steps = [fast('unit'), full('e2e'), bg('slow', ['src/**'])]
    expect(stepsFor(steps, 'full', ['src/a.ts']).map(one => one.run)).toEqual(['unit', 'e2e'])
    expect(backgroundFor(steps, ['src/a.ts']).map(one => one.run)).toEqual(['slow'])
    expect(backgroundFor(steps, ['docs/a.md'])).toEqual([])
  })
  test('the agent, the context line and the command line know them', () => {
    const cfg: Config = { ...DEFAULTS, verify: [fast('unit'), bg('slow')] }
    expect(policyFacts(cfg, 'enforce')).toMatch(/runs `unit`; run them yourself first\. `slow` runs in the background after your stops, with no time limit; only shipping waits for it\./)
    expect(policyFacts({ ...DEFAULTS, verify: [bg('slow')] }, 'enforce')).not.toMatch(/no verify commands/)
    expect(checksForChange(cfg, ['src/a.ts'])).toBe('Checks for what you changed: `unit`, `slow` (runs in the background).')
    expect(checksFor(cfg, ['src/a.ts'], false)).toEqual(['unit', 'slow'])
    expect(infraAdvice('x', 'timeout', 600)).toBe('`x` did not finish within 600s. Raise "verifyTimeoutSec" in devloop.json (600 at most) or mark the check "background": true; no code change to the work fixes this.')
    expect([ago(0), ago(59_999), ago(14 * 60_000), ago(65 * 60_000)]).toEqual(['<1m', '<1m', '14m', '1h 5m'])
  })
  test('with only background checks applying, the context line says they start at the next stop', () => {
    const cfg: Config = { ...DEFAULTS, verify: [fast('unit', ['src/**']), bg('slow')] }
    expect(checksForChange(cfg, ['docs/a.md'])).toBe('Checks for what you changed: `slow` (runs in the background). It starts at your next stop.')
    expect(checksForChange({ ...cfg, verify: [bg('a'), bg('b')] }, ['docs/a.md'])).toBe('Checks for what you changed: `a` (runs in the background), `b` (runs in the background). They start at your next stop.')
  })
  test('doctor shows a background check as such', () => {
    expect(describeStep(bg('bash tests/run-all.sh'))).toBe('bash tests/run-all.sh [background]')
    expect(describeStep(bg('slow', ['src/**']))).toBe('slow [background, when src/**]')
    expect(describeStep(fast('unit'))).toBe('unit [fast]')
  })
})

describe('the verification row', () => {
  const cfg: Config = { ...DEFAULTS, verify: [fast('unit'), bg('slow')] }
  const base: Loop = { ...FRESH, tree: 't1', tier: 'medium', changed: ['src/a.ts'], verify: { ...FRESH.verify, status: 'pass', tree: 't1', profile: 'fast', passedOn: { unit: 't1' } } }
  test('wants a recorded pass of each background check on this tree', () => {
    expect(gate(base, cfg)[0]).toEqual({ label: 'Verification', isMet: false, note: 'fast checks pass; background checks still to run: slow (they start at the next stop)' })
    expect(gate({ ...base, verify: { ...base.verify, passedOn: { unit: 't1', slow: 't1' } } }, cfg)[0]?.isMet).toBe(true)
  })
  test('says a run is going, and for how long when it knows the time', () => {
    const running: Loop = { ...base, background: { slow: { tree: 't1', startedAt: 0 } } }
    expect(gate(running, cfg, { ...NO_FACTS, now: 14 * 60_000 })[0]?.note).toBe('tests still running (started 14m ago): slow')
    expect(gate(running, cfg)[0]?.note).toBe('tests still running: slow')
  })
  test('names a background failure on this tree, never one from an older tree', () => {
    expect(gate({ ...base, verify: { ...base.verify, runs: { slow: FAILED } } }, cfg)[0]?.note).toBe('failing: slow (in the background)')
    expect(gate({ ...base, verify: { ...base.verify, runs: { slow: { ...FAILED, isOlderTree: true } } } }, cfg)[0]?.note).toMatch(/background checks still to run: slow/)
  })
  test('a background check that could not run on this tree says to fix the command, not that it starts at the next stop', () => {
    const could = (outcome: CheckRecord['outcome']): string | undefined => gate({ ...base, verify: { ...base.verify, runs: { slow: { ...FAILED, outcome } } } }, cfg)[0]?.note
    expect(could('not-found')).toBe('could not run on this tree: slow (not-found); fix the command')
    expect(could('killed')).toBe('could not run on this tree: slow (killed); fix the command')
  })
  test('Review Focus 5: outside git the row says a background check cannot be recorded', () => {
    expect(gate({ ...base, tree: null, verify: { ...base.verify, tree: null } }, cfg)[0]).toEqual({ label: 'Verification', isMet: false, note: 'background checks need a git repository to record a result against: slow' })
  })
})
