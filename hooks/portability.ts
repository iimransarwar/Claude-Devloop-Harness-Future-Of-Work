// The module's part in the other enforcement points (DESIGN 4.11): it stamps
// each call and stop it judged, so the classic hooks beneath it stand down;
// it keeps a heartbeat, so a classic hook can tell a skipped module hook from
// a module that is not loaded; it folds what the classic hooks recorded into
// the ledger and the audit trail; it writes portable evidence as a git note;
// and it answers `/devloop sandbox` and `/devloop hooks install|remove`.
// Every `$` helper here is a function declaration (DESIGN 7).

import type { CommandRunInput, CommandRunResult } from 'claude-code'

import type { Config } from './config'
import { heartbeatPath, inboxPath, promptStampPath, readInbox, stampPath, stopKey, stopStampPath } from './enforce'
import { digest } from './output'
import { HOOK_INSTALL, HOOK_REMOVE, HOOK_WHERE, hookOutcome, hooksPlace, prePushHook } from './githook'
import type { HooksPlace } from './githook'
import { actorOf, audit, confirm, isFromPerson, policyHash } from './journal'
import { isBlockingAt, parseReview } from './findings'
import { tierFor, verdictFails } from './gate'
import type { LintItem } from './lint'
import { NOTE_WRITE, evidenceNote } from './portable'
import { compareSandbox, sandboxOf, sandboxSettings } from './sandbox'
import { bump, git, loopOf, record, snapshot, stateRootOf } from './state'
import type { Engine, Place } from './state'

/** Stamps a call the module judged and lets go on, before it goes on: the classic hook beneath sees it and stands down. Never throws. */
export async function stampCall($: Engine, toolUseId: unknown): Promise<void> {
  if (typeof toolUseId !== 'string' || toolUseId === '') {
    return
  }
  const root = await stateRootOf($)
  await $.fs.write(stampPath(root, toolUseId), String(await $.clock.now().catch(() => 0))).catch(() => undefined)
}

/** Stamps a stop the module judges, before the classic Stop hooks run beneath it. Never throws. */
export async function stampStop($: Engine, e: Record<string, unknown>): Promise<void> {
  const session = typeof e.session_id === 'string' ? e.session_id : await $.session.id().catch(() => '')
  if (session === '') {
    return
  }
  await $.fs.write(stopStampPath(await stateRootOf($), session), stopKey({ ...e, session_id: session })).catch(() => undefined)
}

/** Stamps a prompt the module saw, before the classic UserPromptSubmit hooks run beneath it (DESIGN 4.15). Never throws. */
export async function stampPrompt($: Engine, text: string): Promise<void> {
  const session = await $.session.id().catch(() => '')
  if (session === '') {
    return
  }
  await $.fs.write(promptStampPath(await stateRootOf($), session), digest(text)).catch(() => undefined)
}

/** Says the module is live in this session: at its start and each main-loop turn. Never throws. */
export async function heartbeat($: Engine): Promise<void> {
  const session = await $.session.id().catch(() => '')
  if (session === '') {
    return
  }
  await $.fs.write(heartbeatPath(await stateRootOf($), session), String(await $.clock.now().catch(() => 0))).catch(() => undefined)
}

/**
 * Folds what the classic hooks recorded since the last fold (the stateless
 * record path) into the ledger and the audit trail, and toasts the person
 * once for skips: a skipped module hook is a gap they must hear of. The
 * inbox is read from the offset kept in the store, never rewritten.
 */
export async function foldInbox($: Engine, at: Place): Promise<number> {
  const root = await stateRootOf($)
  const text = await $.fs.read(inboxPath(root, at.root)).catch(() => '')
  const events = readInbox(typeof text === 'string' ? text : '')
  const key = `inbox:${at.root}`
  const done = ((await $.store.get(key)) as number | undefined) ?? 0
  const fresh = events.slice(Math.min(done, events.length))
  if (fresh.length === 0) {
    return 0
  }
  await $.store.set(key, events.length)
  const tree = (await loopOf($)).tree
  for (const one of fresh) {
    if (one.kind === 'classic-refusal') {
      await record($, at.root, 'classic-deny', one.rule ?? 'unknown', `${one.tool}: ${one.subject}`)
      await bump($, at.root, `rule:${one.rule ?? 'unknown'}`)
      await audit($, at.root, 'refusal', { kind: 'harness', name: 'classic-hook' }, one.rule ?? 'unknown', tree, one.subject)
      continue
    }
    if (one.kind === 'answer-unchecked') {
      // Grounding's report from the classic Stop hook (DESIGN 4.15): the prompt's first line, as the module records it.
      await record($, at.root, 'grounding-unchecked', one.subject.slice(0, 80), 'answered without a look at any source (classic hook)')
      await audit($, at.root, 'answer-unchecked', { kind: 'harness', name: 'classic-hook' }, one.subject.slice(0, 120), tree, 'reported by the classic Stop hook from the transcript')
      continue
    }
    await record($, at.root, one.kind, one.tool, `${one.subject} (session ${one.session.slice(0, 12)})`)
    await bump($, at.root, one.kind)
    await audit($, at.root, one.kind, { kind: 'harness', name: 'classic-hook' }, `${one.tool}: ${one.subject}`, tree, one.kind === 'module-skipped' ? 'the hooks module did not judge this call; the classic hook applied the stateless core' : 'the hooks module was not loaded in that session')
  }
  const skipped = fresh.filter(one => one.kind === 'module-skipped').length
  if (skipped > 0) {
    $.ui.toast(`devloop: the harness's hooks module did not judge ${skipped} call${skipped === 1 ? '' : 's'} (a skipped hook); the classic hook held the stateless core and refused anything that shipped. /devloop audit lists them.`, { timeoutMs: 15_000 })
  }

  return fresh.length
}

