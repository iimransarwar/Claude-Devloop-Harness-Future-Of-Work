# devloop reference

devloop is a Claude Code plugin that puts rails around an agent working in
your repository. Claude Code still runs the agent; devloop adds what that
loop lacks:

- a definition of done the agent cannot edit: your verify commands run when
  the agent stops, and a failure is handed back to it;
- tripwires on what the agent may read, write and run: secrets, protected
  files, locked tests, production actions, unlisted network hosts;
- a spec a person approves before a risky change is built;
- an independent reviewer in a fresh context;
- risk tiers that decide who may merge;
- a ledger of failures, so repeated mistakes can become rules: a proposer
  agent reads the repeats by itself, a proposed content rule goes on trial
  (it records where it would have fired and refuses nothing), and only a
  person promotes it.

A repository opts in by having a `devloop.json` at its root, in the working
tree or on the base branch: deleting the working copy does not switch devloop
off while the base branch has one (the base's stays in force, and the gate
says the file was deleted). Without either, devloop only refuses reads and
writes of secret files and offers `/devloop init`.

## Install

```
/plugin marketplace add iimransarwar/Claude-Devloop-Harness-Future-Of-Work
/plugin install devloop@devloop
```

Restart Claude Code so the hooks load. The README covers installing from
the terminal, at project scope for a team, from a local clone, and
updating.

Then, in the repository you want to work on:

```
/devloop init
/devloop doctor
```

`init` writes `devloop.json` (in observe mode, with the default branch it
finds), `REVIEW.md`, `evals/README.md` and, if there is no
`CLAUDE.md`, an `AGENTS.md`. It never overwrites a file that exists. It is
a person's command, from the prompt; where a `devloop.json` already governs
the session (at its root or any folder above), it writes nothing and says
where that policy is. It looks at `package.json`, `pyproject.toml`,
`go.mod` and `Cargo.toml` to suggest verify commands.

Three things to know before the first change:

- Read the `verify` list `init` wrote. Where it found no test command the
  list is empty, and nothing is checked until you add one.
- The policy is read from the default branch: commit `devloop.json` there.
- In `observe` mode the harness records what it would refuse and refuses
  nothing (reading a secret file is refused in either mode). Set `"mode":
  "enforce"` when you want it to block.

The classic hooks and the command line need Node 18 or later on the `PATH`.

### Where the policy is enforced

The same policy is enforced in three places (DESIGN 4.11), so a harness whose
main engine feature is missing does not fail open:

- **The hooks module** (`hooks/register.tsx`): the full harness, with its
  state, the person's dialogs and the pane. It is an early-access engine
  feature behind a rollout switch, and a module hook can be skipped.
- **Classic hooks** (`PreToolUse`, `UserPromptSubmit` and `Stop` command hooks, declared beside the
  module in `hooks/hooks.json`), each running `node dist/devloop.mjs hook
  <event>`. They run after the module; the module stamps every call and stop
  it judged, and a stamp makes the classic hook stand down at once, so nothing
  is refused or verified twice. Where the module is live in the session but
  did not judge a call (its heartbeat, no stamp), the classic hook applies the
  stateless core, refuses anything that ships ("the harness could not judge
  this call; run it again") and records `module-skipped` for you to see (a
  toast and `/devloop audit`). Where the module is not loaded at all, the
  classic hooks are the enforcement, and say so once per session. A classic
  hook that cannot read its input (late, large, truncated or empty), or that
  fails for any reason, refuses the call; on a stop it never blocks, but
  tells you verification did not run. On a ship its checks get a time budget;
  past it the ship is refused, naming which checks finished and which did
  not. The hook keeps no passes: every run proves its checks afresh, so a
  retry runs them all again. Where the checks are too slow for its budget,
  push from a session with the hooks module loaded, let the command-line
  gate judge the push in CI, or push yourself. Without
  `node` on the PATH there is no fallback at all: `/devloop doctor` says so.
- **The command line** (`node dist/devloop.mjs <command>`), with no agent at
  all: for CI, the opt-in pre-push hook, and debugging a refusal.

