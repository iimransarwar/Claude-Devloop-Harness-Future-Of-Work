// /devloop and its subcommands: the person's side of the loop.

import { cacheCommand, cacheDoctorLines } from './cachecmd'
import type { CommandRunInput, CommandRunResult } from 'claude-code'

import type { FeatureStatus, Loop } from '../types'
import { cacheReport, EMPTY_CACHE } from './cache'
import { CHECK_ENV_BASE, DEFAULTS as FRESH_CFG } from './config'
import type { Config, Step } from './config'
import { groundingMode } from './grounding'
import { appendEntry, attributionReport, closeQuestion, handoffEntry, handoffEntries, questionsReport, tailLines } from './context'
import type { BriefFacts, HandoffInput } from './context'
import { testHashesOf } from './evidence'
import { approvalsFor, approvers, featureCounts, gate, isShippable, tierFor } from './gate'
import type { GateFacts } from './gate'
import { lintInjection, lintInstructions, lintSkills, makeTargets, namedCommands, referencedPaths } from './lint'
import type { InstructionFile, LintItem } from './lint'
import { isCredentialName, isSecretPlace, judgeWrite, liftClause, lintCheck, place, RULES, whereOf } from './rules'
import { findingsReport, resolveFinding, startReview } from './review'
import { actorOf, audit, confirm, inputsOf, isFromPerson, keepRecord } from './journal'
import { costStep, EMPTY_COSTS } from './ledger'
import type { Costs } from './ledger'
import {
  afterClose, auditCommand, closeChange, defectCommand, evalCommand, learnCommand, metricsCommand, papercutsCommand, pruneCommand, regressionsCommand, reportCommand,
} from './learning'
import { hooksCommand, noteEvidence, sandboxCommand, sandboxLines } from './portability'
import { prove } from './ship'
import { claimLines, readyFor } from './claims'
import { claimsOf, clearSpecClaims, endWatches, followupsFor, ghStatus, releaseClaim, seatOfPlace } from './coord'
import { followupLines } from './followup'
import { account, activeItems, candidateText, itemRef } from './checklist'
import { candidateContext, checklistsCommand, selectedLists } from './checklists'
import { historyOf, taskFiles } from './evals'
import { parseFeatures, readyFeatures, specProblems, unmappedCriteria } from './spec'
import {
  attributionOf, brief, bump, cacheOf, clearKept, credentialNames, factsOf, fingerprintOf, git, judgeFeatureCheck, ledger, locate, tasksFactsOf, tasksProbe,
  heldPolicy, metrics, note, policyInForce, questionsOf, record, refresh, run, save, saveCache, saveQuestions, snapshot, specDir,
  stateDirOf, stateRootOf, sweepCapped, sweepSpecsOf, verifyNow, withSnapshot, FRESH, SWEEP_CAP, loopOf,
} from './state'
import type { InForce, RefusedCheck } from './state'
import type { Engine, Place, Snapshot } from './state'
import { FORMATTERS, INSTRUCTION_FILES, readInstructionFiles } from './scripts'
import { RESIDUAL_RISKS } from './residual'
import { isAtLimit, limitDoctor, limitOn, unscopedFull } from './limits'
import { continueCommand } from './rounds'
import { learningDoctor, maybePropose, rulesCommand } from './learner'
import { libraryCommand, libraryDoctor, saveSpec } from './librarycmd'
import { setup } from './setup'
import { FEATURES, spec as specFile } from './templates'

export const HELP = `/devloop                 where the change stands and what the gate still needs
/devloop init            set this repository up for the loop
/devloop settings        change devloop's settings in a popup (a person's)
/devloop spec <name>     start (or reopen) a spec; only the spec and its tests change until approved
/devloop approve         approve the spec as written and unlock the build (a person's call)
/devloop verify          run the fast and full verify checks now
/devloop review          start an independent review round
/devloop continue [n]    allow n more failed rounds on this branch past the loop limit (a person's call)
/devloop gate            prove the gate now and answer with an exit code (0 green, 1 not), for CI
/devloop findings        review findings: open, deferred backlog, resolved
/devloop findings resolve <id> <note>
                         settle a finding that awaits a person's decision (a person's call)
/devloop done            close the change and reset the loop
/devloop allow <glob>    exempt paths from the guards for one turn (this one, if the agent is working)
/devloop allow --command <exact command>
                         let one exact shell command past the guards for one turn
/devloop budget <usd>    set a cost cap for this session (an estimate)
/devloop doctor          audit the setup: context, instructions, skills, isolation, credentials
/devloop doctor --strict the same, with a non-zero exit code when an error-level item is found (for CI)
/devloop sandbox         print the sandbox settings that match the policy (writes nothing)
/devloop hooks install   a pre-push git hook that runs the gate and refuses a push that is not green (a person's call)
/devloop hooks remove    remove it, and put back a hook it chained (a person's call)
/devloop cache install [flags]
                         install cache-guard, the bundled prompt-cache tool, for you (a person's call; needs Python 3.8+)
/devloop cache uninstall take it out of your user settings again (a person's call)
/devloop cache doctor | report [--all] [--days N] [session] | status
                         cache-guard's own setup scan, cost reports and state (a person's; read-only)
/devloop handoff         append a facts-only handoff entry (kept in the harness's state)
/devloop handoff show [n]
                         print the last n handoff entries (1 by default)
/devloop handoff export <path>
                         write every handoff entry into the repository at <path> (a person's call)
/devloop questions       the builder's open questions for a person
/devloop questions close <id> <answer>
                         answer and close one (a person's call)
/devloop learn           waiting proposals and trial rules, then repeated failures and the cheapest durable fix for each
                         (typed by a person, it also starts a proposer run)
/devloop lesson <text>   record something that went wrong (the harness records some lessons itself)
/devloop rules           learned rules: trial rules with their hits, promoted rules, waiting proposals (a person's)
/devloop rules promote <id>
                         make a trial rule blocking on this machine, after a dialog with its hits (a person's call)
/devloop rules drop <id> <reason>
                         remove a learned rule or proposal, with a tombstone (a person's call)
/devloop papercuts       the agent's friction reports, grouped
/devloop papercuts close <group> <note>
                         record what fixed one (a person's call)
/devloop eval            run the eval suite, or resume an interrupted run (a person's call)
/devloop eval quick      run the quick subset (labelled; not the headline number)
/devloop eval --without <rule | file | skill>
                         ablation: the baseline twice, then without it (a person's call)
/devloop eval validate   check each task's witness (fails untouched, passes solved, ...)
/devloop eval compare    the last two full runs, on the tasks that did not change
/devloop eval adopt [id] eval-task suggestions from failures; scaffold one (a person's call)
/devloop eval cancel     stop the run in progress (a person's call)
/devloop prune           rules with hits, last fired, eval evidence; saturated tasks
/devloop prune remove <rule id> <evidence>
                         record a rule's removal as a tombstone (a person's call)
/devloop regressions     the regression checks kept from closed specs
/devloop regressions drop <id> <reason>
                         retire one (a person's call)
/devloop defect <text> [--change <id>]
                         record an escaped defect against a closed change (a person's call)
/devloop library         the spec library: its folder, how many entries, the last ten (a person's)
/devloop library path <dir>
                         keep the library in another folder, created if missing (a person's call)
/devloop library save    save the current approved spec to the library now (a person's call)
/devloop library remove <entry>
                         delete one entry from the library, after a dialog (a person's call)
/devloop metrics [--json] the loop's numbers; --json exports exactly what is stored
/devloop report          a change report for a pull request body
/devloop audit [n]       the last n events of the audit trail (older ones are archived beside it)
/devloop claims          the claims sessions hold on the active spec's features, with their leases
/devloop claims release <feature>
                         release another session's live claim (a person's call)
/devloop followups       the pull requests the harness watches for you (checks, reviews)
/devloop followups stop [n]
                         stop watching one (or all) (a person's call)
/devloop checklists      the checklists in force, each item's shadow results and promotion
/devloop checklists adjudicate <list>/<item> <correct|wrong>
                         judge the item's last result on this change (a person's call)
/devloop checklists promote|demote <list>/<item>
                         make one item blocking, or back to shadow (a person's call)`

type Answer = CommandRunResult

/** What the status and the pane say outside git, where the snapshot names no tree. */
export const NOT_GIT_STATUS = 'Not a git repository: devloop only sees files Claude edits here.'

const NOT_SET_UP = 'devloop is not set up in this repository. A person sets it up by typing /devloop.'

/** A verify check as a person reads it. */
const describeStep = (one: Step): string =>
  `${one.run} [${one.profile}${one.when === null ? '' : `, when ${one.when.join(' ')}`}]`

/**
 * Where the change stands and what the gate still needs: what /devloop status
 * prints and the devloop_status tool answers. `cfg` is the gate's policy (the
 * base branch's). Pure, so the tool stays read-only.
 */
