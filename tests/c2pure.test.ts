import { describe, expect, test } from 'claude-code/testing'

import { BUILTIN_RULE_IDS, DEFAULTS, parseConfig } from '../hooks/config'
import type { Config, ContentRule } from '../hooks/config'
import { addedLines, countUnmarked, judgeContent, lowered } from '../hooks/contentrules'
import {
  ablationEffect, canStopEarly, compareRuns, isPatch, judgeTrajectory, nextItem, noiseBand, outsideBand, parseTask, projectCost, quickSubset, taskOutcome,
  witnessProblems,
} from '../hooks/evalplan'
import type { Progress, RunRecord, TaskResult, Trial } from '../hooks/evalplan'
import { costStep, EMPTY_COSTS, learnGroups, papercutGroup, papercutGroups, pruneReport } from '../hooks/ledger'
import type { Entry, Papercut } from '../hooks/ledger'
import { auditLine, check, HARNESS_VERSION, SCHEMAS, validate } from '../hooks/records'
import type { SchemaId } from '../hooks/records'
import { attestationOf, changeRecord, changeReport, computeMetrics, fileTiers, scenarios, splitSuggestion, unreviewed } from '../hooks/report'
import { judgeCommand, RULES as RULE_NAMES, shipAlone, whereOf } from '../hooks/rules'
import { FRESH } from '../hooks/state'
import type { Finding, Loop } from '../types'

// Phase C2, the pure parts: records, content rules, the ledger, the eval
// plan, measurement and reporting, and the ship-alone rule (L2).

/** Equal but for floating-point rounding. */
const near = (received: number | null | undefined, expected: number): void => expect(Math.abs((received ?? Number.NaN) - expected) < 1e-9).toBe(true)

const INPUTS = { policy: 'p1', model: 'model-a', harness: HARNESS_VERSION, tree: 't1' }
const actor = { kind: 'person' as const, name: 'composer' }

/** A good record of each shape, and one change that breaks it. */
const SAMPLES: Record<SchemaId, { good: unknown; bad: unknown }> = {
  'finding@1': {
    good: { schema: 'finding@1', id: 'F1', reviewer: 'general', severity: 'high', file: 'a.ts', line: 3, quote: 'x', problem: 'p', evidence: 'e', isPreExisting: false, route: 'fix', status: 'open', isBlocking: true, round: 1, seen: 1, note: null },
    bad: { schema: 'finding@1', id: 'X1', reviewer: 'general', severity: 'huge', file: 'a.ts', line: -1 },
  },
  'papercut@1': {
    good: { schema: 'papercut@1', id: 'pc1', at: 1, group: 'p-abc123', subject: null, tried: 't', expected: 'e', happened: 'h', suggestedFix: 's', actor: { kind: 'builder', name: null } },
    bad: { schema: 'papercut@1', id: 'pc1', at: 1, group: 'nope', subject: null, tried: 't', expected: 'e', happened: 'h', suggestedFix: 's', actor: { kind: 'robot', name: null } },
  },
  'handoff@1': {
    good: { schema: 'handoff@1', at: 1, by: 'builder', file: 'PROGRESS.md', objective: 'o', nextStep: 'n', decisions: 0, deadEnds: 0, assumptions: 0, files: [], facts: { phase: 'idle', spec: null, tree: null, changed: 0, openFindings: 0 } },
    bad: { schema: 'handoff@1', at: 1, by: 'robot', file: 'PROGRESS.md' },
  },
  'change-record@1': {
    good: {
      schema: 'change-record@1', id: 'C1', closedAt: 2, startedAt: 1, durationMs: 1, spec: null, tier: 'medium', tierWhy: [], files: ['a.ts'], lines: 3, fixRounds: 0, reviewRounds: 1,
      isFirstPass: true, vacuous: [], exemptionsUsed: [], findings: { blocking: 0, deferred: 0, resolvedByPerson: 0 }, gate: { isGreen: true, unmet: [] }, costUsd: null, cacheHitRate: null,
      attestation: { by: 'person', at: 2, read: ['diff'] }, inputs: INPUTS,
    },
    bad: { schema: 'change-record@1', id: 'C1', attestation: { by: 'builder', at: 2, read: ['everything'] } },
  },
  'eval-result@1': {
    good: { schema: 'eval-result@1', run: 'r1', pass: 'main', kind: 'full', task: 'one', taskHash: 'h', outcome: 'pass', trials: [{ outcome: 'pass', note: 'ok', calls: 2, costUsd: null }], successRate: 1, without: null, at: 1, inputs: { ...INPUTS, suite: { one: 'h' } } },
    bad: { schema: 'eval-result@1', run: 'r1', pass: 'sideways', kind: 'full', task: 'one', taskHash: 'h', outcome: 'maybe', trials: [], successRate: 1, without: null, at: 1, inputs: INPUTS },
  },
  'gate@1': {
    good: { schema: 'gate@1', at: 1, why: 'gate-command', tier: 'low', isGreen: true, rows: [{ label: 'Verification', isMet: true, note: 'passes' }], inputs: INPUTS },
    bad: { schema: 'gate@1', at: 1, why: 'gate-command', tier: 'low', isGreen: 'yes', rows: [], inputs: { policy: 'p' } },
  },
  // D1: portable evidence, a git note on the reviewed commit.
  'evidence@2': {
    good: { schema: 'evidence@2', at: 1, why: 'review', tree: 't1', head: 'h1', policy: 'p', checks: [{ run: 'npm test', tree: 't1' }], reviewers: [{ name: 'general', mode: 'general', verdict: 'pass', round: 1 }], open: 0, checklistFails: [], harness: '0.2.0' },
    bad: { schema: 'evidence@2', at: 1, why: 'review', tree: 't1', head: 'h1', policy: 'p', checks: [], reviewers: [{ name: 'general', mode: 'general', verdict: 'maybe', round: 1 }], open: 0, checklistFails: [], harness: '0.2.0' },
  },
  'audit-event@1': {
    good: { schema: 'audit-event@1', at: 1, action: 'spec-approved', actor, subject: 'login', tree: 't1', detail: '' },
    bad: { schema: 'audit-event@1', at: 1, action: 'took-over', actor, subject: 'login', tree: 't1', detail: '', extra: 1 },
  },
  'checklist@1': {
    good: { schema: 'checklist@1', id: 'login-form', version: 1, title: 'Login form', appliesTo: { paths: ['**/login/**'] }, maxItems: 14, items: [{ id: 'LF-01', statement: 'Every input has a label', why: 'screen readers', severity: 'high', verify: { by: 'review', how: 'quote the label for each input' } }] },
    bad: { schema: 'checklist@1', id: 'Login Form', version: 0, title: 'x', appliesTo: {}, maxItems: 1, items: [{ id: 'a', statement: 's', severity: 'severe', verify: { by: 'magic' } }] },
  },
  // DESIGN 4.18: an entry of the spec library (entry.json; an index line is the same without criteria).
  'library-entry@1': {
    good: {
      schema: 'library-entry@1', id: 'shop--login--2026-11-27', project: 'shop', spec: 'login', kind: 'New feature', size: 'full', related: [], intent: 'People sign in.', criteria: ['A wrong password is refused.'],
      features: [{ id: 'bad-password', description: 'refused', check: 'npm test -- bad' }], approvedAt: 1, closedAt: 2, outcome: { status: 'closed', isAllPassing: true, reviewRounds: 1, defects: 0 }, harness: '0.2.0', hash: 'h', savedAt: 2,
    },
    bad: { schema: 'library-entry@1', id: 'shop/../x', project: 'shop', spec: 'login', outcome: { status: 'shelved' } },
  },
  'checklist-result@1': {
    good: { schema: 'checklist-result@1', at: 1, list: 'login-form', version: 1, item: 'LF-01', by: 'review', status: 'pass', evidence: 'src/a.tsx:3 "<label>"', tree: 't1', round: 1, source: 'reviewer' },
    bad: { schema: 'checklist-result@1', at: 1, list: 'login-form', version: 1, item: 'LF-01', by: 'review', status: 'good', evidence: '', tree: 't1', round: 1, source: 'model' },
  },
}

