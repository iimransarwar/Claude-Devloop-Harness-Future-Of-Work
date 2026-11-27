// The command line's readers: the file system, git and the shell through
// Node, in place of the module's `$`. Everything the readers return is
// handed to the same pure functions the hooks module calls (hooks/*.ts):
// the policy in force (`decidePolicy`), the snapshot (`SNAPSHOT`,
// `readSnapshot`), the base (`FIND_BASE`), the check environment
// (`checkArgv`). Stateless: nothing here reads the plugin's store.

import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync, realpathSync } from 'node:fs'
import process from 'node:process'

import { parseConfig } from '../hooks/config'
import type { Config } from '../hooks/config'
import { decidePolicy } from '../hooks/inforce'
import type { InForce } from '../hooks/inforce'
import { classify, distill } from '../hooks/output'
import type { Outcome } from '../hooks/output'
import { expandAllNow, expandGlobReviewed } from '../hooks/glob'
import type { Listing } from '../hooks/glob'
import { GLOB_ROUNDS, globsAnswered, globsWanted, lintChecks, patternsOf, physicalPath, place, whereOf } from '../hooks/rules'
import { ENV_NAMES } from '../hooks/shell'
import type { Placed, Where } from '../hooks/rules'
import { BASE_POLICY, CURRENT_BRANCH, FIND_BASE, LS_FILES, PUSH_RANGE, SNAPSHOT, checkArgv, readSnapshot, sweepSpecsOf } from '../hooks/scripts'
import type { Snapshot } from '../hooks/scripts'
import { isVersion2, TASKS_DIR, TASKS_OFF } from '../hooks/tasks'
import type { TasksFacts } from '../hooks/tasks'

/** Runs a program; never throws. */
export function exec(argv: readonly string[], cwd: string, timeoutMs = 30_000, input?: string): { code: number; out: string; err: string; isTimeout: boolean } {
  const ran = spawnSync(argv[0] ?? 'true', argv.slice(1), { cwd, encoding: 'utf8', timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024, ...(input === undefined ? {} : { input }) })
  const isTimeout = ran.error !== undefined && /ETIMEDOUT/.test(String(ran.error))

  return { code: ran.status ?? (ran.signal !== null ? 128 + 15 : 127), out: ran.stdout ?? '', err: ran.stderr ?? '', isTimeout }
}

/** Runs one of the harness's own scripts (hooks/scripts.ts) in a folder, as the module does: `bash -c <script> devloop <args>`. */
export const script = (text: string, args: readonly string[], cwd: string, timeoutMs = 30_000): { code: number; out: string } =>
  exec(['bash', '-c', text, 'devloop', ...args], cwd, timeoutMs)

export function readText(path: string): string | null {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return null
  }
}

/**
 * Where a path leads once links are followed, placed: every place other than
 * its own, none when it leads nowhere else or cannot be told. A path not
 * there yet is placed by its folder. Links are followed from both places the
 * path is put (the thirteenth round, BB2): the text-folded one (`abs`, as the
 * reviewed build followed it) and, for a `..` after a link, the one the
 * kernel takes it to (`raw`, the eleventh round, V3); each is judged.
 */
export function realOf(path: Placed, where: Where): Placed[] {
  if (path.abs === null) {
    return []
  }
  const starts = [...new Set([path.abs, ...(path.raw === undefined ? [] : [physicalPath(path.raw, realOrNull)])])]
  const out: Placed[] = []
  for (const abs of starts) {
    const real = realPathOf(abs)
    for (const one of [abs, ...(real === null ? [] : [real])]) {
      if (one !== path.abs && !out.some(each => each.abs === one)) {
        out.push(place(one, null, where))
      }
    }
  }

  return out
}

/** Where one place leads once its links are followed, a file not there yet by its folder; null when it cannot be told. */
function realPathOf(abs: string): string | null {
  try {
    return realpathSync(abs)
  } catch {
    const cut = abs.lastIndexOf('/')
    try {
      const folder = realpathSync(cut <= 0 ? '/' : abs.slice(0, cut))

      return `${folder.replace(/\/$/, '')}/${abs.slice(cut + 1)}`
    } catch {
      return null
    }
  }
}

/** A folder's place once its links are followed; null when it cannot be told. */
function realOrNull(folder: string): string | null {
  try {
    return realpathSync(folder)
  } catch {
    return null
  }
}

/** The repository as the module's `look` finds it: the nearest folder up holding devloop.json, else the nearest holding `.git`. */
export type Found = { root: string; working: Config | null; text: string | null; errors: string[]; unused: string[] }

