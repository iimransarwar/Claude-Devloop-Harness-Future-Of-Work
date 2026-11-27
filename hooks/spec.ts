// The spec as pure functions: reading features.json, what refuses an
// approval, which acceptance criteria no feature covers, and which features
// are ready to build. Nothing here touches `$`.

import type { Loop } from '../types'

/**
 * One feature as the person approved it. `passes`, if the file has one, is
 * ignored: a feature's status is the harness's own record (DESIGN 4.4).
 */
export type Feature = {
  id: string
  description: string
  check: string
  /** Features that must pass on the current tree before this one is checked. */
  dependsOn: string[]
  /** The numbered acceptance criteria of SPEC.md this feature covers. */
  criteria: number[]
  /** The checklist items (`<list>/<item>`) this feature keeps as criteria (D2): its check is what proves each. */
  checklist: string[]
}

const isWhole = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v > 0

/** A checklist item named as a criterion: `<list>/<item>` (D2). */
const isItemRef = (v: unknown): v is string => typeof v === 'string' && /^[a-z0-9][a-z0-9-]*\/[A-Za-z0-9_.-]+$/.test(v)

/** The features a list names; an entry without a string id and check is left out (`specProblems` names it). */
export function parseFeatures(text: string): Feature[] {
  try {
    const raw: unknown = JSON.parse(text)
    if (!Array.isArray(raw)) {
      return []
    }

    return raw.flatMap(one => {
      const f = (typeof one === 'object' && one !== null ? one : {}) as Record<string, unknown>

      return typeof f.id === 'string' && typeof f.check === 'string'
        ? [{
            id: f.id,
            description: typeof f.description === 'string' ? f.description : '',
            check: f.check,
            dependsOn: Array.isArray(f.dependsOn) ? f.dependsOn.filter((d): d is string => typeof d === 'string') : [],
            criteria: Array.isArray(f.criteria) ? f.criteria.filter(isWhole) : [],
            checklist: [...new Set([...(Array.isArray(f.checklist) ? f.checklist.filter(isItemRef) : []), ...(Array.isArray(f.criteria) ? f.criteria.filter(isItemRef) : [])])],
          }]
        : []
    })
  } catch {
    return []
  }
}

/** Lines of the template /devloop spec writes, which a finished spec has replaced. */
const PLACEHOLDERS = ['1. (criterion)', '(What should be true for the user when this is done']

/** The marker a spec carries while a question is open. */
const CLARIFY = /\[NEEDS CLARIFICATION/i

/**
 * Why a spec cannot be approved as it stands, one line each: the template's
 * placeholder, a feature list that is not a list, an entry with no id,
 * duplicate ids, a feature without a check, a dependency on no feature or a
 * cycle, criteria that are not numbers, and an open `[NEEDS CLARIFICATION]`.
 * Empty when it can be approved.
 */
export function specProblems(featuresText: string, specText: string): string[] {
  const out: string[] = []
  let raw: unknown
  try {
    raw = JSON.parse(featuresText)
  } catch {
    return ['features.json is not valid JSON']
  }
  if (!Array.isArray(raw)) {
    return ['features.json must be a JSON list of features']
  }
  const entries = raw.map(one => (typeof one === 'object' && one !== null && !Array.isArray(one) ? one as Record<string, unknown> : {}))
  if (entries.length === 0 || entries.some(one => one.id === 'example') || PLACEHOLDERS.some(line => specText.includes(line))) {
    out.push('the spec still holds the template\'s placeholder: each acceptance criterion needs a real entry in features.json with a "check" command')
  }
  const ids: string[] = []
  entries.forEach((one, i) => {
    if (typeof one.id !== 'string' || one.id.trim() === '') {
      out.push(`features.json entry ${i + 1} has no "id"`)

      return
    }
    ids.push(one.id)
    if (typeof one.check !== 'string' || one.check.trim() === '') {
      out.push(`feature "${one.id}" has no "check" command`)
    }
    if (one.criteria !== undefined && (!Array.isArray(one.criteria) || !one.criteria.every(v => isWhole(v) || isItemRef(v)))) {
      out.push(`feature "${one.id}": "criteria" must be a list of acceptance-criterion numbers, like [1, 3] (or checklist items, like "login-form/LF-01")`)
    }
    if (one.checklist !== undefined && (!Array.isArray(one.checklist) || !one.checklist.every(isItemRef))) {
      out.push(`feature "${one.id}": "checklist" must be a list of checklist items, like ["login-form/LF-01"]`)
    }
    if (one.dependsOn !== undefined && (!Array.isArray(one.dependsOn) || !one.dependsOn.every(d => typeof d === 'string'))) {
      out.push(`feature "${one.id}": "dependsOn" must be a list of feature ids`)
    }
  })
  const repeated = [...new Set(ids.filter((id, i) => ids.indexOf(id) !== i))]
  if (repeated.length > 0) {
    out.push(`features.json repeats ${repeated.map(id => `"${id}"`).join(', ')}; each id must be unique`)
  }
  const features = parseFeatures(featuresText)
  for (const one of features) {
    const unknown = one.dependsOn.filter(dep => dep === one.id || !ids.includes(dep))
    if (unknown.length > 0) {
      out.push(`feature "${one.id}" depends on ${unknown.map(id => `"${id}"`).join(', ')}, which is ${unknown.includes(one.id) ? 'itself or ' : ''}no feature in the list`)
    }
  }
  const cycle = cycleOf(features)
  if (cycle !== null) {
    out.push(`the features depend on each other in a circle: ${cycle.join(' → ')}`)
  }
  const open = specText.split('\n').filter(line => CLARIFY.test(line)).length
  if (open > 0) {
    out.push(`SPEC.md still has ${open} [NEEDS CLARIFICATION] marker${open === 1 ? '' : 's'}: answer each question in the spec first`)
  }

  return out
}

/** A dependency cycle among the features, as the ids around it, or null. */
function cycleOf(features: readonly Feature[]): string[] | null {
  const deps = new Map(features.map(one => [one.id, one.dependsOn]))
  const state = new Map<string, 'visiting' | 'done'>()
  const path: string[] = []
  const visit = (id: string): string[] | null => {
    if (state.get(id) === 'done') {
      return null
    }
    if (state.get(id) === 'visiting') {
      return [...path.slice(path.indexOf(id)), id]
    }
    state.set(id, 'visiting')
    path.push(id)
    for (const dep of deps.get(id) ?? []) {
      if (dep !== id && deps.has(dep)) {
        const found = visit(dep)
        if (found !== null) {
          return found
        }
      }
    }
    path.pop()
    state.set(id, 'done')

    return null
  }
  for (const one of features) {
    const found = visit(one.id)
    if (found !== null) {
      return found
    }
  }

  return null
}

/**
 * The numbered acceptance criteria of SPEC.md: the `1.` or `1)` items under
 * a heading named "Acceptance criteria", up to the next heading.
 */
export function criteriaOf(specText: string): number[] {
  const out: number[] = []
  let isIn = false
  for (const line of specText.split('\n')) {
    if (/^\s{0,3}#/.test(line)) {
      isIn = /^\s{0,3}#+\s*acceptance criteria\b/i.test(line)
      continue
    }
    const item = isIn ? /^\s{0,3}(\d+)[.)]\s+\S/.exec(line) : null
    if (item !== null) {
      out.push(Number(item[1]))
    }
  }

  return [...new Set(out)]
}

