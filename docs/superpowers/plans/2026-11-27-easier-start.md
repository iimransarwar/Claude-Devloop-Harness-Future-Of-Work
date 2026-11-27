# Easier Start Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `/devloop` in a new repository runs a three-question guided setup with a plain-words summary; every action appears in the `/` menu as `/devloop-<action>`; a thrown handler shows its real error; a folder that is not a git repository is named as such.

**Architecture:** Setup moves out of `hooks/commands.ts` into a new `hooks/setup.ts` (pure answer readers + the engine flow). The action list lives in a new `hooks/actions.ts` table that `hooks/register.tsx` registers and forwards to the existing `command()` handler. Wording fixes touch `hooks/gate.ts` (bundled into `dist/devloop.mjs`, so it is rebuilt) and the status text.

**Tech Stack:** TypeScript hooks module on the Claude Code plugin engine; tests on `claude-code/testing` with the in-memory world in `tests/world.ts`; `bun` for the bundle.

**Spec:** `docs/superpowers/specs/2026-11-27-easier-start-design.md`

## Global Constraints

- Work on branch `easier-start`, created from `main`. Never push. Never commit to `main`.
- Commit messages are plain one-liners with no `Co-Authored-By` or any Claude attribution.
- `git add` only the files a task names. The untracked `devloop.json`, `AGENTS.md`, `REVIEW.md`, `evals/` at the repo root are not part of this work and stay uncommitted.
- Setup writes nothing the person did not answer for. Dismissing any question: `Setup cancelled. Nothing was written.`
- Setup stays a person's command (`isFromPerson`, `hooks/journal.ts:23`).
- Option labels, exactly: `Watch only (recommended)`, `Block from the start`; `None for now`, `I'll add it later`; `Just me (recommended)`, `Two people`; outside git with no git subfolder: `Cancel (recommended)`, `Set up anyway`. Every setup question uses `header: 'Setup'`.
- `Just me` writes `"approvals": { "low": 0, "medium": 1, "high": 1 }`; `Two people` writes no `approvals` field.
- Detected-commands label: at most 60 characters, cut with `…`.
- Not-set-up text (all callers): `devloop is not set up in this repository. A person sets it up by typing /devloop.`
- Summary first line, exported as `SET_UP_HEADLINE`: `devloop is set up.`
- Failure text: `devloop: /devloop <args> failed: <message>. If it keeps happening, start Claude with --debug and share the log.` (`<message>` is `took too long` for a timeout with no message.)
- Command names: letters, digits, `_`, `-`; menu names are `devloop-<action>`.
- After any change to `hooks/gate.ts`: `bash scripts/build.sh` and commit `dist/devloop.mjs`.
- Checks: `claude plugin test .`, `claude plugin validate .`, `bash tests/smoke.sh`. Type-check with `bunx tsc -p . --noUnusedLocals --noUnusedParameters` (downloads TypeScript on first use; `tsc` is not installed).

## Review Focus

1. Running `/devloop` again right after setup in the same session must not ask the questions again: it shows status. (Test in Task 2.)
2. Files that already existed (a `REVIEW.md`, or a `CLAUDE.md` so no `AGENTS.md`) must not appear under "Files it added"; the summary lists only what was written. (Test in Task 2.)
3. A folder that is a git repository and also has git subfolders (submodules, a monorepo) sets up normally; subfolders matter only outside git. (Test in Task 2.)
4. A person-only action through its menu entry from a non-person origin (`/devloop-approve` from the agent) is refused exactly as `/devloop approve` is. (Test in Task 4.)
5. Typed answers with surrounding spaces or different case (`  NONE `, `Block`) read as the matching option; typed text under Other on question 2 is trimmed before it is written. (Test in Task 1.)

---

### Task 1: Setup answer readers, summary and config options

**Files:**
- Create: `hooks/setup.ts` (pure part only in this task)
- Modify: `hooks/templates.ts:10` (`configFile`)
- Test: `tests/setup.test.ts`

**Interfaces:**
- Produces (all exported from `hooks/setup.ts`):
  - `type Detected = string | { run: string; profile?: 'full'; when?: string[] }` (moved here from `hooks/commands.ts:137` in Task 2; declare it here now)
  - `type Strictness = 'observe' | 'enforce'`
  - `type Approvers = 'me' | 'two'`
  - `type SetupAnswers = { mode: Strictness; verify: Detected[]; isVerifyLater: boolean; approvers: Approvers }`
  - `const SET_UP_HEADLINE = 'devloop is set up.'`
  - `const OPTIONS = { strict: ['Watch only (recommended)', 'Block from the start'], none: 'None for now', later: "I'll add it later", approvers: ['Just me (recommended)', 'Two people'] } as const`
  - `function readStrictness(answer: string): Strictness | null`
  - `function readApprovers(answer: string): Approvers | null`
  - `function readVerify(answer: string, found: readonly Detected[]): { verify: Detected[]; isLater: boolean }`
  - `function foundLabel(found: readonly Detected[]): string`
  - `function summary(a: SetupAnswers, wrote: readonly string[], kept: readonly string[], branch: { name: string; isGuessed: boolean }): string`
