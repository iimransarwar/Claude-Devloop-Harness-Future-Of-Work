# Settings Panel Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `/devloop settings` opens a focused popup where a person picks devloop's settings and saves them to `devloop.json`, told plainly when the change takes effect.

**Architecture:** A pure model in a new `hooks/settings.ts` reads `devloop.json` into rows and writes back only the keys a person changed. `hooks/register.tsx` adds the `settings` command, a second pane (`devloop-settings`) drawn with `Select` and `Button`, and a draft kept in `$.state`. Test-command editing and cache-guard buttons reuse setup's question and the existing cache install/uninstall path.

**Tech Stack:** TypeScript hooks module on the Claude Code plugin engine; tests on `claude-code/testing` (`$.ui.mount`, `ui.press`, `ui.select`) with the world in `tests/world.ts`; `bun` for the bundle.

**Spec:** `docs/superpowers/specs/2026-11-27-settings-panel-design.md`

## Global Constraints

- Work on branch `settings-panel`, created from `main`. Never push. Never commit to `main`.
- Commit messages are plain one-liners with no `Co-Authored-By` or any Claude attribution.
- `git add` only the files a task names. Untracked `devloop.json`, `AGENTS.md`, `REVIEW.md`, `evals/`, `.DS_Store` files and `.superpowers/` stay uncommitted. Do not modify `.git/info/exclude`. Never run cache-guard's real installer.
- Pane id `devloop-settings`, title `devloop settings`, opened with `focus: true, closeOnEscape: true`.
- Command text answers: from a person in a set-up repo `Settings are open.`; from anyone else `Settings are a person's: type /devloop settings.`; from a person in a repo not set up, run setup (same as `/devloop`).
- Row labels and option labels exactly as the spec's table: `Mode` (`Watch only`, `Block`), `Tests` (+ `Change`), `Which tests` (`Only those for changed files`, `All of them`), `Auto review` (`On`, `Off`), `Risky merges` (`Just me`, `Two people`, `Custom (as in devloop.json)`), `Check before answering` (`Same as mode`, `Tell me`, `Block`, `Off`), `Learn from mistakes` (`Trial`, `Propose only`, `Off`), `Save specs to library` (`On`, `Off`), `cache-guard` (+ `Install` or `Remove`).
- Invalid value option: `Invalid in devloop.json: <raw value>`. Changed rows show `•` before the label.
- Effect lines: base has no `devloop.json` → `Saved. devloop uses these settings now.`; base has one → `Saved to devloop.json. devloop keeps using <base>'s copy until you commit this change to <base>.` The open panel shows the same line without `Saved` / `Saved to devloop.json.` at its start.
- Footer: `Tiers, protected paths, reviewers and the rest: edit devloop.json.`
- Tests → Change options in order: `Keep the current checks`, the detected commands (only when they differ from the current list), `None for now`; typed text under Other. Warning when the list holds object entries: `This replaces your N checks, including ones that run before shipping or only for some files.`
- Audit action `settings-changed`, subject the changed keys joined with `, `.
- `devloop.json` writes: 2-space indent, trailing newline, every untouched key and its order kept.
- After changing a bundled module (`hooks/records.ts`): `bash scripts/build.sh` and commit `dist/devloop.mjs`.
- Checks: `claude plugin test .` (0 fail), `claude plugin validate .`, type check via a scratch tsconfig adding `/private/tmp/claude-501/bundled-skills/2.1.332/0b6894d9201ce74370ec13e9b0abe3f1/plugin-authoring/types/claude-code.d.ts` with `--noUnusedLocals --noUnusedParameters` (baseline: 7 errors in `tests/loop.test.ts`, add none), `bash tests/smoke.sh` (no FAIL line beyond the environmental baseline).
- Release: `.claude-plugin/plugin.json` version `0.4.0`.

## Review Focus

