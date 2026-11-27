// What the harness proves about the tree beside the checks, by reading git:
// credential shapes in the lines the change adds, the test files' content
// against what was approved, and files as the base branch has them.
// tests/smoke.sh runs these scripts against real git.

import type { EngineInterface } from 'claude-code'

import type { Evidence, Loop } from '../types'
import type { Config } from './config'
import { instructionGlobs, matchesAny } from './rules'
import { hiddenOf } from './inject'
import { addedLines, scanCredentials } from './scan'
import { ADDED_LINES, BASE_FILE } from './scripts'

type Engine = EngineInterface
/** Where the repository is: the folder git runs in. */
type At = { root: string }

/** Runs one of the harness's own git scripts in the repository; null when it could not run. */
async function git($: Engine, at: At, script: string, args: readonly string[], timeoutMs = 30_000): Promise<{ code: number; out: string } | null> {
  const ran = await $.process.run(['bash', '-c', script, 'devloop', ...args], { cwd: at.root, timeoutMs }).catch(() => null)

  return ran === null ? null : { code: ran.exitCode, out: ran.stdout }
}


const TEST_FILES = `
# devloop:test-files
git -c core.quotePath=false ls-files -co --exclude-standard 2>/dev/null | head -20000
`

const TEST_HASHES = `
# devloop:test-hashes
for f in "$@"; do
  if [ -f "$f" ]; then echo "$(git hash-object -- "$f") $f"; fi
done
`


/**
 * The content hash of every file matching the policy's `tests`, tracked or
 * new (ignored files left out), by path; null when git cannot say.
 */
export async function testHashesOf($: Engine, at: At, cfg: Config): Promise<Record<string, string> | null> {
  const listed = await git($, at, TEST_FILES, [])
  if (listed === null || listed.code !== 0) {
    return null
  }
  const files = listed.out.split('\n').filter(file => file !== '' && matchesAny(file, cfg.tests))
  const out: Record<string, string> = {}
  for (let i = 0; i < files.length; i += 200) {
    const hashed = await git($, at, TEST_HASHES, files.slice(i, i + 200), 60_000)
    if (hashed === null) {
      return null
    }
    for (const line of hashed.out.split('\n')) {
      const cut = line.indexOf(' ')
      if (cut > 0) {
        out[line.slice(cut + 1)] = line.slice(0, cut)
      }
    }
  }

  return out
}

/** A file as the base branch has it; null when the base has none (or there is no base). */
export async function baseFile($: Engine, at: At, base: string | null, path: string): Promise<string | null> {
  if (base === null) {
    return null
  }
  const ran = await git($, at, BASE_FILE, [base, path])

  return ran === null || ran.code !== 0 ? null : ran.out
}

/**
 * Proves what the gate's evidence rows need on the tree as it stands: no
 * credential shapes in the added lines, and which approved tests changed or
 * are new. A scan that cannot run leaves `tree` null, so the row stays unmet.
 */
export async function evidenceOf($: Engine, at: At, cfg: Config, loop: Loop, snap: { tree: string | null; base: string | null }): Promise<Evidence> {
  const none = { tree: null, credentials: [], testsChanged: [], testsAdded: [], hidden: [] }
  if (snap.tree === null) {
    return none
  }
  const diff = await git($, at, ADDED_LINES, [snap.base ?? 'HEAD'], 60_000)
  if (diff === null || diff.code !== 0) {
    return none
  }
  const credentials = scanCredentials(addedLines(diff.out))
  // Changed instruction files are read whole: an invisible or bidirectional character anywhere in one keeps the gate shut (C1).
  const hidden: Evidence['hidden'] = []
  for (const file of loop.changed.filter(one => matchesAny(one, instructionGlobs(cfg))).slice(0, 40)) {
    const text = await $.fs.read(`${at.root}/${file}`).catch(() => null)
    if (text !== null) {
      hidden.push(...hiddenOf(file, text).map(one => ({ file: one.file, line: one.line, kind: one.kind })))
    }
  }
  if (loop.phase !== 'build' || loop.testHashes === null) {
    return { tree: snap.tree, credentials, testsChanged: [], testsAdded: [], hidden }
  }
  const approved = loop.testHashes
  const now = await testHashesOf($, at, cfg)
  if (now === null) {
    return { ...none, credentials, hidden }
  }

  return {
    tree: snap.tree,
    credentials,
    hidden,
    testsChanged: Object.keys(approved).filter(file => now[file] !== approved[file]).sort(),
    testsAdded: Object.keys(now).filter(file => !(file in approved)).sort(),
  }
}