describe('1. records and their schemas', () => {
  test('each shape takes a good record and names what is wrong with a bad one', async () => {
    for (const id of Object.keys(SCHEMAS) as SchemaId[]) {
      expect({ id, problems: validate(id, SAMPLES[id].good) }).toEqual({ id, problems: [] })
      expect(validate(id, SAMPLES[id].bad).length).toBeGreaterThan(0)
    }
    expect(Object.keys(SCHEMAS).sort()).toEqual(['audit-event@1', 'change-record@1', 'checklist-result@1', 'checklist@1', 'eval-result@1', 'evidence@2', 'finding@1', 'gate@1', 'handoff@1', 'library-entry@1', 'papercut@1'])
  })

  test('the validator names the path: unknown fields, missing ones, enums, patterns, types', async () => {
    const problems = check(SCHEMAS['audit-event@1'], { schema: 'audit-event@1', at: 1.5, action: 'x', actor: { kind: 'person' }, subject: 's', extra: true })
    expect(problems).toContain('$.tree: missing')
    expect(problems).toContain('$.extra: unknown field')
    expect(problems.some(one => one.startsWith('$.action: expected one of'))).toBe(true)
    expect(problems.some(one => one.startsWith('$.at: expected integer'))).toBe(true)
    expect(problems).toContain('$.actor.name: missing')
  })

  test('every record carries its inputs: policy, model, harness version, tree (and for evals the suite)', async () => {
    for (const id of ['change-record@1', 'eval-result@1', 'gate@1'] as SchemaId[]) {
      const shape = SCHEMAS[id]
      expect(shape.required).toContain('inputs')
      expect(shape.properties?.inputs?.required).toEqual(['policy', 'model', 'harness', 'tree'])
    }
    expect(validate('eval-result@1', { ...(SAMPLES['eval-result@1'].good as object), inputs: { ...INPUTS, suite: { one: 7 } } })).toEqual(['$.inputs.suite.one: expected string, found integer'])
  })

  test('an audit line: time, actor, action, subject, tree; keys only', async () => {
    expect(auditLine({ schema: 'audit-event@1', at: 0, action: 'refusal', actor: { kind: 'builder', name: null }, subject: 'protected', tree: 'abcdef123456', detail: 'REVIEW.md' }))
      .toBe('1970-01-01T00:00:00Z  builder          refusal            protected  [tree abcdef12]  REVIEW.md')
  })
})

