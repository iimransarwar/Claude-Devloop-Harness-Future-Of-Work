// The loop limit and targeted testing (docs/design-notes/loop-limits.md,
// DESIGN 4.16), as pure functions: the failed-round count on a branch and
// the message at its limit, the key a check's pass is kept against, the
// order checks run in, and the words the person and the builder read. The
// module (hooks/register.tsx, hooks/review.ts, hooks/state.ts) counts and
// enforces; the classic hooks and the command line keep nothing between
// calls and say nothing about the limit. Pure: no `$`, no Node.

import type { FailedRound, LoopLimit } from '../types'
import type { Config, Step } from './config'
import { digest } from './output'
import { backgroundFor, matchesAny, stepsFor } from './rules'

// ---------------------------------------------------------------- the loop limit (part 1)

/** The record of a branch no round has failed on. */
export const NO_LIMIT: LoopLimit = { branch: null, failed: 0, grant: null, isTold: false, rounds: [], lastPass: null }

/** How many failed rounds the record keeps for the Activity tab and the message. */
export const ROUNDS_KEPT = 20

/** How many of the failed rounds' findings must name one file before it is named (decision 2). */
export const MOST_NAMED_AT = 3

/**
 * The record for the branch checked out (decision 1): the stored one when it
 * is this branch's, else a fresh one, so a new branch starts at zero. A
 * record from before this field existed reads as fresh.
 */
export function limitOn(limit: LoopLimit | undefined, branch: string | null): LoopLimit {
  return limit !== undefined && limit.branch === branch ? limit : { ...NO_LIMIT, branch }
}

/** The number of failed rounds the limit stands at: what a person allowed, else the policy's; 0 when the policy turns it off. */
export function limitOf(limit: LoopLimit, cfg: Pick<Config, 'loop'>): number {
  return cfg.loop.failedRounds === 0 ? 0 : limit.grant ?? cfg.loop.failedRounds
}

/** Whether the branch is at its limit: a limit in force, and that many failed rounds since a person last allowed more. */
export function isAtLimit(limit: LoopLimit, cfg: Pick<Config, 'loop'>): boolean {
  const n = limitOf(limit, cfg)

  return n > 0 && limit.failed >= n
}

/** One failed round counted (decision 1): a round that passes is never counted, and shipping does not reset the count. */
export function countRound(limit: LoopLimit, round: FailedRound): LoopLimit {
  return { ...limit, failed: limit.failed + 1, rounds: [...limit.rounds, { ...round, what: round.what.slice(0, 200), files: round.files.slice(0, 20) }].slice(-ROUNDS_KEPT) }
}

/** A person allows `n` more failed rounds (decision 3): the count starts again, and the message may be given once more. */
export function allowMore(limit: LoopLimit, n: number): LoopLimit {
  return { ...limit, failed: 0, grant: n, isTold: false, rounds: [] }
}

/** The newest commit on the branch for which the gate was fully met (decision 4). */
export const withLastPass = (limit: LoopLimit, commit: string): LoopLimit => (limit.lastPass === commit ? limit : { ...limit, lastPass: commit })

/** The file the failed rounds' findings name most often, when one accounts for three or more of them. */
export function mostNamed(rounds: readonly FailedRound[]): { file: string; count: number } | null {
  const counts = new Map<string, number>()
  for (const one of rounds) {
    for (const file of new Set(one.files.filter(each => each !== ''))) {
      counts.set(file, (counts.get(file) ?? 0) + 1)
    }
  }
  const [top] = [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))

  return top === undefined || top[1] < MOST_NAMED_AT ? null : { file: top[0], count: top[1] }
}

/** The last commit that passed, as the message names it. */
const lastPassText = (limit: LoopLimit): string => (limit.lastPass === null ? 'none on this branch' : `\`${limit.lastPass.slice(0, 12)}\``)

/**
 * The message at the limit (decision 2): given once per limit, added to the
 * turn that is allowed to end, and the refusal of a review the agent or
 * auto-review starts there.
 */
export function limitMessage(limit: LoopLimit, cfg: Pick<Config, 'loop'>): string {
  const more = cfg.loop.failedRounds

  return [
    `devloop: Loop limit: ${limit.failed} failed round${limit.failed === 1 ? '' : 's'} on this branch without a person. Stop now.`,
    'Do not start another fix or review. Report in a few lines: what failed',
    `each time, what you tried, and the choices: (1) use the last commit that passed the gate (${lastPassText(limit)}), (2) accept the open findings as known gaps, (3) \`/devloop continue\` for ${more} more rounds.`,
  ].join(' ')
}

/** What the person is told at the limit: a toast. */
export const limitToast = (limit: LoopLimit, mode: Config['mode']): string =>
  mode === 'observe'
    ? `devloop (observe): ${limit.failed} failed rounds on this branch; in enforce mode devloop would stop here`
    : `devloop stopped after ${limit.failed} failed rounds`

