// Learning without being asked at work (docs/design-notes/auto-learning.md,
// DESIGN 4.17): starting the proposer at the end of a turn, at /devloop done
// and on a person's /devloop learn; reading its answer into waiting
// proposals and trial rules; the trial and promoted rules' hits and upkeep;
// and the person's /devloop rules. The decisions and the words are pure, in
// autolearn.ts. Nothing the proposer writes reaches the builder: its text is
// shown to the person only (toasts carry counts and ids alone, and a command
// that shows it is display-only).

import type { CommandRunInput, CommandRunResult } from 'claude-code'

import {
  breadthOf, learnedLines, learnedOf, nextId, parseProposals, pendingGroups, policyEntry, proposerPrompt, runRefusal, sweepLearned, trialReason, withHits, MAX_BREADTH, TOO_BROAD,
} from './autolearn'
import type { Learned, LearnedRule, Proposal } from './autolearn'
import type { Config } from './config'
import { rulesFor } from './contentrules'
import { actorOf, audit, confirm, isFromPerson, listOf } from './journal'
import { learnGroups } from './ledger'
import type { Tombstone } from './ledger'
import { firstLine } from './records'
import { bump, filesUnder, ledger, loopOf, note, record, save } from './state'
import type { Engine, Place } from './state'

type Answer = CommandRunResult

const keyOf = (root: string): string => `learning:${root}`

/** The repository's learning state as kept (`learning:<root>`); another shape reads as empty. */
export async function learnedNow($: Engine, root: string): Promise<Learned> {
  return learnedOf(await $.store.get(keyOf(root)).catch(() => undefined))
}

async function keepLearned($: Engine, root: string, learned: Learned): Promise<void> {
  await $.store.set(keyOf(root), learned)
}

/** Whether the session's budget is spent: the flag the guards keep, or the estimate past the cap now. */
async function isBudgetSpent($: Engine, cfg: Config): Promise<boolean> {
  const loop = await loopOf($)
  if (loop.isOverBudget) {
    return true
  }
  const cap = loop.budgetUsd ?? cfg.budgetUsd
  if (cap === null) {
    return false
  }
  const usd = (await $.session.usage().catch(() => null))?.cost?.usd

  return usd !== undefined && usd >= cap
}

/**
 * Starts a proposer run when one is due (decision 2): `turn` at the end of
 * a turn a person started, `done` when a change closes, `asked` on a
 * person's /devloop learn (every repeat that waits, given before or not).
 * One run handles every pending group. Resolves to what happened, in words
 * for the person.
 */
export async function maybePropose($: Engine, at: Place, cfg: Config, how: 'turn' | 'done' | 'asked', isPerson: boolean): Promise<string> {
  const loop = await loopOf($)
  const now = await $.clock.now()
  const refused = runRefusal(loop, cfg, { isPerson, isSpent: await isBudgetSpent($, cfg), now })
  if (refused !== null) {
    return `No proposer run: ${refused}.`
  }
  const entries = await ledger($, at.root)
  const tombstones = await listOf<Tombstone>($, `tombstones:${at.root}`)
  const learned = await learnedNow($, at.root)
  const least = how === 'asked' ? Math.min(2, cfg.learning.repeats) : cfg.learning.repeats
  const groups = pendingGroups(entries, tombstones, learned, least, how === 'asked')
  if (groups.length === 0) {
    return 'No proposer run: no repeat waits for a proposal.'
  }
  const model = cfg.models.learner ?? undefined
  const started = await $.agent.spawn({
    prompt: proposerPrompt(groups, entries),
    description: 'devloop learn: proposals for repeated failures',
    subagentType: 'devloop:learner',
    ...(model === undefined ? {} : { model }),
  }).catch((error: unknown) => ({ agentId: undefined, deny: String((error as Error | undefined)?.message ?? error) }))
  if (started.agentId === undefined || started.deny !== undefined) {
    await record($, at.root, 'learner', 'could-not-start', started.deny ?? 'no agent was created')

    return 'The proposer could not start.'
  }
  const agentId = started.agentId
  const keys = groups.map(one => one.key)
  await save($, at.root, before => note({ ...before, learner: { agentId, at: now, groups: keys, runs: (before.learner?.runs ?? 0) + 1 } }, 'info', `proposer run started for ${keys.length} repeat group${keys.length === 1 ? '' : 's'}`, now))
  await keepLearned($, at.root, { ...learned, asked: [...learned.asked.filter(one => !keys.includes(one.key)), ...keys.map(key => ({ key, at: now }))].slice(-500) })
  await bump($, at.root, 'learn-runs')

  return `A proposer run started for ${keys.length} repeat group${keys.length === 1 ? '' : 's'}; its proposals will show under /devloop learn.`
}