export function findRoot(start: string): Found {
  const up = (test: (dir: string) => boolean): string | null => {
    for (let dir = start; ;) {
      if (test(dir)) {
        return dir
      }
      const parent = dir.slice(0, dir.lastIndexOf('/'))
      if (parent === dir || dir === '' || dir === '/') {
        return null
      }
      dir = parent === '' ? '/' : parent
    }
  }
  const withPolicy = up(dir => existsSync(`${dir}/devloop.json`))
  if (withPolicy !== null) {
    const text = readText(`${withPolicy}/devloop.json`) ?? ''
    const parsed = parseConfig(text)

    return { root: withPolicy, working: parsed.cfg, text, errors: parsed.errors, unused: parsed.unused }
  }

  return { root: up(dir => existsSync(`${dir}/.git`)) ?? start, working: null, text: null, errors: [], unused: [] }
}

/** The base the snapshot would find, by a default branch; null when there is none. */
export function findBase(root: string, branch: string): string | null {
  const ran = script(FIND_BASE, [branch, ''], root)
  const said = ran.out.split('\n')[0]?.trim() ?? ''

  return ran.code !== 0 || said === '' || said === 'unknown' ? null : said
}

/** devloop.json as a commit holds it; null when it has none. */
export function policyTextAt(root: string, base: string | null): string | null {
  if (base === null) {
    return null
  }
  const ran = script(BASE_POLICY, [base], root)

  return ran.code === 0 ? ran.out : null
}

/**
 * The policy in force, as the module's `policyInForce` finds it with no
 * state: the base is looked for by the working copy's default branch (or
 * the default's), and again by the base copy's when it names another; the
 * decision is the shared pure one. Null: not opted in.
 */
export function policyInForce(found: Found, base?: string | null): { policy: InForce | null; base: string | null } {
  if (base !== undefined) {
    return { policy: decidePolicy(found.working, found.text, policyTextAt(found.root, base)), base }
  }
  const branch = found.working?.defaultBranch ?? parseConfig('{}').cfg.defaultBranch
  let at = findBase(found.root, branch)
  let policy = decidePolicy(found.working, found.text, policyTextAt(found.root, at))
  if (policy !== null && policy.source === 'base' && policy.cfg.defaultBranch !== branch) {
    const again = findBase(found.root, policy.cfg.defaultBranch)
    const next = decidePolicy(found.working, found.text, policyTextAt(found.root, again))
    if (next !== null && next.source === 'base') {
      policy = next
      at = again
    }
  }

  return { policy, base: at }
}

/** The working tree as git has it, by the policy in force (the module's `snapshot`, with no closed change on record). */
export function snapshot(root: string, cfg: Config): Snapshot {
  const ran = exec(['bash', '-c', SNAPSHOT, 'devloop', cfg.defaultBranch, '', ...sweepSpecsOf(cfg)], root, 60_000)

  return readSnapshot(ran.out)
}

/** The branch checked out: a name, `(detached)`, or null when it cannot be told. */
export function currentBranch(root: string): string | null {
  const ran = script(CURRENT_BRANCH, [], root, 10_000)
  const line = ran.out.split('\n').find(one => one.startsWith('branch:'))

  return ran.code !== 0 || line === undefined || line === 'branch:' ? null : line.slice('branch:'.length).trim()
}

/** The tracked files at or beneath each path, as the module's `filesUnder`. */
export function filesUnder(root: string, dirs: readonly string[]): Record<string, string[]> {
  if (dirs.length === 0) {
    return {}
  }
  const ran = script(LS_FILES, dirs.map(dir => (dir === '' ? '.' : dir)), root)
  if (ran.code !== 0) {
    return {}
  }
  const files = ran.out.split('\n').filter(line => line !== '')

  return Object.fromEntries(dirs.map(dir => [dir, files.filter(file => dir === '' || file === dir || file.startsWith(`${dir}/`))]))
}

/** The files a push to the default branch would land, from `source`; null when the remote branch is not known here. */
export function pushRange(root: string, cfg: Config, source: string): string[] | null {
  const lines = script(PUSH_RANGE, [cfg.defaultBranch, source], root).out.split('\n').filter(line => line !== '')

  return lines[0] !== 'known' ? null : lines.slice(1)
}

/** This repository's origin as `owner/name`, or null. */
export function remoteSlug(root: string, slug: (url: string) => string): string | null {
  const ran = exec(['git', 'remote', 'get-url', 'origin'], root, 10_000)

  return ran.code === 0 && ran.out.trim() !== '' ? slug(ran.out.trim()) : null
}

