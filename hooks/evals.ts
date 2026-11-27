// The harness's own regression suite (DESIGN 4.8, C2): each task validated
// by its four-stage witness before it counts, run `evalTrials` times with a
// fresh agent in a throwaway worktree or clone, scored by its check (with the
// policy's scrubbed environment) and its trajectory assertions. A run's
// progress is kept in the store after every trial, so an interrupted run
// resumes; the finished run is written to the history last, so an
// incomplete one is never read as a result. The decisions are pure, in
// evalplan.ts; this file does the work.

import type { Ablation, Loop } from '../types'
import type { Config } from './config'
import type { AblationEvidence } from './ledger'
import {
  ablationEffect, canStopEarly, countedResults, headline, isPatch, nextItem, outsideBand, parseTask, passesFor, quickSubset, taskOutcome, witnessProblems, judgeTrajectory,
} from './evalplan'
import type { EvalTask, Progress, RunRecord, StageRun, TaskResult, Trial } from './evalplan'
import { checkRecord, inputsOf, listOf } from './journal'
import { digest } from './output'
import { firstLine } from './records'
import { bump, git, judgeFeatureCheck, loopOf, metrics, note, run, save } from './state'
import type { Engine, Place } from './state'

/** An eval agent that has not finished after this long is abandoned: an infrastructure outcome. */
export const EVAL_AGENT_LIFETIME_MS = 30 * 60 * 1000

/** One task file as read: its id, the hash of its text, and the task or what is wrong with it. */
export type TaskFile = { id: string; hash: string; task: EvalTask | null; problems: string[] }

/** The harness's own copy of the task a trial runs, taken when the trial starts (C2.1 F9). */
type TaskCopy = { id: string; hash: string; task: EvalTask }

/** A task's validation, kept per task with the hash it validated. */
export type Validation = { hash: string; problems: string[]; at: number }

/** A command of a task the command rules refuse: which field, and the rule (C2.1 F1). */
export type RefusedCommand = { field: 'setup' | 'check' | 'solution' | 'nearMiss'; rule: string; reason: string }

/** The commands a task carries, by field, in the order they would run: a patch is applied with `git apply`, never run. */
function taskCommands(task: EvalTask): { field: RefusedCommand['field']; command: string }[] {
  return [
    ...(task.setup === null ? [] : [{ field: 'setup' as const, command: task.setup }]),
    { field: 'check' as const, command: task.check },
    ...(task.solution === null || isPatch(task.solution) ? [] : [{ field: 'solution' as const, command: task.solution }]),
    ...(task.nearMiss === null || isPatch(task.nearMiss) ? [] : [{ field: 'nearMiss' as const, command: task.nearMiss }]),
  ]
}

/**
 * The first command of a task the command rules refuse, or null when every
 * one may run (C2.1 F1). Each is judged before it is ever run, by the policy
 * in force, as a feature check is (B2.1 F6): in enforce mode by every rule,
 * in observe mode by the rules that always hold. The sandbox belongs to no
 * spec, so the paths are judged as in small-fix mode.
 */
export async function refusedCommand($: Engine, at: Place, cfg: Config, task: EvalTask): Promise<RefusedCommand | null> {
  const loop = await loopOf($)
  const judging: Loop = { ...loop, phase: 'idle', spec: null }
  for (const one of taskCommands(task)) {
    const refusal = await judgeFeatureCheck($, at, cfg, judging, one.command)
    if (refusal !== null) {
      return { field: one.field, rule: refusal.id ?? refusal.rule, reason: refusal.reason }
    }
  }

  return null
}

/** Every task file under evals/tasks/, by id, sorted. */
export async function taskFiles($: Engine, at: Place): Promise<TaskFile[]> {
  const dir = `${at.root}/evals/tasks`
  const names = (await $.fs.exists(dir).catch(() => false))
    ? (await $.fs.list(dir)).filter(entry => entry.kind === 'file' && entry.name.endsWith('.json')).map(entry => entry.name.slice(0, -5)).sort()
    : []
  const out: TaskFile[] = []
  for (const id of names) {
    const text = await $.fs.read(`${dir}/${id}.json`).catch(() => '')
    out.push({ id, hash: digest(text), ...parseTask(text) })
  }

  return out
}

export async function validationsOf($: Engine, root: string): Promise<Record<string, Validation>> {
  return ((await $.store.get(`evalvalid:${root}`)) as Record<string, Validation> | undefined) ?? {}
}