/** How many existing lines a pattern matches across the tracked files its globs match (counted up to one past the limit). */
async function breadthIn($: Engine, at: Place, globs: readonly string[], pattern: string): Promise<number> {
  const rule = { id: 'breadth', when: [...globs], pattern, action: 'note' as const, why: '' }
  const tracked = ((await filesUnder($, at, ['']))[''] ?? []).filter(file => {
    try {
      return rulesFor(file, [rule]).length > 0
    } catch {
      return false
    }
  }).slice(0, 3000)
  let n = 0
  for (const file of tracked) {
    n += breadthOf(pattern, [await $.fs.read(`${at.root}/${file}`).catch(() => '')])
    if (n > MAX_BREADTH) {
      return n
    }
  }

  return n
}

/**
 * The proposer answered (decision 2 and 3): its lines are read, one that
 * does not fit is dropped and counted; a rule proposal that passes every gate
 * goes on trial at once, anything else waits for the person with its exact
 * text and, for a rule, the reason. The person is told once per run: a toast
 * with the count and a line in the Activity tab.
 */
export async function finishProposer($: Engine, at: Place, cfg: Config, agentId: string, answer: string, isAborted: boolean): Promise<void> {
  const loop = await loopOf($)
  if (loop.learner?.agentId !== agentId) {
    return
  }
  const now = await $.clock.now()
  const sent = loop.learner.groups
  await save($, at.root, before => ({ ...before, learner: { ...before.learner, agentId: null } }))
  if (isAborted) {
    await save($, at.root, before => note(before, 'info', 'the proposer run was interrupted: nothing was proposed', now))

    return
  }
  const read = parseProposals(answer, sent)
  const entries = await ledger($, at.root)
  const tombstones = await listOf<Tombstone>($, `tombstones:${at.root}`)
  const groups = new Map(learnGroups(entries, tombstones, 1).map(one => [one.key, one]))
  let learned = await learnedNow($, at.root)
  let trials = 0
  for (const one of read.proposals) {
    const group = groups.get(one.group)
    const evidence = { label: group?.label ?? one.group, count: group?.count ?? 0, sample: group?.sample ?? '' }
    const { id, next } = nextId(learned, cfg)
    learned = { ...learned, next }
    if (one.kind === 'rule') {
      let reason = trialReason({ ...one, id }, learned, tombstones, cfg, group?.ruleKey ?? one.group)
      if (reason === null && (await breadthIn($, at, one.globs, one.pattern ?? '')) > MAX_BREADTH) {
        reason = TOO_BROAD
      }
      if (reason === null) {
        const rule: LearnedRule = {
          id, group: one.group, when: one.globs, pattern: one.pattern ?? '', why: one.why, evalTask: one.evalTask, at: now, status: 'trial', hits: 0, last: null, seen: [], isTold: false, promotedAt: null, evidence,
        }
        learned = { ...learned, rules: [...learned.rules, rule] }
        trials += 1
        continue
      }
      learned = { ...learned, proposals: [...learned.proposals, { ...one, id, at: now, reason, evidence }] }
      continue
    }
    const waiting: Proposal = { ...one, id, at: now, reason: null, evidence }
    learned = { ...learned, proposals: [...learned.proposals, waiting] }
  }
  learned = { ...learned, dropped: learned.dropped + read.dropped, runs: learned.runs + 1 }
  await keepLearned($, at.root, learned)
  const n = read.proposals.length
  await bump($, at.root, 'learn-proposals', n)
  if (read.dropped > 0) {
    await bump($, at.root, 'learn-dropped', read.dropped)
  }
  await save($, at.root, before => note(before, 'info', `proposer run: ${n} proposal${n === 1 ? '' : 's'}${trials > 0 ? `, ${trials} on trial` : ''}${read.dropped > 0 ? `; ${read.dropped} line${read.dropped === 1 ? '' : 's'} not in the format, dropped` : ''}; /devloop learn`, now))
  if (n > 0) {
    $.ui.toast(`devloop: ${n} proposal${n === 1 ? '' : 's'} waiting: /devloop learn`, { timeoutMs: 12_000 })
  }
}

