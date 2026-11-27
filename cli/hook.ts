// The classic hooks (DESIGN 4.11): `PreToolUse` and `Stop` command hooks
// declared beside the hooks module in hooks/hooks.json, each running
// `node dist/devloop.mjs hook <event>`. The engine runs them after the
// module's hooks, so the module stamps every call and stop it judged; a
// stamp means the module judged it and this hook stands down at once. With
// the module live in the session (its heartbeat) and no stamp, the module's
// hook was skipped: the stateless core applies, anything that ships is
// refused, and `module-skipped` is recorded. With no heartbeat at all, the
// module is not loaded: this hook is the enforcement, with a one-time notice
// of what holds and what does not. A repository with no policy on either
// side is a silent no-op.

import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import process from 'node:process'
import { clearTimeout, setTimeout } from 'node:timers'

import { DEFAULTS, parseConfig } from '../hooks/config'
import type { Config } from '../hooks/config'
import {
  JUDGED_TOOLS, SEARCH_TOOLS, SHELL_TOOLS, STAMPS_KEPT, commandOf, filePathOf, heartbeatPath, inboxPath, judgeCall, noticePath, promptStampPath, repoStateDir, stampPath, stateRootFrom, statelessLoop, stopKey,
  stopStampPath,
} from '../hooks/enforce'
import { namesDefaultSecret, pushSends } from '../hooks/enforce'
import type { InboxEvent } from '../hooks/enforce'
import { decidePolicy } from '../hooks/inforce'
import type { InForce } from '../hooks/inforce'
import { distill, infraAdvice } from '../hooks/output'
import { sessionCheckProblems } from '../hooks/tasks'
import { NUDGE, backstop, firstLine, groundingMode, isQuestionOfFact, lastTurn, looksIn } from '../hooks/grounding'
import { digest } from '../hooks/output'
import { isHeldBy, liftClause, stepsFor } from '../hooks/rules'
import { OUT_OF_TIME, proveGate } from './gate'
import { exec, findBase, findRoot, globsFor, policyTextAt, readText, realOf, runCheck, snapshot, tasksFacts, whereFor } from './io'
import type { Found } from './io'
import { judgeOne } from './judge'

type Input = Record<string, unknown>

/** The time the checks get on a ship (D1 F5): well under the PreToolUse hook's limit of 600 s in hooks/hooks.json. */
export const SHIP_BUDGET_MS = 240_000

const str = (value: unknown): string => (typeof value === 'string' ? value : '')

/**
 * What the person is to be told beside whatever this hook answers (grounding's
 * report at a stop, DESIGN 4.15): merged into the answer's `systemMessage`, or
 * printed alone when the hook has nothing else to say (`flushNotice`).
 */
let pendingNotice: string | null = null

/** Prints a hook's JSON answer, with any pending notice for the person. */
const answer = (value: unknown): void => {
  let out = value
  if (pendingNotice !== null && typeof value === 'object' && value !== null) {
    const said = (value as { systemMessage?: unknown }).systemMessage
    out = { ...value, systemMessage: typeof said === 'string' && said !== '' ? `${pendingNotice}\n${said}` : pendingNotice }
    pendingNotice = null
  }
  process.stdout.write(`${JSON.stringify(out)}\n`)
}

/** Prints a pending notice that no other answer carried. */
function flushNotice(): void {
  if (pendingNotice !== null) {
    answer({})
  }
}

function ensureDir(file: string): void {
  mkdirSync(file.slice(0, file.lastIndexOf('/')), { recursive: true })
}

/** Removes the oldest call stamps beyond the newest few hundred. */
function pruneStamps(dir: string): void {
  try {
    const names = readdirSync(dir)
    if (names.length <= STAMPS_KEPT + 50) {
      return
    }
    const aged = names.map(name => ({ name, at: statSync(`${dir}/${name}`).mtimeMs })).sort((a, b) => a.at - b.at)
    for (const one of aged.slice(0, aged.length - STAMPS_KEPT)) {
      unlinkSync(`${dir}/${one.name}`)
    }
  } catch {
    // Tidying is best effort.
  }
}

