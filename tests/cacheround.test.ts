import { describe, expect, test } from 'claude-code/testing'

import { braceExpand } from '../hooks/shell'
import { parseConfig } from '../hooks/config'
import type { Config } from '../hooks/config'
import { shippingOf, shipRules } from '../hooks/enforce'
import { expandAllNow, expandGlob, expandGlobReviewed, GLOB_CAP } from '../hooks/glob'
import type { Listing } from '../hooks/glob'
import { digest } from '../hooks/output'
import { isOlderEvidence, OLDER_NOTE, reviewRowFrom } from '../hooks/portable'
import type { EvidenceNote } from '../hooks/portable'
import { FRESH } from '../hooks/state'
import { budgetRefusals, GLOB_BUDGET, globWords, judgeCommand, judgeCommandAll, LINK_BUDGET, linkPlaces, reviewerMayRun, whereOf, WRITE_LINK_BUDGET } from '../hooks/rules'
import type { Placed, Where } from '../hooks/rules'
import { tasksCommandRefusals } from '../hooks/tasks'
import { approved, bash, devloop, edit, start, stop, world } from './world'
import type { Dollar, World } from './world'

// The cache-guard round (docs/reviews/cache-guard-round.md): each decision's
// closing evidence, pure where the decision is a pure rule and through the
// engine where it is about the engine. The parity table (tests/parity-table.ts)
// carries the same spellings through all three enforcement points.

const cfgOf = (raw: object = {}): Config => parseConfig(JSON.stringify({ mode: 'enforce', verify: ['npm test'], ...raw })).cfg
const cfg = cfgOf()
const at: Where = whereOf('/repo', '/repo', { home: '/home/u', tmp: '/tmp', stateRoot: '/data/devloop', branch: 'feature', env: { CLAUDE_PLUGIN_DATA: '/data/devloop' } })
const rule = (command: string, where: Where = at, config: Config = cfg): string | null => judgeCommand(command, config, FRESH, where)?.rule ?? null
const ship = (command: string, branch = 'feature') => shipRules(shippingOf(command, branch, 'main'), branch, cfg, 'low', {})

// ---------------------------------------------------------------- R1 (P-A)