- Produces (`hooks/templates.ts`): `configFile(verify, defaultBranch, options?: { mode?: Strictness; approvals?: { low: number; medium: number; high: number } }): string`. No options means today's output exactly.

- [ ] **Step 1: Create branch**

Run: `git switch -c easier-start`
Expected: `Switched to a new branch 'easier-start'`

- [ ] **Step 2: Write the failing tests** in `tests/setup.test.ts`

```ts
test('readStrictness reads labels and typed words, any case and spacing', () => {
  expect(readStrictness('Watch only (recommended)')).toBe('observe')
  expect(readStrictness('Block from the start')).toBe('enforce')
  expect(readStrictness('  WATCH ')).toBe('observe')
  expect(readStrictness('enforce')).toBe('enforce')
  expect(readStrictness('observe')).toBe('observe')
  expect(readStrictness('sometimes')).toBeNull()
})
test('readApprovers reads labels and me/1/one/two/2', () => {
  expect(readApprovers('Just me (recommended)')).toBe('me')
  for (const t of ['me', 'Just me', '1', 'one']) expect(readApprovers(t)).toBe('me')
  for (const t of ['Two people', 'two', '2']) expect(readApprovers(t)).toBe('two')
  expect(readApprovers('3 people')).toBeNull()
})
test('readVerify: found label keeps objects whole; typed replaces all, trimmed; none/no/empty/later mean none', () => {
  const found = ['npm test --silent', { run: 'go test ./...', when: ['**/*.go'] }]
  expect(readVerify(foundLabel(found), found)).toEqual({ verify: found, isLater: false })
  expect(readVerify('  make check  ', found)).toEqual({ verify: ['make check'], isLater: false })
  for (const t of ['None for now', 'none', ' NO ', '']) expect(readVerify(t, found)).toEqual({ verify: [], isLater: false })
  expect(readVerify("I'll add it later", [])).toEqual({ verify: [], isLater: true })
})
test('foundLabel joins with " + " and cuts at 60 characters with …', () => {
  expect(foundLabel(['npm test --silent', 'npm run --silent lint'])).toBe('npm test --silent + npm run --silent lint')
  const long = foundLabel(['npm run --silent typecheck', 'npm run --silent lint', 'npm test --silent'])
  expect(long.length).toBe(60)
  expect(long.endsWith('…')).toBe(true)
})
test('summary names mode, checks, approvers, only written files, and the guessed branch', () => {
  const text = summary({ mode: 'observe', verify: ['npm test --silent'], isVerifyLater: false, approvers: 'me' }, ['devloop.json', 'evals/README.md'], ['REVIEW.md'], { name: 'main', isGuessed: true })
  expect(text.split('\n')[0]).toBe('devloop is set up.')
  expect(text).toMatch(/Watch only/)
  expect(text).toMatch(/runs: npm test --silent/)
  expect(text).toMatch(/just you/)
  expect(text).toMatch(/devloop\.json/)
  expect(text).not.toMatch(/AGENTS\.md/)
  expect(text).toMatch(/left as is: REVIEW\.md/)
  expect(text).toMatch(/main.*guessed/)
  expect(text).toMatch(/"mode", "verify", "approvals"/)
})
test('summary with no checks says nothing is checked and where to add one', () => {
  const text = summary({ mode: 'enforce', verify: [], isVerifyLater: true, approvers: 'two' }, ['devloop.json'], [], { name: 'main', isGuessed: false })
  expect(text).toMatch(/nothing will be checked/i)
  expect(text).toMatch(/"verify"/)
  expect(text).toMatch(/two people/i)
  expect(text).not.toMatch(/guessed/)
})
test('configFile writes mode and approvals only when given', () => {
  expect(JSON.parse(configFile([], 'main')).mode).toBe('observe')
  expect('approvals' in JSON.parse(configFile([], 'main'))).toBe(false)
  const both = JSON.parse(configFile(['x'], 'main', { mode: 'enforce', approvals: { low: 0, medium: 1, high: 1 } }))
  expect(both.mode).toBe('enforce')
  expect(both.approvals).toEqual({ low: 0, medium: 1, high: 1 })
})
```

- [ ] **Step 3: Run to see them fail**

Run: `claude plugin test . 2>&1 | grep -E "setup.test|fail" | tail -20`
Expected: `tests/setup.test.ts` fails to import `../hooks/setup`.

- [ ] **Step 4: Implement the readers, `foundLabel`, `summary` in `hooks/setup.ts` and the `configFile` options**

Summary layout follows the design's example block ("What it will do here", "Files it added", "Change these later…", "Next: /devloop-doctor checks the setup."). Kept files go on one line after "Files it added": `Already there, left as is: REVIEW.md`. The branch line is always present: `Changes are measured against <name>.`, or when guessed `Changes are measured against main (guessed: set "defaultBranch" in devloop.json if that is wrong).`

- [ ] **Step 5: Run the tests**

Run: `claude plugin test . 2>&1 | tail -5`
Expected: `0 fail`

- [ ] **Step 6: Commit**

