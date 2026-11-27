// The gate as pure functions: the change's tier (with its blast radius),
// each row that stands between it and shipping, and who must approve the
// merge. Nothing here touches `$`.

import type { Loop, Tier } from '../types'
import type { Config } from './config'
import { openBlocking } from './findings'
import { backgroundFor, instructionGlobs, matches, matchesAny, stepsFor, tierOf } from './rules'
import { isTaskStateOnly } from './tasks'
import { ago, recordOn, runningOn } from './testruns'

// ---------------------------------------------------------------- tier

const ORDER: readonly Tier[] = ['none', 'low', 'medium', 'high']

/** One tier riskier, `high` at most; a change with no files stays `none`. */
export const raise = (tier: Tier): Tier => (tier === 'none' ? 'none' : ORDER[Math.min(ORDER.length - 1, ORDER.indexOf(tier) + 1)] ?? 'high')

/**
 * Why a change is bigger than its files' tier says: more files or lines
 * than `blastRadius` allows, or a dependency manifest touched. Each reason
 * raises the tier one step in all (not one step each).
 */
export function blastReasons(changed: readonly string[], lines: number, cfg: Config): string[] {
  const out: string[] = []
  const { maxFiles, maxLines, manifests } = cfg.blastRadius
  if (changed.length > maxFiles) {
    out.push(`${changed.length} files changed, over the ${maxFiles} blastRadius.maxFiles allows`)
  }
  if (lines > maxLines) {
    out.push(`${lines} lines changed, over the ${maxLines} blastRadius.maxLines allows`)
  }
  const touched = changed.filter(file => matchesAny(file, manifests))
  if (touched.length > 0) {
    out.push(`a dependency manifest changed (${touched.slice(0, 3).join(', ')}${touched.length > 3 ? ', …' : ''})`)
  }

  return out
}

/** The tier of a set of files, raised one step when the change is past its blast radius. */
export function tierWithBlast(files: readonly string[], lines: number, cfg: Config, spec: string | null = null): Tier {
  const tier = tierOf(files, cfg, files.some(file => matchesAny(file, cfg.tests)), spec)

  return blastReasons(files, lines, cfg).length > 0 ? raise(tier) : tier
}

/** The tier of the loop's change as a policy reads it: the gate passes the base branch's policy. */
export const tierFor = (loop: Pick<Loop, 'changed' | 'size' | 'spec'>, cfg: Config): Tier =>
  tierWithBlast(loop.changed, loop.size.lines, cfg, loop.spec)

// ---------------------------------------------------------------- features

/** How many approved features pass, and how many of those passes cover `tree`. */
export function featureCounts(loop: Loop): { total: number; passing: number; onTree: number } {
  const all = Object.values(loop.features)
  const passing = all.filter(one => one.passes)

  return { total: all.length, passing: passing.length, onTree: passing.filter(one => one.tree === loop.tree).length }
}

// ---------------------------------------------------------------- the gate

export type Check = { label: string; isMet: boolean; note: string }

/** What the gate knows beside the loop: the policy's state and the lint of its checks. */
export type GateFacts = {
  /** Problems in the working tree's devloop.json: each keeps the gate shut until fixed. */
  errors: readonly string[]
  /** Check-integrity notes on the verify commands. */
  lint: readonly string[]
  /**
   * `changed`: the working tree's policy differs from the base branch's, which the gate uses; `deleted`: the working
   * tree has none, and the base branch's is in force (C2.1); `no-base`: none on the base.
   */
  policy: 'same' | 'changed' | 'deleted' | 'no-base'
  /** The working tree's mode, when it differs from the base branch's, which is the one in force. */
  workingMode?: 'enforce' | 'observe' | null
  /** Credential-shaped variables a check run with the full environment can see (C1, checkEnv observe). */
  exposed?: readonly string[]
  /** How many ignored instruction files matched when the snapshot's sweep took only its cap (F12); null when it took them all. */
  ignoredCapped?: number | null
  /**
   * The review carry-over's facts (final round, D2 F1): git's diff of two
   * trees and whether the task files validate on the later one, by
   * `<verdict's tree> <tree now>`; present only where the `.tasks`
   * integration is on. A fact about two trees never goes stale, and nothing
   * here says a verdict carries: `verdictCovers` decides that every time.
   */
  carry?: Readonly<Record<string, CarryFact>>
  /**
   * Index entries git is told not to look at, from the last snapshot (the
   * last review's F2): the skip-worktree or assume-unchanged bit keeps their
   * changes out of the tree judged, so any one keeps the gate shut.
   */
  hiddenFromGit?: readonly string[]
  /** The time now, so the Verification row can say how long a background run has gone; absent, it names no time. */
  now?: number
}

