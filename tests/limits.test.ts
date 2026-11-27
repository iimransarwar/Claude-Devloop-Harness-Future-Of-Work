import { describe, expect, test } from 'claude-code/testing'

import { DEFAULTS, parseConfig } from '../hooks/config'
import type { Config } from '../hooks/config'
import { MISSED, OUTSIDE, parseReview, reviewPrompt, settleRound } from '../hooks/findings'
import type { PromptFacts } from '../hooks/findings'
import { gate } from '../hooks/gate'
import {
  allowMore, checksForChange, countRound, coveredKey, isAtLimit, limitLines, limitMessage, limitOf, limitOn, mostNamed, NO_LIMIT, orderSteps, unscopedFull,
} from '../hooks/limits'
import { FRESH } from '../hooks/state'
import { RULES } from '../hooks/templates'
import type { Loop, LoopLimit } from '../types'
import { change, CONFIG, devloop, prompt, start, stop, world } from './world'
import type { Dollar, World } from './world'

// The loop limit and targeted testing (docs/design-notes/loop-limits.md,
// DESIGN 4.16): the counter, the limit's one-time message, the refusal of an
// agent-started review, observe mode, the last-passing commit, a check's pass
// kept against the files it covers, the failed check first, the ship gate
// still requiring every check that applies, and the scoped second round.

type Stopped = { block?: string; additionalContext?: readonly string[] }
const stopped = async ($: Dollar): Promise<Stopped> => (await stop($)) as Stopped
const loopIn = (w: World): Loop => (w.store['loop:/repo'] as { value: Loop }).value
const AGENT = { kind: 'plugin', name: 'agent' } as const
const auditIn = (w: World): { action: string; actor: { kind: string } }[] =>
  Object.keys(w.files).filter(path => /\/audit\/\d{6}\.jsonl$/.test(path)).sort()
    .flatMap(file => (w.files[file] ?? '').split('\n').filter(line => line !== '').map(line => JSON.parse(line) as never))

/** A failing check, changed and stopped on: one round the gate hands back (or does not, at the limit). */
async function failingStop($: Dollar, w: World, file: string): Promise<Stopped> {
  change(w, file)

  return stopped($)
}

// ---------------------------------------------------------------- policy

describe('the policy: loop and testing', () => {
  test('defaults, values, and errors by field (the stricter reading where it matters)', () => {
    expect(parseConfig('{}').cfg.loop).toEqual({ failedRounds: 6 })
    expect(parseConfig('{}').cfg.testing).toEqual({ scope: 'targeted' })
    expect(parseConfig('{"loop":{"failedRounds":0},"testing":{"scope":"full"}}').cfg).toMatchObject({ loop: { failedRounds: 0 }, testing: { scope: 'full' } })
    const wrong = parseConfig('{"loop":{"failedRounds":"six","max":1},"testing":{"scope":"some"}}')
    expect(wrong.cfg.loop.failedRounds).toBe(6)
    expect(wrong.cfg.testing.scope).toBe('full')
    expect(wrong.errors).toEqual(['loop.max: unknown field', 'loop.failedRounds: expected a number from 0 to 100; using 6', 'testing.scope: expected "targeted" or "full"; using "full"'])
    expect(parseConfig('{"loop":3,"testing":"full"}').errors).toEqual(['loop: expected { "failedRounds": <a number from 0 to 100> }; using 6', 'testing: expected { "scope": "targeted" | "full" }; using "full"'])
  })
})

// ---------------------------------------------------------------- the counter (pure)

