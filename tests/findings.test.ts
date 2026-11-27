import { describe, expect, test } from 'claude-code/testing'

import {
  addToBacklog, BLOCKS, capFindings, closeGone, isBlockingAt, isQuoteAt, keyOf, parseReview, restatePrompt, reviewPrompt, settleRound,
  toDeferred, wouldBlock,
} from '../hooks/findings'
import type { Answer, RawFinding } from '../hooks/findings'
import type { Finding, Severity } from '../types'

const FILE = ['import x', 'function charge(cents) {', '  return Math.floor(cents)', '}', '', 'export { charge }'].join('\n')
const files = { 'src/charge.ts': FILE, 'src/other.ts': 'const a = 1\nconst b = 2' }

describe('parsing a reviewer\'s answer', () => {
  test('finding lines, with flags and a route, and the verdict', async () => {
    const parsed = parseReview([
      'Some prose first.',
      'F1 | high | src/charge.ts:3 | return Math.floor(cents) | rounds down | a test with 0.5',
      'F2 | low | src/other.ts:1 | const a = 1 | unused | delete it | pre_existing',
      'F3 | medium | src/charge.ts:2 | function charge(cents) { | should money be integers? | a person\'s call | decision',
      'F4 | nit | src/charge.ts:6 | export { charge } | export style | none | route: defer',
      'VERDICT: FAIL',
    ].join('\n'))
    expect(parsed.verdict).toBe('FAIL')
    expect(parsed.findings.map(one => [one.id, one.severity, one.file, one.line, one.isPreExisting, one.route])).toEqual([
      ['F1', 'high', 'src/charge.ts', 3, false, 'fix'],
      ['F2', 'low', 'src/other.ts', 1, true, 'fix'],
      ['F3', 'medium', 'src/charge.ts', 2, false, 'decision'],
      ['F4', 'nit', 'src/charge.ts', 6, false, 'defer'],
    ])
    expect(parsed.findings[0]?.quote).toBe('return Math.floor(cents)')
    expect(parsed.findings[0]?.evidence).toBe('a test with 0.5')
  })

  test('tolerant of markdown noise: bullets, bold, backticks, table edges, numbering', async () => {
    const parsed = parseReview([
      '- **F1** | **HIGH** | `src/charge.ts:3` | `return Math.floor(cents)` | rounds down | a test',
      '| F2 | low | ./src/other.ts:2 | const b = 2 | x | y |',
      '2. F3 | nit | src/a.ts:1-4 | a | b | c',
      '**VERDICT: PASS**',
    ].join('\n'))
    expect(parsed.verdict).toBe('PASS')
    expect(parsed.findings.map(one => `${one.id} ${one.severity} ${one.file}:${one.line} ${one.quote}`)).toEqual([
      'F1 high src/charge.ts:3 return Math.floor(cents)',
      'F2 low src/other.ts:2 const b = 2',
      'F3 nit src/a.ts:1 a',
    ])
  })

  test('a quote may hold a pipe', async () => {
    const parsed = parseReview('F1 | high | src/a.ts:1 | a || b | short-circuits | a test\nVERDICT: FAIL')
    expect(parsed.findings[0]?.quote).toBe('a || b')
    expect(parsed.findings[0]?.problem).toBe('short-circuits')
  })

  test('re-check lines, and the last verdict wins', async () => {
    const parsed = parseReview('F1 | resolved\nF2 | still open\nVERDICT: FAIL\nOn reflection:\nVERDICT: PASS')
    expect(parsed.rechecks).toEqual({ F1: 'resolved', F2: 'open' })
    expect(parsed.verdict).toBe('PASS')
  })

  test('no verdict line is a format failure', async () => {
    expect(parseReview('src/a.ts:10 — rounds down — a test').verdict).toBe(null)
    expect(parseReview('The verdict: it passes').verdict).toBe(null)
  })
})

