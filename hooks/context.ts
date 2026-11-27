// What devloop puts into the model's context, as pure functions (DESIGN 4.7,
// C1): hash-keyed deltas under a budget, the cold-start briefing, context
// pressure, the handoff entry, context-cost attribution and the open-questions
// ledger. Nothing here touches `$`; register.tsx and commands.ts gather the
// facts and keep what these return.

import type { Question } from '../types'
import type { Config } from './config'
import { digest } from './output'

// ---------------------------------------------------------------- deltas

/**
 * One source of injected context: a stable key, a label the model reads, a
 * priority (lower is kept first under the budget) and its current text, or
 * null when it has nothing to say. An ephemeral source (the briefing, a
 * pressure note) is said once and goes without a `removed` line.
 */
export type Source = { key: string; label: string; priority: number; text: string | null; isEphemeral?: boolean }

/** What was last emitted in this thread, by source key: its hash and text (the text, for a diff). */
export type Emitted = Record<string, { hash: string; text: string }>

export type DeltaKind = 'initial' | 'changed' | 'removed'

export type Delta = { key: string; kind: DeltaKind; line: string }

/** Rough tokens of a text: characters / 4, labelled an estimate wherever it is shown. */
export const tokensOf = (text: string): number => Math.ceil(text.length / 4)

/** What ends a source sent cut to fit the budget. */
export const CUT_NOTE = '… (cut to fit; the devloop_status tool has the rest)'

/** The least room worth sending a cut source into; with less it waits for the next prompt. */
const MIN_CUT = 120

/** A line diff, `- old` and `+ new`, of two texts. */
export function lineDiff(before: string, after: string): string {
  const old = before.split('\n')
  const now = after.split('\n')

  return [...old.filter(line => !now.includes(line)).map(line => `- ${line}`), ...now.filter(line => !old.includes(line)).map(line => `+ ${line}`)].join('\n')
}

/**
 * The context to attach to a person's prompt: each source as `initial`,
 * `changed` (the new text, or a line diff when that is shorter) or `removed`,
 * and nothing for a source whose hash is what this thread was last sent.
 * `isReset` (a new thread, a compaction) re-emits every source as initial.
 * Over `budgetTokens`, the lower-priority sources are left for later (not
 * recorded as sent) and one line says to call the status tool.
 */
export function deltas(sources: readonly Source[], before: Emitted, budgetTokens: number, isReset: boolean): { text: string | null; emitted: Emitted; deltas: Delta[]; deferred: string[] } {
  const known: Emitted = isReset ? {} : { ...before }
  const pending: (Delta & { priority: number; hash: string | null; text: string | null })[] = []
  for (const source of sources) {
    const prev = known[source.key]
    if (source.text === null || source.text.trim() === '') {
      if (prev !== undefined) {
        if (source.isEphemeral !== true) {
          pending.push({ key: source.key, kind: 'removed', line: `devloop ${source.label}: cleared.`, priority: -1, hash: null, text: null })
        } else {
          delete known[source.key]
        }
      }
      continue
    }
    const hash = digest(source.text)
    if (prev !== undefined && prev.hash === hash) {
      continue
    }
    if (prev === undefined) {
      pending.push({ key: source.key, kind: 'initial', line: `devloop ${source.label}: ${source.text}`, priority: source.priority, hash, text: source.text })
    } else {
      const diff = lineDiff(prev.text, source.text)
      const line = diff.length < source.text.length && diff !== ''
        ? `devloop ${source.label} (changed since last said):\n${diff}`
        : `devloop ${source.label} (changed): ${source.text}`
      pending.push({ key: source.key, kind: 'changed', line, priority: source.priority, hash, text: source.text })
    }
  }
  pending.sort((a, b) => a.priority - b.priority)
  const budget = budgetTokens * 4
  const out: Delta[] = []
  const deferred: string[] = []
  let used = 0
  // Room is kept for the one line that points at the status tool.
  const pointer = 140
  for (const one of pending) {
    const size = one.line.length + 1
    // A source larger than the whole budget would never fit: it is sent cut, pointing at the status tool (F10).
    const isTooLarge = one.kind !== 'removed' && size + pointer > budget
    const room = budget - used - pointer
    if (one.kind === 'removed' || used + size + pointer <= budget || out.length === 0 && size <= budget) {
      out.push({ key: one.key, kind: one.kind, line: one.line })
      used += size
      if (one.kind === 'removed') {
        delete known[one.key]
      } else if (one.hash !== null && one.text !== null) {
        known[one.key] = { hash: one.hash, text: one.text }
      }
    } else if (isTooLarge && room >= MIN_CUT) {
      const cut = `${one.line.slice(0, room - CUT_NOTE.length - 1)}${CUT_NOTE}`
      out.push({ key: one.key, kind: one.kind, line: cut })
      used += cut.length + 1
      if (one.hash !== null && one.text !== null) {
        known[one.key] = { hash: one.hash, text: one.text }
      }
    } else {
      deferred.push(sources.find(source => source.key === one.key)?.label ?? one.key)
    }
  }
  const lines = out.map(one => one.line)
  if (deferred.length > 0) {
    lines.push(`devloop: more has changed (${deferred.join(', ')}) than fits here; call the devloop_status tool to read it.`)
  }

  return { text: lines.length === 0 ? null : lines.join('\n'), emitted: known, deltas: out, deferred }
}