**What holds when the module is not loaded** (the stateless core): secrets
anywhere, the policy's and the built-in protected paths, the harness's own
state, production, forbidden, destructive and egress commands,
`--no-verify` and forced pushes, ship-alone, merges (a person's), a ship from
another directory or repository, the evidence notes, content rules that refuse,
test weakening on edits, and the fast checks at each stop with the same fix
round budget. Shipping goes through the stateless gate below. **What does
not**: spec approval, feature status, the review loop, exemptions, the
reviewer's and eval agents' limits, the budget, two calls in flight and the
check after a ship. Anything that would need them fails safe: high-risk paths
cannot be edited, and a medium or high-risk change cannot ship without review
evidence (a git note naming its tree). In a repository with no `devloop.json`
on either side the classic hook holds the secrets rule alone, with the default
globs, as the dormant module does (D2), and records nothing. Where the `.tasks`
integration is on, its rules are part of the stateless core too, and the
classic stop gate runs the convention's session check.

## The loop

Every change goes the same way: guarded while the agent works, checked when
it stops, reviewed before it ships, merged by a person.

<p align="center">
  <img src="images/change-loop.svg" width="420" alt="One change, top to bottom: you ask; the agent edits inside the harness guard; when it stops the harness runs the checks that cover the changed files and hands a failure back (two tries); the agent tries to push its branch; before the push lands, the gate runs the full checks and scans the diff for credentials, and a separate read-only reviewer reads a code change and hands findings back (three rounds); then the push goes through and you merge. Six failed rounds on one branch stop the agent.">
</p>

Yellow is a person, blue the building agent, green the harness, purple the
separate reviewer. The gate and the review sit between the agent's push
command and the push landing: a push is refused until both are met. The red
paths are work handed back to the agent; each has
its own cap (`maxFixRounds`, `maxReviewRounds`), and `loop.failedRounds`
failed rounds on one branch stop the agent until a person runs
`/devloop continue`.

The phases of a change:

```
small-fix --/devloop spec--> spec --/devloop approve (person)--> build --> review --> ready
    ^                          | only spec + tests editable        | tests + spec locked    |
    +--------------------------+--------------- /devloop done (person) <-----------------+
```

- **Small fix** (no spec): the guards and the stop gate apply. High-risk
  paths cannot be edited.
- **Spec**: you and the agent write `specs/<name>/SPEC.md` and
  `specs/<name>/features.json`. Each feature has a `check` command that exits
  0 only when the feature works. Only the spec folder and test files may
  change. The tests are expected to fail here: the stop gate runs the fast
  checks and records the result, but does not block.

  `/devloop spec` tells the agent to follow the plugin's `devloop:spec`
  skill. The agent reads the earlier specs in `specs/` and the code first,
  then interviews you in one to three rounds by the kind and size of the
  work, asking only what the code cannot say. It writes the spec (kind and
  size, related specs, intent, context, constraints, out of scope, numbered
  yes-or-no criteria, risks), turns every criterion into a feature check,
  writes the tests and confirms each check fails for the right reason. A
  criterion only a person can judge is marked `(checked by a person)`; an
  unanswered one stays a `[NEEDS CLARIFICATION]` marker. You can also start
  it in plain words ("let's spec this out"): it asks you to run
  `/devloop spec <name>` first.
- **Approve**: you confirm in a dialog. Approval is refused while the spec is
  unfinished: the template's placeholder, duplicate feature ids, a feature
  without a `check`, a dependency on no feature, or a `[NEEDS CLARIFICATION]`
  marker left in SPEC.md. Before the dialog the harness runs every feature
  check (red before green): checks that already pass are *vacuous*. The
  dialog lists them, the check-integrity lint of the feature checks (`|| true`
  and the rest), and the numbered acceptance criteria no feature covers.
  Approving with any of these is allowed and recorded on the change. The spec
  and the existing tests are then locked, and the content hash of every test
  file is kept.
- **Build**: the agent implements one feature at a time. A feature is marked
  passing only through the `feature_check` tool, which runs the feature's own
  check, and only once the features it `dependsOn` pass on the tree as it
  stands. The record lives in the plugin's state, and the status tool, the
  pane and the gate read it there; features.json is never written by the
  harness. A pass covers the tree it ran on: before a review starts, and
  before anything ships, stale passes are run again. A new test file may be
  added; approved ones stay locked.
- **Review**: on medium and high-risk changes, a reviewer agent with a fresh
  context and read-only access (and any specialist reviewers whose files
  changed) reads the diff and answers in a fixed finding format.
- **Done**: you close the change with `/devloop done`. You are asked what you
  read of it (your attestation), a change record is written, and a spec's
  feature checks are kept as regression checks, which run with the full
  checks whenever a later change ships (gate row "Regression checks"; a
  failure names the earlier change and counts as an escaped defect). The
  saved check logs and review diffs are cleared.

<p align="center">
  <img src="images/spec-flow.svg" width="420" alt="The spec flow: you start a spec; the agent writes SPEC.md and one check per feature, and only the spec and tests can change; the harness runs every check and flags one that already passes; you approve and the spec and tests lock; the agent builds one feature at a time and the harness runs that feature's check and records the pass, repeating for the next feature; when all pass the change goes through the loop above.">
</p>

The pane (opened in interactive sessions) has five tabs: Gate, Features,
Findings, Activity (recent events and the audit trail) and Metrics.

A feature in `features.json`:

```json
{ "id": "rejects-bad-password", "description": "a wrong password is refused",
  "check": "npm test -- bad-password", "criteria": [1], "dependsOn": [] }
```

`criteria` names the numbered acceptance criteria of SPEC.md the feature
covers (without it, `criterion 3` or `AC3` in the description counts).
`passes`, if you write one, is ignored: feature status is the harness's own
record, shown by `/devloop status`, the status tool and the pane. The spec's
fingerprint covers SPEC.md and each feature's id, description, check,
dependsOn and criteria: a change after approval freezes `feature_check` until
a person approves again.

Every feature check is judged by the same rules as a shell command before it
is ever run: a check that would be refused (it reads a secret, deletes
something, ships) is not run. `/devloop approve` refuses while any check is
refused and names each with its rule; `feature_check` answers `NOT RUN`. The
approval dialog shows each check's command. What you approve is the text the
checks ran on: if the spec, its features or a test file changes while the
dialog is open, the approval is refused and you run it again.

### Verification

Each verify check has a profile:

- `fast` checks run every time the agent stops after changing the working
  tree. If one fails, the stop is blocked and the agent gets the failure: the
  first lines that look like errors and the tail of the output (runtime-internal
  stack frames dropped), and the path of the full output, which the harness
  keeps outside the working tree. After `maxFixRounds` blocked stops in one
  prompt, or a stop with nothing changed since the last blocked one, the turn
  ends and you are told.
- `full` checks run as well before anything ships (`git push`,
  `gh pr create`, `gh pr ready`, `gh pr merge`, `git merge` on the default
  branch) and on `/devloop verify`. A pass is recorded per check with the tree
  it ran on: shipping runs every check of the base branch's policy that has
  not passed on the tree as it stands, and no other.

A check with `when` runs only if a changed file matches one of its globs.
With `testing.scope: "targeted"` (the default) such a check keeps its pass
against the content of the files its globs match: editing a file outside them
does not run it again. A check without `when` covers the whole tree and runs
again whenever the tree changes. After a failure, the check that failed runs
first, and the run ends there if it fails again. With `"full"`, every pass is
tied to the whole tree and the checks run in the order written. Either way
nothing ships with an applicable check unrun.

A check that could not run at all is not a failure of the work: its program
was not found (exit 127 or 126), it timed out, or it was killed. This is
decided by the exit code alone: output that says "not found" with another
exit code is a failure. The stop is not blocked, no fix round is spent, you are told which
and what to do, the ledger records it as `check-infra`, and the gate row
reads "could not run".

"Verified" is tied to the content of the working tree (a git tree hash that is
the same before and after a commit), so a pass goes stale as soon as a file
changes (for a check with `when` under targeted testing: as soon as a file it
covers changes).

Each failure gets a fingerprint: the command plus its output with line
numbers, timings, hex values and colour codes removed. If the same
fingerprint fails twice in a row, the agent is told its last fix did not
change the failure and to try another approach or stop.

If a check that passed before fails, and nothing it watches has changed since
(the same content, or no changed file matches its `when`), it is run once
more. A pass on the rerun does not block; it is recorded as
`flaky:<command>` in the ledger.

### Guards

Every `Read`, `Edit`, `Write`, `NotebookEdit`, `Grep`, `Glob`, `Bash`
(background too) and `Monitor` call is judged. For a file path, in order:

1. a secret file is refused, in every mode, for reads too, wherever it is
   (`~` expanded, links followed, case folded);
2. a path you exempted with `/devloop allow` is allowed for one turn (the
   turn running when you granted it, or else the next one);
3. the active spec folder is open while the spec is written, locked after;
4. a `protected` path is refused, and so are paths no policy can open:
   `devloop.json`, the agent's settings, `.mcp.json`, hook and plugin
   folders, `.git/hooks`, `.git/config` and shell start-up files;
5. test files are locked while building against an approved spec;
6. while writing a spec, only the spec and tests may change;
7. a high-tier path is refused outside an approved build.

Shell commands are judged by their text, one simple command at a time: a line
is split on `;`, `&&`, `||`, `|`, newlines and subshells, quotes, comments and
heredocs are understood, `bash -c` scripts and substitutions are looked into,
wrappers like `sudo`, `env` and `timeout` are peeled, and git's global options
are skipped (gh's `-R`/`--repo` too); `$(( … ))` and `(( … ))` are
arithmetic. Refused: naming a secret file; writing a path the rules above
lock (a redirect to `2>&1` or `/dev/null` is no write; `find` with a `-name`
or `-path` filter writes what the filter selects; a writer fed by
`git ls-files`, `rg -l`, `find`, `ls` or `fd` through `xargs` writes the
lister's folder while a spec is written or built; `git checkout <word>` is a
file only after `--` or when git tracks it); `--no-verify`; forced
pushes; commands that discard work (`git reset --hard`, `git clean -f`,
`git checkout -- .`, `git stash drop`, deleting a branch, `rm -rf` of the
repository or outside it, except beneath `/tmp`, `/var/tmp` and `$TMPDIR`
when that is not the harness's own state, and a download run as code:
`curl ... | sh`, `bash <(curl ...)`, a download piped into an interpreter
that reads its program from it), each with a safer command named;
production actions (`kubectl apply|delete`, `terraform apply|destroy`,
`npm publish`, `docker push`, `gh release create`,
`aws|gcloud|az ... deploy|delete`); commands matching a `forbidden` pattern;
a configured check piped through `head`, `tail` or `grep`; and, when
`network.allow` is set, any host not on the list. A command the tripwire
cannot follow (a computed name, `eval`, inline `python -c`) is treated as
possibly writing any locked path it names, unless it is plainly a test run
(`$PYTHON -m pytest`). Shipping commands go through the gate; the branch is
followed through a line, so `git checkout main && git merge feature` is a
merge into the default branch. A line that ships must ship alone (rule
`ship-alone`, no exemption lifts it): a push or pull request beside anything
but `cd` and plain reads (`git add -A && git commit -m x && git push`) is
refused, because the gate judges the tree before the line runs. A merge counts
as shipping only on the default branch (or when the branch cannot be told);
anywhere else it is a write, so `git merge wip && git push` is refused while
`git fetch origin && git merge origin/main` on a feature branch is not. Beside
a push, git counts as a read only in its reading forms (`git remote -v`, not
`git remote add`; no `grep -O`). A push and a write sent as separate tool
calls in one message are refused the same way: run the push by itself, after
the other commands have finished.

**How the agent pushes.** A push has one shape: `git push -u origin HEAD`
(or `git push [options] <remote> <branch>` / `HEAD:refs/heads/<branch>`,
one refspec, the branch checked out, no `+`; a destination after a colon is
spelled in full, since git places an unqualified one by what the remote
already has). Options come from a short list spelled in
full (`-u`, `--set-upstream`, `-n`, `--dry-run`, `-v`, `-q`, `--progress`,
`--porcelain`, `--atomic`, `--no-follow-tags`, `--force-with-lease`,
`--no-verify`, the last two judged by their own rules). Anything else is
refused with the command to run instead: a bare `git push` or `git push
origin`, `git push origin :`, `--all` or any abbreviation of it, more than
one refspec, a refspec known only when the line runs, `git -c …`,
`--config-env`, `--git-dir`, `--work-tree`, `--namespace`, `git -C <dir>
push`, and a `GIT_*` variable set anywhere on the line. Pushing tags or
other branches is yours. Git's options are read as git reads them, by any
abbreviation (`--forc` is `--force`, `--skip-w` is `--skip-worktree`), and a
quoted option is still an option.

**Paths by any spelling.** A path is placed through variables the same line
sets to a literal (`f=.env; cat "$f"`) and through `$HOME`, `$PWD`,
`$TMPDIR` and the plugin's and project's folders; through a link the line
makes (`ln -s .env e && cat e`); and through what a wildcard matches on disk
(`cat .en?`, `{a,b}`, `[…]`), each match judged. A folder a protected or
secret pattern names (`~/.claude/cache-guard`, `~/.claude/hooks`,
`.git/hooks`) cannot be written into, replaced, moved, linked over or
removed, nor can a folder above it (so `rm -rf ~` is refused as a secret's
removal), and a recursive read of a folder holding a secret folder
(`grep -r x ~/.claude`) is a read of the secret. The agent does not run
cache-guard's script (`cache_guard.py`, by any path or interpreter, rule
`cache-guard`): you run it through `/devloop cache`. Its tests and reading
it are fine. A push from outside the repository, one
through a `-c alias.*=` alias or another git directory, and a push of a branch
other than the one checked out are refused. After any shipping command, error
or not, the gate is judged again, and work it had not passed is reported to
you loudly (detection, not prevention). What the tripwire knowingly lets through is listed in
[docs/RESIDUAL-RISK.md](RESIDUAL-RISK.md).

**Content rules** (`rules` in devloop.json) are checked against the lines an
`Edit` or `Write` adds to a file their globs match, with the base branch's
policy: `note` records a hit, `refuse` refuses the edit, `ratchet` refuses an
edit that raises the file's count of matches (the repository's count is kept
as a baseline in the plugin's state and only ever falls; a match marked
`devloop-allow: <rule id> <reason>` on its line, or on a line of its own above
it, is not counted). Each rule's hits and last firing are kept for
`/devloop prune`.

