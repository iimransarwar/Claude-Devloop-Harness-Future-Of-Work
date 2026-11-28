// The status row above the prompt, as data: pure, nothing here touches `$`.

import type { Loop } from '../types'
import type { Config } from './config'
import { featureCounts, tierFor } from './gate'
import type { Check } from './gate'
import { backgroundFor } from './rules'
import { ago, recordOn, runningOn } from './testruns'

type Color = 'success' | 'error' | 'warning' | 'subtle'

export type BarParts = {
  phase: string
  tests: { text: string; color: 'success' | 'error' | 'warning' | 'subtle' }
  review: { text: string; color: Color } | null
  gate: { met: number; total: number }
  risk: { text: string; color: 'success' | 'warning' | 'error' }
}

/**
 * The row's parts, or null when no row is shown (idle with no change).
 * `now` lets a background run say how long it has gone; absent, it names no
 * time. The tests part reads as the gate's Verification row does: a
 * foreground failure first, then a background check running, failing or
 * unable to run on this tree; after an edit nothing on record speaks for
 * the tree, so it reads "not run since the last change".
 */
export function barParts(loop: Loop, cfg: Config, checks: readonly Check[], now?: number): BarParts | null {
  const tier = tierFor(loop, cfg)
  if (loop.phase === 'idle' && tier === 'none') {
    return null
  }
  const { passing, total } = featureCounts(loop)
  const phase = loop.phase === 'idle' ? 'Small fix'
    : loop.phase === 'spec' ? `Writing spec "${loop.spec ?? ''}"`
      : `Building "${loop.spec ?? ''}" · ${passing}/${total} features`
  const status = loop.verify.status
  // An edit since the last pass moved the tree the passes and the runs name, as the gate's `isMoved` reads it.
  const isMoved = status === 'pass' && loop.isDirty
  const background = isMoved ? [] : backgroundFor(cfg.verify, loop.changed).map(one => one.run)
  const running = background.flatMap(run => runningOn(loop, run) ?? [])
  const outcomes = background.map(run => recordOn(loop, run)?.outcome)
  const since = now === undefined || running.length === 0 ? null : ago(now - Math.min(...running.map(one => one.startedAt)))
  const tests: BarParts['tests'] = cfg.verify.length === 0 ? { text: 'not set', color: 'subtle' }
    : isMoved ? { text: 'not run since the last change', color: 'warning' }
    : status === 'fail' ? { text: '✗ failing', color: 'error' }
      : status === 'error' ? { text: '! error', color: 'error' }
        : running.length > 0 ? { text: since === null ? 'running…' : `running ${since}…`, color: 'warning' }
          : outcomes.includes('fail') ? { text: '✗ failing', color: 'error' }
            : outcomes.some(one => one !== undefined && one !== 'pass') ? { text: '! could not run', color: 'error' }
              : status === 'pass' ? { text: '✓ passed', color: 'success' }
                : { text: 'not run', color: 'subtle' }
  // A verdict with a promoted checklist failure on its tree is a failing verdict (as `brief` reads it).
  const isFailing = loop.review.status === 'pass' && (loop.checklistFails ?? []).some(one => one.tree !== null && one.tree === loop.review.tree)
  // A pass on another tree is out of date (rule 15), unless the gate's row carries it here (only task state changed since).
  const isPassed = loop.review.status === 'pass' || (loop.review.status === 'none' && loop.review.cycle.ended === 'pass' && loop.review.tree !== null)
  const isStale = isPassed && loop.review.tree !== loop.tree && checks.find(one => one.label === 'Independent review')?.isMet !== true
  const review: BarParts['review'] = tier === 'low' ? null
    : isFailing || loop.review.status === 'fail' ? { text: '✗ changes asked', color: 'error' }
      : isStale ? { text: 'out of date', color: 'warning' }
        : loop.review.status === 'pass' ? { text: '✓ passed', color: 'success' }
          : loop.review.status === 'running' ? { text: '… running', color: 'warning' }
            : loop.review.cycle.ended === 'cap' ? { text: `rounds spent (${loop.review.round})`, color: 'warning' }
              : { text: 'not run', color: 'subtle' }

  return {
    phase,
    tests,
    review,
    gate: { met: checks.filter(one => one.isMet).length, total: checks.length },
    risk: tier === 'high' ? { text: 'high', color: 'error' }
      : tier === 'medium' ? { text: 'medium', color: 'warning' }
        : tier === 'low' ? { text: 'low', color: 'success' }
          : { text: 'no changes', color: 'success' },
  }
}
