// The harness's own git and shell scripts, and the pure helpers around them:
// shared by the hooks module (through hooks/state.ts and hooks/evidence.ts)
// and the command line and classic hooks (cli/, bundled into dist/devloop.mjs),
// so every enforcement point finds the base, hashes the tree and scrubs a
// check exactly the same way. Pure: no `$`. tests/smoke.sh extracts each
// script from this file and runs it against real git.

import { CHECK_ENV_BASE } from './config'
import type { CheckEnv, Config } from './config'

// One call reads the tree's content hash (a throwaway index, so the real one
// is never touched), the branch, the head, the base, the diff's size and the
// changed files against the base. The base is where the branch left the
// default branch: the configured one on the remote, then locally, then the
// remote's HEAD, then main or master; a branch is never its own base. With
// none found it is `unknown` and the gate stays shut. The commit the last
// closed change ended on ($2) moves the base forward. Renames are listed as
// a deletion and an addition, so the old path is never hidden.
// Every file in the working tree is in the hash (DESIGN principle 9): no
// path is ever left out. Instruction files git ignores (the pathspecs after
// $2, dependency and build folders excluded) are hashed into the tree all the
// same and listed as `ignored:` with their content hash, since every session
// reads them; the shallowest are taken first, at most 500, and `capped:<n>`
// says how many matched when there were more. The diff and the changed files
// leave the ignored ones out (`plain`): the harness compares them with the
// change's start itself. Beside the full tree it prints the committable tree
// (final round, D1 F4: what `git add -A` would commit, without the ignored
// instruction files forced in) and HEAD's tree: a push is allowed only when
// the two are the same, since the gate judges the tree and a push sends
// commits. It also reports (the last review's F2, F9) every index entry git
// is told not to look at (skip-worktree or assume-unchanged: `git add -A`
// leaves their changes out of both trees) as `hidden:<path>`, and, where the
// committable tree is not HEAD's, how many files differ from HEAD
// (`differcount:<n>`) and the first five, each marked tracked or untracked
// (`differs:t|u <path>`), for the refusal that says what to commit or stash.
// An entry with either bit hides something only when a file is at its path in
// the working tree and its content (or executable bit) differs from the index
// entry's (the cache-guard round, L2): a file a sparse checkout left out, or
// one identical to the index, hides nothing, since what a push sends is what
// the snapshot saw. The comparison is by content hash (`git hash-object`
// against the entry's blob), never by git's own "modified", which the bits
// switch off. At most 100 such files are compared; past that the snapshot
// says `hiddencap:100`, and that refuses. Every line is tagged (R14), a
// changed file as `file:<path>`; a line with no known tag makes the snapshot
// unreadable, and an unreadable snapshot refuses.
// tests/smoke.sh runs this text against real git.
export const SNAPSHOT = `
# devloop:snapshot
git rev-parse --git-dir >/dev/null 2>&1 || exit 0
current=$(git symbolic-ref --short -q HEAD 2>/dev/null)
base=""
if git rev-parse -q --verify HEAD >/dev/null 2>&1; then
  remoteHead=$(git symbolic-ref -q --short refs/remotes/origin/HEAD 2>/dev/null)
  for ref in "origin/$1" "$1" "$remoteHead" origin/main main origin/master master; do
    [ -n "$ref" ] && [ "$ref" != "$current" ] || continue
    if git rev-parse -q --verify "$ref^{commit}" >/dev/null 2>&1; then
      base=$(git merge-base HEAD "$ref" 2>/dev/null)
      break
    fi
  done
else
  base=$(git hash-object -t tree /dev/null)
fi
if [ -n "$2" ] && git merge-base --is-ancestor "$2" HEAD 2>/dev/null; then
  if [ -z "$base" ] || git merge-base --is-ancestor "$base" "$2" 2>/dev/null; then base=$2; fi
fi
if [ "$#" -ge 2 ]; then shift 2; else set --; fi
dir=$(mktemp -d)
idx="$dir/index"
# -p keeps the index's own timestamps. A copy newer than a file edited in the
# same second makes git trust the cached size and time, and miss the edit.
cp -p "$(git rev-parse --git-path index)" "$idx" 2>/dev/null
plain=""
tree=""
if GIT_INDEX_FILE="$idx" git add -A . >/dev/null 2>&1; then
  plain=$(GIT_INDEX_FILE="$idx" git write-tree 2>/dev/null)
  if [ "$#" -gt 0 ]; then
    git -c core.quotePath=false ls-files -o -i --exclude-standard -- "$@" 2>/dev/null | awk -F/ '{ print NF "\t" $0 }' | sort -s -n -k1,1 | cut -f2- >"$dir/swept"
    count=$(wc -l <"$dir/swept" | tr -d ' ')
    head -500 "$dir/swept" >"$dir/ignored"
    [ "$count" -gt 500 ] && echo "capped:$count" >>"$dir/listed"
    while IFS= read -r f; do
      [ -f "$f" ] || continue
      GIT_INDEX_FILE="$idx" git add -f -- "$f" >/dev/null 2>&1 && echo "ignored:$(git hash-object -- "$f") $f" >>"$dir/listed"
    done <"$dir/ignored"
  fi
  tree=$(GIT_INDEX_FILE="$idx" git write-tree 2>/dev/null)
fi
echo "tree:$tree"
echo "committable:$plain"
echo "headtree:$(git rev-parse -q --verify 'HEAD^{tree}' 2>/dev/null)"
echo "branch:$current"
echo "head:$(git rev-parse -q --verify HEAD 2>/dev/null)"
if [ -n "$base" ]; then echo "base:$base"; else echo "base:unknown"; fi
[ -f "$dir/listed" ] && cat "$dir/listed"
git -c core.quotePath=false ls-files -s -v 2>/dev/null | grep -E '^(S|[a-z]) ' >"$dir/bits"
fileMode=$(git config --bool core.fileMode 2>/dev/null)
n=0
while IFS=$'\t' read -r meta f; do
  [ -e "$f" ] || [ -L "$f" ] || continue
  n=$((n + 1))
  if [ "$n" -gt 100 ]; then echo "hiddencap:100"; break; fi
  read -r tag mode blob stage <<<"$meta"
  if [ -L "$f" ]; then now=$(printf '%s' "$(readlink -- "$f")" | git hash-object --stdin 2>/dev/null); else now=$(git hash-object -- "$f" 2>/dev/null); fi
  if [ "$now" != "$blob" ]; then
    echo "hidden:$f"
  elif [ "$fileMode" != false ] && [ ! -L "$f" ] && { { [ "$mode" = 100755 ] && [ ! -x "$f" ]; } || { [ "$mode" = 100644 ] && [ -x "$f" ]; }; }; then
    echo "hidden:$f"
  fi
done <"$dir/bits"
headTree=$(git rev-parse -q --verify 'HEAD^{tree}' 2>/dev/null)
if [ -n "$plain" ] && [ -n "$headTree" ] && [ "$plain" != "$headTree" ]; then
  git -c core.quotePath=false diff --no-renames --name-only HEAD "$plain" 2>/dev/null >"$dir/differs"
  echo "differcount:$(wc -l <"$dir/differs" | tr -d ' ')"
  head -5 "$dir/differs" | while IFS= read -r f; do
    if git cat-file -e "HEAD:./$f" 2>/dev/null || git ls-files --error-unmatch -- "$f" >/dev/null 2>&1; then echo "differs:t $f"; else echo "differs:u $f"; fi
  done
fi
rm -rf "$dir"
[ -n "$tree" ] || exit 0
from=$base
[ -n "$from" ] || from=HEAD
git diff --no-renames --numstat "$from" "$plain" 2>/dev/null | awk '{ files += 1; if ($1 != "-") lines += $1 + $2 } END { print "diff:" files + 0 " " lines + 0 }'
git -c core.quotePath=false diff --no-renames --name-only "$from" "$plain" 2>/dev/null | sed 's/^/file:/'
`

