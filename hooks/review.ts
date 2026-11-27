// The independent review: one round starts the general reviewer and every
// specialist whose files changed, each in a fresh context; when all have
// answered, the harness reads their findings, checks each quote against the
// code and decides the round. The words and the decisions are pure, in
// findings.ts; this file does the work.

import type { Deferred, Finding, Loop, ReviewAgent, Tier } from '../types'
import type { Config, Reviewer } from './config'
import { baseFile } from './evidence'
import {
  addToBacklog, afterFix, closeGone, formatFinding, openBlocking, parseReview, restatePrompt, reviewPrompt, roundHeader, settleRound, toDeferred,
  unreadable, unverifiedBlocking, wouldBlock,
} from './findings'
import type { Answer, Parsed } from './findings'
import { cycleSummary } from './findings'
import { testLines } from './testruns'
import { atLeast, capText, featureCounts, isCapSpent, isStallSpent, NOTHING_TEXT, reviewRefusal, specialistsFor, STALLED_TEXT, tierFor } from './gate'
import { FRESH } from './fresh'
import { isSecret, relative } from './rules'
import { bump, coverageNow, git, judgeFeatureCheck, note, policyInForce, readFeatures, record, save, snapshot, snapshotInForce, loopOf, specHash, writeReviewDiff } from './state'
import type { Engine, Place, Snapshot } from './state'
import { isAtLimit } from './limits'
import { countFailedRound, limitRefusal, notePassing, reachLimit } from './rounds'
import { audit, checkRecord, meterCost, suggestEval } from './journal'
import { noteEvidence } from './portability'
import { REVIEWER_BRIEF, SECURITY_BRIEF } from './templates'
import { finishChecklist, isChecklistAgent, startChecklists } from './checklists'

/**
 * The exact commands the read-only reviewer may run beside plain reads (the
 * cache-guard round, R3): the base policy's verify commands (`cfg` is the
 * policy in force), and the approved spec's feature checks only while
 * building, when the spec on disk is the one a person approved (its
 * fingerprint matches the approval), each one the command rules let run as
 * `feature_check` judges it. A feature check of a spec still being written,
 * or of one changed since approval, is the builder's text and stays a
 * command like any other.
 */
export async function reviewerChecks($: Engine, at: Place, cfg: Config, loop: Loop): Promise<string[]> {
  // Background checks are not the reviewer's to run (rule 8): it reads their results instead.
  const verify = cfg.verify.filter(one => one.background !== true).map(one => one.run)
  if (loop.phase !== 'build' || loop.spec === null || loop.approvedHash === null || (await specHash($, at, loop)) !== loop.approvedHash) {
    return verify
  }
  const features: string[] = []
  for (const feature of await readFeatures($, at, loop)) {
    if (feature.check.trim() !== '' && (await judgeFeatureCheck($, at, cfg, loop, feature.check)) === null) {
      features.push(feature.check)
    }
  }

  return [...verify, ...features]
}

/** Whether an agent is one of the round's reviewers, general or specialist: every one of them is read-only. */
export const isReviewerAgent = (loop: Loop, agentId: string | undefined): boolean =>
  agentId !== undefined && (loop.review.agentId === agentId || loop.review.agents.some(one => one.agentId === agentId))

/** A finding the harness itself raises about a round (a reviewer that could not start or be read): no file, a person's to settle. */
const isHarnessFinding = (one: Finding): boolean => one.file === ''

/** What closes a harness finding about a reviewer that could not start: a round in which it starts. */
const RESTART = 'a round in which this reviewer starts'

/** What closes a harness finding about an answer that could not be read: only a person. */
const PERSON = 'a person reads the reviewer\'s answer and settles this: /devloop findings resolve <id> <note>'

/** Whether a harness finding ends with the next round: only one about a reviewer that could not start. */
const isRestartable = (one: Finding): boolean => isHarnessFinding(one) && one.evidence === RESTART

/** The brief a reviewer works from: the general one, a specialist's own, or the built-in security brief. */
function briefOf(one: Reviewer | null): string {
  if (one === null) {
    return REVIEWER_BRIEF
  }
  if (one.prompt !== null) {
    return `${REVIEWER_BRIEF}\n\nYou are the "${one.name}" specialist reviewer. ${one.prompt}`
  }

  return one.name === 'security'
    ? `${REVIEWER_BRIEF}\n\n${SECURITY_BRIEF}`
    : `${REVIEWER_BRIEF}\n\nYou are the "${one.name}" specialist reviewer: report only problems of ${one.name}, and leave everything else to the general reviewer.`
}

/** What a fast critic is told: a small change gets a quick, decisive read. */
export const FAST_BRIEF = 'This is a small change: a fast review. Read the diff and the test results, report only problems that would block a merge (at most 5), and give the verdict. Do not explore beyond the changed files and what they call.'

/** The model a reviewer runs on: its own, then the policy's for its kind; undefined is the session's. */
function modelOf(cfg: Config, name: string): string | undefined {
  if (name === 'general') {
    return cfg.models.reviewer ?? undefined
  }
  const one = cfg.reviewers.find(each => each.name === name)

  return one?.model ?? cfg.models.specialist ?? undefined
}

