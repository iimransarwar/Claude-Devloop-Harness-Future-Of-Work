// The status row above the prompt, as data: pure, nothing here touches `$`.

import type { Loop } from '../types'
import type { Config } from './config'
import { featureCounts, tierFor } from './gate'
import type { Check } from './gate'

type Color = 'success' | 'error' | 'warning' | 'subtle'

export type BarParts = {
  phase: string
  tests: { text: string; color: 'success' | 'error' | 'warning' | 'subtle' }
  review: { text: string; color: Color } | null
  gate: { met: number; total: number }
  risk: { text: string; color: 'success' | 'warning' | 'error' }
}

/** The row's parts, or null when no row is shown (idle with no change). */
export function barParts(loop: Loop, cfg: Config, checks: readonly Check[]): BarParts | null {
  const tier = tierFor(loop, cfg)
  if (loop.phase === 'idle' && tier === 'none') {
    return null
  }
  const { passing, total } = featureCounts(loop)
  const phase = loop.phase === 'idle' ? 'Small fix'
    : loop.phase === 'spec' ? `Writing spec "${loop.spec ?? ''}"`
      : `Building "${loop.spec ?? ''}" · ${passing}/${total} features`
  const status = loop.verify.status
  const tests: BarParts['tests'] = cfg.verify.length === 0 ? { text: 'not set', color: 'subtle' }
    : status === 'pass' && loop.isDirty ? { text: 'not run since the last change', color: 'warning' }
    : status === 'pass' ? { text: '✓ passed', color: 'success' }
      : status === 'fail' ? { text: '✗ failing', color: 'error' }
        : status === 'error' ? { text: '! error', color: 'error' }
          : { text: 'not run', color: 'subtle' }
  // A verdict with a promoted checklist failure on its tree is a failing verdict (as `brief` reads it).
  const isFailing = loop.review.status === 'pass' && (loop.checklistFails ?? []).some(one => one.tree !== null && one.tree === loop.review.tree)
  const review: BarParts['review'] = tier === 'low' ? null
    : isFailing || loop.review.status === 'fail' ? { text: '✗ changes asked', color: 'error' }
      : loop.review.status === 'pass' ? { text: '✓ passed', color: 'success' }
        : loop.review.status === 'running' ? { text: '… running', color: 'warning' }
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