// The base alone, found exactly as the snapshot finds it (the same lines;
// tests/smoke.sh checks the two agree), for a decision taken before any
// snapshot: the guards' first call, say. `unknown` when there is none.
export const FIND_BASE = `
# devloop:find-base
git rev-parse --git-dir >/dev/null 2>&1 || { echo unknown; exit 0; }
current=$(git symbolic-ref --short -q HEAD 2>/dev/null)
base=""
if git rev-parse -q --verify HEAD >/dev/null 2>&1; then
  remoteHead=$(git symbolic-ref -q --short refs/remotes/origin/HEAD 2>/dev/null)
  for ref in "origin/$1" "$1" "$remoteHead" origin/main main origin/master master; do
    [ -n "$ref" ] && [ "$ref" != "$current" ] || continue
    if git rev-parse -q --verify "$ref^{commit}" >/dev/null 2>&1; then
      base=$(git merge-base HEAD "$ref" 2>/dev/null)
      break
    fi
  done
else
  base=$(git hash-object -t tree /dev/null)
fi
if [ -n "$2" ] && git merge-base --is-ancestor "$2" HEAD 2>/dev/null; then
  if [ -z "$base" ] || git merge-base --is-ancestor "$base" "$2" 2>/dev/null; then base=$2; fi
fi
if [ -n "$base" ]; then echo "$base"; else echo unknown; fi
`

