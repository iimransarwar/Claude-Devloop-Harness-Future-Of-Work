// Portable evidence (DESIGN 4.11, 11 "Portability"): when a review round
// settles and when a change closes, the harness writes an `evidence@2`
// record as a git note on the reviewed commit under refs/notes/devloop. A
// note changes no tree, so nothing is left out of the verified hash
// (principle 9). The command line's gate reads the note for HEAD and counts
// it only when it names the very tree being judged; it recomputes every
// check itself, so a note can only supply the review rows. A note is a
// record, not a signature: anyone who can push the ref can write one. Also
// here: the stateless gate, the module's gate rows filled from what the tree
// alone proves. Pure: no `$`.

import type { CredentialHit, Loop } from '../types'
import type { Config } from './config'
import { statelessLoop } from './enforce'
import { gate, specialistsFor, tierWithBlast } from './gate'
import type { Check, GateFacts } from './gate'
import { digest } from './output'
import { matchesAny, stepsFor } from './rules'
import { HARNESS_VERSION, validate } from './records'

/** A hash of the policy in force, as every record names it (the module's records and the evidence note alike). */
export const policyHash = (cfg: Config): string => digest(JSON.stringify(cfg))

export type EvidenceNote = {
  schema: 'evidence@2'
  at: number
  why: 'review' | 'done'
  /**
   * The committable tree the evidence covers (final round, D1 F4, F10): the
   * working tree as a commit of everything would make it, equal to HEAD's
   * tree, or nothing is written. Instruction files git ignores are not in it.
   */
  tree: string
  /** The full tree "verified" names, ignored instruction files included, recorded beside it. */
  full?: string
  head: string
  policy: string
  /** Each verify command with a pass on this tree, and that tree. */
  checks: { run: string; tree: string }[]
  /** Each reviewer of the last round on this tree, and its verdict. */
  reviewers: { name: string; mode: 'general' | 'blocking' | 'shadow'; verdict: 'pass' | 'fail'; round: number }[]
  /** Blocking findings still open. */
  open: number
  /**
   * Promoted checklist items that failed on the reviewed tree, as `list/item`
   * (the last review's F7): a round the module's gate calls failing is
   * recorded as failing, and the review row is unmet from such a note.
   */
  checklistFails: string[]
  harness: string
}

// Writes the note on HEAD only when HEAD's tree is the tree the evidence
// names ($1); the record is $2. Exit 4 with `tree:<hash>` when they differ,
// so nothing is written for a tree that is not committed as reviewed. A
// repository with no committer configured gets the harness's name on the
// notes commit, never a prompt.
export const NOTE_WRITE = `
# devloop:note-write
headTree=$(git rev-parse -q --verify "HEAD^{tree}" 2>/dev/null) || { echo "tree:none"; exit 4; }
[ "$headTree" = "$1" ] || { echo "tree:$headTree"; exit 4; }
if ! git config user.email >/dev/null 2>&1; then
  export GIT_AUTHOR_NAME=devloop GIT_AUTHOR_EMAIL=devloop@invalid GIT_COMMITTER_NAME=devloop GIT_COMMITTER_EMAIL=devloop@invalid
fi
printf '%s' "$2" | git notes --ref=devloop add -f -F - HEAD >/dev/null 2>&1 || exit 5
echo "noted:$(git rev-parse HEAD)"
`

// The note on a commit ($1, HEAD by default) under refs/notes/devloop; exit 3 with none.
export const NOTE_READ = `
# devloop:note-read
ref=$1
[ -n "$ref" ] || ref=HEAD
git notes --ref=devloop show "$ref" 2>/dev/null || exit 3
`

