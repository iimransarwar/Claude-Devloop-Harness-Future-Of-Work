// Where the harness writes its records (C2): each validated against its
// schema when written (an invalid one is a bug, recorded loudly in the
// ledger and never stored), the audit trail appended outside the working
// tree, and the few helpers the person's commands share: who a command came
// from, and the confirmation dialog.

import type { CommandRunInput } from 'claude-code'

import type { Config } from './config'
import { costStep, EMPTY_COSTS } from './ledger'
import type { CostEvent, Costs } from './ledger'
import { policyHash } from './portable'
import { auditLine, clip, HARNESS_VERSION, validate } from './records'
import type { Actor, AuditAction, AuditEvent, Inputs, SchemaId } from './records'
import { bump, record, stateDirOf } from './state'
import type { Engine } from './state'

/**
 * Whether the command came from a person's own hand at the prompt: the
 * composer, or the Remote Control bridge. Not a plugin, the SDK host, a
 * peer or a schedule. Every key of principle 3 also asks a confirmation.
 */
export function isFromPerson(e: CommandRunInput): boolean {
  return ['composer', 'bridge'].includes((e.origin as { kind?: string } | undefined)?.kind ?? '')
}

/** Who a command came from, as the audit trail names it: a person (by origin), or what the origin says it is. */
export function actorOf(e: CommandRunInput): Actor {
  const origin = (e.origin as { kind?: string; name?: string } | undefined) ?? {}

  return isFromPerson(e) ? { kind: 'person', name: origin.kind ?? null } : { kind: 'agent', name: origin.name ?? origin.kind ?? null }
}

/** Asks the person to confirm one of the keys they hold; anything but `yes` (or no answer) is a no. */
export async function confirm($: Engine, question: string, yes: string, no: string): Promise<boolean> {
  return (await $.ui.ask(question, [yes, no]).catch(() => no)) === yes
}

/** A hash of the policy in force: what a record names as the policy that produced it. */
export { policyHash }

/** What produced a record: the policy, the model, the harness, the tree (and, for evals, the suite). */
export async function inputsOf($: Engine, cfg: Config, tree: string | null, suite?: Record<string, string>): Promise<Inputs> {
  const model = cfg.models.eval !== null && suite !== undefined ? cfg.models.eval : await $.session.model().catch(() => 'unknown')

  return { policy: policyHash(cfg), model: model === '' ? 'unknown' : model, harness: HARNESS_VERSION, tree, ...(suite === undefined ? {} : { suite }) }
}

/** A list kept in the store. */
export async function listOf<T>($: Engine, key: string): Promise<T[]> {
  const kept = await $.store.get(key)

  return Array.isArray(kept) ? (kept as T[]) : []
}

/** Says an invalid record out loud: the ledger, a counter, a toast. Never stores it. */
async function invalid($: Engine, root: string, id: string, problems: readonly string[]): Promise<void> {
  await record($, root, 'record-invalid', id, problems.slice(0, 4).join('; '))
  $.ui.toast(`devloop: a ${id} record failed its schema and was not stored (${clip(problems[0] ?? '', 120)}). That is a bug in devloop; it is in the ledger.`, { timeoutMs: 15_000 })
}

/**
 * Validates a record against its schema and appends it to a list in the
 * store, the newest `cap` kept. False when it did not fit: it is then
 * recorded as a bug and not stored.
 */
export async function keepRecord($: Engine, root: string, id: SchemaId, key: string, value: unknown, cap = 200): Promise<boolean> {
  const problems = validate(id, value)
  if (problems.length > 0) {
    await invalid($, root, id, problems)

    return false
  }
  await $.store.set(key, [...(await listOf($, key)), value].slice(-cap))

  return true
}

/** Validates a record that is kept elsewhere (a finding inside the loop): false, and said out loud, when it does not fit. */
export async function checkRecord($: Engine, root: string, id: SchemaId, value: unknown): Promise<boolean> {
  const problems = validate(id, value)
  if (problems.length > 0) {
    await invalid($, root, id, problems)

    return false
  }

  return true
}

