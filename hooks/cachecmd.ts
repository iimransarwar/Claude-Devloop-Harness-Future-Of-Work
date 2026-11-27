// `/devloop cache …` (DESIGN 4.14): the vendored cache-guard, run with the
// session's Python from the plugin's folder. install and uninstall change the
// person's own settings, so they are a person's, with a dialog and an audit
// event; doctor, report and status only read, but what they read is the
// person's whole session history, so they are a person's too (principle 3:
// nothing the building agent runs). Also here: whether cache-guard is
// installed, read-only, for the places where devloop steps back so that one
// tool speaks per subject, and doctor's short section.

import type { CommandRunInput, CommandRunResult } from 'claude-code'
import { GUARD_DIR, INSTALL_FLAGS, PYTHON_VERSION, SCRIPT, UNINSTALL_QUESTION, cleanOutput, guardOf, handoffFolder, installFlags, installQuestion, isPythonOk, reportArgs } from './cacheguard'
import type { Guard } from './cacheguard'
import { actorOf, audit, confirm, isFromPerson } from './journal'
import { loopOf } from './state'
import type { Engine, Place } from './state'

/** The person's home folder, as the engine's environment names it; null when it does not. */
async function homeOf($: Engine): Promise<string | null> {
  const home = (await $.env.get('HOME').catch(() => undefined)) ?? ''

  return home === '' ? null : home.replace(/\/+$/, '')
}

/** A file's text, or null when it is not there or cannot be read. */
async function textAt($: Engine, path: string): Promise<string | null> {
  if (!(await $.fs.exists(path).catch(() => false))) {
    return null
  }

  return $.fs.read(path).catch(() => null)
}

/** Whether cache-guard is installed for this person, read from its config file and the status line in their settings (never written). */
export async function guardNow($: Engine): Promise<Guard> {
  const home = await homeOf($)
  if (home === null) {
    return guardOf({ configText: null, settingsText: null })
  }

  return guardOf({ configText: await textAt($, `${home}/${GUARD_DIR}/config.json`), settingsText: await textAt($, `${home}/.claude/settings.json`) })
}

/** Whether cache-guard saved a handoff for this folder (`~/.claude/cache-guard/handoffs/*.md`, its header's folder): only its first line is read. */
export async function handoffFor($: Engine, root: string): Promise<boolean> {
  const home = await homeOf($)
  if (home === null) {
    return false
  }
  const dir = `${home}/${GUARD_DIR}/handoffs`
  const listed = await $.fs.list(dir).catch(() => [])
  for (const one of listed.filter(each => each.kind === 'file' && each.name.endsWith('.md')).slice(0, 60)) {
    const text = await $.fs.read(`${dir}/${one.name}`).catch(() => '')
    if (handoffFolder(text.slice(0, 4000).split('\n')[0] ?? '') === root.replace(/\/+$/, '')) {
      return true
    }
  }

  return false
}

/** The Python cache-guard would run on: its version, or why there is none. */
async function pythonOf($: Engine): Promise<{ isOk: boolean; said: string }> {
  const ran = await $.process.run(['python3', '-c', PYTHON_VERSION], { timeoutMs: 10_000 }).catch(() => null)
  if (ran === null || ran.exitCode !== 0) {
    return { isOk: false, said: 'no python3 was found' }
  }
  const said = ran.stdout.trim()

  return { isOk: isPythonOk(said), said: `Python ${said}` }
}

const NO_PYTHON = (said: string): string => `cache-guard needs Python 3.8 or later, and ${said === 'no python3 was found' ? 'none was found (python3 is not on the PATH)' : `this session's is ${said}`}. Install Python 3.8+ to use it; every devloop feature works without it.`

/** Runs the vendored script with the session's Python, in the repository's folder (report and handoffs go by folder). */
async function runScript($: Engine, at: Place, args: readonly string[], timeoutMs: number): Promise<{ code: number; text: string } | null> {
  const script = `${$.plugin.root.replace(/\/+$/, '')}/${SCRIPT}`
  const ran = await $.process.run(['python3', script, ...args], { cwd: at.root, timeoutMs }).catch(() => null)

  return ran === null ? null : { code: ran.exitCode, text: `${ran.stdout}${ran.stderr === '' ? '' : `\n${ran.stderr}`}` }
}

const USAGE = 'Usage: /devloop cache install [--trim --notify --keepwarm --handoff --lean --all, and the --no- forms] | uninstall | doctor | report [--all] [--days N] [session id] | status. cache-guard is optional and needs Python 3.8+; its README is cache-guard/README.md in the plugin.'

