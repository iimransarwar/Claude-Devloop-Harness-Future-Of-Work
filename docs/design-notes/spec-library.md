# Design note: a shared spec library

Asked for by the repository owner: every finished spec is saved in a shared
folder outside the project, so later work, in this project or another, can
start from it. It extends the spec interview (`spec-interview.md`), whose
first step reads earlier specs: today it can read only the specs in the same
repository.

This note is the system of record. Its name in the code is `library`.

## Decisions

### 1. Where the library lives
A folder outside every repository, set by the person, never by a policy file
(a library is the person's or the team's, not one project's):

- by default, `library/` in the plugin's data folder: shared by every project
  on this machine for this person;
- `/devloop library path <dir>` (a person's) points it at another folder:
  a folder synced by a drive, a network share, or a clone of a team's
  library repository. The harness writes files there; it never commits,
  pulls or pushes. Keeping a shared folder in step is the person's or the
  team's tool's job.

The chosen path is kept in the harness's state for the person (not per
repository). Doctor reports it, whether it exists and is writable, and how
many entries it holds.

### 2. What an entry is
One folder per entry: `<project>--<spec name>--<yyyy-mm-dd>/` holding

- `SPEC.md` and `features.json` as approved, copied unchanged;
- `entry.json`: the project (the repository folder's name), the spec name,
  kind and size and related specs (from the SPEC.md header lines when
  present), the intent's first sentence, the acceptance criteria (text only),
  each feature's id, description and check command, the dates (approved,
  closed), the outcome (closed with every feature passing; the number of
  review rounds; any escaped defect recorded later against the change), the
  harness version, and a content hash.

Nothing else is copied: no source code, no tests, no diffs, no transcripts,
no review findings.

`index.jsonl` in the library's root holds one line per entry (its
`entry.json` without the criteria) and is the only file a search reads
first. Only the harness writes the index; a line is appended, never edited,
and a later line for the same entry supersedes an earlier one.

### 3. When an entry is saved
Automatically, when a person closes a change with `/devloop done` and the
change had an approved spec. The `/devloop done` answer says where it was
saved. `/devloop library save` (a person's) saves the current spec now, for
example one approved but not yet closed; its entry's outcome says "open".

Before anything is written, the two files are scanned with the same
credential scan the gate uses on a diff's added lines. A hit stops the save,
names the file and line (never the value) and tells the person to fix the
spec first; the change still closes. A spec folder matching the policy's
`secrets` globs is never copied.

`library.save` in the policy (`"auto"` by default, or `"off"`) lets a
repository opt out: a project whose specs must not leave it sets `"off"`,
and then neither the automatic save nor `/devloop library save` writes
anything for it. Read from the base branch like every policy field.

### 4. Finding earlier work
A read-only tool, `devloop_library { query, limit? }`, registered with the
other tools (constant spec, behind ToolSearch). It searches the index by the
words of the query against the spec name, intent, kind, project and feature
descriptions, ranks by the number of matching words (ties: newer first) and
returns at most `limit` (default 5, at most 10) entries: their folder,
project, name, kind, intent, outcome, and the criteria. The agent then reads
an entry's `SPEC.md` by its path; reads inside the library are allowed for
every agent, like reads inside the repository. Writes into the library by
any tool call are refused (the folder is the harness's).

The spec skill's first step searches the library as well as `specs/`, and
names to the person every earlier spec it used, with its project.

### 5. Managing it
All a person's, all audited:

- `/devloop library`: the path, the number of entries, the last ten.
- `/devloop library path <dir>`: set the folder (created if missing).
- `/devloop library save`: save the current spec now.
- `/devloop library remove <entry>`: deletes the entry's folder and appends
  a line to the index that marks it removed. Asks first.

### 6. Enforcement points
The module does all of this. The classic hooks and the command line keep
nothing between calls and do not save or search; the command line's
`doctor` reports the library's path when it can read the person's state.

### 7. What this does not do
It does not decide whether an earlier spec fits the new work: the agent
reads it and the person sees which ones were used. It does not merge or
resolve a shared folder that two people wrote at once (the index is
append-only, so a conflict loses at most a duplicate line). A spec can
still describe confidential work in words the credential scan does not
catch: `library.save: "off"` is the control for such a project, and the
register says so.

## Tests the build must add
Module tests: the automatic save at `/devloop done` with an approved spec,
and none without one; the entry's files and `entry.json` fields; the
credential scan stopping a save without stopping the close; `library.save:
"off"`; `/devloop library save`, `path`, `remove` refused for an agent and
working for a person, with audit events; the index append and supersede;
the search's ranking and `limit`; reads in the library allowed and writes
refused; the spec skill's text naming the tool.
