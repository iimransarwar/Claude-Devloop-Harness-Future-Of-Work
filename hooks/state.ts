// What the loop remembers and the few things it does to the world: reading
// the repository's config, snapshotting the working tree, running checks.

import { atom, read, update } from 'claude-code'
import type { EngineInterface } from 'claude-code'

import type { Activity, CheckRecord, FeatureStatus, Loop, LoopEvent, Mode, PaneTab, Question, SectionDecision, SettingsDraft } from '../types'
import { EMPTY_CACHE } from './cache'
import type { CacheState } from './cache'
import { parseConfig } from './config'
import { FRESH } from './fresh'
import { decidePolicy } from './inforce'
import type { InForce } from './inforce'
import type { CheckEnv, Config, Profile, Step } from './config'
import {
  BASE_POLICY, CARRY_DIFF, CURRENT_BRANCH, FIND_BASE, MAIN_ROOT, REMOTE_URL, LS_FILES, NO_SNAPSHOT, PUSH_RANGE, SNAPSHOT, checkArgv, readCarryDiff, readSnapshot, sweepSpecsOf,
} from './scripts'
import { isTaskStateOnly, isVersion2, TASKS_OFF } from './tasks'
import type { TasksFacts } from './tasks'
import type { Snapshot } from './scripts'

// Re-exported where code and tests have always found them.
export { NO_SNAPSHOT, SWEEP_CAP, SWEEP_SKIPS, checkArgv, pathspecsOf, readSnapshot, sweepSpecsOf } from './scripts'
export type { Snapshot } from './scripts'
import { addQuestion, EMPTY_ATTRIBUTION } from './context'
import type { Attribution } from './context'
import { evidenceOf } from './evidence'
import { carryKey, coverageOf, featureCounts, tierFor } from './gate'
import type { CarryFact, Coverage, GateFacts } from './gate'
import { coveredKey, isCoveredPass, orderSteps } from './limits'
import { classify, digest, distill, fingerprint } from './output'
import type { Outcome } from './output'
import { GLOB_ROUNDS, globsAnswered, globsWanted, isCredentialName, isFlakeSuspect, judgeCheck, lintChecks, matchesAny, patternsOf, physicalPath, repoSlug, stepsFor, whereOf, writtenPaths } from './rules'
import type { Placed, Refusal, Where } from './rules'
import { expandAll, expandGlobReviewed } from './glob'
import type { Listing } from './glob'
import { fingerprintInput, parseFeatures } from './spec'
import type { Feature } from './spec'

export type Engine = EngineInterface

// The loop's starting state lives in a pure module the command line shares.
export { FRESH } from './fresh'

// Change the tag when Loop's fields change: it declines what an earlier
// version stored, which outlives a reload.
const SHAPE = 'loop-13'
/** The shape before background checks: the same loop without `background` and `verify.runs`, which `upgraded` fills. */
const PREVIOUS = 'loop-12'
const LOOP = atom({ plugin: 'devloop', key: 'loop' } as const, FRESH, { shape: SHAPE })
const MODE = atom({ plugin: 'devloop', key: 'mode' } as const, 'off' as Mode)
/** The pane's tab: written from a tab button's handler, never while drawing. */
const TAB = atom({ plugin: 'devloop', key: 'tab' } as const, 'gate' as PaneTab)
/** What agents are doing, for the row above the prompt: written by the activity timer, read while drawing. */
const ACTIVITY = atom({ plugin: 'devloop', key: 'activity' } as const, { frame: 0, tasks: [] } as Activity)

/** The agents' activity as last sampled. */
export async function activityOf($: Engine): Promise<Activity> {
  return read($, ACTIVITY)
}

/** Writes the agents' activity; a write redraws the row. */
export async function setActivity($: Engine, next: Activity): Promise<void> {
  await update($, ACTIVITY, () => next)
}

/**
 * Whether the rules section is sent, decided at a thread's first composition
 * and kept by session id (F6), so a plugin reload under the same session never
 * decides again: only a new session id or `/clear` does.
 */
const SECTION = atom({ plugin: 'devloop', key: 'section' } as const, { sessionId: null, isOn: null } as SectionDecision, { shape: 'section-1' })

/** The section decision as it stands. */
export function sectionOf($: Engine): Promise<SectionDecision> {
  return read($, SECTION)
}

/** Keeps the section decision (or clears it, after `/clear`). */
export async function setSection($: Engine, decision: SectionDecision): Promise<void> {
  await update($, SECTION, () => decision)
}

/** A review still `running` after this long has lost its agent: it is marked abandoned. */
const REVIEW_LIFETIME_MS = 30 * 60 * 1000

// The state library's calls stay in this file, beside the atoms they name.

/** The loop as it stands; read while drawing, it redraws the reader on a change. */
export function loopOf($: Engine): Promise<Loop> {
  return read($, LOOP)
}

/** How hard the guards hold, as last read from devloop.json: what a guard that failed falls back on. */
export function modeOf($: Engine): Promise<Mode> {
  return read($, MODE)
}

/** The pane's tab as it stands; read while drawing. */
export function tabOf($: Engine): Promise<PaneTab> {
  return read($, TAB)
}

/** Shows another tab of the pane: called from a tab button's handler, never from a render. */
export async function setTab($: Engine, tab: PaneTab): Promise<void> {
  await update($, TAB, () => tab)
}

/**
 * The settings popup's draft, kept until Save or a close: written when the
 * popup opens and from its pickers' handlers, never while drawing.
 */
const SETTINGS = atom({ plugin: 'devloop', key: 'settings' } as const, null as SettingsDraft | null, { shape: 'settings-1' })

/** The settings draft as it stands; read while drawing, it redraws the popup on a change. */
export function settingsDraftOf($: Engine): Promise<SettingsDraft | null> {
  return read($, SETTINGS)
}

/** Changes the settings draft (null drops it): from the command that opens the popup and its handlers. */
export async function updateSettingsDraft($: Engine, change: (draft: SettingsDraft | null) => SettingsDraft | null): Promise<void> {
  await update($, SETTINGS, change)
}

export type Place = {
  /** The folder that holds devloop.json, or the session's root when none does. */
  root: string
  /** The session's working directory when the config was read. */
  cwd: string
  /**
   * The working tree's devloop.json, or null where the repository has not
   * opted in. Never a policy to decide by: `policyInForce` gives that. It is
   * read to compare with the base branch's copy, and by doctor and init.
   */
  working: Config | null
  /** Problems in devloop.json, each naming its field; the field took its default. */
  errors: string[]
  /** Fields a later version reads, which this one ignores. */
  unused: string[]
  /** Check-integrity notes on the verify commands. */
  lint: string[]
  /** What devloop.json holds, to compare with the base branch's copy. */
  text: string | null
  /** The file does not parse: `cfg` is the last config that did, or the defaults. */
  isFallback: boolean
  /**
   * Whether the repository is opted in (C2.1): the working tree has a
   * devloop.json, or the base branch does. With a base copy and none in the
   * working tree (it was deleted), the base's policy is in force as before.
   * `look` knows the base only from what `policyInForce` last found; `locate`
   * always asks.
   */
  isOptedIn: boolean
}

const places = new Map<string, Place & { readAt: number }>()
/** The mode last written to state, so a read that changed nothing writes nothing. */
let kept: Mode | null = null
/** The config text last kept as the one that parsed, per root. */
const keptText = new Map<string, string>()
/** Config texts whose fallback a person was already told about. */
const toldFallback = new Set<string>()

/** Forgets what was read from disk and git, so the next read sees a file just written. */
export function forget(): void {
  places.clear()
  kept = null
  keptText.clear()
  toldFallback.clear()
  policies.clear()
  lastPolicy.clear()
  bases.clear()
  baseOptIn.clear()
  cappedAt.clear()
  exposed = null
  probes.clear()
  carries.clear()
}

/** Whether the base branch of a root has a devloop.json, as `policyInForce` last found (C2.1). */
const baseOptIn = new Map<string, boolean>()

/**
 * Finds the repository's root (the nearest folder up from the session's root
 * that holds devloop.json, however far; with none, the nearest that holds
 * `.git`, whose base branch may have one) and reads its config, a few
 * seconds stale at most. A file that stops parsing yields the last config
 * that did. Writes nothing and runs nothing, so a render hook may call it.
 */
