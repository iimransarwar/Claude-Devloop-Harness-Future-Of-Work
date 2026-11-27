import { describe, expect, test } from 'claude-code/testing'

import { INSTALL_FLAGS, OUTPUT_CAP, PYTHON_VERSION, cleanOutput, guardOf, handoffFolder, installFlags, installQuestion, isPythonOk, reportArgs } from '../hooks/cacheguard'
import { devloop, prompt, start, stop, turn, world } from './world'
import type { Dollar, World } from './world'

// cache-guard, the repository owner's own tool, vendored in cache-guard/
// (DESIGN 4.14). The vendored files, their manifest, the Lean style's copy and
// cache-guard's own test suite are checked by tests/smoke.sh; the guards on
// ~/.claude/cache-guard/** are rows of the parity table; the classic stop
// gate's half of the keep-warm guarantee is in tests/smoke.sh. Here: the
// commands (python3 is answered by the test world, nothing is installed for
// real), the detection, one voice per subject, and the module's half of the
// keep-warm guarantee.

const HOME = '/home/u'
const CONFIG = `${HOME}/.claude/cache-guard/config.json`
const SETTINGS = `${HOME}/.claude/settings.json`
const STATUS = { statusLine: { type: 'command', command: `python3 "${HOME}/.claude/cache-guard/cache_guard.py" statusline`, refreshInterval: 30 } }

/** cache-guard installed as its installer leaves it, with the config given. */
function installed(w: World, config: object = { keepwarm: false, handoff: false, notify: false }, settings: object = STATUS): void {
  w.files[CONFIG] = JSON.stringify(config)
  w.files[SETTINGS] = JSON.stringify(settings)
}

/** The session's Python, as `python3 -c` prints its version. */
const python = (w: World, version = '3.11.4'): void => {
  w.outputs[PYTHON_VERSION] = `${version}\n`
}

/** The argv of each run of the vendored script. */
const scriptRuns = (w: World): string[][] => w.argvs.filter(one => one[0] === 'python3' && (one[1] ?? '').endsWith('/cache-guard/cache_guard.py'))

const SDK = { kind: 'sdk' } as const

// ---------------------------------------------------------------- detection

describe('detection: one pure function decides "installed" from its config file and the status line', () => {
  test('installed, not installed, half-installed', () => {
    const config = JSON.stringify({ keepwarm: true, handoff: false, notify: true, session_budget_usd: 25 })
    const settings = JSON.stringify({ ...STATUS, outputStyle: 'Lean', hooks: { PostToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: `python3 "${HOME}/.claude/cache-guard/cache_guard.py" hook-trim` }] }] } })
    expect(guardOf({ configText: config, settingsText: settings })).toEqual({ state: 'installed', hasStatusLine: true, hasConfig: true, optIns: ['notify', 'keepwarm', 'trim', 'lean'], budgetUsd: 25 })
    expect(guardOf({ configText: null, settingsText: null }).state).toBe('not-installed')
    expect(guardOf({ configText: null, settingsText: JSON.stringify({ statusLine: { command: 'my-own-line' } }) }).state).toBe('not-installed')
    // An uninstall leaves the config; a status line copied by hand has none.
    expect(guardOf({ configText: config, settingsText: JSON.stringify({}) })).toMatchObject({ state: 'half-installed', hasStatusLine: false, hasConfig: true })
    expect(guardOf({ configText: null, settingsText: settings })).toMatchObject({ state: 'half-installed', hasStatusLine: true, hasConfig: false })
    // A config that does not parse is no config; neither is a settings file that does not.
    expect(guardOf({ configText: '{', settingsText: settings }).state).toBe('half-installed')
    expect(guardOf({ configText: config, settingsText: 'not json' }).state).toBe('half-installed')
    expect(guardOf({ configText: JSON.stringify({ session_budget_usd: 0 }), settingsText: settings }).budgetUsd).toBe(null)
  })

  test('a saved handoff\'s header names its folder', () => {
    expect(handoffFolder('<!-- cache-guard handoff {"session": "abc", "cwd": "/repo", "at": 1} -->')).toBe('/repo')
    expect(handoffFolder('# cache-guard handoff')).toBe(null)
    expect(handoffFolder('<!-- cache-guard handoff {not json} -->')).toBe(null)
  })
})

