// The person's commands of phase C2: papercuts, learn, prune, eval, the
// regression set, defects, metrics, the change report and the audit trail;
// and what /devloop done adds: the change record with its attestation, the
// regression checks, and eval suggestions. The decisions are pure (ledger.ts,
// evalplan.ts, report.ts, records.ts); this file reads and writes the store.

import type { CommandRunInput, CommandRunResult } from 'claude-code'

import type { Ablation, Loop } from '../types'
import { hitRate } from './cache'
import type { Config } from './config'
import { compareRuns, headline, outsideBand, projectCost } from './evalplan'
import type { RunRecord } from './evalplan'
import { abandonStaleEval, beginRun, historyOf, progressOf, readySuite, resumeRun, taskFiles, tasksFor, validateTasks } from './evals'
import type { Check } from './gate'
import { actorOf, audit, auditOf, auditReport, confirm, inputsOf, isFromPerson, keepRecord, listOf, suggestEval } from './journal'
import type { Suggestion } from './journal'
import { learnedLines } from './autolearn'
import { learnedNow, maybePropose } from './learner'
import { noteLibraryDefect } from './librarycmd'
import { costReport, EMPTY_COSTS, LEARN_LADDER, learnGroups, papercutGroups, pruneReport } from './ledger'
import type { AblationEvidence, Costs, Hits, Papercut, PapercutClose, PruneRule, Tombstone } from './ledger'
import { firstLine } from './records'
import { dropRegression, keepRegressions, regressionsOf, syncRegressions } from './regress'
import { attestationOf, changeRecord, changeReport, computeMetrics, metricsLines } from './report'
import type { ChangeRecord, Defect, GroundingSession } from './report'
import { isAlwaysHeld, matchesAny, RULES } from './rules'
import { cacheOf, carryFactsOf, filesUnder, ledger, loopOf, metrics, readFeatures, save } from './state'
import type { Engine, Place } from './state'

type Answer = CommandRunResult


// ---------------------------------------------------------------- papercuts

export async function papercutsCommand($: Engine, at: Place, words: readonly string[], e: CommandRunInput): Promise<Answer> {
  const list = await listOf<Papercut>($, `papercuts:${at.root}`)
  const closes = await listOf<PapercutClose>($, `papercut-closes:${at.root}`)
  if (words[0] !== 'close') {
    const groups = papercutGroups(list, closes)
    if (groups.length === 0) {
      return { text: 'No papercuts filed. The agent files one with the devloop_papercut tool when something gets in its way.' }
    }

    return {
      text: [
        `Papercuts, by group (${list.length} filed):`,
        ...groups.map(one => `  ${one.group}  ${one.count}x${one.isRegression ? '  REGRESSION: filed again after it was closed' : one.closed !== null ? '  closed' : ''}  ${one.subject ?? '(no subject)'}: ${firstLine(one.happened, 100)}${one.suggestedFix === '' ? '' : `\n         suggested: ${firstLine(one.suggestedFix, 100)}`}${one.closed !== null ? `\n         closed ${new Date(one.closed.at).toISOString().slice(0, 10)}: ${firstLine(one.closed.note, 100)}` : ''}`),
        '/devloop papercuts close <group> <what fixed it> records a fix (a person\'s call).',
      ].join('\n'),
    }
  }
  const group = words[1] ?? ''
  const text = words.slice(2).join(' ').trim()
  if (!isFromPerson(e)) {
    return { text: 'A papercut is closed by a person, from the prompt.' }
  }
  if (!/^p-[0-9a-f]{6}$/.test(group) || text === '') {
    return { text: 'Name the group and what fixed it: /devloop papercuts close p-1a2b3c <note>.' }
  }
  if (!list.some(one => one.group === group)) {
    return { text: `No papercut group ${group}. /devloop papercuts lists them.` }
  }
  const now = await $.clock.now()
  await $.store.set(`papercut-closes:${at.root}`, [...closes, { group, at: now, note: text.slice(0, 300) }].slice(-500))
  await audit($, at.root, 'papercut-closed', actorOf(e), group, null, firstLine(text, 200))

  return { text: `${group} is closed: ${text}. If it is filed again, it is flagged as a regression.` }
}

// ---------------------------------------------------------------- learn