export function statusReport(loop: Loop, cfg: Config, at: Place, snap: Snapshot, facts: GateFacts, readyNow: readonly string[] | null = null): string[] {
  const tier = tierFor(loop, cfg)
  const rows = gate(loop, cfg, facts).map(check => `  ${check.isMet ? '[x]' : '[ ]'} ${check.label}: ${check.note}`)
  // Ready: dependencies pass on this tree and no other session's claim holds it (D2), in dependency order.
  const ready = loop.phase === 'build' ? readyNow ?? readyFeatures(loop) : []
  const size = snap.tree === null ? '' : ` (${snap.size.files} in the diff, ${snap.size.lines} lines)`
  const lines = [
    `devloop (${cfg.mode}): ${brief({ ...loop, tier })}`,
    tier === 'none' ? (snap.isOutsideGit === true ? NOT_GIT_STATUS : 'No changes yet.') : `Changed: ${loop.changed.length} file${loop.changed.length === 1 ? '' : 's'}${snap.branch !== null ? ` on ${snap.branch}` : ''}${size}`,
    ...rows,
    tier === 'none' ? '' : `  Merge: ${approvers(tier, cfg)}.`,
    ready.length > 0 ? `Ready to build (dependencies pass on this tree): ${ready.join(', ')}` : '',
    tier !== 'none' && isShippable(loop, cfg, facts) ? 'The gate is green. /devloop done closes the change once it is merged.' : '',
    loop.verify.status === 'fail' && loop.verify.failed !== null ? `Last verification failure: ${loop.verify.failed}` : '',
    loop.blocked !== null ? `The builder reported itself blocked: ${loop.blocked.reason}` : '',
    ...at.errors.map(error => `devloop.json: ${error}`),
  ]

  return lines.filter(line => line !== '')
}

async function status($: Engine, at: Place, cfg: Config): Promise<Answer> {
  const { loop, snap } = await refresh($, at, cfg)
  const policy = (await policyInForce($, at, snap)) ?? { cfg, source: 'working' as const, policy: 'no-base' as const }

  return { text: statusReport(loop, policy.cfg, at, snap, factsOf(at, policy)).join('\n') }
}

async function startSpec($: Engine, at: Place, raw: string, e: CommandRunInput): Promise<Answer> {
  const name = raw.trim().toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48)
  if (name === '') {
    return { text: 'Give the spec a short name: /devloop spec <name>.' }
  }
  const current = await loopOf($)
  // Reopening an approved spec unlocks it and its tests: a key a person holds.
  if (current.phase === 'build') {
    if (!isFromPerson(e)) {
      return { text: 'An approved spec is reopened by a person, from the prompt.' }
    }
    const isYes = await confirm($, `Reopen for editing? The approved spec "${current.spec ?? ''}" and its tests unlock, and every feature's recorded pass is dropped.`, 'Reopen', 'Keep it locked')
    if (!isYes) {
      return { text: 'The approved spec stays locked.' }
    }
    await audit($, at.root, 'spec-reopened', actorOf(e), current.spec ?? name, current.tree)
    // Reopening a spec clears its claims (D2).
    await clearSpecClaims($, at, current.spec ?? name, actorOf(e), 'the spec was reopened').catch(() => 0)
  }
  const dir = `${at.root}/specs/${name}`
  const isNew = !(await $.fs.exists(`${dir}/SPEC.md`))
  if (isNew) {
    await $.fs.write(`${dir}/SPEC.md`, specFile(name))
    await $.fs.write(`${dir}/features.json`, FEATURES)
  }
  const now = await $.clock.now()
  // A spec started while this session holds a `.tasks` task records its id (D2): the change record and the report cite it.
  const task = (await claimedTask($, at).catch(() => null)) ?? current.task
  await save($, at.root, before =>
    note({
      ...before, phase: 'spec', spec: name, approvedHash: null, features: {}, review: FRESH.review, tally: { ...before.tally, startedAt: before.tally.startedAt ?? now }, task,
      // What approval recorded belongs to that approval: the next one records it again.
      dependsOn: {}, approval: null, testHashes: null, newTests: [],
    }, 'spec', `spec "${name}" ${isNew ? 'started' : 'reopened'}`, now),
  )

  // The checklist items that apply already (by the change's paths and added lines) are offered as candidate criteria (D2).
  const snap = await snapshot($, at, (await policyInForce($, at))?.cfg ?? FRESH_CFG)
  const offer = await candidateContext($, at, await loopOf($), snap.tree === null ? null : snap.base).catch(() => null)

  return {
    text: `Spec "${name}" ${isNew ? 'started' : 'reopened'} in specs/${name}/. Until you run /devloop approve, only that folder and test files can change.${task === null ? '' : ` It is recorded against the .tasks task ${task}.`}`,
    context: [
      `The person started the spec "${name}". Follow the devloop:spec skill to fill specs/${name}/SPEC.md and specs/${name}/features.json with them: one entry per criterion, each with a "check" command that exits 0 only when the criterion holds. Write the tests those checks run, and confirm they fail for the right reason. Do not implement anything yet. When the spec is ready, ask the person to read it and run /devloop approve.`,
      ...(offer === null ? [] : [offer]),
    ],
  }
}

const TASKS_MINE = `
# devloop:tasks-mine
tasks mine --json --session "$1"
`

/**
 * The `.tasks` task this session holds, where the integration is on (D2):
 * the first task `tasks mine` lists as in progress. The command's JSON shape
 * is read defensively (a list, or one under `tasks`); null when none.
 */
async function claimedTask($: Engine, at: Place): Promise<string | null> {
  const policy = await policyInForce($, at)
  if (policy === null || !(await tasksFactsOf($, at, policy.cfg)).isOn) {
    return null
  }
  const session = await $.session.id().catch(() => null)
  const ran = await git($, at, TASKS_MINE, [session ?? ''], 30_000)
  if (ran === null || ran.code !== 0) {
    return null
  }
  try {
    const raw = JSON.parse(ran.out) as unknown
    const list = Array.isArray(raw) ? raw : Array.isArray((raw as { tasks?: unknown }).tasks) ? (raw as { tasks: unknown[] }).tasks : []
    const one = list.find(each => /^in_progress$/i.test(String((each as { status?: unknown }).status ?? ''))) as { path?: unknown; id?: unknown } | undefined
    const id = typeof one?.path === 'string' ? one.path : typeof one?.id === 'string' ? one.id : null

    return id === null ? null : id.slice(0, 120)
  } catch {
    return null
  }
}

/** /devloop claims, and `release <feature>`: a person takes another session's live claim back, with a dialog (D2). */
async function claimsCommand($: Engine, at: Place, words: readonly string[], e: CommandRunInput): Promise<Answer> {
  const loop = await loopOf($)
  const claims = await claimsOf($, at)
  const now = await $.clock.now()
  if (words[0] !== 'release') {
    const all = Object.values(claims)
    if (all.length === 0) {
      return { text: 'No claims: with one session working here, none is needed (a session claims a feature at its first feature_check, or with devloop_claim).' }
    }

    return {
      text: ['Claims on features (spec/feature: holder, lease):', ...all.map(one => `  ${one.spec}/${one.feature}: ${one.name}, ${now < one.until ? `${Math.max(0, Math.ceil((one.until - now) / 60_000))} minutes left` : 'lapsed (another session may take it over)'}`)].join('\n'),
    }
  }
  if (!isFromPerson(e)) {
    return { text: 'A claim is released by a person, from the prompt (the builder gives up its own with devloop_release).' }
  }
  const feature = words[1] ?? ''
  const spec = loop.spec
  const one = spec === null ? undefined : claims[`${spec}/${feature}`]
  if (spec === null || one === undefined) {
    return { text: `No claim on "${feature}" in the active spec. /devloop claims lists them.` }
  }
  if (!(await confirm($, `Release ${one.name}'s claim on "${feature}"${now < one.until ? ' (its lease is still live: that session may be working on it)' : ''}? Another session may then take it.`, 'Release it', 'Keep it'))) {
    return { text: `The claim on "${feature}" is kept.` }
  }
  await releaseClaim($, at, spec, feature, actorOf(e), null)

  return { text: `Released the claim on "${feature}".` }
}

/** /devloop followups, and `stop [n]`, a person's (D2). */
async function followupsCommand($: Engine, at: Place, words: readonly string[], e: CommandRunInput): Promise<Answer> {
  if (words[0] !== 'stop') {
    return { text: ['Follow-ups (pull requests the harness watches through gh):', ...followupLines(await followupsFor($, at.root), await $.clock.now())].join('\n') }
  }
  if (!isFromPerson(e)) {
    return { text: 'A follow-up is stopped by a person, from the prompt.' }
  }
  const n = words[1] === undefined ? null : Number(words[1])
  if (n !== null && !Number.isInteger(n)) {
    return { text: 'Name the follow-up by its number: /devloop followups stop 2 (or none to stop them all).' }
  }
  const count = await endWatches($, at, 'a person stopped it', n)
  if (count > 0) {
    await audit($, at.root, 'followup-stopped', actorOf(e), n === null ? 'every follow-up' : `follow-up ${n}`, null, `${count} stopped`)
  }

  return { text: count === 0 ? 'No live follow-up to stop.' : `Stopped ${count} follow-up${count === 1 ? '' : 's'}.` }
}

/** A list for a dialog line, or `none`. */
const named = (items: readonly (string | number)[]): string => (items.length === 0 ? 'none' : items.join(', '))

/** A check's command as a dialog shows it: whole, or shortened past a line's worth. */
const shortened = (check: string): string => {
  const one = check.replace(/\s+/g, ' ').trim()

  return one.length > 72 ? `${one.slice(0, 71)}…` : one
}

/** Whether two records of test hashes name the same files with the same content. */
const isSameHashes = (a: Record<string, string> | null, b: Record<string, string> | null): boolean =>
  JSON.stringify(Object.entries(a ?? {}).sort()) === JSON.stringify(Object.entries(b ?? {}).sort()) && (a === null) === (b === null)