1. A `devloop.json` with unknown fields or an unusual key order: Save keeps them and their order (Task 1 test).
2. Reopening the panel after a Save shows the saved values, not the old ones (Task 2 test).
3. `devloop.json` that is not valid JSON: the panel shows the error and only `Cancel`, and the file is untouched (Task 2 test).
4. Esc or Cancel after picking: nothing is written (Task 2 test).
5. `/devloop-settings` from the agent: refused, no pane (Task 2 test).

---

### Task 1: Settings model

**Files:**
- Create: `hooks/settings.ts`
- Modify: `hooks/records.ts` (`AUDIT_ACTIONS` + `'settings-changed'`), `schemas/audit-event@1.json` (same enum), `dist/devloop.mjs` (rebuilt)
- Test: `tests/settings.test.ts`

**Interfaces:**
- Consumes: `parseConfig(text): Parsed` (`hooks/config.ts:890`, `errors` name their field), `DEFAULTS`.
- Produces (`hooks/settings.ts`):
  - `type RowKey = 'mode' | 'tests' | 'scope' | 'autoReview' | 'approvals' | 'grounding' | 'learning' | 'library'`
  - `type Row = { key: RowKey; label: string; options: readonly { value: string; label: string }[]; current: string; error: string | null }` (for `tests`, `options` is empty and `current` is the display text)
  - `type SettingsView = { rows: readonly Row[]; verify: readonly unknown[] }` or `{ error: string }` when the text is not one JSON object
  - `function readSettings(text: string): SettingsView | { error: string }`
  - `type Changes = Partial<Record<RowKey, string>> & { verify?: readonly unknown[] }` (option values, plus a replacement `verify` list)
  - `function applyChanges(text: string, changes: Changes): string`
  - `function changedKeys(changes: Changes): string[]` (the `devloop.json` key paths, e.g. `learning.auto`)
  - `function effectLine(base: string, baseHasPolicy: boolean, isSaved: boolean): string`
  - Option values are the `devloop.json` values as strings: `observe`/`enforce`, `targeted`/`full`, `true`/`false`, `me`/`two`/`custom`, `same`/`observe`/`enforce`/`off`, `trial`/`propose`/`off`, `auto`/`off`; an invalid row's extra option has value `invalid`. `custom` and `invalid` are never written.

- [ ] **Step 1: Create branch**

Run: `git switch -c settings-panel`
Expected: `Switched to a new branch 'settings-panel'`

- [ ] **Step 2: Write the failing tests** in `tests/settings.test.ts`