/**
 * One check, run as the module runs it: the policy's checkEnv decides the
 * environment. `capMs` cuts its time below the policy's limit (the classic
 * hook's budget on a ship, D1 F5); `isCut` says the cap, not the policy's
 * limit, stopped it, so it is no verdict on the check.
 */
export function runCheck(command: string, root: string, cfg: Config, capMs: number | null = null): { isPassing: boolean; code: number; outcome: Outcome; output: string; isCut: boolean } {
  const limit = cfg.verifyTimeoutSec * 1000
  const isCapped = capMs !== null && capMs < limit
  const ran = exec(checkArgv(command, cfg.checkEnv), root, isCapped ? Math.max(1, capMs) : limit)
  if (ran.isTimeout) {
    return { isPassing: false, code: -1, outcome: 'timeout', output: `No result within ${isCapped ? Math.round(capMs / 1000) : cfg.verifyTimeoutSec}s.`, isCut: isCapped }
  }
  const raw = `${ran.out}\n${ran.err}`.slice(-100_000)

  return { isPassing: ran.code === 0, code: ran.code, outcome: classify(ran.code, raw), output: distill(raw), isCut: false }
}

/** A commit's tree (`<commit>^{tree}`); null when git cannot say. */
export function treeOf(root: string, commit: string): string | null {
  const ran = exec(['git', 'rev-parse', '-q', '--verify', `${commit}^{tree}`], root, 10_000)
  const said = ran.out.trim()

  return ran.code === 0 && /^[0-9a-f]{7,64}$/.test(said) ? said : null
}

/** The facts the judge places paths by, for a call in `cwd`: the home, the temporary folder and the other variables a path may be placed through (R8), from this process's environment. */
export function whereFor(root: string, cwd: string, stateRoot: string | null): Where {
  const env = process.env
  const named = Object.fromEntries(ENV_NAMES.filter(name => name !== 'HOME' && name !== 'TMPDIR').map(name => [name, env[name] || null]))

  return whereOf(root, cwd, { home: env.HOME ?? null, tmp: env.TMPDIR || null, stateRoot, env: named })
}

/**
 * What the command's lookups found on disk (P-C), listed through Node by the
 * expanders the module shares (hooks/glob.ts), in the rounds the module takes
 * (`withGlobs`): each reading's own, kept apart (the fourteenth round, CC1).
 */
export function globsFor(command: string, where: Where): Where {
  // One listing per folder for the whole line. A link may lead to a folder, which a part in the middle of a pattern
  // follows in the extended reading (X11); the reviewed reading's expander takes a real folder alone (CC1).
  const listings = new Map<string, Listing>()
  const list = (dir: string): Listing => {
    const known = listings.get(dir)
    if (known !== undefined) {
      return known
    }
    let listing: Listing
    try {
      listing = readdirSync(dir, { withFileTypes: true }).map(one => ({ name: one.name, isDir: one.isDirectory() ? true : one.isSymbolicLink() ? null : false }))
    } catch {
      listing = null
    }
    listings.set(dir, listing)

    return listing
  }
  let at = where
  for (let round = 0; round < GLOB_ROUNDS; round += 1) {
    // What both readings ask is looked up, each kind by its own expander and kept apart (BB1, CC1).
    const wanted = globsWanted(command, at)
    if (wanted.length === 0) {
      break
    }
    at = globsAnswered(at, wanted, {
      reviewed: expandAllNow(patternsOf(wanted, 'reviewed'), list, expandGlobReviewed),
      extended: expandAllNow(patternsOf(wanted, 'extended'), list),
      spaced: expandAllNow(patternsOf(wanted, 'spaced'), list),
    })
  }

  return at
}

/** The working copy's lint and errors, for the gate's facts. */
export const lintOf = (cfg: Config): string[] => lintChecks(cfg.verify)

/** Whether a program is on the PATH, found without running anything. */
export function onPath(program: string): boolean {
  return (process.env.PATH ?? '').split(':').filter(dir => dir !== '').some(dir => existsSync(`${dir}/${program}`))
}

/**
 * The `.tasks` integration as a stateless reader finds it (D2): on where the
 * policy in force turns it on, the repository's tree declares version 2 and
 * the `tasks` command is on the PATH. A stateless reader proves no gate, so a
 * task is never finished through it (`canFinish` null refuses).
 */
export function tasksFacts(root: string, cfg: Config): TasksFacts {
  if (cfg.tasks.integrate === 'off') {
    return TASKS_OFF
  }
  const isOn = isVersion2(readText(`${root}/${TASKS_DIR}/config.yml`)) && onPath('tasks')

  return { isOn, canFinish: null, finishWhy: '' }
}