// ---------------------------------------------------------------- papercuts

describe('2. papercuts, grouped', () => {
  const cut = (at: number, subject: string | null, happened: string): Papercut => ({
    schema: 'papercut@1', id: `pc${at}`, at, group: papercutGroup(subject, happened), subject, tried: 't', expected: 'e', happened, suggestedFix: 's', actor: { kind: 'builder', name: null },
  })

  test('the group is the subject and a fingerprint of what happened (line numbers and timings aside)', async () => {
    expect(papercutGroup('npm test', 'src/a.ts:12:3 failed in 120ms')).toBe(papercutGroup('npm test', 'src/a.ts:40:1 failed in 9ms'))
    expect(papercutGroup('npm test', 'failed')).not.toBe(papercutGroup('pytest', 'failed'))
    expect(papercutGroup(null, 'x')).toMatch(/^p-[0-9a-f]{6}$/)
  })

  test('groups by count; one filed again after its close is a regression', async () => {
    const list = [cut(1, 'grep', 'flag -P rejected'), cut(2, 'grep', 'flag -P rejected'), cut(3, 'tsc', 'exit 0 on error'), cut(9, 'tsc', 'exit 0 on error')]
    const tsc = papercutGroup('tsc', 'exit 0 on error')
    const groups = papercutGroups(list, [{ group: tsc, at: 5, note: 'fixed the script' }])
    expect(groups[0]?.group).toBe(tsc)
    expect(groups[0]?.isRegression).toBe(true)
    expect(groups[0]?.since).toBe(1)
    expect(groups[1]).toMatchObject({ subject: 'grep', count: 2, isRegression: false, closed: null })
    expect(papercutGroups(list.slice(0, 3), [{ group: tsc, at: 5, note: 'x' }]).find(one => one.group === tsc)?.isRegression).toBe(false)
  })
})

// ---------------------------------------------------------------- content rules

describe('3. content rules', () => {
  const noConsole: ContentRule = { id: 'no-console', when: ['src/**'], pattern: 'console\\.log', action: 'refuse', why: 'use the logger' }
  const todo: ContentRule = { id: 'todo', when: ['**/*.ts'], pattern: 'TODO', action: 'note', why: 'track it' }
  const anyCast: ContentRule = { id: 'no-any', when: ['src/**'], pattern: 'as any', action: 'ratchet', why: 'typed code' }

  test('added lines are a multiset difference: a moved line is not added', async () => {
    expect(addedLines('a\nb\nc', 'c\na\nb\nd')).toEqual(['d'])
    expect(addedLines('x\nx', 'x\nx\nx')).toEqual(['x'])
    expect(addedLines('', 'one')).toEqual(['one'])
  })

  test('a marker on the line or the line above keeps a match out of the count', async () => {
    const text = 'a as any\n// devloop-allow: no-any legacy API\nb as any\nc as any // devloop-allow: no-any vendor\nd as any // devloop-allow: other x'
    expect(countUnmarked(anyCast, text)).toBe(2)
    // A marker with no reason keeps nothing.
    expect(countUnmarked(anyCast, 'x as any // devloop-allow: no-any')).toBe(1)
  })

  test('note records, refuse refuses, ratchet refuses a rise only; globs decide which file', async () => {
    const rules = [noConsole, todo, anyCast]
    const verdicts = (path: string, before: string, after: string, skip: string[] = []): string[] =>
      judgeContent(path, before, after, rules, skip).map(one => `${one.rule.id}:${one.verdict}`)
    expect(verdicts('src/a.ts', 'x', 'x\nconsole.log(1)')).toEqual(['no-console:refuse', 'no-any:note'])
    expect(verdicts('lib/a.ts', 'x', 'x\nconsole.log(1) // TODO')).toEqual(['todo:note'])
    // A line already there is not added.
    expect(verdicts('src/a.ts', 'console.log(1)', 'console.log(1)\ny')).toEqual(['no-any:note'])
    expect(verdicts('src/a.ts', 'a as any', 'a as any\nb as any')).toEqual(['no-any:refuse'])
    expect(verdicts('src/a.ts', 'a as any', 'a as any\n// devloop-allow: no-any third-party types\nb as any')).toEqual(['no-any:note'])
    expect(verdicts('src/a.ts', 'a as any\nb as any', 'a as any')).toEqual(['no-any:note'])
    // An ablation switches one off.
    expect(verdicts('src/a.ts', 'x', 'console.log(1)', ['no-console'])).toEqual(['no-any:note'])
  })

  test('a content rule may not take a built-in rule\'s name (the two lists are one)', async () => {
    expect([...BUILTIN_RULE_IDS].sort()).toEqual([...RULE_NAMES].sort())
    expect(parseConfig(JSON.stringify({ rules: [{ ...noConsole, id: 'protected' }] })).errors).toEqual(['rules[0].id: "protected" is a built-in rule\'s name; left out'])
  })

  test('a ratchet baseline only ever falls', async () => {
    const base = { count: 10, pattern: 'as any', at: 1 }
    expect(lowered(base, -3, 2)).toEqual({ count: 7, pattern: 'as any', at: 2 })
    expect(lowered(base, 2, 2)).toBe(base)
  })

  test('policy: rules parse strictly; a wrong action takes the stricter refuse; a bad pattern is left out', async () => {
    const { cfg, errors } = parseConfig(JSON.stringify({
      rules: [noConsole, { ...todo, action: 'warn' }, { id: 'bad', when: ['x'], pattern: '(', action: 'note', why: 'w' }, { id: 'no-console', when: ['y'], pattern: 'z', action: 'note' }, { id: 'Bad Id', when: [], pattern: 'p' }],
      evalTrials: 3, evalIsolation: 'sandbox', evalQuick: 2, saturationRuns: 4, pruneWindowDays: 14,
    }))
    expect(cfg.rules.map(one => `${one.id}:${one.action}`)).toEqual(['no-console:refuse', 'todo:refuse'])
    expect(errors).toEqual([
      'evalIsolation: expected "worktree" or "clone"; using "worktree"',
      'rules[1].action: expected "note", "refuse" or "ratchet"; using "refuse"',
      'rules[2].pattern: not a valid regular expression; left out',
      'rules[3].id: "no-console" is used twice; the later one is left out',
      'rules[4]: expected { "id": "<lowercase-name>", "when": ["<glob>", ...], "pattern": "<regular expression>", "action": "note" | "refuse" | "ratchet", "why": "<reason>" }; left out',
    ])
    expect([cfg.evalTrials, cfg.evalIsolation, cfg.evalQuick, cfg.saturationRuns, cfg.pruneWindowDays]).toEqual([3, 'worktree', 2, 4, 14])
    expect([DEFAULTS.evalTrials, DEFAULTS.evalIsolation, DEFAULTS.evalQuick, DEFAULTS.saturationRuns, DEFAULTS.pruneWindowDays, DEFAULTS.rules]).toEqual([1, 'worktree', 5, 3, 30, []])
  })
})

