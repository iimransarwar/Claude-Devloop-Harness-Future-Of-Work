# devloop

**Let the agent build. Keep the say over what ships.**

devloop is a Claude Code plugin that turns an AI coding agent into a
disciplined teammate. The agent writes the code. devloop decides when the
work is actually done, keeps the agent away from what it should not touch,
has the work checked by someone other than the agent that wrote it, and
leaves the merge to you.

<p align="center">
  <img src="docs/images/change-loop.svg" width="420" alt="One change, top to bottom: you ask; the agent edits inside the harness guard; when it stops the harness runs the checks that cover the changed files and hands a failure back; the agent tries to push; before the push lands the gate runs the full checks and a separate read-only reviewer reads the change; then the push goes through and you merge. Six failed rounds on one branch stop the agent.">
</p>

## Why devloop

- **Done means verified.** Your own test commands run every time the agent
  stops. A failure goes straight back to the agent. "It should work now" is
  not an answer.
- **The agent never grades itself.** A separate reviewer, in a fresh context
  and with read-only access, reads every code change before it can ship.
- **Guardrails, not babysitting.** Secret files, your policy, locked tests,
  destructive commands and production deploys are off limits. The agent is
  told why, and you are not asked to approve every step.
- **Specs it cannot quietly rewrite.** For bigger work you approve a spec
  with a check for each requirement. The checks lock, and a feature counts as
  done only when the harness has run its check.
- **It knows when to stop.** Capped fix and review rounds, and a hard stop
  after repeated failures, so a stuck agent reports back instead of burning
  a day.
- **It learns your project.** Repeated mistakes become proposed rules that
  run on trial first. You promote the ones that earn it.
- **Specs you can reuse.** Every finished spec is saved to your own library,
  so later work, in this project or another, starts from it.
- **Cheap to run.** devloop's own text never changes mid-session, so it
  never breaks Claude's prompt cache, and what it adds per prompt is small.
- **Checks before it answers.** Ask a question about the state of things and
  the agent is pushed to look at the source, not answer from memory.

## Requirements

