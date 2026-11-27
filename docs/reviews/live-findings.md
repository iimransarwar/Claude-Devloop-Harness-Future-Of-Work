# Findings from live sessions, and the decisions taken

Findings that came from running the plugin in real headless sessions, after a
phase's own review. Each says what happened, the decision, and the test that
shows it is fixed.

## L2 (live session, high): a single command line that writes, commits and pushes was judged on the tree before it ran

**What happened.** In a headless session (enforce mode, `autoReview` on) the
builder ran one shell line that wrote a source file and a test file by
redirection, ran `git add`, `git commit`, and then `git push -u origin
feature`. The `tool.call` hook ran before the line: its snapshot found the
tree unchanged (nothing had been written yet), the gate judged "nothing to
ship", and the line was allowed. The same line then created the change and
pushed it: the branch reached the remote with no verification, no review and
no refusal. The engine's debug log confirmed the order. Earlier live runs
passed only because the builder happened to use separate tool calls.

**Decision 9a — a shipping command must stand alone.** A line with a ship
intent (anything `shipsOf` recognises: a push, `gh pr create|ready|merge`, a
merge on or possibly on the default branch) is refused unless every other part
of the line is `cd` or a plain read with no written paths, no redirect to a
file and no unknown code (`git status`, `git log`, `echo`, a reader in a
substitution). Rule `ship-alone`, in the pure command rules
(`hooks/rules.ts` `shipAlone`, part of `judgeCommandAll`); lift class `none`
in enforce (no command exemption lifts it); recorded only in observe mode,
with the mode in force read from the base policy as for `gate`. It holds
whatever the tier and on a clean tree, since the line itself may create the
change. The refusal says to run the push as its own command so the harness
can judge exactly what is pushed. `make release` names no ship intent and is
not caught: R27.

**Decision 9b — a check after the fact.** After a shell call whose text
shipped returns without error, the hook snapshots the tree and judges the
gate again. If it is not green for what was shipped, the harness records an
audit event `shipped-ungated` (the command's first 80 characters, the tree,
the unmet rows), a ledger entry of its own kind and a `gate@1` record, toasts
the person loudly, and adds context to the tool result telling the builder it
pushed work the gate had not passed, to stop, and to tell the person. This is
detection, not prevention: R31.

**Decision 9c — the live sequence as a loop test.** One Bash call that writes
two files with heredocs, commits and pushes, in enforce mode on a clean tree,
is denied with `ship-alone`, and no process runs. The test was run against the
code before this change (the C1 commit) and failed there: the line was
allowed.

*Fixed when:* `tests/c2pure.test.ts` "9a" (the refused and allowed shapes),
`tests/guards.test.ts` (the allowed shapes in the ordinary-commands table),
`tests/c2.test.ts` "9c" (the live sequence end to end; an exemption does not
lift it), "9a: observe mode", "9b" (a push exempted past the gate on an
unverified tree is detected; a gated push on a green tree is not flagged),
`tests/residual.test.ts` R27 and R31.

*Changed by this decision:* `tests/loop.test.ts` N1 — lines that switch to
the default branch and then merge or push are now refused as `ship-alone`
before the branch matters; the branch is still carried through a line, which
the test now asserts on `shipsOf` directly.
