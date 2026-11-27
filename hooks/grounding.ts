// Grounding (docs/design-notes/grounding.md, DESIGN 4.15): an answer about the
// state of things is checked at the source, in the turn it is given. The two
// pure functions every enforcement point shares: whether a person's prompt is
// a question of fact, and whether a tool call is a look at the source. The
// module counts its own calls with `isLook`; the classic Stop hook counts the
// calls a transcript records with the same function. Pure: no `$`, no Node.

import type { Config } from './config'
import { readings } from './shell'

/** Whether the backstop refuses (`enforce`), only tells the person (`observe`), or is off. */
export type GroundingMode = 'off' | 'observe' | 'enforce'

/** The one line added to the context of a turn whose prompt is a question of fact. */
export const NUDGE = 'This is a question about the state of things: check the source before answering, and say what you checked.'

/** What the stop is refused with, once per turn, in enforce mode. */
export const REFUSAL = 'You were asked a question about the state of things and answered without looking at anything in this turn. Check the source now (read the files, run the query, list the components), then answer and say what you checked. If nothing can be checked (an opinion, a general explanation), say that in one line and stop again.'

/** What the person is told when an answer to a question of fact was given with no look at any source. */
export const UNCHECKED = 'This answer was given without checking anything'

/** The mode in force: the policy's `grounding.mode`, or, left out, the policy's own mode. */
export function groundingMode(cfg: Config): GroundingMode {
  // A hint by default, never a refused stop: refusing costs a whole turn. Set "enforce" to refuse once.
  return cfg.grounding.mode ?? (cfg.mode === 'enforce' ? 'observe' : cfg.mode)
}

/** The words that open a question, after any greeting. */
const OPENERS = ['does', 'do', 'did', 'is', 'are', 'was', 'were', 'has', 'have', 'had', 'can', 'could', 'will', 'would', 'should', 'what', 'which', 'who', 'whose', 'where', 'when', 'why', 'how']

/** The phrases that ask for a check, wherever they stand. */
const CHECKING = ['confirm', 'verify', 'double check', 'double-check', 'make sure', 'are you sure', 'is it true', 'check whether', 'check if', 'did you', 'have you']

/** Greetings and fillers a question may open with ("hi, does …", "ok so is …"). */
const GREETING = /^(?:(?:hi|hello|hey|thanks|thank you|ok|okay|so|and|also|quick question|good (?:morning|afternoon|evening)|please)\b[\s,.!:;\u2013\u2014-]*)+/i