**Test weakening** is judged wherever tests are editable (small-fix mode, the
spec phase, a test file created while building). An edit that adds skip,
only, todo or xfail markers (Jest, Vitest, Mocha, pytest, unittest, Go,
Rust, JUnit) is refused, and so is deleting a test file or renaming it so it
no longer runs as one, by the edit tool or by a shell command the tripwire
understands (`rm`, `git rm`, `mv`, `unlink`). A new test file is judged
against nothing, so a focused or skipped test in it, or a Go `TestMain` that
never runs the tests, is refused. A marker counts only at the start of a
call (`model.fit(X, y)` is not a focused test). For deletion, a test is a
file git tracks: caches and logs under a test folder may be removed. An edit that leaves fewer
assertions is allowed and adds a gate note "Assertions removed in <file>". A
person's `/devloop allow <path>` lifts it for one turn.

Every refusal ends with who can lift it: always held (no one), a person (an
exemption, an approval, or doing it themselves), or a change to
`devloop.json`. `/devloop doctor` lists every rule with its class.

Edits to instruction files (`instructions`) are allowed, but they make the
change high risk and add a gate row a person must read, because text in
those files is read by every later session.

In `observe` mode the guards record what they would refuse and refuse
nothing, except secrets, the harness's own records, the reviewer's read-only
limit, the cost cap and an eval task's worktree: those hold in every mode,
whatever else matched. If a guard itself fails to run, the call is refused in
`enforce` mode and allowed otherwise, except that a secret is always refused.

The policy in force is the base branch's `devloop.json`, whole, whenever the
base has one: the mode, the protected paths, the tests and secrets globs, the
tiers, the instruction globs, the verify checks and their environment, the
review settings, the content rules and the eval settings alike. A change
cannot loosen any of them for itself; its own copy takes effect once it is
merged. With no copy on the base, the working tree's is used and the gate
says so. Eval agents are
exempt from the path rules inside their own worktree and from nothing else.

When the agent is refused twice in a row under the same rule (with no allowed
call between), you get a notice and the agent is told to stop and report. The agent can also call the
`devloop_blocked` tool with a reason: you are told, and the stop gate lets it
end the turn.

### Review

A round starts the general reviewer and every specialist reviewer whose
`when` globs match a changed file, each in a fresh context, each read-only.
The prompt has three fixed parts, stable first: the task and base (the brief,
REVIEW.md as the **base branch** has it, the spec, the base commit), the
current facts (the diff file, tier, changed files, checks, round, open
findings to re-check), and the contract. A change cannot rewrite its own review: the
working tree's REVIEW.md is ignored.

Findings are one line each:

```
F<n> | <critical|high|medium|low|nit> | <file>:<line> | <the line, quoted> | <problem> | <evidence that would close it> [| pre_existing] [| outside] [| fix|decision|defer]
```

ending with `VERDICT: PASS|FAIL`. The harness decides the round, not the
verdict line:

- each quote is checked at or near its line in the reviewed tree (a `|` in
  the quote or the problem, a leading `+`/`-`, backticks, `file:line:col`
  are all read); a finding whose quote is not there is kept as a note when
  its severity does not block, and goes to you as a decision when it does;
- what blocks scales with the tier: low, critical only; medium, critical and
  high; high, all but nits. `pre_existing` and `defer` never block. At most
  12 findings per reviewer per round count, the most severe kept, checked
  first and `pre_existing` last;
- a round passes when nothing blocking is open: a FAIL with nothing blocking
  is a pass with notes, a PASS with a verified blocking finding is a fail;
- a round passes only on what the harness can read: an answer with no
  verdict, a finding line that does not fit the format, a FAIL with no
  finding in the format, or a blocking finding quoted wrongly is restated
  once by a second agent given that answer (not a round); if it still cannot
  be read, a finding goes to you and blocks until you resolve it (a new round
  does not clear it);
- the general and blocking reviewers decide when a round settles; a shadow
  reviewer's answer is counted when it arrives, and its silence changes
  nothing. Open findings of a specialist that no longer applies go to the
  general reviewer to re-check;
- each later round reads the fix, not the whole change again: it is given
  the open findings and the diff since the previous round, confirms each
  finding closed or still open, and reviews only the lines changed since. A
  problem it sees elsewhere is marked `| outside` and kept as a follow-up for
  you without failing the round, unless it is high or critical, in which case
  it fails the round and says it was missed earlier. The round opens with
  what happened: addressed, reappeared, still open, new. Only `fix` findings go to the
  builder; `decision` findings go to you and block until you run
  `/devloop findings resolve <id> <note>`;
- `defer` and non-blocking findings go to a backlog kept across changes,
  keyed by file and quote, and closed when the quoted line is gone;
- two rounds in a row that close nothing end the loop before the cap: you are
  told, and the builder is told to stop.

A `shadow` specialist never blocks: `/devloop metrics` counters record how
often it would have blocked and how often it agreed with the general
reviewer. A `security` specialist with no `prompt` uses a built-in brief.

When a shipping command is refused only because the review has not run and
`autoReview` is on, the gate starts the round itself and the refusal says to
retry after the verdict.

### Grounding: check before you answer

