import { describe, expect, test } from 'claude-code/testing'

import { whenSettled } from '../hooks/background'
import { describeStep } from '../hooks/commands'
import { DEFAULTS, parseConfig } from '../hooks/config'
import type { Config, Step } from '../hooks/config'
import { policyFacts } from '../hooks/context'
import { gate, NO_FACTS } from '../hooks/gate'
import { checksForChange } from '../hooks/limits'
import { infraAdvice } from '../hooks/output'
import { checksFor, NOT_CHECKED_HERE, statelessGate } from '../hooks/portable'
import { backgroundFor, stepsFor } from '../hooks/rules'
import { FRESH } from '../hooks/state'
import { ago, backgroundNotice, testStates } from '../hooks/testruns'
import type { CheckRecord, Loop } from '../types'
import { bash, change, CONFIG, devloop, edit, prompt, start, stop, world } from './world'
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
    // The command line never runs a background check (rule 12): CI or the session's background run proves it.
    expect(checksFor(cfg, ['src/a.ts'], false)).toEqual(['unit'])
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


describe('what the agent and the person are told', () => {
  const fail = async (w: World, output = 'FAIL tests/a.test.ts\nexpected 1 to be 2') => { w.now += 41 * 60_000; w.spawns[0]?.finish(1, output); await whenSettled() }
  const told = (w: World): string => w.contexts.at(-1)?.join('\n') ?? ''
  test('a failure on this tree: a toast, a failed round toward the loop limit, an idle agent woken, never a block', async ($, on) => {
    const w = world(on, BG); await start($); await stopOn($, w); await fail(w)
    expect(w.toasts.at(-1)).toBe(`devloop: the background check \`${SLOW}\` failed on this tree (41m).`)
    expect(w.submitted.at(-1)).toMatch(/^The background check `bash tests\/run-all\.sh` failed on this tree \(it ran 41m\)\.\nFAIL tests\/a\.test\.ts\nexpected 1 to be 2\nThe whole output is in .+\.log\.\nFix the failure and stop;/)
    expect([loopIn(w).limit.failed, loopIn(w).verify.rounds]).toEqual([1, 0])
    expect((await stop($)).block).toBeUndefined()
    await prompt($)
    expect(told(w)).toMatch(/`bash tests\/run-all\.sh` failed in the background on this tree \(41m\):\nFAIL tests\/a\.test\.ts/)
  })
  test('a busy agent is not woken', async ($, on) => {
    const w = world(on, BG); await start($); await stopOn($, w)
    await $.turn.start({ turnId: 'busy' } as never); await fail(w)
    expect(w.submitted).toEqual([])
  })
  test('observe mode wakes no one', async ($, on) => {
    const w = world(on, { ...BG, mode: 'observe' }); await start($); await stopOn($, w); await fail(w)
    expect(w.submitted).toEqual([])
    expect(w.toasts.at(-1)).toMatch(/failed on this tree/)
  })
  test('at the loop limit nothing is handed back: the limit message is added once, and no one is woken', async ($, on) => {
    const w = world(on, { ...BG, loop: { failedRounds: 1 } }); await start($); await stopOn($, w); await fail(w)
    expect(w.submitted).toEqual([])
    expect(w.appended.filter(one => /Loop limit: 1 failed round on this branch/.test(one)).length).toBe(1)
  })
  test('a failure on an older tree is shown as such, and neither counted nor woken', async ($, on) => {
    const w = world(on, BG); await start($); await stopOn($, w); change(w, 'src/b.ts'); await fail(w, 'boom')
    expect(w.toasts.at(-1)).toBe(`devloop: the background check \`${SLOW}\` failed on an older tree (the tree changed while it ran); it runs again at the next stop.`)
    expect([w.submitted, loopIn(w).limit.failed]).toEqual([[], 0])
    await prompt($)
    expect(told(w)).toMatch(/failed on an older tree \(the tree changed while it ran\), so it says nothing certain about this one:\nboom/)
  })
  test('Review Focus 4: while a spec is written a failure is recorded, and nothing is woken or counted', async ($, on) => {
    const w = world(on, BG); await start($)
    w.files['/repo/specs/login/SPEC.md'] = '# login'; await devloop($, 'spec login'); await stopOn($, w); await fail(w)
    expect([w.submitted, loopIn(w).limit.failed, loopIn(w).verify.runs[SLOW]?.outcome]).toEqual([[], 0, 'fail'])
  })
  test('Review Focus 2: a check that cannot run is told with advice, not counted, and not restarted on the same tree', async ($, on) => {
    const w = world(on, BG); await start($); await stopOn($, w)
    w.spawns[0]?.finish(127, 'bash: tests/run-all.sh: not found'); await whenSettled()
    expect(w.toasts.at(-1)).toMatch(/^devloop: `bash tests\/run-all\.sh` could not run: its program was not found \(exit 127\)/)
    expect([w.submitted, loopIn(w).limit.failed]).toEqual([[], 0])
    await stop($)
    expect(w.spawns.length).toBe(1)
  })
  test('a pass reaches the agent at its next prompt; no one is woken', async ($, on) => {
    const w = world(on, BG); await start($); await stopOn($, w)
    w.now += 41 * 60_000; w.spawns[0]?.finish(0); await whenSettled()
    expect(w.submitted).toEqual([])
    await prompt($)
    expect(told(w)).toMatch(/`bash tests\/run-all\.sh` passed in the background on this tree \(41m\)\./)
  })
  test('a push while the run goes is held with how long it has run, and starts no second run', async ($, on) => {
    const w = world(on, BG); await start($); await stopOn($, w); w.now += 14 * 60_000
    expect((await bash($, 'git push -u origin feature')).deny).toMatch(/tests still running \(started 14m ago\): bash tests\/run-all\.sh/)
    expect(w.spawns.length).toBe(1)
  })
  test('in observe mode that push is noted, not held', async ($, on) => {
    const w = world(on, { ...BG, mode: 'observe' }); await start($); await stopOn($, w)
    expect((await bash($, 'git push -u origin feature')).deny).toBeUndefined()
  })
  test('a session that ends (a /clear) drops the run, records nothing as killed, and the next stop starts it again', async ($, on) => {
    const w = world(on, BG); await start($); await stopOn($, w)
    await $.session.end({ reason: 'clear', sessionId: 's1', resume: {} as never })
    expect(w.spawns[0]?.isKilled).toBe(true)
    await whenSettled()
    expect([loopIn(w).background, loopIn(w).verify.runs[SLOW]]).toEqual([{}, undefined])
    expect(loopIn(w).events.some(one => one.text === `background: ${SLOW} did not finish (the session or plugin ended); it starts again at the next stop`)).toBe(true)
    await stop($)
    expect(w.spawns.length).toBe(2)
  })
})

