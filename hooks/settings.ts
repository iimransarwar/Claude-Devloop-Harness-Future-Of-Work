/**
 * The settings panel's model: `devloop.json` text into rows a person picks
 * from, and a picked set of changes back into text. Pure: it reads and writes
 * strings only. Save writes the keys the person changed and nothing else.
 */
import { DEFAULTS, parseConfig } from './config'

export type RowKey = 'mode' | 'tests' | 'scope' | 'autoReview' | 'approvals' | 'grounding' | 'learning' | 'library'

type Option = { value: string; label: string }

export type Row = { key: RowKey; label: string; options: readonly Option[]; current: string; error: string | null }

export type SettingsView = { rows: readonly Row[]; verify: readonly unknown[] }

export type Changes = Partial<Record<RowKey, string>> & { verify?: readonly unknown[] }

type Obj = Record<string, unknown>

const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v)

/** What each picker offers, and the `devloop.json` value each option writes. */
const PICKERS: Record<Exclude<RowKey, 'tests'>, { label: string; path: readonly string[]; options: readonly Option[] }> = {
  mode: { label: 'Mode', path: ['mode'], options: [{ value: 'observe', label: 'Watch only' }, { value: 'enforce', label: 'Block' }] },
  scope: {
    label: 'Which tests',
    path: ['testing', 'scope'],
    options: [{ value: 'targeted', label: 'Only those for changed files' }, { value: 'full', label: 'All of them' }],
  },
  autoReview: { label: 'Auto review', path: ['autoReview'], options: [{ value: 'true', label: 'On' }, { value: 'false', label: 'Off' }] },
  approvals: { label: 'Risky merges', path: ['approvals'], options: [{ value: 'me', label: 'Just me' }, { value: 'two', label: 'Two people' }] },
  grounding: {
    label: 'Check before answering',
    path: ['grounding', 'mode'],
    options: [
      { value: 'same', label: 'Same as mode' },
      { value: 'observe', label: 'Tell me' },
      { value: 'enforce', label: 'Block' },
      { value: 'off', label: 'Off' },
    ],
  },
  learning: {
    label: 'Learn from mistakes',
    path: ['learning', 'auto'],
    options: [{ value: 'trial', label: 'Trial' }, { value: 'propose', label: 'Propose only' }, { value: 'off', label: 'Off' }],
  },
  library: { label: 'Save specs to library', path: ['library', 'save'], options: [{ value: 'auto', label: 'On' }, { value: 'off', label: 'Off' }] },
}

const APPROVALS = { me: { low: 0, medium: 1, high: 1 }, two: { low: 0, medium: 1, high: 2 } } as const

const ORDER: readonly RowKey[] = ['mode', 'tests', 'scope', 'autoReview', 'approvals', 'grounding', 'learning', 'library']

/** The value a picked option writes; undefined for a value the picker does not offer (`custom`, `invalid`, unknown). */
function written(key: Exclude<RowKey, 'tests'>, value: string): unknown {
  if (!PICKERS[key].options.some(o => o.value === value)) {
    return undefined
  }
  if (key === 'autoReview') {
    return value === 'true'
  }
  if (key === 'approvals') {
    return APPROVALS[value as 'me' | 'two']
  }

  return value
}

const dig = (raw: Obj, path: readonly string[]): unknown => path.reduce<unknown>((at, k) => (isObj(at) ? at[k] : undefined), raw)

const show = (v: unknown): string => (typeof v === 'string' ? v : (JSON.stringify(v) ?? 'undefined'))

/** The first parse error that names this field (`testing.scope: ...` or `testing: ...`). */
function errorOf(errors: readonly string[], path: readonly string[], whole: boolean): string | null {
  const names = whole ? [path[0]] : [path.join('.'), path[0]]

  return errors.find(e => names.some(n => e.startsWith(`${n}:`) || (whole && e.startsWith(`${n}.`)))) ?? null
}

function parseObject(text: string): Obj | null {
  try {
    const v: unknown = JSON.parse(text)

    return isObj(v) ? v : null
  } catch {
    return null
  }
}

