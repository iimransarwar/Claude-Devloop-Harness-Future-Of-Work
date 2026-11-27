// An opt-in pre-push git hook (DESIGN 4.11, 11 "Portability"): a backstop
// that runs the command line's gate before git pushes and refuses the push
// when it is not green. A person installs it (`/devloop hooks install`, with
// a dialog); it chains a `pre-push` hook already there rather than replacing
// it, and `/devloop hooks remove` undoes exactly what install did. The
// builder can do neither: the commands are a person's, and `.git/hooks/**`
// is a built-in protected path. Pure: no `$`. tests/smoke.sh runs the
// scripts against a throwaway repository with a bare remote.

import { normalize } from './rules'

/** The first line after the shebang that marks the hook as the harness's. */
export const HOOK_MARK = '# devloop:pre-push'

/** Where a hook that was there before is kept, beside ours, and run first. */
export const CHAINED_SUFFIX = '.devloop-chained'

/** Single-quotes a path for sh. */
const quoted = (text: string): string => `'${text.replace(/'/g, `'\\''`)}'`

/**
 * The hook's text: run the hook that was there before (with the refs git
 * gives on standard input), then the gate, told which commits the push sends
 * (final round, D1 F4: each local commit git's input names, HEAD when it
 * names none), so a push whose commits do not hold the tree the gate judged
 * is refused. A gate that is not green, or no `node` to run it with, refuses
 * the push; a repository with no devloop.json on either side has nothing to
 * judge and passes (D1 F6).
 */
export function prePushHook(bundle: string): string {
  return [
    '#!/bin/sh',
    HOOK_MARK,
    '# Installed by /devloop hooks install; /devloop hooks remove undoes it.',
    '# Runs the hook that was here before, then the devloop gate: a gate that',
    '# is not green refuses the push. A person can still push with --no-verify.',
    'input=$(cat)',
    'here=$(dirname "$0")',
    `if [ -x "$here/pre-push${CHAINED_SUFFIX}" ]; then`,
    `  printf '%s\\n' "$input" | "$here/pre-push${CHAINED_SUFFIX}" "$@" || exit $?`,
    'fi',
    'if ! command -v node >/dev/null 2>&1; then',
    '  echo "devloop: node is not installed, so the gate cannot run; the push is refused." >&2',
    '  exit 1',
    'fi',
    '# What the push sends: each local commit git names (a deletion sends none); HEAD when it names none.',
    "pushing=$(printf '%s\\n' \"$input\" | awk 'NF >= 4 && $2 !~ /^0+$/ { print $2 }')",
    '[ -n "$pushing" ] || pushing=HEAD',
    `out=$(node ${quoted(bundle)} gate --pushing $pushing 2>&1)`,
    'code=$?',
    '[ "$code" -eq 0 ] && exit 0',
    '# Not opted in: no devloop.json on either side, so nothing to judge.',
    "if [ \"$code\" -eq 2 ] && printf '%s' \"$out\" | grep -q 'has not opted in'; then exit 0; fi",
    "printf '%s\\n' \"$out\" >&2",
    `echo "devloop: the gate is not green, so the push is refused (node ${bundle.replace(/"/g, '')} gate says why)." >&2`,
    'exit 1',
    '',
  ].join('\n')
}

// Where git would run a pre-push hook from (D1 F6): its own answer, so
// core.hooksPath is followed, beside the work tree's top and git's common
// folder, so the module can tell a hooks folder inside git's folder from one
// inside the tracked tree or one outside the repository.
export const HOOK_WHERE = `
# devloop:hook-where
dir=$(git rev-parse --git-path hooks 2>/dev/null) || exit 3
echo "dir:$dir"
echo "cwd:$(pwd -P)"
echo "top:$(git rev-parse --show-toplevel 2>/dev/null)"
common=$(git rev-parse --git-common-dir 2>/dev/null) || exit 3
echo "common:$(cd "$common" 2>/dev/null && pwd -P)"
`

/** Where the hooks folder is, for install: inside git's own folder, inside the tracked tree, or outside the repository; the folder as an absolute path. */
export type HooksPlace = { kind: 'git' | 'tree' | 'outside'; dir: string }