describe('what each check last did on the tree', () => {
  const cfg: Config = { ...DEFAULTS, verify: [fast('unit'), full('e2e'), bg('slow')] }
  const base: Loop = { ...FRESH, tree: 't1', tier: 'medium', changed: ['src/a.ts'], verify: { ...FRESH.verify, status: 'pass', tree: 't1', passedOn: { unit: 't1' }, runs: { unit: { ...FAILED, outcome: 'pass', lines: '', durationMs: 2000 } } } }
  test('foreground checks first, then background ones; running, then a pass, then a record on this tree, else not run', () => {
    const states = testStates({ ...base, background: { slow: { tree: 't1', startedAt: 5 } } }, cfg)
    expect(states.map(one => [one.run, one.isBackground, one.state, one.durationMs, one.startedAt])).toEqual([['unit', false, 'pass', 2000, null], ['e2e', false, 'not run', null, null], ['slow', true, 'running', null, 5]])
    const failing = testStates({ ...base, verify: { ...base.verify, runs: { ...base.verify.runs, slow: { ...FAILED, saved: '/s.log' } } } }, cfg)[2]
    expect(failing).toEqual({ run: 'slow', isBackground: true, state: 'fail', durationMs: 1, startedAt: null, lines: 'x', saved: '/s.log' })
    expect(testStates({ ...base, verify: { ...base.verify, runs: { slow: { ...FAILED, outcome: 'not-found' } } } }, cfg)[2]?.state).toBe('could not run')
    expect(testStates({ ...base, verify: { ...base.verify, runs: { slow: { ...FAILED, isOlderTree: true } } } }, cfg)[2]?.state).toBe('not run')
  })
  test('the notice speaks only of background checks, and is null with nothing to say', () => {
    expect(backgroundNotice(base, cfg, 0)).toBeNull()
    expect(backgroundNotice({ ...base, background: { slow: { tree: 't1', startedAt: 0 } } }, cfg, 14 * 60_000)).toBe('`slow` is running in the background on this tree (started 14m ago); nothing waits on it but shipping.')
    expect(backgroundNotice({ ...base, verify: { ...base.verify, runs: { slow: { ...FAILED, outcome: 'not-found' } } } }, cfg, 0)).toBe(infraAdvice('slow', 'not-found', cfg.verifyTimeoutSec))
    expect(backgroundNotice({ ...base, verify: { ...base.verify, runs: { slow: FAILED } } }, cfg, 0)).toBe('`slow` failed in the background on this tree (<1m):\nx')
  })
  test('an older-tree failure while the next run goes says the run is going, not that it starts at the next stop', () => {
    const older = { ...FAILED, isOlderTree: true, lines: 'boom' }
    expect(backgroundNotice({ ...base, background: { slow: { tree: 't1', startedAt: 0 } }, verify: { ...base.verify, runs: { slow: older } } }, cfg, 3 * 60_000))
      .toBe('`slow` failed on an older tree (the tree changed while it ran), so it says nothing certain about this one:\nboom\nIt is running again in the background on this tree (started 3m ago).')
  })
})

