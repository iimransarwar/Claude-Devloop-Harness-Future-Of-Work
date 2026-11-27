import { describe, expect, test } from 'claude-code/testing'

import { parseConfig } from '../hooks/config'
import { backstop, firstLine, groundingMode, hedgeIn, isLook, isQuestionOfFact, lastTurn, looksIn, NUDGE, REFUSAL, UNCHECKED } from '../hooks/grounding'
import type { BackstopFacts } from '../hooks/grounding'
import { computeMetrics, metricsLines } from '../hooks/report'
import { RULES } from '../hooks/templates'
import { devloop, edit, prompt, start, world } from './world'
import type { Dollar, World } from './world'

// Grounding (docs/design-notes/grounding.md, DESIGN 4.15): a person's question
// of fact is checked at the source in the turn it is answered. The two pure
// functions every point shares, each with its table, and the module's
// backstop through the test world.

// ---------------------------------------------------------------- the classifier

describe('a question of fact (decision 2)', () => {
  const QUESTIONS = [
    // The owner's own case, verbatim.
    'Does this update include all changes require (might not be requried for some) for Entitlements, groups, queues, list views, emails, alerts?',
    'does this update include every change required for entitlements, groups, queues, list views, emails, alerts',
    'can you add a queue?',
    'Is the login test passing on main',
    'hi, did the migration run?',
    'Hey — what does the gate say',
    'ok so which branch is this on',
    'Where is the retry logic.',
    'The queue is set up. Is that right? Then add the alert.',
    'Please confirm the list views were deployed',
    'verify the emails go out',
    'make sure the alerts are all there',
    'Are you sure about that',
    'check whether the groups exist',
    'You added the queue, did you not',
    'I think you have you deployed it',
    'why',
    'Do the refactor now',
  ]
  const NOT = [
    'add a queue for the support team',
    'Rename the alert to "Escalation" and push',
    'fix the failing test',
    'see https://example.com/page?id=4 for the spec',
    '/devloop status',
    '',
    'Implement the verification email (subject: Welcome!)',
    'write a doctor command',
    'list views need a filter: add one',
  ]
  test('the table: questions, and their near neighbours that are not', () => {
    for (const text of QUESTIONS) {
      expect({ text, isQuestion: isQuestionOfFact(text) }).toEqual({ text, isQuestion: true })
    }
    for (const text of NOT) {
      expect({ text, isQuestion: isQuestionOfFact(text) }).toEqual({ text, isQuestion: false })
    }
  })

  test('grounding.also adds patterns; grounding.never removes prompts, whatever else they match', () => {
    expect(isQuestionOfFact('status of the org deploy', ['^status of'])).toBe(true)
    expect(isQuestionOfFact('can you add a queue?', [], ['^can you'])).toBe(false)
    expect(isQuestionOfFact('what is next?', ['next'], ['^what'])).toBe(false)
  })

  test('the first line, cut, is what a person sees again', () => {
    expect(firstLine('Is it deployed?\nand the alerts')).toBe('Is it deployed?')
    expect(firstLine('x'.repeat(300)).length).toBe(120)
  })
})

// ---------------------------------------------------------------- the counter