```ts
const BASE = '{\n  "mode": "observe",\n  "defaultBranch": "main",\n  "verify": ["npm test"],\n  "zeta": 1\n}\n'
test('readSettings shows effective values with defaults filled in', () => {
  const v = readSettings(BASE) as SettingsView
  const row = (k: RowKey) => v.rows.find(r => r.key === k)!
  expect(row('mode').current).toBe('observe')
  expect(row('approvals').current).toBe('two')          // absent → default {0,1,2}
  expect(row('grounding').current).toBe('same')          // absent → Same as mode
  expect(row('learning').current).toBe('trial')
  expect(row('tests').current).toBe('npm test')
})
test('approvals: {0,1,1} is me, {0,1,2} two, anything else custom', () => {
  const at = (a: object) => (readSettings(JSON.stringify({ approvals: a })) as SettingsView).rows.find(r => r.key === 'approvals')!.current
  expect(at({ low: 0, medium: 1, high: 1 })).toBe('me')
  expect(at({ low: 0, medium: 1, high: 2 })).toBe('two')
  expect(at({ low: 0, medium: 2, high: 3 })).toBe('custom')
})
test('an invalid value shows the Invalid option and its error', () => {
  const v = readSettings('{ "testing": { "scope": "sometimes" } }') as SettingsView
  const row = v.rows.find(r => r.key === 'scope')!
  expect(row.current).toBe('invalid')
  expect(row.options.some(o => o.label === 'Invalid in devloop.json: sometimes')).toBe(true)
  expect(row.error).not.toBeNull()
})
test('text that is not one JSON object is an error', () => {
  expect('error' in readSettings('{ nope')).toBe(true)
})
test('applyChanges writes only changed keys, keeps order and unknown fields', () => {
  const out = applyChanges(BASE, { mode: 'enforce', learning: 'off' })
  expect(Object.keys(JSON.parse(out))).toEqual(['mode', 'defaultBranch', 'verify', 'zeta', 'learning'])
  expect(JSON.parse(out)).toMatchObject({ mode: 'enforce', zeta: 1, learning: { auto: 'off' } })
  expect(out.endsWith('}\n')).toBe(true)
})
test('applyChanges merges nested objects and maps option values', () => {
  const text = '{ "learning": { "auto": "trial", "repeats": 5 } }'
  expect(JSON.parse(applyChanges(text, { learning: 'propose' })).learning).toEqual({ auto: 'propose', repeats: 5 })
  expect(JSON.parse(applyChanges('{}', { approvals: 'me' })).approvals).toEqual({ low: 0, medium: 1, high: 1 })
  expect(JSON.parse(applyChanges('{}', { autoReview: 'false' })).autoReview).toBe(false)
  expect('mode' in (JSON.parse(applyChanges('{ "grounding": { "mode": "off" } }', { grounding: 'same' })).grounding ?? {})).toBe(false)
  expect(JSON.parse(applyChanges('{ "verify": ["a"] }', { verify: [] })).verify).toEqual([])
})
test('custom and invalid are never written', () => {
  expect(applyChanges(BASE, { approvals: 'custom', scope: 'invalid' })).toBe(BASE)
})
test('changedKeys names devloop.json paths', () => {
  expect(changedKeys({ mode: 'enforce', learning: 'off', verify: [] })).toEqual(['mode', 'learning.auto', 'verify'])
})
test('effectLine', () => {
  expect(effectLine('main', false, true)).toBe('Saved. devloop uses these settings now.')
  expect(effectLine('main', true, true)).toBe("Saved to devloop.json. devloop keeps using main's copy until you commit this change to main.")
  expect(effectLine('main', true, false)).toBe("devloop keeps using main's copy until you commit this change to main.")
})
```

- [ ] **Step 3: Run to see them fail**

Run: `claude plugin test . 2>&1 | grep -E "settings.test|\(fail\)" | head`
Expected: `tests/settings.test.ts` fails to import `../hooks/settings`.

- [ ] **Step 4: Implement `hooks/settings.ts`; add `'settings-changed'` to `AUDIT_ACTIONS` and the schema enum; rebuild the bundle**

Order-keeping write: parse to an object, assign changed keys in place (new keys append), `JSON.stringify(obj, null, 2) + '\n'`. When nothing applicable changed, return the input text unchanged.

- [ ] **Step 5: Run the tests**

Run: `claude plugin test . 2>&1 | tail -3`
Expected: `0 fail`

- [ ] **Step 6: Commit**

```bash
git add hooks/settings.ts hooks/records.ts schemas/audit-event@1.json dist/devloop.mjs tests/settings.test.ts
git commit -m "Add the settings model"
```

---

### Task 2: The settings popup

**Files:**
- Modify: `hooks/register.tsx` (command routing for `settings`, a `ui.render` hook for `{ component: 'Pane', requestId: 'devloop-settings' }`, skip `openForPerson` for `settings`), `hooks/actions.ts` (`settings` entry, not policy-free: 33 entries), `hooks/commands.ts` (`HELP` line `/devloop settings        change devloop's settings in a popup (a person's)`), `hooks/state.ts` (draft atom + read/update helpers), `types/index.d.ts` (`PluginState.devloop.settings`), `tests/world.ts` (as needed), `tests/actions.test.ts` (count 32 → 33)
- Test: `tests/settings.test.ts`

**Interfaces:**
- Consumes: Task 1's `readSettings`, `applyChanges`, `changedKeys`, `effectLine`; `isFromPerson`; `setup`; `policyInForce`/`look`/`heldPolicy`; `audit`.
- Produces: `SETTINGS_PANE = 'devloop-settings'`; draft state `{ changes: Changes; openedWith: Record<RowKey, string> } | null` under `PluginState.devloop.settings`; element keys `row-<RowKey>` (each `Select`), `save`, `cancel`, `tests-change`, `cache-install`, `cache-remove` (the last three wired in Task 3, drawn here as buttons whose handlers Task 3 fills).

