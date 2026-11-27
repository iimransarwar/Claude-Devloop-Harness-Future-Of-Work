---
name: spec
description: Interview the person and write a devloop spec (SPEC.md and features.json) whose every acceptance criterion ends as a check that fails now. Use when /devloop spec has opened a spec, or when the person wants to spec out, scope or write up the requirements for a change before it is built.
---

# Write a spec with the person

You fill `specs/<name>/SPEC.md` and `specs/<name>/features.json` with the
person, then hand the spec to them for approval. You do not build anything.

The spec phase is opened by the person's `/devloop spec <name>`. While it is
open, only the spec folder and test files can change. The harness refuses
approval while the template's placeholders or a `[NEEDS CLARIFICATION: …]`
marker remain, and lists criteria no feature covers.

Read `references/questions.md` when you reach step 4: it holds the questions
for each kind and size of work. Read `references/example.md` when you write
the spec in step 6, or whenever you are unsure what a finished spec and its
features look like.

## Steps

1. Confirm the spec phase is open. Call the `devloop_status` tool and check
   that it reports the spec phase and the spec's name. If it reports another
   phase, or no spec, ask the person to run `/devloop spec <name>` with a
   short name for the change, and wait. Then read the template the harness
   wrote with `Read` on `specs/<name>/SPEC.md`.

2. Read the earlier specs before you ask anything. List them with `Glob`
   on `specs/*/SPEC.md`, leaving out the one you are writing. For each, read
   the intent and the acceptance criteria. Pick the one to three closest to
   the new work (the same area of the code, the same kind of work, shared
   files) and read each in full, with its `features.json`. Then search the
   spec library, the approved specs saved from this project and others:
   call the `devloop_library` tool with a few words for the new work (the
   area, the kind of change, the behaviour). For each entry close to the new
   work, read the `SPEC.md` and `features.json` in the folder it names. Tell
   the person which earlier specs you used, naming each one's project, and
   what you took from each: a scope line, a criterion, a check, a risk.
   Write their names on the `Related specs:` line, with the project for one
   from another project (`<project>/<name>`). If there are none, write
   `Related specs: none` and say so.

3. Look before you ask. Find out from the repository what it can tell you,
   with `Grep`, `Glob` and `Read`: the files and modules the change touches,
   the patterns the code already uses for this kind of thing, the test
   framework, and the verify commands under `verify` in `devloop.json`.
   Find how one test is run on its own (the test script in `package.json`,
   `pyproject.toml`, a `Makefile`, the CI config), then run one existing
   test that way with `Bash` and check it passes. Write what you found under
   `## Context`. You now ask the person only what the code cannot say:
   intent, priority, scope and the decisions.

4. Choose the kind and size of work from the person's words, then confirm
   it with one question (`AskUserQuestion` where the session has it):

   | Kind | Size | Rounds |
   | - | - | - |
   | New feature | full | 3 |
   | Integration (another system, an API, data across a boundary) | full | 3 |
   | Change to existing behaviour | standard | 2 |
   | Bug fix | standard | 2 |
   | Small task (refactor with no behaviour change, config, chore) | lite | 1 |

   Write the answer on the `Kind: … · Size: …` line. Open
   `references/questions.md` at the section for that kind and size.

5. Interview in rounds. Each round is one `AskUserQuestion` call that groups
   a few questions from `references/questions.md`. Before each round, check
   what the person already told you and what step 3 found, and leave those
   questions out: ask only about the gaps. If the person gave the detail up
   front, a round may need one question or none. After each round, write the
   answers into the spec before the next round. When the person does not
   know an answer, write `[NEEDS CLARIFICATION: <the question>]` where the
   answer belongs, and go on. Do not guess an answer for them.

6. Write `SPEC.md` with `Edit`. Fill every section of the template: Intent,
   Context, Constraints, Out of scope, Acceptance criteria, Risks and
   assumptions, Notes for the reviewer. A lite spec may give Context,
   Constraints and Risks one line each. Replace every placeholder line in
   parentheses. Check the acceptance criteria:
   - numbered (`1.`), one behaviour each, decided yes or no by a tester who
     cannot ask you;
   - within the count for the size: full 5 to 15, standard 3 to 8, lite 1
     to 3;
   - for a bug fix, criterion 1 is the reproduction: the failing case, as a
     test;
   - a criterion no command can decide (a look, a person's judgment) ends
     with `(checked by a person)` and is listed under Notes for the
     reviewer.

7. Write `features.json` with `Write`. Replace the `example` entry. Give
   every criterion not checked by a person at least one feature: an `id`, a
   `description`, a `check` command that exits 0 only when the criterion
   holds, and the criterion numbers in `criteria`. Use `dependsOn` only when
   one feature cannot pass before another does. Check the file is valid JSON
   by reading it back with `Read`.

8. Write the tests the checks run, then confirm each check fails for the
   right reason. Put the tests where the repository keeps its tests, in its
   test framework. Run every `check` with `Bash` and read the output. A
   right failure says the behaviour is missing: an assertion fails, an
   expected value is absent, a route answers 404. A wrong failure is a
   typo, a syntax error, an import of a file that does not exist yet, a
   command not found, or a test the runner never found. Fix wrong failures
   until each check fails only because the behaviour is not built.

9. Check the spec yourself before you hand it over. Use `Grep` on the spec
   folder for `NEEDS CLARIFICATION` and for the placeholder lines, and
   confirm each of these:
   - every section is filled (lite: Context, Constraints and Risks may be
     one line);
   - every criterion is binary, and the count is within the size's range;
   - every criterion is covered by a feature or marked `(checked by a
     person)`;
   - every check was run in step 8 and fails for the right reason;
   - no `[NEEDS CLARIFICATION: …]` marker is left, unless the person chose
     to leave it for now (approval stays refused while one remains).

10. Hand the spec to the person. Show the result of step 9 in a few lines:
    the kind and size, the number of criteria and features, the criteria
    checked by a person, any question still open. Then ask them to read
    `specs/<name>/SPEC.md` and run `/devloop approve`. Stop there: building
    starts only after the person approves.

## Error recovery

| What happens | What to do |
| - | - |
| `devloop_status` shows no spec phase | The person has not run `/devloop spec <name>`. Ask them to run it, suggest a short name, and wait. Only their command opens the phase. |
| An edit is refused with `spec-first` | The file is neither in the spec folder nor a test file. Put test helpers under the test folder; leave other changes to the build, and note them under Context. |
| A check passes before anything is built | The check does not test the new behaviour (it is vacuous). Make the test assert what the criterion says, run it again, and confirm it fails. |
| A check fails for the wrong reason | Read the output. Fix the typo, the path or the command in the test or the check, not by building the feature. Run it again and confirm the failure names the missing behaviour. |
| The person does not know an answer | Write `[NEEDS CLARIFICATION: <the question>]` in the spec. Offer to record it with `devloop_question` so it is not lost, and go on with the rest. |
| No earlier specs exist | Write `Related specs: none`, say so in one line, and rely on step 3. |
| No test framework is set up | Tell the person. Either they set one up as its own small change first, or the checks use plain commands that need none (a script under the test folder that exits 1 while the behaviour is missing). Do not add a framework in the spec phase. |
| The person wants to start building | Explain that the spec and tests are locked only at approval, and ask them to run `/devloop approve` once they have read the spec. |
