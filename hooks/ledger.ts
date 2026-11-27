// What the harness learns from its own record (C2, DESIGN 4.8): repeated
// failures grouped for /devloop learn, papercuts grouped by subject and
// symptom, rule hit counts and tombstones for /devloop prune, and the cost
// meter that attributes the session's cost estimate by delta. Pure: no `$`.

import { digest, normalizeOutput } from './output'
import { firstLine } from './records'

/** One ledger entry, as state.ts keeps it: time, kind, key, and a short detail (a failure's first lines). */
export type Entry = { at: number; kind: string; key: string; detail: string; count?: number; auto?: true }

/** How many occurrences an entry stands for: one, or an automatic lesson's count (DESIGN 4.17). */
export const weightOf = (entry: Entry): number => (typeof entry.count === 'number' && entry.count > 1 ? Math.floor(entry.count) : 1)

// ---------------------------------------------------------------- learn

/** A group of repeated failures, with the rule id a fix would be known by. */
export type Group = {
  key: string
  /** What /devloop prune and tombstones call it: a guard's rule, a content rule's id, or the group key. */
  ruleKey: string
  label: string
  count: number
  first: number
  last: number
  /** The first line of the last occurrence's detail. */
  sample: string
  /** The cheapest rung of the ladder that fits this kind of failure. */
  rung: string
  /** A tombstone was set for it, and it has failed again since. */
  recurredAfter: number | null
}

export type Tombstone = { id: string; evidence: string; at: number }

/** Which group a ledger entry belongs to, or null for kinds learn does not group. */
export function groupOf(entry: Entry): { key: string; ruleKey: string; label: string; rung: string } | null {
  switch (entry.kind) {
    case 'guard-deny':
    case 'guard-observe':
      return { key: `refusal:${entry.key}`, ruleKey: entry.key, label: `refused by ${entry.key}`, rung: 'the rule already holds: an instruction line or a skill that names the allowed way, or a content rule that catches the attempt earlier' }
    case 'content-rule':
      return { key: `content:${entry.key}`, ruleKey: entry.key, label: `content rule ${entry.key} fired`, rung: 'the content rule already holds: an instruction line naming the allowed form' }
    case 'verify-fail':
    case 'check-infra':
      return { key: `check:${entry.key}`, ruleKey: `check:${entry.key}`, label: `check failed: ${entry.key}`, rung: 'a content rule, lint rule or test that catches it before the check' }
    case 'feature-fail':
      return { key: `feature:${entry.key}`, ruleKey: `feature:${entry.key}`, label: `feature check failed: ${entry.key}`, rung: 'a test or content rule that fails sooner' }
    case 'finding': {
      const file = entry.key.split(':').slice(2).join(':')

      return { key: `finding:${file}`, ruleKey: `finding:${file}`, label: `review findings in ${file || '(no file)'}`, rung: 'a path-scoped rule in .claude/rules/ for that file\'s area, or a content rule' }
    }
    case 'papercut':
      return { key: `papercut:${entry.key}`, ruleKey: `papercut:${entry.key}`, label: `papercut ${entry.key}`, rung: 'fix the tool, check or instruction it names; failing that, one instruction line' }
    case 'lesson':
      return { key: `lesson:${entry.key}`, ruleKey: `lesson:${entry.key}`, label: `lesson: ${entry.key}`, rung: 'a content rule or test if it can be checked; else one instruction line' }
    default:
      return null
  }
}

/**
 * Groups the ledger's repeated failures (`least` or more, two by default),
 * most frequent first. A group whose rule was tombstoned is left out unless
 * it failed again after the tombstone's date; then it is kept and says so.
 */
export function learnGroups(entries: readonly Entry[], tombstones: readonly Tombstone[] = [], least = 2): Group[] {
  const groups = new Map<string, Group>()
  for (const entry of entries) {
    const one = groupOf(entry)
    if (one === null) {
      continue
    }
    const known = groups.get(one.key)
    groups.set(one.key, known === undefined
      ? { ...one, label: `${entry.kind}: ${entry.key}`, count: weightOf(entry), first: entry.at, last: entry.at, sample: firstLine(entry.detail, 160), recurredAfter: null }
      : { ...known, count: known.count + weightOf(entry), last: Math.max(known.last, entry.at), sample: entry.at >= known.last ? firstLine(entry.detail, 160) : known.sample })
  }
  const out: Group[] = []
  for (const group of groups.values()) {
    if (group.count < least) {
      continue
    }
    const stone = tombstones.filter(one => one.id === group.ruleKey || one.id === group.key).sort((a, b) => b.at - a.at)[0]
    if (stone !== undefined) {
      const after = entries.filter(entry => groupOf(entry)?.key === group.key && entry.at > stone.at)
      if (after.length === 0) {
        continue
      }
      out.push({ ...group, recurredAfter: stone.at })
      continue
    }
    out.push(group)
  }

  return out.sort((a, b) => b.count - a.count || b.last - a.last || a.key.localeCompare(b.key))
}

