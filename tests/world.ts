import { expect } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

import { PYTHON_VERSION, SCRIPT } from '../hooks/cacheguard'

// Nothing sits beneath the plugin in a test, so this stands in for the
// engine and the machine: a repository held in memory, and a shell whose
// answers the test decides. The harness's own git scripts carry a
// `# devloop:<name>` tag, which the world answers by name.

export type World = {
  files: Record<string, string>
  /** Symbolic links: where each path leads. */
  links: Record<string, string>
  /** The working tree's content hash, as the plugin's snapshot reads it. */
  tree: string
  branch: string
  /** The base commit the snapshot finds; null when it finds none. */
  base: string | null
  changed: string[]
  /** Files git reports changed between two trees, for the flake check. */
  since: string[]
  /** devloop.json on the base branch: `same` as the working tree, a text, or null for none. */
  basePolicy: 'same' | string | null
  /** What a push to the default branch would land; null when the remote branch is unknown. */
  pushRange: string[] | null
  /** Tracked files, for listing a folder a command writes. */
  tracked: string[]
  /** What /devloop init finds as the default branch. */
  defaultBranch: string
  /** The change's diff from the base, as `git diff -U0` prints it (the credential scan reads its added lines). */
  added: string
  /** Each test file's content hash as git would compute it now, by path (tracked or new). */
  testHashes: Record<string, string>
  /** Files as the base branch has them, by repository-relative path (REVIEW.md, say). */
  baseFiles: Record<string, string>
  /** Folder listings, by path. */
  lists: Record<string, string[]>
  /** Exit codes by command, or a list used up in order (its last one sticks); one not listed exits 0. */
  exits: Record<string, number | number[]>
  /** What a command prints, by command; one not listed prints the same line every time. */
  outputs: Record<string, string>
  /** Commands the plugin ran, its own git scripts left out. */
  ran: string[]
  /** The plugin's own git scripts, by tag. */
  scripts: string[]
  tools: string[]
  /** The id of each `ui.open`, in order. */
  opened: string[]
  /** Each `ui.open`'s arguments, whole, in order. */
  openArgs: { backgroundColor?: string }[]
  /** Each `ui.status` call's line, in order. */
  statusLines: (string | undefined)[]
  /** The id of each `ui.close` that reached the engine, in order. */
  closed: string[]
  /** Event name to error message: that call fails with it (only `fs.exists` today). */
  failing: Record<string, string>
  /** Makes `$.clock.now` throw, so a step that needs the time fails. */
  isClockBroken: boolean
  /** Makes the session's root and directory unreadable, so a guard cannot even find the repository. */
  isSessionBroken: boolean
  now: number
  sessionId: string
  root: string
  cwd: string
  cost: number | undefined
  /** The plugin's store, which the test reads too. */
  store: Record<string, unknown>
  spawned: { agentId: string; subagentType: string; prompt: string; cwd?: string; model?: string }[]
  submitted: string[]
  toasts: string[]
  /** What the person answers to a dialog; `questions` keeps what they were asked. */
  answer: string
  questions: string[]
  /** Runs while a dialog is open, before the person answers: a change made while they decide. */
  onAsk: (() => void) | null
  /** Each tool spec registered, whole, in order (C1: the list must never change). */
  toolSpecs: unknown[]
  /** Each command name registered, in order. */
  registered: string[]
  /** Command names another plugin holds: registering one throws. */
  takenCommands: string[]
  /** The context each prompt carried down to the engine, in order. */
  contexts: (readonly string[])[]
  /** The live context window as `$.session.usage()` reports it: tokens in use (undefined before a response) and the window. */
  usage: { tokens: number | undefined; window: number }
  /** The environment each check ran with, by command: `all` (inherited) or the names a scrubbed run kept. */
  envs: Record<string, 'all' | string[]>
  /** Variable names in the environment, as the harness's env listing sees them. */
  envNames: string[]
  /** The arguments each of the plugin's own scripts was last run with, by tag. */
  scriptArgs: Record<string, string[]>
  /** Instruction files git ignores, as the snapshot lists them: content hash by path. */
  ignored: Record<string, string>
  /** What the snapshot's sweep says when it took only its cap: how many matched; null when it took them all. */
  capped: number | null
  /** What `$.tool.list()` answers: the session's tools. */
  toolList: { name: string; description: string; mcp: boolean }[]
  /** Rows a plugin appended to the conversation for the model (`$.session.append`), as text. */
  appended: string[]
  /** What the instruction-files listing answers: `t <path>` tracked, `u <path>` untracked, `i <path>` ignored; null outside git. */
  instructionFiles: string[] | null
  /** What a tool call answers, by tool (a Read's text, say); one not listed answers `{}`. */
  toolResults: Record<string, unknown>
  /**
   * Holds the next tool call open once it reaches the engine (C2.1, two calls
   * dispatched together): the call waits on this promise; `onHeld` runs when it starts waiting.
   */
  hold: Promise<void> | null
  onHeld: (() => void) | null
  /** Paths whose read fails (C2.1 F5: a read of the audit trail that fails). */
  unreadable: string[]
  /** Tools whose call answers as an error (C2.1 F12: a push that errored). */
  toolErrors: string[]
  /** More of what `$.process.hookEnv()` answers beside the plugin data folder (D1: the plugin root). */
  hookEnv: Record<string, string>
  /** What git's diff of two trees names, by `<from> <to>` (the review carry-over); a pair not listed answers `#carry-diff`. */
  diffs: Record<string, string[]>
  /** The committable tree and HEAD's tree as the snapshot reads them (final round, D1 F4); null: the same as `tree` (everything committed). */
  committable: string | null
  headTree: string | null
  /** Index entries with the skip-worktree or assume-unchanged bit, as the snapshot reports them (the last review's F2). */
  hidden: string[]
  /** Files that differ from HEAD, as the snapshot reports them (F9): `t <path>` tracked, `u <path>` untracked. */
  differs: string[]
  /** Every argv a command the plugin ran (not its own git scripts) was given, in order. */
  argvs: string[][]
  /**
   * Whether `$.fs.list` of a folder `lists` does not name answers from the
   * world's files, links and tracked files, as a disk would (the cache-guard
   * round, P-C: the wildcard expander lists folders). Off by default.
   */
  isDiskListed: boolean
  /**
   * What the person answers to each setup question (`header: 'Setup'`), used up in
   * order; null, or once used up, answers each with its first option (Enter). The
   * item `'<dismiss>'` dismisses that question.
   */
  setupAnswers: string[] | null
  /** The session's Python version; null answers nothing, so setup skips its cache-guard question. */
  pythonVersion: string | null
  /** Each cache-guard installer run's argv after the script path, and its exit code. */
  cacheInstalls: string[][]
  cacheInstallExit: number
  /** What the plugin logged to the person (`$.ui.log`). */
  logs: string[]
  /** Whether the session's folder is a git work tree: false, the snapshot answers nothing and the git probe lists `gitSubfolders`. */
  isGit: boolean
  /** The snapshot script fails (exit 1, nothing printed) in a git repository: a null tree that is not "outside git". */
  isSnapshotBroken: boolean
  /** Direct subfolders holding a `.git`, as the git probe lists them outside a work tree. */
  gitSubfolders: string[]
  /** A path whose write fails (`disk full`); null for none. */
  failWrite: string | null
  /** ui.open throws. */
  failOpen: boolean
  /** Each child the plugin started with `$.process.spawn`, in order: it runs until the test finishes it, or the plugin kills it. */
  spawns: Spawn[]
}

