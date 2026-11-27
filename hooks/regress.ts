// Regression checks from closed specs (C2, DESIGN 11): at /devloop done a
// spec'd change's feature checks are kept, with the spec's name and the
// close date; they run with the full profile at the ship gate, where a
// failure is an unmet row naming the earlier change and an escaped defect
// against it. A person retires one. A flaky one is absorbed by the flake rule.

import type { Loop, RegressionStatus } from '../types'
import type { Config } from './config'
import { listOf } from './journal'
import type { Defect } from './report'
import { isFlakeSuspect } from './rules'
import { judgeFeatureCheck, loopOf, record, run, save } from './state'
import type { Engine, Place } from './state'

/** A regression check as kept per repository. */
export type Regression = {
  id: string
  spec: string
  feature: string
  change: string
  check: string
  closedAt: number
  status: 'active' | 'dropped'
  reason: string | null
}

export async function regressionsOf($: Engine, root: string): Promise<Regression[]> {
  return listOf<Regression>($, `regressions:${root}`)
}

/**
 * The loop's view of the active regression checks: the stored set is the
 * truth (C2.1 F6). A result is kept only for a check whose command is the
 * same as the one stored; a differing command (its spec reopened and closed
 * with a new one) starts over, not yet run.
 */
export function syncedRegressions(loop: Pick<Loop, 'regressions'>, list: readonly Regression[]): Record<string, RegressionStatus> {
  return Object.fromEntries(list.filter(one => one.status === 'active').map(one => {
    const kept = loop.regressions[one.id]
    const stored = { spec: one.spec, change: one.change, check: one.check, closedAt: one.closedAt }

    return [one.id, kept !== undefined && kept.check === one.check ? { ...kept, ...stored } : { ...stored, passes: null, tree: null }]
  }))
}

/** Brings the loop's regression checks in step with the store. */
export async function syncRegressions($: Engine, root: string): Promise<void> {
  const list = await regressionsOf($, root)
  await save($, root, before => ({ ...before, regressions: syncedRegressions(before, list) }))
}

/** Keeps a closed spec's feature checks as regression checks. */
export async function keepRegressions($: Engine, root: string, spec: string, change: string, features: readonly { id: string; check: string }[], at: number): Promise<number> {
  const list = await regressionsOf($, root)
  const added: Regression[] = features
    .filter(one => one.check.trim() !== '')
    .map(one => ({ id: `${spec}/${one.id}`, spec, feature: one.id, change, check: one.check, closedAt: at, status: 'active' as const, reason: null }))
  const ids = new Set(added.map(one => one.id))
  await $.store.set(`regressions:${root}`, [...list.filter(one => !ids.has(one.id)), ...added])

  return added.length
}

/** Retires one regression check, with the person's reason. False when there is no active one of that id. */
export async function dropRegression($: Engine, root: string, id: string, reason: string, at: number): Promise<boolean> {
  const list = await regressionsOf($, root)
  if (!list.some(one => one.id === id && one.status === 'active')) {
    return false
  }
  await $.store.set(`regressions:${root}`, list.map(one => (one.id === id ? { ...one, status: 'dropped' as const, reason: `${reason} (${new Date(at).toISOString().slice(0, 10)})` } : one)))
  await syncRegressions($, root)

  return true
}

/**
 * Runs every active regression check with no pass on this tree (the ship
 * gate's full profile): each judged by the command rules first (a refused one
 * is not run and stays unmet), a failure on a tree where it passed before
 * with nothing changed rerun once (the flake rule), and a real failure
 * recorded as an escaped defect against the change it came from.
 */
export async function runRegressions($: Engine, at: Place, cfg: Config, tree: string | null): Promise<void> {
  await syncRegressions($, at.root)
  const loop = await loopOf($)
  const now = await $.clock.now()
  const results: Record<string, { passes: boolean; tree: string | null }> = {}
  for (const [id, one] of Object.entries(loop.regressions)) {
    if (one.passes === true && one.tree === tree && tree !== null) {
      continue
    }
    if ((await judgeFeatureCheck($, at, cfg, loop, one.check)) !== null) {
      results[id] = { passes: false, tree }
      continue
    }
    let ran = await run($, one.check, at.root, cfg.verifyTimeoutSec, cfg.checkEnv)
    if (!ran.isPassing && ran.outcome === 'fail' && isFlakeSuspect({ run: one.check, profile: 'full', when: null }, one.passes === true, one.tree === tree ? [] : null)) {
      ran = await run($, one.check, at.root, cfg.verifyTimeoutSec, cfg.checkEnv)
      if (ran.isPassing) {
        await record($, at.root, 'verify-flaky', `flaky:${one.check}`, 'a regression check failed, then passed on a rerun')
      }
    }
    results[id] = { passes: ran.isPassing, tree }
    if (!ran.isPassing && ran.outcome === 'fail') {
      await record($, at.root, 'regression-fail', id, ran.output)
      const defects = await listOf<Defect>($, `defects:${at.root}`)
      const isKnown = defects.some(defect => defect.source === 'regression' && defect.text.startsWith(`regression check ${id} `) && defect.at >= (loop.tally.startedAt ?? 0))
      if (!isKnown) {
        await $.store.set(`defects:${at.root}`, [...defects, { at: now, change: one.change, source: 'regression', text: `regression check ${id} failed: ${one.check}` } satisfies Defect].slice(-500))
      }
    }
  }
  if (Object.keys(results).length > 0) {
    await save($, at.root, before => ({
      ...before,
      regressions: Object.fromEntries(Object.entries(before.regressions).map(([id, one]) => [id, results[id] === undefined ? one : { ...one, ...results[id] }])),
    }))
  }
}