export async function look($: Engine): Promise<Place> {
  const start = await $.session.root().catch(() => $.session.cwd())
  const known = places.get(start)
  if (known !== undefined && Date.now() - known.readAt < 3000) {
    return known
  }
  const cwd = await $.session.cwd().catch(() => start)
  let root = start
  let text: string | null = null
  for (let dir = start; ;) {
    if (await $.fs.exists(`${dir}/devloop.json`)) {
      root = dir
      text = await $.fs.read(`${dir}/devloop.json`)
      break
    }
    const parent = dir.slice(0, dir.lastIndexOf('/'))
    if (parent === dir || dir === '' || dir === '/') {
      break
    }
    dir = parent === '' ? '/' : parent
  }
  if (text === null) {
    // No working copy: the repository is still opted in when its base branch has one (C2.1), so its root is git's.
    for (let dir = start; ;) {
      if (await $.fs.exists(`${dir}/.git`).catch(() => false)) {
        root = dir
        break
      }
      const parent = dir.slice(0, dir.lastIndexOf('/'))
      if (parent === dir || dir === '' || dir === '/') {
        break
      }
      dir = parent === '' ? '/' : parent
    }
  }
  let at: Place = { root, cwd, working: null, errors: [], unused: [], lint: [], text, isFallback: false, isOptedIn: text !== null || baseOptIn.get(root) === true }
  if (text !== null) {
    const parsed = parseConfig(text)
    at = { ...at, working: parsed.cfg, errors: parsed.errors, unused: parsed.unused }
    if (!parsed.isParsed) {
      // A file that stopped parsing keeps the last config that did, so a typo
      // neither switches guards off nor moves an observing repository to enforce.
      const last = (await $.store.get(`config:${root}`)) as string | undefined
      const before = last === undefined ? null : parseConfig(last)
      at = {
        ...at,
        isFallback: true,
        working: before?.isParsed === true ? before.cfg : parsed.cfg,
        errors: parsed.errors.map(error => error.replace(/; every field takes its default$/, before?.isParsed === true
          ? '; the last devloop.json that parsed stays in force until it is fixed'
          : '; no earlier config is on record, so every field takes its default (enforce mode)')),
      }
    }
    at = { ...at, lint: lintChecks(at.working?.verify ?? []) }
  }
  places.set(start, { ...at, readAt: Date.now() })

  return at
}

/**
 * Reads the config as `look` does and keeps state in step with it: the
 * policy in force (and so the mode a failed guard falls back on), the last
 * config that parsed, and the loop of the repository the session is now in.
 */
export async function locate($: Engine): Promise<Place> {
  const looked = await look($)
  // Opted in by the working tree's copy or the base branch's (C2.1): the policy in force says which.
  const at: Place = { ...looked, isOptedIn: looked.working !== null || (await policyInForce($, looked)) !== null }
  const mode: Mode = modeInForce(at)
  if (mode !== kept) {
    kept = await update($, MODE, () => mode)
  }
  if (at.working !== null && at.text !== null && !at.isFallback && keptText.get(at.root) !== at.text) {
    await $.store.set(`config:${at.root}`, at.text)
    keptText.set(at.root, at.text)
  }
  if (at.isFallback && at.text !== null && !toldFallback.has(at.text)) {
    toldFallback.add(at.text)
    $.ui.toast(`devloop: devloop.json does not parse (${at.errors[0] ?? ''}). /devloop doctor says more.`, { timeoutMs: 12_000 })
  }
  if (at.isOptedIn) {
    const loop = await loopOf($)
    if (loop.root !== null && loop.root !== at.root) {
      await restore($, at.root, loop.sessionId)
    }
  }

  return at
}

/** One line of where the loop stands, for the status line and the model. */
export function brief(loop: Loop): string {
  const mark = (status: string): string =>
    status === 'pass' ? 'ok' : status === 'fail' ? 'FAILING' : status === 'running' ? 'running' : status === 'error' ? 'error' : 'not run'
  const parts = [
    loop.phase === 'idle' ? 'small-fix mode' : `${loop.phase} "${loop.spec ?? ''}"`,
  ]
  if (loop.phase === 'build') {
    const { passing, total } = featureCounts(loop)
    parts.push(`${passing}/${total} features`)
  }
  if (loop.tier !== 'none') {
    parts.push(`${loop.tier} risk`, `verify ${loop.isDirty && loop.verify.status === 'pass' ? 'stale' : mark(loop.verify.status)}`)
    if (loop.tier !== 'low') {
      // A verdict with a promoted checklist failure on its tree is a failing verdict wherever it is shown (final round, D2 F2).
      const isFailing = loop.review.status === 'pass' && (loop.checklistFails ?? []).some(one => one.tree !== null && one.tree === loop.review.tree)
      // A cycle that passed on another tree, its verdict reset by a verification of the moved tree: out of date (rule 15), as the gate's row says.
      const isStale = loop.review.status === 'none' && loop.review.cycle.ended === 'pass' && loop.review.tree !== null && loop.review.tree !== loop.tree
      // Rounds ran but none passed and the cap is spent: say so, not "not run" (a person reads the change now).
      const isSpent = loop.review.status === 'none' && loop.review.cycle.ended === 'cap'
      parts.push(`review ${isStale ? 'stale' : isSpent ? `rounds spent (${loop.review.round})` : mark(isFailing ? 'fail' : loop.review.status)}`)
    }
  }

  return parts.join(' · ')
}

/**
 * Changes the loop's state, keeps it for the next session and clears
 * any pinned status line. Every write goes through here.
 */
export async function save($: Engine, root: string, change: (loop: Loop) => Loop): Promise<Loop> {
  const next = await update($, LOOP, loop => ({ ...change(loop), root }))
  await $.store.set(`loop:${root}`, { shape: SHAPE, value: next })
  // The status row is the AbovePrompt band; clear any line an earlier version pinned.
  $.ui.status(undefined)

  return next
}

/**
 * Brings back what an earlier session left for this repository. The same
 * session id means the plugin reloaded: nothing is reset. A new session drops
 * what belonged to the one that ended: a review whose agent is gone, one-turn
 * exemptions, a running eval, a session budget.
 */
export async function restore($: Engine, root: string, sessionId: string | null): Promise<{ loop: Loop; isReload: boolean }> {
  const stored = (await $.store.get(`loop:${root}`)) as { shape?: string; value?: Loop } | undefined
  const base = upgraded(stored)
  // An upgraded loop is kept under this shape at once.
  if (stored?.value !== undefined && (stored.shape === PREVIOUS || (stored.shape === SHAPE && base !== stored.value))) {
    await $.store.set(`loop:${root}`, { shape: SHAPE, value: base })
  }
  const isReload = sessionId !== null && base.sessionId === sessionId
  const loop = await update($, LOOP, (): Loop => isReload
    ? { ...base, root }
    : {
        ...base,
        root,
        sessionId,
        // A round whose session ended gave no verdict: like an interrupted round, it does not use up the cap.
        review: base.review.status === 'running' ? { ...base.review, status: 'none' as const, agentId: null, agents: [], round: Math.max(0, base.review.round - 1) } : base.review,
        allow: [],
        refusals: FRESH.refusals,
        blocked: null,
        budgetUsd: null,
        isOverBudget: false,
        evalRun: null,
        // The proposer's runs are bounded per session (DESIGN 4.17): a new session starts the count over, and an agent of the last one is gone.
        learner: FRESH.learner,
      })

  return { loop, isReload }
}

/**
 * The loop a stored value holds: one of this shape as it is; one of the
 * shape before (an upgrade mid-change) with the fields added since filled
 * empty, so its phase, findings, verdicts, passes and loop limit carry; any
 * older one, or none, fresh.
 */
function upgraded(stored: { shape?: string; value?: Loop } | undefined): Loop {
  if (stored?.value === undefined) {
    return FRESH
  }
  if (stored.shape === SHAPE) {
    return withCycle(stored.value)
  }
  if (stored.shape !== PREVIOUS) {
    return FRESH
  }
  const before = stored.value as Omit<Loop, 'background' | 'verify'> & { verify: Omit<Loop['verify'], 'runs'> }

  return withCycle({ ...before, background: {}, verify: { ...before.verify, runs: {} } })
}