describe('R1: the agent pushes in one shape; anything else is refused with the command to run instead', () => {
  test('the spellings that named no source, or configured git, are refused by the shared shipping rules', () => {
    for (const command of [
      'git push origin :', 'git push --al origin', 'git push --mirr origin', 'git -c push.default=matching push origin', 'git -c remote.origin.push=refs/heads/x:refs/heads/main push origin',
      'git push', 'git push origin', 'git push origin HEAD feature', 'git push origin "HEAD:$B"', 'git push origin HEAD~1:feature', 'git push origin abc1234:feature', 'git push origin @:feature',
      'git push -uv origin HEAD', 'git push --set-up origin HEAD', 'git push --tags origin HEAD', 'git --config-env=core.x=Y push origin HEAD', 'git --namespace=n push origin HEAD',
      'git --git-dir=.git push origin HEAD', 'git -C . push origin HEAD', 'GIT_SSH_COMMAND=x git push origin HEAD', 'git push origin "refs/heads/*"',
    ]) {
      expect({ command, rule: ship(command)?.rule }).toEqual({ command, rule: 'gate' })
    }
    expect(ship('git push')?.reason).toMatch(/not of the one shape[\s\S]*`git push -u origin HEAD`/)
    expect(ship('git push --al origin')?.reason).toMatch(/--al, which names no source/)
    // Its harmless neighbours: the shape, with the options it may carry, spelled in full.
    for (const command of [
      'git push -u origin HEAD', 'git push origin feature', 'git push origin HEAD:refs/heads/feature', 'git push --set-upstream origin feature', 'git push -n origin HEAD', 'git push --dry-run -v origin HEAD',
      'git push --quiet --atomic origin HEAD', 'git push --porcelain --no-progress origin HEAD', 'git push --force-with-lease origin HEAD', 'git push --force-with-lease=feature:abc origin feature', 'git --no-pager push origin HEAD',
      'git push -- origin HEAD',
    ]) {
      expect({ command, verdict: ship(command) }).toEqual({ command, verdict: null })
    }
  })

  test('N1 (ninth round): the destination is a plain branch name or refs/heads/<name>; git\'s other spellings are refused', () => {
    for (const command of ['git push origin HEAD:heads/main', 'git push origin HEAD:heads/feature', 'git push origin HEAD:tags/v1', 'git push origin HEAD:refs/tags/v1', 'git push origin HEAD:remotes/origin/main', 'git push origin HEAD:refs/remotes/origin/main', 'git push origin heads/feature', 'git push -u origin feature:heads/feature']) {
      expect({ command, rule: ship(command)?.rule }).toEqual({ command, rule: 'gate' })
    }
    expect(ship('git push origin HEAD:heads/main')?.reason).toMatch(/the destination heads\/main \(spell it in full, as `HEAD:refs\/heads\/<branch>`/)
    // Changed by the tenth round, D3: a destination after a colon is spelled in full, so an unqualified one is refused
    // with the spelling to use; the branch checked out as refs/heads/<name>, or with no colon, gets no shape verdict.
    for (const command of ['git push origin HEAD:feature', 'git push origin HEAD:meta/base', 'git push origin feature:feature', 'git push origin HEAD:main']) {
      expect({ command, rule: ship(command)?.rule }).toEqual({ command, rule: 'gate' })
    }
    expect(ship('git push origin HEAD:feature')?.reason).toMatch(/the destination feature \(spell it in full, as `HEAD:refs\/heads\/feature`/)
    for (const command of ['git push origin HEAD:refs/heads/feature', 'git push origin refs/heads/feature', 'git push origin feature:refs/heads/feature', 'git push origin HEAD', 'git push origin feature']) {
      expect({ command, verdict: ship(command) }).toEqual({ command, verdict: null })
    }
    // The more specific refusals still fire first: a forced push, and the default branch spelled in full.
    expect(rule('git push origin +HEAD:feature')).toBe('force-push')
    expect(shipRules(shippingOf('git push origin HEAD:refs/heads/main', 'feature', 'main'), 'feature', cfg, 'medium', { HEAD: ['src/a.ts'] })?.rule).toBe('human-merge')
    // The notes keep their own, more specific refusal, which fires first.
    expect(rule('git push origin HEAD:refs/notes/devloop')).toBe('evidence-notes')
  })

  test('a GIT_* variable set anywhere on a shipping line is refused there, by ship-alone or by the shape', () => {
    expect(rule('export GIT_DIR=/srv/x; git push -u origin HEAD')).toBe('ship-alone')
    expect(ship('GIT_TRACE=1 git push -u origin HEAD')?.reason).toMatch(/GIT_TRACE set on the line/)
    expect(ship('env GIT_CONFIG_GLOBAL=/tmp/g git push -u origin HEAD')?.rule).toBe('gate')
  })

  test('the destination rules still run after the shape: the default branch, another branch, the notes', () => {
    expect(ship('git push origin other')?.reason).toMatch(/ships other, which is not the branch you are on/)
    expect(shipRules(shippingOf('git push origin HEAD:refs/heads/main', 'feature', 'main'), 'feature', cfg, 'medium', { HEAD: ['src/a.ts'] })?.reason).toMatch(/medium-risk change on main/)
    expect(rule('git push origin refs/notes/devloop')).toBe('evidence-notes')
    // ship-alone still holds a push beside a write.
    expect(rule('git commit -am x && git push -u origin HEAD')).toBe('ship-alone')
  })

  test('git options are matched as git matches them, by prefix, over-refusing on ambiguity; quoting does not hide one', () => {
    expect(rule('git update-index --skip-w src/a.ts')).toBe('git-hidden')
    expect(rule('git update-index --assume src/a.ts')).toBe('git-hidden')
    expect(rule('git push --forc origin feature')).toBe('force-push')
    expect(rule('git push "--force" origin feature')).toBe('force-push')
    expect(rule('git push --fo origin feature')).toBe('force-push')
    expect(rule('git commit --no-verif -m x')).toBe('no-verify')
    expect(rule('git reset --har')).toBe('destructive')
    expect(rule('git clean --forc -d')).toBe('destructive')
    expect(rule('git branch --del old')).toBe('destructive')
    expect(rule('git push --mirr origin')).toBe('evidence-notes')
    expect(rule('git -c core.hooksPath=/dev/null commit -m x')).toBe('no-verify')
    expect(rule('git --config-env=core.hooksPath=H commit -m x')).toBe('no-verify')
    // The neighbours: the bits cleared, a dry run, a message that mentions an option, an option that only lets a command off spelled in full.
    for (const command of ['git update-index --no-skip-worktree src/a.ts', 'git clean -n', 'git clean --dry-run -f', 'git commit -m "skip --no-verify next time"', 'git rm --cached src/a.ts', 'git restore --staged .']) {
      expect({ command, verdict: rule(command) }).toEqual({ command, verdict: null })
    }
    // An exempting option abbreviated is not taken as given: `git rm --cach` may be anything, so it writes (a test file here).
    expect(judgeCommand('git rm --cach tests/a.test.ts', cfg, FRESH, at)?.rule).toBe('test-weakened')
    // The other git options the rules read, on the same helper: the file git diff or git config writes, by any prefix.
    expect(rule('git diff --outp=devloop.json')).toBe('protected')
    expect(rule('git log --output devloop.json')).toBe('protected')
    expect(rule('git config --fil=devloop.json a.b c')).toBe('protected')
    expect(rule('git diff --stat')).toBe(null)
    expect(rule('git merge --abort')).toBe(null)
  })
})

// ---------------------------------------------------------------- R2 (P-B)

describe('R2: a value the model cannot compute is the evidence ref', () => {
  test('the notes ref by a computed export, an inline variable, --ref, update-ref, symbolic-ref and a fetch destination', () => {
    for (const command of [
      'export GIT_NOTES_REF=$(echo refs/notes/devloop); git notes add -m x', 'GIT_NOTES_REF=$A git notes add -m x', 'export GIT_NOTES_REF=$A; git notes add -m x',
      'git notes --ref "$R" add -m x', 'git notes --re=$R add -m x', 'git update-ref "$R" HEAD', 'git update-ref refs/notes/devloop HEAD',
      'git symbolic-ref refs/notes/devloop refs/heads/x', 'git symbolic-ref "$R" refs/heads/x', 'git fetch origin "x:$R"', 'git pull origin "refs/notes/x:$R"',
      'git fetch --refmap="$M" origin', 'git -c remote.origin.fetch=+refs/notes/*:refs/notes/* fetch origin', 'GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=core.notesRef GIT_CONFIG_VALUE_0=refs/notes/devloop git notes add -m x',
      'git push origin "$REF"',
    ]) {
      expect({ command, rule: rule(command) }).toEqual({ command, rule: 'evidence-notes' })
    }
    for (const command of ['git symbolic-ref --short HEAD', 'git notes --ref=review add -m x', 'git fetch origin main', 'git update-ref refs/heads/x HEAD', 'export X=$(date); git notes --ref=review add -m x']) {
      expect({ command, verdict: rule(command) }).toEqual({ command, verdict: null })
    }
  })

  test('the actor variable: any value, computed or not, is another actor', () => {
    const facts = { isOn: true, canFinish: null, finishWhy: '' }
    expect(tasksCommandRefusals('TASKS_ACTOR=$(whoami) tasks pause web/login -m x', facts).map(one => one.rule)).toEqual(['tasks'])
    expect(tasksCommandRefusals('export TASKS_ACTOR=$A; tasks pause web/login -m x', facts)[0]?.reason).toMatch(/TASKS_ACTOR=…/)
  })
})

describe('P-B: the eval worktree\'s containment, always held, takes a write to a path the model cannot compute for one outside', () => {
  test('through the module', async ($, on) => {
    const w = world(on)
    w.files['/repo/evals/tasks/one.json'] = JSON.stringify({ prompt: 'do it', check: 'npm test -- one' })
    w.lists['/repo/evals/tasks'] = ['one.json']
    w.exits['npm test -- one'] = [1, 0]
    await start($)
    w.answer = 'Start the run'
    expect(await devloop($, 'eval')).toMatch(/Eval run started: 1 task/)
    const agent = w.spawned[0]
    const dir = agent?.cwd ?? ''
    for (const command of ['cp a.txt "$OUT"', 'echo x > "$(git rev-parse --show-toplevel)/../x"', 'D=$(mktemp -d); echo x > $D/f']) {
      expect({ command, deny: (await bash($, command, agent?.agentId)).deny }).toEqual({ command, deny: expect.stringMatching(/only inside its own worktree/) })
    }
    // Its harmless neighbours: a literal path in the worktree, a variable the line sets to one.
    for (const command of [`echo x > ${dir}/out.txt`, `D=${dir}/tmp; echo x > $D/f`]) {
      expect({ command, deny: (await bash($, command, agent?.agentId)).deny }).toEqual({ command, deny: undefined })
    }
  })
})

// ---------------------------------------------------------------- R3: the reviewer's checks

describe('R3: the reviewer runs the base policy\'s checks, and feature checks only of a spec a person approved, while building', () => {
  const asking = (on: Parameters<typeof world>[0]): string[] => {
    const asked: string[] = []
    on('tool.check', () => ({ decision: 'ask' }))
    on('classic.PermissionRequest', (_, e) => {
      asked.push(String((e as { command?: string; tool_input?: { command?: string } }).tool_input?.command ?? ''))

      return { hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'deny', message: 'nobody is here' } } } as never
    })

    return asked
  }
  const review = async ($: Dollar, w: World): Promise<string> => {
    w.changed = ['src/a.ts']
    w.tree = 't1'
    await edit($, '/repo/src/a.ts')
    await stop($)
    expect(await devloop($, 'review')).toMatch(/started/)

    return w.spawned[w.spawned.length - 1]?.agentId ?? ''
  }

  test('a spec-phase feature check is never answered for the reviewer (its guard refuses it); the base policy\'s check is', async ($, on) => {
    const w = world(on)
    const asked = asking(on)
    await start($)
    w.files['/repo/specs/login/SPEC.md'] = '# login'
    w.files['/repo/specs/login/features.json'] = JSON.stringify([{ id: 'a', description: 'd', check: 'npm test -- login' }])
    expect(await devloop($, 'spec login')).toMatch(/login/)
    const id = await review($, w)
    asked.length = 0
    const spec = await $.tool.call({ tool: 'Bash', command: 'npm test -- login', agentId: id } as never)
    expect(spec.deny ?? (asked.length > 0 ? 'asked' : undefined)).toBeDefined()
    expect((await $.tool.call({ tool: 'Bash', command: 'npm test', agentId: id } as never)).isError).toBeUndefined()
  })

  test('while building an approved spec its feature checks are the reviewer\'s; once the spec on disk changes, they are not', async ($, on) => {
    const w = world(on)
    asking(on)
    await start($)
    await approved($, w)
    const id = await review($, w)
    expect((await $.tool.call({ tool: 'Bash', command: 'npm test -- bad-password', agentId: id } as never)).isError).toBeUndefined()
    w.files['/repo/specs/login/SPEC.md'] = '# login, rewritten by the builder'
    expect((await $.tool.call({ tool: 'Bash', command: 'npm test -- bad-password', agentId: id } as never)).deny).toMatch(/reviewer is read-only/)
  })
})

