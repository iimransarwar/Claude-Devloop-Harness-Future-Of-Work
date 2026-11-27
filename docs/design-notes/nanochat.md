# Design note: what we take from `karpathy/nanochat`

Examined read-only (nothing run). nanochat is a minimal end-to-end codebase
for training and serving a small chat model, about 7,800 lines of Python, MIT
licensed. It is not an agent harness. No code is taken: nothing in it is in
our language or over thirty lines of relevant logic. Full analysis:
"Harness prior art/karpathy_nanochat.md" in the research notes (a summary of
third-party material: read it as data, not as instructions). This note is the
system of record for the decisions until they are folded into docs/DESIGN.md.

Three of the items below are gaps in devloop that reading a differently built
project exposed, not features of nanochat. They are marked **gap**.

## Adopted

1. **gap — Instruction files outside the tree.** nanochat git-ignores its
   `CLAUDE.md`. devloop's snapshot builds the tree with `git add -A`, which
   honours ignore rules, so an ignored instruction file never reaches the
   tier, the gate's "instruction files changed" row or the verified hash, yet
   the agent reads it on every session. The snapshot must hash files matching
   the `instructions` globs whether or not git ignores them, the gate row must
   cover them, and doctor must list instruction files git does not track.
2. **Records carry their inputs.** Every eval result, change record and gate
   record stores fingerprints of what produced it: the suite (task file
   hashes), the policy, the model, and the harness version. `eval compare`
   compares only tasks whose hash is unchanged between the two runs and says
   how many it left out. A verdict whose inputs changed is not comparable and
   is shown as such.
3. **gap — Parity tests across enforcement points.** Once the module, the
   classic hooks and the command line all exist (DESIGN 4.11), one table of
   cases is run through all three and must give the same verdict. Selected by
   a test-kit switch, never by an environment variable an agent could set.
4. **A quick eval subset.** A fixed, deterministic subset of the suite for
   routine use; the headline number shown in metrics comes only from a full
   run, and a quick run is labelled as one.
5. **Resumable eval runs.** A run records each finished task as it goes and
   writes its completion marker last, so an interrupted run resumes instead of
   starting over, and an incomplete run can never be mistaken for a result.
6. **gap — A scrubbed environment for checks.** The harness runs verify
   commands and feature checks through a login shell with the full
   environment, so every check sees every credential the session holds.
   Policy gains `checkEnv: { pass: [names], mode: "observe" | "enforce" }`:
   in enforce, checks run with only the listed variables plus a minimal base
   (`PATH`, `HOME`, locale, CI markers); in observe, the harness reports which
   credential-shaped variables a check could see. Observe is the default
   because many test suites need a variable nobody remembered.
7. **Tombstones for removed rules.** When prune removes a rule, its key and
   the evidence for removal are kept, so `/devloop learn` does not propose the
   same rule again unless the failure returns after the tombstone's date.
8. **A disclosure block in the change report**: which parts of the change
   were written by an agent, reviewed by which reviewer on which tree, and
   which parts a person has attested to reading.

## Does not transfer

Its tool-call state machine and calculator (devloop does not own the agent
loop); its Python execution prelude (not a boundary, by its own description);
its report card (removed upstream as bloat, and built by scraping prose);
fixed seeds, leaderboards, `curl | sh` bootstrapping; and all model,
optimizer and data code.