/**
 * A harness finding: a reviewer of the round that cannot be heard. One that
 * could not start ends with the next round; one whose answer could not be
 * read blocks until a person resolves it.
 */
function harnessFinding(reviewer: string, problem: string, round: number, next: number, isRestart = false): Finding {
  return {
    id: `F${next}`, reviewer, severity: 'high', file: '', line: 0, quote: '', problem, evidence: isRestart ? RESTART : PERSON,
    isPreExisting: false, route: 'decision', status: 'open', isBlocking: true, round, seen: round, note: null,
  }
}

const nextIdOf = (findings: readonly Finding[]): number => 1 + findings.reduce((max, one) => Math.max(max, Number(one.id.slice(1)) || 0), 0)

/**
 * A change that shipped closes its review count (Z1): once the gate passed a
 * push and the check after the fact confirmed that what shipped is what the
 * gate judged, the round number, the stall flag and the review cycle start
 * again for what comes next (C6). A round in progress is left alone.
 */
export async function closeShippedReview($: Engine, at: Place): Promise<void> {
  const now = await $.clock.now()
  await save($, at.root, before => (before.review.status === 'running' || (before.review.round === 0 && before.review.stalled === 0 && !before.review.isStalled)
    ? before
    : note({ ...before, review: { ...before.review, round: 0, stalled: 0, isStalled: false, isLooping: false, cycle: FRESH.review.cycle } }, 'review', 'the change shipped through the gate: the review count starts again for the next one', now)))
}

const ROUND_DELTA = `
# devloop:round-delta
git -c core.quotePath=false diff --no-renames --no-ext-diff --no-textconv "$1" "$2"
`

/**
 * The diff since the tree the cycle's last settled round read (DESIGN 4.16,
 * decision 8), for round 2 and later: null when no round settled (a round
 * never reads only the lines since a tree no one reviewed), the tree has not
 * moved, or git cannot give it, and the round reads the whole change.
 */
async function roundDelta($: Engine, at: Place, from: string | null, to: string | null): Promise<string | null> {
  if (from === null || to === null || from === to) {
    return null
  }
  const ran = await git($, at, ROUND_DELTA, [from, to], 60_000)

  return ran === null || ran.code !== 0 || ran.out.trim() === '' ? null : ran.out
}

/**
 * Starts a review round in a fresh context: the general reviewer, and each
 * specialist whose `when` matches a changed file. Resolves to a line saying
 * what happened; the verdicts arrive later, at each reviewer's `turn.complete`.
 * At the loop limit (DESIGN 4.16) a round the agent or auto-review starts is
 * refused with the limit's message; a person's own runs.
 */
