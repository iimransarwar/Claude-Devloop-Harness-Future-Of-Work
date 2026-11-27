import { describe, expect, test } from 'claude-code/testing'

import { CACHE_QUESTION, foundLabel, readApprovers, readStrictness, readVerify, summary } from '../hooks/setup'
import { configFile } from '../hooks/templates'

import { devloop, start, world } from './world'

describe('setup answer readers and summary', () => {
  test('readStrictness reads labels and typed words, any case and spacing', () => {
    expect(readStrictness('Watch only (recommended)')).toBe('observe')
    expect(readStrictness('Block from the start')).toBe('enforce')
    expect(readStrictness('  WATCH ')).toBe('observe')
    expect(readStrictness('enforce')).toBe('enforce')
    expect(readStrictness('observe')).toBe('observe')
    expect(readStrictness('sometimes')).toBeNull()
  })
  test('readApprovers reads labels and me/1/one/two/2', () => {
    expect(readApprovers('Just me (recommended)')).toBe('me')
    for (const t of ['me', 'Just me', '1', 'one']) expect(readApprovers(t)).toBe('me')
    for (const t of ['Two people', 'two', '2']) expect(readApprovers(t)).toBe('two')
    expect(readApprovers('3 people')).toBeNull()
  })
  test('readVerify: found label keeps objects whole; typed replaces all, trimmed; none/no/empty/later mean none', () => {
    const found = ['npm test --silent', { run: 'go test ./...', when: ['**/*.go'] }]
    expect(readVerify(foundLabel(found), found)).toEqual({ verify: found, isLater: false })
    expect(readVerify('  make check  ', found)).toEqual({ verify: ['make check'], isLater: false })
    for (const t of ['None for now', 'none', ' NO ', '']) expect(readVerify(t, found)).toEqual({ verify: [], isLater: false })
    expect(readVerify("I'll add it later", [])).toEqual({ verify: [], isLater: true })
  })
  test('foundLabel joins with " + " and cuts at 60 characters with …', () => {
    expect(foundLabel(['npm test --silent', 'npm run --silent lint'])).toBe('npm test --silent + npm run --silent lint')
    const long = foundLabel(['npm run --silent typecheck', 'npm run --silent lint', 'npm test --silent'])
    expect(long.length).toBe(60)
    expect(long.endsWith('…')).toBe(true)
  })
  test('summary names mode, checks, approvers, only written files, and the guessed branch', () => {
    const text = summary({ mode: 'observe', verify: ['npm test --silent'], approvers: 'me' }, ['devloop.json', 'evals/README.md'], ['REVIEW.md'], { name: 'main', isGuessed: true })
    expect(text.split('\n')[0]).toBe('devloop is set up.')
    expect(text).toMatch(/Watch only/)
    expect(text).toMatch(/runs: npm test --silent/)
    expect(text).toMatch(/just you/)
    expect(text).toMatch(/devloop\.json/)
    expect(text).not.toMatch(/AGENTS\.md/)
    expect(text).toMatch(/left as is: REVIEW\.md/)
    expect(text).toMatch(/main.*guessed/)
    expect(text).toMatch(/"mode", "verify", "approvals"/)
  })
  test('summary: fast checks run at each stop, full ones before shipping, on separate lines', () => {
    const text = summary({ mode: 'observe', verify: ['npm test --silent', { run: 'npm run --silent e2e', profile: 'full' }], approvers: 'me' }, ['devloop.json'], [], { name: 'main', isGuessed: false })
    expect(text).toMatch(/Each time Claude stops after changing files, it runs: npm test --silent\n/)
    expect(text).toMatch(/Before anything ships, it also runs: npm run --silent e2e/)
    expect(text).not.toMatch(/stops after changing files, it runs:.*e2e/)
    const onlyFast = summary({ mode: 'observe', verify: ['npm test --silent'], approvers: 'me' }, ['devloop.json'], [], { name: 'main', isGuessed: false })
    expect(onlyFast).not.toMatch(/Before anything ships/)
  })
  test('summary names the real branch for devloop.json, and none outside git', () => {
    const on = summary({ mode: 'observe', verify: [], approvers: 'me' }, ['devloop.json'], [], { name: 'master', isGuessed: false })
    expect(on).toMatch(/commit it to master/)
    expect(on).not.toMatch(/commit it to main/)
    const off = summary({ mode: 'observe', verify: [], approvers: 'me' }, ['devloop.json'], [], { name: 'main', isGuessed: true }, { isOutsideGit: true })
    expect(off).not.toMatch(/commit it/)
  })
  test('the cache question says what it edits and promises no trimming', () => {
    expect(CACHE_QUESTION).toMatch(/~\/\.claude\/settings\.json/)
    expect(CACHE_QUESTION).toMatch(/all projects/)
    expect(CACHE_QUESTION).toMatch(/status line/)
    expect(CACHE_QUESTION).not.toMatch(/trim/i)
  })
  test('summary with no checks says nothing is checked and where to add one', () => {
    const text = summary({ mode: 'enforce', verify: [], approvers: 'two' }, ['devloop.json'], [], { name: 'main', isGuessed: false })
    expect(text).toMatch(/nothing will be checked/i)
    expect(text).toMatch(/"verify"/)
    expect(text).toMatch(/two people/i)
    expect(text).not.toMatch(/guessed/)
  })
  test('configFile writes mode and approvals only when given', () => {
    expect(JSON.parse(configFile([], 'main')).mode).toBe('observe')
    expect('approvals' in JSON.parse(configFile([], 'main'))).toBe(false)
    const both = JSON.parse(configFile(['x'], 'main', { mode: 'enforce', approvals: { low: 0, medium: 1, high: 1 } }))
    expect(both.mode).toBe('enforce')
    expect(both.approvals).toEqual({ low: 0, medium: 1, high: 1 })
  })
})