describe('quotes, the cap and the tier table', () => {
  test('a quote is found at its line or within three lines, whitespace aside', async () => {
    expect(isQuoteAt(FILE, 3, 'return Math.floor(cents)')).toBe(true)
    expect(isQuoteAt(FILE, 6, 'return   Math.floor(cents)')).toBe(true)
    expect(isQuoteAt(FILE, 3, 'return Math.round(cents)')).toBe(false)
    expect(isQuoteAt(['a', 'b', 'c', 'd', 'e', 'f', 'g', 'return x'].join('\n'), 1, 'return x')).toBe(false)
    expect(isQuoteAt(FILE, 4, '}')).toBe(false)
    expect(isQuoteAt(null, 1, 'import x')).toBe(false)
  })

  test('which severities block, by tier; pre_existing and defer never do', async () => {
    const at = (severity: Severity, tier: 'low' | 'medium' | 'high', more: Partial<RawFinding> = {}): boolean =>
      isBlockingAt({ severity, isPreExisting: false, route: 'fix', ...more }, tier)
    expect(BLOCKS.low).toEqual(['critical'])
    expect([at('critical', 'low'), at('high', 'low')]).toEqual([true, false])
    expect([at('high', 'medium'), at('medium', 'medium')]).toEqual([true, false])
    expect([at('low', 'high'), at('nit', 'high')]).toEqual([true, false])
    expect(at('critical', 'high', { isPreExisting: true })).toBe(false)
    expect(at('critical', 'high', { route: 'defer' })).toBe(false)
    expect(at('critical', 'high', { route: 'decision' })).toBe(true)
  })

  test('at most twelve per round, the most severe kept', async () => {
    const many = [...Array.from({ length: 12 }, () => ({ severity: 'nit' as const })), { severity: 'critical' as const }]
    const kept = capFindings(many)
    expect(kept.length).toBe(12)
    expect(kept[0]?.severity).toBe('critical')
  })
})

const answer = (name: string, text: string): Answer => ({ name, parsed: parseReview(text) })
const ONE = 'F1 | high | src/charge.ts:3 | return Math.floor(cents) | rounds down | a test with 0.5'

