// Shipping: what stands between a command that ships and the gate, and the
// on-demand proof the gate runs (the builder cannot run /devloop verify), which
// /devloop gate shares.

import type { Loop } from '../types'
import type { Config } from './config'
import { pushesToDefault, pushSends, shippingOf, shipRules } from './enforce'
import { gate, isShippable, tierFor } from './gate'
import type { Check, GateFacts } from './gate'
import { shipsOf } from './rules'
import type { Verdict } from './rules'
import { runRegressions } from './regress'
import { startReview } from './review'
import { notePassing } from './rounds'
import { factsOf, loopOf, pushRange, refresh, runFeatures, save, snapshotInForce, verifyNow, withSnapshot } from './state'
import type { Engine, Place } from './state'

export type Proven = {
  loop: Loop
  /** The policy in force: the base branch's, whole. */
  judging: Config
  facts: GateFacts
  rows: Check[]
  /** The approved spec changed on disk, so no feature counts. */
  isSpecChanged: boolean
}

/**
 * Proves what the gate can on the tree as it stands: every check of the base
 * branch's policy that has no pass on this tree runs (a failure on this very
 * tree is not run again, and a change with no files runs none), every
 * feature pass that does not cover the tree runs again, and the evidence
 * rows are proven.
 */
export async function prove($: Engine, at: Place): Promise<Proven> {
  const found = await snapshotInForce($, at)
  if (found === null) {
    throw new Error('the repository has not opted in')
  }
  const { snap, policy } = found
  const judging = policy.cfg
  const before = await save($, at.root, loop => withSnapshot(loop, snap, judging))
  const isFailedHere = snap.tree === before.verify.tree && before.verify.status === 'fail'
  const isEmpty = tierFor(before, judging) === 'none' && before.isBaseKnown
  if (judging.verify.length > 0 && !isFailedHere && !isEmpty) {
    await verifyNow($, at, judging, 'full')
  } else {
    await refresh($, at, judging)
  }
  let isSpecChanged = false
  if (before.phase === 'build') {
    isSpecChanged = (await runFeatures($, at, judging, null)) === null
  }
  // The regression checks of closed specs run with the full profile here (C2).
  if (!isEmpty) {
    await runRegressions($, at, judging, snap.tree)
  }
  // The newest commit for which the gate was fully met (DESIGN 4.16, decision 4).
  if (!isSpecChanged) {
    await notePassing($, at, snap).catch(() => undefined)
  }
  const loop = await loopOf($)
  // The time, so a held push says how long a background run has gone.
  const facts = { ...factsOf(at, policy), now: await $.clock.now() }

  return { loop, judging, facts, rows: gate(loop, judging, facts), isSpecChanged }
}

/** Whether every unmet row is a review that has not run: the one thing an automatic round can fix. */
const isOnlyUnreviewed = (loop: Loop, rows: readonly Check[]): boolean => {
  const open = rows.filter(row => !row.isMet)

  return open.length > 0 && loop.review.status === 'none' && !loop.review.isStalled && open.every(row => row.label === 'Independent review' || row.label.startsWith('Review: '))
}

/**
 * What stands between a shell command that ships and the gate, or null to
 * let it run. Merging is a person's; a push to the default branch is judged
 * on what it would land; everything else ships only through a green gate,
 * judged by the base branch's policy. When the only thing missing is a
 * review and `autoReview` is on, the gate starts the round itself.
 */
export async function judgeShipping($: Engine, at: Place, text: string): Promise<Verdict> {
  if (shipsOf(text).length === 0) {
    return null
  }
  const found = await snapshotInForce($, at)
  if (found === null) {
    return null
  }
  const { snap, policy } = found
  const judging = policy.cfg
  // A merge ships only on the default branch (or possibly on it, after a switch the model cannot follow);
  // a merge on a feature branch brings work in.
  const intents = shippingOf(text, snap.branch, judging.defaultBranch)
  if (intents.length === 0) {
    return null
  }
  const loop = await save($, at.root, before => withSnapshot(before, snap, judging))
  // Merging, another branch, a push to the default branch: the rules the classic hook shares (hooks/enforce.ts).
  const ranges: Record<string, string[] | null> = {}
  for (const source of pushesToDefault(intents, snap.branch, judging.defaultBranch)) {
    ranges[source] = await pushRange($, at, judging, source)
  }
  const before = shipRules(intents, snap.branch, judging, tierFor(loop, judging), ranges)
  if (before !== null) {
    return before
  }
  // The gate judges the tree, a push sends commits (final round, D1 F4): a push goes only when they are the same thing.
  if (intents.some(one => one.kind === 'push')) {
    const sends = pushSends(snap.committable, [{ tree: snap.headTree, isHead: true }], snap)
    if (sends !== null) {
      return sends
    }
  }
  if (tierFor(loop, judging) === 'none' && loop.isBaseKnown) {
    return null
  }
  const proven = await prove($, at)
  if (proven.isSpecChanged) {
    return { rule: 'gate', reason: 'The spec or its feature list changed after it was approved, so no feature counts as passing. A person must reopen it (/devloop spec) and approve it again.' }
  }
  if (isShippable(proven.loop, proven.judging, proven.facts)) {
    return null
  }
  // DESIGN 9.2: an unattended run is not stranded on a review only a person could start.
  if (proven.judging.autoReview && isOnlyUnreviewed(proven.loop, proven.rows)) {
    const started = await startReview($, at, true)
    if ((await loopOf($)).review.status === 'running') {
      return { rule: 'gate', reason: `The gate is green but for the review, which had not run, so the harness started one: ${started} Retry this command after its verdict (the devloop_status tool shows it).` }
    }
  }
  const open = proven.rows.filter(check => !check.isMet).map(check => `${check.label} (${check.note})`).join('; ')

  return { rule: 'gate', reason: `The gate is not green, so nothing ships yet. Still needed: ${open}.` }
}
