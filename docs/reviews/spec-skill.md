# The spec interview skill: what was checked

Spec: `docs/design-notes/spec-interview.md`. Built by Opus at `cf2e583`.
Targeted checks only, and one real session. No independent review round.

## Targeted checks (mine)

- Type check with unused locals and parameters: exit 0.
- `claude plugin validate .`: passes; it lists the skill as `devloop:spec`.
- The committed bundle equals a rebuild (the skill and the template are not
  in the command-line bundle).
- The shipped `skills/spec/SKILL.md` passes doctor's skill audit and
  injection scan with no warning (run on the real file): description 286
  characters, 131 lines, numbered steps, commands and checks, an
  error-recovery table.
- `spec`, `d2` and `b21` test files (everything that drives `/devloop spec`):
  119 pass, 0 fail.
- No company-specific text in the skill (searched for the terms of the skill
  it was modelled on).

The real-file lint is a block in `tests/smoke.sh`, since the plugin test
runner has no file system; I ran that block on its own, not the smoke test.

## Run for real

A throwaway repository with a small Node app, one earlier spec
(`login-lockout`, which injects a clock so tests do not sleep) and a frozen
copy of `cf2e583`.

1. `/devloop spec password-reset`, typed as the person: the spec phase
   opened and the new template was written.
2. A headless session was asked to spec a password reset (request by
   username, a one-time token valid for 30 minutes, email out of scope), and
   told the person was away. It loaded `devloop:spec` by itself, read the
   earlier spec and took its injected-clock approach and test layout
   (written on the `Related specs:` line), read the code, chose "new
   feature, full", wrote 13 numbered criteria, nine features each with its
   own check, and the tests in `test/password-reset.test.mjs`. It ran all
   nine checks and reported each failing because the behaviour is missing.
   The five questions it could not settle without the person are marked
   `[NEEDS CLARIFICATION]`, so approval stays refused until they are
   answered. It built nothing: `src/auth.mjs` was untouched.

## Not run for real

The interview rounds themselves (a headless session has no person to ask),
and the lite and standard sizes.

# The shared spec library: what was checked

Spec: `docs/design-notes/spec-library.md`. Built by Opus at `17a9d2a`.
Targeted checks only. No independent review round.

- Type check exit 0; validate passes; the bundle equals a rebuild.
- `library`, `c2`, `c2pure`, `loop`, `residual` and `guards` test files: 255
  pass, 0 fail (my run). The builder's runs over 20 more files passed after
  one fix.
- The spec skill still passes the skill audit (137 lines) and now searches
  the library with `devloop_library`.

Run for real: `/devloop library` and `/devloop library save` in a headless
session were refused as "a person's to manage, from the prompt". A headless
`claude -p` prompt does not count as a person at the prompt, the same as for
`/devloop approve` and `/devloop done`, so the save at `/devloop done`, the
path setting and the search over saved entries were not run for real; they
have module tests only. They need an interactive session.
