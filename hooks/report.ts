// Measurement and reporting (C2, DESIGN 4.9; skills note 4; nanochat note
// 8; rea "human attestation"): the change record written at /devloop done,
// the numbers /devloop metrics shows, and the change report for a pull
// request body with its reading aid and disclosure block. Deterministic:
// built from records, never from a model. Pure: no `$`.

import type { Finding, Loop, Tier } from '../types'
import type { Config } from './config'
import type { RunRecord } from './evalplan'
import { headline } from './evalplan'
import type { Check, GateFacts } from './gate'
import { blastReasons, coverageOf, specialistsFor, tierFor } from './gate'
import type { AuditEvent, Inputs } from './records'
import { clip } from './records'
import { instructionGlobs, matchesAny } from './rules'

export type Attestation = { by: 'person'; at: number; read: ('diff' | 'tests' | 'instructions')[] }

export type ChangeRecord = {
  schema: 'change-record@1'
  id: string
  closedAt: number
  startedAt: number
  durationMs: number
  spec: string | null
  /** The `.tasks` task the spec was started under (D2), or null. */
  task?: string | null
  tier: Tier
  tierWhy: string[]
  files: string[]
  lines: number
  fixRounds: number
  reviewRounds: number
  isFirstPass: boolean | null
  vacuous: string[]
  exemptionsUsed: string[]
  findings: { blocking: number; deferred: number; resolvedByPerson: number }
  gate: { isGreen: boolean; unmet: string[] }
  costUsd: number | null
  cacheHitRate: number | null
  attestation: Attestation | null
  inputs: Inputs
}

/** An escaped defect: found after the change closed, by a person or a regression check. */
export type Defect = { at: number; change: string | null; text: string; source: 'person' | 'regression' }

// ---------------------------------------------------------------- tiers, file by file

export type FileTier = { file: string; tier: Exclude<Tier, 'none'>; why: string }

/** Each changed file's tier and the reason, riskiest first: the reading aid's order. */
export function fileTiers(files: readonly string[], cfg: Config, spec: string | null = null): FileTier[] {
  const rank = { high: 0, medium: 1, low: 2 }

  return files.map((file): FileTier => {
    if (spec !== null && file.startsWith(`specs/${spec}/`)) {
      return { file, tier: 'low', why: 'the active spec' }
    }
    if (matchesAny(file, instructionGlobs(cfg))) {
      return { file, tier: 'high', why: 'an instruction file: every later session reads it' }
    }
    if (matchesAny(file, cfg.protected)) {
      return { file, tier: 'high', why: 'a protected path' }
    }
    if (matchesAny(file, cfg.tiers.high)) {
      return { file, tier: 'high', why: 'a high-risk path (tiers.high)' }
    }
    if (matchesAny(file, cfg.tests)) {
      return { file, tier: 'medium', why: 'a test: read its diff first' }
    }
    if (matchesAny(file, cfg.tiers.low)) {
      return { file, tier: 'low', why: 'a low-risk path (tiers.low)' }
    }

    return { file, tier: 'medium', why: 'code' }
  }).sort((a, b) => rank[a.tier] - rank[b.tier] || a.file.localeCompare(b.file))
}

/** Why the change has its tier: the riskiest files' reasons and the blast radius. */
export function tierReasons(loop: Pick<Loop, 'changed' | 'size' | 'spec'>, cfg: Config): string[] {
  const tiers = fileTiers(loop.changed, cfg, loop.spec)
  const top = tiers[0]
  const out = top === undefined ? [] : tiers.filter(one => one.tier === top.tier).slice(0, 3).map(one => `${one.file}: ${one.why}`)

  return [...out, ...blastReasons(loop.changed, loop.size.lines, cfg).map(reason => `blast radius: ${reason}`)].map(one => clip(one, 300))
}

// ---------------------------------------------------------------- the change record

/** The facts of a change record that are not in the loop. */
export type RecordFacts = {
  id: string
  now: number
  rows: readonly Check[]
  costUsd: number | null
  cacheHitRate: number | null
  attestation: Attestation | null
  inputs: Inputs
  deferred: number
}