export async function startReview($: Engine, at: Place, isAuto: boolean, isPerson = false): Promise<string> {
  // The policy in force (the base branch's) names the reviewers and their models, so a change cannot drop its own specialist.
  const found = await snapshotInForce($, at)
  if (found === null) {
    return 'This repository has not opted in to devloop, so there is no review.'
  }
  const { snap } = found
  const cfg = found.policy.cfg
  const loop = await loopOf($)
  if (loop.review.status === 'running') {
    return `Review round ${loop.review.round} is already running.`
  }
  if (isStallSpent(loop.review)) {
    return STALLED_TEXT
  }
  if (isCapSpent(loop.review, cfg)) {
    return capText(cfg)
  }
  if (loop.tier === 'none') {
    return NOTHING_TEXT
  }
  const refused = await limitRefusal($, cfg, snap.branch, isPerson)
  if (refused !== null) {
    return refused
  }
  // The first round of a change, or the first after a cycle that passed, is round 1 of a new cycle (rules 5, 15).
  const isNewCycle = loop.review.round === 0 || loop.review.cycle.ended === 'pass'
  const round = (isNewCycle ? 0 : loop.review.round) + 1
  // Round 2 and later reads the fix: the diff since the tree the cycle's last settled round read (decision 8).
  const delta = round > 1 ? await roundDelta($, at, loop.review.cycle.settledTree, snap.tree) : null
  const checks = await reviewerChecks($, at, cfg, loop)
  // The reviewer reads a diff the harness wrote, untracked files included,
  // from the base it measured: it needs no git command of its own.
  const diff = await writeReviewDiff($, at, snap.base, round)
  // Its instructions come from the base branch, so a change cannot rewrite its own review.
  const reviewMd = await baseFile($, at, snap.base, 'REVIEW.md')
  const nextId = nextIdOf(loop.findings)
  const tier = tierFor(loop, cfg)
  // A small change gets one fast critic: the general reviewer on the fast model, and only the specialists the gate needs.
  const isFast = tier !== 'high' && snap.size.files <= cfg.fastReview.maxFiles && snap.size.lines <= cfg.fastReview.maxLines
  const specialists = specialistsFor(loop, cfg).filter(one => !isFast || one.mode === 'blocking')
  // The open findings of a reviewer that no longer applies go to the general reviewer for re-check.
  const names = ['general', ...specialists.map(one => one.name)]
  const recheckedBy = (one: Finding): string => (names.includes(one.reviewer) ? one.reviewer : 'general')
  // The reviewer runs nothing (it has no shell): it reads the checks' and the features' results here.
  const features = Object.entries(loop.features).map(([id, one]) => (one.passes && one.tree === loop.tree ? `✓ feature ${id} passes on this tree` : `✗ feature ${id} not passing on this tree`))
  const tests = [...testLines(loop, cfg, await $.clock.now()), ...features]
  const promptFor = (name: string, one: Reviewer | null): string => reviewPrompt({
    brief: isFast && one === null ? `${briefOf(one)}\n\n${FAST_BRIEF}` : briefOf(one), reviewMd, spec: loop.spec, base: snap.base, diff, tier, changed: loop.changed, checks, tests, round, maxRounds: cfg.maxReviewRounds,
    open: loop.findings.filter(each => each.status === 'open' && each.route === 'fix' && recheckedBy(each) === name), nextId, delta,
  })
  const spawn = async (name: string, one: Reviewer | null): Promise<string | { deny: string }> => {
    const model = isFast && name === 'general' ? (cfg.fastReview.model ?? modelOf(cfg, name)) : modelOf(cfg, name)
    const started = await $.agent.spawn({
      prompt: promptFor(name, one),
      description: `devloop review, round ${round}${one === null ? '' : ` (${name})`}`,
      subagentType: 'devloop:reviewer',
      ...(model === undefined ? {} : { model }),
    }).catch((error: unknown) => ({ deny: String((error as Error | undefined)?.message ?? error), agentId: undefined }))

    return started.deny !== undefined || started.agentId === undefined ? { deny: started.deny ?? 'no agent was created' } : started.agentId
  }
  const general = await spawn('general', null)
  if (typeof general !== 'string') {
    return `The reviewer could not start: ${general.deny}.`
  }
  const agents: ReviewAgent[] = [{ agentId: general, name: 'general', mode: 'general', isRetry: false, answer: null }]
  const missing: string[] = []
  for (const one of specialists) {
    const started = await spawn(one.name, one)
    if (typeof started === 'string') {
      agents.push({ agentId: started, name: one.name, mode: one.mode, isRetry: false, answer: null })
    } else if (one.mode === 'blocking') {
      missing.push(one.name)
    }
  }
  // A new round resets everything derived from the previous verdict (final round, D2 F1): its checklist failures are derived again from this round's results.
  await save($, at.root, before => ({ ...before, checklistFails: [] }))
  // The checklists that apply (D2): pattern and check items answered in code now; review items to a shadow checklist reviewer, read-only like the rest.
  const checklist = await startChecklists($, at, cfg, loop, snap.base, diff, round, snap.tree).catch(() => null)
  if (checklist !== null) {
    agents.push({ agentId: checklist.agentId, name: 'checklist', mode: 'shadow', isRetry: false, answer: null })
  }
  const now = await $.clock.now()
  await save($, at.root, before => {
    // A reviewer that could not start last round is started again: that finding ends. One whose answer could not be read stays for a person.
    let findings = before.findings.map(one => (isRestartable(one) && one.status === 'open' ? { ...one, status: 'closed' as const } : one))
    // A new cycle starts with no stall and no loop, its first finding id the next one (rule 5).
    const reset = isNewCycle ? { stalled: 0, isStalled: false, isLooping: false, cycle: { ...FRESH.review.cycle, from: nextIdOf(before.findings) } } : {}
    for (const name of missing) {
      findings = [...findings, harnessFinding(name, `the ${name} reviewer could not start`, round, nextIdOf(findings), true)]
    }

    return note(
      { ...before, findings, review: { ...before.review, ...reset, status: 'running', round, agentId: general, isAuto, at: now, tree: snap.tree, agents, isScoped: delta !== null } },
      'review',
      `review round ${round} started${agents.length > 1 ? ` with ${agents.slice(1).map(one => one.name).join(', ')}` : ''}${delta === null ? '' : ', on the lines changed since the last round'}`,
      now,
    )
  })
  await meterCost($, at.root, { kind: 'review-start', round })
  const named = agents.length > 1 ? ` with the ${agents.slice(1).map(one => one.name).join(', ')} reviewer${agents.length > 2 ? 's' : ''}` : ''

  return `Review round ${round} of ${cfg.maxReviewRounds} started in a fresh context${named}. Its verdict will show in the Dev loop pane.`
}

/** Reads the files findings cite, as the reviewed tree has them, for their quotes; a path outside the repository or a secret is never read. */
async function readCited($: Engine, at: Place, cfg: Config, files: readonly string[]): Promise<Record<string, string | null>> {
  const out: Record<string, string | null> = {}
  for (const file of [...new Set(files)].slice(0, 80)) {
    const rel = file === '' ? null : relative(at.root, at.root, file)
    const path = `${at.root}/${rel ?? ''}`
    out[file] = rel === null || rel === '' || isSecret(rel, cfg) || !(await $.fs.exists(path).catch(() => false)) ? null : await $.fs.read(path).catch(() => null)
  }

  return out
}

