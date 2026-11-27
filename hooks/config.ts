// devloop.json read strictly: every field is checked by name, and a field that
// is missing or wrong takes its default (or the stricter choice), so a
// half-written file never switches a guard off. Pure: no `$`.

export type Profile = 'fast' | 'full'

/** One verify check: `fast` runs at every stop that changed the tree, `full` before shipping. */
export type Step = {
  run: string
  profile: Profile
  /** Globs: the check runs only when a changed file matches one; null runs it always. */
  when: string[] | null
  /**
   * A background check: in neither profile, it runs after the agent's stops
   * with no time limit, and only shipping waits for its pass. The key is
   * present only on a background check.
   */
  background?: true
}

/** A specialist reviewer: started beside the general one when a changed file matches `when`. */
export type Reviewer = {
  name: string
  when: string[]
  /** `blocking` adds a gate row; `shadow` never blocks and is only counted. */
  mode: 'blocking' | 'shadow'
  /** Its brief; null uses the built-in one (`security` has one) or the general brief. */
  prompt: string | null
  model: string | null
}

/** A shell pattern a person forbade, and why, which the model is told. */
export type Forbidden = { pattern: string; why: string }

export type Config = {
  /** Checks that must all exit 0 before work counts as done. */
  verify: Step[]
  verifyTimeoutSec: number
  /** How long a stop waits on its fast checks before it stops waiting (never longer than verifyTimeoutSec). */
  stopTimeoutSec: number
  /** Paths the agent never edits (harness, policy, acceptance files). */
  protected: string[]
  /** Test files: locked while building against an approved spec. */
  tests: string[]
  /** Files whose contents never enter the conversation. */
  secrets: string[]
  secretsAllow: string[]
  /** Files read into every session: editable, but a change to one is high risk. */
  instructions: string[]
  tiers: { high: string[]; low: string[] }
  forbidden: Forbidden[]
  /** Hosts shell commands may reach; null leaves the egress tripwire off. */
  network: { allow: string[] } | null
  /** `observe` records what the guards would refuse and refuses nothing. */
  mode: 'enforce' | 'observe'
  maxFixRounds: number
  maxReviewRounds: number
  autoReview: boolean
  /** A finished small fix (its checks passed at a stop) gets its first review without anyone asking. */
  reviewOnFinish: boolean
  budgetUsd: number | null
  instructionMaxLines: number
  defaultBranch: string
  /** A change past either limit, or touching a dependency manifest, is one tier riskier. */
  blastRadius: { maxFiles: number; maxLines: number; manifests: string[] }
  /** A small change (not high risk, within both limits) gets one fast critic: the general reviewer only, on `model`. */
  fastReview: { maxFiles: number; maxLines: number; model: string | null }
  /** How many people approve a merge, by tier. */
  approvals: { low: number; medium: number; high: number }
  reviewers: Reviewer[]
  /** Models for the harness's agents; null uses the session's. */
  models: { reviewer: string | null; specialist: string | null; eval: string | null; learner: string | null }
  /** The prompt cache: a turn writing more than `missTokens` is a miss; `ttlMinutes` is the cache's lifetime. */
  cache: { missTokens: number; ttlMinutes: number }
  /**
   * What devloop puts into the model's context: the injected budget per prompt, the two
   * context-pressure levels in tokens remaining (null: scaled to the window, see
   * `pressureLevels` in context.ts), how many tool calls a repeated note waits, and the
   * context size past which an idle gap is worth a warning.
   */
  context: { budgetTokens: number; warnRemaining: number | null; saveRemaining: number | null; debounceCalls: number; idleWarnTokens: number }
  /** Folders and files the sweep for ignored instruction files leaves out, beside the dependency and build folders (F12). */
  instructionsIgnore: string[]
  /** Bytes of launch-loaded instruction text before doctor reports it. */
  instructionMaxBytes: number
  /** The environment checks run with: `enforce` passes only `pass` and a minimal base; `observe` reports what they could see. */
  checkEnv: CheckEnv
  /** Declarative content rules, checked against the lines an edit tool adds (C2). */
  rules: ContentRule[]
  /** Trials per eval task: a task passes only if every trial passes. */
  evalTrials: number
  /** Where an eval task runs: a git worktree, or a fresh clone (catches dependence on untracked files). */
  evalIsolation: 'worktree' | 'clone'
  /** Tasks in the quick subset when none is tagged `quick`: the first N by a stable hash of the id. */
  evalQuick: number
  /** Full runs that a task must pass (or fail) every trial of to count as outside the useful band. */
  saturationRuns: number
  /** Days without a hit after which /devloop prune lists a rule as never fired. */
  pruneWindowDays: number
  /** Claims on a spec's features when more than one session works in a repository (D2): how long a claim lives unless its session's activity renews it. */
  claims: { leaseMinutes: number }
  /** Follow-ups after a pull request is created or updated (D2): whether the harness watches its checks and reviews through `gh`, how often, and for how long. */
  followUp: { ci: boolean; intervalSec: number; timeoutMin: number }
  /** The `.tasks` convention at the edges (D2): off by default; `observe` records what its rules would refuse. */
  tasks: { integrate: 'off' | 'observe' | 'enforce' }
  /**
   * Grounding (DESIGN 4.15): whether a turn that began with a person's
   * question of fact and ended with no look at any source is refused once
   * (`enforce`) or only reported (`observe`); null follows the policy's own
   * mode. `fresh`: `turn` counts only this turn's looks, `tree` also an
   * earlier turn's on the same tree. `also` adds prompt patterns, `never`
   * removes prompts (case-insensitive regular expressions).
   */
  grounding: { mode: 'off' | 'observe' | 'enforce' | null; fresh: 'turn' | 'tree'; also: string[]; never: string[] }
  /**
   * The loop limit (docs/design-notes/loop-limits.md, DESIGN 4.16): failed
   * rounds (a stop handed back for a failed check, a review round that
   * ended FAIL) on one branch before the harness hands nothing more back
   * and a person decides; 0 turns it off.
   */
  loop: { failedRounds: number }
  /**
   * Targeted testing (DESIGN 4.16): `targeted` keeps a pass of a check with
   * `when` globs against the content of the files they match, and runs a
   * failed check first; `full` runs every check on every tree, as before.
   */
  testing: { scope: 'targeted' | 'full' }
  /**
   * Learning without being asked (docs/design-notes/auto-learning.md, DESIGN
   * 4.17): `off` does nothing by itself; `propose` records lessons and starts
   * the proposer at `repeats` occurrences of a repeat group; `trial` also
   * puts proposed content rules on trial (they record hits, refuse nothing).
   * A trial rule at `promoteHits` hits is offered to a person; at most
   * `maxTrial` trial rules, `maxRuns` proposer runs per session.
   */
  learning: { auto: 'off' | 'propose' | 'trial'; repeats: number; promoteHits: number; maxTrial: number; maxRuns: number; at: 'turn' | 'close' }
  /**
   * The spec library (docs/design-notes/spec-library.md, DESIGN 4.18):
   * `auto` saves an approved spec to the person's library when its change
   * closes, and lets `/devloop library save` save it; `off` writes nothing
   * of this repository's specs there.
   */
  library: { save: 'auto' | 'off' }
}