/** The change record (change-record@1): what the change was, how it went, and what produced the record. */
export function changeRecord(loop: Loop, cfg: Config, facts: RecordFacts): ChangeRecord {
  const tier = tierFor(loop, cfg)
  const startedAt = loop.tally.startedAt ?? facts.now
  const unmet = facts.rows.filter(row => !row.isMet)
  const reviewed = loop.review.round > 0

  return {
    schema: 'change-record@1',
    id: facts.id,
    closedAt: facts.now,
    startedAt,
    durationMs: Math.max(0, facts.now - startedAt),
    spec: loop.spec,
    task: loop.task,
    tier,
    tierWhy: tierReasons(loop, cfg),
    files: loop.changed.slice(0, 2000).map(file => clip(file, 400)),
    lines: loop.size.lines,
    fixRounds: loop.tally.fixRounds,
    reviewRounds: loop.review.round,
    isFirstPass: reviewed ? loop.review.round === 1 && loop.review.status === 'pass' : null,
    vacuous: loop.approval?.vacuous ?? [],
    exemptionsUsed: loop.exemptionsUsed.map(one => clip(one, 400)),
    findings: {
      blocking: loop.findings.filter(one => one.isBlocking && one.status !== 'note').length,
      deferred: facts.deferred,
      resolvedByPerson: loop.findings.filter(one => one.status === 'resolved').length,
    },
    gate: { isGreen: unmet.length === 0, unmet: unmet.map(row => clip(`${row.label}: ${row.note}`, 600)) },
    costUsd: facts.costUsd === null ? null : Math.round(facts.costUsd * 10_000) / 10_000,
    cacheHitRate: facts.cacheHitRate,
    attestation: facts.attestation,
    inputs: facts.inputs,
  }
}

/** The attestation the person's answer gives: the rows they read, from the dialog's comma-joined answer. */
export function attestationOf(answer: string, at: number): Attestation | null {
  const words = answer.toLowerCase()
  const read: Attestation['read'] = []
  if (/\bdiff\b/.test(words)) {
    read.push('diff')
  }
  if (/\btest/.test(words)) {
    read.push('tests')
  }
  if (/\binstruction/.test(words)) {
    read.push('instructions')
  }

  return read.length === 0 ? null : { by: 'person', at, read }
}

// ---------------------------------------------------------------- metrics

/** Grounding's counts for one session (DESIGN 4.15), kept as `grounding-session:<root>`. */
export type GroundingSession = { sessionId: string | null; questions: number; unchecked: number }

export type MetricsInput = {
  counters: Readonly<Record<string, number>>
  changes: readonly ChangeRecord[]
  defects: readonly Defect[]
  evals: readonly RunRecord[]
  cacheHitRate: number | null
  /** Grounding's counts for the session in progress, when known. */
  grounding?: GroundingSession | null
}

export type Metrics = {
  changesClosed: number
  escapedDefectRate: number | null
  firstPassReviewRate: number | null
  meanFixRounds: number | null
  meanReviewRounds: number | null
  verificationFailureRate: number | null
  refusalsByRule: Record<string, number>
  flakyChecks: number
  reverts: number
  shadowAgreement: Record<string, number | null>
  evalPassRateByModel: Record<string, { passed: number; counted: number; infra: number; at: number }>
  costPerChange: number | null
  cacheHitRate: number | null
  /** Grounding (DESIGN 4.15): questions of fact asked, and answers given without a look at any source (after the backstop), in the store and in this session. */
  grounding: { questions: number; unchecked: number; session: { questions: number; unchecked: number } | null }
}

const mean = (values: readonly number[]): number | null => (values.length === 0 ? null : values.reduce((a, b) => a + b, 0) / values.length)
const ratio = (part: number, whole: number): number | null => (whole === 0 ? null : part / whole)

