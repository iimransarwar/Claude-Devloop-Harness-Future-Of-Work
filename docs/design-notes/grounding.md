# Design note: check before you answer (grounding)

Asked for by the repository owner. The case that prompted it: a person asks
"does this update include every change required for entitlements, groups,
queues, list views, emails, alerts?" The answer they want begins "let me
check that against the org rather than from memory", is followed by real
reads of the system, and says what was checked. The answer they do not want
is a confident "yes" composed from what the agent remembers having done.

An agent's memory of its own work is a summary of a summary. It is wrong
often enough that an answer built on it is not evidence. The harness already
holds that the builder never grades itself; this note applies the same idea
to answers: **an answer about the state of things is checked at the source,
in the turn it is given.**

This note is the system of record for the feature. Its name in the policy
and in the code is `grounding`.

## What the harness can and cannot know

It cannot know whether a sentence is true. It can know three things, exactly:

1. what the person asked (the prompt, at `prompt.submit`);
2. which tools the agent used after that prompt and before it stopped (the
   module sees every call; the classic hook can read the same from the
   transcript);
3. the text of the final answer (`last_assistant_message` on the stop event).

From those it can tell an answer that rests on a look at the source from one
that rests on nothing, and it can tell the person which kind they got. That
is the whole mechanism; everything below is detail.

## Decisions

### 1. Three layers

**Rule (always, in a repository that has a policy).** The rules text the
agent sees at session start gains a short, byte-stable paragraph:

> A fact you remember, a summary, a memory file or an earlier turn is a
> lead, not a fact. Before you answer a question about the state of the
> code, the repository, a system or your own earlier work, and before you
> act on such a fact, look at the source in this turn: read the file, run
> the query, list the thing. Say what you checked. What you could not
> check, name as an assumption. If a question of fact comes up while you
> work, find out or ask (`devloop_question`); do not decide it by guess.

**Nudge (at the prompt).** When a person's prompt is a question of fact
(decision 2), one line is added to that turn's context: "This is a question
about the state of things: check the source before answering, and say what
you checked." Nothing is added to other prompts, so the cost is one line on
the turns that need it.

**Backstop (at the stop gate).** When such a turn ends with no look at any
source (decision 3), the stop is refused once with a message that says what
is missing and what to do. Details in decision 4.

### 2. What counts as a question of fact
A prompt typed by a person (not a slash command, not a harness or hook
message) that either:

- contains a question mark at the end of a sentence, or
- begins, after any greeting, with an interrogative or auxiliary word (does,
  do, did, is, are, was, were, has, have, had, can, could, will, would,
  should, what, which, who, whose, where, when, why, how), or
- contains one of the checking phrases: "confirm", "verify", "double check",
  "make sure", "are you sure", "is it true", "check whether", "check if",
  "did you", "have you".

`grounding.also` in the policy adds patterns; `grounding.never` removes
some. The classifier is a pure function with a table of examples in the
tests, including the prompting case above and its near neighbours ("add a
queue for the support team" is not a question; "can you add a queue?" is
one, and is satisfied by the work itself, see decision 3).

### 3. What counts as a look at the source
Any of these, by the main agent or a subagent it started, after the prompt
and before the stop:

- Read, Grep, Glob, a notebook read;
- a Bash call the shell model classifies as reading or as running a check
  (not `echo`, `sleep`, `true`, or a line that only writes);
- a web fetch or search;
- a call to any MCP tool other than the harness's own;
- `devloop_status` and `feature_check` (they read the tree and run checks);
- an edit or write also counts when the turn did work rather than only
  answering: a turn that changed the tree is judged by the ordinary gate,
  not by this one.

Reads in earlier turns do not count. That is deliberate: the tree may be
unchanged, but the systems most worth asking about (an org, a deployment, a
queue) change outside it, and the harness cannot tell which kind was asked
about. `grounding.fresh: "tree"` relaxes this for repositories where every
fact lives in the tree: a look in an earlier turn counts while the tree hash
is the same as it was then.

### 4. The backstop, exactly
At the stop of a turn that began with a question of fact and holds no look
at the source:

- **In enforce mode:** the stop is refused, once per turn, with:
  "You were asked a question about the state of things and answered without
  looking at anything in this turn. Check the source now (read the files,
  run the query, list the components), then answer and say what you checked.
  If nothing can be checked (an opinion, a general explanation), say that in
  one line and stop again." A second stop in the same turn is never refused
  for this. If it still holds no look, the person is told in a toast: "This
  answer was given without checking anything", and the event is recorded.
- **In observe mode:** nothing is refused; the toast and the record only.
- The check runs before the ordinary stop gate and never replaces it.
- It never fires on a turn no person started (a keep-warm ping, a hook
  message, a fix round), on a subagent's stop, or while a review is running.
- It never runs twice for one turn, so it cannot loop.

### 5. What the answer says
When a look did happen, the harness adds nothing and checks nothing about
the wording: the person can see the calls. The final answer's text is read
for one purpose only. If it contains wording that marks a guess ("from
memory", "as far as I recall", "I believe", "I assume", "probably",
"should be", "likely", "presumably") **and** the turn held no look at the
source, the toast quotes the phrase. With a look, hedged wording is honest
reporting of an assumption and is left alone.

### 6. Three enforcement points
- **The hooks module** does all of the above.
- **The classic hooks** do the same when the module did not judge the turn:
  a `UserPromptSubmit` hook adds the nudge; the `Stop` hook reads the
  transcript from the last person's prompt to the end, classifies the prompt
  with the same function and counts looks with the same function. If the
  transcript cannot be read, the check is skipped: this is advice about the
  quality of an answer, not a guard on what reaches a branch, so here, and
  only here, an unreadable input does not refuse. The design principle about
  unreadable input is amended to say so.
- **The command line** has nothing to judge (it has no turn), and says so.

### 7. Policy
```json
"grounding": { "mode": "enforce", "fresh": "turn", "also": [], "never": [] }
```
`mode` is `off`, `observe` or `enforce`. Left out, it follows the policy's
own mode (a repository observing observes; one enforcing enforces). A
repository with no policy is dormant, as for every other feature but the
secrets guard. Like every policy field it is read from the base branch.

### 8. What the person sees
- The Activity tab lists each answer given without a check, with the prompt's
  first line.
- Metrics gain two counts for the session and the store: questions of fact
  asked, and answers given without a look (after the backstop).
- `/devloop doctor` says which mode is in force.

### 9. What this does not do
It does not judge whether the look was the *right* look: reading one
unrelated file satisfies it. Closing that would need a second model to judge
relevance on every answer, which is the opposite of cheap by default; the
review at the gate remains the place where claims about a change are tested.
It does not detect a question the agent asks itself and answers by guess
mid-work; the rule text and `devloop_question` are what the harness offers
there. Both limits go into the residual-risk register.