// ---------------------------------------------------------------- the sandbox: a worktree or a clone

// The harness's own scripts for an eval's sandbox; tests/smoke.sh runs them against real git.
const EVAL_MAKE = `
# devloop:eval-make
set -e
src=$(git rev-parse --show-toplevel)
head=$(git rev-parse HEAD)
if [ "$1" = clone ]; then
  git clone -q --no-hardlinks --no-checkout "$src" "$2"
  git -C "$2" fetch -q "$src" "$head"
  git -C "$2" checkout -q --detach "$head"
else
  git worktree add -q --detach "$2" "$head"
fi
`

const EVAL_DROP = `
# devloop:eval-drop
case "$2" in /tmp/devloop-eval-*) ;; *) exit 3 ;; esac
if [ "$1" = clone ]; then rm -rf -- "$2"; else git worktree remove --force "$2" 2>/dev/null || rm -rf -- "$2"; git worktree prune; fi
`

const EVAL_RESET = `
# devloop:eval-reset
cd "$1" || exit 3
git reset -q --hard && git clean -fdq
`

const EVAL_APPLY = `
# devloop:eval-apply
cd "$1" || exit 3
{ printf '%s' "$2"; echo; } | git apply --whitespace=nowarn -
`

const EVAL_REMOVE = `
# devloop:eval-remove
cd "$1" || exit 3
case "$2" in /*|*..*|'') exit 3 ;; esac
rm -rf -- "./$2"
`

/** Makes a throwaway worktree or clone at a fresh folder under /tmp; null when it could not. */
async function makeSandbox($: Engine, at: Place, isolation: 'worktree' | 'clone', id: string, now: number): Promise<string | null> {
  const dir = `/tmp/devloop-eval-${id.replace(/[^A-Za-z0-9_-]/g, '_')}-${now}`
  const made = await git($, at, EVAL_MAKE, [isolation, dir], 300_000)

  return made !== null && made.code === 0 ? dir : null
}

async function dropSandbox($: Engine, at: Place, isolation: 'worktree' | 'clone', dir: string): Promise<void> {
  await git($, at, EVAL_DROP, [isolation, dir], 120_000)
}

/** Applies a solution or near miss in a sandbox: a patch with `git apply`, anything else as a command. */
async function applyIn($: Engine, at: Place, cfg: Config, dir: string, change: string): Promise<boolean> {
  if (isPatch(change)) {
    const ran = await git($, at, EVAL_APPLY, [dir, change])

    return ran !== null && ran.code === 0
  }

  return (await run($, change, dir, cfg.verifyTimeoutSec, cfg.checkEnv)).isPassing
}

/** Runs a task's setup in its sandbox (none is a success). */
async function setupIn($: Engine, cfg: Config, dir: string, task: EvalTask): Promise<boolean> {
  return task.setup === null || (await run($, task.setup, dir, cfg.verifyTimeoutSec, cfg.checkEnv)).isPassing
}

/** Runs a task's check in its sandbox, with the policy's check environment: pass, fail, or could not run. */
async function checkIn($: Engine, cfg: Config, dir: string, task: EvalTask): Promise<{ outcome: 'pass' | 'fail' | 'infra'; note: string }> {
  const ran = await run($, task.check, dir, cfg.verifyTimeoutSec, cfg.checkEnv)

  return ran.outcome === 'pass' ? { outcome: 'pass', note: 'check passed' } : ran.outcome === 'fail' ? { outcome: 'fail', note: `check failed (exit ${ran.code}): ${firstLine(ran.output, 120)}` } : { outcome: 'infra', note: `check could not run (${ran.outcome})` }
}

// ---------------------------------------------------------------- validation: the four-stage witness

/**
 * Validates one task by its witness (rea note 5): the check fails on the
 * untouched sandbox, passes after the solution, fails again after a reset,
 * and fails on the near miss. Resolves to the problems (none when valid).
 */
