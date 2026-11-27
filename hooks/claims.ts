// Claims with leases (D2, coordination note 5, folded into DESIGN 4.12): when
// more than one session works in a repository (typically separate worktrees
// of it, sharing the plugin's store), a session claims a feature of the
// active spec before it works on it, and the claim lives as long as that
// session's activity renews it. The decisions are pure here; hooks/coord.ts
// keeps the claims in the store, keyed by the repository's main root. Pure:
// no `$`.

import type { Loop } from '../types'
import { dependencyOrder, missingDeps } from './spec'

/** One seat's claim on one feature of a spec. */
export type Claim = {
  spec: string
  feature: string
  /**
   * Who holds it (final round, D2 F4): the seat, a working directory of the
   * repository (a checkout or a worktree). A new session in the same
   * directory continues its predecessor's claims.
   */
  seat: string
  /** The session that last took or renewed it (its engine id): for the audit trail only, never who holds it. */
  session: string
  /** Other seats refused this claim while it was live: at its holder's session end it is released for them. */
  waiting?: string[]
  /** How a person tells the session apart: its worktree and branch. */
  name: string
  /** When it was taken, last renewed, and when it lapses unless renewed. */
  at: number
  renewedAt: number
  until: number
  /** When the harness first saw it lapsed (its audit event is written once). */
  lapsedAt?: number | null
}

/** Every claim of a repository, by `<spec>/<feature>`. */
export type Claims = Record<string, Claim>

/** How often a session's activity renews its claims, at most. */
export const RENEW_EVERY_MS = 60_000

export const claimKey = (spec: string, feature: string): string => `${spec}/${feature}`

/** Whether a claim still holds: its lease has not run out. */
export const isLive = (claim: Claim, now: number): boolean => now < claim.until

/** How long a lease has left, in words. */
export function remaining(claim: Claim, now: number): string {
  const minutes = Math.max(0, Math.ceil((claim.until - now) / 60_000))

  return minutes <= 1 ? 'under a minute' : `${minutes} minutes`
}

/** What a feature is to one session: passing on this tree, ready, claimed by it, claimed by another, or waiting on a dependency. */
export type FeatureState = 'passing' | 'ready' | 'yours' | 'theirs' | 'waiting'

/** A claim's seat: kept since the final round; for a claim kept before it, the folder its name ends with (`<branch> in <folder>`). */
export const seatOf = (claim: Pick<Claim, 'name'> & { seat?: string }): string => claim.seat ?? claim.name.slice(claim.name.lastIndexOf(' in ') + 4)

/** Whether another seat holds any live claim in this repository: the only case in which claims are shown at all (one seat sees nothing of them). */
export const hasOthers = (claims: Claims, seat: string | null, now: number): boolean =>
  Object.values(claims).some(one => isLive(one, now) && seatOf(one) !== seat)

/** Each approved feature's state for one seat, in dependency order. */
export function featureStates(loop: Loop, claims: Claims, seat: string | null, now: number): { id: string; state: FeatureState; claim: Claim | null }[] {
  return dependencyOrder(loop).map(id => {
    const status = loop.features[id]
    const claim = loop.spec === null ? null : claims[claimKey(loop.spec, id)] ?? null
    const live = claim !== null && isLive(claim, now) ? claim : null
    if (status !== undefined && status.passes && status.tree === loop.tree) {
      return { id, state: 'passing' as const, claim: live }
    }
    if (live !== null && seatOf(live) !== seat) {
      return { id, state: 'theirs' as const, claim: live }
    }
    if (live !== null) {
      return { id, state: 'yours' as const, claim: live }
    }

    return { id, state: missingDeps(loop, id).length === 0 ? 'ready' as const : 'waiting' as const, claim: null }
  })
}

/**
 * The features ready to build for this session, in dependency order: not
 * passing on this tree, every dependency passing on it, and not under
 * another session's live claim (its own claims are ready to it).
 */
export const readyFor = (loop: Loop, claims: Claims, seat: string | null, now: number): string[] =>
  featureStates(loop, claims, seat, now).filter(one => one.state === 'ready' || one.state === 'yours').map(one => one.id)