/** The policy facts the builder needs, moved out of the system-prompt section so it stays the same for a thread. */
export function policyFacts(cfg: Config, mode: 'enforce' | 'observe'): string {
  const fast = cfg.verify.filter(one => one.profile === 'fast').map(one => `\`${one.run}\``)
  const full = cfg.verify.filter(one => one.profile === 'full').map(one => `\`${one.run}\``)
  const parts = [
    fast.length > 0 ? `when you stop after changing files the harness runs ${fast.join(', ')}; run them yourself first.` : 'no verify commands are set in devloop.json: say so in your report.',
    full.length > 0 ? `Before anything ships it also runs ${full.join(', ')}.` : '',
    cfg.network !== null ? `Shell commands reach only these hosts: ${cfg.network.allow.join(', ') || 'none'} (and loopback).` : '',
    mode === 'observe' ? 'The guards are in observe mode: they record what they would refuse.' : '',
  ]

  return parts.filter(part => part !== '').join(' ')
}

// ---------------------------------------------------------------- the cold-start briefing

export type BriefFacts = {
  /** The last lines of the handoff record (kept in the harness's state), newest last. */
  handoffTail: readonly string[]
  phase: 'idle' | 'spec' | 'build'
  spec: string | null
  ready: readonly string[]
  failing: readonly string[]
  /** The last failure's first line: the check and what it said first. */
  lastFailure: string | null
  /** Open findings that await a person's decision. */
  decisions: readonly string[]
  questions: readonly Question[]
  /** The other sessions' claims (D2), as `claimLines` words them; empty (and unsaid) when no other session holds one. */
  claims?: readonly string[]
}

/** About three hundred tokens at most. */
export const BRIEFING_CHARS = 1200

/** What a session that starts cold on an open change is told once, bounded. */
export function briefing(facts: BriefFacts): string {
  const list = (items: readonly string[], cap = 6): string => `${items.slice(0, cap).join(', ')}${items.length > cap ? ', …' : ''}`
  const lines = [
    `you are starting cold on ${facts.phase === 'idle' ? 'an open small fix' : facts.phase === 'spec' ? `the spec "${facts.spec ?? ''}" (not approved yet)` : `the approved spec "${facts.spec ?? ''}"`}.`,
    facts.ready.length > 0 ? `Ready to build: ${list(facts.ready)}.` : '',
    facts.failing.length > 0 ? `Failing or not built: ${list(facts.failing)}.` : '',
    ...(facts.claims ?? []),
    facts.lastFailure !== null ? `Last failure: ${facts.lastFailure.slice(0, 160)}` : '',
    facts.decisions.length > 0 ? `Findings awaiting a person (not yours to act on): ${list(facts.decisions)}.` : '',
    facts.questions.length > 0 ? `Open questions for a person: ${facts.questions.slice(0, 3).map(one => `${one.id} ${one.question.slice(0, 80)}`).join('; ')}${facts.questions.length > 3 ? '; …' : ''}.` : '',
    facts.handoffTail.length > 0 ? `The end of the last handoff:\n${facts.handoffTail.join('\n')}` : 'No handoff was written: read the last few commits before you start.',
  ]
  const text = lines.filter(line => line !== '').join('\n')

  return text.length > BRIEFING_CHARS ? `${text.slice(0, BRIEFING_CHARS - 1)}…` : text
}

