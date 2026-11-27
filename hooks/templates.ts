// The files setup (typing /devloop) and /devloop spec write, and the words the plugin
// puts in front of the model.

import type { Phase } from '../types'
import type { Strictness } from './setup'

/**
 * The devloop.json setup writes: only what a person is likely to
 * edit. Every other field has a default, listed in the README.
 */
export const configFile = (verify: readonly (string | { run: string; profile?: 'full'; when?: string[] })[], defaultBranch: string, options: { mode?: Strictness; approvals?: { low: number; medium: number; high: number } } = {}): string =>
  `${JSON.stringify(
    {
      mode: options.mode ?? 'observe',
      defaultBranch,
      verify,
      ...(options.approvals ? { approvals: options.approvals } : {}),
      tiers: {
        high: ['**/auth/**', '**/payments/**', '**/billing/**', '**/migrations/**', '.github/workflows/**', 'Dockerfile', '**/*.tf'],
        low: ['**/*.md', 'docs/**'],
      },
    },
    null,
    2,
  )}\n`

export const AGENTS = `# Agent notes

Keep this file under 200 lines. It holds only what cannot be worked out from
the code: delete a line the day the code makes it obvious.

## Checks
The verify commands live in devloop.json; run them before you say work is done.

## Things the code will not tell you
- (a place where the code is misleading, a decision made outside the repository)

## Corrected twice
- (anything a person has had to correct twice goes here, one line each)

## Where to look
- specs/        one folder per change with a spec: SPEC.md and features.json
- REVIEW.md     what the reviewer is told to look for

## Starting cold
The harness keeps the handoff: the agent writes it with the devloop_handoff
tool, and a fresh session's first prompt is briefed from it. A person reads it
with /devloop handoff show.
`

export const REVIEW = `# Review instructions

The harness hands the reviewer this file as the base branch has it, so a
change cannot rewrite its own review. The building agent cannot edit it.

Report only what would make you block the merge:
- behaviour that does not meet the spec or its acceptance checks
- a bug, a missing error path, or a case the tests do not cover and should
- a test that was weakened, deleted or made to pass without the behaviour
- a security problem: unvalidated input, a secret in code, a wider permission
- a change outside what the spec asked for

Do not report style, naming or formatting. Open every file you cite and
confirm the problem is there before you write it down.
`

export const spec = (name: string): string => `# ${name}
Kind: (new feature, integration, change, bug fix or small task) · Size: (full, standard or lite)
Related specs: (the earlier specs this one draws on, or none)

## Intent
(What should be true for the user when this is done, in two or three sentences.)

## Context
- (the files, modules and patterns that matter, found by reading the code)

## Constraints
- (what the change must respect: compatibility, performance, security, data)

## Out of scope
- (what this change deliberately does not do)

## Acceptance criteria
Number each criterion and write it so a tester can decide it yes or no.
Each has a matching entry in features.json with a command that exits 0 only
when the criterion holds, and names it in "criteria" (a feature that covers
criteria 1 and 3 says "criteria": [1, 3]). A criterion no command can decide
ends with (checked by a person), is listed in the notes for the reviewer and
gets no feature. Mark anything undecided with the words NEEDS CLARIFICATION
in square brackets and the question: the spec cannot be approved while one
remains.

1. (criterion)

## Risks and assumptions
- (what could go wrong, and what is assumed without being checked)

## Notes for the reviewer
- (the paths that matter, the criteria checked by a person, what would make this wrong)
`

export const FEATURES = `${JSON.stringify(
  [
    {
      id: 'example',
      description: 'One observable behaviour, written so a test can decide it',
      check: 'npm test -- example',
      criteria: [1],
      dependsOn: [],
    },
  ],
  null,
  2,
)}\n`

export const EVALS = `# Evals

A small regression suite for the harness itself: the instruction files, the
rules in devloop.json, the skills. Each file in evals/tasks/ is one task:

    {
      "prompt": "what to ask the agent",
      "check": "a command that exits 0 only on success",
      "setup": "optional: a command run in the fresh worktree first",
      "solution": "optional: a patch (unified diff) or command that makes the check pass",
      "nearMiss": "optional: a patch or command that comes close and must still fail",
      "expect": { "mustUse": ["Read"], "mustNotUse": ["Write"], "order": ["Grep", "Edit"],
                  "maxToolCalls": 30, "noRefusal": true },
      "tags": ["quick"]
    }

A task counts only once it is valid (/devloop eval validate; a run validates
new and changed tasks first): its check fails on the untouched worktree,
passes after "solution", fails again after a reset, and fails on "nearMiss".
"expect" asserts on what the agent did, from the tool calls the harness saw:
"noRefusal": true is a negative task (the right outcome is that no guard
fired); "refusal": "<rule>" says which guard must fire.

/devloop eval runs each valid task "evalTrials" times with a fresh agent in a
throwaway worktree (or a fresh clone, "evalIsolation": "clone"); a task
passes only if every trial passes. /devloop eval quick runs the tasks tagged
"quick" (or a fixed few). /devloop eval --without <rule | file | skill> runs
the baseline twice and then without it: a difference inside the gap between
the two baselines is "no measurable effect", which is what /devloop prune
needs before deleting anything.

## Composing the suite

- A few golden cases with a fixed input and an exact expected output.
- Mostly real prompts taken from failures (/devloop eval adopt scaffolds a
  candidate under evals/candidates/ from an escaped defect, a review loop that
  ended failed, or a change closed with the gate open), graded on the outcome
  (the check) and the trajectory ("expect").
- A few judged by a person, kept out of the automatic run.
- A healthy suite passes most tasks, not all: a task that passes (or fails)
  every trial across several runs is flagged as outside the useful band. Make
  it harder, or retire it.

Run the suite after changing an instruction file, a rule or a hook, and after
every model upgrade, before deleting anything.
`