// ---------------------------------------------------------------- R5, R6, R10, R11: the reviewer's permission answer

describe('R5: only the engine\'s own default ask is answered', () => {
  for (const [key, value] of [['rule', 'Read(*)'], ['hook', 'PreToolUse'], ['setting', 'permissions.blockReadsOutsideWorkingDirectories'], ['plugin', 'other-plugin']] as const) {
    test(`an ask carrying \`${key}\` stands for the reviewer's read`, async ($, on) => {
      const w = world(on)
      const asked: string[] = []
      on('tool.check', () => ({ decision: 'ask', [key]: value }) as never)
      on('classic.PermissionRequest', (_, e) => {
        asked.push(String((e as { tool_name?: string }).tool_name ?? ''))

        return { hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'deny', message: 'nobody' } } } as never
      })
      w.files['/repo/src/a.ts'] = 'export const a = 1\n'
      await start($)
      w.changed = ['src/a.ts']
      w.tree = 't1'
      await edit($, '/repo/src/a.ts')
      await stop($)
      await devloop($, 'review')
      asked.length = 0
      const id = w.spawned[w.spawned.length - 1]?.agentId ?? ''
      const said = await $.tool.call({ tool: 'Read', file_path: '/repo/src/a.ts', agentId: id } as never)
      // `plugin` is pinned by the engine and dropped from a hook's answer; the others reach the module, which leaves them standing.
      expect(key === 'plugin' || said.isError === true).toBe(true)
      expect(key === 'plugin' || asked.length === 1).toBe(true)
    })
  }
})

