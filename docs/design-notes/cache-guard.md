# Design note: including cache-guard

cache-guard is the repository owner's own tool
(`github.com/iimransarwar/cache-guard-for-claude`), included here at their
request and with their permission to copy it as is. It is one standard-library
Python file with its own test suite: a status line that shows what the prompt
cache is saving, guards on the moves that throw a warm cache away, a usage
forecast, opt-in keep-warm and handoff, a doctor and cost reports. It makes no
network request and never reads a login token.

This note is the system of record for how it is included.

## Decisions

### 1. Vendored unchanged
The files are copied byte for byte into `cache-guard/` (`cache_guard.py`,
`lean.md`, its `README.md`, `tests/`, `docs/`), from commit `9256974`
(v2.6.1). A manifest (`cache-guard/VENDORED.json`) records the source
repository, the commit and a SHA-256 for every file; the smoke test fails if a
vendored file differs from its manifest entry, and runs cache-guard's own
test suite. Nothing in devloop edits those files: an update is a fresh copy
and a new manifest.

*Why unchanged:* it is a finished tool with 303 checks of its own. Folding
its logic into devloop's TypeScript would fork it from its upstream and lose
those tests.

### 2. cache-guard keeps its own way of installing
cache-guard owns things a plugin cannot declare: the status line command and
user-level hooks in `~/.claude/settings.json`, which it backs up before
editing. Its uninstaller takes its own entries out again; a status line that
was there before the install is not put back (it stays in the backup), and
the uninstall dialog says so. devloop does not re-implement any of that. It
exposes the tool through person-only commands that run the vendored script:

- `/devloop cache install [flags]` and `/devloop cache uninstall` — a person,
  with a dialog that says exactly what will change (the status line is
  replaced; hooks are added to the user's settings; a backup is kept) and
  lists the flags chosen. Opt-ins (`--trim`, `--notify`, `--keepwarm`,
  `--handoff`, `--lean`) stay opt-ins: the dialog names each one that is on.
- `/devloop cache doctor`, `/devloop cache report [args]`,
  `/devloop cache status` — read-only, print the script's own output.

The script is run from the plugin's folder with the session's Python. Without
Python 3.8+ the commands say so and doctor reports it. The building agent
cannot run these: install and uninstall change the person's settings, and
`~/.claude/settings*.json` is already a protected path for every tool call.

### 3. One voice per subject
Where both tools would speak about the same thing, exactly one does:

| Subject | Who speaks | The other |
| - | - | - |
| Cold cache before a prompt | cache-guard (it prices the re-read) | devloop's idle-gap toast is off while cache-guard is installed |
| Cache misses and their cost | cache-guard's status line and `report` | devloop's meter records for change records and metrics, and stays silent |
| Session budget | whichever the person configured; if both are set, both apply and doctor says so | — |
| Handoff | both, for different moments: cache-guard writes one while you are away, before the cache dies; devloop writes one under context pressure or on request | devloop's briefing never injects a cache-guard handoff: that tool's rule is that nothing reaches a new session unless the person runs its load command. The person is told one exists |
| Large command output | cache-guard's opt-in trimmer shortens what the model sees; devloop keeps full check output in its own state and refuses filtered check runs | compatible; doctor notes when both are on |
| Setup audit | `/devloop doctor` adds a short cache section (installed or not, Python, which opt-ins are on) and points to `/devloop cache doctor` for the full scan | — |

"Installed" is detected from cache-guard's own config file and from the
status line in the user's settings, read-only.

### 4. Keep-warm and the stop gate
A keep-warm ping is a full turn that changes nothing. devloop's stop gate
already runs nothing when the tree is unchanged; this is now a tested
guarantee: a turn that is not a person's prompt and leaves the tree as it was
gets no verification run, no fix round, no injected context and no toast from
devloop, so a session kept warm overnight costs nothing extra from the
harness.

### 5. The Lean output style
`lean.md` ships as a plugin output style as well (`output-styles/lean.md`, a
byte-identical copy checked by the smoke test), so it can be picked without
installing the rest.

### 6. What devloop does not do
It does not turn on keep-warm, the trimmer or the handoff for anyone; it does
not read cache-guard's saved handoffs into a session; it does not wrap or
rewrite the status line; and it does not make cache-guard a requirement:
every devloop feature works without Python.

### 7. Licence
The owner said the work is theirs and may be copied as is, and chose
Apache-2.0 for it and for the whole repository. `cache-guard/LICENSE` and the
top-level `LICENSE` are the same unmodified Apache 2.0 text (the smoke test
checks both by hash). `cache-guard/NOTICE.md` says where the files came from,
the commit they were copied at, and that they are included at the author's
request; the top-level `NOTICE` carries the repository's copyright line and
points to it. `LICENSE` and `NOTICE.md` in the folder are additions, listed
separately in the manifest; no header is added to the vendored files.
