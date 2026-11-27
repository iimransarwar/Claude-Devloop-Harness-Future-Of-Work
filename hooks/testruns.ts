// What each verify check last did on a tree, as the gate, the status bar and
// the agent's context read it: a background run going on the tree, the
// latest run recorded on it, and how long ago something started. Pure: no
// `$` and no engine import, since hooks/gate.ts pulls it into the bundle.

import type { BackgroundRun, CheckRecord, Loop } from '../types'

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