/** What git and the `tasks` command said about two trees: the paths that differ (null: git could not say), and whether the task files validate. */
export type CarryFact = { paths: readonly string[] | null; isValid: boolean }

/** How a review verdict stands to the tree now: reached on it, carried to it, or not covering it. */
export type Coverage = 'reviewed' | 'carried' | 'not'

/**
 * Whether a review verdict covers the tree now (final round, D2 F1): the one
 * decision of the carry-over, made afresh each time from the verdict's tree,
 * the tree now and git's diff between them. Reached on this very tree; or
 * carried, when the integration is on, every path that differs is task
 * state (`isTaskStateOnly`) and the task files validate; else not. Nothing
 * that says "carried" is ever stored.
 */
export function verdictCovers(input: { verdict: string | null; now: string | null; diff: readonly string[] | null; isOn: boolean; isValid: boolean }): Coverage {
  if (input.verdict === null || input.now === null) {
    return 'not'
  }
  if (input.verdict === input.now) {
    return 'reviewed'
  }

  return input.isOn && input.isValid && input.diff !== null && isTaskStateOnly(input.diff) ? 'carried' : 'not'
}

/** The key of a carry fact: the verdict's tree, then the tree now. */
export const carryKey = (from: string, to: string): string => `${from} ${to}`

/** The loop's review verdict against the tree now, by the facts the gate was given (none: it covers only its own tree). */
export function coverageOf(loop: Pick<Loop, 'tree' | 'review'>, facts: Pick<GateFacts, 'carry'>): Coverage {
  const from = loop.review.tree
  const fact = from === null || loop.tree === null ? undefined : facts.carry?.[carryKey(from, loop.tree)]

  return verdictCovers({ verdict: from, now: loop.tree, diff: fact?.paths ?? null, isOn: fact !== undefined, isValid: fact?.isValid ?? false })
}

/**
 * The promoted checklist items that failed on the verdict's tree (D2 F2):
 * recorded against the tree the round read, they travel with the verdict
 * wherever it carries, and make it a failing verdict there.
 */
export function verdictFails(loop: Pick<Loop, 'tree' | 'review' | 'checklistFails'>, coverage: Coverage): Loop['checklistFails'] {
  const fails = loop.checklistFails ?? []

  return fails.filter(one => one.tree === loop.tree || (coverage !== 'not' && one.tree !== null && one.tree === loop.review.tree))
}

export const NO_FACTS: GateFacts = { errors: [], lint: [], policy: 'same' }

const short = (tree: string | null): string => (tree ?? 'none').slice(0, 8)

const list = (items: readonly string[], cap = 5): string => `${items.slice(0, cap).join(', ')}${items.length > cap ? ', …' : ''}`

/** The specialist reviewers that join this change's review: those whose globs a changed file matches. */
export const specialistsFor = (loop: Pick<Loop, 'changed'>, cfg: Config): Config['reviewers'] =>
  cfg.reviewers.filter(one => loop.changed.some(file => one.when.some(glob => matches(file, glob))))

/**
 * The Verification row: met only when every fast, full and background check
 * of the policy in force that applies to this change has a pass on this very
 * tree. Its note names the checks still to run, and what a background check
 * is doing on this tree: running, failing, or unable to run.
 */