/**
 * The built-in rules' names, which a content rule's id may not take (the
 * ledger, the hit counts and ablation name a rule by it). The same list as
 * rules.ts's RULES; a test keeps the two equal.
 */
export const BUILTIN_RULE_IDS: readonly string[] = [
  'secret', 'harness-state', 'reviewer-read-only', 'budget', 'eval-containment', 'evidence-notes', 'spec-locked', 'protected', 'tests-locked', 'spec-first', 'high-needs-spec',
  'test-weakened', 'destructive', 'production', 'forbidden', 'egress', 'no-verify', 'force-push', 'check-filtered', 'human-merge', 'gate', 'ship-alone', 'content-rule', 'tasks',
  'git-hidden', 'cache-guard',
]

/** A content rule: `pattern` on the lines an edit adds to a file matching `when`. */
export type ContentRule = { id: string; when: string[]; pattern: string; action: 'note' | 'refuse' | 'ratchet'; why: string }

export type CheckEnv = { pass: string[]; mode: 'off' | 'observe' | 'enforce' }

export const DEFAULTS: Config = {
  verify: [],
  verifyTimeoutSec: 300,
  stopTimeoutSec: 60,
  protected: [
    'devloop.json',
    'REVIEW.md',
    'CODEOWNERS',
    '.github/CODEOWNERS',
    '.claude/**',
    'specs/**/features.json',
    'evals/**',
  ],
  tests: [
    '**/*.test.*',
    '**/*.spec.*',
    '**/*_test.*',
    '**/test_*.py',
    'test/**',
    'tests/**',
    '**/__tests__/**',
  ],
  secrets: [
    '.env',
    '.env.*',
    '*.pem',
    '*.key',
    'id_rsa*',
    'id_ed25519*',
    '.npmrc',
    '.netrc',
    '**/.aws/credentials',
    '**/credentials*.json',
  ],
  secretsAllow: ['.env.example', '.env.sample', '.env.template'],
  instructions: ['AGENTS.md', 'CLAUDE.md', '.claude/rules/**', '.claude/skills/**'],
  tiers: {
    high: [
      '**/auth/**',
      '**/payments/**',
      '**/billing/**',
      '**/migrations/**',
      '.github/workflows/**',
      'Dockerfile',
      '**/*.tf',
    ],
    low: ['**/*.md', 'docs/**'],
  },
  forbidden: [],
  network: null,
  mode: 'enforce',
  maxFixRounds: 2,
  maxReviewRounds: 2,
  autoReview: true,
  reviewOnFinish: true,
  budgetUsd: null,
  instructionMaxLines: 200,
  defaultBranch: 'main',
  fastReview: { maxFiles: 3, maxLines: 60, model: 'sonnet' },
  blastRadius: {
    maxFiles: 25,
    maxLines: 600,
    manifests: ['package.json', '*.lock', 'package-lock.json', 'go.mod', 'go.sum', 'Cargo.toml', 'requirements*.txt', 'pyproject.toml', 'Gemfile', 'pom.xml', 'build.gradle'],
  },
  approvals: { low: 0, medium: 1, high: 2 },
  reviewers: [],
  models: { reviewer: null, specialist: null, eval: null, learner: null },
  cache: { missTokens: 20_000, ttlMinutes: 5 },
  context: { budgetTokens: 600, warnRemaining: null, saveRemaining: null, debounceCalls: 25, idleWarnTokens: 50_000 },
  instructionsIgnore: [],
  instructionMaxBytes: 32 * 1024,
  checkEnv: { pass: [], mode: 'observe' },
  rules: [],
  evalTrials: 1,
  evalIsolation: 'worktree',
  evalQuick: 5,
  saturationRuns: 3,
  pruneWindowDays: 30,
  claims: { leaseMinutes: 30 },
  followUp: { ci: true, intervalSec: 120, timeoutMin: 60 },
  tasks: { integrate: 'off' },
  grounding: { mode: null, fresh: 'turn', also: [], never: [] },
  loop: { failedRounds: 6 },
  testing: { scope: 'targeted' },
  // Learning runs by itself, but its proposer only once, when a change closes: never at the end of every turn.
  learning: { auto: 'trial', repeats: 3, promoteHits: 3, maxTrial: 20, maxRuns: 3, at: 'close' },
  library: { save: 'auto' },
}

