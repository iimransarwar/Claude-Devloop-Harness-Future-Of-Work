# Automatic learning: what was checked

Spec: `docs/design-notes/auto-learning.md`. Built by Opus at `dac5621`.
Checked with targeted checks only (`docs/design-notes/loop-limits.md`), and
run for real twice. No independent review round was run on it.

## Targeted checks (mine, on the working tree before the commit)

- Type check with unused locals and parameters: exit 0.
- `claude plugin validate .`: passes.
- The committed bundle equals a rebuild.
- Six test files that cover the change (`autolearn`, `residual`, `evidence`,
  `limits`, `c2`, `policy`): 175 pass, 0 fail.
- The rules text (`hooks/templates.ts`) and the command line (`cli/`) are
  unchanged, as the spec requires.

The builder's one whole-suite run: 1,080 tests, one failure (an expectation
in `tests/evidence.test.ts` that now includes `models.learner`), fixed and
re-run. The smoke test was not run.

## Run for real

Two headless sessions on a frozen copy of `dac5621`, in a throwaway
repository whose check fails when `src` holds `console.log`, with
`learning.repeats` and `learning.promoteHits` set to 1.

1. The agent was asked to add a function that uses `console.log`. The check
   failed and was handed back once. At the end of the turn the harness
   started the proposer by itself. It answered two lines in the format: a
   `rule` proposal (`src/**`, pattern `console\.log`) and an `instruction`
   proposal for `CLAUDE.md`. The person-facing notice read
   "devloop: 2 proposals waiting: /devloop learn".
2. In a second session in the same repository the agent was asked to add
   another `console.log`. The edit was not refused (the function was added),
   and the notice read "devloop: trial rule learn-1 would have caught 1
   edits: /devloop rules promote learn-1". So the rule proposal had gone on
   trial by itself, was kept across sessions, recorded a hit and blocked
   nothing.

## Not run for real

- `/devloop rules`, `rules promote` and `rules drop`: a person's commands
  with dialogs; module tests only.
- The two automatic lessons (the loop limit, the same failure twice): module
  tests only.
- The trigger at `/devloop done`, the limits (`maxRuns`, the budget,
  `maxTrial`, too broad), and removal after `pruneWindowDays`: module tests
  only.

## Known

- The promotion notice says "1 edits" for a single hit.
- The proposer does not get the reviewer's "restate once" retry: a line that
  does not fit the format is dropped and counted.