function verificationRow(loop: Loop, cfg: Config, tier: Tier, facts: GateFacts): Check {
  const label = 'Verification'
  if (loop.verify.status === 'error') {
    return { label, isMet: false, note: `the harness could not verify (${loop.verify.failed ?? 'unknown error'}); /devloop verify retries` }
  }
  if (tier === 'none') {
    return { label, isMet: true, note: 'no changes yet' }
  }
  if (cfg.verify.length === 0) {
    return { label, isMet: tier === 'low', note: 'no verify commands in devloop.json: nothing proves the work' }
  }
  const foreground = stepsFor(cfg.verify, 'full', loop.changed)
  const background = backgroundFor(cfg.verify, loop.changed)
  const steps = [...foreground, ...background]
  if (loop.tree === null && background.length > 0) {
    // A background result is recorded against a tree: outside git none starts, so say why rather than wait (Review Focus 5).
    return { label, isMet: false, note: `background checks need a git repository to record a result against: ${list(background.map(one => one.run))}` }
  }
  // An edit since the last pass moved the tree the passes name.
  const isMoved = loop.isDirty && loop.verify.status === 'pass'
  const pending = steps.filter(one => isMoved || loop.tree === null || loop.verify.passedOn[one.run] !== loop.tree)
  const isOnTree = loop.verify.tree === loop.tree && !isMoved
  if (loop.verify.status === 'fail' && isOnTree && loop.verify.failed !== null) {
    return loop.verify.infra !== null
      ? { label, isMet: false, note: `could not run: ${loop.verify.failed} (${loop.verify.infra})` }
      : { label, isMet: false, note: `failing: ${loop.verify.failed}` }
  }
  if (loop.tree === null) {
    // Outside git there is no tree to name a pass by: the last run and its profile decide.
    const hasPassed = loop.verify.status === 'pass' && !loop.isDirty
    const needsFull = foreground.some(one => one.profile === 'full')
    const isMet = hasPassed && (loop.verify.profile === 'full' || !needsFull)

    return {
      label,
      isMet,
      note: isMet ? (needsFull ? 'fast and full checks pass' : 'passes') : hasPassed ? 'fast checks pass; the full checks run when the change ships' : 'not run since the last edit',
    }
  }
  const hasFull = foreground.some(one => one.profile === 'full')
  if (pending.length === 0) {
    return { label, isMet: true, note: hasFull ? 'fast and full checks pass' : steps.length === 0 ? 'no check applies to this change' : 'passes' }
  }
  const names = pending.map(one => one.run)
  // What each pending background check is doing on this tree; after an edit the loop's tree is not the tree now, so its runs say nothing.
  const waiting = isMoved ? [] : pending.filter(one => one.background === true).map(one => one.run)
  const running = waiting.flatMap(run => {
    const one = runningOn(loop, run)

    return one === null ? [] : [{ run, startedAt: one.startedAt }]
  })
  if (running.length > 0) {
    const since = facts.now === undefined ? '' : ` (started ${ago(facts.now - Math.min(...running.map(one => one.startedAt)))} ago)`

    return { label, isMet: false, note: `tests still running${since}: ${list(running.map(one => one.run))}` }
  }
  const failing = waiting.filter(run => recordOn(loop, run)?.outcome === 'fail')
  if (failing.length > 0) {
    return { label, isMet: false, note: `failing: ${list(failing)} (in the background)` }
  }
  // Not found or killed: it is not started again on this tree, so the next stop would not help.
  const couldNot = waiting.flatMap(run => {
    const outcome = recordOn(loop, run)?.outcome

    return outcome === undefined || outcome === 'pass' || outcome === 'fail' ? [] : [`${run} (${outcome})`]
  })
  if (couldNot.length > 0) {
    return { label, isMet: false, note: `could not run on this tree: ${list(couldNot)}; fix the command` }
  }
  if (pending.every(one => one.background === true)) {
    const done = foreground.length === 0 ? '' : hasFull ? 'fast and full checks pass; ' : 'fast checks pass; '

    return { label, isMet: false, note: `${done}background checks still to run: ${list(names)} (they start at the next stop)` }
  }
  const isFastDone = pending.every(one => one.profile === 'full' || one.background === true)

  return {
    label,
    isMet: false,
    note: isFastDone
      ? `fast checks pass; the full checks run when the change ships: still to run ${list(names)}`
      : `not run since the last edit; still to run: ${list(names)}`,
  }
}

/**
 * One reviewer's row: met when a round on this tree left none of its
 * blocking findings open. `rows` names the reviewers with a row of their
 * own: the general row also holds every open blocking finding of a reviewer
 * without one (a specialist that no longer applies, the harness's own).
 */
