// The guided setup: what a person answers, how the answers are read, the
// plain summary shown when setup is done, and the flow that asks and writes
// (`/devloop init`, and `/devloop` where no policy governs).

import type { CommandRunInput, CommandRunResult } from 'claude-code'

import { cacheGuardState, installCacheGuard } from './cachecmd'
import { isFromPerson } from './journal'
import { forget, locate, save, snapshotInForce, withSnapshot } from './state'
import type { Engine } from './state'
import { AGENTS, EVALS, REVIEW, configFile } from './templates'

/** A check setup proposes: a command, or one with a profile and the globs that scope it. */
export type Detected = string | { run: string; profile?: 'full'; when?: string[] }
export type Strictness = 'observe' | 'enforce'
export type Approvers = 'me' | 'two'
export type SetupAnswers = { mode: Strictness; verify: Detected[]; isVerifyLater: boolean; approvers: Approvers }

export const SET_UP_HEADLINE = 'devloop is set up.'

export const OPTIONS = {
  strict: ['Watch only (recommended)', 'Block from the start'],
  none: 'None for now',
  later: "I'll add it later",
  approvers: ['Just me (recommended)', 'Two people'],
  cache: ['Yes, everything (recommended)', 'Yes, but keep normal replies', 'Not now'],
  outsideGit: ['Cancel (recommended)', 'Set up anyway'],
} as const

const norm = (s: string): string => s.trim().toLowerCase()

export const readStrictness = (answer: string): Strictness | null => {
  const a = norm(answer)
  if (a === norm(OPTIONS.strict[0]) || a === 'watch' || a === 'watch only' || a === 'observe') return 'observe'
  if (a === norm(OPTIONS.strict[1]) || a === 'block' || a === 'enforce') return 'enforce'
  return null
}

export const readApprovers = (answer: string): Approvers | null => {
  const a = norm(answer)
  if (['me', 'just me', 'just me (recommended)', '1', 'one'].includes(a)) return 'me'
  if (['two', 'two people', '2'].includes(a)) return 'two'
  return null
}

export const readCache = (answer: string): '--all' | '--notify' | 'none' | null => {
  const a = norm(answer)
  if (a === norm(OPTIONS.cache[0]) || ['everything', 'all', 'yes'].includes(a)) return '--all'
  if (a === norm(OPTIONS.cache[1]) || ['normal', 'notify'].includes(a)) return '--notify'
  if (a === norm(OPTIONS.cache[2]) || ['no', 'not now', 'skip', 'none'].includes(a)) return 'none'
  return null
}

const runOf = (d: Detected): string => (typeof d === 'string' ? d : d.run)

export const foundLabel = (found: readonly Detected[]): string => {
  const text = found.map(runOf).join(' + ')
  return text.length > 60 ? `${text.slice(0, 59)}…` : text
}

export const readVerify = (answer: string, found: readonly Detected[]): { verify: Detected[]; isLater: boolean } => {
  const a = norm(answer)
  if (a === norm(OPTIONS.later)) return { verify: [], isLater: true }
  if (a === '' || a === 'no' || a === 'none' || a === norm(OPTIONS.none)) return { verify: [], isLater: false }
  if (found.length > 0 && answer.trim() === foundLabel(found)) return { verify: [...found], isLater: false }
  return { verify: [answer.trim()], isLater: false }
}

const PURPOSE: Record<string, string> = {
  'devloop.json': 'your settings (commit it to main: devloop reads it from there)',
  'REVIEW.md': 'what the reviewer looks for',
  'AGENTS.md': 'notes every Claude session reads',
  'evals/README.md': 'where regression tasks go',
}

export const summary = (a: SetupAnswers, wrote: readonly string[], kept: readonly string[], branch: { name: string; isGuessed: boolean }, options: { isOutsideGit?: boolean; cacheLine?: string } = {}): string => {
  const mode =
    a.mode === 'observe'
      ? 'Watch only: it notes what it would have blocked, and blocks nothing (it always blocks reading secret files).'
      : 'Block from the start: it refuses what its rules forbid.'
  const checks =
    a.verify.length > 0
      ? `Each time Claude stops after changing files, it runs: ${a.verify.map(runOf).join(' ; ')}`
      : 'Each time Claude stops after changing files, nothing will be checked until you add a command under "verify" in devloop.json, e.g. "verify": ["npm test"].'
  const approvers = a.approvers === 'me' ? 'Risky merges need your approval (just you).' : 'Risky merges need two people to approve.'
  const files = wrote.map((f) => `  ${f.padEnd(18)}${PURPOSE[f] ?? ''}`.trimEnd())
  const base = branch.isGuessed
    ? `Changes are measured against ${branch.name} (guessed: set "defaultBranch" in devloop.json if that is wrong).`
    : `Changes are measured against ${branch.name}.`
  return [
    SET_UP_HEADLINE,
    ...(options.isOutsideGit === true ? [OUTSIDE_GIT_LINE] : []),
    '',
    'What it will do here',
    `  - ${mode}`,
    `  - ${checks}`,
    ...(options.isOutsideGit === true ? [] : ['  - Before anything is pushed, a second agent reviews the change.']),
    `  - ${approvers}`,
    '',
    'Files it added',
    ...files,
    ...(kept.length > 0 ? [`Already there, left as is: ${kept.join(', ')}`] : []),
    '',
    base,
    'Change these later in devloop.json: "mode", "verify", "approvals".',
    ...(options.cacheLine === undefined ? [] : [options.cacheLine]),
    'Next: /devloop-doctor checks the setup.',
  ].join('\n')
}

