// The loop limit's work in the module (docs/design-notes/loop-limits.md,
// DESIGN 4.16): counting a failed round on the branch checked out, the
// message at the limit (once), the last commit that passed the gate, and
// `/devloop continue`. The words and the decisions are pure, in limits.ts.

import type { CommandRunInput, CommandRunResult } from 'claude-code'

import type { FailedRound, LoopLimit } from '../types'
import type { Config } from './config'
import { isShippable } from './gate'
import { actorOf, audit, isFromPerson } from './journal'
import { allowMore, countRound, isAtLimit, limitMessage, limitOf, limitOn, limitToast, mostNamed, withLastPass } from './limits'
import { limitLesson } from './autolearn'
import { factsOf, loopOf, note, policyInForce, record, recordLesson, save } from './state'
import type { Engine, Place, Snapshot } from './state'

/** The limit's record for the branch checked out, as stored (a record of another branch reads as fresh). */
export async function limitNow($: Engine, branch: string | null): Promise<LoopLimit> {
  return limitOn((await loopOf($)).limit, branch)
}

/** Counts one failed round on the branch checked out (decision 1); resolves to the record after it. */
export async function countFailedRound($: Engine, root: string, branch: string | null, round: Omit<FailedRound, 'at'>): Promise<LoopLimit> {
  const now = await $.clock.now()
  const next = await save($, root, before => ({ ...before, limit: countRound(limitOn(before.limit, branch), { ...round, at: now }) }))

  return next.limit
}

/**
 * The limit's message, once per limit (decision 2): when the branch is at
 * its limit and the message was not given yet, the person gets a toast, the
 * ledger, the audit trail and the Activity tab a record, and the message is
 * returned in enforce mode for the caller to add to the turn (in observe
 * mode, null: the toast and the record only). Null otherwise.
 */
export async function reachLimit($: Engine, at: Place, cfg: Config, branch: string | null): Promise<string | null> {
  const limit = await limitNow($, branch)
  if (!isAtLimit(limit, cfg) || limit.isTold) {
    return null
  }
  const now = await $.clock.now()
  const top = mostNamed(limit.rounds)
  const said = `${limit.failed} failed rounds on ${branch ?? 'a detached head'} without a person${top === null ? '' : `; the file named most often in their findings: ${top.file} (${top.count} rounds)`}`
  await save($, at.root, before => note({ ...before, limit: { ...limitOn(before.limit, branch), isTold: true } }, 'info', `loop limit (${cfg.mode}): ${said}`, now))
  $.ui.toast(limitToast(limit, cfg.mode), { timeoutMs: 15_000 })
  await record($, at.root, 'loop-limit', branch ?? '(detached)', said)
  await audit($, at.root, 'loop-limit', { kind: 'harness', name: null }, branch ?? '(detached)', (await loopOf($)).tree, `${cfg.mode} mode: ${said}`)
  // The lesson the harness writes itself (DESIGN 4.17, decision 1): one per branch, its count raised when the limit stops it again.
  if (cfg.learning.auto !== 'off') {
    const lesson = limitLesson(branch, limit)
    await recordLesson($, at.root, lesson.key, lesson.detail)
  }

  return cfg.mode === 'enforce' ? limitMessage(limit, cfg) : null
}

/**
 * Whether a review this caller starts is refused by the limit (decision 2):
 * in enforce mode, at the limit, unless a person started it. The refusal is
 * the limit's message; null lets it start.
 */
export async function limitRefusal($: Engine, cfg: Config, branch: string | null, isPerson: boolean): Promise<string | null> {
  const limit = await limitNow($, branch)

  return cfg.mode === 'enforce' && !isPerson && isAtLimit(limit, cfg) ? limitMessage(limit, cfg) : null
}

/**
 * Records the newest commit on the branch for which the gate was fully met
 * (decision 4): HEAD, when the work is committed as it is (HEAD's tree is the
 * committable one), the loop holds this tree, and every row is met by the
 * policy in force.
 */
export async function notePassing($: Engine, at: Place, snap: Snapshot): Promise<void> {
  if (snap.tree === null || snap.head === null || snap.committable === null || snap.committable !== snap.headTree) {
    return
  }
  const policy = await policyInForce($, at, snap)
  const loop = await loopOf($)
  if (policy === null || loop.tree !== snap.tree || !isShippable(loop, policy.cfg, factsOf(at, policy))) {
    return
  }
  const head = snap.head
  if (limitOn(loop.limit, snap.branch).lastPass !== head) {
    await save($, at.root, before => ({ ...before, limit: withLastPass(limitOn(before.limit, snap.branch), head) }))
  }
}

/**
 * `/devloop continue [n]` (decision 3): a person allows `n` more failed
 * rounds on this branch (by default the policy's number); who and when go to
 * the audit trail. An agent's call is refused, as for every key a person holds.
 */
export async function continueCommand($: Engine, at: Place, cfg: Config, branch: string | null, arg: string, e: CommandRunInput): Promise<CommandRunResult> {
  if (!isFromPerson(e)) {
    return { text: 'More failed rounds are allowed by a person, from the prompt.' }
  }
  if (cfg.loop.failedRounds === 0) {
    return { text: 'The loop limit is off ("loop": { "failedRounds": 0 }), so there is nothing to allow.' }
  }
  const n = arg.trim() === '' ? cfg.loop.failedRounds : Number(arg.trim())
  if (!Number.isInteger(n) || n < 1 || n > 100) {
    return { text: 'Name how many more failed rounds to allow, from 1 to 100: /devloop continue [n].' }
  }
  const before = await limitNow($, branch)
  const now = await $.clock.now()
  await save($, at.root, loop => note({ ...loop, limit: allowMore(limitOn(loop.limit, branch), n) }, 'info', `a person allowed ${n} more failed rounds on ${branch ?? 'a detached head'}`, now))
  await audit($, at.root, 'loop-continued', actorOf(e), branch ?? '(detached)', (await loopOf($)).tree, `${n} more failed rounds; ${before.failed} counted before, of ${limitOf(before, cfg)}`)

  return {
    text: `${n} more failed round${n === 1 ? '' : 's'} allowed on ${branch ?? 'this detached head'}; the count starts again.`,
    context: [`The person allowed ${n} more failed rounds on this branch (/devloop continue): you may fix and review again.`],
  }
}
