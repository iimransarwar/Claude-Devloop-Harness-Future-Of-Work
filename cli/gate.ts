// The command line's gate, verify, doctor and sandbox (DESIGN 4.11): the
// module's rows, proven from the repository and its git history alone. A
// row is met only on what the tree proves here and now: the checks this run
// ran, the scan of the added lines, and for review, a git note that names
// this very tree. Nothing is read from the plugin's store.

import process from 'node:process'

import type { Tier } from '../types'
import type { Config } from '../hooks/config'
import { approvalsFor, approvers, atLeast } from '../hooks/gate'
import { pushSends } from '../hooks/enforce'
import type { PushSeen } from '../hooks/enforce'
import type { Check, GateFacts } from '../hooks/gate'
import { decidePolicy } from '../hooks/inforce'
import type { InForce } from '../hooks/inforce'
import { groundingMode } from '../hooks/grounding'
import { hiddenOf } from '../hooks/inject'
import { lintInjection, lintInstructions, lintSkills, makeTargets, namedCommands, referencedPaths } from '../hooks/lint'
import type { InstructionFile, LintItem } from '../hooks/lint'
import { NOTE_READ, checksFor, isOlderEvidence, parseEvidence, statelessGate } from '../hooks/portable'
import type { CheckRun, EvidenceNote } from '../hooks/portable'
import { RESIDUAL_RISKS } from '../hooks/residual'
import { instructionGlobs, lintChecks, matchesAny, stepsFor } from '../hooks/rules'
import { compareSandbox, isBroadDomain, sandboxOf, sandboxSettings } from '../hooks/sandbox'
import { addedLines, scanCredentials } from '../hooks/scan'
import { ADDED_LINES, FORMATTERS, INSTRUCTION_FILES, readInstructionFiles, sweepSpecsOf } from '../hooks/scripts'
import type { Snapshot } from '../hooks/scripts'
import { existsSync } from 'node:fs'
import { policyInForce, policyTextAt, readText, runCheck, script, snapshot, treeOf } from './io'
import type { Found } from './io'

/** Exit codes: 0 ok (green, passing, clean), 1 not ok, 2 a usage or policy error. */
export const OK = 0
export const NOT_OK = 1
export const USAGE = 2

/** What a command says: its exit code, its text, its JSON, and warnings that go to standard error in either form. */
export type Said = { code: number; text: string; json: unknown; warnings?: string[] }

/** The policy in force at the snapshot's base, as the module decides it with a snapshot. */
function policyAtSnapshot(found: Found, first: InForce, snap: Snapshot): InForce {
  return snap.tree === null ? first : decidePolicy(found.working, found.text, policyTextAt(found.root, snap.base)) ?? first
}

/** Why the command line has nothing to judge, or null to go on. */
function notJudged(found: Found, policy: InForce | null): Said | null {
  if (policy === null) {
    return { code: USAGE, text: `devloop: no devloop.json in ${found.root} or on its base branch: this repository has not opted in.`, json: { error: 'not-opted-in', root: found.root } }
  }

  return null
}

/** The facts the gate reads beside the loop: the working copy's errors, the lint of the checks in force, how the copies compare. */
const factsFor = (found: Found, policy: InForce, snap: Snapshot): GateFacts => ({
  hiddenFromGit: snap.hidden,
  errors: found.errors,
  lint: lintChecks(policy.cfg.verify),
  policy: policy.policy,
  workingMode: policy.policy === 'changed' && found.working !== null && found.working.mode !== policy.cfg.mode ? found.working.mode : null,
})

/** The git note for HEAD under refs/notes/devloop, read back; null with none. */
export function noteOf(root: string): EvidenceNote | null {
  return noteRead(root).note
}

/** The note for HEAD, and whether a note there is in a schema this version no longer counts (L4). */
function noteRead(root: string): { note: EvidenceNote | null; isOlder: boolean } {
  const ran = script(NOTE_READ, ['HEAD'], root)

  return ran.code === 0 ? { note: parseEvidence(ran.out), isOlder: isOlderEvidence(ran.out) } : { note: null, isOlder: false }
}

