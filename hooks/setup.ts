// The guided setup: what a person answers, how the answers are read, and the
// plain summary shown when setup is done.

export type Detected = string | { run: string; profile?: 'full'; when?: string[] }
export type Strictness = 'observe' | 'enforce'
export type Approvers = 'me' | 'two'
export type SetupAnswers = { mode: Strictness; verify: Detected[]; isVerifyLater: boolean; approvers: Approvers }

export const SET_UP_HEADLINE = 'devloop is set up.'

export const OPTIONS = {
  strict: ['Watch only (recommended)', 'Block from the start'],
  none: 'None for now',
  later: "I'll add it later",
  approvers: ['Just me (recommended)', 'Two people'],
} as const

const norm = (s: string): string => s.trim().toLowerCase()

export const readStrictness = (answer: string): Strictness | null => {
  const a = norm(answer)
  if (a === norm(OPTIONS.strict[0]) || a === 'watch' || a === 'watch only' || a === 'observe') return 'observe'
  if (a === norm(OPTIONS.strict[1]) || a === 'block' || a === 'enforce') return 'enforce'
  return null
}

export const readApprovers = (answer: string): Approvers | null => {
  const a = norm(answer)
  if (['me', 'just me', 'just me (recommended)', '1', 'one'].includes(a)) return 'me'
  if (['two', 'two people', '2'].includes(a)) return 'two'
  return null
}

const runOf = (d: Detected): string => (typeof d === 'string' ? d : d.run)

export const foundLabel = (found: readonly Detected[]): string => {
  const text = found.map(runOf).join(' + ')
  return text.length > 60 ? `${text.slice(0, 59)}…` : text
}

export const readVerify = (answer: string, found: readonly Detected[]): { verify: Detected[]; isLater: boolean } => {
  const a = norm(answer)
  if (a === norm(OPTIONS.later)) return { verify: [], isLater: true }
  if (a === '' || a === 'no' || a === 'none' || a === norm(OPTIONS.none)) return { verify: [], isLater: false }
  if (found.length > 0 && answer.trim() === foundLabel(found)) return { verify: [...found], isLater: false }
  return { verify: [answer.trim()], isLater: false }
}

const PURPOSE: Record<string, string> = {
  'devloop.json': 'your settings (commit it to main: devloop reads it from there)',
  'REVIEW.md': 'what the reviewer looks for',
  'AGENTS.md': 'notes every Claude session reads',
  'evals/README.md': 'where regression tasks go',
}

export const summary = (a: SetupAnswers, wrote: readonly string[], kept: readonly string[], branch: { name: string; isGuessed: boolean }): string => {
  const mode =
    a.mode === 'observe'
      ? 'Watch only: it notes what it would have blocked, and blocks nothing (it always blocks reading secret files).'
      : 'Block from the start: it refuses what its rules forbid.'
  const checks =
    a.verify.length > 0
      ? `Each time Claude stops after changing files, it runs: ${a.verify.map(runOf).join(' ; ')}`
      : 'Each time Claude stops after changing files, nothing will be checked until you add a command under "verify" in devloop.json, e.g. "verify": ["npm test"].'
  const approvers = a.approvers === 'me' ? 'Risky merges need your approval (just you).' : 'Risky merges need two people to approve.'
  const files = wrote.map((f) => `  ${f.padEnd(18)}${PURPOSE[f] ?? ''}`.trimEnd())
  const base = branch.isGuessed
    ? `Changes are measured against ${branch.name} (guessed: set "defaultBranch" in devloop.json if that is wrong).`
    : `Changes are measured against ${branch.name}.`
  return [
    SET_UP_HEADLINE,
    '',
    'What it will do here',
    `  - ${mode}`,
    `  - ${checks}`,
    '  - Before anything is pushed, a second agent reviews the change.',
    `  - ${approvers}`,
    '',
    'Files it added',
    ...files,
    ...(kept.length > 0 ? [`Already there, left as is: ${kept.join(', ')}`] : []),
    '',
    base,
    'Change these later in devloop.json: "mode", "verify", "approvals".',
    'Next: /devloop-doctor checks the setup.',
  ].join('\n')
}