describe('the status bar and the gate agree after an edit', () => {
  test('a run going on the tree an edit has since moved shows as not run, in the bar as in the gate', async ($, on) => {
    const w = world(on, BG); await start($); await stopOn($, w)
    w.files['/repo/src/a.ts'] = 'export const a = 2'; await edit($, '/repo/src/a.ts'); change(w, 'src/a.ts')
    // The edit marks the loop dirty; its tree is still the one the run started on until the next snapshot.
    expect(loopIn(w)).toMatchObject({ isDirty: true, background: { [SLOW]: { tree: loopIn(w).tree } } })
    const bar = async (): Promise<string> => JSON.stringify(await (await $.ui.mount({ plugin: 'devloop', surface: 'terminal', component: 'AbovePrompt', props: { hasSurvey: false } } as never)).findAll({ type: 'Text' }))
    expect(await bar()).toContain('not run since the last change')
    expect(await bar()).not.toContain('running')
    const status = await devloop($, 'status')
    expect(status).toMatch(/\[ \] Verification: not run since the last edit/)
    expect(status).not.toMatch(/still running/)
    expect(await bar()).toContain('not run since the last change')
  })
})

describe('the command line leaves background checks to CI or the session (rule 12)', () => {
  test('its gate adds one met row naming them, and its Verification row does not wait on them', () => {
    const cfg = { ...DEFAULTS, verify: [{ run: 'unit', profile: 'fast' as const, when: null }, { run: 'slow', profile: 'fast' as const, when: null, background: true as const }] }
    const proof = { tree: 't1', committable: 't1', base: 'b', branch: 'f', files: ['src/a.ts'], runs: [{ run: 'unit', isPassing: true, outcome: 'pass' as const, output: '' }], note: null } as never
    const facts = { errors: [], lint: [], hiddenFromGit: [], policy: null } as never
    const { rows } = statelessGate(proof, cfg as never, facts)
    const bgRow = rows.find(row => row.label === 'Background checks')
    expect(bgRow?.isMet).toBe(true)
    expect(bgRow?.note).toBe(`${NOT_CHECKED_HERE}: slow`)
    expect(rows.find(row => row.label === 'Verification')?.note ?? '').not.toMatch(/slow/)
  })
})