describe('guided setup on /devloop', () => {
  test('/devloop in a repo not set up runs setup; Enter three times takes the defaults', async ($, on) => {
    const w = world(on, null); await start($)
    const said = await devloop($, '')
    expect(said.split('\n')[0]).toBe('devloop is set up.')
    expect(w.questions.length).toBe(3)
    const cfg = JSON.parse(w.files['/repo/devloop.json'] ?? '{}')
    expect(cfg.mode).toBe('observe')
    expect(cfg.approvals).toEqual({ low: 0, medium: 1, high: 1 })
  })
  test('/devloop init runs the same flow; answers are written', async ($, on) => {
    const w = world(on, null); w.setupAnswers = ['Block from the start', 'make check', 'Two people']; await start($)
    await devloop($, 'init')
    const cfg = JSON.parse(w.files['/repo/devloop.json'] ?? '{}')
    expect(cfg).toMatchObject({ mode: 'enforce', verify: ['make check'] })
    expect('approvals' in cfg).toBe(false)
  })
  test('dismissing a question writes nothing', async ($, on) => {
    const w = world(on, null); w.setupAnswers = ['Watch only (recommended)', '<dismiss>']; await start($)
    expect(await devloop($, '')).toBe('Setup cancelled. Nothing was written.')
    expect('/repo/devloop.json' in w.files).toBe(false)
  })
  test('an unreadable typed answer is asked again once, then cancels', async ($, on) => {
    const w = world(on, null); w.setupAnswers = ['sometimes', 'never']; await start($)
    expect(await devloop($, '')).toBe('Setup cancelled. Nothing was written.')
    expect(w.questions[1]).toMatch(/^I didn't catch that\./)
  })
  test('second /devloop in the same session shows status, asks nothing', async ($, on) => {
    const w = world(on, null); await start($)
    await devloop($, '')
    const asked = w.questions.length
    expect(await devloop($, '')).not.toMatch(/^devloop is set up\./)
    expect(w.questions.length).toBe(asked)
  })
  test('only written files are listed; existing ones are kept', async ($, on) => {
    const w = world(on, null); w.files['/repo/CLAUDE.md'] = '# x'; w.files['/repo/REVIEW.md'] = 'mine'; await start($)
    const said = await devloop($, '')
    expect(said).not.toMatch(/AGENTS\.md/)
    expect(said).toMatch(/left as is: REVIEW\.md/)
    expect(w.files['/repo/REVIEW.md']).toBe('mine')
  })
  test('not a git repository, git subfolder below: names it, writes nothing, asks nothing', async ($, on) => {
    const w = world(on, null); w.isGit = false; w.gitSubfolders = ['plugin']; await start($)
    const said = await devloop($, '')
    expect(said).toMatch(/isn't a git repository/)
    expect(said).toMatch(/plugin\//)
    expect(w.questions.length).toBe(0)
    expect('/repo/devloop.json' in w.files).toBe(false)
  })
  test('not a git repository, none below: Cancel is the default and writes nothing', async ($, on) => {
    const w = world(on, null); w.isGit = false; await start($)
    expect(await devloop($, '')).toMatch(/Nothing was written/)
    expect('/repo/devloop.json' in w.files).toBe(false)
  })
  test('not a git repository, none below: Set up anyway asks the three questions and says what devloop cannot see', async ($, on) => {
    const w = world(on, null); w.isGit = false; w.setupAnswers = ['Set up anyway']; await start($)
    const said = await devloop($, '')
    expect(said.split('\n')[0]).toBe('devloop is set up.')
    expect(said).toMatch(/devloop will only see files Claude edits here: no diffs, no credential scan, no push gate\./)
    expect(w.questions.length).toBe(4)
    expect('/repo/devloop.json' in w.files).toBe(true)
  })
  test('status outside git says so instead of No changes yet', async ($, on) => {
    const w = world(on); w.isGit = false; await start($)
    const said = await devloop($, 'status')
    expect(said).toMatch(/Not a git repository: devloop only sees files Claude edits here\./)
    expect(said).not.toMatch(/No changes yet/)
  })
  test('a git repository whose snapshot fails still says No changes yet, never that it is not a git repository', async ($, on) => {
    const w = world(on); w.isSnapshotBroken = true; await start($)
    const said = await devloop($, 'status')
    expect(said).toMatch(/No changes yet/)
    expect(said).not.toMatch(/Not a git repository/)
  })
  test('Set up anyway: the summary says no push gate and promises no push review', async ($, on) => {
    const w = world(on, null); w.isGit = false; w.setupAnswers = ['Set up anyway']; await start($)
    const said = await devloop($, '')
    expect(said).toMatch(/no push gate/)
    expect(said).not.toMatch(/second agent reviews/)
  })
  test('a branch taken from the checked-out HEAD is marked guessed', async ($, on) => {
    const w = world(on, null); w.defaultBranch = 'guess:feature'; await start($)
    expect(await devloop($, '')).toMatch(/feature \(guessed/)
  })
  test('doctor in a repo not set up points at /devloop', async ($, on) => {
    world(on, null); await start($)
    expect(await devloop($, 'doctor')).toMatch(/type \/devloop to set it up/)
  })
  test('a git repository with git subfolders sets up normally', async ($, on) => {
    const w = world(on, null); w.gitSubfolders = ['vendor/lib']; await start($)
    expect((await devloop($, '')).split('\n')[0]).toBe('devloop is set up.')
  })
  test('a failing write reports the file and what was already written', async ($, on) => {
    const w = world(on, null); w.failWrite = '/repo/REVIEW.md'; await start($)
    expect(await devloop($, '')).toMatch(/Could not write REVIEW\.md: disk full\. Already written: devloop\.json, AGENTS\.md\. Delete devloop\.json and type \/devloop to try again\./)
  })
  test('setup with master as the base says commit it to master and fast/full lines for package.json scripts', async ($, on) => {
    const w = world(on, null); w.defaultBranch = 'master'; w.files['/repo/package.json'] = JSON.stringify({ scripts: { test: 'x', e2e: 'y' } }); w.setupAnswers = ['Watch only (recommended)', 'npm test --silent + npm run --silent e2e', 'Just me (recommended)']; await start($)
    const said = await devloop($, '')
    expect(said).toMatch(/commit it to master/)
    expect(said).toMatch(/it runs: npm test --silent\n/)
    expect(said).toMatch(/Before anything ships, it also runs: npm run --silent e2e/)
  })
  test('the cache question asked is the one that names the settings file', async ($, on) => {
    const w = world(on, null); w.pythonVersion = '3.12'; await start($)
    await devloop($, '')
    expect(w.questions[3]).toBe(CACHE_QUESTION)
  })
  test('the default branch is marked guessed when git names none', async ($, on) => {
    const w = world(on, null); w.defaultBranch = ''; await start($)
    expect(await devloop($, '')).toMatch(/main \(guessed/)
  })
  test('from the agent: not set up text, nothing asked or written', async ($, on) => {
    const w = world(on, null); await start($)
    expect(await devloop($, '', { kind: 'sdk' })).toBe('devloop is not set up in this repository. A person sets it up by typing /devloop.')
    expect(w.questions.length).toBe(0)
  })
  // Setup's fourth question: cache-guard.
  test('Enter through setup with Python installs cache-guard with --all', async ($, on) => {
    const w = world(on, null); w.pythonVersion = '3.12'; await start($)
    const said = await devloop($, '')
    expect(w.questions.length).toBe(4)
    expect(w.cacheInstalls).toEqual([['install', '--all', '--keepwarm']])
    expect(said).toMatch(/cache-guard: installed \(everything\)\. Restart Claude Code/)
  })
  test('the cache question discloses keep-warm pings and quota', async ($, on) => {
    const w = world(on, null); w.pythonVersion = '3.12'; await start($)
    await devloop($, '')
    expect(w.questions[3]).toMatch(/keeps the cache warm while you are away/)
    expect(w.questions[3]).toMatch(/uses a little of your quota/)
  })
  test('keep normal replies installs with --notify', async ($, on) => {
    const w = world(on, null); w.pythonVersion = '3.12'; w.setupAnswers = ['Watch only (recommended)', 'None for now', 'Just me (recommended)', 'Yes, but keep normal replies']; await start($)
    await devloop($, '')
    expect(w.cacheInstalls).toEqual([['install', '--notify']])
  })
  test('Not now installs nothing and says how to add it later', async ($, on) => {
    const w = world(on, null); w.pythonVersion = '3.12'; w.setupAnswers = ['Watch only (recommended)', 'None for now', 'Just me (recommended)', 'Not now']; await start($)
    expect(await devloop($, '')).toMatch(/cache-guard: not installed\. \/devloop cache install adds it later\./)
    expect(w.cacheInstalls).toEqual([])
  })
  test('no Python: three questions, skipped line', async ($, on) => {
    const w = world(on, null); await start($)
    expect(await devloop($, '')).toMatch(/cache-guard: skipped, it needs Python 3\.8 or later\./)
    expect(w.questions.length).toBe(3)
  })
  test('already installed: three questions, already line', async ($, on) => {
    const w = world(on, null); w.pythonVersion = '3.12'
    w.files['/home/u/.claude/settings.json'] = JSON.stringify({ statusLine: { command: 'python3 /x/cache_guard.py statusline' } })
    await start($)
    expect(await devloop($, '')).toMatch(/cache-guard: already installed\./)
    expect(w.questions.length).toBe(3)
  })
  test('a failing install still sets devloop up and says so', async ($, on) => {
    const w = world(on, null); w.pythonVersion = '3.12'; w.cacheInstallExit = 1; await start($)
    const said = await devloop($, '')
    expect(said.split('\n')[0]).toBe('devloop is set up.')
    expect(said).toMatch(/cache-guard: could not be installed \(.*\)\. \/devloop cache install tries again\./)
    expect('/repo/devloop.json' in w.files).toBe(true)
  })
  test('dismissing the cache question writes nothing and installs nothing', async ($, on) => {
    const w = world(on, null); w.pythonVersion = '3.12'; w.setupAnswers = ['Watch only (recommended)', 'None for now', 'Just me (recommended)', '<dismiss>']; await start($)
    expect(await devloop($, '')).toBe('Setup cancelled. Nothing was written.')
    expect(w.cacheInstalls).toEqual([])
    expect('/repo/devloop.json' in w.files).toBe(false)
  })
  test('/devloop cache install still asks its own confirmation', async ($, on) => {
    const w = world(on); w.pythonVersion = '3.12'; w.answer = 'Leave it'; await start($)
    expect(await devloop($, 'cache install --all')).toBe('Nothing was changed.')
    expect(w.cacheInstalls).toEqual([])
  })
  test('the intro does not name a number of questions', async ($, on) => {
    const w = world(on, null); w.pythonVersion = '3.12'; await start($)
    await devloop($, '')
    expect(w.logs.join('\n')).toMatch(/isn't set up here yet/)
    expect(w.logs.join('\n')).not.toMatch(/three questions/i)
  })
})