/** `/devloop cache <install|uninstall|doctor|report|status>`. */
export async function cacheCommand($: Engine, at: Place, words: readonly string[], e: CommandRunInput): Promise<CommandRunResult> {
  const [sub = '', ...rest] = words
  if (!['install', 'uninstall', 'doctor', 'report', 'status'].includes(sub)) {
    return { text: USAGE }
  }
  if (!isFromPerson(e)) {
    return { text: sub === 'install' || sub === 'uninstall'
      ? 'cache-guard is installed or uninstalled by a person, from the prompt: it changes your own settings.'
      : 'The cache-guard commands are a person\'s, from the prompt: they read your whole session history.' }
  }
  const command = `python3 <plugin>/${SCRIPT} ${sub === 'status' ? '--version' : [sub, ...rest].join(' ')}`.trim()
  let args: string[] = []
  if (sub === 'install') {
    const given = installFlags(rest)
    if ('unknown' in given) {
      return { text: `Not installed: cache-guard's installer has no flag ${given.unknown.slice(0, 40)}. It takes ${Object.keys(INSTALL_FLAGS).join(', ')}.` }
    }
    args = ['install', ...given.flags]
  } else if (sub === 'report') {
    const given = reportArgs(rest)
    if ('refused' in given) {
      return { text: `Not run: ${given.refused}.` }
    }
    args = ['report', ...given.args]
  } else if (rest.length > 0) {
    return { text: `/devloop cache ${sub} takes no arguments.` }
  } else {
    args = sub === 'status' ? ['--version'] : [sub]
  }
  const python = await pythonOf($)
  if (!python.isOk) {
    return { text: NO_PYTHON(python.said) }
  }
  if (sub === 'install' || sub === 'uninstall') {
    const question = sub === 'install' ? installQuestion(args.slice(1)) : UNINSTALL_QUESTION
    if (!(await confirm($, question, sub === 'install' ? 'Install it' : 'Uninstall it', 'Leave it'))) {
      return { text: 'Nothing was changed.' }
    }
    const ran = await runScript($, at, args, 120_000)
    const said = ran === null ? 'cache-guard could not be started.' : cleanOutput(ran.text, command)
    if (ran !== null && ran.code === 0) {
      await audit($, at.root, sub === 'install' ? 'cache-guard-installed' : 'cache-guard-removed', actorOf(e), args.slice(1).join(' ') || '(no flags)', (await loopOf($)).tree, said.split('\n')[0]?.slice(0, 200) ?? '')
    }

    return { text: ran !== null && ran.code === 0 ? said : `cache-guard's ${sub} did not finish (exit ${ran?.code ?? 'none'}):\n${said}` }
  }
  if (sub === 'status') {
    const guard = await guardNow($)
    const ran = await runScript($, at, args, 15_000)

    return { text: [`cache-guard ${cleanOutput(ran?.text ?? '', command).trim() || '(version unknown)'} is bundled with devloop; ${python.said}.`, ...statusLines(guard)].join('\n') }
  }
  const ran = await runScript($, at, args, sub === 'report' ? 300_000 : 60_000)
  if (ran === null) {
    return { text: `cache-guard's ${sub} could not be run (it did not finish in time, or could not start): run \`${command}\` in a terminal.` }
  }

  return { text: cleanOutput(ran.text, command) || `cache-guard's ${sub} printed nothing (exit ${ran.code}).` }
}

/** What is installed, as status and doctor say it. */
function statusLines(guard: Guard): string[] {
  return [
    guard.state === 'installed'
      ? `Installed for you: its status line and its config (~/.claude/cache-guard/config.json). Opt-ins on: ${guard.optIns.join(', ') || 'none'}.`
      : guard.state === 'half-installed'
        ? `Half-installed: ${guard.hasStatusLine ? 'your status line is cache-guard\'s, but its config file is missing' : 'its config file is there, but your status line is not cache-guard\'s'}. /devloop cache install sets it up again, /devloop cache uninstall takes it out; until then devloop speaks for itself.`
        : 'Not installed for you. /devloop cache install sets it up (it changes your user settings, with a backup).',
  ]
}

/** Doctor's short "Cache (cache-guard)" section. */
export async function cacheDoctorLines($: Engine): Promise<string[]> {
  const guard = await guardNow($)
  const python = await pythonOf($)
  const budget = (await loopOf($).catch(() => null))?.budgetUsd ?? null
  const say = (isGood: boolean, text: string): string => `  ${isGood ? '[ok]  ' : '[look]'} ${text}`

  return [
    'Cache (cache-guard)',
    say(guard.state !== 'half-installed', statusLines(guard)[0] ?? ''),
    say(python.isOk || guard.state === 'not-installed', python.isOk ? `${python.said}: cache-guard can run` : `cache-guard needs Python 3.8+: ${python.said}`),
    ...(guard.state === 'installed' ? [say(true, 'while it is installed, devloop leaves the cold-cache warning and the cost of cache misses to it (its status line and report); devloop\'s meter still records')] : []),
    ...(guard.optIns.includes('trim') ? [say(true, 'both shorten nothing devloop relies on: cache-guard\'s trimmer shortens the Bash output the model sees, and devloop keeps every check\'s full output in its own state and refuses a filtered check run')] : []),
    ...(guard.budgetUsd !== null && budget !== null ? [say(true, `both session budgets are set: devloop's ($${budget.toFixed(2)}, its guards refuse past it) and cache-guard's ($${guard.budgetUsd.toFixed(2)}, it warns at each multiple); both apply`)] : []),
    say(true, 'for cache-guard\'s full scan of your setup: /devloop cache doctor'),
  ]
}