/**
 * The policy in force for the classic hook: the shared decision
 * (`decidePolicy`) on the working copy and the base's copy, read through git
 * on every call that needs it. Nothing this hook wrote earlier decides it
 * (the cache-guard round, P-D): a record of the base's copy in the state
 * folder could be written by anything that reaches that folder.
 */
function policyFor(found: Found, stateRoot: string): { policy: InForce | null; base: string | null } {
  const branch = found.working?.defaultBranch ?? DEFAULTS.defaultBranch
  let base = findBase(found.root, branch)
  let baseText = policyTextAt(found.root, base)
  let policy = decidePolicy(found.working, found.text, baseText)
  if (policy !== null && policy.source === 'base' && policy.cfg.defaultBranch !== branch) {
    const again = findBase(found.root, policy.cfg.defaultBranch)
    const text = policyTextAt(found.root, again)
    const next = decidePolicy(found.working, found.text, text)
    if (next !== null && next.source === 'base') {
      policy = next
      base = again
      baseText = text
    }
  }
  // The base copy's secret globs, for the git-free read path below: they can only add to what is refused there.
  const secrets = baseText === null ? null : parseConfig(baseText).cfg.secrets
  if (secrets !== null) {
    try {
      const file = secretsFile(stateRoot, found.root)
      ensureDir(file)
      writeFileSync(file, JSON.stringify({ secrets }))
    } catch {
      // Best effort.
    }
  }

  return { policy, base }
}

/** Where the classic hook notes the base copy's secret globs it last read: an addition to the defaults for a read, never a decision. */
const secretsFile = (stateRoot: string, root: string): string => `${repoStateDir(stateRoot, root)}/classic-secrets.json`

/**
 * The secrets any policy here could name, without running git: the
 * defaults, the working copy's, and the base copy's as this hook last read
 * them. The record only ever adds globs: one that is missing, or was
 * rewritten to name fewer, leaves the defaults and the working copy's, as on
 * the first read in a repository (A11).
 */
function anySecrets(found: Found, stateRoot: string): Config {
  let base: string[] = []
  try {
    const kept = JSON.parse(readFileSync(secretsFile(stateRoot, found.root), 'utf8')) as { secrets?: unknown }
    base = Array.isArray(kept.secrets) ? kept.secrets.filter((one): one is string => typeof one === 'string') : []
  } catch {
    base = []
  }

  return { ...DEFAULTS, secrets: [...DEFAULTS.secrets, ...(found.working?.secrets ?? []), ...base], secretsAllow: [] }
}

/** How large the inbox may grow before the classic hooks stop appending to it. */
const INBOX_MAX_BYTES = 2_000_000

/** Appends one event to the inbox the module folds into the ledger and the audit trail. */
function toInbox(stateRoot: string, root: string, event: InboxEvent): void {
  try {
    const file = inboxPath(stateRoot, root)
    ensureDir(file)
    // Bounded: a repository whose module never loads does not grow it without end.
    if (existsSync(file) && statSync(file).size > INBOX_MAX_BYTES) {
      return
    }
    appendFileSync(file, `${JSON.stringify(event)}\n`)
  } catch {
    // Recording never changes the answer.
  }
}

/**
 * Why a ship is refused when its checks did not finish within the hook's
 * time budget (R4): which finished and which did not, that nothing is kept,
 * and the ways forward.
 */
export const outOfTimeReason = (progress: string): string =>
  `The checks did not finish within the classic hook's time budget (${SHIP_BUDGET_MS / 1000}s), so nothing ships on this call: ${progress}. Nothing is kept between runs, so a retry runs every check again. Ways forward: push from a session with devloop's hooks module loaded (it proves the gate with its own record of passes), let the command-line gate (node dist/devloop.mjs gate) judge the push in CI, or ask a person to push.`

/** What the person and the model are told once per session when the full harness is not loaded. */
export const NOT_LOADED = 'devloop: the full harness (its hooks module) is not loaded in this session, so only the stateless core holds, from the classic hooks: secrets, protected and harness paths, production, forbidden, destructive and egress commands, --no-verify and forced pushes, ship-alone, merges, content rules that refuse, test weakening on edits, and the fast checks at each stop. There is no spec approval, feature status, review loop or exemption: high-risk paths cannot be edited, and a medium or high-risk change cannot ship without review evidence (a git note naming its tree).'