/**
 * A loop kept before review cycles (rule 5) given one: a review that passed
 * ended its cycle with a pass, so the cap does not refuse the next round,
 * and the tree of a round that settled is the one the next round reads from.
 */
function withCycle(loop: Loop): Loop {
  const review = loop.review as Omit<Loop['review'], 'cycle'> & { cycle?: Loop['review']['cycle'] }
  if (review.cycle !== undefined) {
    return loop
  }
  const isSettled = review.status === 'pass' || review.status === 'fail'

  return { ...loop, review: { ...review, cycle: { ...FRESH.review.cycle, ended: review.status === 'pass' ? 'pass' : null, settledTree: isSettled ? review.tree : null } } }
}

/** Marks a review abandoned when it has been `running` past its lifetime: its agent is not coming back. */
export async function abandonStale($: Engine, root: string): Promise<void> {
  const loop = await loopOf($)
  const now = await $.clock.now()
  if (loop.review.status === 'running' && now - loop.review.at > REVIEW_LIFETIME_MS) {
    await save($, root, before => note({ ...before, review: { ...before.review, status: 'none', agentId: null, agents: [], round: Math.max(0, before.review.round - 1) } }, 'review', `review round ${before.review.round} abandoned: no verdict in 30 minutes (it does not count toward the cap)`, now))
  }
}

export const note = (loop: Loop, kind: LoopEvent['kind'], text: string, at: number): Loop => ({
  ...loop,
  events: [...loop.events, { at, kind, text }].slice(-12),
})

/**
 * Records that the harness itself failed while verifying: never a blocked
 * stop (a broken harness must not trap a session), but the gate stays shut
 * and the person is told.
 */
export async function markError($: Engine, why: string): Promise<void> {
  const loop = await loopOf($)
  if (loop.root === null) {
    return
  }
  const now = await $.clock.now().catch(() => 0)
  await save($, loop.root, before => note({ ...before, verify: { ...before.verify, status: 'error', failed: why.slice(0, 200) } }, 'verify', `the harness could not verify: ${why.slice(0, 120)}`, now))
  $.ui.toast(`devloop: the stop gate failed to run (${why.slice(0, 120)}). The change is not verified; /devloop verify retries.`, { timeoutMs: 12_000 })
}

// ---------------------------------------------------------------- ledger

/** One ledger entry; a lesson the harness wrote itself (DESIGN 4.17) is marked `auto` and counts `count` occurrences. */
export type Failure = { at: number; kind: string; key: string; detail: string; count?: number; auto?: true }

/** Records one failure for /devloop learn: a refused edit, a failed check, a finding. */
export async function record($: Engine, root: string, kind: string, key: string, detail: string): Promise<void> {
  const list = ((await $.store.get(`ledger:${root}`)) as Failure[] | undefined) ?? []
  const at = await $.clock.now()
  await $.store.set(`ledger:${root}`, [...list, { at, kind, key, detail: detail.slice(0, 300) }].slice(-300))
  await bump($, root, kind)
}

/**
 * Records a lesson the harness wrote from what it holds (DESIGN 4.17,
 * decision 1): one entry per key, marked `auto`; the same event again raises
 * its count (and moves it to the end, so it outlives the ledger's cap)
 * instead of adding an entry. Resolves to its count after.
 */
export async function recordLesson($: Engine, root: string, key: string, detail: string): Promise<number> {
  const list = ((await $.store.get(`ledger:${root}`)) as Failure[] | undefined) ?? []
  const at = await $.clock.now()
  const known = list.find(one => one.kind === 'lesson' && one.key === key && one.auto === true)
  const count = (known?.count ?? 0) + 1
  const entry: Failure = { at, kind: 'lesson', key, detail: detail.slice(0, 300), count, auto: true }
  await $.store.set(`ledger:${root}`, [...list.filter(one => one !== known), entry].slice(-300))
  await bump($, root, 'lesson')

  return count
}

export async function ledger($: Engine, root: string): Promise<Failure[]> {
  return ((await $.store.get(`ledger:${root}`)) as Failure[] | undefined) ?? []
}

export async function bump($: Engine, root: string, name: string, by = 1): Promise<void> {
  const all = await metrics($, root)
  await $.store.set(`metrics:${root}`, { ...all, [name]: (all[name] ?? 0) + by })
}

export async function metrics($: Engine, root: string): Promise<Record<string, number>> {
  return ((await $.store.get(`metrics:${root}`)) as Record<string, number> | undefined) ?? {}
}

// ---------------------------------------------------------------- the meters and the question ledger (C1)

/** The cache-health meter of a repository, as last kept. */
export async function cacheOf($: Engine, root: string): Promise<CacheState> {
  const kept = (await $.store.get(`cache:${root}`)) as CacheState | undefined

  return kept === undefined || typeof kept !== 'object' || kept === null || !('session' in kept) ? EMPTY_CACHE : kept
}

export async function saveCache($: Engine, root: string, change: (state: CacheState) => CacheState): Promise<CacheState> {
  const next = change(await cacheOf($, root))
  await $.store.set(`cache:${root}`, next)

  return next
}

/** The context-cost estimate a session last kept. */
export async function attributionOf($: Engine, root: string): Promise<Attribution> {
  return ((await $.store.get(`attribution:${root}`)) as Attribution | undefined) ?? EMPTY_ATTRIBUTION
}

/** Every question the builder recorded for a person, open and closed. */
export async function questionsOf($: Engine, root: string): Promise<Question[]> {
  return ((await $.store.get(`questions:${root}`)) as Question[] | undefined) ?? []
}

export async function saveQuestions($: Engine, root: string, list: readonly Question[]): Promise<void> {
  await $.store.set(`questions:${root}`, list)
}

/** Records one open question; resolves to its id. */
export async function addOpenQuestion($: Engine, root: string, question: string, context: string | null, at: number): Promise<string> {
  const made = addQuestion(await questionsOf($, root), question, context, at)
  await saveQuestions($, root, made.list)
  await record($, root, 'question', made.id, question)

  return made.id
}

// ---------------------------------------------------------------- the harness's own files

/** The plugin's data folder, once looked up; null when the engine could not give one. */
let dataFolder: string | null | undefined

/**
 * Where the harness keeps state it needs outside the working tree (saved
 * check output, the reviewer's diff): the plugin's data folder, or a folder
 * under /tmp when there is none. The guards refuse every write beneath it.
 */
export async function stateRootOf($: Engine): Promise<string> {
  if (dataFolder === undefined) {
    const env = await $.process.hookEnv().catch(() => ({}) as Record<string, string>)
    const found = env.CLAUDE_PLUGIN_DATA
    dataFolder = found === undefined || found === '' ? null : found.replace(/\/+$/, '')
  }

  return dataFolder ?? '/tmp/devloop-state'
}

/** This repository's folder within the harness's state, keyed by its root. */
export async function stateDirOf($: Engine, root: string): Promise<string> {
  return `${await stateRootOf($)}/repos/${digest(root)}`
}

/** Where a check's last full output is kept. */
export const outputPath = (dir: string, command: string): string => `${dir}/checks/${digest(command)}.log`

// ---------------------------------------------------------------- the working tree

/** Whether the last snapshot of a root reached the sweep's cap: how many matched, for the gate note and doctor. */
const cappedAt = new Map<string, number | null>()

/** The last snapshot's sweep count past the cap for a root, or null. */
export const sweepCapped = (root: string): number | null => cappedAt.get(root) ?? null

/** The index entries git is told not to look at, from the last snapshot of a root (the last review's F2), for the gate row. */
const hiddenAt = new Map<string, string[]>()

/**
 * The working tree as git has it. `cfg` is the policy in force: its default
 * branch finds the base and its instruction globs say which ignored files are
 * hashed in all the same. Every other path is in the hash; none is left out.
 */