/** The numbers /devloop metrics shows, from what is stored. The eval headline is from full runs only. */
export function computeMetrics(input: MetricsInput): Metrics {
  const n = (name: string): number => input.counters[name] ?? 0
  const changes = input.changes
  const defective = new Set(input.defects.map(one => one.change).filter((id): id is string => id !== null))
  const reviewed = changes.filter(one => one.isFirstPass !== null)
  const shadows = [...new Set(Object.keys(input.counters).filter(key => /^shadow:.+:rounds$/.test(key)).map(key => key.slice(7, -7)))]
  const byModel: Metrics['evalPassRateByModel'] = {}
  for (const run of input.evals.filter(one => one.kind === 'full' && one.without === null)) {
    byModel[run.model] = { ...headline(run.results), at: run.completedAt }
  }
  const costs = changes.map(one => one.costUsd).filter((usd): usd is number => usd !== null)

  return {
    changesClosed: changes.length,
    escapedDefectRate: ratio(changes.filter(one => defective.has(one.id)).length, changes.length),
    firstPassReviewRate: ratio(reviewed.filter(one => one.isFirstPass === true).length, reviewed.length),
    meanFixRounds: mean(changes.map(one => one.fixRounds)),
    meanReviewRounds: mean(reviewed.map(one => one.reviewRounds)),
    verificationFailureRate: ratio(n('verify-fail'), n('verify-runs')),
    refusalsByRule: Object.fromEntries(Object.entries(input.counters).filter(([key]) => key.startsWith('rule:')).map(([key, count]) => [key.slice(5), count])),
    flakyChecks: n('verify-flaky'),
    reverts: n('reverts'),
    shadowAgreement: Object.fromEntries(shadows.map(name => [name, ratio(n(`shadow:${name}:agreed`), n(`shadow:${name}:rounds`))])),
    evalPassRateByModel: byModel,
    costPerChange: mean(costs),
    cacheHitRate: input.cacheHitRate,
    grounding: {
      questions: n('grounding-questions'),
      unchecked: n('grounding-unchecked'),
      session: input.grounding === undefined || input.grounding === null ? null : { questions: input.grounding.questions, unchecked: input.grounding.unchecked },
    },
  }
}

const pct = (value: number | null): string => (value === null ? 'n/a' : `${Math.round(value * 100)}%`)
const num = (value: number | null): string => (value === null ? 'n/a' : (Math.round(value * 10) / 10).toString())

/** The metrics in words. */
export function metricsLines(m: Metrics, quick: RunRecord | null): string[] {
  const rules = Object.entries(m.refusalsByRule).sort((a, b) => b[1] - a[1])
  const models = Object.entries(m.evalPassRateByModel)

  return [
    `  changes closed: ${m.changesClosed}; escaped-defect rate: ${pct(m.escapedDefectRate)}`,
    `  first-pass review rate: ${pct(m.firstPassReviewRate)}; mean fix rounds: ${num(m.meanFixRounds)}; mean review rounds: ${num(m.meanReviewRounds)}`,
    `  verification failure rate: ${pct(m.verificationFailureRate)}; flaky checks: ${m.flakyChecks}; reverts: ${m.reverts}`,
    `  refusals by rule: ${rules.length === 0 ? 'none' : rules.map(([rule, count]) => `${rule} ${count}`).join(', ')}`,
    `  shadow-reviewer agreement: ${Object.keys(m.shadowAgreement).length === 0 ? 'no shadow reviewer' : Object.entries(m.shadowAgreement).map(([name, rate]) => `${name} ${pct(rate)}`).join(', ')}`,
    `  eval pass rate by model (full runs only): ${models.length === 0 ? 'no full run yet' : models.map(([model, one]) => `${model} ${one.passed}/${one.counted}${one.infra > 0 ? ` (+${one.infra} infrastructure, not counted)` : ''}`).join(', ')}`,
    quick === null ? '' : `  last quick run (a subset, not the headline): ${headline(quick.results).passed}/${headline(quick.results).counted} on ${quick.model}`,
    `  cost per change: ${m.costPerChange === null ? 'n/a' : `about $${m.costPerChange.toFixed(2)} (an estimate)`}; cache hit rate: ${pct(m.cacheHitRate)}`,
    `  questions of fact: ${m.grounding.questions}; answered without a look at any source: ${m.grounding.unchecked}${m.grounding.session === null ? '' : ` (this session: ${m.grounding.session.questions} and ${m.grounding.session.unchecked})`}`,
  ].filter(line => line !== '')
}