/** The session's one-time notice, when it has not been given yet. */
function noticeOnce(stateRoot: string, session: string): string | null {
  if (session === '') {
    return null
  }
  const file = noticePath(stateRoot, session)
  if (existsSync(file)) {
    return null
  }
  try {
    ensureDir(file)
    writeFileSync(file, String(Date.now()))
  } catch {
    return null
  }

  return NOT_LOADED
}

/** The module's state for this session: it judged the call (a stamp), it is live but did not (a heartbeat), or it is not loaded. */
export type ModuleState = 'judged' | 'skipped' | 'absent'

/** `hook PreToolUse`: the classic guard. Prints nothing (no decision) or one JSON answer; exits 0. */
export function preToolUse(input: Input, stateRoot: string): void {
  const tool = str(input.tool_name)
  if (!JUDGED_TOOLS.includes(tool)) {
    return
  }
  const id = str(input.tool_use_id)
  const stamp = id === '' ? null : stampPath(stateRoot, id)
  if (stamp !== null && existsSync(stamp)) {
    try {
      unlinkSync(stamp)
    } catch {
      // Gone already.
    }
    pruneStamps(stamp.slice(0, stamp.lastIndexOf('/')))

    return
  }
  const session = str(input.session_id)
  const state: ModuleState = session !== '' && existsSync(heartbeatPath(stateRoot, session)) ? 'skipped' : 'absent'
  const cwd = str(input.cwd) || process.cwd()
  const found = findRoot(cwd)
  const call = { tool, input: (typeof input.tool_input === 'object' && input.tool_input !== null ? input.tool_input : {}) as Record<string, unknown> }
  // A read or a search may skip git work, never judgment (D1 F2): the shared core's own secrets test, with the
  // same path placement and link resolution as every other enforcement point, under every secret any policy here
  // could name. Only when that finds nothing does the call go on with no git and no policy read.
  if (tool === 'Read' || SEARCH_TOOLS.includes(tool)) {
    const where = whereFor(found.root, cwd, stateRoot)
    const loose = judgeCall(call, { cfg: anySecrets(found, stateRoot), isOptedIn: false, where, loop: statelessLoop(), realOf: path => realOf(path, where), readText })
    if (!loose.some(one => one.rule === 'secret')) {
      return
    }
  }
  const { policy } = policyFor(found, stateRoot)
  if (policy === null) {
    // Not opted in (D2, carried from D1): the secrets rule still holds, with the default globs, as the dormant module holds it. Nothing is recorded.
    // A command's wildcards are expanded on disk as the module expands them (P-C), a move's wildcard target included (X11).
    const bare = whereFor(found.root, cwd, stateRoot)
    const where = SHELL_TOOLS.includes(tool) ? globsFor(commandOf(call), bare) : bare
    const secret = judgeCall(call, { cfg: DEFAULTS, isOptedIn: false, where, loop: statelessLoop(), realOf: path => realOf(path, where), readText }).find(one => one.rule === 'secret')
    if (secret !== undefined) {
      answer({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: `devloop (classic hook): [secret] ${secret.reason} ${liftClause('secret')}` } })
    }

    return
  }
  const cfg = policy.cfg
  const where = whereFor(found.root, cwd, stateRoot)
  const judged = judgeOne(call, cfg, true, where, found.root)
  const event = (kind: InboxEvent['kind'], rule: string | null): InboxEvent =>
    ({ at: Date.now(), kind, session, tool, subject: (tool === 'Bash' || tool === 'Monitor' ? str(call.input.command) : filePathOf(call) || str(call.input.pattern)).slice(0, 80), rule })
  if (state === 'skipped') {
    toInbox(stateRoot, found.root, event('module-skipped', judged.verdict?.rule ?? null))
  }
  const notice = state === 'absent' ? noticeOnce(stateRoot, session) : null
  if (notice !== null) {
    toInbox(stateRoot, found.root, event('module-absent', null))
  }
  let deny: string | null = null
  if (judged.isHeld && judged.verdict !== null) {
    deny = `[${judged.verdict.rule}${judged.verdict.id === undefined ? '' : `:${judged.verdict.id}`}] ${judged.verdict.reason} ${liftClause(judged.verdict.rule)}`
    toInbox(stateRoot, found.root, event('classic-refusal', judged.verdict.id ?? judged.verdict.rule))
  } else if (judged.ships && judged.verdict === null) {
    if (state === 'skipped') {
      // The harness's own judgment of a ship needs its state: it did not run, so nothing ships on this call.
      deny = '[gate] The harness could not judge this call (its hook did not run for it), so nothing ships on it: run it again. The skip was recorded for the person.'
    } else {
      // The gate judges the tree, a push sends commits (final round, D1 F4): they must be the same thing before the gate is worth proving.
      const snap = judged.isPush ? snapshot(found.root, cfg) : null
      const sends = snap === null ? null : pushSends(snap.committable, [{ tree: snap.headTree, isHead: true }], snap)
      if (sends !== null) {
        deny = cfg.mode === 'enforce' ? `[gate] ${sends.reason}` : null
      } else {
        // The checks get a time budget well under the hook's own limit (D1 F5). This hook keeps nothing (R4, P-D): it runs them all itself, each time.
        const proven = proveGate(found, { until: Date.now() + SHIP_BUDGET_MS, now: () => Date.now() })
        if ('code' in proven) {
          const isOutOfTime = (proven.json as { error?: string } | null)?.error === OUT_OF_TIME
          deny = cfg.mode !== 'enforce'
            ? null
            : isOutOfTime
              ? `[gate] ${outOfTimeReason(proven.text)}`
              : `[gate] The gate could not be proven here, so nothing ships yet: ${proven.text}`
        } else if (!proven.isGreen && cfg.mode === 'enforce') {
          deny = `[gate] The gate is not green, so nothing ships yet. Still needed: ${proven.rows.filter(row => !row.isMet).map(row => `${row.label} (${row.note})`).join('; ')}.`
        }
      }
      if (deny !== null) {
        toInbox(stateRoot, found.root, event('classic-refusal', 'gate'))
      }
    }
  }
  if (deny !== null) {
    answer({
      ...(notice === null ? {} : { systemMessage: notice }),
      hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: `devloop (classic hook): ${deny}` },
    })

    return
  }
  if (notice !== null) {
    answer({ systemMessage: notice, hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: notice } })
  }
}

