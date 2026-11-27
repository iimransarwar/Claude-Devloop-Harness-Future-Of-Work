// The spec library (docs/design-notes/spec-library.md, DESIGN 4.18) as pure
// functions: an entry made from an approved spec, its folder's name, the
// credential scan of the two files before anything is written, the index's
// lines (append-only: a later line for an entry supersedes an earlier one,
// and one with `removedAt` marks it removed), and the search's ranking. The
// work with the file system is in librarycmd.ts. Nothing here touches `$`.

import type { CredentialHit } from '../types'
import { digest } from './output'
import { clip, firstLine, validate } from './records'
import { scanCredentials } from './scan'
import { parseFeatures } from './spec'

/** One entry as `entry.json` holds it; an index line is the same without `criteria`. */
export type LibraryEntry = {
  schema: 'library-entry@1'
  /** The entry's folder: `<project>--<spec name>--<yyyy-mm-dd>`. */
  id: string
  project: string
  spec: string
  kind: string | null
  size: string | null
  related: string[]
  intent: string
  criteria?: string[]
  features: { id: string; description: string; check: string }[]
  approvedAt: number | null
  closedAt: number | null
  outcome: { status: 'closed' | 'open'; isAllPassing: boolean | null; reviewRounds: number; defects: number }
  harness: string
  hash: string
  savedAt: number
  removedAt?: number
}

/** What an entry is made from: the two files as approved, and the facts the harness holds. */
export type EntryInput = {
  project: string
  spec: string
  specText: string
  featuresText: string
  approvedAt: number | null
  closedAt: number | null
  isAllPassing: boolean | null
  reviewRounds: number
  savedAt: number
  harness: string
  /** The folder of an earlier save of the same spec, as approved, to supersede; else a new one is named. */
  id?: string
}

/** The default limit of a search, and the most it returns. */
export const SEARCH_LIMIT = 5
export const SEARCH_MAX = 10

/** A name as a folder part: letters, digits, `.`, `_` and `-`, no `--` (the separator), at most 60. */
export function slug(name: string): string {
  const out = name.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/-{2,}/g, '-').replace(/^[-.]+|-+$/g, '').slice(0, 60).replace(/-+$/, '')

  return out === '' ? 'unnamed' : out
}

/** The day a time falls on, as the folder name spells it (UTC). */
export const dayOf = (at: number): string => new Date(at).toISOString().slice(0, 10)

/** An entry's folder name: `<project>--<spec name>--<yyyy-mm-dd>`. */
export const entryId = (project: string, spec: string, at: number): string => `${slug(project)}--${slug(spec)}--${dayOf(at)}`

/** A header line's value, or null where the template's placeholder (in parentheses) is still there. */
function headerValue(text: string | undefined): string | null {
  const value = (text ?? '').trim()

  return value === '' || /^\(.*\)$/.test(value) ? null : value
}

/** The `Kind: … · Size: …` and `Related specs: …` lines of a SPEC.md, where present. */
export function headerOf(specText: string): { kind: string | null; size: string | null; related: string[] } {
  const lines = specText.split('\n').slice(0, 12)
  const kindLine = lines.find(line => /^\s*kind\s*:/i.test(line)) ?? ''
  const [kindPart, sizePart] = kindLine.split(/\s*·\s*|\s+\|\s+/)
  const kind = headerValue(kindPart?.replace(/^\s*kind\s*:/i, ''))
  const size = headerValue(/^\s*size\s*:(.*)$/i.exec(sizePart ?? '')?.[1])
  const relatedText = headerValue(lines.find(line => /^\s*related specs?\s*:/i.test(line))?.replace(/^\s*related specs?\s*:/i, ''))
  const related = relatedText === null || /^none\b/i.test(relatedText) ? [] : relatedText.split(/\s*,\s*/).map(one => one.trim()).filter(one => one !== '')

  return { kind: kind === null ? null : clip(kind, 80), size: size === null ? null : clip(size, 20), related: related.slice(0, 20).map(one => clip(one, 120)) }
}

