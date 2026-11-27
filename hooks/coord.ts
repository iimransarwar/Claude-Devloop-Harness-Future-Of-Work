// Coordination (D2, DESIGN 4.12): claims with leases for more than one
// session in a repository, and follow-ups on a pull request in code. The
// decisions are pure (hooks/claims.ts, hooks/followup.ts); this file keeps
// their records in the store and runs `gh` and the timer.

import type { Loop } from '../types'
import type { Config } from './config'
import { claimKey, lapsed, releasedAtEnd, remaining, renew, RENEW_EVERY_MS, seatOf, take, without } from './claims'
import type { Claim, Claims, Taken } from './claims'
import {
  ceilingText, cleanUntrusted, distilledLog, EMPTY_FOLLOWUPS, followStep, mayWatchAgain, needsBuilder, newWatch, parseChecks, parsePrView, PR_CHECK_FIELDS, PR_VIEW_FIELDS, rewatch, runIdOf, toastText, wakeText,
  WAKE_MAX_CHECKS,
} from './followup'
import type { Followups, PrView, Step } from './followup'
import { audit } from './journal'
import type { Actor } from './records'
import { currentBranch, git, mainRootOf, policyInForce, record } from './state'
import type { Engine, Place } from './state'

// ---------------------------------------------------------------- claims

/** The store key of a repository's claims: its main root, so worktrees of one repository share them. */
async function claimsKey($: Engine, at: Place): Promise<string> {
  return `claims:${await mainRootOf($, at)}`
}

/**
 * A repository's claims as they stand, every lapsed one marked and written to
 * the audit trail once (a renewal lapse).
 */
export async function claimsOf($: Engine, at: Place): Promise<Claims> {
  const key = await claimsKey($, at)
  const kept = ((await $.store.get(key)) as Claims | undefined) ?? {}
  const now = await $.clock.now()
  const seen = lapsed(kept, now)
  if (seen.found.length > 0) {
    await $.store.set(key, seen.claims)
    for (const one of seen.found) {
      await audit($, at.root, 'claim-lapsed', { kind: 'harness', name: null }, claimKey(one.spec, one.feature), null, `held by ${one.name}; its lease ran out with no activity to renew it`)
    }
  }

  return seen.claims
}

/** How a person tells this session apart from another: its branch and its worktree. */
async function sessionName($: Engine, at: Place): Promise<string> {
  const branch = await currentBranch($, at).catch(() => null)

  return `${branch ?? 'a detached head'} in ${at.root}`.slice(0, 200)
}

/**
 * A session's seat (final round, D2 F4): the working directory of the
 * repository it works in (its checkout or worktree). Claims belong to the
 * seat, so a new session in the same directory continues them.
 */
export const seatOfPlace = (at: Place): string => at.root

/** When this process last renewed its seat's claims, and whether the seat holds any (null: not looked yet, so a new session continues its seat's claims). */
const renewal: { at: number; holds: boolean | null } = { at: 0, holds: null }

/**
 * Claims a feature of the active spec for this session (explicitly, or at
 * its first `feature_check`): taken, renewed, taken over from a lapsed claim,
 * or refused while another session's lease is live. Every claim and takeover
 * is an audit event; a renewal is not.
 */
export async function claimFeature($: Engine, at: Place, cfg: Config, loop: Loop, feature: string, actor: Actor): Promise<Taken | null> {
  if (loop.spec === null) {
    return null
  }
  const session = (await $.session.id().catch(() => null)) ?? 'unknown'
  const key = await claimsKey($, at)
  const claims = await claimsOf($, at)
  const now = await $.clock.now()
  const taken = take(claims, loop.spec, feature, seatOfPlace(at), session, await sessionName($, at), now, cfg.claims.leaseMinutes * 60_000)
  // A refusal records the refused seat as waiting, so the holder's session end releases the claim for it.
  await $.store.set(key, taken.claims)
  if (taken.kind === 'refused') {
    return taken
  }
  renewal.at = now
  renewal.holds = true
  if (taken.kind === 'taken') {
    await audit($, at.root, 'claim-taken', actor, claimKey(loop.spec, feature), loop.tree, `by ${taken.claim.name}, a lease of ${cfg.claims.leaseMinutes} minutes`)
  } else if (taken.kind === 'retaken') {
    await audit($, at.root, 'claim-taken', actor, claimKey(loop.spec, feature), loop.tree, `re-taken by ${taken.claim.name}, the same seat, after its lease had run out; a lease of ${cfg.claims.leaseMinutes} minutes`)
  } else if (taken.kind === 'takeover') {
    await audit($, at.root, 'claim-takeover', actor, claimKey(loop.spec, feature), loop.tree, `from ${taken.from.name}, whose lease ran out; now ${taken.claim.name}`)
  }

  return taken
}

