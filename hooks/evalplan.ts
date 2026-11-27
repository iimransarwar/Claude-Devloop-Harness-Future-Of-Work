// The eval suite's decisions as pure functions (C2, DESIGN 4.8; skills note
// 3; rea note 4, 5; nanochat note 2, 4, 5): reading a task file, the quick
// subset, trials and consistency, trajectory assertions, what a run does
// next and when it may stop early, the noise band of an ablation, comparing
// two runs on the tasks that did not change, the difficulty band, and the
// cost projection. Pure: no `$`.

import { digest } from './output'

/** What a task may assert about what the agent did (skills note 3, rea note 4). */
export type Expect = {
  /** Tools or skills that must appear among the agent's calls. */
  mustUse?: string[]
  /** Tools or skills that must not appear. */
  mustNotUse?: string[]
  /** Tools or skills that must appear in this order (others may come between). */
  order?: string[]
  maxToolCalls?: number
  /** A negative task: the right outcome is that no guard fired (observed refusals count). */
  noRefusal?: boolean
  /** A negative task: this guard rule must have fired. */
  refusal?: string
}

export type EvalTask = {
  prompt: string
  check: string
  /** A command run in the fresh worktree before the agent starts (and after each reset). */
  setup: string | null
  /** A patch (unified diff) or a command that makes the check pass: the witness's second stage. */
  solution: string | null
  /** A patch or command that comes close but must still fail the check. */
  nearMiss: string | null
  expect: Expect | null
  tags: string[]
}

const isStrings = (v: unknown): v is string[] => Array.isArray(v) && v.every(one => typeof one === 'string')

/** Reads a task file: the task, or the problems that keep it out of every run. */
export function parseTask(text: string): { task: EvalTask | null; problems: string[] } {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return { task: null, problems: ['not valid JSON'] }
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { task: null, problems: ['not one JSON object'] }
  }
  const r = raw as Record<string, unknown>
  const problems: string[] = []
  const known = ['prompt', 'check', 'setup', 'solution', 'nearMiss', 'expect', 'tags', 'source', '$schema']
  problems.push(...Object.keys(r).filter(key => !known.includes(key)).map(key => `${key}: unknown field`))
  if (typeof r.prompt !== 'string' || r.prompt.trim() === '') {
    problems.push('prompt: expected the text to give the agent')
  }
  if (typeof r.check !== 'string' || r.check.trim() === '') {
    problems.push('check: expected a command that exits 0 on success')
  }
  const optional = (key: string): string | null => {
    if (r[key] === undefined) {
      return null
    }
    if (typeof r[key] !== 'string' || (r[key] as string).trim() === '') {
      problems.push(`${key}: expected a patch or a command`)

      return null
    }

    return r[key] as string
  }
  const setup = optional('setup')
  const solution = optional('solution')
  const nearMiss = optional('nearMiss')
  let expect: Expect | null = null
  if (r.expect !== undefined) {
    const e = r.expect
    if (typeof e !== 'object' || e === null || Array.isArray(e)) {
      problems.push('expect: expected { mustUse?, mustNotUse?, order?, maxToolCalls?, noRefusal?, refusal? }')
    } else {
      const x = e as Record<string, unknown>
      problems.push(...Object.keys(x).filter(key => !['mustUse', 'mustNotUse', 'order', 'maxToolCalls', 'noRefusal', 'refusal'].includes(key)).map(key => `expect.${key}: unknown field`))
      for (const key of ['mustUse', 'mustNotUse', 'order']) {
        if (x[key] !== undefined && !isStrings(x[key])) {
          problems.push(`expect.${key}: expected a list of tool or skill names`)
        }
      }
      if (x.maxToolCalls !== undefined && (typeof x.maxToolCalls !== 'number' || !Number.isInteger(x.maxToolCalls) || x.maxToolCalls < 0)) {
        problems.push('expect.maxToolCalls: expected a whole number')
      }
      if (x.noRefusal !== undefined && typeof x.noRefusal !== 'boolean') {
        problems.push('expect.noRefusal: expected true or false')
      }
      if (x.refusal !== undefined && typeof x.refusal !== 'string') {
        problems.push('expect.refusal: expected a rule name')
      }
      if (x.noRefusal === true && typeof x.refusal === 'string') {
        problems.push('expect: noRefusal and refusal contradict each other')
      }
      expect = {
        ...(isStrings(x.mustUse) ? { mustUse: x.mustUse } : {}),
        ...(isStrings(x.mustNotUse) ? { mustNotUse: x.mustNotUse } : {}),
        ...(isStrings(x.order) ? { order: x.order } : {}),
        ...(typeof x.maxToolCalls === 'number' ? { maxToolCalls: x.maxToolCalls } : {}),
        ...(x.noRefusal === true ? { noRefusal: true } : {}),
        ...(typeof x.refusal === 'string' ? { refusal: x.refusal } : {}),
      }
    }
  }
  let tags: string[] = []
  if (r.tags !== undefined) {
    if (isStrings(r.tags)) {
      tags = r.tags
    } else {
      problems.push('tags: expected a list of words')
    }
  }
  if (problems.length > 0 || typeof r.prompt !== 'string' || typeof r.check !== 'string') {
    return { task: null, problems }
  }

  return { task: { prompt: r.prompt, check: r.check, setup, solution, nearMiss, expect, tags }, problems: [] }
}