/**
 * What the classic stop gate keeps per repository: the last tree it blocked
 * and the rounds per prompt (a forged record only ends the fix loop early,
 * and the person is told), and the tree and prompt of the last stop, for the
 * keep-warm quiet turn (A14 in docs/RESIDUAL-RISK.md). No pass is kept: the
 * checks run on every stop that is not quiet (R4, P-D).
 */
type StopRecord = { blocked: string | null; rounds: number; prompt: string; tasksBlocked?: string; error?: string; lastTree?: string | null; lastPrompt?: string }

/**
 * The `.tasks` exit protocol (D2): where the integration is on, the
 * convention's session check for this session; what it reports, or null when
 * it passes (or the integration is off).
 */
function sessionCheckOf(root: string, cfg: Config, session: string): string | null {
  if (session === '' || !tasksFacts(root, cfg).isOn) {
    return null
  }
  const ran = exec(['tasks', 'session-check', '--json', '--session', session], root, 30_000)

  return sessionCheckProblems(ran.code, `${ran.out}\n${ran.err}`)
}

/** `hook Stop`: the classic stop gate. Prints nothing, or one JSON answer; exits 0. */
export function stop(input: Input, stateRoot: string): void {
  if (str(input.agent_id) !== '') {
    return
  }
  const session = str(input.session_id)
  const stamp = session === '' ? null : stopStampPath(stateRoot, session)
  if (stamp !== null && readText(stamp)?.trim() === stopKey(input)) {
    try {
      unlinkSync(stamp)
    } catch {
      // Gone already.
    }

    return
  }
  const state: ModuleState = session !== '' && existsSync(heartbeatPath(stateRoot, session)) ? 'skipped' : 'absent'
  const found = findRoot(str(input.cwd) || process.cwd())
  const { policy } = policyFor(found, stateRoot)
  if (policy === null) {
    return
  }
  // The keep-warm guarantee (DESIGN 4.14): a new turn (another prompt id, not a stop after a block) that leaves the tree
  // as the last stop saw it gets nothing from this hook: no check run, no fix round, no message. A keep-warm ping is
  // such a turn; this hook cannot tell who started a turn, so the same holds for a person's prompt that changed nothing.
  const snap = snapshot(found.root, policy.cfg)
  const stopFile = `${repoStateDir(stateRoot, found.root)}/classic-stop.json`
  let seen: StopRecord = { blocked: null, rounds: 0, prompt: '' }
  try {
    seen = { ...seen, ...(JSON.parse(readFileSync(stopFile, 'utf8')) as Partial<StopRecord>) }
  } catch {
    // Nothing kept yet.
  }
  const thisPrompt = str(input.prompt_id)
  const isQuiet = snap.tree !== null && seen.lastTree === snap.tree && seen.lastPrompt !== thisPrompt && input.stop_hook_active !== true && seen.blocked !== snap.tree
  try {
    ensureDir(stopFile)
    writeFileSync(stopFile, JSON.stringify({ ...seen, lastTree: snap.tree, lastPrompt: thisPrompt }))
  } catch {
    // Best effort: without it the next stop is judged in full.
  }
  // Grounding's backstop (DESIGN 4.15), from the transcript, before the ordinary stop gate and the quiet turn: a turn
  // no person started is left alone (the transcript says who started it), so the keep-warm guarantee holds.
  const grounded = groundingAtStop(input, policy.cfg, snap.tree !== null && typeof seen.lastTree === 'string' && seen.lastTree !== snap.tree)
  if (grounded !== null && 'block' in grounded) {
    answer({ decision: 'block', reason: grounded.block })

    return
  }
  if (grounded !== null) {
    pendingNotice = grounded.notice
    toInbox(stateRoot, found.root, { at: Date.now(), kind: 'answer-unchecked', session, tool: 'Stop', subject: grounded.prompt, rule: null })
  }
  if (isQuiet) {
    return
  }
  // The `.tasks` exit protocol: claimed work is not left without a resume point. Blocked once per prompt, like a failing check; recorded only in observe.
  const tasksFile = stopFile
  const problem = sessionCheckOf(found.root, policy.cfg, session)
  if (problem !== null) {
    let record: StopRecord = { blocked: null, rounds: 0, prompt: '' }
    try {
      record = { ...record, ...(JSON.parse(readFileSync(tasksFile, 'utf8')) as Partial<StopRecord>) }
    } catch {
      // Nothing kept yet.
    }
    const prompt = str(input.prompt_id)
    if (!isHeldBy('tasks', policy.cfg) || record.tasksBlocked === prompt) {
      answer({ systemMessage: `devloop (classic hook): the .tasks session check fails: ${problem}` })

      return
    }
    try {
      ensureDir(tasksFile)
      writeFileSync(tasksFile, JSON.stringify({ ...record, tasksBlocked: prompt }))
    } catch {
      // Best effort.
    }
    answer({ decision: 'block', reason: `devloop (classic hook): the .tasks session check fails, so work is not left as it is: ${problem}\n\nWrite each claimed task's resume point (\`tasks state <task>\`), or pause or hand it over (\`tasks pause|handoff <task> -m "…"\`), then stop.` })

    return
  }
  if (policy.cfg.verify.length === 0) {
    return
  }
  if (snap.tree === null) {
    return
  }
  const cfg = (decidePolicy(found.working, found.text, policyTextAt(found.root, snap.base)) ?? policy).cfg
  const file = `${repoStateDir(stateRoot, found.root)}/classic-stop.json`
  const prompt = str(input.prompt_id)
  let kept: StopRecord = { blocked: null, rounds: 0, prompt }
  try {
    kept = { ...kept, ...(JSON.parse(readFileSync(file, 'utf8')) as Partial<StopRecord>) }
  } catch {
    // Nothing kept yet.
  }
  if (kept.prompt !== prompt) {
    kept = { ...kept, rounds: 0, blocked: null, prompt }
  }
  const keep = (): void => {
    try {
      ensureDir(file)
      writeFileSync(file, JSON.stringify(kept))
    } catch {
      // Best effort.
    }
  }
  const event = (kind: InboxEvent['kind']): InboxEvent => ({ at: Date.now(), kind, session, tool: 'Stop', subject: 'the stop gate', rule: null })
  if (state === 'skipped') {
    toInbox(stateRoot, found.root, event('module-skipped'))
  }
  // No pass is kept and trusted (R4, P-D): the fast checks run on every stop that is not a quiet one.
  if (snap.tree === kept.blocked) {
    // A stop on the very tree the gate last blocked: no progress, so the fix loop ends and the person is told.
    kept = { ...kept, blocked: null }
    keep()
    answer({ systemMessage: 'devloop (classic hook): the agent stopped again with nothing changed since the last blocked stop; verification still fails. This needs you.' })

    return
  }
  const steps = stepsFor(cfg.verify, 'fast', snap.files)
  const runs = steps.map(one => ({ run: one.run, ...runCheck(one.run, found.root, cfg) }))
  const failed = runs.find(one => !one.isPassing)
  if (failed === undefined) {
    kept = { ...kept, blocked: null }
    keep()

    return
  }
  if (failed.outcome !== 'fail') {
    const advice = infraAdvice(failed.run, failed.outcome, cfg.verifyTimeoutSec)
    answer({ systemMessage: `devloop (classic hook): ${advice}` })

    return
  }
  if (cfg.mode === 'observe') {
    answer({ systemMessage: `devloop (classic hook, observe): verification is failing: ${failed.run}` })

    return
  }
  if (kept.rounds >= cfg.maxFixRounds) {
    answer({ systemMessage: `devloop (classic hook): still failing after ${cfg.maxFixRounds} fix rounds. This one needs you.` })

    return
  }
  kept = { ...kept, rounds: kept.rounds + 1, blocked: snap.tree }
  keep()
  answer({
    decision: 'block',
    reason: [
      `devloop (classic hook): verification failed, so the work is not done (fix round ${kept.rounds} of ${cfg.maxFixRounds}).`,
      `\`${failed.run}\` exited ${failed.code}.`,
      distill(failed.output),
      'Fix the cause; never weaken a test to get green.',
    ].join('\n\n'),
  })
}

