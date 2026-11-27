# Design note: stop looping, test what changed

Asked for by the repository owner, after watching this repository's own
build spend a day in fix-and-review rounds on one area, each round re-running
every check and starting a fresh whole-change review that found something new.
Two rules follow. Their names in the policy and the code are `loop` and
`testing`.

This note is the system of record for both.

## What already exists

- `maxFixRounds` (2) and `maxReviewRounds` (3) cap one change.
- A check may carry `when` globs and a `fast` or `full` profile.
- The rules text says "after two failed attempts at the same fix, stop".

What is missing: nothing caps a *series* of changes on one branch (the review
count returns to one after each shipped push, so an agent working alone can
fail, fix, ship and fail again without end); a fix round re-runs checks that
have nothing to do with the fix; and a second review round reads the whole
change again as if it were the first.

## Part 1: the loop limit

### 1. What is counted
Failed rounds on the current branch since a person last allowed more:

- a stop the gate handed back because a check failed (a fix round);
- a review round that ended FAIL (general or specialist; one count per round,
  not per reviewer).

A round that passes costs nothing, so a long session of changes that pass
first time never meets the limit. Shipping a change does not return the count
to zero; only a person does (decision 3), or a new branch.

### 2. What happens at the limit
Policy: `"loop": { "failedRounds": 6 }`. `0` turns the limit off. Left out,
the default is 6. At the limit, in enforce mode:

- The stop gate hands nothing more back. The turn is allowed to end, once,
  with this text added to it:

  > Loop limit: N failed rounds on this branch without a person. Stop now.
  > Do not start another fix or review. Report in a few lines: what failed
  > each time, what you tried, and the choices: (1) use the last commit that
  > passed the gate (`<sha>`, or "none on this branch"), (2) accept the open
  > findings as known gaps, (3) `/devloop continue` for N more rounds.

- A review started by the agent or by auto-review is refused with the same
  text. A person's own `/devloop review` still runs.
- A push stays gated exactly as before: an unmet gate does not ship because
  the limit was reached.
- The person sees a toast ("devloop stopped after N failed rounds") and the
  Activity tab lists the failed rounds, with the file named most often in
  their findings when one file accounts for three or more.
- The message is given once per limit. It cannot itself cause another round.

In observe mode nothing is refused; the toast and the record only.

### 3. How a person allows more
`/devloop continue [n]`, a person only: allows `n` more failed rounds
(default: the policy's number) and records who and when in the journal. A
person's ordinary prompt does not allow more: "still going?" is not consent
to another six rounds.

### 4. The last commit that passed
The harness records the newest commit on the branch for which the gate was
fully met (checks and review). The limit message names it. With none, the
message says so.

### 5. Enforcement points
The module counts and enforces. The classic hooks and the command line keep
nothing between calls (rule P-D) and cannot count rounds; they say nothing
about this limit. Doctor reports the limit in force and the current count.

## Part 2: test what changed

### 6. The rule the agent sees
One byte-stable paragraph in the rules text:

> Test what you changed. Run the check that covers the files you touched, not
> the whole suite, and do not re-run a check that passed on files that have
> not changed since. After a failure, re-run the check that failed. The
> harness runs whatever else applies when the change ships.

The context line that lists the checks names, for the current change, the
checks that apply to the files changed ("Checks for what you changed: …").

### 7. A pass belongs to the files it covered
Policy: `"testing": { "scope": "targeted" }` (the default) or `"full"` (every
check on every tree, as before).

Under `targeted`:

- A check with `when` globs runs only when a changed file matches, at every
  gate, the ship gate included, whatever its profile.
- A pass of such a check is kept against the content of the files its globs
  match, not against the whole tree. Editing a file outside its globs does
  not make it run again.
- A check without `when` covers the whole tree and behaves as now: it runs
  when the tree differs from the one it passed on. `full` checks still run
  only at the ship gate.
- After a failed check, the next stop runs the failed check first and stops
  there if it fails again; checks that already passed on unchanged covered
  files are not run again.
- Nothing here lets a change ship with a check that applies to it unrun: the
  ship gate still requires a pass for every check whose globs match the
  change, and for every check without globs.

Doctor reports each `full` check without `when` ("runs in full on every
change that ships: add `when` globs to scope it"), and `/devloop init`
proposes `when` globs for the checks it detects where the layout makes them
obvious.

### 8. A second review reads the fix, not the whole change again
Review round 2 and later is given the open findings and the diff since the
previous round, and is told: confirm each finding is fixed or still open, and
review only the lines changed since the last round.

A problem the reviewer sees outside those lines is reported as "outside this
round". It is recorded as a follow-up for the person and does not fail the
round, unless its severity is high, in which case it fails the round and the
message says it was missed earlier. Round 1 is unchanged: the whole change.

### 9. What this does not do
It does not judge whether `when` globs are right: a check scoped too narrowly
will be skipped for changes it should cover. That is the policy author's
call, the policy is read from the base branch, and the limit goes into the
residual-risk register. It does not stop the agent typing the full suite's
command itself; the rule text and the context line are what the harness
offers there.

## Tests the build must add
Module tests only for the new behaviour (this note's own rule): the counter
(fail, pass, ship, new branch, `/devloop continue`), the limit's one-time
message and the refusal of an agent-started review, observe mode, the
last-passing commit, the per-check pass keyed by covered files, the failed
check running first, the ship gate still requiring every applicable check,
and the scoped brief for round 2 with a high finding outside the delta.
