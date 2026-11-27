// One call judged by the stateless core, as the classic PreToolUse hook and
// `check-command` / `check-path` judge it: the readers gather the facts
// (where paths lead, which folders are folders, the tracked files under a
// written path, the branch, the remote), and hooks/enforce.ts decides with
// the module's own rule functions.

import { statSync } from 'node:fs'

import type { Phase, Tier } from '../types'
import type { Config } from '../hooks/config'
import { judgeCall, pushesToDefault, shipRules, shippingOf, statelessLoop } from '../hooks/enforce'
import type { Call } from '../hooks/enforce'
import { tierWithBlast } from '../hooks/gate'
import { globParts, isHeldBy, liftOf, shipLookups, repoSlug, strictest, writtenPaths } from '../hooks/rules'
import type { Refusal, Where } from '../hooks/rules'
import { currentBranch, filesUnder, globsFor, pushRange, readText, realOf, remoteSlug, snapshot, tasksFacts } from './io'

export type Judged = {
  /** The strictest refusal, or null. */
  verdict: Refusal | null
  /** Whether it holds in the mode in force (enforce, or a rule that always holds). */
  isHeld: boolean
  /** Every refusal found, in order. */
  all: Refusal[]
  /** What the line ships, when it ships and no rule refused it first: the gate decides. */
  ships: boolean
  /** Whether what it ships is a push: what it sends must be the tree the gate judges (final round, D1 F4). */
  isPush: boolean
}

/** The facts a shell command needs beyond its text: folders, tracked files, the branch, the remote. */
function shellWhere(text: string, base: Where, root: string, isOptedIn: boolean): Where {
  // What each wildcard path matches on disk (P-C), before the paths written are listed.
  const where = globsFor(text, base)
  const written = writtenPaths(text, where)
  const dirs: string[] = []
  for (const one of written.slice(0, 16)) {
    const isGlob = /[*?[]/.test(one.rel ?? '')
    // Listed from the path before its first wildcard, as the rules expand it (the last review's F4).
    const rel = one.rel === null ? null : globParts(one.rel).dir
    if (rel !== null && (rel !== '' || isGlob) && dirs.length < 8 && !dirs.includes(rel)) {
      dirs.push(rel)
    }
  }
  const folders: Record<string, boolean> = {}
  for (const rel of dirs.filter(one => one !== '')) {
    try {
      folders[rel] = statSync(`${root}/${rel}`).isDirectory()
    } catch (error) {
      if (/ENOENT/.test(String(error))) {
        folders[rel] = false
      }
    }
  }
  const ships = shipLookups(text)
  const branch = ships.hasMerge || ships.isShip ? currentBranch(root) : null
  const remote = ships.hasRepoFlag ? remoteSlug(root, repoSlug) : null

  return { ...where, filesUnder: isOptedIn ? filesUnder(root, dirs) : {}, folders, branch, remote }
}

/**
 * Judges one call by the stateless core in a phase (the command line's
 * `--phase`; the classic hook judges in small-fix mode, `idle`), then, for a
 * line that ships and broke no rule, the shipping rules that come before the
 * gate. Whether it ships on into the gate is said; the caller proves it.
 */
export function judgeOne(call: Call, cfg: Config, isOptedIn: boolean, base: Where, root: string, phase: Phase = 'idle'): Judged {
  const isShell = call.tool === 'Bash' || call.tool === 'Monitor'
  const text = isShell && typeof call.input.command === 'string' ? call.input.command : ''
  const where = { ...(isShell ? shellWhere(text, base, root, isOptedIn) : base), ...(isOptedIn ? { tasks: tasksFacts(root, cfg) } : {}) }
  const all = judgeCall(call, { cfg, isOptedIn, where, loop: statelessLoop(phase), realOf: path => realOf(path, where), readText })
  let ships = false
  let isPush = false
  if (isShell && all.length === 0 && isOptedIn) {
    const intents = shippingOf(text, where.branch, cfg.defaultBranch)
    isPush = intents.some(one => one.kind === 'push')
    if (intents.length > 0) {
      const ranges: Record<string, string[] | null> = {}
      for (const source of pushesToDefault(intents, where.branch, cfg.defaultBranch)) {
        ranges[source] = pushRange(root, cfg, source)
      }
      const needsTier = intents.some(one => one.kind === 'pr-merge')
      const snap = needsTier ? snapshot(root, cfg) : null
      const tier: Tier = snap === null || snap.tree === null ? 'medium' : tierWithBlast(snap.files, snap.size.lines, cfg)
      const before = shipRules(intents, where.branch, cfg, tier, ranges)
      if (before !== null) {
        all.push(before)
      } else {
        ships = true
      }
    }
  }
  const verdict = strictest(all, cfg)

  return { verdict, isHeld: verdict !== null && isHeldBy(verdict.rule, cfg), all, ships, isPush }
}

/** A verdict as the command line prints it: the rule, why, and who lifts it. */
export function verdictLines(judged: Judged, mode: string): string[] {
  if (judged.verdict === null) {
    return [judged.ships ? 'allowed by the rules; it ships, so the gate decides (node dist/devloop.mjs gate)' : 'allowed: no rule refuses it']
  }
  const { rule, reason } = judged.verdict

  return [
    `${judged.isHeld ? 'refused' : 'recorded only (observe mode)'}: ${rule}${judged.verdict.id !== undefined ? ` (${judged.verdict.id})` : ''}`,
    `reason: ${reason}`,
    `lift class: ${liftOf(rule)}`,
    `mode in force: ${mode}`,
  ]
}
