import { describe, expect, test } from 'claude-code/testing'

import { DEFAULTS } from '../hooks/config'
import type { Config } from '../hooks/config'
import { capFindings, parseReview, reviewPrompt, settleRound } from '../hooks/findings'
import type { Answer } from '../hooks/findings'
import { gate } from '../hooks/gate'
import { classify } from '../hooks/output'
import { judgeCommand, whereOf } from '../hooks/rules'
import { FRESH } from '../hooks/state'
import type { Finding, Loop } from '../types'
import { approved, bash, CONFIG, change, devloop, edit, feature, start, stop, world } from './world'
import type { Dollar, World } from './world'

// Phase B2.1: the fixes decided in docs/reviews/phase-b2.md, one block per
// item, named as the review names them. Fail safe, never fail useful.

const answer = ($: Dollar, agentId: string, text: string, isAborted = false) =>
  $.turn.complete({ answer: text, durationMs: 1, isAborted, turnId: `t-${agentId}`, agentId, reason: isAborted ? 'aborted' : 'answer' })

const CHARGE = ['import x', 'export function charge(cents: number) {', '  return Math.floor(cents)', '}'].join('\n')

async function reviewable($: Dollar, w: World): Promise<void> {
  w.files['/repo/src/charge.ts'] = CHARGE
  await start($)
  await edit($, '/repo/src/charge.ts')
  change(w, 'src/charge.ts')
  expect((await stop($)).block).toBeUndefined()
}

const stored = (w: World): Loop => (w.store['loop:/repo'] as { value: Loop }).value
const metric = (w: World, name: string): number => ((w.store['metrics:/repo'] as Record<string, number> | undefined) ?? {})[name] ?? 0

// ---------------------------------------------------------------- F1