describe('R6, R10: what the reviewer runs without a prompt lands inside the repository, or is the diff file', () => {
  const facts = (resolve: (path: Placed) => readonly Placed[] | null = path => [path]) => ({ where: whereOf('/repo', '/repo', { home: '/home/u' }), cfg, diffFile: '/data/r/review-1.diff', checks: ['npm test'], resolve })

  test('a read through a link inside the repository that leads outside is not answered (R6)', () => {
    const outside = (path: Placed): Placed[] | null => (path.abs === '/repo/docs/hosts' ? [{ spelled: '/etc/hosts', abs: '/etc/hosts', rel: null }] : [path])
    expect(reviewerMayRun('Read', { file_path: '/repo/docs/hosts' }, facts(outside))).toBe(false)
    expect(reviewerMayRun('Grep', { pattern: 'x', path: '/repo/docs/hosts' }, facts(outside))).toBe(false)
    expect(reviewerMayRun('Read', { file_path: '/repo/docs/a.md' }, facts(outside))).toBe(true)
    // Where the hook could not tell where a path lands, nothing is answered.
    expect(reviewerMayRun('Read', { file_path: '/repo/docs/a.md' }, facts(() => null))).toBe(false)
  })

  test('a command whose path operand lies outside, cannot be placed or is not classified still asks (R10)', () => {
    for (const command of ['cat /etc/hosts', 'find / -name x', 'grep -r token /home/u', 'cat ../other/x', 'ls /', 'git diff --no-index /etc/passwd src/a.ts', 'jq --arg a b . data.json', 'grep -f /etc/patterns x src']) {
      expect({ command, answered: reviewerMayRun('Bash', { command }, facts()) }).toEqual({ command, answered: false })
    }
    expect(reviewerMayRun('Bash', { command: 'npm test', dangerouslyDisableSandbox: true }, facts())).toBe(false)
    expect(reviewerMayRun('Bash', { command: 'cat src/a.ts', run_in_background: true }, facts())).toBe(false)
    expect(reviewerMayRun('Read', { file_path: '/repo/src/a.ts', dangerouslyDisableSandbox: true }, facts())).toBe(false)
    for (const command of ['cat src/a.ts', 'grep -rn TODO src', 'ls src', 'find src -name "*.ts"', 'git diff --stat', 'cat /data/r/review-1.diff', 'wc -l src/a.ts | sort', 'jq .name package.json', 'npm test']) {
      expect({ command, answered: reviewerMayRun('Bash', { command }, facts()) }).toEqual({ command, answered: true })
    }
  })
})