export async function snapshot($: Engine, at: Place, cfg: Config): Promise<Snapshot> {
  try {
    const { base } = await loopOf($)
    const ran = await $.process.run(['bash', '-c', SNAPSHOT, 'devloop', cfg.defaultBranch, base ?? '', ...sweepSpecsOf(cfg)], {
      cwd: at.root,
      timeoutMs: 60_000,
    })
    // Empty output means outside git only when the script itself ran to its exit 0.
    const snap = ran.exitCode === 0 ? readSnapshot(ran.stdout) : NO_SNAPSHOT
    if (snap.tree !== null) {
      bases.set(baseKey(at.root, cfg.defaultBranch, base), snap.base)
      cappedAt.set(at.root, snap.capped)
      hiddenAt.set(at.root, snap.hidden)
    }

    return snap
  } catch {
    return NO_SNAPSHOT
  }
}

/** Runs one of the harness's own git scripts in the repository; null when it could not run. */
export async function git($: Engine, at: Place, script: string, args: readonly string[], timeoutMs = 30_000): Promise<{ code: number; out: string } | null> {
  const ran = await $.process.run(['bash', '-c', script, 'devloop', ...args], { cwd: at.root, timeoutMs }).catch(() => null)

  return ran === null ? null : { code: ran.exitCode, out: ran.stdout }
}

const BETWEEN = `
# devloop:between
git -c core.quotePath=false diff --no-renames --name-only "$1" "$2"
`

const COVERED = `
# devloop:covered-files
git -c core.quotePath=false ls-tree -r --full-tree "$1"
`

/**
 * The key of the files each check with \`when\` covers on a tree (DESIGN 4.16,
 * decision 7): what a pass of it is kept against under targeted testing. A
 * check with no key (git could not list the tree, or no file matches) has
 * none, so it runs as before.
 */
export async function coveredKeys($: Engine, at: Place, steps: readonly Step[], tree: string | null): Promise<Record<string, string>> {
  const scoped = steps.filter(one => one.when !== null)
  if (tree === null || scoped.length === 0) {
    return {}
  }
  const ran = await git($, at, COVERED, [tree], 60_000)
  if (ran === null || ran.code !== 0) {
    return {}
  }

  return Object.fromEntries(scoped.flatMap(one => {
    const key = coveredKey(ran.out, one.when ?? [])

    return key === null ? [] : [[one.run, key] as const]
  }))
}

/** The files that differ between two trees the snapshot wrote; null when git cannot say. */
async function changedBetween($: Engine, at: Place, from: string, to: string): Promise<string[] | null> {
  const ran = await git($, at, BETWEEN, [from, to])

  return ran === null || ran.code !== 0 ? null : ran.out.split('\n').filter(line => line !== '')
}

/**
 * The branch checked out, for a decision taken before any snapshot (the
 * ship-alone rule's merges, C2.1 F2): a name, `(detached)`, or null when it
 * cannot be told (outside git, a script that failed), which counts as
 * possibly the default branch.
 */
export async function currentBranch($: Engine, at: Place): Promise<string | null> {
  const ran = await git($, at, CURRENT_BRANCH, [], 10_000)
  const line = (ran?.out ?? '').split('\n').find(one => one.startsWith('branch:'))

  return ran === null || ran.code !== 0 || line === undefined || line === 'branch:' ? null : line.slice('branch:'.length).trim()
}

/** This repository's origin as `owner/name` (D1), for a `gh` ship that names a repository; null when there is none. */
export async function remoteOf($: Engine, at: Place): Promise<string | null> {
  const ran = await git($, at, REMOTE_URL, [], 10_000)

  return ran === null || ran.code !== 0 || ran.out.trim() === '' ? null : repoSlug(ran.out.trim())
}

export type { InForce } from './inforce'

/** What `policyAt` found per root, base commit and working text; null kept too, so a dormant repository runs git once. */
const policies = new Map<string, InForce | null>()
/** The policy in force last found, by root: for the pane and the mode fallback, which run nothing. */
const lastPolicy = new Map<string, InForce>()
/** The base found for a root, a default branch and the last closed change's commit. */
const bases = new Map<string, string | null>()

const baseKey = (root: string, branch: string, closed: string | null): string => `${root}\n${branch}\n${closed ?? ''}`

/** The base the snapshot would find, without taking one: the last snapshot's, or the script's answer. */
async function baseFor($: Engine, at: Place, branch: string): Promise<string | null> {
  const { base: closed } = await loopOf($)
  const key = baseKey(at.root, branch, closed)
  const known = bases.get(key)
  if (known !== undefined) {
    return known
  }
  const ran = await git($, at, FIND_BASE, [branch, closed ?? ''])
  const said = (ran?.out ?? '').split('\n')[0]?.trim() ?? ''
  const found = ran === null || ran.code !== 0 || said === '' || said === 'unknown' ? null : said
  bases.set(key, found)

  return found
}

/**
 * devloop.json at a base commit, compared with the working tree's: the
 * policy in force for that base. With no working copy (null), the base's
 * when it has one (`deleted`), else null: not opted in.
 */
async function policyAt($: Engine, at: Place, working: Config | null, base: string | null): Promise<InForce | null> {
  const key = `${at.root}\n${base ?? ''}\n${working === null ? '\u0000' : at.text ?? ''}`
  if (policies.has(key)) {
    return policies.get(key) ?? null
  }
  const ran = base === null ? null : await git($, at, BASE_POLICY, [base])
  const text = ran !== null && ran.code === 0 ? ran.out : null
  // A copy on the base that does not parse is still the base's: its defaults (enforce) are in force, never the working tree's.
  const found = decidePolicy(working, at.text, text)
  // A script that could not run says nothing either way: asked again next time.
  if (found !== null || ran !== null || base === null) {
    policies.set(key, found)
  }

  return found
}

/** The default branch to look for the base by, before any policy in force was found: the last config that parsed here, else the default's. */
async function lastBranch($: Engine, root: string): Promise<string> {
  const kept = (await $.store.get(`config:${root}`)) as string | undefined
  const parsed = typeof kept === 'string' ? parseConfig(kept) : null

  return parsed?.isParsed === true ? parsed.cfg.defaultBranch : parseConfig('{}').cfg.defaultBranch
}

/**
 * The one way any code obtains policy for a decision (guards, verification,
 * the scrub, review, the gate, content rules, tiers, instruction globs,
 * evals): the base branch's devloop.json in full when the base has a copy,
 * the working tree's otherwise. Null where the repository has not opted in.
 * With a snapshot, its base is used; without one, the base is found the way
 * the snapshot finds it. The base is looked for from the default branch the
 * last policy in force named (the working tree's before the first), and
 * looked for again when the base's own policy names another.
 */
export async function policyInForce($: Engine, at: Place, snap?: Snapshot): Promise<InForce | null> {
  const working = at.working
  let found: InForce | null
  if (snap !== undefined && snap.tree !== null) {
    found = await policyAt($, at, working, snap.base)
  } else {
    const branch = lastPolicy.get(at.root)?.cfg.defaultBranch ?? working?.defaultBranch ?? (await lastBranch($, at.root))
    found = await policyAt($, at, working, await baseFor($, at, branch))
    if (found !== null && found.source === 'base' && found.cfg.defaultBranch !== branch) {
      const again = await policyAt($, at, working, await baseFor($, at, found.cfg.defaultBranch))
      if (again !== null && again.source === 'base') {
        found = again
      }
    }
  }
  // With no working copy the repository is opted in exactly when the base has one (C2.1).
  if (working === null) {
    baseOptIn.set(at.root, found !== null)
  }
  if (found === null) {
    lastPolicy.delete(at.root)
  } else {
    lastPolicy.set(at.root, found)
  }

  return found
}

/**
 * A snapshot taken by the policy in force, and that policy as the
 * snapshot's base has it: what a decision about the tree needs. Null where
 * the repository has not opted in.
 */
export async function snapshotInForce($: Engine, at: Place): Promise<{ policy: InForce; snap: Snapshot } | null> {
  const first = await policyInForce($, at)
  if (first === null) {
    return null
  }
  const snap = await snapshot($, at, first.cfg)
  const policy = (await policyInForce($, at, snap)) ?? first

  return { policy, snap }
}

/**
 * The policy `policyInForce` last found for a root, without running
 * anything: for the pane (a render hook) and nowhere a decision is taken.
 * The working tree's, marked so, before the first.
 */
export function heldPolicy(at: Place): InForce | null {
  return lastPolicy.get(at.root) ?? (at.working === null ? null : { cfg: at.working, source: 'working', policy: 'no-base' })
}

