// The stateless core (DESIGN 4.11): the rules that need no plugin state,
// applied to one tool call, and the gate as it can be proven from the tree
// alone. The hooks module's guards call the same rule functions
// (hooks/rules.ts, weaken.ts, contentrules.ts); the classic hooks and the
// command line (cli/, bundled into dist/devloop.mjs) call these. Nothing here
// decides a rule of its own: each refusal is one the module would give for
// the same call with no spec, no exemption and no review on record. Pure: no
// `$`, no Node.

import type { Loop, Phase, Tier } from '../types'
import { DEFAULTS } from './config'
import type { Config } from './config'
import { judgeContent, contentReason, rulesFor } from './contentrules'
import { FRESH } from './fresh'
import { approvalsFor, approvers, tierWithBlast } from './gate'
import { digest } from './output'
import {
  LINK_BUDGET, WRITE_LINK_BUDGET, budgetRefusals, followedPlaces, harnessStateReason, isHarnessState, isOnDefault, isPushToDefault, isSecretPlace, judgeCommandAll, judgeWrite, matchesAny,
  namedPlacesByReading, place, pushesOtherBranch, PUSH_ADVICE, shipsOf, whereOf, writtenPathsByReading,
} from './rules'
import type { Placed, Refusal, ShipIntent, Verdict, Where } from './rules'
import type { Snapshot } from './scripts'
import { tasksEditRefusalOf, tasksShellWriteRefusal } from './tasks'
import { editedText, judgeTestEdit } from './weaken'

// ---------------------------------------------------------------- the harness's state, shared by every enforcement point

/** The default state root when the engine names no plugin data folder (the module's `stateRootOf` falls back the same way). */
export const STATE_FALLBACK = '/tmp/devloop-state'

/** The harness's state root from the plugin data variable: `CLAUDE_PLUGIN_DATA`, trailing slashes dropped, else the fallback. */
export const stateRootFrom = (data: string | undefined | null): string =>
  data === undefined || data === null || data === '' ? STATE_FALLBACK : data.replace(/\/+$/, '')

/** A repository's folder within the state root, keyed by its root (the module's `stateDirOf`). */
export const repoStateDir = (stateRoot: string, root: string): string => `${stateRoot}/repos/${digest(root)}`

/** A name safe as one path part, from any id the engine gives (a tool_use_id, a session id). */
const part = (id: string): string => (/^[A-Za-z0-9_-]{1,120}$/.test(id) ? id : digest(id))

/**
 * Where the module stamps a tool call it judged (D1): one small file per
 * call, keyed by its `tool_use_id`, written before the call goes on, so the
 * classic PreToolUse hook beneath it stands down. The classic hook removes a
 * stamp it read, and keeps the folder to the newest few hundred.
 */
export const stampPath = (stateRoot: string, toolUseId: string): string => `${stateRoot}/stamps/calls/${part(toolUseId)}`

/** How many call stamps the folder keeps before the oldest are removed. */
export const STAMPS_KEPT = 300

/** Where the module says it is live in a session (D1): refreshed at the session's start and each main-loop turn. */
export const heartbeatPath = (stateRoot: string, sessionId: string): string => `${stateRoot}/stamps/live/${part(sessionId)}`

/** Where the module stamps a stop it judged: one file per session, holding the stop's key. */
export const stopStampPath = (stateRoot: string, sessionId: string): string => `${stateRoot}/stamps/stops/${part(sessionId)}`

/**
 * Where the module stamps a prompt it saw (DESIGN 4.15): one file per
 * session, holding the prompt's digest, so the classic UserPromptSubmit hook
 * beneath it does not add the grounding nudge a second time.
 */
export const promptStampPath = (stateRoot: string, sessionId: string): string => `${stateRoot}/stamps/prompts/${part(sessionId)}`

/** Where the classic hook notes it told a session the full harness is not loaded, once. */
export const noticePath = (stateRoot: string, sessionId: string): string => `${stateRoot}/stamps/notices/${part(sessionId)}`

/**
 * A stop's key: the same for the module's `classic.Stop` hook and the classic
 * Stop command hook, which receive the same input. A session's stops differ
 * by the prompt they end and the last thing the assistant said.
 */
export function stopKey(input: { session_id?: unknown; prompt_id?: unknown; last_assistant_message?: unknown; stop_hook_active?: unknown }): string {
  const text = (value: unknown): string => (typeof value === 'string' ? value : '')

  return digest([text(input.session_id), text(input.prompt_id), text(input.last_assistant_message), input.stop_hook_active === true ? '1' : '0'].join('\n'))
}