/**
 * Records the learned rules' hits on an edit that went through (decision 3):
 * a trial rule's count and its hits (path, line number, fingerprint), and the
 * person's one notice at `promoteHits`. The ledger and the hit counts are the
 * caller's, as for any content rule.
 */
export async function noteLearnedHits($: Engine, root: string, cfg: Config, hits: readonly { id: string; path: string; line: number; fp: string }[]): Promise<void> {
  if (hits.length === 0) {
    return
  }
  const now = await $.clock.now()
  const { learned, told } = withHits(await learnedNow($, root), hits, now, cfg.learning.promoteHits)
  await keepLearned($, root, learned)
  for (const one of told) {
    $.ui.toast(`devloop: trial rule ${one.id} would have caught ${one.hits} edits: /devloop rules promote ${one.id}`, { timeoutMs: 15_000 })
  }
}

/**
 * The upkeep (decisions 3 and 4), at session start and at the end of a turn:
 * a learned rule the policy in force has by id is dropped from the state; a
 * trial rule with no hit for `pruneWindowDays` is removed and tombstoned.
 */
export async function sweepLearning($: Engine, at: Place, cfg: Config): Promise<void> {
  const learned = await learnedNow($, at.root)
  if (learned.rules.length === 0) {
    return
  }
  const now = await $.clock.now()
  const swept = sweepLearned(learned, cfg, now)
  if (swept.learned === learned) {
    return
  }
  await keepLearned($, at.root, swept.learned)
  if (swept.stones.length > 0) {
    await $.store.set(`tombstones:${at.root}`, [...(await listOf<Tombstone>($, `tombstones:${at.root}`)), ...swept.stones])
  }
  const said = [
    swept.inPolicy.length > 0 ? `${swept.inPolicy.join(', ')} now in the policy: the state copy is dropped` : '',
    swept.expired.length > 0 ? `${swept.expired.join(', ')} removed after ${cfg.pruneWindowDays} days with no hit (tombstoned)` : '',
  ].filter(one => one !== '').join('; ')
  await save($, at.root, before => note(before, 'info', `learned rules: ${said}`, now))
}

/** Doctor's lines (decision 6): the mode in force, the counts, and each promoted rule not yet in the policy. */
export async function learningDoctor($: Engine, at: Place, cfg: Config): Promise<{ isGood: boolean; text: string }[]> {
  const learned = await learnedNow($, at.root)
  const inPolicy = new Set(cfg.rules.map(one => one.id))
  const trials = learned.rules.filter(one => one.status === 'trial').length
  const promoted = learned.rules.filter(one => one.status === 'promoted')
  const missing = promoted.filter(one => !inPolicy.has(one.id)).map(one => one.id)
  const { learning } = cfg

  return [
    {
      isGood: true,
      text: `learning: ${learning.auto}${learning.auto === 'off' ? ' (nothing happens by itself; /devloop learn lists the repeats)' : `; a proposer run at ${learning.repeats} repeats and at /devloop done, at most ${learning.maxRuns} per session${learning.auto === 'trial' ? `; a proposed rule on trial (at most ${learning.maxTrial}), offered for promotion at ${learning.promoteHits} hits` : '; proposed rules wait for a person'}`}; ${trials} trial rule${trials === 1 ? '' : 's'}, ${promoted.length} promoted, ${learned.proposals.length} waiting proposal${learned.proposals.length === 1 ? '' : 's'}`,
    },
    ...(missing.length === 0 ? [] : [{ isGood: false, text: `promoted rules not yet in devloop.json (they hold on this machine only, and not at the command line or the classic hooks): ${missing.join(', ')}; /devloop rules prints each entry` }]),
  ]
}

/**
 * `/devloop rules [promote <id> | drop <id> <reason>]` (decision 4), all a
 * person's: the listing, a promotion after a dialog that shows the hits, and
 * a drop with its tombstone. Promote and drop are audited. Display-only: the
 * proposer's text is the person's to read.
 */