- [ ] **Step 1: Write the failing tests** in `tests/settings.test.ts` (world-driven)

```ts
const MOUNT = { plugin: 'devloop', surface: 'terminal' as const, component: 'Pane' as const, requestId: 'devloop-settings',
  props: { title: 'devloop settings', isFocused: true, bodyColumns: 80, placement: 'dock' as const, scroll: { offset: 0, bodyRows: 40 }, view: {}, id: 'devloop-settings', plugin: 'devloop' } }
test('a person opens settings in a set-up repo', async ($, on) => {
  const w = world(on); await start($); w.opened.length = 0
  expect(await devloop($, 'settings')).toBe('Settings are open.')
  expect(w.opened).toEqual(['devloop-settings'])          // only the settings pane, not 'devloop'
})
test('the agent cannot open settings, by either command', async ($, on) => {
  const w = world(on); await start($); w.opened.length = 0
  expect(await devloop($, 'settings', { kind: 'sdk' })).toBe("Settings are a person's: type /devloop settings.")
  const run = await $.command.run({ command: 'devloop-settings', args: '', origin: { kind: 'sdk' }, presentation: { isFullscreen: false, columns: 80 } })
  expect(run.text).toBe("Settings are a person's: type /devloop settings.")
  expect(w.opened).toEqual([])
})
test('in a repo not set up, settings runs setup', async ($, on) => {
  world(on, null); await start($)
  expect((await devloop($, 'settings')).split('\n')[0]).toBe('devloop is set up.')
})
test('pick, save: devloop.json changes, audit written, panel closes', async ($, on) => {
  const w = world(on); await start($); await devloop($, 'settings')
  const ui = await $.ui.mount(MOUNT)
  await ui.select({ key: 'row-mode', value: 'enforce' })
  expect(await ui.find({ text: /• Mode/ })).toBeDefined()
  await ui.press({ key: 'save' })
  expect(JSON.parse(w.files['/repo/devloop.json'] ?? '{}').mode).toBe('enforce')
  expect(await devloop($, 'audit 3')).toMatch(/settings-changed[\s\S]*mode/)
})
test('reopening after save shows the saved value', async ($, on) => {
  const w = world(on); await start($); await devloop($, 'settings')
  let ui = await $.ui.mount(MOUNT); await ui.select({ key: 'row-learning', value: 'off' }); await ui.press({ key: 'save' })
  await devloop($, 'settings'); ui = await $.ui.mount(MOUNT)
  expect(await ui.find({ key: 'row-learning' })).toMatchObject({ props: { value: 'off' } })
  expect(JSON.parse(w.files['/repo/devloop.json'] ?? '{}').learning.auto).toBe('off')
})
test('cancel after a pick writes nothing', async ($, on) => {
  const w = world(on); await start($); const before = w.files['/repo/devloop.json']
  await devloop($, 'settings'); const ui = await $.ui.mount(MOUNT)
  await ui.select({ key: 'row-mode', value: 'enforce' }); await ui.press({ key: 'cancel' })
  expect(w.files['/repo/devloop.json']).toBe(before)
})
test('unreadable devloop.json: error shown, only Cancel, file untouched', async ($, on) => {
  const w = world(on); w.files['/repo/devloop.json'] = '{ nope'; await start($)
  await devloop($, 'settings'); const ui = await $.ui.mount(MOUNT)
  expect(await ui.find({ key: 'save' })).toBeUndefined()
  expect(await ui.find({ key: 'cancel' })).toBeDefined()
  expect(w.files['/repo/devloop.json']).toBe('{ nope')
})
test('the footer and effect line are shown', async ($, on) => {
  world(on); await start($); await devloop($, 'settings'); const ui = await $.ui.mount(MOUNT)
  expect(await ui.find({ text: /Tiers, protected paths, reviewers and the rest: edit devloop\.json\./ })).toBeDefined()
})
```