export const BASE_POLICY = `
# devloop:base-policy
git cat-file -e "$1:./devloop.json" 2>/dev/null || exit 3
git show "$1:./devloop.json"
`

export const CURRENT_BRANCH = `
# devloop:branch
git rev-parse --git-dir >/dev/null 2>&1 || exit 3
if b=$(git symbolic-ref --short -q HEAD 2>/dev/null); then echo "branch:$b"; else echo "branch:(detached)"; fi
`

export const PUSH_RANGE = `
# devloop:push-range
git rev-parse -q --verify "origin/$1^{commit}" >/dev/null 2>&1 || { echo unknown; exit 0; }
src=$2
[ -n "$src" ] || src=HEAD
from=$(git merge-base "origin/$1" "$src" 2>/dev/null) || { echo unknown; exit 0; }
echo known
git -c core.quotePath=false diff --no-renames --name-only "$from" "$src" 2>/dev/null
`

export const LS_FILES = `
# devloop:ls-files
git rev-parse --git-dir >/dev/null 2>&1 || exit 3
git -c core.quotePath=false ls-files -- "$@" 2>/dev/null | head -5000
`

// A check run with a scrubbed environment (C1, nanochat note 6; F3): the
// environment is built from nothing (`env -i`) with only the names given
// that are shell identifiers and set, so a name that is not an identifier
// (`npm_config_//registry…:_authToken`) and an exported function never reach
// the check. The command runs in a plain bash with no profile and no rc file.
// Not a git script: it is answered as a command by the test world.
export const SCRUBBED = `
# devloop:scrubbed
cmd=$1
shift
for n in "$@"; do
  shift
  case "$n" in ''|[0-9]*|*[!A-Za-z0-9_]*) continue ;; esac
  v=$(printenv -- "$n") || continue
  set -- "$@" "$n=$v"
done
exec env -i "$@" bash --noprofile --norc -c "$cmd"
`

// The added lines of the whole change, untracked files included: the same
// throwaway index as the snapshot, diffed from the base with no context.
export const ADDED_LINES = `
# devloop:added-lines
dir=$(mktemp -d)
idx="$dir/index"
cp -p "$(git rev-parse --git-path index)" "$idx" 2>/dev/null
tree=$(GIT_INDEX_FILE="$idx" git add -A . >/dev/null 2>&1 && GIT_INDEX_FILE="$idx" git write-tree 2>/dev/null)
rm -rf "$dir"
[ -n "$tree" ] || exit 3
git -c core.quotePath=false diff -U0 --no-renames --no-ext-diff --no-textconv --no-color "$1" "$tree"
`

