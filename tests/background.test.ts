import { describe, expect, test } from 'claude-code/testing'

import { whenSettled } from '../hooks/background'
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
import { change, CONFIG, start, stop, world } from './world'
import type { Dollar, World } from './world'

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

const SLOW = 'bash tests/run-all.sh'
const BG = { ...CONFIG, autoReview: false, verify: ['npm test', { run: SLOW, background: true }] }
const loopIn = (w: World): Loop => (w.store['loop:/repo'] as { value: Loop }).value
async function stopOn($: Dollar, w: World, file = 'src/a.ts') { w.files[`/repo/${file}`] = 'export const a = 1'; change(w, file); return stop($) }

describe('background runs', () => {
  test('a stop starts it and returns at once; nothing else runs it', async ($, on) => {
    const w = world(on, BG); await start($)
    expect((await stopOn($, w)).block).toBeUndefined()
    expect(w.spawns.map(one => one.command)).toEqual([SLOW])
    expect(w.spawns[0]?.argv.slice(0, 2)).toEqual(['bash', '-lc'])
    expect(w.ran).not.toContain(SLOW)
    expect(loopIn(w).background[SLOW]).toEqual({ tree: w.tree, startedAt: 1000 })
    await stop($)
    expect(w.spawns.length).toBe(1)
  })
  test('a pass is recorded against its tree, with how long it took', async ($, on) => {
    const w = world(on, BG); await start($); await stopOn($, w)
    w.now += 41 * 60_000; w.spawns[0]?.finish(0); await whenSettled()
    expect(loopIn(w).verify.passedOn[SLOW]).toBe(w.tree)
    expect(loopIn(w).verify.runs[SLOW]).toMatchObject({ tree: w.tree, outcome: 'pass', durationMs: 41 * 60_000, isOlderTree: false })
    expect(loopIn(w).background).toEqual({})
    expect(loopIn(w).events.at(-1)?.text).toBe(`background: ${SLOW} passed on this tree (41m)`)
  })
  test('a failure keeps its first lines and its output, and is not rerun on the same tree', async ($, on) => {
    const w = world(on, BG); await start($); await stopOn($, w)
    w.spawns[0]?.finish(1, 'FAIL tests/a.test.ts\nexpected 1 to be 2'); await whenSettled()
    expect(loopIn(w).verify.runs[SLOW]).toMatchObject({ outcome: 'fail', lines: 'FAIL tests/a.test.ts\nexpected 1 to be 2' })
    expect(loopIn(w).verify.runs[SLOW]?.saved).toMatch(/\/checks\/.+\.log$/)
    expect(loopIn(w).verify.passedOn[SLOW]).toBeUndefined()
    await stop($)
    expect(w.spawns.length).toBe(1)
  })
  test('a stop on a newer tree cancels the older run and starts again', async ($, on) => {
    const w = world(on, BG); await start($); await stopOn($, w); await stopOn($, w, 'src/b.ts')
    expect(w.spawns.length).toBe(2)
    expect(w.spawns[0]?.isKilled).toBe(true)
    w.spawns[0]?.finish(1); await whenSettled()
    expect(loopIn(w).verify.runs[SLOW]).toBeUndefined()
    expect(loopIn(w).background[SLOW]?.tree).toBe(w.tree)
  })
  test('a tree that changed while it ran: never a pass, and the next stop runs it again', async ($, on) => {
    const w = world(on, BG); await start($); await stopOn($, w)
    change(w, 'src/b.ts'); w.spawns[0]?.finish(0); await whenSettled()
    expect(loopIn(w).verify.runs[SLOW]?.isOlderTree).toBe(true)
    expect(loopIn(w).verify.passedOn[SLOW]).toBeUndefined()
    await stop($)
    expect(w.spawns.length).toBe(2)
  })
  test('Review Focus 3: a run whose session ended is not running forever; the next stop starts it again', async ($, on) => {
    const w = world(on, BG); await start($); await stopOn($, w)
    w.sessionId = 's2'; await start($)
    expect(loopIn(w).background).toEqual({})
    expect(loopIn(w).events.some(one => one.text === `background: ${SLOW} did not finish (the session or plugin ended); it starts again at the next stop`)).toBe(true)
    await stop($)
    expect(w.spawns.length).toBe(2)
  })
  test('Review Focus 5: outside git no background check starts', async ($, on) => {
    const w = world(on, BG); w.isGit = false; await start($); await stopOn($, w)
    expect(w.spawns).toEqual([])
  })
  test('a background check with when carries its pass while the files it covers are unchanged', async ($, on) => {
    const w = world(on, { ...BG, testing: { scope: 'targeted' }, verify: ['npm test', { run: SLOW, background: true, when: ['src/**'] }] })
    w.outputs['#covered-files'] = '100644 blob abc\tsrc/a.ts'; await start($); await stopOn($, w)
    w.spawns[0]?.finish(0); await whenSettled(); await stopOn($, w, 'src/b.ts')
    expect(w.spawns.length).toBe(1)
    expect(loopIn(w).verify.passedOn[SLOW]).toBe(w.tree)
  })
  test('rule 3: a background check runs with the scrubbed environment a foreground check gets', async ($, on) => {
    const w = world(on, { ...BG, checkEnv: { mode: 'enforce', pass: ['NODE_ENV'] } }); await start($); await stopOn($, w)
    expect(w.spawns.map(one => [one.command, one.cwd, one.argv.slice(0, 2), one.argv.includes('NODE_ENV')])).toEqual([[SLOW, '/repo', ['bash', '-c'], true]])
    expect(w.envs['npm test']).toContain('NODE_ENV')
  })
  test('foreground checks keep a record with their duration', async ($, on) => {
    const w = world(on, BG); await start($); await stopOn($, w)
    expect(loopIn(w).verify.runs['npm test']).toMatchObject({ tree: w.tree, outcome: 'pass', durationMs: 0, isOlderTree: false })
  })
})

describe('a loop stored before background checks', () => {
  const finding = { id: 'F1', reviewer: 'general', severity: 'high', file: '', line: 0, quote: '', problem: 'unreadable', evidence: 'a person', isPreExisting: false, route: 'decision', status: 'open', isBlocking: true, round: 1, seen: 1, note: null }
  /** The loop as 0.4 kept it: the same fields, without `background` and `verify.runs`. */
  const earlier = (shape: string) => {
    const { runs: _runs, ...verify } = { ...FRESH.verify, status: 'pass' as const, tree: 't0', passedOn: { 'npm test': 't0' } }
    const { background: _background, ...loop } = {
      ...FRESH, root: '/repo', sessionId: 's0', phase: 'build' as const, spec: 'login', findings: [finding], verify,
      limit: { ...FRESH.limit, branch: 'feature', failed: 2 },
    }

    return { shape, value: loop }
  }
  test('an upgrade mid-change keeps the phase, the findings, the passes and the loop limit', async ($, on) => {
    const w = world(on, BG); w.store['loop:/repo'] = earlier('loop-12'); await start($)
    expect(loopIn(w)).toMatchObject({ phase: 'build', spec: 'login', findings: [finding], background: {}, limit: { failed: 2 } })
    expect(loopIn(w).verify).toMatchObject({ passedOn: { 'npm test': 't0' }, runs: {} })
    expect((w.store['loop:/repo'] as { shape: string }).shape).toBe('loop-13')
  })
  test('a shape older than that starts fresh, as before', async ($, on) => {
    const w = world(on, BG); w.store['loop:/repo'] = earlier('loop-11'); await start($)
    expect(loopIn(w)).toMatchObject({ phase: 'idle', findings: [], background: {} })
  })
})