/**
 * Files that hold what a session said or ran, kept outside any repository by
 * a tool the person installed: read and written by no tool call of the
 * builder's, whatever the policy's `secrets` say (they are not the policy's
 * to open). cache-guard (DESIGN 4.14) keeps, per its README, the handoffs
 * Claude wrote of past sessions in `handoffs/` and the full output of
 * trimmed Bash commands in `logs/` (which can hold anything a command
 * printed); its config, per-session figures (`state/`), usage readings and
 * totals hold no session content and are only write-protected
 * (`BUILTIN_PROTECTED`). Judged by the secrets rule, so every enforcement
 * point refuses them as it refuses a secret.
 */
export const BUILTIN_SECRETS: readonly string[] = [
  '**/.claude/cache-guard/handoffs',
  '**/.claude/cache-guard/handoffs/**',
  '**/.claude/cache-guard/logs',
  '**/.claude/cache-guard/logs/**',
]

/**
 * Paths no policy can open to the builder: the policy itself, the agent's and
 * the editor's settings, hook and plugin folders, git's hooks and config, and
 * shell start-up files. Each runs or decides something on the builder's
 * behalf, so editing one would rewrite the rules that judge it. Matched inside
 * the repository and outside it (a glob with no slash matches a name anywhere).
 */
export const BUILTIN_PROTECTED: readonly string[] = [
  'devloop.json',
  '**/.claude/settings*.json',
  '.claude.json',
  '.mcp.json',
  '**/.claude/hooks/**',
  '**/.claude/plugins/**',
  '.claude-plugin/**',
  '.husky/**',
  '.githooks/**',
  '**/.git/hooks/**',
  '**/.git/config',
  '**/.git/refs/notes/**',
  // cache-guard's folder (DESIGN 4.14): its config, state, saved handoffs, logs and its own copy of itself.
  '**/.claude/cache-guard/**',
  '.gitconfig',
  'checklists/**',
  '.bashrc',
  '.bash_profile',
  '.bash_login',
  '.profile',
  '.zshrc',
  '.zshenv',
  '.zprofile',
  '.zlogin',
  '.envrc',
]

/**
 * Fields a later version reads. They are accepted, so a file written for that
 * version is not an error here, and listed by /devloop doctor as unused.
 */
export const RESERVED = ['contextHandoffPercent'] as const

/**
 * Fields an earlier version read and this one does not. Accepted, so an older
 * file is not an error, and listed by /devloop doctor as unused. `handoffFile`
 * (C1) is gone: handoff entries live in the harness's state, never in the
 * working tree (phase C1 review, F1).
 */
export const RETIRED = ['handoffFile'] as const

/**
 * What a check sees in `checkEnv: { mode: "enforce" }` beside the names the
 * policy passes: enough to find programs, a home, a locale and a CI marker.
 */
export const CHECK_ENV_BASE: readonly string[] = ['PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'TERM', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TZ', 'TMPDIR', 'CI']

export type Parsed = {
  /** The whole config: a field in error holds its fallback. */
  cfg: Config
  /** The text was one JSON object, so field errors aside it can be kept as the last that parsed. */
  isParsed: boolean
  /** One line per problem, each naming its field. */
  errors: string[]
  /** Reserved fields the file sets, which this version ignores. */
  unused: string[]
}

type Raw = Record<string, unknown>

const isObject = (v: unknown): v is Raw => typeof v === 'object' && v !== null && !Array.isArray(v)

const isStrings = (v: unknown): v is string[] => Array.isArray(v) && v.every(one => typeof one === 'string')

/** Names the keys of an object that the schema does not know. */
const unknownKeys = (raw: Raw, known: readonly string[], at: string): string[] =>
  Object.keys(raw)
    .filter(key => !known.includes(key))
    .map(key => `${at}${key}: unknown field`)

/**
 * A whole number in range; anything else is reported and takes the fallback.
 * `overMax`, when given, is said after the error for a number above `max`.
 */
function whole(raw: Raw, key: string, fallback: number, max: number, errors: string[], overMax?: string): number {
  const v = raw[key]
  if (v === undefined) {
    return fallback
  }
  if (typeof v !== 'number' || !Number.isFinite(v) || v < 0 || v > max) {
    const why = overMax !== undefined && typeof v === 'number' && Number.isFinite(v) && v > max ? `. ${overMax}` : ''
    errors.push(`${key}: expected a number from 0 to ${max}; using ${fallback}${why}`)

    return fallback
  }

  return Math.floor(v)
}

function strings(raw: Raw, key: string, fallback: string[], errors: string[], at = ''): string[] {
  const v = raw[key]
  if (v === undefined) {
    return fallback
  }
  if (!isStrings(v)) {
    errors.push(`${at}${key}: expected a list of strings; using the default`)

    return fallback
  }

  return v
}

/**
 * One verify entry. An entry with a usable `run` is kept even when another of
 * its fields is wrong, with the stricter reading (runs at every stop, always),
 * since dropping it would quietly skip a check.
 */
