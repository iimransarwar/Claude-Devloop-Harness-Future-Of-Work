import { describe, expect, test } from 'claude-code/testing'

import { DEFAULTS, parseConfig } from '../hooks/config'
import { entryId, entryOf, indexLine, readIndex, scanSpecFiles, searchLibrary, slug } from '../hooks/library'
import type { LibraryEntry } from '../hooks/library'
import { validate } from '../hooks/records'
import { judgeCommand, libraryMayRead, place, whereOf } from '../hooks/rules'
import { FRESH } from '../hooks/state'
import { RULES } from '../hooks/templates'
import { CONFIG, devloop, feature, world } from './world'
import type { Dollar, World } from './world'

// The spec library (docs/design-notes/spec-library.md, DESIGN 4.18): the
// save at /devloop done and on a person's /devloop library save, the entry
// and its files, the credential scan, library.save "off", the person's
// commands and their audit events, the index's append and supersede, the
// search, and reads allowed and writes refused inside the library. The spec
// skill's text naming the tool is checked by tests/smoke.sh (this world has
// no file system to read the shipped skill from).

const LIB = '/data/devloop/library'
const DAY = Date.UTC(2026, 10, 27, 12)
const SPEC = [
  '# login',
  'Kind: New feature · Size: full',
  'Related specs: signup, sessions',
  '',
  '## Intent',
  'People sign in with a password. A wrong one is refused and says so.',
  '',
  '## Acceptance criteria',
  '1. A wrong password is refused with "wrong password".',
  '2. A right password signs in.',
  '',
  '## Notes for the reviewer',
  '- src/auth',
  '',
].join('\n')
const FEATURES = [
  { id: 'rejects-bad-password', description: 'a wrong password is refused', check: 'npm test -- bad-password', criteria: [1] },
  { id: 'accepts-good-password', description: 'a right password signs in', check: 'npm test -- good-password', criteria: [2] },
]
const AGENT = { kind: 'plugin', name: 'agent' } as const

const auditIn = (w: World): { action: string; subject: string; actor: { kind: string }; detail: string }[] =>
  Object.keys(w.files).filter(path => /\/audit\/\d{6}\.jsonl$/.test(path)).sort()
    .flatMap(file => (w.files[file] ?? '').split('\n').filter(line => line !== '').map(line => JSON.parse(line) as never))
const answering = (w: World, rules: [string, string][]): void => {
  w.onAsk = () => {
    const question = w.questions[w.questions.length - 1] ?? ''
    w.answer = rules.find(([text]) => question.includes(text))?.[1] ?? 'No'
  }
}
const closing = (w: World): void => answering(w, [['Close the change', 'Close anyway'], ['What did you read', 'The diff'], ['Remove', 'Remove it']])
const indexIn = (w: World, dir = LIB) => readIndex(w.files[`${dir}/index.jsonl`] ?? '')

/** Writes the spec and approves it as a person. */
async function approve($: Dollar, w: World, spec = SPEC, features: object[] = FEATURES): Promise<void> {
  w.now = DAY
  w.files['/repo/specs/login/SPEC.md'] = spec
  w.files['/repo/specs/login/features.json'] = JSON.stringify(features)
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  await devloop($, 'spec login')
  w.answer = 'Approve'
  expect(await devloop($, 'approve')).toMatch(/approved/)
}

/**
 * The engine beneath: once `isOn` says so, its own verdict is an ask (before,
 * an allow, so the person's dialogs are answered), and every ask that
 * reaches a person is recorded (and refused).
 */
function askingEngine(on: Parameters<typeof world>[0], isOn: () => boolean): string[] {
  const asked: string[] = []
  on('tool.check', () => (isOn() ? { decision: 'ask' } : { decision: 'allow' }))
  on('classic.PermissionRequest', (_, e) => {
    asked.push(String((e as { tool_name?: string }).tool_name ?? ''))

    return { hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'deny', message: 'nobody is here' } } } as never
  })

  return asked
}

// ---------------------------------------------------------------- the policy

