# devloop settings panel

Date: 2026-11-27. Status: draft for approval. A builder check was run; its questions are settled under "Rules settled after the builder check".

## Why

Once a repository is set up, the only way to change how devloop behaves is
to hand-edit `devloop.json`, and the person has to know field names like
`grounding.mode` or `learning.auto`. The status report's `[x]` / `[ ]` rows
look like switches but are gate results, which confused the person. They
want `/devloop settings`: a popup inside Claude Code where they pick values
instead of editing JSON.

Success: a person types `/devloop settings`, moves with the arrow keys,
picks values, presses Save, and `devloop.json` holds the new values; they
are told plainly when the change takes effect.

## Goals

1. `/devloop settings` (and `/devloop-settings` in the `/` menu) opens a
   focused settings popup in a repository that is set up.
2. Each setting is a picker or a button; no field names, no JSON.
3. Save writes `devloop.json`, keeping every field the panel does not show.
4. The panel says when changes apply: at once, or once `devloop.json` is
   committed to the base branch.

## Non-goals

- No new `devloop.json` fields and no change to what any setting does.
- Not every field: tiers, protected paths, forbidden commands, network,
  reviewers, budgets and checklists stay hand-edited (each needs lists or
  globs, which a picker cannot hold well). The panel says so in one line.
- No committing or pushing from the panel.
- The live Now / Done / Next view is a separate design.

## Anti-goals

- The agent can open or change settings. The panel is a person's, like
  `/devloop init`; a non-person gets a refusal.
- Save drops or rewrites fields the panel does not show, or reorders the
  person's file needlessly.
- The panel implies a change is in force when the base branch's copy still
  governs.

## Approaches considered

- **Settings panel (chosen by the person):** one focused pane with every
  setting visible, pickers and buttons, Save and Cancel.
- Chain of question dialogs: rejected; the dialog holds 2–4 options, so
  eight settings means paging through menus.
- Claude Code's own `/config` (plugin `userConfig`): rejected; it is per
  user, not per repository, and devloop's settings are the repository's.

## Design

### Opening

- `/devloop settings` and `/devloop-settings` (a 33rd entry in `ACTIONS`,
  `hooks/actions.ts`; not policy-free).
- From a person in a set-up repository: open pane id `devloop-settings`,
  title `devloop settings`, with `focus: true` and `closeOnEscape: true`
  (`$.ui.open`; a person's command counts as asked, so it is drawn at any
  width). The command's text answer is one line: `Settings are open.`
- From a person in a repository not set up: run setup instead (the same
  flow as `/devloop`).
- From anyone else: `Settings are a person's: type /devloop settings.`

### The rows

Each picker is a `Select` (arrows move, Enter picks); its options are below
with the `devloop.json` value each writes. The current value comes from the
working tree's `devloop.json`, defaults filled in.

| Row label | Options → value |
| --- | --- |
| Mode | `Watch only` → `"mode": "observe"`; `Block` → `"enforce"` |
| Tests | the current `verify` list as text, and a `Change` button (below) |
| Which tests | `Only those for changed files` → `"testing": { "scope": "targeted" }`; `All of them` → `"full"` |
| Auto review | `On` → `"autoReview": true`; `Off` → `false` |
| Risky merges | `Just me` → `"approvals": { "low": 0, "medium": 1, "high": 1 }`; `Two people` → `{ "low": 0, "medium": 1, "high": 2 }`; when the file holds anything else, a third option `Custom (as in devloop.json)` that writes nothing |
| Check before answering | `Same as mode` → `"grounding": { "mode": null }` (removes the key); `Tell me` → `"observe"`; `Block` → `"enforce"`; `Off` → `"off"` |
| Learn from mistakes | `Trial` → `"learning": { "auto": "trial" }`; `Propose only` → `"propose"`; `Off` → `"off"` |
| Save specs to library | `On` → `"library": { "save": "auto" }`; `Off` → `"off"` |
| cache-guard | text `installed` / `not installed` / `needs Python 3.8+`, and an `Install` or `Remove` button |

Nested objects are merged: setting `learning.auto` keeps `learning.repeats`
and the rest.

**Tests → Change** asks through `$.ui.ask` (the setup's question 2: the
detected commands, `None for now`, or typed text under Other) and puts the
answer in the draft. It does not save by itself.

**cache-guard → Install / Remove** runs the existing
`/devloop cache install --all` / `uninstall` path with its own confirmation
dialog; it is user-level and applies at once, independent of Save. The row
then redraws.

### Draft, Save, Cancel

- Picks go into a draft kept in `$.state` (a new key in the `devloop`
  contract, `types/index.d.ts`), never on disk until Save.
- Changed rows show a `•` before the label.
- `Save` reads `devloop.json` as JSON, sets only the changed keys (merging
  nested objects), writes it back with 2-space indentation and a trailing
  newline, writes an audit entry `settings-changed` naming the keys, clears
  the draft, closes the pane, and toasts the effect line.
- `Cancel` and Esc drop the draft and close the pane.
- If `devloop.json` cannot be parsed, the panel shows the error and only
  `Cancel`; it never overwrites a file it could not read.

### When it applies (the effect line)

devloop reads its policy from the base branch whenever the base has a
`devloop.json` (`policyInForce`), so a change cannot loosen its own rules.

- Base branch has no `devloop.json`: `Saved. devloop uses these settings
  now.`