describe('a look at the source (decision 3)', () => {
  test('the table', () => {
    const looks: [string, Record<string, unknown>][] = [
      ['Read', { file_path: '/repo/a.ts' }], ['Grep', { pattern: 'x' }], ['Glob', { pattern: '*.ts' }], ['NotebookRead', {}], ['WebFetch', { url: 'https://x' }], ['WebSearch', { query: 'q' }],
      ['Edit', {}], ['Write', {}], ['NotebookEdit', {}], ['Agent', { prompt: 'look' }],
      ['mcp__salesforce__query', { soql: 'SELECT Id FROM Group' }], ['mcp__devloop__devloop_status', {}], ['mcp__devloop__feature_check', { id: 'a' }],
      ['Bash', { command: 'git status' }], ['Bash', { command: 'npm test' }], ['Bash', { command: 'cat src/a.ts | head' }], ['Bash', { command: 'sf org list' }], ['Bash', { command: 'ls; echo done' }],
      ['Bash', { command: 'cd src && grep -rn queue .' }], ['Monitor', { command: 'tail -f log.txt' }],
    ]
    for (const [tool, input] of looks) {
      expect({ tool, input, isLook: isLook({ tool, input }) }).toEqual({ tool, input, isLook: true })
    }
    const none: [string, Record<string, unknown>][] = [
      ['Bash', { command: 'echo yes' }], ['Bash', { command: 'sleep 5' }], ['Bash', { command: 'true' }], ['Bash', { command: 'X=1' }], ['Bash', { command: 'echo x > notes.txt' }],
      ['Bash', { command: 'cat > notes.txt <<EOF\nhi\nEOF' }], ['Bash', { command: 'mkdir -p out && touch out/a' }], ['Bash', { command: '' }],
      ['mcp__devloop__devloop_question', { question: 'q' }], ['mcp__devloop__devloop_papercut', {}], ['TodoWrite', {}], ['Skill', { skill: 'x' }], ['AskUserQuestion', {}],
    ]
    for (const [tool, input] of none) {
      expect({ tool, input, isLook: isLook({ tool, input }) }).toEqual({ tool, input, isLook: false })
    }
    expect(looksIn([{ tool: 'Read', input: {} }, { tool: 'Bash', input: { command: 'echo' } }, { tool: 'Grep', input: {} }])).toBe(2)
  })

  test('wording that marks a guess, as the answer writes it', () => {
    expect(hedgeIn('Yes, I believe every queue is there.')).toBe('I believe')
    expect(hedgeIn('It should be fine. Probably.')).toBe('should be')
    expect(hedgeIn('From memory: all six are included.')).toBe('From memory')
    expect(hedgeIn('All six are included: I read each file.')).toBe(null)
    expect(hedgeIn('The likelihood is measured.')).toBe(null)
  })
})

// ---------------------------------------------------------------- the backstop, pure

describe('the backstop (decision 4), pure', () => {
  const base: BackstopFacts = { mode: 'enforce', isQuestion: true, looks: 0, isTreeChanged: false, isFreshLook: false, isRefused: false, answer: 'Yes.' }
  test('refused once in enforce, reported after; reported only in observe; nothing with a look, a changed tree, a fresh look, off, or no question', () => {
    expect(backstop(base)).toEqual({ action: 'refuse', reason: REFUSAL })
    expect(backstop({ ...base, isRefused: true })).toEqual({ action: 'report', toast: `${UNCHECKED}.`, hedge: null })
    expect(backstop({ ...base, mode: 'observe' })).toEqual({ action: 'report', toast: `${UNCHECKED}.`, hedge: null })
    expect(backstop({ ...base, mode: 'observe', answer: 'Probably all there.' })).toEqual({ action: 'report', toast: `${UNCHECKED}: it says "Probably".`, hedge: 'Probably' })
    for (const facts of [{ looks: 1 }, { isTreeChanged: true }, { isFreshLook: true }, { mode: 'off' as const }, { isQuestion: false }]) {
      expect(backstop({ ...base, ...facts, answer: 'I believe so' })).toEqual({ action: 'pass' })
    }
  })

  test('the policy field, read strictly; left out, the mode follows the policy\'s own', () => {
    const cfg = (raw: object) => parseConfig(JSON.stringify(raw))
    expect(groundingMode(cfg({ mode: 'observe' }).cfg)).toBe('observe')
    // A hint by default even in enforce mode: refusing a stop costs a turn, so it is opt-in.
    expect(groundingMode(cfg({ mode: 'enforce' }).cfg)).toBe('observe')
    expect(groundingMode(cfg({ mode: 'enforce', grounding: { mode: 'enforce' } }).cfg)).toBe('enforce')
    expect(groundingMode(cfg({ mode: 'enforce', grounding: { mode: 'off' } }).cfg)).toBe('off')
    expect(cfg({ grounding: { mode: 'observe', fresh: 'tree', also: ['^status'], never: ['^why'] } }).cfg.grounding).toEqual({ mode: 'observe', fresh: 'tree', also: ['^status'], never: ['^why'] })
    const bad = cfg({ grounding: { mode: 'loud', fresh: 'week', also: ['('], never: 'x', extra: 1 } })
    expect(bad.cfg.grounding).toEqual({ mode: null, fresh: 'turn', also: [], never: [] })
    expect(bad.errors.filter(one => one.startsWith('grounding')).length).toBe(5)
  })

  test('the rules text carries the paragraph, byte-stable', () => {
    expect(RULES).toContain('A fact you remember, a summary, a memory file or an earlier turn is a lead, not a fact. Before you answer a question about the state of the code, the repository, a system or your own earlier work, and before you act on such a fact, look at the source in this turn: read the file, run the query, list the thing. Say what you checked. What you could not check, name as an assumption. If a question of fact comes up while you work, find out or ask (`devloop_question`); do not decide it by guess.')
  })

  test('metrics: the two counts, in the store and for the session', () => {
    const m = computeMetrics({ counters: { 'grounding-questions': 7, 'grounding-unchecked': 2 }, changes: [], defects: [], evals: [], cacheHitRate: null, grounding: { sessionId: 's1', questions: 3, unchecked: 1 } })
    expect(m.grounding).toEqual({ questions: 7, unchecked: 2, session: { questions: 3, unchecked: 1 } })
    expect(metricsLines(m, null).join('\n')).toMatch(/questions of fact: 7; answered without a look at any source: 2 \(this session: 3 and 1\)/)
  })
})