// ---------------------------------------------------------------- learn and prune

describe('3. learn groups repeats; tombstones; prune', () => {
  const entry = (at: number, kind: string, key: string, detail = 'first line\nsecond'): Entry => ({ at, kind, key, detail })

  test('refusals, check failures by fingerprint, findings by file, papercuts and lessons are grouped; one-offs are not', async () => {
    const groups = learnGroups([
      entry(1, 'guard-deny', 'protected'), entry(2, 'guard-observe', 'protected'),
      entry(3, 'verify-fail', 'npm test #abc'), entry(4, 'verify-fail', 'npm test #abc'), entry(5, 'verify-fail', 'npm test #def'),
      entry(6, 'finding', 'general:high:src/a.ts'), entry(7, 'finding', 'security:critical:src/a.ts'),
      entry(8, 'papercut', 'p-123456'), entry(9, 'papercut', 'p-123456'),
      entry(10, 'lesson', 'mocks lie'), entry(11, 'lesson', 'mocks lie'),
      entry(12, 'cache-miss', 'idle-gap'), entry(13, 'cache-miss', 'idle-gap'),
    ])
    expect(groups.map(one => one.key).sort()).toEqual(['check:npm test #abc', 'finding:src/a.ts', 'lesson:mocks lie', 'papercut:p-123456', 'refusal:protected'])
    expect(groups.find(one => one.key === 'refusal:protected')?.ruleKey).toBe('protected')
    expect(groups.every(one => one.sample === 'first line')).toBe(true)
  })

  test('a tombstoned rule is not proposed again unless the failure recurs after the tombstone', async () => {
    const entries = [entry(1, 'guard-deny', 'destructive'), entry(2, 'guard-deny', 'destructive')]
    expect(learnGroups(entries, [{ id: 'destructive', evidence: 'no effect', at: 5 }])).toEqual([])
    const again = learnGroups([...entries, entry(9, 'guard-deny', 'destructive')], [{ id: 'destructive', evidence: 'no effect', at: 5 }])
    expect(again[0]?.recurredAfter).toBe(5)
  })

  test('prune: hits, last fired, never fired in the window, ablation evidence, the band, tombstones', async () => {
    const DAY = 86_400_000
    const lines = pruneReport({
      rules: [{ id: 'protected', kind: 'built-in' }, { id: 'no-console', kind: 'content', note: 'refuse' }, { id: 'egress', kind: 'built-in' }, { id: 'AGENTS.md', kind: 'instruction', note: '40 lines' }],
      hits: { protected: { hits: 3, last: 100 * DAY }, egress: { hits: 1, last: 10 * DAY } },
      now: 101 * DAY, windowDays: 30,
      ablations: [{ target: 'egress', at: 90 * DAY, effect: 'none', baseline: [4, 5], without: 5, noise: 1, total: 6 }],
      band: [{ task: 'easy', why: 'saturated' }],
      tombstones: [{ id: 'old-rule', evidence: 'no effect in 3 runs', at: 50 * DAY }],
    })
    expect(lines).toContain('  built-in    protected: 3 hits, last a day ago')
    expect(lines).toContain('  content     no-console: never fired (refuse)')
    expect(lines.join('\n')).toMatch(/egress: 1 hit, last 91 days ago; eval evidence: no measurable effect \(baseline 4 and 5 of 6, without it 5, noise band 1\)/)
    expect(lines.join('\n')).toMatch(/Never fired in the last 30 days \(.*\): no-console, egress/)
    expect(lines.join('\n')).toMatch(/easy \(passes every trial: make it harder or retire it\)/)
    expect(lines.join('\n')).toMatch(/old-rule \(1970-02-20: no effect in 3 runs\)/)
  })
})

