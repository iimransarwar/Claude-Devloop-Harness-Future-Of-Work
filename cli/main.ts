// The command line (DESIGN 4.11): `node dist/devloop.mjs <command>`, the same
// policy with no agent at all, for CI, a pre-push git hook, people debugging
// a refusal, and the classic hooks. Stateless: it proves only what the
// repository and its git history prove, and never reads the plugin's store.
//
// Exit codes: 0 ok (green, passing, allowed), 1 not ok (not green, failing,
// refused), 2 a usage or policy error (an unknown command, no devloop.json).
// `--json` prints one JSON value instead of text.

import process from 'node:process'

import type { Phase } from '../types'
import { DEFAULTS } from '../hooks/config'
import { stateRootFrom } from '../hooks/enforce'
import { HARNESS_VERSION } from '../hooks/records'
import { liftOf } from '../hooks/rules'
import { NOT_OK, OK, USAGE, doctorCommand, gateCommand, sandboxCommand, verifyCommand } from './gate'
import type { Said } from './gate'
import { hookCommand } from './hook'
import { findRoot, policyInForce, whereFor } from './io'
import { judgeOne, verdictLines } from './judge'

const USE = `devloop ${HARNESS_VERSION}: the devloop policy with no agent (node dist/devloop.mjs <command>)

  gate [--pushing <commit>…]    prove the gate from the tree: checks, tier, blast radius, tests and
                                instruction files changed, the credential scan, policy changed,
                                check integrity; review only from a git note naming this tree
  verify [--profile fast|full]  run the base policy's checks for the change (full by default)
  doctor [--strict]             policy errors, instruction and skill lints, the injection scan, the
                                sandbox settings against the policy (--strict: exit 1 on an error)
  sandbox                       print the sandbox settings that match the policy (writes nothing)
  check-command '<text>' [--phase idle|spec|build]
  check-path <path> [--write | --content <text>] [--phase idle|spec|build]
                                the verdict the guards would give: rule, reason, lift class
  hook <event>                  a classic hook: PreToolUse, UserPromptSubmit or Stop (reads the hook's JSON on standard input)
  version                       the harness version

  --json   one JSON value instead of text
  Exit: 0 ok, 1 not ok, 2 usage or policy error.`

function flag(args: string[], name: string): string | null {
  const at = args.indexOf(name)
  if (at < 0) {
    return null
  }
  const value = args[at + 1] ?? ''
  args.splice(at, 2)

  return value
}

function phaseOf(args: string[]): Phase | null {
  const value = flag(args, '--phase')

  return value === null ? 'idle' : value === 'idle' || value === 'spec' || value === 'build' ? value : null
}

/** check-command and check-path: the verdict the guards would give for one call. */
function check(kind: 'command' | 'path', args: string[]): Said {
  const phase = phaseOf(args)
  const content = flag(args, '--content')
  const isWrite = args.includes('--write') || content !== null
  const operands = args.filter(one => one !== '--write')
  const subject = operands[0]
  if (phase === null || subject === undefined || operands.length !== 1) {
    return { code: USAGE, text: kind === 'command' ? "usage: check-command '<text>' [--phase idle|spec|build]" : 'usage: check-path <path> [--write | --content <text>] [--phase idle|spec|build]', json: { error: 'usage' } }
  }
  const cwd = process.cwd()
  const found = findRoot(cwd)
  const policy = policyInForce(found).policy
  const cfg = policy?.cfg ?? DEFAULTS
  const stateRoot = stateRootFrom(process.env.CLAUDE_PLUGIN_DATA)
  const where = whereFor(found.root, cwd, stateRoot)
  const call = kind === 'command'
    ? { tool: 'Bash', input: { command: subject } }
    : content !== null ? { tool: 'Write', input: { file_path: subject, content } }
    : isWrite ? { tool: 'Edit', input: { file_path: subject, old_string: '\u0000devloop-check-path', new_string: '' } } : { tool: 'Read', input: { file_path: subject } }
  const judged = judgeOne(call, cfg, policy !== null, where, found.root, phase)
  const mode = policy === null ? 'off (no devloop.json: only secrets are judged)' : cfg.mode

  return {
    code: judged.isHeld ? NOT_OK : OK,
    text: verdictLines(judged, mode).join('\n'),
    json: {
      rule: judged.verdict?.rule ?? null,
      id: judged.verdict?.id ?? null,
      reason: judged.verdict?.reason ?? null,
      lift: judged.verdict === null ? null : liftOf(judged.verdict.rule),
      isHeld: judged.isHeld,
      ships: judged.ships,
      mode: policy === null ? 'off' : cfg.mode,
      phase,
    },
  }
}

/** Runs one command; resolves to its exit code. */
export function main(argv: readonly string[]): number | Promise<number> {
  const args = [...argv]
  const isJson = args.includes('--json')
  const rest = args.filter(one => one !== '--json')
  const [name = '', ...more] = rest
  const stateRoot = stateRootFrom(process.env.CLAUDE_PLUGIN_DATA)
  let said: Said
  switch (name) {
    case 'hook':
      return hookCommand(more[0] ?? '')
    case 'version':
      said = { code: OK, text: HARNESS_VERSION, json: { version: HARNESS_VERSION } }
      break
    case 'gate': {
      // `--pushing <commit>…` (the pre-push hook): the commits a push sends, which must hold the tree the gate judges (final round, D1 F4).
      const at = more.indexOf('--pushing')
      const pushing = at < 0 ? null : more.slice(at + 1).filter(one => one !== '')
      said = pushing !== null && pushing.length === 0 ? { code: USAGE, text: 'usage: gate [--pushing <commit>…]', json: { error: 'usage' } } : gateCommand(findRoot(process.cwd()), pushing)
      break
    }
    case 'verify': {
      const profile = flag(more, '--profile') ?? 'full'
      said = profile === 'fast' || profile === 'full' ? verifyCommand(findRoot(process.cwd()), profile) : { code: USAGE, text: 'usage: verify [--profile fast|full]', json: { error: 'usage' } }
      break
    }
    case 'doctor':
      said = doctorCommand(findRoot(process.cwd()), more.includes('--strict'), stateRoot)
      break
    case 'sandbox':
      said = sandboxCommand(findRoot(process.cwd()), stateRoot, (process.env.CLAUDE_PLUGIN_DATA ?? '') !== '')
      break
    case 'check-command':
      said = check('command', more)
      break
    case 'check-path':
      said = check('path', more)
      break
    case 'help': case '--help': case '-h':
      said = { code: OK, text: USE, json: { usage: USE } }
      break
    default:
      said = { code: USAGE, text: USE, json: { error: 'usage' } }
  }
  process.stdout.write(`${isJson ? JSON.stringify(said.json, null, 2) : said.text}\n`)
  if (isJson && said.warnings !== undefined && said.warnings.length > 0) {
    process.stderr.write(`${said.warnings.join('\n')}\n`)
  }

  return said.code
}

const code = main(process.argv.slice(2))
if (typeof code === 'number') {
  process.exitCode = code
} else {
  void code.then(done => {
    process.exitCode = done
  })
}
