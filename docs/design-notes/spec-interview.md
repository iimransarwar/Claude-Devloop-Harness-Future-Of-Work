# Design note: a spec interview

Asked for by the repository owner, after reviewing a company-specific skill
(an interview that writes a "structured intent specification"). The owner
wants a generic version, with nothing tied to one company, product or
locale. The good ideas taken from it:

- interview before writing, in rounds scaled to the size of the work;
- ask only about the gaps when the person gives detail up front;
- read earlier specs of similar work first, and reuse what they settled;
- keep unknowns marked, never guessed;
- acceptance criteria a tester could decide without asking.

What is not taken: copying meeting notes, emails and data pulls into the
repository; a spreadsheet index kept in step by a script; a central index
file; company terms, client lists and spelling rules.

devloop adds the one thing the original lacks: every acceptance criterion
ends as a command that fails now and must pass when the work is done.

This note is the system of record. The skill's name is `devloop:spec`.

## Decisions

### 1. A plugin skill
`skills/spec/SKILL.md` in the plugin, with its reference files beside it
(`skills/spec/references/`). It must pass devloop's own skill audit
(`/devloop doctor`): a description of at most 400 characters that says when
to use it, under 500 lines, numbered steps with the commands to run and what
to check, an error-recovery table, no `.mcp.json`. Long material (the
question bank, the sections per kind of work) goes in the reference files,
read only when needed.

### 2. When it is used
`/devloop spec <name>` already tells the agent to fill the spec with the
person. That context line now says to follow the `devloop:spec` skill. The
skill can also be used on its own ("let's spec this out"), and then starts by
asking the person to run `/devloop spec <name>`, since only the person's
command opens the spec phase and only the spec folder and tests can change
in it.

### 3. Earlier specs first
Before asking anything, the agent lists `specs/*/SPEC.md` and reads the
intent line and the criteria of each; it reads in full the one to three
closest to the new work (same area of the code, same kind of work, shared
files). It tells the person which ones it used and what it took from each
(scope lines, criteria, checks, risks). No index file is kept: the specs in
the repository are the index, so nothing goes stale.

### 4. Look before asking
What the repository can answer, the agent finds out by reading it: the files
and modules involved, the patterns already used, the test framework and how a
single test is run, the existing checks in `devloop.json`. It asks the person
only what the code cannot say: intent, priority, scope, the decisions. This
is the grounding rule applied to specs.

### 5. Kind and size of work
Five kinds, chosen from the person's words and confirmed in one question:

| Kind | Size | Rounds |
| - | - | - |
| New feature | full | 3 |
| Integration (another system, an API, data moving across a boundary) | full | 3 |
| Change to existing behaviour | standard | 2 |
| Bug fix | standard | 2 |
| Small task (a refactor with no behaviour change, a config change, a chore) | lite | 1 |

Full: round 1 intent, who it is for, scope in and out; round 2 constraints
(compatibility, performance, security, data), and for an integration the
source of truth, the data mapping and what happens on failure; round 3
acceptance criteria, edge cases, risks and assumptions. Standard: round 1
intent and scope (for a bug: the steps to reproduce, expected and actual
behaviour, where it happens); round 2 acceptance criteria and risks. Lite: one
round: what, what not, how we know it is done.

Each round is one question to the person with a few questions grouped, using
the ask-the-person tool where the session has one. A person who gave the
detail up front is asked only about the gaps.

### 6. The spec written
`SPEC.md` gains sections beside the ones it has. The template the harness
writes (`/devloop spec`) becomes:

```
# <name>
Kind: <kind> · Size: <full|standard|lite>
Related specs: <names, or none>

## Intent
## Context            (files, modules and patterns that matter; found by reading)
## Constraints
## Out of scope
## Acceptance criteria
## Risks and assumptions
## Notes for the reviewer
```

A lite spec may leave Context, Constraints and Risks as one line each. An
unanswered item is written `[NEEDS CLARIFICATION: <the question>]`, which
the harness already refuses to approve.

Acceptance criteria are numbered and binary. Counts by size: full 5 to 15,
standard 3 to 8, lite 1 to 3. For a bug fix the first criterion is the
reproduction: the failing case, as a test.

### 7. From criterion to check
Every criterion is covered by an entry in `features.json` whose `check` is a
command that exits 0 only when the criterion holds, naming the criterion in
`criteria`. The agent writes the tests the checks run, runs each check, and
confirms it fails for the right reason (the behaviour is missing, not a typo
or a missing file). A criterion that cannot be decided by a command (a look,
a person's judgment) is kept in SPEC.md, marked `(checked by a person)`,
and listed in Notes for the reviewer; it gets no feature. The harness
already lists criteria no feature covers in the approval dialog.

### 8. Self-check, then hand to the person
Before asking the person to approve, the agent checks the spec against a
short list scaled by size (sections filled, criteria binary and within the
counts, every criterion covered or marked, every check run and failing for
the right reason, no marker left unless the person chose to leave it), and
shows the person the result in a few lines. Then it asks them to read the
spec and run `/devloop approve`.

### 9. What changes in the harness
Only text: the skill's files, the context line `/devloop spec` adds, and the
`SPEC.md` template. The spec checks the harness runs (`hooks/spec.ts`) are
unchanged; the new header lines and sections are not required by them, so
older specs stay valid. Doctor reports the skill as passing its own audit.

### 10. What this does not do
It does not judge whether a criterion is the right one, or whether a check
tests what its criterion says; the person's reading at approval and the
review do that. It does not search outside the repository for earlier work.