/** Resets a round that was interrupted: it does not count. */
async function dropRound($: Engine, at: Place, why: string): Promise<void> {
  const now = await $.clock.now()
  await save($, at.root, before =>
    note({ ...before, review: { ...before.review, status: 'none', agentId: null, agents: [], round: Math.max(0, before.review.round - 1) } }, 'review', why, now),
  )
}

/** Why an answer must be restated, or null: it cannot be read, or a blocking finding's quote is not at its line. */
function restateReason(parsed: Parsed, tier: Tier, files: Readonly<Record<string, string | null>>, prior: readonly Finding[]): string | null {
  const why = unreadable(parsed, prior)
  if (why !== null) {
    return why
  }
  const unverified = unverifiedBlocking(parsed, tier, files)

  return unverified.length > 0 ? `the quoted line of ${unverified.join(', ')} is not at the line cited` : null
}

/** Counts one shadow reviewer's answer: a round, whether it would have blocked, and whether it agreed with the general reviewer. */
async function countShadow($: Engine, at: Place, name: string, parsed: Parsed, tier: Tier, files: Readonly<Record<string, string | null>>, generalBlocks: boolean): Promise<void> {
  const isBlocking = wouldBlock(parsed, tier, files)
  await bump($, at.root, `shadow:${name}:rounds`)
  if (isBlocking) {
    await bump($, at.root, `shadow:${name}:would-block`)
  }
  if (isBlocking === generalBlocks) {
    await bump($, at.root, `shadow:${name}:agreed`)
  }
}

/**
 * A shadow reviewer has answered: it never holds or drops a round. Its
 * answer is counted when it arrives (at settlement while the round runs,
 * at once after it settled); an abort or an answer with no verdict changes nothing.
 */
async function finishShadow($: Engine, at: Place, cfg: Config, agentId: string, answer: string, isAborted: boolean): Promise<void> {
  const loop = await save($, at.root, before => ({
    ...before,
    review: { ...before.review, agents: before.review.agents.map(one => (one.agentId === agentId ? { ...one, answer: isAborted ? '' : answer } : one)) },
  }))
  const agent = loop.review.agents.find(one => one.agentId === agentId)
  if (loop.review.status === 'running' || isAborted || agent === undefined) {
    return
  }
  const parsed = parseReview(answer)
  if (parsed.verdict !== null) {
    const files = await readCited($, at, cfg, parsed.findings.map(raw => raw.file))
    await countShadow($, at, agent.name, parsed, tierFor(loop, cfg), files, openBlocking(loop.findings, 'general').length > 0)
  }
  await save($, at.root, before => ({ ...before, review: { ...before.review, agents: before.review.agents.map(one => (one.agentId === agentId ? { ...one, answer: '' } : one)) } }))
}

/**
 * One reviewer of the round has answered. An answer that cannot be read (no
 * verdict, finding lines that do not fit, a FAIL with no finding) or that
 * quotes a blocking finding's line wrongly gets one restatement (a second
 * agent given its own answer), which is not a round. When the general and
 * every blocking reviewer have answered, the round is decided; a shadow
 * reviewer never holds it.
 */
export async function finishReview($: Engine, at: Place, agentId: string, answer: string, isAborted: boolean): Promise<void> {
  const policy = await policyInForce($, at)
  if (policy === null) {
    return
  }
  const cfg = policy.cfg
  const started = await loopOf($)
  const agent = started.review.agents.find(one => one.agentId === agentId)
  if (agent === undefined || agent.answer !== null) {
    return
  }
  // The checklist reviewer answers items, not findings (D2): its answer is read against the items it was sent.
  if (agent.name === 'checklist' && (await isChecklistAgent($, at.root, agentId))) {
    await finishChecklist($, at, cfg, agentId, answer, isAborted)
    await save($, at.root, before => ({ ...before, review: { ...before.review, agents: before.review.agents.map(one => (one.agentId === agentId ? { ...one, answer: '' } : one)) } }))

    return
  }
  if (agent.mode === 'shadow') {
    await finishShadow($, at, cfg, agentId, answer, isAborted)

    return
  }
  if (started.review.status !== 'running') {
    return
  }
  if (isAborted) {
    await dropRound($, at, 'review interrupted')

    return
  }
  // A verdict covers the tree the round started on. One that arrives after
  // the tree moved is about code that no longer exists: it is discarded, and
  // still uses its round, so spend stays bounded (rule 11).
  const snap = await snapshot($, at, cfg)
  if (snap.tree !== null && started.review.tree !== null && snap.tree !== started.review.tree) {
    await discardRound($, at, cfg, started)

    return
  }
  const parsed = parseReview(answer)
  const why = agent.isRetry ? null : restateReason(parsed, tierFor(started, cfg), await readCited($, at, cfg, parsed.findings.map(raw => raw.file)), started.findings)
  if (why !== null) {
    const model = modelOf(cfg, agent.name)
    const again = await $.agent.spawn({
      prompt: restatePrompt(answer, why),
      description: `devloop review, round ${started.review.round}: restate in the format`,
      subagentType: 'devloop:reviewer',
      ...(model === undefined ? {} : { model }),
    }).catch(() => ({ agentId: undefined, deny: 'could not start' }))
    if (again.agentId !== undefined && again.deny === undefined) {
      const id = again.agentId
      const now = await $.clock.now()
      await save($, at.root, before => note({
        ...before,
        review: {
          ...before.review,
          agentId: before.review.agentId === agentId ? id : before.review.agentId,
          agents: before.review.agents.map(one => (one.agentId === agentId ? { ...one, agentId: id, isRetry: true } : one)),
        },
      }, 'review', `the ${agent.name} reviewer's answer could not be read (${why.slice(0, 80)}); asked once to restate it`, now))
      await record($, at.root, 'review-format', agent.name, answer.slice(-300))

      return
    }
  }
  const loop = await save($, at.root, before => ({
    ...before,
    review: { ...before.review, agents: before.review.agents.map(one => (one.agentId === agentId ? { ...one, answer } : one)) },
  }))
  if (loop.review.agents.some(one => one.mode !== 'shadow' && one.answer === null)) {
    return
  }
  await settle($, at, cfg, loop, snap)
}