/** The mode in force (the policy in force's), from what `policyInForce` last found: a failed guard falls back on it. */
export function modeInForce(at: Place): Mode {
  return heldPolicy(at)?.cfg.mode ?? 'off'
}

/** What the gate needs beside the loop: the working copy's errors, the lint of the checks in force, and how the copies compare. */
export const factsOf = (at: Place, policy: InForce | null): GateFacts => ({
  errors: at.errors,
  lint: policy === null ? at.lint : lintChecks(policy.cfg.verify),
  policy: policy?.policy ?? 'same',
  workingMode: policy !== null && policy.policy === 'changed' && at.working !== null && at.working.mode !== policy.cfg.mode ? at.working.mode : null,
  exposed: exposed ?? [],
  ignoredCapped: cappedAt.get(at.root) ?? null,
  carry: carryFactsOf(at.root, policy?.cfg ?? null),
  hiddenFromGit: hiddenAt.get(at.root) ?? [],
})


/**
 * The files a push to the default branch would land: the commits on `source`
 * not yet on the remote's default branch. Null when the remote branch is not
 * known here, so what would ship cannot be told.
 */
export async function pushRange($: Engine, at: Place, cfg: Config, source: string): Promise<string[] | null> {
  const ran = await git($, at, PUSH_RANGE, [cfg.defaultBranch, source])
  const lines = (ran?.out ?? 'unknown').split('\n').filter(line => line !== '')

  return lines[0] !== 'known' ? null : lines.slice(1)
}


/**
 * The tracked files at or beneath each path (`''` is the whole tree), for
 * judging a command that writes it: a folder's files, or the path itself
 * when it is a tracked file. Empty (every path unknown) when git cannot
 * say, so the rules fall back on the globs alone.
 */
export async function filesUnder($: Engine, at: Place, dirs: readonly string[]): Promise<Record<string, string[]>> {
  if (dirs.length === 0) {
    return {}
  }
  const ran = await git($, at, LS_FILES, dirs.map(dir => (dir === '' ? '.' : dir)))
  if (ran === null || ran.code !== 0) {
    return {}
  }
  const files = ran.out.split('\n').filter(line => line !== '')

  return Object.fromEntries(dirs.map(dir => [dir, files.filter(file => dir === '' || file === dir || file.startsWith(`${dir}/`))]))
}

const REVIEW_DIFF = `
# devloop:review-diff
dir=$(mktemp -d)
idx="$dir/index"
cp -p "$(git rev-parse --git-path index)" "$idx" 2>/dev/null
tree=$(GIT_INDEX_FILE="$idx" git add -A . >/dev/null 2>&1 && GIT_INDEX_FILE="$idx" git write-tree 2>/dev/null)
rm -rf "$dir"
mkdir -p "$(dirname "$2")"
git -c core.quotePath=false diff --no-renames --no-ext-diff --no-textconv "$1" "$tree" >"$2"
`

/**
 * Writes the change's whole diff, untracked files included, to a file in the
 * harness's state for the reviewer to read: it needs no git command of its own.
 */
export async function writeReviewDiff($: Engine, at: Place, base: string | null, round: number): Promise<string | null> {
  const file = `${await stateDirOf($, at.root)}/review-${round}.diff`
  const ran = await git($, at, REVIEW_DIFF, [base ?? 'HEAD', file], 60_000)
  if (ran === null || ran.code !== 0) {
    return null
  }
  await keep($, at, file)
  // The diff's hash, kept in the plugin's store (the cache-guard round, R11): the reviewer's read of the file is checked against it.
  const text = await $.fs.read(file).catch(() => null)
  await $.store.set(diffHashKey(at.root, round), text === null ? null : await sha256(text))

  return file
}

/** Where the hash of a round's diff file is kept, in the plugin's store (no tool call writes it). */
const diffHashKey = (root: string, round: number): string => `review-diff:${root}:${round}`

/** A text's SHA-256, in hex. */
async function sha256(text: string): Promise<string> {
  const hashed = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)))

  return [...hashed].map(byte => byte.toString(16).padStart(2, '0')).join('')
}

/**
 * Checks a round's diff file against the hash kept when the harness wrote it
 * (R11), before the reviewer reads it. On a mismatch (the file was changed,
 * or is gone) it writes the diff again from the tree and says so (true), so
 * the read goes on and reads the harness's own diff; false when it matched
 * or there is no hash to check against. Never makes the read fail.
 */
export async function checkReviewDiff($: Engine, at: Place, cfg: Config, round: number): Promise<boolean> {
  const kept = (await $.store.get(diffHashKey(at.root, round))) as string | null | undefined
  if (typeof kept !== 'string') {
    return false
  }
  const file = `${await stateDirOf($, at.root)}/review-${round}.diff`
  const text = await $.fs.read(file).catch(() => null)
  if (text !== null && (await sha256(text)) === kept) {
    return false
  }
  const snap = await snapshot($, at, cfg)
  await writeReviewDiff($, at, snap.base, round)

  return true
}

/** How many of the harness's saved files (check logs, review diffs) a repository keeps. */
export const KEPT_FILES = 20

const CLEAR_STATE = `
# devloop:clear-state
rm -f -- "$@"
`

/**
 * Records a file the harness just saved in its state, newest last, and
 * deletes the oldest beyond the last twenty, so the state stays tidy.
 */
async function keep($: Engine, at: Place, file: string): Promise<void> {
  const key = `files:${at.root}`
  const before = ((await $.store.get(key)) as string[] | undefined) ?? []
  const all = [...before.filter(one => one !== file), file]
  const gone = all.slice(0, Math.max(0, all.length - KEPT_FILES))
  if (gone.length > 0) {
    await git($, at, CLEAR_STATE, gone)
  }
  await $.store.set(key, all.slice(gone.length))
}

/** Deletes every check log and review diff the harness kept for this repository: a closed change leaves none. */
export async function clearKept($: Engine, at: Place): Promise<void> {
  const key = `files:${at.root}`
  const all = ((await $.store.get(key)) as string[] | undefined) ?? []
  if (all.length > 0) {
    await git($, at, CLEAR_STATE, all)
  }
  await $.store.set(key, [])
}

/** Folds a snapshot into the loop: git's list of changed files is the truth where there is one. */
export function withSnapshot(loop: Loop, snap: Snapshot, cfg: Config): Loop {
  if (snap.tree === null) {
    return snap.isOutsideGit === true ? { ...loop, isOutsideGit: true } : loop
  }
  // Instruction files git ignores count as changed when their content differs from the change's start.
  const ignoredBase = loop.ignoredBase ?? snap.ignored
  const moved = [...new Set([...Object.keys(snap.ignored), ...Object.keys(ignoredBase)])].filter(file => snap.ignored[file] !== ignoredBase[file])
  const changed = [...new Set([...snap.files, ...moved])]
  const hasTouchedTests = changed.some(file => matchesAny(file, cfg.tests))

  return {
    ...loop,
    ...(loop.isOutsideGit === true ? { isOutsideGit: false } : {}),
    ignoredBase,
    tree: snap.tree,
    isBaseKnown: snap.base !== null,
    changed,
    hasTouchedTests,
    size: snap.size,
    tier: tierFor({ changed, size: snap.size, spec: loop.spec }, cfg),
    isDirty: snap.tree !== loop.verify.tree || loop.verify.status !== 'pass',
  }
}

export type Ran = {
  isPassing: boolean
  code: number
  /** How it ended: a pass, a real failure, or a check that could not run at all. */
  outcome: Outcome
  /** What the model reads: the error lines and the tail. */
  output: string
  /** The end of everything it printed, for the fingerprint. */
  raw: string
}


const ENV_NAMES = `
# devloop:env-names
compgen -e
`

/** Credential-shaped variable names in the environment checks inherit, once read; null before. */
let exposed: string[] | null = null

/** The credential-shaped variables a check run with the full environment could see (read once per process). */
export async function credentialNames($: Engine): Promise<string[]> {
  if (exposed === null) {
    const ran = await $.process.run(['bash', '-c', ENV_NAMES, 'devloop'], { timeoutMs: 10_000 }).catch(() => null)
    exposed = [...new Set((ran?.stdout ?? '').split('\n').filter(isCredentialName))].sort()
  }

  return exposed
}


