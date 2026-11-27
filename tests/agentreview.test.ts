import { expect, test } from 'claude-code/testing'

import { DEFAULTS } from '../hooks/config'
import type { Config } from '../hooks/config'
import { FRESH } from '../hooks/fresh'
import { isCapSpent, reviewRefusal } from '../hooks/gate'
import { TOOL_SPECS } from '../hooks/register'
import { RULES } from '../hooks/templates'
import type { Loop } from '../types'
import { approved, bash, change, CONFIG, devloop, edit, feature, start, stop, world } from './world'
import type { Dollar, World } from './world'

// One review per change (agent-driven review design, rules 13-15, with
// rules 5 and 11): a round starts by itself only at a ready moment (a push
// that finds no review, a finished spec build; the agent's devloop_review
// tool), never at an ordinary stop. The one automatic follow-up is the
// re-review of a fix after a failing round. A pass ends a cycle: later edits
// mark the review out of date, and the next ready moment starts round 1.

const answer = ($: Dollar, agentId: string, text: string, isAborted = false) =>
  $.turn.complete({ answer: text, durationMs: 1, isAborted, turnId: `t-${agentId}`, agentId, reason: 'answer' })
const F_HIGH = 'F1 | high | src/a.ts:1 | export const a = 1 | rounds down | a test with 0.5'
const loopIn = (w: World): Loop => (w.store['loop:/repo'] as { value: Loop }).value
const last = (w: World) => w.spawned.at(-1)
/** The builder edits a file, which moves the tree, and stops: what the stop gate blocked with, if anything. */
async function fix($: Dollar, w: World, file = 'src/a.ts'): Promise<string | undefined> {
  w.files[`/repo/${file}`] = 'export const a = 1'; await edit($, `/repo/${file}`); change(w, file)
  return (await stop($)).block
}
/** The shipping command these tests use: what it was refused with, or undefined. */
const push = async ($: Dollar): Promise<string | undefined> => (await bash($, 'git push -u origin feature')).deny
/** The status row above the prompt, as text. */
const bar = async ($: Dollar): Promise<string> =>
  JSON.stringify(await (await $.ui.mount({ plugin: 'devloop', surface: 'terminal', component: 'AbovePrompt', props: { hasSurvey: false } } as never)).findAll({ type: 'Text' }))