/**
 * The events the classic hooks hand the module (D1), one JSON line each in
 * the repository's state folder: the module folds them into the ledger and
 * the audit trail at its next prompt. The stateless record path.
 */
export const inboxPath = (stateRoot: string, root: string): string => `${repoStateDir(stateRoot, root)}/classic-inbox.jsonl`

export type InboxEvent = {
  at: number
  /** `module-skipped`: the module was live but did not judge this call; `module-absent`: no module in this session. */
  kind: 'module-skipped' | 'module-absent' | 'classic-refusal' | 'answer-unchecked'
  session: string
  tool: string
  subject: string
  rule: string | null
}

/** The inbox's lines that parse, in order. */
export function readInbox(text: string): InboxEvent[] {
  const out: InboxEvent[] = []
  for (const line of text.split('\n')) {
    try {
      const one = JSON.parse(line) as InboxEvent
      if (typeof one === 'object' && one !== null && typeof one.kind === 'string' && typeof one.at === 'number') {
        out.push(one)
      }
    } catch {
      // A line that does not parse is skipped.
    }
  }

  return out
}

// ---------------------------------------------------------------- one call, judged without state

/** The loop the stateless core judges by: no spec, no exemption, nothing approved, in the phase given. */
export const statelessLoop = (phase: Phase = 'idle'): Loop => ({ ...FRESH, phase })

/** Whether a search pattern targets secret files: as written, or with its wildcards taken out. */
export function isSecretPattern(pattern: string, cwd: string, where: Where, cfg: Config): boolean {
  const name = pattern.slice(pattern.lastIndexOf('/') + 1)
  const bare = name.replace(/[*?[\]{}]/g, '')

  return [pattern, bare].some(one => one !== '' && isSecretPlace(place(one, cwd, where), cfg))
}

/** A tool call as a classic hook or the command line sees it. */
export type Call = { tool: string; input: Record<string, unknown> }

/** What the caller gathered for the judge: the readers differ, the rules do not. */
export type CallFacts = {
  cfg: Config
  isOptedIn: boolean
  where: Where
  loop: Loop
  /**
   * Where a path leads once its links are followed: every place other than
   * its own, from both places it is put (the text-folded one and, after a
   * link, the physical one: the thirteenth round, BB2), each judged; none
   * when it leads nowhere else or cannot be told.
   */
  realOf: (path: Placed) => readonly Placed[]
  /** A file's text, or null when it is not there. */
  readText: (abs: string) => string | null
}

export const EDIT_TOOLS = ['Edit', 'Write', 'NotebookEdit']
export const FILE_TOOLS = ['Read', ...EDIT_TOOLS]
export const SEARCH_TOOLS = ['Grep', 'Glob']
export const SHELL_TOOLS = ['Bash', 'Monitor']
/** Every tool the guards judge, as the classic hook's matcher names them. */
export const JUDGED_TOOLS = [...FILE_TOOLS, ...SEARCH_TOOLS, ...SHELL_TOOLS]

const textOf = (input: Record<string, unknown>, key: string): string => (typeof input[key] === 'string' ? (input[key] as string) : '')

/** The path an edit or read tool names. */
export const filePathOf = (call: Call): string => textOf(call.input, call.tool === 'NotebookEdit' ? 'notebook_path' : 'file_path')

/** The shell text a Bash or Monitor call runs. */
export const commandOf = (call: Call): string => textOf(call.input, 'command')

/**
 * Every refusal the stateless core gives one call, in the order the module's
 * guard finds them: secrets anywhere, the harness's state, the path rules
 * (protected, locked, high risk outside a build), test weakening on an edit,
 * content rules that refuse (a `refuse` rule's match, a ratchet that rises), and for a command every command rule
 * (destructive, production, forbidden, egress, `--no-verify`, forced push,
 * ship-alone, a ship from elsewhere, the evidence notes). Shipping itself
 * goes through the gate, which the caller proves (`shipRules` and the
 * stateless gate). Without a policy only secrets are judged.
 */
