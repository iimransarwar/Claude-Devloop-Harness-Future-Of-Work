// devloop: rails for an agent-driven development loop.
//
// The plugin rents the agent loop from Claude Code and adds what the loop
// lacks: guards on what the builder may edit, a verify gate at every stop, a
// spec a person approves, a reviewer with a fresh context, risk tiers that
// decide who may ship, and a ledger that turns repeated failures into rules.
// A repository opts in with a devloop.json at its root; without one only the
// secrets guard and /devloop (which sets it up) are live.

import type { CommandRunInput, CommandRunResult, Register, RenderChildren, SessionUsage, ToolCallResult, TurnUsage } from 'claude-code'

import type { Loop, PaneTab } from '../types'
import { cacheReport, hitRate, meterTurn } from './cache'
import type { Miss } from './cache'
import { briefFacts, command, keepGate, NOT_GIT_STATUS, statusReport, writeHandoff } from './commands'
import { contentReason, countUnmarked, isFired, judgeContent, lowered, rulesFor } from './contentrules'
import type { Baseline, RuleHit } from './contentrules'
import { DEFAULTS } from './config'
import type { Config } from './config'
import {
  attribute, attributionReport, briefing, deltas, isIdleGap, openQuestions, policyFacts, pressureLevels, pressureNote, pressureOf, pressureStep,
  readHandoff, EMPTY_ATTRIBUTION, QUESTIONS_PER_TURN,
} from './context'
import type { Attribution, Emitted, PressureState, Source } from './context'
import { claimLines, readyFor, seatOf } from './claims'
import type { Claims } from './claims'
import {
  claimFeature, claimsOf, forgetRenewal, heldText, releaseAtSessionEnd, releaseClaim, renewClaims, resumeFollowups, seatOfPlace, stopFollowTimer, watchAfterShip,
} from './coord'
import { candidateContext, isChecklistAgent } from './checklists'
import { isSecretPattern, namesDefaultSecret, resolvedWriteRefusals } from './enforce'
import { guardNow, handoffFor } from './cachecmd'
import { finishEval, historyOf } from './evals'
import { foldInbox, heartbeat, stampCall, stampPrompt, stampStop } from './portability'
import { backstop, firstLine, groundingMode, isLook, isQuestionOfFact, NUDGE } from './grounding'
import { checksForChange, isAtLimit, limitLines, NO_LIMIT } from './limits'
import { countFailedRound, limitNow, notePassing, reachLimit } from './rounds'
import { audit, auditOf, isFromPerson, keepRecord, listOf, meterCost } from './journal'
import { hit, papercutGroups, papercutGroup, PAPERCUTS_PER_TURN } from './ledger'
import type { Hits, Papercut, PapercutClose } from './ledger'
import { syncRegressions } from './regress'
import { auditLine, clip } from './records'
import type { Actor, AuditEvent } from './records'
import { abandonBackground, startBackground } from './background'
import { approvalsFor, approvers, featureCounts, gate, isShippable, reviewRefusal, tierFor } from './gate'
import { backgroundNotice } from './testruns'
import { digest, infraAdvice } from './output'
import { formatFinding } from './findings'
import { closeShippedReview, finishReview, isReviewedHere, isReviewerAgent, maybeReview, reviewerChecks, startReview } from './review'
import { appliesTo, EMPTY_LEARNED, isLearnerAgent, judgeLearned, learnedReason, learnedRules, repeatLesson } from './autolearn'
import { finishProposer, learnedNow, maybePropose, noteLearnedHits, sweepLearning } from './learner'
import { librarySpellings, searchCommand } from './librarycmd'
import { ACTIONS, commandName, failureText, registerActions } from './actions'
import { applyChanges, effectLine, readSettings } from './settings'
import { SET_UP_HEADLINE } from './setup'
import { activityText, barParts } from './statusbar'
import {
  SETTINGS_FOOTER, SETTINGS_LABEL, SETTINGS_OPEN, SETTINGS_PANE, absentOf, changeTests, closeSettings, installGuard, isSettings, openedWithOf, pickSetting, pythonMissing, removeGuard, saveSettings, settingsCommand, unreadableOf,
} from './settingspane'
import {
  LINK_BUDGET, WRITE_LINK_BUDGET, budgetRefusals, closesReview, followedPlaces, callKind, filteredCheck, globParts, libraryMayRead, reviewerMayRun, reviewerPlaces, harnessStateReason, instructionGlobs, isAlwaysHeld, isHarnessState, isHeldBy, isOnDefault, isReviewerCommand, isSecretPlace, judgeCommandAll, judgeWrite, liftClause, matches,
  matchesAny, maybeWrittenByReading, namedPlacesByReading, NEVER_LIFTED, place, relative, shipLookups, shipsOf, strictest, whereOf, writtenPaths, writtenPathsByReading, writesOpenPath,
} from './rules'
import type { Placed, Refusal, Where } from './rules'
import { judgeShipping } from './ship'
import { computeMetrics, metricsLines } from './report'
import type { ChangeRecord, Defect, GroundingSession } from './report'
import { missingDeps } from './spec'
import { finishesTask, isTaskStatePath, sessionCheckProblems, tasksEditRefusalOf, writesTaskState } from './tasks'
import type { TasksFacts } from './tasks'
import {
  abandonStale, activityOf, addOpenQuestion, brief, bump, cacheOf, recordLesson, checkReviewDiff, currentBranch, envFor, factsOf, filesUnder, forget, git, heldMainRoot, heldPolicy, coverageNow, locate, look, loopOf, markError,
  metrics, modeInForce, modeOf, note, outputPath, policyInForce, questionsOf, readFeatures, record, refresh, remoteOf, restore, runFeatures, save, saveCache, sectionOf,
  setActivity, setSection, settingsDraftOf, snapshot, snapshotInForce, setTab, stateDirOf, stateRootOf, tabOf, tasksFactsOf, updateSettingsDraft, verifyNow, withGlobs, withSnapshot, placesOf, judgeFeatureCheck,
} from './state'
import type { Engine, Place } from './state'
import { fixAdvice, RULES } from './templates'
import { editedText, judgeTestEdit } from './weaken'
import type { TestEdit } from './weaken'

const PANE = 'devloop'
const FEATURE_CHECK = 'mcp__devloop__feature_check'
const STATUS = 'mcp__devloop__devloop_status'
const REVIEW = 'mcp__devloop__devloop_review'
const BLOCKED = 'mcp__devloop__devloop_blocked'
const ADD_CHECK = 'mcp__devloop__devloop_add_check'
const HANDOFF = 'mcp__devloop__devloop_handoff'
const QUESTION = 'mcp__devloop__devloop_question'
const PAPERCUT = 'mcp__devloop__devloop_papercut'
const CLAIM = 'mcp__devloop__devloop_claim'
const RELEASE = 'mcp__devloop__devloop_release'
const LIBRARY = 'mcp__devloop__devloop_library'
const EDITS = ['Edit', 'Write', 'NotebookEdit']
/** The rules about where a path may be written; an eval agent is exempt from these alone, and only in its own worktree. */
const PATH_RULES = ['spec-locked', 'protected', 'tests-locked', 'spec-first', 'high-needs-spec']
const SEARCHES = ['Grep', 'Glob']
const SHELLS = ['Bash', 'Monitor']

/**
 * Every tool the plugin has, registered at load whether or not the
 * repository opted in, with a description, schema and deferral that never
 * change: a tool list that changes mid-session rewrites the cached prefix
 * (DESIGN 4.7, principle 7). Behind ToolSearch, so a session in a repository
 * that has not opted in pays nothing for them. A call where the repository
 * has not opted in answers so.
 */
export const TOOL_SPECS = [
  {
    name: 'feature_check',
    description:
      'Records whether one feature of the active spec passes. The harness runs that feature\'s own "check" command from features.json and keeps the result; this is the only way a feature is recorded as passing. Call it after you have run the check yourself and seen it pass.',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string', description: 'The feature\'s "id" in the active spec\'s features.json' } },
      required: ['id'],
    },
    isDeferred: true,
  },
  {
    name: 'devloop_status',
    description:
      'Reads where the change stands without changing anything: the phase, the risk tier, each gate row and whether it is met, who must approve the merge, the last verification failure and the open questions. With detail, also the prompt-cache health and which tools and files put the most into the context. Call it instead of guessing whether work may ship.',
    inputSchema: {
      type: 'object',
      properties: { detail: { type: 'boolean', description: 'Add the cache meter and the context-cost estimate' } },
    },
    isDeferred: true,
  },
  {
    name: 'devloop_review',
    description:
      'Asks for an independent review round on the change as it stands. Call it once, when the whole change is done, not after each step. The harness starts a separate read-only reviewer in a fresh context when the change has some risk, its tree is not yet reviewed, rounds are left and none is running, and answers in one line; it runs and waits on no tests. Do not edit files until the verdict arrives.',
    inputSchema: { type: 'object', properties: {} },
    isDeferred: true,
  },
  {
    name: 'devloop_add_check',
    description:
      'Adds a test command to devloop.json\'s verify list: how this repository proves its work. It only adds (it never removes or loosens a check). Use it when the verify list is empty or misses how the repository is tested. Mark a suite that takes more than a minute background: true.',
    inputSchema: {
      type: 'object',
      properties: {
        run: { type: 'string', description: 'The command, exactly as a person would run it from the repository root' },
        background: { type: 'boolean', description: 'true for a slow suite: it then runs in the background with no time limit' },
      },
      required: ['run'],
    },
    isDeferred: true,
  },
  {
    name: 'devloop_blocked',
    description:
      'Says you cannot go on and why, and stops cleanly: the reason is recorded and shown to the person, and the stop gate lets you end the turn. Use it instead of looking for a way round a refusal, or when a failure is outside what you can change. Then end your turn with a short report.',
    inputSchema: {
      type: 'object',
      properties: { reason: { type: 'string', description: 'What blocks you, and what a person would need to decide or do' } },
      required: ['reason'],
    },
    isDeferred: true,
  },
  {
    name: 'devloop_handoff',
    description:
      'Writes a structured handoff entry for a fresh session to start from. The harness keeps it in its own state, outside the working tree, and briefs the next session\'s first prompt from it. You give the narrative; the harness adds the facts itself (phase, features, open findings, last failure, changed files, recent commits, tree hash, time). Call it when the harness says the context is nearly full, or before you stop on unfinished work.',
    inputSchema: {
      type: 'object',
      properties: {
        objective: { type: 'string', description: 'What the work is for, in a sentence or two' },
        decisions: { type: 'array', items: { type: 'string' }, description: 'Decisions taken, each with its reason' },
        workState: { type: 'string', description: 'What is done and what is half done' },
        deadEnds: { type: 'array', items: { type: 'string' }, description: 'Approaches tried that did not work, and why' },
        assumptions: {
          type: 'array',
          items: {
            type: 'object',
            properties: { assumption: { type: 'string' }, command: { type: 'string', description: 'The command that would verify it' } },
            required: ['assumption', 'command'],
          },
          description: 'Assumptions not yet verified, each with the command that would verify it',
        },
        nextStep: { type: 'string', description: 'The one next step' },
        files: { type: 'array', items: { type: 'string' }, description: 'The relevant files, at most 15' },
      },
      required: ['objective', 'nextStep'],
    },
    isDeferred: true,
  },
  {
    name: 'devloop_question',
    description:
      'Records an open question you cannot settle yourself (a product decision, an ambiguity in the spec) for a person to answer. It never blocks: carry on with what does not depend on it. Only a person closes a question. At most three per turn.',
    inputSchema: {
      type: 'object',
      properties: {
        question: { type: 'string', description: 'The question, answerable by a person' },
        context: { type: 'string', description: 'What it affects and what you assumed meanwhile' },
      },
      required: ['question'],
    },
    isDeferred: true,
  },
  {
    name: 'devloop_papercut',
    description:
      'Files a friction report for the person who maintains this setup: a flag the help lists but the tool rejects, a command that exits 0 on an error, a check that passes for the wrong reason, an instruction that proved wrong, the same error after several attempts. It never blocks and never ends your turn: file it, then carry on. At most three per turn.',
    inputSchema: {
      type: 'object',
      properties: {
        tried: { type: 'string', description: 'What you tried to do' },
        expected: { type: 'string', description: 'What you expected to happen' },
        happened: { type: 'string', description: 'What happened instead (the first line of an error is enough)' },
        suggestedFix: { type: 'string', description: 'What would fix it for the next session' },
        subject: { type: 'string', description: 'The skill, tool, check or file it is about' },
      },
      required: ['tried', 'expected', 'happened', 'suggestedFix'],
    },
    isDeferred: true,
  },
  {
    name: 'devloop_claim',
    description:
      'Claims one feature of the active spec for this session, so another session working in the same repository (another worktree) leaves it to you. A claim lasts while your activity renews it; your first feature_check on an unclaimed feature claims it too. Only needed when more than one session works here.',
    inputSchema: {
      type: 'object',
      properties: { feature: { type: 'string', description: 'The feature\'s "id" in the active spec\'s features.json' } },
      required: ['feature'],
    },
    isDeferred: true,
  },
  {
    name: 'devloop_release',
    description:
      'Gives up this session\'s claim on one feature of the active spec, so another session may take it. Call it when you stop working on a feature you claimed and leave it unfinished.',
    inputSchema: {
      type: 'object',
      properties: { feature: { type: 'string', description: 'The feature\'s "id" in the active spec\'s features.json' } },
      required: ['feature'],
    },
    isDeferred: true,
  },
  {
    name: 'devloop_library',
    description:
      'Searches the person\'s spec library, the approved specs saved from this project and others, without changing anything. Answers the entries whose name, intent, kind, project or feature descriptions hold the most words of the query (ties: newer first), each with its folder, project, name, kind, intent, outcome and acceptance criteria. Read an entry\'s SPEC.md and features.json from its folder, and tell the person which earlier specs you used and their projects.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Words for the new work: the area, the kind of change, the behaviour' },
        limit: { type: 'number', description: 'How many entries to return: 5 when left out, at most 10' },
      },
      required: ['query'],
    },
    isDeferred: true,
  },
] as const

/** A hash of the tool list as registered: part of devloop's own prefix, for the cache meter. */
const TOOLS_HASH = digest(JSON.stringify(TOOL_SPECS))

/**
 * A pane opened while serving a person's command counts as asked, so the engine draws it at any width.
 * Looked up fresh: the command may just have set the repository up. A failure here never fails the command.
 */
/** Closes the Dev loop panel: the person's Close button. */
function closePane($: Engine): void {
  void Promise.resolve().then(() => $.ui.close({ id: PANE })).catch(() => undefined)
}

async function openForPerson($: Engine, e: Parameters<typeof isFromPerson>[0]): Promise<void> {
  if (!isFromPerson(e)) {
    return
  }
  const at = await locate($).catch(() => null)
  if (at !== null && at.isOptedIn) {
    void Promise.resolve().then(() => $.ui.open({ id: PANE, title: 'Dev loop', backgroundColor: 'transparent' })).catch(() => undefined)
  }
}

/**
 * Answers one /devloop command for its hook (/devloop or a menu entry). A
 * person's answer opens the Dev loop pane, except where it opened the settings
 * popup: that is the one pane its command opens.
 */
async function answerCommand($: Engine, e: CommandRunInput, turnId: string | null): Promise<CommandRunResult> {
  const answer = isSettings(e.args) ? await settingsCommand($, e) : await command($, e, turnId)
  // The tools are already registered, the same as in any session: setup changes no tool.
  if (answer.text?.startsWith(SET_UP_HEADLINE) === true) {
    await registerActions($, true).catch(() => undefined)
  }
  // Only /devloop itself (the status) opens the panel: every other action answers in the chat, so a closed panel stays closed.
  const isStatus = e.command === 'devloop' && /^\s*(status)?\s*$/.test(e.args)
  if (answer.text !== SETTINGS_OPEN && (isStatus || answer.text?.startsWith(SET_UP_HEADLINE) === true)) {
    await openForPerson($, e)
  }

  return answer
}

/** Registers every tool, the same specs in every session (see TOOL_SPECS). */
async function registerTools($: Engine): Promise<void> {
  for (const spec of TOOL_SPECS) {
    await $.tool.register(JSON.parse(JSON.stringify(spec)) as Parameters<Engine['tool']['register']>[0])
  }
}