- Base branch has one: `Saved to devloop.json. devloop keeps using <base>'s
  copy until you commit this change to <base>.`
- The same line, without "Saved", is shown at the bottom of the open panel.

A footer line: `Tiers, protected paths, reviewers and the rest: edit
devloop.json.`

### Rules settled after the builder check (my calls)

- **Current values.** Each row shows the effective value: the working
  tree's `devloop.json` merged over `DEFAULTS` (`hooks/config.ts`), so an
  absent key shows its default (absent `approvals` → `Two people`; absent
  `grounding.mode` → `Same as mode`). `approvals` reads `Just me` when the
  effective value is exactly `{0,1,1}`, `Two people` when exactly
  `{0,1,2}`, otherwise `Custom (as in devloop.json)`.
- **Invalid values.** A key that `parseConfig` reports in its `errors`
  shows a selected extra option `Invalid in devloop.json: <raw value>` that
  writes nothing, and the error text under the row.
- **Save writes only what the person changed** in this panel session, key
  by key, compared against the value shown when the panel opened. Untouched
  rows, including invalid or custom ones, are never written.
- **Tests → Change** asks with these options in order: `Keep the current
  checks` (default; no change), the detected commands (when any differ
  from the current list), `None for now` (→ `[]`), typed text under Other
  (→ `["<text>"]`). Any answer other than Keep replaces the whole `verify`
  list. When the current list holds object entries (a `profile: "full"` or
  `when` globs), the question text says so: "This replaces your N checks,
  including ones that run before shipping or only for some files." The row
  shows each entry's command, with `(before shipping)` after full ones.
- **Only one pane.** `/devloop settings` and `/devloop-settings` open only
  the settings pane: they skip `openForPerson`'s Dev loop pane.
- **Effect line.** The open panel's footer uses the policy devloop last
  held (render runs nothing): base name from its `defaultBranch`, and
  whether the base had a `devloop.json`. Save re-checks with
  `policyInForce` before writing its toast, so the toast is current.

### Status bar (added by the person's request)

Today devloop pins a plain status line (`$.ui.status`, `hooks/state.ts`
`save`): the engine draws it as `⚠ devloop: ` + devloop's text, which itself
starts `devloop: `, so it reads "⚠ devloop: devloop: small-fix mode · high
risk · verify not run · review not run". Plain text only: no color, no
progress, and "verify not run" even when no test command is set.

- Replace it with a one-line `AbovePrompt` band row (`ui.render` on
  `{ component: 'AbovePrompt' }`; `Text` takes `color`), and clear the old
  status line. Shown exactly when the status line is shown today (not idle,
  or a change exists); otherwise no row.
- The row: `devloop  <phase>  ·  tests <state>  ·  review <state>  ·  gate
  <met>/<total> <bar>  ·  <tier> risk`.
  - Phase: `Small fix`; `Writing spec "<name>"`; `Building "<name>" ·
    <passing>/<total> features`.
  - Tests: `✓ passed` (green), `✗ failing` (red), `! error` (red), `not run`
    (dim), `not set` (dim, when `verify` is empty). Colors map to theme keys
    (see Panel colors).
  - Review (as today, not shown for low risk): `✓ passed` (green),
    `✗ changes asked` (red), `… running` (yellow), `not run` (dim).
  - Gate: met rows over all rows, with the engine's `Progress` element.
  - Risk: `high` red, `medium` yellow, `low` green.
- No doubled `devloop:`. No `⚠`.
- Not in this change: which task is running now (the live Now / Done / Next
  view, a separate design).

### Panel colors (added by the person's request)

Observed: the Dev loop pane drew black and dim text on a dark gray body in
a light-theme terminal. devloop opens it without a background
(`$.ui.open({ id, title })`), so the docked seat's own dark look stands,
while text uses the theme's normal and dim colors.

- Open both panes (`devloop` and `devloop-settings`) with
  `backgroundColor: 'transparent'`, so the body shows the terminal's own
  background and theme text colors read on it in light and dark themes.
- Colors only from theme keys (`ThemeKey`), never fixed names or hex:
  met / passed `success`; unmet / waiting `warning`; failing / blocked
  `error`; secondary lines `subtle` (in place of `dimColor`); the selected
  tab and the changed-row marker `suggestion`; headings bold in `text`.
- The status bar uses the same keys: green → `success`, red → `error`,
  yellow → `warning`, dim → `subtle`.

## Constraints

- Engine elements: `Box`, `Text`, `Button`, `Select` (`SelectProps`: `key`,
  `label`, `options`, selected value, a pick raises `ui.select`); no text
  input element, hence `$.ui.ask` for the test command.
- `$.state` keys must be declared in `types/index.d.ts` (`claude plugin
  validate` checks it).
- A pane hook may not take `$` in an inner closure the loader refuses; use
  top-level helpers (Task 7 of easier-start hit this).
- Tests: the world answers `ui.open`, `ui.ask` and records opened panes;
  `ui.select` and button presses need world support or a direct call to the
  handlers.
- Checks: `claude plugin test .`, `claude plugin validate .`, the type check
  with the bundled engine types (7-error baseline in `tests/loop.test.ts`),
  `bash tests/smoke.sh` (no new FAIL lines).
- Release: bump `.claude-plugin/plugin.json` to `0.4.0` when it ships.

## Left to the builder

- Layout details within the sketch: spacing, row order after Mode.
- How the draft is shaped in state.
- How `ui.select` and button presses are routed to handlers.
- Test layout.
