// Checklists at work (D2, DESIGN 4.13): loaded from the base branch like the
// rest of the policy, offered to a spec as candidate criteria, accounted for
// at approval, and answered at each review round: `pattern` and `check` items
// by the harness in code, `review` items by a shadow checklist reviewer (the
// read-only reviewer agent, a checklist brief). An item blocks only once a
// person promotes it. The pure parts are in hooks/checklist.ts.

import type { CommandRunInput, CommandRunResult } from 'claude-code'

import type { Finding, Loop } from '../types'
import type { Config } from './config'
import {
  activeItems, candidateText, checklistPrompt, checkQuotes, evaluatePattern, itemMetrics, itemRef, metricsLine, neverFailed, parseChecklist, parseItemAnswers, promotedRows,
  restateItemsPrompt, selectLists, surfacesOf,
} from './checklist'
import type { Adjudication, Checklist, ChecklistItem, ChecklistResult, Selection } from './checklist'
import { baseFile } from './evidence'
import type { RunRecord } from './evalplan'
import { actorOf, audit, confirm, isFromPerson, keepRecord, listOf } from './journal'
import { isSecret } from './rules'
import { addedLines } from './scan'
import { ADDED_LINES } from './scripts'
import { noteEvidence } from './portability'
import { git, judgeFeatureCheck, loopOf, note, policyInForce, record, run, save, specDir } from './state'
import type { Engine, Place } from './state'

type Answer = CommandRunResult

const CHECKLIST_FILES = `
# devloop:checklist-files
git ls-tree --name-only "$1" -- checklists/ 2>/dev/null
`

/** The lists loaded per root and base: read once per process (they change only with the base). */
const loaded = new Map<string, { lists: Checklist[]; problems: string[] }>()

/**
 * The checklists in force: `checklists/*.json` as the base branch has them
 * (the working tree's only where there is no base, as for the policy), each
 * read strictly; one that fails to load is named and left out (never read as
 * passed).
 */
export async function checklistsOf($: Engine, at: Place, base: string | null): Promise<{ lists: Checklist[]; problems: string[] }> {
  const key = `${at.root}\n${base ?? ''}`
  const known = loaded.get(key)
  if (known !== undefined) {
    return known
  }
  const names: string[] = []
  if (base !== null) {
    const ran = await git($, at, CHECKLIST_FILES, [base])
    names.push(...(ran?.out ?? '').split('\n').map(one => one.trim()).filter(one => /^checklists\/[^/]+\.json$/.test(one)))
  } else if (await $.fs.exists(`${at.root}/checklists`).catch(() => false)) {
    names.push(...(await $.fs.list(`${at.root}/checklists`).catch(() => [])).filter(one => one.name.endsWith('.json')).map(one => `checklists/${one.name}`))
  }
  const lists: Checklist[] = []
  const problems: string[] = []
  for (const name of names.slice(0, 40)) {
    const text = base === null ? await $.fs.read(`${at.root}/${name}`).catch(() => null) : await baseFile($, at, base, name)
    if (text === null) {
      problems.push(`${name}: could not be read`)
      continue
    }
    const parsed = parseChecklist(text, name)
    if (parsed.list !== null) {
      lists.push(parsed.list)
    }
    problems.push(...parsed.problems)
  }
  const found = { lists, problems }
  loaded.set(key, found)

  return found
}

/** What selection reads: the changed files, the lines the change adds, and the surfaces the active spec declares. */
async function selectionOf($: Engine, at: Place, loop: Loop, base: string | null): Promise<Selection> {
  const diff = await git($, at, ADDED_LINES, [base ?? 'HEAD'], 60_000)
  const added = diff === null || diff.code !== 0 ? '' : addedLines(diff.out).map(one => one.text).join('\n')
  const spec = loop.spec === null ? '' : await $.fs.read(`${specDir(at, loop)}/SPEC.md`).catch(() => '')

  return { changed: loop.changed, added, surfaces: surfacesOf(spec) }
}

/** The checklists that apply to the change as it stands. */
export async function selectedLists($: Engine, at: Place, loop: Loop, base: string | null): Promise<Checklist[]> {
  const { lists } = await checklistsOf($, at, base)

  return lists.length === 0 ? [] : selectLists(lists, await selectionOf($, at, loop, base))
}