/** Whether a solution or near miss is a patch (applied with `git apply`) rather than a command. */
export const isPatch = (text: string): boolean => /^(diff --git |--- |Index: )/m.test(text.trimStart()) && /^@@ /m.test(text)

/** The quick subset: the tasks tagged `quick`, or, with none tagged, the first `n` by a stable hash of the id. */
export function quickSubset(tasks: readonly { id: string; tags: readonly string[] }[], n: number): string[] {
  const tagged = tasks.filter(one => one.tags.includes('quick')).map(one => one.id)
  if (tagged.length > 0) {
    return tagged.sort()
  }

  return [...tasks].sort((a, b) => digest(a.id).localeCompare(digest(b.id)) || a.id.localeCompare(b.id)).slice(0, n).map(one => one.id).sort()
}

// ---------------------------------------------------------------- the witness

export type Stage = 'seed-fails' | 'solution-passes' | 'reset-restores' | 'near-miss-fails'

/** One stage of the four-stage witness as it ran: the check's exit, or a step that could not run. */
export type StageRun = { stage: Stage; outcome: 'pass' | 'fail' | 'infra'; note: string }

/** What a witness's stages say: the problems that keep the task out of runs (none when it is valid). */
export function witnessProblems(runs: readonly StageRun[]): string[] {
  const out: string[] = []
  for (const run of runs) {
    if (run.outcome === 'infra') {
      out.push(`${run.stage}: could not run (${run.note})`)
    } else if ((run.stage === 'solution-passes') !== (run.outcome === 'pass')) {
      out.push({
        'seed-fails': 'the check passes on the untouched worktree, so it proves nothing',
        'solution-passes': 'the check still fails after the solution is applied',
        'reset-restores': 'after a reset the check passes again, so the reset does not restore the seed',
        'near-miss-fails': 'the check passes on the near miss, so it cannot tell it from the solution',
      }[run.stage])
    }
  }

  return out
}

// ---------------------------------------------------------------- trajectories

/** One tool call the harness observed an eval agent make: the tool, the skill (for `Skill`), and a guard that fired on it. */
export type Call = { tool: string; skill?: string; refused?: string }

const named = (call: Call, name: string): boolean =>
  call.tool === name || (call.skill !== undefined && (call.skill === name || `Skill:${call.skill}` === name))