describe('the counter (decisions 1 to 3)', () => {
  const cfg = { loop: { failedRounds: 3 } }
  const round = (files: string[] = []) => ({ at: 1, kind: 'review' as const, what: 'round 1: F1', files })

  test('fail counts, a new branch starts at zero, a person allows more, 0 turns it off', () => {
    let limit: LoopLimit = limitOn(undefined, 'feature')
    expect(limit).toEqual({ ...NO_LIMIT, branch: 'feature' })
    limit = countRound(countRound(limit, round()), round())
    expect([limit.failed, isAtLimit(limit, cfg)]).toEqual([2, false])
    limit = countRound(limit, round())
    expect(isAtLimit(limit, cfg)).toBe(true)
    // The same branch keeps its record; another starts again.
    expect(limitOn(limit, 'feature')).toBe(limit)
    expect(limitOn(limit, 'other').failed).toBe(0)
    // A person's grant: the count starts again, and the limit is what they allowed.
    const more = allowMore({ ...limit, isTold: true }, 2)
    expect([more.failed, more.isTold, limitOf(more, cfg), more.rounds]).toEqual([0, false, 2, []])
    expect(isAtLimit(countRound(countRound(more, round()), round()), cfg)).toBe(true)
    expect(isAtLimit(countRound(limit, round()), { loop: { failedRounds: 0 } })).toBe(false)
  })

  test('the message names the count, the last commit that passed (or none), and continue; the most named file at three rounds', () => {
    const limit: LoopLimit = { ...NO_LIMIT, branch: 'feature', failed: 6, rounds: [round(['src/a.ts']), round(['src/a.ts', 'src/b.ts']), round(['src/b.ts'])] }
    expect(limitMessage(limit, DEFAULTS)).toBe('devloop: Loop limit: 6 failed rounds on this branch without a person. Stop now. Do not start another fix or review. Report in a few lines: what failed each time, what you tried, and the choices: (1) use the last commit that passed the gate (none on this branch), (2) accept the open findings as known gaps, (3) `/devloop continue` for 6 more rounds.')
    expect(limitMessage({ ...limit, lastPass: '0123456789abcdef' }, DEFAULTS)).toMatch(/passed the gate \(`0123456789ab`\)/)
    expect(mostNamed(limit.rounds)).toBe(null)
    const more = [...limit.rounds, round(['src/a.ts'])]
    expect(mostNamed(more)).toEqual({ file: 'src/a.ts', count: 3 })
    expect(limitLines({ ...limit, rounds: more }, DEFAULTS)).toEqual([
      'Failed rounds on this branch: 6 of 6: at the limit, a person decides (/devloop continue [n])',
      'review: round 1: F1 (src/a.ts)', 'review: round 1: F1 (src/a.ts, src/b.ts)', 'review: round 1: F1 (src/b.ts)', 'review: round 1: F1 (src/a.ts)',
      'The file named most often in their findings: src/a.ts (3 rounds)',
    ])
  })
})

// ---------------------------------------------------------------- the counter through the module