function step(v: unknown, at: string, errors: string[]): Step | null {
  if (typeof v === 'string' && v.trim() !== '') {
    return { run: v, profile: 'fast', when: null }
  }
  if (!isObject(v) || typeof v.run !== 'string' || v.run.trim() === '') {
    errors.push(`${at}: expected a command, or { "run": "<command>", "profile"?, "when"? }; left out`)

    return null
  }
  errors.push(...unknownKeys(v, ['run', 'profile', 'when', 'background'], `${at}.`))
  let profile: Profile = 'fast'
  if (v.profile === 'full') {
    profile = 'full'
  } else if (v.profile !== undefined && v.profile !== 'fast') {
    errors.push(`${at}.profile: expected "fast" or "full"; using "fast"`)
  }
  let when: string[] | null = null
  if (isStrings(v.when) && v.when.length > 0) {
    when = v.when
  } else if (v.when !== undefined) {
    errors.push(`${at}.when: expected a non-empty list of globs; the check runs on every change`)
  }
  if (v.background === true) {
    return { run: v.run, profile, when, background: true }
  }
  if (v.background !== undefined && v.background !== false) {
    errors.push(`${at}.background: expected true or false; it runs in the foreground`)
  }

  return { run: v.run, profile, when }
}

function forbidden(v: unknown, errors: string[]): Forbidden[] {
  if (v === undefined) {
    return DEFAULTS.forbidden
  }
  if (!Array.isArray(v)) {
    errors.push('forbidden: expected a list of { "pattern", "why" }; none applied')

    return []
  }

  return v.flatMap((one: unknown, i): Forbidden[] => {
    const at = `forbidden[${i}]`
    if (!isObject(one) || typeof one.pattern !== 'string') {
      errors.push(`${at}: expected { "pattern": "<regular expression>", "why": "<reason>" }; left out`)

      return []
    }
    errors.push(...unknownKeys(one, ['pattern', 'why'], `${at}.`))
    try {
      new RegExp(one.pattern)
    } catch {
      errors.push(`${at}.pattern: not a valid regular expression; left out`)

      return []
    }

    return [{ pattern: one.pattern, why: typeof one.why === 'string' ? one.why : 'a person forbade it in devloop.json' }]
  })
}

/** An egress list in error allows no host: the person asked for the tripwire, so it stays on. */
function network(v: unknown, errors: string[]): Config['network'] {
  if (v === undefined || v === null) {
    return null
  }
  if (!isObject(v) || !isStrings(v.allow)) {
    errors.push('network.allow: expected a list of host names; no host is allowed until it is fixed')

    return { allow: [] }
  }
  errors.push(...unknownKeys(v, ['allow'], 'network.'))

  return { allow: v.allow.map(host => host.toLowerCase()) }
}

function blastRadius(v: unknown, errors: string[]): Config['blastRadius'] {
  const fallback = DEFAULTS.blastRadius
  if (v === undefined) {
    return fallback
  }
  if (!isObject(v)) {
    errors.push('blastRadius: expected { "maxFiles", "maxLines", "manifests" }; using the default')

    return fallback
  }
  errors.push(...unknownKeys(v, ['maxFiles', 'maxLines', 'manifests'], 'blastRadius.'))
  const sub: string[] = []
  const out = {
    maxFiles: whole(v, 'maxFiles', fallback.maxFiles, 100_000, sub),
    maxLines: whole(v, 'maxLines', fallback.maxLines, 10_000_000, sub),
    manifests: strings(v, 'manifests', fallback.manifests, sub),
  }
  errors.push(...sub.map(error => `blastRadius.${error}`))

  return out
}

/** The size under which a change gets one fast critic, and the model it runs on (null: the reviewer's own). */
function fastReview(v: unknown, errors: string[]): Config['fastReview'] {
  const fallback = DEFAULTS.fastReview
  if (v === undefined) {
    return fallback
  }
  if (!isObject(v)) {
    errors.push('fastReview: expected { "maxFiles", "maxLines", "model" }; using the default')

    return fallback
  }
  errors.push(...unknownKeys(v, ['maxFiles', 'maxLines', 'model'], 'fastReview.'))
  const sub: string[] = []
  const model = v.model === undefined ? fallback.model : v.model === null || (typeof v.model === 'string' && v.model.trim() !== '') ? (v.model as string | null) : (sub.push('model: expected a model name or null; using the default'), fallback.model)
  const out = {
    maxFiles: whole(v, 'maxFiles', fallback.maxFiles, 100_000, sub),
    maxLines: whole(v, 'maxLines', fallback.maxLines, 10_000_000, sub),
    model,
  }
  errors.push(...sub.map(error => `fastReview.${error}`))

  return out
}

/** People who approve a merge, by tier. A tier left out keeps its default; a wrong value keeps the default too, never fewer people. */
function approvals(v: unknown, errors: string[]): Config['approvals'] {
  const fallback = DEFAULTS.approvals
  if (v === undefined) {
    return fallback
  }
  if (!isObject(v)) {
    errors.push('approvals: expected { "low", "medium", "high" }, each a number of people; using the default')

    return fallback
  }
  errors.push(...unknownKeys(v, ['low', 'medium', 'high'], 'approvals.'))
  const sub: string[] = []
  const out = {
    low: whole(v, 'low', fallback.low, 10, sub),
    medium: whole(v, 'medium', fallback.medium, 10, sub),
    high: whole(v, 'high', fallback.high, 10, sub),
  }
  errors.push(...sub.map(error => `approvals.${error}`))

  return out
}

const isModel = (v: unknown): v is string => typeof v === 'string' && /^[\w.:@/[\]-]{1,100}$/.test(v)

/**
 * Specialist reviewers. One in error is still kept where its name and globs
 * are usable, as `blocking`: dropping it, or demoting it to shadow, would
 * quietly take a check off the gate.
 */
