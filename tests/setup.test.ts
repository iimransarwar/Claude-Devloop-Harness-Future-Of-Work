import { describe, expect, test } from 'claude-code/testing'

import { foundLabel, readApprovers, readStrictness, readVerify, summary } from '../hooks/setup'
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
    const text = summary({ mode: 'observe', verify: ['npm test --silent'], isVerifyLater: false, approvers: 'me' }, ['devloop.json', 'evals/README.md'], ['REVIEW.md'], { name: 'main', isGuessed: true })
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
  test('summary with no checks says nothing is checked and where to add one', () => {
    const text = summary({ mode: 'enforce', verify: [], isVerifyLater: true, approvers: 'two' }, ['devloop.json'], [], { name: 'main', isGuessed: false })
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
    expect(await devloop($, '')).toMatch(/Could not write REVIEW\.md: disk full\. Already written: devloop\.json/)
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
})
