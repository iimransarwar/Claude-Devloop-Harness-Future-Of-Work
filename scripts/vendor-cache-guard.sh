#!/usr/bin/env bash
# Copies cache-guard (the repository owner's own tool, DESIGN 4.14) into
# cache-guard/ byte for byte from a checkout of its repository, and writes
# cache-guard/VENDORED.json: the source, the commit, the version, the date and
# a SHA-256 per vendored file. The files this repository adds beside them
# (LICENSE, NOTICE.md) are kept as they are and listed under "added". The Lean
# output style is copied to output-styles/lean.md as well. An update is one
# command:
#   bash scripts/vendor-cache-guard.sh <path to a cache-guard-for-claude checkout>
# Nothing in the vendored files is ever edited here: tests/smoke.sh fails when
# a file differs from its manifest entry.
set -euo pipefail

src=${1:?usage: bash scripts/vendor-cache-guard.sh <cache-guard checkout>}
src=$(cd "$src" && pwd)
here=$(cd "$(dirname "$0")/.." && pwd)
dest="$here/cache-guard"
url=${CACHE_GUARD_URL:-https://github.com/iimransarwar/cache-guard-for-claude}

commit=$(git -C "$src" rev-parse HEAD)
if [ -n "$(git -C "$src" status --porcelain -- cache_guard.py lean.md README.md tests docs)" ]; then
  echo "vendor-cache-guard: $src has uncommitted changes to the vendored files; copy a clean commit." >&2
  exit 1
fi
version=$(sed -n 's/^VERSION = "\(.*\)"$/\1/p' "$src/cache_guard.py" | head -1)
[ -n "$version" ] || { echo "vendor-cache-guard: no VERSION line in $src/cache_guard.py" >&2; exit 1; }

# The files as the commit holds them, nothing untracked.
files=(); while IFS= read -r f; do files+=("$f"); done < <(git -C "$src" ls-files -- cache_guard.py lean.md README.md tests docs | LC_ALL=C sort)

# Start from an empty folder but for the files this repository adds.
mkdir -p "$dest"
find "$dest" -mindepth 1 -maxdepth 1 ! -name LICENSE ! -name NOTICE.md ! -name VENDORED.json -exec rm -rf {} +
for f in "${files[@]}"; do
  mkdir -p "$dest/$(dirname "$f")"
  cp -p "$src/$f" "$dest/$f"
done
chmod +x "$dest/cache_guard.py"
mkdir -p "$here/output-styles"
cp "$dest/lean.md" "$here/output-styles/lean.md"

hashOf() { sha256sum "$1" | cut -d' ' -f1; }
{
  printf '{\n'
  printf '  "name": "cache-guard",\n'
  printf '  "source": "%s",\n' "$url"
  printf '  "commit": "%s",\n' "$commit"
  printf '  "version": "%s",\n' "$version"
  printf '  "license": "Apache-2.0",\n'
  printf '  "vendored": "%s",\n' "$(date -u +%Y-%m-%d)"
  printf '  "files": {\n'
  n=${#files[@]}
  for i in "${!files[@]}"; do
    f=${files[$i]}
    printf '    "%s": "%s"%s\n' "$f" "$(hashOf "$dest/$f")" "$([ "$i" -lt $((n - 1)) ] && echo , || true)"
  done
  printf '  },\n'
  printf '  "added": {\n'
  added=()
  for f in LICENSE NOTICE.md; do [ -f "$dest/$f" ] && added+=("$f"); done
  n=${#added[@]}
  for i in "${!added[@]}"; do
    f=${added[$i]}
    printf '    "%s": "%s"%s\n' "$f" "$(hashOf "$dest/$f")" "$([ "$i" -lt $((n - 1)) ] && echo , || true)"
  done
  printf '  }\n'
  printf '}\n'
} >"$dest/VENDORED.json"

echo "vendored cache-guard $version ($commit) into $dest: ${#files[@]} files"