When you ask a question about the state of things ("does this update
include every change needed for the queues, list views and alerts?"), the
agent is to look at the source in that turn before it answers, and say what
it checked: an agent's memory of its own work is a lead, not a fact. Three
layers do this:

- the rules text the agent sees at session start says so;
- a prompt that is a question of fact (a question mark, an opening "does",
  "is", "what", "how" and the like, or "confirm", "verify", "make sure", "did
  you", …) gets one line of context: check the source, say what you checked;
- if such a turn ends with no look at any source (no read, search, query,
  check, fetch, edit or other tool that looks), the stop is refused once in
  `enforce` mode and the agent is told to check and answer again; in
  `observe` mode, or if a second stop still holds no look, you get a toast,
  "This answer was given without checking anything", quoting the guess
  ("I believe", "probably", "from memory", …) when the answer holds one.

A turn that changed files is the ordinary stop gate's. Nothing fires on a
turn you did not start (a keep-warm ping, a notification), on a subagent's
stop or while a review runs, and never twice in a turn. Each unchecked
answer is listed in the pane's Activity tab with your prompt's first line,
in `/devloop audit` (`answer-unchecked`), and counted in `/devloop metrics`
(questions of fact asked, answers given without a look, all time and this
session); `/devloop doctor` says which mode is in force. Without the hooks
module, the classic hooks do the same from the session's transcript; if the
transcript cannot be read, this one check is skipped. The harness does not
judge whether the look was the right one, nor see a question the agent asks
itself mid-work (A25 to A27 in [docs/RESIDUAL-RISK.md](RESIDUAL-RISK.md)).

### Risk and the gate

The tier of a change is its riskiest file: `high` if any file matches
`tiers.high`, `protected` or `instructions`; `low` if every file matches
`tiers.low` and no test changed; `medium` otherwise. A change past
`blastRadius` (more files or lines than it allows, or a dependency manifest
touched) is one tier riskier, and the gate says why. The gate lists what
stands between the change and shipping:

- **Verification**: met only when every fast and full check of the policy in
  force has a pass on the tree as it stands; the note names those still to
  run.
- **Spec** and **Features**, while a spec is written and built.
- **Tests unchanged since approval** (building): test files whose content
  differs from what was approved are listed, and keep the row unmet unless a
  person's exemption lifted a rule for that edit; new test files are named.
  With no record of the tests at approval the row is unmet.
- **Independent review**, and **Review: <name>** for each blocking
  specialist, on medium and high tiers; at any tier while a blocking finding
  is open, whoever raised it.
- **No credentials in the diff**: the lines the change adds are scanned for
  AWS key ids, GitHub and Slack tokens, private-key headers on a line of
  their own, and high-entropy `api_key = "…"`, `API_KEY=…` or `api_key: …`
  assignments whose key ends in a credential word; a hit names the file and
  line, never the value. Outside git it reads "not scanned" and is unmet on
  medium and high tiers.
- **Files hidden from git**: an index entry with the skip-worktree or
  assume-unchanged bit whose file on disk differs from it (by content hash,
  or its executable bit) keeps the gate shut and refuses a push, naming the
  file. A sparse checkout is fine: files it leaves out are not on disk, and
  a file identical to the index hides nothing. The agent may not set the
  bits (rule `git-hidden`).
- Notes a person reads: tests changed, assertions removed, vacuous checks at
  approval, instruction files changed, blast radius, policy changed, check
  integrity.

A review note written by an older version of the harness (`evidence@1`)
counts as no review; the review row says so and asks for the review to be
run again.

Who must approve the merge comes from `approvals` (by default: low none,
medium one person other than the author, high two); no state of the loop
meets it. The agent may push a branch and open a pull request, but never
merges a pull request, never merges into the default branch, and pushes to
the default branch only what needs no approval.

`/devloop gate` proves the gate on demand as shipping does (running the
checks that have no pass on this tree) and answers with exit code 0 when
every row the harness can meet is met, 1 otherwise, so CI can run
`claude -p "/devloop gate"`.

The gate, like every other decision, reads `devloop.json` as the base branch
has it, so a change cannot loosen its own policy; when the working copy
differs, the gate says so. With
no base branch found (a `defaultBranch` that names no branch), a policy error,
or a verify command that can pass without earning it (`|| true`, a pipe
without `pipefail`), the gate says so too; the first two keep it shut.

The agent can read the gate with the `devloop_status` tool, which changes
nothing.

### Context and cache

devloop is written to be cheap for the model's context window and prompt
cache. Its system-prompt section is one fixed text, the same bytes in every
repository, phase and mode, so it never breaks the cache; every tool it has
is registered at load with fixed descriptions (behind ToolSearch, so a
repository that has not opted in pays nothing for them). What varies reaches
the model beside your prompts, as a delta: each source (the status, the gate
rows not met, ready and failing features, findings to fix, policy errors, the
verify commands and other policy facts, the cold-start briefing,
context-pressure notes) is sent when it first appears, again only when it
changes (as a short diff when that is shorter), once when it clears, and all
again after a compaction. The total is kept under `context.budgetTokens`;
past it, the rest waits and the agent is told to call `devloop_status`.

<p align="center">
  <img src="images/context-and-cache.svg" width="420" alt="What the model reads on one turn, top to bottom. Cached and read back at the low rate: devloop's rules (one fixed text), devloop's tools (described once) and the conversation so far. New this turn and paid in full: your prompt and a short devloop note holding only what changed, capped at 600 tokens by default.">
</p>

The harness's own text sits in the cached part and never changes during a
session; what changes goes in the short note at the end.

- **Cold start.** The first prompt of a session (or after `/clear`) with a
  change open carries a short briefing: the end of the last handoff, the
  phase, ready and failing features, the last failure, findings awaiting
  you, open questions. A briefing that does not fit the budget comes with a
  later prompt; one larger than the whole budget is sent cut, pointing at
  `devloop_status`.
- **Context pressure.** Past the warn level the agent is told to finish the
  step and not start a new feature; past the save level you get a toast and
  the agent is told to call `devloop_handoff` now. Each is said once per level
  per `context.debounceCalls` tool calls, at once on escalation.
- **Handoff.** The `devloop_handoff` tool records a structured entry: the
  agent writes the objective, decisions, work state, dead ends, assumptions
  with the command that would verify each, the next step and up to 15 files;
  the harness adds the facts itself (phase, features, open findings, last
  failure, changed files, recent commits, tree hash, time). `/devloop
  handoff` writes a facts-only entry. Entries are kept in the harness's own
  state for the repository (the last 50), never in the working tree, so
  writing one never stales a verified tree and nothing has to be left out of
  the tree's hash. `/devloop handoff show [n]` prints the last n; `/devloop
  handoff export <path>` writes them into the repository as an ordinary
  change, refused for a secret, a protected file or a locked test.
- **Idle gap.** A prompt sent after the cache has lapsed, on a large context,
  gets you a toast saying roughly how many tokens it re-writes; nothing goes
  to the model.
- **Cache meter.** Each turn's cache-read and cache-write tokens are kept per
  session and per change; a turn that re-writes more than `cache.missTokens`
  is a miss, with its cause inferred (idle gap, model change, compaction, a
  change on devloop's side, which would be a bug, or unknown). Shown by
  `/devloop metrics` and `devloop_status` with `detail`, never put into
  context.
- **Context cost.** Which tools and files put the most into the session, an
  estimate from result sizes, in the same two places.
- **Open questions.** The agent records a question only you can settle with
  `devloop_question` (at most three per turn); it never blocks. You list and
  close them with `/devloop questions`.

### Instruction files and checks

`/devloop doctor` audits the instruction files (`instructions` globs): the
bytes of launch-loaded instruction text against `instructionMaxBytes`, lines
per file, ALL-CAPS emphasis, paths and commands (package scripts, make
targets) named that do not exist, blocks repeated between files, and lines
that only restate a formatter's rule; each `SKILL.md` pass or fail per check
(a description that says when to use it, under 500 lines, numbered steps with
commands and what to check, an error-recovery table, no `.mcp.json`); an
injection scan (invisible and tag characters, bidirectional overrides,
decode-and-run, reading or sending secrets, `curl … | sh`, editing hooks,
settings or the policy); instruction files git does not track (they are
hashed into the verified tree all the same); and the tools in context with an
estimate of their definition tokens; it ends with the residual-risk
register's headings, one line each. `/devloop doctor --strict` exits non-zero
when anything is at error level, for CI. Only these are errors: a policy
error, hidden characters (a zero-width space, tag characters, a bidirectional
override, or a joiner that is not inside an emoji sequence or between letters
of a script that needs it), the instruction byte budget, and a skill's hard
limits (a description of at most 400 characters, under 500 lines, no
`.mcp.json`). Everything else the audit finds is heuristic and a warning: a
make target is read only from code and only where a Makefile exists, a path
only when it looks like a repository path (not a MIME type, a git ref or an
example name), and a script in the folder a preceding `cd` names. Hidden
characters in a changed instruction file keep the gate's "Instruction files
changed" row unmet. The sweep for instruction files git ignores skips
`node_modules`, `vendor`, `.venv`, `dist`, `build`, `target` and the folders
in `instructionsIgnore`, takes the shallowest 500 and says so when there are
more.

Verify commands and feature checks run with the session's whole environment
by default (`checkEnv.mode: "observe"`): doctor lists the credential-shaped
variables they could see, and the gate note "Check environment" says how many
in one line. In
`"enforce"` they run with only `PATH`, `HOME`, `USER`, `LOGNAME`, `SHELL`,
`TERM`, `LANG`, `LC_ALL`, `LC_CTYPE`, `TZ`, `TMPDIR`, `CI` and the names in
`checkEnv.pass`: the environment is built from nothing (`env -i`), so a
variable whose name is not a shell identifier and an exported function never
reach the check, and the shell reads no profile or rc file.

### Tools the agent can call

| Tool | What it does |
| --- | --- |
| `feature_check` | Runs one feature's own check and records the result; the only way a feature passes. |
| `devloop_status` | Reads the gate, changing nothing, with each open finding to fix as its full line (deferred findings and notes counted, not listed); `detail: true` adds the cache meter and the context cost. |
| `devloop_blocked` | Says it cannot go on and why; you are told and the turn may end. |
| `devloop_handoff` | Records a structured handoff entry in the harness's state (never the working tree); the harness adds the facts, and the next session's first prompt is briefed from it. |
| `devloop_question` | Records an open question for a person; never blocks. |
| `devloop_papercut` | Files a friction report (`tried`, `expected`, `happened`, `suggestedFix`, `subject?`); never blocks, three per turn; grouped for `/devloop papercuts`. |
| `devloop_claim` | Claims one feature of the active spec for this session (`feature`), under a lease its activity renews. Only matters when more than one session works in the repository; the first `feature_check` on an unclaimed feature claims it too. |
| `devloop_release` | Gives up this session's claim on a feature (`feature`), so another session may take it. |
| `devloop_library` | Searches your [spec library](#the-spec-library) (`query`, `limit?`: 5 by default, at most 10), changing nothing: the entries holding the most of the query's words, each with its folder, project, name, kind, intent, outcome and acceptance criteria. |

All nine are registered when the plugin loads, with the same descriptions in
every session, and deferred behind tool search.

## Commands

| Command | What it does |
| --- | --- |
| `/devloop` or `/devloop status` | Where the change stands and what the gate still needs. |
| `/devloop init` | Set this repository up for the loop. A person's call; writes nothing where a policy already governs the session. |
| `/devloop spec <name>` | Start or reopen a spec; only the spec and its tests change until it is approved. |
| `/devloop approve` | Approve the spec as written and unlock the build. A person's call. |
| `/devloop verify` | Run the fast and full verify checks now. |
| `/devloop review` | Start an independent review round. |
| `/devloop gate` | Prove the gate now and answer with an exit code: 0 green, 1 not. |
| `/devloop findings` | Review findings: open, the deferred backlog, resolved; for a person also the notes and this change's deferred findings, with their text (what the agent is not shown). |
| `/devloop findings resolve <id> <note>` | Settle a finding that awaits a person's decision. A person's call. |
| `/devloop done` | Close the change and reset the loop. A person's call. |
| `/devloop continue [n]` | Allow n more failed rounds on this branch after the loop limit stopped the agent (default: the policy's `loop.failedRounds`). A person's call. |
| `/devloop allow <glob>` | Exempt paths from the guards for one turn: the one running, or else the next. A person's call. |
| `/devloop allow --command <command>` | Let one exact shell command past the guards (not secrets) for one turn: the one running, or else the next. A person's call. |
| `/devloop budget <usd>` | Set a cost cap for this session, measured against a client-side estimate. A person's call. |
| `/devloop doctor` | Audit the setup: config errors, verify checks, instruction files and skills, the injection scan, tools in context, sandbox, credentials, what checks can see. |
| `/devloop doctor --strict` | The same, exiting non-zero when an item is at error level (for CI). |
| `/devloop handoff` | Record a facts-only handoff entry (kept in the harness's state). A person's call. |
| `/devloop handoff show [n]` | Print the last n handoff entries (1 by default). A person's call. |
| `/devloop handoff export <path>` | Write every handoff entry into the repository at `<path>`, judged by the path rules (no secret, protected file or locked test); asks before it overwrites a file. A person's call. |
| `/devloop questions` | The agent's open questions for a person. |
| `/devloop questions close <id> <answer>` | Answer and close one; the agent is told. A person's call. |
| `/devloop learn` | The proposer's waiting proposals (each with its exact text and evidence) and the trial rules with their hits, shown to you only; then the failures seen more than once (refusals, check failures, findings by file, papercuts, lessons), with the cheapest durable fix for each and an eval task. Typed by you, it also starts a proposer run. |
| `/devloop lesson <text>` | Record something that went wrong that the harness cannot see. It records two lessons itself: when the loop limit stops the agent, and when the same check fails twice in a row the same way. |
| `/devloop rules` | Learned rules: trial rules (pattern, globs, why, hits, last hit), promoted rules, and waiting proposals. A person's. |
| `/devloop rules promote <id>` | A dialog with the trial rule's pattern, globs, why and each hit; on yes it refuses at once on this machine, and the command prints the entry to add to `rules` in devloop.json so it holds everywhere. Audited. A person's call. |
| `/devloop rules drop <id> <reason>` | Remove a trial or promoted rule or a waiting proposal, with a tombstone so it is not proposed again unless the failure returns. Audited. A person's call. |
| `/devloop papercuts` | The agent's friction reports, grouped by subject and symptom, most filed first; a group filed again after its close is a regression. |
| `/devloop papercuts close <group> <note>` | Record what fixed a group. A person's call. |
| `/devloop eval` | Run the valid tasks in `evals/tasks/` (validated first), `evalTrials` times each with a fresh agent in a throwaway worktree or clone, after a dialog with the projected cost; or resume an interrupted run. A person's call. |
| `/devloop eval quick` | The quick subset (tasks tagged `quick`, or `evalQuick` by hash); labelled, never the headline. A person's call. |
| `/devloop eval --without <rule \| file \| skill>` | Ablation: the baseline twice (the noise band), then with that rule off for the eval agents, or that file or skill out of their sandbox; the verdict is prune's evidence. A person's call. |
| `/devloop eval validate` | Check each task's witness: fails untouched, passes with `solution`, fails after a reset, fails with `nearMiss`. Asks first; a task whose commands the rules refuse is not run. A person's call. |
| `/devloop eval compare` | The last two full runs, on the tasks whose file did not change; regressions flagged. |
| `/devloop eval adopt [id]` | Eval-task suggestions from failures; scaffold one under `evals/candidates/`. A person's call. |
| `/devloop eval cancel` | Drop the run in progress. A person's call. |
| `/devloop prune` | Every rule with its hits and last firing, rules that never fired, ablation evidence, tasks outside the useful band. |
| `/devloop prune remove <rule id> <evidence>` | Record a removal as a tombstone: learn does not propose it again unless the failure returns. A person's call. |
| `/devloop regressions` | The regression checks kept from closed specs; they run at the ship gate. |
| `/devloop regressions drop <id> <reason>` | Retire one. A person's call. |
| `/devloop defect <text> [--change C<n>]` | Record an escaped defect against the last (or the named) closed change; its entry in the spec library counts it. A person's call. |
| `/devloop library` | The spec library: its folder, how many entries, the last ten. A person's. |
| `/devloop library path <dir>` | Keep the library in another folder (absolute, or under `~`; outside the repository), created if missing. For you on this machine, in every project. Audited. A person's call. |
| `/devloop library save` | Save the current approved spec to the library now, before its change closes (its outcome says open). Audited. A person's call. |
| `/devloop library remove <entry>` | Delete one entry's folder, and mark it removed in the index. Asks first. Audited. A person's call. |
| `/devloop metrics [--json]` | Escaped-defect rate, first-pass review rate, rounds, failure rates, refusals by rule, eval pass rate by model, cost per change (an estimate), cache hit rate; `--json` exports what is stored. |
| `/devloop report` | A change report for a pull request body: a reading aid for the approver and a disclosure block. Built from records. |
| `/devloop audit [n]` | The last n events of the audit trail (default 20); says how many older events are archived. |
| `/devloop sandbox` | Print the sandbox settings that match the policy: allowed hosts from `network.allow`, secrets as denied reads, protected paths and the harness's state as denied writes. Writes nothing. |
| `/devloop hooks install` | Install a pre-push git hook that runs `node <plugin>/dist/devloop.mjs gate` and refuses a push that is not green; a `pre-push` hook already there is kept and runs first. Audited. A person's call. |
| `/devloop hooks remove` | Remove it, and put back a hook it chained. Audited. A person's call. |
| `/devloop claims` | The claims sessions hold on the active spec's features: holder (branch and worktree), time left on the lease, or lapsed. |
| `/devloop claims release <feature>` | Release a claim, a live one included; asks first and says when its lease is still live. Audited. A person's call. |
| `/devloop followups` | The pull requests the harness watches for you, what it told the agent, and how each watch ended. |
| `/devloop followups stop [n]` | Stop watching one (by its number), or all. Audited. A person's call. |
| `/devloop checklists` | The checklists in force (from the base branch), lists that failed to load and why, and each item's numbers: shadow results, what a person adjudicated, recall on seeded defects, stability on one tree; items that never failed. |
| `/devloop checklists adjudicate <list>/<item> <correct\|wrong>` | Say whether the item's last result was right (its precision). Audited. A person's call. |
| `/devloop checklists promote <list>/<item>` | Make one item blocking: its fail on a tree is a gate row of its own. Asks first, with the item's numbers. Audited. A person's call. |
| `/devloop checklists demote <list>/<item>` | Back to shadow. Asks first. Audited. A person's call. |
| `/devloop cache install [flags]` | Install cache-guard for you (see below): its own installer changes your user settings, after a dialog listing what changes and each flag. Audited. A person's call. |
| `/devloop cache uninstall` | Take it out of your user settings again. Audited. A person's call. |
| `/devloop cache doctor`, `report [--all] [--days N] [session]`, `status` | cache-guard's setup scan, cost reports, and whether it is installed. Read-only; a person's, since they read your session history. |
| `/devloop help` | The list above. |

## The command line

`dist/devloop.mjs` is the policy core (the pure modules under `hooks/`) and a
thin Node entry (`cli/`), built into one JavaScript file with no dependencies
for Node 18 or later (`bash scripts/build.sh`; `tests/smoke.sh` fails when a
rebuild differs from the committed file by a byte). It is stateless: it proves
only what the repository and its git history prove, and never reads the
plugin's store.

| Command | What it does |
| --- | --- |
| `node dist/devloop.mjs gate [--pushing <commit>…]` | Finds the base as the plugin does, reads the base branch's policy whole, runs its fast and full checks for the change (scrubbed per `checkEnv`), and prints the plugin's gate rows: verification, tier and blast radius, tests changed, instruction files changed (with the hidden-character scan), the credential scan of added lines, policy changed, check integrity. A review row is met only from portable evidence: a git note that names this very tree (as a commit holds it), produced under the policy in force, naming the reviewer in a general or blocking mode with its own pass. `--pushing` (the pre-push hook) adds the row "What the push sends": each commit named must hold the tree the gate judged. |
| `node dist/devloop.mjs verify [--profile fast\|full]` | The base policy's checks for the change (full by default). |
| `node dist/devloop.mjs doctor [--strict]` | The stateless part of doctor: policy errors, the instruction and skill lints, the injection scan, and the sandbox settings against the policy. |
| `node dist/devloop.mjs sandbox` | The sandbox settings block, as `/devloop sandbox`, with a warning when `CLAUDE_PLUGIN_DATA` is not set (the state directory in it is then a fallback) and for each allowed domain broad enough to defeat the allow-list. |
| `node dist/devloop.mjs check-command '<text>' [--phase idle\|spec\|build]` | The verdict the guards would give a shell command: rule, reason, lift class. |
| `node dist/devloop.mjs check-path <path> [--write \| --content <text>] [--phase …]` | The same for reading, writing, or writing that content to a path. |
| `node dist/devloop.mjs version` | The harness version. |

Each takes `--json`. Exit codes: 0 ok (green, passing, allowed), 1 not ok (not
green, failing, refused), 2 a usage or policy error (an unknown command, no
`devloop.json` on either side, not a git repository).

**CI.** [docs/examples/devloop-gate.yml](examples/devloop-gate.yml) is a
GitHub Actions workflow that fetches the evidence notes and runs `node
dist/devloop.mjs gate` (not active in this repository). CI recomputes every
check; a note can only supply the review rows.

**Portable evidence.** When a review round settles and when a change is
closed, the harness writes an `evidence@2` record (tree, policy hash, checks
passed, each reviewer and its own verdict, the promoted checklist items that
failed on the reviewed tree, harness version, time) as a git note
on the reviewed commit under `refs/notes/devloop`, only when HEAD's tree is the
reviewed tree as a commit holds it (instruction files git ignores left out; the
full tree is recorded beside it). A note changes no tree. Push it yourself with `git push origin
refs/notes/devloop`; the agent may not write or push that ref (rule
`evidence-notes`, always held), with `git notes` (however the ref is named on
the line, an exported `GIT_NOTES_REF` included), `update-ref`, a fetch or pull
into the ref, or plumbing such as `fast-import`, `update-ref --stdin` and
`hash-object -w` in a line that names the ref (a stream read from a file, or a
variable an earlier command exported, is not seen: RESIDUAL-RISK R35).
**A note is not a signature**: anyone who can
push the ref can write one. It saves a second machine re-running the review; it
is not a security boundary.

**The pre-push hook** (`/devloop hooks install`) runs the same gate before git
pushes, told which commits the push sends, and refuses a push whose commits do
not hold the tree the gate judged. It is opt-in, a person's to install and
remove, chains a hook already there, passes a repository with no
`devloop.json`, is not installed where `core.hooksPath` points outside the
repository (one inside the tracked tree is named in the dialog), and can be
skipped with `git push --no-verify` by a person (never by the agent: rule
`no-verify`).

**What a push sends.** The gate judges the working tree; a push sends
commits. A push is refused, by the module, the classic hook and the pre-push
hook alike, unless what a commit of the working tree would hold equals HEAD's
tree: commit or stash first. Files git ignores never stop a push.


## devloop.json

Every field is optional. The file is parsed strictly: an unknown field or a
value of the wrong type is reported by name in `/devloop doctor`, in
`/devloop status` and in the pane, and that field takes its default (or the
stricter reading, where the default would switch a guard off). A file that
stops being valid JSON keeps the last version that parsed in force, and says
so; with none on record, every field takes its default (enforce mode). Any
error keeps the gate shut until it is fixed.

| Field | Default | Meaning |
| --- | --- | --- |
| `mode` | `"enforce"` (`init` writes `"observe"`) | `"observe"` records what the guards would refuse; `"enforce"` refuses it. |
| `defaultBranch` | `"main"` | The branch changes are measured against and merged into. |
| `verify` | `[]` | Checks, in order. Each is a command string (a `fast` check) or `{ "run": "<command>", "profile": "fast" \| "full", "when": ["<glob>", ...] }`. A single string is one check. |
| `verifyTimeoutSec` | `300` | Time limit for each check, up to 600. |
| `protected` | `devloop.json`, `REVIEW.md`, `CODEOWNERS`, `.github/CODEOWNERS`, `.claude/**`, `specs/**/features.json`, `evals/**` | Paths the agent never edits. |
| `tests` | `**/*.test.*`, `**/*.spec.*`, `**/*_test.*`, `**/test_*.py`, `test/**`, `tests/**`, `**/__tests__/**` | Test files: locked while building. |
| `secrets` | `.env`, `.env.*`, `*.pem`, `*.key`, `id_rsa*`, `id_ed25519*`, `.npmrc`, `.netrc`, `**/.aws/credentials`, `**/credentials*.json` | Files never read or written. |
| `secretsAllow` | `.env.example`, `.env.sample`, `.env.template` | Exceptions to `secrets`. |
| `instructions` | `AGENTS.md`, `CLAUDE.md`, `.claude/rules/**`, `.claude/skills/**` | Instruction files: editable, but an edit makes the change high risk. |
| `tiers.high` | `**/auth/**`, `**/payments/**`, `**/billing/**`, `**/migrations/**`, `.github/workflows/**`, `Dockerfile`, `**/*.tf` | High-risk paths: edited only against an approved spec. |
| `tiers.low` | `**/*.md`, `docs/**` | Low-risk paths: a change of only these needs no review. |
| `forbidden` | `[]` | `[{ "pattern": "<regular expression>", "why": "<reason>" }]`: commands refused, with the reason the agent is given. The production actions above are built in. |
| `network.allow` | not set (tripwire off) | Hosts shell commands may reach. Exact names; `*.example.com` allows subdomains. Loopback is always allowed. A malformed list allows no host. |
| `maxFixRounds` | `2` | Blocked stops per prompt before the turn ends and you are told. Up to 10. |
| `maxReviewRounds` | `3` | Review rounds before a person must read the change. Up to 10. |
| `autoReview` | `true` | Start a review by itself when every feature passes and verification is green, when a shipping command is refused only because no review has run, and, once a round has failed and its findings went to the agent, at the next stop that verifies the fix (in every phase, within the round cap). |
| `budgetUsd` | `null` | A cost cap per session, against a client-side estimate. |
| `instructionMaxLines` | `200` | `/devloop doctor` flags instruction files longer than this. |
| `instructionMaxBytes` | `32768` | Bytes of launch-loaded instruction text (instruction files outside a `skills` folder, plus each skill's description) before doctor reports it. |
| `instructionsIgnore` | `[]` | Folders (globs) the sweep for instruction files git ignores leaves out, beside `node_modules`, `vendor`, `.venv`, `dist`, `build` and `target`. |
| `handoffFile` | retired | Accepted and listed by doctor as unused: handoff entries live in the harness's state. |
| `cache` | `{ "missTokens": 20000, "ttlMinutes": 5 }` | A turn writing more than `missTokens` to the prompt cache is a miss; `ttlMinutes` is the cache's lifetime, for the idle-gap cause and warning. |
| `context` | `{ "budgetTokens": 600, "warnRemaining": null, "saveRemaining": null, "debounceCalls": 25, "idleWarnTokens": 50000 }` | Injected context per prompt (an estimate: characters / 4); the two pressure levels in tokens remaining (null: warn when 30% of the window remains or 300,000 tokens are in use, whichever comes first; save at 15% or 400,000 in use); tool calls between repeated notes; the context size past which an idle gap is toasted. |
| `checkEnv` | `{ "pass": [], "mode": "observe" }` | `"enforce"` runs verify commands and feature checks with only a minimal base and the names in `pass`; `"observe"` runs them with everything and reports what they could see; `"off"` says nothing. |
| `blastRadius` | `{ "maxFiles": 25, "maxLines": 600, "manifests": ["package.json", "*.lock", "package-lock.json", "go.mod", "go.sum", "Cargo.toml", "requirements*.txt", "pyproject.toml", "Gemfile", "pom.xml", "build.gradle"] }` | Past either limit, or with a manifest changed, the change is one tier riskier. |
| `approvals` | `{ "low": 0, "medium": 1, "high": 2 }` | People who approve a merge, by tier. Above 0, the agent does not push that tier to the default branch. |
| `reviewers` | `[]` | Specialist reviewers: `[{ "name", "when": ["<glob>"], "mode": "blocking" \| "shadow", "prompt"?, "model"? }]`. `blocking` adds a gate row; `shadow` is only counted. |
| `models` | the session's | `{ "reviewer"?, "specialist"?, "eval"?, "learner"? }`: the model each of the harness's agents runs on (`learner`: the proposer). |
| `rules` | `[]` | Content rules: `[{ "id", "when": ["<glob>"], "pattern": "<regular expression>", "action": "note" \| "refuse" \| "ratchet", "why" }]`. A wrong `action` is read as `refuse`; an id may not be a built-in rule's name. |
| `evalTrials` | `1` | Trials per eval task, up to 10; a task passes only if every trial passes. |
| `evalIsolation` | `"worktree"` | `"clone"` runs each eval task in a fresh clone of HEAD instead. |
| `evalQuick` | `5` | Tasks in the quick subset when none is tagged `quick`. |
| `saturationRuns` | `3` | Full runs a task must pass (or fail) every trial of to be flagged outside the useful band. |
| `pruneWindowDays` | `30` | Days without a hit after which prune lists a rule as never fired. |
| `claims` | `{ "leaseMinutes": 30 }` | How long a session's claim on a feature lives unless that session's activity renews it (at most once a minute). 1 to 1440. |
| `followUp` | `{ "ci": true, "intervalSec": 120, "timeoutMin": 60 }` | After a pull request is created or pushed to, poll its checks and reviews through `gh` every `intervalSec` (at least 30) for up to `timeoutMin`; `ci: false` turns it off. Silently off where `gh` is missing or signed out (doctor says which). |
| `grounding` | `{ "mode": <the policy's mode>, "fresh": "turn", "also": [], "never": [] }` | A person's question of fact is checked at the source before it is answered (see [Grounding](#grounding-check-before-you-answer)): `mode` is `"off"`, `"observe"` (tell you) or `"enforce"` (refuse the stop once), and follows `mode` when left out; `fresh: "tree"` also counts a look in an earlier turn while the tree is unchanged; `also` and `never` are case-insensitive regular expressions that add prompts to, or remove them from, what counts as a question. |
| `loop` | `{ "failedRounds": 6 }` | The loop limit: failed rounds (a stop handed back for a failed check, a review round that ended FAIL) on one branch before devloop hands nothing more back and asks you to decide; `/devloop continue [n]` allows more. Shipping does not reset the count; a new branch does. `0` turns it off. Up to 100. |
| `learning` | `{ "auto": "trial", "repeats": 3, "promoteHits": 3, "maxTrial": 20, "maxRuns": 3 }` | Learning without being asked. `auto`: `"off"` (nothing by itself; `/devloop learn` as before), `"propose"` (automatic lessons, and a proposer run when a repeat reaches `repeats` occurrences or a change closes with one waiting) or `"trial"` (also: a proposed content rule goes on trial, recording hits and refusing nothing). A trial rule at `promoteHits` hits is offered to you once; at most `maxTrial` trial rules and `maxRuns` proposer runs per session (none while the budget is spent, a review runs, or on a turn no person started). `repeats` and `promoteHits` from 1 to 100. A wrong `auto` is read as `"off"`. |
| `library` | `{ "save": "auto" }` | The [spec library](#the-spec-library): `"auto"` saves an approved spec to your library when its change closes, and lets `/devloop library save` save it; `"off"` saves nothing of this repository's specs, either way. A wrong value is read as `"off"`. |
| `testing` | `{ "scope": "targeted" }` | `"targeted"`: a pass of a check with `when` globs is kept against the content of the files they match (an edit elsewhere does not run it again), and after a failure the failed check runs first. `"full"`: every check on every tree, as before. A wrong value is read as `"full"`. |
| `tasks` | `{ "integrate": "off" }` | The `.tasks` convention at the edges: `"observe"` records what its rules would refuse, `"enforce"` holds them. Active only where the repository has a `.tasks/` tree declaring `version: 2` and the `tasks` command is on the PATH. A wrong value stays `"off"`. |

Globs: `**` spans folders, `*` stays within one, and a glob with no slash
matches the file name at any depth.

`contextHandoffPercent` is accepted and listed by `/devloop doctor` as not
used: `context.warnRemaining` and `context.saveRemaining` replaced it.

Like every other field, these are read from the base branch's `devloop.json`
(the policy in force), never from the working tree's while the base has one.

### Coordination: claims, follow-ups, ready work

**Claims.** When more than one session works in a repository (typically one
worktree each, sharing the plugin's store), each claims the feature of the
active spec it works on: with `devloop_claim`, or by its first
`feature_check` on an unclaimed feature. A claim belongs to a seat, the
working directory the session works in (its worktree); it names the branch
and worktree and lives `claims.leaseMinutes` unless the seat's tool calls
renew it. A new session in the same directory simply continues its claims.
Another seat's `feature_check` on a feature under a live claim is refused
with the claimant and the time left, and that seat waits: when the holder's
session ends, the claim is released for it (otherwise a claim lapses with its
lease). A lapsed claim is taken over by claiming it; a live one is released
only by a person (`/devloop claims release`, with a dialog). Closing or reopening the spec
clears its claims. Claims are kept under the repository's main root, so the
worktrees of one repository share them. Every claim, lapse, takeover and
release is in the audit trail. With one session this is invisible: nothing
is added to the agent's context and no question is asked.

**Ready work.** The status tool, the cold-start briefing and the pane's
Features tab list what is ready: dependencies passing on this tree, not
claimed by another session, in dependency order. Only when another session
holds a claim do they also show each feature as ready, claimed by another,
claimed by you or passing.

**Follow-ups.** After the harness sees `gh pr create` succeed, or a `git
push` to a branch with an open pull request, it watches the pull request
itself, polling `gh pr checks` and `gh pr view` from a timer in the plugin;
no turn is spent waiting. The agent is woken (a queued prompt) only for a
failing check (its name and the distilled end of its log), a review asking
for changes or a new comment (quoted, as untrusted text from a named person,
which the agent is told not to act on beyond telling you), and once when
every check passed. You get a toast for the same. Every string from the pull
request is cleaned (control, bidirectional and line-separator characters
dropped), cut and quoted; a wake carries at most five checks and five
comments. What was told is kept per head commit, so a push that leaves the
head as it was tells nothing again. A watch ends when the pull request is
merged or closed, `followUp.timeoutMin` after it began (pushes do not extend
it), after ten wakes, at `/devloop done`, or by `/devloop followups stop`;
reaching a limit tells you. A later session resumes one the last left. No
host is contacted except through `gh`.

### The `.tasks` convention

Off by default (`tasks.integrate`). Where a repository uses the `.tasks`
convention (version 2) and the `tasks` command is installed, devloop leaves
the format to that command and adds only what it alone can enforce, on the
agent's own calls:

- the stop gate runs `tasks session-check` for the session: claimed work left
  without a resume point blocks the stop once, like a failing check
  (recorded only in `observe`);
- `tasks done` (and `cancel`) is refused unless devloop's gate is green on the
  tree and the change needs no person's approval; the refusal names `tasks
  handoff <person> <task> -m "…"`;
- `--force`, `--as` and `TASKS_ACTOR=` (inline, or exported earlier on the
  line) are refused, whether the command runs by name or through `npx`,
  `bunx`, `pnpm exec|dlx`, `yarn dlx` or `npm exec` (as `tasks` or
  `@speekl/tasks`); a task's frontmatter (between its `---` fences), its
  `log.md`, and the tree's `config.yml`, `.locks/` and `index.md` are the
  command's to write, so an edit or a shell write to them (through a link, a
  folder or a glob too) is refused with the command to use;
- an eval agent runs no `tasks` command that writes, since from its throwaway
  worktree the command would change the real tree;
- a spec started while the session holds a task records the task's id, and
  the change record and the report cite it;
- a review verdict carries over from the reviewed tree to one that differs
  only in task state (every differing path under `.tasks/` ending in `.md`,
  `.yml` or `.yaml`, by git's diff of the two trees, the files validating
  with `tasks validate`; a link, an executable bit or a submodule is never task
  state): the review row reads "passed on <tree>; only task state has changed
  since". This is decided afresh every time from the verdict's own tree, and
  the verdict carries its open findings and failing promoted checklist items
  with it. Nothing is left out of the tree hash: verification re-runs on the
  tree as it is.

Limits: these are tripwires on the agent's own commands and edits; a script
that writes task state is not seen (docs/RESIDUAL-RISK.md R36), and a check
that reads a task file is re-verified but not re-reviewed (A16). The
stateless enforcement points (the classic hooks, the command line) prove no
gate, so they refuse `tasks done` outright.

### Checklists

A checklist is a short list of checkable statements about a kind of change,
kept at `checklists/<id>.json` on the base branch (format `checklist@1`,
`schemas/checklist@1.json`; a worked example is
`docs/examples/checklists/login-form.json`). `checklists/**` is a built-in
protected path and an instruction file: the agent cannot edit one, and a
person's edit makes the change high risk.

```jsonc
{
  "schema": "checklist@1", "id": "login-form", "version": 1, "title": "Sign-in form",
  "appliesTo": { "surfaces": ["login"], "paths": ["**/login/**"], "detect": "type=[\"']password" },
  "maxItems": 14,                  // at most 15; a list with more active items fails to load and says so
  "items": [
    { "id": "autocomplete", "statement": "…", "why": "…", "severity": "high",   // critical | high | medium | low
      "verify": { "by": "pattern", "how": "…", "pattern": "current-password", "expect": "present" },
      "naWhen": ["…"], "status": "active" }                                     // or "retired"
  ]
}
```

`verify.by` routes each item: `pattern` (a regular expression the harness
runs over the changed files: it reports present or absent, never good),
`check` (a command the harness runs, judged by the command rules first and
scrubbed by `checkEnv`), `review` (answered by the checklist reviewer),
`runtime` and `person` (listed for the approver only).

- **Selection**: a list applies when the spec declares one of its surfaces in
  SPEC.md's front matter (`surfaces: [login]`), a changed path matches its
  `paths`, or its `detect` pattern is in an added line.
- **Seeding a spec**: while a spec is written, the items that apply are
  offered as candidate acceptance criteria. Approval is refused until each is
  accounted for: kept (a feature's `checklist`, or `criteria`, names it as
  `"login-form/autocomplete"`), listed under a `## Judged by a person`
  heading in SPEC.md (it appears in the report's reading aid, never in the
  gate), or struck under `## Not applicable` with a reason. The dialog lists
  which were kept, which are a person's and which were struck, each with how
  it is verified; an item the harness verifies itself (`pattern` or `check`)
  cannot be listed as a person's.
- **The checklist reviewer** (shadow by default): at each review round the
  `review` items go to one read-only reviewer agent, which answers every item
  `pass | fail | not applicable | unverified` with a quoted line at
  `file:line` (checked by the harness) or a reason. An unanswered item or a
  fail whose quote is not there is restated once, then goes to a person.
  Results are `checklist-result@1` records.
- **Promotion, per item**: `/devloop checklists` shows each item's numbers;
  `/devloop checklists promote <list>/<item>` (a person, with a dialog) makes
  that item blocking, and its fail on a tree is then a gate row of its own.
  Recall on seeded defects counts eval tasks tagged with the item id
  (`"tags": ["login-form/autocomplete"]`) whose task passes when the item
  fails as it should.

### Eval tasks

`evals/tasks/<id>.json`:

```json
{
  "prompt": "what to ask the agent",
  "check": "a command that exits 0 only on success",
  "setup": "optional: a command run in the fresh sandbox first",
  "solution": "optional: a patch (unified diff) or command that makes the check pass",
  "nearMiss": "optional: a patch or command that comes close and must still fail",
  "expect": { "mustUse": ["Read"], "mustNotUse": ["Write"], "order": ["Grep", "Edit"],
              "maxToolCalls": 30, "noRefusal": true },
  "tags": ["quick"]
}
```

Every command a task carries (its setup, check, and a solution or near miss
that is not a patch) is judged by the command rules before it runs, in
validation and in runs, as feature checks are; a task with a refused command is
not run and is left out, named with the rule. Before the agent starts, `evals/`
is removed from its sandbox and the harness scores it from its own copy of the
task; the sandbox is the harness's own, so you or the builder cannot write into
it. An ablation leaves out a task that could not run in any of its passes.
A task counts only once its witness holds; `expect` asserts on the tool calls
the harness saw the eval agent make (`"refusal": "<rule>"` instead of
`noRefusal` says which guard must fire). Checks run with `checkEnv`. Agent or
sandbox failures and checks that could not run are reported apart and left out
of pass rates. `evals/README.md` (written by `/devloop init`) says how to
compose the suite.

### Records and the audit trail

Every record the harness keeps has a versioned schema in `schemas/`
(`finding@1`, `papercut@1`, `handoff@1`, `change-record@1`, `eval-result@1`,
`gate@1`, `audit-event@1`, `library-entry@1`) and is validated when written; one that does not
fit is reported in the ledger and not stored. Change records, eval results and
gate records carry what produced them: the policy's hash, the model, the
harness version and the tree (and for evals each task file's hash). The audit
trail, kept outside the working tree in the plugin's data folder, records every
action that changes what may ship, with its actor; `/devloop audit` prints it.
It is written in small numbered segments (`audit/000001.jsonl` on, 200 events
each); an append reads only the current segment, and one it cannot read is
never overwritten (the next segment begins). The newest 50 segments are the
live trail; older ones stay beside them as the archive. A content rule's hit is
recorded as the rule, the path, the line number and a fingerprint, never the
line.
`/devloop done` asks what you read of the change (the diff, the test changes,
the instruction-file changes) and records it on the change record: only that
dialog sets it.

An example:

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
  "reviewers": [{ "name": "security", "when": ["**/auth/**"], "mode": "blocking" }],
  "models": { "reviewer": "sonnet" }
}
```

### The spec library

Every approved spec can start later work, in this project or another. The
library is a folder outside every repository: by default `library/` in the
plugin's data folder (shared by every project on this machine, for you), or a
folder you set with `/devloop library path <dir>`, such as one a drive syncs,
a network share, or a clone of a team's library repository. devloop writes
files there and never commits, pulls or pushes; keeping a shared folder in
step is your tool's job.

When you close a change with `/devloop done` and it had an approved spec, the
spec is saved, and the answer says where. Each entry is a folder,
`<project>--<spec name>--<yyyy-mm-dd>/`, holding `SPEC.md` and
`features.json` as approved and `entry.json` (`library-entry@1`): the
project, the spec's name, kind, size and related specs, the intent's first
sentence, the acceptance criteria, each feature's id, description and check,
the dates, the outcome (closed with every feature passing or not, review
rounds, escaped defects recorded later) and a content hash. No code, tests,
diffs, transcripts or findings are copied. `index.jsonl` holds one line per
save, only ever appended; a later line for an entry supersedes an earlier one.

Before anything is written, both files go through the credential scan the
gate uses on a diff's added lines: a hit stops the save, naming the file and
line (never the value), and the change still closes. A spec folder your
`secrets` globs match is never copied, and `"library": { "save": "off" }`
keeps a project's specs out of the library altogether.

The agent searches it with `devloop_library`, then reads an entry's `SPEC.md`
from its folder: reads inside the library are allowed for every agent, and
every write there by a tool call is refused. The spec skill's first step
searches it beside `specs/`, and tells you which earlier specs it used, with
their projects. Doctor reports the folder, whether it is there and writable,
and how many entries it holds; the command line's doctor does not (the folder
you set is kept in the plugin's store).

## Cache: cache-guard

cache-guard is the repository owner's own prompt-cache tool, bundled unchanged
in [`cache-guard/`](../cache-guard/): a status line that shows what the prompt
cache saves, guards on the moves that throw a warm cache away, and cost
reports, in one standard-library Python file. It is optional and needs Python
3.8+; every devloop feature works without it.

- `/devloop cache install [--trim --notify --keepwarm --handoff --lean --all]`
  and `/devloop cache uninstall`: a person's, with a dialog; its installer
  backs up and edits `~/.claude/settings.json`. Uninstalling does not put
  back a status line you had before installing it: that stays in the
  backups (`~/.claude/settings.json.bak-*`), and the dialog says so. The
  agent cannot run the script itself (rule `cache-guard`).
- `/devloop cache doctor`, `/devloop cache report [--all] [--days N]
  [session]`, `/devloop cache status`: read-only. A session id is 8 to 64
  letters, digits and hyphens; `--days` is given once.

While it is installed, devloop leaves the cold-cache warning and the cost of
cache misses to it, never loads its handoffs, and says in `/devloop doctor`
what is on. The Lean output style also ships as a plugin output style
(`devloop:Lean`). The `cache-guard/` folder is Apache-2.0, like the rest of
the repository. Everything else about it is in
[`cache-guard/README.md`](../cache-guard/README.md).

## What it cannot do

- Shell commands are judged by their text. That catches mistakes and honest
  shortcuts, not an agent set on getting around it: a script can write a
  locked file, and a package manager reaches its registry without a URL in the
  command. [docs/RESIDUAL-RISK.md](RESIDUAL-RISK.md) lists what is
  accepted. The sandbox and keeping credentials out of the environment are the
  boundary; devloop is a tripwire. `/devloop doctor` reports whether a sandbox
  is configured and which credential-shaped variables are visible.
- It cannot create a sandbox or remove credentials from the environment.
- It does not run staged rollouts or rollbacks; that belongs to CI and
  deployment.
- It does not make a solo developer two people. The gate shows who must
  approve a merge; no state of the loop ticks that row.
- Cost figures are client-side estimates, not bills.
- An agent that can delete or edit the plugin, or the settings that load its
  hooks, removes every enforcement point at once. The plugin's folder is
  outside the repository, and `.claude/settings*.json` is protected; the
  sandbox's filesystem rules are what keep it out.

## Running the checks

From the plugin's folder:

```
tsc -p . --noUnusedLocals --noUnusedParameters
claude plugin validate .
claude plugin test .
bash tests/smoke.sh
```

`claude plugin test .` runs the unit tests and the integration tests
(`tests/*.test.ts`), which stand in for the session and the shell.
`tests/smoke.sh` runs the git scripts (`hooks/scripts.ts`, `hooks/state.ts`,
`hooks/portable.ts`, `hooks/githook.ts`, …) against throwaway git
repositories, checks that `dist/devloop.mjs` is the build of its sources,
runs the command line, the classic hook entry, the pre-push hook and the git
notes on throwaway repositories, and runs the parity table through the command
line and the classic hook (`tests/parity.ts`, two runs: a repository that has
opted in and one that has not). The same table (`tests/parity-table.ts`) is
driven through the hooks module's own `tool.call` hook by `claude plugin test`
(`tests/parity.test.ts`); every point must give each row the rule it expects.
It needs `bash`, `git`, `node` and `bun`.

The harness keeps saved check output and the reviewer's diff in the plugin's
data folder, under `repos/<hash of the repository root>/`; tool calls may read
it and never write it. It keeps the twenty most recent of those files per
repository and clears them at `/devloop done`.

## License

Apache-2.0. See [LICENSE](../LICENSE) and [NOTICE](../NOTICE).