export type Proven = { policy: InForce; snap: Snapshot; tier: Tier; rows: Check[]; isGreen: boolean; runs: CheckRun[]; note: EvidenceNote | null }

/**
 * A time budget for the checks (D1 F5, the classic hook on a ship): they
 * stop when it runs out. Nothing is kept (the cache-guard round, R4 and
 * P-D): every run proves its checks afresh, so a retry runs them all again.
 */
export type Budget = { until: number; now: () => number }

/** What proving answers when the budget ran out before every check had run. */
export const OUT_OF_TIME = 'out-of-time'

/** The checks that finished and those that did not, when the budget ran out (R4). */
const outOfTime = (finished: readonly CheckRun[], left: readonly string[]): Said => ({
  code: NOT_OK,
  text: `${finished.length === 0 ? 'no check finished' : `finished: ${finished.map(one => `${one.run} (${one.isPassing ? 'passed' : 'failed'})`).join(', ')}`}; not finished: ${left.join(', ')}`,
  json: { error: OUT_OF_TIME, finished: finished.map(one => one.run), left },
})

/** Proves the gate from the tree: the base policy's fast and full checks that apply, the scan, the note. */
export function proveGate(found: Found, budget: Budget | null = null): Proven | Said {
  const first = policyInForce(found).policy
  const stop = notJudged(found, first)
  if (stop !== null || first === null) {
    return stop ?? { code: USAGE, text: '', json: null }
  }
  const snap = snapshot(found.root, first.cfg)
  if (snap.tree === null) {
    return { code: USAGE, text: `devloop: ${found.root} is not a git repository, so there is no tree to judge and no base to judge it against.`, json: { error: 'not-git' } }
  }
  const policy = policyAtSnapshot(found, first, snap)
  const cfg = policy.cfg
  const isEmpty = snap.files.length === 0 && snap.base !== null
  const runs: CheckRun[] = []
  // Every check runs here, every time (R4, P-D): no pass from an earlier run, the classic hook's included, is kept or trusted.
  const all = checksFor(cfg, snap.files, isEmpty)
  for (const [i, run] of all.entries()) {
    const left = budget === null ? null : budget.until - budget.now()
    if (left !== null && left <= 1000) {
      return outOfTime(runs, all.slice(i))
    }
    const ran = runCheck(run, found.root, cfg, left)
    if (ran.isCut) {
      return outOfTime(runs, all.slice(i))
    }
    runs.push({ run, isPassing: ran.isPassing, outcome: ran.outcome, output: ran.output })
  }
  const diff = script(ADDED_LINES, [snap.base ?? 'HEAD'], found.root, 60_000)
  const hidden = snap.files.filter(file => matchesAny(file, instructionGlobs(cfg))).slice(0, 40).flatMap(file => {
    const text = readText(`${found.root}/${file}`)

    return text === null ? [] : hiddenOf(file, text).map(one => ({ file: one.file, line: one.line, kind: one.kind }))
  })
  const { note, isOlder } = noteRead(found.root)
  const proven = statelessGate({
    tree: snap.tree, committable: snap.committable, base: snap.base, files: snap.files, lines: snap.size.lines, runs,
    credentials: diff.code === 0 ? scanCredentials(addedLines(diff.out)) : [], hidden, isScanned: diff.code === 0, note, isOlderNote: isOlder,
  }, cfg, factsFor(found, policy, snap))

  return { policy, snap, tier: proven.loop.tier, rows: proven.rows, isGreen: proven.isGreen, runs, note }
}

const isSaid = (value: Proven | Said): value is Said => 'code' in value

/**
 * The row a push adds (final round, D1 F4): the gate judges the tree, a push
 * sends commits, and they must be the same. `pushing` names what is sent:
 * the commits git's pre-push input names, or HEAD.
 */