/** The claims lines the status tool and the briefing show; empty when no other session holds a claim (a single session sees none). */
export function claimLines(loop: Loop, claims: Claims, seat: string | null, now: number): string[] {
  if (loop.spec === null || loop.phase !== 'build' || !hasOthers(claims, seat, now)) {
    return []
  }
  const states = featureStates(loop, claims, seat, now)
  const pick = (state: FeatureState): string[] => states.filter(one => one.state === state).map(one => one.id)
  const theirs = states.filter(one => one.state === 'theirs').map(one => `${one.id} (by ${one.claim?.name ?? '?'}, ${one.claim === null ? '' : remaining(one.claim, now)} left)`)

  return [
    `Features, with the other sessions' claims: ready ${pick('ready').join(', ') || 'none'}; claimed by another session ${theirs.join(', ') || 'none'}; claimed by you ${pick('yours').join(', ') || 'none'}; passing ${pick('passing').join(', ') || 'none'}${pick('waiting').length > 0 ? `; waiting on a dependency ${pick('waiting').join(', ')}` : ''}.`,
  ]
}

/** What taking a claim does: taken anew, renewed, re-taken by its own seat after it lapsed, taken over from another seat's lapsed claim, or refused (another seat's is live; the refused seat is recorded as waiting). */
export type Taken =
  | { kind: 'taken' | 'renewed' | 'retaken'; claims: Claims; claim: Claim }
  | { kind: 'takeover'; claims: Claims; claim: Claim; from: Claim }
  | { kind: 'refused'; claims: Claims; by: Claim }

/** One seat claims one feature, under a lease of `leaseMs`; `session` is recorded for the audit trail. */
export function take(claims: Claims, spec: string, feature: string, seat: string, session: string, name: string, now: number, leaseMs: number): Taken {
  const key = claimKey(spec, feature)
  const before = claims[key]
  const claim: Claim = { spec, feature, seat, session, name, at: now, renewedAt: now, until: now + leaseMs, lapsedAt: null }
  if (before === undefined) {
    return { kind: 'taken', claims: { ...claims, [key]: claim }, claim }
  }
  if (seatOf(before) === seat) {
    // The same seat, in this session or a later one: it continues its claim. One that lapsed is re-taken (an audit event).
    const renewed: Claim = { ...before, seat, session, name, renewedAt: now, until: now + leaseMs, lapsedAt: null }

    return { kind: isLive(before, now) ? 'renewed' : 'retaken', claims: { ...claims, [key]: renewed }, claim: renewed }
  }
  if (isLive(before, now)) {
    const waiting = [...new Set([...(before.waiting ?? []), seat])].slice(-10)

    return { kind: 'refused', claims: { ...claims, [key]: { ...before, waiting } }, by: before }
  }

  return { kind: 'takeover', claims: { ...claims, [key]: claim }, claim, from: before }
}

/** A seat's activity renews every live claim it holds; one that already lapsed is not brought back (it must be claimed again). */
export function renew(claims: Claims, seat: string, now: number, leaseMs: number): Claims {
  return Object.fromEntries(Object.entries(claims).map(([key, one]) => [key, seatOf(one) === seat && isLive(one, now) ? { ...one, renewedAt: now, until: now + leaseMs } : one]))
}

/**
 * At a session's end (final round, D2 F4): its seat's claims that another
 * seat is waiting for are released; the rest stay, to lapse with their lease
 * or be continued by the seat's next session.
 */
export function releasedAtEnd(claims: Claims, seat: string): { claims: Claims; released: Claim[] } {
  const released = Object.values(claims).filter(one => seatOf(one) === seat && (one.waiting ?? []).some(other => other !== seat))

  return { claims: released.length === 0 ? claims : without(claims, one => released.includes(one)), released }
}

/** Claims that lapsed and were not yet seen lapsed: each gets one audit event, and is marked. */
export function lapsed(claims: Claims, now: number): { claims: Claims; found: Claim[] } {
  const found = Object.values(claims).filter(one => !isLive(one, now) && (one.lapsedAt === undefined || one.lapsedAt === null))

  return {
    claims: found.length === 0 ? claims : Object.fromEntries(Object.entries(claims).map(([key, one]) => [key, found.includes(one) ? { ...one, lapsedAt: now } : one])),
    found,
  }
}

/** Drops one claim, or every claim of a spec (closing or reopening it). */
export const without = (claims: Claims, match: (one: Claim) => boolean): Claims =>
  Object.fromEntries(Object.entries(claims).filter(([, one]) => !match(one)))
