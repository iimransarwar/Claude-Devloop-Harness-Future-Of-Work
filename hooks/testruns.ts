// What each verify check last did on a tree, as the gate, the status bar and
// the agent's context read it: a background run going on the tree, the
// latest run recorded on it, and how long ago something started. Pure: no
// `$` and no engine import, since hooks/gate.ts pulls it into the bundle.

import type { BackgroundRun, CheckRecord, Loop } from '../types'
import type { Config } from './config'
import { infraAdvice } from './output'
import { backgroundFor, stepsFor } from './rules'

/** A span as a person reads it: `<1m` under a minute, `14m`, then `1h 5m` from an hour on. */
export function ago(ms: number): string {
  const minutes = Math.floor(Math.max(0, ms) / 60_000)
  if (minutes < 1) {
    return '<1m'
  }

  return minutes < 60 ? `${minutes}m` : `${Math.floor(minutes / 60)}h ${minutes % 60}m`
}

/** The check's background run going on the loop's tree; null when none runs, or it runs on another tree. */
export function runningOn(loop: Pick<Loop, 'tree' | 'background'>, run: string): BackgroundRun | null {
  const one = loop.background?.[run]

  return one !== undefined && loop.tree !== null && one.tree === loop.tree ? one : null
}

/** The check's latest run when it ran on the loop's tree; never one whose tree changed while it ran. */
export function recordOn(loop: Pick<Loop, 'tree' | 'verify'>, run: string): CheckRecord | null {
  const one = loop.verify.runs?.[run]

  return one !== undefined && loop.tree !== null && one.tree === loop.tree && !one.isOlderTree ? one : null
}

/** What one verify check last did on the loop's tree, as the agent, the person and the reviewer are told it. */
export type TestState = {
  run: string
  isBackground: boolean
  state: 'pass' | 'fail' | 'could not run' | 'running' | 'not run'
  /** How long its latest run took, from its record; null with none. */
  durationMs: number | null
  /** When its background run on this tree started; null unless running. */
  startedAt: number | null
  /** The first lines of a failure on this tree; empty otherwise. */
  lines: string
  /** Where a failure's whole output was kept; null otherwise. */
  saved: string | null
}

/**
 * Each check that applies to the change, the foreground ones (both profiles)
 * then the background ones, as it stands on the loop's tree: running there,
 * passed there, failed or unable to run there (never a run whose tree
 * changed while it ran), else not run.
 */
export function testStates(loop: Loop, cfg: Config): TestState[] {
  return [...stepsFor(cfg.verify, 'full', loop.changed), ...backgroundFor(cfg.verify, loop.changed)].map((step): TestState => {
    const base = { run: step.run, isBackground: step.background === true, durationMs: loop.verify.runs?.[step.run]?.durationMs ?? null, startedAt: null, lines: '', saved: null }
    const running = runningOn(loop, step.run)
    if (running !== null) {
      return { ...base, state: 'running', startedAt: running.startedAt }
    }
    if (loop.tree !== null && loop.verify.passedOn[step.run] === loop.tree) {
      return { ...base, state: 'pass' }
    }
    const here = recordOn(loop, step.run)
    if (here !== null && here.outcome !== 'pass') {
      return { ...base, state: here.outcome === 'fail' ? 'fail' : 'could not run', lines: here.lines, saved: here.saved }
    }

    return { ...base, state: 'not run' }
  })
}

/** The check's latest run when it failed on a tree that changed while it ran: what it says is about code that is gone. */
function olderFailure(loop: Pick<Loop, 'verify'>, run: string): CheckRecord | null {
  const one = loop.verify.runs?.[run]

  return one !== undefined && one.isOlderTree && one.outcome === 'fail' ? one : null
}

/**
 * What the agent is told of the background checks at its next prompt, one
 * entry per check that has something to say: running, passed or failed on
 * this tree, unable to run there, or failed on an older tree. Null when none
 * has.
 */
export function backgroundNotice(loop: Loop, cfg: Config, now: number): string | null {
  const said = testStates(loop, cfg).filter(one => one.isBackground).flatMap(one => {
    const name = `\`${one.run}\``
    const since = one.startedAt === null ? '' : ago(now - one.startedAt)
    const older = one.state === 'not run' || one.state === 'running' ? olderFailure(loop, one.run) : null
    if (older !== null) {
      const next = one.state === 'running' ? `It is running again in the background on this tree (started ${since} ago).` : 'It runs again in the background after your next stop.'

      return [`${name} failed on an older tree (the tree changed while it ran), so it says nothing certain about this one:\n${older.lines}\n${next}`]
    }
    switch (one.state) {
      case 'running':
        return [`${name} is running in the background on this tree (started ${since} ago); nothing waits on it but shipping.`]
      case 'pass':
        return [`${name} passed in the background on this tree${one.durationMs === null ? '' : ` (${ago(one.durationMs)})`}.`]
      case 'fail':
        return [[`${name} failed in the background on this tree (${ago(one.durationMs ?? 0)}):`, one.lines, one.saved === null ? '' : `The whole output is in ${one.saved}.`].filter(part => part !== '').join('\n')]
      case 'could not run':
        return [infraAdvice(one.run, recordOn(loop, one.run)?.outcome ?? 'killed', cfg.verifyTimeoutSec)]
      default:
        return []
    }
  })

  return said.length === 0 ? null : said.join('\n')
}

/**
 * One line per check as it stands on the loop's tree, for the reviewer's
 * "Tests on this tree" block and the review summary (spec §4, §5).
 */
export function testLines(loop: Loop, cfg: Config, now: number): string[] {
  return testStates(loop, cfg).map(one => {
    const tag = one.isBackground ? ' [background]' : ''
    const took = one.durationMs !== null ? `, ${ago(one.durationMs)}` : ''
    switch (one.state) {
      case 'pass':
        return `✓ passed: ${one.run}${tag}${took}`
      case 'fail':
        return `✗ failing: ${one.run}${tag}${one.lines !== '' ? `\n    ${one.lines.split('\n').slice(0, 5).join('\n    ')}` : ''}`
      case 'could not run':
        return `! could not run: ${one.run}${tag}`
      case 'running':
        return `running: ${one.run}${tag} (started ${ago(now - (one.startedAt ?? now))} ago)`
      default:
        return `not run on this tree: ${one.run}${tag}`
    }
  })
}