// ---------------------------------------------------------------- evals

describe('4. the eval plan', () => {
  test('a task file: required fields, optional witness stages, trajectory expectations', async () => {
    expect(parseTask(JSON.stringify({ prompt: 'p', check: 'c' })).task).toEqual({ prompt: 'p', check: 'c', setup: null, solution: null, nearMiss: null, expect: null, tags: [] })
    expect(parseTask('{').problems).toEqual(['not valid JSON'])
    expect(parseTask(JSON.stringify({ prompt: 'p' })).problems).toEqual(['check: expected a command that exits 0 on success'])
    expect(parseTask(JSON.stringify({ prompt: 'p', check: 'c', expect: { noRefusal: true, refusal: 'x', mystery: 1 } })).problems).toEqual(['expect.mystery: unknown field', 'expect: noRefusal and refusal contradict each other'])
    expect(parseTask(JSON.stringify({ prompt: 'p', check: 'c', expect: { mustUse: ['Read'], maxToolCalls: 3 }, tags: ['quick'] })).task?.expect).toEqual({ mustUse: ['Read'], maxToolCalls: 3 })
    expect(isPatch('diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1 +1 @@\n-a\n+b')).toBe(true)
    expect(isPatch('sed -i s/a/b/ x')).toBe(false)
  })

  test('the quick subset: tasks tagged quick, else the first N by a stable hash', async () => {
    const tasks = ['a', 'b', 'c', 'd', 'e', 'f'].map(id => ({ id, tags: id === 'c' ? ['quick'] : [] }))
    expect(quickSubset(tasks, 2)).toEqual(['c'])
    const untagged = tasks.map(one => ({ ...one, tags: [] }))
    const picked = quickSubset(untagged, 3)
    expect(picked.length).toBe(3)
    expect(quickSubset([...untagged].reverse(), 3)).toEqual(picked)
  })

  test('the witness: seed fails, solution passes, reset restores, near miss fails', async () => {
    expect(witnessProblems([{ stage: 'seed-fails', outcome: 'fail', note: '' }, { stage: 'solution-passes', outcome: 'pass', note: '' }, { stage: 'reset-restores', outcome: 'fail', note: '' }, { stage: 'near-miss-fails', outcome: 'fail', note: '' }])).toEqual([])
    expect(witnessProblems([{ stage: 'seed-fails', outcome: 'pass', note: '' }])).toEqual(['the check passes on the untouched worktree, so it proves nothing'])
    expect(witnessProblems([{ stage: 'solution-passes', outcome: 'fail', note: '' }, { stage: 'reset-restores', outcome: 'pass', note: '' }, { stage: 'near-miss-fails', outcome: 'pass', note: '' }]).length).toBe(3)
    expect(witnessProblems([{ stage: 'seed-fails', outcome: 'infra', note: 'timeout' }])).toEqual(['seed-fails: could not run (timeout)'])
  })

  test('trajectory assertions: must use, must not use, order, a maximum, negative tasks', async () => {
    const calls = [{ tool: 'Grep' }, { tool: 'Read' }, { tool: 'Skill', skill: 'deploy' }, { tool: 'Edit' }, { tool: 'Bash', refused: 'production' }]
    expect(judgeTrajectory({ mustUse: ['Read', 'deploy'], mustNotUse: ['Write'], order: ['Grep', 'Edit'], maxToolCalls: 5, refusal: 'production' }, calls)).toEqual([])
    expect(judgeTrajectory({ mustUse: ['Write'], mustNotUse: ['Skill:deploy'], order: ['Edit', 'Grep'], maxToolCalls: 4, noRefusal: true }, calls)).toEqual([
      'never used Write', 'used Skill:deploy', 'not in the order Edit then Grep', '5 tool calls, over 4', 'a guard fired (production) where none should',
    ])
    expect(judgeTrajectory({ refusal: 'destructive' }, calls)).toEqual(['the destructive guard never fired'])
    expect(judgeTrajectory(null, calls)).toEqual([])
  })

  test('trials: every counted trial must pass; infrastructure trials are left out', async () => {
    const t = (outcome: Trial['outcome']): Trial => ({ outcome, note: '', calls: 0, costUsd: null })
    expect(taskOutcome([t('pass'), t('pass')])).toEqual({ outcome: 'pass', successRate: 1 })
    expect(taskOutcome([t('pass'), t('fail')])).toEqual({ outcome: 'fail', successRate: 0.5 })
    expect(taskOutcome([t('pass'), t('infra')])).toEqual({ outcome: 'pass', successRate: 1 })
    expect(taskOutcome([t('infra'), t('infra')])).toEqual({ outcome: 'infra', successRate: null })
  })

  const result = (pass: TaskResult['pass'], task: string, outcome: TaskResult['outcome'], trials: Trial[] = [{ outcome, note: '', calls: 0, costUsd: 0.1 }]): TaskResult => ({
    schema: 'eval-result@1', run: 'r', pass, kind: 'full', task, taskHash: `h-${task}`, outcome, trials, successRate: null, without: null, at: 1, inputs: INPUTS,
  })
  const base: Progress = { runId: 'r', kind: 'full', model: 'm', startedAt: 0, without: 'x', passes: ['baseline-1', 'baseline-2', 'without'], tasks: ['a', 'b', 'c', 'd'], hashes: {}, trials: 2, results: [], partial: null, skipped: [] }

  test('a run goes pass by pass, task by task, trial by trial, and resumes where it stopped', async () => {
    expect(nextItem(base)).toEqual({ pass: 'baseline-1', task: 'a', trial: 0 })
    expect(nextItem({ ...base, partial: { pass: 'baseline-1', task: 'a', trials: [{ outcome: 'pass', note: '', calls: 0, costUsd: null }] } })).toEqual({ pass: 'baseline-1', task: 'a', trial: 1 })
    expect(nextItem({ ...base, results: [result('baseline-1', 'a', 'pass')] })).toEqual({ pass: 'baseline-1', task: 'b', trial: 0 })
    const all = base.passes.flatMap(pass => base.tasks.map(task => result(pass, task, 'pass')))
    expect(nextItem({ ...base, results: all })).toBe(null)
  })

  test('the noise band, the ablation verdict, and stopping when the rest cannot change it', async () => {
    const b1 = ['a', 'b', 'c', 'd'].map(task => result('baseline-1', task, task === 'd' ? 'fail' : 'pass'))
    const b2 = ['a', 'b', 'c', 'd'].map(task => result('baseline-2', task, task === 'c' ? 'fail' : 'pass'))
    expect(noiseBand([...b1, ...b2])).toBe(2)
    const without = (outcomes: TaskResult['outcome'][]): TaskResult[] => outcomes.map((outcome, i) => result('without', ['a', 'b', 'c', 'd'][i] as string, outcome))
    expect(ablationEffect([...b1, ...b2, ...without(['pass', 'pass', 'fail', 'fail'])])).toEqual({ effect: 'none', baseline: [3, 3], without: 2, noise: 2 })
    expect(ablationEffect([...b1, ...b2, ...without(['fail', 'fail', 'fail', 'fail'])]).effect).toBe('helps')
    // With a quiet baseline (no noise), one failure settles it; before any, the rest could still go either way.
    const quiet = ['a', 'b', 'c', 'd'].flatMap(task => [result('baseline-1', task, 'pass'), result('baseline-2', task, 'pass')])
    expect(canStopEarly({ ...base, results: quiet })).toBe(false)
    expect(canStopEarly({ ...base, results: [...quiet, ...without(['fail'])] })).toBe(true)
    // With a noisy one, two passes leave every outcome inside the band: no measurable effect, whatever comes.
    expect(canStopEarly({ ...base, results: [...b1, ...b2, ...without(['fail'])] })).toBe(false)
    expect(canStopEarly({ ...base, results: [...b1, ...b2, ...without(['pass', 'pass'])] })).toBe(true)
    expect(canStopEarly({ ...base, passes: ['main'], results: quiet })).toBe(false)
  })

  const run = (id: string, model: string, outcomes: Record<string, TaskResult['outcome']>, hashes: Record<string, string>, extra: Partial<RunRecord> = {}): RunRecord => ({
    runId: id, kind: 'full', model, startedAt: 0, completedAt: 1, without: null, tasks: Object.keys(outcomes), hashes, skipped: [], invalid: [],
    results: Object.entries(outcomes).map(([task, outcome]) => result('main', task, outcome)), ...extra,
  })

  test('compare: only tasks whose file did not change, how many were left out, and regressions', async () => {
    const older = run('r1', 'a', { x: 'pass', y: 'pass', z: 'fail' }, { x: '1', y: '1', z: '1' })
    const newer = run('r2', 'b', { x: 'fail', y: 'pass', z: 'pass' }, { x: '1', y: '2', z: '1' })
    const quick = run('r3', 'b', { x: 'pass' }, { x: '1' }, { kind: 'quick' })
    const compared = compareRuns([older, newer, quick])
    expect(compared?.compared).toEqual(['x', 'z'])
    expect(compared?.leftOut).toEqual(['y'])
    expect(compared?.regressions).toEqual(['x'])
    expect(compared?.fixed).toEqual(['z'])
    expect(compareRuns([older, quick])).toBe(null)
  })

  test('the difficulty band: every trial passed (or failed) in the last N full runs of the same task file', async () => {
    const runs = [1, 2, 3].map(n => run(`r${n}`, 'm', { easy: 'pass', hard: 'fail', mid: n === 2 ? 'fail' : 'pass' }, { easy: 'h', hard: 'h', mid: 'h' }))
    expect(outsideBand(runs, { easy: 'h', hard: 'h', mid: 'h' }, 3)).toEqual([{ task: 'easy', why: 'saturated' }, { task: 'hard', why: 'too-hard' }])
    // A changed task file starts over.
    expect(outsideBand(runs, { easy: 'new', hard: 'h', mid: 'h' }, 3)).toEqual([{ task: 'hard', why: 'too-hard' }])
    expect(outsideBand(runs.slice(0, 2), { easy: 'h' }, 3)).toEqual([])
  })

  test('the cost projection: the last run\'s cost per trial, the mean for a task it did not run', async () => {
    const last = run('r1', 'm', { a: 'pass', b: 'pass' }, {})
    near(projectCost([last], ['a', 'b', 'c'], 2, 1), 0.6)
    expect(projectCost([], ['a'], 1, 1)).toBe(null)
  })
})

