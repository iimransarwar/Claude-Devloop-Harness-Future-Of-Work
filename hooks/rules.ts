// The loop's rules as pure functions: path and command judging, verify
// profiles, risk tiers and the gate. Nothing here touches `$`, so every
// decision the guards make can be tested without a session. The config's
// schema is in config.ts, the shell model in shell.ts, what checks print in
// output.ts.

import type { Loop, Tier } from '../types'
import { BUILTIN_PROTECTED, BUILTIN_SECRETS } from './config'
import { FRESH } from './fresh'
import { GLOB_CAP } from './glob'
import type { Config, Profile, Step } from './config'
import { assignedBefore, flagValue, gitOption, gitOptionExactly, gitOptionValues, gitOptionWords, gitSub, hasFlag, hasGitAlias, isGitLong, isGlobTemplate, isOneLine, isPathLike, operands, parse, READINGS, readings, view } from './shell'
import type { Assigned, Env, Reading, Segment, Word } from './shell'
import { tasksRefusalsIn, tasksShellWriteRefusal } from './tasks'
import type { TasksFacts } from './tasks'

// ---------------------------------------------------------------- paths

/** Folds `.`, `..` and doubled slashes out of a path, lexically. */
export function normalize(path: string): string {
  const isAbsolute = path.startsWith('/')
  const out: string[] = []
  for (const part of path.split('/')) {
    if (part === '' || part === '.') {
      continue
    }
    if (part === '..' && out.length > 0 && out[out.length - 1] !== '..') {
      out.pop()
    } else if (part !== '..' || !isAbsolute) {
      out.push(part)
    }
  }

  return (isAbsolute ? '/' : '') + out.join('/')
}

/**
 * A path as the repository names it, or null for one outside the repository.
 * `cwd` anchors a relative spelling.
 */
export function relative(root: string, cwd: string, path: string): string | null {
  const base = normalize(root)
  const full = normalize(path.startsWith('/') ? path : `${cwd}/${path}`)
  if (full === base) {
    return ''
  }

  return full.startsWith(`${base}/`) ? full.slice(base.length + 1) : null
}

const cache = new Map<string, RegExp>()

function compile(glob: string, isFolded = false): RegExp {
  const key = `${isFolded ? 'i' : ''}:${glob}`
  const known = cache.get(key)
  if (known !== undefined) {
    return known
  }
  let source = ''
  for (let i = 0; i < glob.length; i += 1) {
    const c = glob[i] ?? ''
    if (c === '*' && glob[i + 1] === '*') {
      if (glob[i + 2] === '/') {
        source += '(?:.*/)?'
        i += 2
      } else {
        source += '.*'
        i += 1
      }
    } else if (c === '*') {
      source += '[^/]*'
    } else if (c === '?') {
      source += '[^/]'
    } else if (c === '[' && classEnd(glob, i) > 0) {
      // A bracket class (the cache-guard round, R9): `[b]`, `[a-z]`, `[!x]`, never a slash.
      const end = classEnd(glob, i)
      const body = glob.slice(i + 1, end)
      const negated = body.startsWith('!') || body.startsWith('^')
      const members = (negated ? body.slice(1) : body).replace(/[\\\]^]/g, '\\$&')
      source += negated ? `[^/${members}]` : `(?![/])[${members}]`
      i = end
    } else {
      source += c.replace(/[.+^${}()|[\]\\]/g, '\\$&')
    }
  }
  const made = new RegExp(`^${source}$`, isFolded ? 'i' : '')
  cache.set(key, made)

  return made
}

/** Where a bracket class that opens at `at` closes (a `]` right after the opening, or after `!`, is a member); -1 when it does not. */
function classEnd(glob: string, at: number): number {
  let i = at + 1
  if (glob[i] === '!' || glob[i] === '^') {
    i += 1
  }
  if (glob[i] === ']') {
    i += 1
  }
  for (; i < glob.length; i += 1) {
    if (glob[i] === '/') {
      return -1
    }
    if (glob[i] === ']') {
      return i
    }
  }

  return -1
}

/**
 * Whether a repository-relative path matches a glob: `**` spans folders, `*`
 * stays in one, and a glob with no slash matches the file's name at any depth.
 */
export function matches(path: string, glob: string, isFolded = false): boolean {
  const name = path.slice(path.lastIndexOf('/') + 1)

  return compile(glob, isFolded).test(path) || (!glob.includes('/') && compile(glob, isFolded).test(name))
}

export const matchesAny = (path: string, globs: readonly string[], isFolded = false): boolean =>
  globs.some(glob => matches(path, glob, isFolded))

/** Secrets fold case: `.ENV` and `Id_RSA` hold the same thing on a case-insensitive disk. */
export const isSecret = (path: string, cfg: Config): boolean =>
  matchesAny(path, BUILTIN_SECRETS, true) || (matchesAny(path, cfg.secrets, true) && !matchesAny(path, cfg.secretsAllow, true))

/** A path as a tool call names it, placed: where it lands, and its name in the repository. */
export type Placed = {
  /** As written. */
  spelled: string
  /** Absolute and folded, `~` expanded; null when it cannot be placed (an unknown `cd`, no home). */
  abs: string | null
  /** Repository-relative; `''` is the root; null outside the repository or unplaced. */
  rel: string | null
  /**
   * Absolute with its `..` parts kept, where one follows a part that may be a
   * link (the eleventh round, V3): the kernel resolves the link before it
   * takes the `..`, so the guards also judge where the file system leads it
   * (`realOf`), beside the text-folded `abs`.
   */
  raw?: string
  /** It is what a wildcard matched on disk (P-C), not a path the line spells: `GLOB_CAP` bounds how many (`linkPlaces`). */
  isMatch?: boolean
}

/** Where the judge's paths start, and the facts the hook gathered for it. */
export type Where = {
  root: string
  cwd: string
  home: string | null
  /** `$TMPDIR` as the environment sets it, or null. */
  tmp: string | null
  /** The harness's own state outside the working tree: nothing a tool call does writes under it. */
  stateRoot: string | null
  /**
   * The spec library's folder (DESIGN 4.18), as set and where its links
   * lead: the harness's to write, so no tool call writes under it. Absent
   * where the hook did not look (the command line, the classic hooks).
   */
  library?: readonly string[]
  /**
   * Tracked files at or beneath a path a command writes, by repository-relative
   * path (`''` the root), where the hook listed them. A path with no entry was
   * not listed (outside git, or the listing failed): its tracking is unknown.
   */
  filesUnder: Readonly<Record<string, readonly string[]>>
  /**
   * Whether a repository-relative path is a folder, where the hook knows:
   * `false` for a file or a path not there (nothing lies beneath it). A path
   * with no entry is unknown, and is probed as a folder (fail safe).
   */
  folders: Readonly<Record<string, boolean>>
  /** Where the harness saved a check's last full output, or null. */
  savedOutput: (command: string) => string | null
  /**
   * The branch checked out, where the hook looked (C2.1 F2): a name, or
   * `(detached)`; null when it is not known, which counts as possibly the
   * default branch.
   */
  branch: string | null
  /** The calling eval agent's own sandbox, the one eval sandbox that is not harness state to it (C2.1 F9); null otherwise. */
  sandbox: string | null
  /**
   * This repository's `origin` as `owner/name` (D1), where the hook looked:
   * a `gh` ship naming another repository with `-R`/`--repo` is refused. Null
   * when it is not known, and then any `-R` is refused (fail safe).
   */
  remote?: string | null
  /**
   * The `.tasks` integration as the hook found it (D2): whether it is on, and
   * whether this tree may finish a task. Absent or off: no `.tasks` rule applies.
   */
  tasks?: TasksFacts
  /**
   * The judging process's values of the variables a path may be placed
   * through beside `HOME` and `TMPDIR` (the cache-guard round, R8): `PWD`,
   * `CLAUDE_PLUGIN_DATA`, `CLAUDE_PLUGIN_ROOT`, `CLAUDE_PROJECT_DIR`.
   */
  env?: Env
  /**
   * The reviewed reading's lookups (the fourteenth round, CC1), as `2374c49`
   * made them (`globAsksReviewed`): what each of the first 16 wildcard paths
   * the reviewed reading names matched on disk, by its absolute spelling,
   * expanded by that same spelling with `2374c49`'s expander
   * (`expandGlobReviewed`): the matches, or `capped` past `GLOB_CAP`. A path
   * with no entry was not expanded and is judged as written; no matches at
   * all is judged as its literal text.
   */
  globs?: Readonly<Record<string, readonly string[] | 'capped'>>
  /**
   * The extended reading's lookups (CC1), apart from the reviewed reading's
   * so that neither answers for the other: by the pattern expanded (a word's
   * template, quoted characters escaped, the twelfth round, X11), with the
   * checked expander (`expandGlob`). A path is judged by the matches of every
   * pattern the extended reading asked for its spelling. A wildcard target of
   * a `cd`, and any target of a `pushd`, is looked up here by its pattern
   * (`Segment.moveGlob`, X11, Y1).
   */
  globsExtended?: Readonly<Record<string, readonly string[] | 'capped'>>
  /**
   * What exists at the place of each word holding white space (the
   * thirteenth round, BB5), by its pattern, with the checked expander: the
   * word is a path where something is there. Both readings ask; a pattern
   * here holds no wildcard, so one answer serves any reading that asks it.
   */
  spaced?: Readonly<Record<string, readonly string[] | 'capped'>>
}

/** The variables a line's paths are placed through, from the judging process (R8). */
export const envOf = (where: Where): Env => ({ ...(where.env ?? {}), HOME: where.home, TMPDIR: where.tmp })

/**
 * A line's segments under one reading (BB1) as the judge reads them where it
 * runs: from its folder, with the environment's variables and what the hook
 * expanded on disk. Every exported function of this file that judges a line
 * runs it under both readings and combines them (`READINGS`): none answers
 * from one alone.
 */
export const parseOf = (command: string, where: Where, reading: Reading): Segment[] => parse(command, reading, where.cwd, envOf(where), reading === 'extended' ? where.globsExtended : undefined)

/** Each item once, the first kept, by a key (the union of what two readings give, BB1). */
function unionBy<T>(items: readonly T[], key: (item: T) => string): T[] {
  const seen = new Set<string>()

  return items.filter(item => {
    const one = key(item)
    if (seen.has(one)) {
      return false
    }
    seen.add(one)

    return true
  })
}

/** The places two readings give, each once (BB1). */
const unionPlaces = (places: readonly Placed[]): Placed[] => unionBy(places, one => JSON.stringify([one.spelled, one.abs, one.raw ?? null, one.isMatch === true]))

export const whereOf = (root: string, cwd = root, more: Partial<Where> = {}): Where =>
  ({ root, cwd, home: null, tmp: null, stateRoot: null, filesUnder: {}, folders: {}, savedOutput: () => null, branch: null, sandbox: null, ...more })

/** Places one path as a call spells it, relative to `cwd` (null: a `cd` that could not be followed). */
export function place(spelled: string, cwd: string | null, where: Where): Placed {
  let abs: string | null = null
  if (spelled === '~' || spelled.startsWith('~/')) {
    abs = where.home === null ? null : normalize(`${where.home}${spelled.slice(1)}`)
  } else if (spelled.startsWith('/')) {
    abs = normalize(spelled)
  } else if (!spelled.startsWith('~') && cwd !== null) {
    abs = normalize(`${cwd.startsWith('/') ? cwd : `${where.cwd}/${cwd}`}/${spelled}`)
  }

  // `..` after a part that may be a link (V3): the file system takes the link first, so the path is kept unfolded too.
  const joined = abs === null ? null : spelled.startsWith('/') ? spelled : spelled.startsWith('~') ? `${where.home ?? ''}${spelled.slice(1)}` : `${cwd !== null && cwd.startsWith('/') ? cwd : `${where.cwd}/${cwd ?? ''}`}/${spelled}`
  const raw = joined !== null && /(?:^|\/)(?!\.\.?(?:\/|$))[^/]+\/(?:\.?\/)*\.\.(?:\/|$)/.test(joined) ? joined : undefined

  return { spelled, abs, rel: abs === null ? null : relative(where.root, where.root, abs), ...(raw === undefined ? {} : { raw }) }
}

/**
 * Where the file system leads a path whose `..` follows a part that may be a
 * link (the eleventh round, V3): each `..` is taken from the place the parts
 * before it resolve to (`real`: a folder's place once its links are
 * followed, or null when it cannot be told, where the text is folded
 * instead). Pure: the module and the command line each give their reader.
 */
export function physicalPath(raw: string, real: (folder: string) => string | null): string {
  let at = ''
  for (const part of raw.split('/')) {
    if (part === '' || part === '.') {
      continue
    }
    if (part === '..') {
      const resolved = at === '' ? '/' : (real(at) ?? at)
      at = resolved === '/' ? '' : resolved.slice(0, resolved.lastIndexOf('/'))
    } else {
      at = `${at}/${part}`
    }
  }

  return at === '' ? '/' : at
}

/** The spellings a placed path is matched under: in the repository, absolute, and as written. */
function spellings(path: Placed): string[] {
  const out = new Set<string>()
  if (path.rel !== null && path.rel !== '') {
    out.add(path.rel)
  }
  if (path.abs !== null) {
    out.add(path.abs.replace(/^\/+/, ''))
  }
  out.add(normalize(path.spelled.replace(/^~\/?/, '')).replace(/^\/+/, ''))
  out.delete('')

  return [...out]
}

/** Whether a path anywhere, inside the repository or not, holds secrets. */
export const isSecretPlace = (path: Placed, cfg: Config): boolean =>
  spellings(path).some(one => isSecret(one, cfg))

/** Where every eval sandbox is made: a fresh folder under /tmp with this prefix (hooks/evals.ts). */
export const EVAL_SANDBOX_PREFIX = '/tmp/devloop-eval-'

/** The eval sandbox a path lies in, or null (C2.1 F9). */
export function sandboxOf(abs: string | null): string | null {
  if (abs === null || !abs.startsWith(EVAL_SANDBOX_PREFIX)) {
    return null
  }
  const cut = abs.indexOf('/', EVAL_SANDBOX_PREFIX.length)

  return cut < 0 ? abs : abs.slice(0, cut)
}

/** Whether an absolute path is a folder in a list, or lies beneath one. */
const isUnder = (abs: string | null, folders: readonly string[] | undefined): boolean =>
  abs !== null && (folders ?? []).some(one => abs === one || abs.startsWith(`${one.replace(/\/+$/, '')}/`))

/** Whether a path lies in the spec library (DESIGN 4.18). */
export const isInLibrary = (path: Placed, where: Where): boolean => isUnder(path.abs, where.library)

/** Why a write under the harness's state is refused, in the words for what lies there. */
export const harnessStateReason = (path: Placed, where?: Where): string =>
  where !== undefined && isInLibrary(path, where)
    ? `${path.spelled} is in the spec library, which only the harness writes (a person saves a spec there with /devloop library save). It is read, never written, from here.`
    : sandboxOf(path.abs) !== null
      ? `${path.spelled} is inside an eval sandbox, which is the harness's own: only the eval agent working in it writes there.`
      : `${path.spelled} is the harness's own record (saved check output, the review's diff). It is read, never written, from here.`

/**
 * Whether a path lies under the harness's own state: its state folder, the
 * spec library, or an eval sandbox (C2.1 F9), which only the eval agent
 * working in it may write.
 */
export const isHarnessState = (path: Placed, where: Where): boolean => {
  if (isInLibrary(path, where)) {
    return true
  }
  if (where.stateRoot !== null && path.abs !== null && (path.abs === where.stateRoot || path.abs.startsWith(`${where.stateRoot}/`))) {
    return true
  }
  // Only where the hook gathered the harness's facts (an opted-in repository) is a sandbox the harness's.
  const sandbox = sandboxOf(path.abs)

  return where.stateRoot !== null && sandbox !== null && sandbox !== where.sandbox
}

// ---------------------------------------------------------------- edits

/** A refusal: the rule, what the model reads, and for a content rule its id (the ledger's and prune's key). */
export type Verdict = { rule: string; reason: string; id?: string } | null
export type Refusal = NonNullable<Verdict>

/**
 * Rules that hold in every mode, whatever else matched: a call is refused if
 * any of these match, observe mode or not.
 */
export const ALWAYS_HELD: readonly string[] = ['secret', 'harness-state', 'reviewer-read-only', 'budget', 'eval-containment', 'evidence-notes']

export const isAlwaysHeld = (rule: string): boolean => ALWAYS_HELD.includes(rule)

/**
 * Who can lift a refusal: `none` (it always holds), `person` (a person's
 * one-turn exemption, an approval, or a person doing it themselves), or
 * `policy` (a change to devloop.json, which a person reviews like any other).
 */
export type Lift = 'none' | 'person' | 'policy'

/** Rules that devloop.json itself sets, so the lasting fix is a policy change. */
const POLICY_RULES = ['forbidden', 'egress', 'content-rule']

/**
 * Rules no exemption lifts, though observe mode records them only (L2): a
 * line that ships must ship alone, whoever allowed the command.
 */
export const NEVER_LIFTED: readonly string[] = ['ship-alone']

/** The budget holds in every mode, but a person raises it (/devloop budget). */
export const liftOf = (rule: string): Lift => (rule === 'budget' ? 'person' : isAlwaysHeld(rule) || NEVER_LIFTED.includes(rule) ? 'none' : POLICY_RULES.includes(rule) ? 'policy' : 'person')