/**
 * A person approves the spec. Refused while the spec is unfinished (the
 * template's placeholder, a bad feature list, an open question), and while
 * any feature check is refused by the command rules: each is judged before
 * it is ever run, and a refused one is not run (B2.1 F6). Before the dialog
 * the harness runs every check (red before green): checks that already pass
 * are vacuous, and the dialog lists each check's command, the vacuous ones,
 * the check-integrity lint and the acceptance criteria no feature covers.
 * What is approved is the text the checks ran on: the spec, its features and
 * the test files are read again after the dialog, and a change while the
 * person decided refuses the approval (B2.1 F5).
 */
async function approve($: Engine, at: Place, cfg: Config, e: CommandRunInput): Promise<Answer> {
  const loop = await loopOf($)
  if (loop.phase !== 'spec' || loop.spec === null) {
    return { text: 'There is no spec waiting for approval. /devloop spec <name> starts one.' }
  }
  if (!isFromPerson(e)) {
    return { text: 'A spec is approved by a person, from the prompt.' }
  }
  const dir = specDir(at, loop)
  const read = async (file: string): Promise<string> => ((await $.fs.exists(`${dir}/${file}`)) ? await $.fs.read(`${dir}/${file}`) : '')
  const featuresText = await read('features.json')
  const specText = await read('SPEC.md')
  const problems = specProblems(featuresText, specText)
  if (problems.length > 0) {
    return { text: `specs/${loop.spec} cannot be approved yet:\n${problems.map(one => `  - ${one}`).join('\n')}` }
  }
  const features = parseFeatures(featuresText)
  const refused: RefusedCheck[] = []
  for (const one of features) {
    const refusal = await judgeFeatureCheck($, at, cfg, loop, one.check)
    if (refusal !== null) {
      refused.push({ id: one.id, check: one.check, refusal })
    }
  }
  if (refused.length > 0) {
    return {
      text: [
        `specs/${loop.spec} cannot be approved yet: ${refused.length === 1 ? 'a check is' : `${refused.length} checks are`} refused by the command rules, and ${refused.length === 1 ? 'it was' : 'they were'} not run:`,
        ...refused.map(one => `  - ${one.id}: \`${shortened(one.check)}\` (${one.refusal.rule}: ${one.refusal.reason})`),
        'Change each check so that it runs the tests and nothing else, then run /devloop approve again.',
      ].join('\n'),
    }
  }
  // The policy in force (the base branch's) names the test files.
  const policy = (await policyInForce($, at, await snapshot($, at, cfg))) ?? { cfg }
  // What is approved is the text the checks run on, fixed before they run.
  const hash = await fingerprintOf(specText, features)
  const testHashes = await testHashesOf($, at, policy.cfg)
  // Red before green: every check should fail before anything is built.
  const vacuous: string[] = []
  const infra: string[] = []
  for (const one of features) {
    const ran = await run($, one.check, at.root, cfg.verifyTimeoutSec, cfg.checkEnv)
    if (ran.isPassing) {
      vacuous.push(one.id)
    } else if (ran.outcome !== 'fail') {
      infra.push(`${one.id} (${ran.outcome})`)
    }
  }
  const lint = features.flatMap(one => lintCheck(one.check).map(problem => `${one.id}: ${problem}`))
  const unmapped = unmappedCriteria(specText, features)
  // Checklist items that apply (D2): each must be kept (a feature names it), judged by a person, or struck with a reason; none may be left unaccounted for.
  const snapNow = await snapshot($, at, cfg)
  const lists = await selectedLists($, at, loop, snapNow.tree === null ? null : snapNow.base).catch(() => [])
  const refs = lists.flatMap(list => activeItems(list).map(item => itemRef(list.id, item.id)))
  // Each item's verification route, which the dialog names and which decides whether a person may judge it (final round, D2 F11).
  const routes = Object.fromEntries(lists.flatMap(list => activeItems(list).map(item => [itemRef(list.id, item.id), item.verify.by] as const)))
  const routed = (ids: readonly string[]): string => named(ids.map(ref => `${ref} (${routes[ref] ?? '?'})`))
  const accounted = account(refs, features, specText, routes)
  if (accounted.unaccounted.length > 0) {
    return {
      text: [
        `specs/${loop.spec} cannot be approved yet: ${accounted.unaccounted.length} checklist item${accounted.unaccounted.length === 1 ? ' is' : 's are'} not accounted for: ${accounted.unaccounted.join(', ')}.`,
        accounted.noReason.length > 0 ? `Struck without a reason: ${accounted.noReason.join(', ')}.` : '',
        accounted.notPerson.length > 0 ? `Listed as judged by a person, though the harness verifies it itself (by a pattern or a check): ${routed(accounted.notPerson)}. Keep it (a feature names it) or strike it with a reason.` : '',
        'For each: keep it (a feature whose "checklist" names it, with a check that proves it), list it under "## Judged by a person" in SPEC.md, or list it under "## Not applicable" with the reason.',
        candidateText(lists) ?? '',
      ].filter(line => line !== '').join('\n'),
    }
  }
  const question = [
    `Approve the spec "${loop.spec}" as written? It has ${features.length} acceptance check${features.length === 1 ? '' : 's'}. After this the spec and its tests are locked.`,
    `Checks: ${features.map(one => `${one.id}: ${shortened(one.check)}`).join('; ')}.`,
    `Already passing before any implementation (vacuous): ${named(vacuous)}.`,
    infra.length > 0 ? `Could not run at all: ${named(infra)}.` : '',
    `Check integrity: ${named(lint)}.`,
    `Acceptance criteria no feature covers: ${named(unmapped)}.`,
    refs.length > 0 ? `Checklist items, each with how it is verified: kept (a feature names each): ${routed(accounted.kept)}; judged by a person (the report lists them; never the gate): ${routed(accounted.person)}; struck as not applicable: ${routed(accounted.struck)}.` : '',
  ].filter(line => line !== '').join('\n')
  const isYes = await confirm($, question, 'Approve', 'Not yet')
  if (!isYes) {
    return { text: 'Not approved. The spec stays open for changes.' }
  }
  // Read again: what changed while the person decided was not what they read.
  const isSpecSame = (await fingerprintOf(await read('SPEC.md'), parseFeatures(await read('features.json')))) === hash
  if (!isSpecSame || !isSameHashes(await testHashesOf($, at, policy.cfg), testHashes)) {
    return { text: `Not approved: ${isSpecSame ? 'a test file' : `specs/${loop.spec}`} changed while you were deciding, so what you read is not what is there. Run /devloop approve again.` }
  }
  const now = await $.clock.now()
  // Every feature starts not passing, whatever the file says: only the
  // harness's own run of a check records a pass.
  const status: Record<string, FeatureStatus> = Object.fromEntries(features.map(one => [one.id, { passes: false, tree: null }]))
  await save($, at.root, before =>
    note({
      ...before,
      phase: 'build',
      approvedHash: hash,
      features: status,
      dependsOn: Object.fromEntries(features.map(one => [one.id, one.dependsOn])),
      approval: { vacuous, infra, lint, unmapped, at: now, ...(refs.length > 0 ? { checklist: { kept: accounted.kept, person: accounted.person, struck: accounted.struck } } : {}) },
      testHashes,
      newTests: [],
      // An exemption used before approval covers nothing approved after it (B2.1 F12).
      exemptionsUsed: [],
    }, 'spec', `spec "${before.spec ?? ''}" approved${vacuous.length > 0 ? ` with ${vacuous.length} vacuous check${vacuous.length === 1 ? '' : 's'}` : ''}`, now),
  )
  const approvedLoop = (await refresh($, at, cfg)).loop
  await audit($, at.root, 'spec-approved', actorOf(e), loop.spec, approvedLoop.tree, `${features.length} features${vacuous.length > 0 ? `; vacuous: ${vacuous.join(', ')}` : ''}`)
  if (vacuous.length > 0) {
    await bump($, at.root, 'vacuous-checks', vacuous.length)
  }
  const recorded = [
    vacuous.length > 0 ? `Vacuous checks, approved as they are and recorded on the change: ${vacuous.join(', ')}.` : '',
    infra.length > 0 ? `Checks that could not run at approval: ${infra.join(', ')}.` : '',
    unmapped.length > 0 ? `Acceptance criteria no feature covers: ${unmapped.join(', ')}.` : '',
  ].filter(line => line !== '')

  return {
    text: [`Spec "${loop.spec}" approved: ${features.length} features to build. The spec and the tests are now locked.`, ...recorded].join('\n'),
    context: [
      `The person approved the spec "${loop.spec}". Build it one failing feature at a time, a feature's dependencies first: implement, run the feature's check yourself, call the feature_check tool to record the pass, commit. The spec folder and the existing test files are locked; a new test file may be added.`,
    ],
  }
}