export const BASE_FILE = `
# devloop:base-file
git cat-file -e "$1:./$2" 2>/dev/null || exit 3
git show "$1:./$2"
`

/** Dependency and build folders the sweep for ignored instruction files never enters (F12), beside the policy's `instructionsIgnore`. */
export const SWEEP_SKIPS: readonly string[] = ['node_modules', 'vendor', '.venv', 'dist', 'build', 'target']

/** How many ignored instruction files the sweep takes; past it the snapshot says `capped:<n>`. */
export const SWEEP_CAP = 500

/** Instruction globs as git pathspecs: a glob with no slash matches the name at any depth, as `matches` reads it. */
export const pathspecsOf = (globs: readonly string[]): string[] =>
  globs.filter(glob => glob.trim() !== '').map(glob => `:(glob)${glob.includes('/') ? glob.replace(/^\.\//, '') : `**/${glob}`}`)

/**
 * The sweep's pathspecs: the instruction globs, then the folders it leaves
 * out (the dependency and build folders, and `instructionsIgnore`), each as
 * an exclude at any depth. None at all without an instruction glob, since
 * excludes alone would match everything.
 */
export function sweepSpecsOf(cfg: Pick<Config, 'instructions' | 'instructionsIgnore'>): string[] {
  const specs = pathspecsOf(cfg.instructions)
  if (specs.length === 0) {
    return []
  }
  const skips = [...SWEEP_SKIPS, ...cfg.instructionsIgnore].map(one => one.trim().replace(/^\.\//, '').replace(/\/+$/, '')).filter(one => one !== '')
  const excludes = skips.flatMap(one => (one.includes('/') ? [one, `${one}/**`] : [`**/${one}`, `**/${one}/**`]))

  return [...specs, ...[...new Set(excludes)].map(one => `:(exclude,glob)${one}`)]
}

export type Snapshot = {
  /** A hash of the working tree's content, the same before and after a commit; null outside git. */
  tree: string | null
  /**
   * The tree a commit of everything would make (final round, D1 F4): the
   * working tree as `git add -A` takes it, without the ignored instruction
   * files `tree` forces in. What a push can send once it is committed, and
   * what evidence notes are keyed on. Null outside git.
   */
  committable: string | null
  /** HEAD's tree; null with no commit (or outside git). */
  headTree: string | null
  /** The branch checked out; null on a detached head or outside git. */
  branch: string | null
  head: string | null
  /** The commit the change is measured from; null when no base branch was found. */
  base: string | null
  /** Files that differ from the base: where the branch left the default branch, or the last closed change. */
  files: string[]
  /** The diff against the base: files, and lines added plus removed. */
  size: { files: number; lines: number }
  /** Instruction files git ignores, hashed into `tree` all the same: their content hash, by path. */
  ignored: Record<string, string>
  /** How many ignored instruction files matched when more than the sweep takes; null when it took them all. */
  capped: number | null
  /**
   * Index entries git is told not to look at (the last review's F2): the
   * skip-worktree or assume-unchanged bit set, so their changes are in
   * neither tree. Any one keeps the gate shut and refuses a push.
   */
  hidden: string[]
  /** The first files that differ between the committable tree and HEAD's (F9), each marked untracked or not; empty when they are the same. */
  differs: { path: string; isUntracked: boolean }[]
  /** How many files differ between the committable tree and HEAD's. */
  differCount: number
  /** Set when git answered that the folder is no work tree (the script exits 0 with nothing); never when a snapshot merely failed or was unreadable. */
  isOutsideGit?: boolean
}

export const NO_SNAPSHOT: Snapshot = { tree: null, committable: null, headTree: null, branch: null, head: null, base: null, files: [], size: { files: 0, lines: 0 }, ignored: {}, capped: null, hidden: [], differs: [], differCount: 0 }

const TAGGED = /^(tree|committable|headtree|branch|head|base|diff|ignored|capped|hidden|hiddencap|differcount|differs|file):/

/** What the snapshot names in place of the files past its cap of compared hidden entries (L2): it keeps the push refused. */
export const HIDDEN_PAST_CAP = 'more files with the skip-worktree or assume-unchanged bit on disk than the 100 the snapshot compares'

/**
 * Reads the snapshot script's answer (R14): every line tagged, a changed
 * file as `file:<path>`. A line with no known tag makes the whole answer
 * unreadable: no tree, so the gate is shut and a push refused.
 */
export function readSnapshot(stdout: string): Snapshot {
  const lines = stdout.split('\n').filter(line => line !== '')
  if (stdout.trim() === '') {
    return { ...NO_SNAPSHOT, isOutsideGit: true }
  }
  if (lines.some(line => !TAGGED.test(line))) {
    return NO_SNAPSHOT
  }
  const head = lines.filter(line => !line.startsWith('file:'))
  const ignored: Record<string, string> = {}
  for (const line of head.filter(one => one.startsWith('ignored:'))) {
    const cut = line.indexOf(' ')
    if (cut > 0) {
      ignored[line.slice(cut + 1)] = line.slice('ignored:'.length, cut)
    }
  }
  const tagged = (tag: string): string => head.find(line => line.startsWith(`${tag}:`))?.slice(tag.length + 1) ?? ''
  const tree = tagged('tree')
  const base = tagged('base')
  const [files = 0, changedLines = 0] = tagged('diff').split(' ').map(Number)
  const capped = Number(tagged('capped'))
  const hidden = [...head.filter(line => line.startsWith('hidden:')).map(line => line.slice('hidden:'.length)).filter(one => one !== ''), ...(head.some(line => line.startsWith('hiddencap:')) ? [HIDDEN_PAST_CAP] : [])]
  const differs = head.filter(line => /^differs:[tu] ./.test(line)).map(line => ({ path: line.slice('differs:t '.length), isUntracked: line.startsWith('differs:u') }))
  const differCount = Math.max(Number(tagged('differcount')) || 0, differs.length)
  const common = { branch: tagged('branch') || null, head: tagged('head') || null, base: base === '' || base === 'unknown' ? null : base, headTree: tagged('headtree') || null, hidden, differs, differCount }

  return tree === ''
    ? { ...NO_SNAPSHOT, ...common }
    : { ...common, tree, committable: tagged('committable') || null, files: [...new Set(lines.filter(line => line.startsWith('file:') && !line.startsWith('file:.claude/worktrees/')).map(line => line.slice('file:'.length)))], size: { files, lines: changedLines }, ignored, capped: capped > 0 ? capped : null }
}

/** The argv a check runs with: a login shell with everything (`off`, `observe`), or only the base and the names passed (`enforce`). */
export function checkArgv(command: string, scrub: CheckEnv | null): string[] {
  return scrub !== null && scrub.mode === 'enforce'
    ? ['bash', '-c', SCRUBBED, 'devloop', command, ...new Set([...CHECK_ENV_BASE, ...scrub.pass])]
    : ['bash', '-lc', command]
}

// The instruction files the policy's globs name ($@, as sweepSpecsOf gives
// them), each marked: `t` tracked, `u` untracked, `i` ignored (the
// shallowest 400, then `capped:<n>`). Doctor's instruction audit reads it.
export const INSTRUCTION_FILES = `
# devloop:instruction-files
git rev-parse --git-dir >/dev/null 2>&1 || exit 3
git -c core.quotePath=false ls-files -c -- "$@" 2>/dev/null | head -400 | sed 's/^/t /'
git -c core.quotePath=false ls-files -o --exclude-standard -- "$@" 2>/dev/null | head -400 | sed 's/^/u /'
git -c core.quotePath=false ls-files -o -i --exclude-standard -- "$@" 2>/dev/null | awk -F/ '{ print NF "\t" $0 }' | sort -s -n -k1,1 | cut -f2- | awk '{ if (NR <= 400) print "i " $0 } END { if (NR > 400) print "capped:" NR }'
`

/** Formatter and linter configs whose rules an instruction file need not repeat. */
export const FORMATTERS = ['.prettierrc', '.prettierrc.json', '.prettierrc.js', 'prettier.config.js', '.editorconfig', 'biome.json', '.eslintrc', '.eslintrc.json', '.eslintrc.js', 'eslint.config.js', 'eslint.config.mjs', 'rustfmt.toml', '.rustfmt.toml', 'ruff.toml', '.clang-format', '.rubocop.yml', 'deno.json']

/** The instruction-files script's answer: each file with its kind, and the count past the cap. */
export function readInstructionFiles(out: string): { files: { path: string; kind: 't' | 'u' | 'i' }[]; capped: number | null } {
  const found = new Map<string, 't' | 'u' | 'i'>()
  let capped: number | null = null
  for (const line of out.split('\n')) {
    if (line.startsWith('capped:')) {
      capped = Number(line.slice('capped:'.length)) || null
      continue
    }
    const kind = line.slice(0, 1)
    const path = line.slice(2)
    if (path !== '' && (kind === 't' || kind === 'u' || kind === 'i') && !found.has(path)) {
      found.set(path, kind)
    }
  }

  return { files: [...found].map(([path, kind]) => ({ path, kind })), capped }
}

// This repository's origin, for a `gh` ship that names a repository (D1).
export const REMOTE_URL = `
# devloop:remote-url
git remote get-url origin 2>/dev/null || exit 3
`

// The review carry-over (D2): the entries that differ between the reviewed
// tree and the tree now, both written by SNAPSHOT, with their modes. A
// verdict carries only when every one is `.tasks` state (`isTaskStateOnly`
// in hooks/tasks.ts, on what `readCarryDiff` makes of this). No git setting
// hides a change from it (final round, D2 F9): submodule changes are never
// ignored, and an external diff or text conversion never runs.
// tests/smoke.sh runs this text against real git.
export const CARRY_DIFF = `
# devloop:carry-diff
git -c core.quotePath=false -c diff.ignoreSubmodules=none diff --raw --no-renames --no-abbrev --ignore-submodules=none --no-ext-diff --no-textconv "$1" "$2"
`

/** The modes of a file git tracks as text a person edits: a regular file, or none (added or deleted). */
const PLAIN_MODES = ['100644', '000000']

/**
 * The carry diff's answer as the paths the carry-over rule judges (final
 * round, D2 F9, F12): each entry's path, and for an entry that is not a
 * plain file on either side (a link, an executable bit, a submodule) a mark
 * after it, so it is never read as task state. A line with no mode (as a
 * plain list of paths gives it) is its path.
 */
export function readCarryDiff(out: string): string[] {
  return out.split('\n').filter(line => line !== '').map(line => {
    const raw = /^:(\d{6}) (\d{6}) \S+ \S+ [A-Z]\d*\t(.*)$/.exec(line)
    if (raw === null) {
      return line
    }
    const [, from = '', to = '', path = ''] = raw
    const odd = [from, to].find(mode => !PLAIN_MODES.includes(mode))

    return odd === undefined ? path : `${path} (mode ${odd}: ${odd === '120000' ? 'a link' : odd === '160000' ? 'a submodule' : odd === '100755' ? 'an executable' : 'not a plain file'})`
  })
}

// The repository's main root (D2): where its git folder lives, so every
// worktree of one repository finds the same claims in the plugin's store.
export const MAIN_ROOT = `
# devloop:main-root
common=$(git rev-parse --git-common-dir 2>/dev/null) || exit 3
common=$(cd "$common" 2>/dev/null && pwd -P) || exit 3
case "$common" in
  */.git) dirname "$common" ;;
  *) echo "$common" ;;
esac
`
