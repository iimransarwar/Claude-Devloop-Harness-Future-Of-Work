# Design note: coordinating more than one agent

> **Folded into docs/DESIGN.md (D2).** Decisions 3 and 4 were built in C2 (DESIGN 5); decisions 5, 6 and 7 are built as DESIGN 4.12 describes, which is now the system of record. Differences: the scoping of edits to the files a feature lists (decision 5's last sentences) is not built, since features list no files (RESIDUAL-RISK A17). This note is kept for its reasoning.

Sources: Vercel, "Introducing Vercel Board" (November 2026); the `.tasks`
convention v2 specification (overview page; full analysis pending). Ideas
only. This note was the system of record for these features until they were
folded into docs/DESIGN.md.

## The problem

devloop today coordinates one builder, its reviewers and its eval agents
inside one session. Three things it does not have:

- a place where work that outlives a session is listed, claimed and handed
  over, so a second agent or a second person knows what is taken and what is
  ready;
- a record of who did what that a teammate or a CI job can read without the
  first machine's plugin store;
- a way to follow something up later without a model sitting in a polling
  loop.

Vercel Board solves these with a hosted message store: channels and threads,
tasks that are claimed under a lease and renewed, dependencies that make a
review task available when its fix is complete, messages validated against a
versioned schema, grants per person and agent with an audit trail, scheduled
follow-ups and watchers that wake an agent on an event. The `.tasks`
convention solves the first two with files in git: task directories, a fixed
lifecycle, start and finish gates, claims with heartbeats and takeover, and a
mandatory resume point on exit.

## Decisions

### 1. No hosted dependency
devloop does not depend on a hosted board, and does not install one. A
harness that guards a repository should work offline and leave nothing
outside the repository and the plugin store. What follows takes the ideas and
keeps the substrate local. (If a team runs a board, section 3's schemas are
what would be posted to it.)

### 2. Task state on disk: decision pending the `.tasks` analysis
The open question is whether devloop adopts the `.tasks` v2 format for task
and handoff state, integrates with it at two edges (its finish gate is
devloop's gate; its exit protocol is enforced at devloop's stop gate), or
keeps its own `specs/` and `PROGRESS.md`. The dividing line is already
decided whichever way that goes:

- **Work state and narrative** — what to do next, the plan, the resume point,
  the log — are files a person can edit.
- **Verdicts** — verified, approved, reviewed, feature passes — stay in
  plugin state the building agent cannot write.
- **Transitions an agent may write are guarded**: an agent cannot move a task
  to done unless the gate is green, and cannot leave claimed work without a
  resume point.

### 3. Versioned record schemas
Every record devloop produces has a named, versioned schema and is validated
when written: `finding@1`, `papercut@1`, `handoff@1`, `change-record@1`,
`eval-result@1`, `gate@1`. Schemas ship in the repository (`schemas/`). A
reviewer's answer that does not parse into `finding@1` rows is a format
failure the reviewer is asked to correct once, not free text the builder must
interpret. Other tools, a CI job, or a board read fields, not prose.

### 4. An audit trail with actors
An append-only log, kept outside the working tree, of every action that
changes what may ship: who approved a spec, who granted an exemption and for
what, who closed a change with the gate open, each review verdict and the
tree it covered, each refusal in enforce mode. The actor is a person (as far
as the engine reports the origin), the builder, or a named agent. `/devloop
audit` prints it; the change record cites it.

### 5. Claims with leases, for more than one agent in a repository
A unit of work (a spec's feature, or a task if `.tasks` is adopted) is
claimed by a session under a lease that expires unless renewed by activity. A
second session sees it as taken; an expired claim can be taken over, and the
takeover is logged. The guards scope a claimant's edits: while another
session holds a feature, edits to the files that feature lists are refused to
everyone else with the claimant named. This is what makes parallel builders
in separate worktrees safe; with a single builder it is invisible.

### 6. Follow-ups in code, not in the model
After the harness sees a successful `gh pr create` or `git push`, it can
watch the result itself: a timer in the plugin polls check status and review
comments with `gh`, and the model is woken only when something needs it — a
failing check (with the distilled log), a requested change, or all checks
green. Policy: `followUp: { ci: true, intervalSec: 120, timeoutMin: 60 }`.
No model turn is spent on waiting. A watch ends when the change is closed,
the timeout passes, or the session ends; a later session resumes it from the
stored record.

### 7. Dependencies gate what is ready
Features already carry `dependsOn`. The status tool and the cold-start
briefing list what is *ready* (dependencies passing, unclaimed), not just
what is failing, so an agent starting cold picks work that can start.

## Not adopted
- A hosted message store, channels and threads, two-way sync with chat tools,
  and watchers that wake deployed agents: these belong to a platform, not to
  a repository harness.
- Agent swarms as a default way of working. More builders multiply cost and
  conflicts; the research this project started from found writes are best
  kept single-threaded. Claims exist so that parallel work is safe when a
  person chooses it, not to encourage it.