async function done($: Engine, at: Place, cfg: Config, e: CommandRunInput): Promise<Answer> {
  if (!isFromPerson(e)) {
    return { text: 'A change is closed by a person, from the prompt.' }
  }
  const { loop, snap } = await refresh($, at, cfg)
  const policy = (await policyInForce($, at, snap)) ?? { cfg, source: 'working' as const, policy: 'no-base' as const }
  const facts = factsOf(at, policy)
  const tier = tierFor(loop, policy.cfg)
  const rows = gate(loop, policy.cfg, facts)
  if (tier !== 'none' && !isShippable(loop, policy.cfg, facts)) {
    const open = rows.filter(check => !check.isMet).map(check => `${check.label} (${check.note})`).join('; ')
    const isYes = await confirm($, `The gate is not green: ${open}. Close the change anyway?`, 'Close anyway', 'Keep it open')
    if (!isYes) {
      return { text: `Kept open. Still needed: ${open}.` }
    }
    await bump($, at.root, 'closed-with-gate-open')
  }
  await bump($, at.root, 'changes-closed')
  if (tier !== 'none') {
    await keepGate($, at, policy.cfg, 'done', tier, isShippable(loop, policy.cfg, facts), rows, loop.tree)
  }
  // Portable evidence (D1): a git note on HEAD naming the reviewed tree, when HEAD's tree is that tree.
  const noted = tier === 'none' ? null : await noteEvidence($, at, policy.cfg, 'done').catch(() => null)
  // The change record, the person's attestation, the regression set (C2).
  const closed = tier === 'none' && loop.phase === 'idle' ? { lines: [] as string[], id: '' } : await closeChange($, at, policy.cfg, loop, rows, e)
  // The spec library (DESIGN 4.18): an approved spec is saved as the change closes; nothing it finds stops the close.
  const shelved = loop.spec !== null && loop.phase === 'build'
    ? await saveSpec($, at, policy.cfg, loop, { id: closed.id, at: await $.clock.now() }, actorOf(e)).catch(() => ({ kind: 'failed' as const, text: 'The spec could not be saved to the spec library.' }))
    : null
  const costs = ((await $.store.get(`costs:${at.root}`)) as Costs | undefined) ?? EMPTY_COSTS
  await $.store.set(`costs:${at.root}`, costStep(costs, null, { kind: 'change-closed' }))
  // features.json is left as the person approved it: feature status lives in
  // the harness's record, shown by the status tool and the pane. The saved check logs and review diffs go.
  await clearKept($, at)
  // The cache meter's change counts start over with the next change.
  await saveCache($, at.root, before => ({ ...before, change: EMPTY_CACHE.change }))
  const now = await $.clock.now()
  await save($, at.root, before =>
    note({
      ...FRESH,
      root: before.root,
      sessionId: before.sessionId,
      verify: { ...before.verify, rounds: 0 },
      events: before.events,
      budgetUsd: before.budgetUsd,
      regressions: before.regressions,
      // The loop limit counts a branch's failed rounds across changes: closing one does not reset it (DESIGN 4.16).
      limit: before.limit,
      // The proposer's runs are counted per session (DESIGN 4.17), not per change.
      learner: before.learner,
      base: snap.files.length === 0 || tier === 'none' ? before.base : snap.head,
    }, 'info', `change closed${before.spec !== null ? ` (${before.spec})` : ''}${closed.id === '' ? '' : ` as ${closed.id}`}`, now),
  )
  await afterClose($, at.root)
  // Closing the change clears its spec's claims and ends its follow-ups (D2).
  if (loop.spec !== null) {
    await clearSpecClaims($, at, loop.spec, actorOf(e), 'the change was closed').catch(() => 0)
  }
  await endWatches($, at, 'the change was closed', null).catch(() => 0)
  // A change closes while a repeat waits for a proposal: the proposer runs (DESIGN 4.17, decision 2).
  if (policy.cfg.learning.auto !== 'off') {
    await maybePropose($, at, policy.cfg, 'done', true).catch(() => '')
  }

  return { text: ['Change closed. The loop is back in small-fix mode; /devloop metrics has the numbers.', ...closed.lines, ...(noted === null ? [] : [noted]), ...(shelved === null ? [] : [shelved.text])].join('\n') }
}

/**
 * A one-turn exemption: a path glob, or with `--command` one exact shell
 * command. Either lifts the guards (not the secrets rule, the reviewer's
 * limits, the budget or the eval's containment) until the next turn ends.
 */
async function allow($: Engine, at: Place, raw: string, e: CommandRunInput, turnId: string | null): Promise<Answer> {
  const isCommand = /^--command(\s|$)/.test(raw.trim())
  const value = isCommand ? raw.trim().replace(/^--command\s*/, '').trim() : raw.trim()
  if (value === '') {
    return { text: isCommand ? 'Name the exact command: /devloop allow --command <command>.' : 'Name what to exempt: /devloop allow <path or glob>.' }
  }
  if (!isFromPerson(e)) {
    return { text: 'An exemption is granted by a person, from the prompt.' }
  }
  const question = isCommand
    ? `Let the agent run exactly this command until ${turnId === null ? 'the next' : 'this'} turn ends? The guards on it are off for that long:\n${value}`
    : `Let the agent edit "${value}" until ${turnId === null ? 'the next' : 'this'} turn ends? The guards on it are off for that long.`
  if (!(await confirm($, question, 'Allow once', 'No'))) {
    return { text: 'No exemption granted.' }
  }
  const now = await $.clock.now()
  const kind = isCommand ? 'command' as const : 'path' as const
  // Granted while a turn runs, it is bound to that turn and ends with it; granted while idle, the next turn takes it.
  await save($, at.root, before => note({ ...before, allow: [...before.allow, { kind, value, turnId }] }, 'info', `exempted ${isCommand ? 'the command ' : ''}${value} for one turn`, now))
  await bump($, at.root, 'exemptions')
  await audit($, at.root, 'exemption-granted', actorOf(e), isCommand ? `command: ${value}` : value, (await loopOf($)).tree, turnId === null ? 'for the next turn' : 'for this turn')
  const until = turnId === null ? 'the next turn ends' : 'this turn ends'

  return isCommand
    ? { text: `This exact command may run until ${until}:\n${value}`, context: [`The person allowed this exact command until ${until}: ${value}`] }
    : { text: `"${value}" is exempt from the guards until ${until}.`, context: [`The person exempted "${value}" from the edit guards until ${until}.`] }
}

/**
 * /devloop gate: proves the gate as the ship gate does (checks, stale
 * feature passes, evidence) and answers with an exit code, 0 when every row
 * the harness can meet is met and 1 otherwise, so `claude -p "/devloop gate"`
 * works in CI.
 */
async function gateCommand($: Engine, at: Place): Promise<Answer> {
  const proven = await prove($, at)
  const isGreen = !proven.isSpecChanged && isShippable(proven.loop, proven.judging, proven.facts)
  const tier = tierFor(proven.loop, proven.judging)
  await keepGate($, at, proven.judging, 'gate-command', tier, isGreen, proven.rows, proven.loop.tree)
  const lines = [
    `devloop gate: ${isGreen ? 'green' : 'not green'} (${tier === 'none' ? 'no changes' : `${tier} risk`}, judged by ${proven.facts.policy === 'no-base' ? 'the working tree\'s' : 'the base branch\'s'} devloop.json)`,
    ...proven.rows.map(check => `  ${check.isMet ? '[x]' : '[ ]'} ${check.label}: ${check.note}`),
    proven.isSpecChanged ? '  [ ] Spec: changed on disk after approval; a person reopens and approves it again' : '',
    tier === 'none' ? '' : `  Merge: ${approvers(tier, proven.judging)} (${approvalsFor(tier, proven.judging)} approval${approvalsFor(tier, proven.judging) === 1 ? '' : 's'}; no state of the loop meets this row).`,
  ]

  return { text: lines.filter(line => line !== '').join('\n'), exitCode: isGreen ? 0 : 1 }
}

/** Keeps the gate as it was judged (gate@1), with what produced it. */
export async function keepGate($: Engine, at: Place, cfg: Config, why: 'gate-command' | 'shipping' | 'shipped' | 'done', tier: Loop['tier'], isGreen: boolean, rows: readonly { label: string; isMet: boolean; note: string }[], tree: string | null): Promise<void> {
  const now = await $.clock.now()
  await keepRecord($, at.root, 'gate@1', `gates:${at.root}`, {
    schema: 'gate@1', at: now, why, tier, isGreen, rows: rows.slice(0, 60).map(row => ({ label: row.label.slice(0, 120), isMet: row.isMet, note: row.note.slice(0, 600) })), inputs: await inputsOf($, cfg, tree),
  }, 100)
}

/** /devloop findings, and `resolve <id> <note>`, which is a person's key. */
async function findings($: Engine, at: Place, cfg: Config, words: readonly string[], e: CommandRunInput): Promise<Answer> {
  if (words[0] !== 'resolve') {
    // A person also reads what the builder is not shown: the notes and this change's deferred findings, with their text (C2.1).
    return { text: await findingsReport($, at, cfg, isFromPerson(e)) }
  }
  const id = words[1] ?? ''
  const text = words.slice(2).join(' ').trim()
  if (!isFromPerson(e)) {
    return { text: 'A finding is resolved by a person, from the prompt.' }
  }
  if (!/^F\d+$/i.test(id) || text === '') {
    return { text: 'Name the finding and what was decided: /devloop findings resolve F3 <note>.' }
  }
  if (!(await confirm($, `Resolve ${id.toUpperCase()} as decided: "${text}"? It stops blocking the change.`, 'Resolve', 'Leave it open'))) {
    return { text: `${id.toUpperCase()} stays open.` }
  }

  const said = await resolveFinding($, at, id, text)
  if (/ is resolved/.test(said)) {
    await audit($, at.root, 'finding-resolved', actorOf(e), id.toUpperCase(), (await loopOf($)).tree, text.split('\n')[0]?.slice(0, 200) ?? '')
  }

  return { text: said }
}

const BRANCHES = `
# devloop:branches
git for-each-ref --format='%(refname:short)' refs/heads refs/remotes 2>/dev/null | head -12
`