/** What the builder is told when another session holds the feature: who, and how long its lease has left. */
export const heldText = (feature: string, by: Claim, now: number): string =>
  `"${feature}" is claimed by another session (${by.name}), and its lease has ${remaining(by, now)} left. Work on a feature that is ready and not claimed (the devloop_status tool lists them); a claim that lapses can be taken over, and a person can release a live one (/devloop claims release ${feature}).`

/**
 * Any judged tool call of a session renews its live claims, at most once a
 * minute; a session that holds none reads nothing.
 */
export async function renewClaims($: Engine, at: Place, cfg: Config): Promise<void> {
  if (renewal.holds === false) {
    return
  }
  const now = await $.clock.now()
  if (now - renewal.at < RENEW_EVERY_MS) {
    return
  }
  renewal.at = now
  const seat = seatOfPlace(at)
  const key = await claimsKey($, at)
  const claims = await claimsOf($, at)
  if (!Object.values(claims).some(one => seatOf(one) === seat)) {
    renewal.holds = false

    return
  }
  renewal.holds = true
  await $.store.set(key, renew(claims, seat, now, cfg.claims.leaseMinutes * 60_000))
}

/** A new session looks once whether its seat holds claims, and continues them silently (final round, D2 F4). */
export function forgetRenewal(): void {
  renewal.at = 0
  renewal.holds = null
}

/**
 * At a session's end (final round, D2 F4): its seat's claims are released
 * only where another seat is waiting for them; the rest lapse with their
 * lease, or the seat's next session continues them. Each release is audited.
 */
export async function releaseAtSessionEnd($: Engine, at: Place): Promise<number> {
  const key = await claimsKey($, at)
  const ended = releasedAtEnd(await claimsOf($, at), seatOfPlace(at))
  if (ended.released.length === 0) {
    return 0
  }
  await $.store.set(key, ended.claims)
  for (const one of ended.released) {
    await audit($, at.root, 'claim-released', { kind: 'harness', name: null }, claimKey(one.spec, one.feature), null, `held by ${one.name}; released at its session's end because another seat was waiting (${(one.waiting ?? []).join(', ')})`)
  }

  return ended.released.length
}

/**
 * Gives a claim up: the seat's own (`devloop_release`), or any (a
 * person's `/devloop claims release`). Resolves to the claim dropped, or null.
 */
export async function releaseClaim($: Engine, at: Place, spec: string, feature: string, actor: Actor, onlySeat: string | null): Promise<Claim | null> {
  const key = await claimsKey($, at)
  const claims = await claimsOf($, at)
  const one = claims[claimKey(spec, feature)]
  if (one === undefined || (onlySeat !== null && seatOf(one) !== onlySeat)) {
    return null
  }
  await $.store.set(key, without(claims, each => each === one))
  await audit($, at.root, 'claim-released', actor, claimKey(spec, feature), null, `held by ${one.name}${onlySeat === null ? '; released by a person' : ''}`)

  return one
}

/** Closing or reopening a spec clears its claims: each one released is an audit event. */
export async function clearSpecClaims($: Engine, at: Place, spec: string, actor: Actor, why: string): Promise<number> {
  const key = await claimsKey($, at)
  const claims = await claimsOf($, at)
  const gone = Object.values(claims).filter(one => one.spec === spec)
  if (gone.length === 0) {
    return 0
  }
  await $.store.set(key, without(claims, one => one.spec === spec))
  for (const one of gone) {
    await audit($, at.root, 'claim-released', actor, claimKey(one.spec, one.feature), null, `held by ${one.name}; ${why}`)
  }

  return gone.length
}

// ---------------------------------------------------------------- follow-ups

const GH_READY = `
# devloop:gh-ready
command -v gh >/dev/null 2>&1 || { echo "gh:missing"; exit 0; }
gh auth status >/dev/null 2>&1 || { echo "gh:unauthenticated"; exit 0; }
echo "gh:ok"
`

