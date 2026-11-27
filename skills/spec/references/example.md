# Example: a finished spec and its features

A small web app (Node, Express, a SQL database, tests with a test runner
under `tests/`) gains a password reset. This is a new feature, so the size is
full: three rounds of questions, 5 to 15 criteria. The names, paths and
commands below are an example; use the ones your repository has.

## specs/password-reset/SPEC.md

```markdown
# password-reset
Kind: new feature · Size: full
Related specs: login (the session and password hashing), email-verify (sending mail, token table)

## Intent
A user who has forgotten their password can set a new one from a link sent
to their email address, without help from support. Nobody else can use that
link, and asking for one does not reveal whether an address has an account.

## Context
- Sign-in lives in src/auth/login.ts; passwords are hashed with the helper in
  src/auth/hash.ts (reused, not changed).
- Mail goes through src/mail/send.ts; in tests it is replaced by the fake in
  tests/helpers/mail.ts, which records what was sent.
- email-verify already keeps single-use tokens in the tokens table
  (src/db/tokens.ts): this spec adds a "reset" kind beside "verify".
- Routes are registered in src/routes.ts; tests drive them with the request
  helper in tests/helpers/app.ts. One test file runs with
  `npm test -- tests/password-reset.test.ts`.

## Constraints
- The reset link must not show whether an address has an account (same page
  and the same answer time for a known and an unknown address).
- Tokens are stored hashed, as email-verify stores its tokens.
- No change to the login form or the session cookie.
- Works with the existing mail settings; no new service.

## Out of scope
- Changing a password while signed in (a separate spec).
- Text messages or other channels for the link.
- Locking an account after repeated reset requests.

## Acceptance criteria
1. Asking for a reset for a known address sends one email holding a link with a token.
2. Asking for a reset for an unknown address sends no email and shows the same confirmation page as for a known one.
3. Opening a valid link shows a form for a new password.
4. Submitting the form with a new password of at least 12 characters changes the password: the new one signs in and the old one does not.
5. A new password shorter than 12 characters is refused with a message, and the password is unchanged.
6. A link used once is refused on a second use.
7. A link older than 60 minutes is refused.
8. Asking for a second reset makes the first link invalid.
9. The email's wording and the confirmation page read clearly to a non-technical user (checked by a person).

## Risks and assumptions
- Assumed: every account has a verified email address (true since email-verify; older accounts were migrated then).
- Risk: the answer time could still differ for unknown addresses if mail sending is slow; criterion 2 checks the page, not the timing.
- Risk: a token left in server logs. The request logger must not log the query string of the reset route.

## Notes for the reviewer
- Criterion 9 is checked by a person: read the email text in src/mail/templates/reset.txt and the page in src/views/reset-sent.html.
- The paths that matter: src/auth/reset.ts (new), src/db/tokens.ts, src/routes.ts.
- This is wrong if a token is ever stored or logged in plain text.
```

## specs/password-reset/features.json

Every criterion but 9 is covered. Each `check` runs one named test and exits
0 only when that test passes. Before anything is built each one fails because
the route or the behaviour is missing (a 404, an email not sent), not
because of a typo or a missing test file.

```json
[
  {
    "id": "reset-email-known",
    "description": "a reset for a known address sends one email with a token link",
    "check": "npm test -- tests/password-reset.test.ts -t 'sends one email for a known address'",
    "criteria": [1],
    "dependsOn": []
  },
  {
    "id": "reset-email-unknown",
    "description": "an unknown address gets no email and the same page",
    "check": "npm test -- tests/password-reset.test.ts -t 'unknown address'",
    "criteria": [2],
    "dependsOn": []
  },
  {
    "id": "reset-form",
    "description": "a valid link shows the new-password form",
    "check": "npm test -- tests/password-reset.test.ts -t 'valid link shows the form'",
    "criteria": [3],
    "dependsOn": ["reset-email-known"]
  },
  {
    "id": "reset-sets-password",
    "description": "a long enough password is set; a short one is refused",
    "check": "npm test -- tests/password-reset.test.ts -t 'sets the new password'",
    "criteria": [4, 5],
    "dependsOn": ["reset-form"]
  },
  {
    "id": "reset-link-single-use",
    "description": "a used, expired or replaced link is refused",
    "check": "npm test -- tests/password-reset.test.ts -t 'refuses a spent link'",
    "criteria": [6, 7, 8],
    "dependsOn": ["reset-form"]
  }
]
```

## What the self-check reported (step 9)

- Kind new feature, size full: 9 criteria (5 to 15), all binary.
- 8 criteria covered by 5 features; criterion 9 checked by a person and
  listed for the reviewer.
- 5 checks run: each fails because the reset route answers 404 or no email
  is sent.
- No open question. Ready for the person to read and run `/devloop approve`.