/** How much of a transcript the classic Stop hook reads back: its last part, where the last turn is. */
export const TRANSCRIPT_TAIL = 8 * 1024 * 1024

/**
 * Grounding's backstop in the classic Stop hook (DESIGN 4.15, decision 6),
 * when the module did not judge the stop: the transcript is read back to the
 * start of its last turn; a turn a person started with a question of fact
 * that holds no look at any source, on a tree it did not change, is refused
 * once (enforce: `block`), and otherwise reported (`notice`). A second stop
 * (`stop_hook_active`) is never refused for this. A transcript that is
 * missing or cannot be read skips this check, and only this check (principle
 * 11): it is advice about an answer, not a guard on what reaches a branch.
 * `fresh: "tree"` is not honoured here: it would rest on a record this hook
 * keeps on disk (principle 16), so only this turn's looks count.
 */
export function groundingAtStop(input: Input, cfg: Config, isTreeChanged: boolean): { block: string } | { notice: string; prompt: string } | null {
  const mode = groundingMode(cfg)
  const path = str(input.transcript_path)
  if (mode === 'off' || path === '') {
    return null
  }
  let text: string | null = null
  try {
    const size = statSync(path).size
    const all = readFileSync(path, 'utf8')
    text = size > TRANSCRIPT_TAIL ? all.slice(all.indexOf('\n', all.length - TRANSCRIPT_TAIL) + 1) : all
  } catch {
    return null
  }
  const turn = lastTurn(text)
  if (turn === null || !turn.isPerson) {
    return null
  }
  const verdict = backstop({
    mode, isQuestion: isQuestionOfFact(turn.prompt, cfg.grounding.also, cfg.grounding.never), looks: looksIn(turn.calls), isTreeChanged, isFreshLook: false,
    isRefused: input.stop_hook_active === true, answer: str(input.last_assistant_message),
  })
  if (verdict.action === 'refuse') {
    return { block: `devloop (classic hook): ${verdict.reason}` }
  }
  if (verdict.action === 'report') {
    const prompt = firstLine(turn.prompt)

    return { notice: `devloop (classic hook): ${verdict.toast} (asked: "${prompt.slice(0, 80)}")`, prompt }
  }

  return null
}