describe('the policy: library.save (decision 3)', () => {
  test('auto by default; off; a wrong value is read as off, by field', () => {
    expect(DEFAULTS.library).toEqual({ save: 'auto' })
    expect(parseConfig('{}').cfg.library).toEqual({ save: 'auto' })
    expect(parseConfig('{"library":{"save":"off"}}').cfg.library).toEqual({ save: 'off' })
    const wrong = parseConfig('{"library":{"save":"always","x":1}}')
    expect([wrong.cfg.library, wrong.errors]).toEqual([{ save: 'off' }, ['library.x: unknown field', 'library.save: expected "auto" or "off"; using "off"']])
    expect(parseConfig('{"library":"on"}').cfg.library).toEqual({ save: 'off' })
  })

  test('the rules text is unchanged by the feature', () => {
    expect(RULES).not.toMatch(/library/i)
  })
})

// ---------------------------------------------------------------- decisions 2 and 3

describe('the save at /devloop done (decisions 2, 3)', () => {
  test('an approved spec is saved as its change closes: the two files unchanged, entry.json, an index line; the answer says where', async ($, on) => {
    const w = world(on)
    await approve($, w)
    expect(await feature($, 'rejects-bad-password')).toMatch(/^PASS/)
    expect(await feature($, 'accepts-good-password')).toMatch(/^PASS/)
    closing(w)
    const id = 'repo--login--2026-11-27'
    const said = await devloop($, 'done')
    expect(said).toMatch(/Change closed/)
    expect(said).toContain(`Saved to the spec library: ${LIB}/${id}.`)
    expect(w.files[`${LIB}/${id}/SPEC.md`]).toBe(SPEC)
    expect(w.files[`${LIB}/${id}/features.json`]).toBe(JSON.stringify(FEATURES))
    const entry = JSON.parse(w.files[`${LIB}/${id}/entry.json`] ?? '{}') as LibraryEntry
    expect(validate('library-entry@1', entry)).toEqual([])
    expect(entry).toMatchObject({
      id, project: 'repo', spec: 'login', kind: 'New feature', size: 'full', related: ['signup', 'sessions'],
      intent: 'People sign in with a password.',
      criteria: ['A wrong password is refused with "wrong password".', 'A right password signs in.'],
      features: [
        { id: 'rejects-bad-password', description: 'a wrong password is refused', check: 'npm test -- bad-password' },
        { id: 'accepts-good-password', description: 'a right password signs in', check: 'npm test -- good-password' },
      ],
      approvedAt: DAY, closedAt: DAY, outcome: { status: 'closed', isAllPassing: true, reviewRounds: 0, defects: 0 }, harness: '0.7.2',
    })
    // Nothing else is copied: the folder holds the three files.
    expect(Object.keys(w.files).filter(path => path.startsWith(`${LIB}/${id}/`)).sort()).toEqual([`${LIB}/${id}/SPEC.md`, `${LIB}/${id}/entry.json`, `${LIB}/${id}/features.json`])
    // The index line is entry.json without its criteria.
    const line = JSON.parse((w.files[`${LIB}/index.jsonl`] ?? '').trim()) as LibraryEntry
    expect(line.criteria).toBeUndefined()
    expect(line).toEqual({ ...entry, criteria: undefined })
    expect(auditIn(w).filter(one => one.action === 'library-saved').map(one => [one.subject, one.actor.kind])).toEqual([[id, 'person']])
  })

  test('a change with no approved spec saves nothing', async ($, on) => {
    const w = world(on)
    await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
    await $.tool.call({ tool: 'Edit', file_path: '/repo/src/a.ts', old_string: 'a', new_string: 'b' })
    w.changed = ['src/a.ts']
    closing(w)
    expect(await devloop($, 'done')).not.toMatch(/spec library/)
    expect(Object.keys(w.files).some(path => path.startsWith(`${LIB}/`))).toBe(false)
  })

  test('the credential scan stops the save, naming the file and line and never the value; the change still closes', async ($, on) => {
    const w = world(on)
    const key = 'AKIA' + 'Q3J7ZK2M4P8RT6WY'
    await approve($, w, SPEC.replace('- src/auth', `- the staging key is ${key}`))
    closing(w)
    const said = await devloop($, 'done')
    expect(said).toMatch(/Change closed/)
    expect(said).toMatch(/Not saved to the spec library: the credential scan found .* at specs\/login\/SPEC\.md:13\. Fix the spec first/)
    expect(said).not.toContain(key)
    expect(Object.keys(w.files).some(path => path.startsWith(`${LIB}/`))).toBe(false)
    expect(auditIn(w).map(one => one.action)).toEqual(expect.arrayContaining(['change-closed', 'library-save-stopped']))
    expect(JSON.stringify(auditIn(w))).not.toContain(key)
    expect((w.store['loop:/repo'] as { value: { phase: string } }).value.phase).toBe('idle')
  })

  test('library.save "off": neither the save at done nor /devloop library save writes anything', async ($, on) => {
    const w = world(on, { ...CONFIG, library: { save: 'off' } })
    await approve($, w)
    expect(await devloop($, 'library save')).toMatch(/policy sets library\.save to "off"/)
    closing(w)
    expect(await devloop($, 'done')).toMatch(/Not saved to the spec library: this repository's policy sets library\.save to "off"/)
    expect(Object.keys(w.files).some(path => path.startsWith(`${LIB}/`))).toBe(false)
  })

  test('a spec folder the policy\'s secrets globs match is never copied', async ($, on) => {
    const w = world(on, { ...CONFIG, secrets: [...DEFAULTS.secrets, 'specs/login/**'] })
    await approve($, w)
    expect(await devloop($, 'library save')).toMatch(/matches the policy's secrets globs/)
    expect(Object.keys(w.files).some(path => path.startsWith(`${LIB}/`))).toBe(false)
  })

  test('a defect recorded later against the change raises its entry\'s count, in entry.json and a superseding index line', async ($, on) => {
    const w = world(on)
    await approve($, w)
    closing(w)
    await devloop($, 'done')
    expect(await devloop($, 'defect login breaks on an empty password')).toMatch(/recorded against C1/)
    const id = 'repo--login--2026-11-27'
    expect((JSON.parse(w.files[`${LIB}/${id}/entry.json`] ?? '{}') as LibraryEntry).outcome.defects).toBe(1)
    const lines = (w.files[`${LIB}/index.jsonl`] ?? '').trim().split('\n')
    expect(lines).toHaveLength(2)
    expect(indexIn(w).entries.map(one => [one.id, one.outcome.defects])).toEqual([[id, 1]])
  })
})

// ---------------------------------------------------------------- decision 5

describe('the person\'s commands (decision 5)', () => {
  test('refused for an agent; for a person: save now (open), path, the listing, remove after a dialog; each audited', async ($, on) => {
    const w = world(on)
    await approve($, w)
    for (const args of ['library', 'library save', 'library path /home/u/team-specs', `library remove repo--login--2026-11-27`]) {
      expect(await devloop($, args, AGENT)).toMatch(/a person's to manage, from the prompt/)
      expect(await devloop($, args, { kind: 'sdk' })).toMatch(/a person's to manage/)
    }
    expect(Object.keys(w.files).some(path => path.startsWith(`${LIB}/`) || path.startsWith('/home/u/team-specs'))).toBe(false)

    // Saved now, before the change closes: the outcome says open.
    expect(await devloop($, 'library save')).toBe(`Saved to the spec library: ${LIB}/repo--login--2026-11-27.`)
    expect(indexIn(w).entries.map(one => one.outcome)).toEqual([{ status: 'open', isAllPassing: null, reviewRounds: 0, defects: 0 }])

    // Another folder, created; this repository and the harness's own state are refused.
    expect(await devloop($, 'library path /repo/specs-lib')).toMatch(/not outside this repository/)
    expect(await devloop($, 'library path /data/devloop/repos')).toMatch(/inside the harness's own state/)
    expect(await devloop($, 'library path relative/dir')).toMatch(/not an absolute path/)
    expect(await devloop($, 'library path ~/team-specs')).toMatch(/The spec library is now \/home\/u\/team-specs \(0 entries\)/)
    expect(w.files['/home/u/team-specs/index.jsonl']).toBe('')
    expect(w.store['library:path']).toBe('/home/u/team-specs')
    expect(await devloop($, 'library save')).toBe('Saved to the spec library: /home/u/team-specs/repo--login--2026-11-27.')
    const listing = await devloop($, 'library')
    expect(listing).toMatch(/^Spec library: \/home\/u\/team-specs$/m)
    expect(listing).toMatch(/1 entry; the last 1:\n {2}repo--login--2026-11-27: People sign in with a password\. \[open; 0 review rounds\]/)

    // Remove asks first; a no keeps it.
    answering(w, [['Remove', 'Keep it']])
    expect(await devloop($, 'library remove repo--login--2026-11-27')).toMatch(/is kept/)
    expect(await devloop($, 'library remove nothing--here--2026-01-01')).toMatch(/No entry nothing--here--2026-01-01/)
    answering(w, [['Remove', 'Remove it']])
    expect(await devloop($, 'library remove repo--login--2026-11-27')).toMatch(/is removed from the spec library/)
    expect(w.scriptArgs['library-remove']).toEqual(['/home/u/team-specs/repo--login--2026-11-27'])
    const index = indexIn(w, '/home/u/team-specs')
    expect([index.entries, index.removed]).toEqual([[], ['repo--login--2026-11-27']])
    expect(await devloop($, 'library')).toMatch(/0 entries, 1 removed\./)

    // Back to the default: the key goes, the earlier save is still there.
    expect(await devloop($, `library path ${LIB}`)).toMatch(/The spec library is now \/data\/devloop\/library \(1 entry\)/)
    expect(w.store['library:path']).toBeUndefined()
    expect(auditIn(w).filter(one => one.action.startsWith('library-')).map(one => [one.action, one.actor.kind])).toEqual([
      ['library-saved', 'person'], ['library-path-set', 'person'], ['library-saved', 'person'], ['library-removed', 'person'], ['library-path-set', 'person'],
    ])
  })

  test('a save then the close of the same spec, as approved, is one entry: the later line supersedes the earlier', async ($, on) => {
    const w = world(on)
    await approve($, w)
    await devloop($, 'library save')
    w.now = DAY + 3 * 24 * 60 * 60 * 1000
    closing(w)
    expect(await devloop($, 'done')).toContain(`Saved to the spec library: ${LIB}/repo--login--2026-11-27 (superseding the earlier save).`)
    expect((w.files[`${LIB}/index.jsonl`] ?? '').trim().split('\n')).toHaveLength(2)
    expect(indexIn(w).entries.map(one => [one.id, one.outcome.status, one.closedAt])).toEqual([['repo--login--2026-11-27', 'closed', DAY + 3 * 24 * 60 * 60 * 1000]])
  })

  test('doctor reports the library: its path, whether it is there and writable, its entries, and library.save', async ($, on) => {
    const w = world(on)
    await approve($, w)
    expect(await devloop($, 'doctor')).toMatch(/\[ok\] {3}spec library: \/data\/devloop\/library \(the default, in the plugin's data folder\): not there yet; the first save creates it/)
    await devloop($, 'library save')
    const said = await devloop($, 'doctor')
    expect(said).toMatch(/spec library: \/data\/devloop\/library \(the default, in the plugin's data folder\): writable, 1 entry/)
    expect(said).toMatch(/library\.save: auto \(an approved spec is saved when its change closes\)/)
  })
})

// ---------------------------------------------------------------- the index and the search (decisions 2, 4)

describe('the index and the search (decisions 2, 4)', () => {
  const made = (spec: string, intent: string, at: number, project = 'shop', features: string[] = []): LibraryEntry => entryOf({
    project, spec, specText: `# ${spec}\n\n## Intent\n${intent}\n`, featuresText: JSON.stringify(features.map((description, i) => ({ id: `f${i}`, description, check: 'true' }))),
    approvedAt: at, closedAt: at, isAllPassing: true, reviewRounds: 1, savedAt: at, harness: '0.2.0',
  })

  test('the folder name; an append is read in order, a later line supersedes, a removed line hides it, a bad line is skipped', () => {
    expect(entryId('my shop', 'login/v2', DAY)).toBe('my-shop--login-v2--2026-11-27')
    expect(slug('--a--b..')).toBe('a-b..')
    expect(slug('///')).toBe('unnamed')
    const a = made('login', 'Sign in.', 1)
    const b = made('export', 'Export to CSV.', 2)
    const text = [indexLine(a), indexLine(b), '{not json', indexLine({ ...a, outcome: { ...a.outcome, defects: 2 } }), indexLine({ ...b, removedAt: 3 })].join('\n')
    const index = readIndex(text)
    expect(index.entries.map(one => [one.id, one.outcome.defects])).toEqual([[a.id, 2]])
    expect([index.removed, index.skipped]).toEqual([[b.id], 1])
  })

  test('ranked by matching words, ties newer first; none that match nothing; the limit is 5 by default and at most 10', () => {
    const entries = readIndex([
      made('login', 'Sign in with a password.', 1),
      made('password-reset', 'Reset a forgotten password by email.', 2),
      made('export', 'Export orders to CSV.', 3, 'billing'),
      made('signup', 'Create an account.', 4, 'shop', ['sends a welcome email']),
    ].map(indexLine).join('\n')).entries
    expect(searchLibrary(entries, 'password email', 5).map(one => [one.spec, one.score])).toEqual([['password-reset', 2], ['signup', 1], ['login', 1]])
    expect(searchLibrary(entries, 'billing', 5).map(one => one.spec)).toEqual(['export'])
    expect(searchLibrary(entries, 'kubernetes', 5)).toEqual([])
    expect(searchLibrary(entries, '', 5)).toEqual([])
    expect(searchLibrary(entries, 'password email', 1).map(one => one.spec)).toEqual(['password-reset'])
    const many = readIndex(Array.from({ length: 14 }, (_, i) => indexLine(made(`s${i}`, 'Sign in.', i))).join('\n')).entries
    expect(searchLibrary(many, 'sign', undefined)).toHaveLength(5)
    expect(searchLibrary(many, 'sign', 50)).toHaveLength(10)
    expect(searchLibrary(many, 'sign', 50)[0]?.spec).toBe('s13')
  })

  test('the tool answers each entry: folder, project, name, kind, intent, outcome and the criteria from entry.json', async ($, on) => {
    const w = world(on)
    await approve($, w)
    closing(w)
    await devloop($, 'done')
    const said = String((await $.tool.call({ tool: 'mcp__devloop__devloop_library', query: 'password sign in' })).result)
    expect(said).toMatch(/^1 of 1 entry in the spec library \(\/data\/devloop\/library\)/)
    expect(said).toContain('login (project repo, New feature, full)')
    expect(said).toContain(`  folder: ${LIB}/repo--login--2026-11-27 (read its SPEC.md and features.json there)`)
    expect(said).toContain('  intent: People sign in with a password.')
    expect(said).toContain('  outcome: closed with features not passing; 0 review rounds')
    expect(said).toContain('    1. A wrong password is refused with "wrong password".')
    expect(String((await $.tool.call({ tool: 'mcp__devloop__devloop_library', query: 'kubernetes' })).result)).toMatch(/No entry in the spec library/)
    // It reads and never writes.
    const before = JSON.stringify(w.files)
    await $.tool.call({ tool: 'mcp__devloop__devloop_library', query: 'password', limit: 3 })
    expect(JSON.stringify(w.files)).toBe(before)
  })

  test('the scan reads every line of both files', () => {
    const key = 'ghp_' + 'Zx8Qw2Lm4Np6Rt1Vb3Kd5Hf7Js9Gc0Ay2Ue4'
    expect(scanSpecFiles('# a\n\nno key here\n', JSON.stringify([{ id: 'x', check: `curl -H "token ${key}"` }])).map(one => [one.file, one.line])).toEqual([['features.json', 1]])
  })
})

// ---------------------------------------------------------------- reads and writes (decision 4)

describe('reads in the library are allowed for every agent; writes are refused (decision 4)', () => {
  test('pure: a Read, Grep or Glob landing in the library is answered; a secret or one outside is not; a write there is harness-state', () => {
    const where = whereOf('/repo', '/repo', { home: '/home/u', stateRoot: '/data/devloop', library: ['/home/u/team-specs'] })
    const facts = { where, cfg: DEFAULTS, library: ['/home/u/team-specs'], resolve: (path: { abs: string | null }) => (path.abs === null ? null : [{ ...place(path.abs, '/', where) }]) }
    expect(libraryMayRead('Read', { file_path: '/home/u/team-specs/a--b--2026-01-01/SPEC.md' }, facts)).toBe(true)
    expect(libraryMayRead('Grep', { pattern: 'login', path: '/home/u/team-specs' }, facts)).toBe(true)
    expect(libraryMayRead('Glob', { pattern: '*/SPEC.md', path: '/home/u/team-specs' }, facts)).toBe(true)
    expect(libraryMayRead('Glob', { pattern: '../*', path: '/home/u/team-specs' }, facts)).toBe(false)
    expect(libraryMayRead('Read', { file_path: '/home/u/team-specs/.env' }, facts)).toBe(false)
    expect(libraryMayRead('Read', { file_path: '/home/u/other/SPEC.md' }, facts)).toBe(false)
    expect(libraryMayRead('Bash', { command: 'cat /home/u/team-specs/index.jsonl' }, facts)).toBe(false)
    expect(judgeCommand('echo x >> /home/u/team-specs/index.jsonl', DEFAULTS, FRESH, where)).toMatchObject({ rule: 'harness-state', reason: expect.stringMatching(/is in the spec library, which only the harness writes/) })
    expect(judgeCommand('cat /home/u/team-specs/index.jsonl', DEFAULTS, FRESH, where)).toBe(null)
  })

  test('the builder and an agent read in the library with no prompt; every write there is refused, at the default and at a folder a person set', async ($, on) => {
    const w = world(on)
    let isAsking = false
    const asked = askingEngine(on, () => isAsking)
    await approve($, w)
    closing(w)
    await devloop($, 'done')
    // The engine beneath asks from here on (the dialogs above are the person's).
    isAsking = true
    const spec = `${LIB}/repo--login--2026-11-27/SPEC.md`
    expect((await $.tool.call({ tool: 'Read', file_path: spec } as never)).isError).toBeUndefined()
    expect((await $.tool.call({ tool: 'Grep', pattern: 'password', path: LIB } as never)).isError).toBeUndefined()
    expect((await $.tool.call({ tool: 'Read', file_path: spec, agentId: 'helper-1' } as never)).isError).toBeUndefined()
    expect(asked).toEqual([])
    // A read outside the library and the repository is still the engine's to ask.
    w.files['/home/u/notes.md'] = 'n'
    await $.tool.call({ tool: 'Read', file_path: '/home/u/notes.md' } as never)
    expect(asked).toEqual(['Read'])

    expect((await $.tool.call({ tool: 'Write', file_path: spec, content: 'x' })).deny).toMatch(/is in the spec library, which only the harness writes/)
    expect((await $.tool.call({ tool: 'Edit', file_path: `${LIB}/index.jsonl`, old_string: 'a', new_string: 'b', agentId: 'helper-1' })).deny).toMatch(/spec library/)
    expect((await $.tool.call({ tool: 'Bash', command: `rm -rf ${LIB}/repo--login--2026-11-27` })).deny).toBeDefined()
    expect(await devloop($, 'library path /home/u/team-specs')).toMatch(/now \/home\/u\/team-specs/)
    expect((await $.tool.call({ tool: 'Write', file_path: '/home/u/team-specs/index.jsonl', content: '' })).deny).toMatch(/is in the spec library/)
    expect((await $.tool.call({ tool: 'Bash', command: 'echo x > /home/u/team-specs/x.md' })).deny).toMatch(/is in the spec library/)
    expect(w.files[spec]).toBe(SPEC)
  })
})
