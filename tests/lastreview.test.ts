import { describe, expect, test } from 'claude-code/testing'

import { parseConfig } from '../hooks/config'
import type { Config } from '../hooks/config'
import { COMMIT_OR_STASH, pushSends, shippingOf, shipRules } from '../hooks/enforce'
import { gate } from '../hooks/gate'
import { digest } from '../hooks/output'
import { evidenceNote, reviewRowFrom, statelessGate } from '../hooks/portable'
import type { EvidenceNote } from '../hooks/portable'
import { validate } from '../hooks/records'
import { judgeCommand, reviewerMayRun, whereOf } from '../hooks/rules'
import type { Placed } from '../hooks/rules'
import { FRESH } from '../hooks/state'
import type { Loop } from '../types'
import { bash, devloop, edit, start, stop, world } from './world'
import type { Dollar, World } from './world'

// The last review (docs/reviews/final-fix.md): each finding's closing
// evidence. F1 is proven against real processes in tests/smoke.sh (a pass
// made under a doctored PATH by `verify`, the hook's own resumable passes);
// F3 to F6 and F8 are rows of the parity table (tests/parity-table.ts),
// with their harmless neighbours in the ordinary-commands table.

const cfgOf = (raw: object = {}): Config => parseConfig(JSON.stringify(raw)).cfg
const SEEN = { hidden: [] as string[], differs: [] as { path: string; isUntracked: boolean }[], differCount: 0 }

// ---------------------------------------------------------------- F2: files hidden from git

describe('F2: an index entry git is told not to look at keeps the gate shut and refuses a push, at every point', () => {
  test('pure: pushSends names the hidden files; the gate row is unmet and names them', () => {
    const refused = pushSends('c1', [{ tree: 'c1', isHead: true }], { ...SEEN, hidden: ['src/a.ts', 'src/b.ts'] })
    expect(refused?.rule).toBe('gate')
    expect(refused?.reason).toMatch(/^Files hidden from git: .*src\/a\.ts, src\/b\.ts .*skip-worktree or assume-unchanged/)
    // Without one, the same trees go.
    expect(pushSends('c1', [{ tree: 'c1', isHead: true }], SEEN)).toBe(null)
    const rows = gate({ ...FRESH, tree: 't1', isBaseKnown: true }, cfgOf(), { errors: [], lint: [], policy: 'same', hiddenFromGit: ['src/a.ts'] })
    expect(rows.find(row => row.label === 'Files hidden from git')).toMatchObject({ isMet: false, note: expect.stringMatching(/^src\/a\.ts carries the skip-worktree/) })
    expect(gate({ ...FRESH, tree: 't1', isBaseKnown: true }, cfgOf(), { errors: [], lint: [], policy: 'same' }).some(row => row.label === 'Files hidden from git')).toBe(false)
  })

  test('pure: the stateless gate (the command line) shows the row from the snapshot', () => {
    const proof = { tree: 't1', committable: 't1', base: 'b', files: [], lines: 0, runs: [], credentials: [], hidden: [], isScanned: true, note: null }
    const proven = statelessGate(proof, cfgOf({ verify: ['npm test'] }), { errors: [], lint: [], policy: 'same', hiddenFromGit: ['config/local.json'] })
    expect(proven.isGreen).toBe(false)
    expect(proven.rows.find(row => row.label === 'Files hidden from git')?.note).toMatch(/config\/local\.json/)
  })

  test('through the module: the gate row, and a push of a clean committed tree is refused naming the file', async ($, on) => {
    const w = world(on)
    w.hidden = ['src/a.ts']
    await start($)
    expect(await devloop($, 'gate')).toMatch(/\[ \] Files hidden from git: src\/a\.ts/)
    const pushed = await bash($, 'git push -u origin feature')
    expect(pushed.deny).toMatch(/Files hidden from git: git is told not to look at changes to src\/a\.ts/)
    w.hidden = []
    expect((await bash($, 'git push -u origin feature')).deny).toBeUndefined()
  })

  test('the agent may not set the bits; clearing them is fine', () => {
    const cfg = cfgOf({ mode: 'enforce' })
    const at = whereOf('/repo')
    expect(judgeCommand('git update-index --skip-worktree src/a.ts', cfg, FRESH, at)?.rule).toBe('git-hidden')
    expect(judgeCommand('git -C . update-index --assume-unchanged src/a.ts', cfg, FRESH, at)?.rule).toBe('git-hidden')
    expect(judgeCommand('git update-index --skip-worktree src/a.ts', cfg, FRESH, at)?.reason).toMatch(/clearing it, `--no-skip-worktree`, is fine/)
    for (const command of ['git update-index --no-skip-worktree src/a.ts', 'git update-index --no-assume-unchanged src/a.ts', 'git update-index --refresh', 'git ls-files -v']) {
      expect({ command, verdict: judgeCommand(command, cfg, FRESH, at) }).toEqual({ command, verdict: null })
    }
  })
})