/** The instruction the model gets with /devloop learn: the ladder, an eval task per proposal, proposals only. */
export const LEARN_LADDER = 'For each repeated failure above, propose the cheapest durable fix, in this order: (1) a content rule in devloop.json ("rules": [{ "id", "when", "pattern", "action": "note" | "refuse" | "ratchet", "why" }]), a lint rule, a test or a hook, when it must hold every time; (2) a path-scoped rule in .claude/rules/ when it is local to some files; (3) one line in the instruction file when it is a fact the code cannot say; (4) a skill when it is a procedure. Each proposal must name the eval task (evals/tasks/<id>.json: prompt, check, and an "expect" where the trajectory matters) that would prove the rule works and let /devloop prune remove it later. These files are protected: present the proposals to the person and wait; do not edit them.'

// ---------------------------------------------------------------- papercuts

/** One papercut as stored (the papercut@1 record). */
export type Papercut = {
  schema: 'papercut@1'
  id: string
  at: number
  group: string
  subject: string | null
  tried: string
  expected: string
  happened: string
  suggestedFix: string
  actor: { kind: 'person' | 'builder' | 'agent' | 'harness'; name: string | null }
}

export type PapercutClose = { group: string; at: number; note: string }

/** The group a papercut belongs to: its subject and a fingerprint of what happened (numbers, paths' lines, hex and times normalised). */
export const papercutGroup = (subject: string | null, happened: string): string =>
  `p-${digest(`${(subject ?? '').trim().toLowerCase()}\n${normalizeOutput(happened.trim().toLowerCase())}`).slice(0, 6)}`

export type PapercutGroup = {
  group: string
  subject: string | null
  count: number
  last: number
  happened: string
  suggestedFix: string
  /** The person's close, if any. */
  closed: PapercutClose | null
  /** Filed again after a person closed it. */
  isRegression: boolean
  /** Filed since the close (all of them when never closed). */
  since: number
}

/** Papercuts grouped, the most filed first; a group filed again after its close is a regression. */
export function papercutGroups(list: readonly Papercut[], closes: readonly PapercutClose[]): PapercutGroup[] {
  const groups = new Map<string, Papercut[]>()
  for (const one of list) {
    groups.set(one.group, [...(groups.get(one.group) ?? []), one])
  }

  return [...groups].map(([group, items]): PapercutGroup => {
    const last = items.reduce((a, b) => (b.at >= a.at ? b : a))
    const closed = closes.filter(one => one.group === group).sort((a, b) => b.at - a.at)[0] ?? null
    const since = closed === null ? items.length : items.filter(one => one.at > closed.at).length

    return { group, subject: last.subject, count: items.length, last: last.at, happened: last.happened, suggestedFix: last.suggestedFix, closed, isRegression: closed !== null && since > 0, since }
  }).sort((a, b) => Number(b.isRegression) - Number(a.isRegression) || b.count - a.count || b.last - a.last)
}

/** Papercuts filed per turn before the tool says no more. */
export const PAPERCUTS_PER_TURN = 3

// ---------------------------------------------------------------- rule hits and prune

/** How often a rule fired and when it last did, by rule id (a guard's name, or a content rule's id). */
export type Hits = Record<string, { hits: number; last: number }>

export const hit = (hits: Hits, id: string, at: number): Hits => ({ ...hits, [id]: { hits: (hits[id]?.hits ?? 0) + 1, last: Math.max(at, hits[id]?.last ?? 0) } })

export type PruneRule = { id: string; kind: 'built-in' | 'content' | 'instruction'; note?: string }

/** One ablation's evidence, as kept for prune. */
export type AblationEvidence = { target: string; at: number; effect: 'none' | 'helps' | 'hurts'; baseline: [number, number]; without: number; noise: number; total: number }

