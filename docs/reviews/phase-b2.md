# Review of Phase B2, and the decisions taken

Third round, fresh context, read-only, on commit `cc316c2`. Verdict **FAIL**
on two high findings, both in the new review subsystem: the part of the
harness that judges changes could itself be made to pass a change a reviewer
had failed. Every finding was reproduced with the pure functions or with
probe tests. One further finding (L1) came from a live session.

The rule that settles most of this, adopted here as a principle for the whole
harness: **fail safe, never fail useful.** Anything the harness cannot read or
resolve confidently counts as blocking. A gate is met only on positive
evidence.

## High

**F1. A finding the parser could not read was dropped, and the round passed
although the reviewer said FAIL.** A missing field, an unknown severity word,
a heading mark, prose-only findings, even "I could not open the diff file"
all ended as "review passed" and the push was allowed.
*Decision:* a round passes only on positive evidence: a verdict line, every
finding-like line parsed, and no open blocking finding. A reviewer verdict of
FAIL with no readable blocking finding is a format failure: restated once; if
still unreadable the harness raises a `decision` finding ("the reviewer failed
this change and gave no readable finding") that blocks until a person resolves
it. The same holds for the restatement path.
*Fixed when:* an answer ending `VERDICT: FAIL` with prose only, with a
five-field line, an unknown severity or no line number never settles as
passed, and the push is refused.

**F2. A `|` in the problem text moved part of it into the quote, the quote
check failed, and a real finding was demoted to a note.**
*Decision:* the parser tries each way of splitting the remaining fields and
keeps the one whose quote is found in the file. Quotes are normalised before
checking: a leading diff mark (`+`, `-`), backticks, surrounding whitespace
and runs of spaces are ignored; `file:line:col` and a backticked file name
are accepted. A finding of blocking severity whose quote still cannot be
found is not demoted: after the one restatement it becomes a `decision`
finding for a person. Only non-blocking severities are demoted to notes.
*Fixed when:* a problem containing `string | null` or `a || b`, on a line
that exists, stays open and blocking; a `+`-prefixed quote verifies.

## Medium

**F3. A test file created while building was not judged at creation**, so a
new file with `.only`, a `TestMain` that exits, or a module-level skip was
allowed. *Decision:* a new test file is judged with a before-count of zero;
focus markers and runner overrides in it are refused like any rise.

**F4. An open blocking finding blocked only through the row of a reviewer
that still applied**, and not at all below medium tier. *Decision:* the review
row is unmet at every tier while any finding is open and blocking, whoever
raised it. Findings from a specialist that no longer applies are passed to the
general reviewer for re-check.

**F5. Approval hashed the spec after the dialog**, so the spec could be
changed while the person was deciding. *Decision:* the fingerprint and test
hashes are those of the text the checks ran on; the files are read again
after the dialog and approval is refused if they changed.

**F6. Approval ran builder-written checks before the person answered, judged
by none of the command rules.** *Decision:* every feature check is judged by
the command rules before it is ever run, at approval and in `feature_check`.
A check that would be refused as a shell command is not run; the dialog lists
it with the rule, and approval is refused while any check is refused. The
dialog shows each check's command, shortened.

**F7. The folder probe undid the new-test allowance and exact-path
exemptions** under `tests/`, `test/` and `__tests__/`. *Decision:* the probe
applies to directory operands only, never to a file path.

**F8. `model.fit(X, y)` was read as a focused test.** *Decision:* focus and
skip markers match only at the start of a call, never after a dot or an
identifier character.

**F9. Anything under a test folder counted as a test**, so removing caches
and logs was refused. *Decision:* for the deletion and weakening rules a file
is a test only if it matches the test globs **and** git tracks it. Untracked
and ignored files under a test folder are not tests.

**F10. The generic credential shape missed unquoted assignments and fired on
identifiers.** *Decision:* environment, YAML and ini assignments are covered;
the key must *end* in a credential word (so `tokenizer`, `token_url`,
`password_regex`, `secretName` do not match); the value must clear an entropy
floor and not be a URL, a path, a pattern or an upper-case constant name. A
private-key header counts only as a line of its own. Anything deliberately
left out goes in the residual-risk register with a test.

**L1 (live session). A provider-prefixed token of the right length was
skipped because its characters looked hand-written.** *Decision:* for a
recognised prefix and exact length, only obvious placeholders are skipped (a
single repeated character, `example`, `placeholder`, `your`, `xxxx`).

**F11. A shadow specialist could hold or drop a round.** *Decision:* a round
settles when the general and blocking reviewers have answered. A shadow
reviewer's answer is counted when it arrives; its abort or silence changes
nothing.

## Low

**F12.** An exemption was recorded as used by any call on a matching path, a
read included, and never cleared. *Decision:* use is recorded only for a
write the exemption actually lifted a rule for, as the concrete path, and the
record is cleared at approval and at done.

**Cut by the reviewer's cap, also fixed:** the cap of twelve is applied after
quote verification with `pre_existing` ranked last; outside git the
credential row reads "not scanned" and is unmet for medium and high tiers; a
missing test-hash record at approval leaves the tests row unmet, not absent;
an infrastructure outcome is decided by exit code, never by the output text
alone.

## From the builder's own notes

- The stop gate's automatic review reads `autoReview` from the policy in
  force (the base's), like the rest of the review settings.
- Test hashes are computed with the `tests` globs of the policy in force.
- The diff's path moves from the stable part of the reviewer prompt to the
  current-facts part.
