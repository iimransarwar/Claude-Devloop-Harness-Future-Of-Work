import { describe, expect, test } from 'claude-code/testing'

import {
  breadthOf, EMPTY_LEARNED, judgeLearned, learnedOf, learnedRules, limitLesson, parseProposals, pendingGroups, repeatLesson, sweepLearned, trialReason, withHits,
} from '../hooks/autolearn'
import type { Learned, LearnedRule } from '../hooks/autolearn'
import { DEFAULTS, parseConfig } from '../hooks/config'
import type { Config } from '../hooks/config'
import { learnGroups } from '../hooks/ledger'
import type { Entry } from '../hooks/ledger'
import { FRESH } from '../hooks/state'
import { RULES } from '../hooks/templates'
import type { Loop } from '../types'
import { change, CONFIG, devloop, edit, ledgerOf, prompt, start, stop, turn, world } from './world'
import type { Dollar, World } from './world'

// Learning without being asked (docs/design-notes/auto-learning.md, DESIGN
// 4.17): the lessons the harness writes, the proposer's trigger and its
// bounds, the proposal format, the gates to a trial, a trial rule at work,
// its removal, the promotion notice, the person's /devloop rules, the modes,
// and old stored state.

const DAY = 24 * 60 * 60 * 1000
// Learning runs by itself only when a policy opts in (the default is "off"): these tests opt in.
const LEARN = { ...CONFIG, learning: { auto: 'trial' } }
const AGENT = { kind: 'plugin', name: 'agent' } as const
const loopIn = (w: World): Loop => (w.store['loop:/repo'] as { value: Loop }).value
const learnedIn = (w: World): Learned => learnedOf(w.store['learning:/repo'])
const lessons = (w: World, prefix = ''): Entry[] => (ledgerOf(w) as Entry[]).filter(one => one.kind === 'lesson' && one.key.startsWith(prefix))
const learners = (w: World): { agentId: string; prompt: string }[] => w.spawned.filter(one => one.subagentType === 'devloop:learner')
const auditIn = (w: World): { action: string; subject: string; actor: { kind: string } }[] =>
  Object.keys(w.files).filter(path => /\/audit\/\d{6}\.jsonl$/.test(path)).sort()
    .flatMap(file => (w.files[file] ?? '').split('\n').filter(line => line !== '').map(line => JSON.parse(line) as never))
const run = ($: Dollar, args: string, origin: { kind: string; name?: string } = { kind: 'composer' }) =>
  $.command.run({ command: 'devloop', args, origin: origin as never, presentation: { isFullscreen: false, columns: 80 } })
const answer = ($: Dollar, agentId: string, text: string, isAborted = false) =>
  $.turn.complete({ answer: text, durationMs: 1, isAborted, turnId: 't', agentId, reason: 'answer' })
/** Three refusals of one rule, as the ledger keeps them: a repeat group at the default `repeats`. */
const repeats = (key = 'protected', n = 3, at = 500): Entry[] => Array.from({ length: n }, (_, i) => ({ at: at + i, kind: 'guard-deny', key, detail: `REVIEW.md ${i}` }))
const trial = (over: Partial<LearnedRule> = {}): LearnedRule => ({
  id: 'learn-1', group: 'refusal:protected', when: ['src/**'], pattern: 'console\\.log', why: 'use the logger', evalTask: 'evals/tasks/no-log.json', at: 1000,
  status: 'trial', hits: 0, last: null, seen: [], isTold: false, promotedAt: null, evidence: { label: 'guard-deny: protected', count: 3, sample: 'REVIEW.md' }, ...over,
})
const withTrial = (w: World, over: Partial<LearnedRule> = {}): void => {
  w.store['learning:/repo'] = { ...EMPTY_LEARNED, next: 2, rules: [trial(over)] }
}
const logLine = ($: Dollar) => $.tool.call({ tool: 'Edit', file_path: '/repo/src/a.ts', old_string: 'a', new_string: 'console.log(a)' })
const RULE_LINE = 'P1 | refusal:protected | rule | src/** | console\\.log | use the logger | evals/tasks/no-log.json: an edit adding console.log is noted'
const cfgOf = (learning: Partial<Config['learning']> = {}): Config => ({ ...DEFAULTS, learning: { ...DEFAULTS.learning, auto: 'trial', ...learning } })

