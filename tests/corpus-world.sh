#!/usr/bin/env bash
# The world the comparison corpus (tests/corpus.jsonl) is judged in (the
# fourteenth round, CC2): the fourteenth reviewer's two worlds in one. A
# repository with a secrets folder and links into it from several places, a
# folder whose name holds a space, 70 sibling folders under mono/ (one with a
# link into the secrets folder, past the expander's folder-listing cap), a git
# hook, on a feature branch. Every "secret" here is the text "not a real
# token". The reference verdicts in the corpus were recorded in this world
# with the reviewed build's bundle (`git show 2374c49:dist/devloop.mjs`).
#   bash tests/corpus-world.sh <new folder>
set -euo pipefail
w=${1:?usage: corpus-world.sh <new folder>}
[ ! -e "$w" ] || { echo "corpus-world: $w already exists" >&2; exit 2; }
mkdir -p "$w"
cd "$w"
git init -q -b main .
git config user.email corpus@example.invalid
git config user.name corpus
git config commit.gpgsign false
put() { mkdir -p "$(dirname "$1")"; printf '%b' "$2" >"$1"; }
put token.txt 'plain\n'
put src/a.ts 'export const a = 1\n'
put src/b.ts 'export const b = 2\n'
put config/secrets/token.txt 'not a real token\n'
put config/secrets/apikey 'not a real token\n'
put config/secrets/deep/token.txt 'not a real token\n'
put config/secrets/deep2/token.txt 'not a real token\n'
put 'config/secrets/sp ace/token.txt' 'not a real token\n'
put .env 'not a real token\n'
put env.d/.env 'not a real token\n'
put env.d/token.txt 'plain\n'
put tests/a.test.ts "it('a',()=>{})\n"
put package.json '{"name":"root","scripts":{"test":"true"}}\n'
put packages/a/package.json '{"name":"a","scripts":{"test":"true","build":"true"}}\n'
put packages/a/Makefile 'all:\n\t@true\n'
put packages/b/package.json '{"name":"b","scripts":{"test":"true","build":"true"}}\n'
put packages/b/Makefile 'all:\n\t@true\n'
put sub/x.txt 'hi\n'
put .claude/settings.json '{}\n'
put docs/a.md 'a\n'
put docs/b.md 'b\n'
put docs/sub/c.md 'c\n'
put lib/inner/x.ts 'x\n'
put list.txt 'config/secrets/token.txt\n'
put build/.keep ''
put README.md 'r\n'
put 'my docs/notes one.md' 'n\n'
put gen.sh 'printf "not a real token\\n" > fresh.txt\n'
for i in $(seq -w 1 70); do
  put "mono/p$i/package.json" '{}\n'
  put "mono/p$i/src/index.ts" 'export {}\n'
done
put devloop.json '{"verify":["true"],"mode":"enforce","secrets":[".env","config/secrets/**"]}\n'
printf '#!/bin/sh\n' >.git/hooks/pre-commit
chmod +x .git/hooks/pre-commit
git add devloop.json src/a.ts src/b.ts token.txt package.json docs/a.md docs/b.md tests/a.test.ts
git commit -q --no-verify -m init
git checkout -q -b feature
ln -s ../config/secrets src/keys
ln -s ../config/secrets/deep src/deep
ln -s ../.env src/dotenv
ln -s ../.git/hooks src/gh
ln -s . here
ln -s nowhere dangling
ln -s config/secrets sk
mkdir -p tests/t1/t2
ln -s ../../../config/secrets tests/t1/t2/t3
ln -s src/a.ts tofile
ln -s ../config lib/cfg
ln -s ../../config/secrets mono/p05/keys