/** Reads the where-script's answer (`dir:`, `cwd:`, `top:`, `common:`); null when it did not answer. */
export function hooksPlace(said: string): HooksPlace | null {
  const tag = (name: string): string => said.split('\n').find(line => line.startsWith(`${name}:`))?.slice(name.length + 1).trim() ?? ''
  const raw = tag('dir')
  const cwd = tag('cwd')
  if (raw === '' || cwd === '') {
    return null
  }
  const dir = normalize(raw.startsWith('/') ? raw : `${cwd}/${raw}`)
  const within = (folder: string): boolean => folder !== '' && (dir === folder || dir.startsWith(`${folder.replace(/\/+$/, '')}/`))

  return { kind: within(normalize(tag('common'))) ? 'git' : within(normalize(tag('top'))) ? 'tree' : 'outside', dir }
}

// Installs the hook text ($1) as pre-push in the repository's hooks folder
// (git's own answer, so core.hooksPath is followed). A pre-push already
// there that is not the harness's is moved aside and chained; one that is
// the harness's is left as it is. Says what it did on one line.
export const HOOK_INSTALL = `
# devloop:hook-install
dir=$(git rev-parse --git-path hooks 2>/dev/null) || exit 3
mkdir -p "$dir" || exit 3
hook="$dir/pre-push"
if [ -f "$hook" ] && grep -q '^# devloop:pre-push' "$hook"; then echo "already:$hook"; exit 0; fi
chained=""
if [ -e "$hook" ] || [ -L "$hook" ]; then
  if [ -e "$hook.devloop-chained" ]; then echo "busy:$hook.devloop-chained"; exit 4; fi
  mv "$hook" "$hook.devloop-chained" || exit 5
  chained="yes"
fi
printf '%s' "$1" >"$hook" && chmod +x "$hook" || exit 5
if [ -n "$chained" ]; then echo "installed-chained:$hook"; else echo "installed:$hook"; fi
`

// Removes exactly what install wrote: the harness's pre-push, and puts a
// chained hook back where it was. A pre-push that is not the harness's is
// left alone.
export const HOOK_REMOVE = `
# devloop:hook-remove
dir=$(git rev-parse --git-path hooks 2>/dev/null) || exit 3
hook="$dir/pre-push"
if [ ! -f "$hook" ] || ! grep -q '^# devloop:pre-push' "$hook"; then
  if [ -e "$hook" ]; then echo "foreign:$hook"; else echo "absent:$hook"; fi
  exit 0
fi
rm -f "$hook" || exit 5
if [ -e "$hook.devloop-chained" ]; then mv "$hook.devloop-chained" "$hook" || exit 5; echo "removed-restored:$hook"; else echo "removed:$hook"; fi
`

/** What an install or remove script said, in a person's words. */
export function hookOutcome(said: string, code: number): { isDone: boolean; text: string } {
  const line = said.split('\n').find(one => /^[a-z-]+:/.test(one)) ?? ''
  const what = line.slice(0, line.indexOf(':'))
  const path = line.slice(line.indexOf(':') + 1)
  switch (what) {
    case 'installed':
      return { isDone: true, text: `Installed a pre-push hook at ${path}: git runs the devloop gate before each push and refuses a push that is not green.` }
    case 'installed-chained':
      return { isDone: true, text: `Installed a pre-push hook at ${path}; the hook that was there is kept as ${path}${CHAINED_SUFFIX} and runs first. /devloop hooks remove puts it back.` }
    case 'already':
      return { isDone: false, text: `The devloop pre-push hook is already installed at ${path}.` }
    case 'busy':
      return { isDone: false, text: `Not installed: ${path} already exists, so the hook there cannot be chained safely. Move it, then try again.` }
    case 'removed':
      return { isDone: true, text: `Removed the devloop pre-push hook at ${path}.` }
    case 'removed-restored':
      return { isDone: true, text: `Removed the devloop pre-push hook at ${path} and put back the hook it chained.` }
    case 'foreign':
      return { isDone: false, text: `The pre-push hook at ${path} is not the harness's; it is left as it is.` }
    case 'absent':
      return { isDone: false, text: 'No devloop pre-push hook is installed.' }
    default:
      return { isDone: false, text: code === 3 ? 'Not a git repository: there is no hooks folder.' : `The hook could not be written (exit ${code}).` }
  }
}