/**
 * Runs one shell command in the repository and keeps what it said. `scrub`
 * is the policy's `checkEnv` for a verify command or a feature check; null
 * for the harness's own commands.
 */
export async function run($: Engine, command: string, cwd: string, timeoutSec: number, scrub: CheckEnv | null = null): Promise<Ran> {
  try {
    const ran = await $.process.run(checkArgv(command, scrub), { cwd, timeoutMs: timeoutSec * 1000 })
    const raw = `${ran.stdout}\n${ran.stderr}`.slice(-100_000)

    return { isPassing: ran.exitCode === 0, code: ran.exitCode, outcome: classify(ran.exitCode, raw), output: distill(raw), raw }
  } catch {
    const said = `No result within ${timeoutSec}s (or the command could not start).`

    return { isPassing: false, code: -1, outcome: 'timeout', output: said, raw: said }
  }
}

/** Keeps a check's whole output where the builder can read it (and not write it); the path, or null. */
export async function keepOutput($: Engine, at: Place, command: string, raw: string): Promise<string | null> {
  const file = outputPath(await stateDirOf($, at.root), command)
  const saved = await $.fs.write(file, raw).then(() => file, () => null)
  if (saved !== null) {
    await keep($, at, saved)
  }

  return saved
}

export type Verified = {
  isPassing: boolean
  failed: string | null
  output: string
  /** The failure's fingerprint; null on a pass. */
  fingerprint: string | null
  /** Checks that failed, then passed on a rerun. */
  flaky: string[]
  passed: string[]
  /** Where the failing check's whole output was kept. */
  saved: string | null
  /** How the failing check ended when it could not run at all; null for a real failure or a pass. */
  infra: Outcome | null
  /** The covered-files key of each check with \`when\` that passed (DESIGN 4.16), by command. */
  covered: Record<string, string>
  /** Checks whose pass carried to this tree because the files they cover did not change (targeted testing). */
  carried: string[]
  /** What each check this run ran did on the tree, with how long it took, by command (`loop.verify.runs`). */
  runs: Record<string, CheckRecord>
}

/**
 * Runs checks in order and stops at the first that fails. A failure that
 * looks like a flake (see isFlakeSuspect) is run once more before it counts.
 * Under targeted testing (DESIGN 4.16) the check that failed last runs
 * first, and a check with \`when\` whose covered files are as they were when
 * it passed is not run again.
 */
async function verify($: Engine, at: Place, cfg: Config, loop: Loop, profile: Profile, tree: string | null, timeoutSec = cfg.verifyTimeoutSec): Promise<Verified> {
  // A pass is recorded per check with the tree it ran on: a check that
  // already passed on this very tree is not run again, and every other one is.
  const failedLast = loop.verify.status === 'fail' ? loop.verify.failed : null
  const steps = orderSteps(stepsFor(cfg.verify, profile, loop.changed), failedLast, cfg)
  if (cfg.checkEnv.mode === 'observe') {
    await credentialNames($)
  }
  const keys = cfg.testing.scope === 'targeted' ? await coveredKeys($, at, steps, tree) : {}
  const covered = (run: string): Record<string, string> => (keys[run] === undefined ? {} : { [run]: keys[run] })
  const flaky: string[] = []
  const passed: string[] = []
  const carried: string[] = []
  const passedKeys: Record<string, string> = {}
  const runs: Record<string, CheckRecord> = {}
  for (const step of steps) {
    if (tree !== null && loop.verify.passedOn[step.run] === tree) {
      passed.push(step.run)
      Object.assign(passedKeys, covered(step.run))
      continue
    }
    // A pass kept against the files the check covers (decision 7): never for the check that failed last.
    if (step.run !== failedLast && isCoveredPass(step, cfg, (loop.verify.covered ?? {})[step.run], keys[step.run] ?? null)) {
      passed.push(step.run)
      carried.push(step.run)
      Object.assign(passedKeys, covered(step.run))
      continue
    }
    const began = await $.clock.now()
    let ran = await run($, step.run, at.root, timeoutSec, cfg.checkEnv)
    // A check that could not run is not a flake: rerunning it changes nothing.
    if (!ran.isPassing && ran.outcome === 'fail') {
      const passedOn = loop.verify.passedOn[step.run]
      const since = passedOn === undefined || tree === null ? null : passedOn === tree ? [] : await changedBetween($, at, passedOn, tree)
      if (isFlakeSuspect(step, passedOn !== undefined, since)) {
        ran = await run($, step.run, at.root, timeoutSec, cfg.checkEnv)
        if (ran.isPassing) {
          flaky.push(step.run)
        }
      }
    }
    // How long the check took, its rerun included: the summary names it (rule 6).
    const ended = await $.clock.now()
    const saved = await keepOutput($, at, step.run, ran.raw)
    runs[step.run] = { tree, outcome: ran.outcome, at: ended, durationMs: Math.max(0, ended - began), lines: ran.isPassing ? '' : ran.output.split('\n').slice(0, 10).join('\n'), isOlderTree: false, saved }
    if (!ran.isPassing) {
      return {
        isPassing: false,
        failed: step.run,
        output: `$ ${step.run}  (exit ${ran.code})\n${ran.output}`,
        fingerprint: fingerprint(step.run, ran.raw),
        flaky,
        passed,
        saved,
        infra: ran.outcome === 'fail' || ran.outcome === 'pass' ? null : ran.outcome,
        covered: passedKeys,
        carried,
        runs,
      }
    }
    passed.push(step.run)
    Object.assign(passedKeys, covered(step.run))
  }

  return { isPassing: true, failed: null, output: '', fingerprint: null, flaky, passed, saved: null, infra: null, covered: passedKeys, carried, runs }
}

export type VerifiedNow = {
  loop: Loop
  ran: Verified
  /** The failure is the same as the last run's: the fix in between did not change it. */
  isRepeat: boolean
}

/**
 * Verifies the tree as it stands with one profile's checks and writes the
 * outcome down. The one place that sets `verify`, so a pass always names the
 * tree and the profile it covers.
 */
export async function verifyNow($: Engine, at: Place, cfg: Config, profile: Profile, timeoutSec = cfg.verifyTimeoutSec): Promise<VerifiedNow> {
  const snap = await snapshot($, at, cfg)
  const before = withSnapshot(await loopOf($), snap, cfg)
  const ran = await verify($, at, cfg, before, profile, snap.tree, timeoutSec)
  const now = await $.clock.now()
  const isRepeat = ran.fingerprint !== null && ran.fingerprint === before.verify.fingerprint
  await bump($, at.root, 'verify-runs')
  for (const command of ran.flaky) {
    await record($, at.root, 'verify-flaky', `flaky:${command}`, 'failed, then passed on a rerun with nothing it watches changed')
  }
  if (!ran.isPassing) {
    await record($, at.root, ran.infra === null ? 'verify-fail' : 'check-infra', ran.infra === null ? `${ran.failed ?? ''} #${ran.fingerprint ?? ''}` : `${ran.failed ?? ''} (${ran.infra})`, ran.output)
  }
  // The test files are hashed with the tests globs of the policy in force (`cfg`), as at approval.
  const evidence = await evidenceOf($, at, cfg, before, snap)
  // A verdict covers the tree it read; it carries to a tree that differs from it only in task state (D2), decided afresh from the diff (final round F1).
  const carried = (await coverageNow($, at, cfg, before, snap.tree)) === 'carried'
  const names = new Set(cfg.verify.map(one => one.run))
  const loop = await save($, at.root, latest => {
    const passedOn = Object.fromEntries(Object.entries(latest.verify.passedOn).filter(([command]) => names.has(command)))
    if (snap.tree !== null) {
      for (const command of ran.passed) {
        passedOn[command] = snap.tree
      }
    }
    // A check that failed keeps no covered-files key: it runs again (DESIGN 4.16).
    const covered = { ...Object.fromEntries(Object.entries(latest.verify.covered ?? {}).filter(([command]) => names.has(command) && command !== ran.failed)), ...ran.covered }
    const events = ran.flaky.reduce((loop_, command) => note(loop_, 'verify', `flaky: ${command} failed, then passed on a rerun`, now), latest)

    return note(
      {
        ...withSnapshot(events, snap, cfg),
        evidence,
        isDirty: !ran.isPassing,
        // A verdict covers the tree it read: a tree that moved needs a new round.
        review:
          carried && latest.review.tree === before.review.tree
            ? latest.review
            : snap.tree !== latest.verify.tree && latest.review.status !== 'running'
              ? { ...latest.review, status: 'none' }
              : latest.review,
        verify: {
          ...latest.verify,
          status: ran.isPassing ? 'pass' : 'fail',
          failed: ran.failed,
          at: now,
          tree: snap.tree,
          profile: ran.isPassing ? profile : 'none',
          fingerprint: ran.fingerprint,
          passedOn,
          covered,
          infra: ran.infra,
          // Merged: a background check's record is never dropped by a foreground run.
          runs: { ...latest.verify.runs, ...ran.runs },
        },
      },
      'verify',
      ran.isPassing
        ? `${profile} verification passed${ran.carried.length > 0 ? ` (${ran.carried.join(', ')}: passed before on the files it covers, not run again)` : ''}`
        : ran.infra !== null
          ? `${profile} verification could not run: ${ran.failed ?? ''} (${ran.infra})`
          : `${profile} verification failed: ${ran.failed ?? ''}${isRepeat ? ' (same failure as before)' : ''}`,
      now,
    )
  })

  return { loop, ran, isRepeat }
}

