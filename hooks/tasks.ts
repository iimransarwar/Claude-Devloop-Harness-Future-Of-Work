// The `.tasks` convention at the edges (D2, docs/design-notes/rea-and-tasks.md,
// folded into DESIGN 4.12): devloop implements none of the format and calls
// the `tasks` command for it; what it adds is what only it can enforce, as
// rules on the agent's own tool calls. Every rule here is pure, shared by the
// three enforcement points (the module, the classic hooks, the command line),
// and active only where the integration is on: `tasks.integrate` is not
// `off` in the policy in force, the repository has a `.tasks/` tree declaring
// version 2, and the `tasks` command is on the PATH. The readers decide that
// and say it in `TasksFacts`. Pure: no `$`, no Node.

import { globParts, lockedBeneath } from './rules'
import type { Where } from './rules'
import { assignedBefore, flagValue, hasFlag, operands, readings } from './shell'
import type { Segment } from './shell'

/** The folder the convention keeps its tree in, at the repository's root. */
export const TASKS_DIR = '.tasks'

/** What the readers found for the `.tasks` rules: whether the integration is on, and whether this tree may finish a task. */
export type TasksFacts = {
  /** The policy turns it on, a version 2 tree is there and the command is installed. */
  isOn: boolean
  /**
   * Whether the gate is green on the current tree and the tier needs no
   * person's approval: what `tasks done` needs from devloop. Null when the
   * reader could not tell (a stateless reader, or a gate it did not prove),
   * which refuses (principle 8).
   */
  canFinish: boolean | null
  /** Why not, in a few words, for the refusal. */
  finishWhy: string
}

/** The integration off: no `.tasks` rule applies. */
export const TASKS_OFF: TasksFacts = { isOn: false, canFinish: null, finishWhy: '' }