/** A question mark that ends a sentence: before whitespace, the end, or closing punctuation (not `?q=` in a URL). */
const QUESTION_MARK = /\?(?=$|[\s"')\]}*_`>])/

/** A pattern from `grounding.also` or `grounding.never`: a case-insensitive regular expression (one that does not compile was refused by the policy reader). */
const matches = (pattern: string, text: string): boolean => {
  try {
    return new RegExp(pattern, 'i').test(text)
  } catch {
    return false
  }
}

/**
 * Whether a person's prompt is a question of fact (decision 2): a question
 * mark ending a sentence, an opening interrogative or auxiliary word after
 * any greeting, or one of the checking phrases; `also` adds patterns and
 * `never` removes prompts. A slash command is none. The caller passes only
 * prompts a person typed (not a harness or hook message).
 */
export function isQuestionOfFact(prompt: string, also: readonly string[] = [], never: readonly string[] = []): boolean {
  const text = prompt.trim()
  if (text === '' || text.startsWith('/')) {
    return false
  }
  if (never.some(pattern => matches(pattern, text))) {
    return false
  }
  if (also.some(pattern => matches(pattern, text))) {
    return true
  }
  if (QUESTION_MARK.test(text)) {
    return true
  }
  const opening = text.replace(GREETING, '').match(/^[A-Za-z']+/)?.[0]?.toLowerCase() ?? ''
  if (OPENERS.includes(opening)) {
    return true
  }
  const lower = text.toLowerCase().replace(/\s+/g, ' ')

  return CHECKING.some(phrase => new RegExp(`(?:^|[^a-z])${phrase.replace(/[-]/g, '[- ]?')}(?:$|[^a-z])`).test(lower))
}

/** The prompt's first line, cut, as the Activity tab and the audit trail show it. */
export function firstLine(prompt: string): string {
  const line = prompt.trim().split('\n')[0] ?? ''

  return line.length > 120 ? `${line.slice(0, 119)}…` : line
}

/** Wording that marks a guess (decision 5). */
const HEDGES = ['from memory', 'as far as i recall', 'as far as i remember', 'i believe', 'i assume', 'probably', 'should be', 'likely', 'presumably']

/** The first wording in an answer that marks a guess, as written there; null with none. */
export function hedgeIn(answer: string): string | null {
  const lower = answer.toLowerCase()
  let best: { at: number; length: number } | null = null
  for (const phrase of HEDGES) {
    const found = new RegExp(`(?:^|[^a-z])(${phrase})(?:$|[^a-z])`).exec(lower)
    if (found !== null) {
      const at = found.index + found[0].indexOf(found[1] ?? '')
      if (best === null || at < best.at) {
        best = { at, length: phrase.length }
      }
    }
  }

  return best === null ? null : answer.slice(best.at, best.at + best.length)
}

/** A tool call as a point sees it: the tool's name and its input. */
export type ToolUse = { tool: string; input: Readonly<Record<string, unknown>> }

/** Tools that read the source. */
const READERS = ['Read', 'Grep', 'Glob', 'LS', 'NotebookRead', 'WebFetch', 'WebSearch']

/** Tools that change the tree: work, which counts as a look (the ordinary gate judges such a turn). */
const WORK = ['Edit', 'Write', 'MultiEdit', 'NotebookEdit']

/** Tools that start an agent: what it does is its own calls, which the module counts as they come. */
const AGENTS = ['Agent', 'Task']

/** The harness's own tools that read the tree or run checks. */
const HARNESS_LOOKS = ['mcp__devloop__devloop_status', 'mcp__devloop__feature_check']

/** Programs that look at nothing: they print, wait, move or write. */
const NO_LOOK = ['echo', 'printf', 'sleep', 'true', 'false', ':', 'cd', 'pushd', 'popd', 'export', 'unset', 'set', 'exit', 'wait', 'clear', 'mkdir', 'touch', 'rm', 'rmdir', 'mv', 'ln', 'chmod', 'chown', 'tee', 'yes', 'read']

/**
 * Whether one tool call is a look at the source (decision 3): a read, a
 * search, a fetch, an MCP tool other than the harness's own (its status and
 * feature check do count), an agent started, an edit or write (work), or a
 * shell command the shell model reads as running something that reads or
 * checks (not `echo`, `sleep`, `true`, a bare assignment, or a line that only
 * writes).
 */
export function isLook(call: ToolUse): boolean {
  const tool = call.tool
  if (READERS.includes(tool) || WORK.includes(tool) || AGENTS.includes(tool) || HARNESS_LOOKS.includes(tool)) {
    return true
  }
  if (tool.startsWith('mcp__')) {
    return !tool.startsWith('mcp__devloop__')
  }
  if (tool !== 'Bash' && tool !== 'Monitor' && tool !== 'PowerShell') {
    return false
  }
  const command = typeof call.input.command === 'string' ? call.input.command : ''

  // A look under both readings (BB1): it answers the backstop, so it holds only where both readings find one.
  return readings(command).every(segments => segments.some(segment => {
    const program = segment.program
    if (program === null || NO_LOOK.includes(program)) {
      return false
    }
    // `cat > file <<EOF`: it reads only its own heredoc, and writes.
    return !(program === 'cat' && segment.reads.length === 0 && segment.writes.length > 0)
  }))
}

/** How many of the calls are looks at the source. */
export function looksIn(calls: readonly ToolUse[]): number {
  return calls.filter(isLook).length
}

/** What the backstop knows at a stop (decision 4). */
export type BackstopFacts = {
  mode: GroundingMode
  /** The turn began with a person's question of fact. */
  isQuestion: boolean
  /** Looks at the source in this turn, by the main agent or an agent it started. */
  looks: number
  /** The turn changed the tree: the ordinary gate judges it. */
  isTreeChanged: boolean
  /** `fresh: "tree"`: a look in an earlier turn on the tree as it is now. */
  isFreshLook: boolean
  /** The stop was already refused for this in this turn. */
  isRefused: boolean
  /** The final answer's text. */
  answer: string
}

export type BackstopVerdict =
  | { action: 'pass' }
  | { action: 'refuse'; reason: string }
  /** No refusal: the person is told, quoting the guess if the answer holds one, and it is recorded. */
  | { action: 'report'; toast: string; hedge: string | null }

/**
 * The backstop's verdict (decision 4): nothing for a turn that is no question
 * of fact, held a look, changed the tree or (fresh "tree") rests on an earlier
 * look on this tree; else, once per turn in enforce mode, a refusal; else a
 * report to the person, quoting wording that marks a guess.
 */
export function backstop(facts: BackstopFacts): BackstopVerdict {
  if (facts.mode === 'off' || !facts.isQuestion || facts.looks > 0 || facts.isTreeChanged || facts.isFreshLook) {
    return { action: 'pass' }
  }
  if (facts.mode === 'enforce' && !facts.isRefused) {
    return { action: 'refuse', reason: REFUSAL }
  }
  const hedge = hedgeIn(facts.answer)

  return { action: 'report', toast: `${UNCHECKED}${hedge === null ? '.' : `: it says "${hedge}".`}`, hedge }
}

// ---------------------------------------------------------------- the transcript (the classic Stop hook)

/** One line of a session transcript, as far as the reader needs it. */
type Line = {
  type?: unknown
  isMeta?: unknown
  isSidechain?: unknown
  toolUseResult?: unknown
  origin?: { kind?: unknown } | null
  rowSource?: unknown
  message?: { role?: unknown; content?: unknown }
}

/** The last turn a transcript records: whether a person started it, the prompt, and the tool calls after it. */
export type TranscriptTurn = { isPerson: boolean; prompt: string; calls: ToolUse[] }

/** The text of a user entry's content, or null when it carries a tool result (not a prompt). */
function promptText(content: unknown): string | null {
  if (typeof content === 'string') {
    return content
  }
  if (!Array.isArray(content)) {
    return null
  }
  const blocks = content.filter((one): one is { type?: unknown; text?: unknown } => typeof one === 'object' && one !== null)
  if (blocks.some(one => one.type === 'tool_result')) {
    return null
  }

  return blocks.filter(one => one.type === 'text' && typeof one.text === 'string').map(one => one.text as string).join('\n')
}

/** Text the harness or the engine put in a user entry: a slash command's record, a notification, a reminder. */
const MACHINE_TEXT = /^\s*<(?:command-name|command-message|local-command|task-notification|system-reminder|user-prompt-submit-hook|bash-input|bash-stdout)/

/**
 * Reads a session transcript (JSON lines) back to the start of its last turn
 * (decision 6): the last user entry that is not a tool result or an injected
 * message. A person started it when it came from the composer or the SDK
 * (`origin.kind` "human", or no origin on an older line) and is not a slash
 * command or machine text. The calls are the `tool_use` blocks of the main
 * conversation's assistant entries after it. Null when the text holds no
 * readable turn.
 */
export function lastTurn(text: string): TranscriptTurn | null {
  const lines: Line[] = []
  for (const raw of text.split('\n')) {
    if (raw.trim() === '') {
      continue
    }
    try {
      const value = JSON.parse(raw) as unknown
      if (typeof value === 'object' && value !== null) {
        lines.push(value as Line)
      }
    } catch {
      // A line cut short (the engine still writing) is skipped.
    }
  }
  let start = -1
  let prompt = ''
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i] as Line
    if (line.type !== 'user' || line.isMeta === true || line.isSidechain === true || line.toolUseResult !== undefined) {
      continue
    }
    const said = promptText(line.message?.content)
    if (said !== null) {
      start = i
      prompt = said
      break
    }
  }
  if (start < 0) {
    return null
  }
  const first = lines[start] as Line
  const origin = first.origin
  const isFromPerson = origin === undefined || origin === null ? first.rowSource === undefined || first.rowSource === null : origin.kind === 'human'
  const isPerson = isFromPerson && !MACHINE_TEXT.test(prompt) && !prompt.trim().startsWith('/')
  const calls: ToolUse[] = []
  for (const line of lines.slice(start + 1)) {
    if (line.type !== 'assistant' || line.isSidechain === true || !Array.isArray(line.message?.content)) {
      continue
    }
    for (const block of line.message.content as unknown[]) {
      if (typeof block === 'object' && block !== null && (block as { type?: unknown }).type === 'tool_use') {
        const use = block as { name?: unknown; input?: unknown }
        calls.push({ tool: typeof use.name === 'string' ? use.name : '', input: typeof use.input === 'object' && use.input !== null ? (use.input as Record<string, unknown>) : {} })
      }
    }
  }

  return { isPerson, prompt, calls }
}