// ---------------------------------------------------------------- policy

describe('the policy: learning and models.learner (decision 5)', () => {
  test('defaults, values, and errors by field', () => {
    expect(parseConfig('{}').cfg.learning).toEqual({ auto: 'off', repeats: 3, promoteHits: 3, maxTrial: 20, maxRuns: 3 })
    expect(parseConfig('{}').cfg.models.learner).toBe(null)
    const set = parseConfig('{"learning":{"auto":"propose","repeats":5,"promoteHits":1,"maxTrial":0,"maxRuns":10},"models":{"learner":"haiku"}}')
    expect([set.cfg.learning, set.cfg.models.learner, set.errors]).toEqual([{ auto: 'propose', repeats: 5, promoteHits: 1, maxTrial: 0, maxRuns: 10 }, 'haiku', []])
    const wrong = parseConfig('{"learning":{"auto":"always","repeats":0,"promoteHits":101,"x":1}}')
    expect(wrong.cfg.learning).toEqual({ auto: 'off', repeats: 3, promoteHits: 3, maxTrial: 20, maxRuns: 3 })
    expect(wrong.errors).toEqual(['learning.x: unknown field', 'learning.auto: expected "off", "propose" or "trial"; using "off"', 'learning.repeats: expected a number from 1 to 100; using 3', 'learning.promoteHits: expected a number from 0 to 100; using 3'])
    expect(parseConfig('{"learning":"on"}').cfg.learning.auto).toBe('off')
  })

  test('the rules text is unchanged by the feature: nothing of it reaches the builder there', () => {
    expect(RULES).not.toMatch(/learner|proposer|trial rule/i)
  })
})

// ---------------------------------------------------------------- decision 1

