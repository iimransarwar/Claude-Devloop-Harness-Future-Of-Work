// Which devloop.json decides (DESIGN principle 10), as one pure function the
// hooks module (hooks/state.ts policyInForce, reading git through `$`) and
// the command line (cli/, reading git through Node) both call, each with its
// own reader: the base branch's copy, whole, whenever the base has one; the
// working tree's only when it has none. Pure: no `$`.

import { parseConfig } from './config'
import type { Config } from './config'

/**
 * The policy every decision is taken by (DESIGN principle 10): devloop.json
 * as the base branch has it, whole, whenever the base has a copy; the
 * working tree's only when it has none (`source: 'working'`, and the gate
 * says so). `policy` compares the working tree's copy with it, for the
 * "Policy changed in this change" row and nothing else.
 */
export type InForce = {
  cfg: Config
  source: 'base' | 'working'
  /** `deleted`: the working tree has no devloop.json, and the base branch's is in force (C2.1). */
  policy: 'same' | 'changed' | 'deleted' | 'no-base'
}

/**
 * The policy in force from what each reader found: the working tree's
 * config (null with no working copy) and its text, and the base commit's
 * devloop.json text (null when the base has none, or there is no base). A
 * base copy that does not parse is still the base's: its defaults (enforce)
 * are in force, never the working tree's. Null: not opted in.
 */
export function decidePolicy(working: Config | null, workingText: string | null, baseText: string | null): InForce | null {
  if (baseText === null) {
    return working === null ? null : { cfg: working, source: 'working', policy: 'no-base' }
  }

  return {
    cfg: parseConfig(baseText).cfg,
    source: 'base',
    policy: working === null ? 'deleted' : baseText.trim() === (workingText ?? '').trim() ? 'same' : 'changed',
  }
}