// ---------------------------------------------------------------- the change report

export type ReportInput = {
  loop: Loop
  cfg: Config
  rows: readonly Check[]
  /** The change record when the change is closed; null while it is open. */
  record: ChangeRecord | null
  /** The audit trail's review verdicts for this change. */
  verdicts: readonly AuditEvent[]
  /** The review carry-over's facts (final round, D2 F1): whether the verdict covers this tree is decided from them, as the gate decides it. */
  carry?: GateFacts['carry']
}

const SEVERITY_RANK = { critical: 0, high: 1, medium: 2, low: 3, nit: 4 }

/** Up to three concrete failure scenarios, from open or resolved findings, the most severe first. */
export function scenarios(findings: readonly Finding[]): string[] {
  return findings
    .filter(one => (one.status === 'open' || one.status === 'resolved') && one.file !== '')
    .sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] || a.id.localeCompare(b.id))
    .slice(0, 3)
    .map(one => `${one.id} (${one.severity}, ${one.status === 'open' ? 'open' : 'resolved by a person'}): at ${one.file}:${one.line}, ${clip(one.problem, 200)}${one.evidence === '' ? '' : `; would be closed by: ${clip(one.evidence, 160)}`}`)
}

/** Whether the change could be split, from blast-radius facts: its top folders, and a manifest that could go alone. */
export function splitSuggestion(loop: Pick<Loop, 'changed' | 'size'>, cfg: Config): string {
  const folders = new Map<string, number>()
  for (const file of loop.changed) {
    const top = file.includes('/') ? `${file.slice(0, file.indexOf('/'))}/` : '(root)'
    folders.set(top, (folders.get(top) ?? 0) + 1)
  }
  const reasons = blastReasons(loop.changed, loop.size.lines, cfg)
  const manifests = loop.changed.filter(file => matchesAny(file, cfg.blastRadius.manifests))
  if (reasons.length === 0 && folders.size <= 1) {
    return 'no: one area, inside the blast radius'
  }
  const parts = [...folders].sort((a, b) => b[1] - a[1]).map(([folder, count]) => `${folder} (${count})`)

  return [
    reasons.length > 0 ? `past the blast radius (${reasons.join('; ')})` : 'inside the blast radius',
    folders.size > 1 ? `it spans ${parts.join(', ')}: each could be its own change` : '',
    manifests.length > 0 ? `the dependency change (${manifests.join(', ')}) could ship on its own first` : '',
  ].filter(one => one !== '').join('; ')
}

/** What the reviewers did not look at: a tree they did not see, specialists that did not run, or no review at all. */
export function unreviewed(loop: Loop, cfg: Config, carry: GateFacts['carry'] = {}): string[] {
  const out: string[] = []
  if (loop.review.round === 0) {
    return ['no independent review ran on this change']
  }
  if (coverageOf(loop, { carry }) === 'carried') {
    out.push(`only task state changed after the last review (reviewed ${String(loop.review.tree).slice(0, 8)}, now ${String(loop.tree).slice(0, 8)}): the verdict carries over; verification ran on this tree`)
  } else if (loop.review.tree !== loop.tree) {
    out.push(`the tree moved after the last review (reviewed ${String(loop.review.tree).slice(0, 8)}, now ${String(loop.tree).slice(0, 8)}): the latest edits were not reviewed`)
  }
  const ran = loop.review.agents.map(one => one.name)
  for (const one of specialistsFor(loop, cfg).filter(each => !ran.includes(each.name))) {
    out.push(`the ${one.name} reviewer did not run in the last round`)
  }
  const notes = loop.findings.filter(one => one.status === 'note').length
  if (notes > 0) {
    out.push(`${notes} finding${notes === 1 ? '' : 's'} could not be verified at the line cited (kept as notes)`)
  }

  return out.length === 0 ? ['nothing: the last round covered the current tree'] : out
}

