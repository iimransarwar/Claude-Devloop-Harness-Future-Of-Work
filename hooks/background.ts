// Background checks (agent-driven review design, section 3 and rules 1, 3):
// a verify check marked "background" never runs inside a hook. A stop that
// ends the turn starts it with `$.process.spawn`, with no time limit, and
// returns at once; the child runs on after the hook has returned, and when
// it ends its result is recorded against the tree it started on, the record
// the gate reads. One run per check at a time: a stop on a newer tree
// cancels the run on the older one and starts again. A run that ended is
// told (rule 2): a failure on its tree as a toast, a failed round toward the
// loop limit and, in enforce mode, a prompt that wakes an idle agent; never
// a block.

import type { HookStream, ProcessSpawnChunk, ProcessSpawnResult } from 'claude-code'

import type { CheckRecord, Loop, Outcome } from '../types'
import type { Config } from './config'
import { isAtLimit, isCoveredPass } from './limits'
import { classify, distill, infraAdvice } from './output'
import { countFailedRound, reachLimit } from './rounds'
import { backgroundFor } from './rules'
import { checkArgv, coveredKeys, credentialNames, keepOutput, loopOf, note, save, snapshot } from './state'
import type { Engine, Place } from './state'
import { ago } from './testruns'

/** A run going in this process: its child, the tree it started on, the covered-files key there, whether it was cancelled, and whether the main loop is idle now. */
type Live = {
  stream: HookStream<ProcessSpawnChunk, ProcessSpawnResult> | null
  tree: string
  startedAt: number
  key: string | null
  isCancelled: boolean
  isIdle: () => boolean
}

/** The runs going in this process, by root and check. A `loop.background` entry with none here is dead: its child went with a session or the module. */
const live = new Map<string, Live>()

/** The records of runs that ended, while they are written. */
const settling = new Set<Promise<void>>()

const idOf = (root: string, run: string): string => `${root}\n${run}`

/** What a stored loop says when a run ended with the session or the plugin, before it could be recorded. */
const abandoned = (run: string): string => `background: ${run} did not finish (the session or plugin ended); it starts again at the next stop`

/** Whether the check has a result on the tree: a pass, or a run recorded on it whose tree did not change while it ran (rule 1). */
function hasResult(loop: Loop, run: string, tree: string): boolean {
  const last = loop.verify.runs[run]

  return loop.verify.passedOn[run] === tree || (last !== undefined && last.tree === tree && !last.isOlderTree)
}

/** Ends a run going in this process; when it ends, nothing of it is recorded. */
function cancel($: Engine, id: string): void {
  const one = live.get(id)
  if (one === undefined) {
    return
  }
  live.delete(id)
  one.isCancelled = true
  void one.stream?.return({ code: null, signal: null }).catch((error: unknown) => {
    $.ui.log(`devloop: a background run could not be ended: ${String(error)}`, { to: 'debug' })
  })
}

/**
 * Starts each background check that applies to the change and has neither a
 * result on `tree` nor a run going on it, after cancelling its run on another
 * tree. A check with `when` whose pass carries on the files it covers is not
 * run: its pass is recorded on `tree`. Returns the commands it started and
 * never waits on one; outside git (`tree` null) nothing starts. `isIdle`
 * says, when a run ends, whether the main loop has no turn going, so a
 * failure may wake it.
 */
export async function startBackground($: Engine, at: Place, cfg: Config, tree: string | null, isIdle: () => boolean): Promise<string[]> {
  if (tree === null) {
    return []
  }
  const loop = await loopOf($)
  const due = backgroundFor(cfg.verify, loop.changed).filter(step => !hasResult(loop, step.run, tree) && live.get(idOf(at.root, step.run))?.tree !== tree)
  if (due.length === 0) {
    return []
  }
  // The same secret handling as a foreground check (rule 3): `checkArgv` scrubs in enforce mode, and observe mode reads the exposed names once.
  if (cfg.checkEnv.mode === 'observe') {
    await credentialNames($)
  }
  const keys = cfg.testing.scope === 'targeted' ? await coveredKeys($, at, due, tree) : {}
  const now = await $.clock.now()
  const carried: string[] = []
  const started: { run: string; one: Live; wasLive: boolean }[] = []
  for (const step of due) {
    const id = idOf(at.root, step.run)
    const wasLive = live.has(id)
    cancel($, id)
    const key = keys[step.run] ?? null
    if (isCoveredPass(step, cfg, (loop.verify.covered ?? {})[step.run], key)) {
      carried.push(step.run)
      continue
    }
    const one: Live = { stream: null, tree, startedAt: now, key, isCancelled: false, isIdle }
    live.set(id, one)
    started.push({ run: step.run, one, wasLive })
  }
  // Written before any child starts, so a child that ends at once finds its entry to drop.
  await save($, at.root, before => {
    let next: Loop = { ...before, background: Object.fromEntries(Object.entries(before.background).filter(([run]) => !carried.includes(run))) }
    for (const run of carried) {
      next = note({ ...next, verify: { ...next.verify, passedOn: { ...next.verify.passedOn, [run]: tree } } }, 'verify', `background: ${run} passed before on the files it covers, not run again`, now)
    }
    for (const { run, wasLive } of started) {
      if (!wasLive && before.background[run] !== undefined) {
        next = note(next, 'verify', `background: ${run} did not finish (the session or plugin ended); it starts again now`, now)
      }
      next = { ...next, background: { ...next.background, [run]: { tree, startedAt: now } } }
    }

    return next
  })
  for (const { run, one } of started) {
    if (!one.isCancelled) {
      void life($, at, cfg, run, one)
    }
  }

  return started.filter(({ one }) => !one.isCancelled).map(({ run }) => run)
}