/** What a trajectory breaks of a task's `expect`, one line each; empty when it holds. */
export function judgeTrajectory(expect: Expect | null, calls: readonly Call[]): string[] {
  if (expect === null) {
    return []
  }
  const out: string[] = []
  for (const name of expect.mustUse ?? []) {
    if (!calls.some(call => named(call, name))) {
      out.push(`never used ${name}`)
    }
  }
  for (const name of expect.mustNotUse ?? []) {
    if (calls.some(call => named(call, name))) {
      out.push(`used ${name}`)
    }
  }
  if (expect.order !== undefined && expect.order.length > 0) {
    let at = 0
    for (const call of calls) {
      if (at < expect.order.length && named(call, expect.order[at] as string)) {
        at += 1
      }
    }
    if (at < expect.order.length) {
      out.push(`not in the order ${expect.order.join(' then ')}`)
    }
  }
  if (expect.maxToolCalls !== undefined && calls.length > expect.maxToolCalls) {
    out.push(`${calls.length} tool calls, over ${expect.maxToolCalls}`)
  }
  const fired = calls.filter(call => call.refused !== undefined).map(call => call.refused as string)
  if (expect.noRefusal === true && fired.length > 0) {
    out.push(`a guard fired (${[...new Set(fired)].join(', ')}) where none should`)
  }
  if (expect.refusal !== undefined && !fired.includes(expect.refusal)) {
    out.push(`the ${expect.refusal} guard never fired`)
  }

  return out
}

// ---------------------------------------------------------------- trials and outcomes

export type Outcome = 'pass' | 'fail' | 'infra'

export type Trial = { outcome: Outcome; note: string; calls: number; costUsd: number | null }

/**
 * A task's outcome over its trials: infrastructure trials (no agent, a check
 * that could not run, an agent that never finished) are left out; it passes
 * only when every other trial passed, and is infrastructure when no trial
 * counted. The success rate is per counted trial.
 */
export function taskOutcome(trials: readonly Trial[]): { outcome: Outcome; successRate: number | null } {
  const counted = trials.filter(one => one.outcome !== 'infra')
  if (counted.length === 0) {
    return { outcome: 'infra', successRate: null }
  }
  const passed = counted.filter(one => one.outcome === 'pass').length

  return { outcome: passed === counted.length ? 'pass' : 'fail', successRate: passed / counted.length }
}

// ---------------------------------------------------------------- runs

export type PassName = 'main' | 'baseline-1' | 'baseline-2' | 'without'

/** One task's result in a pass: the eval-result@1 record. */
export type TaskResult = {
  schema: 'eval-result@1'
  run: string
  pass: PassName
  kind: 'full' | 'quick'
  task: string
  taskHash: string
  outcome: Outcome
  trials: Trial[]
  successRate: number | null
  without: string | null
  at: number
  inputs: { policy: string; model: string; harness: string; tree: string | null; suite?: Record<string, string> }
}

/** A run in progress, as kept in the store after every trial. */
export type Progress = {
  runId: string
  kind: 'full' | 'quick'
  model: string
  startedAt: number
  /** What the run switches off for its agents, as given (`--without`). */
  without: string | null
  passes: PassName[]
  tasks: string[]
  hashes: Record<string, string>
  trials: number
  results: TaskResult[]
  /** The task whose trials are under way. */
  partial: { pass: PassName; task: string; trials: Trial[] } | null
  /** Tasks of the `without` pass left unrun because the verdict could no longer change. */
  skipped: string[]
}

/** The passes of a run: one, or for an ablation the baseline twice and then without. */
export const passesFor = (without: string | null): PassName[] => (without === null ? ['main'] : ['baseline-1', 'baseline-2', 'without'])

/** What the run does next: a pass, a task and a trial number (0-based), or null when every task has its result. */
export function nextItem(progress: Progress): { pass: PassName; task: string; trial: number } | null {
  for (const pass of progress.passes) {
    for (const task of progress.tasks) {
      if (progress.results.some(one => one.pass === pass && one.task === task) || (pass === 'without' && progress.skipped.includes(task))) {
        continue
      }
      const partial = progress.partial
      const trial = partial !== null && partial.pass === pass && partial.task === task ? partial.trials.length : 0

      return { pass, task, trial }
    }
  }

  return null
}

const passCount = (results: readonly TaskResult[], pass: PassName, tasks?: readonly string[]): number =>
  results.filter(one => one.pass === pass && one.outcome === 'pass' && (tasks === undefined || tasks.includes(one.task))).length

/**
 * The noise band of an ablation: how many tasks came out differently in the
 * two identical baseline passes (tasks infrastructure in either left out).
 */