/** Loads the repository's config and what an earlier session left, and baselines the working tree. */
async function wake($: Engine): Promise<Place> {
  forget()
  // locate reads the policy in force, so the mode is known before the first guard runs.
  const at = await locate($)
  if (!at.isOptedIn) {
    return at
  }
  const sessionId = await $.session.id().catch(() => null)
  const { isReload } = await restore($, at.root, sessionId)
  // A background run the stored loop names went with the last session or the module: it starts again at the next stop.
  await abandonBackground($, at).catch((error: unknown) => {
    $.ui.log(`devloop: the last session's background runs could not be cleared: ${String(error)}`, { to: 'debug' })
  })
  await abandonStale($, at.root)
  const found = await snapshotInForce($, at)
  if (found === null) {
    return at
  }
  const { snap } = found
  const cfg = found.policy.cfg
  // A verdict carries to a tree that differs from the reviewed one only in task state (D2), decided from the diff (final round F1).
  const isCarriedNow = (await coverageNow($, at, cfg, await loopOf($), snap.tree).catch(() => 'not' as const)) === 'carried'
  await save($, at.root, before => {
    // A reload keeps everything. In a new session, a tree that moved while no
    // session watched is unverified, but it is not this session's work:
    // baseline it, so a chat-only turn runs no tests.
    const isMoved = !isReload && snap.tree !== before.verify.tree
    const based = isMoved
      ? {
          ...before,
          verify: { ...before.verify, status: 'none' as const, failed: null, tree: snap.tree, profile: 'none' as const, fingerprint: null, blockedTree: null },
          review: before.review.status === 'none' || isCarriedNow ? before.review : { ...before.review, status: 'none' as const },
        }
      : before

    return withSnapshot(based, snap, cfg)
  })
  // C2: the regression set, the ratchets' baselines (from the policy in force), and policy errors for the audit trail.
  await syncRegressions($, at.root).catch(() => undefined)
  await ratchetBaselines($, at, cfg).catch(() => undefined)
  // Learned rules (DESIGN 4.17): one the policy in force now has is dropped from the state; a trial rule long quiet is removed.
  await sweepLearning($, at, cfg).catch(() => undefined)
  await auditPolicyErrors($, at).catch(() => undefined)
  await foldInbox($, at).catch(() => undefined)
  // Follow-ups an earlier session left: resumed where gh can be used (D2).
  await resumeFollowups($, at, cfg).catch(() => undefined)

  return at
}

/**
 * What every stop that ends the turn does: start the background checks
 * that have no result on the tree (rule 3), never waiting on one. A failure
 * to start them is logged, never a held stop. `isIdle` says, when a run
 * ends, whether the main loop has no turn going (rule 2).
 */
async function atTurnEnd($: Engine, at: Place, cfg: Config, tree: string | null, isIdle: () => boolean): Promise<void> {
  await startBackground($, at, cfg, tree, isIdle).catch((error: unknown) => {
    $.ui.log(`devloop: the background checks could not be started: ${String(error)}`, { to: 'debug' })
  })
}

/** Sets `isOverBudget` once the session's estimated cost passes the cap. */
async function checkBudget($: Engine, at: Place, cfg: Config): Promise<void> {
  const loop = await loopOf($)
  const cap = loop.budgetUsd ?? cfg.budgetUsd
  if (cap === null || loop.isOverBudget) {
    return
  }
  const usd = (await $.session.usage().catch(() => null))?.cost?.usd
  if (usd !== undefined && usd >= cap) {
    const now = await $.clock.now()
    await save($, at.root, before => note({ ...before, isOverBudget: true }, 'info', `cost cap reached (about $${usd.toFixed(2)} of $${cap.toFixed(2)})`, now))
    $.ui.toast(`devloop: the session's cost cap of $${cap.toFixed(2)} is reached (an estimate). /devloop budget <usd> raises it.`)
  }
}

/**
 * Where a path lands when its links are followed, placed: every place other
 * than its own, from both places it is put (the thirteenth round, BB2: the
 * text-folded one and, after a link, the physical one), each judged; none
 * when it leads nowhere else or cannot be told. A file not there yet is
 * placed by its folder.
 */
async function realOf($: Engine, path: Placed, where: Where): Promise<Placed[]> {
  const out: Placed[] = []
  for (const abs of await placesOf($, path)) {
    const real = await realPathOf($, abs)
    for (const one of [abs, ...(real === null ? [] : [real])]) {
      if (one !== path.abs && !out.some(each => each.abs === one)) {
        out.push(place(one, null, where))
      }
    }
  }

  return out
}

/**
 * Where one place leads once its links are followed; a file that is not
 * there, or whose own look fails, by its folder (as the command line's
 * `realpathSync` falls back to it); null when neither can be told.
 */
async function realPathOf($: Engine, abs: string): Promise<string | null> {
  const own = await $.fs.stat(abs, { resolve: true }).catch(() => undefined)
  if (own !== undefined) {
    return own.realPath ?? null
  }
  const cut = abs.lastIndexOf('/')
  const folder = await $.fs.stat(cut <= 0 ? '/' : abs.slice(0, cut), { resolve: true }).catch(() => null)

  return folder?.realPath === undefined ? null : `${folder.realPath.replace(/\/$/, '')}/${abs.slice(cut + 1)}`
}

/**
 * Where a path really lands, placed, for an answer that must rest on positive
 * evidence (the reviewer's permission check, R6): from both places it is put
 * (BB2), each the path itself when it leads nowhere else, where its links
 * lead, a file not there yet by its folder's real place; null when any of
 * them cannot be told.
 */
async function resolvedOf($: Engine, path: Placed, where: Where): Promise<Placed[] | null> {
  const out: Placed[] = []
  for (const abs of await placesOf($, path)) {
    const one = await resolvedOne($, abs === path.abs ? path : place(abs, null, where), where)
    if (one === null) {
      return null
    }
    out.push(one)
  }

  return out.length === 0 ? null : out
}

/** Where one place (one with no `..` after a link left to take) really lands; null when it cannot be told. */
async function resolvedOne($: Engine, path: Placed, where: Where): Promise<Placed | null> {
  const abs = path.abs
  if (abs === null) {
    return null
  }
  const own = await $.fs.stat(abs, { resolve: true }).catch((error: unknown) => (/ENOENT/.test(String((error as Error | undefined)?.message)) ? undefined : null))
  if (own === null) {
    return null
  }
  if (own !== undefined) {
    return own.realPath === undefined || own.realPath === abs ? path : place(own.realPath, null, where)
  }
  // A path not there yet lands where its nearest folder that is there really is: nothing below it can be a link.
  for (let cut = abs.lastIndexOf('/'); cut > 0; cut = abs.lastIndexOf('/', cut - 1)) {
    const folder = await $.fs.stat(abs.slice(0, cut), { resolve: true }).catch((error: unknown) => (/ENOENT/.test(String((error as Error | undefined)?.message)) ? undefined : null))
    if (folder === null) {
      return null
    }
    if (folder !== undefined) {
      const real = folder.realPath === undefined ? abs : `${folder.realPath.replace(/\/$/, '')}${abs.slice(cut)}`

      return real === abs ? path : place(real, null, where)
    }
  }

  return path
}

/** The exemption the person gave for exactly this command, if any. */
const isCommandExempt = (loop: Loop, text: string): boolean =>
  loop.allow.some(one => one.kind === 'command' && one.value.trim() === text.trim())

/**
 * What the plugin keeps in memory for the session it runs in (C1): the tool
 * calls counted, what this thread was sent, the pressure level last said,
 * the context-cost estimate and the questions per turn. Started over at each
 * session start; losing it re-sends context as initial, nothing worse.
 */
const fresh = () => ({
  calls: 0,
  thread: {
    sessionId: null as string | null,
    emitted: {} as Emitted,
    isCompacted: false,
    isBriefed: false,
    /** The response time an idle-gap toast was given for, so it is given once per gap. */
    idleToldFor: null as number | null,
    /** Whether this thread's system prompt carries the section, as kept in plugin state by session id (F6). */
    isSectionOn: null as boolean | null,
  },
  /** The session a cache-guard handoff for this folder was mentioned in (DESIGN 4.14): once per session. */
  handoffToldIn: null as string | null,
  /**
   * The keep-warm guarantee (DESIGN 4.14): whether a person's prompt came in
   * since the last stop, and the tree that stop saw. A turn no person started
   * that leaves the tree as it was gets nothing from devloop.
   */
  isPersonTurn: false,
  /** Whether a person's prompt started the main-loop turn now running (DESIGN 4.17): read and cleared at its end, where a proposer run may start. */
  isLearnTurn: false,
  lastStopTree: null as string | null,
  /** The main-loop turn the last stop ended: a stop in the same turn (after a block) is that turn going on. */
  lastStopTurn: null as string | null,
  /** The context-pressure level last said and the tool call it was said at. */
  pressure: { level: 0, at: 0 } as PressureState,
  /** What tool results put into the main conversation this session, estimated. */
  attribution: EMPTY_ATTRIBUTION as Attribution,
  /** Questions recorded per main-loop turn, for the rate limit. */
  questionsIn: new Map<string, number>(),
  /** Papercuts filed per main-loop turn, for the rate limit. */
  papercutsIn: new Map<string, number>(),
  /**
   * Main-loop tool calls in flight that can write, and that ship (C2.1, two
   * calls dispatched together); `gen` starts over at each turn, so a count
   * never outlives the turn it was taken in.
   */
  flight: { gen: 0, writes: 0, ships: 0 },
  /** The turns whose stop the `.tasks` session check already blocked (D2): once per turn, then the person is told. */
  tasksBlocked: new Set<string>(),
  /**
   * Grounding (DESIGN 4.15), the per-turn facts beside the others here: the
   * turn a person's prompt started (`isPending` until its `turn.start`, or its
   * stop), whether that prompt is a question of fact and its first line, the
   * looks at the source since it, whether its stop was refused for this
   * already, whether the backstop is done with the turn, and the tree the
   * turn started on; across turns, the tree the last turn that looked ended
   * on (`fresh: "tree"`). Kept in memory for the session: lost, the next
   * turn simply has no earlier look.
   */
  grounding: {
    turn: null as string | null, isPending: false, isQuestion: false, prompt: '', looks: 0, isRefused: false, isDone: true,
    startTree: null as string | null, lookTree: null as string | null,
  },
})

let live = fresh()

/** Counts a call the guards let go on as a look at the source, when it is one (DESIGN 4.15). Returns the result as it is. */
function countLook(e: { tool: unknown } & Record<string, unknown>, ran: ToolCallResult): ToolCallResult {
  if (ran.deny === undefined && !live.grounding.isDone && isLook({ tool: String(e.tool), input: e })) {
    live.grounding = { ...live.grounding, looks: live.grounding.looks + 1 }
  }

  return ran
}

/** Adds one to a grounding count, in the store (all sessions) and for this session (`grounding-session:<root>`). */
async function countGrounding($: Engine, root: string, what: 'questions' | 'unchecked'): Promise<void> {
  if (what === 'questions') {
    await bump($, root, 'grounding-questions')
  }
  const base = await groundingSessionOf($, root)
  await $.store.set(`grounding-session:${root}`, { ...base, [what]: base[what] + 1 })
}

/** Grounding's counts for the session in progress (DESIGN 4.15): none kept for it yet is zero. */
async function groundingSessionOf($: Engine, root: string): Promise<GroundingSession> {
  const sessionId = await $.session.id().catch(() => null)
  const kept = (await $.store.get(`grounding-session:${root}`).catch(() => undefined)) as GroundingSession | undefined

  return kept !== undefined && kept.sessionId === sessionId ? kept : { sessionId, questions: 0, unchecked: 0 }
}

/**
 * Grounding's backstop at a main-loop stop (DESIGN 4.15): for the turn a
 * person's prompt started, once. A turn that looked records the tree it
 * ended on; a question of fact answered with no look, on a tree the turn did
 * not change, is refused once in enforce mode (the reason is returned) and
 * otherwise reported: a toast, the audit trail, the ledger, the Activity tab
 * and the counts. Never while a review round runs.
 */
async function groundingStop($: Engine, at: Place, cfg: Config, loop: Loop, tree: string | null, current: string | null, answer: string): Promise<string | null> {
  const g = live.grounding
  const isOurs = g.isPending || (g.turn !== null && g.turn === current)
  if (!isOurs || g.isDone || loop.review.status === 'running') {
    return null
  }
  live.grounding = { ...g, turn: current, isPending: false }
  if (g.looks > 0) {
    live.grounding = { ...live.grounding, lookTree: tree, isDone: true }

    return null
  }
  const verdict = backstop({
    mode: groundingMode(cfg), isQuestion: g.isQuestion, looks: g.looks, answer, isRefused: g.isRefused,
    isTreeChanged: tree !== null && g.startTree !== null && tree !== g.startTree,
    isFreshLook: cfg.grounding.fresh === 'tree' && tree !== null && g.lookTree === tree,
  })
  if (verdict.action === 'refuse') {
    live.grounding = { ...live.grounding, isRefused: true }

    return `devloop: ${verdict.reason}`
  }
  live.grounding = { ...live.grounding, isDone: true }
  if (verdict.action === 'report') {
    const now = await $.clock.now()
    $.ui.toast(`devloop: ${verdict.toast} (asked: "${clip(g.prompt, 80)}")`, { timeoutMs: 15_000 })
    await audit($, at.root, 'answer-unchecked', { kind: 'harness', name: null }, clip(g.prompt, 120), tree, `${groundingMode(cfg)} mode${g.isRefused ? ', after one refused stop' : ''}${verdict.hedge === null ? '' : `; it says "${verdict.hedge}"`}`)
    await record($, at.root, 'grounding-unchecked', clip(g.prompt, 80), verdict.hedge === null ? 'answered without a look at any source' : `answered without a look at any source; it says "${verdict.hedge}"`)
    await countGrounding($, at.root, 'unchecked')
    await save($, at.root, before => note(before, 'info', `answered without checking anything: "${g.prompt}"`, now))
  }

  return null
}

type FlightKind = { isShip: boolean; isWrite: boolean }
type FlightToken = { gen: number; kind: FlightKind } | null

/**
 * The findings the status tool gives the builder (C2.1, live session): each
 * open finding it is to fix as its full line, so a builder polling status
 * has them without waiting for the hand-off; every other open finding, the
 * deferred ones and the notes are counted, not listed.
 */
export function findingsForBuilder(loop: Pick<Loop, 'findings'>): string[] {
  const toFix = loop.findings.filter(one => one.status === 'open' && one.isBlocking && one.route === 'fix')
  const otherOpen = loop.findings.filter(one => one.status === 'open' && !toFix.includes(one)).length
  const deferred = loop.findings.filter(one => one.status === 'deferred').length
  const notes = loop.findings.filter(one => one.status === 'note').length
  const counted = [
    otherOpen > 0 ? `${otherOpen} other open (a person's decision, or not blocking)` : '',
    deferred > 0 ? `${deferred} deferred` : '',
    notes > 0 ? `${notes} note${notes === 1 ? '' : 's'}` : '',
  ].filter(part => part !== '')
  if (toFix.length === 0 && counted.length === 0) {
    return []
  }

  return [
    ...(toFix.length > 0 ? [`Findings for you to fix (${toFix.length}), id | severity | file:line | quote | problem | evidence:`, ...toFix.map(one => `  ${formatFinding(one)}`)] : []),
    ...(counted.length > 0 ? [`Not for you to fix now: ${counted.join(', ')}.`] : []),
  ]
}

/** A main-loop call arrives: counted in flight until its hook is done. */
function enterFlight(kind: FlightKind): FlightToken {
  if (!kind.isShip && !kind.isWrite) {
    return null
  }
  live.flight = { ...live.flight, writes: live.flight.writes + (kind.isWrite ? 1 : 0), ships: live.flight.ships + (kind.isShip ? 1 : 0) }

  return { gen: live.flight.gen, kind }
}

/** Its hook is done, however it ended: the count falls, unless a new turn already started it over. */
function leaveFlight(token: FlightToken): void {
  if (token === null || token.gen !== live.flight.gen) {
    return
  }
  live.flight = {
    ...live.flight,
    writes: Math.max(0, live.flight.writes - (token.kind.isWrite ? 1 : 0)),
    ships: Math.max(0, live.flight.ships - (token.kind.isShip ? 1 : 0)),
  }
}

/** A ship that arrives beside a write in flight, or a write beside a ship: refused, the push to run by itself. */
function flightClash(kind: FlightKind): Refusal | null {
  if (kind.isShip && live.flight.writes > 0) {
    return { rule: 'ship-alone', reason: 'Another command that can change the tree is still running beside this one (they were sent together). Run the push (or the pull request) by itself, after the other commands have finished, so the harness judges exactly what is pushed.' }
  }
  if (kind.isWrite && live.flight.ships > 0) {
    return { rule: 'ship-alone', reason: 'A push (or a pull request) is still running beside this command (they were sent together). Run this after it has finished: the push runs by itself, after the other commands have finished.' }
  }

  return null
}

/** How often the activity row is sampled and its spinner turns. */
const ACTIVITY_MS = 400
/** The activity timer of this module's life: cancelled when a new session starts. */
let activityTimer: { cancel: () => void } | undefined

/**
 * One tick of the activity row: the running agents' own task descriptions
 * (the Agent call's few words), and the next spinner frame. Writes only
 * while an agent runs, and once more to clear the row when the last ends.
 */
async function activityTick($: Engine): Promise<void> {
  const agents = await $.agent.list().catch(() => [])
  const tasks = agents.filter(one => one.status === 'running' || one.status === 'pending').map(one => one.description || one.type)
  const before = await activityOf($)
  if (tasks.length === 0 && before.tasks.length === 0) {
    return
  }
  await setActivity($, { frame: tasks.length === 0 ? 0 : before.frame + 1, tasks })
}

/** Where agents' own git worktrees sit: each is a checkout of its own, never part of this tree's change. */
const AGENT_CHECKOUT = /^\.claude\/worktrees\/[^/]+(?:\/|$)/

/** A placed path inside an agent's checkout, spelled from that checkout's root. */
function inCheckout(one: Placed): Placed {
  return one.rel !== null && AGENT_CHECKOUT.test(one.rel) ? { ...one, rel: one.rel.replace(AGENT_CHECKOUT, '') } : one
}

/**
 * Whether the context is past a pressure level now, debounced (hooks/context.ts):
 * the note for the builder, or null. At the save level the person hears it too.
 */
