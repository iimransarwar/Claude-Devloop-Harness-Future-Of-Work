# Questions by kind and size

Use the section for the kind and size you confirmed in step 4. Each round is
one call to the ask-the-person tool with a few of the questions grouped.
Leave out any question the person already answered, or that the code,
`devloop.json` or an earlier spec answered: ask only about the gaps.

Questions are for what the code cannot say. Do not ask the person which
files are involved, which test framework is used or how a test is run: find
those out by reading the repository, and tell them what you found.

## Choosing the kind

Pick the kind from the person's words, then confirm it in one question with
the other kinds as choices.

- New feature: something the product cannot do yet ("add", "let users",
  "support", "new page").
- Integration: data or calls cross into another system ("sync", "import",
  "webhook", "call the API", "send to", "receive from").
- Change to existing behaviour: something works today and should work
  differently ("instead of", "change", "make it", "no longer").
- Bug fix: something does not work as intended ("broken", "error", "wrong",
  "crashes", "should but does not").
- Small task: no behaviour changes ("rename", "refactor", "bump", "move",
  "tidy", "config").

When two kinds fit, take the larger (an integration that also adds a page is
an integration). When the person disagrees, take theirs.

## Full: new feature

Round 1, intent and scope
- What should a user be able to do when this is done that they cannot now?
- Who is it for: which users, roles or callers?
- Why now: what problem does it solve, or what does it unblock?
- What is in scope, and what is deliberately left for later?
- Is there an earlier design, mock-up or decision to follow?

Round 2, constraints
- Does anything existing have to keep working exactly as it does (an API,
  a file format, a URL, stored data)?
- Are there limits on speed, size or load that matter here?
- Does it touch sign-in, permissions, personal data or money? Who may do
  what?
- Is there data to create, migrate or keep compatible?
- Must it run behind a switch, or for only some users at first?

Round 3, acceptance, edge cases and risks
- Here are the criteria I would write from your answers: which are wrong,
  and what is missing?
- What should happen with empty input, very large input, a duplicate, or a
  user without permission?
- What happens when a step fails half way?
- What would make you say this is wrong even if every check passed?
- What are we assuming that nobody has checked?

## Full: integration

Round 1, intent and scope
- What has to move between which systems, and in which direction?
- Who relies on it, and what do they do with the result?
- Which system is the source of truth for each piece of data?
- What is in scope now, and what comes later?

Round 2, constraints, mapping and failure
- How is the other side reached (an API, a file drop, a queue), and with
  what access? Is there documentation or a sandbox?
- Which field maps to which, and what happens to a value one side cannot
  hold?
- How often does it run, and how much data at a time?
- What happens when the other side is down, slow, or answers with an
  error? Retry, queue, alert, or give up?
- Can the same message arrive twice, and must that be harmless?
- Are there secrets, personal data or rate limits to respect?

Round 3, acceptance, edge cases and risks
- Here are the criteria I would write: which are wrong, and what is missing?
- How do we test it without the real other system (a stub, a recorded
  answer, a sandbox)?
- What would a partial failure leave behind, and how is it cleaned up?
- What are we assuming about the other system that nobody has checked?

## Standard: change to existing behaviour

Round 1, intent and scope
- What does it do now, and what should it do instead?
- Who notices the difference, and why does it matter to them?
- What must stay exactly as it is?
- Is anything that depends on the old behaviour (a caller, a report, a
  stored value) to be changed too, or left alone?

Round 2, acceptance and risks
- Here are the criteria I would write: which are wrong, and what is missing?
- Which edge case worries you most?
- Who could be hurt by the change, and how would we find out?
- What are we assuming that nobody has checked?

## Standard: bug fix

Round 1, the bug
- What are the steps to reproduce it?
- What did you expect, and what happened instead (the message, the wrong
  value, the screen)?
- Where does it happen: which page, command, input, user or environment?
- Since when, and does it always happen or only sometimes?
- Is there a workaround people use today?

Round 2, acceptance and risks
- Criterion 1 is the reproduction as a test. Here it is: is it the case you
  saw?
- Here are the other criteria I would write: which are wrong, and what is
  missing?
- Are there similar cases that should be fixed too, or deliberately not?
- What could the fix break?

## Lite: small task

One round
- What exactly changes?
- What must not change (behaviour, public names, output)?
- How do we know it is done: which command passes, which file looks how?

For a refactor, the usual criteria are that the existing tests still pass
and that a named thing has moved or been renamed. A check that already
passes cannot show that a refactor happened: pair it with one that fails now,
such as a check that the old name or file is gone.

## Turning answers into criteria

- One behaviour per criterion, written so a tester can say yes or no.
- Say the input and the expected result: "a wrong password three times in
  ten minutes locks the account for 15 minutes", not "lockout works".
- Name the error path as its own criterion when it matters.
- A criterion only a person can judge (how it looks, whether a text reads
  well) is kept, marked `(checked by a person)`, and gets no feature.
- When the person cannot answer, write `[NEEDS CLARIFICATION: <the
  question>]` in the spec instead of a criterion you made up.
