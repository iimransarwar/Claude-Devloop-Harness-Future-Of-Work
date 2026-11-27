# devloop: design

This is the system of record for what the harness does and why. Code follows
this file; when they disagree, fix one of them in the same change.

## 1. What this is

devloop is a harness layer for agent-driven software development, delivered as
a Claude Code plugin. It does not own the agent loop (model call, tool
execution, compaction): Claude Code does. devloop owns what the loop lacks:

- a definition of done the builder cannot edit,
- containment tripwires around what the builder may read, write and run,
- an intent a person approved before the build,
- an independent judgment of the result,
- a risk policy that decides who may ship,
- a memory of failures that turns repetition into rules, and
- measurement, so every rule can be justified or deleted.

A repository opts in with `devloop.json` at its root, in the working tree or
on the base branch (C2.1: deleting the working copy does not opt a repository
out while the base has one). Without either the plugin is dormant except for
the secrets guard and `/devloop init`.

## 2. Principles

1. **Enforcement is code; instructions are requests.** Anything that must hold
   every time is a hook that refuses. The prompt section only explains the
   rules so the model works with them.
2. **The builder never grades itself.** Verification results, review verdicts,
   spec approval and feature status live in plugin state (`$.state`/`$.store`),
   which no tool call of the builder's can write.
3. **A person holds the keys.** Approving a spec, exempting a path, closing a
   change with the gate open, raising a budget: each needs a person at the
   prompt and a confirmation dialog.
4. **Tripwire, not boundary.** Shell commands are judged by their text. That
   catches mistakes and honest shortcuts, not an adversary. The sandbox and
   credential isolation are the boundary, and `/devloop doctor` says so.
5. **Observe before enforce.** Every guard can run in observe mode, recording
   what it would refuse. A guard that fails to run refuses in enforce mode,
   and wherever the mode cannot be read (principle 11); secrets by the
   default globs are refused even then.
6. **Truth comes from the tree.** "Verified" names the exact working-tree
   content it covers (a content hash that is the same before and after a
   commit). Anything else is stale. Principles 9 and 10 say what that takes.
7. **Cheap by default.** Nothing runs on a turn that changed nothing. Context
   added to the model is a delta, not a dump. Each added mechanism must be
   deletable and must say what evidence would justify deleting it.
8. **Fail safe, never fail useful.** Anything the harness cannot read or
   resolve confidently counts as blocking. A gate is met only on positive
   evidence. (Adopted after Phase B2; see docs/reviews/phase-b2.md.)
9. **Nothing in the working tree is left out of the hash that "verified"
   names.** The moment a path is excluded, that path is a place to hide a
   change. When the harness needs to write something that must not stale a
   pass (a handoff, a check's output, the audit trail), it writes it outside
   the working tree, in its own state. No policy value removes a path from
   the hash. (Adopted after the Phase C1 review; docs/reviews/phase-c1.md.)
   *As built (D2):* the `.tasks` note asked to leave `.tasks/**` out of the
   hash; it is not. Verification always re-runs on the tree as it is; only a
   review verdict carries over to a tree that differs from the reviewed one
   in task state alone (4.12, A16), decided each time by principle 12.
10. **The policy in force is the base branch's, whole.** Every decision
   (guards, verification, the scrub, review, the gate, content rules, tiers,
   instruction globs, evals) takes its policy from one function,
   `policyInForce`: `devloop.json` as the base branch has it, in full,
   whenever the base has a copy (with no working copy too: the gate then reads
   "Policy changed in this change: devloop.json was deleted", C2.1); the
   working tree's only when the base has none, and the gate says so. Reading one field from the base and the rest from
   the working tree leaves every other field as a way for a change to loosen
   its own judgment. The working tree's copy is read only to compare (the
   "Policy changed in this change" row) and by `/devloop doctor` and
   `/devloop init`. (Adopted after the Phase C1 review.) *As built (D1):* the
   decision itself is one pure function, `decidePolicy` (`hooks/inforce.ts`),
   fed the working copy and the base's copy by two readers: the module's
   `policyInForce` (git through `$`) and the command line's (git through
   Node, `cli/io.ts`).
11. **An enforcement point that cannot read its input, or that fails for any
   reason, refuses.** "Could not judge" is never "allowed" for a write, a
   shell command or a ship: input that is late, large, truncated or empty is
   read to its end or refused; a throw refuses (in observe mode it is
   reported); checks that do not finish in time refuse the ship. A stop is
   the one exception, by principle 8 and B1 F26: a broken stop gate never
   blocks a stop, it marks verification as not done and tells the person.
   (Adopted after the Phase D1 review; docs/reviews/phase-d1.md.)
   *Amended for grounding (4.15):* in the classic `Stop` hook, a transcript
   that is missing or cannot be read skips grounding's check, and only that
   check: the rest of the stop gate runs as before. Grounding is advice
   about the quality of an answer, not a guard on what reaches a branch, so
   there, and only there, unreadable input does not refuse; likewise its
   nudge, and a failure of grounding's backstop in the module, let the
   prompt and the stop through.
   *As built (E1):* a gating hook's `.catch` calls nothing that can throw unguarded; in `tool.call`'s, a secret check that throws names no secret and the mode decides (enforce refuses, observe and dormant let the call through).
12. **Whatever is bound to the reviewed tree travels with the verdict, or the
   verdict does not travel.** Whether a verdict covers another tree is
   decided afresh each time by a diff against the tree the reviewer read,
   never from a stored mark, and a verdict that carries carries every unmet
   thing that was true of that tree: its open findings and its promoted
   checklist failures. A new round resets everything derived from the
   previous verdict. (Adopted after the Phase D2 review;
   docs/reviews/phase-d2.md.)

Five rules of construction. The first four were adopted after the
cache-guard round's review (docs/reviews/cache-guard-round.md): three of that
review's high findings were one fault, a rule that matched *spellings* passed
by a spelling the shell or git accepts and the rule did not list. The fifth
was adopted after its thirteenth round, in the place of one withdrawn after
the twelfth.

13. **Allow by shape, not refuse by spelling (P-A),** wherever the agent has
   one right way to do a thing. *As built:* a push. The agent's push is
   `git push [options] <remote> <source>[:<destination>]`, one refspec whose
   source is `HEAD` or the branch checked out, no `+`, options only from a
   short list spelled in full, nothing configuring git on the line (`-c`,
   `--config-env`, `--git-dir`, `--work-tree`, `--namespace`, `-C`, a `GIT_*`
   variable); anything else is refused with `git push -u origin HEAD` named
   (`pushShape` in `hooks/rules.ts`, read by `shipRules` in
   `hooks/enforce.ts`, so all three points agree). Every rule that refuses on
   a git option matches it as git does, by prefix, through one helper
   (`gitOption` in `hooks/shell.ts`), over-refusing on ambiguity; an option
   that lets a command off a rule (`--cached`, `--dry-run`) counts only
   spelled in full (`gitOptionExactly`).
14. **A value the model cannot compute is the forbidden value, for every
   always-held rule (P-B).** The parser carries, for each assignment, option
   value, ref and written path, whether it held an expansion it could not
   resolve (`Assigned.isComputed`, `Word.hasExpansion`,
   `Segment.isWriteOpen`). *As built:* the evidence-notes rule (`--ref`,
   `GIT_NOTES_REF` inline or earlier on the line, `core.notesRef` by `-c`,
   `--config-env` or `GIT_CONFIG_*`, the ref operand of `update-ref` and
   `symbolic-ref`, a fetch or push refspec), the `.tasks` actor rule (any
   `TASKS_ACTOR` value) and the eval worktree's containment (a write whose
   path is computed is a write outside). For the secrets and harness-state
   paths a read or write whose path still holds an unresolved expansion is
   R2 in the register: refusing it would refuse most scripts.
15. **A wildcard is judged by what it matches on disk (P-C).** A path holding
   `*`, `?`, `[…]` or `{…}` is expanded as the shell would: braces first,
   with no disk needed, then the other wildcards against the file system; a
   wildcard that matches nothing is judged as its literal text. One expander
   (`hooks/glob.ts`, braces in `hooks/shell.ts`), used by every path rule,
   the `.tasks` rules and both readers, behind the file-system interface the
   shared core already uses (the module lists through `$.fs.list`, the
   command line and classic hook through Node). It is capped at 200 matches:
   past the cap a write is refused and a read is judged as a recursive read
   of the literal folder.
16. **The stateless points keep nothing (P-D).** The command line and the
   classic hook derive every verdict from the tree and from git notes;
   nothing either writes to disk is trusted by a later run to loosen a
   verdict. *As built:* the kept passes (`classic-passes.json`) and the
   cached base policy (`classic-policy.json`) are gone. What the classic
   hook still keeps and reads back (its stamps, the module's heartbeat, the
   stop record with the last blocked tree and the keep-warm turn's tree, the
   base's secret globs it last read, which can only add) is listed in A24
   of docs/RESIDUAL-RISK.md, with what a forged copy of each can do.
17. **A new reading adds; it never replaces the reviewed one (BB1).** Every
   regression of the cache-guard round's tenth to thirteenth reviews had one
   shape: a new reading of a line (follow `pushd`, expand a move's target,
   decode a quoting, resolve a link) took the place of the reading the
   reviewed build had, and wherever the new reading was wrong about what the
   shell does, a line the old one refused got through. So a richer reading
   is added beside the reviewed one, and the line is judged under both,
   whole: a refusal under either stands; places to look at are the union;
   an answer of "allowed", "safe", "read-only" or "nothing here" must hold
   under both. *As built:* the shell model has two readings
   (`Reading` in `hooks/shell.ts`, see *Folders* in 4.11); `parse` takes
   one, `readings` gives both, and every function in `hooks/rules.ts`,
   `hooks/tasks.ts` and `hooks/grounding.ts` that judges a line combines
   them, so no caller can judge under one alone (tests/smoke.sh checks that
   nothing else parses a line). The same holds for links (both places a
   path is put are followed, BB2).
   **The reviewed reading is the whole of the reviewed build's reading (the
   fourteenth round, CC1),** not a list of the behaviours someone judged to
   differ: its tokenizer, every flag it puts on a word among them (a word
   with a quoted part before its wildcard is no wildcard to it); its model
   (only `cd` moves, its target as written, `~+` as written); its wildcard
   expander (`expandGlobReviewed` in `hooks/glob.ts`, `2374c49`'s line for
   line); and the lookups it asked the disk for (`globAsksReviewed` in
   `hooks/rules.ts`: the first 16 wildcard paths, each by its own spelling,
   kept in `Where.globs`). The extended reading's lookups are its own
   (`Where.globsExtended`, by the pattern expanded, with the checked
   expander), so neither can answer for the other. Where the reviewed code
   is kept, it is kept as `2374c49` wrote it, under a name that says so;
   what changed since is listed hunk by hunk, each as the extended
   reading's, as adding refusals only (with the argument), or as a change
   of form. The test is differential and large: the fourteenth reviewer's
   generator (42,000 lines in two worlds) and every list from the tenth to
   the fourteenth rounds are judged by the reviewed bundle and by the new
   one, with no line the reviewed bundle refuses allowed; a corpus of those
   lines with the reviewed bundle's verdicts (`tests/corpus.jsonl`, in the
   world `tests/corpus-world.sh` builds) is judged by the built bundle in
   tests/smoke.sh, and a line it refused that is now allowed fails the
   build; the parity sample `W2_SAMPLE` stays beside it.

## 3. The loop

```
small-fix ──/devloop spec──▶ spec ──/devloop approve (person)──▶ build ──▶ review ──▶ ready
    ▲                          │ only spec + tests editable        │ tests + spec locked    │
    └──────────────────────────┴────────────── /devloop done (person) ◀────────────────────┘
```

- **small-fix** (phase `idle`): no spec. Guards and the stop gate apply. High
  risk paths cannot be edited at all in this mode.
- **spec**: the model and the person write `specs/<name>/SPEC.md` and
  `features.json`; each feature has an executable `check`. Only the spec folder
  and test files may change.
- **approve**: a person confirms. The harness then (a) fingerprints the spec,
  (b) runs every feature check and records which fail (they should all fail:
  red before green), (c) records the test files' content hashes.
- **build**: tests and spec are locked. `feature_check` is the only way a
  feature becomes passing: the harness runs the check itself.
- **review**: one or more reviewers in fresh contexts, read-only by allowlist.
- **done**: a person closes the change; a change record is written.

## 4. Subsystems

### 4.1 Policy (`devloop.json`)

Parsed strictly: an unknown key or a wrong type is reported by name in
`/devloop doctor` and the pane, and the field falls back to its default so a
half-written file never switches a guard off.

*As built:* where the default would itself switch a guard off, the stricter
reading wins (a verify entry with a bad `profile` or `when` still runs at every
stop; a malformed `network.allow` allows no host), and a file that is not JSON
still opts in with every default, because dropping the file would drop the
guards. Keys of later phases (`contextHandoffPercent`, `evalTrials`) are
accepted and listed as unused rather than reported as unknown, so a file
written for a later version is not an error. *As built (B2):* `blastRadius`,
`approvals`, `reviewers` and `models` are read, strictly: a reviewer entry
whose `mode` is wrong stays `blocking` (never demoted to shadow), and an
approvals count in error keeps its default (never fewer people).
*As built (B1):* `"verify": "npm test"` is one check; any other wrong type is an
error. Every error, an unknown key included (12.6), keeps the gate shut (row
"Policy error") until it is fixed.
*As built (B1.1):* the mode in force is the base branch's `devloop.json` mode
when the base has a copy, the working tree's otherwise (N8): the guards, the
stop gate and a guard that fails to run all use it, and a working-tree mode
that differs is named in the "Policy changed in this change" row.
`/devloop init` needs a person; when a `devloop.json` already exists at or
above the session's root it writes nothing and says where that policy is (N10).
A file that stops being one JSON object falls back to the last config that
parsed, kept per repository in `$.store` (`config:<root>`), with a toast and a
doctor line; with none on record, every default in enforce (9.3). The verify
commands are linted when policy loads (11, check integrity).
*As built (C1):* `cache`, `context`, `instructionMaxBytes` and
`checkEnv` are read strictly; a `context` level in error keeps its default
(scaled to the window), a `checkEnv.mode` in error stays `observe` (never
`off`), a `pass` list in error passes nothing beyond the base.
*As built (C1 review):* the mode in force (B1.1) is generalised to the whole
policy (principle 10): `policyInForce` in `hooks/state.ts` is the only way
code obtains policy for a decision, and returns the base branch's copy in
full, or the working tree's with `source: 'working'` when the base has none.
The base is found as the snapshot finds it (`FIND_BASE`, the same lines; the
smoke test checks they agree) from the default branch the last policy in
force named, and looked for again when the base's copy names another (A3 in
docs/RESIDUAL-RISK.md). A base copy that does not parse is still the base's:
its defaults (enforce) are in force, never the working tree's. `handoffFile`
is retired: accepted, never an error, and listed by doctor as unused (handoff
entries live in the harness's state, 4.7). `instructionsIgnore` (globs, default
none) names folders the sweep for ignored instruction files leaves out, beside
`node_modules`, `vendor`, `.venv`, `dist`, `build` and `target`.
`contextHandoffPercent` is replaced by `context.warnRemaining` and
`context.saveRemaining`; it stays accepted and listed as unused.
*As built (C2):* `rules`, `evalTrials` (1 to 10), `evalIsolation`, `evalQuick`,
`saturationRuns` (at least 2) and `pruneWindowDays` are read strictly. A
content rule whose id, globs or pattern cannot be used, whose id is used
twice or is a built-in rule's name, is left out and named; a wrong `action`
takes the stricter `refuse`. `evalTrials` is no longer reserved.
*As built (C2.1, an opt-in hole from the builder's notes):* a repository is
opted in when the working tree has a `devloop.json` **or** the base branch
does. `look` finds the root as the nearest folder holding `devloop.json`, else
the nearest holding `.git`; `locate` asks `policyInForce`, which with no
working copy reads the base's (found from the default branch of the last
config that parsed here) and returns it whole with `policy: 'deleted'`, so
every guard, the stop gate, the ship gate and the scrub judge exactly as
before the deletion. `Place.isOptedIn` is the one opt-in test the hooks use.
`/devloop init` writes nothing over it; doctor says the base's copy is in
force. Where no base is found, a deleted working copy leaves the repository
dormant (A10).
*As built (D2):* `claims: { leaseMinutes }` (default 30, 1 to 1440),
`followUp: { ci, intervalSec, timeoutMin }` (defaults true, 120 at least 30,
60) and `tasks: { integrate }` (`off`, `observe`, `enforce`; default and
fallback `off`) are read strictly, like every field from the policy in force.

```jsonc
{
  "mode": "observe",                  // or "enforce"
  "defaultBranch": "main",
  "verify": [                          // string, or { run, when?, profile? }
    "npm run -s typecheck",
    { "run": "npm test -s", "profile": "fast" },
    { "run": "npm run -s e2e", "profile": "full", "when": ["src/**", "e2e/**"] }
  ],
  "verifyTimeoutSec": 300,
  "protected": [...], "tests": [...], "secrets": [...], "secretsAllow": [...],
  "instructions": ["AGENTS.md", "CLAUDE.md", ".claude/rules/**", ".claude/skills/**"],
  "tiers": { "high": [...], "low": [...] },
  "blastRadius": { "maxFiles": 25, "maxLines": 600,
                   "manifests": ["package.json", "*.lock", "go.mod", "Cargo.toml", "requirements*.txt"] },
  "approvals": { "low": 0, "medium": 1, "high": 2 },   // people who must approve the merge
  "forbidden": [ { "pattern": "\\bterraform\\s+apply\\b", "why": "production changes are a person's" } ],
  "network": { "allow": ["registry.npmjs.org", "github.com"] },  // egress tripwire; absent = off
  "reviewers": [ { "name": "security", "when": ["**/auth/**"], "mode": "blocking" },
                 { "name": "accessibility", "when": ["**/*.tsx"], "mode": "shadow", "prompt": "…" } ],
  "models": { "reviewer": "sonnet", "specialist": "haiku", "eval": "haiku", "learner": "haiku" },  // absent = the session's
  "maxFixRounds": 2, "maxReviewRounds": 3, "autoReview": true,
  "budgetUsd": null, "instructionMaxLines": 200, "instructionMaxBytes": 32768,
  "instructionsIgnore": [],            // folders the ignored-instruction sweep skips
  "cache": { "missTokens": 20000, "ttlMinutes": 5 },
  "context": { "budgetTokens": 600, "warnRemaining": null, "saveRemaining": null,
               "debounceCalls": 25, "idleWarnTokens": 50000 },
  "checkEnv": { "pass": [], "mode": "observe" },        // or "off", "enforce"
  "rules": [ { "id": "no-console", "when": ["src/**"], "pattern": "console\\.log",
               "action": "refuse", "why": "use the logger" } ],  // note | refuse | ratchet (C2)
  "evalTrials": 1, "evalIsolation": "worktree",          // or "clone"
  "evalQuick": 5, "saturationRuns": 3, "pruneWindowDays": 30,
  "claims": { "leaseMinutes": 30 },                      // D2
  "followUp": { "ci": true, "intervalSec": 120, "timeoutMin": 60 },
  "tasks": { "integrate": "off" },                       // or "observe", "enforce"
  "grounding": { "mode": "enforce", "fresh": "turn", "also": [], "never": [] },  // 4.15
  "loop": { "failedRounds": 6 },                         // 4.16; 0 turns the limit off
  "testing": { "scope": "targeted" },                    // 4.16; or "full"
  "learning": { "auto": "trial", "repeats": 3, "promoteHits": 3,  // 4.17; auto: off | propose | trial
                "maxTrial": 20, "maxRuns": 3 },
  "library": { "save": "auto" }                          // 4.18; or "off"
}
```

Verify **profiles**: `fast` checks run at every stop that changed the tree;
`full` checks run in addition before anything ships and on `/devloop verify`.
A check with `when` runs only if a changed file matches. A plain string is
`{ run, profile: "fast" }`.

### 4.2 Guards (tool calls)

Edit tools (`Edit`, `Write`, `NotebookEdit`), `Read`, `Grep`, `Glob`, `Bash`
(background too) and `Monitor` pass through one `tool.call` hook. Decision
order for a path:

1. secret → refused in every mode and phase, for reads too;
2. person's one-turn exemption → allowed;
3. active spec folder → open in `spec`, locked otherwise;
4. `protected`, or a built-in protected path (11) → refused;
5. tests → locked in `build`;
6. tests → open in `spec`, wherever they live (F29);
7. anything but spec and tests → refused in `spec`;
8. high-tier path outside `build` → refused (needs an approved spec).

