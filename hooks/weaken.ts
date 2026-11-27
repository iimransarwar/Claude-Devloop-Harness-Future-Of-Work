// Whether an edit to a test hollows it: more tests skipped, focused or left
// to do, or fewer assertions. Rough by design (counts of well-known markers,
// not a parse of each framework), so it catches the honest shortcut, and a
// person's one-turn exemption lifts it. Pure: no `$`.

/**
 * Where a marker may start: never after a dot, `$` or an identifier
 * character, so `model.fit(X, y)` or `parser.xit(t)` is not a focused or
 * skipped test (B2.1 F8).
 */
const AT_START = '(?<![\\w.$])'

/**
 * Markers that switch a test off or narrow a run to some tests, across the
 * common frameworks: Jest/Vitest/Mocha `.skip`/`.only`/`.todo`, `xit` and
 * `xdescribe`, `fit` and `fdescribe`, pytest's skip and xfail marks (a
 * decorator or a module's `pytestmark`) and calls, unittest's skips and
 * `SkipTest`, Go's `t.Skip`, Rust's `#[ignore]`, JUnit's `@Disabled` and
 * `@Ignore`. Each counts only at the start of a call.
 */
const SKIPS: readonly RegExp[] = [
  new RegExp(`${AT_START}(?:it|test|describe|context|suite|specify)\\.(?:skip|only|todo|failing)\\b`, 'g'),
  new RegExp(`${AT_START}x(?:it|test|describe|context|specify)\\s*\\(`, 'g'),
  new RegExp(`${AT_START}f(?:it|describe)\\s*\\(`, 'g'),
  new RegExp(`${AT_START}pytest\\.mark\\.(?:skip|skipif|xfail)\\b`, 'g'),
  new RegExp(`${AT_START}pytest\\.(?:skip|xfail|importorskip)\\s*\\(`, 'g'),
  /@unittest\.(?:skip|skipIf|skipUnless|expectedFailure)\b/g,
  /\braise\s+(?:unittest\.)?SkipTest\b/g,
  new RegExp(`${AT_START}t\\.Skip(?:f|Now)?\\s*\\(`, 'g'),
  /#\[ignore\b/g,
  /@(?:Disabled|Ignore)\b/g,
]

/**
 * Runner overrides that stop tests from running: a Go `TestMain` that never
 * calls `m.Run()` (it exits, or returns, before any test runs).
 */
function overrides(text: string): number {
  return /\bfunc\s+TestMain\s*\(/.test(text) && !/\.Run\s*\(\s*\)/.test(text) ? 1 : 0
}

/** What reads as an assertion: `expect(`, `assert…(` (unittest's `self.assertEqual(` too), a bare `assert`, Go's `t.Error`/`t.Fatal`, Rust's `assert!`. */
const ASSERTIONS: readonly RegExp[] = [
  /\bexpect\s*[(.]/g,
  /\bassert(?:_\w+|[A-Z]\w*)?!?\s*\(/g,
  /^\s*assert\s+\S/gm,
  /\bt\.(?:Error|Errorf|Fatal|Fatalf|Fail|FailNow)\s*\(/g,
  /\.should\b/g,
]

const count = (text: string, patterns: readonly RegExp[]): number =>
  patterns.reduce((sum, pattern) => sum + (text.match(pattern)?.length ?? 0), 0)

export type TestCounts = { skips: number; assertions: number }

/** How many skip-like markers (runner overrides among them) and assertions a test file's text holds. */
export const countMarkers = (text: string): TestCounts => ({ skips: count(text, SKIPS) + overrides(text), assertions: count(text, ASSERTIONS) })

export type TestEdit = {
  /** More skip, only, todo or xfail markers after than before: refused. */
  isWeakened: boolean
  /** Fewer assertions after than before: a gate note. */
  isAssertionDrop: boolean
  /** A file that had content now has none: a deletion by the edit tool. */
  isEmptied: boolean
  before: TestCounts
  after: TestCounts
}

/** Compares a test file's text before and after one edit; a file being created has `''` before, so any marker in it is a rise. */
export function judgeTestEdit(before: string, after: string): TestEdit {
  const was = countMarkers(before)
  const now = countMarkers(after)

  return {
    isWeakened: now.skips > was.skips,
    isAssertionDrop: now.assertions < was.assertions,
    isEmptied: before.trim() !== '' && after.trim() === '',
    before: was,
    after: now,
  }
}

/**
 * The text an edit tool leaves: `Write`'s content, or `Edit` applied to the
 * text before (every occurrence with `replace_all`). An `Edit` with an
 * empty `old_string` creates the file: it is judged as a write of the new
 * content (C2.1 F7). Null when it cannot be told (a notebook, an
 * `old_string` not in the file).
 */
export function editedText(before: string, input: { tool: string; content?: unknown; old_string?: unknown; new_string?: unknown; replace_all?: unknown }): string | null {
  if (input.tool === 'Write') {
    return typeof input.content === 'string' ? input.content : null
  }
  if (input.tool !== 'Edit' || typeof input.old_string !== 'string' || typeof input.new_string !== 'string') {
    return null
  }
  if (input.old_string === '') {
    return input.new_string
  }
  if (!before.includes(input.old_string)) {
    return null
  }

  return input.replace_all === true ? before.split(input.old_string).join(input.new_string) : before.replace(input.old_string, () => input.new_string as string)
}