/**
 * The checks a repository's own files name: fast ones by default, end-to-end
 * suites as `full`, each with `when` globs where the layout makes them
 * obvious (DESIGN 4.16): a Go, Rust or Python suite covers that language's
 * files and its manifests.
 */
async function detectVerify($: Engine, root: string): Promise<Detected[]> {
  const found: Detected[] = []
  const has = (file: string): Promise<boolean> => $.fs.exists(`${root}/${file}`)
  if (await has('package.json')) {
    try {
      const scripts = ((JSON.parse(await $.fs.read(`${root}/package.json`)) as { scripts?: Record<string, string> }).scripts) ?? {}
      for (const name of ['typecheck', 'lint', 'test']) {
        const body = scripts[name]
        if (body !== undefined && !body.includes('no test specified')) {
          found.push(name === 'test' ? 'npm test --silent' : `npm run --silent ${name}`)
        }
      }
      if (scripts.e2e !== undefined) {
        found.push({ run: 'npm run --silent e2e', profile: 'full' })
      }
    } catch {
      // An unreadable package.json names no checks.
    }
  }
  if ((await has('pyproject.toml')) || (await has('pytest.ini'))) {
    found.push({ run: 'pytest -q', when: ['**/*.py', 'pyproject.toml', 'pytest.ini', 'setup.cfg', 'requirements*.txt'] })
  }
  if (await has('go.mod')) {
    const when = ['**/*.go', 'go.mod', 'go.sum']
    found.push({ run: 'go vet ./...', when }, { run: 'go test ./...', when })
  }
  if (await has('Cargo.toml')) {
    found.push({ run: 'cargo test --quiet', when: ['**/*.rs', 'Cargo.toml', 'Cargo.lock'] })
  }

  return found
}

const DEFAULT_BRANCH = `
# devloop:default-branch
remote=$(git symbolic-ref -q --short refs/remotes/origin/HEAD 2>/dev/null) && { echo "$remote" | sed 's#^origin/##'; exit 0; }
for b in main master trunk develop; do
  git rev-parse -q --verify "refs/heads/$b" >/dev/null 2>&1 && { echo "$b"; exit 0; }
done
head=$(git symbolic-ref --short -q HEAD 2>/dev/null) && echo "guess:$head"
`

/**
 * The branch changes merge into, as the repository says: the remote's HEAD, a
 * usual name, or the one checked out; `main`, marked guessed, where it names none.
 */
export async function detectBranch($: Engine, root: string): Promise<{ name: string; isGuessed: boolean }> {
  const ran = await $.process.run(['bash', '-c', DEFAULT_BRANCH, 'devloop'], { cwd: root, timeoutMs: 10_000 }).catch(() => null)
  const line = (ran?.stdout ?? '').split('\n')[0]?.trim() ?? ''
  // The last resort, the checked-out branch, is a guess: the script marks it.
  const isGuessed = line.startsWith('guess:')
  const name = isGuessed ? line.slice('guess:'.length) : line

  return /^[\w./-]+$/.test(name) ? { name, isGuessed } : { name: 'main', isGuessed: true }
}

/**
 * Whether the folder is in a git work tree (`git`); outside one, each direct
 * subfolder holding a `.git` of its own (`sub:<dir>`, one a line), where the
 * repository the person meant may be.
 */
export const GIT_PROBE = `
# devloop:git-probe
if [ "$(git rev-parse --is-inside-work-tree 2>/dev/null)" = true ]; then echo git; exit 0; fi
for dir in */; do
  dir="\${dir%/}"
  if [ -e "$dir/.git" ]; then echo "sub:$dir"; fi
done
exit 0
`