```bash
git add hooks/setup.ts hooks/templates.ts tests/setup.test.ts
git commit -m "Add setup answer readers and plain summary"
```

---

### Task 2: Guided setup flow, git check, not-set-up text

**Files:**
- Modify: `hooks/setup.ts` (add the flow), `hooks/commands.ts:134` (`NOT_SET_UP`), `:137` (remove `Detected`), `:145-195` (move `detectVerify`, `DEFAULT_BRANCH`, `detectBranch`, `init` out), `:1198-1230` (`command()` routing)
- Modify: `tests/world.ts` (setup answers, git probe, non-git snapshot, failing write)
- Modify: `tests/loop.test.ts:33`, `tests/c1review.test.ts:128` (new summary text)
- Modify: `hooks/register.tsx:901` (the `/^Wrote /` check that opens the pane after init becomes `answer.text?.startsWith(SET_UP_HEADLINE)`)
- Test: `tests/setup.test.ts`

**Interfaces:**
- Consumes: Task 1's readers, `OPTIONS`, `summary`, `SET_UP_HEADLINE`, `configFile` options.
- Produces (`hooks/setup.ts`):
  - `async function setup($: Engine, e: CommandRunInput): Promise<CommandRunResult>`, which replaces `init`
  - `async function detectBranch($: Engine, root: string): Promise<{ name: string; isGuessed: boolean }>`
  - `const GIT_PROBE`, a bash script tagged `# devloop:git-probe` that prints `git` inside a work tree, else one `sub:<dir>` line per direct subfolder holding `.git`