/**
 * Writes portable evidence for the tree as it stands (D1): an `evidence@2`
 * record as a git note on HEAD under refs/notes/devloop, only when HEAD's
 * tree is the tree the harness verified and reviewed. Says what it did, or
 * why it wrote nothing.
 */
export async function noteEvidence($: Engine, at: Place, cfg: Config, why: 'review' | 'done'): Promise<string> {
  const loop = await loopOf($)
  const snap = await snapshot($, at, cfg)
  if (snap.tree === null || snap.head === null) {
    return 'No evidence note: this is not a git repository with a commit.'
  }
  if (loop.review.tree !== snap.tree) {
    return 'No evidence note: the review on record does not cover the tree as it stands.'
  }
  if (snap.committable === null) {
    return 'No evidence note: git could not say what a commit of this tree would hold.'
  }
  const open = loop.findings.filter(one => one.status === 'open' && one.isBlocking)
  // The checklist reviewer answers items, not a verdict on the change (D2): it is no reviewer of the evidence.
  const review = { ...loop.review, agents: loop.review.agents.filter(one => one.name !== 'checklist') }
  const tier = tierFor(loop, cfg)
  // Each reviewer's own outcome (D1 F7): a general or blocking reviewer's, by its own open findings and the round;
  // a shadow reviewer's, by its own answer (a readable PASS with no finding that would block at the tier), which never decided the round.
  const ownOf = (one: (typeof review.agents)[number]): 'pass' | 'fail' => {
    if (one.mode === 'shadow') {
      const parsed = parseReview(one.answer ?? '')

      return parsed.verdict === 'PASS' && !parsed.findings.some(each => isBlockingAt(each, tier)) ? 'pass' : 'fail'
    }

    return open.some(each => each.reviewer === one.name) || loop.review.status !== 'pass' ? 'fail' : 'pass'
  }
  const verdicts = Object.fromEntries(review.agents.map(one => [one.name, ownOf(one)]))
  // The promoted checklist items that failed on the reviewed tree travel with the verdict into the note (the last review's F7).
  const checklistFails = verdictFails(loop, 'reviewed').filter(one => one.tree === loop.review.tree).map(one => one.ref)
  // Keyed on the committable tree (final round, D1 F4, F10): what a commit holds, equal to HEAD's tree; the full tree is recorded beside it.
  const note = evidenceNote({ at: await $.clock.now(), why, tree: snap.tree, committable: snap.committable, head: snap.head, policy: policyHash(cfg), passedOn: loop.verify.passedOn, review, open: open.length, verdicts, checklistFails })
  const ran = await git($, at, NOTE_WRITE, [snap.committable, JSON.stringify(note)])
  if (ran === null || ran.code !== 0) {
    const said = ran?.out.trim() ?? ''

    return said.startsWith('tree:')
      ? `No evidence note: HEAD's tree (${said.slice(5, 13)}) is not the reviewed tree as a commit holds it (${snap.committable.slice(0, 8)}); commit the reviewed work as it is, then the next round or /devloop done writes one.`
      : 'No evidence note: git could not write it.'
  }
  await audit($, at.root, 'evidence-noted', { kind: 'harness', name: null }, `${why}: ${snap.head.slice(0, 12)}`, snap.tree, `${note.reviewers.length} reviewer verdicts, ${note.checks.length} checks; a record, not a signature`)

  return `Wrote portable evidence for tree ${snap.tree.slice(0, 8)} as a git note on ${snap.head.slice(0, 8)} (refs/notes/devloop). Push it yourself with git push origin refs/notes/devloop; it is a record, not a signature.`
}