/**
 * A spawned child as the test drives it: `command` is the check (the
 * `bash -lc` form's third argument, the scrubbed form's fifth). `finish`
 * ends it with an exit code and what it printed; `isKilled` says the plugin
 * ended it first.
 */
export type Spawn = { command: string; argv: string[]; cwd: string | undefined; finish: (exitCode: number, output?: string) => void; isKilled: boolean }

// The full review by default (fast critic off), so tests of reviewers, specialists and models see every seat; the fast critic has its own tests.
export const CONFIG = { verify: ['npm test'], mode: 'enforce', fastReview: { maxFiles: 0, maxLines: 0, model: null }, reviewOnFinish: false }

/**
 * `isClockMocked`: the test answers `$.clock` itself with the kit's
 * `mock.clock` (D2: a follow-up's timer), so the world leaves `clock.now` to it.
 */
export function world(on: On, config: object | null = CONFIG, options: { isClockMocked?: boolean } = {}): World {
  const w: World = {
    files: config === null ? {} : { '/repo/devloop.json': JSON.stringify(config) },
    links: {},
    tree: 't0', branch: 'feature', base: 'b0', changed: [], since: [], basePolicy: 'same', pushRange: null, tracked: [], defaultBranch: 'main', lists: {},
    added: '', testHashes: {}, baseFiles: {},
    exits: {}, outputs: {}, ran: [], scripts: [], tools: [], opened: [], openArgs: [], statusLines: [], closed: [], failing: {}, isClockBroken: false, isSessionBroken: false, now: 1000,
    sessionId: 's1', root: '/repo', cwd: '/repo', cost: undefined,
    spawned: [], submitted: [], toasts: [], answer: 'Approve', questions: [], store: {}, onAsk: null,
    toolSpecs: [], registered: [], takenCommands: [], contexts: [], usage: { tokens: undefined, window: 1 }, envs: {}, envNames: ['PATH', 'HOME'], toolList: [], appended: [], instructionFiles: [], toolResults: {},
    scriptArgs: {}, ignored: {}, capped: null, hold: null, onHeld: null, unreadable: [], toolErrors: [], hookEnv: {}, diffs: {}, committable: null, headTree: null, hidden: [], differs: [], argvs: [], isDiskListed: false,
    setupAnswers: null, pythonVersion: null, cacheInstalls: [], cacheInstallExit: 0, logs: [], isGit: true, isSnapshotBroken: false, gitSubfolders: [], failWrite: null, failOpen: false, spawns: [],
  }
  on('store.get', (_, e) => ({ value: w.store[e.key] }))
  on('store.set', (_, e) => {
    w.store[e.key] = e.value

    return { value: undefined }
  })
  on('store.delete', (_, e) => {
    delete w.store[e.key]

    return { value: undefined }
  })
  on('store.keys', () => ({ value: Object.keys(w.store) }))
  if (options.isClockMocked !== true) {
    on('clock.now', () => {
      if (w.isClockBroken) {
        throw new Error('the clock is broken')
      }

      return { value: w.now }
    })
  }
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.cwd', () => {
    if (w.isSessionBroken) {
      throw new Error('no session')
    }

    return { value: w.cwd }
  })
  on('session.root', () => {
    if (w.isSessionBroken) {
      throw new Error('no session')
    }

    return { value: w.root }
  })
  on('session.id', () => ({ value: w.sessionId }))
  on('session.model', () => ({ value: 'model-a' }))
  on('session.usage', () => ({ value: { startedAt: 0, context: { window: w.usage.window, ...(w.usage.tokens === undefined ? {} : { tokens: w.usage.tokens, percent: Math.round((100 * w.usage.tokens) / w.usage.window) }) }, rateLimits: [], ...(w.cost === undefined ? {} : { cost: { usd: w.cost } }) } as never }))
  on('tool.list', () => ({ value: w.toolList }) as never)
  on('prompt.compose', () => ({ sections: [{ id: 'intro', text: 'You are Claude.', scope: 'shared' as const }] }))
  on('session.compact', (_, e) => ({ messages: e.messages }))
  on('session.end', (_, e) => ({ sessionId: e.sessionId }))
  on('session.append', (_, e, next) => {
    w.appended.push(((e.message.content ?? []) as { text?: string }[]).map(one => one.text ?? '').join(''))

    return next(e)
  })
  on('env.get', (_, e) => ({ value: e.name === 'HOME' ? '/home/u' : undefined }))
  on('process.hookEnv', () => ({ value: { CLAUDE_PLUGIN_DATA: '/data/devloop', ...w.hookEnv } }))
  on('command.register', (_, e) => {
    if (w.takenCommands.includes(e.name)) {
      throw new Error('taken')
    }
    w.registered.push(e.name)

    return { value: { command: e.name } }
  })
  on('tool.register', (_, e) => {
    w.tools.push(`mcp__devloop__${e.name}`)
    w.toolSpecs.push(JSON.parse(JSON.stringify(e)))

    return { value: { tool: `mcp__devloop__${e.name}` } }
  })
  on('ui.open', (_, e) => {
    if (w.failOpen) {
      throw new Error('pane unavailable')
    }
    w.opened.push((e as { id: string }).id)
    w.openArgs.push(JSON.parse(JSON.stringify(e)))

    return { value: { isPlaced: true } }
  })
  on('ui.close', (_, e) => {
    w.closed.push(e.id)

    return { value: undefined }
  })
  on('ui.status', (_, e) => {
    w.statusLines.push((e as { text: string | undefined }).text)

    return { value: undefined }
  })
  on('ui.log', (_, e) => {
    w.logs.push(JSON.stringify(e))

    return { value: undefined }
  })
  on('ui.toast', (_, e) => {
    w.toasts.push(e.text)

    return { value: undefined }
  })
  on('fs.exists', (_, e) => {
    const failure = w.failing['fs.exists']
    if (failure !== undefined) {
      // Denied with the message, which is how the plugin's `await` sees the reason.
      return { deny: failure }
    }

    return { value: e.path in w.files || Object.keys(w.files).some(file => file.startsWith(`${e.path}/`)) }
  })
  on('fs.read', (_, e) => {
    if (w.unreadable.includes(e.path)) {
      throw new Error(`read ${e.path} failed: EIO`)
    }

    return { value: w.files[e.path] ?? '' }
  })
  on('fs.write', (_, e) => {
    if (e.path === w.failWrite) {
      // The write rejects with this reason, as a full disk's would.
      return { deny: 'disk full' }
    }
    w.files[e.path] = e.text

    return { value: undefined }
  })
  on('fs.stat', (_, e) => {
    // A path beneath a link to a folder resolves through it, as the file system resolves it.
    const parent = Object.keys(w.links).find(one => e.path.startsWith(`${one}/`))
    if (parent !== undefined && e.resolve === true) {
      const real = `${w.links[parent] ?? parent}${e.path.slice(parent.length)}`
      if (real in w.files) {
        return { value: { kind: 'file', size: 0, mtimeMs: 0, isLink: false, realPath: real } }
      }
    }
    const link = w.links[e.path]
    if (link !== undefined) {
      return { value: { kind: 'file', size: 0, mtimeMs: 0, isLink: true, ...(e.resolve ? { realPath: link } : {}) } }
    }
    if (e.path in w.files) {
      return { value: { kind: 'file', size: 0, mtimeMs: 0, isLink: false, ...(e.resolve ? { realPath: e.path } : {}) } }
    }
    if (Object.keys(w.files).some(file => file.startsWith(`${e.path}/`)) || w.tracked.some(file => `/repo/${file}`.startsWith(`${e.path}/`))) {
      return { value: { kind: 'dir', size: 0, mtimeMs: 0, isLink: false, ...(e.resolve ? { realPath: e.path } : {}) } }
    }
    throw new Error(`stat ${e.path} failed: ENOENT`)
  })
  on('fs.list', (_, e) => {
    const asked = (e.path ?? '').replace(/\/+$/, '')
    const listed = w.lists[e.path ?? '']
    if (listed !== undefined || !w.isDiskListed) {
      return { value: (listed ?? []).map(name => ({ name, kind: 'file' as const, size: 1, mtimeMs: 0, isLink: false })) }
    }
    // As a disk lists it: each child once, a folder where something lies beneath it, a link as `other` (as the engine
    // lists one); a folder reached through a link is listed where the link leads (the twelfth round, X11).
    const through = Object.entries(w.links).find(([link]) => asked === link || asked.startsWith(`${link}/`))
    const dir = through === undefined ? asked : `${through[1]}${asked.slice(through[0].length)}`
    const paths = [...Object.keys(w.files), ...Object.keys(w.links), ...w.tracked.map(file => `${w.root}/${file}`)]
    const children = new Map<string, 'file' | 'dir' | 'other'>()
    for (const path of paths.filter(one => one.startsWith(`${dir}/`))) {
      const rest = path.slice(dir.length + 1)
      const name = rest.split('/')[0] ?? ''
      if (name !== '') {
        children.set(name, w.links[`${dir}/${name}`] !== undefined ? 'other' : rest.includes('/') ? 'dir' : (children.get(name) ?? 'file'))
      }
    }

    return { value: [...children].map(([name, kind]) => ({ name, kind, size: 1, mtimeMs: 0, isLink: false })) }
  })
  on('process.run', (_, e) => {
    const command = e.argv[2] ?? ''
    const args = e.argv.slice(4)
    const tag = /# devloop:([a-z-]+)/.exec(command)?.[1]
    const answer = (stdout: string, exitCode = 0) => ({ value: { exitCode, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } })
    if (tag !== undefined) {
      w.scripts.push(tag)
      w.scriptArgs[tag] = args
      switch (tag) {
        case 'snapshot':
          if (w.isSnapshotBroken) {
            return answer('', 1)
          }
          // Outside a work tree git answers nothing.
          if (!w.isGit) {
            return answer('')
          }

          return answer([
            `tree:${w.tree}`, `committable:${w.committable ?? w.tree}`, `headtree:${w.headTree ?? w.committable ?? w.tree}`, `branch:${w.branch}`, 'head:abc', `base:${w.base ?? 'unknown'}`, ...(w.capped === null ? [] : [`capped:${w.capped}`]),
            ...Object.entries(w.ignored).map(([file, blob]) => `ignored:${blob} ${file}`), ...w.hidden.map(file => `hidden:${file}`),
            ...(w.differs.length === 0 ? [] : [`differcount:${w.differs.length}`, ...w.differs.slice(0, 5).map(one => `differs:${one}`)]), `diff:${w.changed.length} ${w.changed.length * 3}`, ...w.changed.map(file => `file:${file}`),
          ].join('\n'))
        case 'git-probe':
          return answer(w.isGit ? 'git' : w.gitSubfolders.map(dir => `sub:${dir}`).join('\n'))
        case 'find-base':
          return answer(w.base ?? 'unknown')
        case 'branch':
          return answer(`branch:${w.branch}`)
        case 'between':
          return answer(w.since.join('\n'))
        case 'base-policy':
          // `same` copies the working tree's; with none there, the base has none either (the script exits 3, as git's does).
          return w.basePolicy === null || (w.basePolicy === 'same' && w.files['/repo/devloop.json'] === undefined)
            ? answer('', 3)
            : answer(w.basePolicy === 'same' ? (w.files['/repo/devloop.json'] ?? '') : w.basePolicy)
        case 'push-range':
          return answer(w.pushRange === null ? 'unknown' : ['known', ...w.pushRange].join('\n'))
        case 'ls-files':
          return answer(w.tracked.filter(file => args.some(dir => dir === '.' || file === dir || file.startsWith(`${dir}/`))).join('\n'))
        case 'clear-state':
          for (const file of args) {
            delete w.files[file]
          }

          return answer('')
        case 'default-branch':
          return answer(w.defaultBranch)
        case 'branches':
          return answer('master\nfeature')
        case 'added-lines':
          return answer(w.added)
        case 'test-files':
          return answer(Object.keys(w.testHashes).join('\n'))
        case 'test-hashes':
          return answer(args.filter(file => file in w.testHashes).map(file => `${w.testHashes[file] ?? ''} ${file}`).join('\n'))
        case 'scrubbed': {
          // A check run with a scrubbed environment: the command, and the names it keeps.
          const run = args[0] ?? ''
          w.ran.push(run)
          w.envs[run] = args.slice(1)
          const exits = w.exits[run] ?? 0
          // A list is used up in order, as for a check run with the whole environment (C2).
          const code = typeof exits === 'number' ? exits : exits.length > 1 ? (exits.shift() ?? 0) : (exits[0] ?? 0)

          return answer(w.outputs[run] ?? 'output of the command', code)
        }
        case 'note-write': {
          const exit = w.exits['note-write']

          return answer(w.outputs['note-write'] ?? `noted:abc`, typeof exit === 'number' ? exit : 0)
        }
        case 'hook-where':
          return answer(w.outputs['#hook-where'] ?? 'dir:.git/hooks\ncwd:/repo\ntop:/repo\ncommon:/repo/.git')
        case 'hook-install':
          return answer(w.outputs['hook-install'] ?? 'installed:/repo/.git/hooks/pre-push')
        case 'hook-remove':
          return answer(w.outputs['hook-remove'] ?? 'removed:/repo/.git/hooks/pre-push')
        case 'instruction-files':
          return w.instructionFiles === null ? answer('', 3) : answer(w.instructionFiles.join('\n'))
        case 'env-names':
          return answer(w.envNames.join('\n'))
        case 'carry-diff': {
          const listed = w.diffs[`${args[0] ?? ''} ${args[1] ?? ''}`]

          return listed === undefined ? answer(w.outputs['#carry-diff'] ?? '', typeof w.exits['#carry-diff'] === 'number' ? w.exits['#carry-diff'] : 0) : answer(listed.join('\n'))
        }
        case 'base-file': {
          const text = w.baseFiles[args[1] ?? '']

          return text === undefined ? answer('', 3) : answer(text)
        }
        default: {
          // Any other script answers what the test set under `#<tag>` (D2: gh, tasks, the main root), else nothing.
          const exit = w.exits[`#${tag}`]
          const code = typeof exit === 'number' ? exit : Array.isArray(exit) ? (exit.length > 1 ? (exit.shift() ?? 0) : (exit[0] ?? 0)) : 0
          const out = w.outputs[`#${tag}`]

          return answer(out ?? '', code)
        }
      }
    }
    if (w.pythonVersion !== null && e.argv[0] === 'python3') {
      if (e.argv[1] === '-c' && e.argv[2] === PYTHON_VERSION) {
        return answer(`${w.pythonVersion}\n`)
      }
      if ((e.argv[1] ?? '').endsWith(`/${SCRIPT}`) && (e.argv[2] === 'install' || e.argv[2] === 'uninstall')) {
        w.argvs.push([...e.argv])
        w.cacheInstalls.push(e.argv.slice(2))

        return answer(w.cacheInstallExit === 0 ? 'cache-guard installed' : 'installer failed: no write access', w.cacheInstallExit)
      }
    }
    w.ran.push(command)
    w.argvs.push([...e.argv])
    if (e.argv[1] === '-lc') {
      w.envs[command] = 'all'
    }
    const exits = w.exits[command] ?? 0
    const exitCode = typeof exits === 'number' ? exits : exits.length > 1 ? (exits.shift() ?? 0) : (exits[0] ?? 0)

    return answer(w.outputs[command] ?? 'output of the command', exitCode)
  })
  // A child that runs until the test finishes it, or the plugin ends it (`return()` on the stream aborts `next.signal`);
  // as a stand-in for a call on `$`, it answers how the child ended as `{ value }`.
  on('process.spawn', async function* (_, e, next) {
    const argv = [...e.argv]
    let ended: { code: number; output: string } | null = null
    let settle = (): void => undefined
    const settled = new Promise<void>(resolve => {
      settle = resolve
    })
    const one: Spawn = {
      command: (argv[1] === '-lc' ? argv[2] : argv[4]) ?? '',
      argv,
      cwd: e.cwd,
      isKilled: false,
      finish: (code, output = 'output of the command') => {
        ended ??= { code, output }
        settle()
      },
    }
    w.spawns.push(one)
    next.signal.addEventListener('abort', settle)
    try {
      await settled
      const done = ended as { code: number; output: string } | null
      if (done === null) {
        return { value: { code: null, signal: 'SIGTERM' } }
      }
      yield { stream: 'stdout' as const, text: done.output }

      return { value: { code: done.code, signal: null } }
    } finally {
      next.signal.removeEventListener('abort', settle)
      if (ended === null) {
        one.isKilled = true
      }
    }
  })
  on('agent.spawn', (_, e) => {
    const agentId = `agent-${w.spawned.length + 1}`
    // A plugin's spawn arrives spelled as the Agent tool's own call.
    const subagentType = (e as unknown as { subagent_type?: string }).subagent_type ?? e.subagentType
    w.spawned.push({ agentId, subagentType, prompt: e.prompt, cwd: (e as unknown as { cwd?: string }).cwd, model: e.model })

    return { model: 'model-a', agentId, result: { agentId, status: 'async_launched' } } as never
  })
  on('prompt.submit', (_, e) => {
    w.submitted.push(e.text)
    w.contexts.push(e.context ?? [])

    return { text: e.text }
  })
  on('classic.Stop', () => ({}))
  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  on('turn.complete', (_, e) => ({ text: e.answer }))
  on('tool.call', async (_, e) => {
    if (e.tool === 'AskUserQuestion') {
      const asked = e.questions[0]
      const question = asked?.question ?? ''
      w.questions.push(question)
      w.onAsk?.()
      if (asked?.header === 'Setup') {
        // The setup's questions are answered one by one; Enter takes the first option.
        const given = w.setupAnswers === null || w.setupAnswers.length === 0 ? undefined : w.setupAnswers.shift()
        if (given === '<dismiss>') {
          throw new Error('dismissed')
        }

        return { result: { questions: e.questions, answers: { [question]: given ?? asked.options[0]?.label ?? '' } } }
      }

      return { result: { questions: e.questions, answers: { [question]: w.answer } } }
    }
    const held = w.hold
    if (held !== null) {
      w.hold = null
      w.onHeld?.()
      await held
    }

    return w.toolErrors.includes(e.tool) ? { result: 'it failed' as never, isError: true } : { result: (w.toolResults[e.tool] ?? {}) as never }
  })

  return w
}

