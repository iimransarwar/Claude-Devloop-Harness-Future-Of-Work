#!/usr/bin/env bash
# Runs the plugin's git scripts (SNAPSHOT, FIND_BASE, BASE_POLICY, PUSH_RANGE,
# LS_FILES, SCRUBBED, ADDED_LINES, BASE_FILE from hooks/scripts.ts, which the
# hooks module and dist/devloop.mjs share; REVIEW_DIFF from hooks/state.ts;
# TEST_FILES, TEST_HASHES from hooks/evidence.ts; INSTRUCTION_FILES also from
# hooks/scripts.ts), taken word for word, against throwaway git
# repositories: no model, no plugin engine. One line per check; exits
# non-zero if any expectation fails.
set -u

here=$(cd "$(dirname "$0")/.." && pwd)
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

# Each script is the text between `[export ]const NAME = \`` and the closing backtick line.
extract() { # extract <NAME> <file> <text it must hold> [source, hooks/scripts.ts by default]
  src="$here/${4:-hooks/scripts.ts}"
  awk -v name="$1" '$0 == "const " name " = `" || $0 == "export const " name " = `" { on = 1; next } on && /^`$/ { exit } on { print }' "$src" >"$2"
  if ! grep -q "$3" "$2"; then
    echo "FAIL could not extract $1 from $src"
    exit 1
  fi
}
extract SNAPSHOT "$work/snapshot.sh" 'git write-tree'
extract FIND_BASE "$work/find-base.sh" 'merge-base'
extract BASE_POLICY "$work/base-policy.sh" 'devloop.json'
extract PUSH_RANGE "$work/push-range.sh" 'merge-base'
extract REVIEW_DIFF "$work/review-diff.sh" 'no-ext-diff' hooks/state.ts
extract LS_FILES "$work/ls-files.sh" 'ls-files --'
extract ADDED_LINES "$work/added-lines.sh" 'diff -U0'
extract TEST_FILES "$work/test-files.sh" 'ls-files -co' hooks/evidence.ts
extract TEST_HASHES "$work/test-hashes.sh" 'hash-object' hooks/evidence.ts
extract BASE_FILE "$work/base-file.sh" 'git show'
extract SCRUBBED "$work/scrubbed.sh" 'env -i'
extract INSTRUCTION_FILES "$work/instruction-files.sh" 'ls-files -o -i'
extract EVAL_MAKE "$work/eval-make.sh" 'worktree add' hooks/evals.ts
extract EVAL_DROP "$work/eval-drop.sh" 'worktree remove' hooks/evals.ts
extract EVAL_RESET "$work/eval-reset.sh" 'reset -q --hard' hooks/evals.ts
extract EVAL_APPLY "$work/eval-apply.sh" 'git apply' hooks/evals.ts
extract EVAL_REMOVE "$work/eval-remove.sh" 'rm -rf' hooks/evals.ts
extract CARRY_DIFF "$work/carry-diff.sh" 'diff --raw --no-renames'
extract MAIN_ROOT "$work/main-root.sh" 'git-common-dir'

failures=0
pass() { echo "ok   $1"; }
fail() { echo "FAIL $1"; failures=$((failures + 1)); }
expect() { # expect <name> <actual> <expected>
  if [ "$2" = "$3" ]; then pass "$1"; else fail "$1 (got '$2', expected '$3')"; fi
}
differ() { # differ <name> <a> <b>
  if [ -n "$2" ] && [ "$2" != "$3" ]; then pass "$1"; else fail "$1 (both '$2')"; fi
}

# snap [base]: the script's answer in the current directory, as the plugin runs it.
# BRANCH is the configured default branch (main unless a case says otherwise).
# As the plugin calls it (sweepSpecsOf): the instruction globs as pathspecs, then the excluded folders.
SPECS=(':(glob)**/CLAUDE.md' ':(glob).claude/rules/**' ':(exclude,glob)**/node_modules' ':(exclude,glob)**/node_modules/**' ':(exclude,glob)**/vendor' ':(exclude,glob)**/vendor/**')
snap() { bash -c "$(cat "$work/snapshot.sh")" devloop "${BRANCH:-main}" "${1:-}" "${SPECS[@]}"; }
# The base FIND_BASE finds must be the snapshot's, in every case below that checks it.
samebase() { expect "find-base agrees with the snapshot ($1)" "$(bash -c "$(cat "$work/find-base.sh")" devloop "${BRANCH:-main}" "${2:-}")" "$(field base "${2:-}")"; }
field() { snap "${2:-}" | sed -n "s/^$1://p" | head -1; }
# The cache-guard round, R14: every line is tagged, a changed file as `file:<path>`.
files() { snap "${1:-}" | sed -n 's/^file://p' | sort | tr '\n' ' ' | sed 's/ $//'; }
untagged() { snap "${1:-}" | grep -v -E '^(tree|committable|headtree|branch|head|base|diff|ignored|capped|hidden|hiddencap|differcount|differs|file):'; }
run() { script=$1; shift; bash -c "$(cat "$work/$script.sh")" devloop "$@"; }

export GIT_AUTHOR_NAME=smoke GIT_AUTHOR_EMAIL=smoke@example.invalid
export GIT_COMMITTER_NAME=smoke GIT_COMMITTER_EMAIL=smoke@example.invalid

repo="$work/repo"
mkdir -p "$repo" && cd "$repo" || exit 1
git init -q -b main .
git config commit.gpgsign false
printf 'a+b\n' >calc.txt
printf 'one\n' >notes.txt
git add -A && git commit -q -m base
git checkout -q -b feature

# 1. A clean tree: a hash, the branch, no changed files, an empty diff.
clean=$(field tree)
[ -n "$clean" ] && pass "clean tree has a content hash" || fail "clean tree has a content hash"
expect "branch is read" "$(field branch)" "feature"
expect "clean tree changes no files" "$(files)" ""
expect "clean tree's diff is empty" "$(field diff)" "0 0"
expect "the base is where the branch left main" "$(field base)" "$(git rev-parse main)"
samebase "a branch off main"

# 2. An edit moves the hash and lists the file.
printf 'a+b\nc\n' >calc.txt
edited=$(field tree)
differ "an edit changes the hash" "$edited" "$clean"
expect "an edit lists the file" "$(files)" "calc.txt"
expect "R14: every line of the snapshot is tagged (a changed file as file:)" "$(untagged)" ""
expect "diff size counts files and lines" "$(field diff)" "1 1"

# 3. The racy case: an index written this second, then a same-size edit in
#    the same second (a+b -> a-b). Without cp -p the copied index is newer
#    than the file and git trusts its cached stat.
#    The second is pinned in the past so the run cannot drift into the next
#    one, and ctime is left out of git's stat check (it cannot be set back).
git config core.trustctime false
past=$(($(date +%s) - 30))
printf 'a+b\n' >calc.txt
touch -d "@$past" calc.txt
git add calc.txt
touch -d "@$past" .git/index
before=$(field tree)
expect "restoring the content restores the hash" "$before" "$clean"
printf 'a-b\n' >calc.txt
touch -d "@$past" calc.txt .git/index
after=$(field tree)
differ "a same-second, same-size edit changes the hash" "$after" "$before"
expect "the same-size edit lists the file" "$(files)" "calc.txt"
expect "the same-size edit counts its lines" "$(field diff)" "1 2"

# 4. An untracked file counts as content.
withEdit=$(field tree)
printf 'new\n' >fresh.txt
differ "an untracked file changes the hash" "$(field tree)" "$withEdit"
expect "an untracked file is listed" "$(files)" "calc.txt fresh.txt"

# 5. The real index is never touched.
indexBefore=$(stat -c '%Y %s' .git/index; sha1sum .git/index)
snap >/dev/null
indexAfter=$(stat -c '%Y %s' .git/index; sha1sum .git/index)
expect "the real index is untouched" "$indexAfter" "$indexBefore"
expect "the untracked file is still untracked" "$(git status --porcelain fresh.txt)" "?? fresh.txt"

# 6. Committing does not change the content, so the hash stays.
uncommitted=$(field tree)
git add -A && git commit -q -m work
expect "a commit leaves the tree hash unchanged" "$(field tree)" "$uncommitted"
expect "after a commit the files still differ from main" "$(files)" "calc.txt fresh.txt"

# 7. Base override: after a change closes at a commit, later diffs start there.
closed=$(git rev-parse HEAD)
printf 'two\n' >>notes.txt
expect "without a base the diff starts at main" "$(files)" "calc.txt fresh.txt notes.txt"
expect "with the closed change as base only new work shows" "$(files "$closed")" "notes.txt"
expect "a base that is not an ancestor is ignored" "$(files 0000000000000000000000000000000000000000)" "calc.txt fresh.txt notes.txt"
samebase "the closed change as base" "$closed"

# 8. A repository with no commits yet: content still hashes, files are listed.
empty="$work/empty"
mkdir -p "$empty" && cd "$empty" || exit 1
git init -q -b main .
printf 'x\n' >first.txt
emptyTree=$(field tree)
[ -n "$emptyTree" ] && pass "a repository with no commits has a hash" || fail "a repository with no commits has a hash"
expect "a repository with no commits has no head" "$(field head)" ""
samebase "no commits yet"
expect "a repository with no commits lists its files" "$(files)" "first.txt"
expect "a repository with no commits sizes its diff" "$(field diff)" "1 1"
[ ! -e .git/index ] && pass "a repository with no commits gets no index" || fail "a repository with no commits gets no index"

# 9. Outside git: no answer at all, and no error.
plain="$work/plain"
mkdir -p "$plain" && cd "$plain" || exit 1
printf 'x\n' >file.txt
out=$(snap 2>&1)
code=$?
expect "outside git the script says nothing" "$out" ""
expect "outside git the script exits 0" "$code" "0"

# 10. F13: a rename lists the old path as well as the new one.
cd "$repo" || exit 1
git mv -f calc.txt sum.txt
expect "a rename lists both paths" "$(files)" "calc.txt fresh.txt notes.txt sum.txt"
git mv -f sum.txt calc.txt

# 11. F4: configured "main" on a repository whose branch is master.
legacy="$work/legacy"
mkdir -p "$legacy" && cd "$legacy" || exit 1
git init -q -b master .
git config commit.gpgsign false
printf 'a\n' >a.txt && git add -A && git commit -q -m base
git checkout -q -b topic
printf 'b\n' >b.txt && git add -A && git commit -q -m work
expect "with main missing, master is the base and committed work is listed" "$(BRANCH=main files)" "b.txt"
expect "the base is master's commit" "$(BRANCH=main field base)" "$(git rev-parse master)"
git checkout -q master
printf 'c\n' >c.txt && git add -A && git commit -q -m direct
expect "on master itself with main configured, the base is unknown" "$(BRANCH=main field base)" "unknown"
BRANCH=main samebase "on master itself"
printf 'd\n' >d.txt
expect "with the base unknown, uncommitted work is still listed" "$(BRANCH=main files)" "d.txt"
rm d.txt

# 12. A remote's HEAD names the base when the configured branch is missing.
remote="$work/remote.git"
git init -q --bare "$remote"
git remote add origin "$remote"
git push -q origin master 2>/dev/null
git remote set-head origin master >/dev/null 2>&1
git checkout -q -b topic2
printf 'e\n' >e.txt && git add -A && git commit -q -m more
expect "origin/HEAD names the base" "$(BRANCH=trunk field base)" "$(git rev-parse origin/master)"
BRANCH=trunk samebase "origin/HEAD"
(cd "$plain" && expect "outside git find-base says unknown" "$(bash -c "$(cat "$work/find-base.sh")" devloop main '')" "unknown")
expect "and the work on the branch is listed" "$(BRANCH=trunk files)" "e.txt"

# 13. PUSH_RANGE: what a push to the default branch would land.
expect "a push lands the commits not on the remote's default branch" "$(run push-range master HEAD | tr '\n' ' ' | sed 's/ $//')" "known e.txt"
expect "an unknown remote branch is said to be unknown" "$(run push-range nosuch HEAD)" "unknown"

# 14. BASE_POLICY: devloop.json as the base commit holds it, or exit 3 without one.
cd "$repo" || exit 1
printf '{ "mode": "enforce" }\n' >devloop.json
git add devloop.json && git commit -q -m policy
withPolicy=$(git rev-parse HEAD)
printf '{ "mode": "observe" }\n' >devloop.json
expect "the base's copy is read, not the working tree's" "$(run base-policy "$withPolicy")" '{ "mode": "enforce" }'
run base-policy "$(git rev-parse main)" >/dev/null 2>&1
expect "no copy on the base exits 3" "$?" "3"
git checkout -q -- devloop.json