/** The last non-empty lines of a file, each cut to a line's width. */
export const tailLines = (text: string, count = 6): string[] =>
  text.split('\n').map(line => line.trimEnd()).filter(line => line.trim() !== '').slice(-count).map(line => (line.length > 160 ? `${line.slice(0, 159)}…` : line))

// ---------------------------------------------------------------- context pressure

/**
 * The two levels, in tokens remaining. Set in policy they are taken as given;
 * by default they scale with the window: warn when 30% of it remains or
 * 300,000 tokens are in use, whichever comes first; save when 15% remains or
 * 400,000 are in use. The cap in use keeps a large window from waiting until
 * it is nearly full (on a million-token window, 15% is still 150,000 left).
 */
export function pressureLevels(window: number, cfg: Pick<Config, 'context'>): { warn: number; save: number } {
  const warn = cfg.context.warnRemaining ?? Math.max(Math.round(window * 0.3), window - 300_000)
  const save = cfg.context.saveRemaining ?? Math.max(Math.round(window * 0.15), window - 400_000)

  return { warn, save: Math.min(save, warn) }
}

export type Pressure = 0 | 1 | 2

/** 0 below the warn level, 1 at warn, 2 at save; 0 when the window or the tokens are unknown. */
export function pressureOf(tokens: number | undefined, window: number, levels: { warn: number; save: number }): Pressure {
  if (tokens === undefined || !(window > 1)) {
    return 0
  }
  const remaining = window - tokens

  return remaining <= levels.save ? 2 : remaining <= levels.warn ? 1 : 0
}

/** The level last said and the tool call it was said at. */
export type PressureState = { level: Pressure; at: number }

/**
 * Whether to say a level now: at once on escalation, again at the same
 * level only after `every` tool calls, never on the way down (a compaction
 * lowers it, and the next rise is said again).
 */
export function pressureStep(state: PressureState, level: Pressure, calls: number, every: number): { say: Pressure; state: PressureState } {
  if (level < state.level) {
    return { say: 0, state: { level, at: calls } }
  }
  if (level > state.level || (level > 0 && calls - state.at >= every)) {
    return { say: level, state: { level, at: calls } }
  }

  return { say: 0, state }
}

/** What the builder is told at each level. */
export function pressureNote(level: Pressure, remaining: number): string {
  return level === 2
    ? `context is nearly full (about ${remaining} tokens left): call the devloop_handoff tool now with the objective, decisions, work state, dead ends, assumptions and next step, then finish the step you are on.`
    : `context is filling (about ${remaining} tokens left): finish the step you are on and do not start a new feature; the person may start a fresh session from a handoff.`
}

// ---------------------------------------------------------------- the handoff entry

export type HandoffInput = {
  objective: string
  decisions: string[]
  workState: string
  deadEnds: string[]
  assumptions: { assumption: string; command: string }[]
  nextStep: string
  files: string[]
}

const text = (v: unknown, cap: number): string => (typeof v === 'string' ? v.trim().replace(/\s+\n/g, '\n').slice(0, cap) : '')
const texts = (v: unknown, count: number, cap: number): string[] => (Array.isArray(v) ? v.map(one => text(one, cap)).filter(one => one !== '').slice(0, count) : [])

/** Reads the handoff tool's input strictly: missing required fields are named; lists are capped (files at 15). */
export function readHandoff(raw: Record<string, unknown>): { input: HandoffInput; problems: string[] } {
  const problems: string[] = []
  const objective = text(raw.objective, 600)
  const nextStep = text(raw.nextStep, 600)
  if (objective === '') {
    problems.push('objective is required')
  }
  if (nextStep === '') {
    problems.push('nextStep is required')
  }
  const files = texts(raw.files, 1000, 200)
  if (files.length > 15) {
    problems.push(`files: ${files.length} given, at most 15 are kept`)
  }
  const assumptions = Array.isArray(raw.assumptions)
    ? raw.assumptions.flatMap((one: unknown) => {
        const item = (typeof one === 'object' && one !== null ? one : {}) as Record<string, unknown>
        const assumption = text(item.assumption, 300)
        const command = text(item.command, 300)
        if (assumption !== '' && command === '') {
          problems.push(`the assumption "${assumption.slice(0, 40)}" has no command that would verify it`)
        }

        return assumption === '' ? [] : [{ assumption, command }]
      }).slice(0, 10)
    : []

  return {
    input: {
      objective, nextStep, assumptions,
      decisions: texts(raw.decisions, 10, 300),
      workState: text(raw.workState, 1200),
      deadEnds: texts(raw.deadEnds, 10, 300),
      files: files.slice(0, 15),
    },
    problems,
  }
}

