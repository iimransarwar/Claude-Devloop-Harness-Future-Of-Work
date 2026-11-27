# Agent-driven review and background tests

Date: 2026-11-27. Status: draft for approval. A builder check was run; its questions are settled under "Rules settled after the builder check".

## Why

In a real project the person had to type `/devloop` / `/devloop review` to
start every review round. Causes, from the source:

- Round 1 starts by itself only after a spec build with every feature
  passing (risk medium or higher), or when a push is refused for lacking a
  review (`hooks/review.ts` `maybeReview`; `hooks/ship.ts:126`). Small-fix
  mode in observe mode never starts it.
- Later rounds start by themselves only after a failed round, once the fix
  moved the tree, at a stop whose verification passed (`register.tsx` Stop
  path). After a round passes, new edits never start another.
- The project's test suite takes longer than `verifyTimeoutSec`, which is
  capped at 600 (`hooks/config.ts:963`; default 300). Every stop's
  verification "could not run", so no round ever started by itself.
- The reviewer is read-only, so it cannot run tests, and judges by reading.
- After the third round the last fix is never reviewed.

The person wants the agent to drive the loop and to read only the result.
Their suites can take hours, so no fixed time limit is acceptable.

## Goals

1. Review rounds start without a person: devloop starts them at the agent's
   stops, and the agent can ask for one during a long turn.
2. Slow test suites run in the background with no time limit; nothing waits
   on them except shipping.
3. The reviewer sees the latest test result for the tree it reviews.
4. When the loop ends, the person gets one plain summary.

## Non-goals

- No change to what the reviewer checks or its read-only limit.
- No change to `maxReviewRounds` (3) or to who may merge.
- No parallel review seats.

## Anti-goals

- The agent grades itself: the agent may only ask for a round; the
  reviewer stays a separate read-only agent in a fresh context.
- Unbounded spend: rounds stay capped, a round never starts on a tree it
  already reviewed, and background runs on stale trees are cancelled.
- A long suite blocks the agent's stop or turn.

## Approaches considered

- devloop starts rounds at stops only: misses long single-turn work (an
  orchestrating agent may not stop for an hour).
- The agent asks through a tool only: depends on the agent remembering.
- **Both (chosen by the person),** plus background tests and the summary.

## Design

### 1. When a round starts by itself (autoReview on)

At every agent stop, after the fast checks (`hooks/review.ts`
`maybeReview`), a round starts when all hold:

- the change is medium or high risk;
- the tree is not the one the last round reviewed;
- the fast checks passed, or none are set, or they could not run (timed
  out): a round never waits on tests;
- rounds remain (`round < maxReviewRounds`) and none is running.

This covers small-fix mode, round 1, later rounds after a fail, and a new
round after a pass when the code changed again. The spec-build trigger and
the push-refusal trigger stay as they are.

### 2. The agent asks: `devloop_review` tool

- New agent tool `devloop_review` (beside `devloop_status`,
  `hooks/register.tsx`), no arguments.
- Starts a round on the current tree under the same rules as §1 (risk,
  not-yet-reviewed tree, rounds remaining, none running); otherwise answers
  why not, in one line (e.g. "This tree was already reviewed in round 2.").
- The rules text the agent sees (`RULES`) gains one line: when a change is
  ready and the turn will run on, call `devloop_review`.

### 3. Background tests

- A verify entry may be `{ "run": "…", "background": true }`. Background
  checks never run inside a hook: when the agent stops on a tree that has no
  result for them, devloop starts them with `$.process.spawn` (no timeout)
  and returns at once.
- One background run per check at a time. A stop on a newer tree cancels a
  run on an older tree and starts again on the new one.
- On finish: the pass or fail is recorded against the tree it ran on (the
  same record the gate reads), output saved like other check output, and the
  agent is told at its next turn (prompt context) and the status bar shows
  `tests running 12m…` → `✓ passed` / `✗ failing`.
- A failing background result on the current tree goes to the agent like a
  failing fast check (a fix round), within `maxFixRounds`.
- Shipping: the gate needs a recorded pass for the current tree. If a run is
  still going, the push is held (enforce) or noted (observe) with "tests
  still running (started 14m ago)"; it never starts a second run.
- `verifyTimeoutSec` keeps its 600 cap for foreground checks; the doctor and
  the config error for a value over 600 say "mark long checks
  `"background": true`".
- Setup's question 2 and the settings popup's Tests row: unchanged in this
  design; a person marks a check background in `devloop.json`.

### 4. The reviewer sees test results

The reviewer's prompt gains a "Tests on this tree" block: each check, pass /
fail / running / not run, with the first failing lines. It says plainly the
reviewer cannot run tests and should not try.

### 5. The summary for the person

When the loop ends (a round passes with nothing open, or the cap is spent),
devloop posts one summary (a toast plus a line in the Dev loop pane's
Activity, and the next prompt context so the agent relays it):

```
Review done: passed in round 2 of 3.
Fixed: F1 slide title, F2 speaker note.
Still open for you: none.  Not reviewed: the last edit after round 3 (1 file).
Tests: ✓ passed on this tree (bash tests/run-all.sh, 41m).
```

"Not reviewed" lists edits made after the last round's tree when no round
remains.

### Rules settled after the builder check (my calls)