/** The spec context's offer of candidate criteria (D2): null when no checklist applies, so a repository without any is told nothing. */
export async function candidateContext($: Engine, at: Place, loop: Loop, base: string | null): Promise<string | null> {
  if (loop.phase !== 'spec') {
    return null
  }

  return candidateText(await selectedLists($, at, loop, base))
}

// ---------------------------------------------------------------- results and promotion

const resultsKey = (root: string): string => `checklist-results:${root}`
const promotedKey = (root: string): string => `checklist-promoted:${root}`
const adjudicatedKey = (root: string): string => `checklist-adjudications:${root}`

/** The items a person promoted to blocking. */
export async function promotedOf($: Engine, root: string): Promise<string[]> {
  const kept = await $.store.get(promotedKey(root))

  return Array.isArray(kept) ? (kept as string[]) : []
}

/**
 * Keeps the promoted items' failures on the loop, so the gate (pure) shows
 * each as its own row on the tree it failed on: the tree now, and the tree
 * the review verdict read, whose failures travel with the verdict wherever
 * it carries (final round, D2 F2).
 */
async function syncFails($: Engine, at: Place): Promise<void> {
  const loop = await loopOf($)
  const results = await listOf<ChecklistResult>($, resultsKey(at.root))
  const promoted = await promotedOf($, at.root)
  // Outside git there is no tree to name: the failures on no tree are kept as they were.
  const trees = [...new Set([loop.review.tree, loop.tree])].filter(one => one !== null || loop.tree === null)
  const fails = trees.flatMap(tree => promotedRows(promoted, results, tree).map(row => ({ ref: row.label.replace(/^Checklist: /, ''), note: row.note, tree })))
  if (JSON.stringify(fails) !== JSON.stringify(loop.checklistFails ?? [])) {
    await save($, at.root, before => ({ ...before, checklistFails: fails }))
  }
}

/** Keeps results, each a `checklist-result@1` record. */
async function keepResults($: Engine, at: Place, results: readonly ChecklistResult[]): Promise<void> {
  for (const one of results) {
    await keepRecord($, at.root, 'checklist-result@1', resultsKey(at.root), one, 2000)
  }
  await syncFails($, at)
}

/** One result, by the harness or the reviewer. */
const resultOf = (list: Checklist, item: ChecklistItem, status: ChecklistResult['status'], evidence: string, tree: string | null, round: number, at: number, source: ChecklistResult['source']): ChecklistResult =>
  ({ schema: 'checklist-result@1', at, list: list.id, version: list.version, item: item.id, by: item.verify.by, status, evidence: evidence.slice(0, 600), tree, round, source })

/** The changed files' text, for pattern items and the quotes of the reviewer's answers; a secret is never read. */
async function changedText($: Engine, at: Place, cfg: Config, files: readonly string[]): Promise<{ path: string; text: string }[]> {
  const out: { path: string; text: string }[] = []
  for (const path of files.filter(one => !isSecret(one, cfg)).slice(0, 200)) {
    const text = await $.fs.read(`${at.root}/${path}`).catch(() => null)
    if (text !== null) {
      out.push({ path, text })
    }
  }

  return out
}

/** What the checklist reviewer was sent, kept until it answers: its agent, the items, the prompt (for a restatement), and the round. */
type Sent = { agentId: string; refs: string[]; prompt: string; isRetry: boolean; round: number; tree: string | null; base?: string | null }

const sentKey = (root: string): string => `checklist-sent:${root}`

/**
 * At the start of a review round: the applicable lists' items, routed by how
 * they are verified. `pattern` and `check` items are answered here in code
 * and never reach a model; `review` items go to one checklist reviewer (the
 * read-only reviewer agent, shadow: it never holds or decides the round);
 * `runtime` and `person` items are the approver's. Resolves to the reviewer
 * to add to the round, or null.
 */