/**
 * Cancels this root's runs going in this process and drops every
 * `loop.background` entry, each with a note: at a session's start, a child
 * of the last session or of an unloaded module is gone. Each starts again at
 * the next stop.
 */
export async function abandonBackground($: Engine, at: Place): Promise<void> {
  for (const id of [...live.keys()].filter(one => one.startsWith(`${at.root}\n`))) {
    cancel($, id)
  }
  if (Object.keys((await loopOf($)).background).length === 0) {
    return
  }
  const now = await $.clock.now()
  await save($, at.root, before => Object.keys(before.background).reduce((loop, run) => note(loop, 'verify', abandoned(run), now), { ...before, background: {} }))
}

/**
 * Resolves once the record of every run that ended is written (tests await
 * it). A child's end reaches its reader through the engine's stream some
 * promise turns later, and a test file imports a copy of this module of its
 * own, apart from the plugin's (so `settling` there stays empty): what both
 * share is the queue of promise turns, which is let run out first.
 */
export async function whenSettled(): Promise<void> {
  for (;;) {
    await drained()
    if (settling.size === 0) {
      return
    }
    await Promise.all([...settling])
  }
}

/**
 * Resolves once every promise turn queued so far has run: after one timer
 * turn where the environment has timers (the test kit's has; a hooks module
 * has none of its own), else after many promise turns.
 */
async function drained(): Promise<void> {
  const timer = (globalThis as { setTimeout?: (done: () => void, ms: number) => unknown }).setTimeout
  if (timer !== undefined) {
    await new Promise<void>(resolve => {
      timer(resolve, 0)
    })

    return
  }
  for (let turn = 0; turn < 10_000; turn += 1) {
    await undefined
  }
}

/** Reads the child to its end, then records how it ended, unless it was cancelled. */
async function life($: Engine, at: Place, cfg: Config, run: string, one: Live): Promise<void> {
  const chunks: string[] = []
  // Null: it could not start (its first pull rejects).
  let ended: ProcessSpawnResult | null = null
  try {
    const stream = $.process.spawn({ argv: checkArgv(run, cfg.checkEnv), cwd: at.root })
    one.stream = stream
    for (;;) {
      const piece = await stream.next()
      if (piece.done === true) {
        ended = piece.value
        break
      }
      chunks.push(piece.value.text)
    }
  } catch (error) {
    if (!one.isCancelled) {
      $.ui.log(`devloop: the background check ${run} could not start: ${String(error)}`, { to: 'debug' })
    }
  }
  const id = idOf(at.root, run)
  if (live.get(id) === one) {
    live.delete(id)
  }
  if (one.isCancelled) {
    return
  }
  const written = finish($, at, cfg, run, one, chunks.join('').slice(-100_000), ended).catch((error: unknown) => {
    $.ui.log(`devloop: the background check ${run} ended, but its result could not be recorded: ${String(error)}`, { to: 'debug' })
  })
  settling.add(written)
  await written
  settling.delete(written)
}

/** How a child ended: by a signal is `killed`, one that could not start `not-found`, else by its exit code. */
function outcomeOf(ended: ProcessSpawnResult | null | undefined, raw: string): Outcome {
  if (ended === null || ended === undefined) {
    return 'not-found'
  }

  return ended.code === null || ended.signal !== null ? 'killed' : classify(ended.code, raw)
}

/** What the activity line says of a run that ended. */
function told(run: string, record: CheckRecord): string {
  if (record.outcome !== 'pass' && record.outcome !== 'fail') {
    return `background: ${run} could not run (${record.outcome})`
  }
  const how = record.outcome === 'pass' ? 'passed' : 'failed'

  return record.isOlderTree
    ? `background: ${run} ran on an older tree (the tree changed while it ran): ${how}`
    : `background: ${run} ${how} on this tree (${ago(record.durationMs)})`
}