/** The lines under a heading of SPEC.md, up to the next heading. */
function sectionOf(specText: string, heading: RegExp): string[] {
  const out: string[] = []
  let isIn = false
  for (const line of specText.split('\n')) {
    if (/^\s{0,3}#/.test(line)) {
      isIn = heading.test(line)
      continue
    }
    if (isIn) {
      out.push(line)
    }
  }

  return out
}

/** The intent's first sentence. */
export function intentOf(specText: string): string {
  const text = sectionOf(specText, /^\s{0,3}#+\s*intent\b/i).map(line => line.trim()).filter(line => line !== '').join(' ')
  const sentence = /^(.*?[.!?])(?:\s|$)/.exec(text)?.[1] ?? text

  return clip(sentence, 400)
}

/** The numbered acceptance criteria of SPEC.md, text only, in order. */
export function criteriaTextOf(specText: string): string[] {
  return sectionOf(specText, /^\s{0,3}#+\s*acceptance criteria\b/i)
    .flatMap(line => {
      const item = /^\s{0,3}\d+[.)]\s+(\S.*)$/.exec(line)

      return item === null ? [] : [clip(item[1]!.trim(), 600)]
    })
    .slice(0, 40)
}

/** A hash of the two files as copied. */
export const contentHash = (specText: string, featuresText: string): string => digest(`${specText}\u0000${featuresText}`)

/** The entry an approved spec makes (`entry.json`, with its criteria). */
export function entryOf(input: EntryInput): LibraryEntry {
  const header = headerOf(input.specText)
  const status = input.closedAt === null ? 'open' : 'closed'

  return {
    schema: 'library-entry@1',
    id: input.id ?? entryId(input.project, input.spec, input.closedAt ?? input.savedAt),
    project: clip(input.project, 80),
    spec: clip(input.spec, 80),
    kind: header.kind,
    size: header.size,
    related: header.related,
    intent: intentOf(input.specText),
    criteria: criteriaTextOf(input.specText),
    features: parseFeatures(input.featuresText).slice(0, 100).map(one => ({ id: clip(one.id, 120), description: clip(one.description, 600), check: clip(one.check, 600) })),
    approvedAt: input.approvedAt,
    closedAt: input.closedAt,
    outcome: { status, isAllPassing: status === 'open' ? null : input.isAllPassing, reviewRounds: input.reviewRounds, defects: 0 },
    harness: clip(input.harness, 40),
    hash: contentHash(input.specText, input.featuresText),
    savedAt: input.savedAt,
  }
}

/** An entry's index line: the entry without its criteria, one JSON line. */
export function indexLine(entry: LibraryEntry): string {
  const line: Partial<LibraryEntry> = { ...entry }
  delete line.criteria

  return JSON.stringify(line)
}

/**
 * The credential scan of the two files before they are saved: the scan the
 * gate runs on a diff's added lines, over every line of each. A hit names
 * the file and the line, never the value.
 */
export function scanSpecFiles(specText: string, featuresText: string): CredentialHit[] {
  const lines = (file: string, text: string) => text.split('\n').map((one, i) => ({ file, line: i + 1, text: one }))

  return scanCredentials([...lines('SPEC.md', specText), ...lines('features.json', featuresText)])
}

/** Where each entry stands in the index: the last line for it (with its position), removed or not. */
export type IndexState = { entries: (LibraryEntry & { order: number })[]; removed: string[]; skipped: number }

/**
 * Reads the index: one JSON line each, a line that does not parse or fit
 * the record skipped and counted; a later line for an entry supersedes an
 * earlier one, and one with `removedAt` marks it removed. The entries are
 * the live ones, in the order of their last line (the newest last).
 */
export function readIndex(text: string): IndexState {
  const last = new Map<string, LibraryEntry & { order: number }>()
  let skipped = 0
  let order = 0
  for (const line of text.split('\n').filter(one => one.trim() !== '')) {
    let one: unknown
    try {
      one = JSON.parse(line)
    } catch {
      skipped += 1
      continue
    }
    if (validate('library-entry@1', one).length > 0) {
      skipped += 1
      continue
    }
    const entry = one as LibraryEntry
    last.delete(entry.id)
    last.set(entry.id, { ...entry, order })
    order += 1
  }
  const all = [...last.values()]

  return { entries: all.filter(one => one.removedAt === undefined), removed: all.filter(one => one.removedAt !== undefined).map(one => one.id), skipped }
}

/** The words of a text, as the search matches them: lower case, letters and digits, two characters or more. */
export function wordsOf(text: string): string[] {
  return [...new Set(text.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(one => one.length >= 2))]
}

/** What an entry is searched by: its spec name, intent, kind, project and feature descriptions. */
const searchedText = (entry: LibraryEntry): string => [entry.spec, entry.intent, entry.kind ?? '', entry.project, ...entry.features.map(one => one.description)].join(' ')

/** A search's limit: 5 when not given, at most 10, at least 1. */
export function limitOf(limit: unknown): number {
  return typeof limit === 'number' && Number.isFinite(limit) ? Math.min(SEARCH_MAX, Math.max(1, Math.floor(limit))) : SEARCH_LIMIT
}

/** When an entry counts as newer: its close, else its save. */
const whenOf = (entry: LibraryEntry): number => entry.closedAt ?? entry.savedAt

/**
 * The search (decision 4): the live entries ranked by how many of the
 * query's words they hold (ties: newer first), none that hold none, at most
 * `limit`.
 */
export function searchLibrary(entries: readonly (LibraryEntry & { order: number })[], query: string, limit: unknown): (LibraryEntry & { order: number; score: number })[] {
  const wanted = wordsOf(query)
  if (wanted.length === 0) {
    return []
  }

  return entries
    .map(entry => {
      const held = new Set(wordsOf(searchedText(entry)))

      return { ...entry, score: wanted.filter(word => held.has(word)).length }
    })
    .filter(one => one.score > 0)
    .sort((a, b) => b.score - a.score || whenOf(b) - whenOf(a) || b.order - a.order)
    .slice(0, limitOf(limit))
}

/** An entry's outcome in words. */
export function outcomeText(entry: LibraryEntry): string {
  const { outcome } = entry
  const status = outcome.status === 'open'
    ? 'open'
    : `closed${outcome.isAllPassing === true ? ' with every feature passing' : outcome.isAllPassing === false ? ' with features not passing' : ''}`
  const defects = outcome.defects === 0 ? '' : `; ${outcome.defects} escaped defect${outcome.defects === 1 ? '' : 's'} recorded later`

  return `${status}; ${outcome.reviewRounds} review round${outcome.reviewRounds === 1 ? '' : 's'}${defects}`
}

/** One search result as the tool answers it: where it is, what it was, and its criteria (from `entry.json`, or null where it could not be read). */
export function resultText(entry: LibraryEntry, folder: string, criteria: readonly string[] | null): string {
  return [
    `${entry.spec} (project ${entry.project}${entry.kind === null ? '' : `, ${entry.kind}`}${entry.size === null ? '' : `, ${entry.size}`})`,
    `  folder: ${folder} (read its SPEC.md and features.json there)`,
    `  intent: ${entry.intent === '' ? '(none written)' : entry.intent}`,
    `  outcome: ${outcomeText(entry)}`,
    criteria === null
      ? '  criteria: (its entry.json could not be read)'
      : criteria.length === 0 ? '  criteria: none numbered' : ['  criteria:', ...criteria.map((one, i) => `    ${i + 1}. ${one}`)].join('\n'),
  ].join('\n')
}

/** One listed entry as `/devloop library` prints it. */
export const listLine = (entry: LibraryEntry): string =>
  `  ${entry.id}: ${firstLine(entry.intent, 100) || '(no intent)'} [${outcomeText(entry)}]`
