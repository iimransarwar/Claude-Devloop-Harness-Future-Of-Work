import { describe, expect, test } from 'claude-code/testing'

import { DEFAULTS, parseConfig } from '../hooks/config'
import type { Config } from '../hooks/config'
import {
  heartbeatPath, inboxPath, judgeCall, readInbox, repoStateDir, shipRules, shippingOf, stampPath, stateRootFrom, statelessLoop, stopKey, stopStampPath, STATE_FALLBACK,
} from '../hooks/enforce'
import type { CallFacts } from '../hooks/enforce'
import { CHAINED_SUFFIX, HOOK_MARK, hookOutcome, prePushHook } from '../hooks/githook'
import { decidePolicy } from '../hooks/inforce'
import { evidenceNote, parseEvidence, policyHash, reviewRowFrom, statelessGate } from '../hooks/portable'
import type { EvidenceNote, TreeProof } from '../hooks/portable'
import { validate } from '../hooks/records'
import { evidenceNotesWrite, judgeCommand, repoSlug, shipElsewhere, shipLookups, whereOf } from '../hooks/rules'
import { compareSandbox, isBroadDomain, sandboxOf, sandboxSettings } from '../hooks/sandbox'
import { parse as parseIn } from '../hooks/shell'
import { readInstructionFiles } from '../hooks/scripts'
import { FRESH } from '../hooks/state'
import { bash, CONFIG, devloop, edit, prompt, start, stop, world } from './world'
import type { World } from './world'

/** The extended reading (BB1), which these tests were written against; `parseIn` names a reading. */
const parse = (command: string, ...rest: Parameters<typeof parseIn> extends [string, unknown, ...infer R] ? R : never) => parseIn(command, 'extended', ...rest)

const cfgOf = (raw: object): Config => parseConfig(JSON.stringify(raw)).cfg
const ENFORCE = cfgOf({ mode: 'enforce', verify: ['npm test'], network: { allow: ['github.com'] }, rules: [{ id: 'no-console', when: ['src/**'], pattern: 'console\\.log', action: 'refuse', why: 'use the logger' }] })
const where = whereOf('/repo', '/repo', { stateRoot: '/data/devloop', home: '/home/u' })
const facts = (more: Partial<CallFacts> = {}): CallFacts => ({ cfg: ENFORCE, isOptedIn: true, where, loop: statelessLoop('idle'), realOf: () => [], readText: () => null, ...more })
const rulesOf = (call: { tool: string; input: Record<string, unknown> }, more: Partial<CallFacts> = {}): string[] => judgeCall(call, facts(more)).map(one => one.rule)

// ---------------------------------------------------------------- 1. the shared policy decision

describe('D1 1. one pure decision of the policy in force, fed by different readers', () => {
  test('the base branch\'s copy, whole, whenever it has one; the working tree\'s only when it has none', () => {
    const working = cfgOf({ mode: 'observe' })
    const base = JSON.stringify({ mode: 'enforce' })
    expect(decidePolicy(working, '{"mode":"observe"}', base)).toMatchObject({ source: 'base', policy: 'changed', cfg: { mode: 'enforce' } })
    expect(decidePolicy(working, base, base)).toMatchObject({ source: 'base', policy: 'same' })
    expect(decidePolicy(null, null, base)).toMatchObject({ source: 'base', policy: 'deleted' })
    expect(decidePolicy(working, '{"mode":"observe"}', null)).toMatchObject({ source: 'working', policy: 'no-base', cfg: { mode: 'observe' } })
    expect(decidePolicy(null, null, null)).toBe(null)
    // A base copy that does not parse is still the base's: its defaults, enforce.
    expect(decidePolicy(working, '{"mode":"observe"}', '{ not json')).toMatchObject({ source: 'base', cfg: { mode: 'enforce' } })
  })
})

// ---------------------------------------------------------------- 2. the stateless core