export async function rulesCommand($: Engine, at: Place, cfg: Config, words: readonly string[], e: CommandRunInput): Promise<Answer> {
  if (!isFromPerson(e)) {
    return { text: 'Learned rules are a person\'s to read, promote and drop, from the prompt.' }
  }
  const sub = words[0] ?? ''
  const id = words[1] ?? ''
  let learned = await learnedNow($, at.root)
  const shown = (text: string): Answer => ({ text, isTextDisplayOnly: true })
  if (sub === '') {
    return shown([
      ...learnedLines(learned),
      '/devloop rules promote <id> makes a trial rule blocking on this machine; /devloop rules drop <id> <reason> removes a rule or a proposal (each a person\'s call).',
    ].join('\n'))
  }
  if (sub === 'promote') {
    const rule = learned.rules.find(one => one.id === id)
    if (rule === undefined || rule.status !== 'trial') {
      return shown(rule === undefined ? `No trial rule ${id}. /devloop rules lists them.` : `${id} is promoted already. Add it to "rules" in devloop.json: ${policyEntry(rule)}`)
    }
    if (cfg.rules.some(one => one.id === id)) {
      await keepLearned($, at.root, { ...learned, rules: learned.rules.filter(one => one.id !== id) })

      return shown(`The policy in force already has a rule "${id}": the state copy is dropped, and the policy's holds.`)
    }
    const hits = rule.seen.length === 0 ? '  (no hit recorded)' : rule.seen.slice(-20).map(one => `  ${one.path}:${one.line}`).join('\n')
    const question = `Promote trial rule ${id} to blocking (refuse) on this machine?\n  pattern: ${rule.pattern}\n  globs: ${rule.when.join(', ')}\n  why: ${rule.why}\n  ${rule.hits} hit${rule.hits === 1 ? '' : 's'} (a hit is a match, not a mistake):\n${hits}`
    if (!(await confirm($, question, 'Promote it', 'Keep it on trial'))) {
      return shown(`${id} stays on trial.`)
    }
    const now = await $.clock.now()
    learned = await learnedNow($, at.root)
    const promoted: LearnedRule = { ...rule, status: 'promoted', promotedAt: now }
    await keepLearned($, at.root, { ...learned, rules: learned.rules.map(one => (one.id === id ? promoted : one)) })
    await audit($, at.root, 'learned-rule-promoted', actorOf(e), id, (await loopOf($)).tree, firstLine(`${rule.pattern} when ${rule.when.join(',')}`, 200))

    return shown([
      `${id} now refuses on this machine, from the harness's state.`,
      'So it holds for everyone, and at the command line and the classic hooks, add this entry to "rules" in devloop.json:',
      policyEntry(promoted),
    ].join('\n'))
  }
  if (sub === 'drop') {
    const reason = words.slice(2).join(' ').trim()
    if (id === '' || reason === '') {
      return shown('Name the rule or proposal and why: /devloop rules drop <id> <reason>.')
    }
    const rule = learned.rules.find(one => one.id === id)
    const proposal = learned.proposals.find(one => one.id === id)
    const group = rule?.group ?? proposal?.group
    if (group === undefined) {
      return shown(`No learned rule or proposal ${id}. /devloop rules lists them.`)
    }
    if (!(await confirm($, `Drop ${rule === undefined ? 'proposal' : `${rule.status} rule`} ${id}? Reason: "${reason}". A tombstone is written, so its failure is not proposed again unless it returns.`, 'Drop it', 'Keep it'))) {
      return shown(`${id} is kept.`)
    }
    const now = await $.clock.now()
    learned = await learnedNow($, at.root)
    await keepLearned($, at.root, { ...learned, rules: learned.rules.filter(one => one.id !== id), proposals: learned.proposals.filter(one => one.id !== id) })
    await $.store.set(`tombstones:${at.root}`, [...(await listOf<Tombstone>($, `tombstones:${at.root}`)), { id: group, evidence: `${id} dropped: ${reason.slice(0, 280)}`, at: now }])
    await audit($, at.root, 'learned-rule-dropped', actorOf(e), id, (await loopOf($)).tree, firstLine(reason, 200))

    return shown(`${id} is dropped, and a tombstone for ${group} is written: ${reason}`)
  }

  return shown('Use /devloop rules, /devloop rules promote <id>, or /devloop rules drop <id> <reason>.')
}
