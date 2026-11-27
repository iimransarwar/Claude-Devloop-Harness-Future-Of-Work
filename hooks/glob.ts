// The one wildcard expander (the cache-guard round, P-C, R7-R9): a path a
// command names with `*`, `?` or `[…]` is judged by what it matches on disk,
// as the shell would expand it. Brace expansion (`{a,b}`) is the shell
// model's (hooks/shell.ts), made before the disk is consulted. The expander
// is pure: it is given the folders' listings, and says which folders it
// still needs, so the module (through `$.fs.list`) and the command line
// (through Node's file system) gather the same listings the same way and
// the rules judge the same matches. No `$`, no Node.

/**
 * One entry of a folder's listing: its name, and whether it is a folder;
 * null where it may lead to one (a link, which the shell follows when it
 * matches a part in the middle of a pattern: the twelfth round, X11).
 */
export type Entry = { name: string; isDir: boolean | null }

/** A folder's listing, or null when it could not be read (it matches nothing there). */
export type Listing = readonly Entry[] | null

/** The most matches one pattern is judged by; past it the pattern is `capped` (R9). */
export const GLOB_CAP = 200

/** How many folders one pattern may list. */
const LIST_CAP = 64

/** Whether one part of a path holds a wildcard the shell expands. */
export const isWildPart = (part: string): boolean => /[*?[]/.test(part)

const cache = new Map<string, RegExp>()

/**
 * One part of a pattern as a regular expression, as the shell matches a name:
 * `*` any run of characters, `?` one, `[…]` a class (`!` or `^` negates it),
 * a backslash escapes. A name that starts with a dot matches only a part
 * that starts with one (the shell's default).
 */
function partRegex(part: string): RegExp {
  const known = cache.get(part)
  if (known !== undefined) {
    return known
  }
  let source = ''
  for (let i = 0; i < part.length; i += 1) {
    const c = part[i] ?? ''
    if (c === '\\') {
      source += (part[i + 1] ?? '').replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')
      i += 1
    } else if (c === '*') {
      source += '.*'
    } else if (c === '?') {
      source += '.'
    } else if (c === '[') {
      const end = part.indexOf(']', i + (part[i + 1] === ']' || part[i + 1] === '!' || part[i + 1] === '^' ? 2 : 1))
      if (end < 0) {
        source += '\\['
        continue
      }
      const body = part.slice(i + 1, end)
      const negated = body.startsWith('!') || body.startsWith('^')
      source += `[${negated ? '^' : ''}${(negated ? body.slice(1) : body).replace(/[\\\]^]/g, '\\$&')}]`
      i = end
    } else {
      source += c.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')
    }
  }
  const made = new RegExp(`^${source}$`)
  cache.set(part, made)

  return made
}

/** Whether a name matches one pattern part. */
const isMatch = (name: string, part: string): boolean => (!name.startsWith('.') || part.startsWith('.')) && name !== '.' && name !== '..' && partRegex(part).test(name)

/** What an expander makes of a pattern so far: its matches, the folders it still needs listed, or `capped`. */
export type Expanded = { matches: string[] } | { need: string[] } | 'capped'

/** An expander: a pattern and the listings known so far (`listed` answers undefined for a folder not listed yet). */
export type Expander = (pattern: string, listed: (dir: string) => Listing | undefined) => Expanded

/**
 * The extended reading's expander (the twelfth round, X11; the thirteenth,
 * BB4): the matches of an absolute pattern, given the listings known so far:
 * `matches` when every folder it needs was listed (none at all is an empty
 * list), `need` with the folders still to list, or `capped` past `GLOB_CAP`
 * matches or `LIST_CAP` folders. A part before another, or before a
 * trailing `/`, matches folders only, a link that may lead to one included
 * (X11): it is listed in turn, and matches nothing there if it leads to
 * none. A match is kept only where it exists on disk (BB4): a literal part
 * after a wildcard part must be there too (a folder before another part or a
 * trailing `/`, anything as the last part), and in a pattern with no
 * wildcard every part must (Y1: a move's target matches only a folder that
 * exists; BB5: a word holding white space is a path only where something is
 * there). The reviewed reading has its own expander, `2374c49`'s
 * (`expandGlobReviewed`), and its own lookups (the fourteenth round, CC1).
 */
export function expandGlob(pattern: string, listed: (dir: string) => Listing | undefined): Expanded {
  if (!pattern.startsWith('/')) {
    return { matches: [] }
  }
  const parts = pattern.split('/').slice(1)
  const isFolders = pattern.endsWith('/')
  let found: string[] = ['']
  let lists = 0
  // A literal part after a wildcard is checked on disk too (BB4); a pattern with no wildcard at all checks every part.
  let isAfterWild = !parts.some(isWildPart)
  for (const [i, part] of parts.entries()) {
    if (part === '') {
      continue
    }
    const isLast = parts.slice(i + 1).every(one => one === '') && !isFolders
    const isWild = isWildPart(part)
    if (!isWild && (!isAfterWild || part === '.' || part === '..')) {
      found = found.map(one => `${one}/${part.replace(/\\(.)/g, '$1')}`)
      continue
    }
    isAfterWild = true
    const literal = part.replace(/\\(.)/g, '$1')
    const need: string[] = []
    const next: string[] = []
    for (const one of found) {
      const dir = one === '' ? '/' : one
      const listing = listed(dir)
      lists += 1
      if (listing === undefined) {
        need.push(dir)
        continue
      }
      for (const entry of listing ?? []) {
        if ((isLast || entry.isDir !== false) && (isWild ? isMatch(entry.name, part) : entry.name === literal)) {
          next.push(`${one}/${entry.name}`)
        }
      }
    }
    if (lists > LIST_CAP || next.length > GLOB_CAP) {
      return 'capped'
    }
    if (need.length > 0) {
      return { need: [...new Set(need)] }
    }
    found = next
  }

  return { matches: found.filter(one => one !== '').sort() }
}

/**
 * The reviewed reading's expander (the fourteenth round, CC1): `2374c49`'s
 * `expandGlob`, line for line (its hooks/glob.ts, lines 71-115). A middle
 * part matches real folders only (a link is not a folder to it: `isDir`
 * true alone, as `2374c49`'s listings gave a link `false`), the literal
 * parts are taken as written, there or not, and a pattern with no wildcard
 * matches itself. `capped` past `GLOB_CAP` matches or `LIST_CAP` folders.
 */
export function expandGlobReviewed(pattern: string, listed: (dir: string) => Listing | undefined): Expanded {
  if (!pattern.startsWith('/')) {
    return { matches: [] }
  }
  const parts = pattern.split('/').slice(1)
  let found: string[] = ['']
  let lists = 0
  for (const [i, part] of parts.entries()) {
    if (part === '') {
      continue
    }
    const isLast = parts.slice(i + 1).every(one => one === '')
    if (!isWildPart(part)) {
      found = found.map(one => `${one}/${part.replace(/\\(.)/g, '$1')}`)
      continue
    }
    const need: string[] = []
    const next: string[] = []
    for (const one of found) {
      const dir = one === '' ? '/' : one
      const listing = listed(dir)
      lists += 1
      if (listing === undefined) {
        need.push(dir)
        continue
      }
      for (const entry of listing ?? []) {
        if ((isLast || entry.isDir === true) && isMatch(entry.name, part)) {
          next.push(`${one}/${entry.name}`)
        }
      }
    }
    if (lists > LIST_CAP || next.length > GLOB_CAP) {
      return 'capped'
    }
    if (need.length > 0) {
      return { need: [...new Set(need)] }
    }
    found = next
  }

  return { matches: found.filter(one => one !== '').sort() }
}

/**
 * Expands each pattern with a reader, the same loop at every enforcement
 * point: ask the expander, list what it needs, ask again, until it answers.
 * `list` gives a folder's listing (null when it cannot be read). Patterns
 * past the cap answer `capped`. `expand` is the reading's expander: the
 * extended one by default, `expandGlobReviewed` for the reviewed reading.
 */
export async function expandAll(patterns: readonly string[], list: (dir: string) => Promise<Listing> | Listing, expand: Expander = expandGlob): Promise<Record<string, string[] | 'capped'>> {
  const known = new Map<string, Listing>()
  const out: Record<string, string[] | 'capped'> = {}
  for (const pattern of patterns) {
    for (let round = 0; round < LIST_CAP; round += 1) {
      const step = expand(pattern, dir => known.get(dir))
      if (step === 'capped') {
        out[pattern] = 'capped'
        break
      }
      if ('matches' in step) {
        out[pattern] = step.matches
        break
      }
      for (const dir of step.need) {
        known.set(dir, await list(dir))
      }
    }
    out[pattern] ??= 'capped'
  }

  return out
}

/** The same loop for a reader that answers at once (the command line's Node file system). */
export function expandAllNow(patterns: readonly string[], list: (dir: string) => Listing, expand: Expander = expandGlob): Record<string, string[] | 'capped'> {
  const known = new Map<string, Listing>()
  const out: Record<string, string[] | 'capped'> = {}
  for (const pattern of patterns) {
    for (let round = 0; round < LIST_CAP; round += 1) {
      const step = expand(pattern, dir => known.get(dir))
      if (step === 'capped') {
        out[pattern] = 'capped'
        break
      }
      if ('matches' in step) {
        out[pattern] = step.matches
        break
      }
      for (const dir of step.need) {
        known.set(dir, list(dir))
      }
    }
    out[pattern] ??= 'capped'
  }

  return out
}
