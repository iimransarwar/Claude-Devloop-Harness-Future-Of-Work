# Review of the B2.1 fixes and Phase C1, and the decisions taken

Fourth round, fresh context, read-only, on commits `c1e379a` and `a0952e1`.
Verdict **FAIL** on two high findings in Phase C1. The six findings re-walked
from the previous round (F1, F2, F4, F5, F6, L1) are all resolved. Every new
finding was reproduced: pure functions, the extracted git and shell scripts
against throwaway repositories, or probe tests on a copy of the plugin.

Two lessons from this round are adopted as rules:

- **Nothing in the working tree is left out of the hash that "verified"
  names.** The moment a path is excluded, that path is a place to hide a
  change. If the harness needs to write something that must not stale a pass,
  it writes it outside the working tree.
- **The policy in force is the base branch's, whole.** Reading one field from
  the base and the rest from the working tree leaves every other field as a
  way for a change to loosen its own judgment.

## High

**F1. The handoff file's exclusion from the tree hash hid real changes.**
Replacing `PROGRESS.md` with a folder of the same name, or pointing
`handoffFile` at a folder, left the hash, the diff, the tier and the gate
blind to whatever was put there, including a file that turns checks green.
*Decision:* the exclusion is removed. Handoff entries are stored in the
harness's own state directory, per repository, never in the working tree.
The cold-start briefing reads them from there; `/devloop handoff show` prints
them; `/devloop handoff export <path>` (a person) writes them into the
repository as an ordinary change. The `handoffFile` policy field is removed
(accepted and reported as unused), and `/devloop init` no longer writes
`PROGRESS.md`. This also closes F5.
*Fixed when:* a smoke case shows a folder or file at the old handoff path
moves the hash and is listed like any other; no policy value can exclude a
path from the hash.

**F2. The instruction lints raised errors on ordinary prose.** "make sure"
was read as a missing make target (the harness's own rules text tripped it);
MIME types, git refs and example file names were "paths that do not exist";
and `doctor --strict` exited 1.
*Decision:* heuristic lints never produce errors. A make target counts only
inside code and only when a Makefile exists; a path counts only when it looks
like a repository path and is not a MIME type, a ref, a glob or a placeholder
name; a script is resolved relative to a preceding `cd`. `doctor --strict`
fails only on: policy errors, the hidden-character classes (as refined in
F7), the instruction byte budget, and a skill's hard limits.
*Fixed when:* a table of ordinary instruction lines yields no error-level
item and `doctor --strict` on ordinary prose exits 0.

## Medium

**F3. The environment scrub let through names that are not shell
identifiers** (`npm_config_//registry…:_authToken`, `a.b-token`) and exported
functions. *Decision:* the check's environment is built from nothing with an
allow-list (`env -i`), not by removing names.

**F4. `checkEnv`, the instruction globs and other fields came from the
working tree** at the stop gate, in `feature_check` and at approval.
*Decision:* the policy in force is the base branch's in full whenever a base
copy exists, for every use: guards, verification, review, the gate, the
scrub. The working-tree copy is only compared with it, for the "Policy
changed in this change" row. With no base copy, the working tree's is used
and the row says so.

**F5. The handoff tool wrote to whatever path policy named**, including a
locked test, a secret file or a link. *Decision:* closed by F1: the tool
writes only into the harness's state directory.

**F6. A plugin reload re-decided whether the prompt section is sent**, so the
section could appear or vanish inside a thread. *Decision:* the decision is
kept in plugin state by session id and survives a reload; only a new session
or `/clear` decides again. *Fixed when:* a test composes, changes opt-in,
raises `session.start` again under the same session id, and gets the same
bytes.

**F7. The "no innocent use" class included joiners that emoji and several
scripts need.** *Decision:* a zero-width joiner inside an emoji sequence and a
zero-width non-joiner between letters of a script that uses it are not
flagged. Zero-width space, tag characters and bidirectional overrides are.

**F8. The non-blocking injection classes fired on ordinary lines at error
level** ("copy `.env.example` to `.env`", "never pipe a download into a
shell"). *Decision:* those classes are warnings; the negation check applies
to every class; a line that only names an example or template file is not a
hit.

**F9. Nothing tested the plugin half of "ignored instruction files reach the
tier and the gate".** *Decision:* add those tests, including one that the
snapshot is called with the policy's instruction globs.

## Low

**F10.** The briefing was marked as sent before the budget decided, so a
deferred briefing never arrived, and a source larger than the budget was
never sent at all. *Decision:* a source is marked sent only when it is; an
over-budget source is sent truncated with a pointer to the status tool.

**F11.** A FAIL whose only readable line re-checked an id that was not open
settled as passed. *Decision:* a re-check of a closed finding reopens it; a
re-check of an unknown id is an unreadable answer and follows that path.

**F12.** The sweep for ignored instruction files reached into dependency
folders and silently stopped at five hundred matches. *Decision:* dependency
and build folders (`node_modules`, `vendor`, `.venv`, `dist`, `build`,
`target`, and policy `instructionsIgnore`) are left out; the repository's own
files are taken first; reaching the cap is reported in doctor and as a gate
note.
