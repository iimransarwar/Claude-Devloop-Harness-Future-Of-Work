# cache-guard in this repository

This folder is cache-guard, the repository owner's own tool, included in
devloop at their request. It is copied unchanged from
<https://github.com/iimransarwar/cache-guard-for-claude>, commit
`5a37bf0c1ff61f5a26eb8e6807901eadc06d1244` (v2.6.0). `VENDORED.json` records
the source, the commit, the version and a SHA-256 for every copied file, and
`tests/smoke.sh` fails when a copied file differs from it.

Copyright the cache-guard author (github.com/iimransarwar). cache-guard is
licensed under the Apache License, Version 2.0: see `LICENSE` in this folder
(the same text as the repository's own `LICENSE`).

Two files here are this repository's own, not upstream's: this `NOTICE.md`
and `LICENSE`. `VENDORED.json` lists them under `added`, apart from the
copied files.

## Updating it

Nothing in devloop edits the copied files. To update, check out the new
upstream commit and run, from the root of this repository:

```bash
bash scripts/vendor-cache-guard.sh <path to the cache-guard-for-claude checkout>
```

It copies the files again (and the Lean style to `output-styles/lean.md`),
keeps `LICENSE` and this note, and regenerates `VENDORED.json`. Update the
commit named above, then run `bash tests/smoke.sh`.
