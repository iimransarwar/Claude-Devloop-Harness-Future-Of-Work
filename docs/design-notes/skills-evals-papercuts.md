# Design note: skills, evals and papercuts

Source: Uber Engineering, "How Uber Evals 1 Million Agent Skill Invocations a
Month" (November 2026). Ideas only. Uber's problem is thousands of skills
across a company; devloop's is one repository and a small team, so the
marketplace, tiering and distribution parts do not apply. What does apply is
how they find out whether an instruction earns its place, and how agents
report friction. This note is the system of record for these features until
they are folded into docs/DESIGN.md; they belong to phase C (4.7, 4.8, 4.9).

## Adopt

### 1. Papercuts: the agent files its own friction reports
An always-registered tool, `devloop_papercut`, with fields `tried`,
`expected`, `happened`, `suggestedFix`, and an optional `subject` (a skill,
tool, check or file). It never blocks and never ends the turn; it is distinct
from `devloop_blocked`, which does. The rules section tells the agent when to
file one: a flag the help text lists and the tool rejects, a command that
exits 0 on an error, a check that passes for the wrong reason, an instruction
that turned out to be wrong, the same error after several attempts.

- Stored in the ledger under kind `papercut`, grouped by subject and a
  fingerprint of `happened`.
- `/devloop papercuts` lists groups by count; `/devloop learn` includes them.
- A papercut is closed by a person (`/devloop papercuts close <id> <note>`)
  and the close records what fixed it; a group that reappears after being
  closed is flagged as a regression.
- Rate-limited per turn so a struggling agent cannot flood the ledger.

*Prevents:* friction that every session rediscovers and silently works
around, paying for it in tokens each time. *Remove if:* reports are filed but
none leads to a fix over a quarter.

### 2. Skill and instruction linter
Doctor lints every `SKILL.md` under the `instructions` globs, pass or fail per
check:
- the description says when to use the skill and is short enough to be loaded
  always (about 100 tokens);
- the body is under 500 lines; bulky material is in referenced files;
- steps are numbered and each has one objective and a way to verify it;
- each step gives a concrete command and says what result to check before the
  next step;
- there is an error-recovery section: a table of failures and their fixes
  ("try again" does not count);
- deterministic steps that never vary are scripts, not prose (advice, not a
  failure);
- the skill folder ships no `.mcp.json` (a skill must not install tool
  servers).

### 3. Evidence that an instruction earns its place
Extends the eval subsystem (DESIGN 4.8):
- **Ablation with a noise band.** `/devloop eval --without <skill|rule|file>`
  runs the suite with and without the thing. Before any difference is
  reported, the baseline is run twice and the gap between identical runs is
  the noise band; a difference inside it is reported as "no measurable
  effect". That result is the evidence prune asks for.
- **Saturation warning.** A task that passes every trial across the last
  several runs is flagged as saturated: it no longer tells good from bad and
  should be made harder or retired. A healthy suite passes most, not all.
- **Trajectory assertions.** A task may assert on what the agent did, not
  only on the outcome: tools or skills that must appear, must not appear, an
  order, a maximum number of calls. Recorded from observed tool calls.
- **Suite composition guidance** in `evals/README.md`: a few golden cases with
  fixed input and expected output; mostly real prompts taken from failures and
  graded on outcome and trajectory; a few judged by the author.
- **Clean-room option.** `evalIsolation: "worktree" | "clone"`. A fresh clone
  catches dependence on untracked files, caches and local tooling that a
  worktree shares with the author's checkout.
- **Failures feed the suite.** `/devloop defect`, a review that failed, and a
  change a person closed with the gate open each offer to scaffold an eval
  task candidate under `evals/candidates/` for a person to accept.

### 4. Cost attribution by delta
The session's running cost estimate is sampled before and after units of work
and the difference attributed: per skill invocation (the `Skill` tool call
and the turns up to the next person prompt), per feature, per fix round, per
review round. Shown in metrics and the change record, always labelled an
estimate. Per-skill use counts, error-after-use counts and cost feed prune:
a skill never invoked, or one that costs more than it saves under ablation,
is a deletion candidate.

### 5. Code over model, and workers on cheaper models
- Doctor reports how many tool definitions are loaded and an estimate of
  their tokens, and warns past a threshold: a large always-loaded tool list
  is paid for on every request.
- Policy gains `models: { reviewer?, specialist?, eval? }` so review and eval
  agents can run on a cheaper model; the default is the session's. Their
  answers come back bounded (the structured findings, not the transcript).
- The harness's own deterministic work stays in code and its bulky results go
  to files with a short summary to the model (already principle 7 and the
  "full check output to a file" item in DESIGN 11).

### 6. Privacy of measurements
Ledger and metrics record keys, counts, fingerprints and the first line of a
failure. No prompt text and no file contents. `/devloop metrics --json`
exports exactly what is stored, for a team that wants its own dashboard.

## Not adopted
- A marketplace, skill tiers, a distribution command-line tool, per-role
  personas, organisation-wide skill discovery and ranking: these solve
  thousands of skills across many agents, which is not this product.
- Compiling SKILL.md from a spec per model family: devloop is spec-first for
  code changes; doing the same for skills is ceremony at this scale.
- A model as blind judge by default: judging is opt-in per eval task and
  needs a person's annotated examples; outcome checks and trajectory
  assertions are the default because they are deterministic.
