# Review of the final fix round, and the decisions taken

Seventh round, fresh context, read-only, on commit `3c7914e`. Verdict
**PASS**: the first passing round. All four high findings from the previous
round are resolved, most confirmed by reproduction against the committed
bundle with throwaway repositories. Ten new findings, none high. One further
item (I1) came from an interactive session.

## Medium

**F1. A kept pass was trusted from any environment.** Running `verify` with a
doctored `PATH` wrote a pass the classic hook then accepted without running
the check. *Decision:* the hook keeps and trusts only passes from its own
runs, made in its own scrubbed environment. The command-line `verify` no
longer feeds the hook. When the hook's time budget runs out it keeps the
passes it did finish, so the retry resumes where it stopped; the refusal says
to run the push again. (This also settles F10.)

**F2. Files hidden from git with skip-worktree or assume-unchanged escaped
the "what a push sends" comparison.** *Decision:* the snapshot reports index
entries carrying either bit; any such entry makes the gate row unmet and a
push refused, naming the files. The agent may not set those bits
(`git update-index --skip-worktree|--assume-unchanged` is refused).

**F3. A later one-command assignment cancelled an earlier export** of the
notes-ref or actor variable in the command model, though the shell keeps the
export. *Decision:* a forbidden value assigned or exported anywhere earlier on
the line holds; nothing later on the line cancels it.

**F4. A glob in the middle of a path escaped the `.tasks` shell rule**
(`.tasks/web/*/task.md`). *Decision:* the rule and both readers expand from
the same prefix (the path before the first wildcard).

**F5. The `.tasks` edit rule was skipped for a path spelled outside the
repository**, so a link from outside to a manifest passed two of the three
enforcement points. *Decision:* the shared core judges every placed path.

**F6. A shell write through a link to a task manifest or log was judged by
no `.tasks` rule.** *Decision:* the resolved path of every written path goes
through the same rule as an edit.

**F7. The evidence note ignored a promoted checklist item's failure**, so a
round the module's gate called failing was recorded as passing for CI.
*Decision:* a round with a promoted checklist failure writes evidence that
says so (the failing items are recorded and the stateless review row is
unmet).

**F8. `git push --all`, `--branches`, `--tags`, `--follow-tags` and
`--mirror` named no source and were not compared with what the gate judged.**
*Decision:* the agent pushes the branch it is on, by name or by `HEAD`; those
forms are refused with that advice.

## Low

**F9.** The "commit or stash first" refusal did not mention untracked files,
and plain `git stash` leaves them, so the refusal repeated. *Decision:* the
message names the files that differ (up to a few), says which are untracked,
and gives remedies that work: commit them, `git stash -u`, or ignore them.

**F10.** See F1.

## From an interactive session

**I1. Every review round stalled on permission prompts.** In an interactive
session the reviewer's read of the round's diff file (outside the workspace)
and each run of a check raised the engine's own permission prompt, so a
review could not finish without a person approving each one.
*Decision:* the harness answers the permission check for its own reviewer
agents, and only for: a read of that round's diff file, reads inside the
repository, the repository's checks word for word, and the read-only command
allowlist the guards already enforce. Everything else still asks. The same
applies to checklist reviewers. A test shows a reviewer's allowed read is
answered without a prompt, a builder's read of the same file is not, and a
reviewer's command outside the allowlist is still refused.