/**
 * Throws away a round whose tree moved while it ran (rule 11). Unlike an
 * interrupted round it keeps its number, so it counts toward the cycle's
 * cap, and the cycle counts it as discarded; a discarded last round spends
 * the cap. It counts nothing toward the loop limit. What starts the next
 * round: the next stop, for the re-review of a fix (rule 14) or a finished
 * spec build; otherwise the next ready moment (rule 13); with autoReview
 * off, a person.
 */
async function discardRound($: Engine, at: Place, cfg: Config, started: Loop): Promise<void> {
  const { round } = started.review
  const isLast = round >= cfg.maxReviewRounds
  const now = await $.clock.now()
  await save($, at.root, before => note({
    ...before,
    review: {
      ...before.review, status: 'none', agentId: null, agents: [],
      cycle: { ...before.review.cycle, discarded: before.review.cycle.discarded + 1, ended: isLast ? 'cap' : before.review.cycle.ended },
    },
  }, 'review', `review round ${round} discarded: the tree moved while it ran (it counts toward the cap)`, now))
  const next = isLast
    ? 'The review cap is spent, so a person reads the change.'
    : !cfg.autoReview
      ? 'A person starts the next round with /devloop review ("autoReview" is off).'
      : started.review.isLooping || started.phase === 'build'
        ? 'The next stop starts a fresh round.'
        : 'A fresh round starts when the change is ready again: the devloop_review tool, or a push.'
  if (isLast) {
    // The cycle ends at the cap: its summary comes first, the discard notice last (C3).
    const told = cycleSummary({ ended: 'cap', round, cap: cfg.maxReviewRounds, discarded: started.review.cycle.discarded + 1, from: started.review.cycle.from, findings: started.findings, tests: testLines(started, cfg, now) })
    await save($, at.root, before => ({ ...before, review: { ...before.review, cycle: { ...before.review.cycle, summary: told } } }))
    $.ui.toast(`devloop: ${told}`, { timeoutMs: 15_000 })
  }
  $.ui.toast(`devloop: a review verdict arrived for a tree that has since changed; it was discarded and counts as round ${round} of ${cfg.maxReviewRounds}. ${next}`)
}