function reviewers(v: unknown, errors: string[]): Reviewer[] {
  if (v === undefined) {
    return []
  }
  if (!Array.isArray(v)) {
    errors.push('reviewers: expected a list of { "name", "when", "mode", "prompt"?, "model"? }; none started')

    return []
  }

  return v.flatMap((one: unknown, i): Reviewer[] => {
    const at = `reviewers[${i}]`
    if (!isObject(one) || typeof one.name !== 'string' || !/^[a-z0-9][a-z0-9-]{0,39}$/.test(one.name) || !isStrings(one.when) || one.when.length === 0) {
      errors.push(`${at}: expected { "name": "<lowercase-name>", "when": ["<glob>", ...], "mode": "blocking" | "shadow" }; left out`)

      return []
    }
    errors.push(...unknownKeys(one, ['name', 'when', 'mode', 'prompt', 'model'], `${at}.`))
    let mode: Reviewer['mode'] = 'blocking'
    if (one.mode === 'shadow') {
      mode = 'shadow'
    } else if (one.mode !== 'blocking') {
      errors.push(`${at}.mode: expected "blocking" or "shadow"; using "blocking"`)
    }
    if (one.prompt !== undefined && (typeof one.prompt !== 'string' || one.prompt.trim() === '')) {
      errors.push(`${at}.prompt: expected the reviewer's brief as text; using the built-in one`)
    }
    if (one.model !== undefined && !isModel(one.model)) {
      errors.push(`${at}.model: expected a model name; using the session's`)
    }

    return [{
      name: one.name,
      when: one.when,
      mode,
      prompt: typeof one.prompt === 'string' && one.prompt.trim() !== '' ? one.prompt : null,
      model: isModel(one.model) ? one.model : null,
    }]
  })
}

function models(v: unknown, errors: string[]): Config['models'] {
  if (v === undefined) {
    return DEFAULTS.models
  }
  if (!isObject(v)) {
    errors.push('models: expected { "reviewer"?, "specialist"?, "eval"?, "learner"? }; using the session\'s model')

    return DEFAULTS.models
  }
  errors.push(...unknownKeys(v, ['reviewer', 'specialist', 'eval', 'learner'], 'models.'))
  const pick = (key: string): string | null => {
    if (v[key] === undefined) {
      return null
    }
    if (!isModel(v[key])) {
      errors.push(`models.${key}: expected a model name; using the session's`)

      return null
    }

    return v[key] as string
  }

  return { reviewer: pick('reviewer'), specialist: pick('specialist'), eval: pick('eval'), learner: pick('learner') }
}

/** A nested object of whole numbers (or null where allowed), each checked by name; a wrong one keeps its default. */
function numbers<T extends Record<string, number | null>>(v: unknown, name: string, fallback: T, max: Record<keyof T, number>, nullable: readonly (keyof T)[], errors: string[]): T {
  if (v === undefined) {
    return fallback
  }
  if (!isObject(v)) {
    errors.push(`${name}: expected { ${Object.keys(fallback).map(key => `"${key}"`).join(', ')} }; using the default`)

    return fallback
  }
  errors.push(...unknownKeys(v, Object.keys(fallback), `${name}.`))
  const out: Record<string, number | null> = { ...fallback }
  const sub: string[] = []
  for (const key of Object.keys(fallback) as (keyof T & string)[]) {
    if (v[key] === null && nullable.includes(key)) {
      out[key] = null
    } else if (v[key] !== undefined) {
      const value = v[key]
      // A value in error keeps the default, a null one included.
      if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > max[key]) {
        sub.push(`${key}: expected a number from 0 to ${max[key]}; using ${fallback[key] ?? 'the default (scaled to the window)'}`)
      } else {
        out[key] = Math.floor(value)
      }
    }
  }
  errors.push(...sub.map(error => `${name}.${error}`))

  return out as T
}

/** checkEnv: a mode in error stays `observe` (never off); a pass list in error passes nothing more. */
function checkEnv(v: unknown, errors: string[]): CheckEnv {
  const fallback = DEFAULTS.checkEnv
  if (v === undefined) {
    return fallback
  }
  if (!isObject(v)) {
    errors.push('checkEnv: expected { "pass": [names], "mode": "off" | "observe" | "enforce" }; using the default')

    return fallback
  }
  errors.push(...unknownKeys(v, ['pass', 'mode'], 'checkEnv.'))
  let mode: CheckEnv['mode'] = fallback.mode
  if (v.mode === 'off' || v.mode === 'observe' || v.mode === 'enforce') {
    mode = v.mode
  } else if (v.mode !== undefined) {
    errors.push('checkEnv.mode: expected "off", "observe" or "enforce"; using "observe"')
  }
  let pass: string[] = []
  if (isStrings(v.pass) && v.pass.every(name => /^[A-Za-z_][A-Za-z0-9_]*$/.test(name))) {
    pass = v.pass
  } else if (v.pass !== undefined) {
    errors.push('checkEnv.pass: expected a list of variable names; none passed beyond the base')
  }

  return { pass, mode }
}

/**
 * Content rules (C2). One whose id, globs or pattern cannot be used is left
 * out (named); a wrong `action` takes the stricter `refuse`, since a rule a
 * person wrote should not quietly stop holding.
 */