// ---------------------------------------------------------------- F3: an earlier export holds

describe('F3: a forbidden value set earlier on the line holds; nothing later cancels it', () => {
  test('the notes ref and the actor variable', () => {
    const cfg = cfgOf()
    const at = whereOf('/repo')
    expect(judgeCommand('export GIT_NOTES_REF=refs/notes/devloop; GIT_NOTES_REF=refs/notes/other true; git notes add -m x', cfg, FRESH, at)?.rule).toBe('evidence-notes')
    expect(judgeCommand('export GIT_NOTES_REF=refs/notes/devloop && unset GIT_NOTES_REF && GIT_NOTES_REF=x git notes add -m x', cfg, FRESH, at)?.rule).toBe('evidence-notes')
    // A ref named on the command itself decides: git uses it over the variable.
    expect(judgeCommand('export GIT_NOTES_REF=refs/notes/devloop; git notes --ref=review add -m x', cfg, FRESH, at)).toBe(null)
  })
})

// ---------------------------------------------------------------- F8: a push names its source

describe('F8: a push that names no source is refused with the advice; a push of the branch is judged as before', () => {
  const cfg = cfgOf({ mode: 'enforce' })
  const rules = (text: string) => shipRules(shippingOf(text, 'feature', 'main'), 'feature', cfg, 'low', {})

  test('pure, the shared shipping rules', () => {
    for (const text of ['git push --all origin', 'git push --branches origin', 'git push origin --tags', 'git push --follow-tags origin feature']) {
      expect({ text, rule: rules(text)?.rule }).toEqual({ text, rule: 'gate' })
    }
    // Since the cache-guard round (R1), the refusal is the push shape's, which names what is wrong and the command to run instead.
    expect(rules('git push --tags origin')?.reason).toMatch(/--tags, which names no source.*git push -u origin HEAD.*git push -u origin feature.*Tags, other branches .* are a person's/)
    // The nearest harmless pushes: the gate judges them as before, no rule before it.
    for (const text of ['git push origin feature', 'git push -u origin HEAD', 'git push --dry-run origin feature', 'git push --no-follow-tags origin feature']) {
      expect({ text, verdict: rules(text) }).toEqual({ text, verdict: null })
    }
    // A tag by name is no push of the branch the agent is on: refused as before (a person pushes tags).
    expect(rules('git push origin v1.0')?.rule).toBe('gate')
  })
})

// ---------------------------------------------------------------- F9: the refusal says what differs and what works

describe('F9: "commit or stash first" names the files, marks the untracked ones, and gives the three remedies', () => {
  test('pure, on its words', () => {
    const reason = pushSends('c1', [{ tree: 'h0', isHead: true }], {
      hidden: [], differCount: 7,
      differs: [{ path: 'src/a.ts', isUntracked: false }, { path: 'notes.txt', isUntracked: true }, { path: 'b', isUntracked: false }, { path: 'c', isUntracked: false }, { path: 'd', isUntracked: true }],
    })?.reason ?? ''
    expect(reason).toMatch(/^Commit or stash first: .*judge files this push does not send/)
    expect(reason).toMatch(/The files that differ from the last commit: src\/a\.ts, notes\.txt \(untracked\), b, c, d \(untracked\), and 2 more\./)
    expect(reason).toContain('`git stash -u` (a plain `git stash` leaves untracked files behind)')
    expect(reason).toContain(COMMIT_OR_STASH)
    expect(reason).toMatch(/Commit them .* stash them .* or ignore them/)
  })

  test('through the module', async ($, on) => {
    const w = world(on)
    w.committable = 'c1'
    w.headTree = 'h0'
    w.differs = ['u scratch.txt']
    await start($)
    expect((await bash($, 'git push -u origin feature')).deny).toMatch(/scratch\.txt \(untracked\).*git stash -u/)
  })
})

// ---------------------------------------------------------------- F7: the evidence note records a promoted checklist failure

const NOTE = (more: Partial<EvidenceNote> = {}): EvidenceNote => ({
  schema: 'evidence@2', at: 1, why: 'review', tree: 't1', head: 'h1', policy: 'p', checks: [],
  reviewers: [{ name: 'general', mode: 'general', verdict: 'pass', round: 1 }], open: 0, checklistFails: [], harness: '0.2.0', ...more,
})

describe('F7: a round with a promoted checklist failure writes evidence that says so', () => {
  test('pure: the note records the items, and the stateless review row is unmet from it', () => {
    const note = evidenceNote({
      at: 1, why: 'review', tree: 't1', committable: 't1', head: 'h1', policy: 'p', passedOn: {}, open: 0, verdicts: { general: 'pass' },
      review: { status: 'pass', round: 1, tree: 't1', agents: [{ agentId: 'a', name: 'general', mode: 'general', isRetry: false, answer: '' }] }, checklistFails: ['login-form/rate-limit'],
    })
    expect(validate('evidence@2', note)).toEqual([])
    expect(note.checklistFails).toEqual(['login-form/rate-limit'])
    expect(reviewRowFrom('Independent review', 'general', NOTE({ checklistFails: ['login-form/rate-limit'] }), 't1', 'p')).toMatchObject({ isMet: false, note: expect.stringMatching(/a failing verdict: .*login-form\/rate-limit/) })
    expect(reviewRowFrom('Independent review', 'general', NOTE(), 't1', 'p').isMet).toBe(true)
    // An evidence@1 note (no checklist field) proves nothing any more.
    expect(validate('evidence@2', { ...NOTE(), schema: 'evidence@1' }).length).toBeGreaterThan(0)
  })

  test('through the module: /devloop done writes the failing items into the note', async ($, on) => {
    const w = world(on)
    w.changed = ['src/a.ts']
    w.store['loop:/repo'] = {
      shape: 'loop-13',
      value: {
        ...FRESH, root: '/repo', sessionId: 'earlier', tree: 't0', changed: ['src/a.ts'], tier: 'medium', size: { files: 1, lines: 3 },
        verify: { ...FRESH.verify, status: 'pass', tree: 't0', profile: 'full', passedOn: { 'npm test': 't0' } },
        review: { ...FRESH.review, status: 'pass', round: 1, tree: 't0', agents: [{ agentId: 'a1', name: 'general', mode: 'general', isRetry: false, answer: '' }] },
        checklistFails: [{ ref: 'login-form/rate-limit', note: 'failed on this tree (no limit found)', tree: 't0' }],
      } satisfies Loop,
    }
    await start($)
    w.answer = 'Close anyway'
    expect(await devloop($, 'done')).toMatch(/Wrote portable evidence for tree t0/)
    const note = JSON.parse(w.scriptArgs['note-write']?.[1] ?? '{}') as EvidenceNote
    expect(validate('evidence@2', note)).toEqual([])
    expect(note.checklistFails).toEqual(['login-form/rate-limit'])
  })
})

// ---------------------------------------------------------------- I1: the harness answers the permission check for its own reviewers

/** Starts a review round on a medium change (the asks of setting it up forgotten); resolves the reviewer's agent id and the round's diff file. */
async function reviewing($: Dollar, w: World, asked: string[]): Promise<{ id: string; diff: string }> {
  await start($)
  w.changed = ['src/a.ts']
  w.tree = 't1'
  await edit($, '/repo/src/a.ts')
  await stop($)
  expect(await devloop($, 'review')).toMatch(/round 1 of 3 started/)
  asked.length = 0

  return { id: w.spawned[w.spawned.length - 1]?.agentId ?? '', diff: `/data/devloop/repos/${digest('/repo')}/review-1.diff` }
}

/** The engine beneath: its own verdict is an ask, and every ask that reaches a person is recorded (and refused, as nobody answers in a test). */
function askingEngine(on: Parameters<typeof world>[0]): string[] {
  const asked: string[] = []
  on('tool.check', () => ({ decision: 'ask' }))
  on('classic.PermissionRequest', (_, e) => {
    asked.push(String((e as { tool_name?: string }).tool_name ?? ''))

    return { hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'deny', message: 'nobody is here' } } } as never
  })

  return asked
}