/** What the harness itself states in a handoff: from its state and git, never from the model. */
export type HandoffFacts = {
  time: string
  phase: 'idle' | 'spec' | 'build'
  spec: string | null
  features: { passing: number; total: number; ready: readonly string[]; failing: readonly string[] }
  findings: readonly string[]
  lastFailure: string | null
  changed: readonly string[]
  commits: readonly string[]
  tree: string | null
}

const bullets = (items: readonly string[]): string => items.map(one => `- ${one}`).join('\n')

/** One handoff entry as it is appended: the harness's facts first, then (from the builder) the narrative. */
export function handoffEntry(by: 'builder' | 'person', facts: HandoffFacts, input: HandoffInput | null): string {
  const cap = (items: readonly string[], n = 10): string => (items.length === 0 ? 'none' : `${items.slice(0, n).join(', ')}${items.length > n ? `, and ${items.length - n} more` : ''}`)
  const factLines = [
    `- Phase: ${facts.phase === 'idle' ? 'small fix (no spec)' : `${facts.phase} "${facts.spec ?? ''}"`}`,
    facts.features.total > 0 ? `- Features: ${facts.features.passing}/${facts.features.total} passing; ready: ${cap(facts.features.ready)}; failing or not built: ${cap(facts.features.failing)}` : '',
    `- Open findings: ${cap(facts.findings)}`,
    `- Last failure: ${facts.lastFailure ?? 'none'}`,
    `- Changed files: ${cap(facts.changed, 15)}`,
    facts.commits.length > 0 ? `- Recent commits:\n${facts.commits.map(one => `  - ${one}`).join('\n')}` : '',
    `- Tree: ${facts.tree === null ? 'not a git repository' : facts.tree.slice(0, 12)}`,
  ].filter(line => line !== '')
  const parts = [`## Handoff ${facts.time} (${by === 'builder' ? 'written by the builder; facts by the harness' : 'facts only, by the harness'})`, '', 'Facts (from the harness):', ...factLines]
  if (input !== null) {
    parts.push(
      '',
      `Objective: ${input.objective}`,
      input.decisions.length > 0 ? `Decisions:\n${bullets(input.decisions)}` : '',
      input.workState !== '' ? `Work state: ${input.workState}` : '',
      input.deadEnds.length > 0 ? `Dead ends:\n${bullets(input.deadEnds)}` : '',
      input.assumptions.length > 0 ? `Assumptions to verify:\n${bullets(input.assumptions.map(one => `${one.assumption} (verify: \`${one.command || 'no command given'}\`)`))}` : '',
      `Next step: ${input.nextStep}`,
      input.files.length > 0 ? `Files:\n${bullets(input.files)}` : '',
    )
  }

  return `${parts.filter(part => part !== '').join('\n').replace(/\n(Objective|Decisions|Work state|Dead ends|Assumptions|Next step|Files)/g, '\n\n$1').replace(/\n\n\n+/g, '\n\n')}\n`
}

/** The handoff record with an entry appended, a blank line between. */
export const appendEntry = (before: string, entry: string): string =>
  before.trim() === '' ? entry : `${before.replace(/\s*$/, '')}\n\n${entry}`

/** The handoff record's entries, oldest first: each from its `## Handoff` heading to the next. */
export function handoffEntries(text: string): string[] {
  return text.split(/\n(?=## Handoff )/).map(one => one.trim()).filter(one => one.startsWith('## Handoff ')).map(one => `${one}\n`)
}

// ---------------------------------------------------------------- the idle gap

/** Whether a prompt after a pause will write the cache again at a size worth warning about. */
export function isIdleGap(lastResponseAt: number | null, now: number, tokens: number | undefined, cfg: Pick<Config, 'cache' | 'context'>): boolean {
  return lastResponseAt !== null && now - lastResponseAt > cfg.cache.ttlMinutes * 60_000 && tokens !== undefined && tokens > cfg.context.idleWarnTokens
}

// ---------------------------------------------------------------- context-cost attribution

/** Estimated tokens each tool and each file put into the session's context, from the results' sizes. */
export type Attribution = {
  sessionId: string | null
  tools: Record<string, { calls: number; tokens: number }>
  files: Record<string, { reads: number; tokens: number }>
}

export const EMPTY_ATTRIBUTION: Attribution = { sessionId: null, tools: {}, files: {} }

/** Adds one tool result: its tool, the file it read (if any) and how many characters the model was given. */
export function attribute(state: Attribution, sessionId: string | null, tool: string, file: string | null, chars: number): Attribution {
  const base = state.sessionId === sessionId ? state : { ...EMPTY_ATTRIBUTION, sessionId }
  const tokens = Math.ceil(chars / 4)
  const tools = { ...base.tools, [tool]: { calls: (base.tools[tool]?.calls ?? 0) + 1, tokens: (base.tools[tool]?.tokens ?? 0) + tokens } }
  // Only so many files are kept: the smallest go first.
  let files = file === null ? base.files : { ...base.files, [file]: { reads: (base.files[file]?.reads ?? 0) + 1, tokens: (base.files[file]?.tokens ?? 0) + tokens } }
  if (Object.keys(files).length > 200) {
    files = Object.fromEntries(Object.entries(files).sort((a, b) => b[1].tokens - a[1].tokens).slice(0, 150))
  }

  return { sessionId, tools, files }
}

/** The top tools and files by estimated tokens, labelled an estimate. */
export function attributionReport(state: Attribution, top = 5): string[] {
  const tools = Object.entries(state.tools).sort((a, b) => b[1].tokens - a[1].tokens).slice(0, top)
  const files = Object.entries(state.files).sort((a, b) => b[1].tokens - a[1].tokens).slice(0, top)
  if (tools.length === 0) {
    return ['Context cost: no tool results observed this session yet.']
  }

  return [
    'Context cost this session (an estimate: result characters / 4, main conversation only):',
    `  top tools: ${tools.map(([name, one]) => `${name} ~${one.tokens} tokens in ${one.calls} call${one.calls === 1 ? '' : 's'}`).join('; ')}`,
    files.length > 0 ? `  top files: ${files.map(([name, one]) => `${name} ~${one.tokens} tokens in ${one.reads} read${one.reads === 1 ? '' : 's'}`).join('; ')}` : '  top files: none read',
  ]
}

// ---------------------------------------------------------------- open questions

/** At most this many questions per turn: a struggling builder cannot flood the ledger. */
export const QUESTIONS_PER_TURN = 3

export const openQuestions = (list: readonly Question[]): Question[] => list.filter(one => one.status === 'open')

/** Adds an open question; its id is the next `Q<n>`. */
export function addQuestion(list: readonly Question[], question: string, context: string | null, at: number): { list: Question[]; id: string } {
  const next = 1 + list.reduce((max, one) => Math.max(max, Number(one.id.slice(1)) || 0), 0)
  const id = `Q${next}`

  return { list: [...list, { id, question, context, at, status: 'open' as const, answer: null }].slice(-200), id }
}

/** Closes one open question with a person's answer; null when there is no open question by that id. */
export function closeQuestion(list: readonly Question[], id: string, answer: string): Question[] | null {
  const found = list.find(one => one.id.toLowerCase() === id.toLowerCase() && one.status === 'open')

  return found === undefined ? null : list.map(one => (one === found ? { ...one, status: 'closed' as const, answer } : one))
}

/** The ledger as /devloop questions lists it. */
export function questionsReport(list: readonly Question[]): string {
  const open = openQuestions(list)
  const closed = list.filter(one => one.status === 'closed').slice(-5)

  return [
    `Open questions (${open.length}):`,
    ...open.map(one => `  ${one.id} ${one.question}${one.context !== null ? ` (context: ${one.context})` : ''}`),
    ...(open.length > 0 ? ['  /devloop questions close <id> <answer> closes one.'] : []),
    `Recently closed (${closed.length}):`,
    ...closed.map(one => `  ${one.id} ${one.question} -> ${one.answer ?? ''}`),
  ].join('\n')
}