export function contentRules(v: unknown, errors: string[]): ContentRule[] {
  if (v === undefined) {
    return []
  }
  if (!Array.isArray(v)) {
    errors.push('rules: expected a list of { "id", "when", "pattern", "action", "why" }; none applied')

    return []
  }
  const seen = new Set<string>()

  return v.flatMap((one: unknown, i): ContentRule[] => {
    const at = `rules[${i}]`
    if (!isObject(one) || typeof one.id !== 'string' || !/^[a-z0-9][a-z0-9-]{0,39}$/.test(one.id) || !isStrings(one.when) || one.when.length === 0 || typeof one.pattern !== 'string' || one.pattern === '') {
      errors.push(`${at}: expected { "id": "<lowercase-name>", "when": ["<glob>", ...], "pattern": "<regular expression>", "action": "note" | "refuse" | "ratchet", "why": "<reason>" }; left out`)

      return []
    }
    if (BUILTIN_RULE_IDS.includes(one.id)) {
      errors.push(`${at}.id: "${one.id}" is a built-in rule's name; left out`)

      return []
    }
    if (seen.has(one.id)) {
      errors.push(`${at}.id: "${one.id}" is used twice; the later one is left out`)

      return []
    }
    seen.add(one.id)
    errors.push(...unknownKeys(one, ['id', 'when', 'pattern', 'action', 'why'], `${at}.`))
    try {
      new RegExp(one.pattern)
    } catch {
      errors.push(`${at}.pattern: not a valid regular expression; left out`)

      return []
    }
    let action: ContentRule['action'] = 'refuse'
    if (one.action === 'note' || one.action === 'refuse' || one.action === 'ratchet') {
      action = one.action
    } else {
      errors.push(`${at}.action: expected "note", "refuse" or "ratchet"; using "refuse"`)
    }

    return [{ id: one.id, when: one.when, pattern: one.pattern, action, why: typeof one.why === 'string' ? one.why : 'a person wrote this rule in devloop.json' }]
  })
}

/** followUp: `ci` must be true or false (a wrong one keeps the default, on); the numbers keep theirs in error. */
function followUp(v: unknown, errors: string[]): Config['followUp'] {
  const fallback = DEFAULTS.followUp
  if (v === undefined) {
    return fallback
  }
  if (!isObject(v)) {
    errors.push('followUp: expected { "ci", "intervalSec", "timeoutMin" }; using the default')

    return fallback
  }
  errors.push(...unknownKeys(v, ['ci', 'intervalSec', 'timeoutMin'], 'followUp.'))
  let ci = fallback.ci
  if (typeof v.ci === 'boolean') {
    ci = v.ci
  } else if (v.ci !== undefined) {
    errors.push('followUp.ci: expected true or false; using true')
  }
  const sub: string[] = []
  const intervalSec = Math.max(30, whole(v, 'intervalSec', fallback.intervalSec, 3600, sub))
  const timeoutMin = Math.max(1, whole(v, 'timeoutMin', fallback.timeoutMin, 1440, sub))
  errors.push(...sub.map(error => `followUp.${error}`))

  return { ci, intervalSec, timeoutMin }
}

/** tasks.integrate: a value in error keeps the default, `off` (the integration is opt-in and young: nothing turns it on by mistake). */
function tasks(v: unknown, errors: string[]): Config['tasks'] {
  if (v === undefined) {
    return DEFAULTS.tasks
  }
  if (!isObject(v)) {
    errors.push('tasks: expected { "integrate": "off" | "observe" | "enforce" }; using "off"')

    return DEFAULTS.tasks
  }
  errors.push(...unknownKeys(v, ['integrate'], 'tasks.'))
  if (v.integrate === 'off' || v.integrate === 'observe' || v.integrate === 'enforce') {
    return { integrate: v.integrate }
  }
  if (v.integrate !== undefined) {
    errors.push('tasks.integrate: expected "off", "observe" or "enforce"; using "off"')
  }

  return DEFAULTS.tasks
}

/**
 * grounding: `mode` off, observe or enforce (left out, the policy's own
 * mode); `fresh` turn or tree; `also` and `never` lists of regular
 * expressions. A value in error keeps its default; a pattern that does not
 * compile is left out.
 */
function grounding(v: unknown, errors: string[]): Config['grounding'] {
  const fallback = DEFAULTS.grounding
  if (v === undefined) {
    return fallback
  }
  if (!isObject(v)) {
    errors.push('grounding: expected { "mode", "fresh", "also", "never" }; using the default')

    return fallback
  }
  errors.push(...unknownKeys(v, ['mode', 'fresh', 'also', 'never'], 'grounding.'))
  let mode = fallback.mode
  if (v.mode === 'off' || v.mode === 'observe' || v.mode === 'enforce') {
    mode = v.mode
  } else if (v.mode !== undefined) {
    errors.push('grounding.mode: expected "off", "observe" or "enforce"; following the policy\'s mode')
  }
  let fresh = fallback.fresh
  if (v.fresh === 'turn' || v.fresh === 'tree') {
    fresh = v.fresh
  } else if (v.fresh !== undefined) {
    errors.push('grounding.fresh: expected "turn" or "tree"; using "turn"')
  }
  const patterns = (key: 'also' | 'never'): string[] => {
    const raw = v[key]
    if (raw === undefined) {
      return []
    }
    if (!Array.isArray(raw)) {
      errors.push(`grounding.${key}: expected a list of patterns; using none`)

      return []
    }

    return raw.flatMap((one: unknown, i) => {
      if (typeof one !== 'string' || one === '') {
        errors.push(`grounding.${key}[${i}]: expected a pattern; left out`)

        return []
      }
      try {
        new RegExp(one, 'i')
      } catch {
        errors.push(`grounding.${key}[${i}]: not a valid regular expression; left out`)

        return []
      }

      return [one]
    })
  }

  return { mode, fresh, also: patterns('also'), never: patterns('never') }
}

/** loop: `failedRounds` a whole number up to 100 (0 turns the limit off); a value in error keeps the default, 6. */
function loopLimit(v: unknown, errors: string[]): Config['loop'] {
  if (v === undefined) {
    return DEFAULTS.loop
  }
  if (!isObject(v)) {
    errors.push(`loop: expected { "failedRounds": <a number from 0 to 100> }; using ${DEFAULTS.loop.failedRounds}`)

    return DEFAULTS.loop
  }
  errors.push(...unknownKeys(v, ['failedRounds'], 'loop.'))
  const sub: string[] = []
  const failedRounds = whole(v, 'failedRounds', DEFAULTS.loop.failedRounds, 100, sub)
  errors.push(...sub.map(error => `loop.${error}`))

  return { failedRounds }
}

