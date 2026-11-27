# Easier start for devloop

Date: 2026-11-27. Status: draft for approval. A builder check was run and
its questions are settled in the sections below.

## Why

A person installing devloop on a real project
got confused. `/devloop` only said "Run /devloop init". `init` asked nothing,
found no test command (it only reads `package.json`, `pyproject.toml`,
`pytest.ini`, `go.mod`, `Cargo.toml`), and answered in devloop's own terms
(observe mode, guards, base branch). The status then showed
`[x] Verification: nothing to verify`, which reads as "all good" but means
"no files changed yet". Net effect: devloop was on, proved nothing, and did
not say so in words the person could act on. Separately, the person cannot
see devloop's ~27 actions without reading `/devloop help`.

Success: in a new repository, `/devloop` gets a person to a working setup in
three answers (Enter three times takes the recommended defaults), and every
message along the way says what it did and what it means for them.

## Goals

1. **Guided setup.** `/devloop` (no arguments) in a repository that is not
   set up, and `/devloop init`, run a short setup instead of a bare message
   or a silent write.
2. **Plain words.** Setup and status messages say what devloop will do in
   this repository, without its internal terms.
3. **Actions in the `/` menu.** Typing `/devloop` lists each action with its
   one-line description.
4. **Readable failures.** When the `/devloop` handler throws, the person sees
   the error, not the engine's generic "no command.run hook answered it".

## Non-goals

- No change to what the guards, the gate, review or verification do, and no
  new `devloop.json` fields.
- No change to the command line (`dist/devloop.mjs`) beyond what a wording
  change in a bundled module forces (see Constraints).
- No new test-command detection for other ecosystems in this change.

## Anti-goals (a failure even if it works)

- Setup writes anything the person did not answer for. Dismissing a
  question cancels setup and writes nothing.
- The agent can start setup. It stays a person's command, as `init` is today
  (`isFromPerson`, `hooks/commands.ts:196`).
- A default is quietly weaker than today's: "Watch only" is today's default
  mode; the approval choice is asked, not assumed.

## Approaches considered

- **A. Instant setup.** Write defaults on `/devloop`, then explain. Rejected:
  the test command is what `init` most often cannot guess, and without it
  devloop proves nothing, which is the confusion we are fixing.
- **B. Quick guided setup (chosen by the person).** Three picker questions,
  recommended answer first.