// ---------------------------------------------------------------- the commands, pure

describe('the commands\' pure parts', () => {
  test('install flags: each known one with its README line; anything else is refused', () => {
    expect(installFlags(['--trim', '--keepwarm', '--trim'])).toEqual({ flags: ['--trim', '--keepwarm'] })
    expect(installFlags(['--trim', '--everything'])).toEqual({ unknown: '--everything' })
    expect(Object.keys(INSTALL_FLAGS).sort()).toEqual(['--all', '--handoff', '--keepwarm', '--lean', '--no-handoff', '--no-keepwarm', '--no-notify', '--no-trim', '--notify', '--trim'])
    const question = installQuestion(['--trim', '--handoff', '--no-notify'])
    expect(question).toMatch(/copy itself to ~\/\.claude\/cache-guard\//)
    expect(question).toMatch(/back up ~\/\.claude\/settings\.json, then edit it/)
    expect(question).toMatch(/replace your status line/)
    expect(question).toMatch(/add its hooks to your user settings/)
    expect(question).toMatch(/- --trim: trims huge Bash output/)
    expect(question).toMatch(/- --handoff: saves a handoff before a long session's cache dies/)
    expect(question).toMatch(/- --no-notify: turns expiry notifications back off/)
    expect(question).not.toMatch(/--keepwarm:/)
    expect(installQuestion([])).toMatch(/No opt-in flags/)
  })

  test('report passes --all, --days N and one session id, nothing else', () => {
    expect(reportArgs(['--all', '--days', '7'])).toEqual({ args: ['--all', '--days', '7'] })
    expect(reportArgs(['3f2a9c01'])).toEqual({ args: ['3f2a9c01'] })
    expect(reportArgs(['c0ffee12-3456-7890-abcd-ef0123456789'])).toEqual({ args: ['c0ffee12-3456-7890-abcd-ef0123456789'] })
    expect(reportArgs(['--days', 'x'])).toHaveProperty('refused')
    expect(reportArgs(['/etc/passwd'])).toHaveProperty('refused')
    expect(reportArgs(['a1', 'b2'])).toHaveProperty('refused')
    expect(reportArgs(['--json'])).toHaveProperty('refused')
  })

  test('the cache-guard round, R13: a session id is 8 to 64 letters, digits and hyphens, so it names no file there; --days is given once', () => {
    for (const word of ['3f2a9c', 'config', '..', '../../x', 'handoffs/s1', 'a'.repeat(65), 'abc_defgh', 'abc.defgh']) {
      expect({ word, said: reportArgs([word]) }).toEqual({ word, said: { refused: expect.any(String) } })
    }
    expect(reportArgs(['--days', '7', '--days', '30'])).toEqual({ refused: '--days is given once' })
    expect(reportArgs(['--days', '7', '--all'])).toEqual({ args: ['--days', '7', '--all'] })
  })

  test('output: colour codes out, long output cut with a pointer to a terminal; Python 3.8+', () => {
    expect(cleanOutput('\u001b[32m✓\u001b[0m ok\u001b]8;;x\u0007link\u001b]8;;\u0007\n', 'python3 x doctor')).toBe('✓ oklink')
    const long = cleanOutput(`${'line\n'.repeat(5000)}`, 'python3 x report --all')
    expect(long.length).toBeLessThan(OUTPUT_CAP + 200)
    expect(long).toMatch(/run `python3 x report --all` in a terminal for all of it\)$/)
    expect(isPythonOk('3.8.0')).toBe(true)
    expect(isPythonOk('3.12.1')).toBe(true)
    expect(isPythonOk('3.7.9')).toBe(false)
    expect(isPythonOk('2.7.18')).toBe(false)
    expect(isPythonOk('')).toBe(false)
  })
})

// ---------------------------------------------------------------- the commands, through the engine

describe('/devloop cache: a person\'s, run with python3 from the plugin\'s folder', () => {
  test('install: refused to anyone but a person; an unknown flag refused before the dialog; the dialog names each flag; audited', async ($, on) => {
    const w = world(on)
    python(w)
    await start($)
    expect(await devloop($, 'cache install --trim', SDK)).toMatch(/installed or uninstalled by a person/)
    expect(await devloop($, 'cache install --trim', { kind: 'plugin', name: 'other' })).toMatch(/by a person/)
    expect(await devloop($, 'cache install --everything')).toMatch(/has no flag --everything/)
    expect(w.questions).toEqual([])
    expect(scriptRuns(w)).toEqual([])
    w.answer = 'Leave it'
    expect(await devloop($, 'cache install --keepwarm')).toMatch(/Nothing was changed/)
    expect(w.questions[0]).toMatch(/- --keepwarm: keeps a long session's cache warm/)
    expect(scriptRuns(w)).toEqual([])
    w.answer = 'Install it'
    w.outputs.install = 'Installed cache-guard v2.6.0 to /home/u/.claude/cache-guard\n  \u001b[32m✓\u001b[0m status line'
    const said = await devloop($, 'cache install --trim --lean')
    expect(said).toMatch(/^Installed cache-guard v2\.6\.0/)
    expect(said).not.toMatch(/\u001b/)
    expect(scriptRuns(w).map(one => one.slice(2))).toEqual([['install', '--trim', '--lean']])
    expect(await devloop($, 'audit 5')).toMatch(/cache-guard-installed/)
  })

  test('uninstall: a person, a dialog, audited', async ($, on) => {
    const w = world(on)
    python(w)
    await start($)
    expect(await devloop($, 'cache uninstall', SDK)).toMatch(/by a person/)
    w.answer = 'Uninstall it'
    w.outputs.uninstall = 'Removed cache-guard from /home/u/.claude/settings.json (backup: x).'
    expect(await devloop($, 'cache uninstall')).toMatch(/Removed cache-guard/)
    const question = w.questions.pop() ?? ''
    expect(question).toMatch(/backs up ~\/\.claude\/settings\.json/)
    // The cache-guard round, L3: the earlier status line is not put back, and the dialog says where the backups are.
    expect(question).toMatch(/A status line you had before installing it is not put back: it stays in the backups \(~\/\.claude\/settings\.json\.bak-\*\)/)
    expect(scriptRuns(w).map(one => one.slice(2))).toEqual([['uninstall']])
    expect(await devloop($, 'audit 5')).toMatch(/cache-guard-removed/)
  })

  test('doctor, report and status only read, but are a person\'s too; output cleaned; report passes only its own arguments', async ($, on) => {
    const w = world(on)
    python(w)
    await start($)
    for (const sub of ['doctor', 'report --all', 'status']) {
      expect(await devloop($, `cache ${sub}`, SDK)).toMatch(/a person's, from the prompt: they read your whole session history/)
    }
    expect(scriptRuns(w)).toEqual([])
    w.outputs.doctor = '\u001b[33m!\u001b[0m opusplan is set'
    expect(await devloop($, 'cache doctor')).toBe('! opusplan is set')
    w.outputs.report = 'Session 3f2a: 12 turns'
    expect(await devloop($, 'cache report --all --days 7')).toMatch(/Session 3f2a/)
    expect(await devloop($, 'cache report ../../x')).toMatch(/Not run: report takes --all, --days N and a session id/)
    w.outputs['--version'] = '2.6.0'
    installed(w, { keepwarm: true })
    expect(await devloop($, 'cache status')).toMatch(/cache-guard 2\.6\.0 is bundled with devloop; Python 3\.11\.4\.\nInstalled for you: .*Opt-ins on: keepwarm/)
    expect(scriptRuns(w).map(one => one.slice(2))).toEqual([['doctor'], ['report', '--all', '--days', '7'], ['--version']])
    // No question was asked: reading changes nothing.
    expect(w.questions).toEqual([])
  })

  test('without Python 3.8+ each says so plainly, and runs nothing', async ($, on) => {
    const w = world(on)
    w.exits[PYTHON_VERSION] = 127
    await start($)
    for (const sub of ['doctor', 'report', 'status', 'install', 'uninstall']) {
      expect(await devloop($, `cache ${sub}`)).toMatch(/cache-guard needs Python 3\.8 or later, and none was found/)
    }
    delete w.exits[PYTHON_VERSION]
    python(w, '3.6.9')
    expect(await devloop($, 'cache doctor')).toMatch(/this session's is Python 3\.6\.9/)
    expect(scriptRuns(w)).toEqual([])
    expect(w.questions).toEqual([])
  })

  test('works in a repository that has not opted in: cache-guard is the person\'s own', async ($, on) => {
    const w = world(on, null)
    python(w)
    await start($)
    w.outputs.doctor = 'all good'
    expect(await devloop($, 'cache doctor')).toBe('all good')
  })
})

// ---------------------------------------------------------------- one voice per subject

/** A prompt after the cache lapsed on a large context: devloop's idle-gap condition. */
async function idleGap($: Dollar, w: World): Promise<void> {
  await turn($, { written: 1000 })
  w.usage = { tokens: 80_000, window: 200_000 }
  w.now += 6 * 60_000
  await prompt($)
}

describe('one voice per subject while cache-guard is installed (the table in DESIGN 4.14)', () => {
  test('cold cache before a prompt: devloop\'s idle-gap toast is off while it is installed, on otherwise (half-installed too)', async ($, on) => {
    const w = world(on)
    installed(w)
    await start($)
    await idleGap($, w)
    expect(w.toasts.join(' ')).not.toMatch(/past the prompt cache/)
    // Uninstalled (its config left behind): devloop speaks again.
    w.files[SETTINGS] = '{}'
    await idleGap($, w)
    expect(w.toasts.join(' ')).toMatch(/past the prompt cache/)
  })

  test('cache misses: the meter records, and only the devloop-side miss (a bug report) is shown', async ($, on) => {
    const w = world(on)
    installed(w)
    await start($)
    await turn($, { written: 30_000 })
    w.now += 60 * 60_000
    await turn($, { written: 30_000 })
    const misses = (w.store['ledger:/repo'] as { kind: string; key: string }[]).filter(one => one.kind === 'cache-miss')
    expect(misses.map(one => one.key)).toEqual(['idle-gap'])
    expect(w.toasts.join(' ')).not.toMatch(/cache/i)
    // devloop's own prefix changing mid-thread (its section now sent) is devloop's bug, and is still said.
    await $.prompt.compose({ sections: [], model: 'model-a', promptModel: 'model-a', surfaces: [], tools: [], outputStyle: null, traits: [] } as never)
    w.now += 60_000
    await turn($, { written: 30_000 })
    expect(w.toasts.join(' ')).toMatch(/traced to devloop's own system-prompt section or tool list changing mid-thread/)
  })

  test('setup audit: doctor\'s short section, installed or not, Python, opt-ins, both budgets, and the pointer', async ($, on) => {
    const w = world(on)
    python(w)
    await start($)
    let said = await devloop($, 'doctor')
    expect(said).toMatch(/Cache \(cache-guard\)\n.*Not installed for you/)
    expect(said).toMatch(/Python 3\.11\.4: cache-guard can run/)
    expect(said).toMatch(/\/devloop cache doctor/)
    installed(w, { keepwarm: true, handoff: true, session_budget_usd: 20 }, { ...STATUS, hooks: { PostToolUse: [{ matcher: 'Bash', hooks: [{ command: 'python3 /home/u/.claude/cache-guard/cache_guard.py hook-trim' }] }] } })
    w.answer = 'Set the cap'
    await devloop($, 'budget 5')
    said = await devloop($, 'doctor')
    expect(said).toMatch(/Installed for you: .*Opt-ins on: keepwarm, handoff, trim/)
    expect(said).toMatch(/both session budgets are set: devloop's \(\$5\.00.*cache-guard's \(\$20\.00/)
    expect(said).toMatch(/cache-guard's trimmer shortens the Bash output the model sees, and devloop keeps every check's full output/)
    w.files[SETTINGS] = '{}'
    expect(await devloop($, 'doctor')).toMatch(/\[look\] Half-installed: its config file is there, but your status line is not cache-guard's/)
    // Without Python it says so.
    w.exits[PYTHON_VERSION] = 127
    expect(await devloop($, 'doctor')).toMatch(/cache-guard needs Python 3\.8\+: no python3 was found/)
  })

  test('handoff: the briefing never carries a cache-guard handoff; the person is told once per session that one exists here', async ($, on) => {
    const w = world(on)
    installed(w, { handoff: true })
    w.lists[`${HOME}/.claude/cache-guard/handoffs`] = ['s9.md', 'other.md']
    w.files[`${HOME}/.claude/cache-guard/handoffs/s9.md`] = '<!-- cache-guard handoff {"session": "s9", "cwd": "/repo", "at": 1} -->\n# cache-guard handoff\nGoal: SECRET-PLAN-TEXT\n'
    w.files[`${HOME}/.claude/cache-guard/handoffs/other.md`] = '<!-- cache-guard handoff {"session": "s8", "cwd": "/elsewhere", "at": 1} -->\n# cache-guard handoff\n'
    w.changed = ['src/a.ts']
    w.tree = 't1'
    await start($)
    await prompt($)
    const told = w.toasts.filter(one => /cache-guard saved a handoff for this folder/.test(one))
    expect(told).toHaveLength(1)
    expect(told[0]).toMatch(/\/clear and then run \/handoff-load/)
    expect(w.contexts.flat().join('\n')).not.toMatch(/SECRET-PLAN-TEXT|cache-guard handoff/)
    await prompt($)
    expect(w.toasts.filter(one => /cache-guard saved a handoff/.test(one))).toHaveLength(1)
    // Another folder's handoff is not this one's.
    w.files[`${HOME}/.claude/cache-guard/handoffs/s9.md`] = '<!-- cache-guard handoff {"session": "s9", "cwd": "/other", "at": 1} -->\n'
    w.sessionId = 's-new'
    await prompt($)
    expect(w.toasts.filter(one => /cache-guard saved a handoff/.test(one))).toHaveLength(1)
  })
})

// ---------------------------------------------------------------- keep-warm and the stop gate (the module's half)

/** A keep-warm ping as cache-guard's background Stop hook wakes Claude: a new main-loop turn no person typed. */
async function ping($: Dollar, n: number): Promise<{ block?: string; additionalContext?: readonly string[] }> {
  await $.prompt.submit({ text: 'cache-guard keep-warm ping (automatic). Reply with only: ok', origin: { kind: 'task-notification' }, wait: false } as never)
  await $.turn.start({ turnId: `ping-${n}` } as never)

  return stop($) as Promise<{ block?: string; additionalContext?: readonly string[] }>
}

describe('keep-warm: a turn no person started that leaves the tree unchanged gets nothing from devloop', () => {
  test('no verification run, no fix round, no context and no toast, even with the last check failing', async ($, on) => {
    const w = world(on)
    await start($)
    w.changed = ['src/a.ts']
    w.tree = 't1'
    w.exits['npm test'] = 1
    await prompt($)
    expect((await stop($)).block).toMatch(/fix round 1/)
    // The person leaves; the agent's turn ended on the failing tree (the loop gave up and told them).
    await stop($)
    const ran = w.ran.length
    const toasts = w.toasts.length
    const contexts = w.contexts.length
    for (const n of [1, 2, 3]) {
      const said = await ping($, n)
      expect(said.block).toBeUndefined()
      expect(said.additionalContext ?? []).toEqual([])
    }
    expect(w.ran.slice(ran)).toEqual([])
    expect(w.toasts.slice(toasts)).toEqual([])
    // A non-person prompt carries no devloop context.
    expect(w.contexts.slice(contexts).flat().filter(one => one.startsWith('devloop'))).toEqual([])
    // A person's prompt that changes the tree is judged as before.
    await prompt($)
    await $.turn.start({ turnId: 'person-1' } as never)
    w.tree = 't2'
    expect((await stop($)).block).toMatch(/fix round/)
  })

  test('a ping after the tree changed is judged as before', async ($, on) => {
    const w = world(on)
    await start($)
    w.changed = ['src/a.ts']
    w.tree = 't1'
    await prompt($)
    await stop($)
    w.tree = 't2'
    w.exits['npm test'] = 1
    expect((await ping($, 1)).block).toMatch(/fix round 1/)
  })
})