/** Decides a round once the general and every blocking reviewer have answered: the harness, not the verdict line, decides. */
async function settle($: Engine, at: Place, cfg: Config, loop: Loop, snap: Snapshot): Promise<void> {
  const { round, isAuto } = loop.review
  const tier = tierFor(loop, cfg)
  const heard = loop.review.agents.filter(one => one.answer !== null && one.answer !== '').map(one => ({ ...one, parsed: parseReview(one.answer ?? '') }))
  const counted = loop.review.agents.filter(one => one.mode !== 'shadow').map(one => ({ ...one, parsed: parseReview(one.answer ?? '') }))
  const answers: Answer[] = counted.filter(one => one.parsed.verdict !== null).map(one => ({ name: one.name, parsed: one.parsed }))
  const backlog = ((await $.store.get(`deferred:${at.root}`)) as Deferred[] | undefined) ?? []
  const cited = [
    ...heard.flatMap(one => one.parsed.findings.map(raw => raw.file)),
    ...loop.findings.filter(one => one.status === 'open').map(one => one.file),
    ...backlog.filter(one => one.status === 'open').map(one => one.file),
  ].filter(file => file !== '')
  const files = await readCited($, at, cfg, cited)
  const settled = settleRound({ round, tier, prior: loop.findings, answers, files, ran: loop.review.agents.map(one => one.name), isScoped: loop.review.isScoped === true })
  let findings = settled.findings
  // What the harness could not read, even restated, goes to a person: it never counts as a pass.
  for (const one of counted) {
    const why = unreadable(one.parsed, loop.findings)
    if (one.parsed.verdict === null) {
      findings = [...findings, harnessFinding(one.name, `the ${one.name} reviewer twice answered without a verdict in the format, so its review could not be read`, round, nextIdOf(findings))]
    } else if (one.parsed.unread.length > 0) {
      findings = [...findings, harnessFinding(one.name, `the ${one.name} reviewer wrote finding lines the harness could not read, even restated: ${(one.parsed.unread[0] ?? '').slice(0, 120)}`, round, nextIdOf(findings))]
    } else if (why !== null && openBlocking(findings, one.name).length === 0) {
      findings = [...findings, harnessFinding(one.name, `the ${one.name} reviewer failed this change and gave no readable finding, even restated`, round, nextIdOf(findings))]
    }
  }
  // Shadow reviewers never block: whether they would have, and whether they agreed with the general reviewer, is counted.
  const generalBlocks = openBlocking(findings, 'general').length > 0
  for (const one of heard.filter(each => each.mode === 'shadow' && each.parsed.verdict !== null)) {
    await countShadow($, at, one.name, one.parsed, tier, files, generalBlocks)
  }
  const now = await $.clock.now()
  const from = loop.spec ?? 'small fix'
  await $.store.set(`deferred:${at.root}`, closeGone(addToBacklog(backlog, settled.deferred.map(one => toDeferred(one, from, now))), files))
  const isPassing = !findings.some(one => one.status === 'open' && one.isBlocking)
  const stalled = !isPassing && settled.isStalled ? loop.review.stalled + 1 : 0
  const isStalled = stalled >= 2
  const toFix = findings.filter(one => one.status === 'open' && one.isBlocking && one.route === 'fix')
  const decisions = findings.filter(one => one.status === 'open' && one.isBlocking && one.route === 'decision')
  const isLast = round >= cfg.maxReviewRounds
  // A round that ended FAIL is one failed round on the branch (DESIGN 4.16, decision 1), one count per round.
  const opened = findings.filter(one => one.status === 'open' && one.isBlocking && one.seen === round)
  const limit = isPassing ? null : await countFailedRound($, at.root, snap.branch, { kind: 'review', what: `round ${round}: ${opened.map(one => one.id).join(', ') || 'no readable verdict'}`, files: [...new Set(opened.map(one => one.file).filter(file => file !== ''))] })
  // At the limit, in enforce mode, nothing more is handed back: the builder is not woken, and the message is given once (decision 2).
  const isStopped = limit !== null && isAtLimit(limit, cfg) && cfg.mode === 'enforce'
  // Each id the header names is either in the list below it or says why not (11b).
  const header = roundHeader(round, settled, findings, new Set(toFix.map(one => one.id)))
  const summary = `${header.slice(0, -1)}${settled.demoted.length > 0 ? `; ${settled.demoted.join(', ')} not found at the line cited, kept as notes` : ''}${settled.unverified.length > 0 ? `; ${settled.unverified.join(', ')} not found at the line cited, for a person to check` : ''}.`
  // A failed round whose findings go to the builder begins a review loop: the next stop that verifies a moved tree starts the next round (11a, rule 14).
  const isLooping = !isPassing && !isStalled && !isLast && !isStopped && toFix.length > 0
  // The cycle ends with a pass, a stall or a failed last round; the next ready moment after a pass starts a new one (rules 5, 15).
  const ended = isPassing ? 'pass' as const : isStalled ? 'stalled' as const : isLast ? 'cap' as const : null
  await save($, at.root, before => note({
    ...before,
    findings,
    // The round's reviewers are kept (their answers dropped), so a specialist's row knows it ran.
    // A shadow reviewer still at work keeps `answer: null`, so its answer is counted when it arrives.
    review: {
      ...before.review, status: isPassing ? 'pass' : 'fail', agentId: null, summary, at: now, stalled, isStalled, isLooping,
      agents: before.review.agents.map(one => ({ ...one, answer: one.mode === 'shadow' && one.answer === null ? null : '' })),
      cycle: { ...before.review.cycle, ended: ended ?? before.review.cycle.ended, settledTree: before.review.tree },
    },
  }, 'review', isPassing ? `review passed in round ${round}` : `review round ${round} found problems`, now))
  // The one summary a person reads when the cycle ends (spec §5): toast, Activity, and the agent's next prompt.
  const cycleText = ended === null ? null : cycleSummary({ ended, round, cap: cfg.maxReviewRounds, discarded: loop.review.cycle.discarded, from: loop.review.cycle.from, findings, tests: testLines(loop, cfg, now) })
  if (cycleText !== null) {
    await save($, at.root, before => note({ ...before, review: { ...before.review, cycle: { ...before.review.cycle, summary: cycleText } } }, 'review', cycleText.split('\n')[0] ?? 'review done', now))
    $.ui.toast(`devloop: ${cycleText}`, { timeoutMs: 15_000 })
  }
  await bump($, at.root, 'review-rounds')
  await meterCost($, at.root, { kind: 'review-end' })
  for (const one of findings.filter(each => each.round === round || each.seen === round)) {
    // Each finding is a finding@1 record; one that does not fit is said out loud (it is kept: dropping a finding would fail unsafe).
    await checkRecord($, at.root, 'finding@1', { schema: 'finding@1', ...one })
  }
  for (const one of findings.filter(each => each.status === 'open' && each.isBlocking && each.round === round)) {
    await record($, at.root, 'finding', `${one.reviewer}:${one.severity}:${one.file}`, one.problem)
  }
  // Each reviewer's verdict, with the tree it covered, goes to the audit trail.
  for (const one of counted) {
    const open = findings.filter(each => each.reviewer === one.name && each.status === 'open' && each.isBlocking).map(each => each.id)
    await audit($, at.root, 'review-verdict', { kind: 'agent', name: `reviewer:${one.name}` }, `round ${round}`, loop.review.tree, `${open.length === 0 && one.parsed.verdict !== null ? 'pass' : 'fail'}${open.length > 0 ? ` (${open.join(', ')} open)` : ''}${one.parsed.verdict === null ? ' (no readable verdict)' : ''}`)
  }
  // Portable evidence (D1): the settled round, as a git note on HEAD when HEAD's tree is the reviewed one.
  await noteEvidence($, at, cfg, 'review').catch(() => undefined)
  if (!isPassing && (isStalled || isLast)) {
    // A review loop that ended failed is a failure the eval suite could learn from.
    await suggestEval($, at.root, 'review-failed', `review of ${from} ended failed in round ${round}: ${summary}`, null)
  }
  if (isPassing) {
    if (round === 1) {
      await bump($, at.root, 'review-first-pass')
    }
    if (cycleText === null) {
      $.ui.toast(`devloop: review passed in round ${round}${settled.deferred.length + settled.demoted.length > 0 ? ' (with notes; /devloop findings lists them)' : ''}`)
    }
    // The newest commit for which the gate was fully met (decision 4).
    await notePassing($, at, snap).catch(() => undefined)

    return
  }
  await record($, at.root, 'review-fail', answers.length === 0 ? 'no-verdict' : 'findings', summary)
  if (decisions.length > 0) {
    $.ui.toast(`devloop: ${decisions.map(one => one.id).join(', ')} need${decisions.length === 1 ? 's' : ''} your decision before this ships. /devloop findings shows ${decisions.length === 1 ? 'it' : 'them'}; /devloop findings resolve <id> <note> settles one.`, { timeoutMs: 15_000 })
  }
  // At the loop limit (DESIGN 4.16): the message once, appended (it wakes no turn), and nothing handed back in enforce mode.
  const told = await reachLimit($, at, cfg, snap.branch)
  if (isStopped) {
    if (told !== null) {
      await $.session.append({ message: { type: 'user', content: [{ type: 'text', text: told }] } }).catch(() => undefined)
    }

    return
  }
  let text: string
  if (isStalled) {
    $.ui.toast(`devloop: two review rounds in a row closed no finding, so the review loop stopped at round ${round}. A person needs to read this change.`, { timeoutMs: 15_000 })
    text = `The independent review stopped (round ${round} of ${cfg.maxReviewRounds}): two rounds in a row closed none of the open findings. Stop working on them now and tell the person which findings are still open and what you tried.\n\n${toFix.map(formatFinding).join('\n')}`
  } else if (toFix.length === 0) {
    text = `The independent review (round ${round} of ${cfg.maxReviewRounds}) left only findings that await a person's decision: ${decisions.map(one => one.id).join(', ')}. Do not act on them; stop and say so.`
  } else {
    $.ui.toast(isLast ? `devloop: review failed ${round} times; a person needs to look` : `devloop: review round ${round} found problems`)
    text = [
      `The independent reviewer found blocking problems (round ${round} of ${cfg.maxReviewRounds}). The harness checked each quote against the code. ${summary}`,
      `Each line is: id | severity | file:line | the quoted line | the problem | the evidence that would close it.\n${toFix.map(formatFinding).join('\n')}`,
      decisions.length > 0 ? `Awaiting a person's decision, not yours: ${decisions.map(one => one.id).join(', ')}. Do not act on these.` : '',
      afterFix(isLast, cfg.autoReview),
    ].filter(part => part !== '').join('\n\n')
  }
  if (isAuto && !isLast && !isStalled && toFix.length > 0 && cfg.mode === 'enforce') {
    // Wakes the builder to fix what was found; resolves when that turn starts.
    void $.prompt.submit({ text }).catch(() => undefined)
  } else {
    await $.session.append({ message: { type: 'user', content: [{ type: 'text', text }] } }).catch(() => undefined)
  }
}

