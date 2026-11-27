# Agent-driven Review Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Review rounds start at the agent's stops and when the agent asks, slow suites run in the background with no time limit, the reviewer sees the latest test results, and the person gets one summary when a review cycle ends.

**Architecture:** A verify entry may be `"background": true`: it leaves both profiles and runs through `$.process.spawn` from a new `hooks/background.ts`. It starts at every stop that ends the turn. Results are recorded per check (`loop.verify.runs`, `loop.verify.passedOn`) and runs in progress in `loop.background`. The pure words and decisions live in a new `hooks/testruns.ts` (what each check last did on a tree), in `hooks/gate.ts` (when a round may start) and in `hooks/findings.ts` (the reviewer's block, the summary). `hooks/review.ts` starts rounds at every stop under one rule that the new `devloop_review` tool shares. A pass ends a review cycle, so the next edit starts again at round 1.

**Tech Stack:** TypeScript hooks module on the Claude Code plugin engine (`$.process.spawn`, `$.prompt.submit`, `tool.register`, `ui.render` on `AbovePrompt`); tests on `claude-code/testing` with the in-memory world in `tests/world.ts`; `bun` for the bundle.

**Spec:** `docs/superpowers/specs/2026-11-27-agent-driven-review-design.md`. Its "Rules settled after the builder check" (1–6) and "Rulings after planning" (7–12) are binding and override §1–§5 where they differ. Rule 2 replaces §3's "fix round within `maxFixRounds`". Rule 5 makes the cap per cycle. Rule 11 makes a discarded round count toward that cap. Rule 7 makes "Not reviewed" a follow-up line at a later stop.

`CheckRecord` (a check's latest run in the loop, new here) is a different type from `hooks/portable.ts`'s existing `CheckRun` (what the command line ran).

**Depends on:** the `settings-panel` branch, finished. Task 3 extends `barParts(loop, cfg, checks)` in `hooks/statusbar.ts`, which settings-panel's Task 4 creates (that file did not exist yet when this plan was written).

## Global Constraints

- Work on branch `agent-review`, created from the `settings-panel` branch's final commit. Never push.
- Plain one-line commit messages with no `Co-Authored-By` or any Claude attribution.
- `git add` only the files a task names. Untracked `AGENTS.md`, `REVIEW.md`, `devloop.json`, `evals/`, `.DS_Store` files, `docs/superpowers` plan/spec files and `.superpowers/` stay uncommitted. Do not modify `.git/info/exclude`. Never run cache-guard's real installer.
- After changing a bundled module (anything `cli/` imports from `hooks/`: config, gate, records, scripts, etc.; the bundle also holds `findings`, `fresh`, `output`, `portable`, `rules`, and `testruns` once `gate.ts` imports it), rebuild with `bash scripts/build.sh` and commit `dist/devloop.mjs`. Every task runs the build before committing, and adds `dist/devloop.mjs` whenever `git status --short dist/` lists it.
- Checks: `claude plugin test .` 0 fail; `claude plugin validate .`; the type check below (baseline 7 errors in `tests/loop.test.ts`; add none); `bash tests/smoke.sh` no FAIL lines beyond the environmental baseline.
- Type check: `.superpowers/tsc.json` = `{ "extends": "../tsconfig.json", "include": ["../hooks", "../types", "../tests", "../cli", "/private/tmp/claude-501/bundled-skills/2.1.332/0b6894d9201ce74370ec13e9b0abe3f1/plugin-authoring/types/claude-code.d.ts"] }`, then `bunx tsc -p .superpowers/tsc.json --noUnusedLocals --noUnusedParameters 2>&1 | grep 'error TS'` prints exactly the 7 baseline lines.
- Release as `0.5.0` (`.claude-plugin/plugin.json`) in the last task, with README/REFERENCE updates.
- Unchanged: `maxReviewRounds` (default 3), `maxFixRounds`, who may merge, the reviewer's read-only limit, the 600 cap on `verifyTimeoutSec` for foreground checks, the settings popup's Tests row, and setup's question 2.
- Loop shape: `SHAPE` in `hooks/state.ts` goes from `loop-12` to `loop-13` once (Task 1); later tasks add fields under the same tag, since the branch is unreleased.
- Copy the spec fixes, used verbatim: `autoReview is off: a person starts rounds with /devloop review`; `This tree was already reviewed in round <n>.`; `tests still running (started <m> ago)`; the status bar's tests part reads `running <m>…` (the row reads `tests running 12m…`), then `✓ passed` / `✗ failing`; the config error the doctor lists says `Mark long checks "background": true`; the summary is the four lines of §5, and each fixed finding is named by the first 60 characters of its problem text; the follow-up line is `Not reviewed: <N> files changed after round <cap>.` (rule 7); a background row with `--no-background` reads `not checked here (background): CI or the session's background run proves it` (rule 12).
- Durations read as `ago(ms)`: `<1m` under a minute, `14m`, `1h 5m` from an hour on.

## Review Focus

1. Edits while a round runs, which becomes common once rounds start at every stop. Expected: the verdict is discarded; it counts toward the cycle's cap (rule 11) but not toward the loop limit; the next round reads the whole change, not just the lines since the tree no one reviewed; and the old tree is never reviewed again (Task 4 test).
2. A background check that cannot run (exit 127) or is killed. Expected: a toast with advice, no wake-up, no failed round, and no restart at every stop on the same tree (Task 3 test).
3. The session or plugin ends while a background run is going. Expected: it does not show "running" forever, and the next stop starts it again (Task 2 test).
4. A background failure while a spec is still being written. Expected: it is recorded and shown, nobody is woken, and it is not counted (Task 3 test).
5. Outside git (no tree hash). Expected: background checks never start, and the gate row says why instead of waiting forever (Task 1 and Task 2 tests).

---

### Task 0: `--all` includes keep-warm (user request)

Added at the person's request: in devloop, "everything" for cache-guard also keeps the cache warm while they are away. The vendored `cache-guard/` is not edited (`scripts/vendor-cache-guard.sh` re-syncs it); devloop expands the flag.

**Files:**
- Modify: `hooks/cacheguard.ts` (`INSTALL_FLAGS['--all']` text; `installFlags` expands `--all` to `--all --keepwarm` unless `--no-keepwarm` is also given), `hooks/setup.ts` (`CACHE_QUESTION` text)
- Modify: `README.md`, `docs/REFERENCE.md` (where `--all` is described)
- Test: `tests/setup.test.ts`, `tests/cacheguard.test.ts`

**Interfaces:**
- Produces: `installFlags(['--all'])` → `{ flags: ['--all', '--keepwarm'] }`; `installFlags(['--all', '--no-keepwarm'])` → `{ flags: ['--all', '--no-keepwarm'] }`. `INSTALL_FLAGS['--all']` = `--notify, --lean and --keepwarm; it never turns on the trimmer (only --trim does)`.
- `CACHE_QUESTION` replaces its "Everything adds …" sentence with: `Everything adds cache-expiry notices, makes the Lean (short replies) output style the default, and keeps the cache warm while you are away: about once an hour it wakes Claude for a one-word reply, which uses a little of your quota, and stops after 12 hours or when you are back. Normal replies adds only the notices.`

- [ ] **Step 1: Write the failing tests**

```ts
test('--all expands to keep-warm too', () => {
  expect(installFlags(['--all'])).toEqual({ flags: ['--all', '--keepwarm'] })
  expect(installFlags(['--all', '--no-keepwarm'])).toEqual({ flags: ['--all', '--no-keepwarm'] })
})
test('Enter through setup installs with --all --keepwarm', async ($, on) => {
  const w = world(on, null); w.pythonVersion = '3.12'; await start($)
  await devloop($, '')
  expect(w.cacheInstalls).toEqual([['install', '--all', '--keepwarm']])
})
test('the cache question discloses keep-warm pings and quota', async ($, on) => {
  const w = world(on, null); w.pythonVersion = '3.12'; await start($)
  await devloop($, '')
  expect(w.questions[3]).toMatch(/keeps the cache warm while you are away/)
  expect(w.questions[3]).toMatch(/uses a little of your quota/)
})
```

Update the existing tests that expect `[['install', '--all']]` (setup and settings popup Install) to `[['install', '--all', '--keepwarm']]`.

- [ ] **Step 2: Run to see them fail** — `claude plugin test . 2>&1 | grep -E "\(fail\)" | head`

- [ ] **Step 3: Implement the expansion, the flag text and the question text; update README/REFERENCE where `--all` is described**

- [ ] **Step 4: Run tests, validate, type check** — 0 fail; validate passed; only the 7 baseline type errors.

- [ ] **Step 5: Commit**

```bash
git add hooks/cacheguard.ts hooks/setup.ts README.md docs/REFERENCE.md tests/setup.test.ts tests/cacheguard.test.ts tests/settings.test.ts
git commit -m "Make --all keep the cache warm too"
```

---

### Task 1: Background checks in the policy and the gate

**Files:**
- Create: `hooks/testruns.ts` (pure: no `$`, no engine import, since `gate.ts` pulls it into the bundle)
- Modify: `hooks/config.ts` (`Step.background`, `step()`, the `verifyTimeoutSec` error over 600), `hooks/rules.ts` (`stepsFor` leaves background checks out; `backgroundFor`), `hooks/gate.ts` (`GateFacts.now`; `verificationRow` gains `facts`), `hooks/portable.ts` (`checksFor`), `hooks/limits.ts` (`checksForChange`, `unscopedFull`), `hooks/context.ts` (`policyFacts`), `hooks/output.ts` (`infraAdvice` timeout copy), `hooks/commands.ts` (`describeStep`), `types/index.d.ts`, `hooks/fresh.ts`, `hooks/state.ts` (`SHAPE`), `dist/devloop.mjs`
- Test: `tests/background.test.ts`

**Interfaces:**
- Consumes: `parseConfig`, `stepsFor`, `gate`, `NO_FACTS`, `Outcome` (`hooks/output.ts`).
- Produces:
  - `Step.background?: true`. The key is present only on a background check, so a parsed foreground step stays `{ run, profile, when }`.
  - `backgroundFor(steps: readonly Step[], changed: readonly string[]): Step[]` in `hooks/rules.ts`: the background checks whose `when` matches a changed file, or that have no `when`.
  - `type CheckRecord = { tree: string | null; outcome: Outcome; at: number; durationMs: number; lines: string; isOlderTree: boolean; saved: string | null }`. `lines` holds at most the first 10 lines of the distilled output (`''` on a pass); `saved` is where the whole output was kept.
  - `type BackgroundRun = { tree: string | null; startedAt: number }`.
  - `Loop.verify.runs: Record<string, CheckRecord>` (each check's latest run, by command) and `Loop.background: Record<string, BackgroundRun>` (runs going now, by command). Both are `{}` in `FRESH`.
  - `GateFacts.now?: number`, and `ago(ms: number): string` in `hooks/testruns.ts`.

- [ ] **Step 1: Create the branch**

Run: `git switch settings-panel && git switch -c agent-review && ls hooks/statusbar.ts`
Expected: `Switched to a new branch 'agent-review'`, then `hooks/statusbar.ts`. If the file is missing, stop: settings-panel is not finished.

- [ ] **Step 2: Write the failing tests** in `tests/background.test.ts`

Imports: `describe`, `expect`, `test` (`claude-code/testing`); `DEFAULTS`, `parseConfig`, types `Config`, `Step` (config); `gate`, `NO_FACTS` (gate); `backgroundFor`, `stepsFor` (rules); `checksFor` (portable); `checksForChange` (limits); `policyFacts` (context); `infraAdvice` (output); `ago` (testruns); `FRESH` (state); types `CheckRecord`, `Loop` (`../types`). Task 2 adds `change`, `CONFIG`, `start`, `stop`, `world`, types `Dollar`, `World` (`./world`) and `whenSettled`; Task 3 adds `bash`, `devloop`, `prompt`.

```ts
const fast = (run: string, when: string[] | null = null): Step => ({ run, profile: 'fast', when })
const full = (run: string): Step => ({ run, profile: 'full', when: null })
const bg = (run: string, when: string[] | null = null): Step => ({ run, profile: 'fast', when, background: true })
const FAILED: CheckRecord = { tree: 't1', outcome: 'fail', at: 0, durationMs: 1, lines: 'x', isOlderTree: false, saved: null }

describe('background checks in the policy', () => {
  test('a verify entry may be a background check', () => {
    const { cfg, errors } = parseConfig(JSON.stringify({ verify: ['npm test', { run: 'bash tests/run-all.sh', background: true }] }))
    expect(errors).toEqual([])
    expect(cfg.verify).toEqual([fast('npm test'), bg('bash tests/run-all.sh')])
  })
  test('background that is not true or false is named, and the check stays in the foreground', () => {
    const { cfg, errors } = parseConfig(JSON.stringify({ verify: [{ run: 'x', background: 'yes' }] }))
    expect(errors).toEqual(['verify[0].background: expected true or false; it runs in the foreground'])
    expect(cfg.verify).toEqual([fast('x')])
  })
  test('verifyTimeoutSec over 600 says to mark long checks background', () => {
    const { cfg, errors } = parseConfig(JSON.stringify({ verifyTimeoutSec: 3600 }))
    expect(cfg.verifyTimeoutSec).toBe(300)
    expect(errors).toEqual(['verifyTimeoutSec: expected a number from 0 to 600; using 300. Mark long checks "background": true in verify: they run with no time limit, and only shipping waits for them'])
    expect(parseConfig(JSON.stringify({ verifyTimeoutSec: -1 })).errors).toEqual(['verifyTimeoutSec: expected a number from 0 to 600; using 300'])
  })
  test('background checks are in neither profile; backgroundFor applies when', () => {
    const steps = [fast('unit'), full('e2e'), bg('slow', ['src/**'])]
    expect(stepsFor(steps, 'full', ['src/a.ts']).map(one => one.run)).toEqual(['unit', 'e2e'])
    expect(backgroundFor(steps, ['src/a.ts']).map(one => one.run)).toEqual(['slow'])
    expect(backgroundFor(steps, ['docs/a.md'])).toEqual([])
  })
  test('the agent, the context line and the command line know them', () => {
    const cfg: Config = { ...DEFAULTS, verify: [fast('unit'), bg('slow')] }
    expect(policyFacts(cfg, 'enforce')).toMatch(/runs `unit`; run them yourself first\. `slow` runs in the background after your stops, with no time limit; only shipping waits for it\./)
    expect(policyFacts({ ...DEFAULTS, verify: [bg('slow')] }, 'enforce')).not.toMatch(/no verify commands/)
    expect(checksForChange(cfg, ['src/a.ts'])).toBe('Checks for what you changed: `unit`, `slow` (runs in the background).')
    expect(checksFor(cfg, ['src/a.ts'], false)).toEqual(['unit', 'slow'])
    expect(infraAdvice('x', 'timeout', 600)).toBe('`x` did not finish within 600s. Raise "verifyTimeoutSec" in devloop.json (600 at most) or mark the check "background": true; no code change to the work fixes this.')
    expect([ago(0), ago(59_999), ago(14 * 60_000), ago(65 * 60_000)]).toEqual(['<1m', '<1m', '14m', '1h 5m'])
  })
})

describe('the verification row', () => {
  const cfg: Config = { ...DEFAULTS, verify: [fast('unit'), bg('slow')] }
  const base: Loop = { ...FRESH, tree: 't1', tier: 'medium', changed: ['src/a.ts'], verify: { ...FRESH.verify, status: 'pass', tree: 't1', profile: 'fast', passedOn: { unit: 't1' } } }
  test('wants a recorded pass of each background check on this tree', () => {
    expect(gate(base, cfg)[0]).toEqual({ label: 'Verification', isMet: false, note: 'fast checks pass; background checks still to run: slow (they start at the next stop)' })
    expect(gate({ ...base, verify: { ...base.verify, passedOn: { unit: 't1', slow: 't1' } } }, cfg)[0]?.isMet).toBe(true)
  })
  test('says a run is going, and for how long when it knows the time', () => {
    const running: Loop = { ...base, background: { slow: { tree: 't1', startedAt: 0 } } }
    expect(gate(running, cfg, { ...NO_FACTS, now: 14 * 60_000 })[0]?.note).toBe('tests still running (started 14m ago): slow')
    expect(gate(running, cfg)[0]?.note).toBe('tests still running: slow')
  })
  test('names a background failure on this tree, never one from an older tree', () => {
    expect(gate({ ...base, verify: { ...base.verify, runs: { slow: FAILED } } }, cfg)[0]?.note).toBe('failing: slow (in the background)')
    expect(gate({ ...base, verify: { ...base.verify, runs: { slow: { ...FAILED, isOlderTree: true } } } }, cfg)[0]?.note).toMatch(/background checks still to run: slow/)
  })
  test('Review Focus 5: outside git the row says a background check cannot be recorded', () => {
    expect(gate({ ...base, tree: null, verify: { ...base.verify, tree: null } }, cfg)[0]).toEqual({ label: 'Verification', isMet: false, note: 'background checks need a git repository to record a result against: slow' })
  })
})
```

- [ ] **Step 3: Run them to see them fail**

Run: `claude plugin test . 2>&1 | grep -E "background.test|\(fail\)" | head`
Expected: `tests/background.test.ts` fails to import `backgroundFor` and `../hooks/testruns`.

- [ ] **Step 4: Implement**

- `step()`: `unknownKeys` accepts `background`. `true` sets `background: true`, `false` or no key sets nothing, and any other value gives the error above. The "expected a command, or { … }" error text stays as it is.
- `verifyTimeoutSec`: a finite number over 600 gets the new error in place of the generic one. Every other bad value keeps the generic error.
- `stepsFor` filters out `background === true`. `backgroundFor` uses the same `when` test.
- `verificationRow(loop, cfg, tier, facts)`: `steps` is the full steps followed by `backgroundFor`. Notes in this order:
  1. Outside git (tree null) with a background step: the note above.
  2. Today's note for a foreground failure.
  3. A pending background check running on `loop.tree`: the running note, with minutes from `facts.now` when it is set.
  4. A pending background check failed on `loop.tree` (`runs[run].tree === loop.tree`, outcome `fail`, not `isOlderTree`): the failing note.
  5. Every pending check is a background one: the "still to run" note.
  6. Otherwise today's notes, with `isFastDone` counting background checks the way it counts full ones.
- `checksFor` returns the full steps, then `backgroundFor`. The command line keeps nothing, so it runs them too.
- `checksForChange` appends each background check as `` `run` (runs in the background) ``. `unscopedFull` skips background checks.
- `policyFacts` keeps background checks out of `fast` and `full` and adds `` `<runs>` run(s) in the background after your stops, with no time limit; only shipping waits for it/them. ``. With only background checks set, it drops the "no verify commands" sentence.
- `describeStep` prints `[background]` (e.g. `bash tests/run-all.sh [background]`).
- `SHAPE` becomes `'loop-13'`.

- [ ] **Step 5: Run the tests**

Run: `claude plugin test . 2>&1 | tail -3`
Expected: `0 fail`

- [ ] **Step 6: Build and commit**

```bash
bash scripts/build.sh
git add hooks/testruns.ts hooks/config.ts hooks/rules.ts hooks/gate.ts hooks/portable.ts hooks/limits.ts hooks/context.ts hooks/output.ts hooks/commands.ts types/index.d.ts hooks/fresh.ts hooks/state.ts dist/devloop.mjs tests/background.test.ts
git commit -m "Let a verify check run in the background"
```

---

### Task 2: Background runs at stops

**Files:**
- Create: `hooks/background.ts`
- Modify: `hooks/state.ts` (export `coveredKeys` and `keepOutput`; `verify()` times each check it runs; `Verified.runs`; `verifyNow` merges them into `loop.verify.runs`), `hooks/register.tsx` (Stop path; `wake`), `tests/world.ts` (`process.spawn`)
- Test: `tests/background.test.ts`

**Interfaces:**
- Consumes: Task 1's `backgroundFor`, `CheckRecord`, `BackgroundRun`, `ago`; `checkArgv(run, cfg.checkEnv)`, `classify`, `distill`, `isCoveredPass`, `snapshot`, `save`, `note`.
- Produces (`hooks/background.ts`):
  - `startBackground($: Engine, at: Place, cfg: Config, tree: string | null): Promise<string[]>` returns the commands it spawned and never waits on a run. For each `backgroundFor(cfg.verify, loop.changed)` that has neither a result on `tree` nor a live run on it, it does one of three things:
    - it cancels the check's live run on another tree;
    - where `isCoveredPass` holds, it records a covered-files carry (`passedOn[run] = tree`, no run);
    - otherwise it spawns the check (argv from `checkArgv`, cwd `at.root`, no timeout) and records `loop.background[run]`.
  - "A result on `tree`" means `passedOn[run] === tree`, or `runs[run].tree === tree` without `isOlderTree`. A `loop.background` entry with no live run in this process is dead: it gets a note and starts again. With `tree === null`, nothing starts.
  - `abandonBackground($: Engine, at: Place): Promise<void>` cancels this root's live runs and drops every `loop.background` entry, each with the note `background: <run> did not finish (the session or plugin ended); it starts again at the next stop`.
  - `whenSettled(): Promise<void>` resolves once every finished run's record is written; tests await it.
  - When a run finishes (and was not cancelled), it reads a snapshot and records:
    - the same tree: `runs[run]` with `isOlderTree: false`; a pass also sets `passedOn[run]` and `covered[run]` (when the check has a key); a failure removes `covered[run]`;
    - a changed tree: `runs[run]` with `isOlderTree: true`, and no pass;
    - in both cases it drops `loop.background[run]`.
  - Activity notes (kind `verify`): `background: <run> passed on this tree (<ago>)`, `background: <run> failed on this tree (<ago>)`, `background: <run> ran on an older tree (the tree changed while it ran): passed` (or `failed`), `background: <run> could not run (<outcome>)`, `background: <run> passed before on the files it covers, not run again`.
  - A child ended by a signal counts as `killed`; one that cannot start counts as `not-found`. The output is the chunks joined, cut to the last 100_000 characters and kept with `keepOutput`. `lines` is the first 10 lines of `distill(raw)`. There is no flaky rerun.
  - `Verified.runs: Record<string, CheckRecord>`, written to `loop.verify.runs` for each foreground check `verify()` ran. It is merged and never drops background records.
  - World: `World.spawns: Spawn[]` with `type Spawn = { command: string; argv: string[]; cwd: string | undefined; finish: (exitCode: number, output?: string) => void; isKilled: boolean }`.

- [ ] **Step 1: Teach the world to spawn**

Answer `process.spawn` with an async generator that:
- pushes a `Spawn` (`command` is `argv[2]` for `bash -lc` and `argv[4]` for the scrubbed form);
- waits until `finish(code, output = 'output of the command')` is called or `next.signal` aborts;
- yields `{ stream: 'stdout', text: output }` and returns `{ code, signal: null }`;
- in its `finally`, sets `isKilled = true` on a spawn that never finished.

Initialize `spawns: []`.

- [ ] **Step 2: Write the failing tests** (append)

```ts
const SLOW = 'bash tests/run-all.sh'
const BG = { ...CONFIG, autoReview: false, verify: ['npm test', { run: SLOW, background: true }] }
const loopIn = (w: World): Loop => (w.store['loop:/repo'] as { value: Loop }).value
async function stopOn($: Dollar, w: World, file = 'src/a.ts') { w.files[`/repo/${file}`] = 'export const a = 1'; change(w, file); return stop($) }

describe('background runs', () => {
  test('a stop starts it and returns at once; nothing else runs it', async ($, on) => {
    const w = world(on, BG); await start($)
    expect((await stopOn($, w)).block).toBeUndefined()
    expect(w.spawns.map(one => one.command)).toEqual([SLOW])
    expect(w.spawns[0]?.argv.slice(0, 2)).toEqual(['bash', '-lc'])
    expect(w.ran).not.toContain(SLOW)
    expect(loopIn(w).background[SLOW]).toEqual({ tree: w.tree, startedAt: 1000 })
    await stop($)
    expect(w.spawns.length).toBe(1)
  })
  test('a pass is recorded against its tree, with how long it took', async ($, on) => {
    const w = world(on, BG); await start($); await stopOn($, w)
    w.now += 41 * 60_000; w.spawns[0]?.finish(0); await whenSettled()
    expect(loopIn(w).verify.passedOn[SLOW]).toBe(w.tree)
    expect(loopIn(w).verify.runs[SLOW]).toMatchObject({ tree: w.tree, outcome: 'pass', durationMs: 41 * 60_000, isOlderTree: false })
    expect(loopIn(w).background).toEqual({})
    expect(loopIn(w).events.at(-1)?.text).toBe(`background: ${SLOW} passed on this tree (41m)`)
  })
  test('a failure keeps its first lines and its output, and is not rerun on the same tree', async ($, on) => {
    const w = world(on, BG); await start($); await stopOn($, w)
    w.spawns[0]?.finish(1, 'FAIL tests/a.test.ts\nexpected 1 to be 2'); await whenSettled()
    expect(loopIn(w).verify.runs[SLOW]).toMatchObject({ outcome: 'fail', lines: 'FAIL tests/a.test.ts\nexpected 1 to be 2' })
    expect(loopIn(w).verify.runs[SLOW]?.saved).toMatch(/\/checks\/.+\.log$/)
    expect(loopIn(w).verify.passedOn[SLOW]).toBeUndefined()
    await stop($)
    expect(w.spawns.length).toBe(1)
  })
  test('a stop on a newer tree cancels the older run and starts again', async ($, on) => {
    const w = world(on, BG); await start($); await stopOn($, w); await stopOn($, w, 'src/b.ts')
    expect(w.spawns.length).toBe(2)
    expect(w.spawns[0]?.isKilled).toBe(true)
    w.spawns[0]?.finish(1); await whenSettled()
    expect(loopIn(w).verify.runs[SLOW]).toBeUndefined()
    expect(loopIn(w).background[SLOW]?.tree).toBe(w.tree)
  })
  test('a tree that changed while it ran: never a pass, and the next stop runs it again', async ($, on) => {
    const w = world(on, BG); await start($); await stopOn($, w)
    change(w, 'src/b.ts'); w.spawns[0]?.finish(0); await whenSettled()
    expect(loopIn(w).verify.runs[SLOW]?.isOlderTree).toBe(true)
    expect(loopIn(w).verify.passedOn[SLOW]).toBeUndefined()
    await stop($)
    expect(w.spawns.length).toBe(2)
  })
  test('Review Focus 3: a run whose session ended is not running forever; the next stop starts it again', async ($, on) => {
    const w = world(on, BG); await start($); await stopOn($, w)
    w.sessionId = 's2'; await start($)
    expect(loopIn(w).background).toEqual({})
    expect(loopIn(w).events.some(one => one.text === `background: ${SLOW} did not finish (the session or plugin ended); it starts again at the next stop`)).toBe(true)
    await stop($)
    expect(w.spawns.length).toBe(2)
  })
  test('Review Focus 5: outside git no background check starts', async ($, on) => {
    const w = world(on, BG); w.isGit = false; await start($); await stopOn($, w)
    expect(w.spawns).toEqual([])
  })
  test('a background check with when carries its pass while the files it covers are unchanged', async ($, on) => {
    const w = world(on, { ...BG, testing: { scope: 'targeted' }, verify: ['npm test', { run: SLOW, background: true, when: ['src/**'] }] })
    w.outputs['#covered-files'] = '100644 blob abc\tsrc/a.ts'; await start($); await stopOn($, w)
    w.spawns[0]?.finish(0); await whenSettled(); await stopOn($, w, 'src/b.ts')
    expect(w.spawns.length).toBe(1)
    expect(loopIn(w).verify.passedOn[SLOW]).toBe(w.tree)
  })
  test('foreground checks keep a record with their duration', async ($, on) => {
    const w = world(on, BG); await start($); await stopOn($, w)
    expect(loopIn(w).verify.runs['npm test']).toMatchObject({ tree: w.tree, outcome: 'pass', durationMs: 0, isOlderTree: false })
  })
})
```

- [ ] **Step 3: Run them to see them fail**

Run: `claude plugin test . 2>&1 | grep -E "\(fail\)" | head`
Expected: `tests/background.test.ts` fails to import `../hooks/background`.

- [ ] **Step 4: Implement `hooks/background.ts`, the record in `verifyNow`, and the Stop path**

The live runs are a module-level `Map` keyed by `` `${root}\n${run}` `` that holds the stream and its tree. Cancel a run by setting a flag and calling `stream.return(undefined)`. The finish handler checks that flag first.

In the `classic.Stop` handler:
- `limited` calls `startBackground($, at, cfg, snap.tree).catch(() => [])` first.
- The two returns that end the turn without `limited` (verification could not run; the spec phase) call it too.
- A return that blocks never starts one.

`wake` calls `abandonBackground` right after `restore`.

- [ ] **Step 5: Run the tests**

Run: `claude plugin test . 2>&1 | tail -3`
Expected: `0 fail`

- [ ] **Step 6: Build and commit**

```bash
bash scripts/build.sh
git add hooks/background.ts hooks/state.ts hooks/register.tsx tests/world.ts tests/background.test.ts
git commit -m "Run background checks after each stop"
```

---

### Task 3: Background results reach the agent and the person

**Files:**
- Modify: `hooks/testruns.ts` (`TestState`, `testStates`, `backgroundNotice`), `hooks/background.ts` (what a finished run tells; `startBackground` gains `isIdle`), `hooks/register.tsx` (passes `() => turnId === null`; the `tests` prompt-context source; the `AbovePrompt` render passes `await $.clock.now()` to `barParts`), `hooks/statusbar.ts` (`barParts`), `hooks/ship.ts` (`prove` puts `now` in its facts)
- Test: `tests/background.test.ts`, `tests/statusbar.test.ts`

**Interfaces:**
- Consumes: Task 2's records and `whenSettled`; `countFailedRound`, `limitNow`, `reachLimit` (`hooks/rounds.ts`), `isAtLimit` (`hooks/limits.ts`), `infraAdvice`.
- Produces:
  - `type TestState = { run: string; isBackground: boolean; state: 'pass' | 'fail' | 'could not run' | 'running' | 'not run'; durationMs: number | null; startedAt: number | null; lines: string; saved: string | null }`.
  - `testStates(loop: Loop, cfg: Config): TestState[]` covers each check of `stepsFor(cfg.verify, 'full', loop.changed)`, then `backgroundFor(…)`, on `loop.tree`. It takes the first of these that applies: `running` (a `loop.background` entry on this tree), `pass` (`passedOn`), the run record on this tree (`fail` or `could not run`, never one with `isOlderTree`), else `not run`. `durationMs` comes from `runs[run]`.
  - `backgroundNotice(loop: Loop, cfg: Config, now: number): string | null` is null when there is nothing to say. Otherwise it gives one entry per background check:
    - running: `` `<run>` is running in the background on this tree (started <ago> ago); nothing waits on it but shipping. ``
    - pass: `` `<run>` passed in the background on this tree (<ago>). ``
    - fail: `` `<run>` failed in the background on this tree (<ago>):\n<lines>\nThe whole output is in <saved>. `` (the last sentence only when `saved` is set)
    - could not run: `infraAdvice(run, outcome, cfg.verifyTimeoutSec)`
    - not run or running, with an older-tree failure on record: `` `<run>` failed on an older tree (the tree changed while it ran), so it says nothing certain about this one:\n<lines>\nIt runs again in the background after your next stop. ``
  - `startBackground($, at, cfg, tree, isIdle: () => boolean)`.
  - `barParts(loop, cfg, checks, now?: number)` extends settings-panel's `barParts(loop: Loop, cfg: Config, checks: readonly Check[])`. `tests.color` gains `'warning'`. With a background check running on this tree it returns `{ text: now === undefined ? 'running…' : 'running <ago>…', color: 'warning' }`; else with one failing on this tree, `{ text: '✗ failing', color: 'error' }`; else what it returns today.
  - What a finished run tells (never a block). Here `<ago>` is the run's own duration (`durationMs`):
    - Failure on this tree:
      - toast `` devloop: the background check `<run>` failed on this tree (<ago>). ``
      - outside the spec phase, `countFailedRound(…, { kind: 'fix', what: '<run> (background)', files: [] })`; `verify.rounds` is never touched
      - in enforce mode, outside the spec phase, below the loop limit and when `isIdle()`, `$.prompt.submit({ text })` with `` The background check `<run>` failed on this tree (it ran <ago>).\n<lines>\nThe whole output is in <saved>.\nFix the failure and stop; the check runs again in the background after your stop. ``
      - at the limit in enforce mode there is no prompt; `reachLimit`'s message, if any, is appended with `$.session.append`, as `hooks/review.ts` does
    - Failure on an older tree: toast `` devloop: the background check `<run>` failed on an older tree (the tree changed while it ran); it runs again at the next stop. ``; nothing counted, no prompt.
    - Could not run: toast `devloop: <infraAdvice(…)>`; nothing counted, no prompt.
    - Pass: no toast, no prompt.
  - Prompt context: `{ key: 'tests', label: 'background tests', priority: 1, text: backgroundNotice(loop, cfg, now) }` beside the other sources in `prompt.submit`.

- [ ] **Step 1: Write the failing tests** (append to `tests/background.test.ts`)

```ts
describe('what the agent and the person are told', () => {
  const fail = async (w: World, output = 'FAIL tests/a.test.ts\nexpected 1 to be 2') => { w.now += 41 * 60_000; w.spawns[0]?.finish(1, output); await whenSettled() }
  const told = (w: World): string => w.contexts.at(-1)?.join('\n') ?? ''
  test('a failure on this tree: a toast, a failed round toward the loop limit, an idle agent woken, never a block', async ($, on) => {
    const w = world(on, BG); await start($); await stopOn($, w); await fail(w)
    expect(w.toasts.at(-1)).toBe(`devloop: the background check \`${SLOW}\` failed on this tree (41m).`)
    expect(w.submitted.at(-1)).toMatch(/^The background check `bash tests\/run-all\.sh` failed on this tree \(it ran 41m\)\.\nFAIL tests\/a\.test\.ts\nexpected 1 to be 2\nThe whole output is in .+\.log\.\nFix the failure and stop;/)
    expect([loopIn(w).limit.failed, loopIn(w).verify.rounds]).toEqual([1, 0])
    expect((await stop($)).block).toBeUndefined()
    await prompt($)
    expect(told(w)).toMatch(/`bash tests\/run-all\.sh` failed in the background on this tree \(41m\):\nFAIL tests\/a\.test\.ts/)
  })
  test('a busy agent is not woken', async ($, on) => {
    const w = world(on, BG); await start($); await stopOn($, w)
    await $.turn.start({ turnId: 'busy' } as never); await fail(w)
    expect(w.submitted).toEqual([])
  })
  test('observe mode wakes no one', async ($, on) => {
    const w = world(on, { ...BG, mode: 'observe' }); await start($); await stopOn($, w); await fail(w)
    expect(w.submitted).toEqual([])
    expect(w.toasts.at(-1)).toMatch(/failed on this tree/)
  })
  test('a failure on an older tree is shown as such, and neither counted nor woken', async ($, on) => {
    const w = world(on, BG); await start($); await stopOn($, w); change(w, 'src/b.ts'); await fail(w, 'boom')
    expect(w.toasts.at(-1)).toBe(`devloop: the background check \`${SLOW}\` failed on an older tree (the tree changed while it ran); it runs again at the next stop.`)
    expect([w.submitted, loopIn(w).limit.failed]).toEqual([[], 0])
    await prompt($)
    expect(told(w)).toMatch(/failed on an older tree \(the tree changed while it ran\), so it says nothing certain about this one:\nboom/)
  })
  test('Review Focus 4: while a spec is written a failure is recorded, and nothing is woken or counted', async ($, on) => {
    const w = world(on, BG); await start($)
    w.files['/repo/specs/login/SPEC.md'] = '# login'; await devloop($, 'spec login'); await stopOn($, w); await fail(w)
    expect([w.submitted, loopIn(w).limit.failed, loopIn(w).verify.runs[SLOW]?.outcome]).toEqual([[], 0, 'fail'])
  })
  test('Review Focus 2: a check that cannot run is told with advice, not counted, and not restarted on the same tree', async ($, on) => {
    const w = world(on, BG); await start($); await stopOn($, w)
    w.spawns[0]?.finish(127, 'bash: tests/run-all.sh: not found'); await whenSettled()
    expect(w.toasts.at(-1)).toMatch(/^devloop: `bash tests\/run-all\.sh` could not run: its program was not found \(exit 127\)/)
    expect([w.submitted, loopIn(w).limit.failed]).toEqual([[], 0])
    await stop($)
    expect(w.spawns.length).toBe(1)
  })
  test('a pass reaches the agent at its next prompt; no one is woken', async ($, on) => {
    const w = world(on, BG); await start($); await stopOn($, w)
    w.now += 41 * 60_000; w.spawns[0]?.finish(0); await whenSettled()
    expect(w.submitted).toEqual([])
    await prompt($)
    expect(told(w)).toMatch(/`bash tests\/run-all\.sh` passed in the background on this tree \(41m\)\./)
  })
  test('a push while the run goes is held with how long it has run, and starts no second run', async ($, on) => {
    const w = world(on, BG); await start($); await stopOn($, w); w.now += 14 * 60_000
    expect((await bash($, 'git push -u origin feature')).deny).toMatch(/tests still running \(started 14m ago\): bash tests\/run-all\.sh/)
    expect(w.spawns.length).toBe(1)
  })
  test('in observe mode that push is noted, not held', async ($, on) => {
    const w = world(on, { ...BG, mode: 'observe' }); await start($); await stopOn($, w)
    expect((await bash($, 'git push -u origin feature')).deny).toBeUndefined()
  })
})
```

In `tests/statusbar.test.ts`, using that file's own imports:

```ts
test('the status bar shows a background run, then its result', () => {
  const cfg = { ...DEFAULTS, verify: [{ run: 'slow', profile: 'fast', when: null, background: true }] } as Config
  const at = { ...FRESH, tree: 't1', tier: 'medium', changed: ['src/a.ts'], verify: { ...FRESH.verify, status: 'pass', tree: 't1' } } as Loop
  const failed = { tree: 't1', outcome: 'fail', at: 0, durationMs: 1, lines: 'x', isOlderTree: false, saved: null } as const
  const running = { ...at, background: { slow: { tree: 't1', startedAt: 0 } } }
  expect(barParts(running, cfg, [], 12 * 60_000)?.tests).toEqual({ text: 'running 12m…', color: 'warning' })
  expect(barParts(running, cfg, [])?.tests).toEqual({ text: 'running…', color: 'warning' })
  expect(barParts({ ...at, verify: { ...at.verify, runs: { slow: failed } } }, cfg, [])?.tests).toEqual({ text: '✗ failing', color: 'error' })
  expect(barParts({ ...at, verify: { ...at.verify, passedOn: { slow: 't1' } } }, cfg, [])?.tests).toEqual({ text: '✓ passed', color: 'success' })
})
```

- [ ] **Step 2: Run them to see them fail**

Run: `claude plugin test . 2>&1 | grep -E "\(fail\)" | head -20`
Expected: the new tests fail (no toast, no context, no `running` bar part).

- [ ] **Step 3: Implement** the states, the notice, the finish handler's reports, the context source, `barParts`, and `now` in `prove`'s facts (`{ ...factsOf(at, policy), now: await $.clock.now() }`)

- [ ] **Step 4: Run the tests and validate**

Run: `claude plugin test . 2>&1 | tail -3; claude plugin validate . 2>&1 | tail -1`
Expected: `0 fail`; `Validation passed`.

- [ ] **Step 5: Build and commit**

```bash
bash scripts/build.sh
git add hooks/testruns.ts hooks/background.ts hooks/register.tsx hooks/statusbar.ts hooks/ship.ts tests/background.test.ts tests/statusbar.test.ts
git commit -m "Tell the agent and the person what the background tests found"
```

---

### Task 4: Rounds start at every stop; a pass starts a new cycle

> **AMENDED by spec rules 13-15 (one review per change):** rounds do NOT start at every stop. Round 1 starts only at a ready moment (the `devloop_review` tool, a shipping command with no review of the current change — also in observe mode, without holding the push — or a finished spec build). The only automatic follow-up is the one re-review of a fix (the next stop that moved the tree after a failing round). `maxReviewRounds` default becomes 2. After a pass, edits mark the review out of date and nothing starts until the next ready moment. Rewrite this task's tests accordingly; tests below that assert a round at an ordinary stop are inverted (no round).

**Files:**
- Modify: `hooks/gate.ts` (`isCapSpent`, `reviewRefusal`, the stall and cap texts moved here from `startReview`; `reviewRow`'s cap note uses `isCapSpent`), `hooks/review.ts` (`isReviewedHere`; `maybeReview`; `startReview` starts a cycle; `settle` and `resolveFinding` set `cycle.ended`), `hooks/register.tsx` (the Stop path also calls `maybeReview` at the covered early exit when `loop.verify.status === 'pass' || loop.verify.infra !== null`, and on the could-not-run path), `types/index.d.ts` (`Loop.review.cycle`), `hooks/fresh.ts` (`cycle: { from: 1, ended: null, summary: null }`), `dist/devloop.mjs`
- Test: `tests/agentreview.test.ts` (new); updates in `tests/review.test.ts` and wherever Step 4 says

**Interfaces:**
- Consumes: `coverageNow`, `featureCounts`, `tierFor`, `atLeast`, `startReview`.
- Produces:
  - `Loop.review.cycle: { from: number; ended: 'pass' | 'cap' | 'stalled' | null; summary: string | null; discarded: number; settledTree: string | null; toldTree: string | null; followUp: string | null }`, and in `FRESH` `{ from: 1, ended: null, summary: null, discarded: 0, settledTree: null, toldTree: null, followUp: null }`:
    - `from`: the number of the cycle's first finding id
    - `ended`: how the cycle ended
    - `discarded`: rounds of this cycle whose verdict was thrown away because the tree moved
    - `settledTree`: the tree of this cycle's last round that settled
    - Task 6 fills `summary`, `toldTree` and `followUp`.
  - The moved-tree branch of `finishReview` discards the round (rule 11) instead of calling `dropRound`. The round number is kept, so it counts toward the cap, and `cycle.discarded` goes up by one. Note: `review round <n> discarded: the tree moved while it ran (it counts toward the cap)`. Toast: `devloop: a review verdict arrived for a tree that has since changed; it was discarded and counts as round <n> of <max>. The next stop starts a fresh round.`; when that was the last round, the sentence after "<max>." becomes `The review cap is spent, so a person reads the change.` An interrupted (aborted) round still uses `dropRound`, which does not count it.
  - `startReview`'s round delta starts from `cycle.settledTree`, not `review.tree`, so a round never reads only the lines since a tree no one reviewed. With no settled tree, it reads the whole change. `settle` sets `cycle.settledTree` to the round's tree.
  - `isCapSpent(review: Loop['review'], cfg: Pick<Config, 'maxReviewRounds'>): boolean` is `review.round >= cfg.maxReviewRounds && review.cycle.ended !== 'pass'`.
  - `reviewRefusal(loop: Loop, cfg: Config, isReviewedHere: boolean): string | null` returns the first of these that applies, else null:
    1. `autoReview is off: a person starts rounds with /devloop review`
    2. in the spec phase: `A spec is being written: review rounds start once a person approves it.`
    3. a round is running: `Review round <n> is already running.`
    4. stalled: today's text from `startReview`
    5. `isCapSpent`: today's cap text
    6. tier none: `Nothing has changed, so there is nothing to review.`
    7. tier low: `This change is low risk, so it needs no review round.`
    8. `isReviewedHere`: `This tree was already reviewed in round <n>.`
  - `isReviewedHere($: Engine, at: Place, cfg: Config, loop: Loop): Promise<boolean>`: the review status is `pass` or `fail`, and `(await coverageNow($, at, cfg, loop, loop.tree)) !== 'not'` (the carry check that rule 5 names).
  - `maybeReview` (same signature) starts `startReview($, at, true)` when `reviewRefusal(…) === null`. In the build phase it also needs every feature passing on this tree (the spec-build trigger), so a half-built spec does not spend the cap.
  - `startReview`: when `round === 0` or `cycle.ended === 'pass'`, the round is round 1 of a new cycle. It resets `round` to 0 before counting the new round, sets `stalled: 0` and `isLooping: false`, and sets `cycle` to `FRESH`'s cycle with `from: nextIdOf(findings)`. Its cap check is `isCapSpent`.
  - `cycle.ended` is set to `'pass'` by `settle` on a pass, to `'stalled'` on a stall, and to `'cap'` on a failed last round or a discarded last round; otherwise it is left alone. `resolveFinding`'s fail-to-pass sets `'pass'`.

- [ ] **Step 1: Write the failing tests** in `tests/agentreview.test.ts`

Imports: `expect`, `test` (`claude-code/testing`); `approved`, `change`, `CONFIG`, `devloop`, `edit`, `start`, `stop`, `world`, types `Dollar`, `World` (`./world`); type `Loop` (`../types`). Task 5 adds `RULES` (templates) and `TOOL_SPECS` (register); Task 6 adds `prompt` (world), `reviewSummary` (findings), `testsLine`, type `TestState` (testruns), `whenSettled` (background), type `Finding`.

```ts
const answer = ($: Dollar, agentId: string, text: string, isAborted = false) =>
  $.turn.complete({ answer: text, durationMs: 1, isAborted, turnId: `t-${agentId}`, agentId, reason: 'answer' })
const F_HIGH = 'F1 | high | src/a.ts:1 | export const a = 1 | rounds down | a test with 0.5'
const loopIn = (w: World): Loop => (w.store['loop:/repo'] as { value: Loop }).value
async function fix($: Dollar, w: World, file = 'src/a.ts'): Promise<string | undefined> {
  w.files[`/repo/${file}`] = 'export const a = 1'; await edit($, `/repo/${file}`); change(w, file)
  return (await stop($)).block
}

test('§1: a stop on a medium-risk small fix starts round 1 by itself', async ($, on) => {
  const w = world(on); await start($)
  expect(await fix($, w)).toBeUndefined()
  expect(w.spawned.map(one => one.subagentType)).toEqual(['devloop:reviewer'])
  expect(await devloop($, 'status')).toMatch(/Independent review: round 1 running/)
})
test('§1: no round for a low-risk change, or while the fast checks fail', async ($, on) => {
  const w = world(on); await start($)
  await fix($, w, 'docs/guide.md'); expect(w.spawned).toEqual([])
  w.exits['npm test'] = 1
  expect(await fix($, w)).toMatch(/verification failed/); expect(w.spawned).toEqual([])
})
test('§1: with autoReview off no round starts at a stop', async ($, on) => {
  const w = world(on, { ...CONFIG, autoReview: false }); await start($); await fix($, w)
  expect(w.spawned).toEqual([])
})
test('§1: a round starts when the fast checks could not run', async ($, on) => {
  const w = world(on); w.exits['npm test'] = 124; await start($)
  expect(await fix($, w)).toBeUndefined(); expect(w.spawned.length).toBe(1)
})
test('§1: a stop on the tree the last round reviewed starts none', async ($, on) => {
  const w = world(on); await start($); await fix($, w)
  await answer($, 'agent-1', `${F_HIGH}\nVERDICT: FAIL`); await stop($)
  expect(w.spawned.length).toBe(1)
})
test('§1: an interrupted round starts again at the next stop on the same tree', async ($, on) => {
  const w = world(on); await start($); await fix($, w)
  await answer($, 'agent-1', '', true); await stop($)
  expect(w.spawned.length).toBe(2)
})
test('§1: in the build phase the first round waits for every feature', async ($, on) => {
  const w = world(on); await start($); await approved($, w); await fix($, w)
  expect(w.spawned).toEqual([])
})
test('rule 5: edits after a pass start a new cycle at round 1; the cap bounds one cycle', async ($, on) => {
  const w = world(on, { ...CONFIG, maxReviewRounds: 1 }); await start($)
  await fix($, w); await answer($, 'agent-1', 'VERDICT: PASS')
  await fix($, w, 'src/b.ts')
  expect(w.spawned.length).toBe(2)
  expect(w.spawned[1]?.prompt).toMatch(/This is round 1 of 1\./)
  await answer($, 'agent-2', `${F_HIGH}\nVERDICT: FAIL`); await fix($, w, 'src/c.ts')
  expect(w.spawned.length).toBe(2)
  expect(await devloop($, 'status')).toMatch(/the cap of 1 rounds is spent/)
})
test('Review Focus 1 and rule 11: an edit while a round runs discards its verdict; it uses a round, not the loop limit, and the next round reads the whole change', async ($, on) => {
  const w = world(on); await start($); await fix($, w)
  change(w, 'src/b.ts'); await answer($, 'agent-1', `${F_HIGH}\nVERDICT: FAIL`)
  expect(w.toasts.at(-1)).toBe('devloop: a review verdict arrived for a tree that has since changed; it was discarded and counts as round 1 of 3. The next stop starts a fresh round.')
  expect([loopIn(w).limit.failed, loopIn(w).review.cycle.discarded]).toEqual([0, 1])
  await stop($)
  expect(w.spawned.length).toBe(2)
  expect(w.spawned[1]?.prompt).toMatch(/This is round 2 of 3\./)
  expect(w.spawned[1]?.prompt).not.toMatch(/The diff since round 1/)
})
test('rule 11: a discarded last round spends the cap', async ($, on) => {
  const w = world(on, { ...CONFIG, maxReviewRounds: 1 }); await start($); await fix($, w)
  change(w, 'src/b.ts'); await answer($, 'agent-1', 'VERDICT: PASS')
  expect(w.toasts.at(-1)).toMatch(/counts as round 1 of 1\. The review cap is spent, so a person reads the change\.$/)
  await stop($)
  expect(w.spawned.length).toBe(1)
  expect(await devloop($, 'status')).toMatch(/the cap of 1 rounds is spent/)
})
```

- [ ] **Step 2: Run them to see them fail**

Run: `claude plugin test . 2>&1 | grep -E "agentreview|\(fail\)" | head -20`
Expected: the `§1` and `rule 5` tests fail (no round starts at a stop).

- [ ] **Step 3: Implement** the refusal, the cap, `isReviewedHere`, `maybeReview`, the cycle, the discard that counts, the delta from `cycle.settledTree`, and the two new `maybeReview` calls in the Stop path

- [ ] **Step 4: Bring the tests that encoded the old start rule up to date**

Run the whole suite. For each failing test, apply the first case that fits:

1. Rewrite these, since their subject is when a round starts or which round comes next:
   - `tests/review.test.ts` `11a: in small-fix mode, a review loop the ship gate began goes on by itself once the fix verifies`:
     - rename it `§1: in small-fix mode rounds start at stops, and edits after a pass start round 1 again`;
     - `reviewable`'s stop now starts round 1, so replace the push line with `expect(w.spawned.length).toBe(1)`;
     - keep the hand-off and round-2 assertions;
     - end with `expect(w.spawned.length).toBe(3)` and `expect(w.spawned[2]?.prompt).toMatch(/This is round 1 of 3\./)`.
   - `11a: a stop on the reviewed tree, or one that fails verification, starts no round`: drop its `devloop($, 'review')` call (the stop already started round 1 as `agent-1`).
   - The `DESIGN 9.2:` tests built on `reviewable`: set the change up with `edit` and `change` but no stop. A stop now starts the round; the push-refusal trigger itself is unchanged.
   - `Z1: three changes, each reviewed once and pushed through the gate, then a fourth is reviewed as round 1`: each change's stop starts its round. For each change, assert `expect(last(w)?.prompt).toMatch(/This is round 1 of 3\./)`, answer PASS, and check that the push passes. `w.spawned.length` stays 4.
   - `Z1: a change reviewed three times without a push is still capped`: rule 5 reverses it.
     - Rename it `rule 5: rounds that pass never spend the cap: each edit after a pass is reviewed as round 1`.
     - Repeat four times: assert the last prompt is round 1, answer PASS, edit, stop.
     - End with `expect(w.spawned.length).toBe(5)`.
   - `CC-F7` (`afterPass` and its five tests): after a passing round, the next review is round 1 whatever the push was.
     - In `afterPass`, keep `reviewable`, answer PASS, run `line`, edit `src/c2.ts`, stop, then assert `expect(last(w)?.prompt).toMatch(/This is round 1 of 3\./)`.
     - Drop the `round` parameter and the first push expectation.
     - Rename each test `… the next review is round 1`.
   - `tests/loop.test.ts` `F6: a verdict for a tree the reviewer never read is discarded and does not count`: rule 11 reverses it.
     - Rename it `F6: a verdict for a tree the reviewer never read is discarded, and still uses a round`.
     - Drop its first `devloop($, 'review')`: the stop started round 1.
     - Keep the discard, status and `review rounds: 0` assertions; `review-rounds` still counts settled rounds only.
     - Its last line expects `round 2 of 3 started`.
2. A test that calls `devloop($, 'review')` right after a stop that now starts round 1: drop that call, since the round it asserted is the one already running as `agent-1`. An assertion on that call's answer becomes `expect(w.spawned.length).toBe(1)`.
3. Any other test that fails only because a round now starts at a stop, and whose subject is not when rounds start (an extra `w.spawned` entry, `Review round 1 is already running.`, or a review row, toast or prompt it did not expect): give its world `{ ...CONFIG, autoReview: false }`, or add `autoReview: false` to the config it already passes.
4. Anything else that fails is a defect in this task's code: fix the code, not the test.

- [ ] **Step 5: Run the tests**

Run: `claude plugin test . 2>&1 | tail -3`
Expected: `0 fail`

- [ ] **Step 6: Build and commit** (`git add` the test files Step 4 changed, by name, along with these)

```bash
bash scripts/build.sh
git add hooks/gate.ts hooks/review.ts hooks/register.tsx types/index.d.ts hooks/fresh.ts dist/devloop.mjs tests/agentreview.test.ts tests/review.test.ts tests/loop.test.ts
git commit -m "Start review rounds at every stop and a new cycle after a pass"
```

---

### Task 5: The devloop_review tool and its rule

> **AMENDED by spec rule 15:** the RULES line reads: call `devloop_review` once, when the whole change is done, not after each step.

**Files:**
- Modify: `hooks/register.tsx` (a `TOOL_SPECS` entry after `devloop_status`; `const REVIEW = 'mcp__devloop__devloop_review'`; its `tool.run`), `hooks/templates.ts` (`RULES`), `types/index.d.ts` (`McpToolInputs.mcp__devloop__devloop_review: Record<string, never>`)
- Test: `tests/agentreview.test.ts`

**Interfaces:**
- Consumes: Task 4's `reviewRefusal` and `isReviewedHere`; `startReview`, `isReviewerAgent`, `snapshot`, `withSnapshot`.
- Produces:
  - The spec: `{ name: 'devloop_review', description: 'Asks for an independent review round on the change as it stands, without waiting for your stop. The harness starts a separate read-only reviewer in a fresh context under the same rules as at a stop (risk, a tree not yet reviewed, rounds left, none running) and answers in one line; it runs and waits on no tests. Call it when a change is ready and your turn will run on.', inputSchema: { type: 'object', properties: {} }, isDeferred: true }`.
  - The handler checks, in order:
    1. Not opted in: `This repository has not opted in to devloop (no devloop.json), so there is no review.`
    2. Called by a reviewer (`isReviewerAgent(loop, e.agentId)`): `A reviewer cannot start a review round.`
    3. It then snapshots and saves `withSnapshot`, as `/devloop review` does. A non-null `reviewRefusal(loop, cfg, await isReviewedHere(…))` is the answer.
    4. Otherwise it calls `startReview($, at, true)`, which refuses at the loop limit with the limit's own message. Once a round is running, the answer appends ` Do not edit files until its verdict arrives: a verdict on a tree that has changed is discarded.`
  - The `RULES` line, placed after the one that starts "You never grade or approve your own change": `- When a change is ready and your turn will run on, call the devloop_review tool: a separate reviewer starts on the tree as it stands (devloop also starts rounds itself when you stop). Do not edit files until its verdict arrives: a verdict on a tree that has changed is discarded.`

- [ ] **Step 1: Write the failing tests** (append)

```ts
const ask = async ($: Dollar, agentId?: string): Promise<string> =>
  String((await $.tool.call({ tool: 'mcp__devloop__devloop_review', ...(agentId === undefined ? {} : { agentId }) })).result)
async function ready($: Dollar, w: World, file = 'src/a.ts') { w.files[`/repo/${file}`] = 'export const a = 1'; await edit($, `/repo/${file}`); change(w, file) }

test('§2: devloop_review starts a round mid-turn on the tree as it stands, running no tests', async ($, on) => {
  const w = world(on); await start($); await ready($, w); const ran = w.ran.length
  expect(await ask($)).toBe('Review round 1 of 3 started in a fresh context. Its verdict will show in the Dev loop pane. Do not edit files until its verdict arrives: a verdict on a tree that has changed is discarded.')
  expect([w.ran.length, w.spawned.length]).toEqual([ran, 1])
})
test('§2: otherwise it says why not, in one line', async ($, on) => {
  const w = world(on); await start($); await ready($, w); await ask($)
  expect(await ask($)).toBe('Review round 1 is already running.')
  expect(await ask($, 'agent-1')).toBe('A reviewer cannot start a review round.')
  await answer($, 'agent-1', 'VERDICT: PASS')
  expect(await ask($)).toBe('This tree was already reviewed in round 1.')
})
test('rule 4: with autoReview off it is refused', async ($, on) => {
  const w = world(on, { ...CONFIG, autoReview: false }); await start($); await ready($, w)
  expect(await ask($)).toBe('autoReview is off: a person starts rounds with /devloop review')
})
test('rule 4: not while a spec is written', async ($, on) => {
  const w = world(on); await start($); w.files['/repo/specs/login/SPEC.md'] = '# login'; await devloop($, 'spec login'); await ready($, w)
  expect(await ask($)).toBe('A spec is being written: review rounds start once a person approves it.')
})
test('§2: a low-risk change needs no round', async ($, on) => {
  const w = world(on); await start($); await ready($, w, 'docs/guide.md')
  expect(await ask($)).toBe('This change is low risk, so it needs no review round.')
})
test('rule 4: at the loop limit it is refused with the limit message', async ($, on) => {
  const w = world(on, { ...CONFIG, loop: { failedRounds: 1 } }); await start($)
  w.exits['npm test'] = 1; await fix($, w); w.exits['npm test'] = 0
  expect(await ask($)).toMatch(/Loop limit: 1 failed round on this branch/)
  expect(w.spawned).toEqual([])
})
test('the rules ask for it, and it is registered deferred with no arguments', () => {
  expect(RULES.split('\n').filter(line => line.includes('devloop_review'))).toEqual(['- When a change is ready and your turn will run on, call the devloop_review tool: a separate reviewer starts on the tree as it stands (devloop also starts rounds itself when you stop). Do not edit files until its verdict arrives: a verdict on a tree that has changed is discarded.'])
  expect(TOOL_SPECS.find(one => one.name === 'devloop_review')).toMatchObject({ inputSchema: { type: 'object', properties: {} }, isDeferred: true })
})
```

If the plugin's call guard refuses a reviewer's call to this tool before it reaches `tool.run`, the `agent-1` line instead asserts that the call has a `deny` and that `w.spawned.length` is still 1. Either way, a reviewer starts no round.

- [ ] **Step 2: Run them to see them fail**

Run: `claude plugin test . 2>&1 | grep -E "\(fail\)" | head`
Expected: the new tests fail (no such tool).

- [ ] **Step 3: Implement** the spec, the handler, the `McpToolInputs` entry and the `RULES` line

- [ ] **Step 4: Run the tests and validate**

Run: `claude plugin test . 2>&1 | tail -3; claude plugin validate . 2>&1 | tail -1`
Expected: `0 fail`; `Validation passed`.

- [ ] **Step 5: Build and commit**

```bash
bash scripts/build.sh
git add hooks/register.tsx hooks/templates.ts types/index.d.ts tests/agentreview.test.ts
git commit -m "Let the agent ask for a review round with devloop_review"
```

---

### Task 6: The reviewer reads the tests; the person reads one summary

**Files:**
- Modify: `hooks/testruns.ts` (`testsBlock`, `testsLine`), `hooks/findings.ts` (`PromptFacts.tests`, placed right after the "Checks you may run" line; `SummaryFacts`, `reviewSummary`), `hooks/review.ts` (`reviewerChecks` leaves background checks out; `startReview` passes `tests: testsBlock(testStates(loop, cfg), now)`; a private `endCycle` called from `settle`, the discard path and `resolveFinding`; `noteUnreviewed`), `hooks/state.ts` (export `changedBetween`), `hooks/register.tsx` (the `review-summary` and `review-followup` prompt-context sources; `noteUnreviewed` beside each `startBackground` call), `dist/devloop.mjs`
- Test: `tests/agentreview.test.ts`

**Interfaces:**
- Consumes: Task 3's `testStates` and `TestState`; Task 4's `cycle` (`discarded`, `settledTree`, `toldTree`, `followUp`) and its discard path; `changedBetween`.
- Produces:
  - `testsBlock(states: readonly TestState[], now: number): string | null` is null with no states. Otherwise it is `Tests on this tree, as the harness recorded them:` followed by one line per check:
    - `  ✓ passed  <run> (<ago>)` (no parenthesis without a duration)
    - `  ✗ failing  <run> (<ago>)`, then its `lines`, each indented six spaces
    - `  … running  <run> (started <ago> ago)`
    - `  could not run  <run>`
    - `  not run  <run>`
    - and, when any state is a background check, a last line: `You cannot run the background tests above and should not try: judge from these results.`
  - `testsLine(states: readonly TestState[], now: number): string`:
    - no states: `none set`
    - any failure: `✗ failing on this tree (<runs, ', '>)`
    - else any running: `running (<run>, started <ago> ago; …)`
    - else any not run or could not run: `not run on this tree (<runs>)`
    - else: `✓ passed on this tree (<run>, <ago>; …)`, with `<run>` alone when it has no duration
  - `type SummaryFacts = { end: 'pass' | 'cap' | 'stalled'; round: number; maxRounds: number; fixed: readonly Finding[]; open: readonly Finding[]; decisions: readonly Finding[]; discarded: number; notReviewed: number | null; tests: string }`.
  - `reviewSummary(facts: SummaryFacts): string` returns four lines:
    1. `Review done: passed in round <r> of <max>.` (pass), `Review done: the cap of <max> rounds is spent; <open ids> still open.` (cap; `; <open ids> still open` only when some are), or `Review done: stopped in round <r> of <max>: two rounds in a row closed no finding; <open ids> still open.` (stalled). With `discarded > 0` (rule 11), `; <n> round discarded because the code changed during review` (`rounds` for more than one) goes before the final period.
    2. `Fixed: <id> <problem>, ….` or `Fixed: none.`. Each problem is cut to its first 60 characters, with trailing periods and spaces dropped.
    3. `Still open for you: <id> <problem>, ….` or `Still open for you: none.`, then two spaces, then `Not reviewed: none.`, `Not reviewed: the last edit after round <r> (1 file).`, `Not reviewed: the edits after round <r> (<n> files).`, or `Not reviewed: unknown (git could not compare the trees).`
    4. `Tests: <testsLine>.`
  - `endCycle(…, end)` now sets `cycle.ended`, in place of Task 4's direct writes in `settle`, the discard path and `resolveFinding`. It posts only while `cycle.ended` was null before this end, so each cycle gets one summary; `resolveFinding` after a cap still sets `'pass'`, without a summary. Its facts:
    - `fixed`: findings with status `closed`, a file, and an id number at least `cycle.from`
    - `open`: open blocking findings
    - `decisions`: open findings with route `decision`
    - `discarded`: `cycle.discarded`
    - `notReviewed` counts from `cycle.settledTree`: 0 when it is `snap.tree`; `loop.changed.length` when it is null; else `(await changedBetween(…))?.length ?? null`. It is non-zero only when the cycle ends on a discarded round.
    - `tests`: `testsLine(testStates(loop, cfg), now)`
  - `endCycle` then writes `cycle.summary`, sets `cycle.toldTree = snap.tree`, adds an Activity note (kind `review`) with the four lines joined by single spaces, and shows the toast `devloop: <that line>` with `{ timeoutMs: 20_000 }`.
  - `noteUnreviewed($: Engine, at: Place, cfg: Config, tree: string | null): Promise<void>` in `hooks/review.ts` implements rule 7. It runs at every stop that ends the turn, in the same places Task 2 calls `startBackground`. When `cycle.ended === 'cap'`, `tree` is not null, `tree !== cycle.settledTree` and `tree !== cycle.toldTree`, it:
    - counts `N` with `changedBetween(cycle.settledTree, tree)` (or `loop.changed.length` with no settled tree);
    - posts `Not reviewed: <N> files changed after round <cfg.maxReviewRounds>.` (`1 file changed` for one; `Not reviewed: files changed after round <cap> (git could not count them).` when git cannot say) as a toast `devloop: <line>`, an Activity note (kind `review`), and `cycle.followUp`;
    - sets `cycle.toldTree = tree`.
  - Prompt context: `{ key: 'review-followup', label: 'not reviewed', priority: 1, text: cycle.followUp }`, beside `review-summary`.
  - Prompt context: `{ key: 'review-summary', label: 'review summary', priority: 1, text: summary === null ? null : `${summary}\nRelay this summary to the person as it is.` }`.

- [ ] **Step 1: Write the failing tests** (append)

```ts
const F = (id: string, problem: string, extra: Partial<Finding> = {}): Finding => ({ id, reviewer: 'general', severity: 'high', file: 'a.ts', line: 1, quote: 'x', problem, evidence: 'e', isPreExisting: false, route: 'fix', status: 'closed', isBlocking: true, round: 1, seen: 1, note: null, ...extra })
const s = (run: string, state: TestState['state'], extra: Partial<TestState> = {}): TestState => ({ run, isBackground: false, state, durationMs: null, startedAt: null, lines: '', saved: null, ...extra })

test('§5: the summary after a pass', () => {
  expect(reviewSummary({ end: 'pass', round: 2, maxRounds: 3, fixed: [F('F1', 'slide title.'), F('F2', 'speaker note')], open: [], decisions: [], discarded: 0, notReviewed: 0, tests: '✓ passed on this tree (bash tests/run-all.sh, 41m)' }))
    .toBe('Review done: passed in round 2 of 3.\nFixed: F1 slide title, F2 speaker note.\nStill open for you: none.  Not reviewed: none.\nTests: ✓ passed on this tree (bash tests/run-all.sh, 41m).')
})
test('§5 and rule 11: the summary when the cap is spent, with a discarded round', () => {
  expect(reviewSummary({ end: 'cap', round: 3, maxRounds: 3, fixed: [], open: [F('F4', 'a', { status: 'open' })], decisions: [F('F5', 'x'.repeat(80), { status: 'open', route: 'decision' })], discarded: 1, notReviewed: 1, tests: 'not run on this tree (npm test)' }))
    .toBe(`Review done: the cap of 3 rounds is spent; F4 still open; 1 round discarded because the code changed during review.\nFixed: none.\nStill open for you: F5 ${'x'.repeat(60)}.  Not reviewed: the last edit after round 3 (1 file).\nTests: not run on this tree (npm test).`)
})
test('rule 11: the summary says how many rounds the code changed under', async ($, on) => {
  const w = world(on, { ...CONFIG, maxReviewRounds: 2 }); await start($); await fix($, w)
  change(w, 'src/b.ts'); await answer($, 'agent-1', 'VERDICT: PASS')
  await stop($); await answer($, 'agent-2', 'VERDICT: PASS')
  expect(w.toasts.filter(one => one.startsWith('devloop: Review done'))).toEqual(['devloop: Review done: passed in round 2 of 2; 1 round discarded because the code changed during review. Fixed: none. Still open for you: none.  Not reviewed: none. Tests: ✓ passed on this tree (npm test, <1m).'])
})
test('rule 7: after a capped cycle, an edit gets one "Not reviewed" line per tree', async ($, on) => {
  const w = world(on, { ...CONFIG, maxReviewRounds: 1 }); await start($)
  await fix($, w); await answer($, 'agent-1', `${F_HIGH}\nVERDICT: FAIL`)
  const followUps = (): string[] => w.toasts.filter(one => one.startsWith('devloop: Not reviewed:'))
  expect(followUps()).toEqual([])
  w.since = ['src/b.ts', 'src/c.ts']; await fix($, w, 'src/b.ts')
  expect(followUps()).toEqual(['devloop: Not reviewed: 2 files changed after round 1.'])
  expect(loopIn(w).events.some(one => one.kind === 'review' && one.text === 'Not reviewed: 2 files changed after round 1.')).toBe(true)
  await stop($)
  expect(followUps().length).toBe(1)
  await prompt($)
  expect(w.contexts.at(-1)?.join('\n')).toMatch(/Not reviewed: 2 files changed after round 1\./)
})
test('testsLine: failing, then running, then not run, then passed', () => {
  const now = 14 * 60_000
  expect(testsLine([], now)).toBe('none set')
  expect(testsLine([s('a', 'pass', { durationMs: 0 }), s('b', 'fail')], now)).toBe('✗ failing on this tree (b)')
  expect(testsLine([s('a', 'pass'), s('b', 'running', { startedAt: 0, isBackground: true })], now)).toBe('running (b, started 14m ago)')
  expect(testsLine([s('a', 'pass'), s('b', 'not run')], now)).toBe('not run on this tree (b)')
  expect(testsLine([s('a', 'pass', { durationMs: 0 }), s('b', 'pass', { durationMs: 41 * 60_000 })], now)).toBe('✓ passed on this tree (a, <1m; b, 41m)')
})
test('§4: the reviewer reads the tests on this tree, and may not run the background ones', async ($, on) => {
  const w = world(on, { ...CONFIG, autoReview: false, verify: ['npm test', { run: 'bash tests/run-all.sh', background: true }] }); await start($)
  w.files['/repo/src/a.ts'] = 'x'; change(w, 'src/a.ts'); await stop($)
  w.now += 41 * 60_000; w.spawns[0]?.finish(1, 'FAIL tests/a.test.ts\nexpected 1 to be 2'); await whenSettled()
  await devloop($, 'review')
  expect(w.spawned[0]?.prompt).toMatch(/Checks you may run, exactly as written:\n  npm test\n\nTests on this tree, as the harness recorded them:\n  ✓ passed  npm test \(<1m\)\n  ✗ failing  bash tests\/run-all\.sh \(41m\)\n      FAIL tests\/a\.test\.ts\n      expected 1 to be 2\nYou cannot run the background tests above and should not try: judge from these results\./)
})
test('§5: one summary when a cycle ends with a pass: a toast, the Activity tab, the next prompt', async ($, on) => {
  const w = world(on); await start($)
  await fix($, w); await answer($, 'agent-1', `${F_HIGH}\nVERDICT: FAIL`)
  expect(w.toasts.some(one => one.startsWith('devloop: Review done'))).toBe(false)
  await fix($, w); await answer($, 'agent-2', 'F1 | resolved\nVERDICT: PASS')
  const line = 'Review done: passed in round 2 of 3. Fixed: F1 rounds down. Still open for you: none.  Not reviewed: none. Tests: ✓ passed on this tree (npm test, <1m).'
  expect(w.toasts.filter(one => one.startsWith('devloop: Review done'))).toEqual([`devloop: ${line}`])
  expect(loopIn(w).events.some(one => one.kind === 'review' && one.text === line)).toBe(true)
  await prompt($)
  expect(w.contexts.at(-1)?.join('\n')).toMatch(/Review done: passed in round 2 of 3\.\nFixed: F1 rounds down\.\n[\s\S]*Relay this summary to the person as it is\./)
  await prompt($, 'and now?')
  expect(w.contexts.at(-1)?.join('\n') ?? '').not.toMatch(/Review done/)
})
test('§5: the cap ends a cycle with one summary', async ($, on) => {
  const w = world(on, { ...CONFIG, maxReviewRounds: 2 }); await start($)
  await fix($, w); await answer($, 'agent-1', `${F_HIGH}\nVERDICT: FAIL`)
  await fix($, w); await answer($, 'agent-2', 'F1 | resolved\nF2 | high | src/a.ts:1 | export const a = 1 | still rounds down | a test with 1.5\nVERDICT: FAIL')
  expect(w.toasts.filter(one => one.startsWith('devloop: Review done'))).toEqual(['devloop: Review done: the cap of 2 rounds is spent; F2 still open. Fixed: F1 rounds down. Still open for you: none.  Not reviewed: none. Tests: ✓ passed on this tree (npm test, <1m).'])
})
```

- [ ] **Step 2: Run them to see them fail**

Run: `claude plugin test . 2>&1 | grep -E "\(fail\)" | head`
Expected: the new tests fail (no `reviewSummary`, no block).

- [ ] **Step 3: Implement** the block, the line, `reviewSummary`, `endCycle`, `noteUnreviewed` and its Stop-path calls, `reviewerChecks`, and the two context sources

- [ ] **Step 4: Run the tests and validate**

Run: `claude plugin test . 2>&1 | tail -3; claude plugin validate . 2>&1 | tail -1`
Expected: `0 fail`; `Validation passed`.

- [ ] **Step 5: Build and commit**

```bash
bash scripts/build.sh
git add hooks/testruns.ts hooks/findings.ts hooks/review.ts hooks/state.ts hooks/register.tsx dist/devloop.mjs tests/agentreview.test.ts
git commit -m "Show the reviewer the tests and the person one summary"
```

---

### Task 7: The command-line gate and the pre-push hook (rule 12)

**Files:**
- Modify:
  - `hooks/portable.ts`: `checksFor` and `statelessGate` take `isBackgroundSkipped`.
  - `cli/gate.ts`: `proveGate` and `gateCommand` pass it through.
  - `cli/main.ts`: `gate` parses `--no-background`; the `USE` line reads `gate [--no-background] [--pushing <commit>…]`, and the usage error says the same.
  - `cli/hook.ts`: the classic ship hook's `proveGate` call passes `true`, since a background check never runs inside a hook.
  - `hooks/githook.ts`: `prePushHook` runs `gate --no-background --pushing $pushing`.
  - `tests/smoke.sh` and `dist/devloop.mjs`.
- Test: `tests/d1.test.ts`, `tests/smoke.sh`

**Interfaces:**
- Consumes: Task 1's `backgroundFor` and `checksFor`, which already includes background checks.
- Produces:
  - `checksFor(cfg: Config, files: readonly string[], isEmpty: boolean, isBackgroundSkipped = false): string[]`.
  - `statelessGate(proof: TreeProof, cfg: Config, facts: GateFacts, isBackgroundSkipped = false)`. When skipped, the rows are judged with background checks left out of `cfg.verify`, then one met row is added per applicable background check: `{ label: 'Background check: <run>', isMet: true, note: "not checked here (background): CI or the session's background run proves it" }`. Such a row never fails the exit code.
  - `proveGate(found: Found, budget: Budget | null = null, isBackgroundSkipped = false)` and `gateCommand(found: Found, pushing: readonly string[] | null = null, isBackgroundSkipped = false)`.
  - Without the flag, `devloop gate` runs background checks with the rest, as CI needs. `docs/examples/devloop-gate.yml` stays without the flag.

- [ ] **Step 1: Write the failing tests** in `tests/d1.test.ts` (add `checksFor` to its `../hooks/portable` import)

```ts
describe('rule 12: background checks at the command line', () => {
  const cfg = { ...DEFAULTS, verify: [{ run: 'unit', profile: 'fast', when: null }, { run: 'slow', profile: 'fast', when: null, background: true }] } as Config
  const proof: TreeProof = { tree: 't1', committable: 't1', base: 'b', files: ['docs/a.md'], lines: 1, runs: [{ run: 'unit', isPassing: true, outcome: 'pass', output: '' }], credentials: [], hidden: [], isScanned: true, note: null }
  const facts = { errors: [], lint: [], policy: 'same' as const }
  test('the gate runs them, unless told --no-background', () => {
    expect(checksFor(cfg, ['docs/a.md'], false)).toEqual(['unit', 'slow'])
    expect(checksFor(cfg, ['docs/a.md'], false, true)).toEqual(['unit'])
  })
  test('without the flag an unrun background check keeps the gate red; with it, its row says who proves it', () => {
    const row = (rows: readonly { label: string }[], label: string) => rows.find(one => one.label === label)
    expect(row(statelessGate(proof, cfg, facts).rows, 'Verification')).toMatchObject({ isMet: false })
    const skipped = statelessGate(proof, cfg, facts, true)
    expect(row(skipped.rows, 'Background check: slow')).toEqual({ label: 'Background check: slow', isMet: true, note: "not checked here (background): CI or the session's background run proves it" })
    expect(row(skipped.rows, 'Verification')).toMatchObject({ isMet: true })
  })
  test('the installed pre-push hook passes --no-background', () => {
    expect(prePushHook('/p/dist/devloop.mjs')).toMatch(/node '\/p\/dist\/devloop\.mjs' gate --no-background --pushing \$pushing/)
  })
})
```

In `tests/smoke.sh`, add a block after section 27. It uses a fresh throwaway repository `$work/bg` (git init on `main`, one base commit, a `feature` branch) whose `devloop.json` is `{ "mode": "enforce", "verify": ["true", { "run": "test ! -e docs/slow.flag", "background": true }], "tiers": { "low": ["docs/**"] } }`. Change `docs/a.md`, then `touch docs/slow.flag`; the flag sits under `docs/` so the change stays low risk and needs no review note. Then check:
- `expect "rule 12: the gate runs background checks (1)" "$(code cli gate)" "1"`
- `expect "rule 12: --no-background leaves them to CI (0)" "$(code cli gate --no-background)" "0"`
- `cli gate --no-background | grep -q "Background check: test ! -e docs/slow.flag: not checked here (background)"`, followed by `pass`/`fail` as the other checks do.

- [ ] **Step 2: Run them to see them fail**

Run: `claude plugin test . 2>&1 | grep -E "\(fail\)" | head; bash tests/smoke.sh 2>&1 | grep 'rule 12'`
Expected: the d1 tests fail (no fourth parameter; the hook has no flag). The smoke lines FAIL; the flag is rejected or ignored until Step 3.

- [ ] **Step 3: Implement** the parameter through `checksFor`, `statelessGate`, `proveGate` and `gateCommand`; the flag in `cli/main.ts` (removed from the arguments before `--pushing` is read); the classic hook's `true`; and the hook text

- [ ] **Step 4: Rebuild, then run everything that touches the command line**

Run: `bash scripts/build.sh; claude plugin test . 2>&1 | tail -3; bash tests/smoke.sh 2>&1 | grep FAIL`
Expected: `0 fail`; only the environmental-baseline FAIL lines (the existing pre-push hook checks in sections 29 and F4 still pass with the flag).

- [ ] **Step 5: Commit**

```bash
git add hooks/portable.ts cli/gate.ts cli/main.ts cli/hook.ts hooks/githook.ts tests/d1.test.ts tests/smoke.sh dist/devloop.mjs
git commit -m "Let the pre-push hook leave background checks to CI"
```

---

### Task 8: Docs, release 0.5.0, full check

**Files:**
- Modify:
  - `README.md`: in "Everyday use" and "How it works", rounds start at stops and through `devloop_review`; long suites go under `"background": true`; the summary.
  - `docs/REFERENCE.md`:
    - `### Verification`: background checks.
    - `### Review`: when rounds start; a pass starts a new cycle; discarded rounds count; the summary and the "Not reviewed" follow-up.
    - `### Tools the agent can call`: a `devloop_review` row.
    - The command-line table: `gate [--no-background] [--pushing <commit>…]`.
    - The `/devloop hooks install` row: the hook passes `--no-background`, and CI runs the gate without it.
    - The devloop.json table: the `verify` entry's `background`; the `verifyTimeoutSec` row "up to 600; mark longer checks `"background": true`"; the `autoReview` row rewritten to §1; `maxReviewRounds` as "per review cycle, discarded rounds included; a pass starts a new cycle".
  - `.claude-plugin/plugin.json`: `"version": "0.5.0"`.

- [ ] **Step 1: Update the docs** from the code as built (copy, refusals, summary lines)

- [ ] **Step 2: Bump the version** to `0.5.0`

- [ ] **Step 3: Full check** (all four from Global Constraints)

Run: `claude plugin test . 2>&1 | tail -3; claude plugin validate . 2>&1 | tail -1; bash tests/smoke.sh 2>&1 | grep FAIL; bunx tsc -p .superpowers/tsc.json --noUnusedLocals --noUnusedParameters 2>&1 | grep -c 'error TS'`
Expected: `0 fail`; `Validation passed`; only the environmental-baseline FAIL lines; `7`, all in `tests/loop.test.ts`.

- [ ] **Step 4: Commit**

```bash
git add README.md docs/REFERENCE.md .claude-plugin/plugin.json
git commit -m "Document agent-driven review and background tests, release 0.5.0"
```