/** The evidence record for a tree, from what the harness holds for it. */
export function evidenceNote(input: {
  at: number
  why: 'review' | 'done'
  /** The full tree the harness verified and reviewed. */
  tree: string
  /** The committable tree, which the note is keyed on. */
  committable: string
  head: string
  policy: string
  passedOn: Readonly<Record<string, string>>
  review: Pick<Loop['review'], 'status' | 'round' | 'tree' | 'agents'>
  open: number
  /** Each reviewer's verdict of the last round, by name (from the audit trail's sense of it: no blocking finding open). */
  verdicts: Readonly<Record<string, 'pass' | 'fail'>>
  /** The promoted checklist items that failed on the reviewed tree (F7). */
  checklistFails?: readonly string[]
}): EvidenceNote {
  const isOnTree = input.review.tree === input.tree && (input.review.status === 'pass' || input.review.status === 'fail')

  return {
    schema: 'evidence@2',
    at: input.at,
    why: input.why,
    tree: input.committable,
    full: input.tree,
    head: input.head,
    policy: input.policy,
    checks: Object.entries(input.passedOn).filter(([, tree]) => tree === input.tree).map(([run, tree]) => ({ run: run.slice(0, 600), tree })).slice(0, 100),
    reviewers: isOnTree
      ? input.review.agents.slice(0, 20).map(one => ({ name: one.name.slice(0, 60), mode: one.mode, verdict: input.verdicts[one.name] ?? (input.review.status === 'pass' ? 'pass' : 'fail'), round: input.review.round }))
      : [],
    open: input.open,
    checklistFails: (input.checklistFails ?? []).slice(0, 60).map(one => one.slice(0, 120)),
    harness: HARNESS_VERSION,
  }
}

/** A note's text read back: the record when it parses and fits the schema; null otherwise. */
export function parseEvidence(text: string | null): EvidenceNote | null {
  if (text === null || text.trim() === '') {
    return null
  }
  try {
    const value = JSON.parse(text.trim()) as unknown
    return validate('evidence@2', value).length === 0 ? (value as EvidenceNote) : null
  } catch {
    return null
  }
}

/**
 * Whether a note's text is portable evidence in a schema this version no
 * longer counts (`evidence@1`; the cache-guard round, L4): it reads as no
 * evidence, which is the fail-safe direction, and the review row says why.
 */
export function isOlderEvidence(text: string | null): boolean {
  if (text === null || text.trim() === '') {
    return false
  }
  try {
    const value = JSON.parse(text.trim()) as { schema?: unknown }

    return typeof value === 'object' && value !== null && typeof value.schema === 'string' && /^evidence@\d+$/.test(value.schema) && value.schema !== 'evidence@2'
  } catch {
    return false
  }
}

/** What the review row says of a note this version no longer counts (L4). */
export const OLDER_NOTE = 'the note was written by an older version of the harness; run the review again'

/**
 * One review row as the portable evidence proves it: met only when the note
 * names the tree being judged (the committable tree, final round D1 F4),
 * was produced under the policy in force (`policy`, its hash), names this
 * reviewer in a general or blocking mode with its own passing outcome, and
 * leaves no blocking finding open (D1 F7), nor, for the general row, a
 * promoted checklist item failing (the last review's F7). It never claims
 * more than the note says.
 */
export function reviewRowFrom(label: string, name: string, note: EvidenceNote | null, tree: string | null, policy: string, isOlder = false): Check {
  if (note === null && isOlder) {
    return { label, isMet: false, note: OLDER_NOTE }
  }
  if (note === null) {
    return { label, isMet: false, note: 'no evidence of a review for this tree: the harness writes a git note (refs/notes/devloop) on the reviewed commit; fetch it with git fetch origin refs/notes/devloop:refs/notes/devloop' }
  }
  if (tree === null || note.tree !== tree) {
    return { label, isMet: false, note: `the evidence names tree ${note.tree.slice(0, 8)}, but the tree is now ${(tree ?? 'none').slice(0, 8)}` }
  }
  if (note.policy !== policy) {
    return { label, isMet: false, note: 'the evidence for this tree was produced under another policy (its devloop.json hash differs from the one in force), so it does not count' }
  }
  const one = note.reviewers.find(each => each.name === name)
  if (one === undefined) {
    return { label, isMet: false, note: `the evidence for this tree names no ${name === 'general' ? 'independent' : name} review` }
  }
  if (one.mode === 'shadow') {
    return { label, isMet: false, note: `the evidence names ${name} only as a shadow reviewer: this row needs its own passing outcome in a general or blocking mode` }
  }
  if (one.verdict !== 'pass' || note.open > 0) {
    return { label, isMet: false, note: `round ${one.round} did not pass${note.open > 0 ? ` (${note.open} blocking finding${note.open === 1 ? '' : 's'} open)` : ''}` }
  }
  // A promoted checklist item that failed on the reviewed tree makes the round a failing one (the last review's F7), as the module's gate says.
  if (name === 'general' && note.checklistFails.length > 0) {
    return { label, isMet: false, note: `a failing verdict: round ${one.round} left promoted checklist items failing on the tree it read: ${note.checklistFails.slice(0, 5).join(', ')}${note.checklistFails.length > 5 ? ', …' : ''}` }
  }

  return { label, isMet: true, note: `passed in round ${one.round} (a git note on ${note.head.slice(0, 8)}: a record, not a signature)` }
}