describe('I1: a reviewer\'s allowed calls are answered without a prompt; nothing else is', () => {
  test('the reviewer reads its diff file and the repository, and runs a check, with no prompt', async ($, on) => {
    const w = world(on)
    const asked = askingEngine(on)
    // (Since the cache-guard round, R6, an answer rests on where the path really lands, so the files are there to resolve.)
    w.files['/repo/src/a.ts'] = 'export const a = 1\n'
    w.files[`/data/devloop/repos/${digest('/repo')}/review-1.diff`] = 'diff --git a/src/a.ts b/src/a.ts\n'
    const { id, diff } = await reviewing($, w, asked)
    expect((await $.tool.call({ tool: 'Read', file_path: diff, agentId: id } as never)).isError).toBeUndefined()
    expect((await $.tool.call({ tool: 'Read', file_path: '/repo/src/a.ts', agentId: id } as never)).isError).toBeUndefined()
    expect((await $.tool.call({ tool: 'Grep', pattern: 'export', path: '/repo/src', agentId: id } as never)).isError).toBeUndefined()
    expect((await $.tool.call({ tool: 'Bash', command: 'npm test', agentId: id } as never)).isError).toBeUndefined()
    expect((await $.tool.call({ tool: 'Bash', command: 'git diff --stat', agentId: id } as never)).isError).toBeUndefined()
    expect(asked).toEqual([])
  })

  test('the builder\'s read of the same file, another subagent\'s, and a reviewer\'s read outside the repository still ask', async ($, on) => {
    const w = world(on)
    const asked = askingEngine(on)
    const { id, diff } = await reviewing($, w, asked)
    expect((await $.tool.call({ tool: 'Read', file_path: diff } as never)).isError).toBe(true)
    expect((await $.tool.call({ tool: 'Read', file_path: diff, agentId: 'agent-other' } as never)).isError).toBe(true)
    expect((await $.tool.call({ tool: 'Read', file_path: '/etc/hosts', agentId: id } as never)).isError).toBe(true)
    expect((await $.tool.call({ tool: 'Read', file_path: `/data/devloop/repos/${digest('/repo')}/review-0.diff`, agentId: id } as never)).isError).toBe(true)
    expect(asked).toEqual(['Read', 'Read', 'Read', 'Read'])
  })

  test('a reviewer\'s command outside the allowlist is still refused (by its guard, before any permission check)', async ($, on) => {
    const w = world(on)
    const asked = askingEngine(on)
    const { id } = await reviewing($, w, asked)
    expect((await $.tool.call({ tool: 'Bash', command: 'npm install left-pad', agentId: id } as never)).deny).toMatch(/reviewer is read-only/)
    expect(asked).toEqual([])
  })

  test('pure: what is answered, and that a secret never is', () => {
    const cfg = cfgOf()
    const where = whereOf('/repo', '/repo', { home: '/home/u' })
    const facts = { where, cfg, diffFile: '/data/r/review-2.diff', checks: ['npm test'], resolve: (path: Placed): Placed[] => [path] }
    expect(reviewerMayRun('Read', { file_path: '/data/r/review-2.diff' }, facts)).toBe(true)
    expect(reviewerMayRun('Read', { file_path: '/data/r/review-1.diff' }, facts)).toBe(false)
    expect(reviewerMayRun('Read', { file_path: '/repo/.env' }, facts)).toBe(false)
    expect(reviewerMayRun('Read', { file_path: '/repo/../etc/x' }, facts)).toBe(false)
    expect(reviewerMayRun('Glob', { pattern: '**/*.ts' }, facts)).toBe(true)
    expect(reviewerMayRun('Glob', { pattern: '**/.env' }, facts)).toBe(false)
    expect(reviewerMayRun('Grep', { pattern: 'x', path: '/home/u' }, facts)).toBe(false)
    expect(reviewerMayRun('Bash', { command: 'npm test' }, facts)).toBe(true)
    expect(reviewerMayRun('Bash', { command: 'cat .env' }, facts)).toBe(false)
    expect(reviewerMayRun('Bash', { command: 'npm test && rm -rf src' }, facts)).toBe(false)
    expect(reviewerMayRun('Edit', { file_path: '/repo/src/a.ts' }, facts)).toBe(false)
  })
})