describe('deciding a round: the harness, not the verdict line', () => {
  test('a reviewer FAIL with nothing blocking passes, with notes', async () => {
    const settled = settleRound({ round: 1, tier: 'medium', prior: [], files, answers: [answer('general', 'F1 | low | src/charge.ts:3 | return Math.floor(cents) | naming | n\nVERDICT: FAIL')] })
    expect(settled.isPassing).toBe(true)
    expect(settled.deferred.map(one => one.id)).toEqual(['F1'])
  })

  test('a reviewer PASS with a verified blocking finding fails', async () => {
    const settled = settleRound({ round: 1, tier: 'medium', prior: [], files, answers: [answer('general', `${ONE}\nVERDICT: PASS`)] })
    expect(settled.isPassing).toBe(false)
    expect(settled.findings[0]).toMatchObject({ id: 'F1', status: 'open', isBlocking: true })
  })

  test('a quote not at its line is demoted to a note when its severity does not block; B2.1 F2: a blocking one goes to a person', async () => {
    const settled = settleRound({ round: 1, tier: 'medium', prior: [], files, answers: [answer('general', 'F1 | medium | src/charge.ts:3 | return cents * 100 | wrong | x\nVERDICT: FAIL')] })
    expect(settled.isPassing).toBe(true)
    expect(settled.demoted).toEqual(['F1'])
    expect(settled.findings[0]?.status).toBe('note')
    const blocking = settleRound({ round: 1, tier: 'high', prior: [], files, answers: [answer('general', 'F1 | critical | src/charge.ts:3 | return cents * 100 | wrong | x\nVERDICT: FAIL')] })
    expect(blocking.isPassing).toBe(false)
    expect(blocking.unverified).toEqual(['F1'])
    expect(blocking.findings[0]).toMatchObject({ status: 'open', route: 'decision', isBlocking: true })
  })

  test('the same finding blocks at high tier and not at low', async () => {
    const run = (tier: 'low' | 'high') => settleRound({ round: 1, tier, prior: [], files, answers: [answer('general', `${ONE}\nVERDICT: FAIL`)] }).isPassing
    expect(run('low')).toBe(true)
    expect(run('high')).toBe(false)
  })

  test('the lifecycle across rounds: addressed, reappeared, still open, new', async () => {
    const first = settleRound({ round: 1, tier: 'medium', prior: [], files, answers: [answer('general', `${ONE}\nF2 | high | src/other.ts:1 | const a = 1 | shadowed | a test\nVERDICT: FAIL`)] })
    // Round 2: F1 said resolved; F2 re-reported; a new one.
    const second = settleRound({
      round: 2, tier: 'medium', prior: first.findings, files,
      answers: [answer('general', 'F1 | resolved\nF2 | high | src/other.ts:1 | const a = 1 | shadowed | a test\nF3 | critical | src/other.ts:2 | const b = 2 | leaks | a test\nVERDICT: FAIL')],
    })
    expect([second.addressed, second.stillOpen, second.added, second.reappeared]).toEqual([['F1'], ['F2'], ['F3'], []])
    // Round 3: F1's problem is back (same file and quote): it reappears under its old id.
    const third = settleRound({ round: 3, tier: 'medium', prior: second.findings, files, answers: [answer('general', `F9 | high | src/charge.ts:3 | return Math.floor(cents) | still rounds down | a test\nF2 | resolved\nF3 | resolved\nVERDICT: FAIL`)] })
    expect(third.reappeared).toEqual(['F1'])
    expect(third.findings.find(one => one.id === 'F1')?.status).toBe('open')
    expect(third.findings.some(one => one.id === 'F4')).toBe(false)
  })

  test('an open finding not re-checked closes when the line it quotes is gone, and stands while it is there', async () => {
    const first = settleRound({ round: 1, tier: 'medium', prior: [], files, answers: [answer('general', `${ONE}\nVERDICT: FAIL`)] })
    const kept = settleRound({ round: 2, tier: 'medium', prior: first.findings, files, answers: [answer('general', 'VERDICT: PASS')] })
    expect(kept.stillOpen).toEqual(['F1'])
    expect(kept.isPassing).toBe(false)
    const gone = settleRound({ round: 2, tier: 'medium', prior: first.findings, files: { 'src/charge.ts': 'return Math.round(cents)' }, answers: [answer('general', 'VERDICT: PASS')] })
    expect(gone.addressed).toEqual(['F1'])
    expect(gone.isPassing).toBe(true)
  })

  test('a round that closes no open finding is stalled', async () => {
    const first = settleRound({ round: 1, tier: 'medium', prior: [], files, answers: [answer('general', `${ONE}\nVERDICT: FAIL`)] })
    expect(first.isStalled).toBe(false)
    const second = settleRound({ round: 2, tier: 'medium', prior: first.findings, files, answers: [answer('general', `${ONE}\nVERDICT: FAIL`)] })
    expect(second.isStalled).toBe(true)
  })

  test('a decision stays open across rounds and is never re-checked; a person-resolved one is not raised again', async () => {
    const decision = 'F1 | high | src/charge.ts:2 | function charge(cents) { | integers or decimals? | a person decides | decision'
    const first = settleRound({ round: 1, tier: 'medium', prior: [], files, answers: [answer('general', `${decision}\nVERDICT: FAIL`)] })
    const second = settleRound({ round: 2, tier: 'medium', prior: first.findings, files, answers: [answer('general', 'F1 | resolved\nVERDICT: PASS')] })
    expect(second.findings[0]?.status).toBe('open')
    expect(second.isPassing).toBe(false)
    expect(second.isStalled).toBe(false)
    const resolved: Finding[] = second.findings.map(one => ({ ...one, status: 'resolved', note: 'integers' }))
    const third = settleRound({ round: 3, tier: 'medium', prior: resolved, files, answers: [answer('general', `${decision.replace('F1', 'F5')}\nVERDICT: FAIL`)] })
    expect(third.isPassing).toBe(true)
    expect(third.findings.length).toBe(1)
  })

  test('a shadow reviewer would have blocked only on a verified, blocking finding', async () => {
    expect(wouldBlock(parseReview(`${ONE}\nVERDICT: FAIL`), 'medium', files)).toBe(true)
    expect(wouldBlock(parseReview(`${ONE}\nVERDICT: FAIL`), 'low', files)).toBe(false)
    expect(wouldBlock(parseReview('F1 | high | src/charge.ts:3 | not there | x | y\nVERDICT: FAIL'), 'medium', files)).toBe(false)
  })
})

