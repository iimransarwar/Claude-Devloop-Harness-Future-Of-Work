# Review of Phase C2, and the decisions taken

Fifth round, fresh context, read-only, on commit `56db75d`. Verdict **FAIL**
on two high findings. Findings were reproduced by probe tests on a copy of
the commit or by calling the pure functions; two were confirmed by reading
only and are marked so by the reviewer.

## High

**F1. Eval task commands ran unjudged.** A task's `setup`, `check`,
`solution` and `nearMiss` went straight to the shell, and
`/devloop eval validate` ran them with no dialog. A task file holding a forced
push, a secret read piped to the network and `rm -rf ~` was run and reported
valid; the same text typed by the builder is refused.
*Decision:* every command an eval task carries is judged by the command rules
before it is ever run, in validation and in runs, exactly as feature checks
and regression checks are. A task with a refused command is not run, is left
out, and is named with the rule. `eval validate` needs a person and a dialog
like `eval`.
*Fixed when:* each of the four fields holding a refused command is absent
from the list of commands run, in both paths.

**F2. `ship-alone` treated every merge as a ship**, so
`git merge wip && git push` had no "other part" and passed (the very failure
the rule exists to stop), while `git fetch origin && git merge origin/main`
on a feature branch, which ships nothing, was refused.
*Decision:* for `ship-alone`, a ship intent is a push, a `gh pr` action, or a
merge on (or possibly on) the default branch. A merge anywhere else is a
write like any other: beside a ship it makes the line refused; alone, or with
a fetch, it is not shipping.
*Fixed when:* `git merge wip && git push` and
`git merge origin/main && git push origin feature` are refused;
`git fetch origin && git merge origin/main` on a feature branch is not.

## Medium

**F3. A git command beside a ship was accepted by sub-command name alone**,
so `git grep -O"<program>"`, `git symbolic-ref HEAD refs/heads/main`,
`git remote add` and `git reflog expire` passed as "reads".
*Decision:* the reading-form check used for the reviewer applies to
companions: options that run a program are refused, and `symbolic-ref`,
`remote` and `reflog` count as reads only in their reading forms.

**F4. An ablation counted infrastructure outcomes as failures**, so a pass in
which agents failed to start showed the rule as helping or hurting.
*Decision:* a task that was an infrastructure outcome in any of the three
passes is left out of all three counts; a pass with no counted task gives no
verdict and no evidence is stored.

**F5. The audit trail was rewritten whole on every append, and a failed read
turned it into a one-event file.** *Decision:* the trail is written in small
numbered segments; an append reads only the current segment; a read that
fails starts a new segment and never overwrites; old segments are kept up to
a stated total and the oldest are archived beyond it.

**F6. A regression check kept its old command after its spec was reopened and
closed with a new one.** *Decision:* the stored set is the truth; a differing
command resets that check's pass and tree.

**F7. An edit that creates a file through an empty `old_string` skipped
content rules.** *Decision:* it is judged as a write of the new content, for
content rules and for test-weakening.

**F8. A `note` rule stored the matched line in the ledger**, file content and
all, against the privacy rule. *Decision:* the entry holds the rule id, the
path, the line number and a fingerprint. A test writes a marker through every
recording path and finds it nowhere in the ledger, the audit trail, the
metrics export, the report or the learn output.

**F9. An eval agent could read its own task's answer, and the builder could
write into a running trial.** *Decision:* `evals/` is removed from the
sandbox before the agent starts and the harness runs checks from its own copy
of the task; eval sandboxes are harness state, so any write beneath one by
the builder is refused.

**F10. A git alias, a push from another working directory, and a push of a
branch other than the current one were not judged as what they ship.**
*Decision:* a git command carrying `-c alias.*=` is treated as a possible
ship and as unknown code; a ship whose working directory is outside the
repository root is refused (the harness can judge only this repository); a
push that names a source other than the current branch or `HEAD` is refused
with "push the branch you are on".

**F11. The change report listed earlier changes' review verdicts** when a
change had no write the harness attributed. *Decision:* the report is bounded
by the last `change-closed` event.

## Low

**F12.** The check after the fact was skipped when the command's result was
an error, although the push may already have happened. *Decision:* it runs
whenever the text held a ship intent, error or not.

## Not shown either way: two calls dispatched together

The reviewer could neither show nor rule out that an edit, a commit and a
push sent as parallel tool calls in one message could ship a tree the gate
never judged; the engine's ordering of such calls is not stated.
*Decision (fail safe):* the harness keeps a count of main-loop tool calls in
flight that can write. A ship intent that arrives while any is in flight is
refused: run the push by itself, after the other commands have finished. A
test dispatches a write and a push together and shows the push refused.
