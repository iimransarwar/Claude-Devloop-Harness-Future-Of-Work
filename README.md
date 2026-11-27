# devloop

**Let the agent build. Keep the say over what ships.**

devloop is a Claude Code plugin that turns an AI coding agent into a
disciplined teammate. The agent writes the code. devloop decides when the
work is actually done, keeps the agent away from what it should not touch,
has the work checked by someone other than the agent that wrote it, and
leaves the merge to you.

<p align="center">
  <img src="docs/images/change-loop.svg" width="420" alt="One change, top to bottom: you ask; the agent edits inside the harness guard; when it stops the harness runs the checks that cover the changed files and hands a failure back; the agent tries to push; before the push lands the gate runs the full checks and a separate read-only reviewer reads the change; then the push goes through and you merge. Six failed rounds on one branch stop the agent.">
</p>

## Why devloop

- **Done means verified.** Your own test commands run every time the agent
  stops. A failure goes straight back to the agent. "It should work now" is
  not an answer.
- **The agent never grades itself.** A separate reviewer, in a fresh context
  and with read-only access, reads every code change before it can ship.
- **Guardrails, not babysitting.** Secret files, your policy, locked tests,
  destructive commands and production deploys are off limits. The agent is
  told why, and you are not asked to approve every step.
- **Specs it cannot quietly rewrite.** For bigger work you approve a spec
  with a check for each requirement. The checks lock, and a feature counts as
  done only when the harness has run its check.
- **It knows when to stop.** Capped fix and review rounds, and a hard stop
  after repeated failures, so a stuck agent reports back instead of burning
  a day.
- **It learns your project.** Repeated mistakes become proposed rules that
  run on trial first. You promote the ones that earn it.
- **Specs you can reuse.** Every finished spec is saved to your own library,
  so later work, in this project or another, starts from it.
- **Cheap to run.** devloop's own text never changes mid-session, so it
  never breaks Claude's prompt cache, and what it adds per prompt is small.
- **Checks before it answers.** Ask a question about the state of things and
  the agent is pushed to look at the source, not answer from memory.

## Quick start

1. Install the plugin:

   ```
   /plugin install devloop --marketplace youtube949/devloop
   ```

2. In your project, run `/devloop init`. It writes `devloop.json`, your
   project's policy, and suggests your test commands.
3. Open `devloop.json` and check the `verify` list: these are the commands
   that decide whether work is done.
4. Commit `devloop.json` to your main branch. The policy is always read from
   there, so a change cannot loosen its own rules.
5. Run `/devloop doctor` to see what is in force.
6. When you are happy with what it reports, change `"mode": "observe"` to
   `"mode": "enforce"`. In observe mode devloop only records what it would
   have stopped.

Requires Node 18 or later.

## Everyday use

Just ask the agent for what you want. devloop works in the background.

| Command | When |
| --- | --- |
| `/devloop` | See where the current change stands and what is left. |
| `/devloop spec <name>` | Start a spec for bigger work. |
| `/devloop approve` | Approve the spec. Its checks lock. |
| `/devloop review` | Ask for an independent review now. |
| `/devloop done` | Close the change after you have read it. |
| `/devloop continue` | Let the agent keep going after the loop limit stopped it. |
| `/devloop learn` | See the rules devloop has proposed from repeated failures. |
| `/devloop library` | See the specs saved for reuse across your projects. |
| `/devloop doctor` | Check the setup. |
| `/devloop help` | Every command. |

The agent may push a branch and open a pull request. Merging is yours.

## Bigger work: start from a spec

<p align="center">
  <img src="docs/images/spec-flow.svg" width="420" alt="The spec flow: you start a spec; the agent writes SPEC.md and one check per feature; the harness runs every check and flags one that already passes; you approve and the spec and tests lock; the agent builds one feature at a time and the harness runs that feature's check; when all pass the change goes through the normal loop.">
</p>

## A policy in a few lines

```json
{
  "mode": "enforce",
  "defaultBranch": "main",
  "verify": [
    "npm run -s typecheck",
    { "run": "npm test -s", "profile": "fast" },
    { "run": "npm run -s e2e", "profile": "full", "when": ["src/**", "e2e/**"] }
  ],
  "forbidden": [{ "pattern": "\\bpsql\\b.*prod", "why": "the production database is a person's" }],
  "network": { "allow": ["registry.npmjs.org", "github.com"] },
  "reviewers": [{ "name": "security", "when": ["**/auth/**"], "mode": "blocking" }]
}
```

`fast` checks run every time the agent stops. `full` checks run before
anything ships. `when` limits a check to the files it covers.

## Optional: cache-guard

A status line that shows what Claude's prompt cache is saving you, warnings
before moves that throw a warm cache away, and cost reports. Bundled, off by
default, needs Python 3.8 or later. Turn it on with `/devloop cache install`.

## Learn more

- [The full reference](docs/REFERENCE.md): every command, policy field and
  guard, and how each works.
- [The design](docs/DESIGN.md): why it works the way it does.
- [What it cannot do](docs/RESIDUAL-RISK.md): the known limits, written down.

## License

Apache-2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE).