function reviewRow(loop: Loop, cfg: Config, name: string, label: string, rows: readonly string[], facts: GateFacts): Check {
  const { review } = loop
  // Whether the verdict covers this tree is decided here, every time, by the diff from the tree it read (final round, D2 F1).
  const coverage = coverageOf(loop, facts)
  const isCarried = coverage === 'carried'
  const isOnTree = coverage !== 'not'
  const isDone = review.status === 'pass' || review.status === 'fail'
  const open = openBlocking(loop.findings).filter(one => one.reviewer === name || (name === 'general' && !rows.includes(one.reviewer)))
  const decisions = open.filter(one => one.route === 'decision')
  if (decisions.length > 0) {
    return {
      label,
      isMet: false,
      note: `${decisions.map(one => one.id).join(', ')} await${decisions.length === 1 ? 's' : ''} a person's decision: /devloop findings resolve <id> <note>${open.length > decisions.length ? `; ${open.length - decisions.length} more to fix` : ''}`,
    }
  }
  if (review.isStalled && open.length > 0) {
    return { label, isMet: false, note: `stopped: two rounds in a row closed no finding (${open.map(one => one.id).join(', ')} open), so a person reads the change` }
  }
  if (isDone && isOnTree && name !== 'general' && !review.agents.some(one => one.name === name)) {
    return { label, isMet: false, note: `did not run in round ${review.round}: /devloop review starts a round with it` }
  }
  if (isDone && isOnTree) {
    const notes = loop.findings.filter(one => one.reviewer === name && (one.status === 'note' || one.status === 'deferred') && one.seen === review.round).length
    // What failed on the verdict's tree travels with it (D2 F2): a promoted checklist item's failure makes it a failing verdict wherever it is shown.
    const failed = name === 'general' ? verdictFails(loop, coverage).filter(one => one.tree === review.tree).map(one => one.ref) : []
    if (open.length === 0 && failed.length > 0) {
      return { label, isMet: false, note: `a failing verdict: round ${review.round}${isCarried ? ` (on ${short(review.tree)}, carried: only task state has changed since)` : ''} left promoted checklist items failing on the tree it read: ${list(failed)}` }
    }

    return open.length === 0
      ? { label, isMet: true, note: isCarried ? `passed on ${short(review.tree)}; only task state has changed since` : `passed in round ${review.round}${notes > 0 ? ` (${notes} note${notes === 1 ? '' : 's'}, nothing blocking)` : ''}` }
      : { label, isMet: false, note: `round ${review.round} of ${cfg.maxReviewRounds} found problems: ${open.map(one => one.id).join(', ')} open` }
  }
  // A pass covers the tree it read: after later edits it is out of date, and no round starts until the change is ready again (rule 15).
  const next = cfg.autoReview ? 'a new round starts when the change is ready (the devloop_review tool, or a push)' : 'a person starts a new round with /devloop review ("autoReview" is off)'
  const stale = `passed on tree ${short(review.tree)}, but the tree is now ${short(loop.tree)}: the review is out of date, and ${next}`
  if (isDone) {
    return { label, isMet: false, note: review.status === 'pass' ? stale : `reviewed on tree ${short(review.tree)}, but the tree is now ${short(loop.tree)}` }
  }
  if (review.status === 'running') {
    return { label, isMet: false, note: `round ${review.round} running` }
  }
  if (isCapSpent(review, cfg)) {
    return { label, isMet: false, note: `the cap of ${cfg.maxReviewRounds} rounds is spent: a person reads the change` }
  }

  return { label, isMet: false, note: review.cycle.ended === 'pass' && review.tree !== null && review.tree !== loop.tree ? stale : 'not run: /devloop review' }
}

// ---------------------------------------------------------------- when a round may start

/**
 * Whether the review cap is spent (rule 5): `maxReviewRounds` bounds one
 * cycle, discarded rounds included (rule 11), and a cycle that ended with a
 * pass spends nothing, since the next round starts a new one.
 */
export const isCapSpent = (review: Pick<Loop['review'], 'round' | 'cycle'>, cfg: Pick<Config, 'maxReviewRounds'>): boolean =>
  review.round >= cfg.maxReviewRounds && review.cycle.ended !== 'pass'

/** Whether two stalled rounds ended the cycle: a cycle a person then settled with a pass is over, and the next round starts a new one. */
export const isStallSpent = (review: Pick<Loop['review'], 'isStalled' | 'cycle'>): boolean => review.isStalled && review.cycle.ended !== 'pass'