async function witness($: Engine, at: Place, cfg: Config, file: TaskFile, now: number): Promise<string[]> {
  const task = file.task
  if (task === null) {
    return file.problems
  }
  // Nothing of a task runs before every command it carries is judged (C2.1 F1).
  const refused = await refusedCommand($, at, cfg, task)
  if (refused !== null) {
    return [`${refused.field}: refused by the command rules (${refused.rule}): ${refused.reason}`]
  }
  const dir = await makeSandbox($, at, cfg.evalIsolation, `${file.id}-v`, now)
  if (dir === null) {
    return [`could not make a ${cfg.evalIsolation} to validate it in`]
  }
  const runs: StageRun[] = []
  const stage = async (name: StageRun['stage']): Promise<void> => {
    const one = await checkIn($, cfg, dir, task)
    runs.push({ stage: name, outcome: one.outcome, note: one.note })
  }
  const reset = async (): Promise<boolean> => {
    const ran = await git($, at, EVAL_RESET, [dir])

    return ran !== null && ran.code === 0 && (await setupIn($, cfg, dir, task))
  }
  try {
    if (!(await setupIn($, cfg, dir, task))) {
      return ['setup: the setup command failed in a fresh sandbox']
    }
    await stage('seed-fails')
    if (task.solution !== null) {
      if (!(await applyIn($, at, cfg, dir, task.solution))) {
        return [...witnessProblems(runs), 'solution: it could not be applied']
      }
      await stage('solution-passes')
      if (!(await reset())) {
        return [...witnessProblems(runs), 'reset: the sandbox could not be reset']
      }
      await stage('reset-restores')
    }
    if (task.nearMiss !== null) {
      if (!(await applyIn($, at, cfg, dir, task.nearMiss))) {
        return [...witnessProblems(runs), 'nearMiss: it could not be applied']
      }
      await stage('near-miss-fails')
    }

    return witnessProblems(runs)
  } finally {
    await dropSandbox($, at, cfg.evalIsolation, dir)
  }
}

/**
 * Validates the named tasks (every task, with none named) and keeps each
 * result by the task file's hash: a changed task is validated again before
 * it counts. Resolves to the tasks validated and what each found.
 */
export async function validateTasks($: Engine, at: Place, cfg: Config, files: readonly TaskFile[]): Promise<Record<string, Validation>> {
  const kept = await validationsOf($, at.root)
  const now = await $.clock.now()
  for (const file of files) {
    kept[file.id] = { hash: file.hash, problems: (await witness($, at, cfg, file, now)).map(one => firstLine(one, 200)), at: now }
  }
  await $.store.set(`evalvalid:${at.root}`, kept)

  return kept
}

/**
 * Judges every task's commands by the policy in force (a task recorded valid
 * under another policy is judged again: C2.1 F1), validates the tasks that
 * have no validation for their current text, then splits the suite: valid,
 * refused by the command rules (never run), and left out with why.
 */
export async function readySuite($: Engine, at: Place, cfg: Config, isValidating = true): Promise<{ files: TaskFile[]; valid: TaskFile[]; refused: ({ id: string } & RefusedCommand)[]; invalid: { id: string; problems: string[] }[]; validated: string[] }> {
  const files = await taskFiles($, at)
  const refused: ({ id: string } & RefusedCommand)[] = []
  for (const file of files) {
    const found = file.task === null ? null : await refusedCommand($, at, cfg, file.task)
    if (found !== null) {
      refused.push({ id: file.id, ...found })
    }
  }
  const isRefused = (file: TaskFile): boolean => refused.some(one => one.id === file.id)
  const before = await validationsOf($, at.root)
  const stale = files.filter(file => !isRefused(file) && before[file.id]?.hash !== file.hash)
  // Validation runs each task's commands: only once a person confirmed the run (D1, item 8). Before that, a stale task is counted as it would be once validated.
  const kept = stale.length > 0 && isValidating ? await validateTasks($, at, cfg, stale) : before
  const isPending = (file: TaskFile): boolean => !isValidating && stale.includes(file)
  const valid = files.filter(file => file.task !== null && !isRefused(file) && (isPending(file) || (kept[file.id]?.hash === file.hash && kept[file.id]?.problems.length === 0)))
  const invalid = files.filter(file => !valid.includes(file) && !isRefused(file)).map(file => ({ id: file.id, problems: kept[file.id]?.problems ?? file.problems }))

  return { files, valid, refused, invalid, validated: stale.map(file => file.id) }
}

// ---------------------------------------------------------------- runs

export async function progressOf($: Engine, root: string): Promise<Progress | null> {
  return ((await $.store.get(`evalrun:${root}`)) as Progress | undefined) ?? null
}