/**
 * `hook UserPromptSubmit`: grounding's nudge (DESIGN 4.15) where the module
 * did not see the prompt (no prompt stamp of its digest): a person's question
 * of fact, in a repository with a policy and grounding on, gets one line of
 * context. Anything else gets nothing.
 */
export function userPromptSubmit(input: Input, stateRoot: string): void {
  const session = str(input.session_id)
  const prompt = str(input.prompt)
  const stamp = session === '' ? null : promptStampPath(stateRoot, session)
  if (stamp !== null && readText(stamp)?.trim() === digest(prompt)) {
    try {
      unlinkSync(stamp)
    } catch {
      // Gone already.
    }

    return
  }
  const source = str(input.source)
  if (source !== '' && source !== 'user' && source !== 'sdk') {
    return
  }
  const found = findRoot(str(input.cwd) || process.cwd())
  const { policy } = policyFor(found, stateRoot)
  if (policy === null || groundingMode(policy.cfg) === 'off' || !isQuestionOfFact(prompt, policy.cfg.grounding.also, policy.cfg.grounding.never)) {
    return
  }
  answer({ hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: `devloop: ${NUDGE}` } })
}

/** How long the hook waits for its input to end: well under the hook's own limit, so a writer that never closes is refused here, not by the engine's timeout. */
export const READ_DEADLINE_MS = 60_000

