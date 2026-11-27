// Checklists (D2, docs/design-notes/checklists.md, folded into DESIGN 4.13):
// short lists of checkable statements about a kind of change (a login form,
// a migration), kept in `checklists/<id>.json` on the base branch. They seed a
// spec's acceptance criteria, and a shadow reviewer answers them item by
// item; an item blocks only once a person promotes it on its own numbers.
// The format, selection, accounting, routing, answers and metrics are pure
// here; hooks/checklists.ts does the work. Pure: no `$`.

import { isQuoteAt } from './findings'
import { validate } from './records'
import { matchesAny } from './rules'
import type { Feature } from './spec'

/** How an item is verified: `pattern` and `check` in code, `review` by a reviewer agent, `runtime` and `person` by the approver. */
export type VerifyBy = 'pattern' | 'check' | 'review' | 'runtime' | 'person'

export type ChecklistItem = {
  id: string
  statement: string
  why: string
  severity: 'critical' | 'high' | 'medium' | 'low'
  verify: {
    by: VerifyBy
    /** Where to look and what counts as evidence; for `check`, the test it stands for; for `person`, what to look at. */
    how: string
    /** For `pattern`: the regular expression the harness runs over the changed files, and whether it must be present or absent. */
    pattern?: string
    expect?: 'present' | 'absent'
    /** For `check`: the command the harness runs (judged by the command rules, scrubbed by checkEnv). */
    check?: string
  }
  naWhen?: string[]
  ref?: string
  status?: 'active' | 'retired'
}

export type Checklist = {
  schema: 'checklist@1'
  id: string
  version: number
  title: string
  appliesTo: { surfaces?: string[]; paths?: string[]; detect?: string }
  maxItems: number
  items: ChecklistItem[]
}

/** The most items any list may hold active: a list is a reminder of the critical steps, not an inventory. */
export const MAX_ITEMS_CAP = 15

/** `<list>/<item>`, how every result, accounting line and command names an item. */
export const itemRef = (list: string, item: string): string => `${list}/${item}`

const isRegex = (pattern: string): boolean => {
  try {
    new RegExp(pattern)

    return true
  } catch {
    return false
  }
}

/**
 * Reads one checklist file strictly (its schema, then what a schema cannot
 * say): the id is the file's name, item ids are unique, patterns compile, a
 * `pattern` item has its pattern and a `check` item its command, and the
 * active items are no more than `maxItems` (itself at most 15). A list that
 * fails any of it does not load, and every problem is named.
 */