/**
 * Whether a verdict on record covers the tree now: a round settled (passed
 * or failed) and its verdict was reached on this tree or carries to it, only
 * task state having changed since (rule 5; final round, D2 F1).
 */
export async function isReviewedHere($: Engine, at: Place, cfg: Config, loop: Loop): Promise<boolean> {
  return (loop.review.status === 'pass' || loop.review.status === 'fail') && (await coverageNow($, at, cfg, loop, loop.tree)) !== 'not'
}

/**
 * Starts the round a stop calls for, under the rules every automatic round
 * shares (`reviewRefusal`; `cfg` is the policy in force). A stop starts one
 * only at a finished spec build (every feature passing on this tree, and no
 * pass in this cycle yet), or to re-review a fix: a failed round handed its
 * findings to the builder and the tree has moved since (rules 13, 14). An
 * ordinary stop, and an edit after a pass, start none (rule 15).
 */
export async function maybeReview($: Engine, at: Place, cfg: Config, loop: Loop): Promise<void> {
  const { passing, total, onTree } = featureCounts(loop)
  const isBuilt = loop.phase === 'build' && total > 0 && passing === total && onTree === total && loop.review.status === 'none' && loop.review.cycle.ended !== 'pass'
  const isFix = loop.review.isLooping && loop.review.status !== 'pass' && loop.tree !== null && loop.tree !== loop.review.tree
  // A small fix the agent finished (this stop's checks passed, or none are set) gets its first review without anyone asking; later rounds follow rules 14-15.
  const isFinished = cfg.reviewOnFinish && loop.phase === 'idle' && loop.tree !== null && atLeast(tierFor(loop, cfg), 'medium') && loop.review.round === 0 && loop.review.status === 'none'
  if (!isBuilt && !isFix && !isFinished) {
    return
  }
  if (reviewRefusal(loop, cfg, await isReviewedHere($, at, cfg, loop)) === null) {
    await startReview($, at, true)
  }
}

