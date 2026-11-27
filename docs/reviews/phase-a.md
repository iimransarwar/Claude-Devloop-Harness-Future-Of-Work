# Review of Phase A, and the decisions taken

An independent reviewer (fresh context, read-only) reviewed the Phase A code
against docs/DESIGN.md and returned **FAIL** with 30 findings; the high ones
were reproduced with real git, with the pure functions, and with probe tests.
This file records each finding and the decision. "Fixed when" is the test
that must exist.

## High

**F1. Feature status lived in `features.json`, which the builder can edit.**
`passes: true` written before approval, or flipped on disk after it, was
counted without any check running.
*Decision:* feature status is plugin state only: `featureStatus[id] =
{ passes, tree }`. `features.json`'s `passes` is a mirror the harness writes
for people and never reads. Approval starts every feature at not passing.
*Fixed when:* a file carrying `passes: true` before approval reads 0/N after
it; a flip on disk after approval moves neither the count nor the gate.

**F27 (decided with F1). A pass was not tied to a tree.**
*Decision:* a pass records the tree hash it ran on. When every feature is
recorded passing and the fast checks are green at a stop, the harness re-runs
every feature check on the current tree before any review starts; one that
fails is flipped and the stop is blocked with its output. The ship gate does
the same. The gate row shows how many passes cover the current tree.

**F2. One allowed sub-command allowed the whole command line.**
`git merge origin/main && git push …` and `git -C . push …` skipped the gate.
*Decision:* commands are split into segments (`;`, `&&`, `||`, `|`, newline,
subshell parentheses) and each segment is judged; the strictest verdict wins.
Git's global options (`-C <path>`, `-c k=v`, `--git-dir=…`) are skipped when
finding the sub-command.
*Fixed when:* those commands get the same verdict as the bare push.

**F3. The gate judged the checkout, not what was being shipped.**
On a clean default branch the tier was `none`, so `gh pr merge` was allowed.
*Decision:* `gh pr merge` is always refused to the agent (rule `human-merge`):
the harness cannot see the pull request's tier, and merging is a person's.
`git merge` while on the default branch is refused the same way. A push that
targets the default branch is judged on the commits not yet on the remote
default branch; it is refused when `approvals[tier] > 0`.

**F4. A `defaultBranch` that names no branch emptied the change after a
commit.**
*Decision:* the snapshot resolves the base in order: the configured branch on
the remote, then locally, then the remote's HEAD, then `main`/`master`; it
reports `base:<sha>` or `base:unknown`. With the base unknown the gate has an
unmet row "Base branch unknown" (fail closed) and doctor says how to fix it.
`/devloop init` detects the branch instead of writing `main`.
*Fixed when:* a smoke case on `master` with config `main` still lists
committed work, or reports the base unknown with the gate shut.

**F5. The secrets rule did not hold outside the repository.**
`cat /home/u/vault/creds`, `cat ../a.secret`, `~`-spelled paths and links
resolving outside the root were not tested.
*Decision:* the secrets rule applies to every path anywhere: `~` is expanded,
the absolute path and the file name are matched, and a link is judged by its
real path wherever it lands. Matching for secrets is case-insensitive (F23).

**F6. "Review passed" could cover a tree the reviewer never read.**
*Decision:* a review round records the tree hash it started on. A verdict
that arrives for another tree is discarded as stale (it does not count as a
round) and the gate row compares hashes.

**F7. In observe mode a recorded-only verdict masked the rules that always
hold.**
*Decision:* every rule is evaluated; a call is refused if any always-held rule
matches (secret, reviewer read-only, budget, eval containment), whatever
else matched first. The refusal is returned before anything is recorded
(F26).