describe('the loop limit in the module', () => {
  const POLICY = { ...CONFIG, maxFixRounds: 10, loop: { failedRounds: 2 } }

  test('fix rounds count; at the limit the turn ends once with the message; the agent\'s review is refused, a person\'s runs', async ($, on) => {
    const w = world(on, POLICY)
    w.exits['npm test'] = 1
    await start($)
    await prompt($, 'fix the login')
    expect((await failingStop($, w, 'src/a.ts')).block).toMatch(/fix round 1/)
    expect((await failingStop($, w, 'src/b.ts')).block).toMatch(/fix round 2/)
    expect(loopIn(w).limit).toMatchObject({ branch: 'feature', failed: 2, isTold: false })
    // At the limit: nothing more is handed back, the turn ends once with the message, and the person is told.
    const at = await failingStop($, w, 'src/c.ts')
    expect(at.block).toBeUndefined()
    expect(at.additionalContext?.join('\n')).toMatch(/Loop limit: 2 failed rounds on this branch without a person\. Stop now\./)
    expect(w.toasts).toContain('devloop stopped after 2 failed rounds')
    expect(loopIn(w).limit.failed).toBe(2)
    expect(loopIn(w).events.some(one => /loop limit \(enforce\): 2 failed rounds on feature/.test(one.text))).toBe(true)
    // Once per limit: the next stop is not blocked and says nothing.
    const again = await failingStop($, w, 'src/d.ts')
    expect([again.block, again.additionalContext ?? []]).toEqual([undefined, []])
    // A review the agent starts is refused with the same text; a person's own runs.
    expect(await devloop($, 'review', AGENT)).toMatch(/^devloop: Loop limit: 2 failed rounds/)
    expect(w.spawned).toEqual([])
    expect(await devloop($, 'review')).toMatch(/Review round 1 of 2 started/)
    expect(w.spawned.length).toBe(1)
  })

  test('a pass costs nothing; /devloop done keeps the count; a new branch starts at zero; /devloop continue is a person\'s', async ($, on) => {
    const w = world(on, POLICY)
    await start($)
    await prompt($)
    expect((await failingStop($, w, 'src/a.ts')).block).toBeUndefined()
    expect(loopIn(w).limit.failed).toBe(0)
    w.exits['npm test'] = 1
    await failingStop($, w, 'src/b.ts')
    await failingStop($, w, 'src/c.ts')
    expect(loopIn(w).limit.failed).toBe(2)
    // Closing the change is not allowing more.
    w.answer = 'Close anyway'
    expect(await devloop($, 'done')).toMatch(/Change closed/)
    expect(loopIn(w).limit.failed).toBe(2)
    // An agent cannot allow more; a person can, and the journal says who.
    expect(await devloop($, 'continue', AGENT)).toMatch(/by a person, from the prompt/)
    expect(loopIn(w).limit.failed).toBe(2)
    expect(await devloop($, 'continue 1')).toMatch(/1 more failed round allowed on feature/)
    expect(loopIn(w).limit).toMatchObject({ failed: 0, grant: 1, isTold: false })
    expect(auditIn(w).filter(one => one.action === 'loop-continued').map(one => one.actor.kind)).toEqual(['person'])
    await prompt($)
    expect((await failingStop($, w, 'src/d.ts')).block).toMatch(/fix round 1/)
    expect((await failingStop($, w, 'src/e.ts')).additionalContext?.join('\n')).toMatch(/Loop limit: 1 failed round on this branch/)
    // Another branch: its own count, from zero, and the policy's number again.
    w.branch = 'other'
    expect((await failingStop($, w, 'src/f.ts')).block).toMatch(/fix round/)
    expect(loopIn(w).limit).toMatchObject({ branch: 'other', failed: 1, grant: null })
  })

  test('observe mode refuses nothing: the toast and the record only', async ($, on) => {
    const w = world(on, { ...POLICY, mode: 'observe', loop: { failedRounds: 1 } })
    w.exits['npm test'] = 1
    await start($)
    await prompt($)
    const first = await failingStop($, w, 'src/a.ts')
    expect([first.block, first.additionalContext ?? []]).toEqual([undefined, []])
    expect(w.toasts).toContain('devloop (observe): 1 failed rounds on this branch; in enforce mode devloop would stop here')
    expect((w.store['ledger:/repo'] as { kind: string }[]).some(one => one.kind === 'loop-limit')).toBe(true)
    expect(await devloop($, 'review', AGENT)).toMatch(/Review round 1 of 2 started/)
  })

  test('a review round that ends FAIL counts once, and at the limit the builder is not woken: the message is appended once', async ($, on) => {
    const w = world(on, { ...POLICY, loop: { failedRounds: 1 }, reviewers: [{ name: 'security', when: ['src/**'], mode: 'blocking' }] })
    w.files['/repo/src/charge.ts'] = 'import x\nexport function charge(cents) {\n  return Math.floor(cents)\n}'
    await start($)
    await prompt($)
    await failingStop($, w, 'src/charge.ts')
    await devloop($, 'review')
    const finding = 'F1 | high | src/charge.ts:3 | return Math.floor(cents) | rounds down | a test\nVERDICT: FAIL'
    for (const one of w.spawned) {
      await $.turn.complete({ answer: finding, durationMs: 1, isAborted: false, turnId: 't', agentId: one.agentId, reason: 'answer' })
    }
    expect(loopIn(w).limit.failed).toBe(1)
    expect(loopIn(w).limit.rounds[0]).toMatchObject({ kind: 'review', files: ['src/charge.ts'] })
    expect(w.submitted).not.toContain(expect.stringMatching(/rounds down/))
    expect(w.appended.filter(one => /Loop limit: 1 failed round/.test(one)).length).toBe(1)
    expect(w.appended.some(one => /rounds down/.test(one))).toBe(false)
    expect(loopIn(w).review.isLooping).toBe(false)
  })

  test('the last commit that passed the gate: HEAD when the work is committed and every row is met; doctor reports the limit and the count', async ($, on) => {
    const w = world(on, POLICY)
    await start($)
    await prompt($)
    // A low-risk change: the checks are the gate.
    // Uncommitted work: HEAD's tree is not the one judged.
    w.committable = 'uncommitted'
    w.headTree = 'head-before'
    await failingStop($, w, 'docs/a.md')
    expect(loopIn(w).limit.lastPass).toBe(null)
    w.committable = null
    w.headTree = null
    await failingStop($, w, 'docs/b.md')
    expect(loopIn(w).limit.lastPass).toBe('abc')
    w.exits['npm test'] = 1
    await failingStop($, w, 'docs/c.md')
    await failingStop($, w, 'docs/d.md')
    expect((await failingStop($, w, 'docs/e.md')).additionalContext?.join('\n')).toMatch(/use the last commit that passed the gate \(`abc`\)/)
    expect(await devloop($, 'doctor')).toMatch(/loop limit: 2 failed rounds on a branch without a person; 2 counted on feature: at the limit, \/devloop continue \[n\] allows more; the last commit that passed the gate: abc/)
  })

  test('stored state of the earlier shape reads as fresh', async ($, on) => {
    const w = world(on, POLICY)
    w.store['loop:/repo'] = { shape: 'loop-10', value: { ...FRESH, root: '/repo', sessionId: 'earlier', phase: 'spec', spec: 'old' } }
    await start($)
    expect(await devloop($, 'status')).toMatch(/small-fix mode/)
  })
})

