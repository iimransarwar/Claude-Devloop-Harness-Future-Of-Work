/// <reference path="../cli/node.d.ts" />
// Parity across enforcement points (DESIGN 4.11, nanochat note 3): the table
// in tests/parity-table.ts, run through the two enforcement points that are
// separate programs:
//   (b) `node dist/devloop.mjs check-command|check-path` in the row's phase;
//   (c) the classic PreToolUse hook entry, fed the real hook JSON on stdin,
//       with no module loaded (it judges in small-fix mode, so only rows of
//       the idle phase run through it).
// The hooks module's own `tool.call` hook runs the same table in the plugin
// test world (tests/parity.test.ts, final round D1 F8): there is no second
// copy of the module's judging here. Two runs: the opted-in repository, and
// one with no devloop.json on either side (rows marked `dormant`), where the
// secrets rule alone holds. The policy turns the `.tasks` integration on;
// smoke.sh puts a `tasks` stand-in on the PATH.
// Run by tests/smoke.sh with bun (it needs Node and the bundle):
//   bun tests/parity.ts --setup <repository> <dormant repository> <remote>
//   bun tests/parity.ts <repository> <bundle> <state folder> <dormant repository>
// What selects this test is smoke.sh itself, never a variable a builder sets.

import { spawnSync } from 'node:child_process'
import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs'
import process from 'node:process'

import { PARITY_FILES, PARITY_LINKS, PARITY_OUTSIDE_LINKS, PARITY_POLICY, PARITY_UNTRACKED, ROWS, W2_SAMPLE, callOf, filled } from './parity-table'
import type { Row } from './parity-table'

const exec = (argv: string[], cwd: string, input?: string, env?: Record<string, string>): { code: number; out: string } => {
  const ran = spawnSync(argv[0] ?? 'true', argv.slice(1), { cwd, encoding: 'utf8', ...(input === undefined ? {} : { input }), env: { ...process.env, ...env } })

  return { code: ran.status ?? 1, out: `${ran.stdout ?? ''}${ran.stderr ?? ''}` }
}

/** The home the command line and the classic hook place `~` by. */
const HOME = process.env.HOME ?? '/root'

const write = (root: string, rel: string, text: string): void => {
  mkdirSync(`${root}/${rel}`.slice(0, `${root}/${rel}`.lastIndexOf('/')), { recursive: true })
  writeFileSync(`${root}/${rel}`, text)
}

/** Makes both repositories as the table describes them: the files, the links, the policy (the opted-in one only), on a feature branch. */
function setup(root: string, dormant: string, remote: string): void {
  for (const [at, isOptedIn] of [[root, true], [dormant, false]] as const) {
    mkdirSync(at, { recursive: true })
    exec(['git', 'init', '-q', '-b', 'main', '.'], at)
    exec(['git', 'config', 'commit.gpgsign', 'false'], at)
    exec(['git', 'remote', 'add', 'origin', remote], at)
    if (isOptedIn) {
      write(at, 'devloop.json', `${JSON.stringify(PARITY_POLICY, null, 2)}\n`)
    }
    for (const [rel, text] of Object.entries(PARITY_FILES)) {
      write(at, rel, text)
    }
    exec(['git', 'add', '-A'], at)
    exec(['git', 'commit', '-q', '-m', 'base'], at)
    exec(['git', 'checkout', '-q', '-b', 'feature'], at)
    for (const [rel, text] of Object.entries(PARITY_UNTRACKED)) {
      write(at, rel, text)
    }
    for (const [rel, to] of Object.entries(PARITY_LINKS)) {
      mkdirSync(`${at}/${rel}`.slice(0, `${at}/${rel}`.lastIndexOf('/')), { recursive: true })
      symlinkSync(`${at}/${to}`, `${at}/${rel}`)
    }
    for (const [path, to] of Object.entries(isOptedIn ? PARITY_OUTSIDE_LINKS : {})) {
      const link = path.replace('$ROOT', at)
      mkdirSync(link.slice(0, link.lastIndexOf('/')), { recursive: true })
      symlinkSync(`${at}/${to}`, link)
    }
  }
}

/** (b) the command line's check-command or check-path; null for a search, which it does not judge. */
function viaCli(row: Row, root: string, bundle: string, state: string): string | null | undefined {
  const text = filled(row.text, root, state, HOME)
  const argv = row.kind === 'command'
    ? ['node', bundle, 'check-command', text, '--phase', row.phase, '--json']
    : row.kind === 'read' ? ['node', bundle, 'check-path', text, '--phase', row.phase, '--json']
    : row.kind === 'write' ? ['node', bundle, 'check-path', text, '--content', row.content, '--phase', row.phase, '--json'] : null
  if (argv === null) {
    return undefined
  }
  const ran = exec(argv, root, undefined, { CLAUDE_PLUGIN_DATA: state })

  return (JSON.parse(ran.out) as { rule: string | null }).rule
}