/**
 * Reads standard input to its end (final round, D1 F1): asynchronously,
 * until the writer closes it, however late it writes and however much. A
 * read is never cut short: what is not complete by the deadline is an
 * error, never an empty call.
 */
export function readStdin(deadlineMs = READ_DEADLINE_MS): Promise<{ text: string } | { error: string }> {
  return new Promise(resolve => {
    const chunks: string[] = []
    let isDone = false
    const finish = (value: { text: string } | { error: string }): void => {
      if (!isDone) {
        isDone = true
        clearTimeout(timer)
        resolve(value)
      }
    }
    const timer = setTimeout(() => {
      finish({ error: `its input did not end within ${Math.round(deadlineMs / 1000)}s` })
      process.stdin.destroy()
    }, deadlineMs)
    process.stdin.setEncoding('utf8')
    process.stdin.on('data', chunk => chunks.push(chunk))
    process.stdin.on('end', () => finish({ text: chunks.join('') }))
    process.stdin.on('error', error => finish({ error: `its input could not be read (${String(error)})` }))
  })
}

/**
 * The hook's input as one JSON object, or why it is not one: empty input,
 * text that does not parse (a truncated payload), a value that is not an
 * object, or a PreToolUse call with no tool named. Never an empty call.
 */
export function parseInput(event: string, text: string): { input: Input } | { error: string } {
  if (text.trim() === '') {
    return { error: 'its input was empty' }
  }
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    return { error: `its input is not complete JSON (${text.length} characters read)` }
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return { error: 'its input is not a JSON object' }
  }
  const input = value as Input
  if (event === 'PreToolUse' && typeof input.tool_name !== 'string') {
    return { error: 'its input names no tool' }
  }

  return { input }
}

/** The repository state folder for a stop the hook could not judge: where it records that verification did not run. */
function markStopError(stateRoot: string, cwd: string, why: string): void {
  try {
    const found = findRoot(cwd)
    const file = `${repoStateDir(stateRoot, found.root)}/classic-stop.json`
    let kept: StopRecord = { blocked: null, rounds: 0, prompt: '' }
    try {
      kept = { ...kept, ...(JSON.parse(readFileSync(file, 'utf8')) as Partial<StopRecord>) }
    } catch {
      // Nothing kept yet.
    }
    ensureDir(file)
    // Verification is marked as an error; the next stop runs the checks again (no pass is ever kept).
    writeFileSync(file, JSON.stringify({ ...kept, error: why.slice(0, 200) }))
  } catch {
    // Best effort: the person is told either way.
  }
}