/** One failed round as the Activity tab lists it. */
const roundLine = (one: FailedRound): string => `${one.kind === 'fix' ? 'fix round' : 'review'}: ${one.what}${one.files.length > 0 ? ` (${one.files.slice(0, 3).join(', ')}${one.files.length > 3 ? ', …' : ''})` : ''}`

/** The failed rounds on this branch, for the Activity tab (decision 2) and doctor (decision 5): empty when none was counted. */
export function limitLines(limit: LoopLimit, cfg: Pick<Config, 'loop'>): string[] {
  if (limit.failed === 0) {
    return []
  }
  const n = limitOf(limit, cfg)
  const top = mostNamed(limit.rounds)

  return [
    `Failed rounds on this branch: ${limit.failed}${n === 0 ? ' (the limit is off)' : ` of ${n}`}${isAtLimit(limit, cfg) ? ': at the limit, a person decides (/devloop continue [n])' : ''}`,
    ...limit.rounds.map(roundLine),
    ...(top === null ? [] : [`The file named most often in their findings: ${top.file} (${top.count} rounds)`]),
  ]
}

/** Doctor's line on the limit in force and the count (decision 5). */
export function limitDoctor(limit: LoopLimit, cfg: Pick<Config, 'loop'>, branch: string | null): string {
  const on = limitOn(limit, branch)
  const n = limitOf(on, cfg)
  if (n === 0) {
    return `loop limit: off ("loop": { "failedRounds": 0 }); ${on.failed} failed round${on.failed === 1 ? '' : 's'} counted on this branch`
  }

  return `loop limit: ${n} failed rounds on a branch without a person${on.grant === null ? '' : ' (allowed by /devloop continue)'}; ${on.failed} counted on ${branch ?? 'this detached head'}${isAtLimit(on, cfg) ? ': at the limit, /devloop continue [n] allows more' : ''}; the last commit that passed the gate: ${on.lastPass === null ? 'none on this branch' : on.lastPass.slice(0, 12)}`
}

// ---------------------------------------------------------------- targeted testing (part 2)

/**
 * The key of the content of the files a check's globs match (decision 7):
 * from a listing of the tree as `git ls-tree -r` prints it (`<mode> <type>
 * <object>\t<path>`), the lines whose path matches, sorted, hashed. Null
 * when none matches or the listing is empty: nothing to key a pass by, so
 * the check runs as before.
 */
export function coveredKey(listing: string, globs: readonly string[]): string | null {
  const lines = listing.split('\n').filter(line => {
    const tab = line.indexOf('\t')

    return tab > 0 && matchesAny(line.slice(tab + 1), globs)
  })

  return lines.length === 0 ? null : digest(lines.sort().join('\n'))
}

/** Whether a check's pass carries to a tree by the files it covers: targeted testing, a check with `when`, and the same key. */
export function isCoveredPass(step: Step, cfg: Pick<Config, 'testing'>, kept: string | undefined, now: string | null): boolean {
  return cfg.testing.scope === 'targeted' && step.when !== null && kept !== undefined && now !== null && kept === now
}

/** The order checks run in (decision 7): under targeted testing, the check that failed last first; else as written. */
export function orderSteps(steps: readonly Step[], failed: string | null, cfg: Pick<Config, 'testing'>): Step[] {
  const first = cfg.testing.scope === 'targeted' && failed !== null ? steps.find(one => one.run === failed) : undefined

  return first === undefined ? [...steps] : [first, ...steps.filter(one => one !== first)]
}

/** The context line naming the checks that apply to the files changed (decision 6); null with no change or no checks. */
export function checksForChange(cfg: Pick<Config, 'verify'>, changed: readonly string[]): string | null {
  if (changed.length === 0 || cfg.verify.length === 0) {
    return null
  }
  const steps = stepsFor(cfg.verify, 'full', changed)
  const background = backgroundFor(cfg.verify, changed)
  if (steps.length === 0 && background.length === 0) {
    return 'Checks for what you changed: none of the verify checks applies to these files.'
  }
  const named = [
    ...steps.map(one => `\`${one.run}\`${one.profile === 'full' ? ' (run when the change ships)' : ''}`),
    ...background.map(one => `\`${one.run}\` (runs in the background)`),
  ]
  // With no foreground check to run, say when the background ones start rather than that nothing applies.
  const when = steps.length > 0 ? '' : background.length === 1 ? ' It starts at your next stop.' : ' They start at your next stop.'

  return `Checks for what you changed: ${named.join(', ')}.${when}`
}

/** The `full` checks without `when`, which doctor names (decision 7): each runs in full on every change that ships. A background check is not named: it runs after the agent's stops, with no time limit. */
export const unscopedFull = (cfg: Pick<Config, 'verify'>): string[] =>
  cfg.verify.filter(one => one.profile === 'full' && one.when === null && one.background !== true).map(one => one.run)