describe('D1 2. the stateless core judges a call with the module\'s rule functions', () => {
  test('secrets anywhere, for reads too; a search that targets them', () => {
    expect(rulesOf({ tool: 'Read', input: { file_path: '/repo/.env' } })).toEqual(['secret'])
    expect(rulesOf({ tool: 'Read', input: { file_path: '/repo/src/a.ts' } })).toEqual([])
    expect(rulesOf({ tool: 'Glob', input: { pattern: '**/*.pem' } })).toEqual(['secret'])
    // A link is judged by where it leads.
    expect(rulesOf({ tool: 'Read', input: { file_path: '/repo/notes.txt' } }, { realOf: () => [{ spelled: '/repo/.env', abs: '/repo/.env', rel: '.env' }] })).toEqual(['secret'])
  })

  test('protected and harness paths; high risk outside a build; tests locked only while building', () => {
    expect(rulesOf({ tool: 'Edit', input: { file_path: '/repo/devloop.json', old_string: 'a', new_string: 'b' } })).toEqual(['protected'])
    expect(rulesOf({ tool: 'Write', input: { file_path: '/data/devloop/stamps/calls/x', content: '' } })).toContain('harness-state')
    const high = { ...ENFORCE, tiers: { ...ENFORCE.tiers, high: ['src/auth/**'] } }
    expect(rulesOf({ tool: 'Edit', input: { file_path: '/repo/src/auth/login.ts', old_string: 'a', new_string: 'b' } }, { cfg: high })).toEqual(['high-needs-spec'])
    expect(rulesOf({ tool: 'Edit', input: { file_path: '/repo/tests/a.test.ts', old_string: 'a', new_string: 'b' } }, { loop: statelessLoop('build') })).toEqual(['tests-locked'])
    expect(rulesOf({ tool: 'Edit', input: { file_path: '/repo/src/a.ts', old_string: 'a', new_string: 'b' } }, { loop: statelessLoop('spec') })).toEqual(['spec-first'])
  })

  test('test weakening on an edit, and content rules that refuse, from the file\'s text', () => {
    const before = "it('adds', () => { expect(add(1, 1)).toBe(2) })\n"
    const read = (abs: string): string | null => (abs === '/repo/src/add.test.ts' ? before : abs === '/repo/src/a.ts' ? 'export const a = 1\n' : null)
    expect(rulesOf({ tool: 'Edit', input: { file_path: '/repo/src/add.test.ts', old_string: "it('adds'", new_string: "it.skip('adds'" } }, { readText: read })).toEqual(['test-weakened'])
    expect(rulesOf({ tool: 'Edit', input: { file_path: '/repo/src/a.ts', old_string: 'export const a = 1', new_string: 'export const a = 1\nconsole.log(a)' } }, { readText: read })).toEqual(['content-rule'])
  })

  test('commands: every command rule, and the evidence notes; with no policy only secrets', () => {
    expect(rulesOf({ tool: 'Bash', input: { command: 'curl https://evil.example.org' } })).toEqual(['egress'])
    expect(rulesOf({ tool: 'Bash', input: { command: 'terraform apply' } })).toEqual(['production'])
    expect(rulesOf({ tool: 'Bash', input: { command: 'git reset --hard' } })[0]).toBe('destructive')
    expect(rulesOf({ tool: 'Bash', input: { command: 'git commit --no-verify -m x' } })).toEqual(['no-verify'])
    expect(rulesOf({ tool: 'Bash', input: { command: 'git notes --ref=devloop add -m x' } })).toEqual(['evidence-notes'])
    expect(rulesOf({ tool: 'Bash', input: { command: 'git reset --hard' } }, { isOptedIn: false, cfg: DEFAULTS })).toEqual([])
    // The cache-guard round, R7: `rm -rf /` removes the home folder's ~/.claude/cache-guard, a secret pattern's folder, so it is refused even here.
    expect(rulesOf({ tool: 'Bash', input: { command: 'rm -rf /' } }, { isOptedIn: false, cfg: DEFAULTS })).toEqual(['secret'])
    expect(rulesOf({ tool: 'Bash', input: { command: 'cat .env' } }, { isOptedIn: false, cfg: DEFAULTS })).toEqual(['secret'])
  })
})