export async function startChecklists($: Engine, at: Place, cfg: Config, loop: Loop, base: string | null, diff: string | null, round: number, tree: string | null): Promise<{ agentId: string } | null> {
  const lists = await selectedLists($, at, loop, base)
  if (lists.length === 0) {
    return null
  }
  const now = await $.clock.now()
  const files = await changedText($, at, cfg, loop.changed)
  const results: ChecklistResult[] = []
  const toReview: { ref: string; item: ChecklistItem }[] = []
  for (const list of lists) {
    for (const item of activeItems(list)) {
      if (item.verify.by === 'pattern') {
        const found = evaluatePattern(item, files)
        results.push(resultOf(list, item, found.status, found.evidence, tree, round, now, 'harness'))
      } else if (item.verify.by === 'check') {
        const command = item.verify.check ?? ''
        // Judged by the command rules first, as a feature check is, and run with checkEnv's scrub.
        const refusal = await judgeFeatureCheck($, at, cfg, loop, command)
        if (refusal !== null) {
          results.push(resultOf(list, item, 'unverified', `not run: the command rules refuse \`${command.slice(0, 120)}\` (${refusal.rule})`, tree, round, now, 'harness'))
        } else {
          const ran = await run($, command, at.root, cfg.verifyTimeoutSec, cfg.checkEnv)
          results.push(resultOf(list, item, ran.isPassing ? 'pass' : ran.outcome === 'fail' ? 'fail' : 'unverified', `\`${command.slice(0, 120)}\` ${ran.isPassing ? 'exited 0' : ran.outcome === 'fail' ? `exited ${ran.code}` : `could not run (${ran.outcome})`}`, tree, round, now, 'harness'))
        }
      } else if (item.verify.by === 'review') {
        toReview.push({ ref: itemRef(list.id, item.id), item })
      }
    }
  }
  await keepResults($, at, results)
  if (toReview.length === 0) {
    return null
  }
  const prompt = checklistPrompt({ items: toReview, diff, base, spec: loop.spec, round })
  const started = await $.agent.spawn({
    prompt,
    description: `devloop checklist review, round ${round}`,
    subagentType: 'devloop:reviewer',
    ...(cfg.models.specialist === null ? {} : { model: cfg.models.specialist }),
  }).catch(() => ({ agentId: undefined, deny: 'could not start' }))
  if (started.agentId === undefined || started.deny !== undefined) {
    await record($, at.root, 'checklist-reviewer', 'could-not-start', `round ${round}`)

    return null
  }
  // The base whose lists the round loaded: the answers resolve against those lists alone (final round, D2 F11).
  await $.store.set(sentKey(at.root), { agentId: started.agentId, refs: toReview.map(one => one.ref), prompt, isRetry: false, round, tree, base } satisfies Sent)

  return { agentId: started.agentId }
}

/** Whether an agent is the checklist reviewer at work. */
export async function isChecklistAgent($: Engine, root: string, agentId: string): Promise<boolean> {
  const sent = (await $.store.get(sentKey(root))) as Sent | undefined

  return sent !== undefined && sent.agentId === agentId
}

/**
 * The checklist reviewer answered: each item must be answered once, a fail
 * with a quote that is at its line (checked by the harness, as a finding's
 * is). A format failure is restated once by a second agent; a second one
 * goes to a person (a toast and the ledger, and a decision finding when an
 * item it was sent is promoted). Results are kept as `checklist-result@1`.
 */