/**
 * Records a run that ended against the tree it started on (rule 1): on that
 * tree still, a pass counts for it and keeps the covered-files key, and any
 * other end drops that key; on a tree that changed while it ran, the record
 * says so and nothing counts as a pass.
 */
async function finish($: Engine, at: Place, cfg: Config, run: string, one: Live, raw: string, ended: ProcessSpawnResult | null): Promise<void> {
  const outcome = outcomeOf(ended, raw)
  const snap = await snapshot($, at, cfg)
  const now = await $.clock.now()
  const saved = await keepOutput($, at, run, raw)
  const record: CheckRecord = {
    tree: one.tree,
    outcome,
    at: now,
    durationMs: Math.max(0, now - one.startedAt),
    lines: outcome === 'pass' ? '' : distill(raw).split('\n').slice(0, 10).join('\n'),
    isOlderTree: snap.tree !== one.tree,
    saved,
  }
  // The session moved to another repository meanwhile: its loop is not this one. The entry stays, and is started again at the next stop here.
  if ((await loopOf($)).root !== at.root) {
    $.ui.log(`devloop: the background check ${run} ended after the session left ${at.root}; it runs again at the next stop there`, { to: 'debug' })

    return
  }
  const isHere = !record.isOlderTree
  const isPass = isHere && outcome === 'pass'
  const after = await save($, at.root, before => {
    const covered = Object.fromEntries(Object.entries(before.verify.covered ?? {}).filter(([command]) => command !== run || !isHere))
    const verify = {
      ...before.verify,
      passedOn: isPass ? { ...before.verify.passedOn, [run]: one.tree } : before.verify.passedOn,
      covered: isPass && one.key !== null ? { ...covered, [run]: one.key } : covered,
      runs: { ...before.verify.runs, [run]: record },
    }

    return note({ ...before, verify, background: Object.fromEntries(Object.entries(before.background).filter(([command]) => command !== run)) }, 'verify', told(run, record), now)
  })
  await report($, at, cfg, run, record, after, snap.branch, one.isIdle)
}

/**
 * What a run that ended tells the person and the agent (rule 2); never a
 * block, and a pass tells no one (the agent reads it at its next prompt).
 * One that could not run, or failed on an older tree, is a toast and
 * nothing more. A failure on its tree is a toast and, outside the spec
 * phase, one failed round toward the loop limit (never a fix round); in
 * enforce mode, below the limit, an idle agent is woken to fix it, and at
 * the limit the limit's message is added once instead.
 */
async function report($: Engine, at: Place, cfg: Config, run: string, record: CheckRecord, loop: Loop, branch: string | null, isIdle: () => boolean): Promise<void> {
  if (record.outcome === 'pass') {
    return
  }
  if (record.outcome !== 'fail') {
    $.ui.toast(`devloop: ${infraAdvice(run, record.outcome, cfg.verifyTimeoutSec, true)}`, { timeoutMs: 15_000 })

    return
  }
  if (record.isOlderTree) {
    $.ui.toast(`devloop: the background check \`${run}\` failed on an older tree (the tree changed while it ran); it runs again at the next stop.`)

    return
  }
  const took = ago(record.durationMs)
  $.ui.toast(`devloop: the background check \`${run}\` failed on this tree (${took}).`)
  // While a spec is written its checks are expected to fail: recorded and shown, nothing counted (Review Focus 4).
  if (loop.phase === 'spec') {
    return
  }
  const limit = await countFailedRound($, at.root, branch, { kind: 'fix', what: `${run} (background)`, files: [] })
  const told = await reachLimit($, at, cfg, branch)
  if (cfg.mode !== 'enforce') {
    return
  }
  if (isAtLimit(limit, cfg)) {
    // At the loop limit nothing more is handed back: the message once, appended (it wakes no turn), as a review round's is.
    if (told !== null) {
      await $.session.append({ message: { type: 'user', content: [{ type: 'text', text: told }] } }).catch((error: unknown) => {
        $.ui.log(`devloop: the loop limit's message could not be added: ${String(error)}`, { to: 'debug' })
      })
    }

    return
  }
  if (!isIdle()) {
    return
  }
  const text = [
    `The background check \`${run}\` failed on this tree (it ran ${took}).`,
    record.lines,
    record.saved === null ? '' : `The whole output is in ${record.saved}.`,
    'Fix the failure and stop; the check runs again in the background after your stop.',
  ].filter(part => part !== '').join('\n')
  // Resolves when that turn starts: never awaited, so a run's end waits on no turn.
  void $.prompt.submit({ text }).catch((error: unknown) => {
    $.ui.log(`devloop: the agent could not be woken for the background failure of ${run}: ${String(error)}`, { to: 'debug' })
  })
}