/** Why no round starts when two rounds in a row closed no finding. */
export const STALLED_TEXT = 'The review loop stopped after two rounds in a row closed no finding. This change needs a person to read it; /devloop done closes it when they have.'

/** Why no round starts once the cycle's rounds are spent. */
export const capText = (cfg: Pick<Config, 'maxReviewRounds'>): string =>
  `The review cap of ${cfg.maxReviewRounds} rounds is spent. This change needs a person to read it; /devloop done closes it when they have.`

/** Why no round starts on a change with no files. */
export const NOTHING_TEXT = 'Nothing has changed, so there is nothing to review.'

/**
 * Why a round the harness or the agent would start may not (rule 4), or
 * null when it may: the first that applies. `isReviewedHere` is whether a
 * verdict on record covers the tree now (reached on it, or carried to it).
 * A person's own /devloop review is not judged here.
 */
export function reviewRefusal(loop: Loop, cfg: Config, isReviewedHere: boolean): string | null {
  const tier = tierFor(loop, cfg)
  if (!cfg.autoReview) {
    return 'autoReview is off: a person starts rounds with /devloop review'
  }
  if (loop.phase === 'spec') {
    return 'A spec is being written: review rounds start once a person approves it.'
  }
  if (loop.review.status === 'running') {
    return `Review round ${loop.review.round} is already running.`
  }
  if (isStallSpent(loop.review)) {
    return STALLED_TEXT
  }
  if (isCapSpent(loop.review, cfg)) {
    return capText(cfg)
  }
  if (tier === 'none') {
    return NOTHING_TEXT
  }
  if (tier === 'low') {
    return 'This change is low risk, so it needs no review round.'
  }

  return isReviewedHere ? `This tree was already reviewed in round ${loop.review.round}.` : null
}

/**
 * What stands between this change and shipping it. `cfg` is the policy the
 * gate judges by: the base branch's, so a change cannot loosen its own.
 * Rows that are always met are notes a person reads; who must approve the
 * merge is said apart from the rows (`approvers`): no state of the loop ticks it.
 */