/** testing.scope: `targeted` or `full`; a value in error takes `full`, the stricter (every check on every tree). */
function testing(v: unknown, errors: string[]): Config['testing'] {
  if (v === undefined) {
    return DEFAULTS.testing
  }
  if (!isObject(v)) {
    errors.push('testing: expected { "scope": "targeted" | "full" }; using "full"')

    return { scope: 'full' }
  }
  errors.push(...unknownKeys(v, ['scope'], 'testing.'))
  if (v.scope === 'targeted' || v.scope === 'full') {
    return { scope: v.scope }
  }
  if (v.scope !== undefined) {
    errors.push('testing.scope: expected "targeted" or "full"; using "full"')

    return { scope: 'full' }
  }

  return DEFAULTS.testing
}

/**
 * learning (DESIGN 4.17): `auto` `off`, `propose` or `trial` (a value in
 * error takes `off`: nothing happens by itself); `repeats` and `promoteHits`
 * whole numbers from 1 to 100, `maxTrial` and `maxRuns` from 0 to 100; a
 * number in error keeps its default.
 */
function learning(v: unknown, errors: string[]): Config['learning'] {
  const fallback = DEFAULTS.learning
  if (v === undefined) {
    return fallback
  }
  if (!isObject(v)) {
    errors.push('learning: expected { "auto", "repeats", "promoteHits", "maxTrial", "maxRuns" }; using "off"')

    return { ...fallback, auto: 'off' }
  }
  errors.push(...unknownKeys(v, ['auto', 'repeats', 'promoteHits', 'maxTrial', 'maxRuns', 'at'], 'learning.'))
  let auto = fallback.auto
  if (v.auto === 'off' || v.auto === 'propose' || v.auto === 'trial') {
    auto = v.auto
  } else if (v.auto !== undefined) {
    errors.push('learning.auto: expected "off", "propose" or "trial"; using "off"')
    auto = 'off'
  }
  const sub: string[] = []
  const atLeastOne = (key: 'repeats' | 'promoteHits'): number => {
    const n = whole(v, key, fallback[key], 100, sub)
    if (n >= 1) {
      return n
    }
    sub.push(`${key}: expected a number from 1 to 100; using ${fallback[key]}`)

    return fallback[key]
  }
  const repeats = atLeastOne('repeats')
  const promoteHits = atLeastOne('promoteHits')
  const maxTrial = whole(v, 'maxTrial', fallback.maxTrial, 100, sub)
  const maxRuns = whole(v, 'maxRuns', fallback.maxRuns, 100, sub)
  errors.push(...sub.map(error => `learning.${error}`))

  const at = v.at === 'turn' || v.at === 'close' ? v.at : fallback.at
  if (v.at !== undefined && v.at !== 'turn' && v.at !== 'close') {
    errors.push('learning.at: expected "turn" or "close"; using "close"')
  }

  return { auto, repeats, promoteHits, maxTrial, maxRuns, at }
}

/**
 * library (DESIGN 4.18): `save` `auto` or `off`. A value in error takes
 * `off`, the reading that keeps a repository's specs in it.
 */
function library(v: unknown, errors: string[]): Config['library'] {
  if (v === undefined) {
    return DEFAULTS.library
  }
  if (!isObject(v)) {
    errors.push('library: expected { "save": "auto" | "off" }; using "off"')

    return { save: 'off' }
  }
  errors.push(...unknownKeys(v, ['save'], 'library.'))
  if (v.save === 'auto' || v.save === 'off' || v.save === undefined) {
    return { save: v.save ?? DEFAULTS.library.save }
  }
  errors.push('library.save: expected "auto" or "off"; using "off"')

  return { save: 'off' }
}

const KNOWN = [
  ...(Object.keys(DEFAULTS) as (keyof Config)[]),
  ...RESERVED,
  ...RETIRED,
  '$schema',
]