export function noiseBand(results: readonly TaskResult[]): number {
  const first = new Map(results.filter(one => one.pass === 'baseline-1').map(one => [one.task, one.outcome]))

  return results.filter(one => one.pass === 'baseline-2').filter(one => {
    const was = first.get(one.task)

    return was !== undefined && was !== 'infra' && one.outcome !== 'infra' && was !== one.outcome
  }).length
}

export type Effect = 'none' | 'helps' | 'hurts'

/** The ablation's three passes. */
const ABLATION_PASSES: readonly PassName[] = ['baseline-1', 'baseline-2', 'without']

/**
 * The tasks an ablation counts (C2.1 F4): a task that was an infrastructure
 * outcome in any of the three passes is left out of all three, so agents
 * that failed to start never read as the rule helping or hurting.
 */
export function countedResults(results: readonly TaskResult[]): TaskResult[] {
  const infra = new Set(results.filter(one => ABLATION_PASSES.includes(one.pass) && one.outcome === 'infra').map(one => one.task))

  return results.filter(one => !infra.has(one.task))
}

/**
 * An ablation's verdict: the passes without the thing against the baseline
 * (the lower of the two baselines when fewer pass without it, the higher
 * when more do), with any difference inside the noise band read as no
 * measurable effect. `helps` means the thing earns its place. Counted on
 * `countedResults` only; a pass with no counted task gives no verdict
 * (`effect` null), and no evidence is kept from it.
 */
export function ablationEffect(all: readonly TaskResult[]): { effect: Effect | null; baseline: [number, number]; without: number; noise: number } {
  const results = countedResults(all)
  const baseline: [number, number] = [passCount(results, 'baseline-1'), passCount(results, 'baseline-2')]
  const without = passCount(results, 'without')
  const noise = noiseBand(results)
  const low = Math.min(...baseline)
  const high = Math.max(...baseline)
  const isCounted = ABLATION_PASSES.every(pass => results.some(one => one.pass === pass))
  const effect: Effect | null = !isCounted ? null : without < low && low - without > noise ? 'helps' : without > high && without - high > noise ? 'hurts' : 'none'

  return { effect, baseline, without, noise }
}

/**
 * Whether the `without` pass can stop: every outcome of the tasks still to
 * run gives the same verdict as the passes so far allow (rea note 4). Only
 * an ablation stops early: its comparison is one verdict.
 */
export function canStopEarly(progress: Progress): boolean {
  if (!progress.passes.includes('without')) {
    return false
  }
  const done = progress.results.filter(one => one.pass === 'without').map(one => one.task)
  const remaining = progress.tasks.filter(task => !done.includes(task) && !progress.skipped.includes(task)).length
  if (remaining === 0 || progress.results.filter(one => one.pass === 'baseline-2').length < progress.tasks.length) {
    return false
  }
  // Each task still to run may pass, fail or be an infrastructure outcome, which
  // takes it out of the baselines too (C2.1 F4): every combination must give
  // the same verdict. Past a handful of tasks, the run simply goes on.
  if (remaining > 6) {
    return false
  }
  const left = progress.tasks.filter(task => !done.includes(task) && !progress.skipped.includes(task))
  const outcomes: Outcome[] = ['pass', 'fail', 'infra']
  const verdicts = new Set<Effect | null>()
  for (let n = 0; n < 3 ** left.length; n += 1) {
    const filler: TaskResult[] = left.map((task, i) => ({ ...(progress.results[0] as TaskResult), pass: 'without', task, outcome: outcomes[Math.floor(n / 3 ** i) % 3] as Outcome }))
    verdicts.add(ablationEffect([...progress.results, ...filler]).effect)
  }

  return verdicts.size === 1 && !verdicts.has(null)
}

/** A finished run as kept in the history: written once, last, so an incomplete run is never read as a result. */
export type RunRecord = {
  runId: string
  kind: 'full' | 'quick'
  model: string
  startedAt: number
  completedAt: number
  without: string | null
  tasks: string[]
  hashes: Record<string, string>
  results: TaskResult[]
  skipped: string[]
  /** Tasks left out because they failed validation (or were never validated), by id. */
  invalid: string[]
}