/** The one short clause a refusal ends with, saying who can lift it. */
export function liftClause(rule: string): string {
  const lift = liftOf(rule)

  return lift === 'none' ? '(Always held: no one lifts it.)' : lift === 'policy' ? '(Lifted by a change to devloop.json.)' : '(A person can lift it.)'
}

/** Every rule a refusal can name, with who lifts it: doctor lists them. */
export const RULES: readonly string[] = [
  ...ALWAYS_HELD, 'spec-locked', 'protected', 'tests-locked', 'spec-first', 'high-needs-spec', 'test-weakened', 'destructive',
  'production', 'forbidden', 'egress', 'no-verify', 'force-push', 'check-filtered', 'human-merge', 'gate', 'ship-alone', 'content-rule', 'tasks',
  'git-hidden', 'cache-guard',
]

/**
 * Whether a refusal holds under the policy in force, at every enforcement
 * point: a rule that always holds, or enforce mode; the `.tasks` rules (D2)
 * hold only where `tasks.integrate` is `enforce` too, and are recorded in
 * `observe`.
 */
export const isHeldBy = (rule: string, cfg: Pick<Config, 'mode' | 'tasks'>): boolean =>
  isAlwaysHeld(rule) || (cfg.mode === 'enforce' && (rule !== 'tasks' || cfg.tasks.integrate === 'enforce'))

/**
 * Paths that are instruction files whatever the policy says (D2): the
 * checklists a reviewer is briefed from are text fed to an agent across
 * sessions, so an edit is read by a person and raises the tier, as for the
 * policy's own `instructions` (they are also built-in protected paths).
 */
export const BUILTIN_INSTRUCTIONS: readonly string[] = ['checklists/**']

/** The instruction globs in force: the policy's, and the built-in ones. */
export const instructionGlobs = (cfg: Pick<Config, 'instructions'>): string[] => [...cfg.instructions, ...BUILTIN_INSTRUCTIONS]

/**
 * Of several refusals, the one that holds in the most modes; the first among
 * equals. With the policy in force given, a refusal it holds always wins over
 * one it only records, whatever the order they were found in (carried into
 * the final round from D1): a recorded-only rule never lets a held one pass.
 */
export const strictest = (all: readonly Refusal[], cfg?: Pick<Config, 'mode' | 'tasks'>): Verdict =>
  all.find(one => isAlwaysHeld(one.rule)) ?? (cfg === undefined ? undefined : all.find(one => isHeldBy(one.rule, cfg))) ?? all[0] ?? null

const isExempt = (path: string, loop: Loop): boolean =>
  loop.allow.some(one => one.kind === 'path' && matches(path, one.value))

/**
 * Whether the loop's rules refuse an edit of one repository-relative path.
 * `rule` is the ledger's key for the refusal, `reason` what the model reads.
 * `label` names the path in the reason, when it stands for a folder's content.
 */
export function judgeEdit(path: string, cfg: Config, loop: Loop, label = path, isUntracked = false): Verdict {
  if (isSecret(path, cfg)) {
    return {
      rule: 'secret',
      reason: `${label} holds secrets; it is never read or written from here.`,
    }
  }
  if (isExempt(path, loop)) {
    return null
  }
  if (loop.spec !== null && path.startsWith(`specs/${loop.spec}/`)) {
    return loop.phase === 'spec'
      ? null
      : {
          rule: 'spec-locked',
          reason: `${label} is the approved spec. It changes only through a person: /devloop spec ${loop.spec} reopens it. To record a passing feature call the feature_check tool.`,
        }
  }
  if (matchesAny(path, cfg.protected) || matchesAny(path, BUILTIN_PROTECTED)) {
    return {
      rule: 'protected',
      reason: `${label} is part of the harness or its policy, which the building agent does not edit. A person can exempt it for one turn with /devloop allow ${path}.`,
    }
  }
  const isTest = matchesAny(path, cfg.tests)
  // A test file the builder created while building weakens nothing a person approved.
  // Nor does a file under a test folder that git does not track and whose name is no
  // test's (a cache, a log), unless it was hashed at approval: the deletion rule's
  // definition of a test (B2.1 F9, carried to this rule in C1).
  const isNoTest = isUntracked && !matchesAny(path, testNameGlobs(cfg.tests)) && !(path in (loop.testHashes ?? {}))
  if (loop.phase === 'build' && isTest && !loop.newTests.includes(path) && !isNoTest) {
    return {
      rule: 'tests-locked',
      reason: `${label} is a test, and tests are locked while building against an approved spec: make the code pass them. If the test itself is wrong, stop and say so; a person can exempt it with /devloop allow ${path}.`,
    }
  }
  if (loop.phase === 'spec') {
    // While the spec is written its tests are written too, wherever they live.
    return isTest
      ? null
      : {
          rule: 'spec-first',
          reason: `The spec for "${loop.spec ?? ''}" is not approved yet, so only the spec and its tests change. Finish specs/${loop.spec ?? ''}/SPEC.md and features.json, then ask the person to run /devloop approve.`,
        }
  }
  if (loop.phase !== 'build' && matchesAny(path, cfg.tiers.high)) {
    return {
      rule: 'high-needs-spec',
      reason: `${label} is a high-risk path. It changes only against a spec a person approved: /devloop spec <name>, then /devloop approve.`,
    }
  }

  return null
}

/** The test globs that pick files by name (`**\/*.test.*`), not by the folder they sit in (`tests/**`). */
export const testNameGlobs = (globs: readonly string[]): string[] => globs.filter(glob => !/(^|\/)\*\*$/.test(glob))

/** The rules that still hold for a path a command only names: a mention is no proof of a write. */
const LOCKED_RULES = ['secret', 'harness-state', 'spec-locked', 'protected', 'tests-locked']

/**
 * Whether the rules refuse writing one placed path, inside the repository or
 * out of it: secrets and the harness's state anywhere, the built-in protected
 * names anywhere, the loop's rules inside. `isProof` is false for a path an
 * unknown command only names; then only the locked-path rules hold.
 */
export function judgeWrite(path: Placed, cfg: Config, loop: Loop, where: Where, isProof = true): Verdict {
  if (isSecretPlace(path, cfg)) {
    return { rule: 'secret', reason: `${path.spelled} holds secrets; it is never read or written from here.` }
  }
  if (isHarnessState(path, where)) {
    return { rule: 'harness-state', reason: harnessStateReason(path, where) }
  }
  if (path.rel === null) {
    const outside = spellings(path)
    const isGuarded = outside.some(one => matchesAny(one, BUILTIN_PROTECTED)) && ![...outside, path.spelled].some(one => isExempt(one, loop))

    return isGuarded
      ? { rule: 'protected', reason: `${path.spelled} configures the agent, git or the shell, which the building agent does not edit. A person can exempt it for one turn with /devloop allow ${path.spelled}.` }
      : null
  }
  // A shell glob (`rm tests/*`) writes whatever it expands to under its folder.
  const { dir, within } = globParts(path.rel)
  // A glob spelled like a locked name (`*.test.ts`) is judged as written too.
  // What lies beneath is probed only for a folder (or a path not known to be a file): never for a file path (B2.1 F7).
  const isFolder = within !== '' || where.folders[dir] !== false
  // The hook listed what git tracks there and found nothing, and no file there was hashed at approval.
  const listed = where.filesUnder[dir]
  const isUntracked = listed !== undefined && listed.length === 0 && !Object.keys(loop.testHashes ?? {}).some(file => file === dir || file.startsWith(`${dir}/`))
  const verdict = (within === '' ? null : judgeEdit(path.rel, cfg, loop, path.rel, isUntracked)) ?? judgeContents(dir, within, cfg, loop, listed ?? [], isFolder, isUntracked)

  return verdict === null || isProof || LOCKED_RULES.includes(verdict.rule) ? verdict : null
}

/**
 * A written path split at its first wildcard (the last review's F4): `dir`,
 * the path before the first part with a wildcard, where everything it can
 * expand to lives; `within`, the rest, which narrows what lies beneath.
 * The rules and both readers (the module's and the command line's listing of
 * tracked files and folders) expand from this same prefix, so a glob in the
 * middle of a path (`.tasks/web/*\/task.md`) is listed and judged under
 * `.tasks/web`.
 */
