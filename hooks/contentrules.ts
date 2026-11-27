// Declarative content rules (C2; DESIGN 11, rea note item 1): a pattern
// checked against the lines an edit tool adds to a file the rule's globs
// match. `note` records a hit, `refuse` refuses the edit, `ratchet` refuses
// an edit that raises the count of unmarked matches in the file and lowers
// the repository's baseline when the count falls. A match is marked, and
// not counted, when `devloop-allow: <rule id> <reason>` is on its line or
// the line above. Pure: no `$`.

import type { ContentRule } from './config'
import { matchesAny } from './rules'

/** The lines `after` has that `before` did not: a multiset difference, so a moved line is not added. */
export function addedLines(before: string, after: string): string[] {
  const left = new Map<string, number>()
  for (const line of before.split('\n')) {
    left.set(line, (left.get(line) ?? 0) + 1)
  }
  const out: string[] = []
  for (const line of after.split('\n')) {
    const n = left.get(line) ?? 0
    if (n > 0) {
      left.set(line, n - 1)
    } else {
      out.push(line)
    }
  }

  return out
}

/** The reason marker that keeps a match on purpose, for one rule. */
export const markerOf = (id: string): RegExp => new RegExp(`devloop-allow:\\s*${id.replace(/[-]/g, '\\-')}\\s+\\S`)

/** Whether a line matches a rule's pattern; a pattern that does not compile matches nothing (config refuses it). */
export function isMatch(rule: Pick<ContentRule, 'pattern'>, line: string): boolean {
  try {
    return new RegExp(rule.pattern).test(line)
  } catch {
    return false
  }
}

/**
 * The matches in a file's text that carry no reason marker on their line or
 * on the line above (a line of its own: a marker trailing another match marks
 * that match only).
 */
export function countUnmarked(rule: Pick<ContentRule, 'id' | 'pattern'>, text: string): number {
  const lines = text.split('\n')
  const marker = markerOf(rule.id)
  const above = (i: number): boolean => i > 0 && marker.test(lines[i - 1] ?? '') && !isMatch(rule, lines[i - 1] ?? '')

  return lines.filter((line, i) => isMatch(rule, line) && !marker.test(line) && !above(i)).length
}

/** The rules whose globs a repository-relative path matches. */
export const rulesFor = (path: string, rules: readonly ContentRule[]): ContentRule[] =>
  rules.filter(rule => matchesAny(path, rule.when))

export type RuleHit = {
  rule: ContentRule
  /** What the rule does with this edit: recorded only, or refused. */
  verdict: 'note' | 'refuse'
  /** The first added line that matched, cut: what the refusal quotes to the builder. The ledger keeps only its fingerprint (C2.1 F8). */
  line: string
  /** Where that line is in the file after the edit, from 1; 0 when no added line matched (a ratchet that fell). */
  lineNo: number
  /** For a ratchet: the file's unmarked count before and after the edit. */
  before?: number
  after?: number
}

/**
 * What the content rules make of one edit to `path`: the text before and
 * after. A `note` or `refuse` rule fires when an added line matches; a
 * ratchet fires when the edit raises the file's unmarked count (and refuses),
 * and reports its counts whenever it applies, so the caller can lower the
 * baseline when the count fell. `skip` holds rule ids switched off (an eval's
 * ablation).
 */
export function judgeContent(path: string, before: string, after: string, rules: readonly ContentRule[], skip: readonly string[] = []): RuleHit[] {
  const out: RuleHit[] = []
  const added = addedLines(before, after)
  const afterLines = after.split('\n')
  const lineNo = (line: string | undefined): number => (line === undefined ? 0 : afterLines.indexOf(line) + 1)
  for (const rule of rulesFor(path, rules)) {
    if (skip.includes(rule.id)) {
      continue
    }
    if (rule.action === 'ratchet') {
      const was = countUnmarked(rule, before)
      const now = countUnmarked(rule, after)
      const line = added.find(one => isMatch(rule, one))
      out.push({ rule, verdict: now > was ? 'refuse' : 'note', line: (line ?? '').trim().slice(0, 160), lineNo: lineNo(line), before: was, after: now })
      continue
    }
    const line = added.find(one => isMatch(rule, one))
    if (line !== undefined) {
      out.push({ rule, verdict: rule.action === 'refuse' ? 'refuse' : 'note', line: line.trim().slice(0, 160), lineNo: lineNo(line) })
    }
  }

  return out
}

/** Whether a hit counts as the rule firing: any note or refuse rule's match; a ratchet only when it refuses. */
export const isFired = (hit: RuleHit): boolean => hit.rule.action !== 'ratchet' || hit.verdict === 'refuse'

/** The refusal text for a content rule that refuses an edit. */
export function contentReason(hit: RuleHit, path: string): string {
  const { rule } = hit
  if (rule.action === 'ratchet') {
    return `devloop.json's ratchet "${rule.id}" (${rule.why}): this edit raises the count of \`${rule.pattern}\` in ${path} from ${hit.before ?? 0} to ${hit.after ?? 0}. A change may lower the count, never raise it. To keep a match on purpose, put \`devloop-allow: ${rule.id} <reason>\` on its line or the line above.`
  }

  return `devloop.json's rule "${rule.id}" refuses this line in ${path} (${rule.why}): ${hit.line}`
}

/** A ratchet's stored baseline: the repository's unmarked count, and the pattern it counted. */
export type Baseline = { count: number; pattern: string; at: number }

/**
 * The baseline after an allowed edit moved one file's count by `delta`: it
 * only ever falls (an observed rise in observe mode is not taken as the new
 * floor).
 */
export const lowered = (baseline: Baseline, delta: number, at: number): Baseline =>
  delta < 0 ? { ...baseline, count: Math.max(0, baseline.count + delta), at } : baseline