Adjust `ui.find` query shapes to the kit's (`grep -n "find: (" <engine d.ts>`); keep the assertions. If the world's `basePolicy` defaults make the repo's base hold a `devloop.json`, assert the "keeps using" form; otherwise the "now" form.

- [ ] **Step 2: Run to see them fail**

Run: `claude plugin test . 2>&1 | grep -E "\(fail\)" | head -20`
Expected: the new tests fail.

- [ ] **Step 3: Implement** the command routing, the pane, the draft atom (declared in `types/index.d.ts`), Save/Cancel, the `HELP` line and the 33rd action. Save: `readSettings` → `applyChanges` → `$.fs.write` → `audit` (`settings-changed`, `changedKeys(...).join(', ')`) → clear draft → `$.ui.close` → `$.ui.toast(effectLine(base, baseHasPolicy, true))`, re-checking the base with `policyInForce` first.

- [ ] **Step 4: Run tests and validate**

Run: `claude plugin test . 2>&1 | tail -3; claude plugin validate . 2>&1 | tail -1`
Expected: `0 fail`; `Validation passed`.

- [ ] **Step 5: Commit**

```bash
git add hooks/register.tsx hooks/actions.ts hooks/commands.ts hooks/state.ts types/index.d.ts tests/world.ts tests/actions.test.ts tests/settings.test.ts
git commit -m "Open a settings popup with /devloop settings"
```

---

### Task 3: Test command and cache-guard buttons

**Files:**
- Modify: `hooks/register.tsx` (handlers for `tests-change`, `cache-install`, `cache-remove`), `hooks/setup.ts` (export the test-command question builder if Task 2 needs it shared), `hooks/cachecmd.ts` (export what the buttons call)
- Test: `tests/settings.test.ts`

**Interfaces:**
- Consumes: Task 2's draft and keys; `detectVerify` (`hooks/setup.ts`); `cacheCommand` install/uninstall path with its own confirm (`hooks/cachecmd.ts`), `cacheGuardState`.
- Produces: `Change` puts `verify` in the draft (never saves by itself); `Install` runs `cache install --all`, `Remove` runs `cache uninstall`, each with cache-guard's own confirmation, applying at once; the row redraws.

- [ ] **Step 1: Write the failing tests**

```ts
test('Change → Keep the current checks leaves the draft alone', async ($, on) => {
  const w = world(on); w.answer = 'Keep the current checks'; await start($); await devloop($, 'settings')
  const ui = await $.ui.mount(MOUNT); await ui.press({ key: 'tests-change' })
  expect(await ui.find({ text: /• Tests/ })).toBeUndefined()
})
test('Change → typed command replaces verify on Save', async ($, on) => {
  const w = world(on); w.answer = 'make check'; await start($); await devloop($, 'settings')
  const ui = await $.ui.mount(MOUNT); await ui.press({ key: 'tests-change' }); await ui.press({ key: 'save' })
  expect(JSON.parse(w.files['/repo/devloop.json'] ?? '{}').verify).toEqual(['make check'])
})
test('Change warns when it would replace scoped or full checks', async ($, on) => {
  const w = world(on); w.files['/repo/devloop.json'] = JSON.stringify({ verify: ['a', { run: 'b', profile: 'full' }] }); w.answer = 'Keep the current checks'
  await start($); await devloop($, 'settings')
  const ui = await $.ui.mount(MOUNT); await ui.press({ key: 'tests-change' })
  expect(w.questions.at(-1)).toMatch(/This replaces your 2 checks, including ones that run before shipping or only for some files\./)
})
test('cache-guard Install asks its own confirmation and runs --all', async ($, on) => {
  const w = world(on); w.pythonVersion = '3.12'; w.answer = 'Install it'; await start($); await devloop($, 'settings')
  const ui = await $.ui.mount(MOUNT); await ui.press({ key: 'cache-install' })
  expect(w.cacheInstalls).toEqual([['install', '--all']])
})
test('cache-guard Install declined changes nothing', async ($, on) => {
  const w = world(on); w.pythonVersion = '3.12'; w.answer = 'Leave it'; await start($); await devloop($, 'settings')
  const ui = await $.ui.mount(MOUNT); await ui.press({ key: 'cache-install' })
  expect(w.cacheInstalls).toEqual([])
})
```