# 15. REVIEW_DIFF: the whole change, untracked files included, into a file outside the tree.
printf 'brand new\n' >untracked.txt
out="$work/state/review-1.diff"
run review-diff "$(git rev-parse main)" "$out"
grep -q '^+brand new$' "$out" && pass "the review diff holds untracked files" || fail "the review diff holds untracked files"
grep -q '^diff --git a/devloop.json' "$out" && pass "the review diff holds committed work" || fail "the review diff holds committed work"
expect "writing the review diff leaves the file untracked" "$(git status --porcelain untracked.txt)" "?? untracked.txt"
rm -f untracked.txt

# 16. ADDED_LINES: the change's added lines from the base, untracked files included, with new line numbers.
printf 'line one\nline two\n' >added.txt
lines=$(run added-lines "$(git rev-parse main)")
echo "$lines" | grep -q '^+++ b/added.txt$' && pass "added lines name an untracked file" || fail "added lines name an untracked file"
echo "$lines" | grep -q '^+line two$' && pass "added lines hold the untracked file's lines" || fail "added lines hold the untracked file's lines"
echo "$lines" | grep -q '^@@ -0,0 +1,2 @@' && pass "added lines carry the new line numbers" || fail "added lines carry the new line numbers"
echo "$lines" | grep -q '^ ' && fail "added lines carry no context" || pass "added lines carry no context"
expect "writing the added lines leaves the file untracked" "$(git status --porcelain added.txt)" "?? added.txt"

# 17. TEST_FILES and TEST_HASHES: tracked and new files, ignored ones left out, hashed as git hashes them.
printf 'ignored.test.ts\n' >.gitignore
printf 'x\n' >ignored.test.ts
printf 'expect(1)\n' >new.test.ts
listed=$(run test-files)
echo "$listed" | grep -qx 'new.test.ts' && pass "test files include new ones" || fail "test files include new ones"
echo "$listed" | grep -qx 'calc.txt' && pass "test files include tracked ones" || fail "test files include tracked ones"
echo "$listed" | grep -qx 'ignored.test.ts' && fail "test files leave ignored ones out" || pass "test files leave ignored ones out"
expect "a test file is hashed as git hashes it" "$(run test-hashes new.test.ts gone.test.ts)" "$(git hash-object new.test.ts) new.test.ts"
rm -f .gitignore ignored.test.ts new.test.ts added.txt

# 17b. LS_FILES (B2.1 F9): tracked files only, so an untracked cache under a test folder is no test; outside git it fails, so nothing reads as untracked.
mkdir -p tests/__pycache__
printf 'x\n' >tests/a.test.ts
printf 'x\n' >tests/__pycache__/a.pyc
git add tests/a.test.ts
expect "ls-files lists a tracked test under a folder" "$(run ls-files tests)" "tests/a.test.ts"
expect "ls-files lists nothing tracked under an untracked cache" "$(run ls-files tests/__pycache__)" ""
git rm -q --cached tests/a.test.ts
rm -rf tests
(cd "$plain" && run ls-files . >/dev/null 2>&1)
code=$?
[ "$code" -ne 0 ] && pass "outside git ls-files fails, so tracking is unknown" || fail "outside git ls-files fails, so tracking is unknown"

# 18. BASE_FILE: a file as the base commit holds it, or exit 3 without one.
printf 'base rules\n' >REVIEW.md
git add REVIEW.md && git commit -q -m review
withReview=$(git rev-parse HEAD)
printf 'rewritten by the change\n' >REVIEW.md
expect "REVIEW.md is read from the base, not the working tree" "$(run base-file "$withReview" REVIEW.md)" "base rules"
run base-file "$(git rev-parse main)" REVIEW.md >/dev/null 2>&1
expect "no REVIEW.md on the base exits 3" "$?" "3"
git checkout -q -- REVIEW.md

# 19. C1 review F1: nothing in the working tree is left out of the hash. A
#     file or a folder at the old handoff path moves the hash and is listed
#     like any other path, and no argument the plugin can pass (a policy
#     value) removes a path from it: an exclude pathspec narrows only the
#     sweep for ignored instruction files.
cd "$repo" || exit 1
git checkout -q -- . 2>/dev/null
before=$(field tree)
printf '# Progress\n- next: the rest\n' >PROGRESS.md
differ "a file at the old handoff path moves the tree hash" "$(field tree)" "$before"
files | grep -qw PROGRESS.md && pass "a file at the old handoff path is listed as changed" || fail "a file at the old handoff path is listed as changed"
git add PROGRESS.md && git commit -q -m progress
committed=$(field tree)
printf '\n## Handoff\n- next: more\n' >>PROGRESS.md
differ "appending to it moves the hash like any other edit" "$(field tree)" "$committed"
git checkout -q -- PROGRESS.md
git rm -q PROGRESS.md && git commit -q -m 'no progress'
gone=$(field tree)
mkdir -p PROGRESS.md && printf 'exit 0\n' >PROGRESS.md/check.sh
differ "a folder at the old handoff path moves the tree hash" "$(field tree)" "$gone"
files | tr ' ' '\n' | grep -qx 'PROGRESS.md/check.sh' && pass "a file inside that folder is listed as changed" || fail "a file inside that folder is listed as changed"
withFolder=$(field tree)
excluded=$(bash -c "$(cat "$work/snapshot.sh")" devloop main '' ':(glob)**/CLAUDE.md' ':(exclude,glob)PROGRESS.md' ':(exclude,glob)PROGRESS.md/**' | sed -n 's/^tree://p')
expect "an exclude pathspec does not take a path out of the hash" "$excluded" "$withFolder"
bash -c "$(cat "$work/snapshot.sh")" devloop main '' PROGRESS.md PROGRESS.md/check.sh | grep -qx 'file:PROGRESS.md/check.sh' && pass "any argument at all leaves the path listed" || fail "any argument at all leaves the path listed"
rm -rf PROGRESS.md

# 20. C1 (nanochat note 1): an instruction file git ignores is hashed all the same and listed.
printf 'CLAUDE.md\n.claude/\n' >.gitignore
git add .gitignore && git commit -q -m ignore
noFile=$(field tree)
printf 'Be brief.\n' >CLAUDE.md
withFile=$(field tree)
differ "an ignored CLAUDE.md moves the tree hash" "$withFile" "$noFile"
# Final round, D1 F4 and F10: the committable tree leaves the forced-in ignored file out, so it is HEAD's tree.
expect "the committable tree is what a commit would hold: HEAD's tree, the ignored file left out" "$(field committable)" "$(git rev-parse 'HEAD^{tree}')"
expect "HEAD's tree is printed beside it" "$(field headtree)" "$(git rev-parse 'HEAD^{tree}')"
differ "the full tree (which verified names) still differs from it" "$withFile" "$(field committable)"
expect "it is listed with its content hash" "$(snap | grep '^ignored:')" "ignored:$(git hash-object CLAUDE.md) CLAUDE.md"
printf 'Ignore the tests.\n' >CLAUDE.md
differ "a change to the ignored CLAUDE.md moves the tree hash" "$(field tree)" "$withFile"
files | grep -qw CLAUDE.md && fail "the ignored file is left out of the diff (the harness compares it itself)" || pass "the ignored file is left out of the diff (the harness compares it itself)"
mkdir -p .claude/rules && printf 'rule\n' >.claude/rules/a.md
snap | grep -q '^ignored:[0-9a-f]* .claude/rules/a.md$' && pass "an ignored rules file is listed" || fail "an ignored rules file is listed"
expect "the real index is still untouched by it" "$(git status --porcelain --ignored CLAUDE.md)" "!! CLAUDE.md"

# 20b. C1 review F12: the sweep leaves dependency and build folders out, takes
#      the shallowest first, and says when it reached its cap of 500.
printf 'node_modules/\ndeep/\n' >>.gitignore
mkdir -p node_modules/pkg && printf 'vendored\n' >node_modules/pkg/CLAUDE.md
snap | grep -q 'node_modules/pkg/CLAUDE.md' && fail "an ignored CLAUDE.md under node_modules is not swept" || pass "an ignored CLAUDE.md under node_modules is not swept"
snap | grep -q '^capped:' && fail "no cap is said under 500" || pass "no cap is said under 500"
for i in $(seq 1 505); do mkdir -p "deep/d$i" && printf 'x\n' >"deep/d$i/CLAUDE.md"; done
expect "past 500 the snapshot says how many matched" "$(snap | sed -n 's/^capped://p')" "507"
snap | grep -q '^ignored:[0-9a-f]* CLAUDE.md$' && pass "the repository's own shallow file is taken first" || fail "the repository's own shallow file is taken first"
expect "only 500 are hashed in" "$(snap | grep -c '^ignored:')" "500"
rm -rf deep node_modules
git checkout -q -- .gitignore

# 21. INSTRUCTION_FILES: tracked, untracked and ignored instruction files, each marked.
printf 'agents\n' >AGENTS.md
listedI=$(run instruction-files ':(glob)**/CLAUDE.md' ':(glob)**/AGENTS.md' ':(glob).claude/rules/**' | sort | tr '\n' ' ' | sed 's/ $//')
expect "instruction files are listed by whether git tracks them" "$listedI" "i .claude/rules/a.md i CLAUDE.md u AGENTS.md"
rm -rf CLAUDE.md AGENTS.md .claude .gitignore

# 22. SCRUBBED (nanochat note 6): only the names passed reach the check, and no login profile runs.
got=$(env FOO_TOKEN=secret KEEP_ME=yes bash -c "$(cat "$work/scrubbed.sh")" devloop 'printf "%s|%s|%s" "$FOO_TOKEN" "$KEEP_ME" "$(command -v git >/dev/null && echo path)"' PATH KEEP_ME)
expect "a scrubbed check sees what was passed and nothing else" "$got" "|yes|path"
code=$(bash -c "$(cat "$work/scrubbed.sh")" devloop 'exit 3' PATH; echo $?)
expect "a scrubbed check's exit code is its own" "$code" "3"
# C1 review F3: built from nothing. A name that is not a shell identifier, and
# an exported function, never reach the check, even when the pass list names them.
leak() { echo leaked; }
export -f leak
seen=$(env 'npm_config_//registry.example/:_authToken=sekrit' 'a.b-token=sekrit2' bash -c "$(cat "$work/scrubbed.sh")" devloop 'env; type leak 2>&1' PATH 'a.b-token' 'npm_config_//registry.example/:_authToken' 'BASH_FUNC_leak%%')
echo "$seen" | grep -q 'sekrit' && fail "names that are not identifiers do not reach the check" || pass "names that are not identifiers do not reach the check"
echo "$seen" | grep -q 'BASH_FUNC' && fail "an exported function does not reach the check" || pass "an exported function does not reach the check"
echo "$seen" | grep -q 'leaked\|is a function' && fail "the exported function cannot be called" || pass "the exported function cannot be called"
expect "only the allowed names are in the check's environment" "$(env -i PATH="$PATH" KEEP=1 DROP=2 bash -c "$(cat "$work/scrubbed.sh")" devloop 'env | cut -d= -f1 | grep -v "^_$\|^PWD$\|^SHLVL$" | sort | tr "\n" " "' PATH KEEP)" "KEEP PATH "
unset -f leak

# 23. C2: an eval's sandbox, a worktree or a fresh clone of HEAD; reset restores the seed; a patch applies; a file is removed; it is dropped.
cd "$repo" || exit 1
git checkout -q -- . 2>/dev/null
printf 'seed\n' >seed.txt
git add seed.txt && git commit -q -m seed
printf 'local only\n' >untracked-only.txt
stamp=$$
for mode in worktree clone; do
  box="/tmp/devloop-eval-smoke-$mode-$stamp"
  run eval-make "$mode" "$box" >/dev/null 2>&1
  expect "eval-make ($mode) holds HEAD's files" "$(cat "$box/seed.txt" 2>/dev/null)" "seed"
  [ -e "$box/untracked-only.txt" ] && fail "eval-make ($mode) leaves untracked files out" || pass "eval-make ($mode) leaves untracked files out"
  expect "eval-make ($mode) is on HEAD" "$(git -C "$box" rev-parse HEAD 2>/dev/null)" "$(git rev-parse HEAD)"
  printf 'changed\n' >"$box/seed.txt"
  printf 'new\n' >"$box/new.txt"
  run eval-reset "$box" >/dev/null 2>&1
  expect "eval-reset ($mode) restores the seed" "$(cat "$box/seed.txt")|$( [ -e "$box/new.txt" ] && echo new )" "seed|"
  patch=$(printf 'diff --git a/seed.txt b/seed.txt\n--- a/seed.txt\n+++ b/seed.txt\n@@ -1 +1 @@\n-seed\n+solved')
  run eval-apply "$box" "$patch" >/dev/null 2>&1
  expect "eval-apply ($mode) applies a patch" "$(cat "$box/seed.txt")" "solved"
  mkdir -p "$box/.claude/skills/demo" && printf 'x\n' >"$box/.claude/skills/demo/SKILL.md"
  run eval-remove "$box" .claude/skills/demo >/dev/null 2>&1
  [ -e "$box/.claude/skills/demo" ] && fail "eval-remove ($mode) takes a skill folder out" || pass "eval-remove ($mode) takes a skill folder out"
  run eval-remove "$box" ../outside >/dev/null 2>&1
  expect "eval-remove ($mode) refuses a path out of the sandbox" "$?" "3"
  run eval-drop "$mode" "$box" >/dev/null 2>&1
  [ -e "$box" ] && fail "eval-drop ($mode) removes the sandbox" || pass "eval-drop ($mode) removes the sandbox"