// ---------------------------------------------------------------- the audit trail

/**
 * The audit trail (C2.1 F5) is written in small numbered segments under the
 * repository's state folder: `audit/000001.jsonl`, `audit/000002.jsonl`, …
 * An append reads and rewrites only the current segment; a segment that
 * holds `AUDIT_SEGMENT` events is closed and the next begun; a read that
 * fails begins a new segment and never overwrites the one it could not
 * read. The newest `AUDIT_SEGMENTS_KEPT` segments are the live trail; older
 * ones stay on disk beside them as the archive, no longer read.
 */
export const AUDIT_SEGMENT = 200
export const AUDIT_SEGMENTS_KEPT = 50

/** The folder that holds a repository's audit segments: the harness's state, outside the working tree, never written by a tool call. */
export async function auditDir($: Engine, root: string): Promise<string> {
  return `${await stateDirOf($, root)}/audit`
}

/** Where segment `n` is. */
export const segmentPath = (dir: string, n: number): string => `${dir}/${String(n).padStart(6, '0')}.jsonl`

/** Where the trail stands, kept in the store: the current segment, its events, the oldest live one, and the events written. */
export type AuditSegments = { current: number; events: number; first: number; total: number }

const NO_SEGMENTS: AuditSegments = { current: 1, events: 0, first: 1, total: 0 }

/** The segments' state as kept. */
export async function auditSegmentsOf($: Engine, root: string): Promise<AuditSegments> {
  const kept = (await $.store.get(`audit-segments:${root}`)) as AuditSegments | undefined

  return kept === undefined || typeof kept !== 'object' || kept === null || typeof kept.current !== 'number' ? NO_SEGMENTS : kept
}

/**
 * Where one more event goes, pure: the segment to write and the state after.
 * `read` is what the current segment held, or null when it could not be read
 * (then a new segment begins). Old segments past the kept total move to the
 * archive by `first` alone.
 */
export function nextSegment(state: AuditSegments, read: string | null, keep = AUDIT_SEGMENT, kept = AUDIT_SEGMENTS_KEPT): { write: number; before: string; state: AuditSegments } {
  const isNew = state.events >= keep || (state.events > 0 && read === null)
  const write = isNew ? state.current + 1 : state.current
  const before = isNew || read === null ? '' : read
  const first = Math.max(state.first, write - kept + 1)

  return { write, before, state: { current: write, events: (isNew ? 0 : state.events) + 1, first, total: state.total + 1 } }
}

/** Appends run one after another, so two events never overwrite each other. */
let chain: Promise<unknown> = Promise.resolve()

/** Appends one line to the current segment, reading only that segment; a read that fails begins the next. */
export async function appendAudit($: Engine, root: string, line: string, keep = AUDIT_SEGMENT): Promise<void> {
  const dir = await auditDir($, root)
  const state = await auditSegmentsOf($, root)
  const current = segmentPath(dir, state.current)
  const read = state.events === 0 ? '' : await $.fs.read(current).then(text => (typeof text === 'string' ? text : null), () => null)
  const step = nextSegment(state, read, keep)
  await $.fs.write(segmentPath(dir, step.write), `${step.before}${line}\n`)
  await $.store.set(`audit-segments:${root}`, step.state)
}

/**
 * Appends one event to the audit trail: append-only, one JSON line each,
 * keys and the first line of things only (skills note 6). An event that
 * does not fit its schema is recorded as a bug instead. Best effort: a
 * failure to write never changes what the caller does.
 */
export async function audit($: Engine, root: string, action: AuditAction, actor: Actor, subject: string, tree: string | null, detail = ''): Promise<void> {
  const at = await $.clock.now().catch(() => 0)
  const event: AuditEvent = { schema: 'audit-event@1', at, action, actor, subject: clip(subject, 200), tree, detail: clip(detail, 600) }
  const problems = validate('audit-event@1', event)
  if (problems.length > 0) {
    await invalid($, root, 'audit-event@1', problems).catch(() => undefined)

    return
  }
  const step = chain.then(() => appendAudit($, root, JSON.stringify(event)))
  chain = step.catch(() => undefined)
  await step.catch(() => undefined)
  await bump($, root, `audit:${action}`).catch(() => undefined)
}