// ---------------------------------------------------------------- the transcript (the classic Stop hook's reader)

describe('the transcript, read back to the start of its last turn (decision 6)', () => {
  const line = (value: object): string => JSON.stringify(value)
  const person = (text: string) => line({ type: 'user', origin: { kind: 'human' }, promptSource: 'sdk', message: { role: 'user', content: text } })
  const use = (name: string, input: object = {}) => line({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_1', name, input }] } })
  const result = line({ type: 'user', toolUseResult: {}, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'x' }] } })
  const said = (text: string) => line({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text }] } })

  test('the last prompt, who started it, and the calls after it', () => {
    const text = [person('earlier?'), use('Read'), result, said('ok'), person('Is the queue deployed?'), use('Bash', { command: 'echo hi' }), result, line({ type: 'user', isMeta: true, message: { role: 'user', content: '<system-reminder>x</system-reminder>' } }), said('Yes.'), ''].join('\n')
    expect(lastTurn(text)).toEqual({ isPerson: true, prompt: 'Is the queue deployed?', calls: [{ tool: 'Bash', input: { command: 'echo hi' } }] })
    expect(looksIn(lastTurn(text)?.calls ?? [])).toBe(0)
  })

  test('a turn a notification, a peer, a hook or a slash command started is no person\'s; a cut line is skipped; nothing readable is null', () => {
    expect(lastTurn([person('Is it?'), line({ type: 'user', origin: { kind: 'task-notification' }, message: { role: 'user', content: '<task-notification>done</task-notification>' } })].join('\n'))?.isPerson).toBe(false)
    expect(lastTurn(line({ type: 'user', origin: { kind: 'peer' }, message: { role: 'user', content: 'is it done?' } }))?.isPerson).toBe(false)
    expect(lastTurn(line({ type: 'user', rowSource: 'local', message: { role: 'user', content: '<command-name>/devloop</command-name>' } }))?.isPerson).toBe(false)
    // An older line, with no origin at all, is a person's.
    expect(lastTurn(line({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: 'Is it there?' }] } }))?.isPerson).toBe(true)
    expect(lastTurn(`${person('Does it?')}\n{"type":"assistant","mess`)?.prompt).toBe('Does it?')
    expect(lastTurn('')).toBe(null)
    expect(lastTurn('not json\n')).toBe(null)
  })
})

// ---------------------------------------------------------------- through the module

type Stopped = { block?: string; additionalContext?: readonly string[] }
const stopWith = ($: Dollar, answer = 'Yes, everything is included.', isActive = false): Promise<Stopped> =>
  $.classic.Stop({ session_id: 's', transcript_path: '/t', cwd: '/repo', stop_hook_active: isActive, last_assistant_message: answer } as never) as Promise<Stopped>
const ask = async ($: Dollar, text: string, turnId: string): Promise<void> => {
  await prompt($, text)
  await $.turn.start({ turnId } as never)
}
const read = ($: Dollar, agentId?: string) => $.tool.call({ tool: 'Read', file_path: '/repo/src/a.ts', ...(agentId === undefined ? {} : { agentId }) })
const OWNER = 'Does this update include all changes require (might not be requried for some) for Entitlements, groups, queues, list views, emails, alerts?'

/** A repository whose last stop saw tree t1, and whose checks pass. */
async function settled($: Dollar, w: World): Promise<void> {
  w.files['/repo/src/a.ts'] = 'export const a = 1\n'
  w.changed = ['src/a.ts']
  w.tree = 't1'
  await start($)
  await ask($, 'set up the queue', 'setup')
  await edit($, '/repo/src/a.ts')
  expect((await stopWith($, 'done')).block).toBeUndefined()
}