const GH_PR_VIEW = `
# devloop:gh-pr-view
if [ -n "$1" ]; then gh pr view "$1" --json "$2"; else gh pr view --json "$2"; fi
`

const GH_PR_CHECKS = `
# devloop:gh-pr-checks
gh pr checks "$1" --json "$2"
code=$?
[ "$code" -eq 8 ] && exit 0
exit "$code"
`

const GH_RUN_LOG = `
# devloop:gh-run-log
gh run view "$1" --log-failed 2>/dev/null | tail -n 400
`

/** Whether `gh` can be used here, as last asked in this process: `ok`, `missing` or `unauthenticated` (null before). */
let ghState: 'ok' | 'missing' | 'unauthenticated' | null = null

/** Asks once per process whether `gh` is installed and signed in: the follow-ups are silently off otherwise (doctor says why). */
export async function ghStatus($: Engine, at: Place): Promise<'ok' | 'missing' | 'unauthenticated'> {
  if (ghState === null) {
    const ran = await git($, at, GH_READY, [], 15_000)
    const said = /gh:(ok|missing|unauthenticated)/.exec(ran?.out ?? '')?.[1]
    ghState = said === 'ok' || said === 'unauthenticated' ? said : 'missing'
  }

  return ghState
}

const followKey = (root: string): string => `followups:${root}`

async function followupsOf($: Engine, root: string): Promise<Followups> {
  const kept = (await $.store.get(followKey(root))) as Followups | undefined

  return kept === undefined || !Array.isArray(kept.watches) ? EMPTY_FOLLOWUPS : kept
}

/** A repository's watches as kept, for /devloop followups. */
export async function followupsFor($: Engine, root: string): Promise<Followups> {
  return followupsOf($, root)
}

/** The pull request a branch (or a number) names, as `gh pr view` gives it; null when there is none or `gh` failed. */
async function prView($: Engine, at: Place, which: string): Promise<PrView | null> {
  const ran = await git($, at, GH_PR_VIEW, [which, PR_VIEW_FIELDS], 30_000)

  return ran === null || ran.code !== 0 ? null : parsePrView(ran.out)
}

/** The timer that polls, while any watch lives in this process, and the repositories it polls. */
const follow: { timer: { cancel: () => void } | null; roots: Map<string, Place> } = { timer: null, roots: new Map() }

/** Stops the polling of this process (the session ended); the watches stay in the store for a later session. */
export function stopFollowTimer(): void {
  follow.timer?.cancel()
  follow.timer = null
  follow.roots.clear()
  ghState = null
}

/** Starts the timer when none runs: one poll per `followUp.intervalSec`, each poll scheduling the next while a watch lives. */
function ensureTimer($: Engine, intervalSec: number): void {
  if (follow.timer !== null) {
    return
  }
  follow.timer = $.clock.after(intervalSec * 1000, () => {
    follow.timer = null
    void pollAll($).catch(() => undefined)
  })
}

/** One poll of every repository with a live watch in this process, then the next poll is scheduled if any watch lives. */
async function pollAll($: Engine): Promise<void> {
  let interval: number | null = null
  for (const at of [...follow.roots.values()]) {
    const cfg = (await policyInForce($, at).catch(() => null))?.cfg ?? null
    if (cfg === null || !cfg.followUp.ci) {
      follow.roots.delete(at.root)
      continue
    }
    const isLive = await pollRoot($, at)
    if (isLive) {
      interval = Math.min(interval ?? cfg.followUp.intervalSec, cfg.followUp.intervalSec)
    } else {
      follow.roots.delete(at.root)
    }
  }
  if (interval !== null) {
    ensureTimer($, interval)
  }
}

