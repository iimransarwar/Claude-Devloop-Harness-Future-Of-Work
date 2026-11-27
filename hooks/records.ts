// The harness's records: each a named, versioned shape with a JSON Schema
// (coordination note 3), validated whenever one is written, so an invalid
// record is a bug said out loud, never one stored quietly. The schemas here
// are the system of record; schemas/<id>.json are these, written out, and
// tests/smoke.sh checks the two are the same. Pure: no `$`, and no import
// but types, so the smoke test can load this file on its own.

/** The harness's own version, carried in every record it writes (plugin.json says the same; smoke.sh checks). */
export const HARNESS_VERSION = '0.6.1'

/** The subset of JSON Schema (2020-12) these records use, and the validator below reads. */
export type Schema = {
  $schema?: string
  $id?: string
  title?: string
  description?: string
  type?: 'object' | 'array' | 'string' | 'integer' | 'number' | 'boolean' | 'null' | readonly ('object' | 'array' | 'string' | 'integer' | 'number' | 'boolean' | 'null')[]
  properties?: Readonly<Record<string, Schema>>
  required?: readonly string[]
  additionalProperties?: boolean | Schema
  items?: Schema
  enum?: readonly (string | number | boolean | null)[]
  const?: string | number | boolean | null
  minimum?: number
  minLength?: number
  maxLength?: number
  maxItems?: number
  pattern?: string
}

const str = (maxLength = 300): Schema => ({ type: 'string', maxLength })
const text = (maxLength = 300): Schema => ({ type: 'string', maxLength })
const nullableText = (maxLength = 300): Schema => ({ type: ['string', 'null'], maxLength })
const int: Schema = { type: 'integer', minimum: 0 }
const time: Schema = { type: 'integer', minimum: 0, description: 'milliseconds since the epoch' }
const bool: Schema = { type: 'boolean' }
const strings = (maxItems = 500, maxLength = 300): Schema => ({ type: 'array', items: str(maxLength), maxItems })
const obj = (properties: Record<string, Schema>, required: readonly string[] = Object.keys(properties)): Schema =>
  ({ type: 'object', properties, required, additionalProperties: false })

/** What produced a record: the policy, the model, the harness and the tree (nanochat note 2). */
const INPUTS: Schema = obj({
  policy: { type: 'string', maxLength: 64, description: 'a hash of the devloop.json in force' },
  model: str(120),
  harness: str(40),
  tree: { type: ['string', 'null'], maxLength: 80 },
  suite: { type: 'object', additionalProperties: { type: 'string', maxLength: 64 }, description: 'eval task id to the hash of its task file' },
}, ['policy', 'model', 'harness', 'tree'])

const SEVERITY: Schema = { enum: ['critical', 'high', 'medium', 'low', 'nit'] }
const TIER: Schema = { enum: ['none', 'low', 'medium', 'high'] }
const ROW: Schema = obj({ label: str(120), isMet: bool, note: str(600) })
const ACTOR: Schema = obj({
  kind: { enum: ['person', 'builder', 'agent', 'harness'] },
  name: nullableText(120),
}, ['kind', 'name'])

/** Every action the audit trail records. */
export const AUDIT_ACTIONS = [
  'spec-approved', 'spec-reopened', 'exemption-granted', 'change-closed', 'review-verdict', 'finding-resolved', 'refusal', 'policy-error',
  'budget-set', 'regression-dropped', 'rule-tombstoned', 'papercut-closed', 'defect-recorded', 'eval-adopted', 'eval-started', 'shipped-ungated', 'record-invalid', 'handoff-exported',
  'module-skipped', 'module-absent', 'git-hook-installed', 'git-hook-removed', 'evidence-noted',
  'claim-taken', 'claim-lapsed', 'claim-takeover', 'claim-released', 'followup-stopped', 'checklist-promoted', 'checklist-demoted', 'checklist-adjudicated',
  'cache-guard-installed', 'cache-guard-removed', 'harness-state-changed', 'answer-unchecked', 'loop-limit', 'loop-continued',
  'learned-rule-promoted', 'learned-rule-dropped',
  'library-saved', 'library-save-stopped', 'library-path-set', 'library-removed',
  'settings-changed',
] as const

const withTag = (id: string, title: string, properties: Record<string, Schema>, required: readonly string[] = Object.keys(properties)): Schema => ({
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: `devloop/${id}`,
  title,
  type: 'object',
  properties: { schema: { const: id }, ...properties },
  required: ['schema', ...required],
  additionalProperties: false,
})

