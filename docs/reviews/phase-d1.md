# Review of the C.1 and C2.1 fixes and Phase D1, and the decisions taken

Sixth round (part A), fresh context, read-only, on commits `1b9c69d`,
`2e23bbf` and `e6d0022`. Verdict **FAIL** on two high findings in the classic
hook. Every high finding from the two previous rounds, the "two calls
dispatched together" item and the opt-in item are resolved. Findings were
reproduced against the committed bundle with throwaway repositories.

The lesson, adopted as a rule: **an enforcement point that cannot read its
input, or that fails for any reason, refuses.** "Could not judge" is never
"allowed" for a write, a shell command or a ship.

## High

**F1. The classic hook allowed whatever arrived late or large.** Its read of
standard input was non-blocking; an input that was not ready (a slow parent,
or more than about 150 KB) read as empty, and the hook exited 0 with no
decision, always-held rules included.
*Decision:* the hook reads its input to the end, blocking. Input that cannot
be read or parsed is refused with a message saying the harness could not read
the call.
*Fixed when:* a smoke case feeds the hook from a late writer and with a large
payload from a spawning parent and gets the same refusal as a ready input.

**F2. The fast path for reads re-implemented the secrets rule** and got it
wrong: it matched absolute paths against repository-relative globs and
followed no links, so a secret named by a folder-anchored glob, or reached
through a link, was readable through Read and Grep.
*Decision:* the fast path may skip git work, never judgment: it calls the
shared core's secrets test with the same path placement and link resolution
as every other enforcement point.
*Fixed when:* parity rows for Read and Grep by absolute path of an anchored
secret and through a link agree with `check-path`.

## Medium

**F3. The evidence notes ref could be written by spellings the rule did not
see** (an exported `GIT_NOTES_REF`, a fetch or pull refspec ending at the
ref, `symbolic-ref`, `update-ref --stdin`, `--config-env`), and a forged note
turned a refused push into an allowed one. *Decision:* all are refused, on
parsed words and across the line; the residual-risk entry and the test name
are narrowed to exactly what is held.

**F4. The ship gate judged the working tree, not what the push sends.** A
failing commit followed by an uncommitted restore pushed the failing commit
under a green gate. *Decision:* a push is allowed only when what would be
committed from the working tree equals HEAD's tree — the gate judges the
tree, the push sends commits, and they must be the same thing. The snapshot
reports two hashes: the full tree (including instruction files git ignores),
which "verified" names, and the committable tree, which is compared with
HEAD and which evidence notes are keyed on (this also closes F10). Enforced
by the module's ship gate, the classic hook and the pre-push hook. The
refusal says to commit or stash first.

**F5. Every way the command hook failed was an allow.** *Decision:* (a) on a
ship the classic hook gives its checks a time budget well under the hook's
limit; if they do not finish it refuses and says to run
`node dist/devloop.mjs verify` and retry (passes are kept per tree, so the
retry is quick); (b) a missing `node` is reported by doctor and recorded in
the register as the one state in which the fallback is absent; (c) a throw
inside the hook is a refusal in enforce mode.

**F6. The pre-push hook followed `core.hooksPath` wherever it pointed** and
treated "no policy here" as a red gate. *Decision:* install refuses a hooks
path outside the repository; for one inside the tree it names the path in the
dialog and says the change will be tracked; the installed hook passes a
repository with no policy.

**F7. A review row was met from a note without checking its policy hash or
the reviewer's mode.** *Decision:* evidence produced under a different policy
does not count and the row says so; a blocking row needs that reviewer's own
passing outcome in a blocking or general mode; a shadow reviewer's own
outcome is what is recorded for it.

**F8. The parity table's "module" column was a second copy of the judging
code, not the module's hook.** *Decision:* the same table is also driven
through the module's real `tool.call` hook in the plugin test world, and
gains rows for the search tools, a link, an anchored secret by absolute path
and a repository that has not opted in.

## Low

**F9.** The command line printed a fallback state directory as fact in its
sandbox block and emitted `*` as an allowed domain without remark.
*Decision:* it says when it cannot determine the state directory, and warns
on any domain the broad-domain test flags.

**F10.** With an ignored instruction file present, no evidence note could
ever match. *Decision:* closed by F4 (notes are keyed on the committable
tree; the full tree is recorded beside it).

**F11.** With no policy the classic hook judged nothing, though a dormant
repository keeps the secrets guard. *Decision:* already fixed in the commit
after the ones reviewed; a parity row is confirmed.

**F12.** Code nested past six substitutions was neither judged nor marked
unknown. *Decision:* past the limit the segment is an unknown writer and a
possible ship.

## Also carried into the last fix round

- When several refusals apply to one call, a held refusal always wins over a
  recorded-only one, whatever the order they were found in.
- Distillation drops the Node test runner's internal frames, which carry no
  `at` prefix.