// ---------------------------------------------------------------- targeted testing

describe('a pass belongs to the files it covered (decision 7)', () => {
  const LISTING = (a: string, b: string): string => [`100644 blob ${a}\tsrc/a/x.ts`, `100644 blob ${b}\tsrc/b/y.ts`, '100644 blob 333\tREADME.md'].join('\n')

  test('the key: the covered files only, null when none matches', () => {
    expect(coveredKey(LISTING('111', '222'), ['src/a/**'])).toBe(coveredKey(LISTING('111', '999'), ['src/a/**']))
    expect(coveredKey(LISTING('111', '222'), ['src/a/**'])).not.toBe(coveredKey(LISTING('112', '222'), ['src/a/**']))
    expect(coveredKey(LISTING('111', '222'), ['lib/**'])).toBe(null)
    expect(coveredKey('', ['src/a/**'])).toBe(null)
  })

  const SCOPED = { ...CONFIG, maxFixRounds: 10, verify: [{ run: 'npm run lint-a', when: ['src/a/**'] }, 'npm test'] }

  test('an edit outside a check\'s globs does not run it again; one inside does; testing.scope "full" runs it on every tree', async ($, on) => {
    const w = world(on, SCOPED)
    w.outputs['#covered-files'] = LISTING('111', '222')
    await start($)
    await prompt($)
    await failingStop($, w, 'src/a/x.ts')
    expect(w.ran).toEqual(['npm run lint-a', 'npm test'])
    expect(Object.keys(loopIn(w).verify.covered)).toEqual(['npm run lint-a'])
    w.ran = []
    w.outputs['#covered-files'] = LISTING('111', '999')
    await failingStop($, w, 'src/b/y.ts')
    expect(w.ran).toEqual(['npm test'])
    // Its pass covers this tree too, so the gate's Verification row is met.
    expect(loopIn(w).verify.passedOn['npm run lint-a']).toBe(w.tree)
    w.ran = []
    w.outputs['#covered-files'] = LISTING('112', '999')
    await failingStop($, w, 'src/a/z.ts')
    expect(w.ran).toEqual(['npm run lint-a', 'npm test'])
  })

  test('under "full" every check runs on every tree, as before', async ($, on) => {
    const w = world(on, { ...SCOPED, testing: { scope: 'full' } })
    w.outputs['#covered-files'] = LISTING('111', '222')
    await start($)
    await prompt($)
    await failingStop($, w, 'src/a/x.ts')
    w.ran = []
    await failingStop($, w, 'src/b/y.ts')
    expect(w.ran).toEqual(['npm run lint-a', 'npm test'])
  })

  test('after a failure the failed check runs first, and alone when it fails again', async ($, on) => {
    const w = world(on, { ...CONFIG, maxFixRounds: 10, verify: ['npm run a', 'npm run b'] })
    w.exits['npm run b'] = 1
    await start($)
    await prompt($)
    expect((await failingStop($, w, 'src/x.ts')).block).toMatch(/npm run b/)
    expect(w.ran).toEqual(['npm run a', 'npm run b'])
    w.ran = []
    expect((await failingStop($, w, 'src/y.ts')).block).toMatch(/npm run b/)
    expect(w.ran).toEqual(['npm run b'])
    w.ran = []
    w.exits['npm run b'] = 0
    expect((await failingStop($, w, 'src/z.ts')).block).toBeUndefined()
    expect(w.ran).toEqual(['npm run b', 'npm run a'])
    expect(orderSteps([{ run: 'a', profile: 'fast', when: null }, { run: 'b', profile: 'fast', when: null }], 'b', { testing: { scope: 'full' } }).map(one => one.run)).toEqual(['a', 'b'])
  })

  test('the ship gate still requires a pass for every check whose globs match the change, and for every check without globs', () => {
    const cfg: Config = { ...DEFAULTS, verify: [
      { run: 'lint-a', profile: 'fast', when: ['src/a/**'] }, { run: 'lint-c', profile: 'full', when: ['src/c/**'] }, { run: 'e2e', profile: 'full', when: null },
    ] }
    const loop: Loop = { ...FRESH, tree: 't1', changed: ['src/a/x.ts'], tier: 'low', size: { files: 1, lines: 3 }, verify: { ...FRESH.verify, status: 'pass', tree: 't1', profile: 'fast', passedOn: { 'lint-a': 't1' } } }
    const row = (one: Loop) => gate(one, cfg, { errors: [], lint: [], policy: 'same' }).find(check => check.label === 'Verification')
    expect(row(loop)).toMatchObject({ isMet: false, note: expect.stringMatching(/still to run e2e$/) })
    expect(row({ ...loop, verify: { ...loop.verify, passedOn: { 'lint-a': 't1', e2e: 't1' } } })?.isMet).toBe(true)
    expect(row({ ...loop, changed: ['src/a/x.ts', 'src/c/y.ts'], verify: { ...loop.verify, passedOn: { 'lint-a': 't1', e2e: 't1' } } })).toMatchObject({ isMet: false, note: expect.stringMatching(/lint-c/) })
    expect(unscopedFull(cfg)).toEqual(['e2e'])
  })
})

