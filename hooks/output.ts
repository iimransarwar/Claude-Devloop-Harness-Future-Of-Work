// What a check printed, made useful: the part the model reads, and a
// fingerprint that stays the same when only noise changed. Pure: no `$`.

import type { Outcome } from '../types'

const ANSI = /\u001b\[[0-?]*[ -/]*[@-~]|\u001b\][^\u0007]*\u0007/g

const stripAnsi = (text: string): string => text.replace(ANSI, '')

/** The last lines of a command's output, which is where a failure says why. */
function tail(text: string, lines = 40, chars = 4000): string {
  const kept = text.trimEnd().split('\n').slice(-lines).join('\n')

  return kept.length > chars ? `…${kept.slice(-chars)}` : kept
}

/** A line that looks like it names the failure. */
const ERROR = /\berror\b|\bFAIL(ED)?\b|Error:|panicked|Traceback/i

/**
 * A stack frame inside the language runtime rather than the project: Node's
 * `node:internal/…` and built-in modules, Python's frozen import machinery.
 * The first frame in the project's own code says where to look; these do not.
 * The Node test runner prints its frames with no `at` (`Test.run
 * (node:internal/test_runner/test:631:25)`): those go too (carried into the
 * final round). A frame in the project's own files stays, however written.
 */
const RUNTIME_FRAME = /^\s*at\s.*(?:\(node:|\bnode:internal\/)|^\s*at node:|^\s*File "<frozen [^>]*>"|^\s*(?:async\s+)?[\w$.<>[\]]+(?:\s\[as [\w$]+\])?\s\(node:[^)]*\)\s*$|^\s*(?:async\s+)?node:internal\//

/**
 * The part of a failing check's output the model reads: the first lines that
 * look like errors (often far from the end, above a long stack or summary),
 * then the tail, within a cap. Runtime-internal stack frames are dropped first.
 */
export function distill(text: string, errorLines = 12, tailLines = 30, chars = 4000): string {
  const lines = stripAnsi(text).trimEnd().split('\n').filter(line => !RUNTIME_FRAME.test(line))
  const from = Math.max(0, lines.length - tailLines)
  const errors = lines.slice(0, from).filter(line => ERROR.test(line)).slice(0, errorLines)
  const end = tail(lines.slice(from).join('\n'), tailLines, errors.length > 0 ? Math.floor(chars / 2) : chars)
  if (errors.length === 0) {
    return end
  }
  const head = errors.join('\n')

  return `${head.length > chars / 2 ? `${head.slice(0, chars / 2)}…` : head}\n…\n${end}`
}

/**
 * The output with what changes between runs of the same failure taken out:
 * colour codes, line and column numbers, durations, hex numbers and hashes.
 */
export function normalizeOutput(text: string): string {
  return stripAnsi(text)
    .replace(/(\.[A-Za-z0-9]+)(?::\d+)+/g, '$1:_')
    .replace(/(\.[A-Za-z0-9]+)\(\d+(?:,\d+)?\)/g, '$1(_)')
    .replace(/\bline \d+/gi, 'line _')
    .replace(/\b\d+(?:\.\d+)?\s*(?:ms|s|sec|secs|seconds?|m|min|µs|us|ns)\b/g, '_t')
    .replace(/\b\d{1,2}:\d{2}:\d{2}(?:\.\d+)?\b/g, '_t')
    .replace(/\b0x[0-9a-f]+\b/gi, '_h')
    .replace(/\b[0-9a-f]{7,}\b/gi, '_h')
    .replace(/[ \t]+/g, ' ')
    .trim()
}

/** A short, stable hash (53-bit, cyrb53): enough to tell two failures apart. */
function hash(text: string): string {
  let a = 0xdeadbeef
  let b = 0x41c6ce57
  for (let i = 0; i < text.length; i += 1) {
    const c = text.charCodeAt(i)
    a = Math.imul(a ^ c, 2654435761)
    b = Math.imul(b ^ c, 1597334677)
  }
  a = Math.imul(a ^ (a >>> 16), 2246822507) ^ Math.imul(b ^ (b >>> 13), 3266489909)
  b = Math.imul(b ^ (b >>> 16), 2246822507) ^ Math.imul(a ^ (a >>> 13), 3266489909)

  return (4294967296 * (2097151 & b) + (a >>> 0)).toString(16).padStart(14, '0')
}

/** A short, stable name for any text: a folder per repository root, a file per command. */
export const digest = (text: string): string => hash(text)

/**
 * Which failure this is: the command and its normalized output. The same
 * fingerprint twice in a row means the fix in between did not change it.
 */
export const fingerprint = (command: string, output: string): string =>
  hash(`${command}\n${normalizeOutput(output)}`)

// How a check ended is part of the loop's record, so the contract defines it.
export type { Outcome }

/**
 * Classifies a finished check by its exit code alone (as `bash -c` reports
 * it): 127 is a program that could not be found, 126 one that could not be
 * run; 124 is `timeout`'s own, and -1 the harness's; 128 + a kill signal
 * (SIGKILL 137, SIGTERM 143, SIGINT 130, SIGABRT 134) is a check that was
 * killed. Anything else non-zero is a real failure, whatever it printed: a
 * test's output can say "not found" (B2.1), and calling a failure
 * infrastructure would spend no fix round on it. `output` is kept for callers.
 */
export function classify(code: number, _output = ''): Outcome {
  if (code === 0) {
    return 'pass'
  }
  if (code === 127 || code === 126) {
    return 'not-found'
  }
  if (code === 124 || code < 0) {
    return 'timeout'
  }
  if ([130, 134, 137, 143].includes(code)) {
    return 'killed'
  }

  return 'fail'
}

/** What to do about a check that could not run, by how it ended. */
export function infraAdvice(command: string, outcome: Outcome, timeoutSec: number, isBackground = false): string {
  switch (outcome) {
    case 'not-found':
      return `\`${command}\` could not run: its program was not found (exit 127). Install it, or fix the command in devloop.json; no code change fixes this.`
    case 'timeout':
      if (isBackground) {
        return `\`${command}\` stopped before it finished (exit 124: its own time limit, not devloop's). Check the command's own timeout; no code change to the work fixes this.`
      }
      return `\`${command}\` did not finish within ${timeoutSec}s, so devloop stopped waiting. Mark it "background": true in devloop.json: it then runs without holding anyone up, with no time limit. No code change to the work fixes this.`
    case 'killed':
      return `\`${command}\` was killed before it finished (out of memory, or stopped by the system). Free resources or rerun it; no code change to the work fixes this.`
    default:
      return ''
  }
}