export function sendsRow(root: string, committable: string | null, pushing: readonly string[], seen?: PushSeen): Check {
  const refused = pushSends(committable, pushing.map(commit => ({ tree: treeOf(root, commit), isHead: commit === 'HEAD' })), seen)

  return refused === null
    ? { label: 'What the push sends', isMet: true, note: 'the commits it sends hold the tree the gate judged' }
    : { label: 'What the push sends', isMet: false, note: refused.reason }
}

/** `gate [--pushing <commit>…]`: the rows the plugin's gate shows, with an exit code (0 green, 1 not, 2 usage or policy error). */
export function gateCommand(found: Found, pushing: readonly string[] | null = null): Said {
  const proven = proveGate(found)
  if (isSaid(proven)) {
    return proven
  }
  const { policy, tier } = proven
  const rows = pushing === null ? proven.rows : [sendsRow(found.root, proven.snap.committable, pushing, proven.snap), ...proven.rows]
  const isGreen = rows.every(row => row.isMet)
  const cfg = policy.cfg
  const lines = [
    `devloop gate: ${isGreen ? 'green' : 'not green'} (${tier === 'none' ? 'no changes' : `${tier} risk`}, judged by ${policy.policy === 'no-base' ? 'the working tree\'s' : 'the base branch\'s'} devloop.json; stateless: no spec, no exemption, review only from a git note naming this tree)`,
    ...rows.map(check => `  ${check.isMet ? '[x]' : '[ ]'} ${check.label}: ${check.note}`),
    tier === 'none' ? '' : `  Merge: ${approvers(tier, cfg)} (${approvalsFor(tier, cfg)} approval${approvalsFor(tier, cfg) === 1 ? '' : 's'}; no state of the loop meets this row).`,
  ].filter(line => line !== '')

  return {
    code: isGreen ? OK : NOT_OK,
    text: lines.join('\n'),
    json: { isGreen, tier, tree: proven.snap.tree, committable: proven.snap.committable, base: proven.snap.base, policy: policy.policy, rows, approvals: approvalsFor(tier, cfg), evidence: proven.note === null ? null : { tree: proven.note.tree, head: proven.note.head, why: proven.note.why } },
  }
}

/** `verify [--profile fast|full]`: the base policy's checks for the change, run as the module runs them. */
export function verifyCommand(found: Found, profile: 'fast' | 'full'): Said {
  const first = policyInForce(found).policy
  const stop = notJudged(found, first)
  if (stop !== null || first === null) {
    return stop ?? { code: USAGE, text: '', json: null }
  }
  const snap = snapshot(found.root, first.cfg)
  const cfg = policyAtSnapshot(found, first, snap).cfg
  if (cfg.verify.length === 0) {
    return { code: NOT_OK, text: 'devloop verify: devloop.json names no verify commands, so nothing proves the work.', json: { isPassing: false, runs: [] } }
  }
  // Outside git every file counts as changed: a check with `when` runs.
  const steps = stepsFor(cfg.verify, profile, snap.tree === null ? ['**'] : snap.files).map(one => one.run)
  const runs = steps.map(run => ({ run, ...runCheck(run, found.root, cfg) }))
  const failed = runs.filter(one => !one.isPassing)
  // Nothing is kept (R4, P-D): a pass made here never lets a later run skip a check.

  return {
    code: failed.length === 0 ? OK : NOT_OK,
    text: [
      `devloop verify (${profile}): ${failed.length === 0 ? `passed${runs.length === 0 ? ': no check applies to this change' : ''}` : 'failed'}`,
      ...runs.map(one => `  ${one.isPassing ? '[pass]' : one.outcome === 'fail' ? '[FAIL]' : `[${one.outcome}]`} ${one.run}`),
      ...failed.map(one => `\n${one.run}:\n${one.output}`),
    ].join('\n'),
    json: { isPassing: failed.length === 0, profile, runs: runs.map(one => ({ run: one.run, isPassing: one.isPassing, outcome: one.outcome, code: one.code })) },
  }
}