// ---------------------------------------------------------------- the rule and the context line

describe('the rule the agent sees (decision 6)', () => {
  test('the paragraph is in the rules text, once, word for word', () => {
    const paragraph = 'Test what you changed. Run the check that covers the files you touched, not the whole suite, and do not re-run a check that passed on files that have not changed since. After a failure, re-run the check that failed. The harness runs whatever else applies when the change ships.'
    expect(RULES.split(paragraph).length).toBe(2)
  })

  test('the context line names the checks that apply to the files changed', async ($, on) => {
    expect(checksForChange({ verify: [{ run: 'lint-a', profile: 'fast', when: ['src/a/**'] }, { run: 'e2e', profile: 'full', when: null }] }, ['src/b/x.ts'])).toBe('Checks for what you changed: `e2e` (run when the change ships).')
    expect(checksForChange({ verify: [] }, ['src/b/x.ts'])).toBe(null)
    const w = world(on, { ...CONFIG, verify: [{ run: 'npm run lint-a', when: ['src/a/**'] }, 'npm test'] })
    await start($)
    await prompt($)
    change(w, 'src/a/x.ts')
    await stop($)
    await prompt($)
    expect(w.contexts[w.contexts.length - 1]?.join('\n')).toMatch(/Checks for what you changed: `npm run lint-a`, `npm test`\./)
  })

  test('doctor names a full check without when; init proposes when globs where the layout is plain', async ($, on) => {
    const w = world(on, { ...CONFIG, verify: ['npm test', { run: 'npm run e2e', profile: 'full' }] })
    await start($)
    expect(await devloop($, 'doctor')).toMatch(/`npm run e2e` runs in full on every change that ships: add `when` globs to scope it/)
    delete w.files['/repo/devloop.json']
    w.basePolicy = null
    w.files['/repo/go.mod'] = 'module x'
    await devloop($, 'init')
    // The setup question that proposes the checks names each in full, its when globs too.
    expect(w.questions.join('\n')).toMatch(/go test \.\/\.\.\. \(when \*\*\/\*\.go go\.mod go\.sum\)/)
    expect(JSON.parse(w.files['/repo/devloop.json'] ?? '{}').verify).toEqual([{ run: 'go vet ./...', when: ['**/*.go', 'go.mod', 'go.sum'] }, { run: 'go test ./...', when: ['**/*.go', 'go.mod', 'go.sum'] }])
  })
})