describe('the backstop through the module (decision 4)', () => {
  test('enforce: a question with no look is refused once; the second stop passes and is reported (a toast, the audit trail, the ledger, the Activity tab, the counts)', async ($, on) => {
    const w = world(on, { verify: ['npm test'], mode: 'enforce', grounding: { mode: 'enforce' } })
    await settled($, w)
    const contexts = w.contexts.length
    await ask($, OWNER, 'q1')
    // The nudge: one line on this turn's context.
    expect(w.contexts.slice(contexts).flat().filter(one => one.includes(NUDGE))).toEqual([`devloop: ${NUDGE}`])
    const first = await stopWith($, 'Yes, I believe everything is included.')
    expect(first.block).toBe(`devloop: ${REFUSAL}`)
    const toasts = w.toasts.length
    const second = await stopWith($, 'Yes, I believe everything is included.', true)
    expect(second.block).toBeUndefined()
    expect(w.toasts.slice(toasts).join('\n')).toMatch(/This answer was given without checking anything: it says "I believe"\. \(asked: "Does this update include all changes/)
    expect(await devloop($, 'audit 5')).toMatch(/answer-unchecked/)
    expect(((w.store['ledger:/repo'] as { kind: string }[] | undefined) ?? []).map(one => one.kind)).toContain('grounding-unchecked')
    expect(JSON.stringify((w.store['loop:/repo'] as { value: { events: { text: string }[] } }).value.events)).toMatch(/answered without checking anything: \\"Does this update include all changes/)
    expect(await devloop($, 'metrics')).toMatch(/questions of fact: 1; answered without a look at any source: 1 \(this session: 1 and 1\)/)
    // A third stop in the same turn: nothing more.
    const more = w.toasts.length
    expect((await stopWith($, 'Yes.', true)).block).toBeUndefined()
    expect(w.toasts.slice(more).filter(one => /without checking/.test(one))).toEqual([])
  })

  test('observe: never refused, only reported', async ($, on) => {
    const w = world(on, { verify: ['npm test'], mode: 'observe' })
    await settled($, w)
    await ask($, 'Is every alert there?', 'q1')
    expect((await stopWith($)).block).toBeUndefined()
    expect(w.toasts.join('\n')).toMatch(/This answer was given without checking anything\./)
  })

  test('observe set apart from an enforcing policy', async ($, on) => {
    const w = world(on, { verify: ['npm test'], mode: 'enforce', grounding: { mode: 'observe' } })
    await settled($, w)
    await ask($, 'Is every alert there?', 'q1')
    expect((await stopWith($)).block).toBeUndefined()
    expect(w.toasts.join('\n')).toMatch(/This answer was given without checking anything\./)
  })

  test('a question followed by a look is not refused, and a hedged answer after a look is left alone', async ($, on) => {
    const w = world(on, { verify: ['npm test'], mode: 'enforce', grounding: { mode: 'enforce' } })
    await settled($, w)
    await ask($, OWNER, 'q1')
    expect((await read($)).deny).toBeUndefined()
    const toasts = w.toasts.length
    expect((await stopWith($, 'I checked a.ts; the rest is probably fine.')).block).toBeUndefined()
    expect(w.toasts.slice(toasts).filter(one => /without checking/.test(one))).toEqual([])
  })

  test('a look by an agent the turn started counts; a call the guards refused does not', async ($, on) => {
    const w = world(on, { verify: ['npm test'], mode: 'enforce', grounding: { mode: 'enforce' } })
    await settled($, w)
    await ask($, 'is the .env set?', 'q1')
    expect((await $.tool.call({ tool: 'Read', file_path: '/repo/.env' })).deny).toMatch(/secrets/)
    expect((await stopWith($)).block).toBe(`devloop: ${REFUSAL}`)
    await ask($, 'is a.ts exported?', 'q2')
    expect((await read($, 'agent-helper')).deny).toBeUndefined()
    expect((await stopWith($)).block).toBeUndefined()
  })

  test('a request that is not a question is never touched, and a turn that changed the tree is the ordinary gate\'s', async ($, on) => {
    const w = world(on, { verify: ['npm test'], mode: 'enforce', grounding: { mode: 'enforce' } })
    await settled($, w)
    const contexts = w.contexts.length
    await ask($, 'add a queue for the support team', 'r1')
    expect(w.contexts.slice(contexts).flat().filter(one => one.includes(NUDGE))).toEqual([])
    expect((await stopWith($, 'Probably done.')).block).toBeUndefined()
    await ask($, 'can you add a queue?', 'r2')
    w.tree = 't2'
    expect((await stopWith($, 'Added it.')).block).toBeUndefined()
    expect(w.toasts.filter(one => /without checking/.test(one))).toEqual([])
  })

  test('fresh "tree": an earlier look counts on the same tree, and not once the tree changed; "turn" counts this turn only', async ($, on) => {
    const w = world(on, { verify: ['npm test'], mode: 'enforce', grounding: { mode: 'enforce', fresh: 'tree' } })
    await settled($, w)
    await ask($, 'show me a.ts', 'l1')
    await read($)
    await stopWith($, 'Here it is.')
    await ask($, 'Is a exported?', 'q1')
    expect((await stopWith($)).block).toBeUndefined()
    // The tree moves (a person's edit outside the session); the earlier look no longer counts.
    w.tree = 't3'
    await ask($, 'look at it again', 'l2')
    await stopWith($, 'ok')
    await ask($, 'Is it still exported?', 'q2')
    expect((await stopWith($)).block).toBe(`devloop: ${REFUSAL}`)
  })

  test('fresh "turn" (the default): an earlier turn\'s look on the same tree does not count', async ($, on) => {
    const w = world(on, { verify: ['npm test'], mode: 'enforce', grounding: { mode: 'enforce' } })
    await settled($, w)
    await ask($, 'show me a.ts', 'l1')
    await read($)
    await stopWith($, 'Here it is.')
    await ask($, 'Is a exported?', 'q1')
    expect((await stopWith($)).block).toBe(`devloop: ${REFUSAL}`)
  })

  test('a keep-warm turn and a subagent\'s stop are untouched, and so is a stop while a review round runs', async ($, on) => {
    const w = world(on, { verify: ['npm test'], mode: 'enforce', grounding: { mode: 'enforce' } })
    await settled($, w)
    await ask($, 'Is it deployed?', 'q1')
    // A subagent's stop in that turn: nothing.
    expect((await $.classic.Stop({ session_id: 's', transcript_path: '/t', cwd: '/repo', stop_hook_active: false, agent_id: 'agent-x', last_assistant_message: 'yes' } as never) as Stopped).block).toBeUndefined()
    expect((await stopWith($)).block).toBe(`devloop: ${REFUSAL}`)
    await read($)
    await stopWith($, 'checked', true)
    // A keep-warm ping: a turn no person started, on an unchanged tree, gets nothing at all.
    const toasts = w.toasts.length
    await $.prompt.submit({ text: 'cache-guard keep-warm ping (automatic). Is the cache warm? Reply with only: ok', origin: { kind: 'task-notification' }, wait: false } as never)
    await $.turn.start({ turnId: 'ping-1' } as never)
    const pinged = await stopWith($, 'ok')
    expect(pinged.block).toBeUndefined()
    expect(pinged.additionalContext ?? []).toEqual([])
    expect(w.toasts.slice(toasts)).toEqual([])
    // A review round in progress: the backstop stands aside.
    w.changed = ['src/a.ts']
    w.tree = 't4'
    await edit($, '/repo/src/a.ts')
    await stopWith($, 'done')
    expect(await devloop($, 'review')).toMatch(/started/)
    await ask($, 'What did the reviewer say?', 'q2')
    expect((await stopWith($, 'Nothing yet.')).block).toBeUndefined()
  })

  test('off: no nudge and no backstop; a repository with no policy is dormant', async ($, on) => {
    const w = world(on, { verify: ['npm test'], mode: 'enforce', grounding: { mode: 'off' } })
    await settled($, w)
    const contexts = w.contexts.length
    await ask($, 'Is it deployed?', 'q1')
    expect(w.contexts.slice(contexts).flat().filter(one => one.includes(NUDGE))).toEqual([])
    expect((await stopWith($)).block).toBeUndefined()
  })

  test('dormant: no devloop.json on either side', async ($, on) => {
    world(on, null)
    await start($)
    await ask($, 'Is it deployed?', 'q1')
    expect((await stopWith($)).block).toBeUndefined()
  })

  test('doctor says which mode is in force', async ($, on) => {
    world(on, { verify: ['npm test'], mode: 'observe' })
    await start($)
    expect(await devloop($, 'doctor')).toMatch(/grounding: observe \(following the policy's mode\); a person's question of fact gets one line of context, and a stop with no look at any source is reported, not refused/)
  })
})