async function saveProgress($: Engine, root: string, progress: Progress | null): Promise<void> {
  if (progress === null) {
    await $.store.delete(`evalrun:${root}`)
  } else {
    await $.store.set(`evalrun:${root}`, progress)
  }
}

/** The complete runs, oldest first: each written once, at its end. */
export async function historyOf($: Engine, root: string): Promise<RunRecord[]> {
  return (await listOf<RunRecord>($, `evals:${root}`)).filter(one => typeof one === 'object' && one !== null && 'completedAt' in one && Array.isArray(one.results))
}

/** Which tasks a run takes: all valid ones, or the quick subset. */
export function tasksFor(valid: readonly TaskFile[], kind: 'full' | 'quick', cfg: Config): string[] {
  const all = valid.map(file => ({ id: file.id, tags: file.task?.tags ?? [] }))

  return kind === 'quick' ? quickSubset(all, cfg.evalQuick) : all.map(one => one.id)
}

/** Starts a run: its progress kept, then the first task's first trial. */
export async function beginRun($: Engine, at: Place, cfg: Config, plan: { kind: 'full' | 'quick'; tasks: string[]; hashes: Record<string, string>; without: Ablation | null; invalid: string[] }): Promise<void> {
  const now = await $.clock.now()
  const model = cfg.models.eval ?? (await $.session.model().catch(() => 'unknown'))
  // A run's id is unique per repository: a sequence, then the time.
  await bump($, at.root, 'eval-runs')
  const seq = (await metrics($, at.root))['eval-runs'] ?? 1
  const progress: Progress = {
    runId: `r${seq}-${now.toString(36)}`, kind: plan.kind, model, startedAt: now, without: plan.without?.target ?? null,
    passes: passesFor(plan.without?.target ?? null), tasks: plan.tasks, hashes: plan.hashes, trials: cfg.evalTrials, results: [], partial: null, skipped: [],
  }
  await saveProgress($, at.root, progress)
  await $.store.set(`evalinvalid:${at.root}`, plan.invalid)
  await save($, at.root, before => ({ ...before, evalRun: { runId: progress.runId, current: null, without: plan.without, isolation: cfg.evalIsolation } }))
  await advance($, at, cfg)
}

/** Picks up a run left unfinished (a session that ended, an agent that never came back): the lost trial runs again. */
export async function resumeRun($: Engine, at: Place, cfg: Config, without: Ablation | null): Promise<void> {
  const progress = await progressOf($, at.root)
  if (progress === null) {
    return
  }
  await save($, at.root, before => ({ ...before, evalRun: { runId: progress.runId, current: null, without, isolation: before.evalRun?.isolation ?? cfg.evalIsolation } }))
  await advance($, at, cfg)
}

/** Records one trial of the task under way; with every trial in, the task's result (eval-result@1). */
async function settleTrial($: Engine, at: Place, cfg: Config, item: { pass: TaskResult['pass']; task: string }, trial: Trial): Promise<void> {
  const progress = await progressOf($, at.root)
  if (progress === null) {
    return
  }
  const partial = progress.partial !== null && progress.partial.pass === item.pass && progress.partial.task === item.task ? progress.partial : { ...item, trials: [] }
  const trials = [...partial.trials, trial]
  if (trials.length < progress.trials) {
    await saveProgress($, at.root, { ...progress, partial: { ...partial, trials } })

    return
  }
  const { outcome, successRate } = taskOutcome(trials)
  const now = await $.clock.now()
  const loop = await loopOf($)
  let result: TaskResult = {
    schema: 'eval-result@1', run: progress.runId, pass: item.pass, kind: progress.kind, task: item.task, taskHash: progress.hashes[item.task] ?? '',
    outcome, trials, successRate, without: progress.without, at: now, inputs: await inputsOf($, cfg, loop.tree, progress.hashes),
  }
  if (!(await checkRecord($, at.root, 'eval-result@1', result))) {
    result = { ...result, outcome: 'infra', trials: [], successRate: null }
  }
  let next: Progress = { ...progress, partial: null, results: [...progress.results, result] }
  // An ablation stops once the tasks left cannot change its verdict (rea note 4).
  if (canStopEarly(next)) {
    const done = next.results.filter(one => one.pass === 'without').map(one => one.task)
    next = { ...next, skipped: next.tasks.filter(task => !done.includes(task)) }
  }
  await saveProgress($, at.root, next)
}