export function judgeCall(call: Call, facts: CallFacts): Refusal[] {
  const { cfg, where, loop, isOptedIn } = facts
  const out: Refusal[] = []
  const tool = call.tool
  if (FILE_TOOLS.includes(tool)) {
    const file = filePathOf(call)
    const spelled = place(file, where.cwd, where)
    const placed = [spelled, ...facts.realOf(spelled)]
    if (placed.some(one => isSecretPlace(one, cfg))) {
      out.push({ rule: 'secret', reason: `${file} holds secrets; it is never read or written from here.` })
    }
    if (tool === 'Read') {
      return out
    }
    const state = placed.find(one => isHarnessState(one, where))
    if (state !== undefined) {
      out.push({ rule: 'harness-state', reason: harnessStateReason({ ...state, spelled: file }) })
    }
    if (!isOptedIn) {
      return out.filter(one => one.rule === 'secret')
    }
    const asFile = (one: Placed): Where => (one.rel === null ? where : { ...where, folders: { ...where.folders, [one.rel]: false } })
    for (const one of placed) {
      const verdict = judgeWrite(one, cfg, loop, asFile(one))
      if (verdict !== null && verdict.rule !== 'secret') {
        out.push(verdict)
      }
    }
    const rel = spelled.rel ?? ''
    const before = tool === 'NotebookEdit' || spelled.abs === null ? null : facts.readText(spelled.abs)
    const after = tool === 'NotebookEdit' ? null : editedText(before ?? '', { ...call.input, tool })
    // The `.tasks` rules (D2): a task's frontmatter and log are the command's to write. Every placed path is judged, the
    // spelled one and where it leads, however it is spelled (final round, D2 F7; the last review's F5: a link from outside the repository).
    const tasks = tool === 'NotebookEdit' || where.tasks === undefined ? null : tasksEditRefusalOf(placed, before, after, where.tasks)
    if (tasks !== null) {
      out.push(tasks)
    }
    if (tool !== 'NotebookEdit' && rel !== '') {
      if (matchesAny(rel, cfg.tests) && after !== null) {
        const edit = judgeTestEdit(before ?? '', after)
        if (edit.isWeakened) {
          out.push({ rule: 'test-weakened', reason: `This edit ${before !== null ? 'adds' : 'creates a test file with'} skip, only, todo or xfail markers ${before !== null ? 'to' : 'in'} ${rel} (${edit.before.skips} before, ${edit.after.skips} after), which switches tests off. Make the code pass the test instead. If the test is truly wrong, say so and stop: a person can allow it for one turn with /devloop allow ${rel}.` })
        } else if (edit.isEmptied) {
          out.push({ rule: 'test-weakened', reason: `This edit empties ${rel}, which deletes its tests. If the test is truly obsolete, say so and stop: a person can allow it for one turn with /devloop allow ${rel}.` })
        }
      }
      if (after !== null && rulesFor(rel, cfg.rules).length > 0) {
        for (const one of judgeContent(rel, before ?? '', after, cfg.rules).filter(each => each.verdict === 'refuse')) {
          out.push({ rule: 'content-rule', id: one.rule.id, reason: contentReason(one, rel) })
        }
      }
    }

    return out
  }
  if (SEARCH_TOOLS.includes(tool)) {
    const named = [textOf(call.input, 'path'), tool === 'Glob' ? textOf(call.input, 'pattern') : textOf(call.input, 'glob')].filter(one => one !== '')
    if (named.some(one => isSecretPattern(one, where.cwd, where, cfg))) {
      out.push({ rule: 'secret', reason: 'This search targets secret files; they are never read from here.' })
    }
    const path = textOf(call.input, 'path')
    if (path !== '') {
      if (facts.realOf(place(path, where.cwd, where)).some(real => isSecretPlace(real, cfg))) {
        out.push({ rule: 'secret', reason: `${path} leads to files that hold secrets; they are never read from here.` })
      }
    }

    return out
  }
  if (SHELL_TOOLS.includes(tool)) {
    const text = commandOf(call)
    let found = judgeCommandAll(text, cfg, isOptedIn ? loop : { ...loop, phase: 'idle', spec: null }, where)
    for (const one of followedPlaces(namedPlacesByReading(text, where), LINK_BUDGET)) {
      if (facts.realOf(one).some(real => isSecretPlace(real, cfg))) {
        found.push({ rule: 'secret', reason: `${one.spelled} leads to a file that holds secrets; no command reads or writes it from here.` })
      }
    }
    // Past a budget the rest of the line would go unjudged: the line is refused instead (the twelfth round, X10, X12).
    found.push(...budgetRefusals(text, where, isOptedIn))
    if (isOptedIn) {
      for (const one of followedPlaces(writtenPathsByReading(text, where), WRITE_LINK_BUDGET)) {
        found.push(...facts.realOf(one).flatMap(real => resolvedWriteRefusals(real, cfg, loop, where)))
      }
    } else {
      found = found.filter(one => one.rule === 'secret')
    }
    out.push(...found)
  }

  return out
}

