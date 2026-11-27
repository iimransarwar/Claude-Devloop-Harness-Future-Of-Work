# Review of Phase B1, and the decisions taken

Second round, fresh context, read-only, on commit `0284e08`. Verdict **FAIL**
on one new high finding. Of the first round's eight high findings, seven are
resolved and F3 is partly resolved (see N1). The round closed findings, so it
is not a stalled round. Findings were confirmed by calling the pure functions
or by tracing the code path; each "Fixed when" is the test that must exist.

Half of the new findings are *false refusals*: harmless commands the new
command model refuses. They are treated as seriously as bypasses, because a
guard that refuses ordinary work gets switched off.

## High

**N1. A command line that switches branch first evades the merge rules.**
`git checkout main && git merge feature && git push` passed: the branch was
read once, before the command ran.
*Decision:* the command model carries the branch through a line. A
`git checkout|switch` to the default branch makes later segments "on the
default branch"; a switch to a ref the model cannot name makes them "possibly
on the default branch", which is judged the same. Merge and push are judged
against that.
*Fixed when:* on `feature` with a green gate, that line and
`git switch main; git merge feature; git push origin HEAD` are refused with
the human-merge reason.

## Medium

**N2. Every `git merge` was treated as shipping**, so `git merge origin/main`
and `git merge --abort` on a feature branch ran verification and were refused.
*Decision:* only a merge while on (or possibly on, per N1) the default branch
is a ship intent. *Fixed when:* the same test with a changed, unreviewed tree
shows no refusal and no check run.

**N3. Arithmetic was read as a heredoc and a redirect.** `$((1 << n))` and
`(( x > 5 ))` swallowed or misread the rest of the line, hiding a forced push,
a locked delete and a secret read. *Decision:* `$(( … ))` and `(( … ))` are an
arithmetic context: no heredocs, no redirects inside. *Fixed when:* the three
hidden commands get `force-push`, `tests-locked` and `secret`.

**N4. "Download run as code" fired on data pipes** such as
`curl … | python3 -m json.tool`. *Decision:* the rule holds only when the
download is the program: piped into a shell, or into an interpreter reading
its program from standard input with no script or `-c`/`-m` argument; process
substitution into a shell; `sh -c "$(curl …)"`. *Fixed when:* the three
harmless lines pass and the three dangerous forms stay refused.

**N5. `find`'s root stood in for whatever it matched**, refusing
`find . -name "*.pyc" -delete`. *Decision:* with a name or path filter, the
filter is judged: the command is refused only if a locked file under the root
could match it; with no filter the root stands in, as now. *Fixed when:* the
cleanup forms pass and `find tests -delete` stays locked in build.

**N6. A writer fed by a pipe was judged only by literal operands**, so
`git ls-files | xargs sed -i …` rewrote locked tests in build.
*Decision:* in the spec and build phases, a writer fed by a file lister
(`git ls-files`, `git grep -l`, `rg -l`, `grep -rl`, `find`, `ls`, `fd`) is
judged as writing the lister's root, and refused when locked files lie
beneath it; the refusal says to name the files or use the edit tool. In
small-fix mode it passes: nothing is locked there but policy files, and the
gate's "policy changed" and "instruction files changed" rows report an actual
write after the fact. Listers the model does not know go in the residual-risk
register with a test.

**N7. A verification pass did not say which checks it covered.** A change
that weakened its own policy could have its stop-gate pass accepted at the
ship gate. *Decision:* a pass is recorded per check command with the tree it
ran on. The ship gate runs every check of the base policy's fast and full
profiles that has no pass on the current tree. *Fixed when:* "the check the
change dropped still runs" holds after a stop-gate pass and after
`/devloop verify`.

**N8. Enforcement mode came from the working tree** while the gate's policy
came from the base, so a change could set itself to observe.
*Decision:* the mode in force is the base policy's when a base copy exists,
the working tree's otherwise. A differing working-tree mode shows in the
"Policy changed" row. *Fixed when:* base on enforce, tree on observe: the push
of an unreviewed medium change and `gh pr merge` are refused.

**N9. Eval agents lost every non-path rule.** *Decision:* an eval agent is
exempt only from path rules, and only under its own worktree. Production,
forbidden, egress, destructive and download-run rules apply to it.

**N10. `/devloop init` had no person check and could shadow a policy.**
*Decision:* init needs a person; when a policy already exists at or above the
session root it writes nothing and names where the policy is.

**N11. Git forms that leave the working tree alone were judged as writes**:
`git restore --staged`, `git clean -n`, `git rm --cached`, reads of
`git config`. *Decision:* they are not writes. *Fixed when:* the "safe
neighbours" test asserts no refusal at all for each, not merely "not
destructive".

## Low

**N12.** Reviewer: `git grep -O`/`--open-files-in-pager` refused.
**N13.** Grep and Glob paths are resolved through links before the secrets
rule, like Read.
**N14.** The same-rule refusal count resets on any allowed call.
**N15.** A shell command with written paths marks the loop dirty, so the pane
does not show a pass for a tree that has moved.
**N16.** `gh`'s global options (`-R`, `--repo`) are skipped when finding the
sub-command, as git's are.
**N17.** An exemption granted while a turn is running applies to that turn
and ends with it; granted while idle it applies to the next turn. The design
text is corrected to say so.
**N18.** A computed program name that is recognisably a test run
(`$PYTHON -m pytest`, a path ending in a known runner) is not an unknown
writer. Where the unknown-writer rule does fire, the refusal says to name the
program literally.
**N19.** `git checkout <one word>` is a path only after `--` or when the word
is a tracked path; otherwise it is a branch. (`(( x > 5 ))`: see N3.)
**N20.** The filtered-check refusal names the saved output only when that
file exists.

Also: the F27 test asserts the ship path as well as the stop path, as its name
says.