test('rule 13: an ordinary stop starts no round, on a medium-risk change that verifies', async ($, on) => {
  const w = world(on); await start($)
  expect(await fix($, w)).toBeUndefined()
  expect(await fix($, w, 'src/b.ts')).toBeUndefined()
  expect(w.spawned).toEqual([])
  expect(await devloop($, 'status')).toMatch(/\[ \] Independent review: not run/)
})
test('rule 13: nor when the fast checks could not run', async ($, on) => {
  const w = world(on); w.exits['npm test'] = 124; await start($)
  expect(await fix($, w)).toBeUndefined()
  expect(w.spawned).toEqual([])
})
test('rule 13: a push that finds no review of the change starts round 1 of 2, and holds the push until its verdict', async ($, on) => {
  const w = world(on); await start($); await fix($, w)
  expect(await push($)).toMatch(/the harness started one: Review round 1 of 2 started/)
  expect(w.spawned.map(one => one.subagentType)).toEqual(['devloop:reviewer'])
  await answer($, 'agent-1', 'VERDICT: PASS')
  expect(await push($)).toBeUndefined()
})
test('rule 13: in observe mode that push starts the round too, and is not held', async ($, on) => {
  const w = world(on, { ...CONFIG, mode: 'observe' }); await start($); await fix($, w)
  expect(await push($)).toBeUndefined()
  expect(w.spawned.map(one => one.subagentType)).toEqual(['devloop:reviewer'])
  expect(await devloop($, 'status')).toMatch(/Independent review: round 1 running/)
})
test('rule 13: a finished spec build starts round 1 by itself; a half-built one waits', async ($, on) => {
  const w = world(on); await start($); await approved($, w)
  await fix($, w)
  await feature($, 'rejects-bad-password'); await stop($)
  expect(w.spawned).toEqual([])
  await feature($, 'accepts-good-password'); await stop($)
  expect(w.spawned.length).toBe(1)
  expect(last(w)?.prompt).toMatch(/This is round 1 of 2\./)
})
test('rule 14: after a failing round, the next stop that moved the tree re-reviews the fix by itself, once', async ($, on) => {
  const w = world(on); await start($); await fix($, w); await push($)
  await answer($, 'agent-1', `${F_HIGH}\nVERDICT: FAIL`)
  await stop($)
  expect(w.spawned.length).toBe(1)
  expect(await fix($, w)).toBeUndefined()
  expect(w.spawned.length).toBe(2)
  expect(last(w)?.prompt).toMatch(/This is round 2 of 2\./)
  await answer($, 'agent-2', 'F1 | resolved\nF2 | high | src/a.ts:1 | export const a = 1 | still rounds down | a test with 1.5\nVERDICT: FAIL')
  await fix($, w, 'src/c.ts')
  expect(w.spawned.length).toBe(2)
  expect(await devloop($, 'status')).toMatch(/the cap of 2 rounds is spent/)
})
test('rule 14: the re-review starts too when the fast checks could not run', async ($, on) => {
  const w = world(on); await start($); await fix($, w); await push($)
  await answer($, 'agent-1', `${F_HIGH}\nVERDICT: FAIL`)
  w.exits['npm test'] = 124
  expect(await fix($, w)).toBeUndefined()
  expect(w.spawned.length).toBe(2)
})
test('rule 14: and at a stop on a tree a person already verified', async ($, on) => {
  const w = world(on); await start($); await fix($, w); await push($)
  await answer($, 'agent-1', `${F_HIGH}\nVERDICT: FAIL`)
  w.files['/repo/src/a.ts'] = 'export const a = 2'; await edit($, '/repo/src/a.ts'); change(w, 'src/a.ts')
  await devloop($, 'verify')
  expect(w.spawned.length).toBe(1)
  await stop($)
  expect(w.spawned.length).toBe(2)
})
test('rule 14: no re-review while the fix fails its checks', async ($, on) => {
  const w = world(on); await start($); await fix($, w); await push($)
  await answer($, 'agent-1', `${F_HIGH}\nVERDICT: FAIL`)
  w.exits['npm test'] = 1
  expect(await fix($, w)).toMatch(/verification failed/)
  expect(w.spawned.length).toBe(1)
})
test('rule 14: maxReviewRounds defaults to 2, one review and one check of the fix', () => {
  expect(DEFAULTS.maxReviewRounds).toBe(2)
})
test('rule 15: edits after a pass start nothing; the gate row and the status bar say the review is out of date', async ($, on) => {
  const w = world(on); await start($); await fix($, w); await push($)
  await answer($, 'agent-1', 'VERDICT: PASS')
  expect(await bar($)).toContain('✓ passed')
  await fix($, w, 'src/b.ts'); await fix($, w, 'src/c.ts')
  expect(w.spawned.length).toBe(1)
  const status = await devloop($, 'status')
  expect(status).toMatch(/\[ \] Independent review: passed on tree \S+, but the tree is now \S+: the review is out of date, and a new round starts when the change is ready \(the devloop_review tool, or a push\)/)
  expect(status).toMatch(/· review stale\n/)
  expect(await bar($)).toContain('out of date')
})
test('rule 15: the next ready moment after a pass starts a new cycle at round 1', async ($, on) => {
  const w = world(on); await start($); await fix($, w); await push($)
  await answer($, 'agent-1', 'VERDICT: PASS')
  await fix($, w, 'src/b.ts')
  expect(await push($)).toMatch(/Review round 1 of 2 started/)
  expect(last(w)?.prompt).toMatch(/This is round 1 of 2\./)
  expect(loopIn(w).review.cycle).toEqual({ ...FRESH.review.cycle, from: 1 })
})
test('rule 5: the cap bounds one cycle: rounds that pass never spend it', async ($, on) => {
  const w = world(on, { ...CONFIG, maxReviewRounds: 1 }); await start($)
  for (const file of ['src/a.ts', 'src/b.ts', 'src/c.ts']) {
    await fix($, w, file)
    expect({ file, pushed: await push($) }).toEqual({ file, pushed: expect.stringMatching(/Review round 1 of 1 started/) })
    await answer($, last(w)?.agentId ?? '', 'VERDICT: PASS')
  }
  await fix($, w, 'src/d.ts'); await push($)
  await answer($, last(w)?.agentId ?? '', `${F_HIGH}\nVERDICT: FAIL`)
  await fix($, w, 'src/e.ts')
  expect(w.spawned.length).toBe(4)
  expect(await devloop($, 'status')).toMatch(/the cap of 1 rounds is spent/)
})
test('Review Focus 1 and rule 11: an edit while a round runs discards its verdict; it uses a round, not the loop limit, and the next round reads the whole change', async ($, on) => {
  const w = world(on); await start($); await fix($, w); await push($)
  w.outputs['#round-delta'] = '+++ b/src/b.ts\n+export const b = 1'
  change(w, 'src/b.ts'); await answer($, 'agent-1', `${F_HIGH}\nVERDICT: FAIL`)
  expect(w.toasts.at(-1)).toBe('devloop: a review verdict arrived for a tree that has since changed; it was discarded and counts as round 1 of 2. A fresh round starts when the change is ready again: the devloop_review tool, or a push.')
  expect([loopIn(w).limit.failed, loopIn(w).review.cycle.discarded, loopIn(w).review.round]).toEqual([0, 1, 1])
  expect(loopIn(w).events.some(one => one.text === 'review round 1 discarded: the tree moved while it ran (it counts toward the cap)')).toBe(true)
  await stop($)
  expect(w.spawned.length).toBe(1)
  expect(await push($)).toMatch(/Review round 2 of 2 started/)
  expect(last(w)?.prompt).not.toMatch(/The diff since round 1/)
})
test('rule 11: a discarded last round spends the cap', async ($, on) => {
  const w = world(on, { ...CONFIG, maxReviewRounds: 1 }); await start($); await fix($, w); await push($)
  change(w, 'src/b.ts'); await answer($, 'agent-1', 'VERDICT: PASS')
  expect(w.toasts.at(-1)).toMatch(/counts as round 1 of 1\. The review cap is spent, so a person reads the change\.$/)
  expect(loopIn(w).review.cycle.ended).toBe('cap')
  await stop($)
  expect(await push($)).toMatch(/the cap of 1 rounds is spent/)
  expect(w.spawned.length).toBe(1)
})
test('rule 11: a re-review of a fix whose verdict was discarded starts again at the next stop', async ($, on) => {
  const w = world(on, { ...CONFIG, maxReviewRounds: 3 }); await start($); await fix($, w); await push($)
  await answer($, 'agent-1', `${F_HIGH}\nVERDICT: FAIL`)
  await fix($, w)
  expect(w.spawned.length).toBe(2)
  change(w, 'src/b.ts'); await answer($, 'agent-2', 'F1 | resolved\nVERDICT: PASS')
  expect(w.toasts.at(-1)).toMatch(/counts as round 2 of 3\. The next stop starts a fresh round\.$/)
  await stop($)
  expect(w.spawned.length).toBe(3)
  expect(last(w)?.prompt).toMatch(/This is round 3 of 3\./)
})
test('with autoReview off, a discarded round and an out-of-date pass say a person starts the next round', async ($, on) => {
  const w = world(on, { ...CONFIG, autoReview: false }); await start($); await fix($, w)
  await devloop($, 'review'); change(w, 'src/b.ts'); await answer($, 'agent-1', 'VERDICT: PASS')
  expect(w.toasts.at(-1)).toMatch(/counts as round 1 of 2\. A person starts the next round with \/devloop review \("autoReview" is off\)\.$/)
  await stop($); await devloop($, 'review'); await answer($, 'agent-2', 'VERDICT: PASS')
  await fix($, w, 'src/c.ts')
  expect(w.spawned.length).toBe(2)
  expect(await devloop($, 'status')).toMatch(/passed on tree \S+, but the tree is now \S+: the review is out of date, and a person starts a new round with \/devloop review \("autoReview" is off\)/)
})
test('an interrupted round does not count, and is not started again at a stop; the next ready moment starts it', async ($, on) => {
  const w = world(on); await start($); await fix($, w); await push($)
  await answer($, 'agent-1', '', true)
  await stop($)
  expect(w.spawned.length).toBe(1)
  expect(await push($)).toMatch(/Review round 1 of 2 started/)
})
test('rule 4: what refuses a round, in order; a pass ends the cap', () => {
  const base: Loop = { ...FRESH, tree: 't1', changed: ['src/a.ts'] }
  const refused = (loop: Partial<Loop>, cfg: Partial<Config> = {}, isHere = false): string | null => reviewRefusal({ ...base, ...loop }, { ...DEFAULTS, ...cfg }, isHere)
  const review = (more: Partial<Loop['review']>): Partial<Loop> => ({ review: { ...FRESH.review, ...more } })
  expect(refused({}, { autoReview: false })).toBe('autoReview is off: a person starts rounds with /devloop review')
  expect(refused({ phase: 'spec', spec: 'login' })).toBe('A spec is being written: review rounds start once a person approves it.')
  expect(refused(review({ status: 'running', round: 2 }))).toBe('Review round 2 is already running.')
  expect(refused(review({ isStalled: true }))).toBe('The review loop stopped after two rounds in a row closed no finding. This change needs a person to read it; /devloop done closes it when they have.')
  expect(refused(review({ round: 2 }))).toBe('The review cap of 2 rounds is spent. This change needs a person to read it; /devloop done closes it when they have.')
  expect(refused(review({ round: 2, cycle: { ...FRESH.review.cycle, ended: 'pass' } }))).toBeNull()
  expect(refused({ changed: [] })).toBe('Nothing has changed, so there is nothing to review.')
  expect(refused({ changed: ['docs/guide.md'] })).toBe('This change is low risk, so it needs no review round.')
  expect(refused(review({ status: 'pass', round: 1 }), {}, true)).toBe('This tree was already reviewed in round 1.')
  expect(refused({})).toBeNull()
  expect([isCapSpent({ ...FRESH.review, round: 2 }, DEFAULTS), isCapSpent({ ...FRESH.review, round: 1 }, DEFAULTS), isCapSpent({ ...FRESH.review, round: 2, cycle: { ...FRESH.review.cycle, ended: 'pass' } }, DEFAULTS)]).toEqual([true, false, false])
})
test('C6: a real push through the gate closes the cycle too', async ($, on) => {
  const w = world(on); await start($); await fix($, w); await push($)
  await answer($, 'agent-1', 'VERDICT: PASS')
  expect(loopIn(w).review.cycle).toMatchObject({ ended: 'pass', settledTree: w.tree })
  expect(await push($)).toBeUndefined()
  expect(loopIn(w).review).toMatchObject({ round: 0, cycle: FRESH.review.cycle })
})
for (const shape of ['loop-12', 'loop-13']) {
  test(`a ${shape} loop stored before review cycles keeps a passed review passed, so the cap does not refuse the next one`, async ($, on) => {
    const w = world(on)
    const { cycle: _cycle, ...review } = { ...FRESH.review, status: 'pass' as const, round: 3, tree: 't0' }
    w.store['loop:/repo'] = { shape, value: { ...FRESH, root: '/repo', sessionId: 's1', review } }
    await start($)
    expect(loopIn(w).review.cycle).toEqual({ ...FRESH.review.cycle, ended: 'pass', settledTree: 't0' })
    await fix($, w)
    expect(await push($)).toMatch(/Review round 1 of 2 started/)
  })
}