/** (c) the classic PreToolUse hook entry, as the engine runs it, with no module loaded. */
function viaHook(row: Row, root: string, bundle: string, state: string, n: number): string | null {
  const call = callOf(row, root, state, HOME)
  const ran = exec(['node', bundle, 'hook', 'PreToolUse'], root, JSON.stringify({ session_id: 'parity', tool_use_id: `toolu_parity_${n}`, cwd: root, hook_event_name: 'PreToolUse', tool_name: call.tool, tool_input: call.input }), { CLAUDE_PLUGIN_DATA: state })
  const line = ran.out.split('\n').find(one => one.startsWith('{'))
  if (line === undefined) {
    return null
  }
  const reason = (JSON.parse(line) as { hookSpecificOutput?: { permissionDecisionReason?: string } }).hookSpecificOutput?.permissionDecisionReason ?? ''

  return /^devloop \(classic hook\): \[([a-z-]+)/.exec(reason)?.[1] ?? null
}

/** One run over the rows of one repository; resolves the number of disagreements. */
function runOf(label: string, rows: readonly { row: Row; n: number }[], root: string, bundle: string, state: string): number {
  let failures = 0
  const rules = new Set<string>()
  for (const { row, n } of rows) {
    const b = viaCli(row, root, bundle, state)
    const c = row.phase === 'idle' ? viaHook(row, root, bundle, state, n) : undefined
    const isSame = (b === undefined || b === row.expect) && (c === undefined || c === row.expect)
    if (row.expect !== null) {
      rules.add(row.expect)
    }
    const shown = row.kind === 'grep' || row.kind === 'glob' ? `${row.kind} ${JSON.stringify(row.text)}${row.path === undefined ? '' : ` in ${row.path}`}` : `${row.kind} ${JSON.stringify(row.text)}`
    process.stdout.write(`${isSame ? 'ok  ' : 'FAIL'} parity ${shown} (${row.phase}${row.dormant === true ? ', dormant' : ''}): expected ${row.expect ?? 'allowed'}; cli ${b === undefined ? 'n/a (searches)' : (b ?? 'allowed')}, classic hook ${c === undefined ? 'n/a (judges small-fix mode)' : (c ?? 'allowed')}\n`)
    failures += isSame ? 0 : 1
  }
  process.stdout.write(`parity (${label}): ${rows.length} rows, ${rules.size} rule classes, ${failures} disagreement${failures === 1 ? '' : 's'}\n`)

  return failures
}

/**
 * The test of the twelfth and thirteenth rounds (W2, BB6), kept on a sample: each line through the command line in the
 * opted-in repository. It must get the verdict recorded for it now, and no line the reviewed bundle of the ninth round
 * refused may be allowed, with no exception. Resolves the number of disagreements.
 */
function w2Of(root: string, bundle: string, state: string): number {
  let failures = 0
  for (const line of W2_SAMPLE) {
    const ran = exec(['node', bundle, 'check-command', filled(line.text, root, state, HOME), '--phase', 'idle', '--json'], root, undefined, { CLAUDE_PLUGIN_DATA: state })
    const now = (JSON.parse(ran.out) as { rule: string | null }).rule
    const isKept = line.ref === null || (line.now !== null && now !== null)
    const isSame = now === line.now && isKept
    process.stdout.write(`${isSame ? 'ok  ' : 'FAIL'} w2 ${JSON.stringify(line.text)}: the reviewed bundle ${line.ref ?? 'allowed'}, recorded now ${line.now ?? 'allowed'}; cli ${now ?? 'allowed'}${isKept ? '' : '; a line the reviewed bundle refused is allowed'}\n`)
    failures += isSame ? 0 : 1
  }
  process.stdout.write(`w2 sample: ${W2_SAMPLE.length} lines, ${failures} disagreement${failures === 1 ? '' : 's'}\n`)

  return failures
}

function main(): number {
  if (process.argv[2] === '--setup') {
    const [root, dormant, remote] = process.argv.slice(3)
    if (root === undefined || dormant === undefined || remote === undefined) {
      process.stderr.write('usage: bun tests/parity.ts --setup <repository> <dormant repository> <remote>\n')

      return 2
    }
    setup(root, dormant, remote)

    return 0
  }
  const [root, bundle, state, dormant] = process.argv.slice(2)
  if (root === undefined || bundle === undefined || state === undefined || dormant === undefined) {
    process.stderr.write('usage: bun tests/parity.ts <repository> <bundle> <state folder> <dormant repository>\n')

    return 2
  }
  const numbered = ROWS.map((row, n) => ({ row, n }))
  const opted = runOf('opted in', numbered.filter(one => one.row.dormant !== true), root, bundle, state)
  const asleep = runOf('dormant', numbered.filter(one => one.row.dormant === true), dormant, bundle, state)
  const kept = w2Of(root, bundle, state)

  return opted + asleep + kept === 0 ? 0 : 1
}

process.exitCode = main()