/** The live trail's events, oldest first (its segments in order); lines that do not parse, and segments that cannot be read, are skipped. */
export async function auditOf($: Engine, root: string): Promise<AuditEvent[]> {
  await chain
  const dir = await auditDir($, root)
  const state = await auditSegmentsOf($, root)
  const out: AuditEvent[] = []
  for (let n = state.first; n <= state.current; n += 1) {
    const text = await $.fs.read(segmentPath(dir, n)).catch(() => '')
    for (const line of (typeof text === 'string' ? text : '').split('\n').filter(one => one.trim() !== '')) {
      try {
        const one = JSON.parse(line) as AuditEvent
        if (validate('audit-event@1', one).length === 0) {
          out.push(one)
        }
      } catch {
        // A line that does not parse is skipped.
      }
    }
  }

  return out
}

/** The last `n` events as `/devloop audit` prints them. */
export async function auditReport($: Engine, root: string, n: number): Promise<string> {
  const all = await auditOf($, root)
  const last = all.slice(-n)
  const state = await auditSegmentsOf($, root)
  const dir = await auditDir($, root)
  const archived = state.first <= 1
    ? ''
    : `${state.first - 1} older segment${state.first - 1 === 1 ? ' is' : 's are'} archived beside the live ones (${segmentPath(dir, 1)}${state.first > 2 ? ` to ${segmentPath(dir, state.first - 1)}` : ''}); the live trail is the newest ${AUDIT_SEGMENTS_KEPT} segments of ${AUDIT_SEGMENT} events.`

  return [
    last.length === 0
      ? `No audit events in the live trail. It is kept in ${dir} (outside the working tree).`
      : [`Audit trail, the last ${last.length} of ${all.length} live events (kept in ${dir}, ${state.current - state.first + 1} segment${state.current === state.first ? '' : 's'}):`, ...last.map(auditLine)].join('\n'),
    archived,
  ].filter(line => line !== '').join('\n')
}

// ---------------------------------------------------------------- failures that feed the eval suite

/** An eval-task candidate the harness suggests from a failure, until a person adopts it. */
export type Suggestion = { id: string; at: number; source: 'defect' | 'review-failed' | 'closed-gate-open'; text: string; change: string | null; status: 'open' | 'adopted' }

/** Records a failure as an eval-task suggestion (never a file, until a person adopts it: /devloop eval adopt). */
export async function suggestEval($: Engine, root: string, source: Suggestion['source'], text: string, change: string | null): Promise<void> {
  const list = await listOf<Suggestion>($, `evalsuggest:${root}`)
  const at = await $.clock.now()
  await $.store.set(`evalsuggest:${root}`, [...list, { id: `s${list.length + 1}`, at, source, text: clip(text.split('\n')[0] ?? '', 200), change, status: 'open' as const }].slice(-200))
}

// ---------------------------------------------------------------- the cost meter

/**
 * One step of the cost meter (skills note 4): the session's cost estimate
 * sampled now, the difference since the last sample attributed to the units
 * of work open, then the event applied. An estimate, and best effort: a
 * failure here changes nothing else.
 */
export async function meterCost($: Engine, root: string, event: CostEvent): Promise<void> {
  try {
    const usd = (await $.session.usage().catch(() => null))?.cost?.usd
    const sessionId = await $.session.id().catch(() => null)
    const key = `costs:${root}`
    const before = ((await $.store.get(key)) as Costs | undefined) ?? EMPTY_COSTS
    await $.store.set(key, costStep(before, usd === undefined ? null : { sessionId, usd }, event))
  } catch {
    // The meter is an estimate; losing one sample loses nothing that gates.
  }
}
