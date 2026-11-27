// cache-guard (DESIGN 4.14): the repository owner's own prompt-cache tool,
// vendored unchanged in cache-guard/ and run through person-only commands.
// The pure parts: whether it is installed (from its config file and the
// status line in the user's settings), its install flags and what each does
// (from its README), the arguments `report` takes, what its output looks like
// once cleaned for the person, and a saved handoff's header. Pure: no `$`.

/** Where cache-guard keeps everything, under the home folder (its `GUARD_DIR`). */
export const GUARD_DIR = '.claude/cache-guard'

/** The vendored script, under the plugin's root. */
export const SCRIPT = 'cache-guard/cache_guard.py'

/** The oldest Python it runs on. */
export const PYTHON_MIN: readonly [number, number] = [3, 8]

/** Prints Python's version as `major.minor.micro`. */
export const PYTHON_VERSION = "import sys; print('%d.%d.%d' % sys.version_info[:3])"

/** Each install flag, with one line on what it does, taken from cache-guard's README. */
export const INSTALL_FLAGS: Readonly<Record<string, string>> = {
  '--trim': 'trims huge Bash output (test and build logs) before Claude reads it; the full log is saved under ~/.claude/cache-guard/logs/',
  '--notify': 'a desktop alert when a warm cache is about to expire',
  '--keepwarm': 'keeps a long session\'s cache warm while you are away, by waking Claude for a one-word reply just before it expires',
  '--handoff': 'saves a handoff before a long session\'s cache dies, and adds the /handoff-save and /handoff-load commands',
  '--lean': 'makes the bundled Lean output style your default',
  '--all': '--notify and --lean; it never turns on the trimmer (only --trim does)',
  '--no-trim': 'turns the Bash trimmer back off',
  '--no-notify': 'turns expiry notifications back off',
  '--no-keepwarm': 'turns keep-warm back off',
  '--no-handoff': 'turns the handoff back off',
}

/** The flags given, or the first one cache-guard does not know (refused before any dialog). */
export function installFlags(words: readonly string[]): { flags: string[] } | { unknown: string } {
  const flags: string[] = []
  for (const word of words.filter(one => one !== '')) {
    if (INSTALL_FLAGS[word] === undefined) {
      return { unknown: word }
    }
    if (!flags.includes(word)) {
      flags.push(word)
    }
  }

  return { flags }
}

/** What `/devloop cache install` asks the person before running cache-guard's installer: exactly what it changes, and each flag given. */
export function installQuestion(flags: readonly string[]): string {
  return [
    'Install cache-guard (the repository owner\'s prompt-cache tool, bundled in this plugin) for your user? Its own installer runs and will:',
    '- copy itself to ~/.claude/cache-guard/ (with its config.json there),',
    '- back up ~/.claude/settings.json, then edit it,',
    '- replace your status line with cache-guard\'s (the old one stays in the backup),',
    '- add its hooks to your user settings (model switch, cold /compact, cold message, session start, subagent cost' +
      `${flags.includes('--trim') ? ', the Bash trimmer' : ''}${flags.includes('--keepwarm') || flags.includes('--handoff') ? ', a background Stop hook' : ''}).`,
    flags.length === 0 ? 'No opt-in flags: keep-warm, the trimmer, the handoff, notifications and the Lean default stay off.' : 'With these flags:',
    ...flags.map(flag => `- ${flag}: ${INSTALL_FLAGS[flag] ?? ''}`),
    'Restart Claude Code afterwards. /devloop cache uninstall takes it out of your settings again.',
  ].join('\n')
}

/** What `/devloop cache uninstall` asks. */
export const UNINSTALL_QUESTION = 'Uninstall cache-guard from your user settings? Its uninstaller backs up ~/.claude/settings.json, removes its status line and hooks (and the Lean default if it set it), and turns keep-warm and the handoff off for sessions still running. A status line you had before installing it is not put back: it stays in the backups (~/.claude/settings.json.bak-*). Its files in ~/.claude/cache-guard/ stay; delete them yourself if you want them gone.'

/**
 * A session id `report` takes (the cache-guard round, R13): letters, digits
 * and hyphens only, 8 to 64 of them, so it can never name a file or a folder
 * in cache-guard's folder (`config`, `..`, a path).
 */
export const SESSION_ID = /^[A-Za-z0-9-]{8,64}$/

/** The arguments `report` passes through: `--all`, `--days N` (once) and one session id; anything else is refused. */
export function reportArgs(words: readonly string[]): { args: string[] } | { refused: string } {
  const args: string[] = []
  let session = false
  let days = false
  for (let i = 0; i < words.length; i += 1) {
    const word = words[i] ?? ''
    if (word === '') {
      continue
    }
    if (word === '--all') {
      args.push(word)
    } else if (word === '--days') {
      if (days) {
        return { refused: '--days is given once' }
      }
      days = true
      const n = words[i + 1] ?? ''
      if (!/^\d{1,4}(\.\d{1,2})?$/.test(n) || Number(n) <= 0) {
        return { refused: '--days needs a number of days, for example --days 7' }
      }
      args.push(word, n)
      i += 1
    } else if (!session && SESSION_ID.test(word)) {
      args.push(word)
      session = true
    } else {
      return { refused: `report takes --all, --days N and a session id, not ${word.slice(0, 60)}` }
    }
  }

  return { args }
}