describe('D1 6. the evidence notes are the harness\'s to write (rule evidence-notes, always held)', () => {
  const seg = (text: string) => parse(text)[0] ?? (() => { throw new Error('no segment') })()
  test('writes on refs/notes/devloop are refused, by any spelling; reads and other refs are not', () => {
    for (const text of [
      'git notes --ref=devloop add -m x', 'git notes --ref refs/notes/devloop append -m x', 'git -c core.notesRef=refs/notes/devloop notes add -m x',
      'GIT_NOTES_REF=refs/notes/devloop git notes edit', 'git notes --ref=devloop remove HEAD', 'git update-ref refs/notes/devloop abc',
      'git push origin refs/notes/devloop', 'git push origin "refs/notes/*"', 'git push --mirror origin',
    ]) {
      expect([text, evidenceNotesWrite(seg(text)) !== null]).toEqual([text, true])
    }
    // Final round (D2 F10): a fetch into the ref is refused now (it moved to the list above's rule, tests/final.test.ts); a fetch of it to FETCH_HEAD is not.
    expect(evidenceNotesWrite(seg('git fetch origin refs/notes/devloop:refs/notes/devloop'))).toMatch(/a fetch into refs\/notes\/devloop/)
    for (const text of ['git notes --ref=devloop show HEAD', 'git notes --ref=devloop list', 'git notes add -m x', 'git notes --ref=review add -m x', 'git push origin feature', 'git fetch origin refs/notes/devloop']) {
      expect([text, evidenceNotesWrite(seg(text))]).toEqual([text, null])
    }
  })

  test('it holds in observe mode, no exemption lifts it, and the notes ref folder is protected', () => {
    const observe = cfgOf({ mode: 'observe' })
    expect(judgeCommand('git notes --ref=devloop add -m forged', observe, { ...FRESH, allow: [{ kind: 'command', value: 'git notes --ref=devloop add -m forged', turnId: null }] }, where)?.rule).toBe('evidence-notes')
    expect(rulesOf({ tool: 'Write', input: { file_path: '/repo/.git/refs/notes/devloop', content: 'abc' } })).toEqual(['protected'])
  })
})

describe('D1 8. a gh ship naming another repository is refused, like a ship from another directory', () => {
  test('repoSlug reads every spelling of a repository', () => {
    expect(repoSlug('Acme/App')).toBe('acme/app')
    expect(repoSlug('github.com/acme/app')).toBe('acme/app')
    expect(repoSlug('https://github.com/acme/app.git')).toBe('acme/app')
    expect(repoSlug('git@github.com:acme/app.git')).toBe('acme/app')
  })

  test('-R/--repo naming another repository, or with the remote unknown, is refused; this one\'s remote is not', () => {
    const here = { ...where, remote: 'acme/app' }
    expect(shipElsewhere('gh pr create -R other/app --fill', here, 'main')?.rule).toBe('gate')
    expect(shipElsewhere('gh pr create --repo=other/app', here, 'main')?.rule).toBe('gate')
    expect(shipElsewhere('gh pr create -R acme/app --fill', here, 'main')).toBe(null)
    expect(shipElsewhere('gh pr create -R acme/app', { ...here, remote: null }, 'main')?.rule).toBe('gate')
    expect(shipElsewhere('gh issue list -R other/app', here, 'main')).toBe(null)
    expect(shipLookups('gh pr create -R other/app')).toEqual({ isShip: true, hasMerge: false, hasRepoFlag: true })
    expect(shipLookups('git merge feature')).toEqual({ isShip: true, hasMerge: true, hasRepoFlag: false })
  })
})

describe('D1 3. shipping rules shared by the module and the classic hook', () => {
  test('a merge is a person\'s; another branch ships what the gate never saw; a push to the default branch by its files', () => {
    const cfg = cfgOf({})
    expect(shipRules(shippingOf('gh pr merge 3', 'feature', 'main'), 'feature', cfg, 'medium', {})?.rule).toBe('human-merge')
    expect(shipRules(shippingOf('git push origin other', 'feature', 'main'), 'feature', cfg, 'medium', {})?.rule).toBe('gate')
    expect(shipRules(shippingOf('git push origin main', 'main', 'main'), 'main', cfg, 'medium', { HEAD: ['src/a.ts'] })?.rule).toBe('human-merge')
    expect(shipRules(shippingOf('git push origin main', 'main', 'main'), 'main', cfg, 'medium', { HEAD: null })?.rule).toBe('human-merge')
    expect(shipRules(shippingOf('git push -u origin HEAD', 'feature', 'main'), 'feature', cfg, 'medium', {})).toBe(null)
    // A merge on a feature branch ships nothing.
    expect(shippingOf('git merge main', 'feature', 'main')).toEqual([])
  })
})