async function pressureCheck($: Engine, cfg: Config, given?: SessionUsage | null): Promise<string | null> {
  const usage = given === undefined ? await $.session.usage().catch(() => null) : given
  const window = usage?.context.window ?? 0
  const tokens = usage?.context.tokens
  const level = pressureOf(tokens, window, pressureLevels(window, cfg))
  const step = pressureStep(live.pressure, level, live.calls, cfg.context.debounceCalls)
  live.pressure = step.state
  if (step.say === 0) {
    return null
  }
  const remaining = window - (tokens ?? 0)
  if (step.say === 2) {
    $.ui.toast(`devloop: the context is nearly full (about ${remaining} tokens left). The agent was asked to write a handoff now; a fresh session's first prompt is briefed from it (/devloop handoff show prints it).`, { timeoutMs: 15_000 })
  }

  return pressureNote(step.say, remaining)
}

/**
 * After an allowed tool call of the main conversation: what its result put
 * into the context (an estimate, for /devloop metrics), and a pressure note
 * on the result when one is due.
 */
async function observe($: Engine, e: { tool: unknown; agentId?: string } & Record<string, unknown>, ran: ToolCallResult): Promise<ToolCallResult> {
  if (e.agentId !== undefined || ran.deny !== undefined) {
    return ran
  }
  const at = await look($).catch(() => null)
  const cfg = at === null ? null : (await policyInForce($, at).catch(() => null))?.cfg ?? null
  if (at === null || cfg === null) {
    return ran
  }
  const tool = String(e.tool)
  const chars = typeof ran.text === 'string' ? ran.text.length : JSON.stringify(ran.result ?? '').length
  const named = typeof e.file_path === 'string' ? e.file_path : typeof e.notebook_path === 'string' ? e.notebook_path : null
  const file = named === null ? null : relative(at.root, at.cwd, named) ?? named
  const sessionId = await $.session.id().catch(() => null)
  live.attribution = attribute(live.attribution, sessionId, tool, tool === 'Read' ? file : null, chars)
  if (live.calls % 5 === 0) {
    await $.store.set(`attribution:${at.root}`, live.attribution).catch(() => undefined)
  }
  const note = await pressureCheck($, cfg)

  return note === null ? ran : { ...ran, context: [...(ran.context ?? []), `devloop context: ${note}`] }
}

/**
 * The cache-health meter: one main-loop turn's usage, as the API counted
 * it, folded in per session and per change; a turn that re-wrote a large
 * prefix is a miss with its inferred cause (hooks/cache.ts). A miss caused
 * on devloop's side should be impossible and is recorded loudly.
 */
async function meter($: Engine, e: { usage?: TurnUsage; durationMs: number }): Promise<void> {
  const at = await look($)
  const cfg = (await policyInForce($, at))?.cfg ?? null
  if (cfg === null || e.usage === undefined) {
    return
  }
  const usage = e.usage
  const now = await $.clock.now()
  const sessionId = await $.session.id().catch(() => null)
  const prefix = digest(`${live.thread.isSectionOn === true ? RULES : ''}\n${TOOLS_HASH}`)
  let miss: Miss | null = null
  await saveCache($, at.root, before => {
    const step = meterTurn(before, { usage, at: now, durationMs: e.durationMs, sessionId, prefix, missTokens: cfg.cache.missTokens, ttlMinutes: cfg.cache.ttlMinutes })
    miss = step.miss

    return step.state
  })
  const found = miss as Miss | null
  if (found !== null) {
    await record($, at.root, found.cause === 'devloop-change' ? 'cache-devloop-change' : 'cache-miss', found.cause, `${found.tokens} tokens re-written; inferred cause: ${found.detail}`)
    if (found.cause === 'devloop-change') {
      $.ui.toast('devloop: a prompt-cache miss traced to devloop\'s own system-prompt section or tool list changing mid-thread. That is a bug in devloop; it is in the ledger.', { timeoutMs: 15_000 })
    }
  }
  await $.store.set(`attribution:${at.root}`, live.attribution).catch(() => undefined)
}

/** Who made a tool call, as the audit trail names it: the builder, or a named agent. */
function actorOfCall(agentId: string | undefined, isReviewer: boolean, isEval: boolean): Actor {
  return agentId === undefined ? { kind: 'builder', name: null } : { kind: 'agent', name: isReviewer ? 'reviewer' : isEval ? 'eval' : `subagent:${agentId.slice(0, 40)}` }
}

/**
 * Records one tool call of the eval agent at work, for its task's trajectory
 * assertions: the tool, the skill a `Skill` call names, and the rule of a
 * guard that fired on it (refused or only observed). A main-loop `Skill`
 * call opens a unit of the cost meter.
 */
async function noteCall($: Engine, e: { tool: unknown; agentId?: string } & Record<string, unknown>, fired: string | null): Promise<void> {
  const tool = String(e.tool)
  const skill = tool === 'Skill' && typeof e.skill === 'string' ? e.skill : undefined
  const loop = await loopOf($)
  if (e.agentId === undefined) {
    if (skill !== undefined && loop.root !== null) {
      await meterCost($, loop.root, { kind: 'skill', name: skill.slice(0, 80) })
    }

    return
  }
  if (loop.root === null || loop.evalRun?.current?.agentId !== e.agentId) {
    return
  }
  const call = { tool, ...(skill === undefined ? {} : { skill }), ...(fired === null ? {} : { refused: fired }) }
  await save($, loop.root, before => {
    const run = before.evalRun
    const current = run?.current ?? null

    return run === null || current === null || current.agentId !== e.agentId ? before : { ...before, evalRun: { ...run, current: { ...current, calls: [...current.calls, call].slice(-500) } } }
  })
}

/** At a main-loop turn's end: the learned rules' upkeep, then a proposer run where a repeat waits for one (DESIGN 4.17). */
async function afterTurn($: Engine, isPerson: boolean): Promise<void> {
  const at = await look($)
  if (!at.isOptedIn) {
    return
  }
  const cfg = (await policyInForce($, at))?.cfg ?? null
  if (cfg === null) {
    return
  }
  await sweepLearning($, at, cfg).catch(() => undefined)
  // The proposer runs at a turn's end only when the policy asks for it (learning.at "turn"); by default it waits for the change to close.
  if (cfg.learning.auto !== 'off' && cfg.learning.at === 'turn') {
    await maybePropose($, at, cfg, 'turn', isPerson)
  }
}

/** Adds one hit to a rule's count and last-fired time (prune's evidence). */
async function hitRule($: Engine, root: string, id: string): Promise<void> {
  const now = await $.clock.now()
  const hits = ((await $.store.get(`rulehits:${root}`)) as Hits | undefined) ?? {}
  await $.store.set(`rulehits:${root}`, hit(hits, id, now))
}

/**
 * The ratchets' baselines (rea note 1): each ratchet rule of the policy in
 * force counts its unmarked matches across the tracked files its globs
 * match. A rule with no baseline (or a new pattern) takes the count as it;
 * a count that fell lowers it; a count above it (a write no edit tool made)
 * is recorded in the ledger. Kept in plugin state, never in the repository.
 */
async function ratchetBaselines($: Engine, at: Place, cfg: Config): Promise<void> {
  const ratchets = cfg.rules.filter(one => one.action === 'ratchet')
  if (ratchets.length === 0) {
    return
  }
  const files = (await filesUnder($, at, ['']))[''] ?? []
  const key = `ratchet:${at.root}`
  const kept = ((await $.store.get(key)) as Record<string, Baseline> | undefined) ?? {}
  const now = await $.clock.now()
  for (const rule of ratchets) {
    let count = 0
    for (const file of files.filter(one => rulesFor(one, [rule]).length > 0).slice(0, 3000)) {
      count += countUnmarked(rule, await $.fs.read(`${at.root}/${file}`).catch(() => ''))
    }
    const before = kept[rule.id]
    if (before === undefined || before.pattern !== rule.pattern) {
      kept[rule.id] = { count, pattern: rule.pattern, at: now }
    } else if (count < before.count) {
      kept[rule.id] = lowered(before, count - before.count, now)
    } else if (count > before.count) {
      await record($, at.root, 'ratchet-over', rule.id, `${count} unmarked matches of ${rule.pattern}, over the baseline of ${before.count}: a write no edit tool made raised it`)
    }
  }
  await $.store.set(key, kept)
}

/** Policy errors go to the audit trail once per distinct set: they keep the gate shut. */
async function auditPolicyErrors($: Engine, at: Place): Promise<void> {
  if (at.errors.length === 0) {
    return
  }
  const key = `policy-errors:${at.root}`
  const said = digest(at.errors.join('\n'))
  if ((await $.store.get(key)) === said) {
    return
  }
  await $.store.set(key, said)
  await audit($, at.root, 'policy-error', { kind: 'harness', name: null }, 'devloop.json', null, at.errors.slice(0, 3).join('; '))
}

/**
 * The check after the fact (L2, decision 9b): a command that shipped and
 * returned without error is judged again on the tree as it now is. A gate
 * that is not green for what was shipped is recorded in the audit trail and
 * the ledger, toasted, and said to the builder. Detection, not prevention:
 * what was pushed is already pushed.
 */
async function checkShipped($: Engine, at: Place, text: string, actor: Actor, isDone: boolean, isBackground: boolean): Promise<string | null> {
  const found = await snapshotInForce($, at)
  if (found === null) {
    return null
  }
  const { snap, policy } = found
  const judging = policy.cfg
  const shipped = shipsOf(text).filter(one => one.kind !== 'merge' || isOnDefault(one, snap.branch, judging.defaultBranch))
  if (shipped.length === 0) {
    return null
  }
  const { loop } = await refresh($, at, judging)
  const tier = tierFor(loop, judging)
  const facts = factsOf(at, policy)
  if ((tier === 'none' && loop.isBaseKnown) || isShippable(loop, judging, facts)) {
    // The gate passed the push and what shipped is what it judged: the change is closed for the review cap (Z1). Only a
    // push under both readings, no dry run, not in the background (the fourteenth round, CC-F7).
    if (isDone && !isBackground && closesReview(text)) {
      await closeShippedReview($, at)
    }

    return null
  }
  const unmet = gate(loop, judging, facts).filter(row => !row.isMet)
  const rows = unmet.map(row => row.label).join(', ')
  await keepGate($, at, judging, 'shipped', tier, false, gate(loop, judging, facts), loop.tree)
  await audit($, at.root, 'shipped-ungated', actor, clip(text.replace(/\s+/g, ' ').trim(), 80), loop.tree, `unmet: ${rows}`)
  await record($, at.root, 'shipped-ungated', rows.slice(0, 60), `${text.slice(0, 80)}: ${rows}`)
  $.ui.toast(`devloop: WORK WAS SHIPPED THAT THE GATE HAD NOT PASSED (${clip(text.replace(/\s+/g, ' ').trim(), 60)}). Unmet: ${rows}. Check what reached the remote.`, { timeoutMs: 30_000 })

  return `devloop: you just shipped work the gate had not passed (unmet: ${rows}). Stop now, do not ship anything more, and tell the person what you pushed and that the gate was not green.`
}

/**
 * Whether this tree may finish a `.tasks` task (D2): devloop's gate is the
 * finish gate, so the gate must be green on the tree as it stands and the
 * tier must need no person's approval. Proven as the ship gate proves the
 * tree (a refresh, then the rows), without running checks.
 */
async function finishFacts($: Engine, at: Place, cfg: Config): Promise<TasksFacts> {
  const found = await snapshotInForce($, at)
  if (found === null) {
    return { isOn: true, canFinish: null, finishWhy: '' }
  }
  const { loop } = await refresh($, at, found.policy.cfg, false)
  const judging = found.policy.cfg
  const facts = factsOf(at, found.policy)
  const tier = tierFor(loop, judging)
  const unmet = gate(loop, judging, facts).filter(row => !row.isMet).map(row => row.label)
  const approvals = approvalsFor(tier, judging)
  const canFinish = unmet.length === 0 && approvals === 0

  return {
    isOn: true,
    canFinish,
    finishWhy: unmet.length > 0 ? `the gate is not green on this tree (still needed: ${unmet.slice(0, 4).join(', ')})` : approvals > 0 ? `this ${tier}-risk change needs ${approvals} person's approval${approvals === 1 ? '' : 's'} (${approvers(tier, cfg)})` : '',
  }
}

const SESSION_CHECK = `
# devloop:tasks-session-check
tasks session-check --json --session "$1"
`

/** The `.tasks` session check for this session where the integration is on (D2): what it reports, or null when it passes or is off. */
async function sessionCheck($: Engine, at: Place, cfg: Config): Promise<string | null> {
  const tasks = await tasksFactsOf($, at, cfg)
  const session = await $.session.id().catch(() => null)
  if (!tasks.isOn || session === null) {
    return null
  }
  const ran = await git($, at, SESSION_CHECK, [session], 30_000)

  return ran === null ? null : sessionCheckProblems(ran.code, ran.out)
}

/** The seat's claims, read only where a spec is being built (D2): none otherwise, so a session with no spec reads nothing. The holder is the seat (final round, D2 F4). */
async function buildClaims($: Engine, at: Place, loop: Loop): Promise<{ claims: Claims; session: string | null; now: number }> {
  const now = await $.clock.now()

  return { claims: loop.phase === 'build' && loop.spec !== null ? await claimsOf($, at).catch(() => ({})) : {}, session: seatOfPlace(at), now }
}

