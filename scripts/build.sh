#!/usr/bin/env bash
# Builds dist/devloop.mjs: the pure policy core (hooks/*.ts that touch no `$`)
# and the command line (cli/), as one JavaScript file with no dependencies,
# for Node 18 or later. The file is committed; tests/smoke.sh rebuilds it and
# fails when the result differs by a byte, so it never drifts from its sources.
#   bash scripts/build.sh            write dist/devloop.mjs
#   bash scripts/build.sh <file>     write the bundle to <file> instead (the smoke test's check)
set -euo pipefail
here=$(cd "$(dirname "$0")/.." && pwd)
out=${1:-"$here/dist/devloop.mjs"}
cd "$here"
mkdir -p "$(dirname "$out")"
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
bun build cli/main.ts --target=node --format=esm --outfile="$tmp/devloop.mjs" >/dev/null
{
  echo '// devloop: the policy core and the command line, built from hooks/ and cli/ by'
  echo '// scripts/build.sh. Do not edit: tests/smoke.sh fails when a rebuild differs.'
  cat "$tmp/devloop.mjs"
} >"$out"