/** What the probe found; a probe that could not run is taken as git, so setup goes on as it always did. */
async function probeGit($: Engine, root: string): Promise<{ isGit: boolean; subfolders: string[] }> {
  const ran = await $.process.run(['bash', '-c', GIT_PROBE, 'devloop'], { cwd: root, timeoutMs: 10_000 }).catch(() => null)
  if (ran === null) {
    return { isGit: true, subfolders: [] }
  }
  const lines = ran.stdout.split('\n').map(line => line.trim())

  return { isGit: lines.includes('git'), subfolders: lines.filter(line => line.startsWith('sub:')).map(line => line.slice(4)).filter(dir => dir !== '') }
}

const CANCELLED = 'Setup cancelled. Nothing was written.'
const NOT_GIT = "This folder isn't a git repository, so devloop can't see changes here."
const OUTSIDE_GIT_LINE = 'devloop will only see files Claude edits here: no diffs, no credential scan, no push gate.'
const INTRO =
  "devloop isn't set up here yet. Once it is, it runs your tests each time Claude stops, has a second agent review changes before they ship, and keeps Claude off secrets and risky files. Three questions: Enter takes the recommended answer."
const STRICT_QUESTION = 'Watch only notes what devloop would have blocked and blocks nothing; Block from the start refuses what its rules forbid. How strict should it be to start?'
const APPROVERS_QUESTION = 'A risky change needs a person to approve it before it merges; with Two people, someone working alone can never clear one. Who approves risky merges?'
const OUTSIDE_GIT_QUESTION = `${NOT_GIT} It would only see files Claude edits: no diffs, no credential scan, no push gate. Set it up anyway?`
const CACHE_QUESTION = 'cache-guard (bundled, needs Python) shows a status line with how warm your prompt cache is and warns before a cold cache costs you. Everything adds its status line, trimming of long command output, notices and a lean output style; normal replies keeps your replies as they are. Install it?'
const JUST_ME = { low: 0, medium: 1, high: 1 }

/** A detected check in full, as a person reads it: its profile and the globs that scope it. */
const named = (one: Detected): string =>
  typeof one === 'string' ? one : `${one.run}${one.profile === 'full' ? ' (full)' : ''}${one.when === undefined ? '' : ` (when ${one.when.join(' ')})`}`

/** One setup question; null when the person dismissed it (or no one could be asked). */
function ask($: Engine, question: string, options: readonly string[]): Promise<string | null> {
  return $.ui.ask(question, { options, header: 'Setup' }).catch(() => null)
}

/** A question whose typed answer must read as one of its options: asked again once, then null (cancel). */
async function askRead<T>($: Engine, question: string, options: readonly string[], read: (answer: string) => T | null): Promise<T | null> {
  const first = await ask($, question, options)
  if (first === null) {
    return null
  }
  const once = read(first)
  if (once !== null) {
    return once
  }
  const again = await ask($, `I didn't catch that. ${question}`, options)

  return again === null ? null : read(again)
}

/** A failed call's reason, as a person reads it: without the engine's `<plugin>: $.<call>:` lead or a closing period. */
const messageOf = (error: unknown): string =>
  (error instanceof Error ? error.message : String(error)).replace(/^\S+: \$\.[\w.]+: /, '').replace(/\.$/, '')

/**
 * The guided setup (`/devloop init`, and `/devloop` from a person where no
 * policy governs): checks that the folder is a git repository, asks three
 * questions, and writes the scaffold with the answers, never over a file that
 * is there. A dismissed question writes nothing.
 */