| You need | For |
| --- | --- |
| [Claude Code](https://code.claude.com), kept up to date | Everything. devloop is a Claude Code plugin. |
| Node 18 or later on your `PATH` | The hooks and the `devloop` command line. |
| git | Reading the policy from your default branch, diffs and the push gate. |
| Python 3.8 or later | Only the optional cache-guard. |
| bun | Only to rebuild `dist/devloop.mjs` from source. |

## Install

This repository is its own plugin marketplace, named `devloop`, holding one
plugin, also named `devloop`. Add the marketplace, then install the plugin.

### From inside Claude Code

Run these at the Claude Code prompt **one at a time**. A slash command takes
a single line, so pasting both together fails.

1. Add the marketplace:

   ```
   /plugin marketplace add iimransarwar/Claude-Devloop-Harness-Future-Of-Work
   ```

2. When that finishes, install the plugin:

   ```
   /plugin install devloop@devloop
   ```

3. Restart Claude Code so the hooks load.

### From the terminal

```bash
claude plugin marketplace add iimransarwar/Claude-Devloop-Harness-Future-Of-Work
claude plugin install devloop@devloop
```

Or in one step, which adds the marketplace for you if it is not there yet:

```bash
claude plugin install devloop --marketplace iimransarwar/Claude-Devloop-Harness-Future-Of-Work
```

### For a whole team

Install at project scope. The marketplace and the plugin are then declared
in the repository's `.claude/settings.json`, so everyone who opens the
project in Claude Code gets devloop:

```bash
claude plugin marketplace add iimransarwar/Claude-Devloop-Harness-Future-Of-Work --scope project
claude plugin install devloop@devloop --scope project
```

Commit `.claude/settings.json`.

### From a local clone

Use this to try changes to devloop itself:

```bash
git clone https://github.com/iimransarwar/Claude-Devloop-Harness-Future-Of-Work.git
claude plugin marketplace add ./Claude-Devloop-Harness-Future-Of-Work
claude plugin install devloop@devloop
```

### Check, update, remove

```bash
claude plugin list                          # devloop@devloop shows as enabled
claude plugin marketplace update devloop    # fetch the latest from GitHub
claude plugin update devloop@devloop        # then restart Claude Code
claude plugin uninstall devloop@devloop
```

## Set up a project

devloop does nothing to a repository until it opts in. Until then only the
secrets guard and the setup are live.

1. In your project, type `/devloop`. In a repository that is not set up it
   starts a short guided setup. Press Enter to take the recommended answer.
   - How strict? `Watch only (recommended)` or `Block from the start`.
   - What runs your tests? The commands it found in `package.json`,
     `pyproject.toml`, `go.mod` or `Cargo.toml`, `None for now`, or type your
     own. When it finds none: `I'll add it later`.
   - Who approves risky merges? `Just me (recommended)` or `Two people`.
   - Only when Python 3.8 or later is found and cache-guard is not
     installed: add cache-guard? `Yes, everything (recommended)`, `Yes, but
     keep normal replies` or `Not now`.

   Dismissing a question cancels and writes nothing. At the end it says in
   plain words what it will do and which files it added: `devloop.json`,
   `REVIEW.md`, `evals/README.md` and, if there is no `CLAUDE.md`, an
   `AGENTS.md`. It never overwrites a file that exists. `/devloop init` runs
   the same setup.
2. Commit `devloop.json` to your main branch. The policy is always read from
   there, so a change cannot loosen its own rules.
3. Run `/devloop doctor` to see what is in force.
4. When you are happy with what it reports, change `"mode": "observe"` to
   `"mode": "enforce"`. In observe mode devloop only records what it would
   have stopped. Reading a secret file is refused in either mode.

If the folder is not a git repository, setup names the git repository inside it
when there is one and writes nothing. Otherwise it asks whether to cancel or
set up anyway.

## Everyday use

Just ask the agent for what you want. devloop works in the background.

| Command | When |
| --- | --- |
| `/devloop` | See where the current change stands and what is left. |
| `/devloop spec <name>` | Start a spec for bigger work. |
| `/devloop approve` | Approve the spec. Its checks lock. |
| `/devloop review` | Ask for an independent review now. |
| `/devloop done` | Close the change after you have read it. |
| `/devloop continue` | Let the agent keep going after the loop limit stopped it. |
| `/devloop learn` | See the rules devloop has proposed from repeated failures. |
| `/devloop library` | See the specs saved for reuse across your projects. |
| `/devloop hooks install` | Add a pre-push git hook that refuses a push that is not green. |
| `/devloop settings` | Change devloop's settings in a popup. |
| `/devloop doctor` | Check the setup. |
| `/devloop help` | Every command. |

Every action is also in the `/` menu as `/devloop-<action>`. When a person types
any `/devloop` command in a repository that is set up, it opens the Dev loop panel, including in VS Code's narrow
Claude panel. If a command fails, it shows the real error.

While a change is under way, a colored bar above the prompt shows the phase,
tests, review, the gate and the risk.

The agent may push a branch and open a pull request. Merging is yours.

## How it works

Every change goes the same way: guarded while the agent works, checked when
it stops, reviewed before it ships, merged by a person.

- **Small fix.** No spec. The guards and the stop check apply, and high-risk
  paths cannot be edited.
- **Spec, then build.** While a spec is written only the spec and its tests
  can change. Once you approve it they lock, and the agent builds one feature
  at a time against its check.
- **Review.** Before a push lands, the gate runs the full checks and scans
  the added lines for credentials. A separate read-only `reviewer` agent,
  which never saw the conversation, reads the change and ends with PASS or
  FAIL.
- **Ready.** You read it, merge it, and close it with `/devloop done`.

**One review per change.** The agent asks for a review once, when the whole
change is done (or a push finds none). If it fails, the fix gets one
re-check. Reviews never run at every stop. When it ends you get one summary:
the result, what was fixed, what needs you, and the tests.

**Slow tests in the background.** Mark a long suite `"background": true` in
`devloop.json`. It starts when the agent stops, runs with no time limit, and
its result counts only for the exact code it ran on. Nothing waits on it
except shipping.

**Risk tiers.** A change is as risky as its riskiest file. It is `high` if
it touches a file in `tiers.high`, a protected file or an instruction file,
`low` if every file is in `tiers.low` and no test changed, and `medium`
otherwise. A change larger than `blastRadius` moves up a tier. Medium and
high changes need the independent review to ship.

**Limits.** By default the agent gets 2 tries to fix a failing check
(`maxFixRounds`) and 2 review rounds (`maxReviewRounds`): one review and
one check of the fix. After 6 failed rounds on one branch
(`loop.failedRounds`) it stops until you run `/devloop continue`.

**Where the rules are enforced.** The same policy is enforced in more than
one place, so a missing piece does not fail open: the plugin's hooks module,
classic Claude Code hooks that run `dist/devloop.mjs`, and, if you want them,
a pre-push git hook and CI.

<p align="center">
  <img src="docs/images/spec-flow.svg" width="420" alt="The spec flow: you start a spec; the agent writes SPEC.md and one check per feature; the harness runs every check and flags one that already passes; you approve and the spec and tests lock; the agent builds one feature at a time and the harness runs that feature's check; when all pass the change goes through the normal loop.">
</p>

## A policy in a few lines

```json
{
  "mode": "enforce",
  "defaultBranch": "main",
  "verify": [
    "npm run -s typecheck",
    { "run": "npm test -s", "profile": "fast" },
    { "run": "npm run -s e2e", "profile": "full", "when": ["src/**", "e2e/**"] }
  ],
  "forbidden": [{ "pattern": "\\bpsql\\b.*prod", "why": "the production database is a person's" }],
  "network": { "allow": ["registry.npmjs.org", "github.com"] },
  "reviewers": [{ "name": "security", "when": ["**/auth/**"], "mode": "blocking" }]
}
```

`fast` checks run every time the agent stops. `full` checks run before
anything ships. `when` limits a check to the files it covers.

## Outside Claude Code

`dist/devloop.mjs` is the policy core as one dependency-free Node file. Run
it from the plugin's folder against any repository with a `devloop.json`:

```bash
node dist/devloop.mjs gate                   # everything between this change and shipping
node dist/devloop.mjs verify --profile fast  # just the checks
node dist/devloop.mjs doctor                 # policy errors and lints
node dist/devloop.mjs check-command 'git push --force'   # what the guards would say
```

Each takes `--json`. It exits 0 when green, 1 when not, and 2 on a usage or
policy error. [docs/examples/devloop-gate.yml](docs/examples/devloop-gate.yml)
runs the gate in GitHub Actions.

## Optional: cache-guard

A status line that shows what Claude's prompt cache is saving you, warnings
before moves that throw a warm cache away, and cost reports. Bundled, off by
default, needs Python 3.8 or later. Turn it on with `/devloop cache install`.
The `--all` choice (and `Yes, everything` in setup) also keeps the cache warm
while you are away: about one ping an hour, which uses a little quota. It
stops after 12 hours or when you are back, and your Mac must stay awake.

## What is in this repository

| Path | What |
| --- | --- |
| `hooks/` | The harness: guards, the stop check, the gate, review, the ledger. |
| `cli/`, `dist/devloop.mjs` | The command line, and its committed build. |
| `agents/` | The read-only `reviewer` and the `learner` that proposes rules. |
| `skills/spec/` | The skill that interviews you and writes a spec. |
| `output-styles/` | `Lean`, an optional short-reply output style. |
| `schemas/` | JSON schemas for the records devloop writes. |
| `cache-guard/` | The bundled cache-guard. |
| `docs/` | The reference, the design and the known limits. |
| `tests/` | Unit, integration and smoke tests. |

## Developing devloop

From the repository root, with `bash`, `git`, `node` and `bun` installed:

```bash
tsc -p . --noUnusedLocals --noUnusedParameters
claude plugin validate .
claude plugin test .
bash tests/smoke.sh
```

After changing `hooks/` or `cli/`, rebuild with `bash scripts/build.sh` and
commit `dist/devloop.mjs`. The smoke test fails if the committed build
differs from its sources.

**Releasing.** Bump `version` in `.claude-plugin/plugin.json` and
`HARNESS_VERSION` in `hooks/records.ts` together for every release, then
rebuild. Claude Code updates an installed plugin only when that version
changes: with the same number, `claude plugin update devloop@devloop` says
it is already at the latest version and keeps the old code.

## Learn more

- [The full reference](docs/REFERENCE.md): every command, policy field and
  guard, and how each works.
- [The design](docs/DESIGN.md): why it works the way it does.
- [What it cannot do](docs/RESIDUAL-RISK.md): the known limits, written down.

## License

Apache-2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE).