describe('lessons write themselves (decision 1)', () => {
  test('the loop limit leaves one lesson per branch: the rounds, the checks, the file named most; again raises its count', async ($, on) => {
    const w = world(on, { ...LEARN, loop: { failedRounds: 2 } })
    w.exits['npm test'] = 1
    await start($)
    await prompt($)
    change(w, 'src/a.ts')
    await stop($)
    change(w, 'src/b.ts')
    await stop($)
    change(w, 'src/c.ts')
    await stop($)
    const limited = (): Entry[] => lessons(w, 'auto:loop-limit')
    expect(limited()).toHaveLength(1)
    expect(limited()[0]).toMatchObject({ key: 'auto:loop-limit:feature', auto: true, count: 1 })
    expect(limited()[0]?.detail).toMatch(/stopped the agent on feature after 2 failed rounds; checks that failed: npm test; file named most often in the findings: none/)
    // A person allows more, and the limit stops it again: the same lesson, counted twice.
    await devloop($, 'continue 1')
    await prompt($)
    change(w, 'src/d.ts')
    await stop($)
    change(w, 'src/e.ts')
    await stop($)
    expect(limited()).toHaveLength(1)
    expect(limited()[0]?.count).toBe(2)
    expect(learnGroups(ledgerOf(w) as Entry[]).find(one => one.key === 'lesson:auto:loop-limit:feature')?.count).toBe(2)
  })

  test('the same check failing twice in a row with the same fingerprint leaves one lesson: the command and the first error line', async ($, on) => {
    const w = world(on, { ...LEARN, maxFixRounds: 5 })
    w.exits['npm test'] = 1
    w.outputs['npm test'] = 'FAIL src/a.test.ts\n  expected 1, got 2'
    await start($)
    await prompt($)
    change(w, 'src/a.ts')
    expect((await stop($) as { block?: string }).block).toMatch(/fix round 1/)
    expect(lessons(w)).toEqual([])
    change(w, 'src/b.ts')
    expect((await stop($) as { block?: string }).block).toMatch(/same failure as the last round/)
    change(w, 'src/c.ts')
    await stop($)
    expect(lessons(w)).toHaveLength(1)
    expect(lessons(w)[0]).toMatchObject({ auto: true, count: 2 })
    expect(lessons(w)[0]?.key).toMatch(/^auto:same-failure:npm test#/)
    expect(lessons(w)[0]?.detail).toMatch(/`npm test` failed twice in a row the same way: FAIL src\/a.test.ts/)
  })

  test('the pure words, and /devloop lesson still records what the harness cannot see', async ($, on) => {
    expect(repeatLesson('npm test', 'abc', '\nError: boom\nmore').detail).toBe('`npm test` failed twice in a row the same way: Error: boom')
    expect(limitLesson('main', { branch: 'main', failed: 3, grant: null, isTold: false, lastPass: null, rounds: [{ at: 1, kind: 'review', what: 'round 1', files: ['a.ts'] }, { at: 2, kind: 'fix', what: 'npm test', files: [] }, { at: 3, kind: 'review', what: 'round 2', files: ['a.ts', 'b.ts'] }] }).detail)
      .toMatch(/checks that failed: npm test; file named most often in the findings: a.ts \(2 rounds\)/)
    const w = world(on, LEARN)
    await start($)
    expect(await devloop($, 'lesson the staging host is not prod')).toMatch(/Recorded/)
    expect(lessons(w).map(one => [one.key, one.auto])).toEqual([['the staging host is not prod', undefined]])
  })
})

// ---------------------------------------------------------------- decision 2

describe('learn runs by itself (decision 2)', () => {
  test('at `repeats` the proposer starts at the end of the turn, never in the middle of it, and once per group', async ($, on) => {
    const w = world(on, LEARN)
    await start($)
    await prompt($)
    for (let i = 0; i < 3; i += 1) {
      expect((await edit($, '/repo/REVIEW.md')).deny).toMatch(/part of the harness or its policy/)
    }
    // The group reached three inside the turn: nothing starts until the turn ends.
    expect(learners(w)).toEqual([])
    await turn($, {})
    expect(learners(w)).toHaveLength(1)
    expect(learners(w)[0]?.prompt).toMatch(/refusal:protected \| 3 \| guard-deny: protected/)
    expect(learners(w)[0]?.prompt).toMatch(/sample: REVIEW.md/)
    expect(learners(w)[0]?.prompt).toMatch(/P<n> \| <group key> \| rule \| <glob>\[,<glob>...\] \| <pattern> \| <why> \| <eval task in one line>/)
    expect(loopIn(w).learner).toMatchObject({ agentId: 'agent-1', runs: 1, groups: ['refusal:protected'] })
    // It answers with nothing: the group was asked once, and is not asked again however often it fails.
    await answer($, 'agent-1', 'Nothing to propose.')
    await prompt($)
    await edit($, '/repo/REVIEW.md')
    await turn($, {})
    expect(learners(w)).toHaveLength(1)
    // A proposer run is not a round: the loop limit counts nothing for it.
    expect(loopIn(w).limit.failed).toBe(0)
  })

  test('no run on a turn no person started, past maxRuns, or with the budget spent', async ($, on) => {
    const w = world(on, { ...LEARN, learning: { auto: 'trial', maxRuns: 1 } })
    w.store['ledger:/repo'] = repeats()
    await start($)
    // A turn no person's prompt started (a background wake): nothing.
    await turn($, {})
    expect(learners(w)).toEqual([])
    await prompt($)
    await turn($, {})
    expect(learners(w)).toHaveLength(1)
    await answer($, 'agent-1', '')
    // Another group reaches three, but this session has had its one run.
    w.store['ledger:/repo'] = [...(w.store['ledger:/repo'] as Entry[]), ...repeats('secret', 3, 900)]
    await prompt($)
    await turn($, {})
    expect(learners(w)).toHaveLength(1)
  })

  test('no run with the budget spent, or while a review runs', async ($, on) => {
    const w = world(on, { ...LEARN, budgetUsd: 1 })
    w.store['ledger:/repo'] = repeats()
    w.cost = 5
    await start($)
    await prompt($)
    await turn($, {})
    expect(learners(w)).toEqual([])
    w.cost = 0.5
    w.store['loop:/repo'] = { shape: 'loop-13', value: { ...loopIn(w), review: { ...loopIn(w).review, status: 'running', round: 1, at: 1000 } } }
    await start($)
    await prompt($)
    await turn($, {})
    expect(learners(w)).toEqual([])
  })

  test('a new session starts the count of runs over; old stored state reads as fresh', async ($, on) => {
    const w = world(on, LEARN)
    w.store['loop:/repo'] = { shape: 'loop-11', value: { ...FRESH, root: '/repo', sessionId: 'earlier', phase: 'build', spec: 'old' } }
    await start($)
    expect(loopIn(w).phase).toBe('idle')
    expect(loopIn(w).learner).toEqual({ agentId: null, at: 0, groups: [], runs: 0 })
    expect((w.store['loop:/repo'] as { shape: string }).shape).toBe('loop-13')
    expect(learnedOf({ shape: 'learning-0', rules: [] })).toEqual(EMPTY_LEARNED)
    expect(learnedOf(undefined)).toEqual(EMPTY_LEARNED)
  })

  test('/devloop done starts a run while a repeat waits, once per group', async ($, on) => {
    const v = world(on, LEARN)
    v.store['ledger:/repo'] = repeats()
    await start($)
    await devloop($, 'done')
    expect(learners(v)).toHaveLength(1)
    await answer($, 'agent-1', '')
    await devloop($, 'done')
    expect(learners(v)).toHaveLength(1)
  })

  test('the answer: good lines are kept, a bad one dropped and counted, the person told once with counts only', async ($, on) => {
    const w = world(on, LEARN)
    w.store['ledger:/repo'] = repeats()
    w.tracked = ['src/a.ts']
    w.files['/repo/src/a.ts'] = 'export const a = 1\n'
    await start($)
    await prompt($)
    await turn($, {})
    const text = [
      'Here is what I propose.',
      RULE_LINE,
      'P2 | refusal:protected | instruction | CLAUDE.md | Never edit REVIEW.md: ask the person. | it was refused three times | evals/tasks/review-md.json',
      'P3 | refusal:nothing | rule | src/** | x | y | z',
      'P4 | refusal:protected | rule',
    ].join('\n')
    await answer($, 'agent-1', text)
    const learned = learnedIn(w)
    expect(learned.rules.map(one => [one.id, one.status, one.pattern, one.when])).toEqual([['learn-1', 'trial', 'console\\.log', ['src/**']]])
    expect(learned.proposals.map(one => [one.id, one.kind, one.file, one.text])).toEqual([['learn-2', 'instruction', 'CLAUDE.md', 'Never edit REVIEW.md: ask the person.']])
    expect(learned.dropped).toBe(2)
    expect(w.toasts.filter(one => /proposals? waiting/.test(one))).toEqual(['devloop: 2 proposals waiting: /devloop learn'])
    expect(loopIn(w).events.map(one => one.text)).toContain('proposer run: 2 proposals, 1 on trial; 2 lines not in the format, dropped; /devloop learn')
    expect(loopIn(w).learner.agentId).toBe(null)
    // Nothing of the proposer's text went to the builder: not appended, not submitted, not in a prompt's context.
    const seen = [...w.appended, ...w.submitted, ...w.contexts.flat()].join('\n')
    expect(seen).not.toMatch(/Never edit REVIEW.md|use the logger|console\\\\.log/)
    // /devloop learn opens with them, for the person only; the model reads the repeats and the ladder, as before.
    const learn = await run($, 'learn')
    expect(learn.isTextDisplayOnly).toBe(true)
    expect(learn.text).toMatch(/Trial rules \(1;[^]*learn-1[^]*Waiting proposals \(1;[^]*learn-2 {2}instruction in CLAUDE.md[^]*text: Never edit REVIEW.md: ask the person.[^]*Failures seen more than once/)
    expect(learn.context?.join('\n')).not.toMatch(/Never edit|use the logger/)
    expect(learn.context?.[1]).toMatch(/cheapest durable fix/)
  })

  test('the format, pure: fields around a pattern that holds " | ", prose ignored, unknown group and kind dropped', () => {
    const read = parseProposals([
      'P1 | check:npm test | rule | src/**,lib/** | (foo | bar) | why it fails | a task',
      'P2 | check:npm test | skill | .claude/skills/x/SKILL.md | run the build first | the build | another task',
      'P3 | check:npm test | lint | a | b | c | d',
      'P4 | check:other | rule | src/** | x | y | z',
      'P5 check:npm test rule',
      'Some prose about P-values.',
    ].join('\n'), ['check:npm test'])
    expect(read.dropped).toBe(3)
    expect(read.proposals).toEqual([
      { group: 'check:npm test', kind: 'rule', globs: ['src/**', 'lib/**'], pattern: '(foo | bar)', file: null, text: null, why: 'why it fails', evalTask: 'a task' },
      { group: 'check:npm test', kind: 'skill', globs: [], pattern: null, file: '.claude/skills/x/SKILL.md', text: 'run the build first', why: 'the build', evalTask: 'another task' },
    ])
  })

  test('pending groups: at least `repeats`, none proposed or ruled, not a learned rule\'s own hits, not asked since a tombstone', () => {
    const entries = [...repeats(), ...repeats('secret', 2), ...repeats('learn-1', 3).map(one => ({ ...one, kind: 'content-rule' }))]
    expect(pendingGroups(entries, [], EMPTY_LEARNED, 3).map(one => one.key)).toEqual(['content:learn-1', 'refusal:protected'])
    const ruled = { ...EMPTY_LEARNED, rules: [trial()] }
    expect(pendingGroups(entries, [], ruled, 3).map(one => one.key)).toEqual([])
    const asked = { ...EMPTY_LEARNED, asked: [{ key: 'refusal:protected', at: 600 }] }
    expect(pendingGroups(entries, [], asked, 3).map(one => one.key)).toEqual(['content:learn-1'])
    // A person's /devloop learn asks again, from two occurrences.
    expect(pendingGroups(entries, [], asked, 2, true).map(one => one.key)).toEqual(['content:learn-1', 'refusal:protected', 'refusal:secret'])
    // Tombstoned: left out until the failure returns `repeats` times after it.
    const stone = [{ id: 'protected', evidence: 'x', at: 700 }]
    expect(pendingGroups(repeats(), stone, EMPTY_LEARNED, 3)).toEqual([])
    expect(pendingGroups([...repeats(), ...repeats('protected', 3, 800)], stone, { ...EMPTY_LEARNED, asked: [{ key: 'refusal:protected', at: 600 }] }, 3).map(one => one.key)).toEqual(['refusal:protected'])
  })
})

// ---------------------------------------------------------------- decision 3

describe('proposed rules start on trial (decision 3)', () => {
  const one = { id: 'learn-1', group: 'refusal:protected', kind: 'rule' as const, globs: ['src/**'], pattern: 'console\\.log', file: null, text: null, why: 'w', evalTask: 'e' }

  test('each gate: the mode, length, validation, a tombstone, maxTrial', () => {
    const cfg = cfgOf()
    expect(trialReason(one, EMPTY_LEARNED, [], cfg, 'protected')).toBe(null)
    expect(trialReason(one, EMPTY_LEARNED, [], cfgOf({ auto: 'propose' }), 'protected')).toBe('learning.auto is "propose": a proposed rule waits for a person')
    expect(trialReason({ ...one, pattern: 'x'.repeat(201) }, EMPTY_LEARNED, [], cfg, 'protected')).toBe('its pattern is longer than 200 characters')
    expect(trialReason({ ...one, pattern: '(' }, EMPTY_LEARNED, [], cfg, 'protected')).toBe('it fails a content rule\'s validation: rules[0].pattern: not a valid regular expression; left out')
    expect(trialReason({ ...one, globs: [] }, EMPTY_LEARNED, [], cfg, 'protected')).toMatch(/fails a content rule's validation: rules\[0\]: expected/)
    expect(trialReason(one, EMPTY_LEARNED, [{ id: 'protected', evidence: 'x', at: 1 }], cfg, 'protected')).toBe('a tombstone names its group or rule')
    expect(trialReason(one, EMPTY_LEARNED, [{ id: 'refusal:protected', evidence: 'x', at: 1 }], cfg, 'protected')).toBe('a tombstone names its group or rule')
    expect(trialReason(one, { ...EMPTY_LEARNED, rules: [trial(), trial({ id: 'learn-2' })] }, [], cfgOf({ maxTrial: 2 }), 'protected')).toBe('2 trial rules exist already (learning.maxTrial is 2)')
    expect(breadthOf('x', ['x\n'.repeat(300)])).toBe(201)
    expect(breadthOf('(', ['(((('])).toBe(0)
  })

  test('too broad, across the tracked files its globs match: it waits, with the reason', async ($, on) => {
    const w = world(on, LEARN)
    w.store['ledger:/repo'] = repeats()
    w.tracked = ['src/a.ts', 'lib/b.ts']
    w.files['/repo/src/a.ts'] = 'const x = 1\n'.repeat(201)
    w.files['/repo/lib/b.ts'] = 'console.log(1)\n'.repeat(500)
    await start($)
    await prompt($)
    await turn($, {})
    await answer($, 'agent-1', ['P1 | refusal:protected | rule | src/** | const | w | e', 'P2 | refusal:protected | rule | src/** | console\\.log | w | e'].join('\n'))
    expect(learnedIn(w).proposals.map(one => [one.id, one.reason])).toEqual([['learn-1', 'too broad: it matches more than 200 existing lines in the tracked files its globs match']])
    expect(learnedIn(w).rules.map(one => one.id)).toEqual(['learn-2'])
  })

  test('a trial rule records a hit (path, line number, fingerprint) and refuses nothing, says nothing, adds nothing', async ($, on) => {
    const w = world(on, LEARN)
    w.files['/repo/src/a.ts'] = 'a'
    withTrial(w)
    await start($)
    const done = await logLine($) as { deny?: string; context?: readonly string[] }
    expect(done.deny).toBeUndefined()
    expect(done.context).toBeUndefined()
    const hit = ledgerOf(w).find(one => one.kind === 'content-rule') as Entry | undefined
    expect(hit?.key).toBe('learn-1')
    expect(hit?.detail).toMatch(/^src\/a.ts:1 [0-9a-f]+$/)
    expect((w.store['rulehits:/repo'] as Record<string, { hits: number }>)['learn-1']?.hits).toBe(1)
    expect(learnedIn(w).rules[0]).toMatchObject({ hits: 1, seen: [{ path: 'src/a.ts', line: 1 }] })
    expect(JSON.stringify(w.store['learning:/repo'])).not.toMatch(/console\.log\(a\)/)
    expect(w.toasts).toEqual([])
    // The next prompt's context carries nothing of it either.
    await prompt($)
    expect((w.contexts.at(-1) ?? []).join('\n')).not.toMatch(/learn-1|trial|use the logger/)
    // A file its globs do not match is not judged.
    expect((await $.tool.call({ tool: 'Write', file_path: '/repo/lib/b.ts', content: 'console.log(1)\n' })).deny).toBeUndefined()
    expect(learnedIn(w).rules[0]?.hits).toBe(1)
  })

  test('a pattern the engine rejects, or a glob that cannot be read, gives no hit and never an error', async ($, on) => {
    expect(judgeLearned('src/a.ts', '', 'x(', [{ id: 'learn-1', when: ['src/**'], pattern: '(', action: 'note', why: '' }])).toEqual([])
    expect(judgeLearned('src/a.ts', '', 'x', [{ id: 'learn-1', when: [null as unknown as string], pattern: 'x', action: 'note', why: '' }])).toEqual([])
    const w = world(on, LEARN)
    w.files['/repo/src/a.ts'] = 'a'
    withTrial(w, { pattern: '(' })
    await start($)
    expect((await logLine($)).deny).toBeUndefined()
    expect(ledgerOf(w).filter(one => one.kind === 'content-rule')).toEqual([])
  })

  test('removed by itself after pruneWindowDays with no hit, and tombstoned under its group', async ($, on) => {
    const swept = sweepLearned({ ...EMPTY_LEARNED, rules: [trial({ at: 0 }), trial({ id: 'learn-2', at: 0, last: 20 * DAY })] }, { ...DEFAULTS, pruneWindowDays: 30 }, 31 * DAY)
    expect([swept.expired, swept.learned.rules.map(one => one.id), swept.stones]).toEqual([['learn-1'], ['learn-2'], [{ id: 'refusal:protected', evidence: 'trial rule learn-1 had no hit in 30 days', at: 31 * DAY }]])
    const w = world(on, LEARN)
    withTrial(w)
    w.now = 1000 + 31 * DAY
    await start($)
    expect(learnedIn(w).rules).toEqual([])
    expect((w.store['tombstones:/repo'] as { id: string }[]).map(one => one.id)).toEqual(['refusal:protected'])
  })
})

// ---------------------------------------------------------------- decision 4

describe('a person only promotes (decision 4)', () => {
  test('the notice comes once, at promoteHits', async ($, on) => {
    const w = world(on, LEARN)
    w.files['/repo/src/a.ts'] = 'a'
    withTrial(w)
    await start($)
    for (let i = 0; i < 5; i += 1) {
      await logLine($)
    }
    expect(w.toasts).toEqual(['devloop: trial rule learn-1 would have caught 3 edits: /devloop rules promote learn-1'])
    expect(learnedIn(w).rules[0]).toMatchObject({ hits: 5, isTold: true })
    expect(withHits({ ...EMPTY_LEARNED, rules: [trial({ hits: 2 })] }, [{ id: 'learn-1', path: 'a', line: 1, fp: 'f' }], 5, 3).told.map(one => one.id)).toEqual(['learn-1'])
  })

  test('/devloop rules and promote are refused for an agent; after a person\'s yes the rule refuses at once, audited, with the policy entry', async ($, on) => {
    const w = world(on, LEARN)
    w.files['/repo/src/a.ts'] = 'a'
    withTrial(w, { hits: 3, seen: [{ path: 'src/a.ts', line: 1, fp: 'f', at: 1 }] })
    await start($)
    expect(await devloop($, 'rules', AGENT)).toMatch(/a person's to read, promote and drop/)
    expect(await devloop($, 'rules promote learn-1', AGENT)).toMatch(/a person's/)
    expect(learnedIn(w).rules[0]?.status).toBe('trial')
    const listed = await run($, 'rules')
    expect(listed.isTextDisplayOnly).toBe(true)
    expect(listed.text).toMatch(/learn-1 {2}\/console\\.log\/ when src\/\*\*: 3 hits/)
    w.answer = 'Keep it on trial'
    expect(await devloop($, 'rules promote learn-1')).toMatch(/stays on trial/)
    expect(w.questions.at(-1)).toMatch(/pattern: console\\.log[^]*globs: src\/\*\*[^]*why: use the logger[^]*src\/a.ts:1/)
    w.answer = 'Promote it'
    const promoted = await run($, 'rules promote learn-1')
    expect(promoted.isTextDisplayOnly).toBe(true)
    expect(promoted.text).toMatch(/\{"id":"learn-1","when":\["src\/\*\*"\],"pattern":"console\\\\.log","action":"refuse","why":"use the logger"\}/)
    expect(auditIn(w).filter(one => one.action === 'learned-rule-promoted').map(one => [one.subject, one.actor.kind])).toEqual([['learn-1', 'person']])
    expect((await logLine($)).deny).toMatch(/devloop's promoted rule "learn-1" refuses this line in src\/a.ts \(use the logger\): console.log\(a\) \(Lifted by a change to devloop.json.\)/)
    // Doctor names it until it is in the policy.
    expect(await devloop($, 'doctor')).toMatch(/learning: trial; [^\n]*0 trial rules, 1 promoted, 0 waiting proposals[^]*promoted rules not yet in devloop.json [^\n]*: learn-1/)
  })

  test('a promoted rule the base policy has by id is dropped from the state at session start', async ($, on) => {
    const w = world(on, LEARN)
    withTrial(w, { status: 'promoted', promotedAt: 1 })
    w.basePolicy = JSON.stringify({ ...CONFIG, rules: [{ id: 'learn-1', when: ['src/**'], pattern: 'console\\.log', action: 'refuse', why: 'use the logger' }] })
    await start($)
    expect(learnedIn(w).rules).toEqual([])
  })

  test('promote says the policy has the id, and drops the state copy', async ($, on) => {
    const v = world(on, LEARN)
    v.basePolicy = JSON.stringify({ ...CONFIG, rules: [{ id: 'learn-1', when: ['src/**'], pattern: 'x', action: 'note', why: 'y' }] })
    await start($)
    // Kept after the session's upkeep ran: the policy came to have the id while it was on trial.
    withTrial(v)
    v.answer = 'Promote it'
    expect(await devloop($, 'rules promote learn-1')).toMatch(/already has a rule "learn-1": the state copy is dropped/)
    expect(learnedIn(v).rules).toEqual([])
    expect(learnedRules({ ...EMPTY_LEARNED, rules: [trial()] }, { ...DEFAULTS, rules: [{ id: 'learn-1', when: ['a'], pattern: 'b', action: 'note', why: 'c' }] })).toEqual([])
  })

  test('/devloop rules drop removes a rule or a proposal, writes a tombstone, and is audited', async ($, on) => {
    const w = world(on, LEARN)
    withTrial(w)
    await start($)
    expect(await devloop($, 'rules drop learn-1 fires on test fixtures', AGENT)).toMatch(/a person's/)
    expect(await devloop($, 'rules drop learn-1')).toMatch(/Name the rule or proposal and why/)
    w.answer = 'Drop it'
    w.now = 5000
    expect(await devloop($, 'rules drop learn-1 fires on test fixtures')).toMatch(/learn-1 is dropped, and a tombstone for refusal:protected is written/)
    expect(learnedIn(w).rules).toEqual([])
    expect(w.store['tombstones:/repo']).toEqual([{ id: 'refusal:protected', evidence: 'learn-1 dropped: fires on test fixtures', at: 5000 }])
    expect(auditIn(w).filter(one => one.action === 'learned-rule-dropped').map(one => one.subject)).toEqual(['learn-1'])
    // A trial rule no longer: the line passes and nothing is recorded.
    w.files['/repo/src/a.ts'] = 'a'
    await logLine($)
    expect(ledgerOf(w).filter(one => one.kind === 'content-rule')).toEqual([])
  })
})

// ---------------------------------------------------------------- the modes

describe('auto: off and propose (decision 5)', () => {
  test('off: no lesson, no run, no trial rule at work; learn works as before', async ($, on) => {
    const w = world(on, { ...CONFIG, loop: { failedRounds: 1 }, learning: { auto: 'off' } })
    w.store['ledger:/repo'] = repeats()
    w.files['/repo/src/a.ts'] = 'a'
    withTrial(w)
    w.exits['npm test'] = 1
    await start($)
    await prompt($)
    change(w, 'src/a.ts')
    await stop($)
    await turn($, {})
    expect(lessons(w)).toEqual([])
    expect(learners(w)).toEqual([])
    await logLine($)
    expect(learnedIn(w).rules[0]?.hits).toBe(0)
    const learn = await run($, 'learn')
    expect(learn.isTextDisplayOnly).toBeUndefined()
    expect(learn.text).toMatch(/^Failures seen more than once:/)
    expect(learn.context?.[0]).toMatch(/cheapest durable fix/)
    expect(learners(w)).toEqual([])
  })

  test('propose: lessons and a run, but a proposed rule waits for a person; a person\'s learn starts a run on demand', async ($, on) => {
    const w = world(on, { ...CONFIG, learning: { auto: 'propose' } })
    w.store['ledger:/repo'] = repeats('protected', 2)
    await start($)
    expect(await devloop($, 'learn', AGENT)).not.toMatch(/proposer run started/)
    expect(learners(w)).toEqual([])
    expect(await devloop($, 'learn')).toMatch(/A proposer run started for 1 repeat group/)
    await answer($, 'agent-1', RULE_LINE)
    expect(learnedIn(w).rules).toEqual([])
    expect(learnedIn(w).proposals.map(one => [one.id, one.reason])).toEqual([['learn-1', 'learning.auto is "propose": a proposed rule waits for a person']])
  })
})