/**
 * /devloop learn: the repeats and the ladder, as before; for a person, it
 * opens with the waiting proposals and the trial rules (DESIGN 4.17), shown
 * to them only (display-only: the model reads the repeats and the ladder, as
 * before, and nothing the proposer wrote), and starts a proposer run on demand.
 */
export async function learnCommand($: Engine, at: Place, cfg: Config, e: CommandRunInput): Promise<Answer> {
  const tombstones = await listOf<Tombstone>($, `tombstones:${at.root}`)
  const groups = learnGroups(await ledger($, at.root), tombstones)
  const suggestions = (await listOf<Suggestion>($, `evalsuggest:${at.root}`)).filter(one => one.status === 'open')
  const isPerson = isFromPerson(e)
  const learned = await learnedNow($, at.root)
  const isShown = isPerson && cfg.learning.auto !== 'off' && (learned.proposals.length > 0 || learned.rules.length > 0)
  const run = isPerson && cfg.learning.auto !== 'off' ? await maybePropose($, at, cfg, 'asked', true).catch(() => 'The proposer could not start.') : null
  const head = isShown ? [...learnedLines(learned), '/devloop rules promote <id> | drop <id> <reason> (a person\'s call).'] : []
  const said = run === null || !run.startsWith('A proposer run') ? [] : [run]
  if (groups.length === 0) {
    const none = 'Nothing has failed twice yet. One-off failures are left alone: a rule is earned by repetition.'

    return isShown ? { text: [...head, ...said, none].join('\n'), isTextDisplayOnly: true } : { text: [...said, none].join('\n') }
  }
  const listing = groups.map(one => `  ${one.count}x  ${one.label}${one.recurredAfter !== null ? ` (recurred after its tombstone of ${new Date(one.recurredAfter).toISOString().slice(0, 10)})` : ''}\n       last: ${one.sample}\n       cheapest rung: ${one.rung}`).join('\n')
  const repeats = [`Failures seen more than once:\n${listing}`, suggestions.length > 0 ? `Eval-task candidates from failures (/devloop eval adopt): ${suggestions.map(one => one.id).join(', ')}` : ''].filter(line => line !== '').join('\n')
  if (!isShown) {
    return { text: [...said, repeats].join('\n'), context: [LEARN_LADDER] }
  }

  return { text: [...head, ...said, repeats].join('\n'), context: [repeats, LEARN_LADDER], isTextDisplayOnly: true }
}

// ---------------------------------------------------------------- prune

/** The instruction files the policy names that git tracks (an estimate of what every session reads). */
async function instructionFilesOf($: Engine, at: Place, cfg: Config): Promise<string[]> {
  const tracked = (await filesUnder($, at, ['']))[''] ?? []

  return tracked.filter(file => matchesAny(file, cfg.instructions)).slice(0, 40)
}