export function gate(loop: Loop, cfg: Config, facts: GateFacts = NO_FACTS): Check[] {
  const checks: Check[] = []
  const tier = tierFor(loop, cfg)
  if (facts.errors.length > 0) {
    checks.push({ label: 'Policy error', isMet: false, note: `devloop.json: ${facts.errors.slice(0, 3).join('; ')}${facts.errors.length > 3 ? '; …' : ''}` })
  }
  if (!loop.isBaseKnown && loop.tree !== null) {
    checks.push({ label: 'Base branch unknown', isMet: false, note: 'no branch to measure the change against: set "defaultBranch" in devloop.json (/devloop doctor says which exist)' })
  }
  const hiddenFromGit = facts.hiddenFromGit ?? []
  if (hiddenFromGit.length > 0) {
    checks.push({ label: 'Files hidden from git', isMet: false, note: `${list(hiddenFromGit)} carr${hiddenFromGit.length === 1 ? 'ies' : 'y'} the skip-worktree or assume-unchanged bit, so their changes are not in the tree judged: clear it (git update-index --no-skip-worktree --no-assume-unchanged <file>)` })
  }
  checks.push(verificationRow(loop, cfg, tier, facts))
  if (loop.phase === 'spec') {
    checks.push({ label: 'Spec', isMet: false, note: 'awaiting a person: /devloop approve' })
  }
  if (loop.phase === 'build') {
    const { passing, total, onTree } = featureCounts(loop)
    checks.push({
      label: 'Features',
      isMet: passing === total && onTree === total,
      note: `${passing}/${total} passing${passing > 0 && onTree < passing ? `; ${onTree} of those passes cover this tree (the rest are re-run before review and shipping)` : ''}`,
    })
    checks.push(loop.testHashes === null
      ? { label: 'Tests unchanged since approval', isMet: false, note: 'no record of the tests at approval (git could not list them): a person reopens the spec (/devloop spec) and approves it again' }
      : testsRow(loop))
  }
  const regressions = Object.entries(loop.regressions ?? {})
  if (regressions.length > 0 && tier !== 'none') {
    checks.push(regressionRow(loop, regressions))
  }
  // A promoted checklist item that failed on this tree is a row of its own (D2); shadow items never reach the gate.
  // ... and one that failed on the tree a verdict read travels with that verdict wherever it carries (final round, D2 F2).
  for (const one of verdictFails(loop, coverageOf(loop, facts))) {
    checks.push({ label: `Checklist: ${one.ref}`, isMet: false, note: one.tree === loop.tree ? one.note : `failed on the reviewed tree ${short(one.tree)}, and the verdict carries here: ${one.note.replace(/^failed on this tree /, '')}` })
  }
  const evidence = loop.evidence
  const isScanned = evidence.tree === loop.tree
  // Fail safe: an open blocking finding keeps a review row unmet at every tier, whoever raised it.
  const blocking = specialistsFor(loop, cfg).filter(each => each.mode === 'blocking')
  const rows = ['general', ...blocking.map(one => one.name)]
  if (atLeast(tier, 'medium')) {
    checks.push(reviewRow(loop, cfg, 'general', 'Independent review', rows, facts))
    for (const one of blocking) {
      checks.push(reviewRow(loop, cfg, one.name, `Review: ${one.name}`, rows, facts))
    }
  } else if (openBlocking(loop.findings).length > 0) {
    checks.push(reviewRow(loop, cfg, 'general', 'Independent review', ['general'], facts))
  }
  if (tier !== 'none') {
    const hits = evidence.credentials
    // Outside git there is no diff to scan: never read as clean where a review is due.
    const isOutside = loop.tree === null
    checks.push({
      label: 'No credentials in the diff',
      isMet: isOutside ? !atLeast(tier, 'medium') : isScanned && hits.length === 0,
      note: isOutside
        ? 'not scanned: this is not a git repository, so there is no diff to scan'
        : !isScanned
        ? 'not scanned on this tree yet: the scan runs with verification'
        : hits.length === 0
          ? 'no key or token shapes in the added lines'
          : `${list(hits.map(one => `${one.file}:${one.line} (${one.kind})`))}: remove it and rotate it; the value is not shown`,
    })
  }
  if (loop.changed.some(file => matchesAny(file, cfg.tests))) {
    checks.push({ label: 'Tests changed', isMet: true, note: 'a person should read the test diff first' })
  }
  for (const file of loop.assertionDrops) {
    checks.push({ label: `Assertions removed in ${file}`, isMet: true, note: 'an edit left the file with fewer assertions: a person should read why' })
  }
  if (loop.approval !== null && loop.approval.vacuous.length > 0) {
    checks.push({ label: 'Vacuous checks at approval', isMet: true, note: `${list(loop.approval.vacuous)} already passed before any implementation; a person approved them as they were` })
  }
  const instructions = loop.changed.filter(file => matchesAny(file, instructionGlobs(cfg)))
  if (instructions.length > 0) {
    // Invisible or bidirectional-override characters have no innocent use there: they keep the gate shut (C1).
    const hidden = isScanned ? evidence.hidden.filter(one => instructions.includes(one.file)) : []
    checks.push({
      label: 'Instruction files changed',
      isMet: hidden.length === 0,
      note: hidden.length > 0
        ? `${list(hidden.map(one => `${one.file}:${one.line} (${one.kind === 'bidi' ? 'a bidirectional override' : 'invisible characters'})`))}: text a reader cannot see; remove it, then a person reads the file`
        : `a person must read ${list(instructions)}: every later session reads them`,
    })
  }
  const blast = blastReasons(loop.changed, loop.size.lines, cfg)
  if (blast.length > 0 && tier !== 'none') {
    checks.push({ label: 'Blast radius', isMet: true, note: `${blast.join('; ')}: the change is one tier riskier (${tier})` })
  }
  if (facts.policy === 'changed') {
    const mode = facts.workingMode === undefined || facts.workingMode === null ? '' : `; it sets "mode": "${facts.workingMode}", but the base branch's "${cfg.mode}" is in force`
    checks.push({ label: 'Policy changed in this change', isMet: true, note: `devloop.json differs from the base branch; the gate judges by the base branch's copy until this merges, and a person must read the change${mode}` })
  } else if (facts.policy === 'deleted') {
    checks.push({ label: 'Policy changed in this change', isMet: true, note: 'devloop.json was deleted; the base branch\'s copy stays in force for every decision until this merges, and a person must read the change' })
  } else if (facts.policy === 'no-base') {
    checks.push({ label: 'Policy', isMet: true, note: 'no devloop.json on the base branch, so the gate uses the working tree\'s copy (for every decision, not only the gate)' })
  }
  if (facts.ignoredCapped !== undefined && facts.ignoredCapped !== null) {
    checks.push({ label: 'Ignored instruction files', isMet: true, note: `${facts.ignoredCapped} instruction files git ignores matched; only the first 500 (the shallowest) are in the verified tree. Add the folders that hold the rest to "instructionsIgnore", or a person reads them` })
  }
  if (facts.lint.length > 0) {
    checks.push({ label: 'Check integrity', isMet: true, note: facts.lint.join('; ') })
  }
  if (cfg.checkEnv.mode === 'observe' && (facts.exposed ?? []).length > 0 && tier !== 'none') {
    // One short line, never the names (C2.1, live session): /devloop doctor lists them.
    const count = (facts.exposed ?? []).length
    checks.push({ label: 'Check environment', isMet: true, note: `checks could see ${count} credential-shaped variable${count === 1 ? '' : 's'}; /devloop doctor lists them` })
  }

  return checks
}