describe('R11: the diff file is checked before the reviewer reads it; a changed one is written again, recorded and told, and the read goes on', () => {
  test('through the module', async ($, on) => {
    const w = world(on)
    on('tool.check', () => ({ decision: 'ask' }))
    const diff = `/data/devloop/repos/${digest('/repo')}/review-1.diff`
    w.files[diff] = 'diff --git a/src/a.ts b/src/a.ts\n'
    await start($)
    w.changed = ['src/a.ts']
    w.tree = 't1'
    await edit($, '/repo/src/a.ts')
    await stop($)
    await devloop($, 'review')
    const id = w.spawned[w.spawned.length - 1]?.agentId ?? ''
    const written = w.scripts.filter(one => one === 'review-diff').length
    // A read of the untouched file rewrites nothing.
    expect((await $.tool.call({ tool: 'Read', file_path: diff, agentId: id } as never)).deny).toBeUndefined()
    expect(w.scripts.filter(one => one === 'review-diff').length).toBe(written)
    // Something wrote into the harness's state: the read still goes on, after the harness writes the diff again.
    w.files[diff] = 'forged: nothing to see here\n'
    expect((await $.tool.call({ tool: 'Read', file_path: diff, agentId: id } as never)).deny).toBeUndefined()
    expect(w.scripts.filter(one => one === 'review-diff').length).toBe(written + 1)
    expect(w.toasts.some(one => /review's diff file \(round 1\) was changed after the harness wrote it/.test(one))).toBe(true)
    expect(await devloop($, 'audit 5')).toMatch(/harness-state-changed/)
  })

  test('a path held in a variable no longer writes the diff file unseen: the line\'s own and the named variables are replaced (R8)', () => {
    expect(rule('D=/data/devloop/repos/x; echo forged > $D/review-1.diff')).toBe('harness-state')
    expect(rule('echo forged > "$CLAUDE_PLUGIN_DATA/repos/x/review-1.diff"')).toBe('harness-state')
  })
})

// ---------------------------------------------------------------- R7, R8: protected and secret folders

describe('R7: a protected or secret pattern\'s folder is not replaced, written into, moved or linked over; nor an ancestor removed', () => {
  test('every way the review found, for ~/.claude/cache-guard, ~/.claude/hooks and ~/.claude/plugins', () => {
    for (const [command, expected] of [
      ['cp x ~/.claude/cache-guard', 'secret'], ['tar xf a.tar -C ~/.claude/cache-guard', 'secret'], ['rsync -a x ~/.claude/cache-guard', 'secret'], ['mv ~/.claude/cache-guard /tmp/x', 'secret'],
      ['ln -s /tmp/evil ~/.claude/cache-guard', 'secret'], ['cd ~/.claude/cache-guard && cp x .', 'secret'], ['rm -rf ~/.claude', 'secret'], ['mv ~/.claude /tmp/old', 'secret'],
      ['cp x ~/.claude/hooks', 'protected'], ['tar -xzf a.tgz --directory=$HOME/.claude/plugins', 'protected'], ['ln -sfn /tmp/p ~/.claude/plugins', 'protected'], ['cp -r hooks ~/.claude/', 'protected'],
      ['cp x /srv/other/.git/hooks', 'protected'], ['rm -rf .git', 'protected'],
    ] as const) {
      expect({ command, rule: rule(command) }).toEqual({ command, rule: expected })
    }
    // Harmless neighbours: a copy beside the folder, into a temporary one, a folder of the same name elsewhere that no pattern guards.
    for (const command of ['cp x /tmp/cache-guard', 'mkdir -p /tmp/a && cp x /tmp/a', 'cp -r src /tmp/src-copy', 'rm -rf /tmp/build', 'ln -s ../shared src/shared']) {
      expect({ command, verdict: rule(command) }).toEqual({ command, verdict: null })
    }
  })
})

describe('R8: secret paths by every spelling the review found', () => {
  test('$HOME, a variable set on the line, a wildcard, braces, a cd, a recursive read or copy of the folder above', () => {
    const disk: Where = { ...at, globs: { '/home/u/.claude/cache-guard/handoffs/*.md': ['/home/u/.claude/cache-guard/handoffs/s1.md'], '/repo/.en?': ['/repo/.env'] } }
    for (const command of [
      'cat $HOME/.claude/cache-guard/handoffs/s1.md', 'cat "${HOME}/.aws/credentials"', 'H=/home/u; cat $H/.claude/cache-guard/logs/x.log', 'cat ~/.claude/cache-guard/handoffs/*.md', 'cat .en?',
      'cat ~/.claude/cache-guard/{handoffs,state}/x', 'cd ~/.claude/cache-guard/handoffs && cat s1.md', 'grep -r goal ~/.claude/cache-guard', 'cp -r ~/.claude /tmp/x', 'rg token ~/.claude', 'tar czf /tmp/x.tgz ~/.claude/cache-guard',
    ]) {
      expect({ command, rule: judgeCommand(command, cfg, FRESH, disk)?.rule }).toEqual({ command, rule: 'secret' })
    }
    // A recursive read of a folder with no secret pattern's folder beneath it is R8 in the register; a variable the line computes is R2.
    for (const command of ['grep -r API_KEY .', 'grep -rn TODO src', 'cp -r src /tmp/x', 'cat "$(cat name)"', 'cat ~/.claude/cache-guard/config.json']) {
      expect({ command, verdict: judgeCommand(command, cfg, FRESH, disk)?.rule ?? null }).toEqual({ command, verdict: null })
    }
  })

  test('a folder-anchored secret glob makes a recursive read of the folder above it a read of the secret', () => {
    const anchored = cfgOf({ secrets: ['.env', 'config/secrets/**'] })
    expect(rule('grep -r token config', at, anchored)).toBe('secret')
    expect(rule('grep -r token .', at, anchored)).toBe('secret')
    expect(rule('grep -r token src', at, anchored)).toBe(null)
  })

  test('never from the environment for a variable the line set to a value the model cannot compute', () => {
    expect(rule('HOME=$(mktemp -d); cat $HOME/.aws/credentials')).toBe(null)
    expect(rule('HOME=/home/u; cat $HOME/.aws/credentials')).toBe('secret')
  })
})

// ---------------------------------------------------------------- R9 and P-C: one expander

describe('R9, P-C: a wildcard is judged by what it matches on disk, by one expander', () => {
  const tasks: Where = { ...at, tasks: { isOn: true, canFinish: null, finishWhy: '' }, filesUnder: {} }
  const tasked = cfgOf({ tasks: { integrate: 'enforce' } })

  test('brackets and braces against the task tree and the policy file, with matches on disk and without', () => {
    const disk: Where = { ...tasks, globs: { '/repo/.tasks/we[b]/*/task.md': ['/repo/.tasks/web/login/task.md'], '/repo/devloop.jso[n]': ['/repo/devloop.json'] } }
    expect(judgeCommandAll('rm .tasks/we[b]/*/task.md', tasked, FRESH, disk).map(one => one.rule)).toContain('tasks')
    expect(judgeCommandAll('echo x > .tasks/web/login/{task,log}.md', tasked, FRESH, tasks).map(one => one.rule)).toContain('tasks')
    expect(rule('rm devloop.jso[n]', disk)).toBe('protected')
    // With nothing on disk, the bracket is judged as written, and a glob class in it reaches the locked name all the same.
    expect(rule('rm devloop.jso[n]')).toBe('protected')
    expect(rule('touch {devloop,x}.json')).toBe('protected')
    expect(judgeCommandAll('echo x > .tasks/web/login/{state,notes}.md', tasked, FRESH, tasks).map(one => one.rule)).toEqual([])
  })

  test('past the cap, a write is refused and a read is judged as a recursive read of its literal folder', () => {
    const many: Where = { ...at, globs: { '/repo/gen/*': 'capped', '/home/u/.claude/cache-guard/*/x': 'capped' } }
    expect(rule('rm gen/*', many)).toBe('protected')
    expect(rule('cat gen/*', many)).toBe(null)
    expect(rule('cat ~/.claude/cache-guard/*/x', many)).toBe('secret')
  })

  test('the expander: brace expansion first and with no file needed; the other wildcards match what is there; nothing matched is the literal', () => {
    expect(braceExpand('{task,log}.md')).toEqual(['task.md', 'log.md'])
    expect(braceExpand('a{1..3}b')).toEqual(['a1b', 'a2b', 'a3b'])
    expect(braceExpand('x\\{a,b\\}')).toEqual(['x\\{a,b\\}'])
    expect(braceExpand('{1..500}')).toBe(null)
    const disk: Record<string, Listing> = {
      '/repo': [{ name: '.env', isDir: false }, { name: 'src', isDir: true }, { name: 'a.ts', isDir: false }],
      '/repo/src': [{ name: 'a.ts', isDir: false }, { name: 'b.js', isDir: false }],
    }
    expect(expandGlob('/repo/src/*.ts', dir => disk[dir])).toEqual({ matches: ['/repo/src/a.ts'] })
    expect(expandGlob('/repo/*/[ab].?s', dir => disk[dir])).toEqual({ matches: ['/repo/src/a.ts', '/repo/src/b.js'] })
    expect(expandGlob('/repo/*', dir => disk[dir])).toEqual({ matches: ['/repo/a.ts', '/repo/src'] })
    expect(expandGlob('/repo/.e*', dir => disk[dir])).toEqual({ matches: ['/repo/.env'] })
    expect(expandGlob('/other/*', dir => (dir === '/other' ? undefined : null))).toEqual({ need: ['/other'] })
    expect(expandAllNow(['/repo/src/*.py'], dir => disk[dir] ?? null)).toEqual({ '/repo/src/*.py': [] })
    const big: Listing = Array.from({ length: GLOB_CAP + 1 }, (_, i) => ({ name: `f${i}`, isDir: false }))
    expect(expandAllNow(['/big/*'], () => big)).toEqual({ '/big/*': 'capped' })
  })

  test('through the module: the listing comes from $.fs.list', async ($, on) => {
    const w = world(on, { verify: ['npm test'], mode: 'enforce' })
    w.isDiskListed = true
    w.files['/repo/.env'] = 'KEY=x'
    await start($)
    expect((await bash($, 'cat .en?')).deny).toMatch(/holds secrets/)
    expect((await bash($, 'cat src/*.zz')).deny).toBeUndefined()
  })
})

// ---------------------------------------------------------------- the twelfth round, X10-X12: wildcards and budgets

describe('X11: the expander takes a quoted part as literal and follows a link in the middle of a pattern', () => {
  const disk: Record<string, Listing> = {
    '/': [{ name: 'repo', isDir: true }],
    '/repo': [{ name: 'src', isDir: true }, { name: 'config', isDir: true }, { name: 'conf*', isDir: true }],
    '/repo/src': [{ name: 'a.ts', isDir: false }, { name: 'keys', isDir: null }, { name: 'creds', isDir: null }],
    '/repo/src/keys': [{ name: 'token.txt', isDir: false }],
    '/repo/config': [{ name: 'secrets', isDir: true }],
    '/repo/conf*': [{ name: 'secrets', isDir: true }],
  }
  const listed = (dir: string): Listing | undefined => disk[dir] ?? null

  test('a link is listed as one that may lead to a folder, and a middle part matches it; listing it shows where it leads', () => {
    expect(expandGlob('/repo/src/k*/token.txt', listed)).toEqual({ matches: ['/repo/src/keys/token.txt'] })
    // The thirteenth round, BB4: a literal part after a wildcard is kept only where it is there (`creds` holds no token.txt).
    expect(expandGlob('/repo/src/*/token.txt', listed)).toEqual({ matches: ['/repo/src/keys/token.txt'] })
    expect(expandGlob('/repo/src/*/package.json', listed)).toEqual({ matches: [] })
    // The last part matches any entry; a trailing `/` matches folders only, a link among them.
    expect(expandGlob('/repo/src/*', listed)).toEqual({ matches: ['/repo/src/a.ts', '/repo/src/creds', '/repo/src/keys'] })
    expect(expandGlob('/repo/src/*/', listed)).toEqual({ matches: ['/repo/src/creds', '/repo/src/keys'] })
    // In a pattern for folders, a literal part after a wildcard must be there: only the folders that exist match.
    expect(expandGlob('/repo/*/secrets/', listed)).toEqual({ matches: ['/repo/conf*/secrets', '/repo/config/secrets'] })
    // The fourteenth round (CC1): the checked expander is the extended reading's alone; the reviewed reading has
    // `2374c49`'s, which takes a link for no folder and the literal parts after a wildcard as written.
    expect(expandGlob('/repo/*/secrets', listed)).toEqual({ matches: ['/repo/conf*/secrets', '/repo/config/secrets'] })
    expect(expandGlobReviewed('/repo/*/secrets', listed)).toEqual({ matches: ['/repo/conf*/secrets', '/repo/config/secrets', '/repo/src/secrets'] })
    expect(expandGlobReviewed('/repo/src/*/token.txt', listed)).toEqual({ matches: [] })
    expect(expandGlobReviewed('/repo/src/*', listed)).toEqual({ matches: ['/repo/src/a.ts', '/repo/src/creds', '/repo/src/keys'] })
  })

  test('Y1: a folders pattern with no wildcard (a pushd target) matches only a folder that is there, each part checked', () => {
    expect(expandGlob('/repo/config/secrets/', listed)).toEqual({ matches: ['/repo/config/secrets'] })
    expect(expandGlob('/repo/src/keys/', listed)).toEqual({ matches: ['/repo/src/keys'] })
    expect(expandGlob('/repo/config/gone/', listed)).toEqual({ matches: [] })
    expect(expandGlob('/repo/src/a.ts/', listed)).toEqual({ matches: [] })
    expect(expandGlob('/nowhere/x/', listed)).toEqual({ matches: [] })
    expect(expandGlob('/repo/gone/../src/', listed)).toEqual({ matches: [] })
    // Without a trailing `/` a pattern with no wildcard (a word with white space, BB5) matches only what is there, of any kind.
    expect(expandGlob('/repo/config/gone', listed)).toEqual({ matches: [] })
    expect(expandGlob('/repo/src/a.ts', listed)).toEqual({ matches: ['/repo/src/a.ts'] })
    expect(expandGlob('/repo/src/keys/token.txt', listed)).toEqual({ matches: ['/repo/src/keys/token.txt'] })
  })

  test('an escaped character is literal: a quoted `*` matches only a `*`', () => {
    expect(expandGlob('/repo/conf\\*/s*', listed)).toEqual({ matches: ['/repo/conf*/secrets'] })
    expect(expandGlob('/repo/conf*/s*', listed)).toEqual({ matches: ['/repo/conf*/secrets', '/repo/config/secrets'] })
  })

  test('globWords asks with the template, and the rules look the matches up by the text', () => {
    // The fourteenth round (CC1): each reading asks its own, kept apart. A word with a quoted part before its wildcard is
    // no wildcard to the reviewed reading, as in `2374c49`; the extended reading asks by the template.
    expect(globWords('cat "conf*"/s*', at)).toEqual([{ kind: 'extended', key: '/repo/conf*/s*', pattern: '/repo/conf\\*/s*' }])
    expect(globWords('cat "config"/s*/token.txt', at)).toEqual([{ kind: 'extended', key: '/repo/config/s*/token.txt', pattern: '/repo/config/s*/token.txt' }])
    expect(globWords('cat config/s*/token.txt', at)).toEqual([
      { kind: 'reviewed', key: '/repo/config/s*/token.txt', pattern: '/repo/config/s*/token.txt' },
      { kind: 'extended', key: '/repo/config/s*/token.txt', pattern: '/repo/config/s*/token.txt' },
    ])
    // The reviewed reading takes a `cd` target as written, a path the line names; the extended reading asks for its move
    // target as the folder pattern it is followed by.
    expect(globWords('cd con*/secrets && cat token.txt', at)).toEqual([
      { kind: 'reviewed', key: '/repo/con*/secrets', pattern: '/repo/con*/secrets' },
      { kind: 'extended', key: '/repo/con*/secrets/', pattern: '/repo/con*/secrets/' },
      { kind: 'extended', key: '/repo/con*/secrets', pattern: '/repo/con*/secrets' },
    ])
    // Followed where it matched exactly one folder; otherwise the folder is lost, and the path is matched as written.
    expect(rule('cd .cl*/ && echo x > settings.json', { ...at, globsExtended: { '/repo/.cl*/': ['/repo/.claude'] } })).toBe('protected')
    expect(rule('cd .cl*/ && echo x > settings.json', { ...at, globsExtended: { '/repo/.cl*/': ['/repo/.claude', '/repo/.clone'] } })).toBe(null)
    expect(rule('cd .cl*/ && echo x > settings.json', at)).toBe(null)
  })
})

describe('X10, X12: a budget that runs out refuses the line, with advice to split it', () => {
  const words = (n: number, make: (i: number) => string): string => Array.from({ length: n }, (_, i) => make(i)).join(' ')
  const over = (command: string, where: Where = at, isOptedIn = true): string[] => budgetRefusals(command, where, isOptedIn).map(one => one.rule)

  test(`${GLOB_BUDGET} wildcard paths on a line are expanded; one more refuses the line`, () => {
    expect(over(`ls ${words(GLOB_BUDGET, i => `d${i}/*`)}`)).toEqual([])
    expect(over(`ls ${words(GLOB_BUDGET + 1, i => `d${i}/*`)}`)).toEqual(['protected'])
    expect(budgetRefusals(`ls ${words(GLOB_BUDGET + 1, i => `d${i}/*`)}`, at, true)[0]?.reason).toMatch(/more wildcard paths than the harness expands for one line \(32\)[\s\S]*Split the line[\s\S]*\/devloop allow --command/)
    // Where only the secrets rule holds, the refusal is that rule's.
    expect(over(`ls ${words(GLOB_BUDGET + 1, i => `d${i}/*`)}`, at, false)).toEqual(['secret'])
    // One the hook left unexpanded, where it expanded others, is refused too.
    expect(over('ls a/* b/*', { ...at, globs: { '/repo/a/*': [] } })).toEqual(['protected'])
    expect(over('ls a/* b/*', { ...at, globs: { '/repo/a/*': [], '/repo/b/*': [] } })).toEqual([])
    // Through the judge: 33 harmless wildcard words, then a read of a secret by a wildcard (34 paths; within the 200 named places, Y2).
    expect(over(`ls ${words(33, i => `src/[a-${String.fromCharCode(98 + (i % 24))}]${'?'.repeat(Math.floor(i / 24))}.ts`)}; cat conf*/secr*/tok*`)).toEqual(['protected'])
  })

  test(`${LINK_BUDGET} named places are followed through links; one more refuses the line`, () => {
    expect(over(`echo ${words(LINK_BUDGET, i => `a${i}`)}`)).toEqual([])
    expect(over(`echo ${words(LINK_BUDGET + 1, i => `a${i}`)}`)).toEqual(['protected'])
    expect(over(`echo ${words(LINK_BUDGET - 1, i => `a${i}`)}; cat src/keys/token.txt`)).toEqual([])
    expect(over(`echo ${words(LINK_BUDGET, i => `a${i}`)}; cat src/keys/token.txt`)).toEqual(['protected'])
    // A place named twice is followed once.
    expect(over(`echo ${words(LINK_BUDGET, i => `a${i}`)} a0 a1`)).toEqual([])
    // The matches of wildcards have GLOB_CAP for theirs.
    const matched = (n: number): Where => ({ ...at, globs: { '/repo/g/*': Array.from({ length: n }, (_, i) => `/repo/g/f${i}`) } })
    expect(over('cat g/*', matched(GLOB_CAP))).toEqual([])
    expect(over('cat g/* h/*', { ...matched(GLOB_CAP), globs: { ...matched(GLOB_CAP).globs, '/repo/h/*': ['/repo/h/x'] } })).toEqual(['protected'])
  })

  test(`opted in, ${WRITE_LINK_BUDGET} written paths are followed through links; one more refuses the line`, () => {
    expect(over(`touch ${words(WRITE_LINK_BUDGET, i => `w${i}`)}`)).toEqual([])
    expect(over(`touch ${words(WRITE_LINK_BUDGET + 1, i => `w${i}`)}`)).toEqual(['protected'])
    // Where no policy is in force no written path is followed, so there is no budget to run out.
    expect(over(`touch ${words(WRITE_LINK_BUDGET + 1, i => `w${i}`)}`, at, false)).toEqual([])
  })

  test('linkPlaces keeps each place once, the spelled ones to the budget and the matches to GLOB_CAP', () => {
    const one = (abs: string, isMatch = false): Placed => ({ spelled: abs, abs, rel: null, ...(isMatch ? { isMatch } : {}) })
    expect(linkPlaces([one('/a'), one('/a'), one('/b'), one('/m', true)], 1)).toEqual({ places: [one('/a'), one('/m', true)], isOver: true })
    expect(linkPlaces([one('/a'), one('/a'), one('/m', true)], 1).isOver).toBe(false)
  })
})

// ---------------------------------------------------------------- R15

describe('R15: a link made earlier on the line is followed for the rest of it', () => {
  test('to a secret, a protected folder, a locked test', () => {
    expect(rule('ln -s .env e && cat e')).toBe('secret')
    expect(rule('ln -s ~/.claude/cache-guard x; cp evil x/cache_guard.py')).toBe('protected')
    expect(rule('ln -s ~/.claude/hooks h && echo x > h/pre.sh')).toBe('protected')
    expect(rule('ln devloop.json d && echo {} > d')).toBe('protected')
    // A link to a harmless file is harmless.
    expect(rule('ln -s src/a.ts a && cat a')).toBe(null)
  })
})

// ---------------------------------------------------------------- L1

describe('L1: the building agent does not run cache_guard.py, by any path or interpreter', () => {
  test('every spelling the model resolves', () => {
    for (const command of [
      'python3 cache-guard/cache_guard.py install --keepwarm', 'python3 /opt/plugin/cache-guard/cache_guard.py uninstall', 'python cache_guard.py report', 'python3.12 cache_guard.py handoff-show',
      'py cache_guard.py totals-refresh', 'env python3 ~/.claude/cache-guard/cache_guard.py hook stop', './cache_guard.py install', '~/.claude/cache-guard/cache_guard.py doctor', 'python3 -m cache_guard',
      'python3 -I -u cache_guard.py', 'bash -c "python3 cache_guard.py install"', 'sh -c \'cd cache-guard && python3 cache_guard.py install\'', 'nohup python3 x/cache_guard.py &', 'python3 -c "import cache_guard"',
      'P=cache-guard; python3 $P/cache_guard.py install',
    ]) {
      expect({ command, rule: rule(command) }).toEqual({ command, rule: 'cache-guard' })
    }
    expect(judgeCommand('python3 cache-guard/cache_guard.py install', cfg, FRESH, at)?.reason).toMatch(/\/devloop cache/)
    for (const command of ['python3 cache-guard/tests/test_cache_guard.py', 'cat cache-guard/cache_guard.py', 'git diff -- cache-guard/', 'grep -n def cache-guard/cache_guard.py', 'python3 scripts/check.py cache_guard.py']) {
      expect({ command, verdict: rule(command) }).toEqual({ command, verdict: null })
    }
  })

  test('it holds where protected paths are judged: in enforce', async ($, on) => {
    world(on, { verify: ['npm test'], mode: 'enforce' })
    await start($)
    expect((await bash($, 'python3 cache-guard/cache_guard.py install --keepwarm')).deny).toMatch(/\/devloop cache install/)
  })

  test('... recorded, not refused, in observe mode, as a protected path is', async ($, on) => {
    const w = world(on, { verify: ['npm test'], mode: 'observe' })
    await start($)
    expect((await bash($, 'python3 cache-guard/cache_guard.py install --keepwarm')).deny).toBeUndefined()
    expect(w.store['ledger:/repo'] === undefined ? [] : (w.store['ledger:/repo'] as { kind: string; key: string }[]).filter(one => one.key === 'cache-guard').map(one => one.kind)).toEqual(['guard-observe'])
  })

  test('... and not judged in a repository that has not opted in, where only secrets are', async ($, on) => {
    world(on, null)
    await start($)
    expect((await bash($, 'python3 cache-guard/cache_guard.py install --keepwarm')).deny).toBeUndefined()
  })
})

// ---------------------------------------------------------------- L4

describe('L4: an evidence note in an older schema reads as no evidence, and the row says why', () => {
  test('pure', () => {
    expect(isOlderEvidence('{"schema":"evidence@1","tree":"t"}')).toBe(true)
    expect(isOlderEvidence('{"schema":"evidence@2"}')).toBe(false)
    expect(isOlderEvidence('not json')).toBe(false)
    expect(reviewRowFrom('Independent review', 'general', null as EvidenceNote | null, 't1', 'p', true)).toEqual({ label: 'Independent review', isMet: false, note: OLDER_NOTE })
    expect(reviewRowFrom('Independent review', 'general', null, 't1', 'p').note).toMatch(/no evidence of a review/)
  })
})