// ---------------------------------------------------------------- 3. stamps, heartbeat, inbox

describe('D1 3. the stamps and heartbeat the module and the classic hooks share', () => {
  test('one state root, found the same way; ids made safe as path parts', () => {
    expect(stateRootFrom('/data/devloop/')).toBe('/data/devloop')
    expect(stateRootFrom(undefined)).toBe(STATE_FALLBACK)
    expect(stateRootFrom('')).toBe('/tmp/devloop-state')
    expect(stampPath('/d', 'toolu_01ABC')).toBe('/d/stamps/calls/toolu_01ABC')
    expect(stampPath('/d', '../../etc/passwd')).not.toMatch(/\.\./)
    expect(heartbeatPath('/d', 's1')).toBe('/d/stamps/live/s1')
    expect(stopStampPath('/d', 's1')).toBe('/d/stamps/stops/s1')
    expect(inboxPath('/d', '/repo')).toBe(`${repoStateDir('/d', '/repo')}/classic-inbox.jsonl`)
  })

  test('a stop\'s key is the same for the same input and differs between stops', () => {
    const one = { session_id: 's', prompt_id: 'p', last_assistant_message: 'done', stop_hook_active: false }
    expect(stopKey(one)).toBe(stopKey({ ...one, transcript_path: '/elsewhere' } as never))
    expect(stopKey(one)).not.toBe(stopKey({ ...one, last_assistant_message: 'fixed it' }))
    expect(stopKey(one)).not.toBe(stopKey({ ...one, stop_hook_active: true }))
  })

  test('the inbox keeps the lines that parse', () => {
    const text = [JSON.stringify({ at: 1, kind: 'module-skipped', session: 's', tool: 'Bash', subject: 'ls', rule: null }), 'not json', '', JSON.stringify({ nope: 1 })].join('\n')
    expect(readInbox(text).map(one => one.kind)).toEqual(['module-skipped'])
  })
})

// ---------------------------------------------------------------- 4. sandbox

