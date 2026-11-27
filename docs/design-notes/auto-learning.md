# Design note: learning without being asked

Asked for by the repository owner. Today the ledger records every failure by
itself, but nothing is done with the repeats until a person types
`/devloop learn`, and a proposed rule takes effect only when a person writes
it into `devloop.json`. The owner's request, in four parts:

1. Learn runs by itself.
2. Lessons write themselves.
3. New rules start in trial mode automatically.
4. A person only promotes.

One thing is deliberately not automated: a rule never becomes blocking
without a person. An agent that turns its own proposals into blocking rules
is writing its own policy.

This note is the system of record for the feature. Its name in the policy
and in the code is `learning`.

## What exists and is reused

- The ledger and its repeat groups (`hooks/ledger.ts`): refusals, failed
  checks by fingerprint, findings by file, papercuts, lessons.
- Content rules (`rules` in `devloop.json`, `hooks/contentrules.ts`): a
  pattern checked against the lines an edit adds to files its globs match,
  with action `note`, `refuse` or `ratchet`, hit counts and last-fired times.
- `/devloop learn` (the list of repeats and the ladder of fixes),
  `/devloop prune` and its tombstones, `/devloop lesson`.
- The way the harness starts a read-only reviewer agent and reads a fixed
  line format back.

Where the code already does what a decision asks, it is kept and a test
shows it.

## Decisions

### 1. Lessons write themselves
The harness records a lesson (ledger kind `lesson`, marked `auto`) from facts
it already holds, with no model involved, when:

- the loop limit stops the agent: the branch, the number of failed rounds,
  the checks that failed and the file named most often in the findings;
- the same check fails twice in a row with the same fingerprint (the case
  where the agent is already told its fix changed nothing): the command and
  the first error line.

One lesson per key: the same event again raises its count instead of adding
an entry. `/devloop lesson <text>` stays, for what the harness cannot see.

### 2. Learn runs by itself
A *proposer* run is started by the harness, never by the builder, when:

- a repeat group reaches `learning.repeats` occurrences (default 3) and has
  no proposal, trial rule or tombstone yet. The run is started at the end of
  the turn in which that happens, not in the middle of it;
- a change closes (`/devloop done`) while such a group exists.

The proposer is a separate agent with a fresh context and read-only access,
started the way the reviewer is. It is given the repeat groups (key, count,
label, the stored samples) and the ladder of fixes, and answers one line per
proposal:

```
P<n> | <group key> | rule | <glob>[,<glob>…] | <pattern> | <why> | <eval task in one line>
P<n> | <group key> | instruction|path-rule|test|skill | <file> | <the exact text to add> | <why> | <eval task in one line>
```

The harness reads the lines; one that does not fit is dropped and counted.
Nothing the proposer writes reaches the builder's context: its text is shown
to the person only.

Cost is bounded: one run handles every pending group; at most
`learning.maxRuns` runs per session (default 3); no run while the session's
budget (`budgetUsd`) is spent, while a review is running, or on a turn no
person started. A proposer run is not a round and does not count toward the
loop limit. The model is `models.learner` (null: the session's).

The person is told once per run: a toast ("devloop: N proposals waiting:
/devloop learn") and an entry in the Activity tab. `/devloop learn` now opens
with the waiting proposals (each with its exact text and its evidence) and
the trial rules with their hits, and then lists the repeats as before. Typed
by a person it still starts a run on demand.

### 3. Proposed rules start on trial
A `rule` proposal becomes a *trial rule* at once, with no person involved,
when it passes all of these; otherwise it stays a waiting proposal with the
reason:

- the pattern and globs pass the same validation a content rule in
  `devloop.json` passes, and the pattern is at most 200 characters;
- it is not too broad: across the tracked files its globs match it matches
  at most 200 existing lines;
- fewer than `learning.maxTrial` trial rules exist (default 20);
- no tombstone names the group or the rule.

A trial rule is a content rule with the action `note`, kept in the harness's
own state for the repository, never in the working tree. It is checked where
content rules are checked, records a hit as a content rule does (the rule,
the path, the line number and a fingerprint, never the line) and **refuses
nothing, says nothing to the builder and adds nothing to its context.**
A trial rule with no hit for `pruneWindowDays` is removed by itself and
tombstoned, so it is not proposed again unless the failure returns.

The other kinds of proposal (an instruction line, a path-scoped rule, a test,
a skill) change files the builder may not edit, or what the model is told.
They are never applied automatically: they wait, with their exact text, for
the person.

### 4. A person only promotes
When a trial rule reaches `learning.promoteHits` hits (default 3) the person
gets one toast: "devloop: trial rule <id> would have caught N edits:
/devloop rules promote <id>". Once per rule.

Commands, all a person's:

- `/devloop rules`: trial rules (pattern, globs, why, hits, last hit),
  promoted rules, and waiting proposals.
- `/devloop rules promote <id>`: a dialog with the pattern, the globs, the
  why and each hit (path and line number). On confirmation the rule becomes
  blocking (`refuse`) at once on this machine, from the harness's state, and
  the command prints the JSON entry to add to `rules` in `devloop.json` so it
  holds for everyone and at the stateless enforcement points. When the base
  branch's policy has a rule with the same id, the state copy is dropped.
  Audited.
- `/devloop rules drop <id> <reason>`: removes a trial or promoted rule or a
  waiting proposal and writes a tombstone. Audited.

A promoted rule from state behaves as a `refuse` content rule does (same
refusal text shape, same lift class, same hit counting). It only ever adds a
refusal.

### 5. Policy
```json
"learning": { "auto": "trial", "repeats": 3, "promoteHits": 3, "maxTrial": 20, "maxRuns": 3 }
```
`auto` is `off` (nothing in this note happens by itself; `/devloop learn`
works as before), `propose` (decisions 1 and 2: lessons and proposals, no
trial rules) or `trial` (the default: all of it). `repeats` and
`promoteHits` are whole numbers from 1 to 100. Read from the base branch like
every policy field. In a repository with no policy the feature is dormant.

### 6. Enforcement points
The module does all of this. The classic hooks and the command line keep
nothing between calls: they neither start a proposer nor know a trial or
promoted rule until it is written into `devloop.json`. Doctor reports the
mode in force, the number of trial and promoted rules and of waiting
proposals, and names each promoted rule that is not yet in the policy.

### 7. What this does not do
A trial rule's hits count matches, not mistakes: three hits say the pattern
fires, not that it is right. Promotion is the person's judgment, and the
dialog shows the hits so it can be made. A failure that no pattern on added
lines can describe gets a waiting proposal, not a rule. The proposer is a
model reading failure samples, which can hold text from tool output: the
worst a bad proposal can do is a trial rule that records hits. Both limits go
into the residual-risk register.

## Tests the build must add
Module tests for the new behaviour only: the two automatic lessons and their
deduplication; the trigger at `repeats` and at `/devloop done`, once per
group, never mid-turn, never past `maxRuns` or the budget; reading the
proposal format (good lines, a bad line dropped and counted); each gate on a
trial rule (validation, too broad, `maxTrial`, tombstone); a trial rule
recording a hit and refusing nothing and adding nothing to the builder's
context; removal after `pruneWindowDays`; the promotion notice once at
`promoteHits`; `/devloop rules promote` refused for an agent caller, blocking
after a person's confirmation, dropped when the base policy has the id;
`/devloop rules drop` and its tombstone; `auto: off` and `propose`; old
stored state read as fresh.