/** Every record shape the harness writes, by id. */
export const SCHEMAS = {
  'finding@1': withTag('finding@1', 'A review finding as the harness keeps it', {
    id: { type: 'string', pattern: '^F\\d+$' },
    reviewer: str(60),
    severity: SEVERITY,
    file: str(400),
    line: int,
    quote: text(600),
    problem: text(1000),
    evidence: text(1000),
    isPreExisting: bool,
    route: { enum: ['fix', 'decision', 'defer'] },
    status: { enum: ['open', 'closed', 'resolved', 'note', 'deferred'] },
    isBlocking: bool,
    round: int,
    seen: int,
    note: nullableText(600),
  }),
  'papercut@1': withTag('papercut@1', 'A friction report the agent filed', {
    id: { type: 'string', pattern: '^pc\\d+$' },
    at: time,
    group: { type: 'string', pattern: '^p-[0-9a-f]{6}$' },
    subject: nullableText(120),
    tried: text(),
    expected: text(),
    happened: text(),
    suggestedFix: text(),
    actor: ACTOR,
  }),
  'handoff@1': withTag('handoff@1', 'A handoff entry: the builder\'s narrative (or none) and the harness\'s facts', {
    at: time,
    by: { enum: ['builder', 'person'] },
    file: str(200),
    objective: nullableText(600),
    nextStep: nullableText(600),
    decisions: int,
    deadEnds: int,
    assumptions: int,
    files: strings(15, 400),
    facts: obj({ phase: { enum: ['idle', 'spec', 'build'] }, spec: nullableText(60), tree: nullableText(80), changed: int, openFindings: int }),
  }),
  'change-record@1': withTag('change-record@1', 'A closed change, written at /devloop done', {
    id: { type: 'string', pattern: '^C\\d+$' },
    closedAt: time,
    startedAt: time,
    durationMs: int,
    spec: nullableText(60),
    task: nullableText(120),
    tier: TIER,
    tierWhy: strings(20),
    files: strings(2000, 400),
    lines: int,
    fixRounds: int,
    reviewRounds: int,
    isFirstPass: { type: ['boolean', 'null'] },
    vacuous: strings(100),
    exemptionsUsed: strings(100, 400),
    findings: obj({ blocking: int, deferred: int, resolvedByPerson: int }),
    gate: obj({ isGreen: bool, unmet: strings(40, 600) }),
    costUsd: { type: ['number', 'null'], minimum: 0, description: 'an estimate' },
    cacheHitRate: { type: ['number', 'null'], minimum: 0 },
    attestation: {
      type: ['object', 'null'],
      properties: { by: { const: 'person' }, at: time, read: { type: 'array', items: { enum: ['diff', 'tests', 'instructions'] }, maxItems: 3 } },
      required: ['by', 'at', 'read'],
      additionalProperties: false,
    },
    inputs: INPUTS,
  }, ['id', 'closedAt', 'startedAt', 'durationMs', 'spec', 'tier', 'tierWhy', 'files', 'lines', 'fixRounds', 'reviewRounds', 'isFirstPass', 'vacuous', 'exemptionsUsed', 'findings', 'gate', 'costUsd', 'cacheHitRate', 'attestation', 'inputs']),
  'eval-result@1': withTag('eval-result@1', 'One eval task\'s result in one run (one pass of an ablation)', {
    run: str(40),
    pass: { enum: ['main', 'baseline-1', 'baseline-2', 'without'] },
    kind: { enum: ['full', 'quick'] },
    task: str(80),
    taskHash: str(64),
    outcome: { enum: ['pass', 'fail', 'infra'] },
    trials: { type: 'array', maxItems: 10, items: obj({ outcome: { enum: ['pass', 'fail', 'infra'] }, note: str(300), calls: int, costUsd: { type: ['number', 'null'], minimum: 0 } }) },
    successRate: { type: ['number', 'null'], minimum: 0 },
    without: nullableText(200),
    at: time,
    inputs: INPUTS,
  }),
  'gate@1': withTag('gate@1', 'The gate as it was judged at one moment', {
    at: time,
    why: { enum: ['gate-command', 'shipping', 'shipped', 'done'] },
    tier: TIER,
    isGreen: bool,
    rows: { type: 'array', items: ROW, maxItems: 60 },
    inputs: INPUTS,
  }),
  'evidence@2': withTag('evidence@2', 'Portable evidence of a review, as a git note on the reviewed commit (refs/notes/devloop): a record, not a signature', {
    at: time,
    why: { enum: ['review', 'done'] },
    tree: { type: 'string', maxLength: 80, description: 'the committable tree the evidence covers, equal to the commit\'s tree' },
    full: { type: 'string', maxLength: 80, description: 'the full tree verified, ignored instruction files included' },
    head: str(80),
    policy: { type: 'string', maxLength: 64, description: 'a hash of the devloop.json in force' },
    checks: { type: 'array', maxItems: 100, items: obj({ run: str(600), tree: str(80) }) },
    reviewers: { type: 'array', maxItems: 20, items: obj({ name: str(60), mode: { enum: ['general', 'blocking', 'shadow'] }, verdict: { enum: ['pass', 'fail'] }, round: int }) },
    open: int,
    checklistFails: { ...strings(60, 120), description: 'promoted checklist items that failed on the reviewed tree (list/item): the round is a failing one wherever this note is read' },
    harness: str(40),
  }, ['at', 'why', 'tree', 'head', 'policy', 'checks', 'reviewers', 'open', 'checklistFails', 'harness']),
  'checklist@1': withTag('checklist@1', 'A checklist: checkable statements about a kind of change, kept in checklists/<id>.json on the base branch (D2)', {
    id: { type: 'string', pattern: '^[a-z0-9][a-z0-9-]{0,40}$' },
    version: { type: 'integer', minimum: 1 },
    title: str(80),
    appliesTo: {
      type: 'object',
      properties: { surfaces: strings(20, 40), paths: strings(40, 200), detect: str(400) },
      required: [],
      additionalProperties: false,
    },
    maxItems: { type: 'integer', minimum: 1 },
    items: {
      type: 'array',
      maxItems: 60,
      items: obj({
        id: { type: 'string', pattern: '^[A-Za-z0-9][A-Za-z0-9_.-]{0,40}$' },
        statement: { type: 'string', minLength: 10, maxLength: 400 },
        why: { type: 'string', minLength: 5, maxLength: 300 },
        severity: { enum: ['critical', 'high', 'medium', 'low'] },
        verify: obj({
          by: { enum: ['pattern', 'check', 'review', 'runtime', 'person'] },
          how: { type: 'string', minLength: 10, maxLength: 600 },
          pattern: str(400),
          expect: { enum: ['present', 'absent'] },
          check: str(600),
        }, ['by', 'how']),
        naWhen: strings(10, 200),
        ref: str(200),
        status: { enum: ['active', 'retired'] },
      }, ['id', 'statement', 'why', 'severity', 'verify']),
    },
  }),
  'checklist-result@1': withTag('checklist-result@1', 'One checklist item\'s result on one tree: by the harness (pattern, check) or the checklist reviewer (review) (D2)', {
    at: time,
    list: { type: 'string', pattern: '^[a-z0-9][a-z0-9-]{0,40}$' },
    version: { type: 'integer', minimum: 1 },
    item: str(41),
    by: { enum: ['pattern', 'check', 'review', 'runtime', 'person'] },
    status: { enum: ['pass', 'fail', 'na', 'unverified'] },
    evidence: text(600),
    tree: nullableText(80),
    round: int,
    source: { enum: ['harness', 'reviewer'] },
  }),
  'library-entry@1': withTag('library-entry@1', 'One spec in the spec library: entry.json in its folder, and (without the criteria) a line of the library\'s index.jsonl (DESIGN 4.18)', {
    id: { type: 'string', pattern: '^[A-Za-z0-9._-]+--[A-Za-z0-9._-]+--\\d{4}-\\d{2}-\\d{2}$', maxLength: 200, description: 'the entry\'s folder: <project>--<spec name>--<yyyy-mm-dd>' },
    project: str(80),
    spec: str(80),
    kind: nullableText(80),
    size: nullableText(20),
    related: strings(20, 120),
    intent: text(400),
    criteria: { ...strings(40, 600), description: 'the acceptance criteria, text only: in entry.json, never in the index' },
    features: { type: 'array', maxItems: 100, items: obj({ id: str(120), description: text(600), check: str(600) }) },
    approvedAt: { type: ['integer', 'null'], minimum: 0, description: 'milliseconds since the epoch' },
    closedAt: { type: ['integer', 'null'], minimum: 0, description: 'milliseconds since the epoch; null while the change is open' },
    outcome: obj({
      status: { enum: ['closed', 'open'] },
      isAllPassing: { type: ['boolean', 'null'], description: 'closed with every feature passing; null while open' },
      reviewRounds: int,
      defects: { type: 'integer', minimum: 0, description: 'escaped defects recorded later against the change' },
    }),
    harness: str(40),
    hash: { type: 'string', maxLength: 64, description: 'a hash of SPEC.md and features.json as copied' },
    savedAt: time,
    removedAt: { ...time, description: 'set on the index line that marks the entry removed' },
  }, ['id', 'project', 'spec', 'kind', 'size', 'related', 'intent', 'features', 'approvedAt', 'closedAt', 'outcome', 'harness', 'hash', 'savedAt']),
  'audit-event@1': withTag('audit-event@1', 'One action that changed what may ship', {
    at: time,
    action: { enum: AUDIT_ACTIONS },
    actor: ACTOR,
    subject: text(200),
    tree: nullableText(80),
    detail: text(600),
  }),
} satisfies Record<string, Schema>