export type Dollar = Engine

export const start = ($: Dollar): Promise<unknown> => $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
export const edit = ($: Dollar, file_path: string, agentId?: string) =>
  $.tool.call({ tool: 'Edit', file_path, old_string: 'a', new_string: 'b', ...(agentId === undefined ? {} : { agentId }) })
export const bash = ($: Dollar, command: string, agentId?: string) =>
  $.tool.call({ tool: 'Bash', command, ...(agentId === undefined ? {} : { agentId }) })
export type Origin = { kind: 'composer' } | { kind: 'sdk' } | { kind: 'plugin'; name: string }
const PERSON: Origin = { kind: 'composer' }
export const devloop = async ($: Dollar, args: string, origin: Origin = PERSON): Promise<string> =>
  (await $.command.run({ command: 'devloop', args, origin, presentation: { isFullscreen: false, columns: 80 } })).text ?? ''
export const stop = ($: Dollar) =>
  $.classic.Stop({ session_id: 's', transcript_path: '/t', cwd: '/repo', stop_hook_active: false })
/** A person's prompt, as the composer submits it: what devloop attached is the last entry of `w.contexts`. */
export const prompt = ($: Dollar, text = 'go on') => $.prompt.submit({ text, origin: { kind: 'composer' }, wait: false } as never)
/** A main-loop turn ending with the API's usage. */
export const turn = ($: Dollar, usage: { input?: number; read?: number; written?: number; model?: string }, durationMs = 1000, turnId = 'turn') =>
  $.turn.complete({
    answer: 'ok', durationMs, isAborted: false, turnId, reason: 'answer',
    usage: { input_tokens: usage.input ?? 100, output_tokens: 50, cache_read_input_tokens: usage.read ?? 0, cache_creation_input_tokens: usage.written ?? 0, model: usage.model ?? 'model-a' },
  })