export const register: Register = on => {
  /** The main loop's turn in progress, so exemptions bind to it and end with it. */
  let turnId: string | null = null
  /** Whether the main loop has no turn going: a background failure may wake it then (rule 2). */
  const isIdle = (): boolean => turnId === null

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'devloop',
      description: 'The development loop: status, init, spec, approve, verify, review, done, doctor, learn',
      argumentHint: '[status | init | spec <name> | approve | verify | review | done | help]',
    })
    live = fresh()
    forgetRenewal()
    // The row's spinner and the words of what agents are doing: sampled while any agent runs, nothing written while none does.
    activityTimer?.cancel()
    activityTimer = $.clock.every(ACTIVITY_MS, () => activityTick($))
    // Every tool, before anything that could fail: the list must not depend on the repository.
    await registerTools($).catch(() => undefined)
    // The module is live in this session: a classic hook that finds no stamp for a call knows the module's hook was skipped (D1).
    await heartbeat($).catch(() => undefined)
    const at = await wake($).catch(() => null)
    await registerActions($, at?.isOptedIn === true).catch(() => undefined)
    if (at !== null && at.isOptedIn) {
      if (e.isInteractive) {
        void $.ui.open({ id: PANE, title: 'Dev loop', backgroundColor: 'transparent' })
      }
      // A new model is the moment to re-run the evals and prune what the old one needed.
      const model = await $.session.model().catch(() => '')
      const known = (await $.store.get(`model:${at.root}`)) as string | undefined
      if (model !== '' && known !== model) {
        await $.store.set(`model:${at.root}`, model)
        if (known !== undefined) {
          $.ui.toast(`devloop: the model changed (${known} to ${model}). Run /devloop eval, then /devloop prune.`, { timeoutMs: 12_000 })
        }
      }
    }

    return next(e)
  })

  // An exemption granted while a turn runs belongs to that turn.
  on('command.run', { command: 'devloop' }, ($, e) => answerCommand($, e, turnId))
    .catch((_, e, next) => ({ text: failureText(e.args.trim(), next.error) }))

  // One entry per action in the `/` menu: the same handler, the action put in front of the arguments.
  for (const a of ACTIONS) {
    on('command.run', { command: commandName(a) }, ($, e) => answerCommand($, { ...e, args: `${a.name} ${e.args}`.trim() }, turnId))
      .catch((_, e, next) => ({ text: failureText(`${a.name} ${e.args}`.trim(), next.error) }))
  }

  // Esc closes the settings popup as Cancel does: the draft goes with it.
  on('ui.close', { id: SETTINGS_PANE }, async ($, e, next) => {
    const closed = await next(e)
    await updateSettingsDraft($, () => null)

    return closed
  }).catch(() => undefined)

  // The rules, said once per thread; the guards below are what holds them.
  // One text for every repository and every state (RULES), sent where the
  // repository had opted in when the thread's prompt was first composed, and
  // decided once per thread: kept in plugin state by session id (F6), so a
  // plugin reload never decides again; only a new session or /clear does.
  on('prompt.compose', async ($, e, next) => {
    const composed = await next(e)
    const id = await $.session.id().catch(() => null)
    const kept = await sectionOf($)
    let isOn = kept.sessionId === id && kept.isOn !== null ? kept.isOn : null
    if (isOn === null) {
      isOn = (await look($)).isOptedIn
      await setSection($, { sessionId: id, isOn })
    }
    live.thread.isSectionOn = isOn

    return isOn ? { sections: [...composed.sections, { id: 'devloop:rules', text: RULES, scope: 'session' as const }] } : composed
  })

  // What devloop tells the model beside a person's prompt: each source of
  // context as a delta against what this thread was last sent, under a
  // budget (hooks/context.ts). A new prompt also resets what belongs to one
  // request: fix rounds, a blocked report, a run of refusals.
  on('prompt.submit', async ($, e, next) => {
    if (e.isMeta === true || e.command !== undefined || !['composer', 'bridge', 'sdk'].includes(e.origin.kind)) {
      return next(e)
    }
    // The module saw this person's prompt: the classic UserPromptSubmit hook beneath stands down (DESIGN 4.15).
    await stampPrompt($, e.text).catch(() => undefined)
    live.isPersonTurn = true
    live.isLearnTurn = true
    const at = await locate($)
    const policy = await policyInForce($, at)
    if (policy === null) {
      return next(e)
    }
    const cfg = policy.cfg
    const loop = await save($, at.root, before => ({ ...before, verify: { ...before.verify, rounds: 0, blockedTree: null }, blocked: null, refusals: { rule: '', count: 0 } }))
    // Grounding (DESIGN 4.15): a person's question of fact gets one line of context, and its stop the backstop.
    const isQuestion = groundingMode(cfg) !== 'off' && isQuestionOfFact(e.text, cfg.grounding.also, cfg.grounding.never)
    live.grounding = { ...live.grounding, turn: null, isPending: true, isQuestion, prompt: firstLine(e.text), looks: 0, isRefused: false, isDone: false, startTree: live.lastStopTree ?? loop.tree }
    if (isQuestion) {
      await countGrounding($, at.root, 'questions').catch(() => undefined)
    }
    await meterCost($, at.root, { kind: 'prompt' })
    await auditPolicyErrors($, at).catch(() => undefined)
    // What the classic hooks recorded while the module did not judge (D1): into the ledger and the audit trail.
    await foldInbox($, at).catch(() => undefined)
    const sessionId = await $.session.id().catch(() => null)
    const isNewThread = live.thread.sessionId !== sessionId
    const isReset = isNewThread || live.thread.isCompacted
    if (isNewThread) {
      live.thread.sessionId = sessionId
      live.thread.emitted = {}
      live.thread.isBriefed = false
    }
    live.thread.isCompacted = false
    const now = await $.clock.now()
    const usage = await $.session.usage().catch(() => null)
    const cache = await cacheOf($, at.root)
    // A prompt after the cache lapsed, on a large context: the person hears what it costs, once per gap. Nothing goes to the model.
    const lastAt = cache.last?.at ?? null
    // While cache-guard is installed it speaks about a cold cache (it prices the re-read), so devloop does not (DESIGN 4.14).
    if (lastAt !== null && live.thread.idleToldFor !== lastAt && isIdleGap(lastAt, now, usage?.context.tokens, cfg) && (await guardNow($).catch(() => null))?.state !== 'installed') {
      live.thread.idleToldFor = lastAt
      $.ui.toast(`devloop: the last response was ${Math.round((now - lastAt) / 60_000)} minutes ago, past the prompt cache's ${cfg.cache.ttlMinutes}-minute lifetime, so this prompt re-writes roughly ${usage?.context.tokens ?? 0} tokens of cache (an estimate). /devloop handoff and a fresh session would be cheaper.`, { timeoutMs: 15_000 })
    }
    // A cache-guard handoff for this folder is cache-guard's to load (/handoff-load): devloop never reads it into the
    // briefing, and tells the person once per session that it is there (DESIGN 4.14).
    if (sessionId !== null && live.handoffToldIn !== sessionId) {
      live.handoffToldIn = sessionId
      if (await handoffFor($, at.root).catch(() => false)) {
        $.ui.toast('devloop: cache-guard saved a handoff for this folder. devloop does not load it; to start from it, /clear and then run /handoff-load (cache-guard\'s command).', { timeoutMs: 15_000 })
      }
    }
    const judging = cfg
    const facts = factsOf(at, policy)
    const isOpen = loop.phase !== 'idle' || loop.tier !== 'none'
    const sources: Source[] = []
    sources.push({ key: 'policy-errors', label: 'policy errors', priority: 0, text: at.errors.length > 0 ? `devloop.json has problems a person must fix (the gate stays shut until then): ${at.errors.slice(0, 4).join('; ')}` : null })
    sources.push({ key: 'status', label: 'status', priority: 0, text: isOpen ? brief(loop) : null })
    sources.push({ key: 'policy', label: 'policy', priority: 1, text: policyFacts(cfg, modeInForce(at) === 'observe' ? 'observe' : 'enforce') })
    // The checks that apply to the files this change touched (DESIGN 4.16, decision 6).
    sources.push({ key: 'checks', label: 'checks for what you changed', priority: 1, text: checksForChange(cfg, loop.changed) })
    // What the background checks did on this tree since the agent last heard (rule 2): running, passed, failed or unable to run.
    sources.push({ key: 'tests', label: 'background tests', priority: 1, text: backgroundNotice(loop, cfg, now) })
    if (!live.thread.isBriefed && isOpen) {
      // A session that starts cold on an open change: told once (DESIGN 4.7), and marked told only once it is sent (F10).
      sources.push({ key: 'briefing', label: 'cold-start briefing', priority: 1, text: briefing(await briefFacts($, at, loop)), isEphemeral: true })
    }
    const unmet = loop.tier === 'none' ? [] : gate(loop, judging, facts).filter(check => !check.isMet)
    sources.push({ key: 'gate', label: 'gate rows not met', priority: 3, text: unmet.length > 0 ? unmet.map(check => `[ ] ${check.label}: ${check.note}`).join('\n') : null })
    // Ready work, in dependency order and without another session's claims (D2): the same as before when one session works here.
    const held = await buildClaims($, at, loop)
    const ready = loop.phase === 'build' ? readyFor(loop, held.claims, held.session, held.now) : []
    const failing = loop.phase === 'build' ? Object.entries(loop.features).filter(([, one]) => !one.passes || one.tree !== loop.tree).map(([id]) => id) : []
    sources.push({ key: 'features', label: 'features', priority: 2, text: loop.phase === 'build' ? `ready to build: ${ready.join(', ') || 'none'}; not passing on this tree: ${failing.join(', ') || 'none'}` : null })
    // While a spec is written, the checklist items that apply are offered as candidate criteria (D2): nothing when no checklist applies.
    const base = loop.phase === 'spec' ? (await snapshot($, at, cfg).catch(() => null))?.base ?? null : null
    sources.push({ key: 'checklists', label: 'checklist candidates', priority: 2, text: loop.phase === 'spec' ? await candidateContext($, at, loop, base).catch(() => null) : null })
    const toFix = loop.findings.filter(one => one.status === 'open' && one.isBlocking && one.route === 'fix')
    // The review cycle's one summary (spec §5): sent once as a delta; relay it to the person.
    sources.push({ key: 'review-summary', label: 'review summary to pass on to the person', priority: 2, text: loop.review.cycle.summary })
    sources.push({ key: 'findings', label: 'open findings for you', priority: 2, text: toFix.length > 0 ? toFix.map(one => `${one.id} ${one.file}:${one.line} ${one.problem.slice(0, 120)}`).join('\n') : null })
    const note = await pressureCheck($, cfg, usage)
    sources.push({ key: 'pressure', label: 'context', priority: 0, text: note, isEphemeral: true })
    const out = deltas(sources, live.thread.emitted, cfg.context.budgetTokens, isReset)
    live.thread.emitted = out.emitted
    if (out.deltas.some(one => one.key === 'briefing')) {
      live.thread.isBriefed = true
    }

    const added = [...(out.text === null ? [] : [out.text]), ...(isQuestion ? [`devloop: ${NUDGE}`] : [])]

    return added.length === 0 ? next(e) : next({ ...e, context: [...(e.context ?? []), ...added] })
  }).catch((_, e, next) => next(e))

  // A compaction drops what the thread was sent: every source is said again, and the cache meter knows why the next turn re-writes.
  on('session.compact', async ($, e, next) => {
    const done = await next(e)
    if (e.agentId === undefined && e.trigger !== 'precompute' && done.messages !== undefined) {
      live.thread.isCompacted = true
      const at = await look($).catch(() => null)
      if (at !== null && at.isOptedIn) {
        await saveCache($, at.root, before => ({ ...before, isCompacted: true })).catch(() => undefined)
      }
    }

    return done
  }).catch((_, e, next) => next(e))

  // A /clear ends the thread: the next prompt starts a new one, briefed again.
  on('session.end', async ($, e, next) => {
    const at = await locate($).catch(() => null)
    // A background run ends with the session (a /clear included, which starts no session.start): it is
    // dropped before the engine ends its child, so it is never recorded as killed, and starts again at the next stop.
    if (at !== null && at.isOptedIn) {
      await abandonBackground($, at).catch((error: unknown) => {
        $.ui.log(`devloop: the background runs could not be dropped at the session's end: ${String(error)}`, { to: 'debug' })
      })
    }
    // The session ends: the polling of follow-ups stops; their record stays for a later session (D2).
    if (e.reason !== 'clear') {
      stopFollowTimer()
      // Its seat's claims are released only where another seat waits for them; the rest lapse with their lease (final round, D2 F4).
      if (at !== null && at.isOptedIn) {
        await releaseAtSessionEnd($, at).catch(() => 0)
      }
    }
    if (e.reason === 'clear') {
      live.thread.sessionId = null
      live.thread.isSectionOn = null
      await setSection($, { sessionId: null, isOn: null }).catch(() => undefined)
    }

    return next(e)
  })

  // ------------------------------------------------------------ turns

  // An exemption is bound to the next main-loop turn and ends with it, however it ends.
  on('turn.start', async ($, e, next) => {
    if (e.agentId === undefined) {
      turnId = e.turnId
      // The turn a person's prompt started is the one grounding judges at its stop (DESIGN 4.15).
      if (live.grounding.isPending) {
        live.grounding = { ...live.grounding, turn: e.turnId, isPending: false }
      }
      await heartbeat($).catch(() => undefined)
      // Calls in flight belong to the turn they came in: a new turn starts the count over.
      live.flight = { gen: live.flight.gen + 1, writes: 0, ships: 0 }
      const loop = await loopOf($)
      if (loop.root !== null && (loop.allow.some(one => one.turnId === null) || loop.refusals.count > 0)) {
        const id = e.turnId
        await save($, loop.root, before => ({ ...before, allow: before.allow.map(one => (one.turnId === null ? { ...one, turnId: id } : one)), refusals: { rule: '', count: 0 } }))
      }
    }

    return next(e)
  })

  // ------------------------------------------------------------ the guards

  on('tool.call', async ($, e, next) => {
    const tool = String(e.tool)
    const isFile = tool === 'Read' || EDITS.includes(tool)
    const isSearch = SEARCHES.includes(tool)
    const isShell = SHELLS.includes(tool)
    if (!isFile && !isSearch && !isShell) {
      live.calls += 1
      await noteCall($, e as never, null).catch(() => undefined)

      return countLook(e as never, await observe($, e as never, await next(e)))
    }
    // Two calls dispatched together (C2.1): a main-loop call that can write, or
    // that ships, is counted in flight from the moment it arrives until its
    // hook is done, however it ends. A ship beside a write is refused, and so
    // is a write beside a ship.
    const kind = e.agentId !== undefined || tool === 'Read' || isSearch ? null : EDITS.includes(tool) ? { isShip: false, isWrite: true } : callKind(e.tool === 'Bash' ? e.command : e.tool === 'Monitor' ? (e.command ?? '') : '')
    const clash = kind === null ? null : flightClash(kind)
    const token = kind === null || clash !== null ? null : enterFlight(kind)
    try {
      const at = await locate($)
      // The policy in force, whole: the base branch's devloop.json when it has one (paths, rules and mode alike).
      const cfg = (await policyInForce($, at))?.cfg ?? DEFAULTS
      const isOptedIn = at.isOptedIn
      const loop = await loopOf($)
      // The proposer (DESIGN 4.17) is read-only as a reviewer is: it is held to the same rules.
      const isReviewer = isReviewerAgent(loop, e.agentId) || isLearnerAgent(loop, e.agentId)
      const evalDir = e.agentId !== undefined && e.agentId === loop.evalRun?.current?.agentId ? loop.evalRun.current.dir : null
      const isEval = evalDir !== null
      // An agent's own working directory places the relative paths of its calls.
      const cwd = await $.session.cwd().catch(() => at.cwd)
      const home = (await $.env.get('HOME').catch(() => undefined)) ?? null
      const tmp = (await $.env.get('TMPDIR').catch(() => undefined)) || null
      const stateRoot = isOptedIn ? await stateRootOf($) : null
      const stateDir = isOptedIn ? await stateDirOf($, at.root) : null
      // The `.tasks` integration in force (D2): its rules apply only where it is on.
      const tasks = isOptedIn ? await tasksFactsOf($, at, cfg).catch(() => null) : null
      // The variables a path may be placed through (R8): the line's own, and these from the environment.
      const env = await envFor($)
      // The spec library (DESIGN 4.18) is the harness's to write, wherever a person put it (as its state is, where opted in).
      const library = isOptedIn ? await librarySpellings($).catch(() => [] as string[]) : []
      let where = whereOf(at.root, cwd, { home, tmp, stateRoot, sandbox: evalDir, env, library, ...(tasks === null ? {} : { tasks }) })
      // Any judged call of a session that holds claims renews them, at most once a minute (D2).
      if (isOptedIn && e.agentId === undefined) {
        await renewClaims($, at, cfg).catch(() => undefined)
      }
      const isInEval = (path: Placed): boolean => evalDir !== null && path.abs !== null && (path.abs === evalDir || path.abs.startsWith(`${evalDir}/`))
      const refusals: Refusal[] = []
      let subject = ''
      let path: string | null = null
      /** A shell command that writes in the repository: the tree has moved once it runs. */
      let isTreeWrite = false
      /** A test file this edit leaves with fewer assertions, recorded once it is made. */
      let assertionDrop: string | null = null
      /** A test file the builder creates while building: allowed, and recorded once made. */
      let newTest: string | null = null
      /** What a person's exemption lifted a rule for in this call: a write's concrete path, or `command: <text>`. */
      let lifted: string | null = null
      /** What the content rules made of this edit (C2). */
      let contentHits: RuleHit[] = []
      /** The shell command's text, for the check after a shipping command ran (L2). */
      let shellText = ''
      /** The path the content rules judged, as the ledger names it (C2.1 F8). */
      let contentPath = ''
      /** The learned rules' ids among the hits (DESIGN 4.17): a trial rule's hits are its own to count too. */
      let learnedIds: string[] = []

      if (isFile) {
        const file = e.tool === 'Edit' || e.tool === 'Write' || e.tool === 'Read' ? e.file_path : e.tool === 'NotebookEdit' ? e.notebook_path : ''
        // A path in an agent's own checkout (.claude/worktrees/<name>/) is judged as that checkout's path:
        // its tests and protected files are guarded as the repository's are, and `.claude/` is not its folder.
        const spelled = inCheckout(place(file, cwd, where))
        // A link is judged by where it leads as well as by how it is spelled.
        const placed = [spelled, ...(await realOf($, spelled, where)).map(inCheckout)]
        path = spelled.rel
        subject = spelled.rel ?? file
        if (placed.some(one => isSecretPlace(one, cfg))) {
          refusals.push({ rule: 'secret', reason: `${file} holds secrets; it is never read or written from here.` })
        }
        // The reviewer's read of the round's diff file (R11): checked against the hash kept when it was written; a file that
        // changed is written again from the tree, recorded and told, and the read goes on (it never fails on this).
        if (tool === 'Read' && isReviewer && isOptedIn && loop.review.round > 0 && stateDir !== null && spelled.abs === `${stateDir}/review-${loop.review.round}.diff`) {
          const isRewritten = await checkReviewDiff($, at, cfg, loop.review.round).catch(() => false)
          if (isRewritten) {
            await audit($, at.root, 'harness-state-changed', { kind: 'harness', name: null }, `review-${loop.review.round}.diff`, loop.tree, 'the round\'s diff file did not match the hash kept when it was written; it was written again from the tree').catch(() => undefined)
            $.ui.toast(`devloop: the review's diff file (round ${loop.review.round}) was changed after the harness wrote it. It was written again from the tree before the reviewer read it; something other than the harness wrote into its state.`, { timeoutMs: 20_000 })
          }
        }
        if (tool !== 'Read') {
          const state = placed.find(one => isHarnessState(one, where))
          if (state !== undefined) {
            refusals.push({ rule: 'harness-state', reason: harnessStateReason({ ...state, spelled: file }, where) })
          }
          if (isReviewer) {
            refusals.push({ rule: 'reviewer-read-only', reason: 'The reviewer is read-only: report the problem, do not fix it.' })
          }
          if (isEval && !placed.every(isInEval)) {
            refusals.push({ rule: 'eval-containment', reason: `An eval task works only inside its own worktree (${evalDir ?? ''}).` })
          }
          const isTest = isOptedIn && !isEval && !isReviewer && spelled.rel !== null && spelled.rel !== '' && matchesAny(spelled.rel, cfg.tests)
          const rel = spelled.rel ?? ''
          const isExempt = loop.allow.some(one => one.kind === 'path' && matches(rel, one.value))
          const exists = isTest ? await $.fs.exists(spelled.abs ?? file).catch(() => true) : true
          // A new test file while building weakens nothing a person approved: Write may create one.
          if (isTest && tool === 'Write' && loop.phase === 'build' && !exists && !(rel in (loop.testHashes ?? {}))) {
            newTest = rel
          }
          const judging = newTest === null ? loop : { ...loop, newTests: [...loop.newTests, newTest] }
          // An edit tool names a file: nothing beneath it is probed (B2.1 F7).
          const asFile = (one: Placed): Where => (one.rel === null ? where : { ...where, folders: { ...where.folders, [one.rel]: false } })
          if (isOptedIn && !isEval) {
            for (const one of placed) {
              const verdict = judgeWrite(one, cfg, judging, asFile(one))
              if (verdict !== null && verdict.rule !== 'secret') {
                refusals.push(verdict)
              }
            }
          }
          // Wherever a test is editable: more skips, or emptying it, is refused; fewer assertions is a gate note.
          // A file being created is judged against nothing (B2.1 F3): any marker in it is a rise.
          let edit: TestEdit | null = null
          if (isTest && tool !== 'NotebookEdit') {
            const before = exists ? await $.fs.read(spelled.abs ?? file).catch(() => '') : ''
            const after = editedText(before, e as unknown as { tool: string })
            edit = after === null ? null : judgeTestEdit(before, after)
          }
          if (edit !== null && !isExempt) {
            if (edit.isWeakened) {
              refusals.push({ rule: 'test-weakened', reason: `This edit ${exists ? 'adds' : 'creates a test file with'} skip, only, todo or xfail markers ${exists ? 'to' : 'in'} ${rel} (${edit.before.skips} before, ${edit.after.skips} after), which switches tests off. Make the code pass the test instead. If the test is truly wrong, say so and stop: a person can allow it for one turn with /devloop allow ${rel}.` })
            } else if (edit.isEmptied) {
              refusals.push({ rule: 'test-weakened', reason: `This edit empties ${rel}, which deletes its tests. If the test is truly obsolete, say so and stop: a person can allow it for one turn with /devloop allow ${rel}.` })
            } else if (edit.isAssertionDrop) {
              assertionDrop = rel
            }
          }
          // Content rules (C2): the lines this edit adds, against the policy in force's rules for this path.
          const rules = cfg.rules
          const ruleRel = isEval ? (spelled.abs !== null && evalDir !== null && spelled.abs.startsWith(`${evalDir}/`) ? spelled.abs.slice(evalDir.length + 1) : null) : spelled.rel
          // The learned rules (DESIGN 4.17), from the harness's state, never for an eval agent: a trial rule records, a promoted one refuses.
          // A pattern that does not compile, or a glob that cannot be read, gives no hit and never an error.
          const learned = isOptedIn && !isReviewer && !isEval && tool !== 'NotebookEdit' && ruleRel !== null && ruleRel !== ''
            ? learnedRules(await learnedNow($, at.root).catch(() => EMPTY_LEARNED), cfg)
            : []
          const isLearnedHere = ruleRel !== null && learned.length > 0 && appliesTo(ruleRel, learned)
          if (isOptedIn && !isReviewer && tool !== 'NotebookEdit' && ruleRel !== null && ruleRel !== '' && (rulesFor(ruleRel, rules).length > 0 || isLearnedHere)) {
            const fileExists = await $.fs.exists(spelled.abs ?? file).catch(() => false)
            const before = fileExists ? await $.fs.read(spelled.abs ?? file).catch(() => '') : ''
            const after = editedText(before, e as unknown as { tool: string })
            const ablated = isEval && loop.evalRun?.current?.pass === 'without' && loop.evalRun.without?.kind === 'rule' ? [loop.evalRun.without.target] : []
            contentHits = after === null ? [] : judgeContent(ruleRel, before, after, rules, ablated)
            const learnedHits = after === null || !isLearnedHere ? [] : judgeLearned(ruleRel, before, after, learned)
            learnedIds = learnedHits.map(one => one.rule.id)
            contentPath = ruleRel
            for (const one of contentHits.filter(each => each.verdict === 'refuse')) {
              refusals.push({ rule: 'content-rule', id: one.rule.id, reason: contentReason(one, ruleRel) })
            }
            // Only a promoted rule refuses; a trial rule's hit is recorded once the edit is made, and says nothing.
            for (const one of learnedHits.filter(each => each.verdict === 'refuse')) {
              refusals.push({ rule: 'content-rule', id: one.rule.id, reason: learnedReason(one, ruleRel) })
            }
            contentHits = [...contentHits, ...learnedHits]
          }
          // The `.tasks` rules (D2): a task's frontmatter and its log are the command's to write, judged by the
          // spelled path and by where it leads (final round, D2 F7), like every other path rule.
          const taskPaths = placed.filter(one => one.rel !== null && one.rel.startsWith('.tasks/'))
          if (isOptedIn && !isEval && !isReviewer && tasks !== null && tasks.isOn && tool !== 'NotebookEdit' && taskPaths.length > 0) {
            const fileExists = await $.fs.exists(spelled.abs ?? file).catch(() => false)
            const before = fileExists ? await $.fs.read(spelled.abs ?? file).catch(() => '') : null
            const after = editedText(before ?? '', e as unknown as { tool: string })
            const refusal = tasksEditRefusalOf(taskPaths, before, after, tasks)
            if (refusal !== null) {
              refusals.push(refusal)
            }
          }
          // Whether a person's path exemption lifted a rule for this write (B2.1 F12): judged as if it were not there.
          if (isExempt && isOptedIn && !isEval && !isReviewer) {
            const without = { ...judging, allow: judging.allow.filter(one => one.kind !== 'path') }
            const isLocked = placed.some(one => {
              const verdict = judgeWrite(one, cfg, without, asFile(one))

              return verdict !== null && !isAlwaysHeld(verdict.rule)
            })
            if (isLocked || edit?.isWeakened === true || edit?.isEmptied === true) {
              lifted = rel
            }
          }
        }
      } else if (isSearch) {
        const input = e as unknown as { path?: string; pattern?: string; glob?: string }
        subject = `${tool} ${input.pattern ?? ''}`
        const named = [input.path, tool === 'Glob' ? input.pattern : input.glob].filter((one): one is string => typeof one === 'string' && one !== '')
        if (named.some(one => isSecretPattern(one, cwd, where, cfg))) {
          refusals.push({ rule: 'secret', reason: 'This search targets secret files; they are never read from here.' })
        }
        // A link is judged by where it leads, as Read's path is.
        if (typeof input.path === 'string' && input.path !== '') {
          if ((await realOf($, place(input.path, cwd, where), where)).some(real => isSecretPlace(real, cfg))) {
            refusals.push({ rule: 'secret', reason: `${input.path} leads to files that hold secrets; they are never read from here.` })
          }
        }
      } else {
        const text = e.tool === 'Bash' ? e.command : e.tool === 'Monitor' ? (e.command ?? '') : ''
        subject = text.slice(0, 80)
        // What each wildcard path matches on disk, by the one expander every enforcement point uses (P-C).
        where = await withGlobs($, text, where)
        // Paths a command writes are listed (a folder's tracked files, or the
        // path itself when tracked), so a lock on a file beneath them holds and
        // `git checkout <word>` is known for a file or a branch.
        const written = writtenPaths(text, where)
        isTreeWrite = written.some(one => one.rel !== null)
        const dirs: string[] = []
        for (const one of written.slice(0, 16)) {
          const isGlob = /[*?[]/.test(one.rel ?? '')
          // Listed from the path before its first wildcard, as the rules expand it (the last review's F4).
          const rel = one.rel === null ? null : globParts(one.rel).dir
          if (rel !== null && (rel !== '' || isGlob) && dirs.length < 8 && !dirs.includes(rel)) {
            dirs.push(rel)
          }
        }
        // Which written paths are folders: only a folder's contents are probed (B2.1 F7). A path not there is no folder; one that cannot be told stays unknown.
        const folders: Record<string, boolean> = {}
        for (const rel of dirs.filter(one => one !== '')) {
          const kind = await $.fs.stat(`${at.root}/${rel}`).then(one => one.kind, (error: unknown) => (/ENOENT/.test(String((error as Error | undefined)?.message)) ? 'missing' : null))
          // `other` (a look refused, a link leading nowhere) stays unknown, so it is probed.
          if (kind === 'dir' || kind === 'file' || kind === 'missing') {
            folders[rel] = kind === 'dir'
          }
        }
        // The saved output of a check is named only when it is there.
        const filtered = filteredCheck(text, cfg.verify.map(one => one.run))
        const saved = filtered === null || stateDir === null ? null : outputPath(stateDir, filtered)
        const isSaved = saved !== null && (await $.fs.exists(saved).catch(() => false))
        // A merge ships only on the default branch (C2.1 F2): where a line merges without switching first, the branch checked out decides.
        const lookups = shipLookups(text)
        const branch = isOptedIn && lookups.hasMerge ? await currentBranch($, at) : null
        // A `gh` ship that names a repository is judged against this one's remote (D1).
        const remote = isOptedIn && lookups.hasRepoFlag ? await remoteOf($, at) : null
        where = { ...where, filesUnder: isOptedIn ? await filesUnder($, at, dirs) : {}, folders, savedOutput: run => (isSaved && run === filtered ? saved : null), branch, remote }
        // A line that would finish a task (D2): devloop's gate decides, proven on the tree as it stands.
        if (isOptedIn && tasks !== null && tasks.isOn && finishesTask(text)) {
          where = { ...where, tasks: await finishFacts($, at, cfg).catch(() => ({ ...tasks, canFinish: null })) }
        }
        const judging = isOptedIn && !isEval ? loop : { ...loop, phase: 'idle' as const, spec: null }
        let found = judgeCommandAll(text, cfg, judging, where)
        // Links the command names are followed: a link to a secret is a secret.
        for (const one of followedPlaces(namedPlacesByReading(text, where), LINK_BUDGET)) {
          if ((await realOf($, one, where)).some(real => isSecretPlace(real, cfg))) {
            found.push({ rule: 'secret', reason: `${one.spelled} leads to a file that holds secrets; no command reads or writes it from here.` })
          }
        }
        // Past a budget the rest of the line would go unjudged: the line is refused instead (the twelfth round, X10, X12).
        found.push(...budgetRefusals(text, where, isOptedIn))
        if (isOptedIn) {
          for (const one of followedPlaces(writtenPathsByReading(text, where), WRITE_LINK_BUDGET)) {
            // Where it leads, by the path rules and the `.tasks` shell rule alike (the last review's F6).
            found.push(...(await realOf($, one, where)).flatMap(real => resolvedWriteRefusals(real, cfg, judging, where)))
          }
        }
        if (!isOptedIn) {
          found = found.filter(one => one.rule === 'secret')
        }
        if (isEval) {
          // Only the path rules step aside, and only inside its worktree (anything outside is refused next).
          found = found.filter(one => !PATH_RULES.includes(one.rule))
          // A `git checkout <word>` that is no tracked path is a branch switch, not a write.
          // Each reading's writes, less the words that reading takes for a branch (CC1: neither reading excuses the other's).
          const branches = maybeWrittenByReading(text, where).map(list => new Set(list.filter(one => (where.filesUnder[one.rel ?? ''] ?? []).length === 0).map(one => one.abs)))
          const isOutside = writtenPathsByReading(text, where).some((list, i) => list.some(one => !isInEval(one) && !(branches[i]?.has(one.abs) ?? false)))
          if (isOutside || writesOpenPath(text, where) || shipsOf(text).length > 0) {
            found.push({ rule: 'eval-containment', reason: `An eval task works only inside its own worktree (${evalDir ?? ''}), and ships nothing.` })
          }
          // Task state (D2): the tasks command finds the main checkout's tree from a linked worktree, so an eval agent writes none of it.
          if (writesTaskState(text)) {
            found.push({ rule: 'eval-containment', reason: 'An eval task writes no task state: from its worktree the `tasks` command would change the real tree. Read task state only (`tasks show|list|mine`).' })
          }
        }
        shellText = text
        if (isReviewer && !isReviewerCommand(text, await reviewerChecks($, at, cfg, loop))) {
          found.push({ rule: 'reviewer-read-only', reason: 'The reviewer is read-only: it reads files (the diff it was given, cat, grep, git diff, git log) and runs the repository\'s own checks exactly as written, one line at a time, nothing else.' })
        }
        const isExempt = isOptedIn && isCommandExempt(loop, text)
        if (isExempt) {
          // The person allowed this exact command: every rule but those that always hold steps aside.
          if (found.some(one => !isAlwaysHeld(one.rule) && !NEVER_LIFTED.includes(one.rule))) {
            lifted = `command: ${text}`
          }
          found = found.filter(one => isAlwaysHeld(one.rule) || NEVER_LIFTED.includes(one.rule))
        }
        refusals.push(...found)
        if (refusals.length === 0 && isOptedIn && !isReviewer && !isEval && !isExempt) {
          const verdict = await judgeShipping($, at, text)
          if (verdict !== null) {
            refusals.push(verdict)
          }
        }
      }

      if (clash !== null && isOptedIn) {
        refusals.push(clash)
      }
      live.calls += 1
      if (isOptedIn && live.calls % 10 === 0) {
        await checkBudget($, at, cfg)
      }
      if (isOptedIn && tool !== 'Read' && !isSearch && (await loopOf($)).isOverBudget) {
        refusals.push({ rule: 'budget', reason: 'The session reached its cost cap. Stop and tell the person; they can raise it with /devloop budget <usd>.' })
      }

      // An ablation switches one rule off for the eval's agents only (never one that always holds).
      const ablation = isEval && loop.evalRun?.current?.pass === 'without' ? loop.evalRun.without : null
      const standing = ablation === null || ablation.kind !== 'rule' ? refusals : refusals.filter(one => isAlwaysHeld(one.rule) || (one.rule !== ablation.target && one.id !== ablation.target))
      const verdict = strictest(standing, cfg)
      await noteCall($, e as never, verdict === null ? null : verdict.id ?? verdict.rule).catch(() => undefined)
      // Observe mode records and lets pass; the rules that always hold refuse in every mode.
      const isHeld = verdict !== null && isHeldBy(verdict.rule, cfg)
      if (!isHeld && isOptedIn && !isReviewer && !isEval && lifted !== null && !loop.exemptionsUsed.includes(lifted)) {
        // What an exemption lifted a rule for, so the gate can say an edit was a person's: the concrete path, or `command: <text>` (never read as a path).
        const used = lifted
        await save($, at.root, before => ({ ...before, exemptionsUsed: before.exemptionsUsed.includes(used) ? before.exemptionsUsed : [...before.exemptionsUsed, used] })).catch(() => undefined)
      }
      if (!isHeld && isOptedIn && loop.refusals.count > 0) {
        // An allowed call breaks a run of refusals.
        await save($, at.root, before => ({ ...before, refusals: { rule: '', count: 0 } })).catch(() => undefined)
      }
      if (verdict !== null) {
        // Who can lift it, in one short clause.
        let reason = `${verdict.reason} ${liftClause(verdict.rule)}`
        if (isHeld && isOptedIn) {
          // Two refusals of the same rule in a row: the person hears of it, and
          // the builder is told to stop rather than hunt for a way round.
          const count = loop.refusals.rule === verdict.rule ? loop.refusals.count + 1 : 1
          if (count >= 2) {
            reason += ' This is the second refusal under the same rule in a row: stop here and tell the person what you were trying to do and why. Do not look for another way round it; if you cannot go on, call the devloop_blocked tool.'
          }
          if (count === 2) {
            $.ui.toast(`devloop: the agent was refused twice in a row (${verdict.rule}: ${subject.slice(0, 60)}) and was told to stop and report.`, { timeoutMs: 12_000 })
          }
          await save($, at.root, before => ({ ...before, refusals: { rule: verdict.rule, count } })).catch(() => undefined)
        }
        if (isOptedIn) {
          // Recording is best effort: it never changes the answer.
          await (async () => {
            const now = await $.clock.now()
            const rule = verdict.id ?? verdict.rule
            await save($, at.root, before => note(before, isHeld ? 'deny' : 'observe', `${rule}: ${subject}`, now))
            await record($, at.root, isHeld ? 'guard-deny' : 'guard-observe', rule, subject)
            await bump($, at.root, `rule:${rule}`)
            await hitRule($, at.root, rule)
            if (isHeld) {
              // Each refusal goes to the audit trail, with who was refused.
              await audit($, at.root, 'refusal', actorOfCall(e.agentId, isReviewer, isEval), rule, loop.tree, clip(subject, 80))
              if (e.agentId === undefined) {
                await meterCost($, at.root, { kind: 'error' })
              }
            }
          })().catch(() => undefined)
        }
        if (isHeld) {
          return { deny: `devloop: ${reason}` }
        }
      }

      // The module judged this call: the classic hook beneath stands down when it finds the stamp (D1).
      await stampCall($, e.tool_use_id).catch(() => undefined)
      const ran = await next(e)
      if (isOptedIn && !isReviewer && ran.deny === undefined && ran.isError !== true && contentHits.length > 0) {
        // A note rule's hit is recorded; a ratchet's baseline falls with a file's count.
        await (async () => {
          for (const one of contentHits.filter(isFired)) {
            // The rule, the path, the line number and a fingerprint: never the line itself (C2.1 F8).
            await record($, at.root, 'content-rule', one.rule.id, `${contentPath}:${one.lineNo} ${digest(one.line)}`)
            await hitRule($, at.root, one.rule.id)
          }
          // A trial rule's own count and hits, and the person's one notice at `promoteHits` (DESIGN 4.17).
          const trialHits = contentHits.filter(one => learnedIds.includes(one.rule.id) && one.verdict === 'note')
          await noteLearnedHits($, at.root, cfg, trialHits.map(one => ({ id: one.rule.id, path: contentPath, line: one.lineNo, fp: digest(one.line) })))
          const falls = contentHits.filter(one => one.rule.action === 'ratchet' && (one.after ?? 0) < (one.before ?? 0))
          if (falls.length > 0 && !isEval) {
            const kept = ((await $.store.get(`ratchet:${at.root}`)) as Record<string, Baseline> | undefined) ?? {}
            const now = await $.clock.now()
            for (const one of falls) {
              const base = kept[one.rule.id]
              if (base !== undefined) {
                kept[one.rule.id] = lowered(base, (one.after ?? 0) - (one.before ?? 0), now)
              }
            }
            await $.store.set(`ratchet:${at.root}`, kept)
          }
        })().catch(() => undefined)
      }
      let shippedNote: string | null = null
      // Whenever the text held a ship intent, error or not: the push may have happened all the same (C2.1 F12).
      if (isOptedIn && !isReviewer && !isEval && isShell && ran.deny === undefined && shipsOf(shellText).length > 0) {
        shippedNote = await checkShipped($, at, shellText, actorOfCall(e.agentId, false, false), ran.isError !== true, e.tool === 'Bash' && e.run_in_background === true).catch(() => null)
        // A pull request created or pushed to: the harness follows it up itself, through gh, with no turn spent waiting (D2).
        if (e.agentId === undefined && ran.isError !== true && shipsOf(shellText).some(one => one.kind === 'push' || one.kind === 'pr-create' || one.kind === 'pr-ready')) {
          await watchAfterShip($, at, cfg).catch(() => undefined)
        }
      }
      if (isOptedIn && !isReviewer && !isEval && ran.deny === undefined && ran.isError !== true) {
        if (EDITS.includes(tool) && path !== null && path !== '') {
          const edited = path
          // Allowed but flagged: text in an instruction file reaches every later session.
          const isInstruction = matchesAny(edited, instructionGlobs(cfg))
          const now = await $.clock.now()
          // An edit of task state keeps the verdict for now: whether it carries is decided on the tree, by git (D2).
          const keepsVerdict = tasks !== null && tasks.isOn && isTaskStatePath(edited)
          await save($, at.root, before => {
            const changed = [...new Set([...before.changed, edited])]
            const hasTouchedTests = before.hasTouchedTests || matchesAny(edited, cfg.tests)
            const review = !keepsVerdict && (before.review.status === 'pass' || before.review.status === 'fail') ? { ...before.review, status: 'none' as const } : before.review
            const after = {
              ...before, changed, hasTouchedTests, tier: tierFor({ ...before, changed }, cfg), isDirty: true, review,
              newTests: newTest === null || before.newTests.includes(newTest) ? before.newTests : [...before.newTests, newTest],
              agentWritten: before.agentWritten.includes(edited) ? before.agentWritten : [...before.agentWritten, edited],
              tally: { ...before.tally, startedAt: before.tally.startedAt ?? now },
              assertionDrops: assertionDrop === null || before.assertionDrops.includes(assertionDrop) ? before.assertionDrops : [...before.assertionDrops, assertionDrop],
            }

            return isInstruction ? note(after, 'info', `instruction file edited: ${edited} (high risk; a person must read it)`, now) : after
          })
        } else if (isShell) {
          if (isTreeWrite) {
            // The tree has moved: no pass covers it until the gate runs again.
            const now = await $.clock.now()
            const wrote = writtenPaths(shellText, where).map(one => one.rel).filter((rel): rel is string => rel !== null && rel !== '' && !/[*?[]/.test(rel)).slice(0, 50)
            await save($, at.root, before => ({
              ...before, isDirty: true, tally: { ...before.tally, startedAt: before.tally.startedAt ?? now },
              agentWritten: [...new Set([...before.agentWritten, ...wrote])],
            }))
          }
          if (e.tool === 'Bash' && /\bgit\s+revert\b/.test(e.command)) {
            await bump($, at.root, 'reverts')
          }
        }
      }

      const observed = countLook(e as never, await observe($, e as never, ran))

      return shippedNote === null || observed.deny !== undefined ? observed : { ...observed, context: [...(observed.context ?? []), shippedNote] } as typeof observed
    } finally {
      leaveFlight(token)
    }
  }).catch(async ($, e, next) => {
    // A guard that cannot judge refuses only where the repository asked for
    // enforcement; in observe mode, or without devloop.json, it stands aside.
    // Secrets hold in every mode, so a pure check on the call's own text
    // still refuses them.
    if (next.called) {
      return next(e)
    }
    // The secret check runs the same shell model that may have thrown in the hook (E1): a check that throws cannot judge, so the mode decides.
    let isSecretNamed = false
    try {
      isSecretNamed = namesDefaultSecret(String(e.tool), e as unknown as Record<string, unknown>)
    } catch {
      isSecretNamed = false
    }
    if (isSecretNamed) {
      return { deny: 'devloop: this names a file that holds secrets; it is never read or written from here.' }
    }
    // A mode that cannot be read is no reason to let the call through (principle 11): only off (dormant) and observe let it pass.
    const mode = await (async () => modeOf($))().catch(() => 'enforce' as const)

    return mode !== 'enforce' ? next(e) : { deny: 'devloop: a guard failed to run, so the call was refused (enforce mode). /devloop doctor may say why.' }
  })

  // The one way a feature is recorded as passing: the harness runs the check itself.
  // The engine's permission check, answered for the harness's own reviewers only (I1): a reviewer or checklist
  // reviewer of the round in progress may read that round's diff file, read and search inside the repository, and
  // run the repository's checks and the read-only commands its guard allows, with no prompt. Beside those, a Read, Grep
  // or Glob inside the spec library is answered for any agent, the builder's included (DESIGN 4.18). Everything else is
  // the engine's (its ask stands), and no other call of a builder or an eval agent is answered here. A failing guard answers deny.
  on('tool.check', async ($, e, next) => {
    // A read inside the spec library (DESIGN 4.18) is answered for every agent, the main loop's included.
    const isFileRead = e.tool === 'Read' || e.tool === 'Grep' || e.tool === 'Glob'
    if (e.agentId === undefined && !isFileRead) {
      return next(e)
    }
    const at = await look($)
    if (!at.isOptedIn) {
      return next(e)
    }
    const loop = await loopOf($)
    const isOwn = e.agentId !== undefined && (isReviewerAgent(loop, e.agentId) || (await isChecklistAgent($, at.root, e.agentId)))
    const isReviewing = isOwn && loop.review.status === 'running'
    if (!isReviewing && !isFileRead) {
      return next(e)
    }
    const below = await next(e)
    // Only the engine's own default ask is answered (R5): an ask a settings rule, a hook, a setting or another plugin raised stands.
    if (below.decision !== 'ask' || below.rule !== undefined || below.hook !== undefined || below.setting !== undefined || below.plugin !== undefined) {
      return below
    }
    // The answer, from where the call's places really land. Where it fails, a reviewer's call is refused (below),
    // and any other read keeps the engine's own ask.
    const answer = async (): Promise<typeof below> => {
      const cfg = (await policyInForce($, at))?.cfg ?? null
      if (cfg === null) {
        return below
      }
      const cwd = await $.session.cwd().catch(() => at.root)
      const home = (await $.env.get('HOME').catch(() => undefined)) ?? null
      const tmp = (await $.env.get('TMPDIR').catch(() => undefined)) || null
      const where = whereOf(at.root, cwd, { home, tmp, env: await envFor($) })
      const library = await librarySpellings($).catch(() => [] as string[])
      const input = (typeof e.input === 'object' && e.input !== null ? e.input : {}) as Record<string, unknown>
      // Every path the call names, resolved as the call guard resolves it (R6, R10): an answer rests on where it really lands.
      const resolved = new Map<string, Placed[] | null>()
      const keyOf = (one: Placed): string => `${one.abs ?? ''}\u0000${one.raw ?? ''}`
      for (const one of reviewerPlaces(e.tool, input, where).slice(0, 40)) {
        if (one.abs !== null && !resolved.has(keyOf(one))) {
          resolved.set(keyOf(one), await resolvedOf($, one, where))
        }
      }
      const resolve = (path: Placed): readonly Placed[] | null => (path.abs === null ? null : resolved.get(keyOf(path)) ?? null)
      if (isFileRead && libraryMayRead(e.tool, input, { where, cfg, library, resolve })) {
        return { decision: 'allow' as const, reason: 'devloop: a read inside the spec library (the harness writes it; every agent may read it)' }
      }
      if (!isReviewing) {
        return below
      }
      const diffFile = loop.review.round > 0 ? `${await stateDirOf($, at.root)}/review-${loop.review.round}.diff` : null
      const isAllowed = reviewerMayRun(e.tool, input, { where, cfg, diffFile, checks: await reviewerChecks($, at, cfg, loop), resolve, library })

      return isAllowed ? { decision: 'allow' as const, reason: 'devloop: a read-only call of the harness\'s own reviewer (its diff, the repository, the spec library, the checks as written)' } : below
    }

    return isReviewing ? answer() : answer().catch(() => below)
  }).catch(() => ({ decision: 'deny' as const, reason: 'devloop: the reviewer\'s permission check failed, so the call is refused' }))

  on('tool.run', { tool: FEATURE_CHECK }, async ($, e) => {
    const at = await locate($)
    // The policy in force decides how the check runs: its timeout and its checkEnv scrub.
    const cfg = (await policyInForce($, at))?.cfg ?? null
    const loop = await loopOf($)
    if (cfg === null) {
      return { result: 'This repository has not opted in to devloop (no devloop.json), so there are no features to check. A person can set it up by typing /devloop.' }
    }
    if (loop.spec === null || loop.phase !== 'build') {
      return { result: 'No approved spec is active, so there is no feature to check. A person starts one with /devloop spec <name> and approves it with /devloop approve.' }
    }
    const id = String(e.id)
    if (!(id in loop.features)) {
      return { result: `No feature "${id}" in the approved spec (specs/${loop.spec}/features.json as approved).` }
    }
    // Another seat's live claim (D2; a seat's, final round F4): the feature is theirs while their lease runs, and this seat is recorded
    // as waiting for it. An unclaimed or lapsed one is claimed here, silently; this seat's own is continued.
    const claimed = await claimFeature($, at, cfg, loop, id, { kind: 'builder', name: null })
    if (claimed?.kind === 'refused') {
      return { result: `Not run: ${heldText(id, claimed.by, await $.clock.now())}` }
    }
    // A feature is checked only on top of its dependencies, each passing on the tree as it stands.
    const snap = await snapshot($, at, cfg)
    const missing = missingDeps({ ...loop, tree: snap.tree }, id)
    if (missing.length > 0) {
      return { result: `Not run: "${id}" depends on ${missing.join(', ')}, which ${missing.length === 1 ? 'does' : 'do'} not pass on the tree as it stands. Build and record ${missing.length === 1 ? 'it' : 'them'} first with feature_check (the devloop_status tool lists the features that are ready).` }
    }
    const done = await runFeatures($, at, cfg, [id])
    if (done === null) {
      return { result: 'The spec or its feature list changed after it was approved, so no result is recorded. A person must reopen it (/devloop spec) and approve it again.' }
    }
    const refused = done.refused[0]
    if (refused !== undefined) {
      return { result: `NOT RUN ${id}: its check \`${refused.check}\` is refused by the command rules (${refused.refusal.rule}: ${refused.refusal.reason}) Nothing about the feature was learned. The check is the approved spec's: a person reopens it (/devloop spec) to change it; if you cannot go on, call the devloop_blocked tool.` }
    }
    const one = done.runs[0]
    if (one === undefined) {
      return { result: `No feature "${id}" in specs/${loop.spec}/features.json.` }
    }
    const { passing, total } = featureCounts(done.loop)
    await meterCost($, at.root, { kind: 'feature', id })
    const now = await $.clock.now()
    await save($, at.root, before => note(before, 'spec', `${id}: ${one.ran.isPassing ? 'passes' : 'fails'} (${passing}/${total})`, now))
    const check = (await readFeatures($, at, done.loop)).find(feature => feature.id === id)?.check ?? ''

    return {
      result: one.ran.isPassing
        ? `PASS ${id}. ${passing} of ${total} features pass. Commit before the next feature.`
        : one.ran.outcome !== 'fail'
          ? `COULD NOT RUN ${id}: ${infraAdvice(check, one.ran.outcome, cfg.verifyTimeoutSec)} Nothing about the feature was learned; if you cannot fix this, call the devloop_blocked tool.`
          : `FAIL ${id}: \`${check}\` exited ${one.ran.code}.\n${one.ran.output}`,
    }
  }).catch(() => ({ result: 'devloop: feature_check could not run.' }))

  // The gate as the harness sees it, for the builder. It reads and never
  // writes: the snapshot is folded in here, not saved.
  on('tool.run', { tool: STATUS }, async ($, e) => {
    const at = await locate($)
    const inForce = await policyInForce($, at)
    if (inForce === null) {
      return { result: 'This repository has not opted in to devloop (no devloop.json), so there is no gate. A person can set it up by typing /devloop.' }
    }
    // The evidence is proven here too, and nothing is written.
    const { loop, snap } = await refresh($, at, inForce.cfg, false)
    const policy = (await policyInForce($, at, snap)) ?? inForce
    const questions = openQuestions(await questionsOf($, at.root))
    // The meters only on request: they are never put into context by default.
    const detail = e.detail === true ? ['', ...cacheReport(await cacheOf($, at.root)), ...attributionReport(live.attribution)] : []

    // The other sessions' claims, only when another session holds one (D2): a single session sees nothing of them.
    const { claims, session, now } = await buildClaims($, at, loop)

    return {
      result: [
        ...statusReport(loop, policy.cfg, at, snap, factsOf(at, policy), readyFor(loop, claims, session, now)),
        ...claimLines(loop, claims, session, now),
        ...findingsForBuilder(loop),
        ...(questions.length > 0 ? [`Open questions for a person: ${questions.map(one => `${one.id} ${one.question.slice(0, 100)}`).join('; ')}`] : []),
        ...detail,
      ].join('\n'),
    }
  }).catch(() => ({ result: 'devloop: the status could not be read.' }))

  // The agent declares the change ready (rule 13): a round starts on the tree
  // as it stands, under the rules every automatic round shares, and runs and
  // waits on no tests. A reviewer never starts one.
  on('tool.run', { tool: REVIEW }, async ($, e) => {
    const at = await locate($)
    const found = at.isOptedIn ? await snapshotInForce($, at) : null
    if (found === null) {
      return { result: 'This repository has not opted in to devloop (no devloop.json), so there is no review.' }
    }
    if (isReviewerAgent(await loopOf($), e.agentId)) {
      return { result: 'A reviewer cannot start a review round.' }
    }
    // Only the main agent declares its change ready (rule 13): a subagent, an eval's included, cannot start a round.
    if (e.agentId !== undefined) {
      return { result: 'Only the main agent asks for a review, once the whole change is done.' }
    }
    // The tree as it stands, as /devloop review takes it: an edit since the last stop is in the round.
    const { snap, policy } = found
    const cfg = policy.cfg
    const loop = await save($, at.root, before => withSnapshot(before, snap, cfg))
    const refused = reviewRefusal(loop, cfg, await isReviewedHere($, at, cfg, loop))
    if (refused !== null) {
      return { result: refused }
    }
    // The loop limit refuses it with the limit's own message; a reviewer that cannot start says so.
    const started = await startReview($, at, true)

    return { result: (await loopOf($)).review.status === 'running' ? `${started} Do not edit files until its verdict arrives: a verdict on a tree that has changed is discarded.` : started }
  }).catch(($, _e, next) => {
    $.ui.log(`devloop: devloop_review failed: ${String(next.error)}`, { to: 'debug' })

    return { result: 'devloop: the review round could not be started.' }
  })

  // A clean way to stop: the builder says what blocks it, the person hears it,
  // and the stop gate lets the turn end.
  // The agent may tighten the policy, never loosen it: it adds a verify check, and only a person removes one.
  on('tool.run', { tool: ADD_CHECK }, async ($, e) => {
    const at = await locate($)
    const run = String(e.run ?? '').trim()
    if (!at.isOptedIn || at.text === null) {
      return { result: 'This repository has no devloop.json in its working tree, so nothing was added.' }
    }
    if (e.agentId !== undefined) {
      return { result: 'Only the main agent adds checks.' }
    }
    if (run === '' || run.length > 300 || run.includes('\n')) {
      return { result: 'Not added: give one command on one line, under 300 characters.' }
    }
    const policy = await policyInForce($, at)
    if (policy === null) {
      return { result: 'Not added: devloop.json could not be read.' }
    }
    const refused = await judgeFeatureCheck($, at, policy.cfg, await loopOf($), run)
    if (refused !== null) {
      return { result: `Not added: the guards refuse this command (${refused.rule}): ${refused.reason}` }
    }
    // Read fresh: a check added a moment ago must count (the place's copy may be cached).
    const raw = JSON.parse(await $.fs.read(`${at.root}/devloop.json`)) as { verify?: unknown[] }
    const verify = Array.isArray(raw.verify) ? raw.verify : []
    if (verify.some(one => (typeof one === 'string' ? one : (one as { run?: string }).run) === run)) {
      return { result: `\`${run}\` is already a check.` }
    }
    raw.verify = [...verify, e.background === true ? { run, background: true } : run]
    await $.fs.write(`${at.root}/devloop.json`, `${JSON.stringify(raw, null, 2)}\n`)
    await audit($, at.root, 'settings-changed', { kind: 'agent', name: 'builder' }, 'verify', null, `added ${run}${e.background === true ? ' (background)' : ''}`)
    const effect = effectLine(policy.cfg.defaultBranch, policy.source === 'base', true)
    $.ui.toast(`devloop: the agent added a test check: ${run}${e.background === true ? ' (background)' : ''}. ${effect}`, { timeoutMs: 15_000 })

    return { result: `Added \`${run}\`${e.background === true ? ' as a background check' : ''}. ${effect}` }
  }).catch(() => ({ result: 'devloop: the check could not be added.' }))

  on('tool.run', { tool: BLOCKED }, async ($, e) => {
    const at = await locate($)
    const reason = String(e.reason ?? '').trim().slice(0, 500) || '(no reason given)'
    if (!at.isOptedIn) {
      return { result: 'This repository has not opted in to devloop (no devloop.json), so nothing was recorded. Stop and tell the person what blocks you.' }
    }
    {
      const now = await $.clock.now()
      await save($, at.root, before => note({ ...before, blocked: { reason, at: now } }, 'info', `the builder is blocked: ${reason.slice(0, 120)}`, now))
      await record($, at.root, 'blocked', reason.toLowerCase().slice(0, 60), reason)
    }
    $.ui.toast(`devloop: the agent says it is blocked: ${reason.slice(0, 160)}`, { timeoutMs: 15_000 })

    return { result: 'Recorded, and the person has been told. Stop now: end your turn with a short report of what blocks you and what you tried. Do not work around it.' }
  }).catch(() => ({ result: 'devloop: the report could not be recorded. Stop now and tell the person what blocks you.' }))

  // Claims (D2): a session takes a feature of the active spec, or gives it up.
  on('tool.run', { tool: CLAIM }, async ($, e) => {
    const at = await locate($)
    const cfg = (await policyInForce($, at))?.cfg ?? null
    const loop = await loopOf($)
    if (cfg === null) {
      return { result: 'This repository has not opted in to devloop (no devloop.json), so there is nothing to claim.' }
    }
    const id = String(e.feature ?? '')
    if (loop.spec === null || loop.phase !== 'build' || !(id in loop.features)) {
      return { result: loop.phase !== 'build' ? 'No approved spec is being built, so there is no feature to claim.' : `No feature "${id}" in the approved spec.` }
    }
    const taken = await claimFeature($, at, cfg, loop, id, { kind: 'builder', name: null })
    const now = await $.clock.now()
    if (taken === null || taken.kind === 'refused') {
      return { result: taken === null ? 'Nothing was claimed.' : `Not claimed: ${heldText(id, taken.by, now)}` }
    }

    return { result: `${taken.kind === 'takeover' ? `Taken over from ${taken.from.name}, whose lease had run out: ` : ''}"${id}" is yours for ${cfg.claims.leaseMinutes} minutes, renewed while you work. Call devloop_release if you leave it unfinished.` }
  }).catch(() => ({ result: 'devloop: the claim could not be recorded.' }))

  on('tool.run', { tool: RELEASE }, async ($, e) => {
    const at = await locate($)
    const loop = await loopOf($)
    if (!at.isOptedIn || loop.spec === null) {
      return { result: 'No approved spec is being built here, so there is no claim to give up.' }
    }
    const id = String(e.feature ?? '')
    const one = await releaseClaim($, at, loop.spec, id, { kind: 'builder', name: null }, seatOfPlace(at))

    return { result: one === null ? `You hold no claim on "${id}".` : `Released "${id}": another session may take it.` }
  }).catch(() => ({ result: 'devloop: the claim could not be released.' }))

  // The spec library (DESIGN 4.18): a search of the person's earlier specs. It reads and never writes.
  on('tool.run', { tool: LIBRARY }, async ($, e) => {
    const at = await locate($)
    if (!at.isOptedIn) {
      return { result: 'This repository has not opted in to devloop (no devloop.json), so the spec library is not searched from here.' }
    }

    return { result: await searchCommand($, String(e.query ?? ''), e.limit) }
  }).catch(() => ({ result: 'devloop: the spec library could not be searched. Read the earlier specs under specs/ instead.' }))

  // ------------------------------------------------------------ the stop gate

  on('classic.Stop', async ($, e, next) => {
    // The module judges this stop: the classic Stop hook beneath stands down when it finds the stamp (D1).
    await stampStop($, e as unknown as Record<string, unknown>).catch(() => undefined)
    const below = await next(e)
    if (e.agent_id !== undefined || below.block !== undefined) {
      return below
    }
    const at = await locate($)
    // Every decision of the stop gate is the policy in force's: the base branch's, whole.
    const first = await policyInForce($, at)
    if (first === null) {
      return below
    }
    let loop = await loopOf($)
    // The turn is ending: exemptions bound to it end too, and so does a run of refusals.
    const current = turnId
    if (loop.allow.length > 0 || loop.refusals.count > 0) {
      loop = await save($, at.root, before => ({
        ...before,
        // Kept: only what the person granted while this turn ran, which belongs to the next one.
        allow: before.allow.filter(one => current !== null && one.turnId === null),
        refusals: { rule: '', count: 0 },
      }))
    }
    // The keep-warm guarantee (DESIGN 4.14): a turn no person's prompt started (a keep-warm ping, a scheduled or
    // background wake) that leaves the tree as the last stop saw it gets nothing from devloop: no verification run,
    // no fix round, no context, no toast. A stop that follows a block of this gate is the same turn going on, not one.
    const isPersonTurn = live.isPersonTurn
    live.isPersonTurn = false
    const snap = await snapshot($, at, first.cfg)
    const lastStopTree = live.lastStopTree
    const lastStopTurn = live.lastStopTurn
    live.lastStopTree = snap.tree
    live.lastStopTurn = current
    const isSameTurn = current === lastStopTurn
    if (!isPersonTurn && !isSameTurn && e.stop_hook_active !== true && snap.tree !== null && snap.tree === lastStopTree) {
      return below
    }
    // Grounding's backstop (DESIGN 4.15) runs before the ordinary stop gate and never replaces it: a refusal ends this stop
    // here, and the next stop is judged in full. Its catch lets the stop through: it is advice about an answer, not a guard
    // on what reaches a branch, so a failure of it never holds a stop (principle 11's one exception for unreadable input).
    const grounded = await groundingStop($, at, first.cfg, loop, snap.tree, current, typeof e.last_assistant_message === 'string' ? e.last_assistant_message : '').catch(() => null)
    if (grounded !== null) {
      return { ...below, block: grounded }
    }
    await checkBudget($, at, first.cfg)
    await abandonStale($, at.root)
    // A fix round (if one was open) ends at this stop: its cost is attributed (an estimate).
    await meterCost($, at.root, { kind: 'stop' })
    // The `.tasks` exit protocol (D2): claimed work is not left without a resume point. It blocks like a failing check (recorded only in observe), once per prompt.
    const exit = await sessionCheck($, at, first.cfg)
    if (exit !== null && loop.blocked === null) {
      await record($, at.root, 'tasks-session-check', 'session-check', exit)
      if (isHeldBy('tasks', first.cfg) && loop.verify.rounds < first.cfg.maxFixRounds && !live.tasksBlocked.has(current ?? 'idle')) {
        live.tasksBlocked.add(current ?? 'idle')

        return { ...below, block: `devloop: the .tasks session check fails, so the work is not left as it is: ${exit}\n\nWrite each claimed task's resume point (\`tasks state <task>\`), or pause it or hand it over (\`tasks pause|handoff <task> -m "…"\`), then stop.` }
      }
      $.ui.toast(`devloop: the .tasks session check fails: ${exit.slice(0, 160)}`, { timeoutMs: 12_000 })
    }
    const cfg = ((await policyInForce($, at, snap)) ?? first).cfg
    // The loop limit (DESIGN 4.16): at the limit the turn may end, once, with its message added; nothing more is handed back.
    const limited = async (result: typeof below): Promise<typeof below> => {
      await atTurnEnd($, at, cfg, snap.tree, isIdle)
      await notePassing($, at, snap).catch(() => undefined)
      const told = await reachLimit($, at, cfg, snap.branch)

      return told === null ? result : { ...result, additionalContext: [...(result.additionalContext ?? []), told] }
    }
    // The builder said it is blocked: it may stop, and the person was told.
    if (loop.blocked !== null || cfg.verify.length === 0) {
      const refreshed = await refresh($, at, cfg)
      // With no checks to run, a review loop that has begun still goes on (11a).
      if (loop.blocked === null) {
        await maybeReview($, at, cfg, refreshed.loop)
      }

      return limited(below)
    }
    const isCovered = snap.tree !== null ? snap.tree === loop.verify.tree : !loop.isDirty
    if (isCovered) {
      await save($, at.root, before => withSnapshot(before, snap, cfg))
      // A stop on the very tree the gate last blocked: the fix loop made no
      // progress, so it ends here and the person is told.
      if (loop.verify.status === 'fail' && snap.tree !== null && loop.verify.blockedTree === snap.tree && cfg.mode === 'enforce') {
        const now = await $.clock.now()
        await save($, at.root, before => note({ ...before, verify: { ...before.verify, blockedTree: null } }, 'verify', 'stopped with nothing changed since the last blocked stop: fix loop ended', now))
        $.ui.toast(`devloop: the agent stopped again with nothing changed since the last blocked stop; verification still fails (${loop.verify.failed ?? ''}). This needs you.`, { timeoutMs: 12_000 })
      }
      // A tree verified before this stop (by the ship gate, say) whose checks passed or could not run: a fix to re-review still is (rule 14).
      if (loop.verify.status === 'pass' || loop.verify.infra !== null) {
        await maybeReview($, at, cfg, await loopOf($))
      }

      return limited(below)
    }
    // A stop waits briefly: past stopTimeoutSec the check is left alone (no block) and the person is told to run it in the background.
    const stopLimit = Math.min(cfg.verifyTimeoutSec, cfg.stopTimeoutSec)
    const { loop: after, ran, isRepeat } = await verifyNow($, at, cfg, 'fast', stopLimit)
    // A check that could not run at all is no failure of the work: no block, no fix round; the person is told what to do.
    if (ran.infra !== null && ran.failed !== null) {
      const advice = infraAdvice(ran.failed, ran.infra, stopLimit)
      $.ui.toast(`devloop: ${advice}`, { timeoutMs: 15_000 })
      // A round never waits on tests: a fix to re-review is, though they could not run (rule 14).
      await maybeReview($, at, cfg, after)
      await atTurnEnd($, at, cfg, snap.tree, isIdle)

      return { ...below, additionalContext: [...(below.additionalContext ?? []), `devloop: verification could not run, so the stop is not blocked and no fix round is spent. ${advice}`] }
    }
    let failure: { output: string; isRepeat: boolean; saved: string | null } | null = ran.isPassing ? null : { output: ran.output, isRepeat, saved: ran.saved }
    if (failure === null && after.phase === 'build') {
      // Every feature is recorded passing: prove it on this tree before a review starts.
      const counts = featureCounts(after)
      if (counts.total > 0 && counts.passing === counts.total && counts.onTree < counts.total) {
        const rerun = await runFeatures($, at, cfg, null)
        const failed = rerun?.runs.filter(one => !one.ran.isPassing && one.ran.outcome === 'fail') ?? []
        for (const one of rerun?.refused ?? []) {
          $.ui.toast(`devloop: feature ${one.id}: its check is refused by the command rules (${one.refusal.rule}), so it was not run and its pass does not cover this tree.`, { timeoutMs: 15_000 })
        }
        for (const one of rerun?.runs.filter(each => !each.ran.isPassing && each.ran.outcome !== 'fail') ?? []) {
          const check = (await readFeatures($, at, after)).find(feature => feature.id === one.id)?.check ?? one.id
          $.ui.toast(`devloop: feature ${one.id}: ${infraAdvice(check, one.ran.outcome, cfg.verifyTimeoutSec)}`, { timeoutMs: 15_000 })
        }
        if (rerun === null) {
          $.ui.toast('devloop: the approved spec changed on disk, so no feature counts as passing. Reopen it with /devloop spec and approve it again.')
        } else if (failed.length > 0) {
          failure = { output: failed.map(one => `feature ${one.id} no longer passes on this tree:\n${one.ran.output}`).join('\n\n'), isRepeat: false, saved: null }
        }
      }
    }
    if (failure === null) {
      await maybeReview($, at, cfg, await loopOf($))

      return limited(below)
    }
    // While a spec is written its tests are expected to fail: the result is recorded, nothing is blocked.
    if (after.phase === 'spec') {
      await atTurnEnd($, at, cfg, snap.tree, isIdle)

      return below
    }
    // The same check failed twice in a row the same way: the harness writes the lesson itself (DESIGN 4.17, decision 1).
    if (failure.isRepeat && ran.failed !== null && cfg.learning.auto !== 'off') {
      const lesson = repeatLesson(ran.failed, ran.fingerprint, ran.output)
      await recordLesson($, at.root, lesson.key, lesson.detail).catch(() => 0)
    }
    // The round a stop hands back for a failed check is one failed round on the branch (DESIGN 4.16, decision 1).
    const failedRound = { kind: 'fix' as const, what: ran.failed ?? 'a feature check', files: [] }
    if (cfg.mode === 'observe') {
      $.ui.toast(`devloop (observe): verification is failing: ${ran.failed ?? 'a feature check'}`)
      // Observe mode refuses nothing: the round it would have handed back is counted, and at the limit the toast and the record only.
      await countFailedRound($, at.root, snap.branch, failedRound)

      return limited(below)
    }
    if (after.verify.rounds >= cfg.maxFixRounds) {
      $.ui.toast(`devloop: still failing after ${cfg.maxFixRounds} fix rounds. This one needs you.`, { timeoutMs: 12_000 })

      return limited(below)
    }
    // At the loop limit the stop gate hands nothing more back (decision 2).
    if (isAtLimit(await limitNow($, snap.branch), cfg)) {
      return limited(below)
    }
    await countFailedRound($, at.root, snap.branch, failedRound)
    const round = after.verify.rounds + 1
    await save($, at.root, before => ({ ...before, verify: { ...before.verify, rounds: round, blockedTree: snap.tree }, tally: { ...before.tally, fixRounds: before.tally.fixRounds + 1 } }))
    await meterCost($, at.root, { kind: 'error' })
    await meterCost($, at.root, { kind: 'fix-round', round: after.tally.fixRounds + 1 })

    return {
      ...below,
      block: [
        `devloop: verification failed, so the work is not done (fix round ${round} of ${cfg.maxFixRounds}).`,
        failure.output,
        failure.saved !== null ? `The whole output is in ${failure.saved}.` : '',
        failure.isRepeat
          ? 'This is the same failure as the last round: the last fix did not change it. Take a different approach, or call the devloop_blocked tool with what you tried and why it did not work, and stop.'
          : fixAdvice(after.phase),
      ].filter(part => part !== '').join('\n\n'),
    }
  }).catch(async ($, e, next) => {
    // A broken harness never blocks a stop (that could trap the session), but
    // it never passes for verified either: the gate stays shut and a person is told.
    await markError($, 'the stop gate failed partway').catch(() => undefined)

    return next(e)
  })

  // An agent the plugin started has answered: a reviewer's verdict, or an
  // eval task's end. The main loop's turn ending ends its exemptions.
  on('turn.complete', async ($, e, next) => {
    if (e.agentId !== undefined) {
      const at = await locate($)
      const loop = await loopOf($)
      const cfg = (await policyInForce($, at))?.cfg ?? null
      // A shadow reviewer may answer after its round settled: finishReview counts it (B2.1 F11).
      if (cfg !== null && isReviewerAgent(loop, e.agentId)) {
        await finishReview($, at, e.agentId, e.answer, e.isAborted)
      } else if (cfg !== null && loop.evalRun?.current?.agentId === e.agentId) {
        await finishEval($, at, cfg, e.isAborted)
      } else if (cfg !== null && isLearnerAgent(loop, e.agentId)) {
        // The proposer's answer is read into proposals and trial rules; none of its text goes back to the builder (DESIGN 4.17).
        await finishProposer($, at, cfg, e.agentId, e.answer, e.isAborted).catch(() => undefined)
      }
    } else {
      const ended = e.turnId
      turnId = null
      live.questionsIn.delete(ended)
      live.papercutsIn.delete(ended)
      const loop = await loopOf($)
      if (loop.root !== null && (loop.allow.some(one => one.turnId === ended) || loop.refusals.count > 0)) {
        await save($, loop.root, before => ({ ...before, allow: before.allow.filter(one => one.turnId !== ended), refusals: { rule: '', count: 0 } }))
      }
      await meter($, e).catch(() => undefined)
      // The end of the turn (DESIGN 4.17, decision 2): a repeat that reached `learning.repeats` starts the proposer, never mid-turn.
      const isPerson = live.isLearnTurn
      live.isLearnTurn = false
      await afterTurn($, isPerson).catch(() => undefined)
    }

    return next(e)
  })

  // A handoff for a fresh session: the builder's narrative, the harness's facts.
  on('tool.run', { tool: HANDOFF }, async ($, e) => {
    const at = await locate($)
    const cfg = (await policyInForce($, at))?.cfg ?? null
    if (cfg === null) {
      return { result: 'This repository has not opted in to devloop (no devloop.json), so there is nowhere to keep a handoff. A person can set it up by typing /devloop.' }
    }
    const { input, problems } = readHandoff(e as unknown as Record<string, unknown>)
    if (input.objective === '' || input.nextStep === '') {
      return { result: `Not written: ${problems.join('; ')}.` }
    }
    // Kept in the harness's state, never the working tree: writing it moves no hash and no policy can point it elsewhere (F1, F5).
    await writeHandoff($, at, cfg, 'builder', input)

    return { result: `Recorded in the harness's state, with the facts from the harness.${problems.length > 0 ? ` Note: ${problems.join('; ')}.` : ''} Finish the step you are on; a fresh session's first prompt is briefed from it.` }
  }).catch(() => ({ result: 'devloop: the handoff could not be written. Tell the person what you would have written.' }))

  // An open question for a person: recorded, never blocking.
  on('tool.run', { tool: QUESTION }, async ($, e) => {
    const at = await locate($)
    if (!at.isOptedIn) {
      return { result: 'This repository has not opted in to devloop (no devloop.json), so there is no question ledger. Ask the person directly.' }
    }
    const question = String(e.question ?? '').trim().slice(0, 500)
    if (question === '') {
      return { result: 'Not recorded: the question is empty.' }
    }
    const key = turnId ?? 'idle'
    const count = live.questionsIn.get(key) ?? 0
    if (count >= QUESTIONS_PER_TURN) {
      return { result: `Not recorded: at most ${QUESTIONS_PER_TURN} questions per turn. Carry on with what does not depend on them, and say the rest in your report.` }
    }
    live.questionsIn.set(key, count + 1)
    const context = typeof e.context === 'string' && e.context.trim() !== '' ? e.context.trim().slice(0, 500) : null
    const now = await $.clock.now()
    const id = await addOpenQuestion($, at.root, question, context, now)

    return { result: `Recorded as ${id}. Only a person closes it (/devloop questions close ${id} <answer>). It does not block: carry on with what does not depend on it.` }
  }).catch(() => ({ result: 'devloop: the question could not be recorded. Say it in your report.' }))

  // A friction report: recorded, grouped, never blocking (skills note 1).
  on('tool.run', { tool: PAPERCUT }, async ($, e) => {
    const at = await locate($)
    if (!at.isOptedIn) {
      return { result: 'This repository has not opted in to devloop (no devloop.json), so there is nowhere to file it. Mention it in your report and carry on.' }
    }
    const field = (key: string): string => (typeof (e as unknown as Record<string, unknown>)[key] === 'string' ? String((e as unknown as Record<string, unknown>)[key]).trim() : '')
    const happened = field('happened')
    if (happened === '') {
      return { result: 'Not filed: say what happened. Carry on with your work.' }
    }
    const key = turnId ?? 'idle'
    const count = live.papercutsIn.get(key) ?? 0
    if (count >= PAPERCUTS_PER_TURN) {
      return { result: `Not filed: at most ${PAPERCUTS_PER_TURN} papercuts per turn. Carry on; mention the rest in your report.` }
    }
    live.papercutsIn.set(key, count + 1)
    const now = await $.clock.now()
    const listKey = `papercuts:${at.root}`
    const list = await listOf<Papercut>($, listKey)
    const subject = field('subject') === '' ? null : clip(field('subject'), 120)
    const one: Papercut = {
      schema: 'papercut@1', id: `pc${list.length + 1}`, at: now, group: papercutGroup(subject, happened), subject,
      tried: clip(field('tried')), expected: clip(field('expected')), happened: clip(happened), suggestedFix: clip(field('suggestedFix')),
      actor: e.agentId === undefined ? { kind: 'builder', name: null } : { kind: 'agent', name: `subagent:${e.agentId.slice(0, 40)}` },
    }
    if (!(await keepRecord($, at.root, 'papercut@1', listKey, one, 500))) {
      return { result: 'The report could not be stored (the harness recorded why). Carry on.' }
    }
    await record($, at.root, 'papercut', one.group, happened)
    const group = papercutGroups([...list, one], await listOf<PapercutClose>($, `papercut-closes:${at.root}`)).find(each => each.group === one.group)
    if (group?.isRegression === true) {
      await record($, at.root, 'papercut-regression', one.group, happened)
      $.ui.toast(`devloop: papercut ${one.group} was filed again after a person closed it (a regression): ${clip(happened, 80)}`, { timeoutMs: 12_000 })
    }

    return { result: `Filed as ${one.id} in group ${one.group}${group !== undefined && group.count > 1 ? ` (filed ${group.count} times)` : ''}. Carry on with your work.` }
  }).catch(() => ({ result: 'devloop: the papercut could not be filed. Carry on.' }))

  // ------------------------------------------------------------ the pane

  // The pane (DESIGN 4.10): tabs drawn from state. Drawing writes nothing;
  // the tab shown is state, written from a tab button's handler.
  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Button, Progress, Text } = $.ui.resolve(e)
    const loop = await loopOf($)
    const at = await look($)
    const { root, errors } = at
    // The policy in force as last found: a render runs nothing and writes nothing.
    const policy = heldPolicy(at)
    if (policy === null) {
      return (
        <Box flexDirection="column">
          <Text>This repository is not set up for the loop.</Text>
          <Text color="subtle">Type /devloop to set it up.</Text>
        </Box>
      )
    }
    const tab = await tabOf($)
    const cfg = policy.cfg
    const facts = factsOf(at, policy)
    const checks = gate(loop, cfg, facts)
    const tier = tierFor(loop, cfg)
    const { passing, total } = featureCounts(loop)
    const act = (text: string) => () => $.command.run({ command: 'devloop', args: text }).then(() => undefined)
    const show = (next: PaneTab) => () => setTab($, next)
    const tabs: [PaneTab, string][] = [['gate', 'Gate'], ['features', 'Features'], ['findings', 'Findings'], ['activity', 'Activity'], ['metrics', 'Metrics']]
    let body: RenderChildren[]
    if (tab === 'features') {
      // The claims as last kept (D2): a render reads, never writes; a lapse is marked by the next hook that reads them.
      const claims = loop.spec === null ? {} : ((await $.store.get(`claims:${heldMainRoot(root)}`).catch(() => undefined)) as Claims | undefined) ?? {}
      // The holder is the seat, this checkout's root (final round, D2 F4).
      const seat = root
      const now = await $.clock.now().catch(() => 0)
      const ready = readyFor(loop, claims, seat, now)
      const theirs = Object.values(claims).filter(one => one.spec === loop.spec && now < one.until && seatOf(one) !== seat)
      const regressions = Object.entries(loop.regressions)
      body = [
        loop.phase !== 'build' ? <Text color="subtle">No approved spec: features are built against one (/devloop spec, then /devloop approve).</Text> : <Progress label="Features" value={passing} max={Math.max(1, total)} valueText={`${passing}/${total}`} />,
        ...Object.entries(loop.features).map(([id, one]) => (
          <Text color={one.passes && one.tree === loop.tree ? 'success' : 'warning'} wrap="truncate-end">
            {one.passes && one.tree === loop.tree ? '[x]' : '[ ]'} {id}{one.passes && one.tree !== loop.tree ? ' (passed on an earlier tree)' : theirs.some(each => each.feature === id) ? ` (claimed by ${theirs.find(each => each.feature === id)?.name ?? 'another session'})` : ready.includes(id) && !one.passes ? ' (ready)' : ''}
          </Text>
        )),
        regressions.length > 0 && <Text color="subtle">Regression checks: {regressions.filter(([, one]) => one.passes === true && one.tree === loop.tree).length}/{regressions.length} pass on this tree</Text>,
      ]
    } else if (tab === 'findings') {
      const open = loop.findings.filter(one => one.status === 'open')
      body = [
        <Text bold>{open.length === 0 ? 'No open findings' : `${open.length} open finding${open.length === 1 ? '' : 's'}`}</Text>,
        ...open.slice(0, 12).map(one => (
          <Text color={one.isBlocking ? 'error' : undefined} wrap="truncate-end">
            {one.id} {one.severity} {one.file === '' ? '' : `${one.file}:${one.line} `}{one.problem}{one.route === 'decision' ? ' [yours to decide]' : ''}
          </Text>
        )),
        loop.findings.some(one => one.status === 'resolved') && <Text color="subtle">Resolved by a person: {loop.findings.filter(one => one.status === 'resolved').map(one => one.id).join(', ')}</Text>,
        loop.review.summary !== null && <Text color="subtle" wrap="truncate-end">{loop.review.summary}</Text>,
      ]
    } else if (tab === 'activity') {
      const recent = (await auditOf($, root).catch(() => [] as AuditEvent[])).slice(-5)
      // The failed rounds on this branch (DESIGN 4.16): what the loop limit counted, as last kept.
      const failedRounds = limitLines(loop.limit ?? NO_LIMIT, cfg)
      body = [
        loop.events.length === 0 && <Text color="subtle">Nothing yet.</Text>,
        ...loop.events.slice(-8).map(event => <Text color="subtle" wrap="truncate-end">{event.kind}: {event.text}</Text>),
        failedRounds.length > 0 && <Text bold>Failed rounds</Text>,
        ...failedRounds.map(line => <Text color="subtle" wrap="truncate-end">{line}</Text>),
        recent.length > 0 && <Text bold>Audit trail</Text>,
        ...recent.map(one => <Text color="subtle" wrap="truncate-end">{auditLine(one)}</Text>),
      ]
    } else if (tab === 'metrics') {
      const computed = computeMetrics({
        counters: await metrics($, root), changes: await listOf<ChangeRecord>($, `changes:${root}`), defects: await listOf<Defect>($, `defects:${root}`), evals: await historyOf($, root), cacheHitRate: hitRate((await cacheOf($, root)).session),
        grounding: await groundingSessionOf($, root),
      })
      body = metricsLines(computed, null).map(line => <Text wrap="truncate-end">{line.trim()}</Text>)
    } else {
      body = [
        tier !== 'none' && <Text bold>{isShippable(loop, cfg, facts) ? 'Gate: green' : 'Gate: not green'}</Text>,
        tier === 'none' && <Text color="subtle">{loop.isOutsideGit === true ? NOT_GIT_STATUS : 'No changes yet: nothing to gate.'}</Text>,
        ...(tier === 'none' ? [] : checks.map(check => (
          <Text color={check.isMet ? 'success' : 'warning'} wrap="truncate-end">
            {check.isMet ? '[x]' : '[ ]'} {check.label}: {check.note}
          </Text>
        ))),
        tier !== 'none' && <Text color="subtle">Merge: {approvers(tier, cfg)}</Text>,
        <Box>
          <Button key="verify" label="Verify" onPress={act('verify')} />
          <Button key="close" label="Close" onPress={() => closePane($)} />
          <Text> </Text>
          <Button key="review" label="Review" onPress={act('review')} />
          <Text> </Text>
          <Button key="status" label="Status" onPress={act('status')} />
        </Box>,
      ]
    }

    return (
      <Box flexDirection="column">
        <Text bold>{loop.phase === 'idle' ? 'Small-fix mode' : `${loop.phase === 'spec' ? 'Writing spec' : 'Building'}: ${loop.spec ?? ''}`}</Text>
        <Text color="subtle">
          {modeInForce(at) === 'observe' ? 'observe mode (guards record, do not refuse) · ' : ''}
          {tier === 'none' ? 'no changes yet' : `${loop.changed.length} files changed · ${tier} risk`}
        </Text>
        {errors.map(error => <Text color="error" wrap="truncate-end">devloop.json: {error}</Text>)}
        {loop.blocked !== null && <Text color="error" wrap="truncate-end">Blocked: {loop.blocked.reason}</Text>}
        {loop.evalRun !== null && <Text>Evals: {loop.evalRun.current === null ? 'between tasks' : `task ${loop.evalRun.current.id}, trial ${loop.evalRun.current.trial + 1}`}</Text>}
        <Box>
          {tabs.map(([id, label]) => <Button key={`tab-${id}`} label={tab === id ? `[${label}]` : label} onPress={show(id)}>{tab === id ? <Text bold color="suggestion">[{label}]</Text> : <Text>{label}</Text>}</Button>)}
        </Box>
        {body}
        <Text color="subtle" wrap="truncate-end">{root}</Text>
      </Box>
    )
  })

  // The status row above the prompt: where the loop stands, in color, in one
  // line. Drawing writes nothing; no row when there is nothing to show.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) {
      return next(e)
    }
    const loop = await loopOf($)
    const at = await look($)
    const policy = heldPolicy(at)
    // The time, so a background run says how long it has gone; a clock that cannot be read names no time.
    const now = await $.clock.now().catch(() => undefined)
    const parts = policy === null ? null : barParts(loop, policy.cfg, gate(loop, policy.cfg, factsOf(at, policy)), now)
    const activity = await activityOf($).then(one => activityText(one.tasks, one.frame)).catch(() => null)
    if (parts === null && activity === null) {
      return next(e)
    }
    const { Text } = $.ui.resolve(e)
    const dot = <Text color="subtle"> · </Text>
    const working = activity === null ? null : <Text><Text color="suggestion">{activity.icon} </Text><Text color="warning">{activity.text}</Text></Text>
    if (parts === null) {
      return <Text wrap="truncate-end"><Text bold color="suggestion">devloop</Text>{dot}{working}</Text>
    }
    // One line of inline runs (never a flex row, which stretched and cut the parts), with a short text bar for the gate.
    const total = Math.max(1, parts.gate.total)
    const filled = Math.round((parts.gate.met / total) * 6)
    const bar = `${'▰'.repeat(filled)}${'▱'.repeat(6 - filled)}`

    return (
      <Text wrap="truncate-end">
        <Text bold color="suggestion">devloop</Text>
        {working !== null && dot}{working}
        {dot}<Text>{parts.phase}</Text>
        {dot}<Text color="subtle">tests </Text><Text color={parts.tests.color}>{parts.tests.text}</Text>
        {parts.review !== null && dot}{parts.review !== null && <Text color="subtle">review </Text>}{parts.review !== null && <Text color={parts.review.color}>{parts.review.text}</Text>}
        {dot}<Text color="subtle">gate </Text><Text color={parts.gate.met === parts.gate.total ? 'success' : 'warning'}>{bar} {parts.gate.met}/{parts.gate.total}</Text>
        {dot}<Text color={parts.risk.color}>{parts.risk.text}{parts.risk.text === 'no changes' ? '' : ' risk'}</Text>
      </Text>
    )
  })

  // The settings popup: a picker per setting from the working tree's
  // devloop.json, the draft's picks over it, Save and Cancel. Drawing writes
  // nothing and runs nothing; the draft is written from the handlers.
  on('ui.render', { component: 'Pane', requestId: SETTINGS_PANE }, async ($, e) => {
    const { Box, Button, Select, Text } = $.ui.resolve(e)
    const at = await look($)
    const text = at.text
    const view = text === null ? { error: '' } : readSettings(text)
    const cancel = <Button key="cancel" label="Cancel" onPress={() => closeSettings($)} />
    if (text === null || 'error' in view) {
      // Never written over: only Cancel.
      return (
        <Box flexDirection="column">
          <Text color="error" wrap="wrap">{text === null ? absentOf(heldPolicy(at)) : unreadableOf('error' in view ? view.error : '')}</Text>
          <Box>{cancel}</Box>
        </Box>
      )
    }
    const draft = await settingsDraftOf($)
    const opened = draft?.openedWith ?? openedWithOf(view)
    const changes = draft?.changes ?? {}
    // The tests row shows the checks a Save would write.
    const after = changes.verify === undefined ? view : readSettings(applyChanges(text, { verify: changes.verify }))
    const tests = 'rows' in after ? after.rows.find(row => row.key === 'tests') : undefined
    // The policy devloop last held: whether the base branch's copy governs, and the base's name.
    const policy = heldPolicy(at)
    const guard = (await guardNow($).catch(() => null))?.hasStatusLine === true ? 'installed' : pythonMissing() ? 'no-python' : 'available'
    const label = (name: string) => <Text> {name.padEnd(SETTINGS_LABEL)}</Text>
    const mark = (isChanged: boolean) => <Text color={isChanged ? 'suggestion' : undefined}>{isChanged ? '•' : ' '}</Text>
    const rows = view.rows.flatMap(row => {
      if (row.key === 'tests') {
        return [
          <Box>
            {mark(changes.verify !== undefined)}
            {label(row.label)}
            <Text wrap="truncate-end">{tests?.current ?? row.current} </Text>
            <Button key="tests-change" label="Change" onPress={() => changeTests($)} />
          </Box>,
          row.error !== null && <Text color="error" wrap="wrap">  {row.error}</Text>,
        ]
      }
      const key = row.key

      return [
        <Box>
          {mark(changes[key] !== undefined)}
          {label(row.label)}
          <Select
            key={`row-${key}`}
            options={row.options}
            value={changes[key] ?? row.current}
            autoFocus={key === 'mode' ? true : undefined}
            onSelect={value => pickSetting($, key, value, opened)}
          />
        </Box>,
        row.error !== null && <Text color="error" wrap="wrap">  {row.error}</Text>,
      ]
    })

    return (
      <Box flexDirection="column">
        {rows}
        <Box>
          {mark(false)}
          {label('cache-guard')}
          <Text>{guard === 'installed' ? 'installed' : guard === 'available' ? 'not installed' : 'needs Python 3.8+'} </Text>
          {guard === 'installed' && <Button key="cache-remove" label="Remove" onPress={() => removeGuard($)} />}
          {guard === 'available' && <Button key="cache-install" label="Install" onPress={() => installGuard($)} />}
        </Box>
        <Text color="subtle" wrap="wrap">{effectLine(policy?.cfg.defaultBranch ?? DEFAULTS.defaultBranch, policy?.source === 'base', false)}</Text>
        <Text color="subtle" wrap="wrap">{SETTINGS_FOOTER}</Text>
        <Box>
          <Button key="save" label="Save" variant="primary" onPress={() => saveSettings($)} />
          <Text> </Text>
          {cancel}
        </Box>
      </Box>
    )
  })
}