/**
 * The section the plugin adds to the system prompt of a repository that
 * opted in. One text, byte for byte, for every repository, phase, mode and
 * policy, for the life of a thread (DESIGN 4.7, principle 7): the prompt
 * cache keeps a thread's prefix only while it does not change. Everything
 * that varies (the verify commands, the hosts, the phase, the gate) reaches
 * the model as context attached to a prompt, as a delta (hooks/context.ts).
 */
export const RULES = `# Development loop (devloop)

This repository runs a gated development loop. A harness enforces the rules
below in code, so working with them is quicker than working around them.
Facts that change (the verify commands, the phase, the gate) arrive as
"devloop" context beside the person's prompts.

- Done means verified. When you stop after changing files the harness runs the repository's verify commands and hands any failure back to you. Run them yourself first and report what they printed.
- Production actions (deploys, \`terraform apply\`, \`kubectl apply\`, publishing) are a person's: hand them the command.
- Call the devloop_status tool to read the gate instead of guessing what is left.
- Tests in small-fix mode (no approved spec): update a test only when your change intentionally alters the behaviour it encodes, say so in your report, and never weaken a test to get green; test changes are shown to the reviewer and a person. While building an approved spec, the approved tests and the spec are locked: make the code pass them, and if a test is wrong, stop and say why; a new test file may be added. Anywhere, adding skip, only, todo or xfail markers to a test, or deleting one, is refused.
- devloop.json, REVIEW.md, specs/*/features.json, .claude/, evals/, git hooks and git config are not yours to edit.
- With an active spec, work on one failing feature at a time. Record a pass with the feature_check tool, which runs the feature's own check. Then commit.
- Starting cold on an active spec: read the cold-start briefing devloop attaches to the first prompt (it carries the end of the last handoff) and the last few commits, run the verify commands, then pick one failing feature.
- When the context fills, or the harness asks, call the devloop_handoff tool: the harness adds the facts, you add the objective, decisions, dead ends and next step.
- A fact you remember, a summary, a memory file or an earlier turn is a lead, not a fact. Before you answer a question about the state of the code, the repository, a system or your own earlier work, and before you act on such a fact, look at the source in this turn: read the file, run the query, list the thing. Say what you checked. What you could not check, name as an assumption. If a question of fact comes up while you work, find out or ask (\`devloop_question\`); do not decide it by guess.
- A question only a person can settle: record it with the devloop_question tool and carry on with what does not depend on it.
- Friction worth fixing (a flag the help lists but the tool rejects, a command that exits 0 on an error, a check that passes for the wrong reason, an instruction that proved wrong, the same error after several tries): file it with the devloop_papercut tool and carry on.
- You never grade or approve your own change; a separate reviewer does. Do not push or open a pull request until the gate is green, and leave merging to a person.
- Push the branch you are on with \`git push -u origin HEAD\`, as its own command: a push of any other shape (a bare \`git push\`, other refspecs or options, \`git -c …\`, a \`GIT_*\` variable on the line) is refused. cache-guard's script is a person's to run, through \`/devloop cache\`.
- Commands that discard work (\`git reset --hard\`, \`git clean -f\`, \`rm -rf\` of the repository) are refused with a safer command named: use that one.
- When a guard refuses something, do not look for another way round it. If you cannot go on, call the devloop_blocked tool with the reason and stop.
- Test what you changed. Run the check that covers the files you touched, not the whole suite, and do not re-run a check that passed on files that have not changed since. After a failure, re-run the check that failed. The harness runs whatever else applies when the change ships.
- After two failed attempts at the same fix, stop and report what you tried.
- Keep each change to one concern.`

/**
 * What the stop gate asks of the builder after a failed check, by phase:
 * tests are editable in small-fix mode (with care, and in the open) and
 * locked while building, so the words differ.
 */
export function fixAdvice(phase: Phase): string {
  if (phase === 'build') {
    return 'Fix the cause in the code. The tests and the spec are locked while building against the approved spec: make the code pass them. If a test is wrong, or the cause is outside what you can change, call the devloop_blocked tool with the reason and stop.'
  }
  if (phase === 'spec') {
    return 'The spec is being written: a check for a feature not built yet is expected to fail, for the right reason. Fix anything else that fails; if what is left is the expected red, say so in your report and stop.'
  }

  return 'Fix the cause. Update a test only when your change intentionally alters the behaviour it encodes, say so in your report, and never weaken a test to get green: test changes are shown to the reviewer and a person. If the cause is outside what you can change, call the devloop_blocked tool with the reason and stop.'
}

export const REVIEWER_BRIEF = `You are reviewing a change you did not write and whose reasoning you have not seen. You are read-only: report problems, never fix them.`

/** The built-in brief of a specialist reviewer named \`security\` that brings no prompt of its own. */
export const SECURITY_BRIEF = `You are the security specialist reviewer. Report only security problems the change introduces: input that reaches a query, a shell, a path, a template or a deserializer without validation; authentication or authorization that can be skipped or widened; secrets or credentials in code, logs or errors; cryptography used wrongly (home-made schemes, weak hashes for passwords, predictable tokens, missing integrity checks); new network exposure, wider file or process permissions, unsafe defaults; a dependency added without need. Leave correctness, style and design to the general reviewer.`