export async function pruneCommand($: Engine, at: Place, cfg: Config, words: readonly string[], e: CommandRunInput): Promise<Answer> {
  const tombstones = await listOf<Tombstone>($, `tombstones:${at.root}`)
  if (words[0] === 'remove') {
    const id = words[1] ?? ''
    const evidence = words.slice(2).join(' ').trim()
    if (!isFromPerson(e)) {
      return { text: 'A rule is tombstoned by a person, from the prompt.' }
    }
    if (id === '' || evidence === '') {
      return { text: 'Name the rule and the evidence for removing it: /devloop prune remove <rule id> <evidence>.' }
    }
    if (!(await confirm($, `Record the removal of "${id}" with this evidence: "${evidence}"? /devloop learn will not propose it again unless the failure returns. (Edit the policy or the instruction file yourself to remove it.)`, 'Record it', 'Keep it'))) {
      return { text: `Nothing recorded; "${id}" is kept.` }
    }
    const now = await $.clock.now()
    await $.store.set(`tombstones:${at.root}`, [...tombstones, { id, evidence: evidence.slice(0, 300), at: now }])
    await audit($, at.root, 'rule-tombstoned', actorOf(e), id, null, firstLine(evidence, 200))

    return { text: `Tombstone recorded for "${id}". Remove the rule itself from devloop.json or the instruction file; /devloop learn proposes it again only if the failure returns after today.` }
  }
  const hits = ((await $.store.get(`rulehits:${at.root}`)) as Hits | undefined) ?? {}
  const files = await instructionFilesOf($, at, cfg)
  const rules: PruneRule[] = [
    ...RULES.map(id => ({ id, kind: 'built-in' as const, ...(isAlwaysHeld(id) ? { note: 'always held' } : {}) })),
    ...cfg.rules.map(one => ({ id: one.id, kind: 'content' as const, note: one.action })),
    ...await Promise.all(files.map(async file => ({ id: file, kind: 'instruction' as const, note: `${(await $.fs.read(`${at.root}/${file}`).catch(() => '')).split('\n').length} lines (limit ${cfg.instructionMaxLines})` }))),
  ]
  const history = await historyOf($, at.root)
  const hashes = Object.fromEntries((await taskFiles($, at)).map(one => [one.id, one.hash]))
  const now = await $.clock.now()
  const lines = pruneReport({
    rules, hits, now, windowDays: cfg.pruneWindowDays, ablations: await listOf<AblationEvidence>($, `ablations:${at.root}`), band: outsideBand(history, hashes, cfg.saturationRuns), tombstones,
  })
  const costs = ((await $.store.get(`costs:${at.root}`)) as Costs | undefined) ?? EMPTY_COSTS
  const skills = Object.entries(costs.skills)
  if (skills.length > 0) {
    lines.push(`Skills: ${skills.map(([name, one]) => `${name} used ${one.uses}x, errors after use ${one.errorsAfter}, about $${one.usd.toFixed(2)}`).join('; ')} (cost an estimate). A skill never used, or one costing more than it saves under ablation, is a candidate.`)
  }
  if (history.length === 0) {
    lines.push('No eval run on record: run /devloop eval before deleting anything, and again after.')
  }

  return {
    text: ['What to weigh when pruning the harness:', ...lines, '/devloop prune remove <rule id> <evidence> records a removal (a tombstone; a person\'s call).'].join('\n'),
    context: ['The person is pruning the harness. Read the instruction file and .claude/rules/. Sort each line into: an organisational fact or invariant (keep), or a compensation for something a model used to get wrong (emphasis, step-by-step scaffolds, reminders: candidates to delete). Propose deletions one at a time, each with the eval evidence that shows it is not needed (an ablation with no measurable effect, /devloop eval --without <id>). Do not edit the files.'],
  }
}

// ---------------------------------------------------------------- eval