1. **Background runs use the live working tree.** The tree hash is taken
   at start. If the tree differs when the run ends, the result is recorded
   as "ran on an older tree": it never counts as a pass for the current
   tree, but a failure is still shown to the agent and the person, marked
   as from an older tree. A new run starts at the next stop. (An isolated
   copy was rejected: ignored dependencies such as `node_modules` or a
   virtualenv are not in a git tree, so suites would fail there.)
2. **A background failure on the current tree** is delivered in the next
   prompt's context and as a toast. In enforce mode, if the agent is idle,
   devloop wakes it with a prompt the way an automatic review does today.
   It never blocks a stop. It counts toward `loop.failedRounds` (the loop
   limit), not toward `maxFixRounds`.
3. **Background checks are their own kind.** They are excluded from both
   foreground profiles (`fast`, `full`) and from `verifyNow`'s run, and are
   started at every stop path, including the covered early exit. They take
   part in the covered-files carry (a pass on the files a check covers
   carries forward). They get no flaky rerun. They go through the same
   command rules, secret handling and `checkEnv` as foreground checks.
4. **`devloop_review`:** refused when `autoReview` is off ("autoReview is
   off: a person starts rounds with /devloop review"), in the spec phase,
   from a reviewer agent, or at the loop limit (`limitRefusal`). It does not
   run or wait on tests. Otherwise the §1 rules apply.
5. **Rounds reset after a pass.** `maxReviewRounds` bounds one review cycle:
   a cycle ends with a pass (nothing open) or the cap. Edits after a pass
   start a new cycle at round 1. "Already reviewed" uses the existing carry
   check (`coverageNow`), not a plain hash comparison, so task-state-only
   changes need no new round. `loop.failedRounds` still stops a runaway.
6. **Summary facts:** each fixed finding is named by the first 60
   characters of its problem text; "Not reviewed" counts files changed
   between the last reviewed tree and the current one (`changedBetween`);
   check records gain `durationMs`. The summary fires once per cycle end:
   pass with nothing open, cap spent, or stalled. "Still open for you" is the
   findings that await a person's decision.

### Rulings after planning (my calls)

7. **"Not reviewed" needs a later post.** At a cycle end the trees always
   match, so the line could never fill. When a cycle ended with the cap
   spent and the tree later moves, the next stop posts one follow-up line
   per tree: `Not reviewed: N files changed after round 3.`
8. **The reviewer may still run foreground verify commands** (unchanged
   today). Only background checks are removed from what it may run, and the
   "Tests on this tree" block says it cannot run those.
9. **Rule 5 governs the cap** (per cycle, reset after a pass), replacing
   "at most `maxReviewRounds` per branch" below; old tests that assume a
   per-branch cap are rewritten. Rule 2 replaces §3's "within
   `maxFixRounds`".
10. **In the build phase** an automatic round still waits for every feature
    to pass (the `devloop_review` tool does not).
11. **Discarded rounds count toward the cycle cap.** A round whose verdict
    arrives after the tree moved is discarded and still uses a round, so
    spend stays bounded; the summary says how many were discarded because
    the code changed during review.
12. **The command-line gate and background checks.** `devloop gate` runs
    background checks (CI has the time). The pre-push git hook from
    `/devloop hooks install` passes `--no-background`: background rows read
    "not checked here (background): CI or the session's background run
    proves it" and do not fail the hook. CI must run the gate without the
    flag.

### One review per change (the person's principle, overrides §1, §2 and rule 5)

The person: "one review on each build, not 8". devloop follows it:

13. **When a round starts by itself:** only when the work is declared
    ready, never at every stop. "Ready" is: the agent calls
    `devloop_review`; a shipping command (push, PR) finds no review of the
    current change (today's `hooks/ship.ts` trigger, now also in observe
    mode: the review starts and the push is not held); or a spec build
    finishes (unchanged). The §1 "every stop" trigger is removed.
14. **The one fix pass:** after a failing round, the next stop that moved
    the tree (fix made; tests passed, none set, or could not run) starts
    the re-review by itself. `maxReviewRounds` default goes from 3 to 2:
    one review plus one check of the fix. A person can raise it in
    `devloop.json`.
15. **After a pass:** later edits mark the review out of date (gate row and
    status bar say so); no round starts until the next "ready" moment of
    rule 13. Rule 5's "edits after a pass start a new cycle at round 1 at
    the next stop" is replaced by this; a new cycle starts at the next
    ready moment. The RULES line for the agent says: call `devloop_review`
    once, when the whole change is done, not after each step.

## Constraints

- `$.process.spawn` children run after the hook returns and end with the
  session or the module; a background run that dies with the session is
  recorded as not finished and restarts at the next stop.
- Review spend: §1 runs at most `maxReviewRounds` rounds per cycle (rule
  5), discarded rounds included (rule 11); `loop.failedRounds` stops the
  agent as today.
- Bundled modules (`hooks/scripts.ts`, gate) changed → rebuild `dist`.
- Checks as before: plugin tests, validate, type check (7-error baseline),
  smoke (no new FAIL lines).
- Release as `0.5.0`.

## Left to the builder

- Exact wording of the tool's refusals and the summary, within the shapes
  above.
- Where in loop state the background run is tracked.