/**
 * Starts the next trial of the run, or, with every task scored, writes the
 * run to the history (its completion marker) and clears the progress.
 * A trial that cannot start is an infrastructure outcome and the run goes on.
 */
export async function advance($: Engine, at: Place, cfg: Config): Promise<void> {
  for (;;) {
    const progress = await progressOf($, at.root)
    const live = (await loopOf($)).evalRun
    if (progress === null || live === null || live.current !== null) {
      return
    }
    const item = nextItem(progress)
    const now = await $.clock.now()
    if (item === null) {
      await finishRun($, at, cfg, progress, now)

      return
    }
    const fail = (note: string): Promise<void> => settleTrial($, at, cfg, item, { outcome: 'infra', note, calls: 0, costUsd: null })
    const file = (await taskFiles($, at)).find(one => one.id === item.task)
    if (file === undefined || file.task === null || file.hash !== progress.hashes[item.task]) {
      await fail('the task file changed or went missing during the run')
      continue
    }
    const task = file.task
    // Judged again before anything of it runs: the policy in force may have changed since the run began (C2.1 F1).
    const refused = await refusedCommand($, at, cfg, task)
    if (refused !== null) {
      await fail(`not run: its ${refused.field} is refused by the command rules (${refused.rule})`)
      continue
    }
    const dir = await makeSandbox($, at, live.isolation, item.task, now)
    if (dir === null) {
      await fail(`no ${live.isolation} could be made`)
      continue
    }
    if (!(await setupIn($, cfg, dir, task))) {
      await dropSandbox($, at, live.isolation, dir)
      await fail('the setup command failed')
      continue
    }
    // An ablation of a file or skill takes it out of the eval's sandbox only.
    if (item.pass === 'without' && live.without?.kind === 'file') {
      const removed = await git($, at, EVAL_REMOVE, [dir, live.without.target])
      if (removed === null || removed.code !== 0) {
        await dropSandbox($, at, live.isolation, dir)
        await fail(`${live.without.target} could not be removed from the sandbox`)
        continue
      }
    }
    // The agent never sees the suite: evals/ goes from its sandbox, and the
    // harness scores it from its own copy of the task (C2.1 F9).
    const hidden = await git($, at, EVAL_REMOVE, [dir, 'evals'])
    if (hidden === null || hidden.code !== 0) {
      await dropSandbox($, at, live.isolation, dir)
      await fail('evals/ could not be removed from the sandbox')
      continue
    }
    await $.store.set(`evalcopy:${at.root}`, { id: item.task, hash: file.hash, task } satisfies TaskCopy)
    const startUsd = (await $.session.usage().catch(() => null))?.cost?.usd ?? null
    const started = await $.agent.spawn({
      prompt: `${task.prompt}\n\nWork only inside ${dir}. Stop when the task is done.`,
      description: `devloop eval: ${item.task}${progress.trials > 1 ? ` (trial ${item.trial + 1} of ${progress.trials})` : ''}`,
      cwd: dir,
      ...(cfg.models.eval === null ? {} : { model: cfg.models.eval }),
    }).catch((error: unknown) => ({ deny: String((error as Error | undefined)?.message ?? error), agentId: undefined }))
    if (started.deny !== undefined || started.agentId === undefined) {
      await dropSandbox($, at, live.isolation, dir)
      await fail(`no agent: ${started.deny ?? 'none was created'}`)
      continue
    }
    const agentId = started.agentId
    await save($, at.root, before => (before.evalRun === null ? before : {
      ...before,
      evalRun: { ...before.evalRun, current: { id: item.task, agentId, dir, trial: item.trial, pass: item.pass, startedAt: now, startUsd, calls: [] } },
    }))

    return
  }
}