// ---------------------------------------------------------------- the .tasks integration and the review carry-over (D2)

const TASKS_PROBE = `
# devloop:tasks-probe
if [ -f .tasks/config.yml ]; then echo "tree:yes"; grep -E '^version:' .tasks/config.yml | head -1; else echo "tree:no"; fi
if command -v tasks >/dev/null 2>&1; then echo "command:yes"; else echo "command:no"; fi
`

const TASKS_VALIDATE = `
# devloop:tasks-validate
tasks validate --json
`

/** What the probe found per root: a `.tasks` tree, its version line, the command on the PATH. Read once per process. */
const probes = new Map<string, { hasTree: boolean; isVersion2: boolean; hasCommand: boolean }>()

/** The `.tasks` tree and command as the repository has them (doctor reports both). */
export async function tasksProbe($: Engine, at: Place): Promise<{ hasTree: boolean; isVersion2: boolean; hasCommand: boolean }> {
  const known = probes.get(at.root)
  if (known !== undefined) {
    return known
  }
  const ran = await git($, at, TASKS_PROBE, [], 10_000)
  const out = ran?.out ?? ''
  const found = { hasTree: /^tree:yes$/m.test(out), isVersion2: isVersion2(out), hasCommand: /^command:yes$/m.test(out) }
  probes.set(at.root, found)

  return found
}

/**
 * The `.tasks` integration in force (D2): on where the policy in force turns
 * it on (`observe` or `enforce`), the tree declares version 2 and the
 * command is installed. The finish facts are left unknown here: the guard
 * proves the gate only for a line that would finish a task.
 */
export async function tasksFactsOf($: Engine, at: Place, cfg: Config): Promise<TasksFacts> {
  if (cfg.tasks.integrate === 'off') {
    return TASKS_OFF
  }
  const probe = await tasksProbe($, at)

  return { isOn: probe.hasTree && probe.isVersion2 && probe.hasCommand, canFinish: null, finishWhy: '' }
}

/** The carry-over's facts found, by root, then by `<verdict's tree> <tree now>`: git and the command run once per pair of trees. */
const carries = new Map<string, Record<string, CarryFact>>()

/**
 * The carry-over facts the gate is given for a root (final round, D2 F1):
 * only where the `.tasks` integration is on by the policy given and as last
 * probed, so a verdict never carries where it is off. Facts about two
 * trees, never a decision: `verdictCovers` (hooks/gate.ts) decides each time.
 */
export function carryFactsOf(root: string, cfg: Config | null): Record<string, CarryFact> {
  const probe = probes.get(root)
  const isOn = cfg !== null && cfg.tasks.integrate !== 'off' && probe !== undefined && probe.hasTree && probe.isVersion2 && probe.hasCommand

  return isOn ? { ...(carries.get(root) ?? {}) } : {}
}

/**
 * Learns the carry-over's facts for the verdict on record and the tree now
 * (D2; final round F1): git's own diff of the two trees (submodule changes
 * never hidden, F9) and, when every path in it is task state, whether the
 * task files validate with the `tasks` command. Nothing is stored that says
 * a verdict carries; the gate decides that from these facts every time, so
 * a later verdict on another tree is judged by its own diff.
 */
export async function learnCarry($: Engine, at: Place, cfg: Config, review: Loop['review'], tree: string | null): Promise<void> {
  if (tree === null || review.tree === null || review.tree === tree || (review.status !== 'pass' && review.status !== 'fail')) {
    return
  }
  if (!(await tasksFactsOf($, at, cfg)).isOn) {
    return
  }
  const key = carryKey(review.tree, tree)
  if ((carries.get(at.root) ?? {})[key] !== undefined) {
    return
  }
  const diff = await git($, at, CARRY_DIFF, [review.tree, tree])
  const paths = diff === null || diff.code !== 0 ? null : readCarryDiff(diff.out)
  let isValid = false
  if (paths !== null && isTaskStateOnly(paths)) {
    const valid = await git($, at, TASKS_VALIDATE, [], 30_000)
    isValid = valid !== null && valid.code === 0
  }
  carries.set(at.root, { ...(carries.get(at.root) ?? {}), [key]: { paths, isValid } })
}

/** How the verdict on record stands to `tree`, once its facts are learned: reviewed there, carried there, or not covering it. */
export async function coverageNow($: Engine, at: Place, cfg: Config, loop: Pick<Loop, 'review'>, tree: string | null): Promise<Coverage> {
  await learnCarry($, at, cfg, loop.review, tree)

  return coverageOf({ tree, review: loop.review }, { carry: carryFactsOf(at.root, cfg) })
}

/** The main roots found, by root: read once per process. */
const mainRoots = new Map<string, string>()

/**
 * The repository's main root (D2): the folder its git directory belongs to,
 * the same for every worktree of it, so their sessions share one record of
 * claims in the plugin's store. The root itself where git cannot say.
 */
export async function mainRootOf($: Engine, at: Place): Promise<string> {
  const known = mainRoots.get(at.root)
  if (known !== undefined) {
    return known
  }
  const ran = await git($, at, MAIN_ROOT, [], 10_000)
  const said = (ran?.out ?? '').split('\n')[0]?.trim() ?? ''
  const found = ran !== null && ran.code === 0 && said.startsWith('/') ? said : at.root
  mainRoots.set(at.root, found)

  return found
}

/** The main root last found for a root, without running anything: for the pane, which runs nothing. */
export const heldMainRoot = (root: string): string => mainRoots.get(root) ?? root

// ---------------------------------------------------------------- specs

export const specDir = (at: Place, loop: Loop): string => `${at.root}/specs/${loop.spec ?? ''}`

export async function readFeatures($: Engine, at: Place, loop: Loop): Promise<Feature[]> {
  const file = `${specDir(at, loop)}/features.json`

  return loop.spec !== null && (await $.fs.exists(file)) ? parseFeatures(await $.fs.read(file)) : []
}

/**
 * A fingerprint of what the person approved: the spec's text and each
 * feature's id, description, check, dependencies and criteria. `passes`, if
 * the file has one, is left out: the harness never reads it.
 */
export async function specHash($: Engine, at: Place, loop: Loop): Promise<string> {
  const file = `${specDir(at, loop)}/SPEC.md`
  const spec = (await $.fs.exists(file)) ? await $.fs.read(file) : ''

  return fingerprintOf(spec, await readFeatures($, at, loop))
}

/** The fingerprint of a spec's text and its features, as given: what approval records for the text its checks ran on. */
export async function fingerprintOf(specText: string, features: readonly Feature[]): Promise<string> {
  const bytes = new TextEncoder().encode(fingerprintInput(specText, features))
  const hashed = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))

  return [...hashed].map(byte => byte.toString(16).padStart(2, '0')).join('')
}

/**
 * Proves the gate's evidence rows on the tree as it stands (credential
 * scan, tests against approval) and folds the snapshot in. `isSaved` false
 * computes without writing, for the read-only status tool.
 */
