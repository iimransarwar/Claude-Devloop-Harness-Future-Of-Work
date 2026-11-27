// A short, low-noise scan of a change's added lines for well-known key and
// token shapes. It reports where and what kind, never the value. Pure: no `$`.

import type { CredentialHit } from '../types'

/** One line a diff adds, with the file and the line number it has in the new tree. */
export type Added = { file: string; line: number; text: string }

/**
 * The lines a unified diff adds (`git diff -U0` or any context), each with
 * its file and its line number in the new tree. Removed files add nothing.
 */
export function addedLines(diff: string): Added[] {
  const out: Added[] = []
  let file: string | null = null
  let line = 0
  let isHeader = false
  for (const text of diff.split('\n')) {
    if (text.startsWith('diff --git ')) {
      isHeader = true
      file = null
      continue
    }
    if (isHeader && text.startsWith('+++ ')) {
      const path = text.slice(4).replace(/^"(.*)"$/, '$1')
      file = path === '/dev/null' ? null : path.replace(/^b\//, '')
      continue
    }
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(text)
    if (hunk !== null) {
      isHeader = false
      line = Number(hunk[1])
      continue
    }
    if (isHeader || file === null) {
      continue
    }
    if (text.startsWith('+')) {
      out.push({ file, line, text: text.slice(1) })
      line += 1
    } else if (text.startsWith(' ')) {
      line += 1
    }
  }

  return out
}

/** Values that are plainly not a real credential: documentation examples and fill-ins. */
const PLACEHOLDER = /x{4,}|example|placeholder|dummy|changeme|change_me|your[_-]?|sample|fake|redacted|<[^>]*>|\$\{|\{\{|\*{4,}|0{8,}|12345678|abcdefgh/i

/**
 * For a recognised prefix at its exact length, only the obvious fill-ins
 * (L1): a single repeated character, `example`, `placeholder`, `your`,
 * `xxxx`. Random characters that happen to spell `fake` or `12345678` do not
 * make a real token a placeholder.
 */
const OBVIOUS = /example|placeholder|your|x{4}/i

const isRepeated = (text: string): boolean => text.length > 0 && new Set(text).size === 1

/** Bits per character: a random key is high, a word or a repeated pattern is low. */
export function entropy(text: string): number {
  const counts = new Map<string, number>()
  for (const c of text) {
    counts.set(c, (counts.get(c) ?? 0) + 1)
  }

  return [...counts.values()].reduce((sum, n) => {
    const p = n / text.length

    return sum - p * Math.log2(p)
  }, 0)
}

/**
 * The key of a generic assignment: it must end in a credential word, so
 * `tokenizer`, `token_url`, `password_regex` and `secretName` are not keys.
 */
const KEY = '[A-Za-z0-9_.-]*?(?:api[_-]?key|secret(?:[_-]?key)?|token|passwd|password|access[_-]?key|private[_-]?key)'

/**
 * A shape: its kind, the pattern (group 1 the value, the next group that
 * matched the part after a provider's prefix), and, where the provider fixes
 * one, whether a value has its exact length.
 */
type Shape = { kind: string; pattern: RegExp; exact?: (value: string) => boolean; isGeneric?: true }

/** The well-known shapes: each names its kind and the part of the match that is the value. */
const SHAPES: readonly Shape[] = [
  { kind: 'AWS access key id', pattern: /\b((?:AKIA|ASIA)([0-9A-Z]{16}))\b/g, exact: () => true },
  { kind: 'GitHub token', pattern: /\b(gh[pousr]_([A-Za-z0-9]{36,})|github_pat_([A-Za-z0-9_]{22,}))\b/g, exact: value => /^gh[pousr]_[A-Za-z0-9]{36}$/.test(value) || /^github_pat_[A-Za-z0-9]{22}_[A-Za-z0-9]{59}$/.test(value) },
  { kind: 'Slack token', pattern: /\b(xox[abposr]-([0-9A-Za-z-]{10,}))\b/g },
  // A header counts only as a line of its own, as a key file has it; quoted in code it is a string about keys.
  { kind: 'private key', pattern: /^\s*(-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY-----)\s*$/g },
  {
    // Quoted anywhere (code, JSON), or unquoted as an environment, YAML or ini line has it.
    kind: 'API key or secret assignment',
    pattern: new RegExp(`(?:\\b${KEY}["']?\\s*[:=]\\s*["']([^"'\\s]{20,})["']|^\\s*(?:export\\s+)?${KEY}\\s*[:=]\\s*([^\\s"'#]{20,})\\s*(?:#.*)?$)`, 'gi'),
    isGeneric: true,
  },
]

/** The entropy a generic assignment's value must reach to count: below it, a word or a pattern. */
const ENTROPY_FLOOR = 3.5

/**
 * Whether a generic assignment's value is plainly not a secret: a URL, a
 * path, a pattern, an upper-case constant's name, or a reference to a field
 * (`self.session.token_value`).
 */
function isNotSecretValue(value: string): boolean {
  return /:\/\//.test(value) ||
    /^(?:\.{0,2}\/|~\/|[A-Za-z]:\\)/.test(value) ||
    /^\^|\$$|\\[dDwWsSbB]|\[[^\]]*-[^\]]*\]|\(\?|\.\*|\.\+|\{\d+,\d*\}/.test(value) ||
    /^[A-Z][A-Z0-9_]*$/.test(value) ||
    /^[A-Za-z_]\w*(?:\.[A-Za-z_]\w*)+$/.test(value)
}

/** The kinds of credential one line holds; an obvious placeholder never counts. */
export function credentialKinds(text: string): string[] {
  const out: string[] = []
  for (const { kind, pattern, exact, isGeneric } of SHAPES) {
    for (const match of text.matchAll(pattern)) {
      const value = match[1] ?? match[2] ?? ''
      const body = match.slice(2).find(one => one !== undefined) ?? value
      let isFiller: boolean
      if (kind === 'private key') {
        isFiller = false
      } else if (exact?.(value) === true) {
        isFiller = OBVIOUS.test(body) || isRepeated(body)
      } else {
        isFiller = PLACEHOLDER.test(value)
      }
      const isCounted = isGeneric !== true || (entropy(value) >= ENTROPY_FLOOR && !isNotSecretValue(value))
      if (!isFiller && isCounted && !out.includes(kind)) {
        out.push(kind)
      }
    }
  }

  return out
}

/** Every credential-shaped string in the lines a change adds, by file and line, at most `cap`. */
export function scanCredentials(lines: readonly Added[], cap = 20): CredentialHit[] {
  const out: CredentialHit[] = []
  for (const one of lines) {
    for (const kind of credentialKinds(one.text)) {
      out.push({ file: one.file, line: one.line, kind })
    }
    if (out.length >= cap) {
      break
    }
  }

  return out.slice(0, cap)
}