/**
 * What the rules make of the place a shell write's path leads to, once its
 * links are followed: the path rules, and the `.tasks` shell rule (the last
 * review's F6: a write through a link to a task's manifest or log goes
 * through the same rule as a write that names it). Shared by the module's
 * guard and the stateless core.
 */
export function resolvedWriteRefusals(real: Placed, cfg: Config, loop: Loop, where: Where): Refusal[] {
  const out: Refusal[] = []
  const verdict = judgeWrite(real, cfg, loop, where)
  if (verdict !== null) {
    out.push(verdict)
  }
  const tasks = where.tasks === undefined || real.rel === null || real.rel === '' ? null : tasksShellWriteRefusal(real.rel, where.tasks, where)
  if (tasks !== null) {
    out.push(tasks)
  }

  return out
}

/**
 * The last line of a guard that failed partway, shared by the module and the
 * classic hook: whether the call names a secret by the default globs (its
 * command, path, pattern or glob). Secrets hold in every mode, so even a
 * broken guard refuses them. Pure, with no reader: nothing here can fail.
 */
export function namesDefaultSecret(tool: string, input: Readonly<Record<string, unknown>>): boolean {
  const where = whereOf('/', '/')
  const text = (key: string): string => (typeof input[key] === 'string' ? (input[key] as string) : '')
  if (SHELL_TOOLS.includes(tool)) {
    return judgeCommandAll(text('command'), DEFAULTS, FRESH, where).some(one => one.rule === 'secret')
  }

  return ['file_path', 'notebook_path', 'path', 'pattern', 'glob'].some(key => text(key) !== '' && isSecretPattern(text(key), '/', where, DEFAULTS))
}

// ---------------------------------------------------------------- shipping, without state

/** What a line ships, a merge counted only where it ships (on, or possibly on, the default branch). */
export const shippingOf = (text: string, branch: string | null, defaultBranch: string): ShipIntent[] =>
  shipsOf(text).filter(one => one.kind !== 'merge' || isOnDefault(one, branch, defaultBranch))

/**
 * The shipping rules decided before the gate (the module's `judgeShipping`
 * and the classic hook share them): merging is a person's; a push of a
 * branch other than the one checked out ships what the gate never saw; a
 * push that lands on the default branch is judged on its commits' files,
 * whose sources `ranges` gives (null: not known here). Null: the gate decides.
 */
export function shipRules(intents: readonly ShipIntent[], branch: string | null, cfg: Config, tier: Tier, ranges: Readonly<Record<string, readonly string[] | null>>): Verdict {
  if (intents.some(one => one.kind === 'pr-merge')) {
    return { rule: 'human-merge', reason: `Merging a pull request is a person's call: the harness cannot see the pull request's own risk. For this change: ${approvers(tier, cfg)}. Leave the merge to them.` }
  }
  if (intents.some(one => one.kind === 'merge')) {
    return { rule: 'human-merge', reason: `Merging into ${cfg.defaultBranch} is a person's call. Push your branch and open a pull request instead.` }
  }
  // The agent's push has one shape (the cache-guard round, R1, P-A): anything else is refused, with the command to run
  // instead. A push that names no source (the last review's F8) is one such: it sends more than the gate judged.
  for (const intent of intents) {
    if (intent.kind === 'push' && intent.misshapen !== undefined && intent.misshapen !== null) {
      return { rule: 'gate', reason: `This push is not of the one shape the harness judges (${intent.misshapen}): the gate judges only the tree checked out, and a push of any other shape can send what it never saw. ${PUSH_ADVICE}${branch !== null && branch !== '(detached)' ? ` Here: \`git push -u origin ${branch}\` or \`git push -u origin HEAD\`.` : ''} Tags, other branches and pushes that configure git are a person's.` }
    }
  }
  for (const intent of intents) {
    const other = pushesOtherBranch(intent, branch)
    if (other !== null) {
      return { rule: 'gate', reason: `This push ships ${other}, which is not the branch you are on (${branch ?? 'a detached head'}); the gate judged only the tree checked out. Push the branch you are on (\`git push -u origin HEAD\`), or switch to ${other} first and push it by itself.` }
    }
  }
  for (const intent of intents) {
    if (intent.kind !== 'push' || !isPushToDefault(intent, branch, cfg.defaultBranch)) {
      continue
    }
    const files = ranges[pushSource(intent, cfg.defaultBranch)] ?? null
    if (files === null) {
      return { rule: 'human-merge', reason: `This push would land on ${cfg.defaultBranch}, and the harness cannot tell what it would land (origin/${cfg.defaultBranch} is not known here). Pushing to the default branch is a person's call.` }
    }
    const landed = tierWithBlast(files, 0, cfg)
    if (approvalsFor(landed, cfg) > 0) {
      return { rule: 'human-merge', reason: `This push would land a ${landed}-risk change on ${cfg.defaultBranch}: ${approvers(landed, cfg)}. Push a branch and open the pull request; a person merges it.` }
    }
  }

  return null
}