/** Whether `.tasks/config.yml` declares version 2 of the convention (a tree without it is v1, which the command itself refuses). */
export const isVersion2 = (configText: string | null): boolean => configText !== null && /^version:\s*["']?2["']?\s*(#.*)?$/m.test(configText)

/** The sub-commands that only read task state (and `heartbeat`, which touches the session's lock file and nothing in the tree). */
const READS = ['show', 'resume', 'ready', 'mine', 'actors', 'list', 'tree', 'log', 'validate', 'session-check', 'heartbeat', 'help', 'version', 'reindex']

/** Transitions to a resolved status: devloop's gate is the finish gate for these. */
const RESOLVING = ['done', 'cancel']

/** The command's own name, and its package's (`@speekl/tasks`), with or without a version. */
const isTasksName = (text: string): boolean => /^(?:@speekl\/tasks|tasks)(?:@[^\s/]+)?$/.test(text)

/** The options of the package runners that take a value, so the package they run is found after them. */
const RUNNER_VALUES: Record<string, { short: string; long: readonly string[] }> = {
  npx: { short: 'pc', long: ['--package', '--call', '--cache', '--userconfig'] },
  bunx: { short: 'p', long: ['--package', '--bun'] },
  pnpm: { short: 'C', long: ['--dir', '--filter', '--package'] },
  yarn: { short: '', long: ['--cwd', '--package'] },
  npm: { short: 'pc', long: ['--package', '--call', '--prefix', '--workspace'] },
}

/**
 * The arguments a segment passes to the `tasks` command (final round, D2
 * F8): run by name, or through a package runner (`npx`, `bunx`, `pnpm
 * exec|dlx`, `yarn dlx|exec`, `npm exec`) as `tasks` or as the package's
 * own name, `@speekl/tasks`. Null when the segment does not run it.
 */
export function tasksArgs(segment: Segment): readonly Segment['args'][number][] | null {
  if (segment.program !== null && isTasksName(segment.program)) {
    return segment.args
  }
  const runner = segment.program === null ? undefined : RUNNER_VALUES[segment.program]
  if (runner === undefined || segment.program === null) {
    return null
  }
  let args = segment.args
  if (segment.program === 'pnpm' || segment.program === 'yarn' || segment.program === 'npm') {
    const verb = operands(args, runner.short, runner.long)[0]
    if (verb === undefined || !['exec', 'dlx', 'x'].includes(verb.text)) {
      return null
    }
    args = args.slice(args.indexOf(verb) + 1)
  }
  const named = operands(args, runner.short, runner.long).filter(word => word.text !== '--')
  // `--package=@speekl/tasks tasks …` names the package apart from the command it runs.
  const head = named[0]
  if (head === undefined || !isTasksName(head.text)) {
    return null
  }

  return args.slice(args.indexOf(head) + 1)
}

/** The `tasks` action a segment runs (its first operand, and the one after for `dep`/`after`), or null when the segment is not the tasks command. */
export function tasksAction(segment: Segment): { action: string | null; next: string | null } | null {
  const args = tasksArgs(segment)
  if (args === null) {
    return null
  }
  const said = operands(args, 'Cm', ['--as', '--session', '--message', '--actor'])

  return { action: said[0]?.text ?? null, next: said[1]?.text ?? null }
}

/** Whether a `tasks` action only reads. `dep list` and `after list` read; a bare `tasks` prints its help. */
const isReadAction = (one: { action: string | null; next: string | null }): boolean =>
  one.action === null || one.action.startsWith('-') || READS.includes(one.action) || ((one.action === 'dep' || one.action === 'after') && (one.next === null || one.next === 'list'))

/** Whether a line runs a `tasks` command that writes task state: an eval agent may run none (its worktree resolves to the real tree). */
export function writesTaskState(command: string): boolean {
  // A write under either reading counts (BB1).
  return readings(command).flat().some(segment => {
    const one = tasksAction(segment)

    return one !== null && !isReadAction(one)
  })
}

/** Whether a line moves a task to a resolved status (`done`, `cancel`): the reader then proves the gate for `TasksFacts.canFinish`. */
export function finishesTask(command: string): boolean {
  return readings(command).flat().some(segment => {
    const one = tasksAction(segment)

    return one !== null && one.action !== null && RESOLVING.includes(one.action)
  })
}

/** The task a resolving line names, for the hand-off command in the refusal. */
const taskOf = (segment: Segment): string => {
  const said = operands(tasksArgs(segment) ?? segment.args, 'Cm', ['--as', '--session', '--message', '--actor'])

  return said[1]?.text ?? '<task>'
}

/** The convention's hand-off to a person, which is the agent's move when it may not finish. */
export const handoffCommand = (task: string): string => `tasks handoff <person> ${task} -m "<what is done, what the person must check>"`

/**
 * Every `.tasks` rule a shell line breaks (rule `tasks`), when the
 * integration is on: the command's force and act-as options (and an inline
 * `TASKS_ACTOR=`), and a transition to a resolved status unless devloop's
 * gate is green and the tier needs no person. Each refusal names the command
 * to use instead.
 */
export function tasksCommandRefusals(command: string, facts: TasksFacts): { rule: 'tasks'; reason: string }[] {
  // A refusal under either reading stands (BB1); a forbidden value under either is forbidden.
  const all = readings(command).flatMap(segments => tasksRefusalsIn(segments, facts))

  return all.filter((one, i) => all.findIndex(other => other.reason === one.reason) === i)
}

/** The `.tasks` rules a line breaks under one reading (BB1): the segments the judge parsed. */
export function tasksRefusalsIn(segments: readonly Segment[], facts: TasksFacts): { rule: 'tasks'; reason: string }[] {
  if (!facts.isOn) {
    return []
  }
  const out: { rule: 'tasks'; reason: string }[] = []
  for (const [i, segment] of segments.entries()) {
    const one = tasksAction(segment)
    const args = tasksArgs(segment)
    if (one === null || args === null) {
      continue
    }
    if (hasFlag(args, null, ['--force'])) {
      out.push({ rule: 'tasks', reason: '`tasks --force` overrides the convention\'s authorization, its start gate and a live claim: that is a person\'s call. Run the command without it; if it is refused, say why and leave it to the person.' })
    }
    const as = flagValue(args, null, '--as')
    // The actor variable set inline, or exported or assigned anywhere earlier on the line (final round, D2 F8).
    // Any value set earlier holds: nothing later on the line cancels it (the last review's F3).
    const earlier = assignedBefore('TASKS_ACTOR', segments.slice(0, i))
    const actor = segment.assignments.find(word => word.startsWith('TASKS_ACTOR=')) ?? (earlier[0] === undefined ? undefined : `TASKS_ACTOR=${earlier[0].isComputed ? '…' : earlier[0].value}`)
    if (as !== null || actor !== undefined) {
      out.push({ rule: 'tasks', reason: `Acting as another actor (${as !== null ? `--as ${as}` : actor ?? ''}) is the person's to do: run the command as yourself, or hand the task over with \`${handoffCommand(taskOf(segment))}\`.` })
    }
    if (one.action !== null && RESOLVING.includes(one.action) && facts.canFinish !== true) {
      out.push({
        rule: 'tasks',
        reason: `\`tasks ${one.action}\` resolves a task, and devloop's gate is the finish gate: ${facts.canFinish === false ? facts.finishWhy || 'the gate is not green on this tree, or the change needs a person\'s approval' : 'the harness could not prove the gate here'}. Hand the task to a person instead: \`${handoffCommand(taskOf(segment))}\`.`,
      })
    }
  }

  return out
}

/** A task's manifest: `.tasks/<path>/task.md`. */
export const isTaskFile = (rel: string): boolean => /^\.tasks\/(?:[^/]+\/)*task\.md$/.test(rel)

/** A task's append-only history, written by the command alone: `.tasks/<path>/log.md`. */
export const isTaskLog = (rel: string): boolean => /^\.tasks\/(?:[^/]+\/)*log\.md$/.test(rel)

/** The tree's own files the agent does not edit: its configuration, its locks, its derived index. */
const isTreeFile = (rel: string): boolean => rel === '.tasks/config.yml' || rel === '.tasks/index.md' || rel === '.tasks/.locks' || rel.startsWith('.tasks/.locks/')

/** A task's frontmatter, the text between its opening and closing `---` fences; null when it has none. */
export function frontmatterOf(text: string): string | null {
  const lines = text.replace(/\r\n/g, '\n').split('\n')
  if (lines[0]?.trim() !== '---') {
    return null
  }
  const end = lines.findIndex((line, i) => i > 0 && line.trim() === '---')

  return end < 0 ? null : lines.slice(1, end).join('\n')
}

/**
 * Whether an edit tool's write of one path breaks a `.tasks` rule: the log
 * (only the command writes it), the tree's configuration, locks and index,
 * and a `task.md` edit that changes anything between its frontmatter fences
 * (status, claim and dates are the command's: `tasks <transition>`).
 * `before` is null for a file not there yet. Null when the rule is off or the
 * edit keeps to what an agent may write.
 */
export function tasksEditRefusal(rel: string, before: string | null, after: string | null, facts: TasksFacts): { rule: 'tasks'; reason: string } | null {
  if (!facts.isOn || !rel.startsWith(`${TASKS_DIR}/`)) {
    return null
  }
  if (isTaskLog(rel)) {
    return { rule: 'tasks', reason: `${rel} is a task's log: the \`tasks\` command appends to it with each transition and note, and nothing else writes it. Use \`tasks note <task> -m "…"\` or the transition itself.` }
  }
  if (isTreeFile(rel)) {
    return { rule: 'tasks', reason: `${rel} belongs to the task tree itself (its configuration, locks or derived index): a person edits the configuration; the command keeps the rest.` }
  }
  if (isTaskFile(rel) && (after === null || frontmatterOf(before ?? '') !== frontmatterOf(after))) {
    return { rule: 'tasks', reason: `This edit changes ${rel}'s frontmatter (between the --- fences), which the \`tasks\` command owns: use \`tasks claim|pause|release|handoff|priority|assign <task>\` for status, claim and assignment. The body below the fences is yours to edit.` }
  }

  return null
}

/**
 * The `.tasks` edit rule over every place an edit tool's path is placed at:
 * as spelled and where its links lead, inside the repository or spelled from
 * outside it (final round, D2 F7; the last review's F5). The one function
 * the module's guard and the stateless core both call.
 */
export function tasksEditRefusalOf(placed: readonly { rel: string | null }[], before: string | null, after: string | null, facts: TasksFacts): { rule: 'tasks'; reason: string } | null {
  for (const one of placed) {
    const refusal = one.rel === null || one.rel === '' ? null : tasksEditRefusal(one.rel, before, after, facts)
    if (refusal !== null) {
      return refusal
    }
  }

  return null
}

/** The task tree's files a shell write may not touch, as globs, for the folder expansion: manifests, logs, its configuration, index and locks. */
export const TASKS_LOCKED: readonly string[] = [`${TASKS_DIR}/**/task.md`, `${TASKS_DIR}/**/log.md`, `${TASKS_DIR}/config.yml`, `${TASKS_DIR}/index.md`, `${TASKS_DIR}/.locks/**`]

/** Whether one path is a file of the task tree a shell write may not touch. */
const isTasksLocked = (rel: string): boolean => isTaskLog(rel) || isTaskFile(rel) || isTreeFile(rel)

/**
 * Whether a shell command's write of one path breaks a `.tasks` rule: a
 * shell write cannot be compared, so a task's manifest and log (and the
 * tree's own files) are refused outright. A folder or a shell glob is
 * expanded as the protected-path rule expands it (final round, D2 F3): the
 * tracked files the reader listed beneath it, and the paths the locked globs
 * make under it (`lockedBeneath`), so `rm -r .tasks/web`, `cp x
 * .tasks/web/login/`, `mv .tasks/web y` and `.tasks/web/*\/task.md` are seen.
 * `where` gives the listing (`filesUnder`) and which paths are folders.
 */
export function tasksShellWriteRefusal(rel: string, facts: TasksFacts, where: Pick<Where, 'filesUnder' | 'folders'> = { filesUnder: {}, folders: {} }): { rule: 'tasks'; reason: string } | null {
  if (!facts.isOn) {
    return null
  }
  const refuse = (named: string): { rule: 'tasks'; reason: string } => ({
    rule: 'tasks',
    reason: `${named} is written by the \`tasks\` command (a manifest's frontmatter, a log, the tree's own files), and a shell write cannot be told apart from a change to its state. Use the command (\`tasks state|note|<transition> <task>\`), or the edit tool for a task's body.`,
  })
  const { dir, within } = globParts(rel)
  if (within === '' && isTasksLocked(rel)) {
    return refuse(rel)
  }
  const isFolder = within !== '' || where.folders[dir] !== false
  const isNear = dir === '' || dir === TASKS_DIR || dir.startsWith(`${TASKS_DIR}/`)
  if (!isFolder || !isNear) {
    return null
  }
  const reached = lockedBeneath(dir, within, TASKS_LOCKED, where.filesUnder[dir] ?? []).find(one => isTasksLocked(one.path))

  return reached === undefined ? null : refuse(reached.label)
}

// ---------------------------------------------------------------- the review carry-over (decided after the .tasks note)

/** A path that holds task state for the carry-over rule: under `.tasks/`, ending in `.md`, `.yml` or `.yaml`. */
export const isTaskStatePath = (path: string): boolean => path.startsWith(`${TASKS_DIR}/`) && /\.(?:md|ya?ml)$/.test(path) && !path.split('/').includes('..')

/**
 * Whether a review verdict carries over from the reviewed tree to the current
 * one: every path that differs between the two (git's list, `CARRY_DIFF`) is
 * task state. An empty list (the same content) is no carry: the verdict is on
 * that tree already. Nothing is left out of the hash: verification re-runs on
 * the tree as it is; only the review verdict carries.
 */
export const isTaskStateOnly = (paths: readonly string[]): boolean => paths.length > 0 && paths.every(isTaskStatePath)

/** The convention's session check, as `tasks session-check --json` reports it: the tasks this session left without a resume point. */
export function sessionCheckProblems(code: number, out: string): string | null {
  if (code === 0) {
    return null
  }
  try {
    const parsed = JSON.parse(out) as { violations?: { task?: string; id?: string; reason?: string; message?: string }[]; message?: string }
    const lines = (parsed.violations ?? []).slice(0, 6).map(one => `${one.task ?? one.id ?? '?'}${one.reason ?? one.message ? `: ${one.reason ?? one.message ?? ''}` : ''}`)
    if (lines.length > 0) {
      return lines.join('; ')
    }
  } catch {
    // Not JSON: the command's own words, cut.
  }
  const said = out.split('\n').map(line => line.trim()).filter(line => line !== '').slice(0, 4).join(' ')

  return said === '' ? `exit ${code}` : said.slice(0, 400)
}