export async function refresh($: Engine, at: Place, cfg: Config, isSaved = true): Promise<{ loop: Loop; snap: Snapshot }> {
  const snap = await snapshot($, at, cfg)
  const before = withSnapshot(await loopOf($), snap, cfg)
  const evidence = await evidenceOf($, at, cfg, before, snap)
  // The carry-over's facts for this tree are learned here; the gate decides from them (final round, D2 F1).
  await learnCarry($, at, cfg, before.review, snap.tree)
  const loop = isSaved
    ? await save($, at.root, latest => ({ ...withSnapshot(latest, snap, cfg), evidence }))
    : { ...before, evidence }

  return { loop, snap }
}

export type FeatureRun = { id: string; ran: Ran }

/** A feature check the command rules refused: it was not run. */
export type RefusedCheck = { id: string; check: string; refusal: Refusal }

/**
 * Judges one feature check by the command rules, as the guard judges a
 * shell command the builder typed, before it is ever run (B2.1 F6): by the
 * policy in force (`cfg`), with the tracked files under
 * what it writes. Null to let it run.
 */
export async function judgeFeatureCheck($: Engine, at: Place, cfg: Config, loop: Loop, check: string): Promise<Refusal | null> {
  const home = (await $.env.get('HOME').catch(() => undefined)) ?? null
  const tmp = (await $.env.get('TMPDIR').catch(() => undefined)) || null
  const base = whereOf(at.root, at.root, { home, tmp, stateRoot: await stateRootOf($), env: await envFor($) })
  const where = await withGlobs($, check, base)
  const dirs = [...new Set(writtenPaths(check, where).map(one => one.rel).filter((rel): rel is string => rel !== null && rel !== '' && !/[*?[]/.test(rel)))].slice(0, 8)

  return judgeCheck(check, cfg, loop, { ...where, filesUnder: await filesUnder($, at, dirs) })
}

/**
 * The judging process's values of the variables a path is placed through
 * (the cache-guard round, R8), read through `$.env`: `PWD` and the plugin's
 * and project's folders (HOME and TMPDIR are the place's own fields).
 */
export async function envFor($: Engine): Promise<Record<string, string | null>> {
  return {
    PWD: (await $.env.get('PWD').catch(() => undefined)) || null,
    CLAUDE_PLUGIN_DATA: (await $.env.get('CLAUDE_PLUGIN_DATA').catch(() => undefined)) || null,
    CLAUDE_PLUGIN_ROOT: (await $.env.get('CLAUDE_PLUGIN_ROOT').catch(() => undefined)) || null,
    CLAUDE_PROJECT_DIR: (await $.env.get('CLAUDE_PROJECT_DIR').catch(() => undefined)) || null,
  }
}

/**
 * The place with what the command's lookups found on disk (P-C), listed
 * through `$.fs.list` by the expanders the command line shares
 * (hooks/glob.ts): each reading's own lookups, kept apart (the fourteenth
 * round, CC1: the reviewed reading's as `2374c49` made them, by
 * `expandGlobReviewed`; the extended reading's and the words with white
 * space by `expandGlob`). A move's match places what follows it (the
 * twelfth round, X11), so it asks again, a few rounds at most; none past a
 * reading's budget, where the rules refuse the line, as they do one with a
 * lookup left unmade (`budgetRefusals`).
 */
export async function withGlobs($: Engine, command: string, where: Where): Promise<Where> {
  // One listing per folder for the whole line. A link is `other` in a listing: it may lead to a folder, which a part in
  // the middle of a pattern follows in the extended reading (X11); the reviewed reading's expander takes `dir` alone (CC1).
  const listings = new Map<string, Promise<Listing>>()
  const list = (dir: string): Promise<Listing> => {
    const known = listings.get(dir) ?? $.fs.list(dir).then(entries => entries.map(one => ({ name: one.name, isDir: one.kind === 'dir' ? true : one.kind === 'other' ? null : false })), () => null)
    listings.set(dir, known)

    return known
  }
  let at = where
  for (let round = 0; round < GLOB_ROUNDS; round += 1) {
    // What both readings ask is looked up, each kind by its own expander and kept apart (BB1, CC1).
    const wanted = globsWanted(command, at)
    if (wanted.length === 0) {
      break
    }
    at = globsAnswered(at, wanted, {
      reviewed: await expandAll(patternsOf(wanted, 'reviewed'), list, expandGlobReviewed),
      extended: await expandAll(patternsOf(wanted, 'extended'), list),
      spaced: await expandAll(patternsOf(wanted, 'spaced'), list),
    })
  }

  return at
}

/**
 * Where the file system leads a path whose `..` follows a part that may be a
 * link (the eleventh round, V3), through `$.fs.stat`: `physicalPath`, each
 * folder before a `..` resolved in turn.
 */
export async function physicalOf($: Engine, raw: string): Promise<string> {
  const known = new Map<string, string | null>()
  for (let guard = 0; guard < 16; guard += 1) {
    let missing: string | null = null
    const out = physicalPath(raw, folder => {
      if (known.has(folder)) {
        return known.get(folder) ?? null
      }
      missing ??= folder

      return null
    })
    if (missing === null) {
      return out
    }
    const folder: string = missing
    known.set(folder, await $.fs.stat(folder, { resolve: true }).then(one => one.realPath ?? null, () => null))
  }

  return physicalPath(raw, folder => known.get(folder) ?? null)
}

/**
 * The places a guard follows a path's links from (the thirteenth round,
 * BB2): its text-folded place (`abs`, as the reviewed build followed it)
 * and, for a `..` after a link, where the file system leads it (V3). None
 * when the path cannot be placed.
 */
export async function placesOf($: Engine, path: Placed): Promise<string[]> {
  if (path.abs === null) {
    return []
  }

  return [...new Set([path.abs, ...(path.raw === undefined ? [] : [await physicalOf($, path.raw)])])]
}

/**
 * Runs feature checks and records each result against the tree it ran on:
 * the named ones, or (with none named) every recorded pass that does not
 * cover the tree as it stands. A pass is never taken on trust from an
 * earlier tree. A check the command rules refuse is not run (`refused`), and
 * its feature keeps what it had. Null when the spec changed after approval,
 * so nothing runs.
 */
export async function runFeatures($: Engine, at: Place, cfg: Config, ids: readonly string[] | null): Promise<{ loop: Loop; runs: FeatureRun[]; refused: RefusedCheck[] } | null> {
  const before = await loopOf($)
  if (before.phase !== 'build' || before.spec === null) {
    return { loop: before, runs: [], refused: [] }
  }
  if ((await specHash($, at, before)) !== before.approvedHash) {
    return null
  }
  const snap = await snapshot($, at, cfg)
  const listed = await readFeatures($, at, before)
  const wanted = ids ?? Object.entries(before.features).filter(([, one]) => one.passes && one.tree !== snap.tree).map(([id]) => id)
  const runs: FeatureRun[] = []
  const refused: RefusedCheck[] = []
  for (const id of wanted) {
    const feature = listed.find(one => one.id === id)
    if (feature === undefined || !(id in before.features)) {
      continue
    }
    const refusal = await judgeFeatureCheck($, at, cfg, before, feature.check)
    if (refusal !== null) {
      refused.push({ id, check: feature.check, refusal })
      continue
    }
    runs.push({ id, ran: await run($, feature.check, at.root, cfg.verifyTimeoutSec, cfg.checkEnv) })
  }
  if (runs.length === 0) {
    return { loop: before, runs, refused }
  }
  const status = (passes: boolean, tree: string | null): FeatureStatus => ({ passes, tree })
  // Recorded in plugin state only: features.json stays as approved while
  // building, so a pass does not move the tree it names.
  const loop = await save($, at.root, latest => ({
    ...latest,
    features: { ...latest.features, ...Object.fromEntries(runs.map(one => [one.id, status(one.ran.isPassing, snap.tree)])) },
  }))
  for (const one of runs.filter(each => !each.ran.isPassing)) {
    const isInfra = one.ran.outcome !== 'fail'
    await record($, at.root, isInfra ? 'check-infra' : 'feature-fail', isInfra ? `${one.id} (${one.ran.outcome})` : one.id, one.ran.output)
  }

  return { loop, runs, refused }
}