export async function finishChecklist($: Engine, at: Place, cfg: Config, agentId: string, answer: string, isAborted: boolean): Promise<void> {
  const sent = (await $.store.get(sentKey(at.root))) as Sent | undefined
  if (sent === undefined || sent.agentId !== agentId) {
    return
  }
  await $.store.delete(sentKey(at.root))
  if (isAborted) {
    return
  }
  const loop = await loopOf($)
  const parsed = parseItemAnswers(answer, sent.refs)
  const files: Record<string, string | null> = {}
  for (const one of parsed.answers.filter(each => each.file !== null)) {
    const path = one.file ?? ''
    files[path] = path.startsWith('/') || path.includes('..') || isSecret(path, cfg) ? null : await $.fs.read(`${at.root}/${path}`).catch(() => null)
  }
  const quoted = checkQuotes(parsed.answers, files)
  const problems = [...parsed.problems, ...quoted.problems]
  if (problems.length > 0 && !sent.isRetry) {
    const again = await $.agent.spawn({
      prompt: restateItemsPrompt(answer, problems, sent.prompt),
      description: `devloop checklist review, round ${sent.round}: restate in the format`,
      subagentType: 'devloop:reviewer',
      ...(cfg.models.specialist === null ? {} : { model: cfg.models.specialist }),
    }).catch(() => ({ agentId: undefined, deny: 'could not start' }))
    if (again.agentId !== undefined && again.deny === undefined) {
      const id = again.agentId
      await $.store.set(sentKey(at.root), { ...sent, agentId: id, isRetry: true } satisfies Sent)
      // The restatement is read-only like every reviewer of the round.
      await save($, at.root, before => ({ ...before, review: { ...before.review, agents: before.review.agents.map(one => (one.agentId === agentId ? { ...one, agentId: id, isRetry: true } : one)) } }))
      await record($, at.root, 'checklist-format', 'restated', problems[0] ?? '')

      return
    }
  }
  if (problems.length > 0) {
    // Twice unreadable: a person's. It blocks only where an item it was sent is promoted.
    await record($, at.root, 'checklist-format', 'person', problems.slice(0, 3).join('; '))
    $.ui.toast(`devloop: the checklist reviewer's answer could not be read, even restated (${problems[0] ?? ''}). /devloop checklists shows what was answered.`, { timeoutMs: 15_000 })
    const promoted = await promotedOf($, at.root)
    if (sent.refs.some(ref => promoted.includes(ref))) {
      const next = 1 + loop.findings.reduce((max, one) => Math.max(max, Number(one.id.slice(1)) || 0), 0)
      const finding: Finding = {
        id: `F${next}`, reviewer: 'checklist', severity: 'high', file: '', line: 0, quote: '', problem: `the checklist reviewer twice answered items it was sent (some promoted to blocking) in a form the harness could not accept: ${problems[0] ?? ''}`,
        evidence: 'a person reads the checklist answers and settles this: /devloop findings resolve <id> <note>', isPreExisting: false, route: 'decision', status: 'open', isBlocking: true, round: sent.round, seen: sent.round, note: null,
      }
      await save($, at.root, before => ({ ...before, findings: [...before.findings, finding] }))
    }
  }
  const now = await $.clock.now()
  // Results resolve only against the lists loaded from the base for this round (final round, D2 F11): never the working
  // tree's, never another base's. A round kept before the base was recorded resolves nothing (no result is better than a wrong one).
  const { lists } = sent.base === undefined ? { lists: [] as Checklist[] } : await checklistsOf($, at, sent.base).catch(() => ({ lists: [] as Checklist[] }))
  const known = new Map<string, { list: Checklist; item: ChecklistItem }>()
  for (const list of lists) {
    for (const item of list.items) {
      known.set(itemRef(list.id, item.id), { list, item })
    }
  }
  const results = quoted.answers.flatMap(one => {
    const found = sent.refs.includes(one.ref) ? known.get(one.ref) : undefined
    if (found === undefined) {
      return []
    }
    const evidence = one.file === null ? one.reason || 'no reason given' : `${one.file}:${one.line ?? 0} "${one.quote.slice(0, 200)}"${one.reason === '' ? '' : `: ${one.reason}`}`

    return [resultOf(found.list, found.item, one.status, evidence, sent.tree, sent.round, now, 'reviewer')]
  })
  await keepResults($, at, results)
  await save($, at.root, before => note(before, 'review', `checklist review, round ${sent.round}: ${results.filter(one => one.status === 'fail').length} fail of ${results.length} answered (shadow unless promoted)`, now))
}

// ---------------------------------------------------------------- /devloop checklists

/** Eval tasks tagged with an item plant its defect: their trials in the last full run that passed (the item failing as it should), of those counted. */
function seededOf(item: string, runs: readonly RunRecord[], tags: Readonly<Record<string, readonly string[]>>): { found: number; seeded: number } | null {
  const tasks = Object.entries(tags).filter(([, list]) => list.includes(item)).map(([id]) => id)
  if (tasks.length === 0) {
    return null
  }
  const last = [...runs].reverse().find(one => one.kind === 'full' && one.without === null)
  const results = (last?.results ?? []).filter(one => tasks.includes(one.task) && one.outcome !== 'infra')

  return { found: results.filter(one => one.outcome === 'pass').length, seeded: results.length }
}