const DAY = 24 * 60 * 60 * 1000

const ago = (now: number, at: number): string => {
  const days = Math.floor((now - at) / DAY)

  return days <= 0 ? 'today' : days === 1 ? 'a day ago' : `${days} days ago`
}

/**
 * What /devloop prune shows: per rule its hits and last firing, the rules
 * that never fired in the window, the eval evidence where there is any, the
 * tasks outside the useful band, and the tombstones.
 */
export function pruneReport(input: {
  rules: readonly PruneRule[]
  hits: Hits
  now: number
  windowDays: number
  ablations: readonly AblationEvidence[]
  band: readonly { task: string; why: 'saturated' | 'too-hard' }[]
  tombstones: readonly Tombstone[]
}): string[] {
  const { rules, hits, now, windowDays } = input
  const since = now - windowDays * DAY
  const lines = ['Rules, with their hits and when each last fired:']
  for (const rule of rules) {
    const one = hits[rule.id]
    const evidence = input.ablations.filter(each => each.target === rule.id).sort((a, b) => b.at - a.at)[0]
    lines.push(`  ${rule.kind.padEnd(11)} ${rule.id}: ${one === undefined ? 'never fired' : `${one.hits} hit${one.hits === 1 ? '' : 's'}, last ${ago(now, one.last)}`}${rule.note === undefined ? '' : ` (${rule.note})`}${evidence === undefined ? '' : `; eval evidence: ${effectWords(evidence)}`}`)
  }
  const quiet = rules.filter(rule => rule.kind !== 'instruction' && (hits[rule.id] === undefined || hits[rule.id]!.last < since))
  lines.push(quiet.length > 0 ? `Never fired in the last ${windowDays} days (candidates, if an eval shows no measurable effect): ${quiet.map(rule => rule.id).join(', ')}` : `Every rule fired in the last ${windowDays} days.`)
  lines.push(input.ablations.length > 0 ? 'Eval evidence (ablation):' : 'No ablation on record: /devloop eval --without <rule id | file | skill> measures one.')
  for (const one of [...input.ablations].sort((a, b) => b.at - a.at).slice(0, 8)) {
    lines.push(`  ${one.target}: ${effectWords(one)}`)
  }
  if (input.band.length > 0) {
    lines.push(`Eval tasks outside the useful band: ${input.band.map(one => `${one.task} (${one.why === 'saturated' ? 'passes every trial: make it harder or retire it' : 'fails every trial: too hard or broken'})`).join(', ')}`)
  }
  if (input.tombstones.length > 0) {
    lines.push(`Tombstones (learn does not propose these again unless the failure returns): ${input.tombstones.map(one => `${one.id} (${new Date(one.at).toISOString().slice(0, 10)}: ${one.evidence})`).join('; ')}`)
  }

  return lines
}

/** An ablation's result in words. */
export function effectWords(one: AblationEvidence): string {
  const base = `baseline ${one.baseline[0]} and ${one.baseline[1]} of ${one.total}, without it ${one.without}, noise band ${one.noise}`

  return one.effect === 'none'
    ? `no measurable effect (${base})`
    : one.effect === 'helps'
      ? `fewer tasks pass without it: it earns its place (${base})`
      : `more tasks pass without it (${base})`
}

// ---------------------------------------------------------------- cost by delta

/** The cost meter: the session's cost estimate sampled at units of work, the differences attributed. An estimate throughout. */
export type Costs = {
  last: { sessionId: string | null; usd: number } | null
  open: { fixRound: number | null; reviewRound: number | null; skill: string | null; skillErred: boolean }
  /** Spent since the last feature check, attributed to the next feature checked. */
  pending: number
  change: number
  features: Record<string, number>
  fixRounds: Record<string, number>
  reviewRounds: Record<string, number>
  skills: Record<string, { uses: number; errorsAfter: number; usd: number }>
}

export const EMPTY_COSTS: Costs = { last: null, open: { fixRound: null, reviewRound: null, skill: null, skillErred: false }, pending: 0, change: 0, features: {}, fixRounds: {}, reviewRounds: {}, skills: {} }