/** Polls a repository's live watches: what needs the builder wakes it (a queued prompt) and toasts the person. Resolves whether any watch still lives. */
async function pollRoot($: Engine, at: Place): Promise<boolean> {
  const state = await followupsOf($, at.root)
  const now = await $.clock.now()
  const steps: Step[] = []
  const watches = []
  for (const watch of state.watches) {
    if (watch.status !== 'watching') {
      watches.push(watch)
      continue
    }
    const view = await prView($, at, String(watch.pr))
    const checks = await git($, at, GH_PR_CHECKS, [String(watch.pr), PR_CHECK_FIELDS], 30_000)
    const step = followStep(watch, view, checks === null ? null : parseChecks(checks.out), now)
    steps.push(step)
    watches.push(step.watch)
  }
  await $.store.set(followKey(at.root), { watches, polls: state.polls + 1 } satisfies Followups)
  for (const step of steps) {
    if (step.end !== null) {
      await record($, at.root, 'followup-ended', `#${step.watch.pr}`, step.end).catch(() => undefined)
    }
    // A ceiling reached (its life, or its wakes) ends the watch, and the person is told (final round, D2 F6).
    if (step.end === 'timeout' || step.end === 'wake limit') {
      $.ui.toast(ceilingText(step.watch), { timeoutMs: 15_000 })
    }
    if (!needsBuilder(step)) {
      continue
    }
    const logs: Record<string, string> = {}
    for (const one of step.failing.slice(0, WAKE_MAX_CHECKS)) {
      const run = runIdOf(one.link)
      const log = run === null ? null : await git($, at, GH_RUN_LOG, [run], 60_000)
      logs[one.name] = log === null || log.code !== 0 ? '' : distilledLog(log.out)
    }
    if (step.failing.length > 0) {
      await record($, at.root, 'followup-check-failed', cleanUntrusted(step.failing.map(one => one.name).join(', '), 60), `#${step.watch.pr}`).catch(() => undefined)
    }
    $.ui.toast(toastText(step), { timeoutMs: 15_000 })
    // Wakes the builder with a turn of its own once the session is idle; nothing waited for it.
    void $.prompt.submit({ text: wakeText(step, logs) }).catch(() => undefined)
  }

  return watches.some(one => one.status === 'watching')
}

/**
 * After a shipping command that created or updated a pull request returned
 * without error: the pull request for the branch, when `gh` is installed and
 * signed in and `followUp.ci` is on, is watched (or watched again after
 * another push). Silent when `gh` cannot be used or there is no open pull
 * request.
 */
export async function watchAfterShip($: Engine, at: Place, cfg: Config): Promise<void> {
  if (!cfg.followUp.ci || (await ghStatus($, at)) !== 'ok') {
    return
  }
  const view = await prView($, at, '')
  if (view === null || view.state !== 'OPEN') {
    return
  }
  const state = await followupsOf($, at.root)
  const now = await $.clock.now()
  // The latest watch of this pull request: a live one is told of the push (its life and wakes are not extended, D2 F6); one a
  // ceiling or a person ended is not watched again; one that ended otherwise (the change closed) gives way to a new watch.
  const known = [...state.watches].reverse().find(one => one.pr === view.number)
  const n = state.watches.reduce((max, one) => Math.max(max, one.n), 0) + 1
  if (known !== undefined && known.status === 'ended' && !mayWatchAgain(known)) {
    return
  }
  const watches = known === undefined || known.status === 'ended'
    ? [...state.watches, newWatch(view, n, now, cfg.followUp.timeoutMin)].slice(-50)
    : state.watches.map(one => (one === known ? rewatch(one, view) : one))
  await $.store.set(followKey(at.root), { ...state, watches } satisfies Followups)
  follow.roots.set(at.root, at)
  ensureTimer($, cfg.followUp.intervalSec)
}

/**
 * At a session's start: the watches an earlier session left are resumed
 * (those past their timeout end), when `gh` can be used.
 */
export async function resumeFollowups($: Engine, at: Place, cfg: Config): Promise<void> {
  const state = await followupsOf($, at.root)
  if (!state.watches.some(one => one.status === 'watching') || !cfg.followUp.ci || (await ghStatus($, at)) !== 'ok') {
    return
  }
  follow.roots.set(at.root, at)
  ensureTimer($, cfg.followUp.intervalSec)
}

/** Ends watches: every live one (the change was closed), or one by its number (a person stopped it). Resolves how many ended. */
export async function endWatches($: Engine, at: Place, why: string, n: number | null): Promise<number> {
  const state = await followupsOf($, at.root)
  const now = await $.clock.now()
  let count = 0
  const watches = state.watches.map(one => {
    if (one.status !== 'watching' || (n !== null && one.n !== n)) {
      return one
    }
    count += 1

    return { ...one, status: 'ended' as const, ended: why, endedAt: now }
  })
  if (count > 0) {
    await $.store.set(followKey(at.root), { ...state, watches } satisfies Followups)
  }

  return count
}