/** What the hook answers when it could not judge (its input unreadable, or an error): a refusal for a call, never a blocked stop. */
function couldNotJudge(event: string, why: string, stateRoot: string, cwd: string, isRead: boolean): void {
  if (event === 'PreToolUse') {
    answer({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: `devloop (classic hook): the harness ${isRead ? 'could not read this call' : 'could not judge this call'} (${why}), so it is refused: an enforcement point that cannot judge its input refuses. Run it again; if this repeats, a person runs node dist/devloop.mjs doctor.`,
      },
    })
  } else if (event === 'Stop') {
    // A broken harness never blocks a stop (principle 8, B1 F26): verification is marked as an error and the person is told.
    markStopError(stateRoot, cwd, why)
    answer({ systemMessage: `devloop (classic hook): the stop gate ${isRead ? 'could not read its input' : 'failed'} (${why}), so verification did not run on this stop and counts as not done. Run node dist/devloop.mjs verify, or ask the agent to stop again.` })
  }
}

/** The mode the policy in force sets for this call's repository, read again after an error; null when it cannot be told. */
function modeAfterError(input: Input, stateRoot: string): Config['mode'] | 'dormant' | null {
  try {
    const found = findRoot(str(input.cwd) || process.cwd())
    const { policy } = policyFor(found, stateRoot)

    return policy === null ? 'dormant' : policy.cfg.mode
  } catch {
    return null
  }
}

/** `hook <event>`: one classic hook. Always exits 0: an answer is the JSON it prints. */
export async function hookCommand(event: string): Promise<number> {
  const stateRoot = stateRootFrom(process.env.CLAUDE_PLUGIN_DATA)
  if (event !== 'PreToolUse' && event !== 'Stop' && event !== 'UserPromptSubmit') {
    process.stderr.write(`devloop classic hook: unknown event ${event}\n`)

    return 0
  }
  const read = await readStdin()
  const parsed = 'error' in read ? read : parseInput(event, read.text)
  if ('error' in parsed) {
    // A prompt the hook cannot read gets no nudge: the nudge is advice, never a guard (DESIGN 4.15).
    if (event !== 'UserPromptSubmit') {
      couldNotJudge(event, parsed.error, stateRoot, process.cwd(), true)
    }

    return 0
  }
  const input = parsed.input
  try {
    if (event === 'PreToolUse') {
      preToolUse(input, stateRoot)
    } else if (event === 'UserPromptSubmit') {
      userPromptSubmit(input, stateRoot)
    } else {
      stop(input, stateRoot)
      flushNotice()
    }
  } catch (error) {
    if (event === 'UserPromptSubmit') {
      // The nudge is advice: a failure adds nothing and holds nothing.
      process.stderr.write(`devloop classic hook: ${String(error)}\n`)

      return 0
    }
    process.stderr.write(`devloop classic hook: ${String(error)}\n`)
    // A throw is a refusal in enforce mode (D1 F5c), and wherever the mode cannot be told (principle 11). Secrets hold in
    // every mode, so the last line, shared with the module, refuses a call that names one by the default globs; observe
    // reports the failure, and a repository that has not opted in holds that last line alone, as the module's guard does.
    const tool = str(input.tool_name)
    const why = String(error).slice(0, 200)
    if (event === 'Stop') {
      couldNotJudge(event, why, stateRoot, str(input.cwd) || process.cwd(), false)
    } else if (JUDGED_TOOLS.includes(tool)) {
      const mode = modeAfterError(input, stateRoot)
      const toolInput = (typeof input.tool_input === 'object' && input.tool_input !== null ? input.tool_input : {}) as Input
      if (mode === 'enforce' || mode === null) {
        couldNotJudge(event, why, stateRoot, str(input.cwd) || process.cwd(), false)
      } else if (namesDefaultSecret(tool, toolInput)) {
        answer({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: 'devloop (classic hook): this names a file that holds secrets; it is never read or written from here.' } })
      } else if (mode === 'observe') {
        answer({ systemMessage: `devloop (classic hook, observe): the hook failed on this call (${why}); in enforce mode it would have been refused.` })
      }
    }
  }

  return 0
}
