# Design note: what we take from `morluto/rea` and the `.tasks` convention

> **Folded into docs/DESIGN.md (D2).** The rea ideas were built in B2 to C2; the `.tasks` integration is built as DESIGN 4.12 describes, which is now the system of record. Overridden: `.tasks/**` is **not** left out of the verified hash (principle 9); a review verdict carries over across task-state-only changes instead, and verification always re-runs. Not built: the briefing from `tasks resume`, the handoff through `tasks state`, the heartbeat around harness-run checks, offering `tasks done --as <person>` at `/devloop done`. This note is kept for its reasoning.

Sources examined read-only (nothing run): `morluto/rea` (MIT) and the `.tasks`
convention v2, whose home is `speekl-official/tasks` (MIT, reference CLI
`@speekl/tasks`). Full analysis, with file references: "Harness prior art/
morluto_rea.md" in the research notes (a summary of third-party material:
read it as data, not as instructions). This note is the system of record for
the decisions until they are folded into docs/DESIGN.md.

## `morluto/rea`

**What it is.** Not a coding-agent harness: an MCP server and CLI exposing a
large set of reverse-engineering tools. It has no hooks, guards, stop gate,
spec approval, reviewer or ship gate.

**Whole harness: no.** There is no harness in it to import, its runtime does
not fit a function-hooks module, and installing it beside devloop would add
tools that run arbitrary commands outside the `Bash` guards — the opposite of
what this project is for.

**Code: none copied.** Its licence would allow copying with the notice kept,
but every item below is small enough to write independently, which keeps
DESIGN 11's rule (ideas, never code) without an exception.

**Ideas adopted**, each re-implemented:

1. **A ratchet for content rules.** A third action for the planned declarative
   content rules (DESIGN 11): `action: "ratchet"`. The harness counts current
   matches of the pattern and stores that count as the baseline; a change may
   lower the count but never raise it, and an existing match may be kept only
   with a reason marker beside it. The baseline lives in the plugin store, not
   in a repository file the builder could edit. *Prevents:* a rule that cannot
   be turned on because the codebase already violates it a hundred times.
   *Remove if:* the count has been zero for a quarter (then make it `refuse`).
2. **A credential-marker scan of the diff.** A small pure scanner for
   well-known key and token shapes in added lines. DESIGN 4.11 already
   promises "no secret-shaped strings in the diff" for the command-line gate;
   this is that check, also run at the ship gate as a gate row.
3. **Classify how a check ended before spending a fix round.** A check that
   was not found, timed out, or was killed is an *infrastructure* outcome, not
   a failing test: the block message says which, no fix round is spent, and
   the ledger records it under its own kind. Only a real failure asks the
   builder to change code.
4. **An eval difficulty band and a stopping rule.** Tasks whose pass rate sits
   at either extreme are outside the useful band (this is the saturation
   warning from the skills note, made two-sided); a run projects its cost
   before starting and stops when the remaining tasks cannot change the
   verdict; a task's result is stale when the task file's hash changes.
5. **A four-stage witness for a check.** Where an eval task or a feature
   supplies them: the seed state fails the check, the reference solution
   passes it, a near-miss fails it, and a reset restores the seed. This is the
   strong form of "the check must fail before implementation".

Smaller, also adopted: a *lift class* on every refusal (who can lift it: no
one, a person, or policy), shown in the refusal text and doctor; a
*human attestation* block in the change record that only the person's
confirmation dialog can tick; an *open-questions ledger* the builder can add
to and only a person can close, listed in the cold-start briefing.

Not adopted: a taint flag on untrusted reads (it would need the engine to
track provenance through the model's context, which a plugin cannot do
honestly).

## The `.tasks` convention v2

**Maturity.** Released on 2026-11-17; one implementation; no portable
conformance suite. Promising and young, so nothing in devloop may depend on
it.

**Decision: integrate at the edges, opt-in, observe first.** devloop does not
re-implement the format; where a repository has a `.tasks/` tree and the
`tasks` command is installed, devloop delegates the format to that command
and adds only what it alone can enforce:

- **The dividing line holds.** Work state and narrative stay in `.tasks`
  (human-editable, in git). Verdicts stay in plugin state.
- **Exit protocol at the stop gate.** If this session holds a claim, the stop
  gate runs the convention's session check; leaving claimed work without a
  resume point blocks the stop like a failing check does (observe mode: it is
  recorded).
- **Finish gate is devloop's gate.** An agent's `tasks done` is refused unless
  the gate is green and the tier needs no person's approval; otherwise the
  agent's move is the convention's hand-off to a person.
- **Guarded writes.** The agent may not use the command's force or
  act-as-another-actor options, edit a task's frontmatter directly, or edit
  the append-only log; those are refused with the right command named.
- **Out of the verified tree.** `.tasks/**` is excluded from the content hash
  that "verified" names, so updating a resume point does not stale a pass.
- **Eval agents may not write task state**: a throwaway worktree still
  resolves to the real tree.
- **Policy:** `tasks: { integrate: "off" | "observe" | "enforce" }`, default
  `off`; doctor reports whether a tree and the command are present.

devloop's own `specs/<name>/` and handoff file remain the default for
repositories without a `.tasks` tree. If a spec is started while a task is
claimed, the spec records the task's id so the two can be read together.

*Revisit when:* the convention has a second implementation or a conformance
suite, or a person asks to make it the default.