describe('F1: a round passes only on positive evidence', () => {
  test('finding-like lines that cannot be read are kept as unread, not dropped; a heading mark is read', async () => {
    const parsed = parseReview([
      'F1 | high | src/charge.ts:3 | return Math.floor(cents) | rounds down',
      'F2 | severe | src/charge.ts:3 | return Math.floor(cents) | rounds down | a test',
      'F3 | high | src/charge.ts | return Math.floor(cents) | rounds down | a test',
      '### F4 | high | src/charge.ts:3 | return Math.floor(cents) | rounds down | a test',
      'VERDICT: FAIL',
    ].join('\n'))
    expect(parsed.unread.length).toBe(3)
    expect(parsed.findings.map(one => one.id)).toEqual(['F4'])
  })

  const unreadable = [
    'I could not open the diff file.\nVERDICT: FAIL',
    'The rounding in src/charge.ts line 3 is wrong and loses money.\nVERDICT: FAIL',
    'F1 | high | src/charge.ts:3 | return Math.floor(cents) | rounds down\nVERDICT: FAIL',
    'F1 | severe | src/charge.ts:3 | return Math.floor(cents) | rounds down | a test\nVERDICT: FAIL',
    'F1 | high | src/charge.ts | return Math.floor(cents) | rounds down | a test\nVERDICT: FAIL',
  ]
  for (const text of unreadable) {
    test(`never settles as passed, and the push is refused: ${text.split('\n')[0]}`, async ($, on) => {
      const w = world(on)
      await reviewable($, w)
      await devloop($, 'review')
      await answer($, 'agent-1', text)
      // Restated once, by a second agent given the answer.
      expect(w.spawned.length).toBe(2)
      expect(w.spawned[1]?.prompt).toMatch(/Do not review again/)
      await answer($, 'agent-2', text)
      const status = await devloop($, 'status')
      expect(status).not.toMatch(/\[x\] Independent review/)
      expect(status).toMatch(/\[ \] Independent review: F\d+ awaits a person's decision/)
      expect((await bash($, 'git push -u origin feature')).deny).toMatch(/gate is not green/)
      expect(await devloop($, 'findings')).toMatch(/the general reviewer (?:failed this change and gave no readable finding|wrote finding lines the harness could not read)/)
    })
  }

  test('the restatement path too: no verdict first, then a FAIL with prose only, blocks until a person resolves it', async ($, on) => {
    const w = world(on)
    await reviewable($, w)
    await devloop($, 'review')
    await answer($, 'agent-1', 'Rounds down, I think.')
    await answer($, 'agent-2', 'It rounds down.\nVERDICT: FAIL')
    expect((await bash($, 'git push -u origin feature')).deny).toMatch(/awaits a person's decision/)
    // A new round does not clear it: only a person does.
    change(w, 'src/b.ts')
    await stop($)
    await devloop($, 'review')
    await answer($, 'agent-3', 'VERDICT: PASS')
    expect(await devloop($, 'status')).toMatch(/\[ \] Independent review: F1 awaits a person's decision/)
    w.answer = 'Resolve'
    expect(await devloop($, 'findings resolve F1 read it myself')).toMatch(/the review round passes/)
  })
})

// ---------------------------------------------------------------- F2

const FIND = ['function find(id) {', '  const user: User | null = lookup(id)', '  return user.name', '}'].join('\n')
const findFiles = { 'src/find.ts': FIND }
const one = (name: string, text: string): Answer => ({ name, parsed: parseReview(text) })

describe('F2: a pipe in the problem never demotes a real finding', () => {
  test('a problem containing `string | null` or `a || b`, on a line that exists, stays open and blocking', async () => {
    const settled = settleRound({
      round: 1, tier: 'medium', prior: [], files: findFiles,
      answers: [one('general', [
        'F1 | high | src/find.ts:3 | return user.name | user is string | null when the id is missing | a test with a missing id',
        'F2 | high | src/find.ts:2 | const user: User | null = lookup(id) | lookup(id) || fallback is never tried | a test',
        'VERDICT: FAIL',
      ].join('\n'))],
    })
    expect(settled.findings.map(each => [each.id, each.status, each.isBlocking, each.quote, each.problem])).toEqual([
      ['F1', 'open', true, 'return user.name', 'user is string | null when the id is missing'],
      ['F2', 'open', true, 'const user: User | null = lookup(id)', 'lookup(id) || fallback is never tried'],
    ])
    expect(settled.isPassing).toBe(false)
  })

  test('a `+`-prefixed quote, backticks, file:line:col and a backticked file name all verify', async () => {
    const settled = settleRound({
      round: 1, tier: 'medium', prior: [], files: findFiles,
      answers: [one('general', [
        'F1 | high | src/find.ts:3 | +  return user.name | crashes on null | a test',
        'F2 | high | src/find.ts:1:10 | `function  find(id) {` | no type for id | a test',
        'F3 | high | `src/find.ts`:2 | - const user: User | null = lookup(id) | not checked | a test',
        'VERDICT: FAIL',
      ].join('\n'))],
    })
    expect(settled.findings.map(each => [each.id, each.file, each.line, each.status])).toEqual([
      ['F1', 'src/find.ts', 3, 'open'],
      ['F2', 'src/find.ts', 1, 'open'],
      ['F3', 'src/find.ts', 2, 'open'],
    ])
  })

  test('a blocking finding whose quote cannot be found goes to a person; only a non-blocking one becomes a note', async () => {
    const settled = settleRound({
      round: 1, tier: 'medium', prior: [], files: findFiles,
      answers: [one('general', 'F1 | critical | src/find.ts:3 | return user.id | wrong field | a test\nF2 | medium | src/find.ts:3 | return user.id | naming | n\nVERDICT: FAIL')],
    })
    expect(settled.findings.map(each => [each.id, each.status, each.route, each.isBlocking])).toEqual([
      ['F1', 'open', 'decision', true],
      ['F2', 'note', 'fix', false],
    ])
    expect(settled.isPassing).toBe(false)
  })

  test('through the hook: an unverified blocking quote is restated once, then a person decides; the push is refused', async ($, on) => {
    const w = world(on)
    await reviewable($, w)
    await devloop($, 'review')
    const text = 'F1 | critical | src/charge.ts:3 | return cents * 100 | wrong unit | a test\nVERDICT: FAIL'
    await answer($, 'agent-1', text)
    expect(w.spawned.length).toBe(2)
    expect(w.spawned[1]?.prompt).toMatch(/F1/)
    await answer($, 'agent-2', text)
    expect(await devloop($, 'status')).toMatch(/\[ \] Independent review: F1 awaits a person's decision/)
    expect((await bash($, 'git push -u origin feature')).deny).toMatch(/gate is not green/)
  })

  test('through the hook: a problem holding a pipe blocks the push', async ($, on) => {
    const w = world(on)
    await reviewable($, w)
    await devloop($, 'review')
    await answer($, 'agent-1', 'F1 | high | src/charge.ts:3 | return Math.floor(cents) | returns number | NaN for strings | a test\nVERDICT: FAIL')
    expect(await devloop($, 'status')).toMatch(/\[ \] Independent review: round 1 of 3 found problems: F1 open/)
    expect((await bash($, 'git push -u origin feature')).deny).toMatch(/gate is not green/)
  })
})

// ---------------------------------------------------------------- F3

describe('F3: a test file created while building is judged at creation', () => {
  test('focus markers, a TestMain that exits and a module-level skip in a new test file are refused; a plain one is not', async ($, on) => {
    const w = world(on)
    await start($)
    await approved($, w)
    const write = (file_path: string, content: string) => $.tool.call({ tool: 'Write', file_path, content })
    expect((await write('/repo/src/new.test.ts', 'it.only("a", () => { expect(1).toBe(1) })')).deny).toMatch(/skip, only, todo or xfail/)
    expect((await write('/repo/pkg/main_test.go', 'package pkg\n\nfunc TestMain(m *testing.M) {\n\tos.Exit(0)\n}')).deny).toMatch(/skip, only, todo or xfail/)
    expect((await write('/repo/src/test_mod.py', 'import pytest\npytestmark = pytest.mark.skip\n\ndef test_a():\n    assert a')).deny).toMatch(/skip, only, todo or xfail/)
    expect((await write('/repo/src/plain.test.ts', 'it("a", () => { expect(1).toBe(1) })')).deny).toBeUndefined()
    expect((await write('/repo/pkg/setup_test.go', 'package pkg\n\nfunc TestMain(m *testing.M) {\n\tos.Exit(m.Run())\n}')).deny).toBeUndefined()
  })
})

// ---------------------------------------------------------------- F4

const reviewCfg: Config = { ...DEFAULTS, verify: [{ run: 'npm test', profile: 'fast', when: null }], reviewers: [{ name: 'security', when: ['src/**'], mode: 'blocking', prompt: null, model: null }] }
const reviewed: Loop = {
  ...FRESH, changed: ['lib/a.ts'], tree: 't1', size: { files: 1, lines: 10 },
  verify: { ...FRESH.verify, status: 'pass', tree: 't1', profile: 'full', passedOn: { 'npm test': 't1' } },
  review: { ...FRESH.review, status: 'fail', round: 1, tree: 't1', agents: [] },
  evidence: { ...FRESH.evidence, tree: 't1' },
}
const finding = (more: Partial<Finding>): Finding => ({
  id: 'F1', reviewer: 'general', severity: 'critical', file: 'lib/a.ts', line: 1, quote: 'const a = 1', problem: 'p', evidence: 'e',
  isPreExisting: false, route: 'fix', status: 'open', isBlocking: true, round: 1, seen: 1, note: null, ...more,
})

describe('F4: an open blocking finding blocks at every tier, whoever raised it', () => {
  test('below medium tier the review row appears, unmet, while a blocking finding is open', async () => {
    const low: Loop = { ...reviewed, changed: ['docs/a.md'], findings: [finding({ file: 'docs/a.md' })] }
    const row = gate(low, reviewCfg).find(each => each.label === 'Independent review')
    expect(row?.isMet).toBe(false)
    expect(gate({ ...low, findings: [] }, reviewCfg).some(each => each.label === 'Independent review')).toBe(false)
  })

  test('a finding of a specialist that no longer applies keeps the general row unmet', async () => {
    const loop: Loop = { ...reviewed, findings: [finding({ reviewer: 'security' })] }
    const row = gate(loop, reviewCfg).find(each => each.label === 'Independent review')
    expect(row?.isMet).toBe(false)
    expect(row?.note).toMatch(/F1/)
  })

  test('the general reviewer re-checks it: the round closes it when the general reviewer says resolved', async () => {
    const prior = [finding({ reviewer: 'security', file: 'src/find.ts', quote: 'return user.name' })]
    const settled = settleRound({ round: 2, tier: 'medium', prior, files: findFiles, ran: ['general'], answers: [one('general', 'F1 | resolved\nVERDICT: PASS')] })
    expect(settled.addressed).toEqual(['F1'])
    expect(settled.isPassing).toBe(true)
  })

  test('the general reviewer\'s prompt lists it to re-check', async ($, on) => {
    const config = { ...CONFIG, reviewers: [{ name: 'security', when: ['src/auth.ts'], mode: 'blocking' }] }
    const w = world(on, config)
    w.files['/repo/src/auth.ts'] = 'const key = load()'
    await start($)
    await edit($, '/repo/src/auth.ts')
    change(w, 'src/auth.ts')
    await stop($)
    await devloop($, 'review')
    await answer($, 'agent-1', 'VERDICT: PASS')
    await answer($, 'agent-2', 'F1 | high | src/auth.ts:1 | const key = load() | unchecked | a test\nVERDICT: FAIL')
    // The specialist's file is reverted: it no longer applies, its finding still stands.
    w.changed = ['src/charge.ts']
    w.files['/repo/src/charge.ts'] = CHARGE
    w.tree = 't-reverted'
    await stop($)
    await devloop($, 'review')
    const general = w.spawned[w.spawned.length - 1]
    expect(w.spawned.length).toBe(3)
    expect(general?.prompt).toMatch(/Open findings to re-check[\s\S]*F1 \| high \| src\/auth.ts:1/)
  })
})

// ---------------------------------------------------------------- F5

describe('F5: approval fingerprints the text the checks ran on', () => {
  test('a spec changed while the person decides is not approved', async ($, on) => {
    const w = world(on)
    await start($)
    w.files['/repo/specs/login/SPEC.md'] = '# login'
    w.files['/repo/specs/login/features.json'] = JSON.stringify([{ id: 'a', description: 'd', check: 'npm test -- a' }])
    await devloop($, 'spec login')
    w.onAsk = () => {
      w.files['/repo/specs/login/features.json'] = JSON.stringify([{ id: 'a', description: 'd', check: 'true' }])
    }
    expect(await devloop($, 'approve')).toMatch(/changed while/)
    expect(stored(w).phase).toBe('spec')
  })

  test('a test changed while the person decides is not approved', async ($, on) => {
    const w = world(on)
    await start($)
    w.testHashes = { 'src/a.test.ts': 'h1' }
    w.files['/repo/specs/login/SPEC.md'] = '# login'
    w.files['/repo/specs/login/features.json'] = JSON.stringify([{ id: 'a', description: 'd', check: 'npm test -- a' }])
    await devloop($, 'spec login')
    w.onAsk = () => {
      w.testHashes = { 'src/a.test.ts': 'h2' }
    }
    expect(await devloop($, 'approve')).toMatch(/changed while/)
    expect(stored(w).phase).toBe('spec')
  })
})

// ---------------------------------------------------------------- F6

describe('F6: every feature check is judged by the command rules before it runs', () => {
  test('at approval: a refused check is not run, is listed with its rule, and approval is refused', async ($, on) => {
    const w = world(on)
    await start($)
    w.files['/repo/specs/login/SPEC.md'] = '# login'
    w.files['/repo/specs/login/features.json'] = JSON.stringify([
      { id: 'a', description: 'd', check: 'npm test -- a' },
      { id: 'b', description: 'd', check: 'cat .env && npm test -- b' },
    ])
    await devloop($, 'spec login')
    const said = await devloop($, 'approve')
    expect(said).toMatch(/cannot be approved/)
    expect(said).toMatch(/b: `cat \.env && npm test -- b` \(secret/)
    expect(w.ran.some(one => one.includes('.env'))).toBe(false)
    expect(w.questions).toEqual([])
    expect(stored(w).phase).toBe('spec')
  })

  test('the dialog shows each check\'s command', async ($, on) => {
    const w = world(on)
    await start($)
    await approved($, w)
    expect(w.questions[0]).toMatch(/rejects-bad-password: npm test -- bad-password/)
  })

  test('in feature_check: a check the rules refuse while building is not run', async ($, on) => {
    const w = world(on)
    await start($)
    await approved($, w, [{ id: 'report', description: 'd', check: 'npm test -- a > tests/report.txt' }])
    // C1 item 10: an untracked non-test file under tests/ is not locked; a tracked one is a test.
    w.tracked = ['tests/report.txt']
    const before = w.ran.length
    expect(await feature($, 'report')).toMatch(/NOT RUN report[\s\S]*tests-locked/)
    expect(w.ran.length).toBe(before)
  })
})

// ---------------------------------------------------------------- F7

describe('F7: the folder probe judges folders, never a file path', () => {
  test('a new test file under tests/ may be written while building; an exact-path exemption holds there', async ($, on) => {
    const w = world(on)
    await start($)
    await approved($, w)
    expect((await $.tool.call({ tool: 'Write', file_path: '/repo/tests/new.test.ts', content: 'it("a", () => { expect(1).toBe(1) })' })).deny).toBeUndefined()
    w.files['/repo/tests/login.test.ts'] = 'it("a", () => { expect(a).toBe(1) })'
    w.tracked = ['tests/login.test.ts']
    expect((await edit($, '/repo/tests/login.test.ts')).deny).toMatch(/tests are locked/)
    w.answer = 'Allow once'
    await devloop($, 'allow tests/login.test.ts')
    expect((await edit($, '/repo/tests/login.test.ts')).deny).toBeUndefined()
    // A folder is still probed.
    expect((await bash($, 'rm -r tests')).deny).toMatch(/tests are locked/)
  })
})

// ---------------------------------------------------------------- F11

describe('F11: a shadow reviewer neither holds nor drops a round', () => {
  const config = { ...CONFIG, reviewers: [{ name: 'a11y', when: ['src/**'], mode: 'shadow', prompt: 'Check accessibility.' }] }

  test('the round settles when the general reviewer has answered; a shadow abort changes nothing', async ($, on) => {
    const w = world(on, config)
    await reviewable($, w)
    await devloop($, 'review')
    await answer($, 'agent-1', 'VERDICT: PASS')
    expect(await devloop($, 'status')).toMatch(/\[x\] Independent review: passed in round 1/)
    await answer($, 'agent-2', '', true)
    expect(await devloop($, 'status')).toMatch(/\[x\] Independent review: passed in round 1/)
    expect(stored(w).review.round).toBe(1)
  })

  test('a shadow answer is counted when it arrives, after the round settled', async ($, on) => {
    const w = world(on, config)
    await reviewable($, w)
    await devloop($, 'review')
    await answer($, 'agent-1', 'VERDICT: PASS')
    await answer($, 'agent-2', 'F1 | high | src/charge.ts:3 | return Math.floor(cents) | no label | a test\nVERDICT: FAIL')
    expect([metric(w, 'shadow:a11y:rounds'), metric(w, 'shadow:a11y:would-block'), metric(w, 'shadow:a11y:agreed')]).toEqual([1, 1, 0])
    expect(await devloop($, 'status')).toMatch(/\[x\] Independent review: passed in round 1/)
  })
})

// ---------------------------------------------------------------- F12

describe('F12: an exemption is recorded as used only for a write it lifted a rule for', () => {
  test('a read, or a write no rule refused, records nothing; a lifted write records the concrete path; approval and done clear it', async ($, on) => {
    const w = world(on)
    await start($)
    w.files['/repo/src/a.ts'] = 'a'
    w.files['/repo/REVIEW.md'] = 'a'
    w.answer = 'Allow once'
    await devloop($, 'allow **')
    await $.tool.call({ tool: 'Read', file_path: '/repo/REVIEW.md' })
    await edit($, '/repo/src/a.ts')
    expect(stored(w).exemptionsUsed).toEqual([])
    expect((await edit($, '/repo/REVIEW.md')).deny).toBeUndefined()
    expect(stored(w).exemptionsUsed).toEqual(['REVIEW.md'])
    // A command exemption: recorded only when it lifted a rule.
    await devloop($, 'allow --command ls -la')
    await bash($, 'ls -la')
    await devloop($, 'allow --command git reset --hard')
    expect((await bash($, 'git reset --hard')).deny).toBeUndefined()
    expect(stored(w).exemptionsUsed).toEqual(['REVIEW.md', 'command: git reset --hard'])
    w.answer = 'Close anyway'
    await devloop($, 'done')
    expect(stored(w).exemptionsUsed).toEqual([])
  })

  test('approval clears it', async ($, on) => {
    const w = world(on)
    await start($)
    w.files['/repo/REVIEW.md'] = 'a'
    w.answer = 'Allow once'
    await devloop($, 'allow REVIEW.md')
    await edit($, '/repo/REVIEW.md')
    expect(stored(w).exemptionsUsed).toEqual(['REVIEW.md'])
    await approved($, w)
    expect(stored(w).exemptionsUsed).toEqual([])
  })
})

// ---------------------------------------------------------------- cut by the cap

describe('cut by the reviewer\'s cap', () => {
  test('the cap of twelve is applied after quote verification, pre_existing ranked last', async () => {
    const lines = [
      ...Array.from({ length: 12 }, (_, i) => `F${i + 1} | critical | src/find.ts:3 | return user.name | old ${i} | n | pre_existing`),
      'F13 | high | src/find.ts:3 | return user.name | new | a test',
      'VERDICT: FAIL',
    ]
    const settled = settleRound({ round: 1, tier: 'medium', prior: [], files: findFiles, answers: [one('general', lines.join('\n'))] })
    expect(settled.isPassing).toBe(false)
    expect(settled.findings.some(each => each.problem === 'new' && each.status === 'open')).toBe(true)
    expect(capFindings([{ severity: 'nit' as const, isPreExisting: false }, { severity: 'critical' as const, isPreExisting: true }], 1)[0]?.severity).toBe('nit')
  })

  test('outside git the credential row reads "not scanned" and is unmet for medium and high tiers', async () => {
    const cfg: Config = { ...DEFAULTS }
    const outside: Loop = { ...FRESH, changed: ['src/a.ts'], tree: null, verify: { ...FRESH.verify, status: 'pass' } }
    const medium = gate(outside, cfg).find(each => each.label === 'No credentials in the diff')
    expect(medium).toMatchObject({ isMet: false })
    expect(medium?.note).toMatch(/not scanned/)
    const low = gate({ ...outside, changed: ['docs/a.md'] }, cfg).find(each => each.label === 'No credentials in the diff')
    expect(low?.isMet).toBe(true)
    expect(low?.note).toMatch(/not scanned/)
  })

  test('a missing test-hash record at approval leaves the tests row unmet, not absent', async () => {
    const building: Loop = { ...reviewed, phase: 'build', spec: 's', testHashes: null }
    expect(gate(building, reviewCfg).find(each => each.label === 'Tests unchanged since approval')).toMatchObject({ isMet: false })
  })

  test('an infrastructure outcome is decided by exit code, never by the output text alone', async () => {
    expect(classify(1, 'sh: 1: jest: not found')).toBe('fail')
    expect(classify(1, 'bash: line 1: vitest: command not found')).toBe('fail')
    expect(classify(127, 'bash: line 1: vitest: command not found')).toBe('not-found')
  })
})

// ---------------------------------------------------------------- the builder's notes

describe('from the builder\'s own notes', () => {
  test('the stop gate\'s automatic review reads autoReview from the policy in force', async ($, on) => {
    const w = world(on)
    w.basePolicy = JSON.stringify({ ...CONFIG, autoReview: false })
    w.files['/repo/src/charge.ts'] = CHARGE
    await start($)
    await approved($, w, [{ id: 'charges', description: 'd', check: 'npm test -- charges' }])
    await edit($, '/repo/src/charge.ts')
    change(w, 'src/charge.ts')
    await feature($, 'charges')
    await stop($)
    expect(w.spawned).toEqual([])
  })

  test('test hashes are computed with the tests globs of the policy in force', async ($, on) => {
    const w = world(on)
    w.basePolicy = JSON.stringify({ ...CONFIG, tests: ['checks/**'] })
    w.testHashes = { 'src/a.test.ts': 'h1', 'checks/b.py': 'h2' }
    await start($)
    await approved($, w)
    expect(stored(w).testHashes).toEqual({ 'checks/b.py': 'h2' })
  })

  test('the diff\'s path is a current fact, so the task part is the same every round', async () => {
    const facts = {
      brief: 'BRIEF', reviewMd: null, spec: null, base: 'abc', diff: '/data/review-1.diff', tier: 'medium' as const,
      changed: ['a.ts'], checks: [], round: 1, maxRounds: 3, open: [], nextId: 1,
    }
    const task = (text: string): string => text.slice(0, text.indexOf('## Current facts'))
    const first = reviewPrompt(facts)
    expect(task(reviewPrompt({ ...facts, diff: '/data/review-2.diff', round: 2 }))).toBe(task(first))
    expect(first.indexOf('/data/review-1.diff')).toBeGreaterThan(first.indexOf('## Current facts'))
  })
})

// ---------------------------------------------------------------- F9 (also in the ordinary-commands table)

describe('F9: for deletion and weakening, a test is a tracked file matching the test globs', () => {
  const at = whereOf('/repo', '/repo', { home: '/home/u', stateRoot: '/data/devloop' })
  test('untracked caches and logs under a test folder may be removed; a tracked test may not', async () => {
    expect(judgeCommand('rm -rf tests/__pycache__', DEFAULTS, FRESH, { ...at, filesUnder: { 'tests/__pycache__': [] } })).toBe(null)
    expect(judgeCommand('rm tests/output.log', DEFAULTS, FRESH, { ...at, filesUnder: { 'tests/output.log': [] } })).toBe(null)
    expect(judgeCommand('rm tests/a.test.ts', DEFAULTS, FRESH, { ...at, filesUnder: { 'tests/a.test.ts': ['tests/a.test.ts'] } })?.rule).toBe('test-weakened')
    expect(judgeCommand('rm -r tests', DEFAULTS, FRESH, { ...at, filesUnder: { tests: ['tests/a.test.ts', 'tests/cache.log'] } })?.rule).toBe('test-weakened')
    // Not listed (outside git, or the listing failed): the globs alone decide.
    expect(judgeCommand('rm tests/output.log', DEFAULTS, FRESH, at)?.rule).toBe('test-weakened')
  })
})