/** Doctor's sandbox lines: the project's settings files against the policy. */
export async function sandboxLines($: Engine, at: Place, cfg: Config): Promise<LintItem[]> {
  const read = async (name: string): Promise<{ name: string; text: string | null }> =>
    ({ name, text: (await $.fs.exists(`${at.root}/${name}`).catch(() => false)) ? await $.fs.read(`${at.root}/${name}`).catch(() => null) : null })
  const { found, errors } = sandboxOf([await read('.claude/settings.json'), await read('.claude/settings.local.json')])
  const home = (await $.env.get('HOME').catch(() => undefined)) ?? null
  const path = (await $.env.get('PATH').catch(() => undefined)) ?? ''

  return [...errors.map(text => ({ level: 'warn' as const, text: `sandbox: ${text}` })), ...compareSandbox(found, cfg, await stateRootOf($), { home, pathDirs: path.split(':') })]
}

/** `/devloop sandbox`: the settings block that matches the policy in force. Writes nothing. */
export async function sandboxCommand($: Engine, cfg: Config): Promise<CommandRunResult> {
  const block = sandboxSettings(cfg, await stateRootOf($))

  return {
    text: [
      'The sandbox settings that match devloop.json (the policy in force). Nothing was written: merge this into .claude/settings.json yourself.',
      JSON.stringify(block, null, 2),
      cfg.network === null ? 'devloop.json sets no network.allow, so no allowed domains are implied.' : '',
      '/devloop doctor compares what the settings configure with this.',
    ].filter(line => line !== '').join('\n'),
  }
}

/**
 * `/devloop hooks install|remove`: the opt-in pre-push git hook, a person's
 * key with a dialog, recorded in the audit trail. Install chains a hook
 * already there; remove undoes exactly that.
 */
export async function hooksCommand($: Engine, at: Place, words: readonly string[], e: CommandRunInput): Promise<CommandRunResult> {
  const sub = words[0] ?? ''
  if (sub !== 'install' && sub !== 'remove') {
    return { text: 'Usage: /devloop hooks install (a pre-push git hook that runs the gate) or /devloop hooks remove.' }
  }
  if (!isFromPerson(e)) {
    return { text: 'A git hook is installed or removed by a person, from the prompt.' }
  }
  const env = await $.process.hookEnv().catch(() => ({}) as Record<string, string>)
  const pluginRoot = (env.CLAUDE_PLUGIN_ROOT ?? '').replace(/\/+$/, '')
  if (sub === 'install' && pluginRoot === '') {
    return { text: 'Not installed: the engine did not say where the plugin is, so the hook could not name dist/devloop.mjs.' }
  }
  const bundle = `${pluginRoot}/dist/devloop.mjs`
  // Where git runs hooks from (D1 F6): core.hooksPath is followed only inside the repository, and a folder in the tracked tree is named.
  let where: HooksPlace | null = null
  if (sub === 'install') {
    where = hooksPlace((await git($, at, HOOK_WHERE, []))?.out ?? '')
    if (where === null) {
      return { text: 'Not installed: git did not say where its hooks folder is.' }
    }
    if (where.kind === 'outside') {
      return { text: `Not installed: git runs hooks from ${where.dir} (core.hooksPath), which is outside this repository, so the harness does not write there. Point core.hooksPath inside the repository, or unset it, then try again.` }
    }
  }
  const question = sub === 'install'
    ? `Install a pre-push git hook at ${where?.dir ?? 'the hooks folder'}/pre-push that runs \`node ${bundle} gate\` and refuses a push that is not green? A pre-push hook already there is kept and runs first.${where?.kind === 'tree' ? ` That folder is inside the working tree (core.hooksPath), so the hook file is part of the repository: git will track the change unless it is ignored.` : ''}`
    : 'Remove the devloop pre-push git hook (and put back a hook it chained)?'
  if (!(await confirm($, question, sub === 'install' ? 'Install it' : 'Remove it', 'Leave it'))) {
    return { text: 'Nothing was changed.' }
  }
  const ran = await git($, at, sub === 'install' ? HOOK_INSTALL : HOOK_REMOVE, sub === 'install' ? [prePushHook(bundle)] : [])
  const outcome = hookOutcome(ran?.out ?? '', ran?.code ?? -1)
  if (outcome.isDone) {
    await audit($, at.root, sub === 'install' ? 'git-hook-installed' : 'git-hook-removed', actorOf(e), 'pre-push', (await loopOf($)).tree, outcome.text)
  }

  return { text: outcome.text }
}