- Produces (`hooks/commands.ts`): `command()` sends `init`, and `''`/`status` from a person when no policy governs, to `setup`. A non-person gets the not-set-up text.
- Produces (`tests/world.ts`): `World.setupAnswers: string[] | null` (null answers each `header: 'Setup'` question with its first option; a list is used up in order; the item `'<dismiss>'` makes that question throw `Error('dismissed')`), `World.isGit: boolean` (default `true`; false makes `snapshot` answer empty stdout and `git-probe` answer the subfolders), `World.gitSubfolders: string[]`, `World.failWrite: string | null` (that path's `fs.write` throws `Error('disk full')`).

Flow order in `setup`: person check → existing-policy refusals (unchanged text except the not-set-up line) → `GIT_PROBE` → (not git: subfolders named and nothing written; none: ask `Cancel (recommended)` / `Set up anyway`) → intro line → question 1 → 2 → 3 (an unreadable typed answer re-asks once with `I didn't catch that.` prefixed, then cancels) → writes (a failing write returns `Could not write <file>: <message>. Already written: <list>.`) → baseline snapshot as today → `summary(...)`.

Question 2 when nothing is found: text says no test command was found and to type one under Other; options `None for now`, `I'll add it later`. When found: the full list in the question text; options `foundLabel(found)`, `None for now`.

- [ ] **Step 1: Write the failing tests** in `tests/setup.test.ts` (world-driven; `world(on, null)`, `start($)`, `devloop($, …)`)

```ts
test('/devloop in a repo not set up runs setup; Enter three times takes the defaults', async ($, on) => {
  const w = world(on, null); await start($)
  const said = await devloop($, '')
  expect(said.split('\n')[0]).toBe('devloop is set up.')
  expect(w.questions.length).toBe(3)
  const cfg = JSON.parse(w.files['/repo/devloop.json'] ?? '{}')
  expect(cfg.mode).toBe('observe')
  expect(cfg.approvals).toEqual({ low: 0, medium: 1, high: 1 })
})
test('/devloop init runs the same flow; answers are written', async ($, on) => {
  const w = world(on, null); w.setupAnswers = ['Block from the start', 'make check', 'Two people']; await start($)
  await devloop($, 'init')
  const cfg = JSON.parse(w.files['/repo/devloop.json'] ?? '{}')
  expect(cfg).toMatchObject({ mode: 'enforce', verify: ['make check'] })
  expect('approvals' in cfg).toBe(false)
})
test('dismissing a question writes nothing', async ($, on) => {
  const w = world(on, null); w.setupAnswers = ['Watch only (recommended)', '<dismiss>']; await start($)
  expect(await devloop($, '')).toBe('Setup cancelled. Nothing was written.')
  expect('/repo/devloop.json' in w.files).toBe(false)
})
test('an unreadable typed answer is asked again once, then cancels', async ($, on) => {
  const w = world(on, null); w.setupAnswers = ['sometimes', 'never']; await start($)
  expect(await devloop($, '')).toBe('Setup cancelled. Nothing was written.')
  expect(w.questions[1]).toMatch(/^I didn't catch that\./)
})
test('second /devloop in the same session shows status, asks nothing', async ($, on) => {
  const w = world(on, null); await start($)
  await devloop($, '')
  const asked = w.questions.length
  expect(await devloop($, '')).not.toMatch(/^devloop is set up\./)
  expect(w.questions.length).toBe(asked)
})
test('only written files are listed; existing ones are kept', async ($, on) => {
  const w = world(on, null); w.files['/repo/CLAUDE.md'] = '# x'; w.files['/repo/REVIEW.md'] = 'mine'; await start($)
  const said = await devloop($, '')
  expect(said).not.toMatch(/AGENTS\.md/)
  expect(said).toMatch(/left as is: REVIEW\.md/)
  expect(w.files['/repo/REVIEW.md']).toBe('mine')
})
test('not a git repository, git subfolder below: names it, writes nothing, asks nothing', async ($, on) => {
  const w = world(on, null); w.isGit = false; w.gitSubfolders = ['plugin']; await start($)
  const said = await devloop($, '')
  expect(said).toMatch(/isn't a git repository/)
  expect(said).toMatch(/plugin\//)
  expect(w.questions.length).toBe(0)
  expect('/repo/devloop.json' in w.files).toBe(false)
})
test('not a git repository, none below: Cancel is the default and writes nothing', async ($, on) => {
  const w = world(on, null); w.isGit = false; await start($)
  expect(await devloop($, '')).toMatch(/Nothing was written/)
  expect('/repo/devloop.json' in w.files).toBe(false)
})
test('a git repository with git subfolders sets up normally', async ($, on) => {
  const w = world(on, null); w.gitSubfolders = ['vendor/lib']; await start($)
  expect((await devloop($, '')).split('\n')[0]).toBe('devloop is set up.')
})
test('a failing write reports the file and what was already written', async ($, on) => {
  const w = world(on, null); w.failWrite = '/repo/REVIEW.md'; await start($)
  expect(await devloop($, '')).toMatch(/Could not write REVIEW\.md: disk full\. Already written: devloop\.json/)
})
test('the default branch is marked guessed when git names none', async ($, on) => {
  const w = world(on, null); w.defaultBranch = ''; await start($)
  expect(await devloop($, '')).toMatch(/main \(guessed/)
})
test('from the agent: not set up text, nothing asked or written', async ($, on) => {
  const w = world(on, null); await start($)
  expect(await devloop($, '', { kind: 'sdk' })).toBe('devloop is not set up in this repository. A person sets it up by typing /devloop.')
  expect(w.questions.length).toBe(0)
})
```

`{ kind: 'sdk' }` is the non-person origin existing tests pass to `devloop()` (e.g. `tests/loop.test.ts:58`).

- [ ] **Step 2: Run to see them fail**

Run: `claude plugin test . 2>&1 | grep -E "\(fail\)" | head -20`
Expected: the new setup tests fail.

- [ ] **Step 3: Add the world fields** in `tests/world.ts` (defaults: `setupAnswers: null`, `isGit: true`, `gitSubfolders: []`, `failWrite: null`) and their handling in the `tool.call` `AskUserQuestion` branch (`:379`), `fs.write` (`:211`), the `snapshot` case (`:268`), and a new `git-probe` case.

- [ ] **Step 4: Implement `setup`, `detectBranch`, `GIT_PROBE` in `hooks/setup.ts`; move `detectVerify` and `DEFAULT_BRANCH` there; route in `command()`; replace `NOT_SET_UP`**

- [ ] **Step 5: Update `tests/loop.test.ts:33` and `tests/c1review.test.ts:128`** to the new summary: `toMatch(/^devloop is set up\.[\s\S]*devloop\.json/)`, and for loop.test.ts the branch: `toMatch(/measured against master/)`.

- [ ] **Step 6: Run the tests**

Run: `claude plugin test . 2>&1 | tail -5`
Expected: `0 fail`

- [ ] **Step 7: Commit**

```bash
git add hooks/setup.ts hooks/commands.ts hooks/register.tsx tests/world.ts tests/setup.test.ts tests/loop.test.ts tests/c1review.test.ts
git commit -m "Guided setup on /devloop, with a git check"
```

---

### Task 3: Plain words in status and the gate

**Files:**
- Modify: `hooks/gate.ts:166`, `hooks/commands.ts:262`, `hooks/register.tsx:2124`, `dist/devloop.mjs` (rebuilt)
- Modify: `tests/loop.test.ts:586-590`, `tests/loop.test.ts:73` if its world is not git (it is git: unchanged)
- Test: `tests/setup.test.ts`

**Interfaces:**
- Consumes: `World.isGit` (Task 2).
- Produces: Verification row note `no changes yet` for tier `none`. Status line, and pane line, outside git: `Not a git repository: devloop only sees files Claude edits here.`

- [ ] **Step 1: Write the failing tests**

```ts
test('status outside git says so instead of No changes yet', async ($, on) => {
  const w = world(on); w.isGit = false; await start($)
  const said = await devloop($, 'status')
  expect(said).toMatch(/Not a git repository: devloop only sees files Claude edits here\./)
  expect(said).not.toMatch(/No changes yet/)
})
```

In `tests/loop.test.ts:586`, rename the test to `'C6: with no changes, the status says there are no changes yet'` and change `:590` to `toMatch(/Verification: no changes yet/)`.

**Amendment (controller ruling after Task 2 review): also in this task**

- Old pointers to `/devloop init` become `/devloop` (locate by text; it still works, but `/devloop` is the entry point now): `hooks/register.tsx` ~1614, ~1668, ~1971 (`A person can run /devloop init.` → `A person can set it up by typing /devloop.`), ~2059-2060 (pane: `Run /devloop init to start.` → `Type /devloop to set it up.`), `hooks/librarycmd.ts` ~290, `hooks/commands.ts` ~639 (doctor's `no devloop.json: run /devloop init` → `no devloop.json: type /devloop to set it up`). Update any test asserting the old text.
- Set up anyway summary must not promise a push review: when outside git, `summary` omits the `Before anything is pushed, a second agent reviews the change.` bullet and carries the outside-git line. Replace the `said.replace(SET_UP_HEADLINE, …)` patch (`hooks/setup.ts` ~559) with an optional last parameter `summary(a, wrote, kept, branch, options?: { isOutsideGit?: boolean })`.
- The branch fallback to the checked-out branch (last line of `DEFAULT_BRANCH`) is a guess too: that line prints `guess:<name>`, and `detectBranch` returns `{ name, isGuessed: true }` for it.

```ts
test('Set up anyway: the summary says no push gate and promises no push review', async ($, on) => {
  const w = world(on, null); w.isGit = false; w.setupAnswers = ['Set up anyway']; await start($)
  const said = await devloop($, '')
  expect(said).toMatch(/no push gate/)
  expect(said).not.toMatch(/second agent reviews/)
})
test('a branch taken from the checked-out HEAD is marked guessed', async ($, on) => {
  const w = world(on, null); w.defaultBranch = 'guess:feature'; await start($)
  expect(await devloop($, '')).toMatch(/feature \(guessed/)
})
test('doctor in a repo not set up points at /devloop', async ($, on) => {
  world(on, null); await start($)
  expect(await devloop($, 'doctor')).toMatch(/type \/devloop to set it up/)
})
```

Add to this task's commit: `hooks/setup.ts`, `hooks/librarycmd.ts`, and any test file whose old-text assertion changed.

- [ ] **Step 2: Run to see them fail**

Run: `claude plugin test . 2>&1 | grep -E "\(fail\)" | head`
Expected: the two tests above fail.

- [ ] **Step 3: Change the three texts**

- [ ] **Step 4: Rebuild the bundle**

Run: `bash scripts/build.sh && git diff --stat dist/devloop.mjs`
Expected: `dist/devloop.mjs` changed.

- [ ] **Step 5: Run tests and smoke**

Run: `claude plugin test . 2>&1 | tail -3; bash tests/smoke.sh 2>&1 | tail -5`
Expected: `0 fail`; the smoke test ends with no failures.

- [ ] **Step 6: Commit**

```bash
git add hooks/gate.ts hooks/commands.ts hooks/register.tsx hooks/setup.ts hooks/librarycmd.ts dist/devloop.mjs tests/loop.test.ts tests/setup.test.ts  # plus any test file whose old-text assertion changed
git commit -m "Say no changes yet, and say when a folder is not a git repository"
```

---

### Task 4: Actions in the `/` menu

**Files:**
- Create: `hooks/actions.ts`
- Modify: `hooks/register.tsx:866-910` (session.start, command.run), `tests/world.ts:189` (`command.register`)
- Test: `tests/actions.test.ts`

**Interfaces:**
- Consumes: `command($, e, turnId)` (`hooks/commands.ts:1198`), `SET_UP_HEADLINE` (Task 1).
- Produces (`hooks/actions.ts`):
  - `type Action = { name: string; description: string; argumentHint?: string; isPolicyFree?: true }`
  - `const ACTIONS: readonly Action[]`: the 32 names in the design §3, in that order. `isPolicyFree` on `doctor`, `cache`, `library`, `help`. Descriptions are one line from `HELP`. Hints for actions taking arguments, e.g. `spec` → `<name>`, `cache` → `install [flags] | uninstall | doctor | report | status`, `allow` → `<glob> | --command <exact command>`.
  - `const commandName = (a: Action): string => \`devloop-${a.name}\``
  - `async function registerActions($: Engine, isSetUp: boolean): Promise<string[]>`, which registers each (all, or only `isPolicyFree` ones), each in its own `.catch`, and returns the names registered.
- Produces (`register.tsx`): `session.start` calls `registerActions($, at?.isOptedIn === true)` after `wake`. The `/devloop` `command.run` hook, when the answer starts with `SET_UP_HEADLINE`, opens the pane (replacing the `/^Wrote /` test at `:901`) and calls `registerActions($, true)`. One `command.run` hook per action on `{ command: commandName(a) }` calls `command($, { ...e, args: \`${a.name} ${e.args}\`.trim() }, turnId)`.
- Produces (`tests/world.ts`): `World.registered: string[]`; `World.takenCommands: string[]` (registering one throws `Error('taken')`).

- [ ] **Step 1: Write the failing tests** in `tests/actions.test.ts`

```ts
test('ACTIONS covers every /devloop <word> in HELP except init, plus help', () => {
  const words = new Set([...HELP.matchAll(/^\/devloop ([a-z]+)/gm)].map(m => m[1]))
  words.delete('init'); words.add('help')
  expect(new Set(ACTIONS.map(a => a.name))).toEqual(words)
  expect(ACTIONS.length).toBe(32)
})
test('set up: all 32 register', async ($, on) => {
  const w = world(on); await start($)
  expect(w.registered.filter(n => n.startsWith('devloop-')).length).toBe(32)
})
test('not set up: only the four policy-free ones', async ($, on) => {
  const w = world(on, null); await start($)
  expect(w.registered.filter(n => n.startsWith('devloop-')).sort()).toEqual(['devloop-cache', 'devloop-doctor', 'devloop-help', 'devloop-library'])
})
test('after setup in a session the rest register', async ($, on) => {
  const w = world(on, null); await start($)
  await devloop($, '')
  expect(w.registered).toContain('devloop-review')
})
test('a taken name is skipped and the others still register', async ($, on) => {
  const w = world(on); w.takenCommands = ['devloop-doctor']; await start($)
  expect(w.registered).toContain('devloop-review')
})
test('a menu entry runs the same action with its arguments', async ($, on) => {
  world(on); await start($)
  expect((await $.command.run({ command: 'devloop-help', args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 80 } })).text).toBe(HELP)
})
test('a person-only action through its entry is refused for the agent as /devloop is', async ($, on) => {
  world(on); await start($)
  const run = (command: string, args: string) => $.command.run({ command, args, origin: { kind: 'sdk' }, presentation: { isFullscreen: false, columns: 80 } })
  expect((await run('devloop-approve', '')).text).toBe((await run('devloop', 'approve')).text)
})
```

`HELP` is exported from `hooks/commands.ts` for the first test.

- [ ] **Step 2: Run to see them fail**

Run: `claude plugin test . 2>&1 | grep -E "actions.test|\(fail\)" | head`
Expected: import of `../hooks/actions` fails.

- [ ] **Step 3: Add `registered` and `takenCommands` to the world; implement `hooks/actions.ts`; wire `register.tsx`; export `HELP`**

- [ ] **Step 4: Run the tests and validate**

Run: `claude plugin test . 2>&1 | tail -3; claude plugin validate . 2>&1 | tail -3`
Expected: `0 fail`; `Validation passed`.

- [ ] **Step 5: Commit**

```bash
git add hooks/actions.ts hooks/register.tsx hooks/commands.ts tests/world.ts tests/actions.test.ts
git commit -m "List every devloop action in the slash menu"
```

---

### Task 5: Readable failures

**Files:**
- Modify: `hooks/actions.ts`, `hooks/register.tsx` (the `/devloop` and per-action `command.run` hooks), `tests/world.ts`
- Test: `tests/actions.test.ts`

**Interfaces:**
- Consumes: `HookFailure` (`next.error` in a `.catch`: `{ kind: 'throw' | 'timeout'; message?: string }`).
- Produces (`hooks/actions.ts`): `function failureText(args: string, error: { kind: 'throw' | 'timeout'; message?: string } | undefined): string`, the global failure text. Both hooks get `.catch(($, e, next) => ({ text: failureText(<args as typed after /devloop>, next.error) }))`. For a menu entry, `<args>` is `<action> <args>`.
- Produces (`tests/world.ts`): `World.failing: Record<string, string>`, an event name → error message. The world's `fs.exists` throws `Error(message)` when `failing['fs.exists']` is set.

- [ ] **Step 1: Write the failing tests**

```ts
test('failureText names the command and the error, or took too long', () => {
  expect(failureText('verify', { kind: 'throw', message: 'boom' })).toBe('devloop: /devloop verify failed: boom. If it keeps happening, start Claude with --debug and share the log.')
  expect(failureText('verify', { kind: 'timeout' })).toMatch(/failed: took too long\./)
})
test('a throwing /devloop shows the real error, not the engine line', async ($, on) => {
  const w = world(on, null); w.failing['fs.exists'] = 'disk unavailable'; await start($)
  expect(await devloop($, 'init')).toMatch(/^devloop: \/devloop init failed: .*disk unavailable/)
})
```

If `init` no longer reaches `$.fs.exists` before another call, fail the first call it does make instead, and say which in the test name.

- [ ] **Step 2: Run to see them fail**

Run: `claude plugin test . 2>&1 | grep -E "\(fail\)" | head`
Expected: both fail.

- [ ] **Step 3: Implement `failureText`, add the `.catch` handlers, add `failing` to the world**

- [ ] **Step 4: Run the tests**

Run: `claude plugin test . 2>&1 | tail -3`
Expected: `0 fail`

- [ ] **Step 5: Commit**

```bash
git add hooks/actions.ts hooks/register.tsx tests/world.ts tests/actions.test.ts
git commit -m "Show the real error when a devloop command fails"
```

---

### Task 6: Docs and the full check

**Files:**
- Modify: `README.md` ("Set up a project", the Everyday use table), `docs/REFERENCE.md:31-56` (after Install: what `/devloop` setup asks and writes)

- [ ] **Step 1: Update the README.** "Set up a project" becomes: type `/devloop`, answer three questions, plus a fourth offering cache-guard when Python 3.8+ is present (list them with the recommended answers), commit `devloop.json` to main. Add one line under Everyday use: each action is also in the `/` menu as `/devloop-<action>`. Add one line: typing any `/devloop` command opens the Dev loop panel, including in VS Code's narrow Claude panel (Task 7, which runs before this task).

- [ ] **Step 2: Update `docs/REFERENCE.md`** where it describes `init`: the three questions, the answer mapping (Global Constraints), the not-a-git-repository behaviour, and that `/devloop init` runs the same setup.

- [ ] **Step 3: Full check**

Run: `claude plugin test . 2>&1 | tail -3; claude plugin validate . 2>&1 | tail -2; bash tests/smoke.sh 2>&1 | tail -3; bunx tsc -p . --noUnusedLocals --noUnusedParameters 2>&1 | tail -5`
Expected: `0 fail`; `Validation passed`; smoke ends with no failures; no tsc output.

- [ ] **Step 4: Commit**

```bash
git add README.md docs/REFERENCE.md
git commit -m "Document the guided setup and the menu entries"
```

---

### Task 7: Open the Dev loop panel when a person asks

**Files:**
- Modify: `hooks/register.tsx` (the `/devloop` `command.run` hook and the per-action forwarders), `tests/world.ts:209` (`ui.open`)
- Test: `tests/actions.test.ts`

**Interfaces:**
- Consumes: `PANE` (`hooks/register.tsx:73`), `isFromPerson` (`hooks/journal.ts:23`), `ACTIONS`/forwarders (Task 4), `.catch` handlers (Task 5).
- Produces: after a person's `/devloop…` command is answered in a repository that is set up (`at.isOptedIn` after the command ran), `void $.ui.open({ id: PANE, title: 'Dev loop' })`. Not from a person, or not set up: no open. `World.opened: string[]` records each `ui.open` id.

- [ ] **Step 1: Write the failing tests**

```ts
test('a person typing /devloop in a set-up repo opens the panel', async ($, on) => {
  const w = world(on); await start($); w.opened.length = 0
  await devloop($, '')
  expect(w.opened).toContain('devloop')
})
test('a person typing a menu entry opens the panel too', async ($, on) => {
  const w = world(on); await start($); w.opened.length = 0
  await $.command.run({ command: 'devloop-help', args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 80 } })
  expect(w.opened).toContain('devloop')
})
test('the agent running /devloop does not open the panel', async ($, on) => {
  const w = world(on); await start($); w.opened.length = 0
  await devloop($, '', { kind: 'sdk' })
  expect(w.opened).not.toContain('devloop')
})
test('a person in a repo not set up does not get the panel from doctor', async ($, on) => {
  const w = world(on, null); await start($); w.opened.length = 0
  await devloop($, 'doctor')
  expect(w.opened).not.toContain('devloop')
})
```

- [ ] **Step 2: Run to see them fail**

Run: `claude plugin test . 2>&1 | grep -E "\(fail\)" | head`
Expected: the first two fail (`w.opened` missing or empty).

- [ ] **Step 3: Add `opened` to the world; open the pane in both hooks after the answer, for a person in a set-up repository**

One helper in `register.tsx` used by both hooks; the existing open after setup (Task 2) folds into it.

- [ ] **Step 4: Run the tests**

Run: `claude plugin test . 2>&1 | tail -3`
Expected: `0 fail`

- [ ] **Step 5: Commit**

```bash
git add hooks/register.tsx tests/world.ts tests/actions.test.ts
git commit -m "Open the Dev loop panel when a person runs a devloop command"
```

---

### Task 8: Offer cache-guard as a fourth setup question

Runs after Task 7, before Task 6. Spec §7.

**Files:**
- Modify: `hooks/cachecmd.ts` (extract the install path), `hooks/setup.ts` (question 4, the install, the summary line), `tests/world.ts`
- Test: `tests/setup.test.ts`

**Interfaces:**
- Consumes: `setup`'s question/re-ask helper and `summary(a, wrote, kept, branch, options?)` (Tasks 1-3); `guardOf`, `installFlags` (`hooks/cacheguard.ts`); `pythonOf`, `runScript`, `audit` (`hooks/cachecmd.ts`).
- Produces (`hooks/cachecmd.ts`): `async function installCacheGuard($: Engine, at: Place, flags: readonly string[], e: CommandRunInput): Promise<{ isOk: boolean; text: string }>`: runs the installer and writes the same audit entry; no confirm dialog (callers confirm). `cacheCommand`'s install branch keeps its confirm and then calls it. Also `async function cacheGuardState($: Engine): Promise<'installed' | 'no-python' | 'available'>`.
- Produces (`hooks/setup.ts`): `OPTIONS.cache = ['Yes, everything (recommended)', 'Yes, but keep normal replies', 'Not now']`; `function readCache(answer: string): '--all' | '--notify' | 'none' | null` (typed `everything`/`all`/`yes` → `--all`; `normal`/`notify` → `--notify`; `no`/`not now`/`skip`/`none` → `none`); `summary`'s options gain `cacheLine?: string`, appended as its own line before `Next:`.
- Produces (`tests/world.ts`): `World.pythonVersion: string | null` (default `null`, so existing tests skip question 4), `World.cacheInstalls: string[][]` (each installer argv after the script path), `World.cacheInstallExit: number` (default `0`).

Exact summary lines:
- `cache-guard: installed (everything). Restart Claude Code to see its status line.`
- `cache-guard: installed (normal replies). Restart Claude Code to see its status line.`
- `cache-guard: not installed. /devloop cache install adds it later.`
- `cache-guard: already installed.`
- `cache-guard: skipped, it needs Python 3.8 or later.`
- `cache-guard: could not be installed (<first line of its output>). /devloop cache install tries again.`

- [ ] **Step 1: Write the failing tests** in `tests/setup.test.ts`

```ts
test('Enter through setup with Python installs cache-guard with --all', async ($, on) => {
  const w = world(on, null); w.pythonVersion = '3.12'; await start($)
  const said = await devloop($, '')
  expect(w.questions.length).toBe(4)
  expect(w.cacheInstalls).toEqual([['install', '--all']])
  expect(said).toMatch(/cache-guard: installed \(everything\)\. Restart Claude Code/)
})
test('keep normal replies installs with --notify', async ($, on) => {
  const w = world(on, null); w.pythonVersion = '3.12'; w.setupAnswers = ['Watch only (recommended)', 'None for now', 'Just me (recommended)', 'Yes, but keep normal replies']; await start($)
  await devloop($, '')
  expect(w.cacheInstalls).toEqual([['install', '--notify']])
})
test('Not now installs nothing and says how to add it later', async ($, on) => {
  const w = world(on, null); w.pythonVersion = '3.12'; w.setupAnswers = ['Watch only (recommended)', 'None for now', 'Just me (recommended)', 'Not now']; await start($)
  expect(await devloop($, '')).toMatch(/cache-guard: not installed\. \/devloop cache install adds it later\./)
  expect(w.cacheInstalls).toEqual([])
})
test('no Python: three questions, skipped line', async ($, on) => {
  const w = world(on, null); await start($)
  expect(await devloop($, '')).toMatch(/cache-guard: skipped, it needs Python 3\.8 or later\./)
  expect(w.questions.length).toBe(3)
})
test('already installed: three questions, already line', async ($, on) => {
  const w = world(on, null); w.pythonVersion = '3.12'
  w.files['<home>/.claude/settings.json'] = JSON.stringify({ statusLine: { command: 'python3 /x/cache_guard.py statusline' } })
  await start($)
  expect(await devloop($, '')).toMatch(/cache-guard: already installed\./)
  expect(w.questions.length).toBe(3)
})
test('a failing install still sets devloop up and says so', async ($, on) => {
  const w = world(on, null); w.pythonVersion = '3.12'; w.cacheInstallExit = 1; await start($)
  const said = await devloop($, '')
  expect(said.split('\n')[0]).toBe('devloop is set up.')
  expect(said).toMatch(/cache-guard: could not be installed \(.*\)\. \/devloop cache install tries again\./)
  expect('/repo/devloop.json' in w.files).toBe(true)
})
test('dismissing the cache question writes nothing and installs nothing', async ($, on) => {
  const w = world(on, null); w.pythonVersion = '3.12'; w.setupAnswers = ['Watch only (recommended)', 'None for now', 'Just me (recommended)', '<dismiss>']; await start($)
  expect(await devloop($, '')).toBe('Setup cancelled. Nothing was written.')
  expect(w.cacheInstalls).toEqual([])
  expect('/repo/devloop.json' in w.files).toBe(false)
})
test('/devloop cache install still asks its own confirmation', async ($, on) => {
  const w = world(on); w.pythonVersion = '3.12'; w.answer = 'Leave it'; await start($)
  expect(await devloop($, 'cache install --all')).toBe('Nothing was changed.')
  expect(w.cacheInstalls).toEqual([])
})
```

`<home>` is however the world resolves the user's home for `~/.claude/settings.json` (find how `guardOf`'s facts are read and use that path).

- [ ] **Step 2: Run to see them fail**

Run: `claude plugin test . 2>&1 | grep -E "\(fail\)" | head -20`
Expected: the new tests fail.

- [ ] **Step 3: World stubs** for `python3 -c <PYTHON_VERSION>` (answers `w.pythonVersion`, or fails when null) and `python3 <script> install …` (records argv after the script into `w.cacheInstalls`, exits `w.cacheInstallExit`).

- [ ] **Step 4: Extract `installCacheGuard` and `cacheGuardState` in `hooks/cachecmd.ts`; add question 4 and the summary line in `hooks/setup.ts`**

- [ ] **Step 5: Run the tests and validate**

Run: `claude plugin test . 2>&1 | tail -3; claude plugin validate . 2>&1 | tail -2`
Expected: `0 fail`; `Validation passed`.

- [ ] **Step 6: Commit**

```bash
git add hooks/cachecmd.ts hooks/setup.ts tests/world.ts tests/setup.test.ts
git commit -m "Offer cache-guard during setup"
```