describe('D1 4. sandbox settings from the same policy', () => {
  test('the block: hosts from network.allow, secrets denied reads, protected paths and the harness state denied writes', () => {
    const block = sandboxSettings(ENFORCE, '/data/devloop').sandbox
    expect(block.enabled).toBe(true)
    expect(block.allowUnsandboxedCommands).toBe(false)
    expect(block.network?.allowedDomains).toEqual(['github.com'])
    expect(block.filesystem.denyRead).toContain('.env')
    expect(block.filesystem.denyWrite).toEqual(expect.arrayContaining(['devloop.json', '**/.git/hooks/**', '/data/devloop']))
    expect(sandboxSettings(cfgOf({}), '/d').sandbox.network).toBeUndefined()
  })

  test('doctor compares what the settings configure, and warns of what weakens the sandbox', () => {
    const settings = JSON.stringify({ sandbox: {
      enabled: true, excludedCommands: ['docker *'], enableWeakerNestedSandbox: true,
      network: { allowedDomains: ['github.com', '*.com', '*.amazonaws.com', 'npmjs.org'], allowUnixSockets: ['/var/run/docker.sock'] },
      filesystem: { allowWrite: ['~/.bashrc', '/usr/local/bin'], denyRead: ['.env'] },
    } })
    const { found } = sandboxOf([{ name: '.claude/settings.json', text: settings }, { name: '.claude/settings.local.json', text: null }])
    const said = compareSandbox(found, ENFORCE, '/d', { home: '/home/u', pathDirs: ['/usr/local/bin', '/usr/bin'] }).map(one => one.text).join('\n')
    expect(said).toMatch(/allows hosts devloop.json's network.allow does not name: \*\.com, \*\.amazonaws\.com, npmjs\.org/)
    expect(said).toMatch(/\*\.com is broad/)
    expect(said).toMatch(/\*\.amazonaws\.com is broad/)
    expect(said).toMatch(/container socket is reachable \(\/var\/run\/docker\.sock\)/)
    expect(said).toMatch(/writes are allowed to ~\/\.bashrc \(a shell start-up file\)/)
    expect(said).toMatch(/writes are allowed to \/usr\/local\/bin \(\/usr\/local\/bin is on \$PATH\)/)
    expect(said).toMatch(/allowUnsandboxedCommands is not false/)
    expect(said).toMatch(/excludedCommands run outside the sandbox: docker \*/)
    expect(said).toMatch(/enableWeakerNestedSandbox is on/)
    expect(said).toMatch(/protected paths are not denied writes/)
    expect(compareSandbox({}, ENFORCE, '/d', { home: null, pathDirs: [] })[0]?.text).toMatch(/not enabled/)
    expect(isBroadDomain('github.com')).toBe(false)
    expect(isBroadDomain('*.github.com')).toBe(false)
    expect(isBroadDomain('*')).toBe(true)
  })
})

// ---------------------------------------------------------------- 5. the pre-push hook

describe('D1 5. the opt-in pre-push hook', () => {
  test('its text runs a chained hook first, then the gate; no node refuses', () => {
    const text = prePushHook("/plug/it's/dist/devloop.mjs")
    expect(text.split('\n')[1]).toBe(HOOK_MARK)
    expect(text).toMatch(new RegExp(`pre-push${CHAINED_SUFFIX}" "\\$@" \\|\\| exit \\$\\?`))
    expect(text).toMatch(/node '\/plug\/it'\\''s\/dist\/devloop\.mjs' gate/)
    expect(text).toMatch(/command -v node/)
  })

  test('what install and remove said, in a person\'s words', () => {
    expect(hookOutcome('installed-chained:/r/.git/hooks/pre-push\n', 0)).toMatchObject({ isDone: true })
    expect(hookOutcome('busy:/r/.git/hooks/pre-push.devloop-chained', 4)).toMatchObject({ isDone: false })
    expect(hookOutcome('foreign:/r/.git/hooks/pre-push', 0).text).toMatch(/not the harness's/)
    expect(hookOutcome('', 3).text).toMatch(/Not a git repository/)
  })
})

// ---------------------------------------------------------------- 6. portable evidence and the stateless gate

const NOTE = (more: Partial<EvidenceNote> = {}): EvidenceNote => ({
  schema: 'evidence@2', at: 1, why: 'review', tree: 't1', head: 'h1', policy: 'p', checks: [{ run: 'npm test', tree: 't1' }],
  reviewers: [{ name: 'general', mode: 'general', verdict: 'pass', round: 1 }], open: 0, checklistFails: [], harness: '0.2.0', ...more,
})

describe('D1 6. portable evidence', () => {
  test('the record names the tree, the checks that passed on it and each reviewer\'s verdict', () => {
    const note = evidenceNote({
      at: 5, why: 'done', tree: 't1', committable: 't1', head: 'h1', policy: 'p', passedOn: { 'npm test': 't1', 'npm run e2e': 't0' }, open: 0, verdicts: { general: 'pass', security: 'fail' },
      review: { status: 'pass', round: 2, tree: 't1', agents: [{ agentId: 'a', name: 'general', mode: 'general', isRetry: false, answer: '' }, { agentId: 'b', name: 'security', mode: 'blocking', isRetry: false, answer: '' }] },
    })
    expect(validate('evidence@2', note)).toEqual([])
    expect(note.checks).toEqual([{ run: 'npm test', tree: 't1' }])
    expect(note.reviewers.map(one => `${one.name}:${one.verdict}`)).toEqual(['general:pass', 'security:fail'])
    // A review of another tree names no reviewer.
    expect(evidenceNote({ ...{ at: 5, why: 'done', tree: 't2', committable: 't2', head: 'h1', policy: 'p', passedOn: {}, open: 0, verdicts: {} }, review: { status: 'pass', round: 1, tree: 't1', agents: [] } }).reviewers).toEqual([])
    expect(parseEvidence(JSON.stringify(note))).toEqual(note)
    expect(parseEvidence('{"schema":"evidence@2"}')).toBe(null)
    expect(parseEvidence('not json')).toBe(null)
  })

  test('a review row is met only from a note that names this tree, this reviewer and a pass', () => {
    // Final round (D1 F7): the policy hash in force is passed too; here it is the note's own, 'p'.
    expect(reviewRowFrom('Independent review', 'general', NOTE(), 't1', 'p').isMet).toBe(true)
    expect(reviewRowFrom('Independent review', 'general', NOTE(), 't2', 'p')).toMatchObject({ isMet: false, note: expect.stringMatching(/names tree t1/) })
    expect(reviewRowFrom('Independent review', 'general', null, 't1', 'p').isMet).toBe(false)
    expect(reviewRowFrom('Review: security', 'security', NOTE(), 't1', 'p')).toMatchObject({ isMet: false, note: expect.stringMatching(/names no security review/) })
    expect(reviewRowFrom('Independent review', 'general', NOTE({ open: 1 }), 't1', 'p').isMet).toBe(false)
    expect(reviewRowFrom('Independent review', 'general', NOTE({ reviewers: [{ name: 'general', mode: 'general', verdict: 'fail', round: 1 }] }), 't1', 'p').isMet).toBe(false)
  })

  test('the stateless gate: the module\'s rows, review from the note, never claiming a row it cannot prove', () => {
    const cfg = cfgOf({ verify: ['npm test', { run: 'npm run e2e', profile: 'full' }] })
    // Final round: the note is keyed on the committable tree, and on the policy in force (D1 F4, F7).
    const proof: TreeProof = { tree: 't1', committable: 't1', base: 'b', files: ['src/a.ts'], lines: 4, runs: [{ run: 'npm test', isPassing: true, outcome: 'pass', output: '' }, { run: 'npm run e2e', isPassing: true, outcome: 'pass', output: '' }], credentials: [], hidden: [], isScanned: true, note: NOTE() }
    const facts = { errors: [], lint: [], policy: 'same' as const }
    const green = statelessGate({ ...proof, note: NOTE({ policy: policyHash(cfg) }) }, cfg, facts)
    expect(green.isGreen).toBe(true)
    expect(green.loop.tier).toBe('medium')
    expect(statelessGate({ ...proof, note: null }, cfg, facts).isGreen).toBe(false)
    expect(statelessGate({ ...proof, note: NOTE({ tree: 't0' }) }, cfg, facts).isGreen).toBe(false)
    // A check not run, or failing, keeps Verification unmet.
    expect(statelessGate({ ...proof, runs: proof.runs.slice(0, 1) }, cfg, facts).rows.find(row => row.label === 'Verification')?.isMet).toBe(false)
    expect(statelessGate({ ...proof, runs: [{ run: 'npm test', isPassing: false, outcome: 'fail', output: '' }] }, cfg, facts).rows.find(row => row.label === 'Verification')?.note).toMatch(/failing: npm test/)
    // Unscanned is unmet; a credential is named by file and kind.
    expect(statelessGate({ ...proof, isScanned: false }, cfg, facts).isGreen).toBe(false)
    expect(statelessGate({ ...proof, credentials: [{ file: 'src/a.ts', line: 2, kind: 'aws-key' }] }, cfg, facts).rows.find(row => row.label === 'No credentials in the diff')?.isMet).toBe(false)
    // A policy error shuts it; a low-risk change needs no review evidence.
    expect(statelessGate(proof, cfg, { ...facts, errors: ['unknown key "x"'] }).isGreen).toBe(false)
    const low = cfgOf({ verify: ['npm test'], tiers: { low: ['docs/**'] } })
    expect(statelessGate({ ...proof, files: ['docs/a.md'], runs: [proof.runs[0] as never], note: null }, low, facts).isGreen).toBe(true)
    // Instruction files with hidden characters keep it shut.
    expect(statelessGate({ ...proof, files: ['CLAUDE.md'], hidden: [{ file: 'CLAUDE.md', line: 1, kind: 'invisible' }] }, cfg, facts).rows.find(row => row.label === 'Instruction files changed')?.isMet).toBe(false)
  })

  test('the instruction-files listing is read the same by the module and the command line', () => {
    expect(readInstructionFiles('t CLAUDE.md\nu AGENTS.md\ni .claude/rules/x.md\ncapped:900\n')).toEqual({ files: [{ path: 'CLAUDE.md', kind: 't' }, { path: 'AGENTS.md', kind: 'u' }, { path: '.claude/rules/x.md', kind: 'i' }], capped: 900 })
  })
})

// ---------------------------------------------------------------- the module side, through the test world

const stamps = (w: World, kind: 'calls' | 'live' | 'stops'): string[] => Object.keys(w.files).filter(file => file.startsWith(`/data/devloop/stamps/${kind}/`))

describe('D1 3. the module stamps what it judged and keeps a heartbeat', () => {
  test('a heartbeat at the session\'s start and each turn; a stamp for each call it let go on, none for one it refused', async ($, on) => {
    const w = world(on)
    await start($)
    expect(stamps(w, 'live')).toEqual(['/data/devloop/stamps/live/s1'])
    await bash($, 'ls')
    expect(stamps(w, 'calls').length).toBe(1)
    await bash($, 'cat .env')
    expect(stamps(w, 'calls').length).toBe(1)
    await edit($, '/repo/src/a.ts')
    expect(stamps(w, 'calls').length).toBe(2)
    w.now = 5000
    await $.turn.start({ turnId: 't2' } as never)
    expect(w.files['/data/devloop/stamps/live/s1']).toBe('5000')
  })

  test('the stop is stamped with its key before the classic Stop hooks run', async ($, on) => {
    const w = world(on)
    await start($)
    await stop($)
    expect(w.files['/data/devloop/stamps/stops/s']).toBe(stopKey({ session_id: 's', stop_hook_active: false }))
  })

  test('a dormant repository is stamped too, so the classic hook stands down without reading git', async ($, on) => {
    const w = world(on, null)
    await start($)
    await bash($, 'ls')
    expect(stamps(w, 'calls').length).toBe(1)
  })
})

describe('D1 3. what the classic hooks recorded reaches the ledger and the audit trail', () => {
  test('module-skipped and module-absent events are folded once, with a toast for skips', async ($, on) => {
    const w = world(on)
    await start($)
    const inbox = inboxPath('/data/devloop', '/repo')
    w.files[inbox] = [
      { at: 1, kind: 'module-skipped', session: 's1', tool: 'Bash', subject: 'git push', rule: null },
      { at: 2, kind: 'classic-refusal', session: 's1', tool: 'Bash', subject: 'curl x', rule: 'egress' },
    ].map(one => JSON.stringify(one)).join('\n')
    await prompt($)
    expect(w.toasts.join(' ')).toMatch(/did not judge 1 call/)
    const ledger = (w.store['ledger:/repo'] as { kind: string }[]).map(one => one.kind)
    expect(ledger).toEqual(expect.arrayContaining(['module-skipped', 'classic-deny']))
    const audit = await devloop($, 'audit 20')
    expect(audit).toMatch(/module-skipped/)
    // Folded once: a second prompt adds nothing.
    const before = w.toasts.length
    await prompt($)
    expect(w.toasts.length).toBe(before)
  })
})

describe('D1 4, 5. the new commands', () => {
  test('/devloop sandbox prints the block and writes nothing', async ($, on) => {
    const w = world(on, { ...CONFIG, network: { allow: ['github.com'] } })
    await start($)
    const files = Object.keys(w.files).length
    const said = await devloop($, 'sandbox')
    expect(said).toMatch(/"allowedDomains": \[\n\s+"github.com"/)
    expect(said).toMatch(/Nothing was written/)
    expect(Object.keys(w.files).length).toBe(files)
  })

  test('/devloop hooks install and remove are a person\'s, with a dialog, and audited', async ($, on) => {
    const w = world(on)
    w.hookEnv = { CLAUDE_PLUGIN_ROOT: '/plug' }
    await start($)
    for (const origin of [{ kind: 'sdk' as const }, { kind: 'plugin' as const, name: 'other' }]) {
      expect(await devloop($, 'hooks install', origin)).toMatch(/by a person/)
      expect(await devloop($, 'hooks remove', origin)).toMatch(/by a person/)
    }
    expect(w.scripts.filter(one => one.startsWith('hook-'))).toEqual([])
    w.answer = 'Leave it'
    expect(await devloop($, 'hooks install')).toMatch(/Nothing was changed/)
    // Final round (D1 F6): only where git runs hooks from is read before the dialog, so the dialog can name it; nothing is written.
    expect(w.scripts.filter(one => one.startsWith('hook-'))).toEqual(['hook-where'])
    expect(w.questions.at(-1)).toMatch(/node \/plug\/dist\/devloop.mjs gate/)
    w.answer = 'Install it'
    expect(await devloop($, 'hooks install')).toMatch(/Installed a pre-push hook/)
    expect(await devloop($, 'audit 5')).toMatch(/git-hook-installed/)
    w.answer = 'Remove it'
    expect(await devloop($, 'hooks remove')).toMatch(/Removed the devloop pre-push hook/)
    expect(await devloop($, 'audit 5')).toMatch(/git-hook-removed/)
    expect(await devloop($, 'help')).toMatch(/\/devloop hooks install/)
  })
})

describe('D1 8. /devloop eval validates out-of-date tasks only after the person confirms', () => {
  test('declining the run validates nothing; confirming validates, then runs', async ($, on) => {
    const w = world(on)
    w.files['/repo/evals/tasks/a.json'] = JSON.stringify({ prompt: 'p', check: 'check a' })
    w.lists['/repo/evals/tasks'] = ['a.json']
    w.exits['check a'] = 1
    await start($)
    w.answer = 'Not now'
    expect(await devloop($, 'eval')).toMatch(/No run started/)
    expect(w.questions.at(-1)).toMatch(/validation is out of date \(a\)/)
    expect(w.scripts.filter(one => one === 'eval-make')).toEqual([])
    expect(w.ran).not.toContain('check a')
    w.answer = 'Start the run'
    expect(await devloop($, 'eval')).toMatch(/Eval run started|no task is valid/)
    expect(w.scripts.filter(one => one === 'eval-make').length).toBeGreaterThan(0)
  })
})

describe('D1 6. the harness writes portable evidence for the reviewed tree', () => {
  test('/devloop done writes evidence@2 as a git note on HEAD, naming the reviewed tree and each verdict', async ($, on) => {
    const w = world(on)
    w.changed = ['src/a.ts']
    w.store['loop:/repo'] = {
      shape: 'loop-12',
      value: {
        ...FRESH, root: '/repo', sessionId: 'earlier', tree: 't0', changed: ['src/a.ts'], tier: 'medium', size: { files: 1, lines: 3 },
        verify: { ...FRESH.verify, status: 'pass', tree: 't0', profile: 'full', passedOn: { 'npm test': 't0' } },
        review: { ...FRESH.review, status: 'pass', round: 1, tree: 't0', agents: [{ agentId: 'a1', name: 'general', mode: 'general', isRetry: false, answer: '' }] },
      },
    }
    await start($)
    w.answer = 'Close anyway'
    const said = await devloop($, 'done')
    expect(said).toMatch(/Wrote portable evidence for tree t0/)
    const [tree, text] = w.scriptArgs['note-write'] ?? []
    expect(tree).toBe('t0')
    const note = JSON.parse(text ?? '{}') as EvidenceNote
    expect(validate('evidence@2', note)).toEqual([])
    expect(note).toMatchObject({ why: 'done', tree: 't0', head: 'abc', checks: [{ run: 'npm test', tree: 't0' }], reviewers: [{ name: 'general', verdict: 'pass', round: 1 }], open: 0 })
    expect(await devloop($, 'audit 20')).toMatch(/evidence-noted/)
  })

  test('a HEAD whose tree is not the reviewed one gets no note, and the person is told why', async ($, on) => {
    const w = world(on)
    w.changed = ['src/a.ts']
    w.outputs['note-write'] = 'tree:ffffffffff\n'
    w.exits['note-write'] = 4
    w.store['loop:/repo'] = {
      shape: 'loop-12',
      value: {
        ...FRESH, root: '/repo', sessionId: 'earlier', tree: 't0', changed: ['src/a.ts'], tier: 'medium', size: { files: 1, lines: 3 },
        verify: { ...FRESH.verify, status: 'pass', tree: 't0', profile: 'full', passedOn: { 'npm test': 't0' } },
        review: { ...FRESH.review, status: 'pass', round: 1, tree: 't0', agents: [{ agentId: 'a1', name: 'general', mode: 'general', isRetry: false, answer: '' }] },
      },
    }
    await start($)
    w.answer = 'Close anyway'
    expect(await devloop($, 'done')).toMatch(/No evidence note: HEAD's tree \(ffffffff\) is not the reviewed tree/)
  })
})