// ---------------------------------------------------------------- measurement

describe('6. cost by delta, the change record, metrics, the report', () => {
  test('the cost meter: deltas go to the change and to every open unit; a new session restarts the delta', async () => {
    let c = costStep(EMPTY_COSTS, { sessionId: 's', usd: 1 }, { kind: 'sample' })
    c = costStep(c, { sessionId: 's', usd: 1.5 }, { kind: 'skill', name: 'deploy' })
    c = costStep(c, { sessionId: 's', usd: 2 }, { kind: 'error' })
    c = costStep(c, { sessionId: 's', usd: 2 }, { kind: 'error' })
    c = costStep(c, { sessionId: 's', usd: 2.25 }, { kind: 'prompt' })
    c = costStep(c, { sessionId: 's', usd: 2.5 }, { kind: 'fix-round', round: 1 })
    c = costStep(c, { sessionId: 's', usd: 3 }, { kind: 'stop' })
    c = costStep(c, { sessionId: 's', usd: 3.5 }, { kind: 'feature', id: 'login' })
    c = costStep(c, { sessionId: 's2', usd: 0.2 }, { kind: 'review-start', round: 1 })
    c = costStep(c, { sessionId: 's2', usd: 0.7 }, { kind: 'review-end' })
    near(c.change, 3)
    expect(c.skills.deploy).toEqual({ uses: 1, errorsAfter: 1, usd: 0.75 })
    near(c.fixRounds['1'], 0.5)
    near(c.features.login, 2.5)
    near(c.reviewRounds['1'], 0.5)
    const closed = costStep(c, null, { kind: 'change-closed' })
    expect([closed.change, closed.features, closed.skills.deploy?.uses]).toEqual([0, {}, 1])
  })

  const cfg: Config = { ...DEFAULTS, instructions: ['AGENTS.md'] }
  const finding = (id: string, severity: Finding['severity'], status: Finding['status']): Finding => ({
    id, reviewer: 'general', severity, file: 'src/a.ts', line: 3, quote: 'q', problem: `problem ${id}`, evidence: 'a test', isPreExisting: false, route: 'fix', status, isBlocking: true, round: 1, seen: 1, note: null,
  })
  const loop: Loop = {
    ...FRESH, phase: 'build', spec: 'login', tree: 't2', changed: ['src/a.ts', 'AGENTS.md', 'docs/x.md', 'package.json', 'tests/a.test.ts'], size: { files: 5, lines: 40 },
    features: { a: { passes: true, tree: 't2' } }, tally: { startedAt: 1000, fixRounds: 2 }, agentWritten: ['src/a.ts', 'tests/a.test.ts'],
    review: { ...FRESH.review, status: 'pass', round: 2, tree: 't1', agents: [{ agentId: 'r', name: 'general', mode: 'general', isRetry: false, answer: '' }] },
    findings: [finding('F1', 'low', 'resolved'), finding('F2', 'critical', 'open'), finding('F3', 'high', 'closed'), finding('F4', 'medium', 'open'), finding('F5', 'nit', 'open')],
    approval: { vacuous: ['b'], infra: [], lint: [], unmapped: [], at: 1 },
  }

  test('files by tier with the reason, the split suggestion, what was not reviewed, three failure scenarios', async () => {
    expect(fileTiers(loop.changed, cfg).map(one => `${one.tier} ${one.file}`)).toEqual(['high AGENTS.md', 'medium package.json', 'medium src/a.ts', 'medium tests/a.test.ts', 'low docs/x.md'])
    expect(splitSuggestion(loop, cfg)).toMatch(/a dependency manifest changed \(package.json\)\); it spans .*: each could be its own change; the dependency change \(package.json\) could ship on its own first/)
    expect(unreviewed(loop, cfg)).toEqual(['the tree moved after the last review (reviewed t1, now t2): the latest edits were not reviewed'])
    expect(unreviewed({ ...loop, review: FRESH.review }, cfg)).toEqual(['no independent review ran on this change'])
    expect(scenarios(loop.findings).map(one => one.split(' ')[0])).toEqual(['F2', 'F4', 'F1'])
  })

  test('the change record fits its schema; the attestation comes only from the person\'s answer', async () => {
    const attestation = attestationOf('The diff, The test changes', 5000)
    expect(attestation).toEqual({ by: 'person', at: 5000, read: ['diff', 'tests'] })
    expect(attestationOf('None of it'.replace(/none of it/i, ''), 1)).toBe(null)
    const record = changeRecord(loop, cfg, { id: 'C1', now: 5000, rows: [{ label: 'Verification', isMet: false, note: 'failing' }], costUsd: 1.23456, cacheHitRate: 0.5, attestation, inputs: INPUTS, deferred: 1 })
    expect(validate('change-record@1', record)).toEqual([])
    expect(record).toMatchObject({ tier: 'high', fixRounds: 2, reviewRounds: 2, isFirstPass: false, vacuous: ['b'], durationMs: 4000, costUsd: 1.2346, gate: { isGreen: false, unmet: ['Verification: failing'] } })
    expect(record.findings).toEqual({ blocking: 5, deferred: 1, resolvedByPerson: 1 })
    expect(record.tierWhy[0]).toBe('AGENTS.md: an instruction file: every later session reads it')
  })

  test('metrics from records: rates, means, refusals by rule, shadow agreement, eval pass rate by model (full runs only)', async () => {
    const rec = (id: string, isFirstPass: boolean | null, fixRounds: number, costUsd: number | null) => ({ ...changeRecord(loop, cfg, { id, now: 1, rows: [], costUsd, cacheHitRate: null, attestation: null, inputs: INPUTS, deferred: 0 }), isFirstPass, fixRounds })
    const m = computeMetrics({
      counters: { 'verify-fail': 1, 'verify-runs': 4, 'rule:protected': 2, 'shadow:a11y:rounds': 4, 'shadow:a11y:agreed': 3, 'verify-flaky': 1, reverts: 2 },
      changes: [rec('C1', true, 0, 1), rec('C2', false, 2, 3), rec('C3', null, 1, null)],
      defects: [{ at: 1, change: 'C2', text: 'x', source: 'person' }],
      evals: [{ runId: 'r', kind: 'full', model: 'm', startedAt: 0, completedAt: 1, without: null, tasks: ['a'], hashes: {}, results: [{ ...(SAMPLES['eval-result@1'].good as TaskResult) }], skipped: [], invalid: [] },
        { runId: 'q', kind: 'quick', model: 'q', startedAt: 0, completedAt: 1, without: null, tasks: [], hashes: {}, results: [], skipped: [], invalid: [] }],
      cacheHitRate: 0.8,
    })
    expect(m).toMatchObject({ changesClosed: 3, firstPassReviewRate: 0.5, meanFixRounds: 1, meanReviewRounds: 2, verificationFailureRate: 0.25, refusalsByRule: { protected: 2 }, flakyChecks: 1, reverts: 2, costPerChange: 2, cacheHitRate: 0.8 })
    near(m.escapedDefectRate, 1 / 3)
    expect(m.shadowAgreement).toEqual({ a11y: 0.75 })
    expect(Object.keys(m.evalPassRateByModel)).toEqual(['m'])
  })

  test('the report: deterministic, with the reading aid and the disclosure block', async () => {
    const input = { loop, cfg, rows: [{ label: 'Verification', isMet: true, note: 'passes' }], record: null, verdicts: [{ schema: 'audit-event@1' as const, at: 2, action: 'review-verdict' as const, actor: { kind: 'agent' as const, name: 'reviewer:general' }, subject: 'round 2', tree: 't1aaaaaaaa', detail: 'pass' }] }
    const text = changeReport(input)
    expect(changeReport(input)).toBe(text)
    expect(text).toMatch(/^## Change: login/)
    expect(text).toMatch(/### Reading aid\nFiles, riskiest first:\n- `AGENTS.md` \(high\): an instruction file/)
    expect(text).toMatch(/- the tree moved after the last review/)
    expect(text).toMatch(/- F2 \(critical, open\): at src\/a.ts:3, problem F2/)
    expect(text).toMatch(/Written by an agent \(its edit tools or commands\): `src\/a.ts`, `tests\/a.test.ts`/)
    expect(text).toMatch(/Not written through the agent's tools .*`AGENTS.md`/)
    expect(text).toMatch(/Reviewed by reviewer:general on tree t1aaaaaa: pass/)
    expect(text).toMatch(/A person attested to: nothing yet \(attestation is given at \/devloop done\)/)
  })
})

// ---------------------------------------------------------------- 9. a shipping command must stand alone (L2)

describe('9a. a line that ships must ship alone', () => {
  const at = whereOf('/repo', '/repo', { home: '/home/u', stateRoot: '/data/devloop' })

  test('the refused shapes: anything that writes, commits or runs code beside the ship', async () => {
    for (const command of [
      "cat >> src/a.js <<'EOF'\nexport const a = 1\nEOF\ngit add -A && git commit -m x && git push -u origin feature",
      'git commit -am x && git push',
      'npm version patch && git push --follow-tags',
      '(git commit -am x; git push)',
      'git push && git tag v1',
      "bash -c 'git commit -am x && git push'",
      'echo x > notes.txt && git push',
      'git checkout main && git merge feature',
      'git add . && gh pr create --fill',
      'python3 bump.py; git push',
    ]) {
      expect({ command, rule: shipAlone(command)?.rule ?? null }).toEqual({ command, rule: 'ship-alone' })
      expect(judgeCommand(command, DEFAULTS, FRESH, at)?.rule).toBe('ship-alone')
    }
    expect(shipAlone('git commit -am x && git push')?.reason).toMatch(/Run the push \(or the pull request\) as its own command, so the harness can judge exactly what is being pushed/)
  })

  test('the allowed shapes: the ship alone, after a cd, or beside a plain read', async () => {
    for (const command of ['git push -u origin feature', 'cd sub && git push', 'git status && git push', 'git push origin $(git rev-parse --abbrev-ref HEAD)', 'git log -1 && gh pr create --fill', 'git fetch origin', 'git commit -am x']) {
      expect({ command, rule: shipAlone(command)?.rule ?? null }).toEqual({ command, rule: null })
    }
  })
})