export async function setup($: Engine, e: CommandRunInput): Promise<CommandRunResult> {
  if (!isFromPerson(e)) {
    return { text: 'A repository is set up for the loop by a person, from the prompt.' }
  }
  // A policy at or above the session's root already governs it: a second one here would shadow it.
  forget()
  const found = await locate($)
  if (found.text !== null) {
    return { text: `This repository already has a policy: ${found.root.replace(/\/$/, '')}/devloop.json. Nothing was written. /devloop doctor audits it.` }
  }
  if (found.isOptedIn) {
    return { text: 'This repository\'s base branch has a devloop.json, which stays in force although the working tree\'s copy was deleted. Nothing was written: restore it from the base branch (git checkout <base> -- devloop.json) or change it there.' }
  }
  const root = await $.session.root().catch(() => $.session.cwd())
  const git = await probeGit($, root)
  if (!git.isGit) {
    // Subfolders matter only outside git: there, the repository the person meant is likely one of them.
    if (git.subfolders.length > 0) {
      const dirs = git.subfolders.map(dir => `${dir}/`)

      return {
        text: dirs.length === 1
          ? `${NOT_GIT} Found one in ${dirs[0]}: open Claude there and type /devloop. Nothing was written.`
          : `${NOT_GIT} Found git repositories in ${dirs.join(', ')}: open Claude in one of them and type /devloop. Nothing was written.`,
      }
    }
    const anyway = await ask($, OUTSIDE_GIT_QUESTION, OPTIONS.outsideGit)
    if (anyway === null || norm(anyway) !== norm(OPTIONS.outsideGit[1])) {
      return { text: CANCELLED }
    }
  }
  try {
    $.ui.log(INTRO)
  } catch {
    // The line is a courtesy: setup goes on without it.
  }
  const mode = await askRead($, STRICT_QUESTION, OPTIONS.strict, readStrictness)
  if (mode === null) {
    return { text: CANCELLED }
  }
  const detected = await detectVerify($, root)
  const verifyQuestion = detected.length > 0
    ? { question: `devloop found these checks: ${detected.map(named).join(' ; ')}. A command typed under Other replaces them. What runs your tests?`, options: [foundLabel(detected), OPTIONS.none] }
    : { question: 'devloop found no test command here. Type yours under Other (npm test, say), or pick one of these. What runs your tests?', options: [OPTIONS.none, OPTIONS.later] }
  const tests = await ask($, verifyQuestion.question, verifyQuestion.options)
  if (tests === null) {
    return { text: CANCELLED }
  }
  const { verify, isLater } = readVerify(tests, detected)
  const approvers = await askRead($, APPROVERS_QUESTION, OPTIONS.approvers, readApprovers)
  if (approvers === null) {
    return { text: CANCELLED }
  }
  // Asked before anything is written, so a dismissal still writes nothing; the install itself comes after.
  const guardState = await cacheGuardState($)
  const cache = guardState === 'available' ? await askRead($, CACHE_QUESTION, OPTIONS.cache, readCache) : null
  if (guardState === 'available' && cache === null) {
    return { text: CANCELLED }
  }
  const branch = await detectBranch($, root)
  const files: [string, string][] = [
    ['devloop.json', configFile(verify, branch.name, { mode, ...(approvers === 'me' ? { approvals: JUST_ME } : {}) })],
    ...((await $.fs.exists(`${root}/CLAUDE.md`)) ? [] : [['AGENTS.md', AGENTS] as [string, string]]),
    ['REVIEW.md', REVIEW],
    ['evals/README.md', EVALS],
  ]
  const wrote: string[] = []
  const kept: string[] = []
  for (const [file, text] of files) {
    try {
      if (await $.fs.exists(`${root}/${file}`)) {
        kept.push(file)
        continue
      }
      await $.fs.write(`${root}/${file}`, text)
    } catch (error) {
      // What was written stands (a devloop.json now governs): the next read must see it.
      forget()

      return { text: `Could not write ${file}: ${messageOf(error)}. Already written: ${wrote.length > 0 ? wrote.join(', ') : 'nothing'}.` }
    }
    wrote.push(file)
  }
  forget()
  const at = await locate($)
  // A first baseline names the tree but verifies nothing.
  const baseline = await snapshotInForce($, at)
  if (baseline !== null) {
    const { snap, policy } = baseline
    await save($, at.root, before => ({ ...withSnapshot(before, snap, policy.cfg), verify: { ...before.verify, status: 'none', tree: snap.tree, profile: 'none' } }))
  }
  let cacheLine: string
  if (guardState === 'installed') {
    cacheLine = 'cache-guard: already installed.'
  } else if (guardState === 'no-python') {
    cacheLine = 'cache-guard: skipped, it needs Python 3.8 or later.'
  } else if (cache === 'none' || cache === null) {
    cacheLine = 'cache-guard: not installed. /devloop cache install adds it later.'
  } else {
    // The answer is the person's confirmation; a failed install never fails setup.
    const done = await installCacheGuard($, at, [cache], e).catch((): { isOk: boolean; text: string } => ({ isOk: false, text: 'exit none):\ncache-guard could not be started.' }))
    const reason = (done.text.split('\n').slice(done.isOk ? 0 : 1).find(line => line.trim() !== '') ?? 'no output').trim().replace(/\.$/, '').slice(0, 160)
    cacheLine = done.isOk
      ? `cache-guard: installed (${cache === '--all' ? 'everything' : 'normal replies'}). Restart Claude Code to see its status line.`
      : `cache-guard: could not be installed (${reason}). /devloop cache install tries again.`
  }
  // Outside git the person chose this: the summary says, under its first line, what devloop cannot see.
  return { text: summary({ mode, verify, isVerifyLater: isLater, approvers }, wrote, kept, branch, { isOutsideGit: !git.isGit, cacheLine }) }
}