export function globParts(rel: string): { dir: string; within: string } {
  const parts = rel.split('/')
  const wild = parts.findIndex(part => /[*?[]/.test(part))

  return wild < 0 ? { dir: rel, within: '' } : { dir: parts.slice(0, wild).join('/'), within: parts.slice(wild).join('/') }
}

/** The part of a glob before its first wildcard folder: where everything it matches lives. */
function literalPrefix(glob: string): string {
  const parts = glob.split('/')
  const end = parts.findIndex(part => /[*?[]/.test(part))

  return (end < 0 ? parts.slice(0, -1) : parts.slice(0, end)).join('/')
}

/** A path a glob matches, made by filling its wildcards, or null when filling does not give one. */
function exemplar(glob: string): string | null {
  const made = glob.replace(/\*\*\//g, '').replace(/\*\*/g, 'x').replace(/\*/g, 'x').replace(/\?/g, 'x')

  return made !== '' && matches(made, glob) ? made : null
}

/**
 * Judges writing a path that may be a folder: the path itself, then what
 * lies beneath it. A locked glob lies beneath a folder when everything under
 * the folder matches it (`tests` and `tests/**`) or the glob's own folder is
 * inside it; `listed` adds the tracked files the hook found there, which
 * catches globs that match at any depth (`**\/*.test.*` under `src`).
 * `within` narrows to what a shell glob in the command would expand to.
 * `isFolder` false (a file path) judges the path itself and nothing beneath it.
 */
function judgeContents(dir: string, within: string, cfg: Config, loop: Loop, listed: readonly string[], isFolder = true, isUntracked = false): Verdict {
  if (dir !== '' && within === '') {
    const own = judgeEdit(dir, cfg, loop, dir, isUntracked)
    if (own !== null || !isFolder) {
      return own
    }
  }
  const locked = [
    ...cfg.protected, ...BUILTIN_PROTECTED, ...cfg.tests, ...cfg.tiers.high,
    ...(loop.spec === null ? [] : [`specs/${loop.spec}/**`]),
  ]
  for (const { path, label } of lockedBeneath(dir, within, locked, listed)) {
    const verdict = judgeEdit(path, cfg, loop, label, isUntracked)
    if (verdict !== null && verdict.rule !== 'secret' && verdict.rule !== 'spec-first') {
      return verdict
    }
  }

  return null
}

/**
 * What a write of a folder (or a shell glob) reaches beneath it that `globs`
 * lock, each with how the refusal names it: everything in the folder when it
 * lies wholly under a glob, a path the glob makes when the glob's own folder
 * is inside it, and the tracked files the hook listed there (`listed`), which
 * catches globs that match at any depth. `within` narrows to what a shell
 * glob in the command would expand to. The one expansion the protected-path
 * rule and the `.tasks` shell rule share (final round, D2 F3).
 */
export function lockedBeneath(dir: string, within: string, globs: readonly string[], listed: readonly string[]): { path: string; label: string }[] {
  const shown = dir === '' ? '.' : `${dir}/`
  const isWithin = (path: string): boolean => {
    if (within === '') {
      return true
    }
    const parts = path.split('/')

    return parts.some((_, i) => compile(within).test(parts.slice(0, i + 1).join('/')))
  }
  const candidates: { path: string; label: string }[] = []
  for (const glob of globs) {
    const probe = dir === '' ? null : `${dir}/x`
    if (probe !== null && matches(probe, glob)) {
      candidates.push({ path: probe, label: `${shown} (everything in it matches ${glob})` })
      continue
    }
    const prefix = literalPrefix(glob)
    const isBeneath = dir === '' || prefix === dir || prefix.startsWith(`${dir}/`)
    const made = isBeneath ? exemplar(glob) : null
    if (made !== null && (dir === '' || made.startsWith(`${dir}/`))) {
      candidates.push({ path: made, label: `${shown} (it holds paths matching ${glob})` })
    }
  }
  for (const file of listed) {
    candidates.push({ path: file, label: `${shown} (it holds ${file})` })
  }

  return candidates.filter(({ path }) => isWithin(dir === '' ? path : path.slice(dir.length + 1)))
}

// ---------------------------------------------------------------- production

const words = (segment: Segment): string[] => operands(segment.args).map(word => word.text)

/** gh's words, its global `-R`/`--repo` option skipped as git's are. */
const ghWords = (args: readonly Word[]): string[] => operands(args, 'R', ['--repo']).map(word => word.text)

/**
 * Which built-in production action a command takes, or null: a separate
 * axis from merge risk, refused in enforce mode whatever the change's tier.
 * Matched on the command's own words, so `grep "terraform apply"` is not one.
 */
export function productionAction(segment: Segment): string | null {
  const said = words(segment)
  switch (segment.program) {
    case 'kubectl':
      return said.some(one => one === 'apply' || one === 'delete') ? 'kubectl apply/delete' : null
    case 'terraform': case 'tofu':
      return said.some(one => one === 'apply' || one === 'destroy') ? 'terraform apply/destroy' : null
    case 'npm': case 'pnpm': case 'yarn':
      return said.includes('publish') && !['run', 'run-script', 'exec', 'x', 'dlx'].includes(said[0] ?? '') ? `${segment.program} publish` : null
    case 'docker': case 'podman':
      return said.includes('push') ? 'docker push' : null
    case 'gh': {
      const gh = ghWords(segment.args)

      return gh[0] === 'release' && gh[1] === 'create' ? 'gh release create' : null
    }
    case 'aws': case 'gcloud': case 'az':
      return said.some(one => /^(deploy|delete)(-|$)/.test(one)) ? 'a cloud deploy or delete' : null
    default:
      return null
  }
}

// ---------------------------------------------------------------- destructive

const SAFER_WORKTREE = '`git stash push --include-untracked` keeps the work recoverable (`git stash pop` brings it back); to restore one file, `git restore <file>`'

/**
 * Commands that discard work that may exist nowhere else, each with the
 * safer command the refusal names. Null when the segment is none of them.
 */
export function destructiveAction(segment: Segment, where: Where): { what: string; safer: string } | null {
  const { program, args } = segment
  if (program === 'git') {
    const { sub, at } = gitSub(args)
    const rest = args.slice(at + 1)
    const said = operands(rest).map(word => word.text)
    const isWholeTree = (paths: readonly string[]): boolean => paths.some(path => ['.', './', ':/', '*', ':(top)'].includes(path))
    if (sub === 'reset' && gitOption(rest, ['--hard']) !== null) {
      return { what: '`git reset --hard` discards every uncommitted change', safer: `${SAFER_WORKTREE}; to move the branch and keep edits, \`git reset --keep <commit>\`` }
    }
    if (sub === 'checkout' && (gitOption(rest, ['--force'], 'f') !== null || isWholeTree(said))) {
      return { what: '`git checkout` of the whole tree discards every uncommitted change', safer: SAFER_WORKTREE }
    }
    if (sub === 'restore' && isWholeTree(said) && (!gitOptionExactly(rest, ['--staged'], 'S') || gitOption(rest, ['--worktree'], 'W') !== null)) {
      return { what: '`git restore` of the whole tree discards every uncommitted change', safer: SAFER_WORKTREE }
    }
    if (sub === 'clean' && gitOption(rest, ['--force'], 'f') !== null && !gitOptionExactly(rest, ['--dry-run'], 'n')) {
      return { what: '`git clean -f` deletes untracked files, which git cannot bring back', safer: '`git clean -n` lists what it would delete; `git stash push --include-untracked` keeps those files recoverable' }
    }
    if (sub === 'stash' && ['drop', 'clear'].includes(said[0] ?? '')) {
      return { what: `\`git stash ${said[0] ?? ''}\` deletes stashed work, which may be its only copy`, safer: 'leave the stash; `git stash show -p` shows what it holds, and a person can drop it' }
    }
    if (sub === 'branch' && (gitOption(rest, ['--delete'], 'd') !== null || gitOption(rest, [], 'D') !== null)) {
      return { what: 'deleting a branch', safer: 'leave the branch; deleting one is a person\'s call' }
    }
    if (sub === 'push' && (gitOption(rest, ['--delete'], 'd') !== null || said.slice(1).some(spec => spec.startsWith(':') && spec.length > 1))) {
      return { what: 'deleting a remote branch', safer: 'leave the branch; deleting one is a person\'s call' }
    }

    return null
  }
  if (program === 'rm' && (hasFlag(args, 'r', ['--recursive']) || hasFlag(args, 'R', []))) {
    for (const word of operands(args)) {
      // `"$TMPDIR/x"` is placed by the environment's TMPDIR, when the hook knows it.
      const isTmpVar = word.lead === 'TMPDIR' && where.tmp !== null && (word.text === '' || word.text.startsWith('/'))
      if (word.hasExpansion && !isTmpVar) {
        return { what: `\`rm -rf\` of \`${word.text || '$…'}\`, a path known only when it runs`, safer: 'name the path to delete literally, inside the repository' }
      }
      const text = isTmpVar ? `${where.tmp ?? ''}${word.text}` : word.text
      // A wildcard is judged by the literal folder before it. One in the first part under `/` is judged from `/` (the
      // fourteenth round, CC-F9), and still from the folder the line runs in as before, which can only add a refusal.
      const prefix = text.replace(/\/?[^/]*[*?[].*$/, '')
      const spellings = word.hasGlob ? [...new Set([prefix || '.', prefix || (text.startsWith('/') ? '/' : '.')])] : [text]
      for (const spelled of spellings) {
        const placed = place(spelled, segment.cwd, where)
        if (placed.abs === null) {
          continue
        }
        if (placed.rel === null && isTemporary(word.hasGlob ? place(text, segment.cwd, where).abs ?? '' : placed.abs, word.hasGlob, where)) {
          continue
        }
        if (placed.rel === '' || placed.rel === null) {
          return {
            what: placed.rel === '' ? '`rm -rf` of the repository root' : `\`rm -rf\` of ${placed.abs}, outside the repository`,
            safer: 'delete the specific paths inside the repository that need to go; whole trees and anything outside it are a person\'s to remove',
          }
        }
      }
    }
  }

  return null
}

/** The system's temporary folders, where cleaning up is allowed. */
const TEMPORARY = ['/tmp', '/var/tmp', '/private/tmp', '/private/var/tmp']

/**
 * Whether `rm -rf` of a path outside the repository is a tidy-up of a
 * temporary folder: strictly beneath `/tmp`, `/var/tmp` or `$TMPDIR`, and
 * neither the harness's state nor the repository at or beneath it. A glob
 * is judged by everything it could match.
 */
function isTemporary(abs: string, isGlob: boolean, where: Where): boolean {
  const roots = [...TEMPORARY, ...(where.tmp === null ? [] : [normalize(where.tmp)])].filter(one => one !== '/')
  const path = normalize(abs)
  if (!roots.some(one => path.startsWith(`${one}/`))) {
    return false
  }
  const kept = [where.stateRoot, normalize(where.root), ...(where.library ?? [])].filter((one): one is string => one !== null)
  const pattern = isGlob ? compile(path.replace(/^\//, '')) : null

  return !kept.some(one => {
    const parts = one.split('/')
    const lies = parts.map((_, i) => parts.slice(0, i + 1).join('/')).filter(prefix => prefix !== '')

    // It is the kept folder, or holds it.
    return lies.some(prefix => (pattern === null ? prefix === path : pattern.test(prefix.replace(/^\//, ''))))
  })
}

const FETCHERS = ['curl', 'wget']
const SHELL_RUNNERS = ['sh', 'bash', 'zsh', 'dash', 'ksh', 'source', '.']
const INTERPRETER_RUNNERS = ['python', 'python3', 'perl', 'ruby', 'node']

/** Whether an interpreter reads its program from standard input: no script operand, no `-c`, `-m` or `-e`. */
function readsProgram(segment: Segment): boolean {
  const program = segment.program ?? ''
  if (!INTERPRETER_RUNNERS.includes(program) && !/^python\d/.test(program)) {
    return false
  }
  const isInline = segment.args.some(word => !word.isQuoted && /^-(?:[a-zA-Z]*[cmeEp]|-eval|-print)$/.test(word.text))
  const script = operands(segment.args, 'WX')[0]

  return !isInline && (script === undefined || script.text === '-')
}

/**
 * A download run as code without being read first: piped into a shell, or
 * into an interpreter that reads its program from standard input; given to a
 * shell by process substitution (`bash <(curl …)`) or as its `-c` script
 * (`sh -c "$(curl …)"`). A download piped into a program that only reads
 * data (`python3 -m json.tool`, `jq`) is not.
 */
function isPipeToShell(segments: readonly Segment[]): boolean {
  const fetches = segments.filter(one => one.program !== null && FETCHERS.includes(one.program))
  if (fetches.length === 0) {
    return false
  }

  return segments.some(one => {
    const program = one.program ?? ''
    const isShell = SHELL_RUNNERS.includes(program)
    const isPiped = fetches.some(fetch => fetch.pipeline === one.pipeline && fetch.place < one.place)
    if (isPiped && (isShell || readsProgram(one))) {
      return true
    }
    if (!isShell || !fetches.some(fetch => fetch.isNested)) {
      return false
    }
    const flag = one.args.findIndex(word => !word.isQuoted && /^-[a-zA-Z]*c[a-zA-Z]*$/.test(word.text))
    const script = flag >= 0 ? one.args[flag + 1] : operands(one.args)[0]

    return script !== undefined && script.hasExpansion && (flag >= 0 || script.text === '/dev/fd/63')
  })
}

// ---------------------------------------------------------------- egress

/** Hosts that never leave the machine. */
const LOOPBACK = ['localhost', '127.0.0.1', '::1', '0.0.0.0']

/** The hosts a shell command names, in every simple command it runs. */
export function hostsOf(command: string): string[] {
  return [...new Set(readings(command).flat().flatMap(segment => segment.hosts))]
}

/** Whether a host is one the policy lets commands reach: listed, or `*.domain` for its subdomains. */
export function isAllowedHost(host: string, allow: readonly string[]): boolean {
  return LOOPBACK.includes(host) || allow.some(entry => entry === host || (entry.startsWith('*.') && host.endsWith(entry.slice(1))))
}

// ---------------------------------------------------------------- git hygiene

/** Short flags of `git commit` that take a value: in `-am msg`, letters after `m` are its value. */
const COMMIT_VALUES = 'mFCctu'

/**
 * The settings a git command's global options give it: the value after each
 * `-c`, and after each `--config-env` (written `--config-env=name=VAR` or
 * with the value apart, any prefix git takes), as words (R1, R2).
 */
export function gitConfigValues(globals: readonly Word[]): Word[] {
  const out: Word[] = []
  for (let i = 0; i < globals.length; i += 1) {
    const word = globals[i] as Word
    if (word.text === '-c' && globals[i + 1] !== undefined) {
      out.push(globals[i + 1] as Word)
      i += 1
    } else if (isGitLong(word, '--config-env')) {
      out.push(...gitOptionValues([word, ...globals.slice(i + 1, i + 2)], '--config-env'))
      i += word.text.includes('=') ? 0 : 1
    }
  }

  return out
}

/** Whether a git command skips the repository's own hooks: `--no-verify`, `commit -n`, or `-c core.hooksPath`. */
function isNoVerify(segment: Segment): boolean {
  const { sub, at } = gitSub(segment.args)
  const globals = segment.args.slice(0, at)
  if (gitConfigValues(globals).some(one => /^core\.hookspath=/i.test(one.text))) {
    return true
  }
  const rest = segment.args.slice(at + 1)
  if (!['commit', 'push', 'merge', 'rebase', 'am', 'cherry-pick', 'revert', 'pull'].includes(sub ?? '')) {
    return false
  }
  if (gitOption(rest, ['--no-verify']) !== null) {
    return true
  }
  if (sub !== 'commit') {
    return false
  }

  // `-n` is no-verify for commit (it is dry-run for push).
  return rest.some(word => {
    if (word.isQuoted || !/^-[A-Za-z]+$/.test(word.text)) {
      return false
    }
    for (const letter of word.text.slice(1)) {
      if (letter === 'n') {
        return true
      }
      if (COMMIT_VALUES.includes(letter)) {
        return false
      }
    }

    return false
  })
}

/** Whether a push rewrites the remote's history: `--force`, `-f`, or a `+` refspec. */
function isForcePush(segment: Segment): boolean {
  const { sub, at } = gitSub(segment.args)
  if (sub !== 'push') {
    return false
  }
  const rest = segment.args.slice(at + 1)

  return gitOption(rest, ['--force'], 'f') !== null || operands(rest, 'o', ['--push-option', '--repo', '--receive-pack', '--exec']).slice(1).some(word => word.text.startsWith('+'))
}

// ---------------------------------------------------------------- shipping

/**
 * The branch a command runs on, where an earlier part of its line switched:
 * `undefined` when nothing switched (the branch checked out), a name, or null
 * for a ref the model cannot name (`git checkout -`, `git switch "$b"`), which
 * is judged as possibly the default branch.
 */
export type OnBranch = string | null | undefined

export type ShipIntent = (
  /** `targets[i]` is pushed from `sources[i]`; with no refspec, the branch checked out goes. */
  | {
      kind: 'push'
      targets: string[]
      sources: string[]
      isAll: boolean
      /**
       * A form that names no source (the last review's F8): `--all`, `--branches`, `--tags`, `--follow-tags`,
       * `--mirror`, as written; null for a push that names what it sends (or sends the branch checked out).
       */
      unnamed?: string | null
      /**
       * What makes the push other than the one shape the agent pushes in
       * (the cache-guard round, R1, P-A): `git push [options] <remote>
       * <source>[:<destination>]`, options from `PUSH_OPTIONS` alone, nothing
       * configuring git on the line. Null for a push of that shape.
       */
      misshapen?: string | null
    }
  | { kind: 'pr-create' | 'pr-ready' | 'pr-merge' | 'merge' }
) & { on?: OnBranch }

/** Git sub-commands that only read. */
const GIT_READS_BASE = ['diff', 'log', 'show', 'status', 'blame', 'ls-files', 'rev-parse', 'merge-base', 'grep', 'cat-file', 'ls-tree']

/** A detached head is on no branch. */
const DETACHED = '(detached)'

/** Where a `git checkout` or `git switch` leaves the line: a branch, null for one the model cannot name; undefined if it switches nothing. */
function switchOf(sub: string | null, rest: readonly Word[]): OnBranch {
  if (sub !== 'checkout' && sub !== 'switch') {
    return undefined
  }
  if (gitOptionExactly(rest, ['--detach'])) {
    return DETACHED
  }
  const create = sub === 'checkout' ? ['-b', '-B', '--orphan'] : ['-c', '-C', '--create', '--force-create', '--orphan']
  const made = rest.findIndex(word => create.includes(word.text) || create.some(flag => flag.startsWith('--') && word.text.startsWith(`${flag}=`)))
  if (made >= 0) {
    const word = rest[made] as Word
    const name = word.text.includes('=') ? word.text.slice(word.text.indexOf('=') + 1) : rest[made + 1]?.text

    return name === undefined || (rest[made + 1]?.hasExpansion === true && !word.text.includes('=')) ? null : name
  }
  if (rest.some(word => word.text === '--')) {
    return undefined
  }
  const said = operands(rest, '', ['--conflict'])
  if (said.length !== 1) {
    return undefined
  }
  const only = said[0] as Word
  if (only.hasExpansion || only.text === '-' || only.text.startsWith('@{')) {
    return null
  }

  return only.text === '.' || only.hasGlob ? undefined : only.text
}

/** Push options that name no source (the last review's F8): what they send is not the branch the gate judged. */
export const UNNAMED_PUSHES: readonly string[] = ['--all', '--branches', '--tags', '--follow-tags', '--mirror']

/**
 * The options an agent's push may carry (R1), each spelled in full; any
 * other option word is refused. `--force-with-lease` and `--no-verify` keep
 * the verdicts their own rules give.
 */
export const PUSH_OPTIONS: readonly string[] = ['-u', '--set-upstream', '-n', '--dry-run', '-v', '--verbose', '-q', '--quiet', '--progress', '--no-progress', '--porcelain', '--atomic', '--no-follow-tags', '--force-with-lease', '--no-verify']

/** Git's global options a shipping line may carry: only those that change nothing but the pager. */
const SHIP_GLOBALS = ['--no-pager', '-P', '-p', '--paginate']

/** How the agent pushes, as the refusals and the rules text say it. */
export const PUSH_ADVICE = 'Push the branch you are on in the one shape the harness judges: `git push -u origin HEAD` (or `git push origin HEAD:refs/heads/<branch>` for its own branch on the remote, the destination spelled in full), as its own command.'

/**
 * Whether a push is of the one shape the agent pushes in (the cache-guard
 * round, R1, P-A): `git push [options] <remote> <source>[:<destination>]`,
 * exactly one refspec whose source is `HEAD` or a branch name (the shipping
 * rules then check it is the branch checked out) and whose destination, if
 * any, is spelled in full, `refs/heads/<name>` (the tenth round, D3), no `+`, no
 * wildcard and no expansion; options only from `PUSH_OPTIONS`; no git option before `push`
 * but the pager's, and no `GIT_*` variable assigned or exported anywhere on
 * the line. What is wrong, or null for that shape.
 */
function pushShape(segment: Segment, line: readonly Segment[]): string | null {
  const { at } = gitSub(segment.args)
  const globals = segment.args.slice(0, at)
  const configuring = globals.find(word => !SHIP_GLOBALS.includes(word.text))
  if (configuring !== undefined) {
    return `the git option ${configuring.text} before \`push\` (nothing configures git on a shipping line: -c, --config-env, --git-dir, --work-tree, --namespace and -C are refused there)`
  }
  const variable = line.flatMap(one => [
    ...one.assigned.map(each => each.name),
    ...(one.program !== null && ['export', 'declare', 'typeset', 'readonly', 'local', 'env'].includes(one.program) ? operands(one.args).map(word => word.text.replace(/=.*$/, '')) : []),
  ]).find(name => /^GIT_[A-Za-z0-9_]*$/.test(name))
  if (variable !== undefined) {
    return `${variable} set on the line (no GIT_* variable is assigned or exported on a shipping line)`
  }
  const rest = segment.args.slice(at + 1)
  const said: Word[] = []
  let isEnd = false
  for (const word of rest) {
    if (!isEnd && word.text === '--') {
      isEnd = true
    } else if (!isEnd && word.text.startsWith('-') && word.text !== '-') {
      if (!PUSH_OPTIONS.includes(word.text) && !word.text.startsWith('--force-with-lease=')) {
        const unnamed = UNNAMED_PUSHES.find(one => isGitLong(word, one))

        return unnamed === undefined
          ? `the option ${word.text} (a push takes only ${PUSH_OPTIONS.join(', ')}, each spelled in full)`
          : `${word.text}, which names no source: it sends ${unnamed === '--tags' || unnamed === '--follow-tags' ? 'tags' : 'branches or refs'} beside (or instead of) the branch the gate judged`
      }
    } else {
      said.push(word)
    }
  }
  if (said.length !== 2) {
    return said.length < 2 ? 'no remote and refspec named: a bare push sends whatever git is configured to send' : 'more than one refspec'
  }
  const [remote, spec] = said as [Word, Word]
  if (remote.hasExpansion || spec.hasExpansion || remote.text === '' || spec.text === '') {
    return 'a remote or refspec known only when the line runs'
  }
  if (spec.hasGlob || spec.text.startsWith('+') || spec.text.startsWith(':') || spec.text.split(':').length > 2) {
    return `the refspec ${spec.text} (one source, no +, no pattern, no deletion)`
  }
  const source = spec.text.includes(':') ? spec.text.slice(0, spec.text.indexOf(':')) : spec.text
  const bare = source.replace(/^refs\/heads\//, '')
  if (source !== 'HEAD' && (bare === '' || bare.startsWith('refs/') || /[~^@:]/.test(bare) || /^[0-9a-f]{7,64}$/i.test(bare))) {
    return `the source ${source} (a push sends HEAD or the branch checked out, by name)`
  }
  // A destination after a colon is spelled in full (the tenth round, D3, P-A): git places an unqualified one
  // (`feature`, `heads/main`, `meta/base`) by what the remote already has, which the harness cannot see.
  if (spec.text.includes(':')) {
    const destination = spec.text.slice(spec.text.indexOf(':') + 1)
    if (!/^refs\/heads\/[^/]/.test(destination)) {
      const named = /^[A-Za-z0-9._-][A-Za-z0-9._/-]*$/.test(destination) && !destination.startsWith('refs/') && !/^(?:heads|tags|remotes)\//.test(destination) ? destination : '<branch>'

      return `the destination ${destination} (spell it in full, as \`${source}:refs/heads/${named}\`: git places an unqualified destination by what the remote already has)`
    }
  }

  return null
}

/**
 * What a command would ship: pushes (with the branches they target), pull
 * requests, merges. The branch is carried through the line: a part after a
 * `git checkout` or `git switch` records where that left it (`on`).
 */
export function shipsOf(command: string): ShipIntent[] {
  // A line ships if either reading says it ships, and every push either reading reads is judged (BB1).
  return unionBy(readings(command).flatMap(segments => shipsBySegment(segments).filter((one): one is ShipIntent => one !== null)), one => JSON.stringify(one))
}

/**
 * Whether a line that ran without error and passed the gate closes the
 * change for the review cap (Z1; the fourteenth round, CC-F7): it is a push
 * under both readings (BB1: an answer that lets something off holds under
 * both), no push in it asks git for a dry run under either (`-n`,
 * `--dry-run`, as git matches options, an abbreviation or a cluster
 * included), and it is one command, not a list or a job in the background.
 * A push the tool ran in the background is the caller's to leave out.
 */
export function closesReview(command: string): boolean {
  if (!isOneLine(command)) {
    return false
  }

  return readings(command).every(segments => {
    const ships = shipsBySegment(segments)
    const pushes = segments.filter((_, i) => ships[i]?.kind === 'push')

    return pushes.length > 0 && pushes.every(segment => {
      const { at } = gitSub(segment.args)

      return segment.program === 'git' && segment.isBeyondDepth !== true && gitOption(segment.args.slice(at + 1), ['--dry-run'], 'n') === null
    })
  })
}

/** What each segment of a line ships, in order (null for one that ships nothing), the branch carried through. */
function shipsBySegment(segments: readonly Segment[]): (ShipIntent | null)[] {
  let on: OnBranch

  return segments.map((segment): ShipIntent | null => {
    // Code past the nesting the model follows may push anything (final round, D1 F12).
    if (segment.isBeyondDepth === true) {
      return { kind: 'push', targets: [], sources: [], isAll: true, on }
    }
    if (segment.program === 'git') {
      const { sub, at } = gitSub(segment.args)
      const rest = segment.args.slice(at + 1)
      const moved = switchOf(sub, rest)
      if (moved !== undefined) {
        on = moved
      }
      // An alias defined on the line may be a push of anything (C2.1 F10): judged as possibly pushing every branch.
      if (hasGitAlias(segment.args)) {
        return { kind: 'push', targets: [], sources: [], isAll: true, on }
      }
      if (sub === 'push') {
        const specs = operands(rest, 'o', ['--push-option', '--repo', '--receive-pack', '--exec']).slice(1)
        const parts = specs.map(spec => {
          const text = spec.text.replace(/^\+/, '')
          const isPair = text.includes(':')
          const dst = isPair ? text.slice(text.indexOf(':') + 1) : text

          return { target: dst.replace(/^refs\/heads\//, ''), source: (isPair ? text.slice(0, text.indexOf(':')) : text) || 'HEAD' }
        })

        const unnamed = gitOptionWords(rest).find(word => UNNAMED_PUSHES.some(one => isGitLong(word, one)))?.text ?? null
        const misshapen = pushShape(segment, segments)

        return {
          kind: 'push', targets: parts.map(one => one.target), sources: parts.map(one => one.source), isAll: gitOption(rest, ['--all', '--mirror', '--branches']) !== null,
          ...(unnamed === null ? {} : { unnamed }), ...(misshapen === null ? {} : { misshapen }), on,
        }
      }
      if (sub === 'merge' && !gitOptionExactly(rest, ['--abort', '--quit'])) {
        return { kind: 'merge', on }
      }
    } else if (segment.program === 'gh') {
      const [noun, action] = ghWords(segment.args)
      if (noun === 'pr' && (action === 'create' || action === 'ready' || action === 'merge')) {
        return { kind: `pr-${action}`, on }
      }
    }

    return null
  })
}

/** Git sub-commands that only read, for the ship-alone rule; `remote`, `reflog` and `symbolic-ref` only in their reading forms (C2.1 F3). */
const GIT_SHIP_READS = [...GIT_READS_BASE, 'remote', 'describe', 'shortlog', 'reflog', 'symbolic-ref', 'for-each-ref', 'show-ref', 'name-rev']

/** Git's global options that point it at another repository, configuration or program: never a plain read. */
const GIT_ELSEWHERE = ['-c', '--config-env', '--exec-path', '--git-dir', '--work-tree']

/**
 * Whether a word is one of the named git options, as git reads it (R1): a
 * long one by `isGitLong` (any prefix of two letters or more), a short one
 * as `-X` or `-Xvalue`. Quoting does not hide an option from git.
 */
const isOptionNamed = (word: Word, names: readonly string[]): boolean =>
  !/\s/.test(word.text) && names.some(name => isGitLong(word, name) || (name.length === 2 && word.text.startsWith(name) && !word.text.startsWith('--')))

/**
 * Whether a git command is a plain read in its reading form (C2.1 F3):
 * a reading sub-command with no option that runs a program or writes a
 * file (`grep -O`, `--ext-diff`, `--textconv`, `--output`); `remote` only
 * listed or shown, `reflog` only shown, `symbolic-ref` only read; a branch
 * only listed.
 */
function isGitRead(segment: Segment): boolean {
  const { sub, at } = gitSub(segment.args)
  const globals = segment.args.slice(0, at)
  if (globals.some(word => isOptionNamed(word, GIT_ELSEWHERE))) {
    return false
  }
  const rest = segment.args.slice(at + 1)
  if (gitOptionWords(rest).some(word => isOptionNamed(word, GIT_WRITING))) {
    return false
  }
  const said = operands(rest)
  switch (sub) {
    case 'branch':
      // A listing only: `git branch`, `--show-current`, `-a`, `-v`, `--list`.
      return rest.every(word => /^(-a|-r|-v|-vv|--all|--list|--show-current|--remotes|--verbose|--no-color|--color)$/.test(word.text))
    case 'remote': {
      // `git remote`, `-v`, `show [name]`, `get-url <name>`: nothing that adds, removes, renames or sets.
      const first = said[0]?.text
      const before = first === undefined ? rest : rest.slice(0, rest.findIndex(word => word.text === first))

      return before.every(word => word.text === '-v' || word.text === '--verbose') && (first === undefined || first === 'show' || first === 'get-url')
    }
    case 'reflog': {
      // `git reflog`, `git reflog show …`, `git reflog <ref>`, `git reflog exists <ref>`: never expire or delete.
      const first = said[0]?.text

      return first === undefined || !['expire', 'delete', 'drop'].includes(first)
    }
    case 'symbolic-ref':
      // Reading names one ref; a second operand sets it, and -d deletes it.
      return said.length <= 1 && gitOption(rest, ['--delete'], 'd') === null && gitOption(rest, [], 'm') === null
    default:
      return sub !== null && GIT_SHIP_READS.includes(sub)
  }
}

/** Programs that only read or print, beside the plain readers: what may share a line with a shipping command. */
const SHIP_READERS = ['echo', 'printf', 'pwd', 'true', 'test', '[', 'date', 'whoami', 'which', 'type']

/**
 * Whether a segment may stand beside a shipping command on one line (L2):
 * `cd`, or a plain read that writes no path, redirects to no file and runs
 * no unknown code. Anything else may change what the line then ships.
 */
function isShipCompanion(segment: Segment): boolean {
  if (segment.program === 'cd' || segment.program === 'pushd' || segment.program === 'popd') {
    return segment.redirects.every(one => !one.isWrite) && segment.writes.length === 0
  }
  if (segment.isUnknown || segment.writes.length > 0 || segment.maybeWrites.length > 0 || segment.redirects.some(one => one.isWrite) || segment.assignments.length > 0) {
    return false
  }
  const program = segment.program
  if (program === null) {
    return false
  }
  if (program === 'git') {
    return isGitRead(segment)
  }

  return SHIP_READERS.includes(program) || (READERS[program] !== undefined && isReaderSegment({ ...segment, isNested: false, wrappers: [] }))
}

/**
 * Whether a merge ships (C2.1 F2): on the default branch, or possibly on it
 * (after a switch the model cannot follow, or with the branch checked out
 * unknown). A merge anywhere else brings work in.
 */
export const isMergeShip = (intent: ShipIntent, branch: string | null, defaultBranch: string): boolean =>
  intent.on === undefined ? branch === null || branch === defaultBranch : intent.on === null || intent.on === defaultBranch

/**
 * What each segment ships for the ship-alone rule: a push, a pull request
 * created, readied or merged, a possible ship by an alias, and a merge only
 * where it ships (`isMergeShip`).
 */
function shipIntents(segments: readonly Segment[], branch: string | null, defaultBranch: string): (ShipIntent | null)[] {
  return shipsBySegment(segments).map(one => (one !== null && (one.kind !== 'merge' || isMergeShip(one, branch, defaultBranch)) ? one : null))
}

/**
 * The ship-alone rule (L2, decision 9a; C2.1 F2): a line that ships (a push,
 * a pull request created, readied or merged, a merge on or possibly on the
 * default branch) must ship and do nothing else but `cd` and plain reads,
 * because the gate judges the tree before the line runs and a line that also
 * writes, commits or runs code would ship a change the gate never saw. A
 * merge elsewhere is a write like any other; a merge or an alias beside
 * another ship is a write too. Whatever the tier, even on a clean tree.
 * `branch` is the branch checked out (null: not known, possibly the default).
 */
export function shipAlone(command: string, branch: string | null = null, defaultBranch = 'main'): Verdict {
  return readings(command).map(segments => shipAloneIn(segments, branch, defaultBranch)).find(one => one !== null) ?? null
}

/** The ship-alone rule under one reading (BB1). */
function shipAloneIn(segments: readonly Segment[], branch: string | null, defaultBranch: string): Verdict {
  const ships = shipIntents(segments, branch, defaultBranch)
  const count = ships.filter(one => one !== null).length
  if (count === 0) {
    return null
  }
  // A merge or an alias writes the tree too: it stands alone, or it is a write beside the other ship.
  const isPlainShip = (segment: Segment, i: number): boolean => {
    const one = ships[i]

    return one !== null && one !== undefined && (count === 1 || (one.kind !== 'merge' && !segment.isUnknown))
  }
  const others = segments.filter((segment, i) => !isPlainShip(segment, i) && !isShipCompanion(segment))
  if (others.length === 0) {
    return null
  }
  const named = [...new Set(others.map(one => [one.program ?? '(computed)', one.program === 'git' ? gitSub(one.args).sub : null].filter(Boolean).join(' ')))].slice(0, 3)

  return {
    rule: 'ship-alone',
    reason: `This line ships and also runs ${named.join(', ')}. Run the push (or the pull request) as its own command, so the harness can judge exactly what is being pushed: the gate judges the tree before a line runs, and a line that changes the tree and ships it would ship work the gate never saw.`,
  }
}

/**
 * Where a line ships from (C2.1 F10): the harness judges one repository, so
 * a ship whose working directory is outside its root, cannot be followed,
 * or is pointed elsewhere by `--git-dir`, `--work-tree` or `GIT_DIR` is
 * refused.
 */
export function shipElsewhere(command: string, where: Where, defaultBranch: string): Verdict {
  return READINGS.map(reading => shipElsewhereIn(parseOf(command, where, reading), where, defaultBranch)).find(one => one !== null) ?? null
}

/** Where a line ships from, under one reading (BB1). */
function shipElsewhereIn(segments: readonly Segment[], where: Where, defaultBranch: string): Verdict {
  const ships = shipIntents(segments, where.branch, defaultBranch)
  for (const [i, segment] of segments.entries()) {
    if (ships[i] === null || ships[i] === undefined) {
      continue
    }
    const globals = segment.program === 'git' ? segment.args.slice(0, gitSub(segment.args).at) : []
    const isPointed = globals.some(word => isOptionNamed(word, ['--git-dir', '--work-tree']))
      || segment.assignments.some(one => /^GIT_(DIR|WORK_TREE)=/.test(one))
    // gh's `-R`/`--repo` names the repository it acts on (D1): another one than this one's remote ships elsewhere.
    const repo = segment.program === 'gh' ? flagValue(segment.args, '-R', '--repo') : null
    if (repo !== null && (where.remote === undefined || where.remote === null || repoSlug(repo) !== where.remote)) {
      return {
        rule: 'gate',
        reason: `This ships to ${repo}, which is not this repository's remote (${where.remote ?? 'not known here'}), and the harness can judge only this repository. Run it without -R/--repo, from inside the repository it ships.`,
      }
    }
    const here = segment.cwd === null ? null : place('.', segment.cwd, where)
    if (isPointed || here === null || here.rel === null) {
      const from = isPointed ? 'another git directory' : here === null || here.abs === null ? 'a directory the harness cannot follow' : here.abs
      return {
        rule: 'gate',
        reason: `This ships from ${from}, and the harness can judge only this repository (${where.root}). Run the push from inside it, as its own command.`,
      }
    }
  }

  return null
}

/**
 * A repository named the way gh, git and a remote URL name it, reduced to
 * `owner/name`, lower case: `OWNER/REPO`, `HOST/OWNER/REPO`,
 * `https://host/owner/repo.git`, `git@host:owner/repo.git`.
 */
export function repoSlug(named: string): string {
  const bare = named.trim().replace(/\.git$/, '').replace(/\/+$/, '').replace(/^[a-z][a-z0-9+.-]*:\/\/[^/]*\//i, '').replace(/^[^@/]+@[^:]+:/, '')
  const parts = bare.split('/').filter(one => one !== '')

  return parts.slice(-2).join('/').toLowerCase()
}

/** The notes ref that holds portable evidence (D1): only the harness writes it. */
export const EVIDENCE_REF = 'refs/notes/devloop'

/** Whether a ref name or pattern reaches the evidence notes: `devloop`, `refs/notes/devloop`, or a pattern over refs/notes. */
const isEvidenceRef = (ref: string): boolean => {
  const bare = ref.replace(/^\+/, '').replace(/^:/, '')
  const name = bare.includes(':') ? bare.slice(bare.indexOf(':') + 1) : bare

  return [bare, name].some(one => one === 'devloop' || one === 'notes/devloop' || one === EVIDENCE_REF || (/^(refs\/)?notes\//.test(one) && /[*?[]/.test(one)) || one === 'refs/notes' || one === 'refs/notes/')
}

/** Whether a fetch or pull refspec's destination (after its `:`) is the evidence notes ref, or a pattern over refs/notes (final round, D2 F10). */
const isEvidenceDestination = (spec: string): boolean => {
  const text = spec.replace(/^\+/, '')
  if (!text.includes(':')) {
    return false
  }
  const dst = text.slice(text.indexOf(':') + 1)

  return /^(refs\/)?notes\/devloop$/.test(dst) || (/^(refs\/)?notes(\/|$)/.test(dst) && (/[*?[]/.test(dst) || /^(refs\/)?notes\/?$/.test(dst))) || /\$/.test(dst)
}

/** A value that may name the evidence notes: the ref itself, a pattern over refs/notes, or one known only when the line runs. */
const mayBeEvidenceRef = (value: string): boolean => isEvidenceRef(value) || /\$/.test(value)

/** `git notes` sub-commands that only read. */
const NOTES_READS = ['list', 'show', 'get-ref']

/**
 * The evidence-notes rule (D1, always held): the portable evidence a
 * reviewed tree carries is a git note under refs/notes/devloop, written by
 * the harness alone. Refused, on parsed words and across the line (final
 * round, D1 F3, D2 F10): a `git notes` command that writes on that ref,
 * however the ref is named (`--ref`, `-c core.notesRef=`, an inline
 * `GIT_NOTES_REF=`, or one exported or assigned earlier on the line), or
 * where a value that names it is known only when the line runs (a variable,
 * `--config-env`); an `update-ref` of it; a fetch or pull whose destination
 * is it (or a pattern over refs/notes); and a push of it (named, by a
 * pattern over refs/notes, or `--mirror`). A person pushes notes themselves:
 * `git push origin refs/notes/devloop`. `earlier` is the line's segments
 * before this one.
 */
export function evidenceNotesWrite(segment: Segment, earlier: readonly Segment[] = []): string | null {
  if (segment.program !== 'git') {
    return null
  }
  const { sub, at } = gitSub(segment.args)
  const globals = segment.args.slice(0, at)
  const rest = segment.args.slice(at + 1)
  // Every value the line gives git's own settings (-c, --config-env, GIT_CONFIG_* inline or earlier on the line), as values.
  const settings = gitConfigValues(globals)
  const lineSettings = (pattern: RegExp): Assigned[] => {
    const all = [...segment.assigned, ...earlier.flatMap(one => [...one.assigned, ...(one.program !== null && ['export', 'declare', 'typeset', 'readonly', 'local'].includes(one.program) ? one.args.filter(word => /^[A-Za-z_][A-Za-z0-9_]*=/.test(word.text)).map(word => ({ name: word.text.slice(0, word.text.indexOf('=')), value: word.text.slice(word.text.indexOf('=') + 1), isComputed: word.hasExpansion })) : [])])]

    return all.filter(one => pattern.test(one.name))
  }
  // GIT_CONFIG_PARAMETERS and GIT_CONFIG_KEY_<n> set on the line can name any setting: one that names the notes ref, or holds an expansion, counts (P-B).
  const viaEnvConfig = lineSettings(/^GIT_CONFIG_(PARAMETERS|KEY_\d+|VALUE_\d+)$/).filter(one => one.isComputed || /notesref|remote\..*\.fetch|refs\/notes/i.test(one.value))
  if (sub === 'notes') {
    const isComputedWord = (word: Word): boolean => word.hasExpansion
    // Which ref git writes on: `--ref` decides; else GIT_NOTES_REF (inline, or set anywhere earlier on the line, and nothing after
    // cancels a forbidden one: the last review's F3); else core.notesRef by -c, --config-env or GIT_CONFIG_*. A value the model
    // cannot compute is taken for the evidence ref (the cache-guard round, R2, P-B).
    const refWords = gitOptionValues(rest, '--ref')
    const fromEnv = [...segment.assigned.filter(one => one.name === 'GIT_NOTES_REF'), ...assignedBefore('GIT_NOTES_REF', earlier)]
    const fromConfig = settings.filter(word => /^core\.notesref=/i.test(word.text) || (/^core\.notesref=/i.test(word.text.replace(/^-c/, ''))))
    const fromConfigEnv = globals.some(word => isGitLong(word, '--config-env')) && settings.some(word => /^core\.notesref=/i.test(word.text))
    type Ref = { value: string; isComputed: boolean }
    const refs: Ref[] = refWords.length > 0
      ? refWords.map(word => ({ value: word.text, isComputed: isComputedWord(word) }))
      : [
          ...fromEnv,
          ...fromConfig.map(word => ({ value: word.text.replace(/^[^=]*=/, ''), isComputed: isComputedWord(word) || fromConfigEnv })),
          ...viaEnvConfig.map(one => ({ value: one.value, isComputed: true })),
        ]
    // The action: the first word that is not an option or the value of `--ref`.
    let action = 'list'
    for (let i = 0; i < rest.length; i += 1) {
      const word = rest[i] as Word
      if (isGitLong(word, '--ref')) {
        i += word.text.includes('=') ? 0 : 1
      } else if (!word.text.startsWith('-')) {
        action = word.text
        break
      }
    }
    const ref = refs.find(one => one.isComputed || mayBeEvidenceRef(one.value)) ?? null
    if (ref !== null && !NOTES_READS.includes(action)) {
      return `\`git notes ${action}\` on ${EVIDENCE_REF}${!ref.isComputed && isEvidenceRef(ref.value) ? '' : ' (or on a ref known only when the line runs)'}`
    }

    return null
  }
  if (sub === 'update-ref') {
    // The ref operand: one that names the evidence ref, or holds an expansion (P-B).
    const said = operands(rest, 'm', [])
    if (said.some(word => isEvidenceRef(word.text)) || said[0]?.hasExpansion === true) {
      return `\`git update-ref\` of ${EVIDENCE_REF}${said[0]?.hasExpansion === true ? ' (or of a ref known only when the line runs)' : ''}`
    }

    return null
  }
  if (sub === 'symbolic-ref') {
    const said = operands(rest, 'm', [])
    const isWrite = said.length >= 2 || gitOption(rest, ['--delete'], 'd') !== null
    if (isWrite && said.some(word => word.hasExpansion || isEvidenceRef(word.text))) {
      return `\`git symbolic-ref\` of ${EVIDENCE_REF} (or of a ref known only when the line runs)`
    }

    return null
  }
  if (sub === 'fetch' || sub === 'pull') {
    const specs = operands(rest, 'oj', ['--depth', '--deepen', '--shallow-since', '--shallow-exclude', '--upload-pack', '--negotiation-tip', '--server-option', '--jobs', '--refmap', '--recurse-submodules-default']).slice(1)
    const refmaps = gitOptionValues(rest, '--refmap')
    const fetchSettings = [...settings.filter(word => /^remote\..*\.fetch=/i.test(word.text)).map(word => ({ ...word, text: word.text.replace(/^[^=]*=/, '') })), ...viaEnvConfig.map(one => ({ text: one.value, hasExpansion: true }))]
    // A destination known only when the line runs may be the evidence ref (P-B): a refspec holding an expansion is refused.
    if ([...specs, ...refmaps, ...fetchSettings].some(word => word.hasExpansion || isEvidenceDestination(word.text))) {
      return `a ${sub} into ${EVIDENCE_REF}${[...specs, ...refmaps, ...fetchSettings].some(word => word.hasExpansion) ? ' (or into a ref known only when the line runs)' : ''}`
    }

    return null
  }
  if (sub === 'push') {
    const specs = operands(rest, 'o', ['--push-option', '--repo', '--receive-pack', '--exec']).slice(1)
    if (gitOption(rest, ['--mirror']) !== null || specs.some(word => word.hasExpansion || isEvidenceRef(word.text))) {
      return `a push of ${EVIDENCE_REF}${specs.some(word => word.hasExpansion) ? ' (or of a ref known only when the line runs)' : ''}`
    }
  }

  return null
}

/**
 * Whether a git command sets the skip-worktree or assume-unchanged bit on an
 * index entry (the last review's F2): `git update-index --skip-worktree` or
 * `--assume-unchanged`. A file with either bit keeps its changes out of
 * `git add -A`, so out of the tree the gate judges and of what a push sends.
 * The `--no-` forms clear the bit and are fine. The option as written, or null.
 */
export function hidesFromGit(segment: Segment): string | null {
  const { sub, at } = gitSub(segment.args)
  if (sub !== 'update-index') {
    return null
  }

  return gitOption(segment.args.slice(at + 1), ['--skip-worktree', '--assume-unchanged'])
}

/** Git plumbing that writes refs or objects from what it is fed, not from its operands. */
const NOTES_PLUMBING = ['fast-import', 'update-ref', 'symbolic-ref', 'hash-object', 'mktree', 'commit-tree', 'replace']

/** The evidence ref, or a pattern over refs/notes, named in some text. */
const NAMES_REF = /(^|[^A-Za-z0-9_./-])(refs\/)?notes\/devloop($|[^A-Za-z0-9_-])|refs\/notes\/[*?[]/

/**
 * Plumbing that can write the evidence notes without naming them as an
 * operand (D2, carried from D1): `git fast-import` fed a stream, `git
 * update-ref --stdin`, `git hash-object -w` then an `update-ref`, a
 * `symbolic-ref` pointing at the ref. Refused where the line names the ref
 * anywhere: in its parsed words (so a quote-split spelling, `refs/notes/dev''loop`,
 * is the ref it spells: final round, D2 F10), in an `echo`/`printf` feeding
 * it, an argument, or a heredoc's text. What reaches the ref with no
 * mention of it in the line (a stream read from a file, a computed ref name)
 * is R35 in docs/RESIDUAL-RISK.md.
 */
export function notesPlumbingWrite(segment: Segment, command: string, line: readonly Segment[] = []): string | null {
  if (segment.program !== 'git') {
    return null
  }
  const { sub } = gitSub(segment.args)
  if (sub === null || !NOTES_PLUMBING.includes(sub)) {
    return null
  }
  if (sub === 'hash-object' && gitOption(segment.args.slice(gitSub(segment.args).at + 1), [], 'w') === null) {
    return null
  }
  const isNamed = NAMES_REF.test(command) || line.some(one => [...one.words.map(word => word.text), ...one.assignments, ...one.redirects.map(each => each.target)].some(text => NAMES_REF.test(text)))

  return isNamed ? `\`git ${sub}\` in a line that names ${EVIDENCE_REF}` : null
}

/** Whether a push names a source other than the branch it runs on or `HEAD` (C2.1 F10): what it ships is not the tree the gate judged. */
export function pushesOtherBranch(intent: ShipIntent, branch: string | null): string | null {
  if (intent.kind !== 'push') {
    return null
  }
  const current = intent.on === undefined ? branch : intent.on

  return intent.sources.map(one => one.replace(/^refs\/heads\//, '')).find(one => one !== 'HEAD' && one !== '@' && one !== current) ?? null
}

/**
 * Whether a tool call can change what a push ships, or is itself a ship, for
 * the count of main-loop calls in flight (C2.1, two calls dispatched
 * together). A ship is a push, a pull request action, an alias, or a merge;
 * a write is a call that writes a path, runs unknown code, or a git
 * sub-command that is not a plain read (a merge among them).
 */
export function callKind(command: string): { isShip: boolean; isWrite: boolean } {
  // A ship or a write under either reading counts (BB1).
  const kinds = readings(command).map(callKindIn)

  return { isShip: kinds.some(one => one.isShip), isWrite: kinds.some(one => one.isWrite) }
}

/** What a call is under one reading (BB1). */
function callKindIn(segments: readonly Segment[]): { isShip: boolean; isWrite: boolean } {
  const ships = shipsBySegment(segments)
  const isWrite = segments.some((segment, i) => {
    const one = ships[i]
    if (one !== null && one !== undefined && one.kind !== 'merge' && !segment.isUnknown) {
      return false
    }
    if (segment.writes.length > 0 || segment.maybeWrites.length > 0 || segment.redirects.some(each => each.isWrite) || segment.isUnknown) {
      return true
    }

    return segment.program === 'git' && !isGitRead(segment)
  })

  return { isShip: ships.some(one => one !== null), isWrite }
}

/**
 * What a hook must look up before judging a line (D1): whether it ships,
 * whether it merges without switching first (the branch checked out then
 * decides), and whether a `gh` ship names a repository with `-R`/`--repo`
 * (this repository's remote then decides).
 */
export function shipLookups(command: string): { isShip: boolean; hasMerge: boolean; hasRepoFlag: boolean } {
  // What either reading needs looked up is looked up (BB1).
  const each = readings(command).map(segments => {
    const ships = shipsBySegment(segments)

    return {
      isShip: ships.some(one => one !== null),
      hasMerge: ships.some(one => one !== null && one.kind === 'merge' && one.on === undefined),
      hasRepoFlag: segments.some((segment, i) => ships[i] !== null && ships[i] !== undefined && segment.program === 'gh' && flagValue(segment.args, '-R', '--repo') !== null),
    }
  })

  return { isShip: each.some(one => one.isShip), hasMerge: each.some(one => one.hasMerge), hasRepoFlag: each.some(one => one.hasRepoFlag) }
}

/**
 * Whether a part of the line runs on the default branch, or possibly does:
 * after a switch, where that left it (a ref the model cannot name counts as
 * the default); otherwise the branch checked out.
 */
export function isOnDefault(intent: ShipIntent, branch: string | null, defaultBranch: string): boolean {
  return intent.on === undefined ? branch === defaultBranch : intent.on === null || intent.on === defaultBranch
}

/** Whether a push lands on the default branch: named, by `--all`, or by pushing it while on it. */
export function isPushToDefault(intent: ShipIntent, branch: string | null, defaultBranch: string): boolean {
  if (intent.kind !== 'push') {
    return false
  }

  return intent.isAll || intent.targets.includes(defaultBranch) || ((intent.targets.length === 0 || intent.targets.includes('HEAD')) && isOnDefault(intent, branch, defaultBranch))
}

// ---------------------------------------------------------------- the verdict on a command

/** A word's path spelling: the value of `--flag=value` or `NAME=value`. */
const pathOf = (word: Word): string => word.text.replace(/^--?[A-Za-z][\w-]*=/, '').replace(/^[A-Za-z_][A-Za-z0-9_]*=/, '')

/** Every path a segment names, for the secrets rule: arguments, assignments, redirects, inline code. */
function namedPaths(segment: Segment): string[] {
  const isUrl = (text: string): boolean => /^[a-z][a-z0-9+.-]*:\/\//i.test(text)
  const isValue = (word: Word): boolean => /^-[\w-]*=|^[A-Za-z_]\w*=/.test(word.text) && !word.hasExpansion && !/\s/.test(word.text)
  // The program's own name is no path it reads; a computed one is judged by what it names.
  const args = segment.program === null ? segment.words : segment.args

  return [
    ...args.filter(isPathLike).map(pathOf),
    ...args.filter(isValue).map(pathOf),
    ...segment.assignments.map(one => one.replace(/^[^=]*=/, '')),
    ...segment.redirects.map(one => one.target),
    ...segment.named,
  ].filter(path => path !== '' && path !== '-' && !isUrl(path))
}

// ---------------------------------------------------------------- a line's paths, as the shell would reach them

/** A link a line makes (R15): the name, placed, and where it leads, placed. */
type LineLink = { name: string; target: string }

/** The links each segment of a line may follow (R15): those `ln` made in the segments before it, by index. */
function lineLinks(segments: readonly Segment[], where: Where): LineLink[][] {
  const out: LineLink[][] = []
  let made: LineLink[] = []
  for (const segment of segments) {
    out.push(made)
    const more: LineLink[] = []
    for (const one of segment.links) {
      const name = place(one.name, segment.cwd, where).abs
      // A symbolic link's relative target is read from the link's own folder; a hard link's from where the command runs.
      const from = one.isSymbolic && !one.target.startsWith('/') && !one.target.startsWith('~') && name !== null ? name.slice(0, name.lastIndexOf('/')) || '/' : segment.cwd
      const target = place(one.target, from, where).abs
      if (name !== null && target !== null && name !== target) {
        more.push({ name, target })
      }
    }
    made = [...made, ...more]
  }

  return out
}


/** Whether a spelled path holds a wildcard the shell expands against the disk. */
const isWild = (spelled: string): boolean => /[*?[]/.test(spelled)

/** What a reading's lookups say a wildcard path matched on disk, by its absolute spelling: undefined where it was not looked up. */
type Lookup = (abs: string) => readonly string[] | 'capped' | undefined

/**
 * How one reading of a line finds what its wildcard paths matched (the
 * fourteenth round, CC1). The reviewed reading as `2374c49` did: the entry
 * of `Where.globs` by the path's absolute spelling. The extended reading:
 * the matches of every pattern it asked for that spelling, from its own
 * `Where.globsExtended` (one capped, the path is capped), so that a quoted
 * spelling and an unquoted one of the same text each add their own matches
 * and neither empties the other's (CC-F1).
 */
function lookupOf(segments: readonly Segment[], where: Where, reading: Reading): Lookup {
  if (reading === 'reviewed') {
    return abs => where.globs?.[abs]
  }
  const byKey = new Map<string, string[]>()
  for (const ask of globAsksExtended(segments, where)) {
    byKey.set(ask.key, [...(byKey.get(ask.key) ?? []), ask.pattern])
  }

  return abs => {
    const answers = (byKey.get(abs) ?? []).map(pattern => where.globsExtended?.[pattern]).filter(one => one !== undefined)
    if (answers.length === 0) {
      return undefined
    }

    return answers.includes('capped') ? 'capped' : [...new Set(answers.flatMap(one => (one === 'capped' ? [] : one)))].sort()
  }
}

/**
 * Every place one spelled path reaches on its line (R15, P-C): where it is
 * placed, where a link made earlier on the line leads it, and what each of
 * those matched on disk as the reading's lookups say (`lookupOf`).
 * `isCapped` when a wildcard matched more than `GLOB_CAP` paths.
 */
function reach(spelled: string, segment: Segment, links: readonly LineLink[], where: Where, lookup: Lookup): { places: Placed[]; isCapped: boolean } {
  const first = place(spelled, segment.cwd, where)
  const places: Placed[] = [first]
  for (const link of links) {
    for (const one of [...places]) {
      if (one.abs !== null && (one.abs === link.name || one.abs.startsWith(`${link.name}/`))) {
        places.push({ ...place(`${link.target}${one.abs.slice(link.name.length)}`, null, where), spelled })
      }
    }
  }
  let isCapped = false
  for (const one of [...places]) {
    const found = one.abs === null || !isWild(one.abs) ? undefined : lookup(one.abs)
    if (found === 'capped') {
      isCapped = true
    } else if (found !== undefined) {
      places.push(...found.map(abs => ({ ...place(abs, null, where), spelled: `${spelled} (${abs})`, isMatch: true })))
    }
  }

  return { places, isCapped }
}

/**
 * One lookup for the hook to make on disk (P-C). `kind` says whose it is and
 * where its answer is kept (the fourteenth round, CC1): `reviewed`, the
 * reviewed reading's, kept in `Where.globs` and expanded by
 * `expandGlobReviewed`; `extended`, the extended reading's, kept in
 * `Where.globsExtended`; `spaced`, a word holding white space (BB5), kept in
 * `Where.spaced`; the last two expanded by `expandGlob`. `pattern` is what
 * is expanded, and what the answer is kept by; `key` is the path's absolute
 * spelling, which the rules look the answer up by (the same as the pattern
 * for the reviewed reading, as in `2374c49`).
 */
export type GlobAsk = { kind: 'reviewed' | 'extended' | 'spaced'; key: string; pattern: string }

/** How many wildcard paths (and `pushd` targets, Y1) the extended reading of one line looks up on disk; past it the line is refused (the twelfth round, X10; Y2). */
export const GLOB_BUDGET = 32

/** How many words holding white space one reading of a line looks up on disk (BB5); past it the line is refused (the fourteenth round, CC-F6). */
export const SPACED_BUDGET = 200

/** How many wildcard paths the reviewed reading looks up, the first ones it names: `2374c49`'s `globWords` (its hooks/rules.ts, line 1561). */
const REVIEWED_GLOBS = 16

/** How many times the hook expands a line's wildcard paths: a move's match places the paths after it, which are expanded next (X11). */
export const GLOB_ROUNDS = 3

/** How many places one reading of a line names whose links the hook follows; past it the line is refused (X12; Y2; CC-F8). */
export const LINK_BUDGET = 200

/** How many paths one reading of a line writes that the hook follows through links; past it the line is refused (X12; Y2; CC-F8). */
export const WRITE_LINK_BUDGET = 64

/** A word's path spelling as a pattern: its template (quoted characters escaped) where it has one, less a `--flag=` or `NAME=`. */
const patternOf = (word: Word): string => (word.template ?? word.text).replace(/^--?[A-Za-z][\w-]*=/, '').replace(/^[A-Za-z_][A-Za-z0-9_]*=/, '')

/**
 * Every lookup a line asks the disk for, under both readings (BB1, CC1),
 * each once: what the hook expands before judging, so that the rules judge
 * each match. A move's match places what follows it, so the hook asks again
 * once it has the answers (`GLOB_ROUNDS`). Words holding an expansion the
 * model could not resolve are not expanded.
 */
export function globWords(command: string, where: Where): GlobAsk[] {
  return unionBy(globAsks(command, where).flat(), one => `${one.kind}\u0000${one.pattern}`)
}

/**
 * What each reading of a line asks the disk (BB1), the reviewed reading
 * first: the reviewed reading's own lookups (`globAsksReviewed`) and its
 * words with white space; the extended reading's (`globAsksExtended`) and
 * its words with white space. Each budget holds for each reading.
 */
export function globAsks(command: string, where: Where): GlobAsk[][] {
  return READINGS.map(reading => {
    const segments = parseOf(command, where, reading)

    return [...(reading === 'reviewed' ? globAsksReviewed(segments, where) : globAsksExtended(segments, where)), ...spacedAsks(segments, where)]
  })
}

/** Each kind of lookup's answers, by pattern, as an expander gave them. */
export type GlobAnswers = Readonly<Record<GlobAsk['kind'], Readonly<Record<string, readonly string[] | 'capped'>>>>

/**
 * What the hook has still to look up for a line, given what it has (one
 * round of the gatherers, `withGlobs` and `globsFor`): each reading's
 * lookups not yet answered, each once by kind and pattern; none of a kind a
 * reading has past its budget (the line is refused for that reading,
 * `budgetRefusals`).
 */
export function globsWanted(command: string, at: Where): GlobAsk[] {
  const kept = (kind: GlobAsk['kind']): Where['globs'] => (kind === 'reviewed' ? at.globs : kind === 'extended' ? at.globsExtended : at.spaced)
  const wanted = globAsks(command, at).flatMap(asks => {
    const isOver = (kind: GlobAsk['kind']): boolean => kind === 'extended' ? asks.filter(one => one.kind === kind).length > GLOB_BUDGET : kind === 'spaced' && asks.filter(one => one.kind === kind).length > SPACED_BUDGET

    return asks.filter(one => !isOver(one.kind) && kept(one.kind)?.[one.pattern] === undefined)
  })

  return unionBy(wanted, one => `${one.kind}\u0000${one.pattern}`)
}

/** The place with a round's answers kept, each kind in its own record (CC1: one reading's answer never stands for the other's). */
export function globsAnswered(at: Where, wanted: readonly GlobAsk[], found: GlobAnswers): Where {
  const answers = (kind: GlobAsk['kind']): Record<string, readonly string[] | 'capped'> =>
    Object.fromEntries(wanted.filter(one => one.kind === kind).map(one => [one.pattern, found[kind][one.pattern] ?? 'capped']))

  return {
    ...at,
    globs: { ...(at.globs ?? {}), ...answers('reviewed') },
    globsExtended: { ...(at.globsExtended ?? {}), ...answers('extended') },
    spaced: { ...(at.spaced ?? {}), ...answers('spaced') },
  }
}

/** The patterns of one kind among a round's lookups, for its expander. */
export const patternsOf = (wanted: readonly GlobAsk[], kind: GlobAsk['kind']): string[] => wanted.filter(one => one.kind === kind).map(one => one.pattern)

/**
 * The reviewed reading's lookups (CC1): `2374c49`'s `globWords` (its
 * hooks/rules.ts, lines 1545-1562), unchanged. The wildcard words of each
 * segment (a word flagged by the reviewed tokenizer), its redirect targets
 * and the paths it names that hold a wildcard, placed, and again through
 * each link the line made; each by its absolute spelling, which is also the
 * pattern expanded; the first `REVIEWED_GLOBS` of them. The rest are judged
 * as written, as `2374c49` judged them.
 */
function globAsksReviewed(segments: readonly Segment[], where: Where): GlobAsk[] {
  const out = new Set<string>()
  const links = lineLinks(segments, where)
  segments.forEach((segment, i) => {
    const spelled = [
      ...segment.args.filter(word => word.hasGlob && !word.hasExpansion).map(word => pathOf(word)),
      ...segment.redirects.map(one => one.target).filter(isWild),
      ...segment.named.filter(isWild),
    ]
    for (const one of spelled) {
      const first = place(one, segment.cwd, where)
      for (const each of [first, ...(links[i] ?? []).flatMap(link => (first.abs !== null && first.abs.startsWith(`${link.name}/`) ? [place(`${link.target}${first.abs.slice(link.name.length)}`, null, where)] : []))]) {
        if (each.abs !== null && isWild(each.abs)) {
          out.add(each.abs)
        }
      }
    }
  })

  return [...out].slice(0, REVIEWED_GLOBS).map(key => ({ kind: 'reviewed', key, pattern: key }))
}

/**
 * The extended reading's lookups (P-C, X11, Y1; CC1): the wildcard target
 * of each move and every `pushd` target (`Segment.moveGlob`), then each
 * wildcard path, by its template (quoted characters escaped) and kept by
 * that pattern, the path's absolute spelling beside it for the rules to look
 * it up by; again through each link the line made. All of them: past
 * `GLOB_BUDGET` the line is refused (`budgetRefusals`).
 */
function globAsksExtended(segments: readonly Segment[], where: Where): GlobAsk[] {
  const out = new Map<string, GlobAsk>()
  const add = (key: string, pattern: string): void => {
    const id = `${key}\u0000${pattern}`
    if (!out.has(id)) {
      out.set(id, { kind: 'extended', key, pattern })
    }
  }
  const links = lineLinks(segments, where)
  segments.forEach((segment, i) => {
    if (segment.moveGlob !== null) {
      add(segment.moveGlob, segment.moveGlob)
    }
    const spelled = [
      ...segment.args.filter(word => word.hasGlob && !word.hasExpansion).map(word => ({ text: pathOf(word), glob: patternOf(word) })),
      ...[...segment.redirects.map(one => one.target), ...segment.named].filter(isWild).map(text => ({ text, glob: text })),
    ]
    for (const one of spelled) {
      const first = place(one.text, segment.cwd, where)
      const glob = place(one.glob, segment.cwd, where).abs
      const asks = [{ key: first.abs, pattern: glob }, ...(links[i] ?? []).flatMap(link => (first.abs !== null && first.abs.startsWith(`${link.name}/`)
        ? [{ key: place(`${link.target}${first.abs.slice(link.name.length)}`, null, where).abs, pattern: glob !== null && glob.startsWith(`${link.name}/`) ? place(`${link.target}${glob.slice(link.name.length)}`, null, where).abs : null }]
        : []))]
      for (const { key, pattern } of asks) {
        if (key !== null && isWild(key)) {
          add(key, pattern ?? key)
        }
      }
    }
  })

  return [...out.values()]
}

/**
 * The words of a segment that hold white space and could be a path (the
 * thirteenth round, BB5), with no wildcard the shell expands: taken for a
 * path when something exists at their place (`spacedAsks`).
 */
const spacedWords = (segment: Segment): Word[] =>
  (segment.program === null ? segment.words : segment.args).filter(word => /\s/.test(word.text) && !word.hasExpansion && !word.hasGlob && !word.text.startsWith('-') && !isGlobTemplate(patternOf(word)))

/** The lookup of a word with white space (BB5): its place, and its pattern (no wildcard in it), which the answer is kept by. */
const spacedAsk = (word: Word, segment: Segment, where: Where): GlobAsk | null => {
  const key = place(pathOf(word), segment.cwd, where).abs
  const pattern = place(patternOf(word), segment.cwd, where).abs

  return key === null || pattern === null ? null : { kind: 'spaced', key, pattern }
}

/** What one reading of a line asks the disk for its words with white space (BB5): budgeted apart from the wildcards (`SPACED_BUDGET`, CC-F6). */
function spacedAsks(segments: readonly Segment[], where: Where): GlobAsk[] {
  return unionBy(segments.flatMap(segment => spacedWords(segment).flatMap(word => spacedAsk(word, segment, where) ?? [])), one => one.pattern)
}

/**
 * The words with white space of a segment that are paths under one reading,
 * judged as any other: those that name something on disk (BB5); and, in the
 * extended reading, those that hold a wildcard, which it expands and judges
 * by their matches (the fourteenth round, CC-F4). The reviewed reading takes
 * none of the second kind, as `2374c49` took none.
 */
const spacedPaths = (segment: Segment, where: Where, reading: Reading): string[] => [
  ...spacedWords(segment).filter(word => {
    const ask = spacedAsk(word, segment, where)
    const found = ask === null ? undefined : where.spaced?.[ask.pattern]

    return found === 'capped' || (Array.isArray(found) && found.length > 0)
  }).map(pathOf),
  ...(reading === 'reviewed' ? [] : (segment.program === null ? segment.words : segment.args)
    .filter(word => /\s/.test(word.text) && word.hasGlob && !word.hasExpansion && !word.text.startsWith('-')).map(pathOf)),
]

/** Every path one reading of a segment names, for the rules that judge what it reaches (`namedPaths`, and its words with white space). */
const pathsOf = (segment: Segment, where: Where, reading: Reading): string[] => [...namedPaths(segment), ...spacedPaths(segment, where, reading)]

/**
 * The places of a line the hook follows through links (X12), each once: the
 * first `budget` it spells, and the first `GLOB_CAP` its wildcards matched.
 * `isOver` when there are more of either: the line is then refused
 * (`budgetRefusals`) rather than judged with the rest unfollowed.
 */
export function linkPlaces(places: readonly Placed[], budget: number): { places: Placed[]; isOver: boolean } {
  const seen = new Set<string>()
  const spelled: Placed[] = []
  const matched: Placed[] = []
  for (const one of places) {
    const key = `${one.abs ?? ''}\u0000${one.raw ?? ''}`
    if (one.abs !== null && !seen.has(key)) {
      seen.add(key)
      if (one.isMatch === true) {
        matched.push(one)
      } else {
        spelled.push(one)
      }
    }
  }

  return { places: [...spelled.slice(0, budget), ...matched.slice(0, GLOB_CAP)], isOver: spelled.length > budget || matched.length > GLOB_CAP }
}

/**
 * What the budgets of one line refuse (the twelfth round, X10, X12), each
 * for each reading (BB1, CC-F8): more wildcard paths than `GLOB_BUDGET` in
 * the extended reading's lookups; a lookup of either reading the hook did
 * not make (where it made that reading's others); more words with white
 * space than `SPACED_BUDGET` (counted apart from the wildcards, CC-F6); more
 * named places than `LINK_BUDGET`; or, opted in, more written paths than
 * `WRITE_LINK_BUDGET` (`linkPlaces`; the matches of wildcards have
 * `GLOB_CAP` for theirs). Past a budget the rest of the line would pass
 * unjudged, so the line is refused instead, with advice to split it:
 * `protected` where a policy is in force, `secret` where only the secrets
 * rule holds (a budget there guards it alone). The reviewed reading's own
 * lookups are `2374c49`'s first 16, and have no budget of their own.
 */
export function budgetRefusals(command: string, where: Where, isOptedIn: boolean): Refusal[] {
  const out: string[] = []
  const isMissing = (asks: readonly GlobAsk[], kept: Where['globs']): boolean => kept !== undefined && asks.some(one => kept[one.pattern] === undefined)
  for (const reading of READINGS) {
    const segments = parseOf(command, where, reading)
    const lookups = reading === 'reviewed' ? globAsksReviewed(segments, where) : globAsksExtended(segments, where)
    if ((reading === 'extended' && lookups.length > GLOB_BUDGET) || isMissing(lookups, reading === 'reviewed' ? where.globs : where.globsExtended)) {
      out.push(`names more wildcard paths than the harness expands for one line (${GLOB_BUDGET})`)
    }
    const spaced = spacedAsks(segments, where)
    if (spaced.length > SPACED_BUDGET || isMissing(spaced, where.spaced)) {
      out.push(`names more words holding white space than the harness looks up for one line (${SPACED_BUDGET})`)
    }
    if (linkPlaces(namedPlacesIn(segments, where, reading), LINK_BUDGET).isOver) {
      out.push(`names more paths than the harness follows through links for one line (${LINK_BUDGET})`)
    }
    if (isOptedIn && linkPlaces(writtenPathsIn(segments, where, reading), WRITE_LINK_BUDGET).isOver) {
      out.push(`writes more paths than the harness follows through links for one line (${WRITE_LINK_BUDGET})`)
    }
  }

  return [...new Set(out)].map(what => ({
    rule: isOptedIn ? 'protected' : 'secret',
    reason: `This line ${what}, so the harness cannot judge the rest of it. Split the line into shorter commands.${isOptedIn ? ` A person can allow this exact command for one turn: /devloop allow --command ${command.trim()}` : ''}`,
  }))
}

/**
 * The places a guard follows through links for a line (X12; the fourteenth
 * round, CC-F8): each reading's own, the first `budget` it spells and the
 * first `GLOB_CAP` its wildcards matched (`linkPlaces`), each place once. A
 * reading past its budget is refused (`budgetRefusals`).
 */
export function followedPlaces(byReading: readonly (readonly Placed[])[], budget: number): Placed[] {
  return unionBy(byReading.flatMap(places => linkPlaces(places, budget).places), one => `${one.abs ?? ''}\u0000${one.raw ?? ''}`)
}

/** The literal folder a pattern names: its parts before the first wildcard part (or before its last part when it has none), `**\/` taken off the front. */
function folderOf(glob: string): { folder: string; isAnywhere: boolean } {
  const isAnywhere = glob.startsWith('**/')

  return { folder: literalPrefix(isAnywhere ? glob.slice(3) : glob), isAnywhere }
}

/** A protected or secret pattern's literal folder, with the rule that guards it (R7, R8). */
type Guarded = { folder: string; isAnywhere: boolean; rule: 'protected' | 'secret'; glob: string }

/** The literal folders the protected and secret patterns in force name (R7). */
function guardedFolders(cfg: Config): Guarded[] {
  const out: Guarded[] = []
  for (const [globs, rule] of [[[...BUILTIN_SECRETS, ...cfg.secrets], 'secret'], [[...BUILTIN_PROTECTED, ...cfg.protected], 'protected']] as const) {
    for (const glob of globs) {
      const { folder, isAnywhere } = folderOf(glob)
      if (folder !== '' && !out.some(one => one.folder === folder && one.rule === rule)) {
        out.push({ folder, isAnywhere, rule, glob })
      }
    }
  }

  return out
}

/**
 * Where a guarded folder concretely lies: a pattern anchored at the root, in
 * the repository; one that matches anywhere, in the home folder, where the
 * tools that write it keep it (`~/.claude/cache-guard`, `~/.aws`), and for a
 * protected one in the repository too (`.git/hooks`, `.claude/hooks`).
 */
const concreteOf = (one: Guarded, where: Where): string[] =>
  [...(!one.isAnywhere || one.rule === 'protected' ? [normalize(`${where.root}/${one.folder}`)] : []), ...(one.isAnywhere && where.home !== null ? [normalize(`${where.home}/${one.folder}`)] : [])]

/**
 * Whether a shell command's write reaches a protected or secret pattern's
 * literal folder as a whole (the cache-guard round, R7), in or out of the
 * repository: a write, copy, extraction, sync or link whose target is that
 * folder; and, for a removal, a move away or a link that replaces it
 * (`isReplace`), an ancestor of the folder too. A pattern that matches at any
 * depth (`**\/.claude/hooks/**`) guards that folder wherever it lies.
 */
export function folderRefusal(path: Placed, isReplace: boolean, cfg: Config, where: Where): Verdict {
  if (path.abs === null) {
    return null
  }
  const abs = normalize(path.abs)
  for (const one of guardedFolders(cfg)) {
    const concrete = concreteOf(one, where)
    const isTarget = concrete.includes(abs) || (one.isAnywhere && abs.endsWith(`/${one.folder}`))
    const below = `${abs === '/' ? '' : abs}/`
    const isAncestor = isReplace && concrete.some(each => each.startsWith(below))
    if (isTarget || isAncestor) {
      const what = isTarget ? `${path.spelled} is the folder ${one.glob} guards` : `${path.spelled} holds ${concrete.find(each => each.startsWith(below)) ?? one.folder}, the folder ${one.glob} guards`

      return one.rule === 'secret'
        ? { rule: 'secret', reason: `${what}: it holds secrets, so no command writes, moves or replaces it from here.` }
        : { rule: 'protected', reason: `${what}: it configures the agent, git or the harness, so no command writes into, moves, deletes or replaces it from here. A person can exempt it for one turn with /devloop allow ${path.spelled}.` }
    }
  }

  return null
}

/**
 * Whether a recursive read of a folder reads a secret pattern's literal
 * folder (the cache-guard round, R8): the folder itself or a folder beneath
 * it, where it concretely lies (a pattern anchored at the repository's root
 * there; one that matches anywhere, under the home folder, where the tools
 * that write it keep it). A recursive read of a folder with no such folder
 * beneath it is R8 in docs/RESIDUAL-RISK.md.
 */
export function deepReadRefusal(path: Placed, cfg: Config, where: Where): Verdict {
  if (path.abs === null) {
    return null
  }
  const abs = normalize(path.abs)
  for (const one of guardedFolders(cfg).filter(each => each.rule === 'secret')) {
    const inside = concreteOf(one, where).find(each => each === abs || each.startsWith(`${abs === '/' ? '' : abs}/`))
    if (inside !== undefined) {
      return { rule: 'secret', reason: `${path.spelled} is read recursively, and ${inside} beneath it holds secrets (${one.glob}); name the files to read instead.` }
    }
  }

  return null
}

/** The interpreters cache-guard's script runs under (L1): python, python3, python3.x, py, pypy. */
const PYTHONS = /^(?:python[0-9.]*|py|pypy[0-9.]*)$/

/**
 * Whether a segment runs cache-guard's script (the cache-guard round, L1),
 * by any path to a file named `cache_guard.py` (the plugin's copy, the
 * installed one under `~/.claude/cache-guard/`, any other), through an
 * interpreter (`python3 x`, `python x`, `py`, `env python3 x`), directly
 * (`./cache_guard.py`), as a module (`-m cache_guard`), or from inline code
 * that names it. Its tests and a read of the file are not runs of it.
 */
export function runsCacheGuard(segment: Segment): boolean {
  const program = segment.program
  if (program === null) {
    return false
  }
  if (program === 'cache_guard.py') {
    return true
  }
  if (!PYTHONS.test(program)) {
    return false
  }
  const args = segment.args
  const module = args.flatMap((word, i) => (word.text === '-m' ? [args[i + 1]?.text ?? ''] : /^-[a-zA-Z]*m./.test(word.text) && !word.text.startsWith('--') ? [word.text.slice(word.text.indexOf('m') + 1)] : []))
  if (module.some(one => /(?:^|\.)cache_guard$/.test(one))) {
    return true
  }
  const inline = args.findIndex(word => word.text === '-c' || /^-[a-zA-Z]*c$/.test(word.text))
  if (inline >= 0 && /cache_guard/.test(args[inline + 1]?.text ?? '')) {
    return true
  }
  const script = inline >= 0 || module.length > 0 ? undefined : operands(args, 'WX')[0]

  return script !== undefined && basename(script.text) === 'cache_guard.py'
}

const basename = (path: string): string => path.slice(path.lastIndexOf('/') + 1)

const isFilter = (segment: Segment): boolean => ['head', 'tail', 'grep', 'egrep', 'rg', 'less', 'more'].includes(segment.program ?? '')

/** Whether a command runs one of the repository's checks with its output cut by a filter. */
export function filteredCheck(command: string, checks: readonly string[]): string | null {
  const text = command.trim()
  for (const check of checks) {
    const run = check.trim()
    if (run !== '' && text.startsWith(run)) {
      const after = text.slice(run.length)
      // A filter under either reading cuts the output (BB1).
      if (/^\s*(?:2>&1\s*)?\|&?/.test(after) && readings(after.replace(/^\s*(?:2>&1\s*)?\|&?/, '')).some(segments => segments.some(isFilter))) {
        return run
      }
    }
  }

  return null
}

/**
 * Every rule a shell command breaks, read by its text alone: one entry per
 * refusal, in the order found. Best effort by nature: the sandbox is the
 * boundary, this is the tripwire. Each simple command is judged on its own
 * (`a && b` is judged as `a` and as `b`), so one allowed part never covers
 * another.
 */
export function judgeCommandAll(command: string, cfg: Config, loop: Loop, where: Where): Refusal[] {
  // The line is judged under both readings, whole (BB1): a refusal under either stands, the reviewed reading's first.
  return unionBy(READINGS.flatMap(reading => judgeIn(command, cfg, loop, where, reading)), one => JSON.stringify([one.rule, one.reason]))
}

/** Every rule a shell command breaks under one reading (BB1). */
function judgeIn(command: string, cfg: Config, loop: Loop, where: Where, reading: Reading): Refusal[] {
  const out: Refusal[] = []
  // Variables the line sets, and those of the judging process's environment, are replaced before paths are placed (R8).
  const segments = parseOf(command, where, reading)
  const links = lineLinks(segments, where)
  // What this reading's wildcard paths matched, from its own lookups (CC1).
  const lookup = lookupOf(segments, where, reading)
  const add = (verdict: Verdict): void => {
    if (verdict !== null && !out.some(one => one.rule === verdict.rule && one.reason === verdict.reason)) {
      out.push(verdict)
    }
  }
  /** The literal folder before a wildcard: what a read past the cap is judged as reading recursively (R9). */
  const prefixOf = (spelled: string, segment: Segment): Placed => place(spelled.replace(/\/?[^/]*[*?[{].*$/, '') || '.', segment.cwd, where)

  for (const [i, segment] of segments.entries()) {
    for (const spelled of pathsOf(segment, where, reading)) {
      const reached = reach(spelled, segment, links[i] ?? [], where, lookup)
      if (reached.places.some(one => isSecretPlace(one, cfg))) {
        add({ rule: 'secret', reason: `${spelled} holds secrets; no command reads or writes it from here.` })
      }
      if (reached.isCapped) {
        add(deepReadRefusal(prefixOf(spelled, segment), cfg, where))
      }
    }
    // A recursive read of a folder that holds a secret pattern's literal folder (R8), and a brace past its cap read as its folder.
    for (const spelled of [...segment.readsDeep, ...segment.capped]) {
      for (const one of reach(spelled, segment, links[i] ?? [], where, lookup).places) {
        add(deepReadRefusal(isWild(one.spelled) || spelled.includes('{') ? prefixOf(one.spelled, segment) : one, cfg, where))
      }
    }
  }
  for (const segment of segments) {
    const destructive = destructiveAction(segment, where)
    if (destructive !== null) {
      add({
        rule: 'destructive',
        reason: `${destructive.what}. Safer: ${destructive.safer}. If it really is needed, a person can allow this exact command for one turn: /devloop allow --command ${command.trim()}`,
      })
    }
  }
  if (isPipeToShell(segments)) {
    add({ rule: 'destructive', reason: `A download is run as code before anyone reads it. Safer: save it to a file (\`curl -fsSLo install.sh <url>\`), read it, then run it. If it really is needed, a person can allow this exact command for one turn: /devloop allow --command ${command.trim()}` })
  }
  for (const segment of segments) {
    // cache-guard's script is run by a person, through /devloop cache (the cache-guard round, L1).
    if (runsCacheGuard(segment)) {
      add({ rule: 'cache-guard', reason: 'This runs cache-guard\'s own script (cache_guard.py), which edits the person\'s user settings and turns on opt-ins: a person runs it, through /devloop cache install|uninstall|doctor|report|status. Its test suite (python3 cache-guard/tests/test_cache_guard.py) and reading the file are fine.' })
    }
    const action = productionAction(segment)
    if (action !== null) {
      add({ rule: 'production', reason: `This command acts on production (${action}). Production changes are a person's to make, whatever the change's risk: stop and hand the command to the person.` })
    }
    const texts = [view(segment, true), view(segment, false)]
    const forbidden = cfg.forbidden.find(one => texts.some(text => new RegExp(one.pattern).test(text)))
    if (forbidden !== undefined) {
      add({ rule: 'forbidden', reason: `devloop.json forbids this command (${forbidden.pattern}): ${forbidden.why}.` })
    }
    if (segment.program === 'git' && isNoVerify(segment)) {
      add({ rule: 'no-verify', reason: 'The repository’s own hooks are not skipped: drop --no-verify (for commit, -n), and leave core.hooksPath alone.' })
    }
    const notes = evidenceNotesWrite(segment, segments.slice(0, segments.indexOf(segment))) ?? notesPlumbingWrite(segment, command, segments)
    if (notes !== null) {
      add({ rule: 'evidence-notes', reason: `${notes}: the portable evidence of a review is the harness's to write, never the builder's. A person pushes it themselves: git push origin ${EVIDENCE_REF}.` })
    }
    const hidden = segment.program === 'git' ? hidesFromGit(segment) : null
    if (hidden !== null) {
      add({ rule: 'git-hidden', reason: `\`git update-index ${hidden}\` tells git to stop looking at a file's changes, so the gate and a push would no longer see what it holds. Leave the bit alone (clearing it, \`--no-${hidden.slice(2)}\`, is fine); if a file must not be committed, say so and let the person decide.` })
    }
    if (segment.program === 'git' && isForcePush(segment)) {
      add({ rule: 'force-push', reason: 'A forced push is a person’s call; use --force-with-lease on your own branch or ask.' })
    }
    if (cfg.network !== null) {
      const allow = cfg.network.allow
      const host = segment.hosts.find(one => !isAllowedHost(one, allow))
      if (host !== undefined) {
        add({ rule: 'egress', reason: `${host} is not in devloop.json's network.allow, so commands do not reach it from here. If the work needs it, stop and ask the person to add it.` })
      }
    }
  }
  // A line that ships must ship alone (L2): the gate judges the tree before the line runs.
  add(shipAloneIn(segments, where.branch, cfg.defaultBranch))
  // And from this repository (C2.1 F10).
  add(shipElsewhereIn(segments, where, cfg.defaultBranch))
  const filtered = filteredCheck(command, cfg.verify.map(one => one.run))
  if (filtered !== null) {
    const saved = where.savedOutput(filtered)
    add({
      rule: 'check-filtered',
      reason: `\`${filtered}\` is one of the repository's checks: run it whole, so no failure is cut away.${saved !== null ? ` The harness saved the full output of its last run at ${saved}; read that file for any part of it.` : ''}`,
    })
  }
  // The `.tasks` rules (D2), where the integration is on: the command's force and act-as options, and the finish gate.
  for (const verdict of where.tasks === undefined ? [] : tasksRefusalsIn(segments, where.tasks)) {
    add(verdict)
  }
  const isLocking = loop.phase === 'spec' || loop.phase === 'build'
  for (const [i, segment] of segments.entries()) {
    const lineLinksHere = links[i] ?? []
    for (const spelled of segment.writes) {
      // Every place the path reaches: as spelled, through a link made earlier on the line (R15), and each wildcard match (P-C).
      const reached = reach(spelled, segment, lineLinksHere, where, lookup)
      for (const placed of reached.places) {
        add(judgeWrite(placed, cfg, loop, where, true))
        if (where.tasks !== undefined && placed.rel !== null) {
          add(tasksShellWriteRefusal(placed.rel, where.tasks, where))
        }
        add(folderRefusal(placed, false, cfg, where))
      }
      if (reached.isCapped) {
        add({ rule: 'protected', reason: `${spelled} matches more than ${GLOB_CAP} paths, so the harness cannot judge what this writes. Name the files to change, or a narrower pattern.` })
      }
    }
    if (segment.capped.length > 0 && (segment.writes.length > 0 || segment.isUnknown)) {
      add({ rule: 'protected', reason: `${segment.capped[0] ?? ''} expands to more than ${GLOB_CAP} words, so the harness cannot judge what this writes. Name the files to change.` })
    }
    // A removal, a move away or a link that replaces a guarded folder or one that holds it (R7).
    for (const spelled of segment.replaces) {
      for (const placed of reach(spelled, segment, lineLinksHere, where, lookup).places) {
        add(folderRefusal(placed, true, cfg, where))
      }
    }
    // What a copy, a move, a sync or a link lands as inside the folder it is given (R7: `cp -r cache-guard ~/.claude/`).
    const dest = segment.writes[segment.writes.length - 1]
    if (dest !== undefined && ['cp', 'mv', 'rsync', 'ln', 'install'].includes(segment.program ?? '')) {
      const sources = segment.program === 'mv' ? segment.replaces : segment.reads
      for (const source of sources) {
        const name = source.replace(/\/+$/, '').slice(source.replace(/\/+$/, '').lastIndexOf('/') + 1)
        if (name !== '' && name !== '.' && name !== '..' && !source.endsWith('/')) {
          add(folderRefusal(place(`${dest.replace(/\/+$/, '')}/${name}`, segment.cwd, where), false, cfg, where))
        }
      }
    }
    // `git checkout <word>` restores a file only when the word is a tracked path.
    for (const spelled of segment.maybeWrites) {
      const placed = place(spelled, segment.cwd, where)
      if (placed.rel !== null && placed.rel !== '' && (where.filesUnder[placed.rel] ?? []).length > 0) {
        add(judgeWrite(placed, cfg, loop, where, true))
      }
    }
    // An unknown command may write any path it names; only the locked-path rules hold for a mention.
    for (const spelled of segment.isUnknown ? segment.named : []) {
      for (const placed of reach(spelled, segment, lineLinksHere, where, lookup).places) {
        const verdict = judgeWrite(placed, cfg, loop, where, false)
        add(verdict === null ? null : { ...verdict, reason: `${verdict.reason} The command's program is computed or runs inline code, so the harness cannot tell what it writes; if it only runs or reads, name the program literally (\`python3 -m pytest\`, not \`$PYTHON -m pytest\`).` })
      }
    }
    if (!segment.isFedByInput || !FED_WRITERS.includes(segment.program ?? '')) {
      continue
    }
    // A writer fed paths by the stage before it writes what that stage names:
    // a file lister's root while a spec is written or built, any other stage's own paths.
    const before = segments.filter(one => one.pipeline === segment.pipeline && one.place < segment.place)
    for (const one of before) {
      const lister = listerRoots(one)
      if (lister === null) {
        for (const spelled of [...one.reads, ...operands(one.args).filter(isPathLike).map(word => word.text)]) {
          add(judgeWrite(place(spelled, segment.cwd, where), cfg, loop, where, false))
        }
      } else if (isLocking) {
        for (const spelled of lister) {
          const verdict = judgeWrite(place(spelled, one.cwd, where), cfg, loop, where, false)
          add(verdict === null ? null : {
            ...verdict,
            reason: `\`${segment.program ?? ''}\` writes every file \`${one.program ?? ''}\` lists under ${spelled}, and locked files lie there: ${verdict.reason} Name the files to change on the command line, or use the edit tool.`,
          })
        }
      }
    }
  }
  // After the locks, so a locked test is refused as locked first.
  for (const segment of segments) {
    for (const verdict of removedTests(segment, cfg, loop, where)) {
      add(verdict)
    }
  }

  return out
}

/**
 * Test files a command deletes, or renames so they no longer run as tests:
 * `rm`, `unlink`, `shred`, `git rm`, and `mv`/`git mv` to a name the test
 * globs do not match. A test is a file git tracks that matches the test
 * globs (B2.1 F9): where the hook listed what git tracks there, a path counts
 * only when a tracked test is at or beneath it, so untracked caches and logs
 * under a test folder are not tests. Where nothing was listed (outside git,
 * a listing that failed), the globs alone decide (fail safe). A person's path
 * exemption lifts it.
 */
export function removedTests(segment: Segment, cfg: Config, loop: Loop, where: Where): Refusal[] {
  const { program } = segment
  const sub = program === 'git' ? gitSub(segment.args).sub : null
  const isDelete = ['rm', 'unlink', 'shred'].includes(program ?? '') || sub === 'rm'
  const isMove = program === 'mv' || sub === 'mv'
  if (!isDelete && !isMove) {
    return []
  }
  const isTestPath = (rel: string): boolean => {
    const listed = where.filesUnder[rel]

    return listed !== undefined
      ? listed.some(file => matchesAny(file, cfg.tests))
      : matchesAny(rel, cfg.tests) || matchesAny(`${rel}/x`, cfg.tests)
  }
  let sources = segment.writes
  let dest: string | null = null
  if (isMove) {
    const target = program === 'mv' ? flagValue(segment.args, '-t', '--target-directory') : null
    dest = target ?? segment.writes[segment.writes.length - 1] ?? null
    sources = target === null ? segment.writes.slice(0, -1) : segment.writes
  }
  const out: Refusal[] = []
  for (const spelled of sources) {
    const placed = place(spelled, segment.cwd, where)
    const rel = placed.rel
    if (rel === null || rel === '' || isExempt(rel, loop) || !isTestPath(rel)) {
      continue
    }
    if (dest !== null) {
      const to = place(dest, segment.cwd, where).rel
      const name = rel.slice(rel.lastIndexOf('/') + 1)
      const landed = to === null ? null : sources.length > 1 || dest.endsWith('/') ? `${to}/${name}` : to
      // A rename that keeps it a test moves it; one that does not stops it running.
      if (landed === null || matchesAny(landed, cfg.tests) || matchesAny(`${landed}/x`, cfg.tests)) {
        continue
      }
    }
    out.push({
      rule: 'test-weakened',
      reason: `${spelled} is a test${dest === null ? '; deleting it' : `; renaming it to ${dest} so it no longer runs as one`} removes what it checks. If the test is truly obsolete, say so and stop: a person can allow it for one turn with /devloop allow ${rel}.`,
    })
  }

  return out
}

/** Writers that take their paths from the stage before them (`xargs sed -i …`). */
const FED_WRITERS = ['rm', 'mv', 'cp', 'tee', 'truncate', 'shred', 'unlink', 'chmod', 'sed', 'perl']

/**
 * The folders a file lister lists, when a stage is one: `git ls-files`,
 * `git grep -l`, `rg -l`, `grep -l`, `find`, `ls`, `fd`; `.` when it names
 * none. Null for any other stage.
 */
export function listerRoots(segment: Segment): string[] | null {
  const { program, args } = segment
  const pathsOr = (paths: readonly Word[]): string[] => {
    const named = paths.filter(isPathLike).map(word => word.text)

    return named.length > 0 ? named : ['.']
  }
  if (program === 'git') {
    const { sub, at } = gitSub(args)
    const rest = args.slice(at + 1)
    if (sub === 'ls-files') {
      return pathsOr(operands(rest, 'x', ['--exclude', '--exclude-from']))
    }
    if (sub === 'grep' && gitOption(rest, ['--files-with-matches', '--name-only'], 'l') !== null) {
      const dash = rest.findIndex(word => word.text === '--')

      return dash >= 0 ? pathsOr(rest.slice(dash + 1)) : ['.']
    }

    return null
  }
  if ((program === 'rg' || program === 'grep' || program === 'egrep' || program === 'fgrep') && hasFlag(args, 'l', ['--files-with-matches', '--files'])) {
    const hasPattern = args.some(word => ['-e', '--regexp', '-f', '--file'].includes(word.text)) || hasFlag(args, null, ['--files'])
    const said = operands(args, 'efABCmgt', ['--regexp', '--file', '--glob', '--type', '--after-context', '--before-context', '--context', '--max-count'])

    return pathsOr(hasPattern ? said : said.slice(1))
  }
  if (program === 'find') {
    return segment.reads.length > 0 ? segment.reads : ['.']
  }
  if (program === 'ls' || program === 'fd' || program === 'fdfind') {
    const said = operands(args, program === 'ls' ? 'IwT' : 'edtEcj', ['--extension', '--type', '--exclude', '--max-depth', '--ignore', '--hide'])

    return pathsOr(program === 'ls' ? said : said.slice(1))
  }

  return null
}

/**
 * Whether a feature check may run (B2.1 F6): it is judged by the command
 * rules as a shell command the builder typed would be, before it is ever
 * run, and a check never ships. Refused only where the rule would hold: in
 * enforce mode, or a rule that holds in every mode. Null to let it run.
 */
export function judgeCheck(check: string, cfg: Config, loop: Loop, where: Where): Verdict {
  const found = judgeCommandAll(check, cfg, loop, where)
  if (shipsOf(check).length > 0) {
    found.push({ rule: 'gate', reason: 'A feature check ships nothing: it pushes, merges or releases.' })
  }

  return strictest(found.filter(one => isHeldBy(one.rule, cfg)))
}

/** The strictest refusal for a shell command, or null to let it run. */
export function judgeCommand(command: string, cfg: Config, loop: Loop, where: Where): Verdict {
  return strictest(judgeCommandAll(command, cfg, loop, where), cfg)
}

/** The words `git checkout` writes only if they are tracked paths, placed: a branch otherwise. */
export function maybeWritten(command: string, where: Where): Placed[] {
  return unionPlaces(maybeWrittenByReading(command, where).flat())
}

/**
 * The same, each reading's apart: a word taken for a branch excuses a write
 * only in the reading that reads it so (the fourteenth round, CC1: an answer
 * that lets something off holds under the reading it is about).
 */
export function maybeWrittenByReading(command: string, where: Where): Placed[][] {
  return READINGS.map(reading => parseOf(command, where, reading).flatMap(segment => segment.maybeWrites.map(spelled => place(spelled, segment.cwd, where))))
}

/**
 * The paths a command writes or may write, placed, for the hook to look into
 * (folders and tracked paths it should list): writes, words `git checkout`
 * writes if tracked, what an unknown command names, a fed writer's lister
 * roots; each also where a link made earlier on the line leads it (R15) and
 * what it matched on disk (P-C).
 */
export function writtenPaths(command: string, where: Where): Placed[] {
  return unionPlaces(writtenPathsByReading(command, where).flat())
}

/** The paths a command writes or may write, each reading's apart (CC-F8: each is followed through links within its own budget). */
export function writtenPathsByReading(command: string, where: Where): Placed[][] {
  return READINGS.map(reading => writtenPathsIn(parseOf(command, where, reading), where, reading))
}

/** The paths a command writes or may write under one reading (BB1). */
function writtenPathsIn(segments: readonly Segment[], where: Where, reading: Reading): Placed[] {
  const links = lineLinks(segments, where)
  const lookup = lookupOf(segments, where, reading)

  return segments.flatMap((segment, i) => [
    ...[...segment.writes, ...segment.maybeWrites, ...(segment.isUnknown ? segment.named : [])].flatMap(spelled => reach(spelled, segment, links[i] ?? [], where, lookup).places),
    ...(segment.isFedByInput && FED_WRITERS.includes(segment.program ?? '')
      ? segments.filter(one => one.pipeline === segment.pipeline && one.place < segment.place)
        .flatMap(one => (listerRoots(one) ?? []).map(spelled => place(spelled, one.cwd, where)))
      : []),
  ])
}


/**
 * Whether a command writes a path that holds an expansion the model could
 * not resolve (the cache-guard round, P-B): where it lands is known only when
 * the line runs, so the eval worktree's containment, which always holds,
 * takes it for a write outside the worktree.
 */
export function writesOpenPath(command: string, where: Where): boolean {
  return READINGS.some(reading => parseOf(command, where, reading).some(segment => segment.isWriteOpen))
}

/** Every path a command names, placed, for the hook to resolve links (a link to a secret is a secret), with the places each reaches on its line. */
export function namedPlaces(command: string, where: Where): Placed[] {
  return unionPlaces(namedPlacesByReading(command, where).flat())
}

/** Every path a command names, placed, each reading's apart (CC-F8: each is followed through links within its own budget). */
export function namedPlacesByReading(command: string, where: Where): Placed[][] {
  return READINGS.map(reading => namedPlacesIn(parseOf(command, where, reading), where, reading))
}

/** Every path a command names under one reading, placed (BB1), words with white space that are paths among them (BB5, CC-F4). */
function namedPlacesIn(segments: readonly Segment[], where: Where, reading: Reading): Placed[] {
  const links = lineLinks(segments, where)
  const lookup = lookupOf(segments, where, reading)

  return segments.flatMap((segment, i) => pathsOf(segment, where, reading).flatMap(spelled => reach(spelled, segment, links[i] ?? [], where, lookup).places))
}

// ---------------------------------------------------------------- the reviewer

/** What the reviewer may run beside the checks: readers, each with its writing options refused by name. */
const READERS: Record<string, readonly string[]> = {
  cat: [], head: [], tail: [], wc: [], nl: [], cut: [], jq: [], ls: [], diff: [], stat: [], file: [],
  grep: [], egrep: [], fgrep: [],
  rg: ['--pre', '--pre-glob'],
  sort: ['-o', '--output'],
  uniq: [],
  find: ['-delete', '-exec', '-execdir', '-ok', '-okdir', '-fprint', '-fprint0', '-fprintf', '-fls'],
}

const GIT_READS = GIT_READS_BASE
// `-o` is `git grep --only-matching`, a read; `-O` opens files in a program.
const GIT_WRITING = ['--output', '--output-directory', '--ext-diff', '--textconv', '-O', '--open-files-in-pager']

/** Whether a segment is a plain read the reviewer may run. */
function isReaderSegment(segment: Segment): boolean {
  if (segment.isUnknown || segment.isNested || segment.writes.length > 0 || segment.wrappers.length > 0 || segment.assignments.length > 0) {
    return false
  }
  if (segment.words.some(word => word.hasExpansion) || segment.redirects.some(one => one.isWrite)) {
    return false
  }
  const refused = (names: readonly string[]): boolean =>
    segment.args.some(word => !word.isQuoted && names.some(name => word.text === name || word.text.startsWith(`${name}=`) || (name.length === 2 && word.text.startsWith(name) && !word.text.startsWith('--'))))
  if (segment.program === 'git') {
    const { sub, at } = gitSub(segment.args)
    const globals = segment.args.slice(0, at)
    if (globals.some(word => isOptionNamed(word, ['-c', '--config-env', '--exec-path', '--git-dir', '--work-tree']))) {
      return false
    }

    // Git's writing options by any prefix git takes, quoted or not (R1's helper).
    return sub !== null && GIT_READS.includes(sub) && !gitOptionWords(segment.args.slice(at + 1)).some(word => isOptionNamed(word, GIT_WRITING))
  }
  const program = segment.program
  if (program === null) {
    return false
  }
  const writing = READERS[program]

  return writing !== undefined && !refused(writing) && (program !== 'uniq' || operands(segment.args, 'fsw').length <= 1)
}

/**
 * Whether a command is one the read-only reviewer may run: the repository's
 * own checks word for word, or one line of plain reads joined by pipes, none
 * of them writing. Nothing that ships, ever.
 */
export function isReviewerCommand(command: string, checks: readonly string[]): boolean {
  const text = command.trim()
  if (shipsOf(text).length > 0) {
    return false
  }
  if (checks.includes(text)) {
    return true
  }
  if (!isOneLine(text) || /\n/.test(text)) {
    return false
  }
  // Plain reads under both readings (BB1).
  return readings(text).every(segments => segments.length > 0 && segments.every(isReaderSegment))
}

/** The places a reviewer's call names, for the hook to resolve before `reviewerMayRun` (R6, R10): the file, the search's folder, each path a command reads, and where each command runs. */
export function reviewerPlaces(tool: string, input: Readonly<Record<string, unknown>>, where: Where): Placed[] {
  const text = (key: string): string => (typeof input[key] === 'string' ? (input[key] as string) : '')
  if (tool === 'Read') {
    return [place(text('file_path'), where.cwd, where)]
  }
  if (tool === 'Grep' || tool === 'Glob') {
    return [place(text('path') === '' ? '.' : text('path'), where.cwd, where)]
  }
  if (tool === 'Bash') {
    return unionPlaces(READINGS.flatMap(reading => parseOf(text('command'), where, reading).flatMap(segment => [place('.', segment.cwd, where), ...segment.reads.map(spelled => place(spelled, segment.cwd, where))])))
  }

  return []
}

/**
 * Whether every place a path is put really lands where `isAllowed` says, and
 * neither spelling is a secret (BB2: from both places a path is put, each
 * place it really lands holds); a path that cannot be placed or resolved
 * never does.
 */
function landsOf(cfg: Config, resolve: (path: Placed) => readonly Placed[] | null, isAllowed: (real: Placed) => boolean): (path: Placed) => boolean {
  return path => {
    const reals = resolve(path)
    if (path.abs === null || reals === null || reals.length === 0 || isSecretPlace(path, cfg)) {
      return false
    }

    return reals.every(real => real.abs !== null && !isSecretPlace(real, cfg) && isAllowed(real))
  }
}

/** A Read, Grep or Glob whose file or folder lands (`lands`), with no secret named in its path or pattern and no Glob pattern that leaves its folder. */
function fileReadLands(tool: 'Read' | 'Grep' | 'Glob', input: Readonly<Record<string, unknown>>, where: Where, cfg: Config, lands: (path: Placed) => boolean): boolean {
  const text = (key: string): string => (typeof input[key] === 'string' ? (input[key] as string) : '')
  if (tool === 'Read') {
    return lands(place(text('file_path'), where.cwd, where))
  }
  const named = [text('path'), tool === 'Glob' ? text('pattern') : text('glob')].filter(one => one !== '')
  if (named.some(one => {
    const name = one.slice(one.lastIndexOf('/') + 1)
    const bare = name.replace(/[*?[\]{}]/g, '')

    return [one, bare].some(each => each !== '' && isSecretPlace(place(each, where.cwd, where), cfg))
  })) {
    return false
  }
  const path = place(text('path') === '' ? '.' : text('path'), where.cwd, where)

  return lands(path) && !(tool === 'Glob' && (text('pattern').startsWith('/') || text('pattern').split('/').includes('..')))
}

/**
 * Whether the harness answers the engine's permission check with an allow
 * for a read inside the spec library (DESIGN 4.18), for any agent: a Read of
 * a file, or a Grep or Glob of a folder, that really lands in the library
 * (`library`: its spellings), never of a secret. Writes there are refused by
 * the call guard (`isHarnessState`). Pure.
 */
export function libraryMayRead(tool: string, input: Readonly<Record<string, unknown>>, facts: { where: Where; cfg: Config; library: readonly string[]; resolve: (path: Placed) => readonly Placed[] | null }): boolean {
  if (facts.library.length === 0 || (tool !== 'Read' && tool !== 'Grep' && tool !== 'Glob')) {
    return false
  }

  return fileReadLands(tool, input, facts.where, facts.cfg, landsOf(facts.cfg, facts.resolve, real => isUnder(real.abs, facts.library)))
}

/**
 * Whether the harness answers the engine's permission check for its own
 * reviewer (or checklist reviewer) with an allow (I1, narrowed in the
 * cache-guard round, R6, R10): a Read of that round's diff file; a Read,
 * Grep or Glob inside the repository root, never of a secret; the
 * repository's checks word for word; and a read-only command the reviewer
 * guard allows (`isReviewerCommand`) every one of whose path operands, as
 * the shell model classifies them, lies inside the repository or is the
 * diff file. Every path is judged where its links lead (`resolve`: the place
 * the hook resolved, or null when it could not tell, which is never
 * answered). A command whose paths the model does not classify, one that
 * asks to leave the sandbox or to run in the background, and anything else
 * is left to the engine (its ask stands). Pure: the caller says which agent
 * it is.
 */
export function reviewerMayRun(tool: string, input: Readonly<Record<string, unknown>>, facts: { where: Where; cfg: Config; diffFile: string | null; checks: readonly string[]; resolve: (path: Placed) => readonly Placed[] | null; library?: readonly string[] }): boolean {
  const text = (key: string): string => (typeof input[key] === 'string' ? (input[key] as string) : '')
  const { where, cfg } = facts
  if (input.dangerouslyDisableSandbox === true || input.run_in_background === true) {
    return false
  }
  const diff = facts.diffFile === null ? null : normalize(facts.diffFile)
  const isInside = (path: Placed): boolean => path.abs !== null && path.rel !== null && !path.rel.split('/').includes('..')
  /** Where a path really lands is inside the repository, is the round's diff file, or is in the spec library (4.18), and neither spelling is a secret. */
  const lands = landsOf(cfg, facts.resolve, real => (diff !== null && real.abs === diff) || isInside(real) || isUnder(real.abs, facts.library))
  if (tool === 'Read' || tool === 'Grep' || tool === 'Glob') {
    return fileReadLands(tool, input, where, cfg, lands)
  }
  if (tool === 'Bash') {
    const command = text('command')
    if (!isReviewerCommand(command, facts.checks) || judgeCommandAll(command, cfg, FRESH, where).some(one => one.rule === 'secret')) {
      return false
    }
    if (facts.checks.includes(command.trim())) {
      return true
    }

    // Every path lands inside under both readings (BB1).
    return READINGS.every(reading => parseOf(command, where, reading).every(segment => {
      if (!lands(place('.', segment.cwd, where))) {
        return false
      }
      if (segment.program === 'git') {
        // Git reads the repository it runs in; `--no-index` compares any two paths, so it is never answered.
        return gitOption(segment.args.slice(gitSub(segment.args).at + 1), ['--no-index']) === null
      }

      return segment.isReadKnown && segment.reads.every(spelled => lands(place(spelled, segment.cwd, where)))
    }))
  }

  return false
}

// ---------------------------------------------------------------- tiers

/**
 * The risk tier of a change: its riskiest file decides. The active spec's
 * own folder is left out: its feature list is protected, but writing it is
 * the spec phase's work, not a risk of the change.
 */
export function tierOf(files: readonly string[], cfg: Config, hasTouchedTests: boolean, spec: string | null = null): Tier {
  const counted = spec === null ? files : files.filter(file => !file.startsWith(`specs/${spec}/`))
  if (counted.length === 0) {
    return files.length === 0 ? 'none' : 'low'
  }
  // Instruction files are read into every later session, so text injected
  // there outlives the change: as risky as the harness's own files.
  if (counted.some(file => matchesAny(file, cfg.tiers.high) || matchesAny(file, cfg.protected) || matchesAny(file, BUILTIN_PROTECTED) || matchesAny(file, instructionGlobs(cfg)))) {
    return 'high'
  }
  const isAllLow = counted.every(
    file => matchesAny(file, cfg.tiers.low) && !matchesAny(file, cfg.tests),
  )

  return isAllLow && !hasTouchedTests ? 'low' : 'medium'
}

// ---------------------------------------------------------------- policy lint

/**
 * What makes a verify command report success it did not earn: a swallowed
 * exit code, a pipe that keeps only the last command's status, a test runner
 * told to pass with no tests, output cut by a filter. Reported, never fixed.
 */
export function lintCheck(run: string): string[] {
  const found: string[] = []
  if (/\|\|\s*(?:true|:)(?=$|[\s;)&|])/.test(run)) {
    found.push('`|| true` turns any failure into a pass')
  }
  if (/(?:;|\|\||&&)\s*exit\s+0\b/.test(run)) {
    found.push('`exit 0` makes it pass whatever ran before')
  }
  if (/--passWithNoTests\b/.test(run)) {
    found.push('`--passWithNoTests` passes when no test runs')
  }
  // What either reading finds is reported (BB1).
  for (const segments of readings(run)) {
    const isPiped = segments.some(one => one.place > 0 && !one.isNested)
    if (isPiped && segments.some(one => one.place > 0 && isFilter(one))) {
      found.push('its output goes through head, tail or grep, which can hide the failure and its exit code')
    } else if (isPiped && !/pipefail/.test(run)) {
      found.push('a pipe without `set -o pipefail` reports only the last command\'s exit code')
    }
  }

  return [...new Set(found)]
}

/** The lint of every verify command, each line naming its command. */
export const lintChecks = (steps: readonly Step[]): string[] =>
  steps.flatMap(one => lintCheck(one.run).map(problem => `\`${one.run}\`: ${problem}`))

// ---------------------------------------------------------------- environment

const KNOWN_CREDENTIALS = ['AWS_SECRET_ACCESS_KEY', 'AWS_SESSION_TOKEN', 'GH_TOKEN', 'GITHUB_TOKEN', 'NPM_TOKEN']

/**
 * Whether an environment variable's name says it holds a credential: it ends
 * in a credential word (`_TOKEN`, `_SECRET`, `_KEY`, `_PASSWORD`,
 * `_CREDENTIALS`) or is a well-known one. `MAX_THINKING_TOKENS` is not.
 */
export const isCredentialName = (name: string): boolean =>
  /_(?:TOKEN|SECRET|KEY|PASSWORD|CREDENTIALS)$/i.test(name) || KNOWN_CREDENTIALS.includes(name.toUpperCase())

// ---------------------------------------------------------------- verification

/** Whether a check applies to a change: it has no `when`, or a changed file matches one of its globs. */
const isApplying = (step: Step, changed: readonly string[]): boolean =>
  step.when === null || changed.some(file => matchesAny(file, step.when ?? []))

/**
 * The checks a profile runs on a change, in the order written: `full` runs
 * the fast checks too. A check with `when` runs only if a changed file
 * matches. Background checks are in neither profile (`backgroundFor`).
 */
export function stepsFor(steps: readonly Step[], profile: Profile, changed: readonly string[]): Step[] {
  return steps.filter(one => one.background !== true && (profile === 'full' || one.profile === 'fast') && isApplying(one, changed))
}

/** The background checks that apply to a change, in the order written: by `when`, as `stepsFor` decides. */
export const backgroundFor = (steps: readonly Step[], changed: readonly string[]): Step[] =>
  steps.filter(one => one.background === true && isApplying(one, changed))

/**
 * Whether a failing check deserves one rerun before it blocks: it passed on
 * an earlier tree, and nothing it watches changed since (the same content, or
 * no changed file matches its `when`). A check with no `when` watches every
 * file, so a change since its pass may well be the cause.
 *
 * @param since the files changed between the tree it passed on and now; null when unknown
 */
export function isFlakeSuspect(step: Step, hasPassedBefore: boolean, since: readonly string[] | null): boolean {
  if (!hasPassedBefore || since === null) {
    return false
  }

  return since.length === 0 || (step.when !== null && !since.some(file => matchesAny(file, step.when ?? [])))
}