/** A run's headline: passed of counted, with infrastructure outcomes apart. */
export function headline(results: readonly TaskResult[], pass: PassName = 'main'): { passed: number; counted: number; infra: number } {
  const mine = results.filter(one => one.pass === pass)

  return { passed: mine.filter(one => one.outcome === 'pass').length, counted: mine.filter(one => one.outcome !== 'infra').length, infra: mine.filter(one => one.outcome === 'infra').length }
}

/** The runs a comparison may use: complete full runs with no ablation, newest last. */
export const comparable = (history: readonly RunRecord[]): RunRecord[] => history.filter(one => one.kind === 'full' && one.without === null)

/**
 * The last two comparable full runs side by side: only tasks whose file hash
 * is the same in both are compared; a task that passed and now fails is a
 * regression. Null with fewer than two such runs.
 */
export function compareRuns(history: readonly RunRecord[]): { older: RunRecord; newer: RunRecord; compared: string[]; leftOut: string[]; regressions: string[]; fixed: string[] } | null {
  const runs = comparable(history)
  const older = runs[runs.length - 2]
  const newer = runs[runs.length - 1]
  if (older === undefined || newer === undefined) {
    return null
  }
  const outcome = (run: RunRecord, task: string): Outcome | undefined => run.results.find(one => one.pass === 'main' && one.task === task)?.outcome
  const all = [...new Set([...older.tasks, ...newer.tasks])].sort()
  const compared = all.filter(task => older.hashes[task] !== undefined && older.hashes[task] === newer.hashes[task] && outcome(older, task) !== undefined && outcome(newer, task) !== undefined)
  const leftOut = all.filter(task => !compared.includes(task))
  const regressions = compared.filter(task => outcome(older, task) === 'pass' && outcome(newer, task) === 'fail')
  const fixed = compared.filter(task => outcome(older, task) === 'fail' && outcome(newer, task) === 'pass')

  return { older, newer, compared, leftOut, regressions, fixed }
}

/**
 * Tasks outside the useful band (rea note 4, skills note 3): over the last
 * `runs` comparable full runs in which the task's hash is today's, every
 * trial passed (saturated) or every trial failed (too hard).
 */
export function outsideBand(history: readonly RunRecord[], hashes: Readonly<Record<string, string>>, runs: number): { task: string; why: 'saturated' | 'too-hard' }[] {
  const out: { task: string; why: 'saturated' | 'too-hard' }[] = []
  for (const [task, hash] of Object.entries(hashes).sort()) {
    const seen = comparable(history).filter(run => run.hashes[task] === hash).slice(-runs)
      .map(run => run.results.find(one => one.pass === 'main' && one.task === task))
      .filter((one): one is TaskResult => one !== undefined && one.outcome !== 'infra')
    if (seen.length < runs) {
      continue
    }
    if (seen.every(one => one.trials.every(trial => trial.outcome !== 'fail'))) {
      out.push({ task, why: 'saturated' })
    } else if (seen.every(one => one.trials.every(trial => trial.outcome !== 'pass'))) {
      out.push({ task, why: 'too-hard' })
    }
  }

  return out
}

/**
 * The cost a run is projected to take, from the last run's cost per trial
 * of each task (a task with none takes the mean of those known): an
 * estimate, or null when no run recorded a cost.
 */
export function projectCost(history: readonly RunRecord[], tasks: readonly string[], trials: number, passes: number): number | null {
  const last = history[history.length - 1]
  if (last === undefined) {
    return null
  }
  const perTrial = new Map<string, number>()
  for (const one of last.results) {
    const costs = one.trials.map(trial => trial.costUsd).filter((usd): usd is number => usd !== null)
    if (costs.length > 0) {
      perTrial.set(one.task, costs.reduce((a, b) => a + b, 0) / costs.length)
    }
  }
  if (perTrial.size === 0) {
    return null
  }
  const mean = [...perTrial.values()].reduce((a, b) => a + b, 0) / perTrial.size

  return tasks.reduce((sum, task) => sum + (perTrial.get(task) ?? mean), 0) * trials * passes
}