done
run eval-drop clone "$repo" >/dev/null 2>&1
expect "eval-drop refuses a folder that is not an eval sandbox" "$?" "3"
[ -d "$repo/.git" ] && pass "and the repository is still there" || fail "and the repository is still there"
expect "no eval worktree is left registered" "$(git worktree list | grep -c devloop-eval)" "0"
rm -f untracked-only.txt

# 24. C2: the schema files are the records module's schemas, byte for byte, and the harness version is plugin.json's.
if node --experimental-strip-types --no-warnings -e '1' >/dev/null 2>&1; then
  got=$(cd "$here" && node --experimental-strip-types --no-warnings -e '
    import("./hooks/records.ts").then(m => {
      const fs = require("fs")
      const ids = Object.keys(m.SCHEMAS)
      const files = fs.readdirSync("schemas").filter(f => f.endsWith(".json")).map(f => f.slice(0, -5)).sort()
      const same = ids.every(id => fs.readFileSync(`schemas/${id}.json`, "utf8") === m.schemaFile(id))
      const version = JSON.parse(fs.readFileSync(".claude-plugin/plugin.json", "utf8")).version
      console.log(`${same}|${JSON.stringify(files) === JSON.stringify([...ids].sort())}|${version === m.HARNESS_VERSION}`)
    })')
  expect "schemas/*.json match hooks/records.ts, and the harness version matches plugin.json" "$got" "true|true|true"
else
  echo "skip the schema files (no node with --experimental-strip-types)"
fi

# 25. The residual-risk register: every id docs/RESIDUAL-RISK.md names is in
#     hooks/residual.ts (which /devloop doctor prints), and the other way round.
docIds=$(grep -oE '^\| R[0-9]+ \||^- \*\*A[0-9]+\.' "$here/docs/RESIDUAL-RISK.md" | grep -oE '[RA][0-9]+' | sort | tr '\n' ' ')
codeIds=$(grep -oE "id: '[RA][0-9]+'" "$here/hooks/residual.ts" | grep -oE '[RA][0-9]+' | sort | tr '\n' ' ')
[ -n "$docIds" ] && expect "hooks/residual.ts names every entry of docs/RESIDUAL-RISK.md" "$codeIds" "$docIds" || fail "docs/RESIDUAL-RISK.md lists ids"

# 25b. The eleventh round, V2: the table of what real bash makes of each one-character `$'…'` escape body, which
#      tests/shell.test.ts compares the decoder with, is what this machine's bash makes of it.
bash "$here/tests/ansi-c-table.sh" >"$work/ansi-c-table.ts" 2>"$work/ansi-c-table.err" && cmp -s "$work/ansi-c-table.ts" "$here/tests/ansi-c-table.ts" && pass "V2: real bash makes of every one-character \$'…' escape body what tests/ansi-c-table.ts says" || fail "V2: tests/ansi-c-table.ts is not what real bash makes of the escape bodies ($(diff "$work/ansi-c-table.ts" "$here/tests/ansi-c-table.ts" | head -5 | tr '\n' ' ')$(head -c 200 "$work/ansi-c-table.err"))"

# 25c. The thirteenth round, BB1: every place that judges a line reads it under both readings. Outside the shell model
#      itself, `parse` is called only by rules.ts's `parseOf`, and every `parseOf` names the reading of a `READINGS` loop.
direct=$(cd "$here" && grep -nE '(^|[^A-Za-z_.])parse\(' hooks/*.ts hooks/*.tsx cli/*.ts | grep -v '^hooks/shell.ts:' | grep -v 'export const parseOf = ' | tr '\n' ' ')
single=$(cd "$here" && grep -nE 'parseOf\(' hooks/*.ts hooks/*.tsx cli/*.ts | grep -v 'export const parseOf = ' | grep -vE 'parseOf\([^()]*(\([^()]*\))?[^()]*, reading\)' | tr '\n' ' ')
expect "BB1: no caller parses a line under one reading alone (direct: $direct; parseOf without a reading of READINGS: $single)" "$direct|$single" "|"
# 25d. The fourteenth round, CC1: each reading's lookups are its own. Outside hooks/glob.ts the expanders run only in the
#      two gatherers (`withGlobs`, `globsFor`), each kind of lookup by its own expander (the reviewed reading's by
#      `2374c49`'s, `expandGlobReviewed`); a reading's matches are found only through `lookupOf` with that reading; and
#      only `globsAnswered` writes the answers, each kind in its own record.
expanders=$(cd "$here" && grep -nE 'expandAll(Now)?\(' hooks/*.ts hooks/*.tsx cli/*.ts | grep -v '^hooks/glob.ts:' | grep -vE "expandAll(Now)?\(patternsOf\(wanted, '(extended|spaced)'\), list\)|expandAll(Now)?\(patternsOf\(wanted, 'reviewed'\), list, expandGlobReviewed\)" | tr '\n' ' ')
reviewed=$(cd "$here" && grep -cE "expandAll(Now)?\(patternsOf\(wanted, 'reviewed'\), list, expandGlobReviewed\)" hooks/state.ts cli/io.ts | tr '\n' ' ')
lookups=$(cd "$here" && grep -nE '(lookupOf|reach)\(' hooks/*.ts hooks/*.tsx cli/*.ts | grep -vE 'function (lookupOf|reach)\(' | grep -vE 'lookupOf\(segments, where, reading\)|reach\([^;]*, lookup\)' | tr '\n' ' ')
answers=$(cd "$here" && grep -nE '(globs|globsExtended|spaced): \{' hooks/*.ts hooks/*.tsx cli/*.ts | grep -v '^hooks/rules.ts:' | tr '\n' ' ')
expect "CC1: each reading's lookups are expanded by its own expander and found by its own reading (expanders: $expanders; gatherers with the reviewed expander: $reviewed; lookups: $lookups; answers written elsewhere: $answers)" "$expanders|$reviewed|$lookups|$answers" "|hooks/state.ts:1 cli/io.ts:1 ||"

# 26. D1: dist/devloop.mjs is the build of its sources, byte for byte.
cd "$here" || exit 1
if ! command -v node >/dev/null 2>&1 || ! command -v bun >/dev/null 2>&1; then
  fail "node and bun are installed (the bundle and the parity table need both)"
else
  bash "$here/scripts/build.sh" "$work/rebuilt.mjs" && cmp -s "$work/rebuilt.mjs" "$here/dist/devloop.mjs" \
    && pass "a rebuild of dist/devloop.mjs is byte-identical to the committed file" \
    || fail "a rebuild of dist/devloop.mjs is byte-identical to the committed file (run bash scripts/build.sh)"
  grep -q "from ['\"]claude-code" "$here/dist/devloop.mjs" && fail "the bundle imports no engine runtime" || pass "the bundle imports no engine runtime"
  [ ! -d "$here/bin" ] && pass "the plugin has no bin/ folder" || fail "the plugin has no bin/ folder"

  cli() { node "$here/dist/devloop.mjs" "$@"; }
  code() { "$@" >/dev/null 2>&1; echo $?; }
  export CLAUDE_PLUGIN_DATA="$work/plugin-data"

  # 27. D1: the command line's exit codes on a throwaway repository with a bare remote.
  d1="$work/d1"
  git init -q --bare "$work/d1-remote.git"
  mkdir -p "$d1" && cd "$d1" || exit 1
  git init -q -b main . && git config commit.gpgsign false
  git remote add origin "$work/d1-remote.git"
  printf '%s\n' '{ "mode": "enforce", "verify": ["test ! -e broken.flag"], "tiers": { "low": ["docs/**"] } }' >devloop.json
  mkdir -p docs src && printf 'one\n' >docs/a.md && printf 'export const a = 1\n' >src/a.ts
  git add -A && git commit -q -m base && git push -q origin main 2>/dev/null
  git checkout -q -b feature
  expect "version exits 0" "$(code cli version)" "0"
  expect "an unknown command is a usage error (2)" "$(code cli frobnicate)" "2"
  expect "check-command without its text is a usage error (2)" "$(code cli check-command)" "2"
  expect "an empty change is green (0)" "$(code cli gate)" "0"
  printf 'two\n' >>docs/a.md
  expect "a low-risk change with its checks passing is green (0)" "$(code cli gate)" "0"
  cli gate --json | grep -q '"isGreen": true' && pass "gate --json says green" || fail "gate --json says green"
  touch broken.flag
  expect "a failing check makes the gate red (1)" "$(code cli gate)" "1"
  cli gate | grep -q '\[ \] Verification: failing: test ! -e broken.flag' && pass "the red row names the failing check" || fail "the red row names the failing check"
  expect "verify fails with it (1)" "$(code cli verify)" "1"
  expect "verify --profile fast fails with it (1)" "$(code cli verify --profile fast)" "1"
  expect "verify --profile other is a usage error (2)" "$(code cli verify --profile other)" "2"
  rm broken.flag
  expect "verify passes again (0)" "$(code cli verify)" "0"
  printf 'aws_secret = "AKIAABCDEFGHIJKLMNOP"\nkey: AKIAQWERTYUIOPASDFGH\n' >docs/creds.md
  expect "a credential in the added lines makes the gate red (1)" "$(code cli gate)" "1"
  cli gate | grep -q '\[ \] No credentials in the diff: docs/creds.md' && pass "the credential row names the file, never the value" || fail "the credential row names the file, never the value"
  cli gate | grep -q 'AKIAABCDEFGHIJKLMNOP' && fail "the value is never printed" || pass "the value is never printed"
  rm docs/creds.md
  printf 'export const a = 2\n' >src/a.ts
  expect "a medium-risk change with no review evidence is red (1)" "$(code cli gate)" "1"
  cli gate | grep -q '\[ \] Independent review: no evidence of a review for this tree' && pass "the review row says no evidence names this tree" || fail "the review row says no evidence names this tree"
  printf 'Read the docs\xe2\x80\x8b first.\n' >CLAUDE.md
  cli gate | grep -q '\[ \] Instruction files changed: CLAUDE.md:1 (invisible characters)' && pass "a hidden character in an instruction file keeps its row unmet" || fail "a hidden character in an instruction file keeps its row unmet"
  expect "doctor --strict fails on the hidden character (1)" "$(code cli doctor --strict)" "1"
  rm CLAUDE.md
  printf '%s\n' '{ "mode": "enforce", "verify": ["test ! -e broken.flag"], "tiers": { "low": ["docs/**"] }, "bogus": 1 }' >devloop.json
  cli gate | grep -q '\[ \] Policy error: devloop.json' && pass "a policy error is its own red row" || fail "a policy error is its own red row"
  cli gate | grep -q '\[x\] Policy changed in this change' && pass "a changed policy is named, and the base's judges" || fail "a changed policy is named, and the base's judges"
  expect "doctor --strict fails on a policy error (1)" "$(code cli doctor --strict)" "1"
  git checkout -q devloop.json
  expect "doctor --strict passes on a clean setup (0)" "$(code cli doctor --strict)" "0"
  cli sandbox | grep -q '"enabled": true' && pass "sandbox prints the block" || fail "sandbox prints the block"
  # Final round, D1 F9: no fallback printed as fact, and a broad domain warned of.
  cli sandbox | grep -q 'warning: the harness.s state directory' && fail "F9: with CLAUDE_PLUGIN_DATA set, no state-directory warning" || pass "F9: with CLAUDE_PLUGIN_DATA set, no state-directory warning"
  (unset CLAUDE_PLUGIN_DATA; cli sandbox) | grep -q 'warning: the harness.s state directory could not be determined here' && pass "F9: without CLAUDE_PLUGIN_DATA the state directory is said to be a fallback" || fail "F9: without CLAUDE_PLUGIN_DATA the state directory is said to be a fallback"
  (unset CLAUDE_PLUGIN_DATA; cli sandbox --json 2>&1 >/dev/null) | grep -q 'could not be determined' && pass "F9: ... in --json too, on standard error" || fail "F9: ... in --json too, on standard error"
  broad="$work/d1-broad"
  mkdir -p "$broad" && (cd "$broad" && git init -q -b main . && printf '%s\n' '{ "network": { "allow": ["*", "github.com"] } }' >devloop.json)
  (cd "$broad" && cli sandbox 2>&1) | grep -q 'warning: the allowed domain \* is broad' && pass "F9: a broad allowed domain is warned of" || fail "F9: a broad allowed domain is warned of"
  (cd "$broad" && cli sandbox 2>&1) | grep -q 'allowed domain github.com' && fail "F9: an exact host is not" || pass "F9: an exact host is not"
  [ ! -e .claude/settings.json ] && pass "sandbox writes nothing" || fail "sandbox writes nothing"
  expect "check-command refuses a production action (1)" "$(code cli check-command 'terraform apply')" "1"
  expect "check-command allows a read (0)" "$(code cli check-command 'git status')" "0"
  expect "check-path refuses a write to the policy (1)" "$(code cli check-path devloop.json --write)" "1"
  expect "check-path allows reading a source file (0)" "$(code cli check-path src/a.ts)" "0"
  cli check-command 'git notes --ref=devloop add -m forged' | grep -q 'refused: evidence-notes' && pass "the agent's git notes write is refused (evidence-notes)" || fail "the agent's git notes write is refused (evidence-notes)"
  cli check-command 'git reset --hard' --json | grep -q '"lift": "person"' && pass "check-command --json gives the lift class" || fail "check-command --json gives the lift class"
  nopol="$work/d1-nopolicy"
  mkdir -p "$nopol" && (cd "$nopol" && git init -q -b main . && expect "gate with no policy on either side is a policy error (2)" "$(code cli gate)" "2")
  outside="$work/d1-outside"
  mkdir -p "$outside" && printf '{}\n' >"$outside/devloop.json" && (cd "$outside" && expect "gate outside git is a policy error (2)" "$(code cli gate)" "2")

  # 28. D1: portable evidence as a git note, written only for the verified tree.
  extract NOTE_WRITE "$work/note-write.sh" 'notes --ref=devloop add' hooks/portable.ts
  extract NOTE_READ "$work/note-read.sh" 'notes --ref=devloop show' hooks/portable.ts
  git add -A && git commit -q -m change
  tree=$(git rev-parse 'HEAD^{tree}')
  # Final round (D1 F7): a note counts only under the policy in force, by its hash.
  hashOf() { (cd "$here" && bun -e "import { parseConfig } from './hooks/config'; import { policyHash } from './hooks/portable'; process.stdout.write(policyHash(parseConfig(process.argv[1]).cfg))" "$1"); }
  d1hash=$(hashOf "$(git show HEAD:devloop.json)")
  note="{\"schema\":\"evidence@2\",\"at\":1,\"why\":\"review\",\"tree\":\"$tree\",\"head\":\"$(git rev-parse HEAD)\",\"policy\":\"$d1hash\",\"checks\":[],\"reviewers\":[{\"name\":\"general\",\"mode\":\"general\",\"verdict\":\"pass\",\"round\":1}],\"open\":0,\"checklistFails\":[],\"harness\":\"0.2.0\"}"
  expect "a note for another tree is not written (exit 4)" "$(code run note-write 0000000000000000000000000000000000000000 "$note")" "4"
  expect "nothing was written for it" "$(code run note-read HEAD)" "3"
  expect "a note for HEAD's tree is written" "$(code run note-write "$tree" "$note")" "0"
  run note-read HEAD | grep -q '"evidence@2"' && pass "the note reads back" || fail "the note reads back"
  expect "the note moved no tree" "$(git rev-parse 'HEAD^{tree}')" "$tree"
  expect "with evidence naming this tree, the medium-risk change is green (0)" "$(code cli gate)" "0"
  cli gate | grep -q '\[x\] Independent review: passed in round 1 (a git note on' && pass "the review row cites the note" || fail "the review row cites the note"
  printf 'export const a = 3\n' >src/a.ts
  expect "a note for another tree is ignored: red again (1)" "$(code cli gate)" "1"
  cli gate | grep -q 'the evidence names tree' && pass "the row says the evidence names another tree" || fail "the row says the evidence names another tree"
  git checkout -q src/a.ts

  # 29. D1: the opt-in pre-push hook chains an existing one, refuses a red gate and allows a green one.
  extract HOOK_INSTALL "$work/hook-install.sh" 'devloop-chained' hooks/githook.ts
  extract HOOK_REMOVE "$work/hook-remove.sh" 'devloop-chained' hooks/githook.ts
  hooktext=$(cd "$here" && bun -e "import { prePushHook } from './hooks/githook'; process.stdout.write(prePushHook(process.argv[1]))" "$here/dist/devloop.mjs")
  printf '#!/bin/sh\necho chained-ran >>"%s"\ncat >/dev/null\n' "$work/chained.log" >.git/hooks/pre-push && chmod +x .git/hooks/pre-push
  run hook-install "$hooktext" | grep -q '^installed-chained:' && pass "install chains the pre-push hook already there" || fail "install chains the pre-push hook already there"
  [ -x .git/hooks/pre-push.devloop-chained ] && pass "the old hook is kept beside it" || fail "the old hook is kept beside it"
  run hook-install "$hooktext" | grep -q '^already:' && pass "a second install changes nothing" || fail "a second install changes nothing"
  git push -q origin feature 2>/dev/null && pass "a green gate lets the push through" || fail "a green gate lets the push through"
  grep -q chained-ran "$work/chained.log" 2>/dev/null && pass "the chained hook ran first" || fail "the chained hook ran first"
  touch broken.flag && git add broken.flag && git commit -q -m red
  git push -q origin feature 2>/dev/null && fail "a red gate refuses the push" || pass "a red gate refuses the push"
  expect "the remote did not get the red commit" "$(git ls-remote "$work/d1-remote.git" refs/heads/feature | cut -f1)" "$(git rev-parse HEAD~1)"
  run hook-remove | grep -q '^removed-restored:' && pass "remove puts the chained hook back" || fail "remove puts the chained hook back"
  grep -q chained-ran .git/hooks/pre-push && [ ! -e .git/hooks/pre-push.devloop-chained ] && pass "exactly as it was" || fail "exactly as it was"
  git reset -q --hard HEAD~1

  # 30. D1: the classic hook entry: stamp, heartbeat, absence, no policy.
  data="$work/plugin-data"
  hookin() { printf '{"session_id":"%s","tool_use_id":"%s","cwd":"%s","hook_event_name":"PreToolUse","tool_name":"Bash","tool_input":{"command":"%s"}}' "$1" "$2" "$d1" "$3"; }
  mkdir -p "$data/stamps/calls" && touch "$data/stamps/calls/toolu_stamped"
  expect "a stamped call: the classic hook is silent" "$(hookin s-live toolu_stamped 'curl https://evil.example.org' | cli hook PreToolUse)" ""
  [ ! -e "$data/stamps/calls/toolu_stamped" ] && pass "and it removes the stamp it read" || fail "and it removes the stamp it read"
  mkdir -p "$data/stamps/live" && touch "$data/stamps/live/s-live"
  said=$(hookin s-live toolu_unstamped 'terraform apply' | cli hook PreToolUse)
  echo "$said" | grep -q '"permissionDecision":"deny".*\[production\]' && pass "heartbeat without a stamp: the stateless core refuses" || fail "heartbeat without a stamp: the stateless core refuses ($said)"
  said=$(hookin s-live toolu_ship 'git push origin feature' | cli hook PreToolUse)
  echo "$said" | grep -q 'could not judge this call' && pass "heartbeat without a stamp: a ship is refused outright" || fail "heartbeat without a stamp: a ship is refused outright ($said)"
  inbox=$(cat "$data"/repos/*/classic-inbox.jsonl 2>/dev/null)
  echo "$inbox" | grep -q '"kind":"module-skipped".*git push' && pass "the skip is recorded (module-skipped)" || fail "the skip is recorded (module-skipped)"
  said=$(hookin s-absent toolu_a1 'ls' | cli hook PreToolUse)
  echo "$said" | grep -q 'not loaded in this session' && pass "no heartbeat: the one-time notice says what holds" || fail "no heartbeat: the one-time notice says what holds"
  said=$(hookin s-absent toolu_a2 'ls' | cli hook PreToolUse)
  expect "the notice is given once" "$said" ""
  said=$(hookin s-absent toolu_a3 'terraform apply' | cli hook PreToolUse)
  echo "$said" | grep -q '\[production\]' && pass "no heartbeat: the classic hook is the enforcement" || fail "no heartbeat: the classic hook is the enforcement"
  said=$(hookin s-absent toolu_a4 'git push origin feature' | cli hook PreToolUse)
  expect "no heartbeat: a ship whose tree the evidence names, with its checks passing, goes through" "$said" ""
  # Committed first (final round, D1 F4: a push of uncommitted work is refused before the gate is proven).
  printf 'export const a = 4\n' >src/a.ts && git commit -q -am four
  said=$(hookin s-absent toolu_a5 'git push origin feature' | cli hook PreToolUse)
  echo "$said" | grep -q '\[gate\] The gate is not green.*Independent review' && pass "no heartbeat: a medium-risk ship with no review evidence for its tree is refused" || fail "no heartbeat: a medium-risk ship with no review evidence for its tree is refused ($said)"
  git reset -q --hard HEAD~1
  said=$(printf '{"session_id":"s-absent","tool_use_id":"toolu_a5","cwd":"%s","tool_name":"Edit","tool_input":{"file_path":"%s/devloop.json","old_string":"a","new_string":"b"}}' "$d1" "$d1" | cli hook PreToolUse)
  echo "$said" | grep -q '\[protected\]' && pass "no heartbeat: the policy file is protected" || fail "no heartbeat: the policy file is protected"
  said=$(printf '{"session_id":"s-absent","tool_use_id":"toolu_a6","cwd":"%s","tool_name":"Read","tool_input":{"file_path":"%s/src/a.ts"}}' "$d1" "$d1" | cli hook PreToolUse)
  expect "a read of a source file is allowed silently" "$said" ""
  said=$(printf '{"session_id":"s-absent","tool_use_id":"toolu_n1","cwd":"%s","tool_name":"Bash","tool_input":{"command":"git reset --hard"}}' "$nopol" | cli hook PreToolUse)
  expect "no policy on either side: the classic hook is a silent no-op" "$said" ""
  # (The cache-guard round, R7: `rm -rf /` removes the home folder's ~/.claude/cache-guard, a secret pattern's folder, so it is refused even here.)
  said=$(printf '{"session_id":"s-absent","tool_use_id":"toolu_n2","cwd":"%s","tool_name":"Bash","tool_input":{"command":"rm -rf /"}}' "$nopol" | cli hook PreToolUse)
  echo "$said" | grep -q '"permissionDecision":"deny".*\[secret\] / holds .*/.claude/cache-guard' && pass "R7: with no policy, rm -rf / is refused as a secret folder's removal" || fail "R7: with no policy, rm -rf / is refused as a secret folder's removal ($said)"
  touch broken.flag
  said=$(printf '{"session_id":"s-absent","prompt_id":"p1","cwd":"%s","hook_event_name":"Stop","stop_hook_active":false}' "$d1" | cli hook Stop)
  echo "$said" | grep -q '"decision":"block".*fix round 1 of 2' && pass "no heartbeat: the classic stop gate blocks a failing check" || fail "no heartbeat: the classic stop gate blocks a failing check ($said)"
  said=$(printf '{"session_id":"s-absent","prompt_id":"p1","cwd":"%s","hook_event_name":"Stop","stop_hook_active":true}' "$d1" | cli hook Stop)
  echo "$said" | grep -q 'nothing changed since the last blocked stop' && pass "a stop on the tree it blocked ends the fix loop" || fail "a stop on the tree it blocked ends the fix loop ($said)"
  rm broken.flag
  mkdir -p "$data/stamps/stops"
  stopin='{"session_id":"s-live","prompt_id":"p2","cwd":"'"$d1"'","hook_event_name":"Stop","stop_hook_active":false,"last_assistant_message":"done"}'
  key=$(cd "$here" && bun -e "import { stopKey } from './hooks/enforce'; process.stdout.write(stopKey(JSON.parse(process.argv[1])))" "$stopin")
  printf '%s' "$key" >"$data/stamps/stops/s-live"
  touch broken.flag
  expect "a stamped stop: the classic stop gate is silent" "$(printf '%s' "$stopin" | cli hook Stop)" ""
  rm broken.flag

  # 30b. Final round, D1 F1: the classic hook reads its input to the end. A
  #      late writer and a 300 KB payload, from a shell pipe and from a
  #      spawning Node parent, get the refusal a ready input gets; truncated
  #      or empty input is refused as unreadable (PreToolUse), and never
  #      blocks a stop (Stop) but tells the person.
  pad=$(head -c 300000 /dev/zero | tr '\0' x)
  f1in() { printf '{"session_id":"s-f1","tool_use_id":"%s","cwd":"%s","hook_event_name":"PreToolUse","tool_name":"Bash","tool_input":{"command":"terraform apply","description":"%s"}}' "$1" "$d1" "$2"; }
  denied() { echo "$1" | grep -q '"permissionDecision":"deny".*\[production\]'; }
  said=$(f1in toolu_f1a '' | cli hook PreToolUse)
  denied "$said" && pass "F1: a ready input is refused (the baseline)" || fail "F1: a ready input is refused ($said)"
  said=$( (sleep 1; f1in toolu_f1b '') | cli hook PreToolUse)
  denied "$said" && pass "F1: a late writer on a shell pipe gets the same refusal" || fail "F1: a late writer on a shell pipe gets the same refusal ($said)"
  said=$(f1in toolu_f1c "$pad" | cli hook PreToolUse)
  denied "$said" && pass "F1: a 300 KB payload from a shell pipe gets the same refusal" || fail "F1: a 300 KB payload from a shell pipe gets the same refusal ($(echo "$said" | head -c 200))"
  cat >"$work/spawn-hook.mjs" <<'EOF'
import { spawn } from 'node:child_process'
const [bundle, delay, size, cwd] = process.argv.slice(2)
const input = JSON.stringify({ session_id: 's-f1', tool_use_id: `toolu_f1n${delay}${size}`, cwd, hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'terraform apply', description: 'x'.repeat(Number(size)) } })
const child = spawn('node', [bundle, 'hook', 'PreToolUse'], { stdio: ['pipe', 'pipe', 'ignore'] })
let out = ''
child.stdout.on('data', chunk => { out += chunk })
child.stdin.on('error', () => undefined)
child.on('close', () => process.stdout.write(out))
const send = () => child.stdin.end(input)
if (Number(delay) > 0) setTimeout(send, Number(delay)); else send()
EOF
  said=$(node "$work/spawn-hook.mjs" "$here/dist/devloop.mjs" 800 0 "$d1")
  denied "$said" && pass "F1: a late writer from a spawning Node parent gets the same refusal" || fail "F1: a late writer from a spawning Node parent gets the same refusal ($said)"
  said=$(node "$work/spawn-hook.mjs" "$here/dist/devloop.mjs" 0 300000 "$d1")
  denied "$said" && pass "F1: a 300 KB payload from a spawning Node parent gets the same refusal" || fail "F1: a 300 KB payload from a spawning Node parent gets the same refusal ($(echo "$said" | head -c 200))"
  said=$(f1in toolu_f1d '' | head -c 70 | cli hook PreToolUse)
  echo "$said" | grep -q '"permissionDecision":"deny".*could not read' && pass "F1: truncated JSON is refused as unreadable" || fail "F1: truncated JSON is refused as unreadable ($said)"
  said=$(printf '' | cli hook PreToolUse)
  echo "$said" | grep -q '"permissionDecision":"deny".*could not read' && pass "F1: empty input is refused as unreadable" || fail "F1: empty input is refused as unreadable ($said)"
  said=$(cd "$d1" && printf '{"session_id":' | cli hook Stop)
  echo "$said" | grep -q '"decision":"block"' && fail "F1: an unreadable stop is never blocked" || pass "F1: an unreadable stop is never blocked"
  echo "$said" | grep -q '"systemMessage":"devloop.*could not read' && pass "F1: and the person is told verification did not run" || fail "F1: and the person is told verification did not run ($said)"

  # 31. D1: parity across the three enforcement points. D2: with the .tasks
  #     integration on (a version 2 tree, a `tasks` stand-in on the PATH), and
  #     a second repository with no policy at all, where only secrets hold.
  par="$work/parity"
  dormant="$work/parity-dormant"
  (cd "$here" && bun tests/parity.ts --setup "$par" "$dormant" "$work/d1-remote.git") || fail "the parity repositories are made from the table"
  mkdir -p "$work/fakebin" && printf '#!/bin/sh\nexit 0\n' >"$work/fakebin/tasks" && chmod +x "$work/fakebin/tasks"
  (cd "$here" && PATH="$work/fakebin:$PATH" bun tests/parity.ts "$par" "$here/dist/devloop.mjs" "$work/parity-data" "$dormant") >"$work/parity.out"; parity=$?
  cat "$work/parity.out"
  grep -q '^parity (opted in): .* 0 disagreements$' "$work/parity.out" && pass "parity run 1 (opted in): the command line and the classic hook agree with the table on every row" || fail "parity run 1 (opted in): the command line and the classic hook agree with the table on every row"
  grep -q '^parity (dormant): .* 0 disagreements$' "$work/parity.out" && pass "parity run 2 (dormant): the command line and the classic hook agree with the table on every row" || fail "parity run 2 (dormant): the command line and the classic hook agree with the table on every row"
  grep -q '^w2 sample: .* 0 disagreements$' "$work/parity.out" && pass "W2, BB6 (the twelfth and thirteenth rounds): no line of the sample the ninth round's reviewed bundle refused is allowed, and each gets its recorded verdict" || fail "W2, BB6 (the twelfth and thirteenth rounds): no line of the sample the ninth round's reviewed bundle refused is allowed, and each gets its recorded verdict"
  [ "$parity" -eq 0 ] || fail "the parity runner exits 0"
  # 31b. The fourteenth round, CC2: the comparison corpus. About 2,000 lines, each with the verdict the reviewed build's
  #      bundle gave it in the world tests/corpus-world.sh builds (links into the secrets folder, a folder with a space,
  #      70 sibling folders, the git hook), judged by the built bundle in-process: none it refused may be allowed now.
  (cd "$here" && bun tests/corpus.ts "$here/dist/devloop.mjs" "$work/corpus") >"$work/corpus.out" 2>&1; corpus=$?
  grep '^FAIL' "$work/corpus.out" | head -20
  tail -1 "$work/corpus.out"
  [ "$corpus" -eq 0 ] && grep -q '^corpus: [0-9]* lines, [0-9]* refused by the reviewed bundle, 0 of them allowed now, 0 unread$' "$work/corpus.out" && pass "CC2: no line of the corpus the reviewed bundle refused is allowed now" || fail "CC2: no line of the corpus the reviewed bundle refused is allowed now ($(tail -1 "$work/corpus.out"))"
  mkdir -p "$work/fakebin-check" && printf '#!/bin/sh\n[ "$1" = session-check ] || exit 0\necho %s\nexit 4\n' "'{\"violations\":[{\"task\":\"web/login\",\"reason\":\"IN_PROGRESS without state.md\"}]}'" >"$work/fakebin-check/tasks" && chmod +x "$work/fakebin-check/tasks"
  stopin='{"session_id":"s-tasks","prompt_id":"p9","cwd":"'"$par"'","hook_event_name":"Stop","stop_hook_active":false}'
  said=$(printf '%s' "$stopin" | PATH="$work/fakebin-check:$PATH" cli hook Stop)
  echo "$said" | grep -q '"decision":"block".*session check fails.*web/login: IN_PROGRESS without state.md' && pass "the classic stop gate runs the .tasks session check and blocks on a failure (D2)" || fail "the classic stop gate runs the .tasks session check ($said)"
  said=$(printf '%s' "$stopin" | PATH="$work/fakebin-check:$PATH" cli hook Stop)
  echo "$said" | grep -q '"decision":"block"' && fail "it blocks once per prompt, then tells the person" || pass "it blocks once per prompt, then tells the person"
  said=$(printf '{"session_id":"s-dormant","tool_use_id":"toolu_d1","cwd":"%s","tool_name":"Bash","tool_input":{"command":"cat .env"}}' "$dormant" | cli hook PreToolUse)
  echo "$said" | grep -q '"permissionDecision":"deny".*\[secret\]' && pass "no policy on either side: the classic hook still refuses a secret, by the default globs (D2)" || fail "no policy on either side: the classic hook still refuses a secret ($said)"
  unset CLAUDE_PLUGIN_DATA

  # 32. D2: the review carry-over, by git's own diff of the two trees.
  carry="$work/carry"
  mkdir -p "$carry/src" "$carry/.tasks/web/login" && cd "$carry" || exit 1
  git init -q -b main . && git config commit.gpgsign false
  printf 'export const a = 1\n' >src/a.ts && printf 'version: 2\n' >.tasks/config.yml && printf 'Next: the form.\n' >.tasks/web/login/state.md
  git add -A && git commit -q -m base && git checkout -q -b feature
  reviewed=$(field tree)
  only() { (cd "$here" && bun -e "import { isTaskStateOnly } from './hooks/tasks'; import { readCarryDiff } from './hooks/scripts'; process.stdout.write(String(isTaskStateOnly(readCarryDiff(process.argv[1]))))" "$1"); }
  printf 'Next: the error state.\n' >.tasks/web/login/state.md && printf -- '---\nstatus: IN_PROGRESS\n---\n# Login\n' >.tasks/web/login/task.md
  moved=$(field tree)
  differ "a task-state edit moves the hash (nothing is left out of it)" "$moved" "$reviewed"
  expect "the diff of the two trees names only task state" "$(run carry-diff "$reviewed" "$moved" | cut -f2 | sort | tr '\n' ' ')" ".tasks/web/login/state.md .tasks/web/login/task.md "
  expect "so the verdict carries over" "$(only "$(run carry-diff "$reviewed" "$moved")")" "true"
  printf '#!/bin/sh\n' >.tasks/web/login/run.sh
  expect "a file under .tasks/ that is not .md, .yml or .yaml stops the carry-over" "$(only "$(run carry-diff "$reviewed" "$(field tree)")")" "false"
  rm .tasks/web/login/run.sh && printf 'export const a = 2\n' >src/a.ts
  expect "any change outside .tasks/ needs a new round" "$(only "$(run carry-diff "$reviewed" "$(field tree)")")" "false"
  git checkout -q src/a.ts
  expect "back to task state only: it carries again" "$(only "$(run carry-diff "$reviewed" "$(field tree)")")" "true"
  # Final round, D2 F12 and F9: a rename, a link, a mode and a submodule.
  git mv -k .tasks/web/login/state.md .tasks/web/login/resume.md 2>/dev/null || mv .tasks/web/login/state.md .tasks/web/login/resume.md
  expect "a rename within task state carries (both paths are task state)" "$(only "$(run carry-diff "$reviewed" "$(field tree)")")" "true"
  mv .tasks/web/login/resume.md .tasks/web/login/state.md
  git mv -k src/a.ts .tasks/web/a.md 2>/dev/null
  expect "a rename of code into .tasks/ does not carry (the old path is listed)" "$(only "$(run carry-diff "$reviewed" "$(field tree)")")" "false"
  git mv -k .tasks/web/a.md src/a.ts 2>/dev/null
  ln -s ../../../src/a.ts .tasks/web/login/code.md
  expect "a link under .tasks/ named like task state does not carry" "$(only "$(run carry-diff "$reviewed" "$(field tree)")")" "false"
  rm .tasks/web/login/code.md
  chmod +x .tasks/web/login/state.md
  expect "an executable bit on a task file does not carry" "$(only "$(run carry-diff "$reviewed" "$(field tree)")")" "false"
  chmod -x .tasks/web/login/state.md
  expect "and back to task state only, it carries" "$(only "$(run carry-diff "$reviewed" "$(field tree)")")" "true"
  mkdir -p lib && (cd lib && git init -q -b main . && git config commit.gpgsign false && printf '1\n' >x && git add x && git commit -q -m one)
  git add lib 2>/dev/null && git commit -q -m 'a submodule' 2>/dev/null
  subBase=$(field tree)
  (cd lib && printf '2\n' >x && git commit -q -am two)
  printf 'Next: after the bump.\n' >.tasks/web/login/state.md
  git config diff.ignoreSubmodules all
  printf '[submodule "lib"]\n\tpath = lib\n\tignore = all\n' >.gitmodules && git add .gitmodules && git commit -q -m gitmodules
  subBase=$(field tree)
  (cd lib && printf '3\n' >x && git commit -q -am three)
  printf 'Next: after the second bump.\n' >.tasks/web/login/state.md
  expect "a submodule's change is never hidden from the carry diff, whatever git's settings say" "$(only "$(run carry-diff "$subBase" "$(field tree)")")" "false"
  run carry-diff "$subBase" "$(field tree)" | grep -q 'lib$' && pass "the submodule is listed" || fail "the submodule is listed"
  git config --unset diff.ignoreSubmodules

  # 33. D2: every worktree of a repository finds the same main root (claims are kept under it).
  git worktree add -q "$work/carry-wt" -b other 2>/dev/null
  expect "a linked worktree's main root is the main checkout" "$(cd "$work/carry-wt" && run main-root)" "$(cd "$carry" && pwd -P)"
  expect "the main checkout's own" "$(run main-root)" "$(pwd -P)"

  # 34. D2: the worked checklist loads as checklist@1, 10 to 14 items, each verified some way with a concrete how.
  got=$(cd "$here" && bun -e "
    import { readFileSync } from 'node:fs'
    import { parseChecklist } from './hooks/checklist'
    const parsed = parseChecklist(readFileSync('docs/examples/checklists/login-form.json', 'utf8'), 'checklists/login-form.json')
    const items = parsed.list?.items ?? []
    const ways = [...new Set(items.map(one => one.verify.by))].sort().join(',')
    process.stdout.write([parsed.problems.length, items.length >= 10 && items.length <= 14, items.every(one => one.verify.how.length >= 40), ways].join('|'))")
  expect "docs/examples/checklists/login-form.json loads, with 10 to 14 items, each with a concrete how, every route used" "$got" "0|true|true|check,pattern,person,review,runtime"
  cd "$here" || exit 1

  # 35. Final round, D1 F4, F6, F10: what a push sends is what the gate
  #     judged, at the classic hook, the command line and the pre-push hook;
  #     the evidence note is keyed on the committable tree; the pre-push hook
  #     passes a repository with no policy and is not installed outside it.
  export CLAUDE_PLUGIN_DATA="$work/plugin-data-final"
  fr="$work/final"
  git init -q --bare "$work/final-remote.git"
  mkdir -p "$fr" && cd "$fr" || exit 1
  git init -q -b main . && git config commit.gpgsign false
  git remote add origin "$work/final-remote.git"
  printf '%s\n' '{ "mode": "enforce", "verify": ["test ! -e broken.flag"], "tiers": { "low": ["docs/**"] } }' >devloop.json
  mkdir -p docs src && printf 'one\n' >docs/a.md && printf 'export const a = 1\n' >src/a.ts
  git add -A && git commit -q -m base && git push -q origin main 2>/dev/null
  git checkout -q -b feature
  printf 'two\n' >>docs/a.md && git commit -q -am low
  pushin() { printf '{"session_id":"s-final","tool_use_id":"%s","cwd":"%s","hook_event_name":"PreToolUse","tool_name":"Bash","tool_input":{"command":"%s"}}' "$1" "$fr" "$2"; }
  pushin toolu_fr0 'ls' | cli hook PreToolUse >/dev/null
  expect "F4: a push of a clean, green, committed tree is not refused (classic hook)" "$(pushin toolu_fr1 'git push -u origin feature' | cli hook PreToolUse)" ""
  touch broken.flag && git add broken.flag && git commit -q -m red && rm broken.flag
  said=$(pushin toolu_fr2 'git push -u origin feature' | cli hook PreToolUse)
  echo "$said" | grep -q '"permissionDecision":"deny".*\[gate\] Commit or stash first' && pass "F4: a failing commit with an uncommitted restore is refused by the classic hook" || fail "F4: a failing commit with an uncommitted restore is refused by the classic hook ($said)"
  expect "F4: the command line's gate is green for the working tree alone" "$(code cli gate)" "0"
  expect "F4: ... and red told what the push sends (--pushing HEAD)" "$(code cli gate --pushing HEAD)" "1"
  cli gate --pushing HEAD | grep -q '\[ \] What the push sends: Commit or stash first' && pass "F4: the row says to commit or stash first" || fail "F4: the row says to commit or stash first"
  hooktext=$(cd "$here" && bun -e "import { prePushHook } from './hooks/githook'; process.stdout.write(prePushHook(process.argv[1]))" "$here/dist/devloop.mjs")
  extract HOOK_WHERE "$work/hook-where.sh" 'git-path hooks' hooks/githook.ts
  run hook-install "$hooktext" | grep -q '^installed:' && pass "F4: the pre-push hook installs" || fail "F4: the pre-push hook installs"
  git push -q origin feature 2>/dev/null && fail "F4: the pre-push hook refuses the push of the failing commit" || pass "F4: the pre-push hook refuses the push of the failing commit"
  expect "F4: the remote did not get it" "$(git ls-remote "$work/final-remote.git" refs/heads/feature | cut -f1)" ""
  git reset -q --hard HEAD~1
  expect "F4: with the red commit dropped (the tree is what is committed), the push goes" "$(git push -q origin feature 2>/dev/null; echo $?)" "0"
  git checkout -q -b other && printf 'three\n' >>docs/a.md && git commit -q -am other-work && git checkout -q feature
  git push -q origin other 2>/dev/null && fail "F4: a push of another branch, whose commit is not the tree judged, is refused by the pre-push hook" || pass "F4: a push of another branch, whose commit is not the tree judged, is refused by the pre-push hook"
  printf 'scratch.log\nCLAUDE.md\n' >>.git/info/exclude && printf 'x\n' >scratch.log && printf 'Be brief.\n' >CLAUDE.md
  expect "F4: a push with only git-ignored files present is not refused (classic hook)" "$(pushin toolu_fr3 'git push -u origin feature' | cli hook PreToolUse)" ""
  expect "F4: ... nor by the command line told what it sends" "$(code cli gate --pushing HEAD)" "0"
  # F10: with the ignored instruction file present, a note keyed on the committable tree is written and counts.
  printf 'export const a = 2\n' >src/a.ts && git commit -q -am medium
  ctree=$(git rev-parse 'HEAD^{tree}')
  phash=$(hashOf "$(cat devloop.json)")
  fnote="{\"schema\":\"evidence@2\",\"at\":1,\"why\":\"review\",\"tree\":\"$ctree\",\"full\":\"$(field tree)\",\"head\":\"$(git rev-parse HEAD)\",\"policy\":\"$phash\",\"checks\":[],\"reviewers\":[{\"name\":\"general\",\"mode\":\"general\",\"verdict\":\"pass\",\"round\":1}],\"open\":0,\"checklistFails\":[],\"harness\":\"0.2.0\"}"
  differ "F10: the full tree differs from the committable tree here" "$(field tree)" "$ctree"
  expect "F10: a note keyed on the committable tree is written for HEAD" "$(code run note-write "$ctree" "$fnote")" "0"
  expect "F10: and the command line's gate counts it (green)" "$(code cli gate)" "0"
  fother=$(printf '%s' "$fnote" | sed "s/$phash/0000000000000000/")
  run note-write "$ctree" "$fother" >/dev/null 2>&1
  cli gate | grep -q '\[ \] Independent review: the evidence for this tree was produced under another policy' && pass "F7: a note produced under another policy does not count, and the row says so" || fail "F7: a note produced under another policy does not count, and the row says so"
  rm -f scratch.log CLAUDE.md
  # The last review's F2: a file git is told not to look at (skip-worktree or
  # assume-unchanged) hides its edit from both trees; the snapshot reports it,
  # the gate row is unmet and every point refuses the push, naming it.
  git update-index --skip-worktree docs/a.md && printf 'hidden edit\n' >>docs/a.md
  expect "F2: the hidden edit is in neither tree (why the bit matters)" "$(field committable)" "$(git rev-parse 'HEAD^{tree}')"
  expect "F2: the snapshot reports the hidden entry" "$(field hidden)" "docs/a.md"
  cli gate | grep -q '\[ \] Files hidden from git: docs/a.md' && pass "F2: the command line's gate row is unmet, naming it" || fail "F2: the command line's gate row is unmet, naming it"
  said=$(pushin toolu_fr5 'git push -u origin feature' | cli hook PreToolUse)
  echo "$said" | grep -q '"permissionDecision":"deny".*Files hidden from git.*docs/a.md' && pass "F2: the classic hook refuses the push, naming it" || fail "F2: the classic hook refuses the push, naming it ($said)"
  git push -q origin feature 2>/dev/null && fail "F2: the pre-push hook refuses the push" || pass "F2: the pre-push hook refuses the push"
  # The cache-guard round, L2: an entry with a bit hides something only when the file on disk differs from it, by content hash.
  git show HEAD:docs/a.md >docs/a.md
  expect "L2: the skip-worktree file restored to the index's content hides nothing" "$(field hidden)" ""
  said=$(pushin toolu_frl2 'git push -u origin feature' | cli hook PreToolUse)
  echo "$said" | grep -q 'Files hidden from git' && fail "L2: ... so its push is not refused as hidden ($said)" || pass "L2: ... so its push is not refused as hidden (the review row still decides here)"
  git update-index --no-skip-worktree docs/a.md && git checkout -q docs/a.md && git update-index --assume-unchanged docs/a.md
  expect "L2: assume-unchanged on an unchanged file hides nothing" "$(field hidden)" ""
  printf 'hidden edit\n' >>docs/a.md
  expect "F2: assume-unchanged on an edited file is reported too" "$(field hidden)" "docs/a.md"
  git checkout -q docs/a.md 2>/dev/null; git show HEAD:docs/a.md >docs/a.md
  chmod +x docs/a.md
  expect "L2: an executable bit hidden by the bit is reported (the mode differs from the index entry's)" "$(field hidden)" "docs/a.md"
  chmod -x docs/a.md
  git update-index --no-assume-unchanged docs/a.md
  expect "F2: with the bits cleared, nothing is hidden" "$(field hidden)" ""
  # F9: the refusal names the files that differ, the untracked ones marked, and the remedies.
  printf 'x\n' >untracked-one.txt && printf 'more\n' >>docs/a.md
  said=$(pushin toolu_fr6 'git push -u origin feature' | cli hook PreToolUse)
  echo "$said" | grep -q 'docs/a.md, untracked-one.txt (untracked).*git stash -u' && pass "F9: the refusal names the files, marks the untracked one and says git stash -u" || fail "F9: the refusal names the files ($said)"
  rm -f untracked-one.txt && git checkout -q docs/a.md
  # F6: a repository with no policy on either side: the installed hook passes its push.
  np="$work/final-nopolicy"
  git init -q --bare "$work/final-nopolicy.git"
  mkdir -p "$np" && cd "$np" && git init -q -b main . && git config commit.gpgsign false && git remote add origin "$work/final-nopolicy.git"
  printf 'x\n' >a.txt && git add -A && git commit -q -m base
  run hook-install "$hooktext" >/dev/null
  expect "F6: the installed hook passes a repository with no policy" "$(git push -q origin main 2>/dev/null; echo $?)" "0"
  # F6: a hooks path outside the repository is told apart from one inside it.
  where() { (cd "$here" && bun -e "import { hooksPlace } from './hooks/githook'; process.stdout.write(hooksPlace(process.argv[1])?.kind ?? 'none')" "$1"); }
  expect "F6: git's own hooks folder" "$(where "$(run hook-where)")" "git"
  git config core.hooksPath "$work/shared-hooks"
  expect "F6: core.hooksPath outside the repository" "$(where "$(run hook-where)")" "outside"
  git config core.hooksPath .githooks
  expect "F6: core.hooksPath inside the tracked tree" "$(where "$(run hook-where)")" "tree"
  git config --unset core.hooksPath
  # D1 F5, and the cache-guard round's R4 (P-D): the classic hook's checks on
  # a ship get a time budget; past it the ship is refused, saying which checks
  # finished and which did not. Nothing is kept: a retry runs every check
  # again, and nothing the hook or the command line wrote earlier is trusted.
  # A throw inside the hook refuses.
  slow="$work/final-slow"
  mkdir -p "$slow" && cd "$slow" && git init -q -b main . && git config commit.gpgsign false
  printf '%s\n' '{ "mode": "enforce", "verify": ["sleep 2", "sleep 1"] }' >devloop.json && printf 'x\n' >a.txt && git add -A && git commit -q -m base && git checkout -q -b feature && printf 'y\n' >>a.txt
  budget() { (cd "$here" && bun -e "
    import { proveGate } from './cli/gate'
    import { findRoot } from './cli/io'
    const started = Date.now()
    const proven = proveGate(findRoot(process.argv[1]), { until: Date.now() + Number(process.argv[2]), now: () => Date.now() })
    process.stdout.write(('code' in proven ? (proven.json?.error ?? 'said') : 'proven') + ' ' + (Date.now() - started < 1900 ? 'quick' : 'slow') + ('code' in proven ? ' | ' + proven.text : ''))" "$slow" "$1"); }
  first=$(budget 2500)
  expect "F5: past the budget the checks stop and nothing is proven" "${first%% |*}" "out-of-time slow"
  echo "$first" | grep -q 'finished: sleep 2 (passed); not finished: sleep 1' && pass "R4: the refusal says which checks finished and which did not" || fail "R4: the refusal says which checks finished and which did not ($first)"
  again=$(budget 2500)
  expect "R4: the retry runs every check again: nothing was kept" "${again%% |*}" "out-of-time slow"
  [ -z "$(find "$CLAUDE_PLUGIN_DATA" -name classic-passes.json 2>/dev/null)" ] && pass "R4: no kept-pass file is written anywhere" || fail "R4: no kept-pass file is written anywhere"
  reason=$(cd "$here" && bun -e "import { outOfTimeReason } from './cli/hook'; process.stdout.write(outOfTimeReason('finished: a (passed); not finished: b'))")
  echo "$reason" | grep -q 'Nothing is kept between runs.*hooks module loaded.*node dist/devloop.mjs gate.*a person to push' && pass "R4: the hook's out-of-time refusal names the ways forward" || fail "R4: the hook's out-of-time refusal names the ways forward ($reason)"
  # F1, carried: a pass produced under a doctored PATH by the command line does not let the hook skip the check.
  doc="$work/final-doctored"
  mkdir -p "$doc" "$work/doctored-bin" && cd "$doc" && git init -q -b main . && git config commit.gpgsign false
  printf '#!/bin/sh\nexit 0\n' >"$work/doctored-bin/devloop-smoke-probe" && chmod +x "$work/doctored-bin/devloop-smoke-probe"
  printf '%s\n' '{ "mode": "enforce", "verify": ["devloop-smoke-probe"], "tiers": { "low": ["docs/**"] } }' >devloop.json && mkdir -p docs && printf 'one\n' >docs/a.md
  git add -A && git commit -q -m base && git checkout -q -b feature && printf 'two\n' >>docs/a.md && git commit -q -am low
  expect "F1: under a doctored PATH the command line's verify passes" "$(PATH="$work/doctored-bin:$PATH" code cli verify)" "0"
  docin() { printf '{"session_id":"s-doc","tool_use_id":"%s","cwd":"%s","hook_event_name":"PreToolUse","tool_name":"Bash","tool_input":{"command":"%s"}}' "$1" "$doc" "${2:-git push -u origin feature}"; }
  said=$(docin toolu_doc1 | cli hook PreToolUse)
  echo "$said" | grep -q '"permissionDecision":"deny".*\[gate\] The gate is not green.*Verification' && pass "F1: the hook runs the check itself and refuses the push" || fail "F1: the hook runs the check itself and refuses the push ($said)"
  # R4, P-D: a kept pass forged with every field the old reader checked is not read at all.
  for one in "$CLAUDE_PLUGIN_DATA"/repos/*/; do printf '{"by":"classic-hook","env":"x","tree":"%s","runs":["devloop-smoke-probe"]}' "$(field tree)" >"$one/classic-passes.json"; done
  said=$(docin toolu_doc2 | cli hook PreToolUse)
  echo "$said" | grep -q '"permissionDecision":"deny".*\[gate\]' && pass "R4: a forged kept pass is not trusted (the file is not read)" || fail "R4: a forged kept pass is not trusted ($said)"
  # P-D: nor a forged record of the base policy (the hook read the policy in force from it before): a record that says observe changes nothing.
  for one in "$CLAUDE_PLUGIN_DATA"/repos/*/; do printf '{"key":"x","base":null,"baseText":"{ \\"mode\\": \\"observe\\" }"}' >"$one/classic-policy.json"; done
  said=$(docin toolu_doc3 'terraform apply' | cli hook PreToolUse)
  echo "$said" | grep -q '"permissionDecision":"deny".*\[production\]' && pass "P-D: a forged policy record in the state folder does not loosen the policy in force" || fail "P-D: a forged policy record does not loosen the policy in force ($said)"
  cd "$slow" || exit 1
  # DESIGN 4.14 (cache-guard's keep-warm): a new turn that leaves the tree as
  # the last stop saw it gets nothing from the classic stop gate: no check
  # run, no fix round, no message.
  kw="$work/final-keepwarm"
  mkdir -p "$kw" && cd "$kw" && git init -q -b main . && git config commit.gpgsign false
  printf '%s\n' "{ \"mode\": \"enforce\", \"verify\": [\"echo ran >> $work/kw-runs.log; test ! -e broken.flag\"] }" >devloop.json && printf 'x\n' >a.txt && git add -A && git commit -q -m base && git checkout -q -b feature && printf 'y\n' >>a.txt
  kwstop() { printf '{"session_id":"s-kw","prompt_id":"%s","cwd":"%s","hook_event_name":"Stop","stop_hook_active":%s}' "$1" "$kw" "${2:-false}" | cli hook Stop; }
  runs() { wc -l <"$work/kw-runs.log" 2>/dev/null | tr -d ' ' || echo 0; }
  expect "keep-warm: a person's turn that changed the tree runs the checks (silently, they pass)" "$(kwstop k1)" ""
  expect "keep-warm: ... once" "$(runs)" "1"
  expect "keep-warm: a new turn on the same tree gets nothing" "$(kwstop k2)" ""
  expect "keep-warm: ... and runs no check" "$(runs)" "1"
  touch broken.flag
  kwstop k3 | grep -q '"decision":"block"' && pass "keep-warm: a turn that changed the tree is judged as before (blocked)" || fail "keep-warm: a turn that changed the tree is judged as before"
  kwstop k3 true | grep -q 'nothing changed since the last blocked stop' && pass "keep-warm: the same turn going on after a block is told the fix loop ended" || fail "keep-warm: the same turn going on after a block is told the fix loop ended"
  before=$(runs)
  expect "keep-warm: a ping after that, on the same tree, gets nothing: no fix round, no message" "$(kwstop k4)" ""
  expect "keep-warm: ... and runs no check" "$(runs)" "$before"
  rm -f broken.flag
  cd "$slow" || exit 1
  said=$(printf '{"session_id":"s-throw","tool_use_id":"toolu_throw","cwd":"%s\\u0000x","tool_name":"Bash","tool_input":{"command":"ls"}}' "$slow" | cli hook PreToolUse 2>/dev/null)
  echo "$said" | grep -q '"permissionDecision":"deny".*could not judge this call' && pass "F5: a throw inside the classic hook refuses (the mode cannot be told)" || fail "F5: a throw inside the classic hook refuses ($said)"
  # R4, P-D: the classic stop gate keeps no pass either: a record that says this tree passed does not skip the checks.
  cd "$kw" || exit 1
  printf 'z\n' >>a.txt && touch broken.flag
  for one in "$CLAUDE_PLUGIN_DATA"/repos/*/; do [ -f "$one/classic-stop.json" ] && printf '{"passed":"%s","blocked":null,"rounds":0,"prompt":"k9"}' "$(field tree)" >"$one/classic-stop.json"; done
  kwstop k9 | grep -q '"decision":"block"' && pass "R4: a stop on a tree a forged record calls passed still runs the checks and blocks" || fail "R4: a stop on a tree a forged record calls passed still runs the checks and blocks"
  rm -f broken.flag

  # 37. The cache-guard round, L2: a sparse checkout pushes; a skip-worktree file
  #     edited on disk is refused and named; restored to the index's content it
  #     passes. R1: with real git, the spellings that named no source do not send
  #     an unjudged `main -> main`: every point refuses them, and the remote's
  #     main is unchanged.
  sp="$work/sparse"
  git init -q --bare "$work/sparse-remote.git"
  mkdir -p "$sp" && cd "$sp" || exit 1
  git init -q -b main . && git config commit.gpgsign false && git remote add origin "$work/sparse-remote.git"
  printf '%s\n' '{ "mode": "enforce", "verify": ["true"], "grounding": { "mode": "enforce" }, "tiers": { "low": ["docs/**", "big/**"] } }' >devloop.json
  mkdir -p docs big/one big/two && printf 'one\n' >docs/a.md && printf 'x\n' >big/one/x.md && printf 'y\n' >big/two/y.md
  git add -A && git commit -q -m base && git push -q origin main 2>/dev/null
  git checkout -q -b feature && printf 'two\n' >>docs/a.md && git commit -q -am low
  git sparse-checkout set --no-cone /devloop.json /docs/ >/dev/null 2>&1
  [ ! -e big/one/x.md ] && pass "L2: the sparse checkout left big/ out of the working tree" || fail "L2: the sparse checkout left big/ out of the working tree"
  git ls-files -v | grep -q '^S big/one/x.md$' && pass "L2: ... and git marks those entries skip-worktree" || fail "L2: ... and git marks those entries skip-worktree"
  expect "L2: absent files carry the bit but hide nothing" "$(field hidden)" ""
  spin() { printf '{"session_id":"s-sparse","tool_use_id":"%s","cwd":"%s","hook_event_name":"PreToolUse","tool_name":"Bash","tool_input":{"command":"%s"}}' "$1" "$sp" "$2"; }
  spin toolu_sp0 'ls' | cli hook PreToolUse >/dev/null
  expect "L2: a sparse checkout pushes (classic hook)" "$(spin toolu_sp1 'git push -u origin feature' | cli hook PreToolUse)" ""
  expect "L2: ... and the command line's gate told what it sends is green" "$(code cli gate --pushing HEAD)" "0"
  git sparse-checkout disable >/dev/null 2>&1
  git update-index --skip-worktree big/one/x.md && printf 'edited behind the bit\n' >>big/one/x.md
  expect "L2: a skip-worktree file edited on disk is reported" "$(field hidden)" "big/one/x.md"
  said=$(spin toolu_sp2 'git push -u origin feature' | cli hook PreToolUse)
  echo "$said" | grep -q '"permissionDecision":"deny".*Files hidden from git.*big/one/x.md' && pass "L2: ... and its push is refused, naming it" || fail "L2: ... and its push is refused, naming it ($said)"
  git show HEAD:big/one/x.md >big/one/x.md
  expect "L2: restored to the index's content it hides nothing" "$(field hidden)" ""
  expect "L2: ... and the push goes" "$(spin toolu_sp3 'git push -u origin feature' | cli hook PreToolUse)" ""
  git update-index --no-skip-worktree big/one/x.md
  # R1: the default branch moved locally to an unjudged commit; none of these may send it.
  mainBefore=$(git ls-remote "$work/sparse-remote.git" refs/heads/main | cut -f1)
  printf 'unjudged\n' >big/two/y.md && git commit -q -am unjudged && git branch -f main HEAD && git reset -q --hard HEAD~1
  for cmd in 'git push origin :' 'git push --al origin' 'git -c push.default=matching push origin' 'git -c remote.origin.push=refs/heads/main:refs/heads/main push origin' 'git push' 'git push origin'; do
    said=$(spin "toolu_r1_$RANDOM" "$cmd" | cli hook PreToolUse)
    if echo "$said" | grep -q '"permissionDecision":"deny"'; then
      pass "R1: the classic hook refuses \`$cmd\`"
    else
      fail "R1: the classic hook refuses \`$cmd\` ($said)"
      eval "$cmd" >/dev/null 2>&1
    fi
    expect "R1: ... and the command line refuses it too" "$(code cli check-command "$cmd")" "1"
  done
  expect "R1: the remote's main is unchanged: main -> main was never sent" "$(git ls-remote "$work/sparse-remote.git" refs/heads/main | cut -f1)" "$mainBefore"
  git -c push.default=matching push --dry-run origin 2>&1 | grep -q 'main -> main' && pass "R1: (git itself would have sent main -> main for the matching spelling)" || fail "R1: git itself would have sent main -> main for the matching spelling"
  # Ninth round, N1: git resolves the destination heads/main to the remote's main; the classic hook refuses the spelling.
  git push --dry-run origin HEAD:heads/main 2>&1 | grep -q -- '-> main$' && pass "N1: (git itself would land HEAD:heads/main on the remote's main)" || fail "N1: git itself would land HEAD:heads/main on the remote's main"
  said=$(spin toolu_n1 'git push --dry-run origin HEAD:heads/main' | cli hook PreToolUse)
  echo "$said" | grep -q '"permissionDecision":"deny".*the destination heads/main' && pass "N1: the classic hook refuses \`git push --dry-run origin HEAD:heads/main\`, naming the destination" || fail "N1: the classic hook refuses \`git push --dry-run origin HEAD:heads/main\` ($said)"
  expect "N1: ... and the command line refuses it too" "$(code cli check-command 'git push --dry-run origin HEAD:heads/main')" "1"

  # 38. Grounding (DESIGN 4.15), the classic hooks: the nudge at UserPromptSubmit
  #     where the module did not see the prompt, and the backstop at Stop from
  #     a hand-made transcript in the engine's line format (a person's prompt,
  #     assistant tool_use blocks, tool results).
  cd "$sp" || exit 1
  gdata="$CLAUDE_PLUGIN_DATA"
  upin() { printf '{"session_id":"%s","cwd":"%s","hook_event_name":"UserPromptSubmit","prompt":"%s","source":"%s"}' "$1" "$sp" "$2" "${3:-user}"; }
  said=$(upin s-g1 'Does this update include every queue and alert?' | cli hook UserPromptSubmit)
  echo "$said" | grep -q '"hookEventName":"UserPromptSubmit","additionalContext":"devloop: This is a question about the state of things: check the source before answering' && pass "grounding: the classic UserPromptSubmit hook nudges a question of fact" || fail "grounding: the classic UserPromptSubmit hook nudges a question of fact ($said)"
  expect "grounding: ... and adds nothing to a request" "$(upin s-g1 'add a queue for the support team' | cli hook UserPromptSubmit)" ""
  expect "grounding: ... nor to a prompt no person typed" "$(upin s-g1 'Is the cache warm?' system | cli hook UserPromptSubmit)" ""
  mkdir -p "$gdata/stamps/prompts"
  (cd "$here" && bun -e "import { digest } from './hooks/output'; process.stdout.write(digest('Is it deployed?'))") >"$gdata/stamps/prompts/s-g2"
  expect "grounding: a prompt the module stamped gets nothing from the classic hook" "$(upin s-g2 'Is it deployed?' | cli hook UserPromptSubmit)" ""
  [ ! -e "$gdata/stamps/prompts/s-g2" ] && pass "grounding: ... and it removes the stamp it read" || fail "grounding: ... and it removes the stamp it read"
  expect "grounding: an unreadable prompt gets no nudge and no refusal (advice)" "$(printf 'not json' | cli hook UserPromptSubmit)" ""
  tr1="$work/transcript-question.jsonl"
  {
    printf '%s\n' '{"type":"user","origin":{"kind":"human"},"promptSource":"sdk","message":{"role":"user","content":"set up the queue"}}'
    printf '%s\n' '{"type":"assistant","message":{"role":"assistant","content":[{"type":"tool_use","id":"toolu_g1","name":"Read","input":{"file_path":"a.txt"}}]}}'
    printf '%s\n' '{"type":"user","toolUseResult":{},"message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"toolu_g1","content":"x"}]}}'
    printf '%s\n' '{"type":"user","origin":{"kind":"human"},"promptSource":"sdk","message":{"role":"user","content":"Does this update include every queue and alert?"}}'
    printf '%s\n' '{"type":"assistant","message":{"role":"assistant","content":[{"type":"tool_use","id":"toolu_g2","name":"Bash","input":{"command":"echo checking"}}]}}'
    printf '%s\n' '{"type":"user","toolUseResult":{},"message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"toolu_g2","content":"checking"}]}}'
    printf '%s\n' '{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"Yes, I believe so."}]}}'
  } >"$tr1"
  gstop() { printf '{"session_id":"s-g3","prompt_id":"%s","cwd":"%s","hook_event_name":"Stop","stop_hook_active":%s,"transcript_path":"%s","last_assistant_message":"Yes, I believe so."}' "$1" "$sp" "$2" "$3"; }
  said=$(gstop gp1 false "$tr1" | cli hook Stop)
  echo "$said" | grep -q '"decision":"block".*answered without looking at anything in this turn' && pass "grounding: the classic Stop hook refuses a question answered with no look, once" || fail "grounding: the classic Stop hook refuses a question answered with no look, once ($said)"
  said=$(gstop gp1 true "$tr1" | cli hook Stop)
  echo "$said" | grep -q '"decision":"block"' && fail "grounding: the second stop is not refused ($said)" || pass "grounding: the second stop is not refused"
  echo "$said" | grep -q '"systemMessage":"devloop (classic hook): This answer was given without checking anything: it says \\"I believe\\"' && pass "grounding: ... and the person is told, the guess quoted" || fail "grounding: ... and the person is told, the guess quoted ($said)"
  grep -q '"kind":"answer-unchecked"' "$gdata"/repos/*/classic-inbox.jsonl && pass "grounding: ... and it is recorded for the module to fold (answer-unchecked)" || fail "grounding: ... and it is recorded for the module to fold (answer-unchecked)"
  tr2="$work/transcript-looked.jsonl"
  head -5 "$tr1" | sed 's/"name":"Bash","input":{"command":"echo checking"}/"name":"Grep","input":{"pattern":"queue"}/' >"$tr2"
  said=$(gstop gp2 false "$tr2" | cli hook Stop)
  echo "$said" | grep -q 'without looking\|without checking' && fail "grounding: a question followed by a look is not refused ($said)" || pass "grounding: a question followed by a look is not refused"
  said=$(gstop gp3 false "$work/no-such-transcript.jsonl" | cli hook Stop)
  echo "$said" | grep -q 'without looking\|without checking' && fail "grounding: a missing transcript skips this check, and only it ($said)" || pass "grounding: a missing transcript skips this check, and only it"
  tr3="$work/transcript-ping.jsonl"
  { cat "$tr1"; printf '%s\n' '{"type":"user","origin":{"kind":"task-notification"},"promptSource":"system","message":{"role":"user","content":"<task-notification>keep-warm ping: is the cache warm?</task-notification>"}}'; } >"$tr3"
  said=$(gstop gp4 false "$tr3" | cli hook Stop)
  echo "$said" | grep -q 'without looking\|without checking' && fail "grounding: a turn no person started is left alone (keep-warm) ($said)" || pass "grounding: a turn no person started is left alone (keep-warm)"
  said=$(printf '{"session_id":"s-g3","prompt_id":"gp5","cwd":"%s","hook_event_name":"Stop","stop_hook_active":false,"agent_id":"agent-x","transcript_path":"%s"}' "$sp" "$tr1" | cli hook Stop)
  expect "grounding: a subagent's stop is left alone" "$said" ""
  cd "$here" || exit 1
  unset CLAUDE_PLUGIN_DATA
  cd "$here" || exit 1
fi

# 36. cache-guard (DESIGN 4.14): the vendored files are the upstream commit's,
#     byte for byte, as cache-guard/VENDORED.json records them; its licence is
#     the canonical Apache License 2.0 text; the plugin's Lean output style is
#     the vendored one; and cache-guard's own test suite passes (it makes a
#     throwaway HOME itself, here under this run's folder).
cd "$here" || exit 1
manifest="$here/cache-guard/VENDORED.json"
if [ ! -f "$manifest" ]; then
  fail "cache-guard/VENDORED.json is there"
else
  listed=$(sed -n '/"files": {/,/}/p' "$manifest" | grep -oE '"[^"]+": "[0-9a-f]{64}"')
  count=0
  while IFS= read -r entry; do
    [ -n "$entry" ] || continue
    file=$(echo "$entry" | sed -E 's/^"([^"]+)": .*/\1/')
    want=$(echo "$entry" | grep -oE '[0-9a-f]{64}')
    got=$(sha256sum "$here/cache-guard/$file" 2>/dev/null | cut -d' ' -f1)
    count=$((count + 1))
    [ "$got" = "$want" ] || fail "cache-guard/$file matches its manifest hash (got '${got:-missing}')"
  done <<<"$listed"
  [ "$count" -ge 4 ] && pass "every vendored cache-guard file ($count) matches its manifest hash" || fail "the manifest lists the vendored files ($count)"
  grep -q '"commit": "9256974ddec1ad8c79a6b28fe37001b3a73e190e"' "$manifest" && pass "the manifest names the upstream commit" || fail "the manifest names the upstream commit"
  grep -q '"license": "Apache-2.0"' "$manifest" && pass "the manifest names the licence" || fail "the manifest names the licence"
  for added in LICENSE NOTICE.md; do
    sed -n '/"added": {/,/}/p' "$manifest" | grep -q "\"$added\"" && [ -f "$here/cache-guard/$added" ] && pass "cache-guard/$added is listed as added, apart from the vendored files" || fail "cache-guard/$added is listed as added"
  done
  sed -n '/"files": {/,/}/p' "$manifest" | grep -qE '"(LICENSE|NOTICE.md)"' && fail "the added files are not among the vendored ones" || pass "the added files are not among the vendored ones"
fi
expect "LICENSE (the repository's) is the canonical Apache License 2.0 text" "$(sha256sum "$here/LICENSE" | cut -d' ' -f1)" "cfc7749b96f63bd31c3c42b5c471bf756814053e847c10f3eb003417bc523d30"
grep -q '"license": "Apache-2.0"' "$here/.claude-plugin/plugin.json" && pass "plugin.json says Apache-2.0" || fail "plugin.json says Apache-2.0"
grep -q 'Licensed under the Apache License, Version 2.0; see LICENSE.' "$here/NOTICE" && pass "NOTICE names the licence" || fail "NOTICE names the licence"
expect "cache-guard/LICENSE is the canonical Apache License 2.0 text" "$(sha256sum "$here/cache-guard/LICENSE" | cut -d' ' -f1)" "cfc7749b96f63bd31c3c42b5c471bf756814053e847c10f3eb003417bc523d30"
[ -x "$here/cache-guard/cache_guard.py" ] && pass "cache_guard.py keeps its executable bit" || fail "cache_guard.py keeps its executable bit"
cmp -s "$here/output-styles/lean.md" "$here/cache-guard/lean.md" && pass "output-styles/lean.md is byte-identical to cache-guard/lean.md" || fail "output-styles/lean.md is byte-identical to cache-guard/lean.md"
# The skills the plugin ships pass doctor's own skill audit and injection scan with no error and no warning (spec-interview note, decision 9).
# Here, not in a *.test.ts: the plugin test world has no file system to read the shipped file from.
for skill in "$here"/skills/*/SKILL.md; do
  rel=${skill#"$here"/}
  said=$(cd "$here" && bun -e "import { existsSync, readFileSync } from 'node:fs'; import { lintInjection, lintSkills } from './hooks/lint'; const path = process.argv[1]; const text = readFileSync(path, 'utf8'); for (const one of [...lintSkills([{ path, text, hasMcp: existsSync(path.replace(/SKILL[.]md\$/, '.mcp.json')) }]), ...lintInjection([{ path, text }])]) console.log(one.level + ' ' + one.text)" "$rel")
  [ -n "$said" ] && ! echo "$said" | grep -qv '^ok ' && pass "$rel passes the skill audit with no error or warning" || fail "$rel passes the skill audit with no error or warning ($said)"
done
# The spec skill's first step searches the spec library too, and names each earlier spec's project (spec-library note, decision 4).
grep -q 'call the `devloop_library` tool' "$here/skills/spec/SKILL.md" && grep -q "naming each one's project" "$here/skills/spec/SKILL.md" && pass "the spec skill searches the spec library with devloop_library and names each spec's project" || fail "the spec skill searches the spec library with devloop_library and names each spec's project"
if command -v python3 >/dev/null 2>&1; then
  if (cd "$here" && TMPDIR="$work" PYTHONDONTWRITEBYTECODE=1 python3 cache-guard/tests/test_cache_guard.py >"$work/cache-guard-tests.out" 2>&1); then
    pass "cache-guard's own test suite passes ($(grep -c '^PASS' "$work/cache-guard-tests.out") checks)"
  else
    tail -20 "$work/cache-guard-tests.out"
    fail "cache-guard's own test suite passes"
  fi
  [ -z "$(find "$here/cache-guard" -name __pycache__ -print -quit)" ] && pass "running it left no bytecode in the vendored folder" || fail "running it left no bytecode in the vendored folder"
else
  echo "skipped: no python3 (cache-guard's own test suite)"
fi

if [ "$failures" -gt 0 ]; then
  echo "$failures check(s) failed"
  exit 1
fi
echo "all snapshot checks passed"
