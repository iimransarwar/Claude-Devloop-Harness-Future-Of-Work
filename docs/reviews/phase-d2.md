# Review of Phase D2, and the decisions taken

Sixth round (part B), fresh context, read-only, on commit `038fe33`. Verdict
**FAIL** on two high findings, both in the rule that lets a review verdict
carry across a change confined to task-state files. Both were reproduced
through the engine.

The lesson, adopted as a rule: **whatever is bound to the reviewed tree
travels with the verdict or the verdict does not travel.** A carry-over is
decided afresh each time, by a diff against the tree the reviewer read, and
it carries every unmet thing that was true of that tree.

## High

**F1. A carry-over credit was never cleared.** After a failed round, a
task-state edit, a fix and a passing round, reverting the fix returned the
tree to one the harness still had marked as "carried", and the gate showed
the later round's pass on a tree that round never saw.
*Decision:* no carry target is stored. Whether the current tree is covered is
decided each time by diffing it against the tree of the verdict in hand; a
new round clears anything derived from an earlier one.
*Fixed when:* that sequence shows the review row unmet.

**F2. A promoted checklist item's failure did not follow the verdict.** The
failure was bound to the reviewed tree; after a task-state edit the row
vanished while the verdict carried, and the gate went green. The exit
protocol asks the agent to write exactly such a file.
*Decision:* a verdict carries with everything recorded against its tree:
open findings and promoted checklist failures are shown against the carried
tree as they were against the reviewed one. A verdict with any such failure
is a failing verdict wherever it is carried.

## Medium

**F3. The `.tasks` shell rule matched only a literally named file**, so a
glob, a folder, `cp` into the folder or `mv` of it reached a task's manifest
and log. *Decision:* it uses the same tracked-file and folder expansion as
the protected-path rule.

**F4. A claim outlived its session and blocked the same person's next
session.** *Decision:* a claim belongs to a seat — a working directory of the
repository — not to a session. A new session in the same working directory
continues its predecessor's claims silently; claims are released at session
end only if another seat is waiting, otherwise they simply lapse with the
lease. Re-taking a lapsed claim is an audit event.
*Fixed when:* a second session in the same directory runs `feature_check`
with no claim named anywhere in its context.

**F5. Check and workflow names from the pull request reached the model
unquoted**, and one wake could carry hundreds of thousands of characters.
*Decision:* every string that comes from the pull request — names included —
is cleaned of control, bidirectional and line-separator characters, cut to a
short length, and placed inside the quoted block. A wake carries at most five
checks and five comments and a bounded total; the rest are counted.

**F6. A re-push forgot what had been told and restarted the timeout**, so one
failing check could wake the builder without end. *Decision:* what was told is
kept per head commit; a push that leaves the head unchanged tells nothing
again. A watch has a ceiling on its total life and on its wakes that pushes
cannot extend; reaching either ends the watch and tells the person.

**F7. The `.tasks` edit rule judged the spelled path only**, so an edit
through a link to a manifest or a log passed. *Decision:* it judges the
resolved path, at all three enforcement points, like every other path rule.

**F8. Acting as another actor through an exported variable, and running the
command through a package runner, were not seen.** *Decision:* an assignment
or export of the actor variable anywhere earlier on the line counts; `npx`,
`pnpm exec`, `yarn dlx`, `bunx` and the package's own name are recognised as
the command. What remains (a variable exported in an earlier command) is
registered with a test.

**F9. The carry-over diff honoured git settings that hide submodule
changes.** *Decision:* the diff ignores no submodule change; a smoke case
proves it.

## Low

**F10.** A fetch or pull whose destination is the evidence notes ref, and a
quote-split spelling of the ref, were not refused. *Decision:* refused, on
parsed words; the rest registered.

**F11.** The builder could list an item that has an executable verification
as "judged by a person", and results were resolved against the working
tree's checklists. *Decision:* the approval dialog names each item's
verification route; "judged by a person" is refused for items whose route is
a pattern or a check; results resolve only against the lists loaded from the
base for that round.

**F12.** Four tests asserted less than their names. *Decision:* each named
case is asserted, and the smoke section for the carry-over diff gains rename,
link, mode and submodule cases.