/** Reads `--without <target>` into an ablation: a rule (built-in or content) or a file or skill folder that exists. */
async function ablationOf($: Engine, at: Place, cfg: Config, target: string): Promise<Ablation | string> {
  if (RULES.includes(target) || cfg.rules.some(one => one.id === target)) {
    return isAlwaysHeld(target) || target === 'ship-alone' ? `"${target}" always holds; it cannot be switched off, even for an eval.` : { kind: 'rule', target }
  }
  const rel = target.replace(/^\.\//, '')
  if (rel.split('/').includes('..') || rel.startsWith('/')) {
    return `"${target}" is not a path inside the repository.`
  }
  for (const candidate of [rel, `.claude/skills/${rel}`]) {
    if (await $.fs.exists(`${at.root}/${candidate}`).catch(() => false)) {
      return { kind: 'file', target: candidate }
    }
  }

  return `"${target}" is no rule (built-in or in devloop.json), file or skill here.`
}

export async function evalCommand($: Engine, at: Place, cfg: Config, words: readonly string[], e: CommandRunInput): Promise<Answer> {
  const sub = words[0] ?? ''
  if (sub === 'compare') {
    return { text: compareText(await historyOf($, at.root)) }
  }
  if (sub === 'adopt') {
    return adopt($, at, words[1] ?? '', e)
  }
  if (!isFromPerson(e)) {
    return { text: 'An eval run is started by a person, from the prompt.' }
  }
  if (sub === 'validate') {
    const files = await taskFiles($, at)
    if (files.length === 0) {
      return { text: 'No tasks in evals/tasks/.' }
    }
    // Validation runs each task's commands: a person's key, with a dialog, as a run is (C2.1 F1).
    if (!(await confirm($, `Validate ${files.length} eval task${files.length === 1 ? '' : 's'}? Each task's setup, check, solution and near miss run in a fresh ${cfg.evalIsolation}, with the policy's check environment; a command the command rules refuse is not run, and its task is left out.`, 'Validate them', 'Not now'))) {
      return { text: 'Nothing was validated.' }
    }
    const kept = await validateTasks($, at, cfg, files)

    return {
      text: [
        'Each task\'s witness: the check fails on the untouched sandbox; passes after the solution; fails again after a reset; fails on the near miss.',
        ...files.map(file => {
          const problems = kept[file.id]?.problems ?? file.problems

          return `  ${problems.length === 0 ? '[valid]  ' : '[invalid]'} ${file.id}${problems.length > 0 ? `: ${problems.join('; ')}` : ''}`
        }),
        'Invalid tasks are left out of every run until fixed.',
      ].join('\n'),
    }
  }
  if (sub === 'cancel') {
    if (!(await confirm($, 'Cancel the eval run in progress? Its results so far are discarded (an incomplete run is never a result).', 'Cancel it', 'Keep it'))) {
      return { text: 'The run is kept.' }
    }
    await $.store.delete(`evalrun:${at.root}`)
    // An agent still at work is no longer an eval agent: its later calls meet every rule.
    await save($, at.root, before => ({ ...before, evalRun: null }))

    return { text: 'The run was cancelled; nothing of it is kept.' }
  }
  const loop = await loopOf($)
  if (loop.evalRun?.current !== null && loop.evalRun?.current !== undefined) {
    if (!(await abandonStaleEval($, at, cfg))) {
      return { text: `An eval run is in progress: task ${loop.evalRun.current.id}, trial ${loop.evalRun.current.trial + 1}. /devloop eval cancel stops it.` }
    }
  }
  const progress = await progressOf($, at.root)
  if (progress !== null) {
    // An interrupted run resumes: its finished tasks are kept, the lost trial runs again.
    const without = progress.without === null ? null : await ablationOf($, at, cfg, progress.without)
    await resumeRun($, at, cfg, typeof without === 'string' ? null : without)
    const done = progress.results.length

    return { text: `Resumed the interrupted ${progress.kind} run ${progress.runId}${progress.without === null ? '' : ` (without ${progress.without})`}: ${done} task result${done === 1 ? '' : 's'} kept, the rest run now.` }
  }
  const withoutAt = words.indexOf('--without')
  let without: Ablation | null = null
  if (withoutAt >= 0) {
    const found = await ablationOf($, at, cfg, words[withoutAt + 1] ?? '')
    if (typeof found === 'string') {
      return { text: found }
    }
    without = found
  }
  const kind = sub === 'quick' ? 'quick' as const : 'full' as const
  // Nothing runs before the person confirms (D1, item 8): tasks whose validation is out of date are counted, and validated only after the dialog.
  const planned = await readySuite($, at, cfg, false)
  if (planned.files.length === 0) {
    return { text: 'No tasks in evals/tasks/. Add one JSON file per task: { "prompt": "...", "check": "..." } (evals/README.md says more).' }
  }
  let suite = planned
  let tasks = tasksFor(suite.valid, without === null ? kind : 'full', cfg)
  const refusedNote = suite.refused.length > 0 ? `Left out, refused by the command rules: ${suite.refused.map(one => `${one.id} (${one.field}: ${one.rule})`).join('; ')}. Nothing of these ran.` : ''
  const invalidNoteOf = (of: typeof suite): string => [
    refusedNote,
    of.invalid.length > 0 ? `Left out, failing validation: ${of.invalid.map(one => `${one.id} (${one.problems[0] ?? 'invalid'})`).join('; ')}.` : '',
  ].filter(line => line !== '').join('\n')
  let invalidNote = invalidNoteOf(suite)
  const stale = planned.validated
  if (tasks.length === 0) {
    return { text: ['No task is valid, so there is nothing to run.', invalidNote].filter(line => line !== '').join('\n') }
  }
  const history = await historyOf($, at.root)
  const passes = without === null ? 1 : 3
  const projected = projectCost(history, tasks, cfg.evalTrials, passes)
  const model = cfg.models.eval ?? (await $.session.model().catch(() => 'the session\'s model'))
  const label = without !== null ? `an ablation without ${without.target} (the baseline twice, then without it)` : kind === 'quick' ? 'a quick run (a subset; it is not the headline number)' : 'a full run'
  const question = [
    `Start ${label}? ${tasks.length} task${tasks.length === 1 ? '' : 's'} x ${cfg.evalTrials} trial${cfg.evalTrials === 1 ? '' : 's'}${passes > 1 ? ' x 3 passes' : ''} on ${model}, each in a fresh ${cfg.evalIsolation}.`,
    projected === null ? 'Projected cost: unknown (no earlier run recorded a cost).' : `Projected cost: about $${projected.toFixed(2)} (an estimate, from the last run's cost per task).`,
    invalidNote,
    stale.length > 0 ? `First, ${stale.length} task${stale.length === 1 ? '' : 's'} whose validation is out of date (${stale.slice(0, 6).join(', ')}) ${stale.length === 1 ? 'is' : 'are'} validated: each one's setup, check, solution and near miss run in a fresh ${cfg.evalIsolation}; a task that fails it is left out of the run.` : '',
  ].filter(line => line !== '').join('\n')
  if (!(await confirm($, question, 'Start the run', 'Not now'))) {
    return { text: 'No run started.' }
  }
  if (stale.length > 0) {
    // Only now, after the person's yes: the stale tasks are validated, and the run takes those that pass.
    suite = await readySuite($, at, cfg, true)
    tasks = tasksFor(suite.valid, without === null ? kind : 'full', cfg)
    invalidNote = invalidNoteOf(suite)
    if (tasks.length === 0) {
      return { text: ['Validated first, and no task is valid, so nothing was run.', invalidNote].filter(line => line !== '').join('\n') }
    }
  }
  await audit($, at.root, 'eval-started', actorOf(e), `${kind}${without === null ? '' : ` without ${without.target}`}`, loop.tree, `${tasks.length} tasks`)
  await beginRun($, at, cfg, { kind: without === null ? kind : 'full', tasks, hashes: Object.fromEntries(suite.valid.map(one => [one.id, one.hash])), without, invalid: [...suite.refused, ...suite.invalid].map(one => one.id).sort() })

  return {
    text: [
      `Eval run started: ${tasks.length} task${tasks.length === 1 ? '' : 's'} on ${model}, ${label}, one at a time. Results show in the Dev loop pane and under /devloop metrics.`,
      suite.validated.length > 0 ? `Validated first: ${suite.validated.join(', ')}.` : '',
      invalidNote,
    ].filter(line => line !== '').join('\n'),
  }
}

/** /devloop eval compare in words. */
export function compareText(history: readonly RunRecord[]): string {
  const compared = compareRuns(history)
  if (compared === null) {
    return 'Fewer than two complete full runs on record: nothing to compare. (Quick runs and ablations are not compared.)'
  }
  const { older, newer } = compared
  const a = headline(older.results)
  const b = headline(newer.results)

  return [
    `Comparing the last two full runs: ${a.passed}/${a.counted} on ${older.model} (${new Date(older.completedAt).toISOString().slice(0, 10)}) and ${b.passed}/${b.counted} on ${newer.model} (${new Date(newer.completedAt).toISOString().slice(0, 10)}).`,
    `Compared ${compared.compared.length} task${compared.compared.length === 1 ? '' : 's'} whose file did not change; left out ${compared.leftOut.length}${compared.leftOut.length > 0 ? ` (${compared.leftOut.join(', ')}: changed, added or removed)` : ''}.`,
    compared.regressions.length > 0 ? `REGRESSIONS (passed, now fail): ${compared.regressions.join(', ')}` : 'No regressions.',
    compared.fixed.length > 0 ? `Now passing: ${compared.fixed.join(', ')}` : '',
  ].filter(line => line !== '').join('\n')
}

/** /devloop eval adopt [id]: lists the suggestions, or scaffolds one as a candidate task under evals/candidates/ (a person, with a dialog). */
async function adopt($: Engine, at: Place, id: string, e: CommandRunInput): Promise<Answer> {
  const list = await listOf<Suggestion>($, `evalsuggest:${at.root}`)
  const open = list.filter(one => one.status === 'open')
  if (id === '') {
    return {
      text: open.length === 0
        ? 'No eval-task suggestions. Escaped defects, review loops that ended failed and changes closed with the gate open each suggest one.'
        : ['Eval-task suggestions from failures (each becomes a candidate under evals/candidates/ when a person adopts it):', ...open.map(one => `  ${one.id}  ${one.source}${one.change === null ? '' : ` (${one.change})`}: ${one.text}`), '/devloop eval adopt <id> scaffolds one.'].join('\n'),
    }
  }
  if (!isFromPerson(e)) {
    return { text: 'An eval task is adopted by a person, from the prompt.' }
  }
  const one = open.find(each => each.id === id)
  if (one === undefined) {
    return { text: `No open suggestion ${id}. /devloop eval adopt lists them.` }
  }
  const file = `evals/candidates/${one.id}.json`
  if (!(await confirm($, `Scaffold ${file} from "${one.text}"? It is a candidate: fill in its prompt and check, validate it (/devloop eval validate), and move it to evals/tasks/ yourself.`, 'Scaffold it', 'Not now'))) {
    return { text: 'Nothing written.' }
  }
  const body = { prompt: `(Reproduce: ${one.text})`, check: '(a command that exits 0 only when the failure is fixed; it must fail on the untouched tree)', tags: ['candidate'], source: `${one.source}${one.change === null ? '' : ` ${one.change}`}: ${one.text}` }
  await $.fs.write(`${at.root}/${file}`, `${JSON.stringify(body, null, 2)}\n`)
  await $.store.set(`evalsuggest:${at.root}`, list.map(each => (each.id === id ? { ...each, status: 'adopted' as const } : each)))
  await audit($, at.root, 'eval-adopted', actorOf(e), file, null, firstLine(one.text, 200))

  return { text: `Wrote ${file}. It is protected from the builder; edit it yourself, then move it to evals/tasks/.` }
}

// ---------------------------------------------------------------- regressions and defects

export async function regressionsCommand($: Engine, at: Place, words: readonly string[], e: CommandRunInput): Promise<Answer> {
  const list = await regressionsOf($, at.root)
  if (words[0] !== 'drop') {
    const loop = await loopOf($)
    const active = list.filter(one => one.status === 'active')

    return {
      text: list.length === 0
        ? 'No regression checks yet. A spec\'s feature checks are kept as regression checks when its change is closed with /devloop done.'
        : [
            `Regression checks (${active.length} active; they run with the full checks when a change ships):`,
            ...active.map(one => {
              const status = loop.regressions[one.id]

              return `  ${one.id}  from ${one.change}, closed ${new Date(one.closedAt).toISOString().slice(0, 10)}: \`${one.check}\` (${status?.passes === true && status.tree === loop.tree ? 'passes on this tree' : status?.passes === false ? 'FAILING' : 'not run on this tree'})`
            }),
            ...list.filter(one => one.status === 'dropped').map(one => `  ${one.id}  retired: ${one.reason ?? ''}`),
            '/devloop regressions drop <id> <reason> retires one (a person\'s call).',
          ].join('\n'),
    }
  }
  const id = words[1] ?? ''
  const reason = words.slice(2).join(' ').trim()
  if (!isFromPerson(e)) {
    return { text: 'A regression check is retired by a person, from the prompt.' }
  }
  if (id === '' || reason === '') {
    return { text: 'Name the check and why it is retired: /devloop regressions drop <spec>/<feature> <reason>.' }
  }
  if (!list.some(one => one.id === id && one.status === 'active')) {
    return { text: `No active regression check ${id}. /devloop regressions lists them.` }
  }
  if (!(await confirm($, `Retire the regression check ${id}? It stops running at the ship gate. Reason: "${reason}"`, 'Retire it', 'Keep it'))) {
    return { text: `${id} is kept.` }
  }
  const now = await $.clock.now()
  await dropRegression($, at.root, id, reason, now)
  await audit($, at.root, 'regression-dropped', actorOf(e), id, (await loopOf($)).tree, firstLine(reason, 200))

  return { text: `${id} is retired: ${reason}` }
}

export async function defectCommand($: Engine, at: Place, raw: string, e: CommandRunInput, cfg: Config | null = null): Promise<Answer> {
  if (!isFromPerson(e)) {
    return { text: 'An escaped defect is recorded by a person, from the prompt.' }
  }
  const match = /(?:^|\s)--change\s+(C\d+)(?:\s|$)/.exec(raw)
  const text = raw.replace(/(?:^|\s)--change\s+C\d+(?=\s|$)/, ' ').trim()
  if (text === '') {
    return { text: 'Say what escaped: /devloop defect <text> [--change C3].' }
  }
  const changes = await listOf<ChangeRecord>($, `changes:${at.root}`)
  const change = match?.[1] ?? changes[changes.length - 1]?.id ?? null
  if (change !== null && !changes.some(one => one.id === change)) {
    return { text: `No change ${change} on record. /devloop metrics --json lists the change records.` }
  }
  const now = await $.clock.now()
  const defect: Defect = { at: now, change, text: firstLine(text, 300), source: 'person' }
  await $.store.set(`defects:${at.root}`, [...(await listOf<Defect>($, `defects:${at.root}`)), defect].slice(-500))
  await audit($, at.root, 'defect-recorded', actorOf(e), change ?? '(no change)', null, firstLine(text, 200))
  await suggestEval($, at.root, 'defect', text, change)
  // The change's entry in the spec library counts it too (DESIGN 4.18).
  if (cfg !== null) {
    await noteLibraryDefect($, at, cfg, change).catch(() => undefined)
  }

  return { text: `Escaped defect recorded against ${change ?? 'no closed change (none on record)'}. An eval-task candidate is suggested: /devloop eval adopt lists it.` }
}

// ---------------------------------------------------------------- metrics, report, audit

export async function metricsCommand($: Engine, at: Place, isJson: boolean, extra: () => Promise<string[]>): Promise<Answer> {
  const counters = await metrics($, at.root)
  const changes = await listOf<ChangeRecord>($, `changes:${at.root}`)
  const defects = await listOf<Defect>($, `defects:${at.root}`)
  const evals = await historyOf($, at.root)
  const cache = await cacheOf($, at.root)
  // Grounding's counts for the session in progress (DESIGN 4.15), beside the store's.
  const sessionId = await $.session.id().catch(() => null)
  const kept = (await $.store.get(`grounding-session:${at.root}`).catch(() => undefined)) as GroundingSession | undefined
  const grounding = kept !== undefined && kept.sessionId === sessionId ? kept : { sessionId, questions: 0, unchecked: 0 }
  const computed = computeMetrics({ counters, changes, defects, evals, cacheHitRate: hitRate(cache.session), grounding })
  if (isJson) {
    // Exactly what is stored: keys, counts, fingerprints, first lines; no prompt text, no file contents.
    const stored = {
      counters,
      changes,
      defects,
      evals,
      regressions: await regressionsOf($, at.root),
      ruleHits: ((await $.store.get(`rulehits:${at.root}`)) as Hits | undefined) ?? {},
      papercuts: await listOf<Papercut>($, `papercuts:${at.root}`),
      ablations: await listOf<AblationEvidence>($, `ablations:${at.root}`),
      costs: ((await $.store.get(`costs:${at.root}`)) as Costs | undefined) ?? EMPTY_COSTS,
      cache,
    }

    return { text: JSON.stringify(stored, null, 2) }
  }
  const quick = [...evals].reverse().find(one => one.kind === 'quick' && one.without === null) ?? null
  const costs = ((await $.store.get(`costs:${at.root}`)) as Costs | undefined) ?? EMPTY_COSTS

  return {
    text: ['devloop metrics for this repository', ...metricsLines(computed, quick), ...costReport(costs), ...(await extra())].filter(line => line !== '').join('\n'),
  }
}

export async function reportCommand($: Engine, at: Place, cfg: Config, rows: readonly Check[]): Promise<Answer> {
  const loop = await loopOf($)
  const changes = await listOf<ChangeRecord>($, `changes:${at.root}`)
  const isOpen = loop.changed.length > 0 || loop.phase !== 'idle'
  const record = isOpen ? null : changes[changes.length - 1] ?? null
  const events = await auditOf($, at.root)
  const since = isOpen ? loop.tally.startedAt ?? 0 : record?.startedAt ?? 0
  const until = isOpen ? Number.MAX_SAFE_INTEGER : record?.closedAt ?? Number.MAX_SAFE_INTEGER
  // Bounded by the last close (C2.1 F11): an earlier change's verdicts are never this one's, however the times compare.
  const closedAt = isOpen ? events.map(one => one.action).lastIndexOf('change-closed') : -1
  const verdicts = events.filter((one, i) => one.action === 'review-verdict' && i > closedAt && one.at >= since && one.at <= until)
  if (!isOpen && record === null) {
    return { text: 'No change in progress and none closed: nothing to report.' }
  }
  if (!isOpen && record !== null) {
    return { text: `The last closed change, ${record.id}${record.spec === null ? '' : ` (${record.spec})`}: tier ${record.tier}, ${record.files.length} files, ${record.lines} lines; gate at close ${record.gate.isGreen ? 'green' : `open (${record.gate.unmet.join('; ')})`}; attested: ${record.attestation === null ? 'nothing' : record.attestation.read.join(', ')}. Start a change for a full report.` }
  }

  return { text: changeReport({ loop, cfg, rows, record: null, verdicts, carry: carryFactsOf(at.root, cfg) }) }
}

export async function auditCommand($: Engine, at: Place, raw: string): Promise<Answer> {
  const n = Number(raw.trim() || '20')

  return { text: await auditReport($, at.root, Number.isFinite(n) && n > 0 ? Math.min(500, Math.floor(n)) : 20) }
}

// ---------------------------------------------------------------- closing a change

/**
 * What /devloop done writes once the person has decided to close: the
 * attestation they give in its own dialog (the only way it is set), the
 * change record, the spec's checks kept as regression checks, and an eval
 * suggestion when the gate was open. Resolves to lines for the answer.
 */
export async function closeChange($: Engine, at: Place, cfg: Config, loop: Loop, rows: readonly Check[], e: CommandRunInput): Promise<{ lines: string[]; id: string }> {
  const changes = await listOf<ChangeRecord>($, `changes:${at.root}`)
  const counters = await metrics($, at.root)
  const id = `C${(counters['change-records'] ?? changes.length) + 1}`
  const now = await $.clock.now()
  // The person says what they read; nothing the builder can call sets this.
  const answer = await $.ui.ask(`What did you read of this change? (recorded on the change as your attestation)`, { options: ['The diff', 'The test changes', 'The instruction-file changes', 'None of it'], multiSelect: true, header: 'Attest' }).catch(() => '')
  const attestation = attestationOf(answer.replace(/none of it/i, ''), now)
  const costs = ((await $.store.get(`costs:${at.root}`)) as Costs | undefined) ?? EMPTY_COSTS
  const cache = await cacheOf($, at.root)
  const deferred = loop.findings.filter(one => one.status === 'deferred').length
  const record = changeRecord(loop, cfg, {
    id, now, rows, costUsd: costs.last === null ? null : costs.change, cacheHitRate: hitRate(cache.change), attestation, deferred,
    inputs: await inputsOf($, cfg, loop.tree),
  })
  const lines: string[] = []
  if (await keepRecord($, at.root, 'change-record@1', `changes:${at.root}`, record, 500)) {
    await $.store.set(`metrics:${at.root}`, { ...(await metrics($, at.root)), 'change-records': (counters['change-records'] ?? changes.length) + 1 })
    lines.push(`Change record ${id} written${attestation === null ? '' : ` (you attested to reading: ${attestation.read.join(', ')})`}.`)
  }
  if (loop.spec !== null && loop.phase === 'build') {
    const features = await readFeatures($, at, loop)
    const kept = await keepRegressions($, at.root, loop.spec, id, features, now)
    if (kept > 0) {
      lines.push(`${kept} feature check${kept === 1 ? '' : 's'} of "${loop.spec}" kept as regression checks (/devloop regressions).`)
    }
  }
  if (!record.gate.isGreen) {
    await suggestEval($, at.root, 'closed-gate-open', `${id} closed with the gate open: ${record.gate.unmet[0] ?? ''}`, id)
  }
  await audit($, at.root, 'change-closed', actorOf(e), id, loop.tree, record.gate.isGreen ? 'gate green' : `gate open: ${record.gate.unmet.map(one => one.split(':')[0]).join(', ')}`)

  return { lines, id }
}

/** Brings the loop's regression set in step after a close. */
export async function afterClose($: Engine, root: string): Promise<void> {
  await syncRegressions($, root)
}