/** A compaction of the main conversation, as `/compact` raises it. */
export const compact = ($: Dollar) => $.session.compact({ trigger: 'manual', messages: [{ role: 'user', text: 'earlier work', toolUses: [] }] })
export const feature = async ($: Dollar, id: string): Promise<string> => String((await $.tool.call({ tool: 'mcp__devloop__feature_check', id })).result)

/** Stands for the builder changing the working tree. */
export function change(w: World, file: string): void {
  w.changed = [...new Set([...w.changed, file])]
  w.tree = `t${w.changed.length}-${file}-${w.ran.length}`
}

/** The ledger as the plugin keeps it for /repo. */
export const ledgerOf = (w: World): { kind: string; key: string }[] =>
  (w.store['ledger:/repo'] as { kind: string; key: string }[] | undefined) ?? []

/** Writes a spec with two features and approves it as a person. */
export async function approved($: Dollar, w: World, features = [
  { id: 'rejects-bad-password', description: 'a wrong password is refused', check: 'npm test -- bad-password' },
  { id: 'accepts-good-password', description: 'a right password signs in', check: 'npm test -- good-password' },
]): Promise<void> {
  w.files['/repo/specs/login/SPEC.md'] = '# login'
  w.files['/repo/specs/login/features.json'] = JSON.stringify(features)
  await devloop($, 'spec login')
  w.answer = 'Approve'
  expect(await devloop($, 'approve')).toMatch(/approved/)
}

/**
 * Moves the session to another seat (final round, D2 F4): a second worktree
 * of the same repository, `/wt`, with the same approved spec, whose claims are
 * kept under the repository's main root, `/repo`, as the first one's are.
 */
export function otherSeat(w: World): void {
  w.sessionId = 's2'
  w.outputs['#main-root'] = '/repo'
  for (const [path, text] of Object.entries(w.files).filter(([one]) => one.startsWith('/repo/') && !one.startsWith('/repo/.git'))) {
    w.files[`/wt/${path.slice('/repo/'.length)}`] = text
  }
  const kept = w.store['loop:/repo'] as { shape: string; value: Record<string, unknown> }
  w.store['loop:/wt'] = { shape: kept.shape, value: { ...kept.value, root: '/wt', sessionId: 's2' } }
  w.root = '/wt'
  w.cwd = '/wt'
}