async function doctor($: Engine, at: Place, isStrict = false): Promise<Answer> {
  const out: string[] = []
  let errors = 0
  const say = (isGood: boolean, text: string): void => {
    out.push(`  ${isGood ? '[ok]  ' : '[look]'} ${text}`)
  }
  /** A lint line: `error` counts toward --strict's exit code. */
  const sayItem = (item: LintItem): void => {
    if (item.level === 'error') {
      errors += 1
    }
    out.push(`  ${item.level === 'ok' ? '[ok]  ' : item.level === 'warn' ? '[look]' : '[error]'} ${item.text}`)
  }
  // Doctor audits the working tree's copy as written; the line after it names the policy in force.
  const cfg = at.working
  if (cfg === null && at.isOptedIn) {
    // Deleted in the working tree, kept on the base (C2.1): the base's stays in force.
    say(false, `no devloop.json in the working tree at ${at.root}, but the base branch has one: it stays in force for every decision (mode: ${heldPolicy(at)?.cfg.mode ?? 'enforce'}), and the gate reads "Policy changed in this change: devloop.json was deleted"`)

    return { text: ['devloop doctor', ...out].join('\n') }
  }
  say(cfg !== null, cfg !== null ? `devloop.json found at ${at.root} (mode: ${cfg.mode})` : 'no devloop.json: type /devloop to set it up')
  if (cfg === null) {
    return { text: ['devloop doctor', ...out].join('\n') }
  }
  const inForce = await policyInForce($, at)
  say(true, inForce === null || inForce.source === 'working'
    ? 'policy in force: the working tree\'s devloop.json (the base branch has none), for every decision'
    : `policy in force: the base branch's devloop.json, whole, for every decision (mode: ${inForce.cfg.mode})${inForce.policy === 'changed' ? '; the working tree\'s copy differs and takes effect only once it is merged' : ''}`)
  if (at.isFallback) {
    say(false, 'devloop.json does not parse, so the last config that parsed is in force (or, with none on record, every default in enforce mode)')
  }
  for (const error of at.errors) {
    errors += 1
    say(false, `devloop.json: ${error}`)
  }
  if (at.unused.length > 0) {
    say(true, `devloop.json sets fields this version does not read, ignored: ${at.unused.map(one => (one === 'handoffFile' ? 'handoffFile (handoff entries live in the harness\'s state; /devloop handoff export writes them into the repository)' : one)).join(', ')}`)
  }
  say(cfg.verify.length > 0, cfg.verify.length > 0 ? `verify: ${cfg.verify.map(describeStep).join(' ; ')}` : 'no verify commands: the stop gate has nothing to run')
  if (cfg.verify.length > 0 && cfg.verify.every(one => one.profile === 'full')) {
    say(false, 'every verify check is "full": the stop gate runs none of them, only shipping does')
  }
  // Targeted testing (DESIGN 4.16): a full check with no `when` runs whole on every change that ships.
  for (const run of unscopedFull(cfg)) {
    say(false, `\`${run}\` runs in full on every change that ships: add \`when\` globs to scope it`)
  }
  for (const problem of at.lint) {
    say(false, `check integrity: ${problem}`)
  }
  say(true, cfg.forbidden.length > 0 ? `forbidden: ${cfg.forbidden.length} pattern${cfg.forbidden.length === 1 ? '' : 's'}, plus the built-in production and destructive actions` : 'forbidden: the built-in production and destructive actions only')
  say(cfg.network !== null, cfg.network === null
    ? 'network.allow is not set: the egress tripwire is off (the sandbox\'s network rules are the boundary)'
    : `egress tripwire on: ${cfg.network.allow.length > 0 ? cfg.network.allow.join(', ') : 'no host'} allowed, plus loopback`)
  say(true, `instruction files (an edit makes the change high risk): ${cfg.instructions.join(', ')}`)
  say(true, cfg.rules.length > 0
    ? `content rules: ${cfg.rules.map(one => `${one.id} (${one.action}, when ${one.when.join(' ')})`).join('; ')}; read from the base branch's policy`
    : 'content rules: none ("rules" in devloop.json; /devloop learn proposes them)')
  say(true, `evals: ${cfg.evalTrials} trial${cfg.evalTrials === 1 ? '' : 's'} per task, each in a fresh ${cfg.evalIsolation}; the quick subset is the tasks tagged "quick" or ${cfg.evalQuick} chosen by hash`)
  // D2: coordination. What decides is the policy in force; the working copy is what doctor audits.
  const judging = inForce?.cfg ?? cfg
  say(true, `claims: a session's claim on a feature lasts ${judging.claims.leaseMinutes} minutes unless its activity renews it (only another session ever sees one)`)
  // The loop limit and targeted testing (DESIGN 4.16): the limit in force and this branch's count.
  const branchNow = (await snapshot($, at, judging)).branch
  const limit = (await loopOf($)).limit
  say(!isAtLimit(limitOn(limit, branchNow), judging), limitDoctor(limit, judging, branchNow))
  // Learning without being asked (DESIGN 4.17): the mode in force, the counts, and promoted rules not yet in the policy.
  for (const one of await learningDoctor($, at, judging).catch(() => [{ isGood: false, text: 'learning: the learned rules could not be read' }])) {
    say(one.isGood, one.text)
  }
  // The spec library (DESIGN 4.18): where it is, whether it is there and writable, its entries, and library.save in force.
  for (const one of await libraryDoctor($, judging).catch(() => [{ isGood: false, text: 'spec library: could not be checked' }])) {
    say(one.isGood, one.text)
  }
  say(true, `testing: ${judging.testing.scope}${judging.testing.scope === 'targeted' ? '; a pass of a check with "when" is kept against the files its globs match, and a failed check runs first' : '; every check runs on every tree'}`)
  // Grounding (DESIGN 4.15): which mode is in force, and whence.
  const grounded = groundingMode(judging)
  say(true, `grounding: ${grounded}${judging.grounding.mode === null ? ` (following the policy's mode)` : ''}; ${grounded === 'off' ? 'a question of fact gets no nudge and no backstop' : `a person's question of fact gets one line of context, and a stop with no look at any source ${grounded === 'enforce' ? 'is refused once' : 'is reported, not refused'}`}; looks count ${judging.grounding.fresh === 'tree' ? 'from this turn, or an earlier one on the same tree' : 'from this turn only'}`)
  if (!judging.followUp.ci) {
    say(true, 'follow-ups: off (followUp.ci is false)')
  } else {
    const gh = await ghStatus($, at).catch(() => 'missing' as const)
    say(gh === 'ok', gh === 'ok'
      ? `follow-ups: on; after a pull request is created or pushed to, gh is polled every ${judging.followUp.intervalSec}s for up to ${judging.followUp.timeoutMin} minutes`
      : `follow-ups: off, because gh is ${gh === 'missing' ? 'not installed' : 'not signed in (gh auth login)'}; nothing else is contacted`)
  }
  const probe = await tasksProbe($, at).catch(() => ({ hasTree: false, isVersion2: false, hasCommand: false }))
  say(judging.tasks.integrate === 'off' || (probe.hasTree && probe.isVersion2 && probe.hasCommand), `.tasks integration: ${judging.tasks.integrate}; a .tasks tree ${probe.hasTree ? (probe.isVersion2 ? 'declaring version 2' : 'that does not declare version 2') : 'is not here'}; the tasks command ${probe.hasCommand ? 'is on the PATH' : 'is not on the PATH'}${judging.tasks.integrate !== 'off' && !(probe.hasTree && probe.isVersion2 && probe.hasCommand) ? ': so the integration is not active' : ''}`)
  // C1: the instruction and skill audit, the injection scan, and instruction files git does not track.
  const audit = await auditInstructions($, at, cfg)
  for (const item of audit.items) {
    sayItem(item)
  }
  say(audit.untracked.length === 0, audit.untracked.length === 0
    ? audit.isGit ? 'every instruction file is tracked by git' : 'not a git repository: instruction files are checked by name only'
    : `instruction files git does not track, read by every session all the same (they are hashed into the verified tree): ${audit.untracked.slice(0, 8).join(', ')}`)
  const capped = audit.capped ?? sweepCapped(at.root)
  if (capped !== null) {
    say(false, `${capped} instruction files git ignores match the instruction globs: only the first ${SWEEP_CAP} (the shallowest; dependency and build folders left out) are hashed into the verified tree. Add the folders that hold the rest to "instructionsIgnore".`)
  }
  sayItem(await toolDefinitions($))
  say(true, `blast radius: past ${cfg.blastRadius.maxFiles} files or ${cfg.blastRadius.maxLines} lines, or a change to ${cfg.blastRadius.manifests.join(', ')}, raises the tier one step`)
  say(true, `approvals to merge: low ${cfg.approvals.low}, medium ${cfg.approvals.medium}, high ${cfg.approvals.high}`)
  say(true, cfg.reviewers.length > 0
    ? `specialist reviewers: ${cfg.reviewers.map(one => `${one.name} (${one.mode}, when ${one.when.join(' ')})`).join('; ')}`
    : 'specialist reviewers: none; the general reviewer alone')
  say(true, `models: reviewer ${cfg.models.reviewer ?? 'the session\'s'}, specialist ${cfg.models.specialist ?? 'the session\'s'}, eval ${cfg.models.eval ?? 'the session\'s'}, learner ${cfg.models.learner ?? 'the session\'s'}`)
  say(true, `refusals and who lifts them: ${RULES.map(rule => `${rule} ${liftClause(rule).replace(/^\((.*)\.\)$/, '[$1]')}`).join('; ')}`)
  const snap = await snapshot($, at, cfg)
  say(snap.tree !== null, snap.tree !== null ? `git repository, on ${snap.branch ?? 'a detached head'}` : 'not a git repository: changes are tracked by edits alone, and there is no rollback')
  if (snap.tree !== null && snap.base === null) {
    const ran = await $.process.run(['bash', '-c', BRANCHES, 'devloop'], { cwd: at.root, timeoutMs: 10_000 }).catch(() => null)
    const branches = (ran?.stdout ?? '').split('\n').filter(line => line !== '').join(', ')
    say(false, `no base branch: "defaultBranch" is "${cfg.defaultBranch}" and no branch to measure the change against was found${branches !== '' ? ` (branches here: ${branches})` : ''}. Set "defaultBranch" in devloop.json to the branch changes merge into; until then the gate stays shut.`)
  }
  if (snap.branch === cfg.defaultBranch) {
    say(false, `working directly on ${cfg.defaultBranch}: use a branch or a worktree per change`)
  }
  const env = await $.process.run(['bash', '-c', 'env | cut -d= -f1'], { timeoutMs: 10_000 }).catch(() => null)
  const risky = (env?.stdout ?? '').split('\n').filter(isCredentialName)
  say(risky.length === 0, risky.length === 0 ? 'no credential-shaped variables in the environment' : `credential-shaped variables are visible to every command the agent runs: ${risky.slice(0, 8).join(', ')}${risky.length > 8 ? ', …' : ''}`)
  // C1: what the checks the harness runs can see.
  if (cfg.checkEnv.mode === 'enforce') {
    say(true, `checkEnv enforce: verify commands and feature checks run with only ${[...CHECK_ENV_BASE, ...cfg.checkEnv.pass].join(', ')} (no login profile)`)
  } else {
    const seen = await credentialNames($)
    say(seen.length === 0 || cfg.checkEnv.mode === 'off', `checkEnv ${cfg.checkEnv.mode}: verify commands and feature checks run with the whole environment${seen.length > 0 ? `, so they can see ${seen.slice(0, 8).join(', ')}${seen.length > 8 ? ', …' : ''}; "checkEnv": { "mode": "enforce", "pass": [...] } narrows it` : ''}`)
  }
  // D1: the sandbox the settings configure, against the one the policy implies (/devloop sandbox prints it).
  for (const item of await sandboxLines($, at, inForce?.cfg ?? cfg)) {
    sayItem(item)
  }
  // Final round, D1 F5b: the classic hooks and the pre-push hook run on node; without it the fallback is absent (docs/RESIDUAL-RISK.md A19).
  const node = await $.process.run(['bash', '-c', 'command -v node'], { cwd: at.root, timeoutMs: 10_000 }).catch(() => null)
  const hasNode = node !== null && node.exitCode === 0 && node.stdout.trim() !== ''
  say(hasNode, hasNode
    ? 'node is on the PATH: the classic hooks (the fallback beneath the hooks module) and the pre-push hook can run'
    : 'node is not on the PATH (or could not be found): the classic hooks and the pre-push hook cannot run, so if the hooks module is skipped or not loaded nothing else holds; this is the one state with no fallback (docs/RESIDUAL-RISK.md A19). Install Node 18 or later.')
  const usage = await $.session.usage().catch(() => null)
  if (usage?.context.percent !== undefined) {
    say(usage.context.percent < 60, `context window ${Math.round(usage.context.percent)}% full${usage.context.percent >= 60 ? ': finish the step, then /devloop handoff and start a fresh session (its first prompt is briefed from the handoff)' : ''}`)
  }
  const tasks = (await $.fs.exists(`${at.root}/evals/tasks`)) ? (await $.fs.list(`${at.root}/evals/tasks`)).filter(entry => entry.name.endsWith('.json')).length : 0
  say(tasks >= 5, `${tasks} eval task${tasks === 1 ? '' : 's'} in evals/tasks/ (aim for 20 to 50, each from a real failure)`)
  // What the harness knowingly accepts (docs/RESIDUAL-RISK.md), one line each.
  out.push(`  accepted residual risks (docs/RESIDUAL-RISK.md; the sandbox and credential isolation are the boundary):`)
  for (const one of RESIDUAL_RISKS) {
    out.push(`    ${one.id} ${one.line}`)
  }

  return {
    text: ['devloop doctor', ...out, isStrict ? `strict: ${errors} error-level item${errors === 1 ? '' : 's'}` : ''].filter(line => line !== '').join('\n'),
    ...(isStrict ? { exitCode: errors > 0 ? 1 : 0 } : {}),
  }
}

// ---------------------------------------------------------------- context: the briefing and the handoff (C1)

/** The first line of the last recorded failure's output: what a cold start needs of it. */
async function lastFailureLine($: Engine, at: Place, loop: Loop): Promise<string | null> {
  if (loop.verify.status !== 'fail' || loop.verify.failed === null) {
    return null
  }
  const last = [...(await ledger($, at.root))].reverse().find(one => one.kind === 'verify-fail' || one.kind === 'check-infra' || one.kind === 'feature-fail')
  const first = last?.detail.split('\n').map(line => line.trim()).find(line => line !== '' && !line.startsWith('$ ')) ?? ''

  return `${loop.verify.failed}${first !== '' ? `: ${first.slice(0, 140)}` : ''}`
}

/** Features not passing on the tree as it stands, in the order approved. */
const failingOf = (loop: Loop): string[] =>
  loop.phase === 'build' ? Object.entries(loop.features).filter(([, one]) => !one.passes || one.tree !== loop.tree).map(([id]) => id) : []

/** Where a repository's handoff entries are kept: the harness's state, never the working tree (F1). */
export async function handoffPath($: Engine, root: string): Promise<string> {
  return `${await stateDirOf($, root)}/handoff.md`
}

/** Every handoff entry the harness kept for a repository, as one text (empty with none). */
async function handoffText($: Engine, root: string): Promise<string> {
  const file = await handoffPath($, root)

  return (await $.fs.exists(file).catch(() => false)) ? await $.fs.read(file).catch(() => '') : ''
}

/** What the cold-start briefing is made of, gathered without running anything but reads. */
export async function briefFacts($: Engine, at: Place, loop: Loop): Promise<BriefFacts> {
  // Ready work without the other seats' claims, and their claims, only when another seat holds one (D2; the holder is the seat, final round F4).
  const session = seatOfPlace(at)
  const now = await $.clock.now()
  const claims = loop.phase === 'build' && loop.spec !== null ? await claimsOf($, at).catch(() => ({})) : {}

  return {
    handoffTail: tailLines(await handoffText($, at.root), 6),
    phase: loop.phase,
    spec: loop.spec,
    ready: loop.phase === 'build' ? readyFor(loop, claims, session, now) : [],
    claims: claimLines(loop, claims, session, now),
    failing: failingOf(loop),
    lastFailure: await lastFailureLine($, at, loop),
    decisions: loop.findings.filter(one => one.status === 'open' && one.route === 'decision').map(one => `${one.id} ${one.problem.slice(0, 60)}`),
    questions: (await questionsOf($, at.root)).filter(one => one.status === 'open'),
  }
}

const RECENT_COMMITS = `
# devloop:recent-commits
git log -5 --format='%h %s' 2>/dev/null
`

/** How many handoff entries the harness keeps per repository; older ones go. */
export const HANDOFFS_KEPT = 50

/**
 * Appends a handoff entry to the repository's handoff record in the
 * harness's state (never the working tree, so writing one moves no hash and
 * no tool call can point it elsewhere): the facts from the harness's state
 * and git (never from the model), then the builder's narrative, or none for
 * a person's facts-only entry.
 */
export async function writeHandoff($: Engine, at: Place, cfg: Config, by: 'builder' | 'person', input: HandoffInput | null): Promise<void> {
  const snap = await snapshot($, at, cfg)
  const loop = withSnapshot(await loopOf($), snap, cfg)
  const commits = (await git($, at, RECENT_COMMITS, []))?.out.split('\n').filter(line => line.trim() !== '') ?? []
  const now = await $.clock.now()
  const { passing, total } = featureCounts(loop)
  const entry = handoffEntry(by, {
    time: new Date(now).toISOString().replace(/\.\d+Z$/, 'Z'),
    phase: loop.phase,
    spec: loop.spec,
    features: { passing, total, ready: loop.phase === 'build' ? readyFeatures(loop) : [], failing: failingOf(loop) },
    findings: loop.findings.filter(one => one.status === 'open').map(one => `${one.id} (${one.route})`),
    lastFailure: await lastFailureLine($, at, loop),
    changed: loop.changed,
    commits,
    tree: snap.tree,
  }, input)
  const file = await handoffPath($, at.root)
  const kept = handoffEntries(await handoffText($, at.root)).slice(-(HANDOFFS_KEPT - 1))
  await $.fs.write(file, appendEntry(kept.join('\n'), entry))
  // The entry as a handoff@1 record: counts and keys, not the narrative's every word.
  await keepRecord($, at.root, 'handoff@1', `handoffs:${at.root}`, {
    schema: 'handoff@1', at: now, by, file: 'harness-state:handoff.md',
    objective: input === null ? null : input.objective.slice(0, 600), nextStep: input === null ? null : input.nextStep.slice(0, 600),
    decisions: input?.decisions.length ?? 0, deadEnds: input?.deadEnds.length ?? 0, assumptions: input?.assumptions.length ?? 0,
    files: (input?.files ?? []).slice(0, 15).map(one => one.slice(0, 400)),
    facts: { phase: loop.phase, spec: loop.spec, tree: snap.tree, changed: loop.changed.length, openFindings: loop.findings.filter(one => one.status === 'open').length },
  }, 50)
  await save($, at.root, latest => note(latest, 'info', `handoff entry written (${by === 'builder' ? 'by the builder' : 'facts only'})`, now))
}

/**
 * /devloop handoff, `show [n]` and `export <path>`, all a person's. The
 * export is an ordinary write the person asked for, judged by the path rules
 * of the policy in force (no secret, no harness state, no protected file, no
 * locked test, nothing outside the repository); it is refused in every mode,
 * never only recorded.
 */
async function handoffCommand($: Engine, at: Place, policy: InForce, words: readonly string[], e: CommandRunInput): Promise<Answer> {
  if (!isFromPerson(e)) {
    return { text: 'This is a person\'s command; the builder writes its own entry with the devloop_handoff tool.' }
  }
  const sub = words[0] ?? ''
  if (sub === 'show') {
    const n = Number(words[1] ?? '1')
    const all = handoffEntries(await handoffText($, at.root))
    const count = Number.isFinite(n) && n > 0 ? Math.min(HANDOFFS_KEPT, Math.floor(n)) : 1

    return { text: all.length === 0 ? 'No handoff entries yet. The builder writes one with the devloop_handoff tool; /devloop handoff writes a facts-only one.' : [`The last ${Math.min(count, all.length)} of ${all.length} handoff entr${all.length === 1 ? 'y' : 'ies'}:`, '', ...all.slice(-count)].join('\n') }
  }
  if (sub === 'export') {
    const target = words.slice(1).join(' ').trim()
    if (target === '') {
      return { text: 'Name where to write them: /devloop handoff export <path in the repository>.' }
    }
    const loop = await loopOf($)
    const home = (await $.env.get('HOME').catch(() => undefined)) ?? null
    const where = whereOf(at.root, at.cwd, { home, stateRoot: await stateRootOf($) })
    const spelled = place(target, at.cwd, where)
    const resolved = spelled.abs === null ? null : await $.fs.stat(spelled.abs, { resolve: true }).then(one => one.realPath ?? null, () => null)
    const placed = resolved === null || resolved === spelled.abs ? [spelled] : [spelled, place(resolved, null, where)]
    const asFile = { ...where, folders: Object.fromEntries(placed.flatMap(one => (one.rel === null ? [] : [[one.rel, false]]))) }
    // Judged as the builder's write would be, with no exemption: a person's command cannot open a locked path either.
    const strict = { ...loop, allow: [] }
    const refusal = placed.some(one => one.rel === null || one.rel === '')
      ? 'it is not a file inside the repository'
      : placed.map(one => (isSecretPlace(one, policy.cfg) ? { reason: `${one.spelled} holds secrets` } : judgeWrite(one, policy.cfg, strict, asFile))).find(one => one !== null)?.reason ?? null
    if (refusal !== null) {
      return { text: `Not written: ${refusal}. Choose a path the guards would let a change write (not a secret, a protected file or a locked test).` }
    }
    const text = await handoffText($, at.root)
    if (text.trim() === '') {
      return { text: 'There are no handoff entries to export yet.' }
    }
    // A file already there is the person's to give up (C2.1).
    const isThere = await $.fs.exists(spelled.abs ?? `${at.root}/${target}`).catch(() => true)
    if (isThere && !(await confirm($, `${spelled.rel ?? target} already exists. Overwrite it with the ${handoffEntries(text).length} handoff entries?`, 'Overwrite it', 'Keep it'))) {
      return { text: `Nothing written: ${spelled.rel ?? target} is kept as it was.` }
    }
    await $.fs.write(spelled.abs ?? `${at.root}/${target}`, text)
    await audit($, at.root, 'handoff-exported', actorOf(e), spelled.rel ?? target, loop.tree, `${handoffEntries(text).length} entries`)

    return { text: `Wrote ${handoffEntries(text).length} handoff entries to ${spelled.rel ?? target}. It is an ordinary change to the working tree: the tree hash moves and the gate sees it like any other file.` }
  }
  if (sub !== '') {
    return { text: 'Use /devloop handoff, /devloop handoff show [n] or /devloop handoff export <path>.' }
  }
  await writeHandoff($, at, policy.cfg, 'person', null)

  return { text: 'A facts-only handoff entry was written to the harness\'s state (outside the working tree). A fresh session\'s first prompt is briefed from it; /devloop handoff show prints it.' }
}

/** /devloop questions, and `close <id> <answer>`, which is a person's key. */
async function questions($: Engine, at: Place, words: readonly string[], e: CommandRunInput): Promise<Answer> {
  const list = await questionsOf($, at.root)
  if (words[0] !== 'close') {
    return { text: questionsReport(list) }
  }
  const id = words[1] ?? ''
  const answer = words.slice(2).join(' ').trim()
  if (!isFromPerson(e)) {
    return { text: 'A question is closed by a person, from the prompt.' }
  }
  if (!/^Q\d+$/i.test(id) || answer === '') {
    return { text: 'Name the question and the answer: /devloop questions close Q1 <answer>.' }
  }
  const closed = closeQuestion(list, id, answer)
  if (closed === null) {
    return { text: `No open question ${id}. /devloop questions lists them.` }
  }
  if (!(await confirm($, `Close ${id.toUpperCase()} with the answer "${answer}"? The builder is told the answer.`, 'Close it', 'Leave it open'))) {
    return { text: `${id.toUpperCase()} stays open.` }
  }
  await saveQuestions($, at.root, closed)
  const asked = list.find(one => one.id.toLowerCase() === id.toLowerCase())

  return { text: `${id.toUpperCase()} is closed.`, context: [`The person answered the open question ${id.toUpperCase()} ("${asked?.question ?? ''}"): ${answer}`] }
}

// ---------------------------------------------------------------- doctor: instructions and skills (C1)

// Dependency and build folders are left out (the excludes after the
// instruction pathspecs), the shallowest files are taken first, and each
// kind stops at 400; `capped:<n>` says how many ignored ones matched past it.


/** The instruction files the policy's globs name, with whether git tracks each: `t` tracked, `u` untracked, `i` ignored. Null outside git. */
async function instructionFiles($: Engine, at: Place, cfg: Config): Promise<{ files: { path: string; kind: 't' | 'u' | 'i' }[]; capped: number | null } | null> {
  const ran = await git($, at, INSTRUCTION_FILES, sweepSpecsOf(cfg))

  return ran === null || ran.code !== 0 ? null : readInstructionFiles(ran.out)
}

/** The instruction and skill audit: lint lines, and the files git does not track. */
async function auditInstructions($: Engine, at: Place, cfg: Config): Promise<{ items: LintItem[]; untracked: string[]; isGit: boolean; capped: number | null }> {
  const sweep = await instructionFiles($, at, cfg)
  const listed = sweep?.files ?? null
  const exists = (rel: string): Promise<boolean> => $.fs.exists(`${at.root}/${rel}`).catch(() => false)
  const paths = listed ?? (await Promise.all(cfg.instructions.filter(glob => !/[*?[]/.test(glob)).map(async glob => ((await exists(glob)) ? { path: glob, kind: 't' as const } : null)))).filter((one): one is { path: string; kind: 't' } => one !== null)
  const files: InstructionFile[] = []
  for (const { path } of paths.slice(0, 200)) {
    const text = await $.fs.read(`${at.root}/${path}`).catch(() => null)
    if (text !== null) {
      files.push({ path, text })
    }
  }
  const existing = new Set<string>()
  for (const { path, text } of files) {
    const folder = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : ''
    for (const ref of referencedPaths(text).slice(0, 60)) {
      if ((await exists(ref)) || (folder !== '' && (await exists(`${folder}/${ref}`)))) {
        existing.add(ref)
      }
    }
  }
  let scripts: string[] | null = null
  if (await exists('package.json')) {
    try {
      scripts = Object.keys(((JSON.parse(await $.fs.read(`${at.root}/package.json`)) as { scripts?: Record<string, string> }).scripts) ?? {})
    } catch {
      scripts = []
    }
  }
  // A script after a `cd` is looked for in that folder's package.json (F2); a folder with none is not judged.
  const scriptsIn: Record<string, string[] | null> = {}
  for (const dir of [...new Set(files.flatMap(one => namedCommands(one.text).map(each => each.dir)))].filter(one => one !== '' && one !== '?').slice(0, 20)) {
    scriptsIn[dir] = null
    if (await exists(`${dir}/package.json`)) {
      try {
        scriptsIn[dir] = Object.keys(((JSON.parse(await $.fs.read(`${at.root}/${dir}/package.json`)) as { scripts?: Record<string, string> }).scripts) ?? {})
      } catch {
        scriptsIn[dir] = null
      }
    }
  }
  let targets: string[] | null = null
  for (const name of ['Makefile', 'makefile', 'GNUmakefile']) {
    if (targets === null && (await exists(name))) {
      targets = makeTargets(await $.fs.read(`${at.root}/${name}`).catch(() => ''))
    }
  }
  let hasFormatter = false
  for (const name of FORMATTERS) {
    hasFormatter = hasFormatter || (await exists(name))
  }
  const items = lintInstructions({ files, existing, scripts, scriptsIn, targets, hasFormatter, maxLines: cfg.instructionMaxLines, maxBytes: cfg.instructionMaxBytes })
  const skills: { path: string; text: string; hasMcp: boolean }[] = []
  for (const one of files.filter(each => /(^|\/)SKILL\.md$/.test(each.path))) {
    const folder = one.path.slice(0, Math.max(0, one.path.lastIndexOf('/')))
    skills.push({ ...one, hasMcp: await exists(`${folder === '' ? '' : `${folder}/`}.mcp.json`) })
  }
  items.push(...lintSkills(skills))
  items.push(...lintInjection(files))
  if (files.length === 0) {
    items.push({ level: 'ok', text: `no instruction files match ${cfg.instructions.join(', ')}` })
  }
  const untracked = (listed ?? []).filter(one => one.kind !== 't').map(one => `${one.path} (${one.kind === 'i' ? 'ignored by git' : 'not added to git'})`)

  return { items, untracked, isGit: listed !== null, capped: sweep?.capped ?? null }
}

/** Past this many tokens of tool definitions loaded on every request, doctor warns. */
export const TOOL_TOKENS_WARN = 15_000

/** How many tools the session offers and roughly what their definitions cost, as the engine reports it. */
async function toolDefinitions($: Engine): Promise<LintItem> {
  const tools = await $.tool.list().catch(() => null)
  const usage = await $.session.usage({ breakdown: 'summary' }).catch(() => null)
  const breakdown = usage?.context.breakdown
  if (breakdown !== undefined) {
    const mcp = breakdown.mcpTools.reduce((sum, one) => sum + one.tokens, 0)
    const system = (breakdown.systemTools ?? []).reduce((sum, one) => sum + one.tokens, 0)
    const loaded = mcp + system
    const count = tools?.length ?? breakdown.mcpTools.length + (breakdown.systemTools ?? []).length

    return {
      level: loaded > TOOL_TOKENS_WARN ? 'warn' : 'ok',
      text: `tools in context: ${count} available; about ${loaded} tokens of definitions (${system} built-in, ${mcp} from tool servers and plugins; the engine's estimate) sent with every request${loaded > TOOL_TOKENS_WARN ? `, over ${TOOL_TOKENS_WARN}: drop tool servers this repository does not use` : ''}`,
    }
  }
  if (tools === null) {
    return { level: 'warn', text: 'tools in context: the engine did not list them' }
  }
  const estimate = Math.ceil(tools.reduce((sum, one) => sum + one.name.length + one.description.length + JSON.stringify(one.inputSchema ?? {}).length, 0) / 4)

  return {
    level: estimate > TOOL_TOKENS_WARN ? 'warn' : 'ok',
    text: `tools in context: ${tools.length} available; about ${estimate} tokens of descriptions (an estimate from their text: characters / 4; schemas of built-in tools not counted)${estimate > TOOL_TOKENS_WARN ? `, over ${TOOL_TOKENS_WARN}` : ''}`,
  }
}

/** The meters /devloop metrics adds beside the loop's numbers: the session's cost, the prompt cache, the context cost. */
async function meterLines($: Engine, at: Place): Promise<string[]> {
  const counts = await metrics($, at.root)
  const n = (name: string): number => counts[name] ?? 0
  const usage = await $.session.usage().catch(() => null)

  const rules = Object.entries(counts).filter(([name]) => name.startsWith('rule:')).map(([name, count]) => `${name.slice(5)} ${count}`)

  return [
    `  changes closed: ${n('changes-closed')} (${n('closed-with-gate-open')} with the gate open)`,
    `  review rounds: ${n('review-rounds')}; first-round passes: ${n('review-first-pass')}`,
    `  guard refusals: ${n('guard-deny')}; observed only: ${n('guard-observe')}${rules.length > 0 ? ` (${rules.join(', ')})` : ''}`,
    `  exemptions granted: ${n('exemptions')}; reverts: ${n('reverts')}; lessons: ${n('lesson')}; blocked reports: ${n('blocked')}; papercuts: ${n('papercut')}`,
    usage?.cost !== undefined ? `  this session so far: about $${usage.cost.usd.toFixed(2)} (a client-side estimate, not a bill)` : '',
    `  cache misses recorded: ${n('cache-miss')}${n('cache-devloop-change') > 0 ? `; caused by devloop's own prefix changing (a bug): ${n('cache-devloop-change')}` : ''}`,
    ...cacheReport(await cacheOf($, at.root)),
    ...attributionReport(await attributionOf($, at.root)),
  ]
}

/** Runs one /devloop subcommand and answers with what the person reads. */
export async function command($: Engine, e: CommandRunInput, turnId: string | null = null): Promise<Answer> {
  const [name = 'status', ...rest] = e.args.trim().split(/\s+/)
  const arg = rest.join(' ')
  if (name === 'help') {
    return { text: HELP }
  }
  if (name === 'init') {
    return setup($, e)
  }
  const at = await locate($)
  if (name === 'doctor') {
    const said = await doctor($, at, rest.includes('--strict'))

    // The short cache-guard section (DESIGN 4.14), whether or not this repository has opted in.
    return { ...said, text: [said.text ?? '', ...(await cacheDoctorLines($).catch(() => ['Cache (cache-guard): could not be checked']))].join('\n') }
  }
  if (name === 'cache') {
    // cache-guard is the person's own, at user level: not tied to this repository's policy.
    return cacheCommand($, at, rest, e)
  }
  if (name === 'library') {
    // The spec library is the person's, across projects (DESIGN 4.18): only a save needs this repository's policy.
    return libraryCommand($, at, (await policyInForce($, at))?.cfg ?? null, rest, e)
  }
  // Every subcommand decides by the policy in force: the base branch's, whole.
  const policy = await policyInForce($, at)
  if (policy === null) {
    // A person's bare /devloop (or status) leads into setup; anyone else is told who sets it up.
    return (name === '' || name === 'status') && isFromPerson(e) ? setup($, e) : { text: NOT_SET_UP }
  }
  const cfg = policy.cfg
  switch (name === '' ? 'status' : name) {
    case 'status':
      return status($, at, cfg)
    case 'spec':
      return startSpec($, at, arg, e)
    case 'approve':
      return approve($, at, cfg, e)
    case 'verify': {
      if (cfg.verify.length === 0) {
        return { text: 'devloop.json names no verify commands.' }
      }
      const { ran, isRepeat } = await verifyNow($, at, cfg, 'full')
      const flaky = ran.flaky.length > 0 ? `\nPassed on a rerun, recorded as flaky: ${ran.flaky.join(' ; ')}` : ''

      return {
        text: ran.isPassing
          ? `Verification passed: ${ran.passed.length > 0 ? ran.passed.join(' ; ') : 'no check applies to this change'}${flaky}`
          : `Verification failed${isRepeat ? ' (the same failure as the last run)' : ''}.\n${ran.output}${flaky}`,
      }
    }
    case 'review': {
      const snap = await snapshot($, at, cfg)
      await save($, at.root, before => withSnapshot(before, snap, cfg))

      return { text: await startReview($, at, false, isFromPerson(e)) }
    }
    case 'continue': {
      const snap = await snapshot($, at, cfg)

      return continueCommand($, at, cfg, snap.branch, arg, e)
    }
    case 'gate':
      return gateCommand($, at)
    case 'findings':
      return findings($, at, cfg, rest, e)
    case 'done':
      return done($, at, cfg, e)
    case 'allow':
      return allow($, at, e.args.trim().replace(/^allow\b/, ''), e, turnId)
    case 'budget': {
      const usd = Number(arg)
      if (!isFromPerson(e) || !Number.isFinite(usd) || usd <= 0) {
        return { text: 'A person sets the cap in US dollars, from the prompt: /devloop budget 5' }
      }
      if (!(await confirm($, `Set this session's cost cap to about $${usd.toFixed(2)}? The guards refuse work past it.`, 'Set the cap', 'Leave it'))) {
        return { text: 'The cap is unchanged.' }
      }
      await audit($, at.root, 'budget-set', actorOf(e), `$${usd.toFixed(2)}`, null, 'an estimate-based cap for this session')
      await save($, at.root, before => ({ ...before, budgetUsd: usd, isOverBudget: false }))

      return { text: `This session's cap is now about $${usd.toFixed(2)}, measured against a client-side cost estimate.` }
    }
    case 'learn':
      return learnCommand($, at, cfg, e)
    case 'rules':
      return rulesCommand($, at, cfg, rest, e)
    case 'papercuts':
      return papercutsCommand($, at, rest, e)
    case 'regressions':
      return regressionsCommand($, at, rest, e)
    case 'defect':
      return defectCommand($, at, arg, e, cfg)
    case 'audit':
      return auditCommand($, at, arg)
    case 'report': {
      const { loop, snap } = await refresh($, at, cfg)
      const judged = (await policyInForce($, at, snap)) ?? policy

      return reportCommand($, at, judged.cfg, gate(loop, judged.cfg, factsOf(at, judged)))
    }
    case 'lesson': {
      if (arg === '') {
        return { text: 'Say what went wrong: /devloop lesson <text>.' }
      }
      await record($, at.root, 'lesson', arg.toLowerCase().slice(0, 60), arg)

      return { text: 'Recorded. /devloop learn groups lessons that repeat.' }
    }
    case 'eval':
      return evalCommand($, at, cfg, rest, e)
    case 'prune':
      return pruneCommand($, at, cfg, rest, e)
    case 'metrics':
      return metricsCommand($, at, rest.includes('--json'), () => meterLines($, at))
    case 'handoff':
      return handoffCommand($, at, policy, rest, e)
    case 'questions':
      return questions($, at, rest, e)
    case 'sandbox':
      return sandboxCommand($, cfg)
    case 'hooks':
      return hooksCommand($, at, rest, e)
    case 'claims':
      return claimsCommand($, at, rest, e)
    case 'followups':
      return followupsCommand($, at, rest, e)
    case 'checklists': {
      const snap = await snapshot($, at, cfg)
      const tags = Object.fromEntries((await taskFiles($, at).catch(() => [])).map(one => [one.id, one.task?.tags ?? []]))

      return checklistsCommand($, at, snap.tree === null ? null : snap.base, rest, e, { runs: await historyOf($, at.root).catch(() => []), tags })
    }
    default:
      return { text: `No such subcommand: ${name}\n${HELP}` }
  }
}