/** Reads `devloop.json`'s text into a whole config and the problems found, each by field. */
export function parseConfig(text: string): Parsed {
  let raw: Raw
  try {
    const parsed: unknown = JSON.parse(text)
    if (!isObject(parsed)) {
      return { cfg: DEFAULTS, isParsed: false, errors: ['devloop.json must hold one JSON object; every field takes its default'], unused: [] }
    }
    raw = parsed
  } catch (error) {
    const why = error instanceof Error ? `: ${error.message}` : ''

    return { cfg: DEFAULTS, isParsed: false, errors: [`devloop.json is not valid JSON${why}; every field takes its default`], unused: [] }
  }
  const errors = unknownKeys(raw, KNOWN, '')

  let verify = DEFAULTS.verify
  if (Array.isArray(raw.verify)) {
    verify = raw.verify.flatMap((one: unknown, i) => step(one, `verify[${i}]`, errors) ?? [])
  } else if (typeof raw.verify === 'string' || isObject(raw.verify)) {
    // One check written without the list around it is still that check.
    verify = [step(raw.verify, 'verify', errors)].flatMap(one => one ?? [])
  } else if (raw.verify !== undefined) {
    errors.push('verify: expected a command or a list of commands; nothing is verified until it is fixed')
  }

  let tiers = DEFAULTS.tiers
  if (isObject(raw.tiers)) {
    errors.push(...unknownKeys(raw.tiers, ['high', 'low'], 'tiers.'))
    tiers = {
      high: strings(raw.tiers, 'high', DEFAULTS.tiers.high, errors, 'tiers.'),
      low: strings(raw.tiers, 'low', DEFAULTS.tiers.low, errors, 'tiers.'),
    }
  } else if (raw.tiers !== undefined) {
    errors.push('tiers: expected { "high": [...], "low": [...] }; using the default')
  }

  let mode = DEFAULTS.mode
  if (raw.mode === 'observe' || raw.mode === 'enforce') {
    mode = raw.mode
  } else if (raw.mode !== undefined) {
    errors.push(`mode: expected "observe" or "enforce"; using "${DEFAULTS.mode}"`)
  }

  let budgetUsd = DEFAULTS.budgetUsd
  if (typeof raw.budgetUsd === 'number' && Number.isFinite(raw.budgetUsd) && raw.budgetUsd > 0) {
    budgetUsd = raw.budgetUsd
  } else if (raw.budgetUsd !== undefined && raw.budgetUsd !== null) {
    errors.push('budgetUsd: expected a number of US dollars above 0, or null; no cap')
  }

  let autoReview = DEFAULTS.autoReview
  if (typeof raw.autoReview === 'boolean') {
    autoReview = raw.autoReview
  } else if (raw.autoReview !== undefined) {
    errors.push('autoReview: expected true or false; using true')
  }

  let defaultBranch = DEFAULTS.defaultBranch
  if (typeof raw.defaultBranch === 'string' && raw.defaultBranch.trim() !== '') {
    defaultBranch = raw.defaultBranch.trim()
  } else if (raw.defaultBranch !== undefined) {
    errors.push(`defaultBranch: expected a branch name; using "${DEFAULTS.defaultBranch}"`)
  }

  let evalIsolation = DEFAULTS.evalIsolation
  if (raw.evalIsolation === 'worktree' || raw.evalIsolation === 'clone') {
    evalIsolation = raw.evalIsolation
  } else if (raw.evalIsolation !== undefined) {
    errors.push('evalIsolation: expected "worktree" or "clone"; using "worktree"')
  }

  const cfg: Config = {
    verify,
    verifyTimeoutSec: whole(raw, 'verifyTimeoutSec', DEFAULTS.verifyTimeoutSec, 600, errors, 'Mark long checks "background": true in verify: they run with no time limit, and only shipping waits for them'),
    stopTimeoutSec: whole(raw, 'stopTimeoutSec', DEFAULTS.stopTimeoutSec, 600, errors),
    protected: strings(raw, 'protected', DEFAULTS.protected, errors),
    tests: strings(raw, 'tests', DEFAULTS.tests, errors),
    secrets: strings(raw, 'secrets', DEFAULTS.secrets, errors),
    secretsAllow: strings(raw, 'secretsAllow', DEFAULTS.secretsAllow, errors),
    instructions: strings(raw, 'instructions', DEFAULTS.instructions, errors),
    tiers,
    forbidden: forbidden(raw.forbidden, errors),
    network: network(raw.network, errors),
    mode,
    maxFixRounds: whole(raw, 'maxFixRounds', DEFAULTS.maxFixRounds, 10, errors),
    maxReviewRounds: whole(raw, 'maxReviewRounds', DEFAULTS.maxReviewRounds, 10, errors),
    autoReview,
    reviewOnFinish: typeof raw.reviewOnFinish === 'boolean' ? raw.reviewOnFinish : (raw.reviewOnFinish !== undefined && errors.push('reviewOnFinish: expected true or false; using true'), DEFAULTS.reviewOnFinish),
    budgetUsd,
    instructionMaxLines: whole(raw, 'instructionMaxLines', DEFAULTS.instructionMaxLines, 10_000, errors),
    defaultBranch,
    blastRadius: blastRadius(raw.blastRadius, errors),
    fastReview: fastReview(raw.fastReview, errors),
    approvals: approvals(raw.approvals, errors),
    reviewers: reviewers(raw.reviewers, errors),
    models: models(raw.models, errors),
    cache: numbers(raw.cache, 'cache', DEFAULTS.cache, { missTokens: 10_000_000, ttlMinutes: 1440 }, [], errors),
    context: numbers(raw.context, 'context', DEFAULTS.context, { budgetTokens: 100_000, warnRemaining: 100_000_000, saveRemaining: 100_000_000, debounceCalls: 10_000, idleWarnTokens: 100_000_000 }, ['warnRemaining', 'saveRemaining'], errors),
    instructionsIgnore: strings(raw, 'instructionsIgnore', DEFAULTS.instructionsIgnore, errors),
    instructionMaxBytes: whole(raw, 'instructionMaxBytes', DEFAULTS.instructionMaxBytes, 100_000_000, errors),
    checkEnv: checkEnv(raw.checkEnv, errors),
    rules: contentRules(raw.rules, errors),
    evalTrials: Math.max(1, whole(raw, 'evalTrials', DEFAULTS.evalTrials, 10, errors)),
    evalIsolation,
    evalQuick: Math.max(1, whole(raw, 'evalQuick', DEFAULTS.evalQuick, 1000, errors)),
    saturationRuns: Math.max(2, whole(raw, 'saturationRuns', DEFAULTS.saturationRuns, 50, errors)),
    pruneWindowDays: whole(raw, 'pruneWindowDays', DEFAULTS.pruneWindowDays, 3650, errors),
    claims: { leaseMinutes: Math.max(1, numbers(raw.claims, 'claims', DEFAULTS.claims, { leaseMinutes: 1440 }, [], errors).leaseMinutes) },
    followUp: followUp(raw.followUp, errors),
    tasks: tasks(raw.tasks, errors),
    grounding: grounding(raw.grounding, errors),
    loop: loopLimit(raw.loop, errors),
    testing: testing(raw.testing, errors),
    learning: learning(raw.learning, errors),
    library: library(raw.library, errors),
  }

  return { cfg, isParsed: true, errors, unused: [...RESERVED, ...RETIRED].filter(key => key in raw) }
}