- For the action list, the alternatives were a picker on `/devloop` (the
  engine's picker holds 2–4 options, so ~27 actions need nested menus) and an
  Actions tab in the Dev loop pane (only visible while the pane is open, and
  actions needing text still need typing). **Chosen (my call, the person
  may overrule): one `/` menu entry per action.**

## Design

### 1. Guided setup

Trigger: `/devloop` with no arguments when no policy governs the repository
(today's `NOT_SET_UP` path, `hooks/commands.ts:134`), and `/devloop init`.
Both run the same flow. The existing refusals in `init` stay as they are
(a policy above already governs; base branch has one; not from a person).

First, a short intro line in the transcript: devloop isn't set up here; once
it is, it runs your tests each time Claude stops, has a second agent review
changes before they ship, and keeps Claude off secrets and risky files.

Then three questions through `$.ui.ask` (2–4 labels each, plus the dialog's
own free-text "Other"):

1. **How strict to start?**
   - `Watch only (recommended)` → `"mode": "observe"`
   - `Block from the start` → `"mode": "enforce"`
2. **What runs your tests?**
   - If `detectVerify` found commands: first option is what it found
     (joined, e.g. `npm test --silent + npm run --silent lint`), second
     `None for now`. Typed text under Other replaces what was found.
   - If it found none: the question says none were found; options are
     `None for now` and `I'll add it later` (both write an empty list; the
     second makes the summary point at the exact place to add one). Typed
     text under Other becomes the command.
   - A typed command is written as one plain string entry (a `fast` check).
3. **Who approves risky merges?**
   - `Just me (recommended)` → `"approvals": { "low": 0, "medium": 1, "high": 1 }`
   - `Two people` → no `approvals` field (today's default `high: 2`)

   Recommended is my call (the person left it to me): most people trying
   devloop work alone, and with two approvals a solo person can never clear
   a high-risk change. It is an explicit answer, so it needs no warning; the
   summary names the choice and how to change it.

Dismissing any question (the `$.ui.ask` promise rejects) ends setup with
"Setup cancelled. Nothing was written." Where no one can be asked (`-p`),
`init` already refuses as not-from-a-person; no change.

Answer handling (builder's calls, settled here):

- **Typed text on questions 1 and 3** is matched case-insensitively:
  `watch`/`observe` and `block`/`enforce` for question 1; `me`/`just me`/
  `1`/`one` and `two`/`2` for question 3. Anything else re-asks that
  question once with a note, then cancels with nothing written. Never
  silently falls back to a default.
- **Question 2:** the first option writes the detected list exactly as
  `detectVerify` returns it (objects with `profile` and `when` intact).
  Typed text replaces the whole list with one plain string, which the
  config reads as a `fast` check (`hooks/config.ts:368`). Typed `none`,
  `no`, or empty text means `None for now`.
- **Long labels:** a joined label over 60 characters is cut with `…`; the
  question text lists every detected command in full.
- **Not from a person:** `/devloop` with no arguments from the agent or a
  plugin keeps returning a not-set-up message, reworded so it does not tell
  the agent to run a person's command: "devloop is not set up in this
  repository. A person sets it up by typing /devloop."
- **A failure mid-write** (say `fs.write` throws after `devloop.json` was
  written) reports the error and lists the files written so far.

Then the files are written exactly as `init` writes them today
(`devloop.json`, `AGENTS.md` if there is no `CLAUDE.md`, `REVIEW.md`,
`evals/README.md`; never overwriting), with the answers applied to
`devloop.json`. `configFile` (`hooks/templates.ts:10`) gains the mode and
approvals as parameters.

Finally, a plain summary replacing today's init text:

```
devloop is set up.

What it will do here
  - Watch only: it notes what it would have blocked, and blocks nothing
    (it always blocks reading secret files).
  - Each time Claude stops after changing files, it runs: npm test --silent
  - Before anything is pushed, a second agent reviews the change.
  - Risky merges need your approval (just you).

Files it added
  devloop.json      your settings (commit it to main: devloop reads it from there)
  REVIEW.md         what the reviewer looks for
  AGENTS.md         notes every Claude session reads
  evals/README.md   where regression tasks go

Change these later in devloop.json: "mode", "verify", "approvals".
Next: /devloop-doctor checks the setup.
```

With no test command, the "runs" line instead says nothing will be checked
until one is added under `"verify"` in `devloop.json`, with an example.
The default-branch line stays, in plain words.

### 2. Plain words elsewhere

- The Verification row when nothing changed: `nothing to verify` →
  `no changes yet` (`hooks/gate.ts:166`).
- No other status or gate wording changes in this change.

### 3. Actions in the `/` menu

At `session.start`, after `/devloop`, register one command per top-level
action in `HELP` (`hooks/commands.ts:47`) except `init`: every
`/devloop <word>` HELP documents, plus `help`. Today that is 32: allow,
approve, audit, budget, cache, checklists, claims, continue, defect, doctor,
done, eval, findings, followups, gate, handoff, help, hooks, learn, lesson,
library, metrics, papercuts, prune, questions, regressions, report, review,
rules, sandbox, spec, verify. Each:

- `description`: the action's line from `HELP`, shortened to one line.
- `argumentHint`: the action's arguments where it takes any (e.g.
  `<name>` for spec, `install | uninstall | doctor | report | status` for
  cache).
- served by a `command.run` hook that calls the existing `command($, e)`
  directly with `args` set to `<action> <args>` and the original `e`
  (origin included). Not through `$.command.run`, which would make the
  origin the plugin's and refuse person-only actions.

Where (builder's calls, settled here):

- "Set up" means `at.isOptedIn`, the same test that opens the pane at
  session start, so an uncommitted `devloop.json` counts.
- Set up: all 32 are registered. Not set up: only the four that work
  without a policy (`doctor`, `cache`, `library`, `help`) beside
  `/devloop`, which leads to setup. After setup completes in a session,
  the rest are registered then.
- Each registration is its own call with its own `.catch`: a name another
  plugin or skill already holds is skipped, and the others still register.
- `/devloop <action>` keeps working.

### 4. Readable failures

Add a `.catch` to the `command.run` hooks (`hooks/register.tsx:898` and the
new forwarders) returning `{ text: "devloop: /devloop <args> failed: <error
message>. If it keeps happening, start Claude with --debug and share the
log." }`. Root cause of the one observed failure is unknown: it did not
reproduce in a fresh headless session or in the test kit (init then verify,
same session). This change makes the next occurrence diagnosable.

### 5. Setup in a folder that is not a git repository

Observed: setup ran in a plain parent folder whose git repository is
the subfolder `plugin/`. `init` wrote its files there, printed
"Default branch: main" (a silent fallback in `detectBranch`), and `/devloop`
then said "No changes yet". devloop could see nothing, and nothing said so.

- Setup checks for a git repository before the first question.
- Not a git repository, and one or more direct subfolders are: name them
  and write nothing. "This folder isn't a git repository, so devloop can't
  see changes here. Found one in plugin/: open Claude there and type
  /devloop."
- Not a git repository, and none below: one question, `Cancel
  (recommended)` or `Set up anyway`. The latter's summary says devloop
  will only see files Claude edits: no diffs, no credential scan, no push
  gate.
- The default branch line says "guessed" when `detectBranch` fell back.
- `/devloop` status in a folder that is not a git repository says so in
  place of "No changes yet".

### 6. The Dev loop panel on narrow windows (VS Code)

Observed: in VS Code's Claude panel the Dev loop pane never appears. devloop
opens it unasked at session start (`hooks/register.tsx:880`), and the engine
draws an unasked pane only from 144 columns wide; VS Code's panel is
narrower, so the pane waits undrawn, and no command opens it on request.

- Any `/devloop…` command a person types (`/devloop`, `/devloop <action>`,
  `/devloop-<action>`) in a repository that is set up also opens the pane.
  A person's command counts as asked, so the engine draws it at any width.
  Opening an already-open pane changes nothing.
- Not from a person, or not set up: no change.

### 7. cache-guard offered in setup (person chose: on by default, via a question)

Silent install was rejected: it would change every project's user settings
and reply style without asking, and `/devloop cache install` is a person's
call by design (`hooks/cachecmd.ts:90`, `:120`).

- A fourth setup question, after question 3, only when Python 3.8+ is
  found and cache-guard is not already installed (its status line is in
  `~/.claude/settings.json`, as `guardOf` reads it):
  "Also turn on cache-guard? It shows what Claude's prompt cache saves you
  in the status line, warns before moves that waste it, and with
  "everything" switches Claude to short replies. It edits your
  ~/.claude/settings.json (all projects)."
  - `Yes, everything (recommended)` → install `--all`
  - `Yes, but keep normal replies` → install `--notify`
  - `Not now` → nothing
- Answering it is the person's confirmation: no second dialog. Typed text
  follows the same rule as questions 1 and 3 (re-ask once, then cancel
  with nothing written). Dismissing it cancels setup, nothing written.
- The install runs after devloop's files are written, through the same
  code path and audit entry as `/devloop cache install`. If it fails,
  setup still succeeds; the summary says so.
- One summary line: installed (everything / normal replies) and restart
  Claude Code to see the status line; not installed (`/devloop cache
  install` adds it later); already installed; skipped (needs Python 3.8+);
  or could not be installed (first line of the error).

## Constraints

- `hooks/gate.ts` is bundled into `dist/devloop.mjs`; changing its wording
  means rebuilding with `bash scripts/build.sh` (needs `bun`) and committing
  the bundle, or `tests/smoke.sh` fails.
- Command names: letters, digits, `_`, `-`, up to 64; a name another command
  holds refuses the registration.
- `$.ui.ask` takes 2–4 option labels; fewer than two are padded with Yes/No.
- Checks to run: `claude plugin validate .`, `claude plugin test .`,
  `bash tests/smoke.sh`. `tsc` is not installed on this machine.
- Tests answer the picker through the world's `AskUserQuestion` stub
  (`tests/world.ts:379`), which answers every question with `w.answer`; a
  three-question flow needs it to answer per question.

## Left to the builder

- Exact wording of each line, within the plain-words goal.
- How `HELP` is turned into descriptions and hints (parse it, or a small
  table beside it).
- Whether the summary's "Next" points to `/devloop-doctor` or
  `/devloop doctor` (prefer the menu form once registered).
- Test layout: new tests for setup answers (each option), cancel-writes-
  nothing, not-from-a-person refusal, forwarder origin, and the catch.