export type SchemaId = keyof typeof SCHEMAS

const typeOf = (value: unknown): string =>
  value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value === 'number' ? (Number.isInteger(value) ? 'integer' : 'number') : typeof value

/** The problems with a value against a schema, each naming its path; empty when it fits. */
export function check(schema: Schema, value: unknown, path = '$'): string[] {
  const out: string[] = []
  if (schema.const !== undefined && value !== schema.const) {
    return [`${path}: expected ${JSON.stringify(schema.const)}`]
  }
  if (schema.enum !== undefined && !schema.enum.includes(value as never)) {
    return [`${path}: expected one of ${schema.enum.map(one => JSON.stringify(one)).join(', ')}`]
  }
  if (schema.type !== undefined) {
    const types: readonly string[] = typeof schema.type === 'string' ? [schema.type] : schema.type
    const actual = typeOf(value)
    if (!types.includes(actual) && !(actual === 'integer' && types.includes('number'))) {
      return [`${path}: expected ${types.join(' or ')}, found ${actual}`]
    }
  }
  if (typeof value === 'string') {
    if (schema.maxLength !== undefined && value.length > schema.maxLength) {
      out.push(`${path}: longer than ${schema.maxLength} characters`)
    }
    if (schema.minLength !== undefined && value.length < schema.minLength) {
      out.push(`${path}: shorter than ${schema.minLength} characters`)
    }
    if (schema.pattern !== undefined && !new RegExp(schema.pattern).test(value)) {
      out.push(`${path}: does not match ${schema.pattern}`)
    }
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      out.push(`${path}: not a finite number`)
    } else if (schema.minimum !== undefined && value < schema.minimum) {
      out.push(`${path}: below ${schema.minimum}`)
    }
  }
  if (Array.isArray(value)) {
    if (schema.maxItems !== undefined && value.length > schema.maxItems) {
      out.push(`${path}: more than ${schema.maxItems} items`)
    }
    if (schema.items !== undefined) {
      const items = schema.items
      value.forEach((one, i) => out.push(...check(items, one, `${path}[${i}]`)))
    }
  }
  if (typeOf(value) === 'object') {
    const record = value as Record<string, unknown>
    for (const key of schema.required ?? []) {
      if (!(key in record) || record[key] === undefined) {
        out.push(`${path}.${key}: missing`)
      }
    }
    for (const [key, one] of Object.entries(record)) {
      if (one === undefined) {
        continue
      }
      const known = schema.properties?.[key]
      if (known !== undefined) {
        out.push(...check(known, one, `${path}.${key}`))
      } else if (schema.additionalProperties === false) {
        out.push(`${path}.${key}: unknown field`)
      } else if (typeof schema.additionalProperties === 'object') {
        out.push(...check(schema.additionalProperties, one, `${path}.${key}`))
      }
    }
  }

  return out
}

