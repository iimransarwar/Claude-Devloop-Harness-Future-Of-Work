// Review findings as pure functions: reading a reviewer's answer, checking
// each quote against the code, which severities block at which tier, the
// lifecycle across rounds, the deferred backlog, and the words of the
// reviewer's prompt. Nothing here touches `$`; review.ts does the work.

import type { Deferred, Finding, Route, Severity, Tier } from '../types'

export const SEVERITIES: readonly Severity[] = ['critical', 'high', 'medium', 'low', 'nit']

/** At most this many findings count per reviewer per round: the most severe are kept. */
export const FINDINGS_CAP = 12

/** How many lines away from the cited one a quote may sit and still be found. */
export const QUOTE_SLACK = 3

/** One way of reading a finding's last fields when its text holds `|`. */
export type Reading = { quote: string; problem: string; evidence: string }

/** A finding as a reviewer wrote it, before the harness checks it. */
export type RawFinding = {
  id: string
  severity: Severity
  file: string
  line: number
  quote: string
  problem: string
  evidence: string
  isPreExisting: boolean
  route: Route
  /** Marked `outside`: seen outside the lines a scoped round reads (DESIGN 4.16, decision 8); read only in such a round. */
  isOutside?: boolean
  /**
   * Every way of splitting the fields after `file:line` into quote, problem
   * and evidence, longest quote first; the first is `quote`/`problem`/`evidence`.
   * The harness keeps the one whose quote is in the file.
   */
  readings: Reading[]
}

export type Parsed = {
  /** The reviewer's own summary; null when no `VERDICT:` line could be read: a format failure. */
  verdict: 'PASS' | 'FAIL' | null
  findings: RawFinding[]
  /** What the reviewer said of earlier findings: `F3 | resolved` or `F3 | open`. */
  rechecks: Record<string, 'resolved' | 'open'>
  /** Lines that look like a finding (`F<n> …`) but could not be read as one: a format failure. */
  unread: string[]
}