/**
 * "Regression checks" (C2): the feature checks of closed specs, run with the
 * full profile when the change ships. Met only when each has a pass on this
 * tree; a failure names the change it came from.
 */
function regressionRow(loop: Loop, regressions: readonly [string, Loop['regressions'][string]][]): Check {
  const label = 'Regression checks'
  const onTree = (one: Loop['regressions'][string]): boolean => one.tree === loop.tree
  const failing = regressions.filter(([, one]) => one.passes === false && onTree(one))
  if (failing.length > 0) {
    return { label, isMet: false, note: `failing: ${list(failing.map(([id, one]) => `${id} (from ${one.change}, spec "${one.spec}", closed ${new Date(one.closedAt).toISOString().slice(0, 10)})`), 3)}` }
  }
  const pending = regressions.filter(([, one]) => one.passes !== true || !onTree(one))
  if (pending.length > 0) {
    return { label, isMet: false, note: `${pending.length} of ${regressions.length} not run on this tree: they run with the full checks when the change ships (${list(pending.map(([id]) => id), 3)})` }
  }

  return { label, isMet: true, note: `${regressions.length} pass on this tree` }
}

/**
 * "Tests unchanged since approval": the test files whose content differs
 * from what the person approved. Met when none differs, or a person's
 * exemption covered each edit; new test files are allowed and named.
 */
function testsRow(loop: Loop): Check {
  const label = 'Tests unchanged since approval'
  const { evidence } = loop
  if (evidence.tree !== loop.tree) {
    return { label, isMet: false, note: 'not checked on this tree yet: it is checked with verification' }
  }
  const exempted = (file: string): boolean => loop.exemptionsUsed.some(glob => matches(file, glob))
  const covered = evidence.testsChanged.filter(exempted)
  const uncovered = evidence.testsChanged.filter(file => !exempted(file))
  const parts = [
    uncovered.length > 0 ? `changed since approval: ${list(uncovered)}` : 'no approved test changed',
    covered.length > 0 ? `changed under a person's exemption: ${list(covered)}` : '',
    evidence.testsAdded.length > 0 ? `new test files: ${list(evidence.testsAdded)}` : '',
  ]

  return { label, isMet: uncovered.length === 0, note: parts.filter(one => one !== '').join('; ') }
}

export const isShippable = (loop: Loop, cfg: Config, facts: GateFacts = NO_FACTS): boolean =>
  gate(loop, cfg, facts).every(check => check.isMet)

const RANK: Record<Tier, number> = { none: 0, low: 1, medium: 2, high: 3 }

export const atLeast = (tier: Tier, floor: Tier): boolean => RANK[tier] >= RANK[floor]

/** How many people must approve a merge at a tier, by the policy's `approvals`. */
export const approvalsFor = (tier: Tier, cfg: Config): number => (tier === 'none' ? 0 : cfg.approvals[tier])

/** Who must approve the merge: the part of the gate no agent meets. */
export function approvers(tier: Tier, cfg: Config): string {
  const n = approvalsFor(tier, cfg)

  return n === 0
    ? 'merge once the gate is green'
    : n === 1
      ? 'one person other than the author approves and merges'
      : `${n === 2 ? 'two' : n} people approve and merge`
}