A path is judged by its spelling and by where it resolves (`realPath`; a file
not there yet by its folder's). *As built (B1):* the secrets rule applies to
every path anywhere: `~` is expanded, the absolute path and the name are
matched, case folded. Outside the repository only secrets, the harness's state
and the built-in protected names are judged. `Grep`'s path and glob and
`Glob`'s pattern meet the secrets rule (with wildcards taken out too).

**Rules that always hold**, in every mode, whatever else matched: `secret`,
`harness-state`, `reviewer-read-only`, `budget`, `eval-containment`, and from
D1 `evidence-notes` (4.11).
*As built (B2):* every refusal ends with its **lift class** in one short
clause: `none` (always held: the rules above but `budget`), `policy`
(`forbidden`, `egress`: the lasting fix is a change to devloop.json) or
`person` (everything else, `budget` included: an exemption, an approval, or
the person doing it). `/devloop doctor` lists each rule with its class. Of several
refusals the strictest is returned; recording it is best effort and never
changes the answer. A guard that fails before judging still refuses a call that
names a secret (a pure check on its text), and otherwise refuses only in
enforce mode.

**The command model** (`hooks/shell.ts`, B1). A line is split into simple
commands on `;`, `&&`, `||`, `|`, newlines and subshell parentheses, and each is
judged; the strictest verdict wins. Quotes, backslashes, comments and heredoc
bodies are understood, so quoted data, comments and heredocs are not judged as
commands; `bash -c`/`sh -c` scripts, command and process substitutions,
`find -exec` and `env -S` are judged as commands. Wrappers (`sudo`, `env`,
`nohup`, `timeout`, `xargs`, `command`, `time`, `nice`, …) are peeled; git's
global options (`-C`, `-c`, `--git-dir`, `--work-tree`, …) are skipped; `cd`
and `git -C` move the directory later relative paths are placed from. A
redirect to a descriptor or `/dev/null` is no write; any other target is a
written path. Each command exposes its program, sub-command, operands, written
paths, read paths, hosts. A computed command name, `eval`, inline interpreter
code and `patch` make it an **unknown writer**: it may write any locked path it
names (only the locked-path rules hold for a mention), and its refusal says to
name the program literally. A written folder is
locked when a locked glob lies beneath it (by the glob's own folder, or by the
tracked files the hook lists there). *As built (B2.1, F7):* what lies beneath
is probed for a folder only: an edit tool's path, and a command's path the
hook finds is a file or is not there, is judged as itself, so a new test file
and an exact-path exemption under `tests/` hold. A path whose kind cannot be
told is probed (principle 8). What it knowingly accepts is in
docs/RESIDUAL-RISK.md, each with a test.

*As built (B1.1):* `$(( … ))` and `(( … ))` are an arithmetic context: no
heredocs and no redirects inside (N3). `find` with `-name`/`-path` filters
writes what the filters select under each root (`./**/*.pyc`), judged as a
glob against the policy's globs and the tracked files the hook lists; with no
filter, a negated one or an `-o` branch without one, the roots stand in (N5).
A writer fed through `xargs` by a file lister (`git ls-files`, `git grep -l`,
`rg -l`, `grep -l`, `find`, `ls`, `fd`) writes the lister's root in the spec
and build phases, and the refusal says to name the files or use the edit
tool; in small-fix mode it passes (N6). `git restore --staged`, `git rm
--cached`, `git clean -n` and `git config <name>` (a read) write nothing
(N11). `git checkout <one word>` writes a path only after `--` or when the hook
finds the word tracked; otherwise it is a branch (N19). A computed program
that is plainly a test run (`$PYTHON -m pytest`, a path ending in a known
runner) is not an unknown writer (N18).

Shell commands are judged by text:

- secrets named anywhere in the command;
- writes that meet the edit rules above (all of them, F20), and unknown
  writers that name a locked file;
- `--no-verify` (also `commit -n` and `-c core.hooksPath=`), forced pushes
  (also `+refspec`);
- destructive commands (11), with the safer command named. A download is run
  as code when it is the program: piped into a shell or into an interpreter
  that reads its program from standard input (no script, no `-c`/`-m`/`-e`),
  or handed to a shell by process substitution or as its `-c` script; a
  download piped into a program that reads data passes (N4);
- running one of the configured checks through `head`/`tail`/`grep`: refused,
  pointing at the full output the harness saved;
- **forbidden** patterns from policy, plus built-ins for production actions
  (`kubectl apply|delete`, `terraform apply|destroy`, `npm publish`,
  `docker push`, `gh release create`, `aws|gcloud|az … deploy|delete`): rule
  `production`, refused in enforce mode whatever the tier — production access
  is a separate axis from merge risk;
- **egress tripwire** when `network.allow` is set: `curl`, `wget`, `nc`, `ssh`,
  `scp` and URLs in commands are checked by host; an unlisted host is refused
  (*as built:* loopback always passes and `*.example.com` allows subdomains,
  since a local dev server is not egress);
- shipping commands (`git push`, `gh pr create|ready|merge`, `git merge` on the
  default branch) go through the gate (4.6). The branch is carried through a
  line: after `git checkout|switch` to the default branch the later parts are
  on it, and after a switch to a ref the model cannot name (`-`, a variable)
  they are possibly on it, judged the same (N1). A merge anywhere else, and
  `git merge --abort`, ships nothing and runs no check (N2). gh's `-R`/`--repo`
  are skipped like git's global options (N16). *As built (D1):* a `gh` ship
  whose `-R`/`--repo` names a repository other than this one's `origin`
  (compared as `owner/name`), or any `-R` where the remote cannot be read, is
  refused like a ship from another directory (rule `gate`, `shipElsewhere`).

*As built (C2, L2 in docs/reviews/live-findings.md):* **a line that ships
must ship alone** (rule `ship-alone`). A line with a shipping command (what
`shipsOf` recognises: a push, `gh pr create|ready|merge`, a merge) is refused
unless every other part is `cd` or a plain read that writes no path, redirects
to no file and runs no unknown code (`git status`, `git log`, `echo`, the
reviewer's readers, a substitution such as `$(git rev-parse …)`): the gate
judges the tree before a line runs, so a line that writes, commits and pushes
would ship a change the gate never saw. It holds whatever the tier, even on a
clean tree; it is recorded only in observe mode (the mode in force is the
base policy's), its lift class is `none`, and no command exemption lifts it.
`make release` and the like name no shipping command and are not caught (R27).

*As built (C2.1, docs/reviews/phase-c2.md):* **what ships, for ship-alone**
(F2) is a push, a `gh pr` action, a possible ship by an alias, and a merge
only on, or possibly on, the default branch: the hook reads the branch checked
out (`currentBranch`) when a line merges without switching first, and a branch
it cannot tell counts as the default. A merge anywhere else is a write like
any other: beside a ship it makes the line refused; alone, or after a fetch,
it ships nothing. A merge or an alias beside another ship is a write too.
**Companions** (F3): beside a ship, a git command is a read only in its
reading form: an option that runs a program or writes a file (`grep -O`,
`--ext-diff`, `--textconv`, `--output`) makes it a write, and `symbolic-ref`
(one operand, no `-d`), `remote` (listed, `show`, `get-url`) and `reflog`
(never `expire`, `delete`) count as reads only so. **Aliases, other
directories, other branches** (F10): a git command carrying `-c alias.*=` (or
`--config-env alias.*`) is unknown code and a possible ship of every branch
(judged as a push that may land on the default branch); a ship whose working
directory is outside the repository root, cannot be followed, or is pointed
elsewhere by `--git-dir`, `--work-tree` or `GIT_DIR` is refused (rule `gate`:
the harness judges only this repository); a push naming a source other than
the branch checked out, `HEAD` or `@` is refused with "push the branch you are
on" (rule `gate`, in `judgeShipping`). An alias defined in git's config is R32.

*As built (C2.1, two calls dispatched together):* the hook keeps a count, in
the module's memory, of main-loop tool calls in flight that can write (edit
tools; shell calls with written paths, an unknown writer, or a git
sub-command that is not a plain read; `callKind` in `hooks/rules.ts`) and of
those that ship. A call is counted from the moment its hook starts until it
ends, in a `finally`, so an error in the tool or in the hook (its `.catch`)
never leaks a count; a new main-loop turn starts the count over. A ship that
arrives while a write is in flight, and a write that arrives while a ship is,
is refused with rule `ship-alone`: run the push by itself, after the other
commands have finished. A build tool or script is not counted as a write (R33).

*As built (C2.1, F9):* an eval sandbox (`/tmp/devloop-eval-*`) is harness
state in an opted-in repository: a write beneath one by anyone but the eval
agent working in it is refused (`harness-state`, always held). *F7:* an `Edit`
with an empty `old_string` (which creates the file) is judged as a write of
its new content, by the content rules and by test-weakening.

Production, forbidden and egress read each command's own words: a quoted
argument with spaces in it is data, and a URL handed to a text tool (`grep`,
`echo`, a commit message) is not a host contacted.

*As built (D2):* `checklists/**` is a built-in protected path and, with the
policy's `instructions`, an instruction file (`instructionGlobs`: a change
to one is high tier and the "Instruction files changed" row names it). The
evidence-notes rule also reads git plumbing (`fast-import`, `update-ref`,
`symbolic-ref`, `hash-object -w`, `mktree`, `commit-tree`, `replace`) in a
line that names the ref anywhere (R35). Where the `.tasks` integration is on
(4.12), rule `tasks` refuses the command's `--force` and `--as` and an inline
`TASKS_ACTOR=`, `tasks done|cancel` unless the gate is green and the tier
needs no approval, an edit that changes a `task.md`'s frontmatter, and any
edit or shell write of a task's `log.md`, `.tasks/config.yml`, `.locks/` or
`index.md`; each refusal names the command to use. Its lift class is
`person`; it holds only where `tasks.integrate` is `enforce` (and the mode is
enforce), and is recorded in `observe`: `isHeldBy` in `hooks/rules.ts` is the
one hold test of every enforcement point. An eval agent may run no `tasks`
command that writes (`eval-containment`): its worktree resolves to the real
tree.

**Exemptions** (`/devloop allow <glob>`, `/devloop allow --command <exact>`)
need a person (`composer` or `bridge`) and a dialog. Granted while a main-loop
turn is running, one applies to that turn and ends with it; granted while
idle, it binds to the next turn when it starts and ends with that one, however
it ends (F25, N17). A command exemption matches the
exact text and lifts every rule but those that always hold.

**No-progress tripwires** (11): two refusals of the same rule in a row (in one
turn, with no allowed call between: any allowed call resets the count, N14)
toast the person, and the second tells the builder to stop and report.
`devloop_blocked { reason }` records the reason, toasts the person, and lets
the stop gate pass the turn's end; the person's next prompt clears it.

**Test weakening** (11, B2) is judged after the rules above, so a locked test
is refused as locked first: rule `test-weakened`, lifted by a person's path
exemption. An edit tool's change to a file matching `tests` is compared
before and after (`hooks/weaken.ts`); a shell command is judged by the paths
it deletes or renames away (`removedTests` in `hooks/rules.ts`).
*As built (B2.1):* a test file being created is judged with a before-count
of zero, so a focus or skip marker, or a runner override (a Go `TestMain`
that never calls `m.Run()`, a module-level `pytestmark` skip), in a new file
is refused like any rise (F3). A marker counts only at the start of a call,
never after a dot, `$` or an identifier character, so `model.fit(X, y)` is no
focused test (F8; R18). For deletion and renaming a test is a file git tracks
that matches the test globs: where the hook listed what git tracks, untracked
caches and logs under a test folder are not tests; where it could not list
(outside git), the globs alone decide (F9; R19). *As built (C1, item 10):*
while building, `tests-locked` uses the same definition: a path under a test
folder that the hook listed and found untracked, whose name matches no test
file-name glob (the `tests` globs that do not end in a folder's `**`) and
that was not hashed at approval, is not locked, so removing
`tests/__pycache__` or writing `tests/output.log` is allowed in build too.
Unlisted (outside git), the globs decide, as before.

Edits to **instruction files** (`instructions` globs) are allowed but flagged:
they raise the change to high tier and add a gate row a person must read,
because injected text in those files persists across sessions.

The reviewer and eval agents are identified by agent id. The reviewer may run
one line of plain readers joined by pipes, each reader's writing options
refused by name (`sort -o`, a second `uniq` operand, `git diff --output`,
`rg --pre`, `find -fprint|-delete|-exec`), or the repository's checks word for
word; nothing that ships, ever (F8). It reads the change from a diff file the
harness writes (5); `git grep -O` (`--open-files-in-pager`) is refused to it
(N12). *As built (B2):* `git grep -o` (`--only-matching`) is a read and is
allowed. Every reviewer of a round (the general one, specialists, a
restatement) is identified by its agent id, and all are read-only. Eval agents work in throwaway worktrees and are exempt only from the
path rules, and only for paths under their own worktree; production,
forbidden, egress, destructive and download-run rules hold for them as for the
builder, and anything they write outside the worktree, or ship, is refused
(F18, N9). An agent's own working directory places the
relative paths of its calls (F16). `Grep` and `Glob` paths are followed
through links before the secrets rule, as `Read`'s is (N13).

*As built (the cache-guard round):* the guards follow principles 13 to 15.
The push has one shape (R1); git's options are matched by prefix (R1);
computed values are the forbidden value for the always-held rules (R2, and
an eval agent's write to a computed path is outside its worktree); a path
is placed through the line's literal assignments and the named environment
variables (R8), through a link made earlier on the line (R15), and through
each wildcard match on disk (R9, P-C); a guarded folder is not written into,
replaced, moved or removed, nor any ancestor of it (R7); a recursive read of
a folder holding a secret folder is a read of the secret (R8); and
cache-guard's script is a person's to run (rule `cache-guard`, L1, 4.14).
The reviewer's writing options in git (`--output`, `--ext-diff`,
`--textconv`, `-O`) are matched by prefix too. Details in 4.11's note of
the same round.

### 4.3 Verification

- **Snapshot**: one shell call returns the working tree's content hash (a
  temporary index, `git add -A`, `git write-tree`), branch, head, base, changed
  files against the merge base, and diff size. *As built (B1):* the base is
  resolved in order: the configured branch on the remote, then locally, then
  the remote's HEAD, then `main`/`master`; a branch is never its own base. It
  reports `base:<sha>` or `base:unknown`; unknown shuts the gate (row "Base
  branch unknown") and doctor lists the branches. Diffs use `--no-renames`, so a
  rename shows the old path too (F13). Every changed file counts; only display
  is capped (F12). The temporary index must be copied
  with its timestamps (`cp -p`) so same-second, same-size edits are still
  detected (found in real-git testing).
  *As built (C1 review, F1):* nothing is left out of the hash (principle 9).
  The C1 handoff exclusion is gone: a file or a folder at any path, the old
  handoff path included, moves the hash and is listed like any other, and the
  snapshot takes no argument that could exclude one. Its arguments are the
  default branch, the last closed change's commit, and the sweep's pathspecs
  (`sweepSpecsOf`: the instruction globs of the policy in force, then the
  dependency and build folders and `instructionsIgnore` as excludes, which
  narrow only the sweep below). The sweep takes the shallowest first, at most
  500, and says `capped:<n>` past that: a gate note ("Ignored instruction
  files") and a doctor line (F12).
  *As built (C1):* instruction files git ignores (`instructions` globs as pathspecs)
  are added to the throwaway index with `-f` and so are in the verified tree;
  the snapshot lists each as `ignored:<blob> <path>`, the diff and the changed
  files are taken from the tree without them, and the loop counts one as
  changed when its blob differs from the one recorded when the change began
  (`loop.ignoredBase`), so it reaches the tier and the "Instruction files
  changed" row. `tests/smoke.sh` proves both against git.
  *As built (final round, D1 F4, F10):* beside the full tree the snapshot
  prints the **committable tree** (`committable:`, the tree `git add -A`
  would commit, without the force-added ignored instruction files) and
  HEAD's tree (`headtree:`). "Verified" names the full tree; what a push
  sends is compared with the committable tree (4.6), and evidence notes are
  keyed on it (4.11).
- **Stop gate** (`classic.Stop`, main loop only): if the tree hash differs from
  the one last verified, run the `fast` profile. On failure, block the stop
  with the distilled output. Budget: `maxFixRounds` per person prompt, then let
  the turn end and tell the person. *As built (B1):* a stop on the same tree as
  the last blocked stop ends the fix loop and tells the person. The message
  follows the phase (9.1). Each check's whole output is saved in the harness's
  state (5) and the block names the file. A gate that fails partway never
  blocks the stop; verification is marked `error`, the gate row is unmet, and
  the person is told (F26). When every feature is recorded passing and the fast
  checks pass, the feature checks whose passes do not cover the current tree
  are run again before a review starts; a failure blocks the stop (F27).
  *As built (B1.1):* in the `spec` phase the stop gate runs the fast checks
  and records the result, and blocks nothing: the tests are expected to fail
  there (12.3). A shell command that writes in the repository marks the loop
  dirty when it runs, so no pass shows for a tree that has moved (N15).
- *As built (D2):* where the `.tasks` integration is on, the stop gate first
  runs `tasks session-check --json --session <session id>`: a failure blocks
  the stop with the command's own words distilled, once per turn and within
  the fix-round budget (the classic stop gate does the same, once per
  prompt); in `observe`, or past the budget, it is recorded and the person
  is told. A review verdict carries over (4.12) only where git's diff of the
  two trees (`CARRY_DIFF`) names task state alone; verification itself
  always runs. *As built (final round, D2 F1):* `verifyNow`, session start
  and `refresh` only learn the diff's facts (`learnCarry`, kept in memory by
  the pair of trees); whether the verdict covers the tree is decided by one
  pure function, `verdictCovers` (hooks/gate.ts), each time the gate is
  shown. No carry target is stored.
- **Check outcome classification** (rea note, B2): a check whose program was
  not found (exit 127 or 126; *as built, B2.1:* decided by the exit code
  alone, never by the output text, which a test can print), that
  timed out (the harness's limit, or exit 124) or that was killed (exit 130,
  134, 137, 143) is an *infrastructure* outcome. The stop is not blocked and
  no fix round is spent; the person gets a toast saying which and what to do
  (install it or fix the command; raise `verifyTimeoutSec`; free resources),
  the model gets the same as context; the ledger kind is `check-infra`, it is
  never rerun as a flake, and the Verification row reads "could not run". A
  feature check that cannot run answers `COULD NOT RUN` the same way.
- **Failure fingerprint**: normalize the failing output (strip paths' line and
  column numbers, timings, hex, ANSI) and hash it with the command. The same
  fingerprint twice in a row means the fix did not change the failure: the
  block message says so and asks for a different approach or a stop; the
  ledger groups by fingerprint.
- **Flake check**: when a check fails on a tree whose previous run of the same
  check passed and the changed files do not match the check's `when`, rerun it
  once; a pass on rerun records `flaky:<command>` in the ledger and does not
  block. *As built:* "changed" means between the tree it last passed on and
  now (`git diff` of the two snapshot trees), since the base diff already
  decided the check should run; a check with no `when` watches every file, so
  it is rerun only when the content is the same as on its pass.
- **Distillation**: the model gets the first lines that look like errors
  (`error`, `FAIL`, `Error:`, `panicked`, `Traceback`) and the tail, capped.
  Runtime-internal stack frames (`node:internal/…`, `File "<frozen …>"`) are
  dropped first (9.5), and so are the Node test runner's frames, which carry
  no `at` (`Test.run (node:internal/test_runner/…)`; carried into the final
  round).
- **Ship verification**: the gate runs `fast` + `full` on demand, because the
  builder cannot run `/devloop verify`. *As built (B1.1, N7):* a pass is
  recorded per check command with the tree it ran on (`verify.passedOn`); the
  ship gate runs every check of the base policy's fast and full profiles that
  has no pass on the current tree, so a check a change dropped from its own
  policy still runs, whichever run passed before. A failure on the same tree is
  not rerun. The filtered-check refusal names the saved output only when that
  file exists (N20). *As built (B2, decision 3):* the Verification row is met
  only when every fast and full check of the policy in force that applies to
  the change has a pass on the current tree, and its note names the checks
  still to run. Outside git (no tree to name a pass by) the last run and its
  profile decide, as before.

### 4.4 Spec

- `features.json`: `[{ id, description, check, dependsOn?, criteria? }]`.
  *As built (B1, F1):* a feature's status is plugin state only,
  `features[id] = { passes, tree }`. Approval starts every feature at not
  passing. *As built (B2, decision 1):* there is no mirror at all: the
  harness never writes `passes` into features.json, not at `/devloop done`
  either (the mirror left an uncommitted change in a protected file). A
  `passes` field a person writes is ignored on read. The status tool, the
  pane and the change report show feature status, from plugin state. A pass covers the tree it ran on; the gate row counts how many
  passes cover the current tree, and both the stop gate and the ship gate run
  stale ones again (F27). Reopening an approved spec is a person's key, with a
  dialog.
- **Approval** refuses: the template placeholder, duplicate ids, a feature
  without a check, and (after confirmation) reports **vacuous** checks — those
  that already pass before any implementation. Vacuous checks are listed in the
  dialog; approving with them is allowed but recorded on the change.
  *As built (B2):* the checks run *before* the dialog, since it must list
  them (`hooks/spec.ts` `specProblems`, `commands.ts` `approve`). Also
  refused: the template's SPEC.md lines (`1. (criterion)`, the intent
  placeholder), an entry with no id, a `dependsOn` naming no feature or
  itself, a dependency cycle, `criteria` that are not numbers, and any
  `[NEEDS CLARIFICATION` left in SPEC.md. The dialog lists, beside the
  vacuous checks, checks that could not run at all, the check-integrity lint
  of each feature check, and the numbered acceptance criteria no feature
  covers. What it showed is kept on the change (`loop.approval`), vacuous
  checks add a gate note and the `vacuous-checks` counter.
- **Spec coverage** (B2): a criterion is a `1.` or `1)` item under the
  "Acceptance criteria" heading. A feature covers the numbers in its
  `criteria`; with none, the criteria its description names as `criterion 3`
  or `AC3` (only those spellings, so a number in prose never counts).
- **Fingerprint**: SHA-256 over SPEC.md and each feature's id, description,
  check and dependsOn. A mismatch freezes `feature_check` until re-approval.
  *As built (B2):* `criteria` is covered too.
- **Test lock evidence**: at approval the harness stores the blob hash of every
  file matching `tests`. The gate has a row "Tests unchanged since approval";
  files that differ are listed (a shell command that slipped past the tripwire
  shows up here). New test files are allowed and listed separately.
  *As built (B2):* hashed are the tracked and untracked files git does not
  ignore. The row is met when no approved test differs, or when each that
  differs was matched by a path exemption a call used (`loop.exemptionsUsed`);
  a command exemption covers none (RESIDUAL-RISK). *As built (B2.1, F12):*
  an exemption is recorded as used only for a write it lifted a rule for, as
  that write's concrete path (or `command: <text>` for a command), never for
  a read; the record is cleared at approval and at `/devloop done`. The test
  files are hashed with the `tests` globs of the policy in force (the base
  branch's), at approval and after. A build with no record of the tests at
  approval (git could not list them) has the row unmet. It is proven with
  verification, `/devloop status`, `/devloop gate` and shipping; until then
  it reads "not checked on this tree yet". While building, `Write` may create
  a test file that existed neither on disk nor at approval; it is then the
  builder's to edit (`loop.newTests`), and weakening is still judged on it.
- *As built (B2.1):* **every feature check is judged by the command rules
  before it is ever run** (F6), at approval, in `feature_check` and in the
  reruns of the stop and ship gates, as the guard judges a command the
  builder typed (with the mode in force), and a check never ships. A refused
  check is not run: approval is refused while any is, listing each with its
  rule; `feature_check` answers `NOT RUN` with the rule; a rerun leaves the
  pass stale and toasts the person (R24). The dialog shows each check's
  command, shortened. **Approval fingerprints the text the checks ran on**
  (F5): SPEC.md, features.json and the test hashes are read before the
  checks run, read again after the dialog, and a change while the person
  decided refuses the approval.
- `feature_check` runs a feature only when its `dependsOn` features pass.
  *As built (B2):* pass *on the current tree*; the refusal names them, and
  the status lists the features that are ready (dependencies passing).
  *As built (D2):* ready features are listed in dependency order
  (`dependencyOrder`), without those under another session's live claim
  (4.12). A feature may name checklist items it keeps (`checklist`, or
  `"<list>/<item>"` strings among its `criteria`); the fingerprint covers
  them when there are any. Approval refuses while a checklist item that
  applies is unaccounted for, and its dialog lists the items kept, judged by
  a person, and struck (4.13); what it showed is `loop.approval.checklist`.
- *As built (spec interview, `docs/design-notes/spec-interview.md`):* the
  plugin ships the skill `devloop:spec` (`skills/spec/SKILL.md`, with
  `references/questions.md` and `references/example.md`), and the context
  `/devloop spec` adds tells the agent to follow it. The SPEC.md template
  gains a `Kind: … · Size: …` line, a `Related specs:` line and the sections
  Context, Constraints, and Risks and assumptions; it keeps the two
  placeholder lines approval refuses. `specProblems` is unchanged, so the
  new lines and sections are not required and older specs stay valid. The
  skill passes doctor's skill audit with no error or warning; since the
  plugin test world has no file system, `tests/smoke.sh` checks the shipped
  file.

### 4.5 Review

- **Reviewer agent** (`devloop:reviewer`): fresh context, tools Read/Grep/
  Glob/Bash, read-only by the guard's allowlist. *As built (B1):* the harness
  writes the whole diff (untracked files included) to a file in its state (5)
  and gives the reviewer the path. A round records the tree it started on; a
  verdict that arrives for another tree is discarded and is not a round (F6).
  A round `running` for thirty minutes is marked abandoned (F28).
  *As built (last review, I1):* the harness answers the engine's permission
  check (`tool.check`) for its own reviewer and checklist reviewer of the
  round in progress, and for nothing else: a Read of that round's diff file
  (`<state>/repos/<hash>/review-<round>.diff`), a Read, Grep or Glob inside
  the repository root (never a secret: the secrets rule refuses first at
  `tool.call`, and `reviewerMayRun` checks again), the repository's checks
  word for word and the commands `isReviewerCommand` allows. Only an `ask`
  from beneath is turned into `allow`; a deny stands, and anything else is
  left to the engine's ask. A builder's or an eval agent's call (or any
  other subagent's) is never answered; the hook's `.catch` answers deny.
  The engine allows this as assumed: `tool.check` carries the subagent's
  `agentId`, and a plugin hook's `allow` settles the call with no prompt
  (tests/lastreview.test.ts drives it through the test kit's subagent calls).
  *As built (the cache-guard round, R3, R5, R6, R10, R11):* the reviewer's
  checks are the base policy's `verify` commands, plus the approved spec's
  feature checks only while building and only when the spec on disk matches
  its approval fingerprint, each passed through the command rules as
  `feature_check` judges it (`reviewerChecks`); a feature check of a spec
  still being written is a command like any other, and its guard refuses
  it. Only the engine's own default ask is answered: an ask carrying a
  `rule`, `hook`, `setting` or `plugin` stands. Every path is judged where
  it really lands, resolved as the call guard resolves links
  (`reviewerPlaces`, then `resolve`): inside the root, or the round's diff
  file; a path that cannot be resolved is never answered. A command is
  answered only when every path operand the shell model classifies for it
  (`Segment.reads`, with `isReadKnown`) and the folder it runs in land
  inside, and `git diff --no-index` never; a call setting
  `dangerouslyDisableSandbox` or `run_in_background` is never answered.
  What is not answered still asks; the guard's own verdict is unchanged.
  The harness keeps the SHA-256 of each round's diff file when it writes it
  (`review-diff:<root>:<round>`); on the reviewer's read it checks the file,
  and on a mismatch writes it again from the tree, records
  `harness-state-changed` and tells the person, and the read goes on.
- **Instructions come from the base branch**: the harness reads `REVIEW.md`
  with `git show <merge-base>:REVIEW.md` and passes it in the prompt; the
  working-tree copy is ignored, so a change cannot rewrite its own review.
- **Findings are structured**: the reviewer lists findings as
  `F<n> | <severity> | <file>:<line> | <problem> | <evidence that would close it>`
  and ends with `VERDICT: PASS|FAIL`. The harness parses them, stores them, and
  in later rounds passes the open ones back for re-check; a finding the
  reviewer marks resolved is closed.
- **Rounds** are capped (`maxReviewRounds`); after the cap the builder is told
  to stop and a person is told to read the change. *As built (the
  cache-guard round, Z1):* the cap is for one change. A push the gate
  passed, which the check after the fact confirms shipped what the gate
  judged (the push returned without error and the gate is green on the tree
  as it now is), closes the count: the round number and the stall flag
  return to zero for what comes next (`closeShippedReview` in
  `hooks/review.ts`, called from `checkShipped`). A round that passed
  without a push, followed by more edits, still counts. *As built (the
  fourteenth round, CC-F7):* only a real push closes it (`closesReview` in
  `hooks/rules.ts`): a line that is a push under both readings, with no
  push in it asking for a dry run under either (`-n`, `--dry-run`, as git
  matches options), one command and not run in the background (neither a
  `&` on the line nor the tool's `run_in_background`).
- **Specialist reviewers** from policy run when their `when` globs match.
  `blocking` ones join the gate; `shadow` ones never block: their verdicts are
  only counted, so a person can decide from numbers when to promote them.
  A built-in `security` brief ships; others supply a `prompt`.
- **Automatic review** starts when a build has every feature passing and
  verification is green, on medium and high tiers. *As built (C1, item 11a,
  from a live session):* once a review loop has begun (a round failed and its
  findings went to the builder: `review.isLooping`), the next stop where
  verification passes on a tree other than the reviewed one starts the next
  round, in every phase (small-fix included), when `autoReview` is on in the
  policy in force and the cap and stall rules allow. The hand-off text is a
  function of what will happen (`afterFix`): the next round starts by itself;
  a person starts it with `/devloop review` (`autoReview` off); or the cap is
  spent and a person reads the change. *(11b):* the round header accounts for
  every id it names: `to fix` when it is in the list handed over, or a clause
  saying why not (addressed, a note, deferred to the backlog, a person's
  decision, not blocking at the tier) (`roundHeader`). *As built (B2.1):* the
  stop gate reads `autoReview` (and the tier and cap) from the policy in
  force, the base branch's, like the rest of the review settings.

*As built (D2):* a round also answers the checklists that apply (4.13):
`pattern` and `check` items in code at its start, `review` items by one
checklist reviewer (the `devloop:reviewer` agent with a checklist brief,
read-only as every reviewer of the round, mode `shadow`: it never holds or
decides the round, and is no reviewer of the portable evidence). A
restatement of its answer replaces it in the round's agent list.
*As built (final round, D2 F11):* its answers resolve only against the lists
loaded from the base for that round (the base is kept with what it was
sent), never the working tree's.

*As built (B2):* `hooks/findings.ts` holds the pure part (parser, quote
check, tier table, lifecycle, backlog, prompts), `hooks/review.ts` the work.

- **Prompt**: three fixed parts, stable first. (1) Task: the brief, REVIEW.md
  as `git show <base>:REVIEW.md` gives it (with none on the base the prompt
  says so and the built-in brief stands alone), the spec path, the base
  commit, the diff path. (2) Current facts: tier and which severities block
  at it, changed files, checks, round, the open findings to re-check in the
  format, and the number new findings start from. (3) The contract: format,
  the cap of 12, what not to report, the assurance boundary. Nothing like
  "look harder" is passed forward. *As built (B2.1):* the diff path carries
  the round number, so it is a current fact (part 2), and part 1 is the same
  every round.
- **Format**: `F<n> | <critical|high|medium|low|nit> | <file>:<line> |
  <quote> | <problem> | <evidence>`, optionally `| pre_existing` and a route
  `| fix|decision|defer` (default `fix`); `F<n> | resolved|open` re-checks an
  earlier finding; the last `VERDICT: PASS|FAIL` counts. The parser skips
  markdown around a line and keeps a `|` inside a quote.
- **Format failure**: an answer with no readable verdict is restated once by
  a second agent given that answer, with the same model; it is not a round.
  A second miss leaves a harness finding (no file, route `decision`) that
  blocks until a person resolves it or the next round starts.
  *As built (B2.1, F1):* a round passes only on positive evidence: a verdict
  line, every finding-like line (`F<n>` then a field mark) read, and no open
  blocking finding. An answer is restated once when it has no verdict, when a
  finding-like line does not fit (a field missing, an unknown severity, no
  line number; a heading mark is read), when it says FAIL with no readable
  finding, or when a blocking finding's quote is not at its line. If the
  restatement is still unreadable, the harness raises a `decision` finding
  ("the reviewer failed this change and gave no readable finding", or that
  its finding lines could not be read) that blocks until a person resolves
  it; a new round does not close it. Only a harness finding about a
  reviewer that could not start ends with the next round. Prose beside a
  readable verdict is not judged (R23).
- **Deciding a round**: when every reviewer of the round has answered, each
  quote is checked at its line or within three lines in the reviewed tree
  (a quote under three characters proves nothing); one not there is a note
  that never blocks. *As built (B2.1, F2, F11):* the round is decided when
  the general and every blocking reviewer have answered; a shadow reviewer's
  answer is counted when it arrives, and its abort or silence changes
  nothing. A `|` may sit in the quote or the problem: the parser keeps every
  split of the fields after `file:line` and the harness keeps the one whose
  quote is in the file (the longest). Quotes are compared without backticks,
  a leading diff mark (`+`, `-`), surrounding whitespace and runs of spaces;
  `file:line:col` and a backticked file name are read. A finding whose quote
  cannot be found is a note only when its severity does not block at the
  tier; a blocking one becomes a `decision` finding for a person. The cap of
  12 is applied after the quotes are checked, with `pre_existing` ranked
  last. Blocking scales with tier (low: critical; medium:
  critical, high; high: all but nit); `pre_existing` and `defer` never
  block; at most 12 per reviewer, the most severe kept. The round passes when
  no blocking finding is open, whatever the verdict line says.
- **Lifecycle**: an open `fix` finding is closed when its reviewer says
  `resolved`, or, if not re-checked, when its quoted line is gone; re-reported
  (same id and file) or still quoted, it stays open. A new finding matching a
  closed one by file and quote has reappeared and reopens under its old id; one
  matching an open or person-resolved finding is not new. The round's summary
  ("addressed …; reappeared …; still open …; new …") opens the builder's
  message. Only `fix` findings go to the builder, in the format; `decision`
  findings are toasted to the person and block until `/devloop findings
  resolve <id> <note>` (a person, with a dialog). `defer` and non-blocking
  verified findings go to the backlog `deferred:<root>` in `$.store`, kept
  across changes by file and quote and closed when the quoted line is gone
  (checked at each round and at `/devloop findings`).
- **Stall**: a round that had open `fix` findings and closed none is stalled;
  two in a row end the loop before the cap (`review.isStalled`), toast the
  person and tell the builder to stop; `/devloop review` then refuses.
- **Specialists**: the reviewers and models come from the base branch's
  policy, so a change cannot drop its own specialist. Each runs as the same
  `devloop:reviewer` agent type with its own brief (its `prompt`, the
  built-in `security` brief, or a generic one). *As built (B2.1, F4):* the
  open findings of a specialist that no longer applies are given to the
  general reviewer to re-check, and its answer closes or keeps them. A blocking specialist's row
  is met only once it ran in the round on this tree (the round's agent list
  is kept, answers dropped); one that could not start leaves a harness
  finding. Shadow counters: `shadow:<name>:rounds`, `:would-block`,
  `:agreed` (would-block equal to the general reviewer's outcome).
- **Models**: `models.reviewer` for the general reviewer, a specialist's own
  `model` then `models.specialist`, `models.eval` for eval agents; absent,
  the session's.

### 4.6 Risk, approvals and the gate

- **Tier** = the riskiest changed file: `high` if any file matches
  `tiers.high`, `protected` or `instructions`; `low` if all match `tiers.low`
  and no test changed; else `medium`.
- **Blast radius** raises the tier one step when the change exceeds
  `maxFiles`/`maxLines` or touches a dependency manifest, and says why.
  *As built (B2):* one step in all, however many reasons; a change with no
  files stays `none`; the gate note "Blast radius" names the reasons. A push
  to the default branch is judged on its commits' files (their line count is
  not known there), so only the file count and manifests raise it.
- **Gate rows**: verification (profile-aware), spec approval, features,
  tests-unchanged, each blocking reviewer, instruction-files-changed,
  blast-radius notes. The last row names the people who must approve
  (`approvals`): no state of the loop ticks it.
- **Shipping**: nothing ships until every row the harness can meet is met.
  Merging, and pushing to the default branch, is refused to the agent whenever
  `approvals[tier] > 0`. *As built (B1, F3):* `gh pr merge` is always refused
  (rule `human-merge`): the harness cannot see the pull request's tier. `git
  merge` while on the default branch (or, after a switch in the same line, on
  it or possibly on it: N1) is refused the same way. A push that
  lands on the default branch (named, `HEAD:refs/heads/main`, `--all`, or a bare
  push while on it) is judged on the commits not yet on the remote default
  branch, with `approvals` at its defaults (low 0, medium 1, high 2, until the
  field is read); with the remote branch unknown it is refused. The gate judges
  by the base branch's `devloop.json` (11). Rows added in B1: "Policy error",
  "Base branch unknown", "Policy changed in this change" (or "Policy" when the
  base has no copy), "Check integrity".
- `/devloop gate` answers the same check with an exit code (0 green, 1 not),
  so CI can run `claude -p "/devloop gate"`.

*As built (B2):* `approvals` is read from policy: the merge line
(`approvers`) and the push-to-default rule use `approvals[tier]`. The gate
code moved to `hooks/gate.ts` and the shipping judgment to `hooks/ship.ts`;
`prove` there is shared by shipping and `/devloop gate`, which proves on
demand (runs the base policy's checks with no pass on this tree, reruns stale
feature passes, proves the evidence rows; an empty change runs nothing) and
sets `exitCode`. New rows: "Tests unchanged since approval", "Review: <name>"
per blocking specialist, "No credentials in the diff" (rea note: a short
scan of the added lines, `hooks/scan.ts`: AWS key ids, GitHub and Slack
tokens, private-key headers, and `api_key`/`secret`/`token`/`password`
assignments of 20+ characters at 3.5 bits per character or more; obvious
placeholders never fire; unmet names file, line and kind, never the value;
unscanned on this tree is unmet; *as built, B2.1:* outside git the row reads
"not scanned" and is unmet for medium and high tiers; the generic shape
covers environment, YAML and ini assignments, its key must end in a
credential word and its value clear the entropy floor and not be a URL, a
path, a pattern or an upper-case constant name; a private-key header counts
only as a line of its own; for a provider prefix at its exact length only
obvious placeholders are skipped, L1; R20, R21), and the notes "Assertions removed in
<file>", "Vacuous checks at approval", "Blast radius". Who must approve stays
a line beside the rows, which no state of the loop ticks.

*As built (C2, L2, decision 9b):* **a check after the fact.** After a shell
call whose text shipped (as `judgeShipping` reads it) returns without error,
the hook snapshots the tree and judges the gate again. Not green for what was
shipped: an audit event `shipped-ungated` (the command's first 80
characters, the tree, the unmet rows), a ledger entry of its own kind, a
`gate@1` record, a loud toast, and context on the tool result telling the
builder to stop and tell the person. This is detection, not prevention: what
was pushed is already pushed (R31). The ship gate also runs the regression
checks of closed specs (11) and keeps a row "Regression checks".
*As built (C2.1, F12):* the check after the fact runs whenever the text held
a ship intent, the result an error or not: the push may have happened all
the same. *As built (C2.1):* with the working copy of `devloop.json` deleted
and the base's in force, the row "Policy changed in this change" reads
"devloop.json was deleted". The "Check environment" note is one short line
("checks could see 5 credential-shaped variables; /devloop doctor lists
them"), never the names, wherever gate rows are shown (the status tool, the
gate, the pane); doctor keeps the list. The status tool also lists each open
finding the builder is to fix (open, blocking, route `fix`) as its full line
(id, severity, file:line, quote, problem, evidence), so a builder polling
status has them without waiting for the hand-off; other open findings,
deferred findings and notes are counted, not listed.

*As built (D2):* a review row is met by a verdict carried over to this tree
(4.12): it reads "passed on <tree>; only task state has changed since". A
promoted checklist item whose latest result on this tree failed is a row of
its own, "Checklist: <list>/<item>" (4.13); shadow items, and `person` and
`runtime` items, never reach the gate.

*As built (final round, D2 F1, F2; principle 12):* the review row decides
whether the verdict covers this tree with `verdictCovers` from the facts it
is given (`GateFacts.carry`: git's diff of the verdict's tree and this one,
and whether the task files validate), every time it is shown; with no fact
the verdict covers only its own tree. A promoted checklist item that failed
on the verdict's tree is shown, as its row, wherever the verdict carries
("failed on the reviewed tree <tree>, and the verdict carries here"), and
makes the general review row unmet ("a failing verdict"); the status bar
above the prompt reads `review ✗ changes asked`. A new round clears the previous verdict's
checklist failures before its own are derived.

*As built (final round, D1 F4):* **a push is allowed only when the
committable tree equals HEAD's tree**: the gate judges the tree, a push
sends commits, and they must be the same thing. Otherwise it is refused
(rule `gate`): "Commit or stash first", because the gate would judge files
the push does not send (or the push would send commits the gate did not
judge). The module's ship gate and the classic hook compare with HEAD's
tree; the pre-push hook passes the commits git's input names to `gate
--pushing <commit>…`, whose row "What the push sends" compares each.
Untracked files git ignores are in neither tree, so they never stop a push.

*As built (B2.1, F4):* a review row is unmet at every tier while any finding
is open and blocking, whoever raised it: below medium tier the "Independent
review" row appears while one is open, and the general row holds the open
blocking findings of a reviewer with no row of its own (a specialist that no
longer applies, the harness's own).

### 4.7 Context

- **Rules section** in the system prompt: about a dozen lines, stable per
  thread.
- **Status delta** attached to a person's prompt only when it changed.
- **Cold-start briefing**: the first prompt of a session with an active spec
  gets the end of the last handoff, the failing features, and the last
  failure's first line — bounded to a few hundred tokens.
- **Context pressure**: past `contextHandoffPercent` the person gets a toast
  and the model a one-line note to finish the step; `/devloop handoff` writes
  a structured entry (phase, features, open findings, last failure) for a
  fresh session, kept in the harness's state.
- **Doctor** audits: config errors; instruction files (length, ALL-CAPS
  emphasis, references to paths that no longer exist); skills over 500 lines;
  number of tools in context; sandbox settings; credential-shaped environment
  variables; default-branch work; eval suite size.
- **Status tool** (`devloop_status`): read-only, lets the builder read the gate
  instead of guessing.

*As built (C1).* The pure parts are `hooks/context.ts` (deltas, budget,
briefing, pressure, handoff entry, attribution, questions), `hooks/cache.ts`
(the meter), `hooks/lint.ts` (instruction and skill lints) and
`hooks/inject.ts` (the injection scan); `register.tsx` and `commands.ts` do
the work.

- **Prefix stability.** The section is one constant (`RULES` in
  `templates.ts`): no phase, count, mode, verify command, host, path, model
  or time. Whether it is sent is decided at a thread's first composition
  (opted in or not) and kept for the thread (a new session id, or `/clear`,
  decides again). *As built (C1 review, F6):* the decision is kept in plugin
  state (`devloop.section`, shape `section-1`) by session id, so a plugin
  reload under the same session reuses it rather than deciding again. Every tool (`feature_check`, `devloop_status`,
  `devloop_blocked`, `devloop_handoff`, `devloop_question`, and from C2
  `devloop_papercut`) is registered at
  `session.start` before anything that could fail, with constant specs
  (`TOOL_SPECS`) and `isDeferred: true` everywhere, so a dormant repository
  pays nothing; `/devloop init` registers nothing. A tool called where the
  repository has not opted in says so. Tests render the section across every
  phase, both modes, with and without a spec and under different policies,
  and compare the tool specs of a dormant session, an opted-in one and after
  init.
- **Deltas.** Each source has a key, a label, a priority and its text:
  `status`, `policy-errors`, `policy` (the verify commands, hosts and mode
  moved out of the section), `gate` (unmet rows), `features`,
  `findings` (open blocking `fix` findings), `briefing` and `pressure` (the
  last two ephemeral: said once, never "cleared"). On a person's prompt each
  is `initial`, `changed` (or a line diff when shorter) or `removed`, and
  nothing when its hash is what this thread was last sent; a new thread or a
  compaction re-sends all as initial. Over `context.budgetTokens` (characters
  / 4) the lower-priority sources wait, are not recorded as sent, and one
  line points at the status tool. *As built (C1 review, F10):* a source is
  marked sent only when it is (the briefing included: a briefing that waited
  arrives with a later prompt, once); a source larger than the whole budget
  is sent cut, ending with a pointer to the status tool, rather than never. What was sent is kept in memory for the
  session; a reload re-sends as initial.
- **Cold-start briefing** on the first prompt of a session (or after
  `/clear`) with a spec active or a change open: the last six lines of the
  last handoff (from the harness's state), the phase, ready and failing features, the last failure's
  first line, findings awaiting a person, open questions; at most 1,200
  characters.
- **Context pressure** in tokens remaining, from `$.session.usage()`'s live
  window: warn when 30% of the window remains or 300,000 tokens are in use,
  whichever comes first; save at 15% or 400,000 in use (`context.warnRemaining`
  / `saveRemaining` set them in tokens remaining). On a million-token window
  the caps fire at 300,000 and 400,000 in use rather than waiting until
  150,000 remain. Checked at each main-loop tool call (the note rides on the
  tool result's context) and each prompt; said at once on escalation, again
  at the same level only after `context.debounceCalls` calls, reset when the
  level drops (a compaction). The save level toasts the person and tells the
  builder to call `devloop_handoff` now.
- **Handoff.** `devloop_handoff { objective, decisions[], workState,
  deadEnds[], assumptions[{ assumption, command }], nextStep, files[] }`
  (objective and nextStep required, files capped at 15) appends an entry to
  the repository's handoff record; the facts (phase, features
  passing/ready/failing, open findings, last failure, changed files, the last
  five commits, tree hash, time) come from plugin state and git. `/devloop
  handoff` (a person) writes a facts-only entry. *As built (C1 review, F1,
  F5):* the record is `handoff.md` in the harness's state folder for the
  repository (5), never the working tree, so writing one moves no hash and no
  policy can point the tool at a locked test, a secret or a link; the last
  fifty entries are kept. `/devloop handoff show [n]` prints the last n;
  `/devloop handoff export <path>` (a person) writes them into the
  repository as an ordinary change, judged by the path rules of the policy in
  force (no secret, harness state, protected file or locked test, nothing
  outside the repository) and refused in every mode, never only recorded.
  *As built (C2.1):* a file already at the path is overwritten only after a
  dialog. `/devloop init` writes no `PROGRESS.md`; the AGENTS.md template and the
  rules section name the tool and the briefing.
- **Idle gap.** On a person's prompt, when the last main-loop response is
  older than `cache.ttlMinutes` and the live context is over
  `context.idleWarnTokens`, the person gets one toast per gap with the tokens
  the prompt will re-write; the model is told nothing.
- **Doctor** adds: the instruction audit (launch-loaded bytes against
  `instructionMaxBytes`, counting instruction files outside a `skills` folder
  and each skill's description; lines per file; ALL-CAPS emphasis outside
  code; backticked or linked relative paths that do not exist; package
  scripts and make targets named that do not exist; paragraphs of 80+
  characters repeated between files; formatting rules restated where a
  formatter config exists), the skills note's checks per `SKILL.md`, the
  injection scan by file and line, instruction files git does not track (by
  `git ls-files`: tracked, untracked, ignored), the tools in context with
  their definition tokens (the engine's `summary` breakdown of tool-server
  and built-in tools when it gives one, else the tool listing's text / 4,
  labelled an estimate; a warning past 15,000), and what checks can see
  (`checkEnv`). `--strict` sets exit code 1 when an error-level item is
  present. *As built (C1 review, F2, F7, F8):* heuristic lints never produce
  errors. An error is only: a policy error; hidden characters (zero-width
  space, tag characters, bidirectional overrides, and joiners, except a
  zero-width joiner inside an emoji sequence and a zero-width non-joiner
  between letters of a script that needs it); the instruction byte budget;
  and a skill's hard limits (a description present and at most 400
  characters, under 500 lines, no tool server shipped). Stale paths, missing
  scripts and targets, the line limit, emphasis, a skill's other checks and
  the other injection classes are warnings. A make target counts only inside
  code and only where a Makefile exists; a path counts only when it looks
  like a repository path and is not a MIME type, a git ref, a glob or a
  placeholder or example name; a script is resolved in the folder a
  preceding `cd` names. The negation check applies to every non-hidden
  class, and a line that names an example or template file is no secret
  read. Doctor ends with the residual-risk register's headings, one line
  each (`hooks/residual.ts`; `tests/smoke.sh` fails when
  docs/RESIDUAL-RISK.md names an id the constant lacks).
- **Status tool** takes `detail`: the cache meter and the context-cost
  estimate, which are never injected; open questions are always listed.
- *As built (D2):* the status tool and the cold-start briefing list the ready
  features in dependency order, and, only when another session holds a live
  claim, each feature as ready, claimed by another (who, and the time left),
  claimed by you, or passing. In the spec phase the checklist items that
  apply are a context source (`checklists`) offered as candidate criteria.
  Doctor adds the claims lease, whether follow-ups are on (and if not, why:
  `followUp.ci` false, `gh` missing or signed out), and the `.tasks`
  integration (the setting, whether a version 2 tree is there, whether the
  command is on the PATH). Tools `devloop_claim` and `devloop_release` join
  the constant `TOOL_SPECS` (eight tools).

### 4.8 Learning

- **Ledger**: every refusal, observed refusal, failed check (by fingerprint),
  failed feature, finding and lesson, with time and key.
- `/devloop learn`: groups repeats and asks the model to propose the cheapest
  durable fix in order: lint/test/hook → path-scoped rule → instruction line →
  skill; each with an eval task.
- `/devloop prune`: rules with hit counts and last-fired time, instruction
  length, eval history; candidates are compensations for model weakness, never
  organisational facts.
- **Model change** is detected at session start and prompts eval then prune.
- **Evals**: `evals/tasks/<id>.json` = `{ prompt, check, setup? }`. Each task
  runs with a fresh agent in a throwaway worktree, `evalTrials` times; a task
  passes only if every trial passes (consistency). History is kept per model;
  `/devloop eval compare` shows the last two runs and flags regressions.

*As built (C2).* The pure parts are `hooks/ledger.ts` (learn's groups,
papercut groups, rule hits, prune's report, the cost meter),
`hooks/contentrules.ts`, `hooks/evalplan.ts` and `hooks/records.ts`;
`hooks/evals.ts`, `hooks/regress.ts`, `hooks/journal.ts` and
`hooks/learning.ts` do the work.

- **Papercuts** (skills note 1): `devloop_papercut { tried, expected,
  happened, suggestedFix, subject? }`, registered at load with the other tools
  (constant spec), never blocking, three per turn. Stored as `papercut@1`
  (`papercuts:<root>`) and in the ledger (kind `papercut`), grouped by subject
  and a fingerprint of `happened` (normalised as a check's output is: line
  numbers, timings, hex): group `p-<6 hex>`. `/devloop papercuts` lists groups
  by count; `/devloop papercuts close <group> <note>` is a person's (audited); a
  group filed again after its close is flagged REGRESSION, recorded
  (`papercut-regression`) and toasted. One line of the rules section says when
  to file one; the section is still one constant.
- **Content rules** (11): checked in `tool.call` against the lines an `Edit`
  or `Write` *adds* (a multiset line difference, so a moved line is not added)
  to a file the rule's globs match, with the policy in force's (the base
  branch's) rules. `note` records (ledger kind `content-rule`); `refuse`
  refuses (rule `content-rule`, lift class `policy`, ledger and hits under the
  rule's id); `ratchet` refuses an edit that raises the file's count of
  unmarked matches. A match is marked by `devloop-allow: <id> <reason>` on its
  line or on a line of its own above it. The baseline (the count across the
  tracked files the globs match) is taken at session start and kept in
  `ratchet:<root>`, never in the repository; it falls with an allowed edit that
  lowers a file's count and with a recount that finds fewer; a recount that
  finds more (a write no edit tool made) is a ledger entry `ratchet-over`.
  Hits and last-fired times per rule (built-in and content) are kept in
  `rulehits:<root>`. `NotebookEdit` and shell writes are not judged (R28).
  *As built (C2.1, F8):* a recorded hit holds the rule id, the path, the line
  number and a fingerprint of the line, never the line itself (the refusal
  the builder reads still quotes it); nothing of a matched line reaches the
  ledger, the audit trail, the metrics export, the report or learn.
- **`/devloop learn`** groups refusals by rule, check failures by
  fingerprint, feature failures, findings by file, papercuts and lessons
  (two or more), each with its cheapest rung, and hands the model the ladder:
  content rule, lint, test or hook; path-scoped rule; one instruction line;
  skill; each proposal naming the eval task that would prove it. Proposals
  only. *As built (learning, 4.17):* learn also runs by itself: the harness
  writes two lessons, a read-only proposer reads the repeats at
  `learning.repeats` and at `/devloop done`, a proposed content rule goes on
  trial (it records hits and refuses nothing), and a person promotes it with
  `/devloop rules promote <id>`; see 4.17.
- **`/devloop prune`** lists every built-in rule, content rule and tracked
  instruction file with hits and last firing, the rules that never fired in
  `pruneWindowDays`, ablation evidence, tasks outside the useful band and
  per-skill use. `/devloop prune remove <id> <evidence>` (a person, dialog,
  audited) records a tombstone; learn does not propose a tombstoned rule
  again unless its failure recurs after the tombstone's date. It records the
  removal; the person edits the policy or the file.
- **Evals.** A task file is `{ prompt, check, setup?, solution?, nearMiss?,
  expect?, tags? }` (`hooks/evalplan.ts` `parseTask`). *Validation* (`/devloop
  eval validate`, and before a run for any task whose file hash has no
  validation): the four-stage witness in a fresh sandbox (seed fails; solution,
  a patch or a command, passes; after a reset the check fails again; the near
  miss fails); a task that fails it, or never passed it, is left out of runs
  and named. *Trials*: `evalTrials` per task; infrastructure trials (no agent,
  an agent aborted or past 30 minutes, a check that could not run, a sandbox
  or setup that failed) are left out; a task passes only if every counted
  trial passed; the success rate is kept beside it. *Trajectories*: the tool
  calls the harness saw the eval agent make (tool, the skill of a `Skill`
  call, a guard that fired, refused or observed) against `expect: { mustUse,
  mustNotUse, order, maxToolCalls, noRefusal, refusal }`. *Quick*: tasks
  tagged `quick`, else the first `evalQuick` by a stable hash; labelled, never
  the headline. *Resumable*: progress (`evalrun:<root>`) is written after every
  trial; the run is written to the history (`evals:<root>`) last, as its
  completion marker; a run interrupted (a session ended) resumes on the next
  `/devloop eval`, the lost trial run again. *Isolation*: `evalIsolation`
  `worktree` or `clone` (a fresh clone of HEAD); both start from HEAD, so
  untracked files are absent in each; the clone also shares no git dir.
  *Environment*: the check, setup, solution and near miss obey `checkEnv`.
  *Budget*: the dialog projects the cost from the last run's cost per trial
  (an estimate; "unknown" with none). *Stopping*: an ablation's `without`
  pass stops once the tasks left cannot change its verdict; a full run does
  not stop early (its comparison is per task). *Band*: a task whose every
  trial passed (or failed) in the last `saturationRuns` full runs of the same
  task file is flagged in the run's summary and in prune. *Ablation*:
  `/devloop eval --without <rule | file | skill>` runs the baseline twice and
  then without it; a rule (built-in, never one always held, or a content
  rule) is switched off for the eval agents of the `without` pass only; a file
  or skill folder is removed from that pass's sandboxes. The noise band is
  the number of tasks whose outcome differed between the two baselines; a
  difference inside it is "no measurable effect"; the verdict is kept in
  `ablations:<root>` for prune. *Compare*: the last two complete full runs
  without ablation, only tasks whose file hash is the same in both, with how
  many were left out and the regressions. *Failures feed the suite*: `/devloop
  defect`, a review loop that ended failed (stalled or at the cap) and a change
  closed with the gate open each add a suggestion (`evalsuggest:<root>`);
  `/devloop eval adopt <id>` (a person, dialog, audited) scaffolds
  `evals/candidates/<id>.json`, which the builder cannot write (`evals/**` is
  protected). Eval records are `eval-result@1` with their inputs (the suite's
  task hashes).
  *As built (C2.1, F1):* every command a task carries (setup, check, and a
  solution or near miss that is not a patch) is judged by the command rules
  before it is ever run, in validation and in runs, exactly as feature checks
  and regression checks are (enforce: every rule; observe: those always
  held), as in small-fix mode since a sandbox belongs to no spec. A task with
  a refused command is not run (no sandbox is made), is left out, and is named
  with the field and the rule ("Left out, refused by the command rules: …");
  a run judges again before each trial and before scoring, so a task recorded
  valid under another policy is not run either. `/devloop eval validate` needs
  a person and a dialog, as `/devloop eval` does. *F9:* before the agent
  starts, `evals/` is removed from its sandbox, and the harness scores the
  trial from its own copy of the task (`evalcopy:<root>`, taken when the
  trial starts), never the working tree's file; an eval agent's reads are not
  contained (R34). *F4:* an ablation leaves a task that was an infrastructure
  outcome in any of its three passes out of all three counts
  (`countedResults`); a pass with no counted task gives no verdict and no
  evidence is stored; stopping early weighs every outcome of each task left,
  infrastructure included (up to six tasks left; with more, the pass runs on).

### 4.9 Measurement

- **Change record** written at `/devloop done`: spec, tier, files, lines, fix
  rounds, review rounds and first-pass, vacuous checks, exemptions used, gate
  state at close, duration, estimated cost (labelled an estimate).
- `/devloop defect <text>` records an escaped defect against the last closed
  change; `/devloop metrics` reports escaped-defect rate, first-pass review
  rate, mean rounds, verification failure rate, refusals by rule, flaky checks,
  reverts, shadow-reviewer disagreement, and eval pass rate by model.
- `/devloop report` prints a change report suitable for a pull request body.

*As built (C2).* `hooks/report.ts` is pure and table-tested.

- **Cost by delta** (skills note 4): `meterCost` samples the session's cost
  estimate at units of work and attributes the difference since the last
  sample (same session only) to the change and to each unit open: per feature
  (the cost since the last `feature_check` goes to the feature checked), per
  fix round (from a blocked stop to the next stop), per review round (start to
  settlement), per `Skill` call (to the next person prompt), with per-skill use
  counts and error-after-use counts (a refusal or a failed verification before
  the next prompt). Always labelled an estimate (`costs:<root>`).
- **Change record** (`change-record@1`, `changes:<root>`), written at
  `/devloop done` for any change with files or a spec: spec, tier and why,
  files and lines, fix rounds (`loop.tally`), review rounds and first-pass,
  vacuous checks, exemptions used, findings (blocking, deferred, resolved by a
  person), gate state at close, duration, estimated cost, the change's cache
  hit rate, and the inputs (policy hash, model, harness version, tree). Ids
  are `C<n>`.
- **Human attestation**: `/devloop done` asks the person, in a dialog of its
  own (several answers allowed), which they read: the diff, the test
  changes, the instruction-file changes. Only that answer sets the block; no
  tool of the builder's names it, and `/devloop done` refuses every origin but
  a person's.
- **`/devloop defect <text> [--change C<n>]`** (a person, audited): an escaped
  defect against the last closed change. A regression check that fails is one
  too, against the change it came from (once per change in progress).
- **`/devloop metrics`**: escaped-defect rate, first-pass review rate, mean fix
  and review rounds, verification failure rate (failures over runs), refusals
  by rule, flaky checks, reverts, shadow-reviewer agreement, eval pass rate by
  model (complete full runs only; the last quick run labelled), cost per
  change, cache hit rate, and the meters of C1. `--json` exports what is
  stored: the counters, change records, defects, eval history, regression
  set, rule hits, papercuts, ablations, the cost meter and the cache meter.
- **`/devloop report`**: for the change in progress, deterministic, from the
  records: tier and why, features, the reading aid (files by tier with the
  reason; what the reviewers did not look at: no round, a tree that moved
  after it, a specialist that did not run, notes; up to three failure
  scenarios from open or person-resolved findings; whether it could be split,
  by top folder, blast radius and manifests) and the disclosure block (files
  written through the agent's tools or commands, `loop.agentWritten`; files
  not; each review verdict from the audit trail with its tree; what a person
  attested to). With no change open, a line on the last closed change.
  *As built (C2.1, F11):* the verdicts are bounded by the last
  `change-closed` event, so a change with no write the harness attributed
  never lists an earlier change's verdicts.
- **`/devloop findings`** for a person (C2.1, a live session) also lists the
  notes and this change's deferred findings with their text: what the
  builder is not shown. Another caller gets the open, backlog and resolved
  lists only.

### 4.10 Interface

- Status bar: one colored line above the prompt (phase, tests, review, the gate
  as a bar, risk), hidden when nothing is in progress.
- Pane with tabs: **Gate** (rows, who approves), **Features**, **Activity**
  (recent events), **Metrics**. Buttons for verify, review, status.
- Toasts only for things a person must act on.

*As built (C2):* the pane has five tabs, **Gate** (rows, who approves, the
Verify, Review and Status buttons), **Features** (status per feature, ready
ones, the regression checks), **Findings** (open ones, decisions, resolved),
**Activity** (the loop's events and the last audit events) and **Metrics**
(the numbers of 4.9). *As built (D2):* the Features tab marks ready features
(dependency order, claims of other sessions left out) and names the session
holding a feature; it reads the claims from the store and writes nothing. The tab shown is the `devloop.tab` atom, written only by
a tab button's handler; the render hook reads and never writes. Tested by
mounting the pane on terminal, desktop, vscode and mobile. New toasts are a
papercut regression, a ship the gate had not passed and an invalid record.

## 5. State

- `$.state` `devloop.loop` (shaped): the change in progress.
- `$.state` `devloop.mode`: `off | observe | enforce`, as last read, so a guard
  that fails to run knows whether to refuse.
- `$.store`, keyed by repository root: `loop`, `ledger`, `metrics`, `changes`,
  `evals`, `model`, `config` (the last `devloop.json` that parsed),
  `deferred` (the review backlog, B2). The loop's shape tag is `loop-6` (B2).
  *As built (C1):* also `cache` (the meter: session and change counts, the
  last turn, misses), `attribution` (the context-cost estimate of the
  session) and `questions` (the open-questions ledger). The loop gains
  `ignoredBase`, `review.isLooping` and `evidence.hidden`; its shape tag is
  `loop-7`. *As built (C2):* the loop gains `regressions`, `tally` and
  `agentWritten`, and `evalRun` keeps only the live agent (its trial, cost at
  start and observed calls) and the ablation; shape tag `loop-8`. New in the
  store: `changes`, `defects`, `gates`, `handoffs`, `papercuts`,
  `papercut-closes`, `rulehits`, `ratchet`, `tombstones`, `ablations`,
  `regressions`, `evalrun`, `evalvalid`, `evalinvalid`, `evalsuggest`,
  `costs`, `policy-errors` (C2.1 adds `evalcopy`, the task a trial is scored
  from, and `audit-segments`). The `devloop.tab` atom holds the pane's tab.
  *As built (C1 review):* the `devloop.section` atom (shape `section-1`)
  holds the section decision by session id (F6); the repository's state
  folder holds `handoff.md` (the handoff record, F1) and the audit trail's
  archives; `audit-archive` in the store counts them.
- *As built (C2):* **records** (`hooks/records.ts`, `schemas/*.json`):
  `finding@1`, `papercut@1`, `handoff@1`, `change-record@1`, `eval-result@1`,
  `gate@1`, `audit-event@1`, each validated when written (`keepRecord`,
  `checkRecord`); one that does not fit is a ledger entry `record-invalid`, a
  counter and a toast, and is not stored (a finding is kept, since dropping it
  would fail unsafe). `tests/smoke.sh` checks the schema files equal the
  module's and the harness version equals plugin.json's. **The audit trail**
  is `audit.jsonl` in the repository's state folder (append-only, never
  written by a tool call: `harness-state`): spec approved and reopened,
  exemption granted (and for what), change closed (and the gate), each review
  verdict (reviewer and tree), finding resolved, each refusal held, policy
  errors (once per set), budget set, regression retired, tombstone, papercut
  closed, defect, eval adopted and started, `shipped-ungated`. Each names its
  actor: a person (by the command's origin), the builder, a named agent, or
  the harness itself (policy errors). Keys, counts, fingerprints and first
  lines only. `/devloop audit [n]` prints the last n. *As built (C1 review):*
  the live file keeps the newest 5,000 events; older ones move to numbered
  archives beside it, and `/devloop audit` says how many are archived and
  where. *As built (C2.1, F5), replacing that:* the trail is written in small
  numbered segments, `audit/000001.jsonl` on, `AUDIT_SEGMENT` (200) events
  each; an append reads and rewrites only the current segment; a read that
  fails begins the next segment and never overwrites the one it could not
  read; the newest `AUDIT_SEGMENTS_KEPT` (50) segments are the live trail
  (10,000 events), and the older ones stay on disk beside them as the
  archive, no longer read (the engine has no delete). `audit-segments` in the
  store holds the current segment, its count, the oldest live one and the
  total. What a thread was sent (the delta hashes), the pressure level
  last said and the questions per turn live in the module's memory for the
  session.
- *As built (D2):* the loop's shape tag is `loop-9`: it gains `task` (the
  `.tasks` task the spec was started under), `review.carriedTo` (the tree a
  verdict carries over to) and `checklistFails` (promoted items' failures,
  by tree, for the gate) and `approval.checklist`. New in the store:
  `claims:<main root>` (keyed by the repository's main root, so worktrees
  share them), `followups:<root>` (the watches, which outlive a session),
  `checklist-results:<root>`, `checklist-promoted:<root>`,
  `checklist-adjudications:<root>` and `checklist-sent:<root>` (what the
  checklist reviewer at work was sent). New records `checklist@1` (a
  checklist file) and `checklist-result@1`; `change-record@1` gains `task`.
  New audit actions `claim-taken`, `claim-lapsed`, `claim-takeover`,
  `claim-released`, `followup-stopped`, `checklist-promoted`,
  `checklist-demoted`, `checklist-adjudicated`.
- *As built (final round):* the loop's shape tag is `loop-10`:
  `review.carriedTo` is gone (principle 12: no carry target is stored; the
  carry-over's facts live in the module's memory, by the pair of trees), and
  `checklistFails` holds the promoted failures of the tree now and of the
  verdict's tree, each with its tree. A claim gains `seat` (its holder) and
  `waiting` (seats refused it); the session stays, for the audit trail. A
  watch gains `wakes` and `told.heads` (what was told per earlier head).
  `checklist-sent:<root>` gains the round's `base`. `evidence@1` gains `full`
  (the full tree, beside `tree`, now the committable tree). In a
  repository's state folder: `classic-passes.json` (the checks that passed
  on a tree, kept by the classic hook and `verify`); `classic-stop.json`
  gains `error` (a stop the gate could not judge).
- The loop records its root and the session id that wrote it: the same id at
  load is a plugin reload and nothing is reset; another root's loop is loaded
  when the session moves (F16, F28).
- **Harness state outside the working tree**: `<plugin data>/repos/<hash of
  root>/`, where `<plugin data>` is `CLAUDE_PLUGIN_DATA` from
  `$.process.hookEnv()` (or `/tmp/devloop-state` when the engine gives none).
  It holds `checks/<hash of command>.log` (each check's last full output) and
  `review-<round>.diff` (the reviewer's diff). Every write beneath the plugin
  data folder by a tool call is refused in every mode (rule `harness-state`);
  reading it is allowed. *As built (B1.1, 12.5):* the files the harness saves
  there are listed in `$.store` (`files:<root>`), newest last; past twenty the
  oldest are deleted, and `/devloop done` deletes them all.
- *As built (D1):* the state root is found the same way by the module and
  the bundle (`stateRootFrom`: `CLAUDE_PLUGIN_DATA`, else
  `/tmp/devloop-state`). Under it: `stamps/calls/<tool_use_id>`,
  `stamps/stops/<session>`, `stamps/live/<session>` (the heartbeat) and
  `stamps/notices/<session>`; in a repository's folder, `classic-inbox.jsonl`
  (what the classic hooks recorded; `inbox:<root>` in the store is how far
  the module folded it), `classic-policy.json` (the base policy the classic
  hook last read, keyed by the refs) and `classic-stop.json` (the classic
  stop gate's last passing and blocked trees and rounds). All of it is
  harness state: no tool call writes it (`harness-state`). Portable evidence
  is a git note under `refs/notes/devloop`, not in any tree. New record
  `evidence@1`; new audit actions `module-skipped`, `module-absent`,
  `git-hook-installed`, `git-hook-removed`, `evidence-noted`.

*As built (last review, 4.14):* `evidence@1` is replaced by `evidence@2`
(adds `checklistFails`); `classic-passes.json` gains its writer and an
environment key (the old shape is not trusted); `classic-stop.json` gains
`lastTree` and `lastPrompt` (the keep-warm guarantee); the snapshot's answer
gains `hidden:`, `differcount:` and `differs:` lines; new audit actions
`cache-guard-installed`, `cache-guard-removed`. The stored loop's shape is
unchanged (`loop-10`): the new gate facts are read from the snapshot each
time, and the keep-warm facts live in memory for the session.

*As built (the cache-guard round, P-D):* `classic-passes.json` is gone: no
writer, no reader (R4). `classic-policy.json` is gone too: the classic hook
reads the base's policy through git on every call that needs it, and keeps
only the base copy's secret globs (`classic-secrets.json`), which can only
add to what a git-free read refuses. `classic-stop.json` no longer holds a
passed tree: the checks run on every stop that is not a keep-warm quiet
turn. New in the store: `review-diff:<root>:<round>`, the SHA-256 of the
round's diff file as the harness wrote it (R11). New audit action
`harness-state-changed`. The snapshot's answer tags every line, a changed
file as `file:<path>`, and gains `hiddencap:100` (R14, L2); a line with no
known tag makes it unreadable, which refuses.

*As built (grounding, 4.15):* new in the store: `grounding-session:<root>`
(the session's questions of fact and unchecked answers) and the counters
`grounding-questions` and `grounding-unchecked`; new audit action
`answer-unchecked` and inbox kind `answer-unchecked`; under the state root,
`stamps/prompts/<session>` (the prompt the module saw). The per-turn facts
live in the module's memory, so the loop's shape tag stays `loop-10`.

*As built (loop limits, 4.16):* the loop's shape tag is `loop-11`; a loop
stored under `loop-10` reads as fresh. New in the loop: `limit` (the branch
it counts for, the failed rounds since a person last allowed more, the rounds
a person allowed, whether the message was given, the failed rounds' record
and the last commit that passed the gate), which `/devloop done` keeps;
`verify.covered` (each check with `when`, by command: the key of the files it
covered when it last passed); `review.isScoped`. New audit actions
`loop-limit` and `loop-continued`; new ledger kind `loop-limit`.

*As built (learning, 4.17):* the loop's shape tag is `loop-12`; a loop
stored under `loop-11` reads as fresh. New in the loop: `learner` (the
proposer at work, when it started, the repeat groups it was given, and the
runs this session started), which `/devloop done` keeps and a new session
starts over. New in the store: `learning:<root>` (shape `learning-1`: the
waiting proposals, the trial and promoted rules with their hits, the groups
given to a run and when, the lines dropped). A ledger entry may carry
`count` and `auto` (a lesson the harness wrote). New audit actions
`learned-rule-promoted` and `learned-rule-dropped`; new ledger kind
`learner` (a proposer that could not start); new counters `learn-runs`,
`learn-proposals`, `learn-dropped`.

*As built (the spec library, 4.18):* the loop's shape is unchanged
(`loop-12`). New in the store: `library:path` (the folder a person set; one
key for every repository, absent for the default) and `library-saved:<root>`
(each save this repository made: the entry, the library, the change id, the
content hash). New record `library-entry@1`; new audit actions
`library-saved`, `library-save-stopped`, `library-path-set` and
`library-removed`. The library's own files (`index.jsonl`, each entry's
folder) live outside the store, where a person put them.

## 6. What it does not do

- It cannot create the sandbox or remove credentials from the environment.
- It does not run staged rollouts or rollbacks; that belongs to CI and deploy.
- It does not make a solo developer two people. It makes the missing second
  person visible in the gate instead of pretending otherwise.

## 7. Build notes (constraints learned from the engine)

- A helper that takes `$` and lives in another file must be a **function
  declaration**, not an arrow bound to a const.
- `atom`/`read`/`update` calls stay in the file that declares the atoms
  (`hooks/state.ts`); other files call its functions.
- Every gating hook (`tool.call`, `tool.run`, `prompt.submit`, `classic.Stop`)
  has a `.catch`.
- No Node, no DOM, no dynamic `import()`. The world is reached through `$`.
- A render hook never writes state. (`locate` keeps `devloop.mode` current,
  so the pane reads config through `look`, which writes nothing.)
- The plugin's own tools are declared under `McpToolInputs` in
  `types/index.d.ts`; without that, `tool.run { tool: 'mcp__devloop__…' }`
  and test calls of them do not type-check.
- Test kit: nothing sits beneath the plugin, so tests answer `fs.*`,
  `process.run`, `session.*`, `agent.spawn` and `tool.call` themselves;
  `$.ui.ask` arrives as an `AskUserQuestion` tool call; a plugin's
  `$.agent.spawn` arrives spelled as the Agent tool's call (`subagent_type`)
  and its answer is read from `result.agentId`; `$.command.run` in a test must
  pass `origin`. The harness's own git scripts start with a `# devloop:<name>`
  line, so a test's `process.run` answers them by name; `tests/smoke.sh`
  extracts them from `hooks/state.ts` (a script there must not use `${…}`,
  which a TypeScript template would need escaped). A hook that throws in a test
  world (`fs.stat` on a missing path) is logged by the kit as skipped; that is
  noise, not a failure.
- *(D2)* A timer is `$.clock.after`, rescheduled after each poll while a
  watch lives, started from the hook that saw the ship or from
  `session.start`; it stops at `session.end`, and its record is in the store.
  Tests move time with the kit's `mock.clock(on)` (`advance` settles what a
  timer started); the world helper then leaves `clock.now` to it
  (`isClockMocked`), and answers any tagged script it does not know from
  `w.outputs['#<tag>']` and `w.exits['#<tag>']` (`gh`, `tasks`, the main
  root). A store key is removed with `$.store.delete`: `set` refuses
  `undefined`.
- Checks that must stay green: `tsc -p .`, `claude plugin validate .`,
  `claude plugin test .`, `bash tests/smoke.sh`.
- *(D1)* `cli/` and `dist/devloop.mjs` are a separate program and use Node;
  the hooks module still does not. `cli/node.d.ts` declares the few Node
  modules `cli/` imports, so `tsc -p .` checks it without giving the module
  Node's globals. A module the bundle imports must not use `$` or import the
  engine at run time (`import type` is erased); smoke fails if the bundle
  names `claude-code`. A git script shared with the bundle lives in
  `hooks/scripts.ts` (or `portable.ts`, `githook.ts`) and, being extracted
  raw by the smoke test, holds no escape a template would turn into
  something else. `claude plugin validate .` accepts classic `hooks` beside
  `modules` in `hooks/hooks.json` and lists them under "Provides". The
  folder is not named `bin/` (one packaging route refuses it).
- *(Final round)* A classic hook reads standard input asynchronously to its
  end (`process.stdin`'s `end`), never with a non-blocking read: a read of
  file descriptor 0 that is not ready yet returns nothing. `cli/main.ts`
  awaits the hook before it sets the exit code. A plugin test cannot select
  one file: `claude plugin test` runs every `*.test.ts`, so the parity table
  lives in a file without that suffix, imported by both runners.

## 8. Phases

- **A — core hardening**: 4.1 strict parsing and verify profiles; 4.2
  production, forbidden, egress and instruction-file rules; 4.3 in full;
  `devloop.mode` fail-open; status tool; real-git smoke tests; README, LICENSE,
  marketplace file.
- **B — spec and review depth**: 4.4 in full; 4.5 in full; 4.6 blast radius,
  approvals, `/devloop gate`.
- **C — context, learning, measurement, interface**: 4.7, 4.8, 4.9, 4.10.

## 9. Findings from real-engine testing

Each of these came from running the plugin in live headless agent sessions
against a throwaway repository, not from unit tests. They are requirements.

1. **Wording must follow the phase.** In small-fix mode tests are editable by
   policy, but the stop-gate message and the rules section said "tests are not
   to be changed". An agent asked to rename an exported function stopped
   instead of updating the test that imported the old name. In small-fix mode
   the message must say: update a test only when the change intentionally
   alters the behaviour it encodes, say so in the report, and never weaken a
   test to get green; test changes are shown to the reviewer and a person. In
   `build` the tests are locked and the message says that instead. The rules
   section is one text per thread, so it describes both modes.
2. **Ship-time review.** In small-fix mode a medium change could not ship
   without a review that only a person could start, which strands unattended
   runs. When a shipping command is refused only for a missing review and
   `autoReview` is on, the gate starts the review round itself and says so:
   retry after the verdict.
3. **Last known good config.** A `devloop.json` that stops parsing must not
   move a repository from observe to enforce, nor switch guards off. Keep the
   last config that parsed (per repository, in `$.store`), keep using it, and
   report the error loudly; with none on record, use the defaults in enforce.
4. **Doctor's credential check** flagged `MAX_THINKING_TOKENS`. Match names
   that end in a credential word (`_TOKEN`, `_SECRET`, `_KEY`, `_PASSWORD`,
   `_CREDENTIALS`) or are well-known (`AWS_SECRET_ACCESS_KEY`, `GH_TOKEN`).
5. **Stack frames are noise.** Distillation drops runtime-internal frames
   (`at node:internal/…`, `File "<frozen …>"`), keeping the first user frame.
6. **An empty change reads oddly**: with no changes the status says
   "Verification: not run since the last edit". Say "nothing to verify".
*As built (B1):* items 1, 3, 4, 5 and 6 are done (9.1: `fixAdvice` and the
rules section; 9.3: `config:<root>`; 9.4: `isCredentialName`; 9.5:
`distill`; 9.6: the Verification row). *As built (B2):* item 2 is done
(`judgeShipping` in `hooks/ship.ts`): when every unmet row is a review row,
no review is running or stalled, and `autoReview` is on (base policy), the
gate starts the round and the refusal says to retry after the verdict; a
retry while it runs is refused without a second round.

7. **Function hooks are early access.** Every headless run began with the
   engine saying hooks modules load only once a rollout switch answers. A
   harness whose enforcement silently depends on that fails open. See 4.11.
   *As built (D1):* classic hooks beside the module, with stamps, a heartbeat
   and skip detection; the command line; the pre-push hook (4.11).

## 4.11 Enforcement points (added after testing)

One policy core, several places it is enforced:

- **Module** (`hooks/register.tsx`): the full harness. State in `$.store`,
  person dialogs, the pane.
- **Classic hooks** (standard `PreToolUse` and `Stop` command hooks, and since 4.15 `UserPromptSubmit`, declared
  beside the module): the stateless core — secrets, protected paths,
  production, forbidden, egress, and the stop gate's fast checks. They stand
  down when the module is live (the module announces itself in the hook
  environment), so nothing runs twice, and they are what holds when the module
  is not loaded.
- **Command line** (`node dist/devloop.mjs gate|verify|doctor`): the same
  policy with no agent at all, for CI and a pre-push git hook. Stateless: it
  proves what can be proven from the tree (checks pass, tier, tests changed
  against the base, instruction files changed, blast radius, no secret-shaped
  strings in the diff) and exits non-zero otherwise.

The pure modules (`rules`, `config`, `output`) are the shared core; the
command line and classic hooks are built from them into one committed file
with no dependencies.

*As built (D1).* Function hooks load only once a rollout switch answers, and a
module hook can be skipped silently; a harness whose enforcement rests on one
mechanism that can be absent fails open. So:

- **One core, one bundle.** `dist/devloop.mjs` is `cli/main.ts` and the pure
  modules it imports (`rules`, `shell`, `config`, `output`, `scan`, `weaken`,
  `findings`, `gate`, `contentrules`, `lint`, `inject`, `records`, `fresh`,
  `inforce`, `scripts`, `enforce`, `portable`, `sandbox`, `githook`,
  `residual`), built by `bun build` for Node 18+ (`scripts/build.sh`), with a
  header and no dependencies. `tests/smoke.sh` rebuilds it and fails on any
  byte of difference. To share them, the git scripts and their readers moved
  from `state.ts`/`evidence.ts`/`commands.ts` into `hooks/scripts.ts`
  (re-exported where they were), `FRESH` into `hooks/fresh.ts`, the policy
  decision into `hooks/inforce.ts` (`decidePolicy`), and the shipping rules
  before the gate into `hooks/enforce.ts` (`shipRules`, which the module's
  `judgeShipping` now calls). No rule was re-implemented: `hooks/enforce.ts`
  (`judgeCall`) calls `judgeCommandAll`, `judgeWrite`, `isSecretPlace`,
  `isHarnessState`, `judgeTestEdit` and `judgeContent` as the module's guard
  does.
- **The command line** (`node dist/devloop.mjs gate|verify|doctor|sandbox|
  check-command|check-path|hook|version`, each with `--json`; exit 0 ok, 1
  not ok, 2 usage or policy error) is stateless. `gate` finds the base as the
  snapshot does (`FIND_BASE`, by the working copy's default branch, with no
  last closed change), reads the base policy whole, snapshots the tree
  (`SNAPSHOT`), runs every fast and full check that applies (`checkArgv`, so
  `checkEnv` scrubs them as in the module; none for an empty change), scans
  the added lines (`ADDED_LINES`, `scanCredentials`), reads changed
  instruction files for hidden characters, and fills a loop from what the tree
  proves (`proofLoop`) so the module's own `gate()` gives the rows; the review
  rows are then replaced by what the portable evidence proves
  (`statelessGate`, `reviewRowFrom`). It never claims a row it cannot prove.
  `doctor` is the stateless subset (policy errors, the instruction and skill
  lints, the injection scan, the sandbox comparison); `check-command` and
  `check-path` print the verdict the guards would give in a phase (rule,
  reason, lift class), for the parity tests and for a person debugging a
  refusal. `docs/examples/devloop-gate.yml` is a CI example.
- **Classic hooks** in `hooks/hooks.json` beside `modules`: `PreToolUse`
  (matcher `Bash|Edit|Write|NotebookEdit|Read|Grep|Glob|Monitor`) and `Stop`,
  each `node "${CLAUDE_PLUGIN_ROOT}/dist/devloop.mjs" hook <event>`. The
  engine runs a classic event's chain as managed settings hooks, then hooks
  modules, then the other settings hooks; `classic.PreToolUse` fires beneath
  every plugin's `tool.call`. So: the module writes a **stamp** for each call
  it judged and lets go on, just before `next(e)` (`stamps/calls/<tool_use_id>`
  under the state root), and for each stop before its `classic.Stop` calls
  `next(e)` (`stamps/stops/<session>`, holding `stopKey`: a hash of the
  session, prompt id, last assistant message and `stop_hook_active`). A call
  it refuses never reaches the classic hook. The classic hook that finds its
  stamp removes it and exits silently: nothing is refused or verified twice.
  It keeps the call stamps to the newest 300. (Where this differs from the
  text above: the module does not announce itself in the hook environment,
  which a hooks module cannot set for a command hook; it stands the classic
  hooks down call by call, which also tells a skipped hook from a live one.)
- **Skip detection.** The module also writes a **heartbeat**
  (`stamps/live/<session>`) at the session's start and each main-loop turn.
  Heartbeat and no stamp: the module's hook was skipped. The classic hook
  applies the stateless core (`judgeCall`, in small-fix mode, the mode in
  force from the base policy), refuses any ship outright ("the harness could
  not judge this call; run it again") and appends a `module-skipped` event to
  the repository's **inbox** (`classic-inbox.jsonl`, the stateless record
  path). The module folds the inbox into the ledger and the audit trail at
  each session start and person's prompt (read from an offset kept in the
  store, `inbox:<root>`), with a toast for skips. No heartbeat: the module is
  not loaded, the classic hooks are the enforcement, and the first call of
  the session carries a one-time notice (to the person as `systemMessage`, to
  the model as context) of what is and is not enforced. A ship then runs the
  stateless gate and is refused when it is not green (enforce mode).
- **Honesty about limits.** Without the module there is no spec approval,
  feature status, review loop or exemption; small-fix mode's rules apply, so
  high-risk paths are refused for edits, and a medium or high-risk change
  cannot ship without review evidence. docs/RESIDUAL-RISK.md A11 lists what
  the stateless core cannot hold.
- **The classic stop gate** runs the fast checks when the tree differs from
  the last tree its checks passed on (`classic-stop.json` in the repository's
  state folder), blocks with the distilled output, keeps the fix round
  budget per prompt (`maxFixRounds`), ends the loop on a stop on the tree it
  last blocked, does not block on a check that could not run, and only
  reports in observe mode. *(Since the cache-guard round, R4: no passed
  tree is kept; the checks run on every stop but a keep-warm quiet turn.)*
- **Cost.** A classic hook is a Node process per call. A read or search that
  names no secret any policy here could name returns before any git; the
  base's policy is read through git only when `.git`'s refs moved since the
  hook last read it (`classic-policy.json`; since the cache-guard round,
  P-D, read through git on every call that needs it); a repository with no
  `devloop.json` on either side is a silent no-op. Measured: a median of
  about 30 ms start to exit for a trivial call (a read, a plain command, a
  stamped call, or a repository with no policy: 29 to 32 ms; Node alone
  starts in about 17).
- **Parity** (nanochat note 3). `tests/parity.ts` runs one table (42 rows,
  19 rule classes, harmless rows among them) through the module's pure
  functions, `check-command|check-path` and the classic hook entry fed real
  hook JSON; `tests/smoke.sh` runs it and fails on any disagreement. The
  classic hook judges small-fix mode, so rows of the spec and build phases go
  through the first two only.
- **Portable evidence.** When a review round settles and at `/devloop done`,
  the harness writes `evidence@1` (tree, head, policy hash, the checks with a
  pass on the tree, each reviewer of the round on that tree with its verdict,
  open blocking findings, harness version, time) as a git note on HEAD under
  `refs/notes/devloop` (`NOTE_WRITE`), only when HEAD's tree is the reviewed
  tree as a commit holds it (its committable tree, final round); otherwise
  it writes nothing and says why. A note changes no tree, so
  nothing is excluded from the hash (principle 9). The command line reads the
  note for HEAD; a review row is met only when the note names the tree being
  judged (its committable tree), was produced under the policy in force, and
  names the reviewer in a general or blocking mode with its own pass and no
  blocking finding open (final round, D1 F7). **A note is
  not a signature**: anyone with push access to the ref can forge one; it
  saves a second machine re-running the review, it is not a security
  boundary. The builder may not write it: a `git notes` write on that ref
  (`--ref`, `-c core.notesRef=`, `GIT_NOTES_REF=`), an `update-ref` of it and
  a push of it (named, by a pattern over `refs/notes`, `--mirror`) are rule
  `evidence-notes`, always held; `.git/refs/notes/**` is a built-in
  protected path. People push it: `git push origin refs/notes/devloop`.
- **Sandbox settings from the same policy.** `/devloop sandbox` and `node
  dist/devloop.mjs sandbox` print `sandbox.enabled`, `allowUnsandboxedCommands:
  false`, `network.allowedDomains` from `network.allow` (none implied when it
  is not set), `filesystem.denyRead` from `secrets`, `filesystem.denyWrite`
  from `protected`, the built-in protected paths and the harness's state
  root; they write nothing. Doctor compares what `.claude/settings.json` and
  `.claude/settings.local.json` configure (merged) with that, and warns of
  broad allowed domains (`*`, a bare top-level domain, shared hosting), a
  reachable container socket or all Unix sockets, writes allowed to shell
  start-up files, a home or root folder or a `$PATH` folder, and every flag
  that weakens the sandbox (`allowUnsandboxedCommands` not false,
  `excludedCommands`, `enableWeakerNestedSandbox`,
  `enableWeakerNetworkIsolation`, `allowNestedUserNamespaces`,
  `network.allowLocalBinding`, `filesystem.disabled`). Warnings, never
  errors: the sandbox is the person's to configure.
- **The pre-push hook.** `/devloop hooks install` (a person, a dialog,
  audited `git-hook-installed`) writes `pre-push` into the folder `git
  rev-parse --git-path hooks` names; a hook already there is moved to
  `pre-push.devloop-chained` and run first with the same input. The hook runs
  `node <plugin>/dist/devloop.mjs gate --pushing <commit>…` and refuses the
  push when it is not green, when the commits pushed do not hold the tree
  judged, or when `node` is missing; a repository with no policy passes
  (final round, D1 F4, F6). `/devloop hooks remove` removes exactly
  that and puts the chained hook back; a `pre-push` that is not the harness's
  is never touched. The builder can run neither (person check), and
  `.git/hooks/**` is protected.

*As built (final round), the enforcement points* (docs/reviews/phase-d1.md,
principle 11):

- **The classic hook reads its input to the end** (D1 F1): asynchronously,
  until the writer closes standard input, however late or large, within a
  deadline of 60 s. Empty, truncated or unparsable input, or a call with no
  tool named, is refused for `PreToolUse` in the hook's own output format
  ("the harness could not read this call"); for `Stop` it never blocks:
  verification is marked not done in `classic-stop.json` (no pass kept) and
  the person is told.
- **Every failure refuses** (D1 F5): a throw inside the hook is a refusal
  in enforce mode and wherever the mode cannot be read (observe only
  reports it; a repository that has not opted in holds the secrets last
  line alone, `namesDefaultSecret`, which the module's guard shares). The
  module's guard, too, now refuses when it cannot read the mode. On a ship the checks get a time budget (240 s, the hook's
  limit is 600 s); past it the ship is refused and the passes of the tree
  are kept (`classic-passes.json`), so the retry runs only what is left.
  *(Superseded by the last review, F1: only the hook's own passes, made in
  its own environment, are kept and trusted; `verify` keeps none, and the
  refusal says to run the push again. See the end of 4.11.)* A missing `node` is said by doctor and is A19.
- **The fast path for reads and searches skips git, never judgment** (D1
  F2): it runs the shared core's own test (`judgeCall`, the same placement
  and link resolution as every point) under every secret any policy here
  could name; only when that finds none does the call go on with no git.
- **What a push sends** (D1 F4): see 4.6. The installed pre-push hook runs
  `gate --pushing <commit>…` with the commits git's input names (HEAD when
  it names none), and passes a repository with no `devloop.json` on either
  side (D1 F6). `/devloop hooks install` refuses a `core.hooksPath` outside
  the repository; for one inside the tracked tree the dialog names it and
  says git will track the hook (`HOOK_WHERE`, `hooksPlace`).
- **Evidence notes** (D1 F7, F10) are keyed on the committable tree (equal to
  HEAD's tree, so a note can be written with an ignored instruction file
  present) and record the full tree beside it (`full`). A review row is met
  from a note only when it names the committable tree, was produced under
  the policy in force (its `policy` hash equals `policyHash` of the policy in
  force), and names the reviewer in a general or blocking mode with its own
  passing outcome; a shadow reviewer's own outcome (its readable verdict and
  findings) is what the note records for it.
- **The evidence-notes rule on parsed words and across the line** (D1 F3,
  D2 F10): an exported or assigned `GIT_NOTES_REF` earlier on the line,
  `--config-env core.notesRef=`, a ref in a variable, a fetch or pull whose
  destination is the ref (or a pattern over refs/notes), and a quote-split
  spelling are refused; R35 says what is not.
- **Code nested past six substitutions** (D1 F12) is a segment of its own:
  an unknown writer of every path it names and a possible push of anything.
- **A held refusal always wins** over a recorded-only one, whatever the
  order found (`strictest(all, cfg)`, carried into the final round).
- **`sandbox`** (D1 F9) warns when `CLAUDE_PLUGIN_DATA` is not set (the
  state directory is a fallback, not a fact) and of every allowed domain the
  broad-domain test flags (on standard error with `--json`).
- **Parity through the real module** (D1 F8): the table lives in
  `tests/parity-table.ts`, imported by both runners. `tests/parity.test.ts`
  (`claude plugin test`) drives every row through the module's own
  `tool.call` hook in the test world; `tests/parity.ts` (run by smoke.sh)
  drives the same rows through `check-command|check-path` and the classic
  hook, in two runs (opted in, dormant). The module's column is no longer a
  second copy of its judging. 83 rows of 20 rule classes, with the search
  tools, links to a secret, a folder-anchored secret by absolute path, a
  repository that has not opted in, and the final round's rules.

*As built (D2), the enforcement points:* the parity table has 57 rows of 20
rule classes: the D1 rows, git plumbing on the evidence notes, the `.tasks`
rules with the integration on (smoke.sh gives the throwaway repository a
version 2 tree and a `tasks` stand-in on the PATH), and five rows in a
repository with no policy on either side, where all three points hold the
secrets rule alone with the default globs (the classic hook used to be a
silent no-op there; the dormant module always held it). The classic stop
gate runs the `.tasks` session check as the module's does. The stateless
points prove no gate, so they refuse `tasks done` outright.

*As built (last review, docs/reviews/final-fix.md), the enforcement points:*

- **The classic hook keeps and trusts only its own passes** (F1, settling
  F10): `classic-passes.json` records the writer (`classic-hook`), an
  environment key (the policy's `checkEnv`, `PATH` and `HOME`), the tree
  and the checks that passed; a pass from another writer, environment or
  tree is not trusted. The command line's `verify` keeps nothing. When the
  hook's time budget runs out it keeps what it finished, and the refusal
  says to run the push again: the retry resumes where it stopped.
  *(Superseded in the cache-guard round, R4: nothing is kept.)*
  tests/smoke.sh proves that a pass made by `verify` under a doctored
  `PATH` does not let the hook skip the check.
- **Files hidden from git** (F2): the snapshot reports every index entry
  with the skip-worktree or assume-unchanged bit (`hidden:<path>`), whose
  changes `git add -A` leaves out of both trees. Any one makes the gate row
  "Files hidden from git" unmet (`GateFacts.hiddenFromGit`) and refuses a
  push at all three points (`pushSends`), naming them. The agent may not set
  the bits: `git update-index --skip-worktree|--assume-unchanged` is rule
  `git-hidden` (held in enforce mode, a person lifts it); the `--no-` forms
  are fine. A sparse checkout sets skip-worktree on every file outside its
  cone, so it keeps the gate shut too (fail safe; a person pushes).
  *(Narrowed in the cache-guard round, L2: only an entry whose file on disk
  differs from it by content hash hides anything.)*
- **The shared core, on parsed words** (F3 to F6): a notes-ref or actor
  value exported or assigned anywhere earlier on the line holds, and nothing
  later cancels it (`assignedBefore` returns every value); a written path is
  split at its first wildcard by one function, `globParts`, which the rules
  and both readers use, so `.tasks/web/*/task.md` is listed and judged under
  `.tasks/web`; the `.tasks` edit rule judges every placed path, a link from
  outside the repository included (`tasksEditRefusalOf`); and the place a
  shell write's link leads to goes through the `.tasks` shell rule as well
  as the path rules (`resolvedWriteRefusals`), at all three points.
- **A push names its source** (F8): `git push --all`, `--branches`,
  `--tags`, `--follow-tags` and `--mirror` name no source and are refused
  (`--mirror` by the evidence-notes rule, the rest by the shared shipping
  rules) with the advice to push the branch checked out, by name or by
  `HEAD`. A tag is a person's to push; `git push origin <tag>` was already
  refused as a push of something other than the branch.
- **"Commit or stash first" says what and how** (F9): the snapshot lists
  how many files differ from HEAD and the first five, each marked untracked
  or not; the refusal names them and gives three remedies that work:
  commit them, `git stash -u`, or ignore them.
- **Evidence records a promoted checklist failure** (F7): the record is now
  `evidence@2`, with `checklistFails` (the promoted items that failed on the
  reviewed tree); the stateless general review row is unmet from such a
  note. An `evidence@1` note no longer validates, so it proves nothing (fail
  safe): a round writes a new one.
- **Parity**: 109 rows of 21 rule classes (100 opted in, 9 dormant), with
  the rows of each finding above, the cache-guard guards (4.14), and a link
  from outside the repository (`PARITY_OUTSIDE_LINKS`).

*As built (the cache-guard round, docs/reviews/cache-guard-round.md), the
enforcement points.* Principles 13 to 17 are its rules of construction.
(A seventeenth, P-E, adopted after the tenth round and restated after the
eleventh, was withdrawn after the twelfth: see *Folders* below. Its place is
taken by the thirteenth round's BB1, principle 17.)

- **One shape for a push** (R1, principle 13): `pushShape` sets
  `misshapen` on a push intent, and `shipRules` refuses it first, with
  `git push -u origin HEAD` named; the destination rules (default branch,
  another branch, tags, the notes) still run after it, as do ship-alone and
  the check after a ship. A bare `git push`, `git push origin`, `git push
  origin :`, `--al`, `-c push.default=…`, `-c remote.origin.push=…`, `-C`,
  `--namespace`, a `GIT_*` variable on the line: each is refused at all
  three points, and tests/smoke.sh shows with real git that `main -> main`
  is never sent. The git options the rules refuse (`--force`, `--no-verify`,
  `--skip-worktree`, `--assume-unchanged`, `--hard`, `--delete`, `--all`,
  `--mirror`, `--output`, `--file`, …) are matched by prefix (`gitOption`).
  The rules text the agent sees says how to push. *As built (ninth round,
  N1):* the destination has one shape too: a plain branch name or
  `refs/heads/<name>`; `heads/…`, `tags/…`, `remotes/…` and any other
  `refs/…` are misshapen (git lands `HEAD:heads/main` on main). *As built
  (tenth round, D3), replacing N1's three prefixes:* a destination after a
  colon is spelled in full, `refs/heads/<name>`; any unqualified one
  (`HEAD:feature`, `HEAD:heads/main`, `HEAD:meta/base`, `feature:feature`)
  is misshapen, and the refusal names the spelling to use
  (`HEAD:refs/heads/feature`), since git places an unqualified name by what
  the remote already has, which the harness cannot see. A refspec with no
  colon is unchanged. The refusals that fired first still do: a notes ref
  is `evidence-notes`, a leading `+` a forced push, and
  `HEAD:refs/heads/<default>` is judged as a push to the default branch.
  `PUSH_ADVICE` and README name `HEAD:refs/heads/<branch>`.
- **Computed values** (R2, principle 14): see the principle. `git notes
  --ref "$R"`, `GIT_NOTES_REF=$A`, `export GIT_NOTES_REF=$(…)`, `git
  update-ref "$R"`, `git symbolic-ref refs/notes/devloop …`, `git fetch
  origin "x:$R"` and `GIT_CONFIG_KEY_<n>` naming the notes ref are
  `evidence-notes`.
- **Nothing kept** (R4, principle 16): the classic hook runs every check
  itself each time it must decide, at the stop gate and on a ship; past its
  time budget the ship is refused, saying which checks finished and which
  did not, that nothing is kept, and the ways forward (a session with the
  hooks module, the command-line gate in CI, a person pushing). This
  supersedes F1 and F10 above.
- **Guarded folders** (R7): for every protected or secret pattern with a
  literal folder (`~/.claude/cache-guard`, `~/.claude/hooks`,
  `~/.claude/plugins`, `.git/hooks`, …), a write, copy, extraction or sync
  into it, a link over it, and a move, delete or link-replace of it or of an
  ancestor are refused (`folderRefusal`). A literal `cd` is followed for
  this, as for any placed path. `rm -rf ~` and `rm -rf /` are therefore
  `secret` (they remove `~/.claude/cache-guard`) before they are
  `destructive`, even in a repository that has not opted in.
- **Secret paths by other spellings** (R8): variables a line assigns a
  literal are replaced before paths are placed, and `HOME`, `PWD`,
  `TMPDIR`, `CLAUDE_PLUGIN_DATA`, `CLAUDE_PLUGIN_ROOT` and
  `CLAUDE_PROJECT_DIR` from the judging process's environment (`$.env` in
  the module, `process.env` in the command line and classic hook), never
  for a variable the line itself set to a computed value (`ENV_NAMES`,
  `parse(command, cwd, env)`). A read through a followed `cd` is placed like
  a write. *As built (ninth round, N2):* `pushd <dir>` is followed as `cd`
  is and `popd` returns to the folder it kept; any other `pushd` or `popd`
  form loses the place as an unfollowable `cd` does (the twelfth round, W1: such a form now leaves the folder and the stack as they were; see *Folders* below). A recursive read or copy of a folder that holds a secret
  pattern's literal folder is refused (`deepReadRefusal`). *As built (tenth
  round, D4):* `$'…'` is decoded as bash decodes it (`decodeAnsiC` in
  `hooks/shell.ts`: `\\ \' \" \? \a \b \e \E \f \n \r \t \v`, `\NNN`,
  `\xHH`, `\uHHHH`, `\UHHHHHHHH`, `\cX`; a NUL ends the string); an
  escape it does not know (`\q`, `\x` with no digit, a byte past
  ASCII) makes the word one that holds an expansion (principle 14).
  *As built (the eleventh round, V2):* `\cX` is `toupper(X) & 0x1f`, `\c?`
  0x7f, `\c\\` one backslash pair, as bash makes it, and a NUL from any
  escape ends the string (`git push origin HEAD:refs/heads/$'main\c x'`
  names `main`); `\?` is `?`. *As built (the twelfth round, X2):* `\cX`
  with X outside printable ASCII (0x20 to 0x7E) is not decoded: bash works
  on the first byte of X's encoding, so the word is one that holds an
  expansion (`HEAD:refs/heads/$'main\cअx'` is refused as `evidence-notes`,
  the rule that takes an unknown destination for the notes ref). tests/ansi-c-table.ts holds what real bash
  makes of every one-character escape body (written by
  tests/ansi-c-table.sh, which tests/smoke.sh runs again to check it), and
  tests/shell.test.ts compares the decoder with it. `$"…"`
  is read as a double-quoted string, its expansions as in double quotes.
  Inside double quotes neither is a quoting. So `HEAD:$'\x6dain'` is
  `HEAD:main` and `cat $'\x63onfig/…'` names the secret. *As built (the
  thirteenth round, BB3):* `\x{H…}` is decoded as bash 5.2 does: every hex
  digit after the brace, the value's low byte kept, then one `}` if it is
  there (empty braces, a non-hex part and `\x{100}` give a NUL, which ends
  the string; a missing `}` ends nothing; `\x{65g}` is `eg}`); the table
  holds those bodies. This decoding is the extended reading's (principle
  17): the reviewed reading tokenizes `$'…'` and `$"…"` as `2374c49` did,
  so an escape the decoder does not know is still judged by its text.
- **Folders** (the twelfth round, W1; the thirteenth, BB1): the model is
  deliberately simple, and has two readings of every line (`Reading` in
  `hooks/shell.ts`: `parse(command, reading, …)`, `readings(command, …)`
  for both). Each is a plain one-folder model: each command has one folder
  (`Segment.cwd`), a computed `cd` target loses it (null) and a relative
  path is then matched as written, a subshell `( … )` restores it, and
  `$PWD` and `~+` are that folder where it is known. The *reviewed* reading
  is `2374c49`'s, exactly, for the three things later rounds read
  differently: only `cd` moves the folder, its target followed as written
  (a wildcard in it is literal text, so `cd config/secrets; cd nomatch*;
  cat token.txt` places the read under `config/secrets/nomatch*`, a secret
  by its text); `pushd` and `popd` move nothing; `$'…'` and `$"…"` are
  tokenized as they were then (inside double quotes too, nothing decoded:
  `cat "$'config/secrets/token.txt'"` names the secret). The *extended*
  reading adds what the later rounds built: `pushd <folder>` (one word, or
  `pushd -- <folder>`) is followed as `cd` is when the hook finds the target
  on disk as exactly one existing folder (Y1; a folders pattern with no
  wildcard checks each of its parts), the old folder kept on a modelled
  stack, and `popd` (no word) returns to it; any other `pushd` or `popd`
  leaves the folder and the stack exactly as they were. A wildcard target
  of a `cd` or `pushd` is expanded on disk by the one expander
  (`Segment.moveGlob`, asked for by `globWords` in `GLOB_ROUNDS` rounds)
  and followed only where it matched exactly one folder; otherwise it is a
  target the model cannot follow (for `cd`, null; for `pushd`, unchanged).
  `$'…'` is decoded and `$"…"` read as a double-quoted string. Everything
  else (the push shape, the budgets, the wildcard expander for paths,
  links, the `.tasks` rules) is the same in both. Every place that judges
  a line runs it under both, whole (principle 17): `judgeCommandAll`,
  `shipAlone`, `shipElsewhere`, `budgetRefusals`, `tasksCommandRefusals`
  and `filteredCheck` refuse what either reading refuses; `namedPlaces`,
  `writtenPaths`, `maybeWritten`, `globWords` (what `withGlobs` and
  `globsFor` look up), `reviewerPlaces`, `hostsOf` and `shipsOf` give the
  union (a line ships if either reading says so, and every push either
  reads is shaped); `isReviewerCommand`, `reviewerMayRun`, `isLook` and
  `isOneLine` answer yes only where both do; `callKind`, `shipLookups`,
  `writesOpenPath`, `writesTaskState` and `finishesTask` answer yes where
  either does. Nothing is split or multiplied inside one reading; the cost
  is two passes. Three richer designs (the tenth round's D1, a folder state
  per shell state; the eleventh's V1, one set of folders per call) each
  failed independent review and each let through lines the model before it
  refused, and the twelfth round's return to one folder still let through
  what `pushd` and the new readings replaced; docs/reviews/cache-guard-round.md
  says why. What both readings do not see is listed by name in R3 of
  docs/RESIDUAL-RISK.md, with what stands behind it: the sandbox, the
  credential scan on the diff, the review.
- **Links before `..`** (the eleventh round, V3): a path whose `..` follows
  a part that may be a link keeps its unfolded spelling (`Placed.raw`), and
  the link resolver every guard uses (`realOf`, through `physicalPath`: the
  module's in `hooks/register.tsx` through `$.fs.stat`, the command line's
  in `cli/io.ts` through `realpathSync`) takes each `..` from where the
  parts before it lead, as the kernel does. Both places are judged, the
  strictest verdict standing: `cat src/keys/../secrets/token.txt` with
  `src/keys -> config/secrets` reads the secret. *As built (the thirteenth
  round, BB2):* links are followed from both places, not from the physical
  one alone: `realOf` (both implementations) and the reviewer's resolver
  (`resolvedOf`) start from the text-folded place (`abs`, as the reviewed
  build did) and from the physical one, and every place either leads to is
  judged (`realOf` returns all of them; the reviewer's answer needs every
  one inside the repository and none a secret). So after `cd src/keys &&
  cd ..` a read of `keys/token.txt` is followed through the link again, as
  `2374c49` followed it, and `cd src/gh; cd ..; rm gh/pre-commit` with
  `src/gh -> ../.git/hooks` writes the hook.
- **Wildcards** (R9, principle 15): `globWords` names the wildcard paths a
  command holds; each point expands them (`expandAll` through `$.fs.list`,
  `expandAllNow` through Node's `readdirSync`) into `Where.globs`, and every
  rule judges each match. *As built (the twelfth round, X11):* a word with
  quoted or escaped parts still expands: the tokenizer marks an unquoted
  wildcard beside a quoted part (`"config"/s*`, `config/s\ecret*`), and the
  expander is given the word's template, in which quoted characters are
  escaped and stay literal (`GlobAsk`: the `key` the rules look matches up
  by, the `pattern` the expander matches by). A link in the middle of a
  pattern is followed: a listing marks a link as one that may lead to a
  folder (`Entry.isDir` null), which a middle part, or a part before a
  trailing `/`, matches and lists in turn (`cat src/k*/token.txt` with
  `src/keys -> config/secrets` reads the secret). A move's target is
  expanded as a pattern for folders (a trailing `/`), in which a literal
  part after a wildcard must be there too, so `cd */secrets` matches only
  the `secrets` folders that exist. *As built (X10, X12):* a
  budget that runs out refuses the line instead of passing the rest
  unjudged (`budgetRefusals` in `hooks/rules.ts`, called by the stateless
  core and the module after the link checks): more than `GLOB_BUDGET` (32)
  wildcard paths on a line, or one the hook left unexpanded; more than
  `LINK_BUDGET` (200) named places, or more than `GLOB_CAP` wildcard matches,
  to follow through links (`linkPlaces`); opted in, more than
  `WRITE_LINK_BUDGET` (64) written paths to follow. *As built (Y2):* the
  budgets were 16, 24 and 16 and refused `git add` of 26 files; they are
  now 32, 200 and 64 (a `pushd` target counts as one of the 32). Each is refused as
  `protected` with advice to split the line (a person can lift it); where
  only the secrets rule holds (no policy), as `secret`, since the budget
  guards it alone. *As built (the thirteenth round, BB4):* a match is kept
  only where it is there: a literal part after a wildcard part is looked up
  too (a folder before another part, anything as the last), so beside
  `sk -> config/secrets` `cat */package.json` matches no `sk/package.json`
  and is not refused, while `cat */token.txt` is. Under principle 17 the
  matches `2374c49`'s expander gave (a middle part matching real folders
  only, literal parts after it taken as written) are judged too, so a path
  the reviewed build refused by its text, such as
  `config/secrets/package.json` for `*/*/package.json`, is refused still.
  *As built (the fourteenth round, CC1):* those are the reviewed reading's
  own lookups now, not a second half of one answer: `expandGlob` is the
  checked expander alone, the extended reading's; the reviewed reading asks
  what `2374c49` asked (`globAsksReviewed`) and expands it with
  `expandGlobReviewed`, keeping its answers apart (`Where.globs`), so a
  capped answer of one never discards the other's matches (CC-F2), and a
  quoted and an unquoted spelling of one text cannot empty each other's
  answer (CC-F1: the extended reading keeps its answers by pattern and
  judges a path by the matches of every pattern it asked for its spelling).
  *As built (BB5):* a word holding white space is taken
  for a path where something exists at its place: it is looked up as a
  pattern with no wildcard (every part checked on disk), in both readings,
  and judged as any path where it is there: `cat "config/secrets/sp
  ace/token.txt"` reads the secret, while `git commit -m "fix the thing in
  src/a.ts today"` and `echo "see config/secrets for details"` name nothing
  there and pass. *As built (the fourteenth round, CC-F6):* those lookups
  have their own budget, `SPACED_BUDGET` (200) for each reading, apart from
  the 32 wildcard paths, and are kept in `Where.spaced`; past it the line is
  refused with its own words, never the wildcard message, so 33 `echo "step
  N done"` pass. *As built (CC-F4):* in the extended reading a word holding
  white space and a wildcard is expanded and each match judged as a path:
  `cat "config/secrets/sp ace"/*`, `cat config/secrets/sp\ ace/*` and `cat
  sk/"sp ace"/tok*` read the secret, `cat "my docs"/*.md` passes. *As built
  (CC-F8):* each reading follows links for its own places within its own
  budget (200 named, 64 written: `followedPlaces`), and a reading past one
  is refused, so padding words in one reading cannot push the other's
  places past the budget unfollowed. *As built (CC-F9):* `rm -rf` of a
  wildcard in the first part under `/` (`rm -rf /e*`) is judged from `/`,
  and from the folder the line runs in as before, which can only add a
  refusal. The policy-file and `.tasks` globs compile `[…]`
  classes, so a bracket with nothing on disk still reaches the locked name.
- **Links made on the line** (R15): `ln -s target name`, then a path
  through `name`, is judged where the link leads (`lineLinks`, `reach`).
- **cache-guard's script** (L1): rule `cache-guard` (4.14).
- **Hidden files, narrowed** (L2): an index entry with the skip-worktree or
  assume-unchanged bit is reported only when a file is at its path and its
  content hash (`git hash-object`, or the link's target for a link) or its
  executable bit differs from the index entry. A sparse checkout pushes; a
  file edited behind the bit is refused and named; restored, it passes. At
  most 100 such files are compared; past that the snapshot says
  `hiddencap:100`, which keeps the push refused.
- **Tagged snapshot** (R14): every line is tagged (`file:<path>` for a
  changed file); an untagged line makes the snapshot unreadable, which
  refuses.
- **Older evidence** (L4): an `evidence@1` note still proves nothing, and
  the review row says why: "the note was written by an older version of the
  harness; run the review again" (`isOlderEvidence`, `OLDER_NOTE`).
- **Parity**: 153 rows of 22 rule classes opted in, 11 rows dormant, with a
  row for each spelling above and its harmless neighbours; `tests/world.ts`
  lists folders as a disk would (`isDiskListed`) so the module's expander
  sees the same files as the classic hook's.

## 4.12 Coordination (D2: claims, follow-ups, ready work, `.tasks` at the edges)

Folded from docs/design-notes/coordination.md (decisions 5 to 7) and
docs/design-notes/rea-and-tasks.md (the `.tasks` section). The pure parts
are `hooks/claims.ts`, `hooks/followup.ts` and `hooks/tasks.ts` (shared with
the bundle); `hooks/coord.ts` does the work.

- **Claims with leases.** A session claims a feature of the active spec with
  `devloop_claim { feature }`, or by its first `feature_check` on an
  unclaimed feature. A claim holds the session id, a name a person can tell
  (branch and worktree), and a lease of `claims.leaseMinutes` that the
  session's judged tool calls renew, at most once a minute. Claims live in
  the store under the repository's main root (`MAIN_ROOT`: the folder of
  git's common directory), so worktrees share them; never in the working
  tree. Another session's `feature_check` on a feature under a live claim is
  refused with the claimant and the lease's time left; a lapsed claim is
  taken over by claiming it; a live one only by a person (`/devloop claims
  release <feature>`, origin check and dialog). `devloop_release` gives one
  up. Closing (`/devloop done`) or reopening a spec clears its claims. Each
  claim, lapse (seen once, by whoever reads the claims next), takeover and
  release is an audit event. With one session nothing of this is shown: the
  claim is kept silently, no context is added, no question asked. Not built:
  the note's scoping of edits to the files a feature lists (features list no
  files); A17. *As built (final round, D2 F4):* **a claim belongs to a
  seat**, a working directory of the repository (the root the session works
  in; a worktree is its own seat); the session id is recorded for the audit
  trail only. A new session in the same directory continues its
  predecessor's claims silently. A seat refused a live claim is recorded as
  waiting; at a session's end its seat's claims are released only where
  another seat waits for them, otherwise they lapse with the lease.
  Re-taking a lapsed claim of the same seat is an audit event (`claim-taken`,
  "re-taken"). Two sessions in one directory are one seat (A20).
- **Ready work.** The status tool, the briefing and the pane list the ready
  features (dependencies passing on this tree, not under another session's
  live claim) in dependency order; with another session's claim live they
  also show each feature as ready, claimed by another, claimed by you, or
  passing.
- **Follow-ups in code.** After a shell call that pushed, or ran `gh pr
  create|ready`, returns without error in the main loop, and where
  `followUp.ci` is on and `gh` is installed and signed in (`gh auth status`),
  the open pull request for the branch (`gh pr view --json
  number,url,state,headRefOid,headRefName,reviewDecision,reviews,comments`)
  is watched: a record in `followups:<root>` and a `$.clock.after` timer of
  `intervalSec`, rescheduled while a watch lives. Each poll reads `gh pr
  view` and `gh pr checks --json name,bucket,link,workflow` (exit 8,
  pending, is no error) and decides purely (`followStep`): nothing on
  pending; each failing check once, with the distilled end of its log (`gh
  run view <run> --log-failed`, the run taken from the check's link); every
  check passed once per head (a new push starts the checks over); each
  review asking for changes and each new comment once (the comments there at
  the first poll are no news). What needs the builder wakes it with a queued
  prompt (`$.prompt.submit`) and toasts the person. A comment's or review's
  text is quoted line by line as untrusted text from a named person, control
  and bidirectional characters dropped and cut, under a sentence telling the
  builder not to act on it beyond telling the person (A18). A watch ends
  when the pull request is merged or closed, at `timeoutMin`, at `/devloop
  done`, or by `/devloop followups stop [n]` (a person); at `session.end` the
  timer stops and the record stays, and a later session's start resumes it.
  *As built (final round, D2 F5, F6):* every string from the pull request
  (check, workflow and branch names, comment and review bodies, log tails,
  author logins, its URL) goes through one function, `cleanUntrusted`:
  control, bidirectional and zero-width characters and every Unicode line
  and paragraph separator dropped (a body keeps its plain line breaks, to be
  quoted line by line), cut to a stated length (names 100, logins 39,
  bodies 1,200, log tails 1,600), then quoted (a name in double quotes, a
  body or a log tail as `> ` lines). A wake carries at most five failing
  checks and five reviews and comments (the rest counted) and at most
  12,000 characters. What was told is kept per head commit: a push that
  leaves the head as it was tells nothing again, nor does a push back to an
  earlier head. A watch lives `timeoutMin` from its start and wakes the
  builder at most ten times; pushes extend neither, and reaching either ends
  the watch and toasts the person. A watch a ceiling or a person ended is
  not started again by a push; one the closing of a change ended is.
  No host is contacted except through `gh`; where `gh` is missing or signed
  out the feature is silently off and doctor says why. The `gh` field names
  were read from `gh pr checks --help` and `gh pr view --help` (gh 2.89).
- **The `.tasks` convention at the edges**, off by default (`tasks.integrate`),
  active only where a `.tasks/` tree declares version 2 and the `tasks`
  command is on the PATH (`tasksProbe`; doctor reports both). devloop
  implements none of the format; it calls the command. *Exit protocol:* the
  stop gate runs `tasks session-check` for the session (4.3). *Finish gate:*
  `tasks done|cancel` is refused unless the gate is green on the tree as it
  stands and `approvals[tier]` is 0 (the module proves it as the status tool
  does; the stateless points cannot, and refuse); the refusal names `tasks
  handoff <person> <task> -m "…"`. *Guarded writes:* 4.2. *As built (final
  round, D2 F3, F7, F8):* the shell rule expands a folder or a glob as the
  protected-path rule does (`lockedBeneath`, one expansion for both), so `rm
  -r .tasks/web`, `cp x .tasks/web/login/`, `mv .tasks/web y` and
  `.tasks/web/*/task.md` reach a manifest or a log and are refused; the edit
  rule judges the path a link leads to as well as the spelled one, at all
  three points; the actor variable set inline, exported or assigned anywhere
  earlier on the line counts; and the command is recognised by name or
  through `npx`, `bunx`, `pnpm exec|dlx`, `yarn dlx|exec` and `npm exec`, as
  `tasks` or as the package's own name, `@speekl/tasks`. *Eval agents* write
  no task state. *Task id:* a spec started while `tasks mine` lists an
  `IN_PROGRESS` task for the session records it (`loop.task`); the change
  record (`task`) and the report cite it. *Review carry-over* (decided over
  the note, which asked to exclude `.tasks/**` from the hash): a verdict
  reached on one tree covers another when every path that differs between
  them (git's diff of the two trees) is under `.tasks/` and ends in `.md`,
  `.yml` or `.yaml`, `tasks validate` passes, and the integration is on; the
  review row then reads "passed on <tree>; only task state has changed
  since". Any other difference needs a new round. `tests/smoke.sh` proves
  the diff rule against real git. *As built (final round, D2 F1, F2, F9,
  F12; principle 12):* no carry target is stored: `verdictCovers` decides
  from the verdict's tree, the tree now and the diff between them every
  time; open findings and promoted checklist failures travel with the
  verdict (4.6). `CARRY_DIFF` is `git diff --raw --no-renames
  --ignore-submodules=none` with `diff.ignoreSubmodules=none`, so no git
  setting hides a submodule's change, and an entry that is not a plain file
  on both sides (a link, an executable bit, a submodule) is never task
  state (`readCarryDiff`). The smoke section has rename, link, mode and
  submodule cases. A check that reads a task file is
  re-verified, not re-reviewed (A16); a script that writes task state is not
  seen (R36). Not built from the note: the cold-start briefing from `tasks
  resume`, writing the handoff with `tasks state`, the heartbeat around
  harness-run checks, and offering `tasks done --as <person>` at `/devloop
  done` (the person runs it).

## 4.13 Checklists (D2)

Folded from docs/design-notes/checklists.md. The pure parts are
`hooks/checklist.ts`; `hooks/checklists.ts` does the work.

- **Format** `checklists/<id>.json`, record `checklist@1` (`schemas/`):
  `id` (the file's name), `version`, `title`, `appliesTo: { surfaces?,
  paths?, detect? }`, `maxItems` (at most 15), `items[]` of `{ id, statement,
  why, severity: critical|high|medium|low, verify: { by, how, pattern?,
  expect?: present|absent, check? }, naWhen?, ref?, status?: active|retired }`.
  Validated when loaded; a list with more active items than its `maxItems`,
  duplicate ids, a pattern that does not compile, a `pattern` item with no
  pattern or a `check` item with no command fails to load and is named by
  `/devloop checklists` (never read as passed). Read from the base branch
  (`git ls-tree` and `git show`), the working tree's only where there is no
  base. `checklists/**` is protected and an instruction file (4.2). One
  worked example ships, `docs/examples/checklists/login-form.json`, written
  independently: twelve items, each routed and with a concrete `how`.
- **Selection**: a list applies when SPEC.md's front matter declares one of
  its surfaces (`surfaces: [login]`), a changed path matches its `paths`, or
  its `detect` pattern is in an added line (`ADDED_LINES`).
- **Seeding specs**: while a spec is written the matching items are offered
  as candidate acceptance criteria (a context delta, and in `/devloop
  spec`'s context). At approval every item that applies is accounted for:
  kept (a feature's `checklist` or `criteria` names it; its check is what
  proves it), judged by a person (listed under a "Judged by a person" heading
  in SPEC.md: in the report's reading aid, never in the automated gate), or
  struck (under "Not applicable", with a reason). Approval is refused while
  any is unaccounted for; the dialog lists the three groups. *As built
  (final round, D2 F11):* the dialog names each item's verification route,
  and "judged by a person" is refused for an item the harness verifies
  itself (route `pattern` or `check`): keep it or strike it.
- **Checklist reviewer, shadow by default** (4.5): `pattern` items are a
  regular expression over the changed files' text (secrets never read),
  reported as present or absent, never good; `check` items are judged by the
  command rules and run scrubbed; neither reaches a model. `review` items go
  to one reviewer agent, which answers every item `C | <list>/<item> |
  pass|fail|not applicable|unverified | <file>:<line> | <quote> | <reason>`.
  An unanswered or twice-answered item, an unknown status, or a fail whose
  quote is not at its line is a format failure: restated once by a second
  agent, then a person's (a toast and the ledger; a decision finding only
  where an item it was sent is promoted). A pass whose quote is not there is
  kept as `unverified`. `runtime` and `person` items are the approver's.
  Results are `checklist-result@1` records (`checklist-results:<root>`).
- **Promotion per item**: `/devloop checklists` shows per item the shadow
  results (fails, unverified, not applicable), what a person adjudicated
  (`/devloop checklists adjudicate <list>/<item> <correct|wrong>`, a
  person's), recall on seeded defects (eval tasks tagged with the item id,
  whose task passes when the item fails as it should, in the last full run),
  and stability (trees with two results or more that agreed). `promote` and
  `demote` (a person, a dialog, audited) keep the set in
  `checklist-promoted:<root>`; a promoted item's fail on the current tree is
  its own gate row (`loop.checklistFails`). Items that never failed are
  listed as prune candidates. *As built (the cache-guard round, R12):* a
  promotion that makes an item that failed on the reviewed tree blocking,
  after the round settled, writes that tree's evidence note again
  (`noteEvidence`), so the portable record carries the item in
  `checklistFails` as the module's gate now does; the promotion's answer
  says so.

## 4.14 cache-guard

Folded from docs/design-notes/cache-guard.md. cache-guard is the repository
owner's own tool (`github.com/iimransarwar/cache-guard-for-claude`): one
standard-library Python file with its own test suite, a status line that
shows what the prompt cache saves, guards on the moves that throw a warm
cache away, a usage forecast, opt-in keep-warm and handoff, a doctor and cost
reports. It makes no network request and never reads a login token. The pure
parts are `hooks/cacheguard.ts`; `hooks/cachecmd.ts` does the work.

- **Vendored unchanged.** `cache-guard/` holds `cache_guard.py` (executable),
  `lean.md`, its `README.md`, `tests/` and `docs/`, byte for byte from commit
  `9256974` (v2.6.1). `cache-guard/VENDORED.json` records the source, the
  commit, the version, the licence and a SHA-256 per copied file under
  `files`; the two files this repository adds, `LICENSE` and `NOTICE.md`,
  are listed apart under `added`. `bash scripts/vendor-cache-guard.sh
  <checkout>` makes an update one command (a fresh copy, the Lean style
  copied again, a new manifest). tests/smoke.sh checks every copied file
  against its hash, runs `python3 cache-guard/tests/test_cache_guard.py`
  (with a throwaway HOME of its own; "skipped: no python3" without Python),
  and checks that `output-styles/lean.md` is byte-identical to
  `cache-guard/lean.md`. *Why unchanged:* a finished tool with 303 checks of
  its own; folding it into TypeScript would fork it and lose them.
- **Licence.** The whole repository, cache-guard included, is under the
  Apache License, Version 2.0 (`LICENSE`, `NOTICE`); `cache-guard/LICENSE`
  is the same text, and `cache-guard/NOTICE.md` says where the folder came
  from and that it is included unchanged at its author's request. The smoke
  test checks both licence files' hash.
- **It keeps its own way of installing** (what a plugin cannot declare: the
  status line and user-level hooks in `~/.claude/settings.json`, backed up
  first). devloop runs the vendored script with `python3` from the plugin's
  folder (`$.plugin.root`), in the repository's folder:
  - `/devloop cache install [flags]` and `/devloop cache uninstall`: a
    person (the origin check every key uses), with a dialog that says
    exactly what the installer does (copy itself to `~/.claude/cache-guard/`,
    back up and edit `~/.claude/settings.json`, replace the status line, add
    its hooks) and lists each flag given with its line from the README
    (`--trim`, `--notify`, `--keepwarm`, `--handoff`, `--lean`, `--all` and
    the `--no-` forms; any other flag is refused before the dialog). Audit
    events `cache-guard-installed`, `cache-guard-removed`.
  - `/devloop cache doctor`, `report [--all] [--days N] [session id]` and
    `status`: read-only, the script's output with terminal colour codes
    taken out and cut at 12,000 characters with a pointer to a terminal.
    `report` passes those arguments only. cache-guard has no `status`
    command: `status` prints its `--version` and whether it is installed,
    with which opt-ins (it runs nothing that writes, unlike its
    `statusline`, which keeps state). These three also need a person
    (principle 3): they change nothing, but what they read is the person's
    whole session history, which is not the building agent's to read.
  - Without Python 3.8+ every one says so plainly and runs nothing. All
    five work whether or not the repository has opted in.
- **Installed** is decided by one pure function, `guardOf`, from cache-guard's
  config file (`~/.claude/cache-guard/config.json`) and the status line in
  `~/.claude/settings.json`, both read and never written: both is
  `installed`, neither is `not-installed`, one is `half-installed` (an
  uninstall leaves the config). Only `installed` makes devloop step back.
- **One voice per subject.** Cold cache before a prompt: cache-guard's;
  devloop's idle-gap toast is off while it is installed. Cache misses and
  their cost: cache-guard's status line and `report`; devloop's meter still
  records (change records, metrics) and shows no toast for a miss except the
  devloop-side one, which is a bug report. Session budget: whichever the
  person set; doctor says when both are set. Handoff: devloop's briefing
  never carries a cache-guard handoff (nothing reaches a session unless the
  person runs `/handoff-load`); the person is told once per session, by a
  toast, that one exists for this folder (only each saved file's header line
  is read). Large command output: compatible; doctor says so when the
  trimmer is on. Setup audit: `/devloop doctor` has a "Cache (cache-guard)"
  section (installed or not, Python, the opt-ins on, both budgets) and points
  to `/devloop cache doctor`.
- **Keep-warm and the stop gate**, a tested guarantee: a turn no person's
  prompt started (a keep-warm ping, any wake) that leaves the tree as the
  last stop saw it gets no verification run, no fix round, no injected
  context and no toast from devloop. In the module: a stop in a new turn,
  after no person's prompt, on the tree of the last stop, returns before
  anything else; a stop in the same turn after a block is that turn going
  on. In the classic hook (which cannot tell who started a turn): a stop
  with a new prompt id, not after a block, on the tree of the last stop
  that was not blocked there, does nothing.
- **The Lean output style** ships as a plugin output style,
  `output-styles/lean.md` (listed as `devloop:Lean`), so it can be picked
  without installing the rest.
- **Guards.** The agent cannot reach cache-guard's state or the person's
  settings: `~/.claude/cache-guard/**` is a built-in protected path (no
  write), and its `handoffs/` and `logs/` folders, which hold what a session
  said and what its commands printed, are built-in secrets (`BUILTIN_SECRETS`:
  no read, no write, whatever the policy says). Its config, per-session
  figures, usage readings and totals hold no session content and stay
  readable. `cache-guard/**` in this repository is ordinary vendored source;
  the manifest check catches an edit. Parity rows cover each.
- **What devloop does not do:** turn on keep-warm, the trimmer or the handoff
  for anyone; read cache-guard's handoffs into a session; wrap or rewrite the
  status line; or make cache-guard a requirement: every devloop feature works
  without Python. Accepted: A21 to A23 in docs/RESIDUAL-RISK.md.

*As built (the cache-guard round, L1, L3, R13):*

- **The agent does not run cache-guard's script** (L1): rule `cache-guard`
  in the shared core refuses a run of any file named `cache_guard.py` (the
  plugin's copy, the installed one under `~/.claude/cache-guard/`, any
  other), through `python`, `python3`, `python3.x`, `py`, `pypy`, `env
  python3`, directly (`./cache_guard.py`), as a module (`-m cache_guard`),
  from inline code that names it, and inside the `bash -c` and `sh -c`
  wrappers the shell model unwraps, in every mode in which protected paths
  are judged (held in enforce, recorded in observe, not judged in a
  repository that has not opted in). The refusal names `/devloop cache …`
  as the person's way. Its tests (`python3
  cache-guard/tests/test_cache_guard.py`), reading the file and `git diff --
  cache-guard/` are ordinary commands. What a script or build tool runs
  behind the model's back stays R1.
- **The uninstall dialog** (L3) says that a status line from before the
  install is not put back and stays in the backups
  (`~/.claude/settings.json.bak-*`). The vendored tool is unchanged.
- **`report`'s arguments** (R13): a session id is 8 to 64 letters, digits
  and hyphens (`SESSION_ID`), so it names no file in cache-guard's folder;
  `--days` is given once.

## 4.15 Grounding: check before you answer

Folded from docs/design-notes/grounding.md, which is binding for it. An
agent's memory of its own work is a summary of a summary; an answer about
the state of things is checked at the source, in the turn it is given. The
harness cannot know whether a sentence is true. It knows what the person
asked, which tools were used after that prompt and before the stop, and the
final answer's text, and from those it tells an answer that rests on a look
at the source from one that rests on nothing.

- **The pure core** (`hooks/grounding.ts`), shared by every point:
  `isQuestionOfFact` (a question mark ending a sentence, an opening
  interrogative or auxiliary word after any greeting, or a checking phrase;
  `grounding.also` adds patterns, `grounding.never` removes prompts; a slash
  command is none), `isLook` (Read, Grep, Glob, a notebook read, a web fetch
  or search, an MCP tool other than the harness's own, `devloop_status` and
  `feature_check`, an agent started, an edit or write, and a shell command
  the shell model reads as running something that reads or checks: not
  `echo`, `sleep`, `true`, a bare assignment or a line that only writes),
  `hedgeIn` (the wording that marks a guess), `backstop` (the verdict) and
  `lastTurn` (the transcript reader). Each has an example table in
  tests/grounding.test.ts, the owner's own question among them, verbatim.
- **Rule.** The rules text (`RULES`, byte-stable) carries the paragraph of
  decision 1.
- **Nudge.** At `prompt.submit`, a person's prompt that is a question of
  fact gets one line of context: "This is a question about the state of
  things: check the source before answering, and say what you checked."
  Nothing is added to other prompts.
- **Backstop** (in the module's `classic.Stop` hook, before the ordinary
  stop gate, which it never replaces). The per-turn facts live in the
  module's memory beside the other per-turn state (the turn the prompt
  started, whether it is a question, its first line, the looks counted at
  `tool.call` for the main agent and any agent it started, calls a guard
  refused not counted, whether the stop was refused for this, the tree the
  turn started on), so the stored loop's shape is unchanged (`loop-10`). At
  the stop of that turn, with no look, on a tree the turn did not change: in
  enforce mode the stop is refused once with decision 4's message; a second
  stop in the same turn is never refused for this, and if it still holds no
  look the person is told ("This answer was given without checking
  anything", quoting the guess when the answer holds one) and it is
  recorded; in observe mode the toast and the record only. It never fires
  on a turn no person started (the keep-warm guarantee of 4.14 holds), on a
  subagent's stop, while a review round runs, or twice for one turn.
  `fresh: "tree"`: a turn that looked records the tree its stop saw; a later
  question on that same tree counts that look.
- **What is recorded**: a toast; the audit action `answer-unchecked` (the
  prompt's first line, the mode, the guess quoted); the ledger entry
  `grounding-unchecked`; an Activity-tab line with the prompt's first line;
  and two counts, questions of fact asked (`grounding-questions`) and answers
  given without a look after the backstop (`grounding-unchecked`), in the
  store and for the session (`grounding-session:<root>`), in `/devloop
  metrics` and the Metrics tab. `/devloop doctor` says which mode is in
  force.
- **The classic hooks**, where the module did not judge: a
  `UserPromptSubmit` classic hook (in `hooks/hooks.json`) adds the nudge
  unless the module stamped the prompt (`stamps/prompts/<session>`, the
  prompt's digest); the classic `Stop` hook reads `transcript_path` back to
  the start of its last turn (the engine's JSON lines: a user entry that is
  not a tool result or injected is a turn's start, a person's when its
  `origin.kind` is `human`; the `tool_use` blocks of the assistant entries
  after it are the calls), classifies the prompt and counts looks with the
  same functions, and refuses once (`stop_hook_active` marks the second
  stop) or tells the person (`systemMessage`), recording `answer-unchecked`
  in the inbox for the module to fold. It runs before the keep-warm quiet
  turn, since the transcript says who started a turn. A missing or
  unreadable transcript skips this check only (principle 11, amended).
  `fresh: "tree"` is not honoured there (principle 16): only this turn's
  looks count. A look by a subagent is the `Agent` call itself, since its
  own calls are in another transcript.
- **The command line** has no turn, so nothing to judge; its doctor says so
  and names the mode.
- **Policy**: `"grounding": { "mode": "enforce", "fresh": "turn", "also":
  [], "never": [] }`; `mode` off, observe or enforce, left out following the
  policy's own mode; read from the base branch like every field; a
  repository with no policy is dormant.
- **What it does not do** (A25 to A27 in docs/RESIDUAL-RISK.md): judge
  whether the look was the right one; see a question the agent asks itself
  mid-work; judge in the classic hook when the transcript cannot be read.

## 4.16 Loop limits: stop looping, test what changed

Folded from docs/design-notes/loop-limits.md, which is binding for it (its
decision numbers are used here). Two rules, `loop` and `testing` in the
policy, read from the base branch like every field.

- **The pure core** (`hooks/limits.ts`): the count on a branch (`limitOn`,
  `countRound`, `allowMore`, `isAtLimit`), the message (`limitMessage`), the
  Activity and doctor lines, the key of the files a check covers
  (`coveredKey`), the order checks run in (`orderSteps`), and the context
  line (`checksForChange`). The module's work is in `hooks/rounds.ts`.
- **What is counted** (1): a stop the gate hands back for a failed check
  (counted where the block is given), and a review round that settles FAIL
  (one count per round, in `settle`). A pass costs nothing; shipping
  (`closeShippedReview`) and `/devloop done` leave the count; a snapshot on
  another branch starts a fresh record (a detached head is one branch).
- **At the limit** (2; `"loop": { "failedRounds": 6 }`, 0 off), in enforce
  mode: the stop gate blocks no more; the first stop at the limit, whatever
  its checks said, ends with the message added (`additionalContext`) and the
  record marked told; a failed review round that reaches it hands nothing
  back (the builder is not woken, `isLooping` is false) and appends the
  message instead; a round started by auto-review, by a ship refused only
  for want of a review, or by `/devloop review` from anyone but a person is
  refused with the message. The push gate is unchanged. The person gets a
  toast ("devloop stopped after N failed rounds"), an Activity note and a
  "Failed rounds" list in the Activity tab (with the file named most often
  in their findings when one accounts for three or more), the ledger entry
  and the audit action `loop-limit`. The message is given once per limit and
  is never a block or a prompt, so it starts nothing. In observe mode the
  round the gate would have handed back is counted, and at the limit there
  is the toast and the record only.
- **A person allows more** (3): `/devloop continue [n]`, refused to any
  caller but a person, as the other keys are; it restarts the count with a
  limit of `n` (the policy's number by default) and audits
  `loop-continued` with who and when. A prompt allows nothing.
- **The last commit that passed** (4): at a stop, at a round that passes and
  in the ship gate's proof (`prove`), HEAD is recorded when the work is
  committed as it stands (HEAD's tree is the committable tree) and every
  gate row is met by the policy in force.
- **Enforcement points** (5): only the module counts. The classic hooks and
  the command line keep nothing between calls and say nothing of it.
  `/devloop doctor` reports the limit in force and this branch's count.
- **Rule and context** (6): the rules text carries decision 6's paragraph;
  each prompt's context names the checks that apply to the files changed
  ("Checks for what you changed: …"), as a delta like the other sources.
- **Targeted testing** (7; `"testing": { "scope": "targeted" }`): a check
  with `when` was already run only when a changed file matches, at every
  gate and whatever its profile; that is unchanged. New: at each
  verification, `git ls-tree -r` of the tree gives each such check a key of
  the files its globs match (path, mode and object); a pass is kept with
  its key, and a later tree with the same key carries the pass (the check is
  not run, and the pass is recorded on that tree), never for the check that
  failed last, whose key is dropped. A check without `when` behaves as
  before. The check that failed last runs first, so a second failure stops
  there. The gate's Verification row is unchanged: every applicable check
  needs a pass on the tree judged. Doctor names each `full` check without
  `when`; `/devloop init` proposes `when` globs for Go, Rust and Python
  suites. `"full"` keeps every check on every tree and the written order.
- **A second review reads the fix** (8): round 2 and later get the diff
  between the tree the previous round read and the tree now (git's diff of
  the two trees, inline up to 60,000 characters, else the files it names),
  the open findings to re-check, and the brief to confirm each and review
  only the lines changed. A finding marked `| outside` in such a round is a
  deferred follow-up for the person that does not block, unless it is high
  or critical: then it is judged as any finding and its problem says it was
  missed in an earlier round. With no earlier tree, or no diff from git, the
  round reads the whole change; round 1 is unchanged.
- **What it does not do** (9; A28 in docs/RESIDUAL-RISK.md): judge whether
  `when` globs are right, or stop the agent typing the whole suite itself.

## 4.17 Learning without being asked

Folded from docs/design-notes/auto-learning.md, which is binding for it (its
decision numbers are used here). It extends 4.8: the ledger, the repeat
groups, `LEARN_LADDER`, tombstones and content rules are reused. Its name in
the policy is `learning`, read from the base branch like every field.

- **The pure core** (`hooks/autolearn.ts`): the two lessons' words
  (`limitLesson`, `repeatLesson`), the groups that wait for a proposal
  (`pendingGroups`), the bounds on a run (`runRefusal`), the proposer's
  brief (`proposerPrompt`) and the reading of its answer
  (`parseProposals`), the gates to a trial (`trialReason`, `breadthOf`),
  the learned rules as content rules (`learnedRules`, `judgeLearned`,
  `learnedReason`), their hits (`withHits`) and upkeep (`sweepLearned`), and
  the person's listings. The work is in `hooks/learner.ts`; the read-only
  agent is `agents/learner.md` (Read, Grep, Glob).
- **Lessons write themselves** (1): with `auto` not `off`, the loop limit's
  message (`reachLimit`) records a lesson keyed `auto:loop-limit:<branch>`
  (the failed rounds, the checks that failed, the file named most often in
  the rounds' findings), and a stop that hands back the same failure as the
  last round (the same check, the same fingerprint) records one keyed
  `auto:same-failure:<command>#<fingerprint>` (the command and the first
  error line). One ledger entry per key, marked `auto`, whose `count` rises
  each time (`recordLesson`); the repeat groups weigh an entry by its count.
  `/devloop lesson <text>` is unchanged.
- **The proposer** (2): started by the harness only, with
  `subagentType: "devloop:learner"` and `models.learner`, at the end of a
  main-loop turn a person's prompt started (`turn.complete`, never in a tool
  call), and after `/devloop done`, when a group has `repeats` occurrences
  (since its tombstone, if it recurred), no proposal or learned rule made
  from it, is not a learned rule's own hits, and was not given to a run
  before. A person's `/devloop learn` starts a run on demand for every group
  of two or more with no proposal. No run with `auto` `off`, past `maxRuns`
  in the session, with the budget spent (the guards' flag, or the estimate
  past the cap), while a review runs or another proposer is at work (30
  minutes). One run takes every pending group (at most 12), each with its
  key, count, label, cheapest rung and its last three stored samples, the
  ladder and the format. It is not a round and the loop limit does not
  count it. Its tool calls meet the reviewer's rules (read-only).
- **Its answer** (2, 3): lines starting `P<n>` are read as `P<n> | <group
  key> | <kind> | <globs or file> | <pattern or text> | <why> | <eval
  task>` (a pattern or text may hold ` | `: the fields around it are
  fixed); a line that does not fit, names a group the run was not given or
  an unknown kind is dropped and counted; at most 20 are kept. Each gets an
  id `learn-<n>` no policy rule uses. A `rule` goes on trial when `auto` is
  `trial`, its pattern is at most 200 characters, it passes `contentRules`
  (the policy's own validation), no tombstone names its group, group rule
  or id, fewer than `maxTrial` trial rules exist, and it matches at most 200
  existing lines across the tracked files its globs match; otherwise it
  waits with the reason. Every other kind waits. The person gets one toast
  per run with the count ("devloop: N proposals waiting: /devloop learn")
  and an Activity line with the counts; nothing the proposer wrote is
  appended, submitted or put in any context.
- **Trial rules at work** (3): in `tool.call`, beside the policy's content
  rules and never for a reviewer, the proposer or an eval agent, a trial
  rule is a `note` content rule from the state (`trial` mode only): a hit on
  an edit that went through is recorded as any content rule's (ledger kind
  `content-rule`: the rule, the path, the line number and a fingerprint; and
  `rulehits`), and on the rule itself (its count, last hit and the hits'
  paths and lines). It refuses nothing and the call's result is unchanged. A
  pattern that does not compile, or a glob that cannot be read, gives no hit
  and never an error. At session start and at each turn's end, a trial rule
  with no hit for `pruneWindowDays` is removed and its group tombstoned, and
  a learned rule whose id the policy in force has is dropped from the state.
- **A person only promotes** (4): at `promoteHits` hits, one toast per rule
  ("devloop: trial rule <id> would have caught N edits: /devloop rules
  promote <id>"). `/devloop rules`, `rules promote <id>` and `rules drop <id>
  <reason>` refuse any caller but a person and answer display-only (the
  text goes in no request). Promote shows the pattern, globs, why and each
  hit (path and line) in a dialog; on yes the rule is `refuse` at once from
  the state (rule `content-rule`, the same lift class and hit counting as a
  policy rule; the refusal reads "devloop's promoted rule …"), audited
  `learned-rule-promoted`, and the answer prints the JSON entry for `rules`.
  When the policy in force already has the id, the state copy is dropped
  instead. Drop removes a trial or promoted rule or a waiting proposal,
  after a dialog, writes a tombstone for its group, and is audited
  `learned-rule-dropped`. `/devloop learn`, for a person with `auto` not
  `off`, opens with the trial rules and waiting proposals (display-only; the
  model's context holds the repeats and the ladder, as before); otherwise
  it answers as before.
- **Policy** (5): `"learning": { "auto": "trial", "repeats": 3,
  "promoteHits": 3, "maxTrial": 20, "maxRuns": 3 }`; `auto` `off`,
  `propose` (1 and 2: lessons and proposals, no trial rules) or `trial`; a
  wrong `auto` is read as `off`; `repeats` and `promoteHits` 1 to 100,
  `maxTrial` and `maxRuns` 0 to 100. Promoted rules from the state refuse in
  every mode (a person's decision); trial rules work only in `trial`.
  Without a policy the feature is dormant.
- **Enforcement points** (6): the module alone. The classic hooks and the
  command line neither start a proposer nor know a trial or promoted rule.
  Doctor reports the mode in force, the counts of trial and promoted rules
  and of waiting proposals, and names each promoted rule not yet in the
  policy. The rules text is unchanged.
- **What it does not do** (7; A29 and A30 in docs/RESIDUAL-RISK.md): count
  mistakes rather than matches, or describe a failure no pattern on added
  lines can; the proposer reads samples that can hold tool output.

## 4.18 The spec library

Folded from docs/design-notes/spec-library.md, which is binding for it (its
decision numbers are used here). It extends the spec interview (4.4): the
skill's first step reads earlier specs from the library as well as from
`specs/`. Its name in the policy and the code is `library`.

- **The pure core** (`hooks/library.ts`): the folder name (`entryId`,
  `slug`: `<project>--<spec name>--<yyyy-mm-dd>`, UTC), the entry made from
  the two files and the harness's facts (`entryOf`: `headerOf` reads the
  `Kind: … · Size: …` and `Related specs:` lines, a placeholder in
  parentheses read as absent; `intentOf` the intent's first sentence;
  `criteriaTextOf` the numbered criteria, text only), the index line
  (`indexLine`: the entry without its criteria), the scan of both files
  (`scanSpecFiles`: `scanCredentials`, the gate's scan of added lines, over
  every line of each), the index read (`readIndex`), and the search
  (`wordsOf`, `searchLibrary`, `limitOf`). The work is in
  `hooks/librarycmd.ts`. The record is `library-entry@1`.
- **Where** (1): the folder a person set with `/devloop library path <dir>`,
  kept in the store under `library:path`, a key of no repository (the
  person's, on this machine); absent, `library/` in the plugin's data
  folder. A path must be absolute (or under `~`), outside the repository
  and its main checkout, and outside the harness's state but for the
  default; it is created by writing an empty `index.jsonl` there. Setting the
  default deletes the key. The harness never commits, pulls or pushes it.
- **An entry** (2): `SPEC.md` and `features.json` copied byte for byte, and
  `entry.json`: id, project (the main checkout's folder name), spec, kind,
  size, related, intent, criteria, features (id, description, check),
  `approvedAt` (the approval's time), `closedAt`, `outcome` (`status`
  `closed` or `open`, `isAllPassing` (null while open), `reviewRounds` (the
  loop's round count), `defects`), `harness`, `hash` (of the two files) and
  `savedAt`. The index holds one line per save, appended (read and written
  whole, one append after another, never over an index that is there and
  cannot be read); the last line for an id is the entry, and one with
  `removedAt` marks it removed. A line that does not parse or fit is
  skipped. A save of a spec whose open entry this repository saved before,
  with the same content hash, reuses that folder: the later line supersedes.
- **When** (3): at `/devloop done`, after the change record, when the loop
  was building an approved spec; the answer gets one line (saved, and
  where, or why not). `/devloop library save` saves the current spec with
  the outcome `open`. Nothing is written when `library.save` is `off` (read
  from the policy in force; a wrong value is read as `off`), for a spec
  folder the policy's `secrets` globs match, when the files on disk no longer
  have the approved fingerprint, or when the scan finds anything: the answer
  names each hit's kind, file and line, never the value, and the close goes
  on. Audited: `library-saved`, `library-save-stopped`. Each save is noted
  per repository (`library-saved:<root>`: the entry, the library, the change
  id), so `/devloop defect` against that change raises the entry's
  `defects` in `entry.json` and in a superseding index line.
- **Finding earlier work** (4): `devloop_library { query, limit? }`, in the
  constant tool table behind tool search, opted-in repositories only. It
  reads the index, ranks the live entries by how many of the query's words
  (lower case, letters and digits, two characters or more) their spec name,
  intent, kind, project and feature descriptions hold, ties newer first
  (`closedAt`, else `savedAt`), none with no match, at most `limit` (5, at
  most 10), and answers each with its folder, project, name, kind, size,
  intent, outcome and the criteria read from its `entry.json`. It writes
  nothing. `tool.check` answers the engine's own default ask with an allow
  for a Read, Grep or Glob that really lands in the library (its spelling
  and where its links lead), never a secret, for every agent in an opted-in
  repository (`libraryMayRead`); the reviewer's answer
  (`reviewerMayRun`) counts the library beside the repository and its diff
  file. Writes: in an opted-in repository, as for the state folder, the
  library's spellings are on `Where.library`, and
  `isHarnessState` holds for a path beneath them, so every write by a file
  tool or a shell command there is refused as `harness-state` (with its own
  reason), and `rm -rf` of a temporary folder holding it is not a tidy-up.
  The rules text is unchanged.
- **Managing it** (5): `/devloop library`, `library path <dir>`, `library
  save` and `library remove <entry>` refuse any caller but a person, and
  work without a policy but for `save`. Remove asks first, deletes the
  entry's three files and its folder (a folder that holds other files is
  left, and the answer says so) and appends the entry's line with
  `removedAt`. Audited: `library-path-set`, `library-removed`. Doctor
  reports the folder (default or set), whether it is there and writable
  (an empty `.devloop-write-check` written), its live entries and
  `library.save`.
- **Enforcement points** (6): the module alone. The classic hooks and the
  command line neither save nor search; the classic hooks protect the
  default library as part of the state folder, not a folder a person set.
  The command line's doctor cannot read the store, so it names the library
  among what it does not check.
- **What it does not do** (7; A31 and A32 in docs/RESIDUAL-RISK.md): judge
  whether an earlier spec fits, merge a shared folder two people wrote at
  once, or catch confidential words the credential scan does not know.

## 10. Later phases

- **D — portable enforcement**: 4.11.
- **E — adopted prior art**: features taken from the survey of comparable
  projects, including cache management and context engineering, each recorded
  here with its source and the evidence that would justify removing it.

## 11. Adopted from prior art

From a read-only survey of 75 comparable projects (hook packs, spec toolkits,
long-running loops, review bots, sandboxes, eval harnesses, and the context
and cache handling of other coding harnesses). Ideas were taken, never code or
text. Each entry says what it prevents and what evidence would justify
removing it (principle 7).

### Guards and policy (phase B1)

- **Policy self-protection.** Built-in protected paths beyond the policy's
  own list: `devloop.json`, `.claude/settings*.json`, `.mcp.json`, hook and
  plugin folders, `.git/hooks/**`, `.git/config`, shell rc files. For the
  gate, `devloop.json` is read from the merge base (as REVIEW.md is), so a
  change cannot lower its own tier, drop a check or switch to observe; a
  working-tree policy that differs adds the gate row "Policy changed in this
  change". A repository with no base copy uses the working tree and says so.
  *As built (C1 review):* not only for the gate: the base's copy, whole, is
  the policy for every decision (principle 10).
  *Prevents:* the builder editing the policy that judges it. *Remove if:* the
  row never fires in a year of changes.
- **Test-weakening detection** wherever tests are editable (small-fix, spec,
  new test files in build): compare counts of skip/only/todo/xfail markers
  and of assertions before and after an edit; refuse a rise in skip markers
  and the deletion or disabling-rename of a test file; record an assertion
  drop as a gate note. A person's one-turn exemption lifts it.
  *Prevents:* green by hollowing the suite. *Remove if:* ledger shows only
  false alarms.
- **Destructive-command rules**, a short list with the safer command named in
  the refusal: `git reset --hard`, `git checkout -- .`, `git restore` of the
  whole tree, `git clean -f`, `git stash drop|clear`, branch deletion, `rm -rf`
  of the repository root or outside it, `curl … | sh`. A light tokenizer
  ignores text in comments, single-quoted strings and heredoc bodies and looks
  inside `bash -c`. The person's one-turn exemption extends from paths to one
  exact command. No full shell parser: this stays a tripwire.
  *Prevents:* "cleaning up" that discards uncommitted work, and false alarms
  such as `grep "terraform apply" docs/`.
- **Check-integrity lint** at approval and when policy loads: `|| true`,
  `; exit 0`, a pipe without `pipefail`, `--passWithNoTests`, output piped to
  `head|tail|grep`. Reported in the approval dialog like vacuous checks, never
  silently accepted. The builder may not run a configured check through a
  filter; the refusal points at the saved full output.
- **No-progress tripwires**: the fix loop ends when the tree hash is unchanged
  between two blocked stops; two consecutive refusals of the same rule tell
  the person instead of letting the agent hunt for a way round; a
  `devloop_blocked(reason)` tool lets the agent stop cleanly and be heard.
  *Prevents:* fix rounds burned on a wall, and weakening something because
  stopping was not an available move.
- **Spec coverage lint**: each numbered acceptance criterion in SPEC.md maps
  to at least one feature id; unmapped ones are listed in the approval dialog;
  approval is refused while `[NEEDS CLARIFICATION]` remains in the spec.

*As built (B1):* built-in protected paths are `devloop.json`,
`**/.claude/settings*.json`, `.claude.json`, `.mcp.json`, `**/.claude/hooks/**`,
`**/.claude/plugins/**`, `.claude-plugin/**`, `.husky/**`, `.githooks/**`,
`**/.git/hooks/**`, `**/.git/config`, `.gitconfig` and the shell start-up files
(`.bashrc`, `.bash_profile`, `.bash_login`, `.profile`, `.zshrc`, `.zshenv`,
`.zprofile`, `.zlogin`, `.envrc`), matched inside and outside the repository;
`git config` that sets a value writes `.git/config` (or `~/.gitconfig`).
Destructive rules: rule `destructive`, observe-able like the other policy rules,
with the safer command and the exact `/devloop allow --command` line in the
refusal; `rm -r` is judged by placed operands (root, outside the repository,
or a variable). *As built (B1.1, 12.2):* outside the repository, a path
strictly beneath `/tmp`, `/var/tmp` or `$TMPDIR` (as the environment sets it;
`"$TMPDIR/x"` is placed by it) passes unless it is, or holds, the harness's
state directory or the repository; a glob there is judged by everything it
could match. The check-integrity lint runs when policy loads (doctor lines,
gate row "Check integrity"); the approval dialog part is B2. The no-progress
tripwires and `devloop_blocked` are in 4.2 and 4.3. *As built (B2):*
test-weakening detection counts skip-like markers (Jest/Vitest/Mocha
`.skip`/`.only`/`.todo`, `xit`, `xdescribe`, `fit`; pytest
`@pytest.mark.skip|skipif|xfail`, `pytest.skip(`/`xfail(`; unittest skips;
Go `t.Skip`; Rust `#[ignore]`; JUnit `@Disabled`/`@Ignore`) and, roughly,
assertions. A rise in markers, or an edit that empties a test file, is
refused; so is `rm`/`unlink`/`shred`/`git rm` of a test file, or `mv`/`git
mv` to a name the test globs no longer match. A drop in assertions is the
gate note "Assertions removed in <file>". Shell writes that hollow a test
without deleting it are R15. The check-integrity lint and the spec coverage
lint are in the approval dialog (4.4). *As built (B2.1):* markers count only
at the start of a call; `pytestmark` skips, `SkipTest` and a Go `TestMain`
that never calls `m.Run()` count too; a new test file is judged against
nothing; a test, for deletion, is a tracked file (4.2).

### Review (phase B2)

- **Finding quality**: each finding quotes the line it is about and the
  harness checks the quote exists at `file:line` in the reviewed tree,
  demoting it to a note otherwise; a `pre_existing` flag for issues outside
  the diff, never blocking; which severities block scales with tier (low:
  critical; medium: critical and high; high: all but nits); a cap on findings
  per round; a fixed short list of what not to report.
- **Stall detection and an assurance boundary**: a round that closes no open
  finding is stalled; two stalled rounds stop the loop and hand to a person
  before the cap. The reviewer prompt has three fixed parts (frozen task and
  base, current facts, contract); nothing like "look harder at X" is passed
  forward. Once a property is shown by a test in both directions, asking for
  more guards on it is a note, not a blocker. *Prevents:* the review spiral
  measured elsewhere at nine rounds.
- **Finding lifecycle**: each open finding is routed — fix now, needs a
  person's decision, or deferred; deferred findings persist across changes
  keyed by file and quote and close when the quoted line goes; each round
  opens with addressed / reappeared / still open / new.
- **Cache-friendly spawn prompts**: stable parts first (brief, base-branch
  REVIEW.md, spec), volatile last (open findings); the diff is passed as a
  file path with the base recorded at approval, never inline.

*As built (B2):* all four, as 4.5 describes. The base in the prompt is the
snapshot's base commit (where the branch left the default branch), not one
recorded at approval. *As built (B2.1):* the quote check reads a `|` in the
problem, a diff mark and backticks, and never demotes a blocking finding (it
goes to a person); the cap is applied after the check, `pre_existing` last;
an answer the harness cannot read never passes (4.5).

### Context, cache and learning (phase C)

- **Prefix stability, enforced by a test**: the system-prompt section is
  byte-identical for the life of a thread — no phase, counts, mode or time —
  and every tool is registered at load whether or not the repository opted
  in, because a tool that appears mid-session rewrites the cached prefix. A
  test renders the section across every phase and policy state and asserts
  equality.
- **Cache-health meter**: per turn, read cache-read and cache-creation tokens;
  record hit rate per session and per change; a turn that re-bills a large
  prefix logs a miss with its probable cause (idle gap, model change,
  compaction, or a devloop-side change, which the test above should make
  impossible).
- **Hash-keyed deltas** for everything injected: each source (gate rows,
  failing features, open findings, policy errors) is emitted as initial,
  changed or removed, and not at all when its hash is unchanged.
- **Structured handoff**: objective, decisions with reasons, work state, dead
  ends, assumptions to verify with the command for each, next step, at most
  fifteen relevant files. Facts (phase, features, findings, last failure,
  files, commits) come from plugin state and git, not from the model.
- **Two-level, window-scaled context pressure** in tokens remaining, with
  debounce and immediate escalation; an **idle-gap warning** when a prompt
  after a long pause will re-write a large cache.
- **Full check output to a file** outside the working tree, with distilled
  errors, tail and the path given to the model.
- **Instruction hygiene, second pass**: a byte budget for launch-loaded
  instruction text, commands named that no longer exist, references gone
  stale since the file's last edit, duplicate blocks; plus an **injection
  scan** of instruction and skill files (invisible and bidi characters,
  decode-and-execute, directives to read secrets or edit hooks).
- **Context-cost attribution**: which files and tools put the most into the
  session, as an estimate from observed result sizes.
- **Closed specs become regression checks**, run in the `full` profile.
- **Eval upgrades**: a task's check must fail on the untouched tree; ablation
  (`eval --without <rule>`) so prune has evidence; infrastructure failures
  excluded from pass rates; negative tasks where the right outcome is that a
  guard did not fire.
- **Declarative content rules** in policy (`rules: [{ when, pattern, action,
  why }]`) as the cheap first rung for `/devloop learn`.
- **A reading aid for the approver** in the report: files ordered by tier
  with the reason, what the reviewer did not look at, up to three failure
  scenarios, a split suggestion.
- **Residual-risk register**: the bypass families the tripwire accepts, each
  with a test showing the accepted behaviour, printed by doctor.

*As built (C1):* prefix stability, the cache meter, hash-keyed deltas, the
structured handoff, two-level pressure and the idle-gap warning, the second
instruction-hygiene pass with the injection scan, and context-cost
attribution, as 4.7 describes. "Full check output to a file" was built in
B1.1. Differences: the meter reads `turn.complete`'s `usage` (summed over the
turn's responses, so a turn of several requests counts every cache read);
compaction is seen at `session.compact` (main conversation, a non-skip
result); a miss on the thread's first turn is not counted (the prefix is
written once by design); devloop's own prefix is a hash of the section it
sent and its tool specs, so a "devloop-change" miss can only come from a
section decision that changed within a session id, and is recorded under
`cache-devloop-change` with a toast. "Commands named that no longer exist"
covers package scripts and make targets; "references gone stale since the
file's last edit" is read as references to paths that do not exist now. The
injection scan's invisible and bidi classes are evidence (`evidence.hidden`,
read from the changed instruction files at verification and at the gate)
and keep "Instruction files changed" unmet; the rest are doctor lines.
Context-cost attribution counts the main conversation's tool results
(`ToolCallResult.text`, or the result's JSON) and attributes `Read`'s file;
it is an estimate. Scrubbed checks (`checkEnv`, nanochat note 6) cover the
verify commands and feature checks; eval checks are not scrubbed (R26). *As
built (C1 review, F3):* the scrubbed environment is built from nothing
(`env -i` with the allow-list of names that are shell identifiers and set),
not by unsetting names, so a name that is not an identifier and an exported
function never reach the check; `tests/smoke.sh` proves both. The
open-questions ledger (rea note) is `devloop_question` (three per turn) and
`/devloop questions [close <id> <answer>]`.

*As built (C2):* closed specs become regression checks (`hooks/regress.ts`):
at `/devloop done` on a spec'd change its feature checks are kept with the
spec, the change record's id and the close date. The ship gate's proof
(shipping, `/devloop gate`) runs each with no pass on this tree, judged by the
command rules first, with the flake rule; row "Regression checks" is met
only when each passes on this tree, a failure names the earlier change and is
an escaped defect against it. `/devloop regressions` lists them; `/devloop
regressions drop <id> <reason>` (a person, dialog, audited) retires one.
*As built (C2.1, F6):* the stored set is the truth: a check whose command
differs from the one the loop last ran (its spec reopened and closed with a
new one) starts over, its pass and tree reset. Eval
upgrades, declarative content rules and the reading aid are built as 4.8 and
4.9 say. Eval checks are now scrubbed by `checkEnv` (R26 narrowed).
`/devloop doctor --strict` counts only the invisible and bidirectional
injection classes as errors; the rest are warnings, as the gate row treats
them.

### Portability (phase D)

- **Sandbox settings emitted from the same policy**, with doctor comparing
  what is in force; a **pre-push git hook** as an opt-in backstop; **portable
  evidence** (a change record naming the verified tree hash) so CI and a
  teammate can check "this exact tree was reviewed" — CI still recomputes the
  checks.

*As built (D1):* all three, as 4.11 describes: the sandbox block and doctor's
comparison (`hooks/sandbox.ts`), the pre-push hook (`hooks/githook.ts`), and
portable evidence as a git note (`hooks/portable.ts`), which is a record, not
a signature (A12). The two items carried over: `/devloop eval` validates
out-of-date tasks only after the person confirms the run (the dialog says how
many will be validated), and a `gh` ship naming another repository is refused.
*Prevents:* a harness that fails open when its one mechanism is absent.
*Remove if:* function hooks are generally available and never skipped
(`module-skipped` never recorded in a year).

### Deliberately not adopted

Agent fleets and role casts; forced minimum findings; a model judging every
tool call; a full shell parser; skill auto-activation routers; document
pipelines; opaque learned memory; auto-merge loops; environment-variable
bypasses; rewriting the transcript or redirecting built-in tools; pushing
transcripts to the remote. Also not possible from a plugin: choosing cache
breakpoints or lifetime, keeping the main thread's cache warm, or changing
the engine's compaction.

## 12. Decisions after Phase B1, and the build plan

### Decisions (from live testing of B1 and the builder's notes)

1. **The harness-state rule is always held.** Writes by any tool call to the
   harness's own state directory are refused in every mode. Confirmed.
2. **Temporary folders may be cleaned.** `rm -rf` is refused on the repository
   root and outside the repository, *except* under the system's temporary
   directories (`/tmp`, `$TMPDIR`, `/var/tmp`), where it is allowed unless the
   path is the harness's state directory. Live testing showed the blanket
   refusal would fire on every agent that tidies up after itself.
3. **The spec phase does not block on red.** While a spec is being written its
   tests are expected to fail, so the stop gate runs the fast checks, records
   the result and blocks nothing. Approval is where red is examined.
4. **No mirror during a build.** The harness does not write `passes` into
   `features.json` while building: the file stays as approved, so recording a
   pass does not move the tree and stale earlier passes. Feature status is
   read from the status tool and the pane; the mirror is written once, at
   `/devloop done`.
5. **State is kept tidy.** Review diffs and check logs are kept for the last
   twenty runs per repository and cleared at `/devloop done`.
6. **Every config error keeps the gate shut**, unknown keys included (stricter
   than first written; kept, because a typo in a key is a guard silently not
   applied).

*As built (B1.1):* decisions 2 to 5 were built with the fixes of
`docs/reviews/phase-b1.md`; each section above that they change says so.

### Decisions before Phase B2

1. **No mirror at all.** The harness never writes `passes` into
   features.json; the field is ignored on read. (Supersedes decision 4's
   "written once, at /devloop done".)
2. **The reviewer's `git grep -o`** (`--only-matching`) is a read and is
   allowed; only `-O`/`--open-files-in-pager` is refused.
3. **The Verification row reflects per-check passes** against the base
   policy: met only when every fast and full check of the policy in force has
   a pass on the current tree; its note names the checks still to run.

*As built (B2):* all three; 4.2, 4.3 and 4.4 say where.

### Build plan

Design notes in `docs/design-notes/` hold the detail for features adopted
after this file was first written; each phase folds its notes into this file
when it is built.

- **B2 — spec and review depth.** *Built*; each section above marks what
  differs. 4.4, 4.5, 4.6 in full; test-weakening
  detection, spec coverage lint and check-integrity lint at approval (11);
  finding quality, stall detection, lifecycle, cache-friendly spawn prompts
  (11); ship-time review (9.2); from the rea note: check
  outcome classification, the credential scan of the diff, the lift class on
  refusals; `models` for review agents (skills note 5).
- **C1 — context and cache.** *Built*; 4.7, 4.3, 4.5 and 11 mark what
  differs. 4.7; the context and cache items of 11; the
  skill and instruction linter (skills note 2); instruction files git ignores
  and the scrubbed check environment (nanochat note 1, 6); the open-questions
  ledger (rea note). Also: `tests-locked` takes the deletion rule's test
  definition (B2.1 F9, 4.2), and two review-loop defects from a live session
  (item 11: the next round starts by itself once a loop has begun, in every
  phase, and the hand-off says only what will happen; the round header
  accounts for every id). New residual-risk families: R25, R26.
- **C2 — learning, evals, measurement, interface.** *Built*; 4.2, 4.6, 4.8,
  4.9, 4.10, 5 and 11 mark what differs. Also L2 (docs/reviews/live-findings.md):
  a line that ships must ship alone, and a check after the fact. New
  residual-risk families: R27–R31. 4.8, 4.9, 4.10; papercuts,
  ablation with a noise band, saturation, trajectory assertions, clean-room
  isolation, failures feeding the suite, cost by delta (skills note); the
  ratchet, difficulty band and witness (rea note); records that carry their
  inputs, the quick subset, resumable runs, tombstones, disclosure (nanochat
  note); record schemas and the audit trail (coordination note 3, 4).
- **D — portability and coordination.** 4.11 with parity tests (nanochat note
  3); sandbox settings, pre-push hook, portable evidence (11) (D1, built); claims with
  leases, follow-ups in code, ready work (coordination note 5–7); the `.tasks`
  edge integration (rea-and-tasks note); checklists (checklists note).

- **D2 — coordination.** *Built*; 4.12 and 4.13 are new, and 2, 4.1-4.7,
  4.10, 4.11, 5 and 7 mark what changed as "as built (D2)". Claims with
  leases, follow-ups in code through `gh`, ready work in dependency order,
  the `.tasks` convention at the edges (off by default) with the review
  carry-over in place of the note's hash exclusion, checklists (format,
  selection, seeding, a shadow checklist reviewer, promotion per item), and
  two items carried from D1 (the classic hook holds the secrets rule in a
  repository that has not opted in; git plumbing on the evidence notes). New
  accepted risks: R35, R36, A16-A18. The three design notes are folded.

- **D1 — enforcement points.** *Built*; 4.11, 4.2, 5, 7, 9 and 11 mark what
  differs. The standalone build of the pure core (`dist/devloop.mjs`), the
  command line, classic hooks with stamps, a heartbeat and skip detection,
  sandbox settings from the policy, the opt-in pre-push hook, portable
  evidence as git notes (rule `evidence-notes`), parity tests across the
  three enforcement points, and two carried items (eval validation after the
  dialog; `gh -R` to another repository). New accepted risks: A11–A15. Not in
  this phase (D2): claims and leases, follow-ups after a pull request,
  `.tasks`, checklists.

- **C2.1 — fixes after the C2 review.** *Built.* The decisions of
  `docs/reviews/phase-c2.md` (F1–F12 and two calls dispatched together), the
  opt-in hole from the builder's notes (a base policy keeps a repository opted
  in), and four items from a live session (findings in the status tool, a
  one-line "Check environment" note, notes and deferred findings in
  `/devloop findings` for a person, a dialog before `handoff export`
  overwrites). Sections 1, 2, 4.1, 4.2, 4.6, 4.7, 4.8, 4.9, 5 and 11 mark
  each as "as built (C2.1)"; what is newly accepted is R32–R34 and A10.

- **C1 review fixes.** *Built.* The decisions of `docs/reviews/phase-c1.md`
  (F1–F12), principles 9 and 10, the audit trail's rollover and the
  residual-risk headings in doctor. Sections 4.1, 4.3, 4.7 and 5 mark each as
  "as built (C1 review)"; what is newly accepted is A3, A7–A9 in
  docs/RESIDUAL-RISK.md.

- **B2.1 — fixes after the B2 review.** *Built.* The decisions of
  `docs/reviews/phase-b2.md` (F1–F12, L1, the four items cut by the
  reviewer's cap, the builder's three notes), with principle 8; the sections
  above mark each as "as built (B2.1)", and what they knowingly accept is
  R18–R24 in docs/RESIDUAL-RISK.md.

Each phase ends the same way: the four checks, an independent fresh-context
review whose findings are decided in `docs/reviews/`, and live sessions
against a throwaway repository.