// ---------------------------------------------------------------- the devloop_review tool (§2, rules 4, 13, 15)

const ask = async ($: Dollar, agentId?: string): Promise<string> =>
  String((await $.tool.call({ tool: 'mcp__devloop__devloop_review', ...(agentId === undefined ? {} : { agentId }) })).result)
/** The builder edits a file, which moves the tree, and goes on working: no stop. */
async function ready($: Dollar, w: World, file = 'src/a.ts'): Promise<void> {
  w.files[`/repo/${file}`] = 'export const a = 1'; await edit($, `/repo/${file}`); change(w, file)
}
const DO_NOT_EDIT = 'Do not edit files until its verdict arrives: a verdict on a tree that has changed is discarded.'

test('§2: devloop_review starts a round mid-turn on the tree as it stands, running no tests', async ($, on) => {
  const w = world(on); await start($); await ready($, w); const ran = w.ran.length
  expect(await ask($)).toBe(`Review round 1 of 2 started in a fresh context. Its verdict will show in the Dev loop pane. ${DO_NOT_EDIT}`)
  expect([w.ran.length, w.spawned.length]).toEqual([ran, 1])
  expect(loopIn(w).review).toMatchObject({ status: 'running', round: 1, tree: w.tree, isAuto: true })
})
test('§2: otherwise it says why not, in one line', async ($, on) => {
  const w = world(on); await start($); await ready($, w); await ask($)
  expect(await ask($)).toBe('Review round 1 is already running.')
  expect(await ask($, 'agent-1')).toBe('A reviewer cannot start a review round.')
  await answer($, 'agent-1', 'VERDICT: PASS')
  expect(await ask($)).toBe('This tree was already reviewed in round 1.')
  expect(w.spawned.length).toBe(1)
})
test('rule 4: with autoReview off it is refused', async ($, on) => {
  const w = world(on, { ...CONFIG, autoReview: false }); await start($); await ready($, w)
  expect(await ask($)).toBe('autoReview is off: a person starts rounds with /devloop review')
  expect(w.spawned).toEqual([])
})
test('rule 4: not while a spec is written', async ($, on) => {
  const w = world(on); await start($); w.files['/repo/specs/login/SPEC.md'] = '# login'; await devloop($, 'spec login'); await ready($, w)
  expect(await ask($)).toBe('A spec is being written: review rounds start once a person approves it.')
})
test('§2: a low-risk change needs no round, and no change has nothing to review', async ($, on) => {
  const w = world(on); await start($)
  expect(await ask($)).toBe('Nothing has changed, so there is nothing to review.')
  await ready($, w, 'docs/guide.md')
  expect(await ask($)).toBe('This change is low risk, so it needs no review round.')
  expect(w.spawned).toEqual([])
})
test('rule 4: at the loop limit it is refused with the limit message', async ($, on) => {
  const w = world(on, { ...CONFIG, loop: { failedRounds: 1 } }); await start($)
  w.exits['npm test'] = 1; await fix($, w); w.exits['npm test'] = 0
  expect(await ask($)).toMatch(/Loop limit: 1 failed round on this branch/)
  expect(w.spawned).toEqual([])
})
test('rule 4: where the repository has not opted in there is no review', async ($, on) => {
  const w = world(on, null); await start($); await ready($, w)
  expect(await ask($)).toBe('This repository has not opted in to devloop (no devloop.json), so there is no review.')
})
test('rule 15: after a pass and more edits, the tool starts a new cycle at round 1; the cap bounds the cycle it starts', async ($, on) => {
  const w = world(on); await start($); await ready($, w); await ask($)
  await answer($, 'agent-1', 'VERDICT: PASS')
  await ready($, w, 'src/b.ts')
  expect(await ask($)).toBe(`Review round 1 of 2 started in a fresh context. Its verdict will show in the Dev loop pane. ${DO_NOT_EDIT}`)
  await answer($, 'agent-2', `${F_HIGH}\nVERDICT: FAIL`)
  await ready($, w)
  expect(await ask($)).toMatch(/^Review round 2 of 2 started/)
  await answer($, last(w)?.agentId ?? '', `${F_HIGH}\nVERDICT: FAIL`)
  await ready($, w, 'src/c.ts')
  expect(await ask($)).toBe('The review cap of 2 rounds is spent. This change needs a person to read it; /devloop done closes it when they have.')
  expect(w.spawned.length).toBe(3)
})
test('the rules ask for it once, when the whole change is done, and it is registered deferred with no arguments', () => {
  expect(RULES.split('\n').filter(line => line.includes('devloop_review'))).toEqual(['- When the whole change is done, call the devloop_review tool once, not after each step: a separate reviewer starts on the tree as it stands. Do not edit files until its verdict arrives: a verdict on a tree that has changed is discarded. When a round fails, fix its findings and stop: devloop re-reviews the fix by itself.'])
  const lines = RULES.split('\n')
  expect(lines.findIndex(line => line.includes('devloop_review'))).toBe(1 + lines.findIndex(line => line.startsWith('- You never grade or approve your own change')))
  expect(TOOL_SPECS.find(one => one.name === 'devloop_review')).toMatchObject({ inputSchema: { type: 'object', properties: {} }, isDeferred: true })
  expect(TOOL_SPECS.findIndex(one => one.name === 'devloop_review')).toBe(1 + TOOL_SPECS.findIndex(one => one.name === 'devloop_status'))
})

test('reviewOnFinish: a finished small fix gets its first review by itself, and only its first', async ($, on) => {
  const w = world(on, { ...CONFIG, reviewOnFinish: true }); await start($)
  await fix($, w)
  expect(w.spawned.length).toBe(1)
  await fix($, w, 'src/b.ts')
  expect(w.spawned.length).toBe(1)
})