/** Markdown a reviewer may wrap a line in: headings, list bullets, numbering, quotes, bold, table edges. */
function unwrap(line: string): string {
  return line
    .replace(/^\s*(?:#{1,6}\s+|[-*+>]\s+|\d+[.)]\s+)*/, '')
    .replace(/\*\*|__/g, '')
    .trim()
    .replace(/^\|\s*/, '')
    .replace(/\s*\|$/, '')
}

/** A field without the backticks or quotes a reviewer put round it. */
const bare = (text: string): string => text.trim().replace(/^`+|`+$/g, '').replace(/^"(.*)"$/, '$1').trim()

const FLAG = /^(?:pre[_ -]?existing|outside(?:[_ -]this[_ -]round)?|(?:route\s*[:=]\s*)?(?:fix|decision|defer))$/i

/** A line that reads as a finding or a re-check: `F<n>` and then a field mark. Prose that merely starts with an id does not. */
const FINDING_LIKE = /^F\d+\s*(?:[|:]|[-–—]\s|$)/i

/** `file:line`, `file:line:col` or `file:line-line`, a file name in backticks too; null without a line number. */
function locationOf(field: string): { file: string; line: number } | null {
  const at = /^(.+?):(\d+)(?::\d+)?(?:[-–]\d+(?::\d+)?)?$/.exec(bare(field).replace(/`/g, '').trim())

  return at === null ? null : { file: (at[1] ?? '').trim().replace(/^\.\//, ''), line: Number(at[2]) }
}

/**
 * Reads a reviewer's answer: finding lines
 * `F<n> | <severity> | <file>:<line> | <quote> | <problem> | <evidence>`
 * with optional `pre_existing` and a route (`fix`, `decision`, `defer`) at
 * the end, re-check lines `F<n> | resolved|open`, and the last
 * `VERDICT: PASS|FAIL`. Tolerant of markdown around them. A `|` may sit in
 * the quote or the problem: every split is kept (`readings`), and the quote
 * check picks the one that is in the file. A line that looks like a finding
 * but does not fit (a field missing, an unknown severity, no line number) is
 * kept in `unread`, never dropped; other lines are prose.
 */
export function parseReview(text: string): Parsed {
  const findings: RawFinding[] = []
  const rechecks: Record<string, 'resolved' | 'open'> = {}
  const unread: string[] = []
  for (const raw of text.split('\n')) {
    const line = unwrap(raw)
    const parts = line.split('|')
    const fields = parts.map(one => one.trim())
    const id = /^F(\d+)$/i.exec(bare(fields[0] ?? '').replace(/[:.]$/, ''))
    if (id === null) {
      if (FINDING_LIKE.test(bare(line))) {
        unread.push(line.slice(0, 200))
      }
      continue
    }
    const name = `F${Number(id[1])}`
    const said = bare(fields[1] ?? '').toLowerCase()
    if (fields.length <= 3 && /^(?:resolved|fixed|addressed|closed)\b/.test(said)) {
      rechecks[name] = 'resolved'
      continue
    }
    if (fields.length <= 3 && /^(?:open|still open|not resolved|unresolved)\b/.test(said)) {
      rechecks[name] = 'open'
      continue
    }
    const at = locationOf(fields[2] ?? '')
    if (fields.length < 6 || !SEVERITIES.includes(said as Severity) || at === null) {
      unread.push(line.slice(0, 200))
      continue
    }
    // Untrimmed, so a quote holding `|` keeps its spacing when joined back.
    const rest = parts.slice(3)
    let isPreExisting = false
    let isOutside = false
    let route: Route = 'fix'
    while (rest.length > 3 && FLAG.test(bare(rest[rest.length - 1] ?? ''))) {
      const flag = bare(rest.pop() ?? '').toLowerCase()
      if (/pre/.test(flag)) {
        isPreExisting = true
      } else if (/outside/.test(flag)) {
        isOutside = true
      } else {
        route = /decision/.test(flag) ? 'decision' : /defer/.test(flag) ? 'defer' : 'fix'
      }
    }
    // Evidence is the last field; the quote ends somewhere before the problem.
    const evidence = bare(rest[rest.length - 1] ?? '')
    // A reviewer that marks the evidence itself as a person's call ("decision: …") routes it to the person.
    if (route === 'fix' && /^decision\b\s*[:-]/i.test(evidence)) {
      route = 'decision'
    }
    const readings: Reading[] = []
    for (let cut = rest.length - 2; cut >= 1; cut -= 1) {
      readings.push({ quote: bare(rest.slice(0, cut).join('|')), problem: bare(rest.slice(cut, -1).join('|')), evidence })
    }
    const first = readings[0] ?? { quote: '', problem: '', evidence }
    if (!findings.some(one => one.id === name)) {
      findings.push({ id: name, severity: said as Severity, file: at.file, line: at.line, ...first, isPreExisting, route, readings, ...(isOutside ? { isOutside } : {}) })
    }
  }
  const verdicts = [...text.matchAll(/VERDICT\s*:\s*[*_`]*\s*(PASS|FAIL)\b/gi)]
  const last = verdicts[verdicts.length - 1]?.[1]?.toUpperCase()

  return { verdict: last === 'PASS' || last === 'FAIL' ? last : null, findings, rechecks, unread }
}

/**
 * Why an answer cannot be read, or null when it can: no verdict line,
 * finding lines that could not be read, a re-check of an id that is no
 * finding of this change (`prior`, F11), or a FAIL with nothing a person or
 * the builder could act on: no readable finding, and no re-check that keeps
 * open (or reopens) a finding of this change. Fail safe: what the harness
 * cannot read never counts as a pass.
 */
export function unreadable(parsed: Parsed, prior: readonly Pick<Finding, 'id' | 'status'>[] = []): string | null {
  if (parsed.verdict === null) {
    return 'it had no `VERDICT:` line in the format'
  }
  if (parsed.unread.length > 0) {
    return `${parsed.unread.length === 1 ? 'a line' : `${parsed.unread.length} lines`} looked like a finding but did not fit the format (${parsed.unread[0] ?? ''})`
  }
  const unknown = Object.keys(parsed.rechecks).filter(id => !prior.some(one => one.id === id))
  if (unknown.length > 0) {
    return `it re-checked ${unknown.slice(0, 3).join(', ')}, which ${unknown.length === 1 ? 'is' : 'are'} no finding of this change`
  }
  const keptOpen = Object.entries(parsed.rechecks).some(([id, said]) => said === 'open' && prior.some(one => one.id === id && (one.status === 'open' || one.status === 'closed')))
  if (parsed.verdict === 'FAIL' && parsed.findings.length === 0 && !keptOpen) {
    return 'it said FAIL and gave no finding in the format'
  }

  return null
}

const RANK: Record<Severity, number> = { critical: 0, high: 1, medium: 2, low: 3, nit: 4 }

/**
 * The `cap` findings that count, in the order written among equals: those
 * that predate the change rank last, then the most severe first, and among
 * equals a verified one (`isVerified`, when known) before one that is not.
 */
export function capFindings<T extends { severity: Severity; isPreExisting?: boolean; isVerified?: boolean }>(list: readonly T[], cap = FINDINGS_CAP): T[] {
  const key = (one: T): number[] => [one.isPreExisting === true ? 1 : 0, RANK[one.severity], one.isVerified === false ? 1 : 0]

  return list
    .map((one, i) => ({ one, i, k: key(one) }))
    .sort((a, b) => (a.k[0] ?? 0) - (b.k[0] ?? 0) || (a.k[1] ?? 0) - (b.k[1] ?? 0) || (a.k[2] ?? 0) - (b.k[2] ?? 0) || a.i - b.i)
    .slice(0, cap)
    .map(({ one }) => one)
}

/** Which severities block at each tier: the riskier the change, the more that blocks. Nits never do. */
export const BLOCKS: Record<Tier, readonly Severity[]> = {
  none: ['critical'],
  low: ['critical'],
  medium: ['critical', 'high'],
  high: ['critical', 'high', 'medium', 'low'],
}

/** Whether a verified finding blocks at a tier: never when it predates the change or is deferred. */
export const isBlockingAt = (one: Pick<RawFinding, 'severity' | 'isPreExisting' | 'route'>, tier: Tier): boolean =>
  !one.isPreExisting && one.route !== 'defer' && BLOCKS[tier].includes(one.severity)

/**
 * A quote as compared: its first non-empty line, with backticks, a leading
 * diff mark (`+`, `-`), surrounding whitespace and runs of spaces taken out.
 */
export const normalQuote = (quote: string): string =>
  (quote.split('\n').find(line => line.trim() !== '') ?? '').replace(/`/g, '').replace(/^\s*[+-]/, '').replace(/\s+/g, ' ').trim()

const normalLine = (line: string): string => line.replace(/`/g, '').replace(/\s+/g, ' ').trim()

/** Whether a quote is in a file's text at or within a few lines of `line`. A quote of under three characters proves nothing. */
export function isQuoteAt(content: string | null, line: number, quote: string, slack = QUOTE_SLACK): boolean {
  const wanted = normalQuote(quote)
  if (content === null || wanted.replace(/\s/g, '').length < 3) {
    return false
  }
  const lines = content.split('\n')
  for (let i = Math.max(0, line - 1 - slack); i <= Math.min(lines.length - 1, line - 1 + slack); i += 1) {
    if (normalLine(lines[i] ?? '').includes(wanted)) {
      return true
    }
  }

  return false
}

/** The reading of a finding whose quote is at its line (the longest such quote), or null when none is. */
export function verifiedReading(raw: Pick<RawFinding, 'line' | 'readings'>, content: string | null): Reading | null {
  return raw.readings.find(one => isQuoteAt(content, raw.line, one.quote)) ?? null
}

/** Whether a quote is anywhere in a file's text: the line it was about still exists. */
export function isQuotePresent(content: string | null, quote: string): boolean {
  const wanted = normalQuote(quote)

  return content !== null && wanted !== '' && content.split('\n').some(line => normalLine(line).includes(wanted))
}

/** The key a finding is kept by across rounds and changes: its file and its quote. */
export const keyOf = (one: { file: string; quote: string }): string => `${one.file}\n${normalQuote(one.quote)}`

export type Answer = { name: string; parsed: Parsed }

export type Round = {
  round: number
  tier: Tier
  /** Every finding of the change so far. */
  prior: readonly Finding[]
  /** The answers that count: the general reviewer's and each blocking specialist's. */
  answers: readonly Answer[]
  /** The files the findings cite, as the reviewed tree has them; null for a file not there. */
  files: Readonly<Record<string, string | null>>
  /**
   * The reviewers the round started, by name. An open finding of a reviewer
   * not among them (a specialist that no longer applies) is re-checked by the
   * general reviewer. Defaults to the reviewers that answered.
   */
  ran?: readonly string[]
  /**
   * The round read only the lines changed since the last one (DESIGN 4.16,
   * decision 8): a finding marked `outside` is a follow-up for the person
   * (deferred, never blocking) unless its severity is high or critical, when
   * it is judged as any finding and says it was missed earlier.
   */
  isScoped?: boolean
}

/** Whether a finding marked `outside` still fails a scoped round: high or critical (decision 8). */
export const isMissedEarlier = (severity: Severity): boolean => severity === 'critical' || severity === 'high'

/** What an outside finding's problem says: why it is in this round at all. */
export const OUTSIDE = 'outside this round\'s lines, a follow-up for the person: '
export const MISSED = 'missed in an earlier round (outside this round\'s lines): '

export type Settled = {
  findings: Finding[]
  addressed: string[]
  reappeared: string[]
  stillOpen: string[]
  added: string[]
  /** Findings of a non-blocking severity whose quote is not at the line they cite: kept as notes, never blocking. */
  demoted: string[]
  /** Findings of a blocking severity whose quote is not at the line they cite: a person decides them. */
  unverified: string[]
  /** Verified findings that do not block, or that were routed `defer`: they go to the backlog. */
  deferred: Finding[]
  /** No blocking finding is open. */
  isPassing: boolean
  /** There were findings to fix, and the round closed none of them. */
  isStalled: boolean
}

const content = (files: Round['files'], file: string): string | null => files[file] ?? null

/** What a person reads on a finding whose quote the harness could not find. */
const UNVERIFIED = 'the quoted line is not at the line cited, so a person checks it: '

/** A raw finding with the reading whose quote is in the file, and whether one was. */
function checked(raw: RawFinding, files: Round['files']): RawFinding & { isVerified: boolean } {
  const reading = verifiedReading(raw, content(files, raw.file))

  return reading === null ? { ...raw, isVerified: false } : { ...raw, ...reading, isVerified: true }
}

/** The blocking findings of an answer whose quote is not at its line: after one restatement, each goes to a person. */
export function unverifiedBlocking(parsed: Parsed, tier: Tier, files: Round['files']): string[] {
  return parsed.findings.filter(raw => isBlockingAt(raw, tier) && verifiedReading(raw, content(files, raw.file)) === null).map(raw => raw.id)
}

/**
 * Decides a round from what its reviewers said and what the code holds: the
 * harness, not the verdict line, decides. Open findings to fix are closed
 * when the reviewer says resolved, or when the line they quote is gone;
 * re-reported, they stay open. A new finding whose quote is not at its line
 * is a note when its severity does not block, and a decision for a person
 * when it does; one matching a closed finding has reappeared and is opened
 * again under its old id. Decisions stay open until a person resolves them.
 */
export function settleRound(input: Round): Settled {
  const { round, tier, answers, files } = input
  const ran = input.ran ?? answers.map(one => one.name)
  const findings: Finding[] = input.prior.map(one => ({ ...one }))
  const out: Omit<Settled, 'findings' | 'isPassing' | 'isStalled'> = { addressed: [], reappeared: [], stillOpen: [], added: [], demoted: [], unverified: [], deferred: [] }
  let next = 1 + findings.reduce((max, one) => Math.max(max, Number(one.id.slice(1)) || 0), 0)
  const toFix = findings.filter(one => one.status === 'open' && one.route === 'fix')
  const reReported = new Set<RawFinding>()
  for (const one of toFix) {
    // A reviewer that no longer applies hands its open findings to the general reviewer.
    const answer = answers.find(each => each.name === (ran.includes(one.reviewer) ? one.reviewer : 'general'))
    if (answer === undefined) {
      // That reviewer did not answer this round: the finding stands.
      out.stillOpen.push(one.id)
      continue
    }
    const again = answer.parsed.findings.find(raw => raw.id === one.id && raw.file === one.file)
    if (answer.parsed.rechecks[one.id] === 'resolved' && again === undefined) {
      one.status = 'closed'
      out.addressed.push(one.id)
    } else if (again !== undefined) {
      reReported.add(again)
      const read = checked(again, files)
      Object.assign(one, { line: again.line, quote: (read.isVerified ? read.quote : '') || one.quote, problem: read.problem || one.problem, seen: round })
      out.stillOpen.push(one.id)
    } else if (answer.parsed.rechecks[one.id] !== 'open' && !isQuotePresent(content(files, one.file), one.quote)) {
      // Not re-checked, and the line it quoted is gone.
      one.status = 'closed'
      out.addressed.push(one.id)
    } else {
      one.seen = round
      out.stillOpen.push(one.id)
    }
  }
  // A re-check that says a closed finding is still open reopens it (F11): the reviewer, not the absent line, decides.
  for (const { parsed } of answers) {
    for (const [id, said] of Object.entries(parsed.rechecks)) {
      const closed = findings.find(one => one.id === id && one.status === 'closed')
      if (said === 'open' && closed !== undefined && !parsed.findings.some(raw => raw.id === id)) {
        Object.assign(closed, { status: 'open', seen: round })
        out.reappeared.push(closed.id)
      }
    }
  }
  for (const { name, parsed } of answers) {
    // Each quote is checked (and the reading whose quote is there chosen) before the cap.
    for (const raw of capFindings(parsed.findings.filter(one => !reReported.has(one)).map(one => checked(one, files)))) {
      const { isVerified } = raw
      // Outside a scoped round's lines (decision 8): a follow-up, unless high or critical, which counts as missed earlier.
      const outside = input.isScoped === true && raw.isOutside === true ? (isMissedEarlier(raw.severity) ? MISSED : OUTSIDE) : ''
      const isBlocking = outside !== OUTSIDE && isBlockingAt(raw, tier)
      // A blocking finding the harness cannot verify is not demoted: a person decides it.
      const status: Finding['status'] = isBlocking ? 'open' : isVerified ? 'deferred' : 'note'
      const route: Route = !isVerified && isBlocking ? 'decision' : outside === OUTSIDE ? 'defer' : raw.route
      const problem = `${outside}${!isVerified && isBlocking ? `${UNVERIFIED}${raw.problem}` : raw.problem}`
      // Already known and still open, or already decided by a person: not a new finding.
      const known = isVerified ? findings.find(one => (one.status === 'open' || one.status === 'resolved') && keyOf(one) === keyOf(raw)) : undefined
      if (known !== undefined) {
        if (known.status === 'open' && !out.stillOpen.includes(known.id)) {
          known.seen = round
          out.stillOpen.push(known.id)
        }
        continue
      }
      const closed = isVerified ? findings.find(one => one.status === 'closed' && keyOf(one) === keyOf(raw)) : undefined
      if (closed !== undefined) {
        Object.assign(closed, { status, isBlocking, severity: raw.severity, line: raw.line, problem, evidence: raw.evidence, route, seen: round })
        out.reappeared.push(closed.id)
        if (status === 'deferred') {
          out.deferred.push(closed)
        }
        continue
      }
      const made: Finding = {
        id: `F${next}`, reviewer: name, severity: raw.severity, file: raw.file, line: raw.line, quote: raw.quote, problem,
        evidence: raw.evidence, isPreExisting: raw.isPreExisting, route, status, isBlocking, round, seen: round, note: null,
      }
      next += 1
      findings.push(made)
      if (status === 'note') {
        out.demoted.push(made.id)
      } else {
        out.added.push(made.id)
      }
      if (!isVerified && isBlocking) {
        out.unverified.push(made.id)
      }
      if (status === 'deferred') {
        out.deferred.push(made)
      }
    }
  }

  return {
    ...out,
    findings,
    isPassing: !findings.some(one => one.status === 'open' && one.isBlocking),
    isStalled: toFix.length > 0 && out.addressed.length === 0,
  }
}

/** Whether a shadow reviewer's answer would have blocked: a verified finding that blocks at the tier. */
export function wouldBlock(parsed: Parsed, tier: Tier, files: Round['files']): boolean {
  return capFindings(parsed.findings.map(one => checked(one, files))).some(raw => raw.isVerified && isBlockingAt(raw, tier))
}

/** The open blocking findings of one reviewer. */
export const openBlocking = (findings: readonly Finding[], reviewer?: string): Finding[] =>
  findings.filter(one => one.status === 'open' && one.isBlocking && (reviewer === undefined || one.reviewer === reviewer))

// ---------------------------------------------------------------- the deferred backlog

/** A finding as the backlog keeps it. */
export const toDeferred = (one: Finding, from: string, at: number): Deferred =>
  ({ key: keyOf(one), file: one.file, quote: one.quote, problem: one.problem, severity: one.severity, from, at, status: 'open' })

/** The backlog with new entries added by key: one already there is kept (and opened again if it had closed). */
export function addToBacklog(list: readonly Deferred[], added: readonly Deferred[]): Deferred[] {
  const out = list.map(one => ({ ...one }))
  for (const one of added) {
    const known = out.find(each => each.key === one.key)
    if (known === undefined) {
      out.push(one)
    } else {
      known.status = 'open'
    }
  }

  return out.slice(-200)
}

/** The backlog with every open entry whose quoted line no longer exists closed. */
export function closeGone(list: readonly Deferred[], files: Readonly<Record<string, string | null>>): Deferred[] {
  return list.map(one => (one.status === 'open' && one.file in files && !isQuotePresent(files[one.file] ?? null, one.quote) ? { ...one, status: 'closed' as const } : one))
}

// ---------------------------------------------------------------- words

/**
 * Why a finding named in a round's header is not in the list handed to the
 * builder, or `to fix` when it is (C1, 11b). Every id the header names is
 * accounted for, so the builder never meets an id it cannot find.
 */
export function accountFor(one: Finding | undefined, toFix: ReadonlySet<string>): string {
  if (one === undefined) {
    return 'no longer on record, nothing to do'
  }
  if (toFix.has(one.id)) {
    return 'to fix'
  }
  if (one.status === 'closed') {
    return 'addressed, nothing to do'
  }
  if (one.status === 'resolved') {
    return 'settled by a person, nothing to do'
  }
  if (one.status === 'note') {
    return 'recorded as a note, not blocking, nothing to do'
  }
  if (one.status === 'deferred') {
    return 'deferred to the backlog, not blocking, nothing to do'
  }
  if (one.status === 'open' && one.route === 'decision') {
    return 'awaits a person\'s decision, not yours'
  }
  if (one.status === 'open' && !one.isBlocking) {
    return 'not blocking at this tier, nothing to do'
  }

  return 'not handed to you this round, nothing to do'
}

/** A round's header: each group of ids, each id with what it means for the builder. */
export function roundHeader(round: number, settled: Pick<Settled, 'addressed' | 'reappeared' | 'stillOpen' | 'added' | 'demoted'>, findings: readonly Finding[], toFix: ReadonlySet<string>): string {
  const byId = new Map(findings.map(one => [one.id, one]))
  const group = (name: string, ids: readonly string[]): string =>
    `${name} ${ids.length === 0 ? 'none' : ids.map(id => `${id} (${accountFor(byId.get(id), toFix)})`).join(', ')}`
  const added = [...settled.added, ...settled.demoted]

  return `Round ${round}: ${[group('addressed', settled.addressed), group('reappeared', settled.reappeared), group('still open', settled.stillOpen), group('new', added)].join('; ')}.`
}

/**
 * What happens after the builder fixes a round's findings, said as it will
 * happen (C1, 11a): the next round starts by itself at the next stop that
 * verifies a moved tree, when `autoReview` is on and the cap allows; else a
 * person starts it, or the loop has ended and a person reads the change.
 */
export function afterFix(isLast: boolean, autoReview: boolean): string {
  if (isLast) {
    return 'The review cap is spent, so no further round will run. Do not keep fixing: tell the person what is still open and stop; a person reads the change.'
  }
  if (!autoReview) {
    return 'Fix these findings and nothing else, then stop. A finding that asks for an edit the person or the repository instructions reserve for a person is not yours: leave it, and say so. Verification runs when you stop; the next review round does not start by itself here ("autoReview" is off), so a person starts it with /devloop review.'
  }

  return 'Fix these findings and nothing else, then stop. A finding that asks for an edit the person or the repository instructions reserve for a person is not yours: leave it, and say so. When you stop, verification runs, and once it passes on the changed tree the next review round starts by itself.'
}

/** One finding as a line of the format. */
export const formatFinding = (one: Finding): string =>
  `${one.id} | ${one.severity} | ${one.file}:${one.line} | ${one.quote} | ${one.problem} | ${one.evidence}${one.isPreExisting ? ' | pre_existing' : ''}${one.route !== 'fix' ? ` | ${one.route}` : ''}`

/** The contract: the third part of every reviewer prompt, the same every round. */
export function contract(): string {
  return `## Contract

Report at most ${FINDINGS_CAP} findings, most severe first, one line each, in exactly this form:

F<n> | <critical|high|medium|low|nit> | <file>:<line> | <the text of that line, copied exactly> | <the problem> | <the evidence that would close it>

Add \`| pre_existing\` when the problem is in code this change did not touch (it never blocks), and a route when it is not a plain fix: \`| decision\` when a person must choose (a trade-off, scope, product behaviour), \`| defer\` when it is real but not for this change.

- The harness checks every quote against the file at that line. A finding whose quote is not there is kept as a note when its severity does not block, and handed to a person when it does: copy the line, do not paraphrase it.
- A FAIL with no finding in this format cannot be acted on, and goes to a person: put every problem in a finding line.
- For each open finding you were given, write \`F<n> | resolved\` when the change now handles it, or report it again with the same F<n> when it does not.
- Which severities block depends on the change's risk; the harness decides the outcome from the findings. Your verdict line is your summary.

Do not report: style, naming or formatting; matters of taste; anything you could not confirm by opening the file; problems in code this change did not touch, unless marked pre_existing; requests for more tests or guards on a property a test already shows in both directions.

Assurance boundary: once a test shows a property in both directions (it holds when it should, and fails when it should not), asking for more guards on that property is a nit at most.

End with exactly one line, and nothing after it: \`VERDICT: PASS\` or \`VERDICT: FAIL\`.`
}

export type PromptFacts = {
  brief: string
  /** REVIEW.md as the base branch has it; null when the base has none. */
  reviewMd: string | null
  spec: string | null
  base: string | null
  diff: string | null
  tier: Tier
  changed: readonly string[]
  checks: readonly string[]
  /** Each check's state on the reviewed tree, one line each (spec §4). */
  tests?: readonly string[]
  round: number
  maxRounds: number
  /** Open findings this reviewer is to re-check. */
  open: readonly Finding[]
  /** The number new findings start from. */
  nextId: number
  /**
   * Round 2 and later (DESIGN 4.16, decision 8): the diff since the tree the
   * previous round read. Null (or absent) is a round that reads the whole
   * change: round 1, or a later one whose delta git could not give.
   */
  delta?: string | null
  /** Changed files git does not track yet: in the diff, but not committed (they may predate the change). */
  untracked?: readonly string[]
}

/** devloop's own files: the harness's policy and records, judged by a person, never the change's code. */
export const HARNESS_FILES = /^(?:devloop\.json|REVIEW\.md|AGENTS\.md|evals\/|\.claude\/|\.devloop\/)/

/** The most of the diff since the last round a scoped prompt carries; past it, the files are named and the whole diff read. */
export const DELTA_CHARS = 60_000

/** What a scoped round (2 and later) is told to do (decision 8). */
export function scopedBrief(round: number): string {
  return [
    `This is round ${round}: it reads the fix, not the whole change again.`,
    'Confirm each open finding below is fixed (`F<n> | resolved`) or still open (report it again with the same F<n>), and review only the lines changed since the last round.',
    'A problem you see outside those lines: report it in the format with `| outside` at the end. It is recorded as a follow-up for the person and does not fail this round, unless its severity is high or critical: then it fails the round, as missed in an earlier round.',
  ].join(' ')
}

/**
 * A reviewer's prompt in three fixed parts, the stable ones first so a
 * cache can keep them: the frozen task and base, the current facts (the
 * diff's path, which carries the round, among them), the contract. Nothing like "look harder at X" is ever passed forward: open
 * findings are listed as facts to re-check, in the format.
 */
export function reviewPrompt(facts: PromptFacts): string {
  const task = [
    '## Task',
    facts.brief,
    facts.reviewMd !== null
      ? `REVIEW.md as the base branch has it (a copy in the working tree is ignored, so a change cannot rewrite its own review):\n\n${facts.reviewMd.trim()}`
      : 'The base branch has no REVIEW.md: use this brief alone.',
    facts.spec === null ? 'There is no spec: this is a small fix; judge the diff on its own terms.' : `The spec is specs/${facts.spec}/SPEC.md and specs/${facts.spec}/features.json.`,
    `The change is measured from base commit ${facts.base ?? 'unknown'}.`,
  ].join('\n\n')
  const blocking = BLOCKS[facts.tier].join(', ')
  const delta = facts.delta ?? null
  const scoped = delta === null
    ? []
    : [
        scopedBrief(facts.round),
        delta.length <= DELTA_CHARS
          ? `The diff since round ${facts.round - 1}, the only lines this round reviews:\n\n\`\`\`diff\n${delta.trimEnd()}\n\`\`\``
          : `The diff since round ${facts.round - 1} is too long to give here (${delta.length} characters): review the hunks of the whole diff that changed since then, in these files: ${[...new Set([...delta.matchAll(/^\+\+\+ b\/(.+)$/gm)].map(one => one[1] ?? ''))].slice(0, 40).join(', ')}.`,
      ]
  const now = [
    '## Current facts',
    ...scoped,
    facts.diff !== null
      ? `The whole diff, untracked files included, is in ${facts.diff}. Read it with the Read tool${delta === null ? '' : ' for context only'}.`
      : 'The harness could not write the diff; read the changed files listed below directly.',
    `Risk tier: ${facts.tier}. At this tier these severities block: ${blocking}.`,
    `Changed files (${facts.changed.length}): ${facts.changed.slice(0, 60).join(', ')}${facts.changed.length > 60 ? ', …' : ''}`,
    ...untrackedLines(facts.changed, facts.untracked ?? []),
    'You run nothing: the harness ran the checks, and their results are below. Judge from the diff, the code and these results.',
    ...(facts.tests === undefined ? [] : [facts.tests.length > 0 ? `Tests on this tree (from the harness):\n${facts.tests.map(one => `  ${one}`).join('\n')}` : 'Tests on this tree: none set.']),
    `This is round ${facts.round} of ${facts.maxRounds}.`,
    facts.open.length > 0
      ? `Open findings to re-check, each by its id:\n${facts.open.map(formatFinding).join('\n')}`
      : 'There are no open findings to re-check.',
    `Number new findings from F${facts.nextId}.`,
  ].join('\n\n')

  return [task, now, contract()].join('\n\n')
}

/**
 * What the reviewer is told about the files that are not the change's code:
 * devloop's own files, and untracked files, which may have sat in the
 * repository before the work began. Neither fails a round on its own.
 */
function untrackedLines(changed: readonly string[], untracked: readonly string[]): string[] {
  const own = changed.filter(one => HARNESS_FILES.test(one))
  const loose = untracked.filter(one => !HARNESS_FILES.test(one))
  return [
    ...(own.length === 0 ? [] : [`devloop's own files (${own.slice(0, 20).join(', ')}${own.length > 20 ? ', …' : ''}) are the harness's policy and records, judged by a person: raise no finding on them.`]),
    ...(loose.length === 0 ? [] : [`Untracked, not committed (${loose.length}): ${loose.slice(0, 30).join(', ')}${loose.length > 30 ? ', …' : ''}. They may predate this change. Raise a finding on one only when committed code uses it, and route a question of whether it belongs in the change to the person (decision), never to the builder.`]),
  ]
}

/** The one second chance a reviewer gets when its answer could not be read: restate, not review again. */
export function restatePrompt(previous: string, why = 'it had no `VERDICT:` line in the format'): string {
  return [
    `Your previous review answer could not be read: ${why}. Do not review again. Restate the same review in the format below, changing nothing of substance. Copy each quoted line exactly as the file has it at the line you cite.`,
    `Your previous answer:\n\n${previous.trim().slice(-12_000)}`,
    contract(),
  ].join('\n\n')
}

/** The one summary a person reads when a review cycle ends (spec §5, rule 11). */
export function cycleSummary(input: { ended: 'pass' | 'cap' | 'stalled'; round: number; cap: number; discarded: number; from: number; findings: readonly Finding[]; tests: readonly string[] }): string {
  const ofCycle = input.findings.filter(one => Number(one.id.replace(/\D/g, '')) >= input.from)
  const fixed = ofCycle.filter(one => one.status === 'closed').map(one => `${one.id} ${one.problem.slice(0, 60)}`)
  const forYou = ofCycle.filter(one => one.status === 'open' && one.route === 'decision').map(one => one.id)
  const head = input.ended === 'pass'
    ? `Review done: passed in round ${input.round} of ${input.cap}.`
    : input.ended === 'cap'
      ? `Review done: all ${input.cap} rounds used and it still fails; a person reads the change.`
      : `Review done: stopped in round ${input.round}, the same findings kept coming back; a person reads the change.`

  return [
    head,
    `Fixed: ${fixed.join(', ') || 'none'}.`,
    `Still open for you: ${forYou.join(', ') || 'none'}.`,
    ...(input.discarded > 0 ? [`${input.discarded} round${input.discarded === 1 ? ' was' : 's were'} discarded because the code changed during review.`] : []),
    `Tests: ${input.tests.length === 0 ? 'none set' : input.tests.join('; ')}`,
  ].join('\n')
}