export function parseChecklist(text: string, fileName: string): { list: Checklist | null; problems: string[] } {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch (error) {
    return { list: null, problems: [`${fileName}: not valid JSON (${error instanceof Error ? error.message : 'unreadable'})`] }
  }
  const problems = validate('checklist@1', raw).map(one => `${fileName}: ${one}`)
  if (problems.length > 0) {
    return { list: null, problems }
  }
  const list = raw as Checklist
  const name = fileName.replace(/^.*\//, '').replace(/\.json$/, '')
  if (list.id !== name) {
    problems.push(`${fileName}: its id "${list.id}" is not its file's name ("${name}")`)
  }
  const ids = list.items.map(one => one.id)
  const twice = [...new Set(ids.filter((id, i) => ids.indexOf(id) !== i))]
  if (twice.length > 0) {
    problems.push(`${fileName}: item ids used twice: ${twice.join(', ')}`)
  }
  if (list.appliesTo.detect !== undefined && !isRegex(list.appliesTo.detect)) {
    problems.push(`${fileName}: appliesTo.detect is not a valid regular expression`)
  }
  for (const one of list.items) {
    if (one.verify.by === 'pattern' && (one.verify.pattern === undefined || !isRegex(one.verify.pattern))) {
      problems.push(`${fileName}: item ${one.id} is verified by pattern but has no valid verify.pattern`)
    }
    if (one.verify.by === 'check' && (one.verify.check === undefined || one.verify.check.trim() === '')) {
      problems.push(`${fileName}: item ${one.id} is verified by check but names no verify.check command`)
    }
  }
  const active = list.items.filter(one => one.status !== 'retired').length
  if (list.maxItems > MAX_ITEMS_CAP) {
    problems.push(`${fileName}: maxItems is ${list.maxItems}, over the cap of ${MAX_ITEMS_CAP}`)
  }
  if (active > list.maxItems) {
    problems.push(`${fileName}: ${active} active items, over its maxItems of ${list.maxItems}: retire one before adding one`)
  }

  return problems.length > 0 ? { list: null, problems } : { list, problems: [] }
}

/** The active items of a list. */
export const activeItems = (list: Checklist): ChecklistItem[] => list.items.filter(one => one.status !== 'retired')

/** The `- item` lines that start a block, up to the first line that is not one. */
function listRun(lines: readonly string[]): string[] {
  const end = lines.findIndex(line => !/^\s*-\s/.test(line))

  return [...(end < 0 ? lines : lines.slice(0, end))]
}

/** The surfaces a spec declares in SPEC.md's front matter: `surfaces: [login, settings]`, or a list under `surfaces:`. */
export function surfacesOf(specText: string): string[] {
  const lines = specText.replace(/\r\n/g, '\n').split('\n')
  if (lines[0]?.trim() !== '---') {
    return []
  }
  const end = lines.findIndex((line, i) => i > 0 && line.trim() === '---')
  const front = end < 0 ? [] : lines.slice(1, end)
  const at = front.findIndex(line => /^surfaces:/.test(line))
  if (at < 0) {
    return []
  }
  const inline = /^surfaces:\s*\[(.*)\]\s*$/.exec(front[at] ?? '')
  const words = inline !== null
    ? (inline[1] ?? '').split(',')
    : listRun(front.slice(at + 1)).map(line => line.replace(/^\s*-\s*/, ''))

  return words.map(one => one.trim().replace(/^["']|["']$/g, '')).filter(one => /^[a-z0-9][a-z0-9-]{0,40}$/.test(one))
}

/** What selection reads of a change: its changed files, the lines it adds, and the surfaces its spec declares. */
export type Selection = { changed: readonly string[]; added: string; surfaces: readonly string[] }

/** Why a checklist applies: a surface the spec declares, a changed path its globs match, or its `detect` pattern in an added line. Null when it does not. */
export function appliesBecause(list: Checklist, facts: Selection): string | null {
  const surface = (list.appliesTo.surfaces ?? []).find(one => facts.surfaces.includes(one))
  if (surface !== undefined) {
    return `the spec declares the surface "${surface}"`
  }
  const path = facts.changed.find(file => matchesAny(file, list.appliesTo.paths ?? []))
  if (path !== undefined) {
    return `${path} matches its paths`
  }
  const detect = list.appliesTo.detect
  if (detect !== undefined && facts.added.split('\n').some(line => new RegExp(detect).test(line))) {
    return 'its detect pattern is in an added line'
  }

  return null
}

/** The checklists that apply to a change. */
export const selectLists = (lists: readonly Checklist[], facts: Selection): Checklist[] => lists.filter(one => appliesBecause(one, facts) !== null)

/** The candidate acceptance criteria a spec is offered: every active item of the lists that apply, the most severe first. */
export function candidates(lists: readonly Checklist[]): { ref: string; item: ChecklistItem; list: Checklist }[] {
  const rank = { critical: 0, high: 1, medium: 2, low: 3 }

  return lists.flatMap(list => activeItems(list).map(item => ({ ref: itemRef(list.id, item.id), item, list }))).sort((a, b) => rank[a.item.severity] - rank[b.item.severity])
}

/** The spec context's offer: each candidate with how it is verified, and how to keep, strike or hand it to a person. */
export function candidateText(lists: readonly Checklist[]): string | null {
  const found = candidates(lists)
  if (found.length === 0) {
    return null
  }

  return [
    `Checklist items that apply to this spec (${lists.map(one => one.title).join(', ')}), offered as candidate acceptance criteria. Approval is refused until each is accounted for: keep it (a feature whose "checklist" names it, with a check that proves it), mark it under a "## Judged by a person" heading in SPEC.md (\`- <list>/<item>: what to look at\`), or strike it under a "## Not applicable" heading with a reason (\`- <list>/<item>: why not\`).`,
    ...found.slice(0, 40).map(one => `- ${one.ref} (${one.item.severity}, verified by ${one.item.verify.by}): ${one.item.statement}`),
  ].join('\n')
}

/** The `<list>/<item>` lines under a SPEC.md heading that matches, with the text after each. */
function listedUnder(specText: string, heading: RegExp): { ref: string; note: string }[] {
  const out: { ref: string; note: string }[] = []
  let isIn = false
  for (const line of specText.split('\n')) {
    if (/^\s{0,3}#/.test(line)) {
      isIn = heading.test(line.replace(/^\s{0,3}#+\s*/, ''))
      continue
    }
    const item = isIn ? /^\s*[-*]\s+`?([a-z0-9][a-z0-9-]*\/[A-Za-z0-9_.-]+)`?\s*[:—–-]?\s*(.*)$/.exec(line) : null
    if (item !== null) {
      out.push({ ref: item[1] ?? '', note: (item[2] ?? '').trim() })
    }
  }

  return out
}

/** How the person accounted for the candidate items: kept, for a person, struck; and what is not accounted for, which refuses approval. */
export type Accounting = {
  kept: string[]
  person: string[]
  struck: string[]
  unaccounted: string[]
  noReason: string[]
  /** Listed as judged by a person, though the harness verifies the item itself (its route is a pattern or a check): refused (final round, D2 F11). */
  notPerson: string[]
}

/**
 * Accounts for each candidate at approval: kept when a feature's
 * `checklist` (or `criteria`) names it, judged by a person when SPEC.md lists
 * it under "Judged by a person", struck when it is listed under "Not
 * applicable" with a reason. A struck item with no reason, one not named
 * anywhere, and one listed as judged by a person whose route (`routes`) is a
 * pattern or a check the harness runs itself, are unaccounted for.
 */
export function account(refs: readonly string[], features: readonly Feature[], specText: string, routes: Readonly<Record<string, VerifyBy>> = {}): Accounting {
  const named = new Set(features.flatMap(one => one.checklist))
  const person = listedUnder(specText, /^judged by a person\b/i)
  const struck = listedUnder(specText, /^not applicable\b/i)
  const out: Accounting = { kept: [], person: [], struck: [], unaccounted: [], noReason: [], notPerson: [] }
  for (const ref of refs) {
    const isStruck = struck.find(one => one.ref === ref)
    const route = routes[ref]
    if (named.has(ref)) {
      out.kept.push(ref)
    } else if (person.some(one => one.ref === ref) && (route === 'pattern' || route === 'check')) {
      // The harness verifies it in code: a person's judgment does not stand in for that (final round, D2 F11).
      out.notPerson.push(ref)
      out.unaccounted.push(ref)
    } else if (person.some(one => one.ref === ref)) {
      out.person.push(ref)
    } else if (isStruck !== undefined && isStruck.note.replace(/[^A-Za-z]/g, '').length >= 3) {
      out.struck.push(ref)
    } else if (isStruck !== undefined) {
      out.noReason.push(ref)
      out.unaccounted.push(ref)
    } else {
      out.unaccounted.push(ref)
    }
  }

  return out
}

// ---------------------------------------------------------------- results

export type ChecklistStatus = 'pass' | 'fail' | 'na' | 'unverified'

/** One item's result on one tree: a `checklist-result@1` record. */
export type ChecklistResult = {
  schema: 'checklist-result@1'
  at: number
  list: string
  version: number
  item: string
  by: VerifyBy
  status: ChecklistStatus
  /** A quoted line at `file:line`, the pattern's finding, the command's exit, or the reason. Never the word "good". */
  evidence: string
  tree: string | null
  round: number
  source: 'harness' | 'reviewer'
}

/**
 * A `pattern` item evaluated in code over the changed files' text: the
 * pattern present or absent, against what the item expects. It reports
 * presence, never quality.
 */
export function evaluatePattern(item: ChecklistItem, files: readonly { path: string; text: string }[]): { status: ChecklistStatus; evidence: string } {
  const pattern = new RegExp(item.verify.pattern ?? '(?!)')
  let found: { path: string; line: number } | null = null
  for (const one of files) {
    const at = one.text.split('\n').findIndex(line => pattern.test(line))
    if (at >= 0) {
      found = { path: one.path, line: at + 1 }
      break
    }
  }
  const wanted = item.verify.expect ?? 'present'
  const isPresent = found !== null
  const where = found === null ? `absent from the ${files.length} changed file${files.length === 1 ? '' : 's'} read` : `present at ${found.path}:${found.line}`

  return { status: isPresent === (wanted === 'present') ? 'pass' : 'fail', evidence: `${where} (expected ${wanted}; a pattern says present or absent, never good)` }
}

/** The reviewer's brief for the checklist items routed to it: one answer per item, each with checked evidence. */
export function checklistPrompt(input: { items: readonly { ref: string; item: ChecklistItem }[]; diff: string | null; base: string | null; spec: string | null; round: number }): string {
  return [
    'You are the checklist reviewer: you answer a fixed list of statements about a change you did not write. You are read-only: report, never fix.',
    `The change's whole diff is in ${input.diff ?? '(no diff file could be written: read the changed files)'}, against base ${input.base ?? 'unknown'}${input.spec === null ? '' : `; its spec is specs/${input.spec}/`}. This is review round ${input.round}.`,
    'Answer every item below exactly once, one line each, in this format and nothing else on the line:',
    'C | <list>/<item> | pass|fail|not applicable|unverified | <file>:<line> or - | <the quoted line, or -> | <reason>',
    '- pass and fail need evidence: the exact text of one line at file:line in the changed tree (the harness checks it is there). A fail without a quoted line that is there is not accepted.',
    '- not applicable needs the reason it does not apply (the item\'s own "not applicable when" reasons, or a line of the spec that struck it).',
    '- unverified is allowed and honest: say what would settle it (the app running, a person looking, more context). Never guess pass.',
    '- A pass means the statement holds as written, from the code; presence is not proof of quality, so say what you saw.',
    '',
    'The items:',
    ...input.items.map(one => `- ${one.ref} (${one.item.severity}): ${one.item.statement}\n  Why: ${one.item.why}\n  How to check: ${one.item.verify.how}${(one.item.naWhen ?? []).length > 0 ? `\n  Not applicable when: ${(one.item.naWhen ?? []).join('; ')}` : ''}`),
  ].join('\n')
}

/** One answer line as the reviewer wrote it. */
export type ItemAnswer = { ref: string; status: ChecklistStatus; file: string | null; line: number | null; quote: string; reason: string }

const STATUS: Record<string, ChecklistStatus> = { pass: 'pass', fail: 'fail', 'not applicable': 'na', na: 'na', 'n/a': 'na', unverified: 'unverified' }

/**
 * Reads the reviewer's answer against the items it was sent: one line per
 * item, each read; an item unanswered or answered twice, an unknown status,
 * or a `fail` with no `file:line` and quote is a problem (a format failure,
 * restated once, then a person).
 */
export function parseItemAnswers(text: string, sent: readonly string[]): { answers: ItemAnswer[]; problems: string[] } {
  const answers: ItemAnswer[] = []
  const problems: string[] = []
  for (const raw of text.split('\n')) {
    const line = raw.trim().replace(/^[-*>`\s]+/, '').replace(/`+$/, '')
    if (!/^C\s*\|/.test(line)) {
      continue
    }
    const parts = line.split('|').map(one => one.trim())
    const ref = (parts[1] ?? '').replace(/@\d+(?=\/|$)/, '')
    const status = STATUS[(parts[2] ?? '').toLowerCase()]
    if (!sent.includes(ref)) {
      problems.push(`an answer names an item it was not sent: ${ref || '(none)'}`)
      continue
    }
    if (status === undefined) {
      problems.push(`${ref}: "${parts[2] ?? ''}" is not pass, fail, not applicable or unverified`)
      continue
    }
    if (answers.some(one => one.ref === ref)) {
      problems.push(`${ref} is answered twice`)
      continue
    }
    const place = /^(.+?):(\d+)$/.exec(parts[3] ?? '')
    const quote = parts.length > 6 ? parts.slice(4, -1).join('|').trim() : (parts[4] ?? '').trim()
    const reason = parts.length > 5 ? (parts[parts.length - 1] ?? '').trim() : ''
    answers.push({ ref, status, file: place === null ? null : (place[1] ?? '').replace(/^`|`$/g, ''), line: place === null ? null : Number(place[2]), quote: quote === '-' ? '' : quote.replace(/^"|"$/g, ''), reason })
  }
  for (const ref of sent) {
    if (!answers.some(one => one.ref === ref) && !problems.some(one => one.startsWith(ref))) {
      problems.push(`${ref} is not answered`)
    }
  }

  return { answers, problems }
}

/**
 * Checks each answer's quote against the changed tree (as a finding's is):
 * a `fail` whose quote is not at its line is a format failure; a `pass` whose
 * quote is not there is only `unverified` (its evidence did not hold).
 */
export function checkQuotes(answers: readonly ItemAnswer[], files: Readonly<Record<string, string | null>>): { answers: ItemAnswer[]; problems: string[] } {
  const problems: string[] = []
  const out = answers.map(one => {
    if (one.status !== 'pass' && one.status !== 'fail') {
      return one
    }
    const isThere = one.file !== null && one.line !== null && isQuoteAt(files[one.file] ?? null, one.line, one.quote)
    if (isThere) {
      return one
    }
    if (one.status === 'fail') {
      problems.push(`${one.ref}: the quoted line is not at ${one.file ?? '?'}:${one.line ?? '?'}`)

      return one
    }

    return { ...one, status: 'unverified' as const, reason: `the quote given for a pass is not at ${one.file ?? '?'}:${one.line ?? '?'}; ${one.reason}` }
  })

  return { answers: out, problems }
}

/** The restatement prompt for an answer that could not be read: what was wrong, and the format again. */
export const restateItemsPrompt = (answer: string, problems: readonly string[], prompt: string): string =>
  `Your checklist answer could not be accepted: ${problems.slice(0, 6).join('; ')}. Answer again, every item exactly once, in the format below. Your earlier answer is at the end for reference.\n\n${prompt}\n\nYour earlier answer:\n${answer.slice(0, 6000)}`

// ---------------------------------------------------------------- promotion, per item

/** A person's judgment of an item's result: it was right, or it was wrong. */
export type Adjudication = { item: string; verdict: 'correct' | 'wrong'; at: number; tree: string | null }

/** The numbers an item is promoted on (checklists note 5): what it said in shadow, what a person confirmed, recall on seeded defects, stability on one tree. */
export type ItemMetrics = {
  item: string
  results: number
  fails: number
  unverified: number
  na: number
  adjudicated: { correct: number; wrong: number }
  /** Eval tasks tagged with the item that plant its defect: how many of their counted trials found it (the task passes when the item fails). */
  recall: { found: number; seeded: number } | null
  /** Trees with two or more results for the item, and how many gave the same answer every time. */
  stability: { same: number; trees: number }
  isPromoted: boolean
}

/** The per-item numbers from the records. */
export function itemMetrics(item: string, results: readonly ChecklistResult[], adjudications: readonly Adjudication[], seeded: { found: number; seeded: number } | null, isPromoted: boolean): ItemMetrics {
  const mine = results.filter(one => itemRef(one.list, one.item) === item)
  const byTree = new Map<string, ChecklistStatus[]>()
  for (const one of mine.filter(each => each.tree !== null)) {
    byTree.set(one.tree ?? '', [...(byTree.get(one.tree ?? '') ?? []), one.status])
  }
  const repeated = [...byTree.values()].filter(one => one.length >= 2)

  return {
    item,
    results: mine.length,
    fails: mine.filter(one => one.status === 'fail').length,
    unverified: mine.filter(one => one.status === 'unverified').length,
    na: mine.filter(one => one.status === 'na').length,
    adjudicated: { correct: adjudications.filter(one => one.item === item && one.verdict === 'correct').length, wrong: adjudications.filter(one => one.item === item && one.verdict === 'wrong').length },
    recall: seeded,
    stability: { same: repeated.filter(one => one.every(each => each === one[0])).length, trees: repeated.length },
    isPromoted,
  }
}

/** One item's numbers as /devloop checklists prints them. */
export function metricsLine(m: ItemMetrics): string {
  const pct = (a: number, b: number): string => (b === 0 ? 'n/a' : `${Math.round((100 * a) / b)}%`)

  return `  ${m.item}${m.isPromoted ? ' [blocking]' : ' [shadow]'}: ${m.results} result${m.results === 1 ? '' : 's'} (${m.fails} fail, ${m.unverified} unverified, ${m.na} not applicable); a person judged ${m.adjudicated.correct + m.adjudicated.wrong} (${m.adjudicated.correct} correct, precision ${pct(m.adjudicated.correct, m.adjudicated.correct + m.adjudicated.wrong)}); recall on seeded defects ${m.recall === null ? 'n/a (no eval task tagged with it)' : `${m.recall.found}/${m.recall.seeded}`}; stable on ${m.stability.same} of ${m.stability.trees} trees run twice or more`
}

/** The latest result per item on a tree. */
export function latestOn(results: readonly ChecklistResult[], tree: string | null): Map<string, ChecklistResult> {
  const out = new Map<string, ChecklistResult>()
  for (const one of results.filter(each => each.tree === tree)) {
    out.set(itemRef(one.list, one.item), one)
  }

  return out
}

/**
 * The gate rows of promoted items (D2): an item a person promoted blocks as
 * its own row when its latest result on this tree is a fail. Shadow items
 * never reach the gate; `person` and `runtime` items never do either.
 */
export function promotedRows(promoted: readonly string[], results: readonly ChecklistResult[], tree: string | null): { label: string; isMet: boolean; note: string }[] {
  const latest = latestOn(results, tree)

  return promoted.flatMap(ref => {
    const one = latest.get(ref)

    return one !== undefined && one.status === 'fail' ? [{ label: `Checklist: ${ref}`, isMet: false, note: `failed on this tree (${one.by}): ${one.evidence.slice(0, 300)}` }] : []
  })
}

/** Items with results that never failed: prune lists them (saturated, or the wrong selector). */
export function neverFailed(results: readonly ChecklistResult[]): string[] {
  const all = [...new Set(results.map(one => itemRef(one.list, one.item)))]

  return all.filter(ref => !results.some(one => itemRef(one.list, one.item) === ref && one.status === 'fail')).sort()
}