export type CostEvent =
  | { kind: 'sample' }
  | { kind: 'feature'; id: string }
  | { kind: 'fix-round'; round: number }
  | { kind: 'stop' }
  | { kind: 'review-start'; round: number }
  | { kind: 'review-end' }
  | { kind: 'skill'; name: string }
  | { kind: 'prompt' }
  | { kind: 'error' }
  | { kind: 'change-closed' }

const add = (record: Record<string, number>, key: string, usd: number): Record<string, number> => ({ ...record, [key]: (record[key] ?? 0) + usd })

/**
 * One step of the meter: the difference since the last sample (same
 * session, never negative) goes to the change and to every unit open, then
 * the event opens or closes units. A sample from another session restarts
 * the difference (the engine's estimate is per session).
 */
export function costStep(state: Costs, sample: { sessionId: string | null; usd: number } | null, event: CostEvent): Costs {
  let next = state
  if (sample !== null) {
    const delta = state.last !== null && state.last.sessionId === sample.sessionId && sample.usd >= state.last.usd ? sample.usd - state.last.usd : 0
    if (delta > 0) {
      const { open } = state
      next = {
        ...next,
        change: next.change + delta,
        pending: next.pending + delta,
        fixRounds: open.fixRound === null ? next.fixRounds : add(next.fixRounds, String(open.fixRound), delta),
        reviewRounds: open.reviewRound === null ? next.reviewRounds : add(next.reviewRounds, String(open.reviewRound), delta),
        skills: open.skill === null ? next.skills : { ...next.skills, [open.skill]: { ...(next.skills[open.skill] ?? { uses: 0, errorsAfter: 0, usd: 0 }), usd: (next.skills[open.skill]?.usd ?? 0) + delta } },
      }
    }
    next = { ...next, last: sample }
  }
  switch (event.kind) {
    case 'feature':
      return { ...next, features: add(next.features, event.id, next.pending), pending: 0 }
    case 'fix-round':
      return { ...next, open: { ...next.open, fixRound: event.round } }
    case 'stop':
      return { ...next, open: { ...next.open, fixRound: null } }
    case 'review-start':
      return { ...next, open: { ...next.open, reviewRound: event.round } }
    case 'review-end':
      return { ...next, open: { ...next.open, reviewRound: null } }
    case 'skill': {
      const was = next.skills[event.name] ?? { uses: 0, errorsAfter: 0, usd: 0 }

      return { ...next, skills: { ...next.skills, [event.name]: { ...was, uses: was.uses + 1 } }, open: { ...next.open, skill: event.name, skillErred: false } }
    }
    case 'prompt':
      return { ...next, open: { ...next.open, skill: null, skillErred: false } }
    case 'error': {
      const name = next.open.skill
      if (name === null || next.open.skillErred) {
        return next
      }
      const was = next.skills[name] ?? { uses: 0, errorsAfter: 0, usd: 0 }

      return { ...next, skills: { ...next.skills, [name]: { ...was, errorsAfter: was.errorsAfter + 1 } }, open: { ...next.open, skillErred: true } }
    }
    case 'change-closed':
      return { ...next, change: 0, pending: 0, features: {}, fixRounds: {}, reviewRounds: {}, open: { ...next.open, fixRound: null, reviewRound: null } }
    default:
      return next
  }
}

/** The meter in words, always labelled an estimate. */
export function costReport(costs: Costs): string[] {
  const usd = (n: number): string => `$${n.toFixed(2)}`
  const top = (record: Record<string, number>): string => Object.entries(record).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([key, n]) => `${key} ${usd(n)}`).join(', ')
  const skills = Object.entries(costs.skills).sort((a, b) => b[1].uses - a[1].uses)

  return [
    `  cost of this change so far: about ${usd(costs.change)} (an estimate, by delta of the session's estimate)`,
    Object.keys(costs.features).length > 0 ? `    per feature (estimate): ${top(costs.features)}` : '',
    Object.keys(costs.fixRounds).length > 0 ? `    per fix round (estimate): ${top(costs.fixRounds)}` : '',
    Object.keys(costs.reviewRounds).length > 0 ? `    per review round (estimate): ${top(costs.reviewRounds)}` : '',
    skills.length > 0 ? `  skills: ${skills.slice(0, 8).map(([name, one]) => `${name} used ${one.uses}x, errors after use ${one.errorsAfter}, about ${usd(one.usd)}`).join('; ')} (cost an estimate)` : '',
  ].filter(line => line !== '')
}