/** Reads `devloop.json`'s text into the panel's rows, or says why it cannot. */
export function readSettings(text: string): SettingsView | { error: string } {
  const parsed = parseConfig(text)
  const raw = parseObject(text)
  if (!parsed.isParsed || raw === null) {
    return { error: parsed.errors[0] ?? 'devloop.json must hold one JSON object' }
  }
  const { cfg, errors } = parsed
  const current: Record<Exclude<RowKey, 'tests'>, string> = {
    mode: cfg.mode,
    scope: cfg.testing.scope,
    autoReview: String(cfg.autoReview),
    approvals:
      cfg.approvals.low === 0 && cfg.approvals.medium === 1 && cfg.approvals.high === 1
        ? 'me'
        : cfg.approvals.low === 0 && cfg.approvals.medium === 1 && cfg.approvals.high === DEFAULTS.approvals.high
          ? 'two'
          : 'custom',
    grounding: cfg.grounding.mode ?? 'same',
    learning: cfg.learning.auto,
    library: cfg.library.save,
  }
  const rows: Row[] = ORDER.map((key): Row => {
    if (key === 'tests') {
      const shown = cfg.verify.map(s => (s.profile === 'full' ? `${s.run} (before shipping)` : s.run)).join(', ')

      return { key, label: 'Tests', options: [], current: shown === '' ? 'none' : shown, error: errors.find(e => e.startsWith('verify')) ?? null }
    }
    const picker = PICKERS[key]
    const error = errorOf(errors, picker.path, key === 'approvals')
    let options: readonly Option[] = picker.options
    let now = current[key]
    if (error !== null) {
      options = [...options, { value: 'invalid', label: `Invalid in devloop.json: ${show(dig(raw, picker.path))}` }]
      now = 'invalid'
    } else if (now === 'custom') {
      options = [...options, { value: 'custom', label: 'Custom (as in devloop.json)' }]
    }

    return { key, label: picker.label, options, current: now, error }
  })
  const verify = Array.isArray(raw.verify) ? raw.verify : raw.verify === undefined ? [] : [raw.verify]

  return { rows, verify }
}

/** Sets only the changed keys in `devloop.json`'s text; untouched keys keep their order and value. */
export function applyChanges(text: string, changes: Changes): string {
  const obj = parseObject(text)
  if (obj === null) {
    return text
  }
  let isChanged = false
  for (const key of Object.keys(changes) as (keyof Changes)[]) {
    if (key === 'verify') {
      if (changes.verify !== undefined) {
        obj.verify = [...changes.verify]
        isChanged = true
      }
      continue
    }
    const value = changes[key]
    if (key === 'tests' || value === undefined) {
      continue
    }
    const out = written(key, value)
    if (out === undefined) {
      continue
    }
    const path = PICKERS[key].path
    if (path.length === 1) {
      obj[path[0]] = out
      isChanged = true
      continue
    }
    const holder = obj[path[0]]
    if (key === 'grounding' && value === 'same') {
      if (isObj(holder) && path[1] in holder) {
        delete holder[path[1]]
        isChanged = true
      }
      continue
    }
    const inner: Obj = isObj(holder) ? holder : {}
    inner[path[1]] = out
    obj[path[0]] = inner
    isChanged = true
  }
  if (!isChanged) {
    return text
  }

  return `${JSON.stringify(obj, null, 2)}\n`
}

/** The `devloop.json` key paths these changes write, in the order given. */
export function changedKeys(changes: Changes): string[] {
  const keys: string[] = []
  for (const key of Object.keys(changes) as (keyof Changes)[]) {
    if (key === 'verify') {
      if (changes.verify !== undefined) {
        keys.push('verify')
      }
      continue
    }
    const value = changes[key]
    if (key !== 'tests' && value !== undefined && written(key, value) !== undefined) {
      keys.push(PICKERS[key].path.join('.'))
    }
  }

  return keys
}

/** Says when a saved (or pending) change applies. */
export function effectLine(base: string, baseHasPolicy: boolean, isSaved: boolean): string {
  if (!baseHasPolicy) {
    return isSaved ? 'Saved. devloop uses these settings now.' : 'devloop uses these settings now.'
  }
  const rest = `devloop keeps using ${base}'s copy until you commit this change to ${base}.`

  return isSaved ? `Saved to devloop.json. ${rest}` : rest
}