/**
 * A person settles a finding: a decision made, or a finding they accept as
 * it is. With nothing blocking left, a round on this tree passes.
 */
export async function resolveFinding($: Engine, at: Place, id: string, text: string): Promise<string> {
  const loop = await loopOf($)
  const one = loop.findings.find(each => each.id.toLowerCase() === id.toLowerCase())
  if (one === undefined || one.status !== 'open') {
    return `No open finding ${id}. /devloop findings lists them.`
  }
  const now = await $.clock.now()
  const next = await save($, at.root, before => {
    const findings = before.findings.map(each => (each.id === one.id ? { ...each, status: 'resolved' as const, note: text } : each))
    const isClear = !findings.some(each => each.status === 'open' && each.isBlocking)
    // Nothing blocking left: the round passes, and its cycle ends with a pass (rule 5).
    const review = isClear && before.review.status === 'fail' ? { ...before.review, status: 'pass' as const, cycle: { ...before.review.cycle, ended: 'pass' as const } } : before.review

    return note({ ...before, findings, review }, 'review', `${one.id} resolved by a person: ${text.slice(0, 80)}`, now)
  })
  await record($, at.root, 'finding-resolved', one.id, text)

  return `${one.id} is resolved: ${text}${next.review.status === 'pass' && loop.review.status === 'fail' ? '\nNothing blocking is left: the review round passes.' : ''}`
}

/** What /devloop findings lists: open findings, the deferred backlog (closing entries whose line is gone), and resolved ones. */
export async function findingsReport($: Engine, at: Place, cfg: Config, isPerson = false): Promise<string> {
  const loop = await loopOf($)
  const stored = ((await $.store.get(`deferred:${at.root}`)) as Deferred[] | undefined) ?? []
  const files = await readCited($, at, cfg, stored.filter(one => one.status === 'open').map(one => one.file))
  const backlog = closeGone(stored, files)
  if (JSON.stringify(backlog) !== JSON.stringify(stored)) {
    await $.store.set(`deferred:${at.root}`, backlog)
  }
  const open = loop.findings.filter(one => one.status === 'open')
  const resolved = loop.findings.filter(one => one.status === 'resolved' || one.status === 'closed')
  const deferred = backlog.filter(one => one.status === 'open')
  const lines = [
    `Open (${open.length}):`,
    ...open.map(one => `  ${formatFinding(one)}${one.route === 'decision' ? '  [a person decides: /devloop findings resolve ' + one.id + ' <note>]' : ''}`),
    `Deferred backlog (${deferred.length}, kept across changes until the quoted line goes):`,
    ...deferred.map(one => `  ${one.severity} | ${one.file} | ${one.quote} | ${one.problem} (from ${one.from})`),
    `Resolved or addressed (${resolved.length}):`,
    ...resolved.map(one => `  ${one.id} ${one.file}${one.file === '' ? '' : ':'}${one.file === '' ? '' : one.line} ${one.problem}${one.note !== null ? ` (person: ${one.note})` : ' (addressed)'}`),
  ]
  // For a person: what the builder is not shown, with its text (C2.1).
  if (isPerson) {
    const later = loop.findings.filter(one => one.status === 'deferred')
    const notes = loop.findings.filter(one => one.status === 'note')
    lines.push(
      `Deferred in this change (${later.length}, not shown to the builder):`,
      ...later.map(one => `  ${formatFinding(one)}`),
      `Notes (${notes.length}, not shown to the builder):`,
      ...notes.map(one => `  ${formatFinding(one)}`),
    )
  }

  return lines.join('\n')
}