/** Writes the finished run to the history (the completion marker, last) and clears its progress. */
async function finishRun($: Engine, at: Place, cfg: Config, progress: Progress, now: number): Promise<void> {
  const history = await historyOf($, at.root)
  const invalid = await listOf<string>($, `evalinvalid:${at.root}`)
  if (!history.some(one => one.runId === progress.runId)) {
    const done: RunRecord = {
      runId: progress.runId, kind: progress.kind, model: progress.model, startedAt: progress.startedAt, completedAt: now, without: progress.without,
      tasks: progress.tasks, hashes: progress.hashes, results: progress.results, skipped: progress.skipped, invalid,
    }
    await $.store.set(`evals:${at.root}`, [...history, done].slice(-40))
    // An ablation's verdict is prune's evidence (skills note 3).
    // An ablation in which some pass counted no task gives no verdict, and no evidence is kept (C2.1 F4).
    const found = done.without === null ? null : ablationEffect(done.results)
    if (done.without !== null && found !== null && found.effect !== null) {
      const counted = new Set(countedResults(done.results).filter(one => one.pass === 'without').map(one => one.task)).size
      const evidence: AblationEvidence = { target: done.without, at: now, ...found, effect: found.effect, total: counted }
      await $.store.set(`ablations:${at.root}`, [...(await listOf<AblationEvidence>($, `ablations:${at.root}`)), evidence].slice(-100))
    }
  }
  await saveProgress($, at.root, null)
  const main = headline(progress.results, progress.passes[progress.passes.length - 1] ?? 'main')
  const band = outsideBand(await historyOf($, at.root), progress.hashes, cfg.saturationRuns)
  const label = progress.without !== null ? `ablation without ${progress.without}` : progress.kind === 'quick' ? 'quick run (a subset)' : 'full run'
  const summary = `evals: ${main.passed}/${main.counted} passed on ${progress.model} (${label})${main.infra > 0 ? `; ${main.infra} could not run (not counted)` : ''}${band.length > 0 ? `; outside the useful band: ${band.map(one => one.task).join(', ')}` : ''}`
  await save($, at.root, before => note({ ...before, evalRun: null }, 'eval', summary, now))
  $.ui.toast(`devloop: evals ${main.passed}/${main.counted} passed (${label}). /devloop eval compare and /devloop prune read it.`)
}

/**
 * Scores the trial whose agent just finished: its check in its sandbox,
 * then its trajectory assertions; an agent that was aborted, or a check
 * that could not run, is an infrastructure outcome. Then the next trial.
 */
export async function finishEval($: Engine, at: Place, cfg: Config, isAborted = false): Promise<void> {
  const live = (await loopOf($)).evalRun
  const current = live?.current
  if (live === null || live === undefined || current === null || current === undefined) {
    return
  }
  // Scored from the harness's own copy of the task, taken when the trial started (C2.1 F9): never what the working tree holds now.
  const copy = (await $.store.get(`evalcopy:${at.root}`)) as TaskCopy | undefined
  const task = copy !== undefined && copy.id === current.id ? copy.task : null
  const usd = (await $.session.usage().catch(() => null))?.cost?.usd ?? null
  const costUsd = usd === null || current.startUsd === null || usd < current.startUsd ? null : Math.round((usd - current.startUsd) * 10_000) / 10_000
  let trial: Trial
  if (isAborted) {
    trial = { outcome: 'infra', note: 'the agent did not finish', calls: current.calls.length, costUsd }
  } else if (task === null) {
    trial = { outcome: 'infra', note: 'the harness\'s copy of the task went missing', calls: current.calls.length, costUsd }
  } else if ((await refusedCommand($, at, cfg, task)) !== null) {
    trial = { outcome: 'infra', note: 'not scored: its check is refused by the command rules', calls: current.calls.length, costUsd }
  } else {
    const checked = await checkIn($, cfg, current.dir, task)
    const broken = checked.outcome === 'infra' ? [] : judgeTrajectory(task.expect, current.calls)
    trial = broken.length > 0 && checked.outcome !== 'infra'
      ? { outcome: 'fail', note: `${checked.note}; trajectory: ${broken.join('; ')}`.slice(0, 300), calls: current.calls.length, costUsd }
      : { ...checked, note: checked.note.slice(0, 300), calls: current.calls.length, costUsd }
  }
  await dropSandbox($, at, live.isolation, current.dir)
  await settleTrial($, at, cfg, { pass: current.pass as TaskResult['pass'], task: current.id }, trial)
  await save($, at.root, before => (before.evalRun === null ? before : { ...before, evalRun: { ...before.evalRun, current: null } }))
  await advance($, at, cfg)
}

/** An eval agent's trial that has run past its lifetime: scored as infrastructure, and the run goes on. */
export async function abandonStaleEval($: Engine, at: Place, cfg: Config): Promise<boolean> {
  const loop: Loop = await loopOf($)
  const current = loop.evalRun?.current
  const now = await $.clock.now()
  if (current === null || current === undefined || now - current.startedAt < EVAL_AGENT_LIFETIME_MS) {
    return false
  }
  await finishEval($, at, cfg, true)

  return true
}