/** The checklist items the approval kept for a person to judge (D2): listed for the approver, never in the gate. */
export const personItems = (loop: Pick<Loop, 'approval'>): string[] => loop.approval?.checklist?.person ?? []

/** The change report for a pull request body: deterministic, from records. */
export function changeReport(input: ReportInput): string {
  const { loop, cfg, rows, record } = input
  const tier = tierFor(loop, cfg)
  const files = fileTiers(loop.changed, cfg, loop.spec)
  const unmet = rows.filter(row => !row.isMet)
  const written = new Set(loop.agentWritten)
  const byAgent = loop.changed.filter(file => written.has(file))
  const notByAgent = loop.changed.filter(file => !written.has(file))
  const attestation = record?.attestation ?? null
  const featureLines = Object.entries(loop.features).map(([id, one]) => `- ${id}: ${one.passes && one.tree === loop.tree ? 'passes on this tree' : one.passes ? 'passed on an earlier tree' : 'not passing'}`)
  const lines = [
    `## ${loop.spec === null ? 'Change' : `Change: ${loop.spec}`}${record === null ? '' : ` (${record.id})`}`,
    '',
    `Risk tier: **${tier}**${tierReasons(loop, cfg).length > 0 ? ` (${tierReasons(loop, cfg).join('; ')})` : ''}. ${loop.changed.length} file${loop.changed.length === 1 ? '' : 's'}, ${loop.size.lines} lines.`,
    `Gate: ${unmet.length === 0 ? 'green' : `not green: ${unmet.map(row => row.label).join(', ')}`}.`,
    loop.task === null || loop.task === undefined ? '' : `Task: \`${loop.task}\` (the .tasks task this spec was started under).`,
    ...(featureLines.length > 0 ? ['', '### Features', ...featureLines] : []),
    '',
    '### Reading aid',
    'Files, riskiest first:',
    ...files.map(one => `- \`${one.file}\` (${one.tier}): ${one.why}`),
    '',
    'What the reviewers did not look at:',
    ...unreviewed(loop, cfg, input.carry).map(one => `- ${one}`),
    ...(personItems(loop).length > 0 ? ['', 'Checklist items judged by a person (never by the automated gate):', ...personItems(loop).map(one => `- ${one}`)] : []),
    '',
    'Failure scenarios to check:',
    ...(scenarios(loop.findings).length > 0 ? scenarios(loop.findings).map(one => `- ${one}`) : ['- none drawn from the findings']),
    '',
    `Could it be split? ${splitSuggestion(loop, cfg)}.`,
    '',
    '### Disclosure',
    `- Written by an agent (its edit tools or commands): ${byAgent.length === 0 ? 'none recorded' : byAgent.slice(0, 20).map(file => `\`${file}\``).join(', ')}${byAgent.length > 20 ? ', …' : ''}`,
    notByAgent.length > 0 ? `- Not written through the agent's tools (a person, or a command the harness did not attribute): ${notByAgent.slice(0, 20).map(file => `\`${file}\``).join(', ')}` : '',
    ...(input.verdicts.length > 0
      ? input.verdicts.map(one => `- Reviewed by ${one.actor.name ?? one.actor.kind} on tree ${String(one.tree).slice(0, 8)}: ${one.detail}`)
      : ['- No review verdict on record for this change']),
    attestation === null
      ? `- A person attested to: ${record === null ? 'nothing yet (attestation is given at /devloop done)' : 'nothing'}`
      : `- A person attested to having read: ${attestation.read.join(', ')} (${new Date(attestation.at).toISOString().slice(0, 10)})`,
    record === null ? '' : `- Record inputs: policy ${record.inputs.policy.slice(0, 8)}, model ${record.inputs.model}, harness ${record.inputs.harness}, tree ${String(record.inputs.tree).slice(0, 8)}`,
    '',
    '_Generated by devloop from its records; costs, where shown, are estimates._',
  ]

  return lines.filter((line, i, all) => line !== '' || (all[i - 1] ?? '') !== '').join('\n')
}