/**
 * The criteria a feature covers: its `criteria` list, or failing that the
 * criteria its description names as `criterion 3` or `AC3`. Only those
 * spellings count, so a number in the prose is never read as a criterion.
 */
export function coveredBy(feature: Feature): number[] {
  if (feature.criteria.length > 0) {
    return feature.criteria
  }

  return [...feature.description.matchAll(/\b(?:criterion|AC)\s*#?\s*(\d+)\b/gi)].map(one => Number(one[1]))
}

/** The numbered acceptance criteria no feature covers. */
export function unmappedCriteria(specText: string, features: readonly Feature[]): number[] {
  const covered = new Set(features.flatMap(coveredBy))

  return criteriaOf(specText).filter(n => !covered.has(n))
}

/** What the fingerprint covers: SPEC.md and each feature's id, description, check, dependencies and criteria. */
export const fingerprintInput = (specText: string, features: readonly Feature[]): string =>
  JSON.stringify([specText, features.map(f => [f.id, f.description, f.check, f.dependsOn, f.criteria, ...(f.checklist.length > 0 ? [f.checklist] : [])])])

/** The dependencies of a feature that do not pass on the tree as it stands. */
export function missingDeps(loop: Loop, id: string): string[] {
  return (loop.dependsOn[id] ?? []).filter(dep => {
    const one = loop.features[dep]

    return one === undefined || !one.passes || one.tree !== loop.tree
  })
}

/** The approved features in dependency order (D2): a feature after what it depends on; otherwise as approved. */
export function dependencyOrder(loop: Pick<Loop, 'features' | 'dependsOn'>): string[] {
  const ids = Object.keys(loop.features)
  const out: string[] = []
  const seen = new Set<string>()
  const visit = (id: string, path: readonly string[]): void => {
    if (seen.has(id) || path.includes(id) || !ids.includes(id)) {
      return
    }
    for (const dep of loop.dependsOn[id] ?? []) {
      visit(dep, [...path, id])
    }
    seen.add(id)
    out.push(id)
  }
  for (const id of ids) {
    visit(id, [])
  }

  return out
}

/** Features ready to build, in dependency order: not passing on this tree, every dependency passing on it. */
export function readyFeatures(loop: Loop): string[] {
  return dependencyOrder(loop).filter(id => {
    const one = loop.features[id]

    return one !== undefined && !(one.passes && one.tree === loop.tree) && missingDeps(loop, id).length === 0
  })
}