/** The problems with a record of a named shape; empty when it fits. */
export const validate = (id: SchemaId, value: unknown): string[] => check(SCHEMAS[id], value)

/** The JSON a schema file holds: what schemas/<id>.json must say, byte for byte. */
export const schemaFile = (id: SchemaId): string => `${JSON.stringify(SCHEMAS[id], null, 2)}\n`

export type Actor = { kind: 'person' | 'builder' | 'agent' | 'harness'; name: string | null }

export type Inputs = { policy: string; model: string; harness: string; tree: string | null; suite?: Record<string, string> }

export type AuditAction = (typeof AUDIT_ACTIONS)[number]

export type AuditEvent = { schema: 'audit-event@1'; at: number; action: AuditAction; actor: Actor; subject: string; tree: string | null; detail: string }

/** One audit line as `/devloop audit` prints it: time, actor, action, subject, tree, detail. */
export function auditLine(one: AuditEvent): string {
  const who = one.actor.name === null ? one.actor.kind : `${one.actor.kind}:${one.actor.name}`
  const when = new Date(one.at).toISOString().replace(/\.\d+Z$/, 'Z')

  return `${when}  ${who.padEnd(16)} ${one.action.padEnd(18)} ${one.subject}${one.tree === null ? '' : `  [tree ${one.tree.slice(0, 8)}]`}${one.detail === '' ? '' : `  ${one.detail}`}`
}

/** Cuts a text to a record field's length, so a long value fits rather than failing the record. */
export const clip = (value: string, max = 300): string => (value.length > max ? `${value.slice(0, max - 1)}…` : value)

/** The first line of a text, cut: what the privacy rule lets a record keep of a failure (skills note 6). */
export const firstLine = (value: string, max = 200): string => clip(value.split('\n').map(line => line.trim()).find(line => line !== '') ?? '', max)
