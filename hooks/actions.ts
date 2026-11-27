/**
 * One slash command per devloop action, /devloop-<action>, so the `/` menu
 * lists them. Each is served by a hook that hands the action to the same
 * `command` handler /devloop uses.
 */

import type { Engine } from './state'

export type Action = { name: string; description: string; argumentHint?: string; isPolicyFree?: true }

/** Every top-level action in HELP except init, plus help. */
export const ACTIONS: readonly Action[] = [
  { name: 'allow', description: 'Exempt paths or one exact command from the guards for one turn', argumentHint: '<glob> | --command <exact command>' },
  { name: 'approve', description: "Approve the spec as written and unlock the build (a person's call)" },
  { name: 'audit', description: 'The last events of the audit trail', argumentHint: '[n]' },
  { name: 'budget', description: 'Set a cost cap for this session (an estimate)', argumentHint: '<usd>' },
  { name: 'cache', description: "Install, remove or inspect cache-guard, the prompt-cache tool", argumentHint: 'install [flags] | uninstall | doctor | report | status', isPolicyFree: true },
  { name: 'checklists', description: "The checklists in force, with each item's shadow results", argumentHint: 'adjudicate <list>/<item> <correct|wrong> | promote|demote <list>/<item>' },
  { name: 'claims', description: 'The claims sessions hold on the active spec, with their leases', argumentHint: 'release <feature>' },
  { name: 'continue', description: 'Allow more failed rounds on this branch past the loop limit', argumentHint: '[n]' },
  { name: 'defect', description: 'Record an escaped defect against a closed change', argumentHint: '<text> [--change <id>]' },
  { name: 'doctor', description: 'Audit the setup: context, instructions, skills, isolation, credentials', argumentHint: '[--strict]', isPolicyFree: true },
  { name: 'done', description: 'Close the change and reset the loop' },
  { name: 'eval', description: 'Run the eval suite, or resume an interrupted run', argumentHint: 'quick | --without <rule | file | skill> | validate | compare | adopt [id] | cancel' },
  { name: 'findings', description: 'Review findings: open, deferred backlog, resolved', argumentHint: 'resolve <id> <note>' },
  { name: 'followups', description: 'The pull requests the harness watches for you', argumentHint: 'stop [n]' },
  { name: 'gate', description: 'Prove the gate now and answer with an exit code, for CI' },
  { name: 'handoff', description: 'Append a facts-only handoff entry, or show earlier ones', argumentHint: 'show [n] | export <path>' },
  { name: 'help', description: 'Every devloop action, one per line', isPolicyFree: true },
  { name: 'hooks', description: 'A pre-push git hook that refuses a push that is not green', argumentHint: 'install | remove' },
  { name: 'learn', description: 'Waiting proposals, trial rules and repeated failures with the cheapest fix' },
  { name: 'lesson', description: 'Record something that went wrong', argumentHint: '<text>' },
  { name: 'library', description: 'The spec library: its folder, its entries, the last ten', argumentHint: 'path <dir> | save | remove <entry>', isPolicyFree: true },
  { name: 'metrics', description: "The loop's numbers", argumentHint: '[--json]' },
  { name: 'papercuts', description: "The agent's friction reports, grouped", argumentHint: 'close <group> <note>' },
  { name: 'prune', description: 'Rules with hits, last fired and eval evidence', argumentHint: 'remove <rule id> <evidence>' },
  { name: 'questions', description: "The builder's open questions for a person", argumentHint: 'close <id> <answer>' },
  { name: 'regressions', description: 'The regression checks kept from closed specs', argumentHint: 'drop <id> <reason>' },
  { name: 'report', description: 'A change report for a pull request body' },
  { name: 'review', description: 'Start an independent review round' },
  { name: 'rules', description: 'Learned rules: trial, promoted and waiting proposals', argumentHint: 'promote <id> | drop <id> <reason>' },
  { name: 'sandbox', description: 'Print the sandbox settings that match the policy' },
  { name: 'spec', description: 'Start or reopen a spec; only the spec and its tests change until approved', argumentHint: '<name>' },
  { name: 'verify', description: 'Run the fast and full verify checks now' },
]

/** A failed call's reason, as a person reads it: without the engine's `<plugin>: $.<call>:` lead or a closing period. */
export const reasonOf = (error: unknown): string =>
  (error instanceof Error ? error.message : String(error)).replace(/^(?:\w*Error: )?\S+: \$\.[\w.]+: /, '').replace(/\.$/, '')

/** What a person reads when a /devloop command throws or overruns: the real error, not the engine's generic line. */
export function failureText(args: string, error: { kind: 'throw' | 'timeout'; message?: string } | undefined): string {
  const reason = error?.kind === 'timeout' ? 'took too long' : (error?.message === undefined ? 'unknown error' : reasonOf(error.message))

  return `devloop: ${`/devloop ${args}`.trim()} failed: ${reason}. If it keeps happening, start Claude with --debug and share the log.`
}

export const commandName = (a: Action): string => `devloop-${a.name}`

/**
 * Register the actions: all of them, or only those that work without a
 * policy. A refused registration (the name is taken) skips that one command.
 * Answers the names that registered.
 */
export async function registerActions($: Engine, isSetUp: boolean): Promise<string[]> {
  const done: string[] = []
  for (const a of ACTIONS) {
    if (!isSetUp && a.isPolicyFree !== true) {
      continue
    }
    const registered = await $.command
      .register({ name: commandName(a), description: a.description, ...(a.argumentHint === undefined ? {} : { argumentHint: a.argumentHint }) })
      .then(() => true, () => false)
    if (registered) {
      done.push(commandName(a))
    }
  }

  return done
}
