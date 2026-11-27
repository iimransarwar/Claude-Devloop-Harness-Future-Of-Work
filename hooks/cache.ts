// The cache-health meter (DESIGN 4.7, C1): from each main-loop turn's usage
// as the API counted it, the hit rate per session and per change, and a miss
// with its probable cause. Pure: no `$`. Causes are inferred, never known:
// the engine reports token counts, not why a prefix was written again.

/** One meter: the API's counts summed over turns. */
export type Meter = { turns: number; input: number; cacheRead: number; cacheCreation: number; output: number }

export const EMPTY_METER: Meter = { turns: 0, input: 0, cacheRead: 0, cacheCreation: 0, output: 0 }

/** The part of a turn's usage the meter reads (ModelUsage plus the model, as TurnUsage carries it). */
export type Usage = {
  input_tokens: number
  output_tokens: number
  cache_read_input_tokens: number
  cache_creation_input_tokens: number
  model: string
}

/** Why a turn wrote a large prefix again, as the harness infers it. `first-turn` is the thread's first write, no miss. */
export type MissCause = 'first-turn' | 'idle-gap' | 'model-change' | 'compaction' | 'devloop-change' | 'unknown'

export type Miss = { at: number; tokens: number; cause: MissCause; detail: string }

/** What the meter keeps between turns. */
export type CacheState = {
  /** The session the `session` meter counts; another id starts it over. */
  sessionId: string | null
  session: Meter
  /** The change in progress; started over at /devloop done. */
  change: Meter
  /** When the last main-loop response ended, its model, and devloop's own prefix (section and tools) then. */
  last: { at: number; model: string; prefix: string } | null
  /** A compaction since the last turn. */
  isCompacted: boolean
  /** The last misses, newest last. */
  misses: Miss[]
}

export const EMPTY_CACHE: CacheState = { sessionId: null, session: EMPTY_METER, change: EMPTY_METER, last: null, isCompacted: false, misses: [] }

const add = (meter: Meter, usage: Usage): Meter => ({
  turns: meter.turns + 1,
  input: meter.input + usage.input_tokens,
  cacheRead: meter.cacheRead + usage.cache_read_input_tokens,
  cacheCreation: meter.cacheCreation + usage.cache_creation_input_tokens,
  output: meter.output + usage.output_tokens,
})

/** The share of input tokens the cache served, 0 to 1; null before any input. */
export function hitRate(meter: Meter): number | null {
  const all = meter.input + meter.cacheRead + meter.cacheCreation

  return all === 0 ? null : meter.cacheRead / all
}

export type TurnFacts = {
  usage: Usage
  /** When the turn ended, and how long it ran: it began at `at - durationMs`. */
  at: number
  durationMs: number
  sessionId: string | null
  /** A hash of devloop's own part of the prefix this turn: its section and its tools. */
  prefix: string
  missTokens: number
  ttlMinutes: number
}

/**
 * The probable cause of a turn that wrote more than the miss threshold, in
 * order: the thread's first turn (no miss); devloop's own prefix changed (a
 * bug: the section and tools are fixed for a thread); the model changed; a
 * compaction; an idle gap past the cache's lifetime; otherwise unknown.
 */
export function missCause(state: CacheState, facts: TurnFacts): { cause: MissCause; detail: string } {
  const { last } = state
  const isNewSession = state.sessionId !== facts.sessionId
  if (last === null || isNewSession) {
    return { cause: 'first-turn', detail: 'the first turn of this thread writes its prefix' }
  }
  if (last.prefix !== facts.prefix) {
    return { cause: 'devloop-change', detail: 'devloop\'s system-prompt section or tool list differs from the previous turn\'s' }
  }
  if (last.model !== facts.usage.model) {
    return { cause: 'model-change', detail: `the model changed (${last.model} to ${facts.usage.model})` }
  }
  if (state.isCompacted) {
    return { cause: 'compaction', detail: 'the conversation was compacted since the last turn' }
  }
  const gap = facts.at - facts.durationMs - last.at
  if (gap > facts.ttlMinutes * 60_000) {
    return { cause: 'idle-gap', detail: `${Math.round(gap / 60_000)} minutes passed since the last response, past the cache's ${facts.ttlMinutes}-minute lifetime` }
  }

  return { cause: 'unknown', detail: 'none of the causes the harness can see' }
}

/** Folds one main-loop turn into the meter; `miss` is set when the turn wrote past the threshold (never on the first turn). */
export function meterTurn(state: CacheState, facts: TurnFacts): { state: CacheState; miss: Miss | null } {
  const isNewSession = state.sessionId !== facts.sessionId
  const base = isNewSession ? { ...state, sessionId: facts.sessionId, session: EMPTY_METER } : state
  const written = facts.usage.cache_creation_input_tokens
  let miss: Miss | null = null
  if (written > facts.missTokens) {
    const { cause, detail } = missCause(state, facts)
    if (cause !== 'first-turn') {
      miss = { at: facts.at, tokens: written, cause, detail }
    }
  }

  return {
    state: {
      ...base,
      session: add(base.session, facts.usage),
      change: add(base.change, facts.usage),
      last: { at: facts.at, model: facts.usage.model, prefix: facts.prefix },
      isCompacted: false,
      misses: miss === null ? base.misses : [...base.misses, miss].slice(-20),
    },
    miss,
  }
}

const percent = (rate: number | null): string => (rate === null ? 'no input yet' : `${Math.round(rate * 100)}% served from cache`)

const meterLine = (label: string, meter: Meter): string =>
  `${label}: ${meter.turns} turn${meter.turns === 1 ? '' : 's'}, ${meter.input + meter.cacheRead + meter.cacheCreation} input tokens (${meter.cacheRead} read from cache, ${meter.cacheCreation} written to it), ${percent(hitRate(meter))}`

/** The meter as /devloop metrics and the status tool's detail show it. Causes are labelled inferred. */
export function cacheReport(state: CacheState): string[] {
  return [
    'Prompt cache (token counts as the API reported them):',
    `  ${meterLine('this session', state.session)}`,
    `  ${meterLine('this change', state.change)}`,
    ...(state.misses.length === 0
      ? ['  no cache misses recorded']
      : [`  cache misses (cause inferred, not known): ${state.misses.slice(-5).map(one => `${one.tokens} tokens re-written, ${one.cause}: ${one.detail}`).join('; ')}`]),
  ]
}