// ---------------------------------------------------------------- a second review reads the fix

describe('a second review round reads the fix (decision 8)', () => {
  const FACTS: PromptFacts = { brief: 'b', reviewMd: null, spec: null, base: 'b0', diff: '/d/review-2.diff', tier: 'medium', changed: ['src/a.ts'], checks: [], round: 2, maxRounds: 3, open: [], nextId: 2 }

  test('round 2 is given the diff since round 1 and told to confirm findings and review only those lines; round 1 is unchanged', () => {
    const scoped = reviewPrompt({ ...FACTS, delta: '+++ b/src/a.ts\n+fixed()' })
    expect(scoped).toMatch(/This is round 2: it reads the fix, not the whole change again\./)
    expect(scoped).toMatch(/review only the lines changed since the last round/)
    expect(scoped).toMatch(/```diff\n\+\+\+ b\/src\/a.ts\n\+fixed\(\)\n```/)
    expect(scoped).toMatch(/for context only/)
    expect(reviewPrompt({ ...FACTS, round: 1 })).toBe(reviewPrompt({ ...FACTS, round: 1, delta: null }))
    expect(reviewPrompt({ ...FACTS, round: 1 })).not.toMatch(/reads the fix|outside/)
  })

  test('outside the delta: a follow-up that does not fail the round; high fails it as missed earlier; in round 1 the mark changes nothing', () => {
    const files = { 'src/a.ts': 'one()\ntwo()\nthree()' }
    const answer = (text: string) => [{ name: 'general', parsed: parseReview(`${text}\nVERDICT: FAIL`) }]
    const low = settleRound({ round: 2, tier: 'high', prior: [], answers: answer('F1 | medium | src/a.ts:1 | one() | slow | a bench | outside'), files, isScoped: true })
    expect(low.isPassing).toBe(true)
    expect(low.findings[0]).toMatchObject({ status: 'deferred', route: 'defer', isBlocking: false, problem: `${OUTSIDE}slow` })
    expect(low.deferred.map(one => one.id)).toEqual(['F1'])
    const high = settleRound({ round: 2, tier: 'medium', prior: [], answers: answer('F1 | high | src/a.ts:2 | two() | wrong | a test | outside'), files, isScoped: true })
    expect(high.isPassing).toBe(false)
    expect(high.findings[0]).toMatchObject({ status: 'open', isBlocking: true, problem: `${MISSED}wrong` })
    const first = settleRound({ round: 1, tier: 'high', prior: [], answers: answer('F1 | medium | src/a.ts:1 | one() | slow | a bench | outside'), files })
    expect(first.findings[0]).toMatchObject({ status: 'open', isBlocking: true, problem: 'slow' })
  })

  test('through the module: round 2 gets the open finding and the diff since round 1', async ($, on) => {
    const w = world(on, CONFIG)
    w.files['/repo/src/charge.ts'] = 'import x\nexport function charge(cents) {\n  return Math.floor(cents)\n}'
    await start($)
    await prompt($)
    change(w, 'src/charge.ts')
    await stop($)
    await devloop($, 'review')
    await $.turn.complete({ answer: 'F1 | high | src/charge.ts:3 | return Math.floor(cents) | rounds down | a test\nVERDICT: FAIL', durationMs: 1, isAborted: false, turnId: 't', agentId: w.spawned[0]?.agentId ?? '', reason: 'answer' })
    expect(w.spawned[0]?.prompt).not.toMatch(/reads the fix/)
    w.outputs['#round-delta'] = '+++ b/src/charge.ts\n+  return Math.round(cents)'
    change(w, 'src/charge.ts')
    await stop($)
    const second = w.spawned[1]?.prompt ?? ''
    expect(second).toMatch(/This is round 2: it reads the fix/)
    expect(second).toMatch(/\+  return Math.round\(cents\)/)
    expect(second).toMatch(/Open findings to re-check[\s\S]*F1 \| high \| src\/charge.ts:3/)
    expect(loopIn(w).review.isScoped).toBe(true)
  })
})