/** The instruction and skill audit as doctor runs it, from files read here; the lints are the module's. */
function instructionAudit(root: string, cfg: Config): LintItem[] {
  const listed = script(INSTRUCTION_FILES, sweepSpecsOf(cfg), root)
  const paths = listed.code === 0
    ? readInstructionFiles(listed.out).files.map(one => one.path)
    : cfg.instructions.filter(glob => !/[*?[]/.test(glob) && existsSync(`${root}/${glob}`))
  const exists = (rel: string): boolean => existsSync(`${root}/${rel}`)
  const files: InstructionFile[] = paths.slice(0, 200).flatMap(path => {
    const text = readText(`${root}/${path}`)

    return text === null ? [] : [{ path, text }]
  })
  const existing = new Set<string>()
  for (const { path, text } of files) {
    const folder = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : ''
    for (const ref of referencedPaths(text).slice(0, 60)) {
      if (exists(ref) || (folder !== '' && exists(`${folder}/${ref}`))) {
        existing.add(ref)
      }
    }
  }
  const scriptsAt = (dir: string): string[] | null => {
    const text = readText(`${root}/${dir === '' ? '' : `${dir}/`}package.json`)
    if (text === null) {
      return null
    }
    try {
      return Object.keys((JSON.parse(text) as { scripts?: Record<string, string> }).scripts ?? {})
    } catch {
      return []
    }
  }
  const scriptsIn: Record<string, string[] | null> = {}
  for (const dir of [...new Set(files.flatMap(one => namedCommands(one.text).map(each => each.dir)))].filter(one => one !== '' && one !== '?').slice(0, 20)) {
    scriptsIn[dir] = scriptsAt(dir)
  }
  const makefile = ['Makefile', 'makefile', 'GNUmakefile'].find(exists)
  const items = lintInstructions({
    files, existing, scripts: scriptsAt(''), scriptsIn, targets: makefile === undefined ? null : makeTargets(readText(`${root}/${makefile}`) ?? ''),
    hasFormatter: FORMATTERS.some(exists), maxLines: cfg.instructionMaxLines, maxBytes: cfg.instructionMaxBytes,
  })
  items.push(...lintSkills(files.filter(each => /(^|\/)SKILL\.md$/.test(each.path)).map(one => {
    const folder = one.path.slice(0, Math.max(0, one.path.lastIndexOf('/')))

    return { ...one, hasMcp: exists(`${folder === '' ? '' : `${folder}/`}.mcp.json`) }
  })))
  items.push(...lintInjection(files))

  return items
}

/** The sandbox comparison, from the project's settings files. */
export function sandboxAudit(root: string, cfg: Config, stateRoot: string): LintItem[] {
  const files = ['.claude/settings.json', '.claude/settings.local.json'].map(name => ({ name, text: readText(`${root}/${name}`) }))
  const { found, errors } = sandboxOf(files)

  return [
    ...errors.map(text => ({ level: 'warn' as const, text: `sandbox: ${text}` })),
    ...compareSandbox(found, cfg, stateRoot, { home: process.env.HOME ?? null, pathDirs: (process.env.PATH ?? '').split(':') }),
  ]
}

/** `doctor [--strict]`, the stateless subset: policy errors, the instruction and skill lints, the injection scan, the sandbox. */
export function doctorCommand(found: Found, isStrict: boolean, stateRoot: string): Said {
  const policy = policyInForce(found).policy
  const out: string[] = []
  let errors = 0
  const say = (item: LintItem): void => {
    errors += item.level === 'error' ? 1 : 0
    out.push(`  ${item.level === 'ok' ? '[ok]  ' : item.level === 'warn' ? '[look]' : '[error]'} ${item.text}`)
  }
  if (policy === null) {
    say({ level: 'warn', text: `no devloop.json in ${found.root} or on its base branch: not opted in` })
  } else {
    say({ level: 'ok', text: policy.source === 'base' ? `policy in force: the base branch's devloop.json, whole (mode ${policy.cfg.mode})${policy.policy === 'changed' ? '; the working tree\'s copy differs' : policy.policy === 'deleted' ? '; the working tree\'s copy was deleted' : ''}` : 'policy in force: the working tree\'s devloop.json (the base branch has none)' })
    for (const error of found.errors) {
      say({ level: 'error', text: `devloop.json: ${error}` })
    }
    if (found.unused.length > 0) {
      say({ level: 'ok', text: `devloop.json sets fields this version does not read, ignored: ${found.unused.join(', ')}` })
    }
    // Grounding (DESIGN 4.15): judged at a turn's end; the command line has no turn, so it only says which mode is in force.
    say({ level: 'ok', text: `grounding: ${groundingMode(policy.cfg)}${policy.cfg.grounding.mode === null ? ' (following the policy\'s mode)' : ''}; judged at a turn's end by the hooks module and the classic hooks; the command line has no turn, so it has nothing to judge` })
    for (const problem of lintChecks(policy.cfg.verify)) {
      say({ level: 'warn', text: `check integrity: ${problem}` })
    }
    for (const item of instructionAudit(found.root, found.working ?? policy.cfg)) {
      say(item)
    }
    for (const item of sandboxAudit(found.root, policy.cfg, stateRoot)) {
      say(item)
    }
  }
  out.push('  not checked here (the plugin\'s doctor reads them): the tools in context, the session\'s context window, the store\'s records, the spec library (its folder is kept in the store)')
  out.push('  accepted residual risks (docs/RESIDUAL-RISK.md):')
  for (const one of RESIDUAL_RISKS) {
    out.push(`    ${one.id} ${one.line}`)
  }

  return {
    code: isStrict && errors > 0 ? NOT_OK : policy === null ? USAGE : OK,
    text: ['devloop doctor (stateless)', ...out, isStrict ? `strict: ${errors} error-level item${errors === 1 ? '' : 's'}` : ''].filter(line => line !== '').join('\n'),
    json: { errors, isOptedIn: policy !== null, lines: out },
  }
}

/**
 * `sandbox`: the settings block that matches the policy in force. Writes
 * nothing. It says what it cannot know (final round, D1 F9): with no plugin
 * data folder named (`CLAUDE_PLUGIN_DATA`), the harness's state directory is
 * a fallback, not a fact; and it warns of every allowed domain the
 * broad-domain test flags.
 */
export function sandboxCommand(found: Found, stateRoot: string, isStateKnown = true): Said {
  const policy = policyInForce(found).policy
  if (policy === null) {
    return { code: USAGE, text: `devloop: no devloop.json in ${found.root} or on its base branch: this repository has not opted in.`, json: { error: 'not-opted-in' } }
  }
  const block = sandboxSettings(policy.cfg, stateRoot)
  const broad = (policy.cfg.network?.allow ?? []).filter(isBroadDomain)
  const warnings = [
    ...(isStateKnown ? [] : [`the harness's state directory could not be determined here (CLAUDE_PLUGIN_DATA is not set), so ${stateRoot} in denyWrite is the fallback, not necessarily where the plugin keeps its state: run this where the plugin runs, or put the plugin's data folder there yourself.`]),
    ...broad.map(domain => `the allowed domain ${domain} is broad enough to defeat the allow-list (anyone can publish under it): name the exact hosts instead.`),
  ]

  return {
    code: OK,
    text: [
      '// The sandbox settings that match devloop.json (the policy in force). Nothing was written:',
      '// merge this into .claude/settings.json yourself. Globs are given as the policy writes them.',
      ...warnings.map(one => `// warning: ${one}`),
      JSON.stringify(block, null, 2),
      policy.cfg.network === null ? '// devloop.json sets no network.allow, so no allowed domains are implied: add sandbox.network.allowedDomains yourself.' : '',
    ].filter(line => line !== '').join('\n'),
    json: block,
    warnings: warnings.map(one => `devloop sandbox: warning: ${one}`),
  }
}

/** Whether a tier needs review evidence: medium and high. */
export const needsReview = (tier: Tier): boolean => atLeast(tier, 'medium')