- [ ] **Step 2: Run to see them fail**

Run: `claude plugin test . 2>&1 | grep -E "\(fail\)" | head`
Expected: the new tests fail.

- [ ] **Step 3: Implement the three handlers**

- [ ] **Step 4: Run tests and validate**

Run: `claude plugin test . 2>&1 | tail -3; claude plugin validate . 2>&1 | tail -1`
Expected: `0 fail`; `Validation passed`.

- [ ] **Step 5: Commit**

```bash
git add hooks/register.tsx hooks/setup.ts hooks/cachecmd.ts tests/settings.test.ts
git commit -m "Change tests and cache-guard from the settings popup"
```

---

### Task 4: Status bar and panel colors

Spec: "Status bar" and "Panel colors" (both added by the person's request).

**Files:**
- Modify: `hooks/state.ts` (`save`: stop pinning `devloop: ${brief(next)}`; clear any pinned line), `hooks/register.tsx` (a `ui.render` hook on `{ component: 'AbovePrompt' }`), `tests/world.ts` (as needed; record `ui.open` args), `hooks/register.tsx` also: open both panes with `backgroundColor: 'transparent'` and switch the Dev loop pane's colors to theme keys (met `success`, unmet `warning`, failing `error`, secondary `subtle` instead of `dimColor`, selected tab `suggestion`)
- Test: `tests/statusbar.test.ts`

**Interfaces:**
- Consumes: `loopOf`, `gate(loop, cfg, facts)`, `tierFor`, `featureCounts`, `heldPolicy`/`factsOf` (as the Dev loop pane uses them, `hooks/register.tsx` pane render).
- Produces: `function barParts(loop: Loop, cfg: Config, checks: readonly Check[]): { phase: string; tests: { text: string; color: 'success' | 'error' | 'subtle' }; review: { text: string; color: 'success' | 'error' | 'warning' | 'subtle' } | null; gate: { met: number; total: number }; risk: { text: string; color: 'success' | 'warning' | 'error' } } | null` in a new `hooks/statusbar.ts` (pure; `null` when no row is shown).

- [ ] **Step 1: Write the failing tests** in `tests/statusbar.test.ts`

```ts
test('no row when idle with no change', () => {
  expect(barParts({ ...FRESH, phase: 'idle', tier: 'none' } as Loop, DEFAULTS, [])).toBeNull()
})
test('small fix, tests passed in green, review not run dim, gate counts, risk colored', () => {
  const p = barParts({ ...FRESH, phase: 'idle', tier: 'high', verify: { ...FRESH.verify, status: 'pass' } } as Loop, { ...DEFAULTS, verify: ['npm test'] }, [{ label: 'a', isMet: true, note: '' }, { label: 'b', isMet: false, note: '' }] as Check[])!
  expect(p.phase).toBe('Small fix')
  expect(p.tests).toEqual({ text: '✓ passed', color: 'success' })
  expect(p.review).toEqual({ text: 'not run', color: 'subtle' })
  expect(p.gate).toEqual({ met: 1, total: 2 })
  expect(p.risk).toEqual({ text: 'high', color: 'error' })
})
test('no test command reads not set, not "not run"', () => {
  const p = barParts({ ...FRESH, tier: 'medium' } as Loop, { ...DEFAULTS, verify: [] }, [])!
  expect(p.tests).toEqual({ text: 'not set', color: 'subtle' })
})
test('failing tests are red; build phase shows features', () => {
  const p = barParts({ ...FRESH, phase: 'build', spec: 'login', tier: 'medium', verify: { ...FRESH.verify, status: 'fail' } } as Loop, { ...DEFAULTS, verify: ['npm test'] }, [])!
  expect(p.tests.color).toBe('error')
  expect(p.phase).toMatch(/^Building "login" · \d+\/\d+ features$/)
})
test('low risk hides review', () => {
  expect(barParts({ ...FRESH, tier: 'low' } as Loop, { ...DEFAULTS, verify: ['x'] }, [])!.review).toBeNull()
})
test('the pinned status line is no longer set (no doubled devloop:)', async ($, on) => {
  const w = world(on); await start($); await devloop($, 'status')
  expect(JSON.stringify(w)).not.toMatch(/devloop: devloop:/)
})
```

```ts
test('both panes open with a transparent background', async ($, on) => {
  const w = world(on); await start($); w.openArgs.length = 0
  await devloop($, ''); await devloop($, 'settings')
  expect(w.openArgs.map(a => a.backgroundColor)).toEqual(['transparent', 'transparent'])
})
test('the Dev loop pane colors met rows success and uses no dimColor', async ($, on) => {
  world(on); await start($)
  const ui = await $.ui.mount({ plugin: 'devloop', surface: 'terminal', component: 'Pane', requestId: 'devloop', props: { title: 'Dev loop', isFocused: true, bodyColumns: 80, placement: 'dock', scroll: { offset: 0, bodyRows: 40 }, view: {}, id: 'devloop', plugin: 'devloop' } })
  expect((await ui.findAll({ type: 'Text' })).some(t => t.props.dimColor === true)).toBe(false)
})
```

Adjust the `FRESH` / `Check` / review-field shapes and the kit's query shapes to the real types; keep the assertions. `barParts` colors are theme keys: `'success' | 'error' | 'warning' | 'subtle'` (replace the `green/red/yellow/dim` literals in the tests above with these). Add a `$.ui.mount({ component: 'AbovePrompt', … })` test that the row contains `Small fix` and `✓ passed` when the world's loop has a passing verify.

- [ ] **Step 2: Run to see them fail**

Run: `claude plugin test . 2>&1 | grep -E "statusbar|\(fail\)" | head`
Expected: import of `../hooks/statusbar` fails.

- [ ] **Step 3: Implement `hooks/statusbar.ts`, the `AbovePrompt` hook, and stop pinning the status line**

Follow the engine example `band.tsx` in the plugin-authoring skill (`/private/tmp/claude-501/bundled-skills/2.1.332/0b6894d9201ce74370ec13e9b0abe3f1/plugin-authoring/examples/band.tsx`) for the hook shape; return `next(e)` when `barParts` is `null`.

- [ ] **Step 4: Run tests and validate**

Run: `claude plugin test . 2>&1 | tail -3; claude plugin validate . 2>&1 | tail -1`
Expected: `0 fail`; `Validation passed`.

- [ ] **Step 5: Commit**

```bash
git add hooks/statusbar.ts hooks/state.ts hooks/register.tsx tests/world.ts tests/statusbar.test.ts
git commit -m "Show status as a colored bar and make the panels readable"
```

---

### Task 5: Docs, release 0.4.0, full check

**Files:**
- Modify: `README.md` (Everyday use table: a `/devloop settings` row, "Change devloop's settings in a popup."; one line on the colored status bar above the prompt), `docs/REFERENCE.md` (commands table row + a short "Settings" subsection after Install: the rows, what each writes, when changes apply, what stays hand-edited), `.claude-plugin/plugin.json` (`"version": "0.4.0"`)

- [ ] **Step 1: Update the docs** from the code as built (labels, values, effect lines).

- [ ] **Step 2: Bump the version** to `0.4.0`.

- [ ] **Step 3: Full check** (all four from Global Constraints) and record results.

Run: `claude plugin test . 2>&1 | tail -3; claude plugin validate . 2>&1 | tail -1; bash tests/smoke.sh 2>&1 | grep -c FAIL`
Expected: `0 fail`; `Validation passed`; FAIL count equal to the baseline on `main`. Type check: only the 7 baseline errors.

- [ ] **Step 4: Commit**

```bash
git add README.md docs/REFERENCE.md .claude-plugin/plugin.json
git commit -m "Document the settings popup and release 0.4.0"
```