/** /devloop checklists: the lists in force and each item's numbers; `adjudicate`, `promote` and `demote` are a person's. */
export async function checklistsCommand($: Engine, at: Place, base: string | null, words: readonly string[], e: CommandRunInput, evals: { runs: readonly RunRecord[]; tags: Readonly<Record<string, readonly string[]>> }): Promise<Answer> {
  const { lists, problems } = await checklistsOf($, at, base)
  const results = await listOf<ChecklistResult>($, resultsKey(at.root))
  const promoted = await promotedOf($, at.root)
  const adjudications = await listOf<Adjudication>($, adjudicatedKey(at.root))
  const sub = words[0] ?? ''
  const refs = lists.flatMap(list => activeItems(list).map(item => itemRef(list.id, item.id)))
  if (sub === '') {
    if (lists.length === 0 && problems.length === 0) {
      return { text: 'No checklists: none in checklists/ on the base branch. docs/examples/checklists/login-form.json shows the format (checklist@1).' }
    }

    return {
      text: [
        `Checklists in force (from ${base === null ? 'the working tree: there is no base' : 'the base branch'}):`,
        ...lists.map(list => `  ${list.id} v${list.version}: ${list.title}, ${activeItems(list).length} of at most ${list.maxItems} items`),
        ...problems.map(one => `  not loaded: ${one}`),
        'Each item (shadow until a person promotes it):',
        ...refs.map(ref => metricsLine(itemMetrics(ref, results, adjudications, seededOf(ref, evals.runs, evals.tags), promoted.includes(ref)))),
        neverFailed(results).length > 0 ? `Never failed (prune candidates: saturated, or the wrong selector): ${neverFailed(results).join(', ')}` : '',
      ].filter(line => line !== '').join('\n'),
    }
  }
  if (!isFromPerson(e)) {
    return { text: 'Adjudicating, promoting and demoting a checklist item is a person\'s call, from the prompt.' }
  }
  const ref = words[1] ?? ''
  if (!refs.includes(ref) && !promoted.includes(ref)) {
    return { text: `No active item ${ref || '(none named)'}. Name it as <list>/<item>; /devloop checklists lists them.` }
  }
  const loop = await loopOf($)
  if (sub === 'adjudicate') {
    const verdict = words[2]
    if (verdict !== 'correct' && verdict !== 'wrong') {
      return { text: 'Say whether its last result was right: /devloop checklists adjudicate <list>/<item> correct|wrong.' }
    }
    const now = await $.clock.now()
    await $.store.set(adjudicatedKey(at.root), [...adjudications, { item: ref, verdict, at: now, tree: loop.tree } satisfies Adjudication].slice(-2000))
    await audit($, at.root, 'checklist-adjudicated', actorOf(e), ref, loop.tree, verdict)

    return { text: `Recorded: ${ref}'s last result was ${verdict}. Its precision is in /devloop checklists.` }
  }
  if (sub === 'promote' || sub === 'demote') {
    const isPromote = sub === 'promote'
    if (isPromote === promoted.includes(ref)) {
      return { text: `${ref} is already ${isPromote ? 'blocking' : 'in shadow'}.` }
    }
    const m = itemMetrics(ref, results, adjudications, seededOf(ref, evals.runs, evals.tags), promoted.includes(ref))
    const question = isPromote
      ? `Make ${ref} blocking? When its latest result on a tree is a fail, the gate shows it as its own unmet row. Its numbers: ${metricsLine(m).trim()}`
      : `Put ${ref} back in shadow? Its fails stop reaching the gate.`
    if (!(await confirm($, question, isPromote ? 'Promote it' : 'Demote it', 'Leave it'))) {
      return { text: `${ref} stays ${isPromote ? 'in shadow' : 'blocking'}.` }
    }
    await $.store.set(promotedKey(at.root), isPromote ? [...promoted, ref] : promoted.filter(one => one !== ref))
    await audit($, at.root, isPromote ? 'checklist-promoted' : 'checklist-demoted', actorOf(e), ref, loop.tree, metricsLine(m).trim().slice(0, 500))
    await syncFails($, at)
    // A promotion that makes an item failing on the reviewed tree blocking rewrites that tree's evidence note with it (the
    // cache-guard round, R12), so the portable record of the settled round says what the module's gate now says.
    let rewritten = ''
    const after = await loopOf($)
    const isSettled = after.review.status === 'pass' || after.review.status === 'fail'
    if (isPromote && isSettled && after.review.tree !== null && after.checklistFails.some(one => one.ref === ref && one.tree === after.review.tree)) {
      const cfg = (await policyInForce($, at))?.cfg ?? null
      const said = cfg === null ? 'No evidence note: the policy in force could not be read.' : await noteEvidence($, at, cfg, 'review').catch(() => 'No evidence note: git could not write it.')
      rewritten = ` It failed on the reviewed tree, so that tree's evidence note was rewritten with it: ${said}`
    }

    return { text: `${ref} is now ${isPromote ? 'blocking: a fail on the tree shows in the gate as its own row' : 'in shadow again'}.${rewritten}` }
  }

  return { text: 'Use /devloop checklists, or adjudicate|promote|demote <list>/<item>.' }
}