describe('the deferred backlog', () => {
  const finding: Finding = {
    id: 'F1', reviewer: 'general', severity: 'low', file: 'src/charge.ts', line: 3, quote: 'return Math.floor(cents)', problem: 'p', evidence: 'e',
    isPreExisting: false, route: 'defer', status: 'deferred', isBlocking: false, round: 1, seen: 1, note: null,
  }

  test('kept by file and quote, once', async () => {
    const one = toDeferred(finding, 'pay', 1)
    expect(one.key).toBe(keyOf(finding))
    expect(addToBacklog([one], [toDeferred({ ...finding, id: 'F7' }, 'other', 2)]).length).toBe(1)
  })

  test('closed when the quoted line no longer exists; left alone for a file not read', async () => {
    const list = [toDeferred(finding, 'pay', 1)]
    expect(closeGone(list, { 'src/charge.ts': FILE })[0]?.status).toBe('open')
    expect(closeGone(list, { 'src/charge.ts': 'return Math.round(cents)' })[0]?.status).toBe('closed')
    expect(closeGone(list, { 'src/charge.ts': null })[0]?.status).toBe('closed')
    expect(closeGone(list, {})[0]?.status).toBe('open')
  })
})

describe('the reviewer\'s prompt', () => {
  const facts = {
    brief: 'BRIEF', reviewMd: 'Check money.', spec: 'pay', base: 'abc123', diff: '/data/review-1.diff', tier: 'medium' as const,
    changed: ['src/charge.ts'], checks: ['npm test'], round: 2, maxRounds: 3, open: [], nextId: 4,
  }

  test('three fixed parts, stable first: task and base, current facts, contract', async () => {
    const prompt = reviewPrompt(facts)
    // B2.1: the diff's path carries the round, so it is a current fact, not part of the frozen task.
    const order = ['## Task', 'BRIEF', 'Check money.', 'specs/pay/SPEC.md', 'abc123', '## Current facts', '/data/review-1.diff', 'Risk tier: medium', 'round 2 of 3', 'from F4', '## Contract', 'VERDICT: PASS']
    const at = order.map(part => prompt.indexOf(part))
    expect(at.every(i => i >= 0)).toBe(true)
    expect([...at].sort((a, b) => a - b)).toEqual(at)
    // The frozen part is byte-identical across rounds and findings.
    const task = (text: string): string => text.slice(0, text.indexOf('## Current facts'))
    expect(task(reviewPrompt({ ...facts, round: 3, nextId: 9 }))).toBe(task(prompt))
    expect(prompt).toMatch(/at most 12 findings/)
    expect(prompt).toMatch(/Assurance boundary: once a test shows a property in both directions/)
    expect(prompt).not.toMatch(/look harder/i)
  })

  test('with no REVIEW.md on the base, the prompt says so', async () => {
    expect(reviewPrompt({ ...facts, reviewMd: null })).toMatch(/The base branch has no REVIEW.md: use this brief alone/)
  })

  test('the restatement carries the previous answer and the contract', async () => {
    const text = restatePrompt('it looks fine to me')
    expect(text).toMatch(/Do not review again/)
    expect(text).toMatch(/it looks fine to me/)
    expect(text).toMatch(/## Contract/)
  })
})