// ---------------------------------------------------------------- the stateless gate

/** One check as the command line ran it. */
export type CheckRun = { run: string; isPassing: boolean; outcome: string; output: string }

/** What the command line proved from the tree, for the gate rows. */
export type TreeProof = {
  tree: string | null
  /** The committable tree (final round, D1 F4): what the evidence notes are keyed on. */
  committable: string | null
  base: string | null
  files: string[]
  lines: number
  /** The checks run on this tree, in order; a check not run has no entry. */
  runs: CheckRun[]
  credentials: CredentialHit[]
  /** Hidden characters in changed instruction files. */
  hidden: { file: string; line: number; kind: string }[]
  /** Whether the added lines could be scanned at all. */
  isScanned: boolean
  note: EvidenceNote | null
  /** The note there is in a schema this version no longer counts (L4): the review row says so. */
  isOlderNote?: boolean
}

/**
 * The loop the gate rows are judged on, from the tree alone: small-fix mode,
 * no spec, the changed files and size, a pass per check that passed on this
 * tree, the scan's evidence. Review comes from the note, row by row
 * (`statelessGate`), never from this loop.
 */
export function proofLoop(proof: TreeProof, cfg: Config): Loop {
  const base = statelessLoop('idle')
  const failed = proof.runs.find(one => !one.isPassing) ?? null
  const passedOn = Object.fromEntries(proof.runs.filter(one => one.isPassing && proof.tree !== null).map(one => [one.run, proof.tree as string]))
  const infra = failed !== null && failed.outcome !== 'fail' ? failed.outcome : null

  return {
    ...base,
    tree: proof.tree,
    isBaseKnown: proof.base !== null,
    changed: proof.files,
    hasTouchedTests: proof.files.some(file => matchesAny(file, cfg.tests)),
    size: { files: proof.files.length, lines: proof.lines },
    tier: tierWithBlast(proof.files, proof.lines, cfg),
    isDirty: false,
    verify: {
      ...base.verify,
      status: failed !== null ? 'fail' : proof.runs.length > 0 ? 'pass' : 'none',
      failed: failed?.run ?? null,
      infra,
      tree: proof.tree,
      profile: 'full',
      passedOn,
    },
    evidence: { tree: proof.isScanned ? proof.tree : null, credentials: proof.credentials, testsChanged: [], testsAdded: [], hidden: proof.hidden },
  }
}

/** The review rows' reviewer names, as the gate labels them. */
const reviewerOf = (label: string): string | null =>
  label === 'Independent review' ? 'general' : label.startsWith('Review: ') ? label.slice('Review: '.length) : null

/**
 * The gate the command line proves (DESIGN 4.11): the module's rows
 * (`gate`), judged on the loop the tree proves, the review rows replaced by
 * what the portable evidence proves. Green only when every row is met.
 */
export function statelessGate(proof: TreeProof, cfg: Config, facts: GateFacts): { loop: Loop; rows: Check[]; isGreen: boolean } {
  const loop = proofLoop(proof, cfg)
  const rows = gate(loop, cfg, facts).map(row => {
    const name = reviewerOf(row.label)

    return name === null ? row : reviewRowFrom(row.label, name, proof.note, proof.committable, policyHash(cfg), proof.isOlderNote === true)
  })

  return { loop, rows, isGreen: rows.every(row => row.isMet) }
}

/** The checks the command line runs for a change: every fast and full check that applies to its files; none for an empty change. */
export const checksFor = (cfg: Config, files: readonly string[], isEmpty: boolean): string[] =>
  isEmpty ? [] : stepsFor(cfg.verify, 'full', files).map(one => one.run)

/** The reviewers a change needs evidence from: the general one, and each blocking specialist whose globs a changed file matches. */
export const reviewersNeeded = (cfg: Config, files: readonly string[]): string[] =>
  ['general', ...specialistsFor({ changed: [...files] }, cfg).filter(one => one.mode === 'blocking').map(one => one.name)]