/** The source a push to the default branch sends: the one named for it, else HEAD. */
export function pushSource(intent: ShipIntent, defaultBranch: string): string {
  if (intent.kind !== 'push') {
    return 'HEAD'
  }

  return intent.sources[intent.targets.indexOf(defaultBranch)] ?? 'HEAD'
}

/** The sources whose landed files `shipRules` needs: the pushes that land on the default branch. */
export const pushesToDefault = (intents: readonly ShipIntent[], branch: string | null, defaultBranch: string): string[] =>
  [...new Set(intents.filter(one => one.kind === 'push' && isPushToDefault(one, branch, defaultBranch)).map(one => pushSource(one, defaultBranch)))]

/** What the snapshot saw beside the trees (the last review's F2, F9): entries git is told not to look at, and the files that differ from HEAD. */
export type PushSeen = Pick<Snapshot, 'hidden' | 'differs' | 'differCount'>

/** The differing files, as a refusal names them: up to five, each untracked one marked so, and how many more. */
export function differList(seen: Pick<Snapshot, 'differs' | 'differCount'>): string {
  const shown = seen.differs.slice(0, 5).map(one => `${one.path}${one.isUntracked ? ' (untracked)' : ''}`)
  const more = Math.max(0, seen.differCount - shown.length)

  return `${shown.join(', ')}${more > 0 ? `, and ${more} more` : ''}`
}

/** The three ways out of a tree that differs from its last commit (F9): each one works, untracked files included. */
export const COMMIT_OR_STASH = 'Commit them (`git add -A`, then `git commit`), stash them with `git stash -u` (a plain `git stash` leaves untracked files behind), or ignore them (`.gitignore`, or `.git/info/exclude` for this clone only), then push again.'

/**
 * What a push sends against what the gate judged (final round, D1 F4): the
 * gate judges the working tree, a push sends commits, and they must be the
 * same thing. `committable` is the tree a commit of everything would make
 * (the snapshot's, without the ignored instruction files it forces into the
 * verified tree); `sent` is the tree of each commit the push sends (HEAD's,
 * or each one git's pre-push input names). An index entry git is told not
 * to look at (skip-worktree or assume-unchanged) hides its changes from both
 * trees, so any one refuses, named (the last review's F2). Any difference,
 * or a tree that cannot be told, refuses: commit or stash first, naming up
 * to five of the files that differ, which are untracked, and the remedies
 * that work (F9). Null: they are the same. Shared by all three enforcement
 * points.
 */
export function pushSends(committable: string | null, sent: readonly { tree: string | null; isHead: boolean }[], seen: PushSeen = { hidden: [], differs: [], differCount: 0 }): Verdict {
  if (seen.hidden.length > 0) {
    const names = `${seen.hidden.slice(0, 5).join(', ')}${seen.hidden.length > 5 ? `, and ${seen.hidden.length - 5} more` : ''}`

    return { rule: 'gate', reason: `Files hidden from git: git is told not to look at changes to ${names} (the skip-worktree or assume-unchanged bit), so neither the gate nor this push can see what they hold. Clear the bit (\`git update-index --no-skip-worktree --no-assume-unchanged <file>\`), then commit or stash what changed, and push again. If the bit is wanted, a person pushes.` }
  }
  if (committable === null || sent.length === 0 || sent.some(one => one.tree === null)) {
    return { rule: 'gate', reason: 'The harness could not tell what this push sends against the tree the gate judges, so it is refused. Commit or stash first (git status shows what is not committed), then push again.' }
  }
  const other = sent.find(one => one.tree !== committable)
  if (other === undefined) {
    return null
  }
  const files = seen.differs.length > 0 ? ` The files that differ from the last commit: ${differList(seen)}.` : ''

  return {
    rule: 'gate',
    reason: other.isHead
      ? `Commit or stash first: the working tree has changes that are not committed, so the gate would judge files this push does not send (the push sends commits, and the last commit is not the tree the gate judges).${files} ${COMMIT_OR_STASH}`
      : `Commit or stash first: this push sends commits whose tree is not the working tree the gate judged, so it would send work the gate did not judge. Check out what you push and commit it, or stash what is not committed (\`git stash -u\` takes untracked files too), then push again.${files}`,
  }
}