/** Whether a Python version (`3.11.4`) is one cache-guard runs on. */
export function isPythonOk(said: string): boolean {
  const match = /^(\d+)\.(\d+)/.exec(said.trim())
  if (match === null) {
    return false
  }
  const [major, minor] = [Number(match[1]), Number(match[2])]

  return major > PYTHON_MIN[0] || (major === PYTHON_MIN[0] && minor >= PYTHON_MIN[1])
}

/** The most of the script's output a command shows. */
export const OUTPUT_CAP = 12_000

/** The script's output for the person: terminal colour and control codes taken out, cut with a pointer to a terminal when it is very long. */
export function cleanOutput(text: string, command: string): string {
  const plain = text
    .replace(/\u001b\][^\u0007\u001b]*(\u0007|\u001b\\)/g, '')
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/\u001b[@-Z\\-_]/g, '')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
    .trimEnd()
  if (plain.length <= OUTPUT_CAP) {
    return plain
  }
  const cut = plain.lastIndexOf('\n', OUTPUT_CAP)

  return `${plain.slice(0, cut > 0 ? cut : OUTPUT_CAP)}\n… (cut at ${OUTPUT_CAP} characters: run \`${command}\` in a terminal for all of it)`
}

/** Whether cache-guard is installed for the user, from the two facts devloop reads. */
export type GuardState = 'installed' | 'not-installed' | 'half-installed'

export type GuardFacts = {
  /** ~/.claude/cache-guard/config.json, or null when it is not there. */
  configText: string | null
  /** ~/.claude/settings.json, or null when it is not there. */
  settingsText: string | null
}

export type Guard = {
  state: GuardState
  /** The status line in the user's settings is cache-guard's. */
  hasStatusLine: boolean
  /** Its config file is there and parses. */
  hasConfig: boolean
  /** The opt-ins that are on: from its config (`notify`, `keepwarm`, `handoff`) and its settings (the trimmer, the Lean default). */
  optIns: string[]
  /** Its session budget in US dollars at list price, when set (`session_budget_usd` over 0). */
  budgetUsd: number | null
}

const objectOf = (text: string | null): Record<string, unknown> | null => {
  if (text === null) {
    return null
  }
  try {
    const value = JSON.parse(text) as unknown

    return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null
  } catch {
    return null
  }
}

const isOn = (value: unknown): boolean => value === true || ['true', '1', 'on', 'yes'].includes(String(value).trim().toLowerCase())

/**
 * Whether cache-guard is installed, decided from its config file and the
 * status line in the user's settings, read-only: both there is installed,
 * neither is not, one alone is half-installed (an uninstall leaves the
 * config; a status line copied by hand has none). Only `installed` makes
 * devloop step back where both would speak.
 */
export function guardOf(facts: GuardFacts): Guard {
  const config = objectOf(facts.configText)
  const settings = objectOf(facts.settingsText)
  const statusLine = settings?.statusLine as { command?: unknown } | undefined
  const hasStatusLine = typeof statusLine?.command === 'string' && /cache_guard\.py/.test(statusLine.command) && /\bstatusline\b/.test(statusLine.command)
  const hasConfig = config !== null
  const hooks = (settings?.hooks ?? {}) as Record<string, { hooks?: { command?: unknown }[] }[] | undefined>
  const commands = Object.values(hooks).flatMap(groups => (Array.isArray(groups) ? groups : []).flatMap(group => (Array.isArray(group.hooks) ? group.hooks : []).map(one => String(one.command ?? ''))))
  const optIns = [
    ...(config !== null && isOn(config.notify) ? ['notify'] : []),
    ...(config !== null && isOn(config.keepwarm) ? ['keepwarm'] : []),
    ...(config !== null && isOn(config.handoff) ? ['handoff'] : []),
    ...(commands.some(one => /cache_guard\.py.*hook-trim/.test(one)) ? ['trim'] : []),
    ...(settings?.outputStyle === 'Lean' ? ['lean'] : []),
  ]
  const budget = Number(config?.session_budget_usd ?? 0)

  return {
    state: hasStatusLine && hasConfig ? 'installed' : hasStatusLine || hasConfig ? 'half-installed' : 'not-installed',
    hasStatusLine,
    hasConfig,
    optIns,
    budgetUsd: Number.isFinite(budget) && budget > 0 ? budget : null,
  }
}

/** A saved handoff's header (`<!-- cache-guard handoff {…} -->`, its first line): the folder it was written in, or null when it is not one. */
export function handoffFolder(firstLine: string): string | null {
  const match = /^<!-- cache-guard handoff (\{.*\}) -->$/.exec(firstLine.trim())
  if (match === null) {
    return null
  }
  const meta = objectOf(match[1] ?? '')

  return typeof meta?.cwd === 'string' ? meta.cwd.replace(/\/+$/, '') : null
}
