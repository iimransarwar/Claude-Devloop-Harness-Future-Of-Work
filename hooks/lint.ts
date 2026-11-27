// The instruction and skill linter /devloop doctor reports (DESIGN 4.7, C1;
// skills note 2). Pure: the caller reads the files and says which referenced
// paths exist and which scripts and targets the repository has.

import { BLOCKING_KINDS, KIND_WORDS, scanInjection } from './inject'

export type Level = 'error' | 'warn' | 'ok'

/** One doctor line: its level and what it says. */
export type LintItem = { level: Level; text: string }

/** One instruction or skill file, as the repository has it. */
export type InstructionFile = { path: string; text: string }

/** Whether a path is a skill's file (beneath a `skills` folder): loaded on demand, not at launch. */
export const isSkillPath = (path: string): boolean => /(^|\/)skills\//.test(path)

/** A skill's own description in its front matter, or null. */
export function skillDescription(text: string): string | null {
  const front = /^---\n([\s\S]*?)\n---/.exec(text)
  if (front === null) {
    return null
  }
  const lines = (front[1] ?? '').split('\n')
  const at = lines.findIndex(line => /^description:/.test(line))
  if (at < 0) {
    return null
  }
  let value = (lines[at] ?? '').replace(/^description:\s*/, '')
  // A folded or literal block, or a value continued on indented lines.
  for (const more of lines.slice(at + 1)) {
    if (!/^\s+\S/.test(more)) {
      break
    }
    value += ` ${more.trim()}`
  }

  return value.replace(/^[>|][-+]?\s*/, '').replace(/^["']|["']$/g, '').trim()
}

/** A MIME type (`application/json`, `text/x-python`): no path. */
const MIME = /^(?:application|text|image|audio|video|multipart|font|model|message)\/[\w.+-]+$/i
/** A git ref (`origin/main`, `refs/heads/x`, `upstream/release-2`): no path. */
const REF = /^(?:origin|upstream|refs|remotes|heads|tags)\//i
/** A placeholder or example name (`path/to/file`, `foo.ts`, `my-component.tsx`, `user.test.ts`): no file anyone means to exist. */
const PLACEHOLDER = /(?:^|\/)(?:path\/to|foo|bar|baz|qux|example|examples?[-_.]|sample|my[-_]|your[-_]|some[-_]|xxx|placeholder)|^[\w-]+\.(?:test|spec)\.\w+$|^test_[\w-]+\.py$|^[\w-]+_test\.\w+$/i

/**
 * Paths an instruction file refers to: a backticked span or a markdown link
 * that reads as a repository path (a slash or a file extension, no spaces, no
 * scheme, no wildcard), and is not a MIME type, a git ref or a placeholder
 * or example name (C1 review F2). Conservative, so a missing one is likely a
 * real stale reference; still only a warning.
 */
export function referencedPaths(text: string): string[] {
  const found = new Set<string>()
  const consider = (raw: string): void => {
    const one = raw.trim().replace(/[#?].*$/, '').replace(/:\d+(?::\d+)?$/, '').replace(/^\.\//, '')
    if (
      one === '' || /\s/.test(one) || /^[a-z]+:/i.test(one) || /[*?<>{}$|`'"(),;=[\]]/.test(one) || one.startsWith('/') || one.startsWith('~') ||
      one.startsWith('-') || one.startsWith('@') || one.includes('..') || one.length > 200
    ) {
      return
    }
    const isPathish = (/\//.test(one) && /^[\w.@-]+(?:\/[\w.@-]*)+$/.test(one)) || /^[\w.-]+\.(?:md|ts|tsx|js|jsx|mjs|cjs|json|py|go|rs|rb|java|kt|sh|ya?ml|toml|txt|css|html|sql)$/.test(one)
    // A bare `a/b` reads as a path; `1/2`, `and/or`, an npm scope, a MIME type, a ref and a placeholder do not.
    if (isPathish && !/^\d+\/\d+$/.test(one) && !/^(?:and|or|either)\/(?:and|or)$/i.test(one) && !MIME.test(one) && !REF.test(one) && !PLACEHOLDER.test(one)) {
      found.add(one.replace(/\/$/, ''))
    }
  }
  const withoutBlocks = text.replace(/```[\s\S]*?```/g, '')
  for (const match of withoutBlocks.matchAll(/`([^`\n]+)`/g)) {
    consider(match[1] ?? '')
  }
  for (const match of withoutBlocks.matchAll(/\]\(([^)\s]+)\)/g)) {
    consider(match[1] ?? '')
  }

  return [...found]
}

/**
 * A command an instruction names: a package script or a make target, with
 * the folder a preceding `cd` moved to (`''` the root): the script is looked
 * for in that folder's package.json.
 */
export type NamedCommand = { kind: 'script' | 'target'; name: string; line: number; dir: string }

/** A file line by line, split into its code (fenced blocks whole, backticked spans elsewhere) and its prose. */
function codeAndProse(text: string): { code: string; prose: string }[] {
  let isFence = false

  return text.split('\n').map(line => {
    if (/^\s*```/.test(line)) {
      isFence = !isFence

      return { code: '', prose: '' }
    }

    return isFence
      ? { code: line, prose: '' }
      : { code: [...line.matchAll(/`([^`\n]+)`/g)].map(match => match[1] ?? '').join(' ; '), prose: line.replace(/`[^`\n]*`/g, ' ') }
  })
}

const SCRIPT = /\b(?:npm|pnpm|yarn|bun)\s+(?:run|run-script)\s+(?:-{1,2}[\w-]+\s+)*([\w:.-]+)/g

/**
 * Package scripts (`npm run x`, `pnpm run x`, `yarn run x`, `bun run x`) and
 * make targets an instruction file names. A make target is read from code
 * only (fenced blocks and backticked spans), never prose, so "make sure"
 * names no target (C1 review F2). A `cd <folder>` in code sets the folder
 * the scripts after it are resolved in.
 */
export function namedCommands(text: string): NamedCommand[] {
  const out: NamedCommand[] = []
  let dir = ''
  codeAndProse(text).forEach(({ code, prose }, i) => {
    for (const part of code.split(/\s*(?:&&|;|\|\|)\s*/)) {
      const cd = /^\s*cd\s+([\w./@-]+)\s*$/.exec(part)
      if (cd !== null) {
        const to = (cd[1] ?? '').replace(/^\.\//, '').replace(/\/+$/, '')
        // A folder that cannot be followed (absolute, upward, home) leaves the scripts after it unknown.
        dir = to === '' || to === '.' ? '' : to.startsWith('/') || to.includes('..') || to.startsWith('~') || dir === '?' ? '?' : dir === '' ? to : `${dir}/${to}`
        continue
      }
      for (const match of part.matchAll(SCRIPT)) {
        out.push({ kind: 'script', name: match[1] ?? '', line: i + 1, dir })
      }
      for (const match of part.matchAll(/(?:^|[\s$(])make\s+(?:-[\w]+\s+)*([a-z][\w.-]*)/g)) {
        out.push({ kind: 'target', name: match[1] ?? '', line: i + 1, dir })
      }
    }
    for (const match of prose.matchAll(SCRIPT)) {
      out.push({ kind: 'script', name: match[1] ?? '', line: i + 1, dir })
    }
  })

  return out.map(one => ({ ...one, name: one.name.replace(/[.:]+$/, '') })).filter(one => one.name !== '')
}

/** The targets a Makefile defines. */
export const makeTargets = (text: string): string[] =>
  [...text.matchAll(/^([A-Za-z0-9_.-][A-Za-z0-9_./-]*)\s*:(?!=)/gm)].map(one => one[1] ?? '').filter(name => name !== '')

/** Words that only shout: emphasis that compensates for a model, not a fact. */
const SHOUT = /\b(?:IMPORTANT|CRITICAL|MUST|NEVER|ALWAYS|MANDATORY|REQUIRED|WARNING|ABSOLUTELY|STRICTLY|DO NOT|DON'T|NOT)\b/

/** Lines with ALL-CAPS emphasis outside code: a shouted word, or a run of three or more capitalised words. */
export function shoutedLines(text: string): number[] {
  const out: number[] = []
  let isCode = false
  text.split('\n').forEach((line, i) => {
    if (/^\s*```/.test(line)) {
      isCode = !isCode

      return
    }
    const prose = isCode ? '' : line.replace(/`[^`]*`/g, '').replace(/^#+\s.*$/, '')
    if (SHOUT.test(prose) || /\b[A-Z]{2,}(?:\s+[A-Z]{2,}){2,}\b/.test(prose)) {
      out.push(i + 1)
    }
  })

  return out
}

/** Formatting rules a formatter or linter config already enforces: saying them again costs context every session. */
const RESTATES = /\b(?:indent(?:ation)?\s+(?:with|of|using)\s+(?:\d+\s+spaces|tabs)|use\s+(?:\d+\s+spaces|tabs)\b|(?:use|no|omit)\s+semicolons|(?:use\s+)?(?:single|double)\s+quotes\s+(?:for|in|everywhere)|trailing\s+commas?|(?:max(?:imum)?\s+)?line\s+length\s+(?:of\s+)?\d+|lines?\s+(?:under|below|at most)\s+\d+\s+characters)\b/i

/** Lines that only restate a formatter's rule, where the repository has a formatter or linter config. */
export const restatingLines = (text: string): number[] =>
  text.split('\n').flatMap((line, i) => (RESTATES.test(line) && line.trim().length < 140 ? [i + 1] : []))

/** Blocks (paragraphs of 80 characters or more) that appear in more than one file, by their files. */
export function duplicateBlocks(files: readonly InstructionFile[]): { files: string[]; start: string }[] {
  const seen = new Map<string, Set<string>>()
  for (const { path, text } of files) {
    for (const block of text.split(/\n\s*\n/)) {
      const key = block.replace(/\s+/g, ' ').trim().toLowerCase()
      if (key.length >= 80) {
        seen.set(key, (seen.get(key) ?? new Set()).add(path))
      }
    }
  }

  return [...seen].filter(([, where]) => where.size > 1).map(([key, where]) => ({ files: [...where].sort(), start: key.slice(0, 60) }))
}

export type InstructionInput = {
  files: readonly InstructionFile[]
  /** Referenced paths (as `referencedPaths` gave them, by file) that exist, relative to the root or the file's folder. */
  existing: ReadonlySet<string>
  /** Package scripts at the root, or null when there is no package.json. */
  scripts: readonly string[] | null
  /** Package scripts by folder a `cd` moved to (`''` the root); a folder not listed is not known, and its scripts are not judged. */
  scriptsIn?: Readonly<Record<string, readonly string[] | null>>
  /** Make targets, or null when there is no Makefile. */
  targets: readonly string[] | null
  /** Whether a formatter or linter config is present (so a restated formatting rule is redundant). */
  hasFormatter: boolean
  maxLines: number
  maxBytes: number
}

const bytesOf = (text: string): number => new TextEncoder().encode(text).length

const lineList = (lines: readonly number[]): string => `line${lines.length === 1 ? '' : 's'} ${lines.slice(0, 5).join(', ')}${lines.length > 5 ? ', …' : ''}`

/**
 * The instruction-file lints, one line each. Only the byte budget is an
 * error here: every other lint is a heuristic, and a heuristic never fails a
 * check (C1 review F2).
 */
export function lintInstructions(input: InstructionInput): LintItem[] {
  const out: LintItem[] = []
  const launch = input.files.filter(one => !isSkillPath(one.path))
  const skills = input.files.filter(one => /(^|\/)SKILL\.md$/.test(one.path))
  const described = skills.map(one => skillDescription(one.text) ?? '').join('\n')
  const total = launch.reduce((sum, one) => sum + bytesOf(one.text), 0) + bytesOf(described)
  out.push({
    level: total > input.maxBytes ? 'error' : 'ok',
    text: `launch-loaded instruction text: ${(total / 1024).toFixed(1)} KiB across ${launch.length} file${launch.length === 1 ? '' : 's'}${skills.length > 0 ? ` and ${skills.length} skill description${skills.length === 1 ? '' : 's'}` : ''} (budget ${(input.maxBytes / 1024).toFixed(0)} KiB, "instructionMaxBytes"): every task pays for it`,
  })
  for (const { path, text } of launch) {
    const lines = text.split('\n').length
    if (lines > input.maxLines) {
      out.push({ level: 'warn', text: `${path}: ${lines} lines, over the ${input.maxLines} "instructionMaxLines" allows` })
    }
    const shouted = shoutedLines(text)
    if (shouted.length > 0) {
      out.push({ level: 'warn', text: `${path}: ALL-CAPS emphasis on ${lineList(shouted)}: emphasis compensates for a model; state the fact once` })
    }
    const missing = referencedPaths(text).filter(ref => !input.existing.has(ref))
    if (missing.length > 0) {
      out.push({ level: 'warn', text: `${path}: refers to paths that do not exist: ${missing.slice(0, 6).join(', ')}${missing.length > 6 ? ', …' : ''}` })
    }
    const scriptsOf = (dir: string): readonly string[] | null => (dir === '' ? input.scripts : input.scriptsIn?.[dir] ?? null)
    // A make target counts only where a Makefile exists; a script only where its folder's package.json is known.
    const gone = namedCommands(text).filter(one => (one.kind === 'script'
      ? scriptsOf(one.dir) !== null && !(scriptsOf(one.dir) ?? []).includes(one.name)
      : input.targets !== null && one.dir === '' && !input.targets.includes(one.name)))
    if (gone.length > 0) {
      out.push({
        level: 'warn',
        text: `${path}: names commands that do not exist: ${gone.slice(0, 5).map(one => `${one.kind === 'script' ? `package script${one.dir === '' ? '' : ` (in ${one.dir})`}` : 'make target'} "${one.name}" (line ${one.line})`).join(', ')}`,
      })
    }
    const restated = input.hasFormatter ? restatingLines(text) : []
    if (restated.length > 0) {
      out.push({ level: 'warn', text: `${path}: ${lineList(restated)} only restate${restated.length === 1 ? 's' : ''} what the formatter or linter config enforces` })
    }
  }
  for (const one of duplicateBlocks(launch)) {
    out.push({ level: 'warn', text: `the same block is in ${one.files.join(' and ')} ("${one.start}…"): keep it in one place` })
  }

  return out
}

// ---------------------------------------------------------------- skills

export type SkillCheck = { name: string; isPassing: boolean; isAdvice?: boolean; note: string }

/** A numbered step and the lines up to the next one. */
function stepsOf(body: string): string[] {
  const lines = body.split('\n')
  const steps: string[] = []
  let current: string[] | null = null
  let isCode = false
  for (const line of lines) {
    if (/^\s*```/.test(line)) {
      isCode = !isCode
    }
    if (!isCode && /^\s*\d+[.)]\s+\S/.test(line)) {
      if (current !== null) {
        steps.push(current.join('\n'))
      }
      current = [line]
    } else if (current !== null) {
      if (!isCode && /^#{1,6}\s/.test(line)) {
        steps.push(current.join('\n'))
        current = null
      } else {
        current.push(line)
      }
    }
  }
  if (current !== null) {
    steps.push(current.join('\n'))
  }

  return steps
}

/**
 * The skills note's checks on one SKILL.md, pass or fail each. `hasMcp`: the
 * skill's folder ships a `.mcp.json`.
 */
export function lintSkill(text: string, hasMcp: boolean): SkillCheck[] {
  const description = skillDescription(text)
  const body = text.replace(/^---\n[\s\S]*?\n---\n?/, '')
  const lines = body.split('\n').length
  const steps = stepsOf(body)
  const withCommand = steps.filter(step => /`[^`]+`|```/.test(step))
  const withCheck = steps.filter(step => /\b(?:verify|check|confirm|expect|should (?:see|print|show|return|pass)|until|succeeds?|exits? 0|passes)\b/i.test(step))
  const recovery = /^#{1,6}\s+.*(?:error|recover|troubleshoot|failure|when .* fails|if .* fails)/im.exec(body)
  const recoveryText = recovery === null ? '' : body.slice(recovery.index).split(/\n#{1,6}\s/)[0] ?? ''
  const rows = recoveryText.split('\n').filter(line => /^\s*\|/.test(line) && !/^\s*\|[\s:|-]+\|\s*$/.test(line))
  const isOnlyRetry = rows.length > 1 && rows.slice(1).every(row => /try again|retry|re-run|rerun/i.test(row) && row.split('|').filter(cell => cell.trim() !== '').length <= 2)
  const shellBlocks = (body.match(/```(?:bash|sh|shell|console)?\n/g) ?? []).length

  return [
    {
      name: 'description',
      isPassing: description !== null && description.length <= 400 && /\b(?:use (?:this|it|when|for)|when\b|trigger|invoke)/i.test(description),
      note: description === null
        ? 'no description in the front matter'
        : description.length > 400
          ? `the description is about ${Math.round(description.length / 4)} tokens; keep it near 100, since it is loaded always`
          : /\b(?:use (?:this|it|when|for)|when\b|trigger|invoke)/i.test(description) ? 'says when to use it, short enough to load always' : 'does not say when to use the skill',
    },
    { name: 'length', isPassing: lines < 500, note: `${lines} lines${lines < 500 ? '' : ': move bulky material to referenced files'}` },
    { name: 'numbered steps', isPassing: steps.length > 0, note: steps.length > 0 ? `${steps.length} numbered step${steps.length === 1 ? '' : 's'}` : 'no numbered steps' },
    {
      name: 'commands and checks',
      isPassing: steps.length > 0 && withCommand.length * 2 >= steps.length && withCheck.length > 0,
      note: steps.length === 0 ? 'no steps to judge' : `${withCommand.length} of ${steps.length} steps give a command; ${withCheck.length} say what result to check`,
    },
    {
      name: 'error recovery',
      isPassing: recovery !== null && rows.length >= 2 && !isOnlyRetry,
      note: recovery === null ? 'no error-recovery section' : rows.length < 2 ? 'the error-recovery section has no table of failures and fixes' : isOnlyRetry ? '"try again" is not a fix' : 'a table of failures and their fixes',
    },
    {
      name: 'scripts over prose',
      isPassing: shellBlocks < 6,
      isAdvice: true,
      note: shellBlocks < 6 ? 'fine' : `${shellBlocks} shell blocks: steps that never vary belong in a script the skill runs (advice)`,
    },
    { name: 'no tool servers', isPassing: !hasMcp, note: hasMcp ? 'the skill folder ships a .mcp.json: a skill must not install tool servers' : 'ships no .mcp.json' },
  ]
}

/**
 * A skill's hard limits, the only skill checks that are errors (C1 review
 * F2): a description in its front matter no longer than it may be (it is
 * loaded always), fewer than 500 lines, and no tool server shipped. The rest
 * are heuristics about how it is written, and warn.
 */
function isHardFailure(one: SkillCheck, text: string): boolean {
  if (one.name === 'description') {
    const description = skillDescription(text)

    return description === null || description.length > 400
  }

  return one.name === 'length' || one.name === 'no tool servers'
}

/** The skill checks as doctor lines: one per skill, failures named. */
export function lintSkills(skills: readonly { path: string; text: string; hasMcp: boolean }[]): LintItem[] {
  return skills.map(({ path, text, hasMcp }) => {
    const checks = lintSkill(text, hasMcp)
    const failed = checks.filter(one => !one.isPassing && one.isAdvice !== true)
    const advice = checks.filter(one => !one.isPassing && one.isAdvice === true)
    const hard = failed.filter(one => isHardFailure(one, text))

    return {
      level: hard.length > 0 ? 'error' : failed.length + advice.length > 0 ? 'warn' : 'ok',
      text: `skill ${path}: ${checks.map(one => `${one.name} ${one.isPassing ? 'pass' : one.isAdvice === true ? 'advice' : 'FAIL'}`).join(', ')}${[...failed, ...advice].length > 0 ? ` (${[...failed, ...advice].map(one => `${one.name}: ${one.note}`).join('; ')})` : ''}`,
    }
  })
}

/** The injection scan as doctor lines, by file and line. */
export function lintInjection(files: readonly InstructionFile[]): LintItem[] {
  return files.flatMap(({ path, text }) =>
    scanInjection(path, text).map(one => ({
      // Only the classes that keep the gate shut are errors (--strict fails on them); the rest are for a person to read.
      level: BLOCKING_KINDS.includes(one.kind) ? 'error' as const : 'warn' as const,
      text: `${one.file}:${one.line}: ${KIND_WORDS[one.kind]}${BLOCKING_KINDS.includes(one.kind) ? ' (keeps the gate shut while changed)' : ''}: ${one.text}`,
    })),
  )
}