**F8. The reviewer's allowlist was not read-only.**
A newline, `sort -o`, `uniq in out`, `git diff --output=`, `rg --pre`,
`find -fprint` and a push after `git status` all passed.
*Decision:* the harness writes the diff (including untracked files) to a file
in its own state directory outside the working tree and gives the reviewer the
path, so the reviewer needs few commands (this also fixes F15, where the
harness's own suggested diff command was refused). The allowlist becomes:
one line only; each pipe part is one of a short list of readers with their
writing options refused by name; the repository's checks word for word;
nothing that ships, for the reviewer, ever.

## Medium

**F9.** Re-running `/devloop init` marked the tree verified. *Decision:* init
on a configured repository leaves verification alone; a first baseline sets
status `none`.

**F10.** The locked-file tripwire missed `cd x⏎rm …`, a leading space, `sudo`,
and directories (`rm -rf tests`, `mv tests old`, `git checkout main -- tests/`).
*Decision:* judged per segment; wrapper commands (`sudo`, `env`, `nohup`,
`timeout`, `xargs`, `command`) are peeled; a directory operand is locked when
a locked glob lies beneath it.

**F11.** Only Bash, Read and the edit tools were judged. *Decision:* Grep and
Glob paths and patterns meet the secrets rule; Monitor's `command` and a
background Bash meet the command rules.

**F12.** Tier was computed over the last 300 files. *Decision:* tier,
tests-touched and the instruction-files row use the full list; only display
is capped.

**F13.** Rename detection hid the old path. *Decision:* `--no-renames`.

**F14.** Any `>` made a command write-shaped, so `pytest tests/x.py 2>&1` was
refused in build. *Decision:* redirects to file descriptors and `/dev/null`
are not writes; a redirect's target is what is judged.

**F15.** See F8.

**F16.** Root lookup stopped after eight folders, and the cache and loop were
not keyed by repository. *Decision:* the root is found from the session's
root with an unbounded walk; the cache is keyed by it; an agent's own working
directory is used only to resolve relative paths in its tool calls.

**F17.** `"verify": "npm test"` parsed to no checks. *Decision:* a single
string is one check; any other wrong type is an error and the gate has an
unmet row "Policy error" until it is fixed. A file that stops parsing falls
back to the last config that parsed (DESIGN 9.3).

**F18.** The eval exemption was by agent, not by worktree. *Decision:* exempt
only paths under the run's own directory; `/devloop eval` needs a person.

**F19.** The guarantees that matter most had no test: every command was sent
as a person. *Decision:* tests for approve, allow, done, budget, spec-reopen
and eval from a non-person origin; done with the gate open (both answers); a
link; the fix-round reset on a person's prompt; the budget rule; an eval run.

## Low

**F20.** High-needs-spec and spec-first bound the edit tools only.
*Decision:* they also apply to write-shaped commands' targets.

**F21.** `git commit -n`, `git push origin +branch`, `HEAD:refs/heads/main`
passed; `aws s3 ls deployments/` was refused as production. *Decision:* fixed
by segment parsing; note `-n` means no-verify for commit and dry-run for push.

**F22.** Egress missed bare addresses, subshells and wrapped commands.
*Decision:* fixed with F2 and F10.

**F23.** Globs were case-sensitive. *Decision:* secrets fold case always.

**F24.** Raising a budget had no dialog; `sdk` counted as a person; reopening
a spec had no person check. *Decision:* a person is `composer` or `bridge`
plus a confirmation dialog for every key in principle 3; reopening an approved
spec is one of them.

**F25.** A one-turn exemption outlived an interrupted turn. *Decision:* it is
bound to the next main-loop turn and cleared when that turn ends, however it
ends.

**F26.** A failed stop gate let the stop through silently in enforce mode.
*Decision:* a stop is never blocked by a broken harness (that could trap a
session), but verification is marked `error`, the gate row is unmet and the
person is told.

**F28.** A plugin reload was treated as a new session: a running review's id
was dropped and the tree re-baselined. *Decision:* state records the session
id; the same id means a reload and nothing is reset. A review `running` for
more than thirty minutes is marked abandoned.

**F29.** A test under a high-risk folder could never be written; any change
with a spec was high tier because of its own feature list. *Decision:* in the
spec phase the tests rule comes before the high-risk rule; the active spec's
folder is left out of the tier.

**F30.** Three tests asserted less than their names. *Decision:* strengthen
them with the F7 and F8 cases and compare stored state across the status
tool's call.
