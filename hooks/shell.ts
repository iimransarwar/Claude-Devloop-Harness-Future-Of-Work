// A light model of a shell command: enough to judge what each simple command
// in a line runs, writes, reads and contacts. It is a tripwire, not a shell:
// quoting, comments, heredoc bodies, substitutions, subshells, `bash -c` and
// common wrappers are understood; anything it cannot follow (a computed
// command name, `eval`) is marked unknown, and the rules treat an unknown
// command as one that may write any locked path it names. Pure: no `$`.

/** One word of a command, after quoting is taken off. */
export type Word = {
  text: string
  /** Some part was quoted: the word is data as written, whatever it holds. */
  isQuoted: boolean
  /** Holds `$VAR`, `${…}`, `$(…)` or backticks: its value is known only when it runs. */
  hasExpansion: boolean
  /** Holds an unquoted `*`, `?` or `[`: the shell expands it to file names. */
  hasGlob: boolean
  /** The variable the word starts with, when that is its only expansion (`"$TMPDIR/x"`): TMPDIR. */
  lead?: string | null
  /**
   * The word as the shell would expand it (the cache-guard round, R8, P-C):
   * its literal text with every character that was quoted and would
   * otherwise be special (`* ? [ ] { } , \`) escaped by a backslash, and each
   * expansion as a marker, `\u0001u:NAME\u0002` (an unquoted `$NAME` or
   * `${NAME}`), `\u0001q:NAME\u0002` (a quoted one), `\u0001?\u0002` (any
   * other: a substitution, arithmetic, a special parameter). Absent on a
   * word the model made itself, which is its text as written.
   */
  template?: string
  /** Its brace expansion passed the cap (200 words): what it reaches is not known (P-C). */
  isCapped?: boolean
}

/** A redirect: `>` writes its target, `<` reads it; a descriptor or /dev/null is neither. */
export type Redirect = { op: string; target: string; isWrite: boolean; isRead: boolean }

type Token =
  | { kind: 'word'; word: Word; subs: string[] }
  | { kind: 'op'; op: string }
  | { kind: 'redirect'; op: string; target: Word | null; subs: string[] }

const isSpace = (c: string): boolean => c === ' ' || c === '\t' || c === '\r'

/** Characters a template escapes where they were quoted: each would mean something to the shell unquoted. */
const SPECIAL = '*?[]{},\\\u0001\u0002'

/** One character of a template: escaped when it was quoted and is special. */
const encode = (c: string, isQuoted: boolean): string => (isQuoted && SPECIAL.includes(c)) || c === '\u0001' || c === '\u0002' ? `\\${c}` : c

/** The literal text a template stands for: escapes taken off, markers dropped. */
export function templateText(template: string): string {
  let out = ''
  for (let i = 0; i < template.length; i += 1) {
    const c = template[i] ?? ''
    if (c === '\\') {
      out += template[i + 1] ?? ''
      i += 1
    } else if (c === '\u0001') {
      const end = template.indexOf('\u0002', i)
      i = end < 0 ? template.length : end
    } else {
      out += c
    }
  }

  return out
}

/** Whether a template holds an unescaped character of `set`, outside markers. */
function holds(template: string, set: string): boolean {
  for (let i = 0; i < template.length; i += 1) {
    const c = template[i] ?? ''
    if (c === '\\') {
      i += 1
    } else if (c === '\u0001') {
      const end = template.indexOf('\u0002', i)
      i = end < 0 ? template.length : end
    } else if (set.includes(c)) {
      return true
    }
  }

  return false
}

/** Whether a template holds an expansion marker. */
function hasMarker(template: string): boolean {
  for (let i = 0; i < template.length; i += 1) {
    if (template[i] === '\\') {
      i += 1
    } else if (template[i] === '\u0001') {
      return true
    }
  }

  return false
}

/** Whether a template holds an unquoted wildcard the shell expands against the disk (`*`, `?`, `[`). */
export const isGlobTemplate = (template: string): boolean => holds(template, '*?[')

/**
 * A template with each variable marker replaced by its value (R8): `value`
 * gives a name's literal value, or null where it is not known. Null when any
 * marker cannot be replaced (a substitution, an unknown variable, an
 * unquoted value with whitespace, which the shell would split). An unquoted
 * value's wildcards stay active, as the shell leaves them; its braces and
 * backslashes are literal (brace expansion comes before variables).
 */
export function resolveTemplate(template: string, value: (name: string) => string | null): string | null {
  let out = ''
  for (let i = 0; i < template.length; i += 1) {
    const c = template[i] ?? ''
    if (c === '\\') {
      out += template.slice(i, i + 2)
      i += 1
      continue
    }
    if (c !== '\u0001') {
      out += c
      continue
    }
    const end = template.indexOf('\u0002', i)
    const inner = template.slice(i + 1, end < 0 ? template.length : end)
    i = end < 0 ? template.length : end
    const named = /^([uq]):([A-Za-z_][A-Za-z0-9_]*)$/.exec(inner)
    if (named === null) {
      return null
    }
    const found = value(named[2] ?? '')
    if (found === null) {
      return null
    }
    const isQuoted = named[1] === 'q'
    if (!isQuoted && /\s/.test(found)) {
      return null
    }
    out += [...found].map(one => (isQuoted ? encode(one, true) : '{},\\\u0001\u0002'.includes(one) ? `\\${one}` : one)).join('')
  }

  return out
}

/** How many words one brace expansion may give before it is taken as unknown (P-C, R9). */
export const BRACE_CAP = 200

/** The alternatives of one brace's body (`a,b` or `1..3`), or null when it is no brace expansion the shell would make. */
function braceAlternatives(body: string): string[] | null {
  const parts: string[] = []
  let depth = 0
  let from = 0
  for (let i = 0; i < body.length; i += 1) {
    const c = body[i] ?? ''
    if (c === '\\') {
      i += 1
    } else if (c === '\u0001') {
      const end = body.indexOf('\u0002', i)
      i = end < 0 ? body.length : end
    } else if (c === '{') {
      depth += 1
    } else if (c === '}') {
      depth -= 1
    } else if (c === ',' && depth === 0) {
      parts.push(body.slice(from, i))
      from = i + 1
    }
  }
  if (parts.length > 0) {
    return [...parts, body.slice(from)]
  }
  const range = /^(-?\d+|[A-Za-z])\.\.(-?\d+|[A-Za-z])(?:\.\.(-?\d+))?$/.exec(body)
  if (range === null) {
    return null
  }
  const [, a = '', b = '', stepText] = range
  const isNumber = /\d/.test(a) && /\d/.test(b)
  if (!isNumber && (/\d/.test(a) || /\d/.test(b))) {
    return null
  }
  const start = isNumber ? Number(a) : a.charCodeAt(0)
  const stop = isNumber ? Number(b) : b.charCodeAt(0)
  const step = Math.max(1, Math.abs(Number(stepText ?? 1)) || 1)
  const out: string[] = []
  for (let n = start; start <= stop ? n <= stop : n >= stop; n += start <= stop ? step : -step) {
    out.push(isNumber ? String(n) : String.fromCharCode(n))
    if (out.length > BRACE_CAP) {
      break
    }
  }

  return out
}

/**
 * A template's brace expansion, as the shell makes it before anything else
 * (R9: `{task,log}.md`, `{devloop,x}.json`, `a{1..3}`), in order; braces that
 * were quoted, or that hold no comma or range, stay as written. Null past
 * `BRACE_CAP` words.
 */
export function braceExpand(template: string): string[] | null {
  for (let i = 0; i < template.length; i += 1) {
    const c = template[i] ?? ''
    if (c === '\\') {
      i += 1
      continue
    }
    if (c === '\u0001') {
      const end = template.indexOf('\u0002', i)
      i = end < 0 ? template.length : end
      continue
    }
    if (c !== '{') {
      continue
    }
    let depth = 0
    let close = -1
    for (let j = i; j < template.length; j += 1) {
      const d = template[j] ?? ''
      if (d === '\\') {
        j += 1
      } else if (d === '\u0001') {
        const end = template.indexOf('\u0002', j)
        j = end < 0 ? template.length : end
      } else if (d === '{') {
        depth += 1
      } else if (d === '}') {
        depth -= 1
        if (depth === 0) {
          close = j
          break
        }
      }
    }
    if (close < 0) {
      return [template]
    }
    const alternatives = braceAlternatives(template.slice(i + 1, close))
    if (alternatives === null) {
      // Not a brace expansion: the braces are literal, and a later one may still be.
      const rest = braceExpand(template.slice(i + 1))
      if (rest === null) {
        return null
      }

      return rest.map(one => `${template.slice(0, i + 1)}${one}`)
    }
    const out: string[] = []
    const head = template.slice(0, i)
    for (const one of alternatives) {
      const expanded = braceExpand(`${one}${template.slice(close + 1)}`)
      if (expanded === null) {
        return null
      }
      for (const tail of expanded) {
        out.push(`${head}${tail}`)
        if (out.length > BRACE_CAP) {
          return null
        }
      }
    }

    return out
  }

  return [template]
}

/**
 * The text up to the parenthesis that closes one already opened, quotes
 * respected. In an arithmetic context (`$(( … ))`, `(( … ))`) `<<` is a shift,
 * not a heredoc.
 */
function closing(text: string, from: number, isArithmetic = false): number {
  let depth = 1
  for (let i = from; i < text.length; i += 1) {
    const c = text[i]
    const heredoc = c === '<' && !isArithmetic ? /^<<-?\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\1/.exec(text.slice(i)) : null
    if (heredoc !== null) {
      // A heredoc's body is data, quotes and parentheses in it included.
      const start = text.indexOf('\n', i)
      const delimiter = heredoc[2] ?? ''
      let end = start
      while (end >= 0) {
        const next = text.indexOf('\n', end + 1)
        const line = text.slice(end + 1, next < 0 ? text.length : next)
        if (line.replace(/^\t+/, '') === delimiter) {
          end = next < 0 ? text.length : next
          break
        }
        end = next
      }
      i = start < 0 ? i + heredoc[0].length - 1 : end < 0 ? text.length : end
    } else if (c === '\\') {
      i += 1
    } else if (c === "'") {
      const end = text.indexOf("'", i + 1)
      i = end < 0 ? text.length : end
    } else if (c === '"') {
      for (i += 1; i < text.length && text[i] !== '"'; i += 1) {
        if (text[i] === '\\') {
          i += 1
        }
      }
    } else if (c === '(') {
      depth += 1
    } else if (c === ')') {
      depth -= 1
      if (depth === 0) {
        return i
      }
    }
  }

  return text.length
}

/** The end of a `${…}` expansion that starts at `from` (just past the brace). */
function braceEnd(text: string, from: number): number {
  let depth = 1
  for (let i = from; i < text.length; i += 1) {
    if (text[i] === '\\') {
      i += 1
    } else if (text[i] === '{') {
      depth += 1
    } else if (text[i] === '}') {
      depth -= 1
      if (depth === 0) {
        return i
      }
    }
  }

  return text.length
}

/**
 * The two readings of a line (the thirteenth round, BB1: a new reading adds,
 * it never replaces the reviewed one). `reviewed` is the whole of the reading
 * `2374c49` passed review with (the fourteenth round, CC1), not a list of
 * the things later rounds read differently: its tokenizer and every flag it
 * puts on a word (`$'…'` and `$"…"` as they were then, nothing decoded; a
 * word with a quoted part before its wildcard is no wildcard); its model
 * (only `cd` moves the folder, its target as written, a wildcard in it
 * literal text; `pushd` and `popd` are not followed; `~+` is the word as
 * written); and, in hooks/rules.ts and hooks/glob.ts, its wildcard lookups
 * and expander (`globAsksReviewed`, `expandGlobReviewed`). `extended` is what
 * the later rounds added: `pushd` to an existing folder followed and `popd`
 * back (Y1), a wildcard `cd` or `pushd` target expanded on disk and followed
 * on exactly one match (X11), `$'…'` decoded and `$"…"` read as a
 * double-quoted string (D4, V2), an unquoted wildcard beside a quoted part
 * expanded (X11), `~+` as the folder followed (W1), with its own lookups and
 * the checked expander. Every place that judges a line runs it under both
 * (`READINGS`), whole: a refusal under either stands, places to look at are
 * the union, and anything that answers "allowed" or "nothing here" must hold
 * under both. Each reading is a plain single-folder model.
 */
export type Reading = 'reviewed' | 'extended'

/** Both readings, the reviewed one first (BB1). */
export const READINGS: readonly Reading[] = ['reviewed', 'extended']

/** The one-letter escapes of `$'…'`, and what each stands for (the tenth round, D4). */
const ANSI_C: Readonly<Record<string, string>> = {
  '\\': '\\', "'": "'", '"': '"', '?': '?', a: '\u0007', b: '\b', e: '\u001b', E: '\u001b', f: '\f', n: '\n', r: '\r', t: '\t', v: '\v',
}

/**
 * The body of a `$'…'` word, decoded as bash decodes it (the tenth round,
 * D4; the eleventh, V2): the escapes of `ANSI_C`, `\NNN` (one to three octal
 * digits), `\xHH` (one or two hex digits), `\uHHHH` and `\UHHHHHHHH` (one to
 * four, one to eight), `\x{H…}` (any number of hex digits, the low byte
 * kept, and one `}`, as bash 5.2: BB3), `\cX` (a control character: `toupper(X) & 0x1f`,
 * `\c?` 0x7f, and `\c\\` reads the backslash pair as one). A NUL, from any
 * escape, ends the string, as in bash. Any other escape (and `\c` at the end)
 * is left as written, as bash leaves it, and is not one the decoder knows:
 * `isUnknown`, and the word is then taken as one that holds an expansion
 * (P-B). tests/ansi-c-table.ts holds what real bash makes of every
 * one-character escape body.
 */
export function decodeAnsiC(body: string): { text: string; isUnknown: boolean } {
  let text = ''
  let isUnknown = false
  for (let i = 0; i < body.length; i += 1) {
    const c = body[i] ?? ''
    if (c !== '\\') {
      text += c
      continue
    }
    const next = body[i + 1]
    if (next === undefined) {
      // A lone backslash ends the body only where the quote never closes, which bash refuses to run at all: the text
      // stands as written, so the rules judge what it names (the twelfth round, W2).
      text += '\\'
      break
    }
    if (next === 'x' && body[i + 2] === '{') {
      // `\x{H…}` as bash 5.2 reads it (the thirteenth round, BB3): every hex digit after the brace, the value's low byte
      // kept (`c & 0xff`), then one `}` if it is there (a missing one ends nothing; anything else stays as text).
      const digits = /^[0-9A-Fa-f]*/.exec(body.slice(i + 3))?.[0] ?? ''
      const code = parseInt(digits.slice(-2) || '0', 16)
      i += 2 + digits.length + (body[i + 3 + digits.length] === '}' ? 1 : 0)
      if (code === 0) {
        break
      }
      if (code > 0x7f) {
        // A raw byte past ASCII: what the program gets is not text the model can name.
        isUnknown = true
        continue
      }
      text += String.fromCharCode(code)
      continue
    }
    const one = ANSI_C[next]
    const octal = /^[0-7]{1,3}/.exec(body.slice(i + 1))
    const hex = next === 'x' ? /^[0-9A-Fa-f]{1,2}/.exec(body.slice(i + 2)) : next === 'u' ? /^[0-9A-Fa-f]{1,4}/.exec(body.slice(i + 2)) : next === 'U' ? /^[0-9A-Fa-f]{1,8}/.exec(body.slice(i + 2)) : null
    let code: number | null = null
    if (one !== undefined) {
      text += one
      i += 1
      continue
    } else if (octal !== null) {
      code = parseInt(octal[0], 8) & 0xff
      i += octal[0].length
    } else if (hex !== null) {
      code = parseInt(hex[0], 16)
      i += 1 + hex[0].length
    } else if (next === 'c' && body[i + 2] !== undefined) {
      const x = body[i + 2] ?? ''
      const at = x.codePointAt(0) ?? 0
      if (at < 0x20 || at > 0x7e) {
        // A control character from a byte past printable ASCII (the twelfth round, X2): bash takes the first byte of
        // the character's encoding, the model a code unit, so what the program gets is not text the model can name.
        text += body.slice(i, i + 2 + x.length)
        isUnknown = true
        i += 1 + x.length
        continue
      }
      code = x === '?' ? 0x7f : x.toUpperCase().charCodeAt(0) & 0x1f
      i += x === '\\' && body[i + 3] === '\\' ? 3 : 2
    }
    const isByte = next === 'x' || octal !== null
    if (code === null) {
      // An escape bash leaves as written (`\q`, `\8`, `\x` with no digit): not one the decoder knows.
      text += body.slice(i, i + 2)
      isUnknown = true
      i += 1
      continue
    }
    if (code === 0) {
      break
    }
    if ((isByte && code > 0x7f) || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) {
      // A raw byte past ASCII, or no character at all: what the program gets is not text the model can name.
      isUnknown = true
      continue
    }
    text += String.fromCodePoint(code)
  }

  return { text, isUnknown }
}

/**
 * Splits a command line into words, control operators and redirects. Comments
 * and heredoc bodies are dropped; the bodies of command and process
 * substitutions are kept beside the word that holds them, since they run.
 */
function tokenize(text: string, reading: Reading): Token[] {
  const tokens: Token[] = []
  let word: Word | null = null
  let subs: string[] = []
  /** Heredoc delimiters waiting for the end of the line, and whether tabs are stripped. */
  let heredocs: { delimiter: string; isTabbed: boolean }[] = []
  /** A redirect operator waiting for its target word. */
  let pending: { op: string; isHeredoc: boolean; isTabbed: boolean } | null = null

  const part = (): Word => {
    word ??= { text: '', isQuoted: false, hasExpansion: false, hasGlob: false, template: '' }

    return word
  }
  /** Literal characters, quoted or not, into the word and its template. */
  const add = (w: Word, chars: string, isQuoted: boolean): void => {
    w.text += chars
    w.template = `${w.template ?? ''}${[...chars].map(one => encode(one, isQuoted)).join('')}`
  }
  /** An expansion's marker: a variable by name, or one the model cannot name (null). */
  const mark = (w: Word, name: string | null, isQuoted: boolean): void => {
    w.template = `${w.template ?? ''}\u0001${name === null ? '?' : `${isQuoted ? 'q' : 'u'}:${name}`}\u0002`
  }
  const flush = (): void => {
    if (word === null) {
      return
    }
    if (pending !== null) {
      if (pending.isHeredoc) {
        heredocs.push({ delimiter: word.text, isTabbed: pending.isTabbed })
        tokens.push({ kind: 'redirect', op: pending.op, target: null, subs })
      } else {
        tokens.push({ kind: 'redirect', op: pending.op, target: word, subs })
      }
      pending = null
    } else {
      tokens.push({ kind: 'word', word, subs })
    }
    word = null
    subs = []
  }
  const op = (value: string): void => {
    flush()
    tokens.push({ kind: 'op', op: value })
  }
  /** Reads a `$…` expansion at `i`; returns the index of its last character. */
  const dollar = (i: number, isQuoted: boolean): number => {
    const w = part()
    // The variable a word starts with, while it is the word's only expansion.
    const had = w.hasExpansion
    const isFirst = w.text === '' && !had
    w.lead = null
    w.hasExpansion = true
    const next = text[i + 1]
    if (next === '(' && text[i + 2] === '(') {
      // Arithmetic: no heredocs, no redirects inside.
      const end = closing(text, i + 3, true)
      mark(w, null, isQuoted)

      return Math.min(text.length, end + 1)
    }
    if (next === '(') {
      const end = closing(text, i + 2)
      subs.push(text.slice(i + 2, end))
      mark(w, null, isQuoted)

      return end
    }
    if (next === '{') {
      const end = braceEnd(text, i + 2)
      const inner = text.slice(i + 2, end)
      const isName = /^[A-Za-z_][A-Za-z0-9_]*$/.test(inner)
      w.lead = isFirst && isName ? inner : null
      mark(w, isName ? inner : null, isQuoted)

      return end
    }
    if (next === "'" && reading === 'reviewed') {
      // The reviewed reading (BB1) reads `$'…'` as `2374c49` did (its hooks/shell.ts, lines 417-428): inside double
      // quotes too, each escape's backslash dropped and the character after it kept as written, nothing decoded.
      w.hasExpansion = had
      w.isQuoted = true
      let j = i + 2
      for (; j < text.length && text[j] !== "'"; j += 1) {
        if (text[j] === '\\') {
          j += 1
        }
        add(w, text[j] ?? '', true)
      }

      return j
    }
    if (next === "'" && !isQuoted) {
      // ANSI-C quoting (the tenth round, D4): a literal, decoded as bash decodes it. An escape the decoder
      // does not know makes the word one that holds an expansion (P-B): what reaches the program is not known.
      w.hasExpansion = had
      w.isQuoted = true
      let j = i + 2
      for (; j < text.length && text[j] !== "'"; j += 1) {
        if (text[j] === '\\') {
          j += 1
        }
      }
      const decoded = decodeAnsiC(text.slice(i + 2, j))
      add(w, decoded.text, true)
      if (decoded.isUnknown) {
        w.hasExpansion = true
        w.lead = null
        mark(w, null, true)
      }

      return j
    }
    // The reviewed reading has no locale quoting (BB1): `$"…"` is a `$` and a double-quoted string, as in `2374c49`.
    if (next === '"' && !isQuoted && reading === 'extended') {
      // Locale quoting (D4): `$"…"` is a double-quoted string; the `$` is dropped and the quote read as one.
      w.hasExpansion = had

      return i
    }
    const name = /^(?:[A-Za-z_][A-Za-z0-9_]*|[0-9@*#?$!-])/.exec(text.slice(i + 1))
    if (name === null) {
      w.hasExpansion = had
      add(w, '$', isQuoted)

      return i
    }
    const isName = /^[A-Za-z_]/.test(name[0])
    w.lead = isFirst && isName ? name[0] : null
    mark(w, isName ? name[0] : null, isQuoted)

    return i + name[0].length
  }

  for (let i = 0; i < text.length; i += 1) {
    const c = text[i] ?? ''
    if (c === '\\') {
      if (text[i + 1] === '\n') {
        i += 1
        continue
      }
      add(part(), text[i + 1] ?? '', true)
      part().isQuoted = true
      i += 1
    } else if (c === "'") {
      const end = text.indexOf("'", i + 1)
      const stop = end < 0 ? text.length : end
      add(part(), text.slice(i + 1, stop), true)
      part().isQuoted = true
      i = stop
    } else if (c === '"') {
      const w = part()
      w.isQuoted = true
      let j = i + 1
      for (; j < text.length && text[j] !== '"'; j += 1) {
        const d = text[j] ?? ''
        if (d === '\\' && '$`"\\\n'.includes(text[j + 1] ?? '')) {
          add(w, text[j + 1] === '\n' ? '' : (text[j + 1] ?? ''), true)
          j += 1
        } else if (d === '$') {
          j = dollar(j, true)
        } else if (d === '`') {
          const end = text.indexOf('`', j + 1)
          const stop = end < 0 ? text.length : end
          subs.push(text.slice(j + 1, stop))
          w.hasExpansion = true
          w.lead = null
          mark(w, null, true)
          j = stop
        } else {
          add(w, d, true)
        }
      }
      i = j
    } else if (c === '$') {
      i = dollar(i, false)
    } else if (c === '`') {
      const end = text.indexOf('`', i + 1)
      const stop = end < 0 ? text.length : end
      subs.push(text.slice(i + 1, stop))
      part().hasExpansion = true
      part().lead = null
      mark(part(), null, false)
      i = stop
    } else if (c === '#' && word === null) {
      while (i + 1 < text.length && text[i + 1] !== '\n') {
        i += 1
      }
    } else if (c === '\n') {
      op('\n')
      if (heredocs.length > 0) {
        // The bodies follow this line, one per heredoc, in order.
        for (const { delimiter, isTabbed } of heredocs) {
          for (;;) {
            const end = text.indexOf('\n', i + 1)
            const line = text.slice(i + 1, end < 0 ? text.length : end)
            i = end < 0 ? text.length : end
            if ((isTabbed ? line.replace(/^\t+/, '') : line) === delimiter || end < 0) {
              break
            }
          }
        }
        heredocs = []
      }
    } else if (isSpace(c)) {
      flush()
    } else if (c === ';') {
      op(text[i + 1] === ';' ? ';;' : ';')
      if (text[i + 1] === ';') {
        i += 1
      }
    } else if (c === '&' && text[i + 1] === '&') {
      op('&&')
      i += 1
    } else if (c === '|' && text[i + 1] === '|') {
      op('||')
      i += 1
    } else if (c === '|') {
      op(text[i + 1] === '&' ? '|&' : '|')
      if (text[i + 1] === '&') {
        i += 1
      }
    } else if ((c === '<' || c === '>') && text[i + 1] === '(') {
      // Process substitution: the body runs; the word is a descriptor path.
      const end = closing(text, i + 2)
      subs.push(text.slice(i + 2, end))
      part().text += '/dev/fd/63'
      mark(part(), null, false)
      part().hasExpansion = true
      i = end
    } else if (c === '&' && text[i + 1] === '>') {
      flush()
      const isAppend = text[i + 2] === '>'
      pending = { op: isAppend ? '&>>' : '&>', isHeredoc: false, isTabbed: false }
      i += isAppend ? 2 : 1
    } else if (c === '&') {
      op('&')
    } else if (c === '(' && text[i + 1] === '(' && word === null && text[closing(text, i + 2, true) + 1] === ')') {
      // `(( … ))` is an arithmetic command: no heredocs, no redirects inside, nothing it runs.
      flush()
      tokens.push({ kind: 'word', word: { text: '((', isQuoted: false, hasExpansion: false, hasGlob: false }, subs: [] })
      i = closing(text, i + 2, true) + 1
    } else if (c === '(' || c === ')') {
      op(c)
    } else if (c === '<' || c === '>') {
      // A word of digits right before the operator names the descriptor.
      // (Read through a cast: the closures above assign `word`, which flow analysis does not see.)
      const current = word as Word | null
      const fd = current !== null && /^\d+$/.test(current.text) && !current.isQuoted ? current.text : ''
      if (fd !== '') {
        word = null
      } else {
        flush()
      }
      const rest = text.slice(i)
      const found = /^(<<<|<<-|<<|<>|<&|>>|>\||>&|<|>)/.exec(rest)?.[1] ?? c
      i += found.length - 1
      if (found === '>&' || found === '<&') {
        // `2>&1`, `>&-`: a descriptor, not a file, unless a path follows.
        const target = /^\s*([0-9]+-?|-)/.exec(text.slice(i + 1))
        if (target !== null) {
          tokens.push({ kind: 'redirect', op: `${fd}${found}${target[1] ?? ''}`, target: null, subs: [] })
          i += target[0].length
          continue
        }
      }
      pending = { op: `${fd}${found}`, isHeredoc: found === '<<' || found === '<<-', isTabbed: found === '<<-' }
    } else {
      const w = part()
      add(w, c, false)
      // An unquoted wildcard expands even beside a quoted part (the twelfth round, X11): the template keeps the quoted ones
      // literal. The reviewed reading flags a word as `2374c49` did (its hooks/shell.ts, line 581): a wildcard only in a
      // word with no quoted part before it (the fourteenth round, CC1, CC-F5).
      if ((c === '*' || c === '?' || c === '[') && (reading === 'extended' || !w.isQuoted)) {
        w.hasGlob = true
      }
    }
  }
  flush()

  return tokens
}

// ---------------------------------------------------------------- segments

/** One simple command, with what the model could tell about it. */
export type Segment = {
  /** The words as written, wrappers and assignments included. */
  words: Word[]
  /** Wrappers peeled to find the real command (`sudo`, `env`, `timeout`, …). */
  wrappers: string[]
  /** Leading `NAME=value` assignments. */
  assignments: string[]
  /**
   * The same assignments, each with whether its value holds an expansion the
   * model could not resolve (the cache-guard round, R2, P-B): an always-held
   * rule treats such a value as the one it protects.
   */
  assigned: Assigned[]
  /** The real command's name, path stripped; null when there is none or it is computed. */
  program: string | null
  /** The arguments after the program. */
  args: Word[]
  /** For git, the sub-command after its global options; otherwise the first argument that is not a flag. */
  sub: string | null
  /** Redirects, each with its target. */
  redirects: Redirect[]
  /** Paths the command writes, as spelled: redirect targets and a known writer's operands. */
  writes: string[]
  /**
   * Whether one of those paths holds an expansion the model could not
   * resolve (P-B): where it lands is known only when the line runs. The
   * eval worktree's containment, always held, takes it for a write outside.
   */
  isWriteOpen: boolean
  /**
   * Words it writes only if they name tracked paths: `git checkout <one word>`
   * restores a file of that name, or else switches to that branch.
   */
  maybeWrites: string[]
  /** Paths it reads, where the program is known to read its operands. */
  reads: string[]
  /**
   * Whether `reads` names every path the program reads (R10): false for a
   * program whose operands the model does not classify, so the reviewer's
   * call is left to ask.
   */
  isReadKnown: boolean
  /** Folders it reads recursively (`grep -r`, `rg`, `cp -r`, `rsync`, `tar c`, R8). */
  readsDeep: string[]
  /**
   * Paths it removes, moves away or replaces with a link (R7): `rm`'s
   * operands, `mv`'s sources, the name `ln` makes. An ancestor of a
   * protected folder is refused for these as well as the folder itself.
   */
  replaces: string[]
  /** Links it makes (R15): the name, and what it leads to as the line names it. */
  links: { name: string; target: string; isSymbolic: boolean }[]
  /** Words whose expansion passed its cap (P-C): what they reach is not known, so a write of one is refused. */
  capped: string[]
  /** Hosts it contacts: URLs, `user@host:` remotes, and network tools' destinations. */
  hosts: string[]
  /**
   * The command cannot be followed (a computed name, `eval`, inline code for
   * an interpreter, `patch`): it may write any path it names.
   */
  isUnknown: boolean
  /** Every path-like word it names, for an unknown command, including those inside inline code; and the files curl's options read (EE2). */
  named: string[]
  /** The working directory for its relative paths, as `cd` and `git -C` moved it; null when a `cd` could not be followed. */
  cwd: string | null
  /**
   * For a `cd` whose target holds a wildcard, or any `pushd` target the model
   * reads, the pattern the hook looks up on disk for it (the twelfth round,
   * X11, and Y1, `movePattern`): the move is followed only where that matched
   * exactly one existing folder. Null otherwise.
   */
  moveGlob: string | null
  /** Which pipeline it belongs to, and its place in it (0 first). */
  pipeline: number
  place: number
  /** It came from inside another command: `bash -c`, a substitution, `find -exec`. */
  isNested: boolean
  /** It runs once per line of its input (`xargs`): its operands come from the stage before. */
  isFedByInput: boolean
  /**
   * Code nested past the depth the model follows (final round, D1 F12): never
   * judged as nothing, it stands for an unknown writer of every path it names
   * and a possible ship.
   */
  isBeyondDepth?: boolean
}

/** One assignment as the line makes it: the name, the value as far as it is known, and whether it holds an unresolved expansion. */
export type Assigned = { name: string; value: string; isComputed: boolean }

/**
 * The variables whose value is taken from the judging process's own
 * environment when the line does not set them (R8): where a path placed
 * through them lands. Any other variable is known only from a literal
 * assignment earlier on the same line.
 */
export const ENV_NAMES: readonly string[] = ['HOME', 'PWD', 'TMPDIR', 'CLAUDE_PLUGIN_DATA', 'CLAUDE_PLUGIN_ROOT', 'CLAUDE_PROJECT_DIR']

/** The judging process's values of `ENV_NAMES`, where set. */
export type Env = Readonly<Record<string, string | null | undefined>>

/** How deep the model follows code inside code (`bash -c`, substitutions, `eval`, `find -exec`). */
export const MAX_NESTING = 6

/** Words that run the next word as the command, with the flags of theirs that take a value. */
const WRAPPERS: Record<string, { values: string; long?: readonly string[]; positional?: number }> = {
  sudo: { values: 'ughpUCDrtTR' },
  doas: { values: 'uC' },
  nohup: { values: '' },
  time: { values: 'fo' },
  command: { values: '' },
  builtin: { values: '' },
  exec: { values: 'a' },
  nice: { values: 'n' },
  ionice: { values: 'cnp' },
  stdbuf: { values: 'ioe' },
  setsid: { values: '' },
  chronic: { values: '' },
  unbuffer: { values: '' },
  timeout: { values: 'sk', long: ['--signal', '--kill-after'], positional: 1 },
  xargs: { values: 'ILnPdlsEea', long: ['--arg-file', '--delimiter', '--max-args', '--max-procs', '--replace', '--max-lines', '--eof'] },
  env: { values: 'uCS', long: ['--unset', '--chdir', '--split-string'] },
  watch: { values: 'nd', long: ['--interval'] },
}

/** Shell keywords that lead a command without being one. */
const KEYWORDS = ['if', 'then', 'else', 'elif', 'do', 'while', 'until', '!', '{']
/** Keywords that end a construct and run nothing. */
const CLOSERS = ['fi', 'done', 'esac', '}', 'for', 'case', 'in', 'function', 'select']

const SHELLS = ['bash', 'sh', 'zsh', 'dash', 'ksh', 'ash', 'fish']
const INTERPRETERS: Record<string, readonly string[]> = {
  python: ['-c'], python2: ['-c'], python3: ['-c'], node: ['-e', '--eval', '-p', '--print'], nodejs: ['-e', '--eval'],
  ruby: ['-e'], perl: ['-e', '-E'], php: ['-r'], deno: ['eval'], bun: ['-e', '--eval'], lua: ['-e'], osascript: ['-e'],
}

/** Git's global options: those that take the next word, and those that do not. */
const GIT_VALUE_OPTIONS = ['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--exec-path', '--super-prefix', '--config-env']

const isAssignment = (word: Word): boolean => /^[A-Za-z_][A-Za-z0-9_]*\+?=/.test(word.text) && !word.text.startsWith('=')

const basename = (path: string): string => path.slice(path.lastIndexOf('/') + 1)

/**
 * Whether a word can name a path: a literal with no whitespace (a message or
 * a pattern with spaces is data), not a flag.
 */
export const isPathLike = (word: Word): boolean =>
  word.text !== '' && !/\s/.test(word.text) && !word.text.startsWith('-') && !word.hasExpansion

/** Peels wrappers off the front of a command; returns what is left and their names. */
function peel(words: Word[]): { rest: Word[]; wrappers: string[]; assignments: string[]; assigned: Word[]; cwd: string | null; split: string | null; isLookup: boolean } {
  let rest = words
  const wrappers: string[] = []
  const assignments: string[] = []
  const assigned: Word[] = []
  let cwd: string | null = null
  let split: string | null = null
  let isLookup = false
  for (let guard = 0; guard < 16 && rest.length > 0; guard += 1) {
    const first = rest[0]
    if (first === undefined) {
      break
    }
    if (isAssignment(first)) {
      assignments.push(first.text)
      assigned.push(first)
      rest = rest.slice(1)
      continue
    }
    if (first.isQuoted || first.hasExpansion) {
      break
    }
    if (KEYWORDS.includes(first.text)) {
      rest = rest.slice(1)
      continue
    }
    const name = basename(first.text)
    const spec = WRAPPERS[name]
    if (spec === undefined) {
      break
    }
    wrappers.push(name)
    let i = 1
    let positional = spec.positional ?? 0
    for (; i < rest.length; i += 1) {
      const text = rest[i]?.text ?? ''
      if (text === '--') {
        i += 1
        break
      }
      if (name === 'env' && isAssignment(rest[i] as Word)) {
        assignments.push(text)
        assigned.push(rest[i] as Word)
        continue
      }
      if (text.startsWith('--')) {
        const [flag, value] = text.split('=', 2)
        if (name === 'env' && (flag === '--chdir')) {
          cwd = value ?? rest[i + 1]?.text ?? null
        }
        if (name === 'env' && flag === '--split-string') {
          split = value ?? rest[i + 1]?.text ?? null
        }
        if (value === undefined && (spec.long ?? []).includes(flag ?? '')) {
          i += 1
        }
        continue
      }
      if (text.startsWith('-') && text.length > 1) {
        const letter = text.slice(-1)
        if (name === 'command' && /[vV]/.test(text)) {
          isLookup = true
        }
        if (spec.values.includes(letter) && text.length === 2) {
          if (name === 'env' && letter === 'C') {
            cwd = rest[i + 1]?.text ?? null
          }
          if (name === 'env' && letter === 'S') {
            split = rest[i + 1]?.text ?? null
          }
          i += 1
        } else if (name === 'env' && text.startsWith('-S')) {
          split = text.slice(2)
        }
        continue
      }
      if (positional > 0) {
        positional -= 1
        continue
      }
      break
    }
    rest = rest.slice(i)
  }

  return { rest, wrappers, assignments, assigned, cwd, split, isLookup }
}

/** An assignment word as an `Assigned`: its value computed when it holds an expansion, or appends (`+=`). */
export function assignedOf(word: Word): Assigned {
  const at = word.text.indexOf('=')
  const name = word.text.slice(0, at).replace(/\+$/, '')

  return { name, value: word.text.slice(at + 1), isComputed: word.hasExpansion || word.text[at - 1] === '+' }
}

/** Git's sub-command and the directory `-C` moves it to, its global options skipped. */
export function gitSub(args: readonly Word[]): { sub: string | null; at: number; dir: string | null } {
  let dir: string | null = null
  for (let i = 0; i < args.length; i += 1) {
    const text = args[i]?.text ?? ''
    if (GIT_VALUE_OPTIONS.includes(text)) {
      if (text === '-C') {
        const next = args[i + 1]?.text ?? '.'
        dir = dir === null || next.startsWith('/') ? next : `${dir}/${next}`
      }
      i += 1
    } else if (text.startsWith('-')) {
      continue
    } else {
      return { sub: text, at: i, dir }
    }
  }

  return { sub: null, at: args.length, dir }
}

// ---------------------------------------------------------------- git options, as git reads them

/**
 * Words after which git takes the next word as a value, never as an option:
 * a message, a file, a push option, a template, a ref.
 */
const GIT_VALUE_WORD = /^(?:-[a-zA-Z]*[mFo]|--message|--file|--push-option|--template|--reuse-message|--reedit-message|--ref)$/

/**
 * The words git reads as options in a command's arguments: up to `--`, the
 * value after a value-taking option left out, quoted or not (git sees a
 * quoted `"--force"` as `--force`), never one holding whitespace.
 */
export function gitOptionWords(words: readonly Word[]): Word[] {
  const out: Word[] = []
  for (let i = 0; i < words.length; i += 1) {
    const word = words[i] as Word
    if (word.text === '--') {
      break
    }
    if (!word.text.startsWith('-') || word.text === '-' || /\s/.test(word.text)) {
      continue
    }
    out.push(word)
    if (GIT_VALUE_WORD.test(word.text)) {
      i += 1
    }
  }

  return out
}

/**
 * Whether a word names a git long option as git's option parser takes it
 * (the cache-guard round, R1): the whole name, `name=value`, or a prefix of
 * the name, which git accepts when it is unambiguous. Over-refusing on
 * ambiguity: any prefix of two or more letters after `--` counts as the
 * option, whatever else it could abbreviate.
 */
export function isGitLong(word: Word, long: string): boolean {
  const text = word.text
  if (!text.startsWith('--') || !long.startsWith('--')) {
    return false
  }
  const name = text.includes('=') ? text.slice(0, text.indexOf('=')) : text

  return name === long || (name.length >= 4 && long.startsWith(name))
}

/**
 * The option word, as written, by which a git command asks for one of the
 * named options (`long`, matched by `isGitLong`, or the short letter alone or
 * in a cluster such as `-fd`); null when it asks for none. The one helper
 * every rule that refuses on a git option uses.
 */
export function gitOption(words: readonly Word[], long: readonly string[], short: string | null = null): string | null {
  for (const word of gitOptionWords(words)) {
    if (long.some(one => isGitLong(word, one))) {
      return word.text
    }
    if (short !== null && /^-[A-Za-z0-9]+$/.test(word.text) && word.text.slice(1).includes(short)) {
      return word.text
    }
  }

  return null
}

/**
 * Whether a git command gives one of the named options spelled in full
 * (`--name` or `--name=value`, or the short letter): for an option that
 * lets a command off a rule (`--cached`, `--dry-run`, `--check`), where an
 * abbreviation that might mean something else must not let it off.
 */
export function gitOptionExactly(words: readonly Word[], long: readonly string[], short: string | null = null): boolean {
  return gitOptionWords(words).some(word =>
    long.some(one => word.text === one || word.text.startsWith(`${one}=`)) || (short !== null && /^-[A-Za-z0-9]+$/.test(word.text) && word.text.slice(1).includes(short)))
}

/**
 * The values a git command gives a long option (`--ref x`, `--ref=x`, or an
 * abbreviation, as `isGitLong` matches it), each as a word, so an expansion in
 * one is seen (R2).
 */
export function gitOptionValues(words: readonly Word[], long: string): Word[] {
  const out: Word[] = []
  for (let i = 0; i < words.length; i += 1) {
    const word = words[i] as Word
    if (word.text === '--') {
      break
    }
    if (!isGitLong(word, long)) {
      continue
    }
    const at = word.text.indexOf('=')
    if (at >= 0) {
      out.push({ ...word, text: word.text.slice(at + 1) })
    } else if (words[i + 1] !== undefined) {
      out.push(words[i + 1] as Word)
      i += 1
    }
  }

  return out
}

/**
 * Whether a git command defines an alias for itself (`-c alias.<name>=…`,
 * `--config-env alias.<name>=…`): its sub-command may then run anything,
 * a push or a shell command included (C2.1 F10).
 */
export function hasGitAlias(args: readonly Word[]): boolean {
  const { at } = gitSub(args)
  const globals = args.slice(0, at)

  return globals.some((word, i) => {
    const text = word.text
    const value = text === '-c' || text === '--config-env' ? (globals[i + 1]?.text ?? '') : text.startsWith('-c') && !text.startsWith('--') ? text.slice(2) : text.startsWith('--config-env=') ? text.slice('--config-env='.length) : ''

    return /^alias\./i.test(value)
  })
}

/** The arguments that are not flags. `values` names short flags whose value is the next word. */
export function operands(args: readonly Word[], values = '', long: readonly string[] = []): Word[] {
  const out: Word[] = []
  let isEnd = false
  for (let i = 0; i < args.length; i += 1) {
    const word = args[i] as Word
    const text = word.text
    if (isEnd || word.isQuoted || !text.startsWith('-') || text === '-') {
      out.push(word)
    } else if (text === '--') {
      isEnd = true
    } else if (text.startsWith('--')) {
      if (!text.includes('=') && long.includes(text)) {
        i += 1
      }
    } else if (/^-[A-Za-z0-9]+$/.test(text) && values.includes(text.slice(-1))) {
      i += 1
    }
  }

  return out
}

/** The value of a flag, written `-o x`, `-ox`, `--output x` or `--output=x`. */
export function flagValue(args: readonly Word[], short: string | null, long: string | null): string | null {
  for (let i = 0; i < args.length; i += 1) {
    const text = args[i]?.text ?? ''
    if (long !== null && text === long) {
      return args[i + 1]?.text ?? null
    }
    if (long !== null && text.startsWith(`${long}=`)) {
      return text.slice(long.length + 1)
    }
    if (short !== null && text === short) {
      return args[i + 1]?.text ?? null
    }
    if (short !== null && text.startsWith(short) && !text.startsWith('--') && text.length > 2 && /^-[A-Za-z]$/.test(short)) {
      return text.slice(2)
    }
  }

  return null
}

/** Whether a short flag is set, alone or among combined letters (`-rf`), or by its long name. */
export function hasFlag(args: readonly Word[], letter: string | null, long: readonly string[] = []): boolean {
  return args.some(word => {
    const text = word.text
    if (word.isQuoted) {
      return false
    }
    if (long.includes(text) || long.some(name => text.startsWith(`${name}=`))) {
      return true
    }

    return letter !== null && /^-[A-Za-z0-9]+$/.test(text) && text.slice(1).includes(letter)
  })
}

type Effects = {
  writes: Word[]
  reads: Word[]
  isUnknown: boolean
  maybe?: Word[]
  /** Whether `reads` is every path it reads (R10); true unless said. */
  isReadKnown?: boolean
  /** Folders it reads recursively (R8). */
  readsDeep?: Word[]
  /** What it removes, moves away or replaces (R7). */
  replaces?: Word[]
  /** Links it makes (R15). */
  links?: { name: Word; target: Word; isSymbolic: boolean }[]
}

/** Programs whose operands the model classifies as paths read (R10): for any other, what it reads is not known. */
const READ_KNOWN = ['cat', 'head', 'tail', 'less', 'more', 'wc', 'nl', 'od', 'xxd', 'strings', 'file', 'stat', 'grep', 'egrep', 'fgrep', 'rg', 'sort', 'uniq', 'find', 'ls', 'diff', 'cut', 'jq']

/** jq's options that take no value: with any other, what it reads is not known (R10). */
const JQ_FLAGS = ['-r', '-c', '-e', '-s', '-n', '-S', '-j', '-a', '-C', '-M', '--raw-output', '--compact-output', '--slurp', '--null-input', '--sort-keys', '--tab', '--exit-status', '--join-output', '--ascii-output', '--color-output', '--monochrome-output']

/** What a known program writes and reads, from its arguments. */
function effects(program: string, sub: string | null, args: Word[]): Effects {
  const none: Effects = { writes: [], reads: [], isUnknown: false }
  const all = (values = '', long: readonly string[] = []): Word[] => operands(args, values, long)
  switch (program) {
    case 'rm': case 'rmdir': case 'unlink': case 'shred': {
      const words = all('s', ['--size', '--reference'])

      return { ...none, writes: words, replaces: words }
    }
    case 'touch': case 'truncate':
      return { ...none, writes: all('s', ['--size', '--reference']) }
    case 'mv': {
      const target = flagValue(args, '-t', '--target-directory')
      const words = all('tS', ['--target-directory', '--suffix'])

      return { ...none, writes: target === null ? words : [...words, literal(target)], replaces: target === null ? words.slice(0, -1) : words }
    }
    case 'cp': case 'ln': case 'install': {
      const target = flagValue(args, '-t', '--target-directory')
      const words = all('tSmgo', ['--target-directory', '--suffix', '--mode', '--owner', '--group'])
      const isDeep = program === 'cp' && (hasFlag(args, 'r', ['--recursive', '--archive']) || hasFlag(args, 'R', []) || hasFlag(args, 'a', []))
      const sources = target !== null ? words : words.slice(0, -1)
      const made = program === 'ln' ? (target !== null ? sources.map(one => literal(`${target}/${basename(one.text)}`)) : words.slice(-1)) : []
      const links = program === 'ln' && sources.length === 1 && made[0] !== undefined
        ? [{ name: made[0], target: sources[0] as Word, isSymbolic: hasFlag(args, 's', ['--symbolic']) }]
        : []
      const writes = target !== null ? [literal(target)] : words.slice(-1)

      return { ...none, writes, reads: sources, ...(isDeep ? { readsDeep: sources } : {}), ...(program === 'ln' ? { replaces: made, links } : {}) }
    }
    case 'chmod': case 'chown': case 'chgrp':
      return { ...none, writes: all().slice(1) }
    case 'tee':
      return { ...none, writes: all() }
    case 'dd':
      return {
        ...none,
        writes: args.filter(word => word.text.startsWith('of=')).map(word => ({ ...word, text: word.text.slice(3) })),
        reads: args.filter(word => word.text.startsWith('if=')).map(word => ({ ...word, text: word.text.slice(3) })),
      }
    case 'rsync': {
      // The last operand is where it copies to; the others what it reads, folders recursively (R7, R8).
      const words = all('eTf', ['--rsh', '--exclude', '--include', '--filter', '--exclude-from', '--include-from', '--files-from', '--rsync-path', '--log-file', '--password-file', '--temp-dir', '--partial-dir', '--backup-dir', '--compare-dest', '--copy-dest', '--link-dest', '--suffix', '--chmod', '--chown', '--timeout', '--port'])
      const sources = words.slice(0, -1).filter(one => !/^[^/]*:/.test(one.text))
      const dest = words.slice(-1).filter(one => !/^[^/]*:/.test(one.text))

      return { ...none, writes: dest, reads: sources, readsDeep: sources }
    }
    case 'tar': case 'bsdtar': case 'gtar': {
      // Extraction writes into `-C`'s folder (R7: extract into); the files it writes are in the archive (R6).
      const first = args[0]?.text ?? ''
      const bundled = !first.startsWith('-') && /^[A-Za-z]+$/.test(first) ? first : ''
      const isExtract = /x/.test(bundled) || args.some(word => /^-[A-Za-z]*x[A-Za-z]*$/.test(word.text) || word.text === '--extract' || word.text === '--get')
      const isCreate = /c/.test(bundled) || args.some(word => /^-[A-Za-z]*c[A-Za-z]*$/.test(word.text) || word.text === '--create')
      const into = flagValue(args, '-C', '--directory')
      const archive = flagValue(args, '-f', '--file')
      const files = operands(bundled === '' ? args : args.slice(1), 'CfbTXIL', ['--directory', '--file', '--exclude', '--files-from', '--exclude-from', '--use-compress-program', '--transform', '--owner', '--group', '--mode'])
      if (isExtract) {
        return { ...none, writes: into === null ? [] : [literal(into)], reads: archive === null ? [] : [literal(archive)] }
      }
      if (isCreate) {
        return { ...none, writes: archive === null || archive === '-' ? [] : [literal(archive)], reads: files, readsDeep: files }
      }

      return none
    }
    case 'sed': case 'gsed': {
      const isInPlace = args.some(word => !word.isQuoted && (/^-[a-zA-Z]*i/.test(word.text) || word.text.startsWith('--in-place')))
      const hasScript = args.some(word => ['-e', '--expression', '-f', '--file'].includes(word.text) || /^-[a-zA-Z]*[ef]$/.test(word.text))
      const words = all('ef', ['--expression', '--file'])
      const files = hasScript ? words : words.slice(1)

      return isInPlace ? { ...none, writes: files } : { ...none, reads: files }
    }
    case 'perl': {
      const isInPlace = args.some(word => !word.isQuoted && /^-[a-zA-Z]*i/.test(word.text))
      if (isInPlace) {
        return { ...none, writes: all('eE').slice(args.some(word => /^-[a-zA-Z]*[eE]$/.test(word.text)) ? 0 : 1) }
      }

      return none
    }
    case 'awk': case 'gawk': {
      const isInPlace = args.some((word, i) => word.text === '-i' && args[i + 1]?.text === 'inplace')

      return isInPlace ? { ...none, writes: all('ivf').slice(1) } : none
    }
    case 'sort': {
      const out = flagValue(args, '-o', '--output')

      return out === null ? { ...none, reads: all('okt', ['--output', '--key', '--field-separator']) } : { ...none, writes: [literal(out)] }
    }
    case 'uniq': {
      const words = all('fsw')

      return { ...none, reads: words.slice(0, 1), writes: words.slice(1, 2) }
    }
    case 'curl': {
      const out = flagValue(args, '-o', '--output')

      return { ...none, writes: out === null || out === '-' ? [] : [literal(out)], reads: curlReads(args) }
    }
    case 'wget': {
      const out = flagValue(args, '-O', '--output-document')

      return out === null || out === '-' ? none : { ...none, writes: [literal(out)] }
    }
    case 'patch':
      return { ...none, isUnknown: true }
    case 'cat': case 'head': case 'tail': case 'less': case 'more': case 'wc': case 'nl': case 'od': case 'xxd': case 'strings': case 'file': case 'stat':
      return { ...none, reads: all('nc', ['--lines', '--bytes']) }
    case 'ls':
      return { ...none, reads: all('IwT', ['--ignore', '--hide', '--width', '--tabsize', '--format', '--sort', '--time', '--time-style', '--color', '--indicator-style', '--quoting-style', '--block-size']) }
    case 'diff':
      return { ...none, reads: [...all('CUIFLSWxXD', ['--label', '--exclude', '--exclude-from', '--ignore-matching-lines', '--starting-file', '--width', '--tabsize', '--ifdef', '--show-function-line', '--line-format', '--old-line-format', '--new-line-format', '--unchanged-line-format']), ...['--from-file', '--to-file'].flatMap(name => { const value = flagValue(args, null, name); return value === null ? [] : [literal(value)] })] }
    case 'cut':
      return { ...none, reads: all('bcdf', ['--bytes', '--characters', '--delimiter', '--fields', '--output-delimiter']) }
    case 'jq': {
      const isPlain = args.every(word => word.isQuoted || !word.text.startsWith('-') || word.text === '-' || JQ_FLAGS.includes(word.text) || /^-[rcesnSjaCM]+$/.test(word.text))

      return isPlain ? { ...none, reads: all().slice(1) } : { ...none, isReadKnown: false }
    }
    case 'grep': case 'egrep': case 'fgrep': case 'rg': {
      const hasPattern = args.some(word => ['-e', '--regexp', '-f', '--file'].includes(word.text) || word.text.startsWith('--regexp=') || word.text.startsWith('--file='))
      const words = all('efABCmg', ['--regexp', '--file', '--after-context', '--before-context', '--context', '--max-count', '--glob', '--type', '--pre', '--pre-glob'])
      // A pattern file is read too (R10).
      const patterns = ['-f', '--file'].flatMap(flag => { const value = flagValue(args, flag.length === 2 ? flag : null, flag.length === 2 ? null : flag); return value === null ? [] : [literal(value)] })
      const files = hasPattern ? words : words.slice(1)
      const isDeep = program === 'rg' || hasFlag(args, 'r', ['--recursive', '--dereference-recursive']) || hasFlag(args, 'R', [])

      return { ...none, reads: [...files, ...patterns], ...(isDeep ? { readsDeep: files.length === 0 ? [literal('.')] : files } : {}), isUnknown: program === 'rg' && hasFlag(args, null, ['--pre']) }
    }
    case 'git':
      return gitEffects(sub, args)
    default:
      return none
  }
}

const literal = (text: string): Word => ({ text, isQuoted: false, hasExpansion: false, hasGlob: false })

/**
 * How a curl option's value names a file it reads and sends (EE2), as
 * curl's manual gives it: `at`, a value that starts with `@` (the rest is
 * the file, `@-` is stdin); `encoded`, `@file` or `name@file` where the `@`
 * comes before any `=` (`--url-query` alone: `+…` is sent as it is); `form`,
 * `name=@file` or `name=<file` (several files by commas, a quoted name
 * as one), and a part's `headers=@file`.
 */
type CurlRead = 'at' | 'encoded' | 'form'

/**
 * curl's options that read a file their value names, and the options whose
 * name is a prefix of one of them, which are no read (`--head`, `--url`) or
 * send the value as written (`--data-raw`, `--form-string`, `--form-escape`).
 */
const CURL_LONG: Readonly<Record<string, CurlRead | null>> = {
  '--data': 'at', '--data-ascii': 'at', '--data-binary': 'at', '--json': 'at', '--header': 'at',
  '--data-urlencode': 'encoded', '--url-query': 'encoded', '--variable': 'encoded',
  '--form': 'form',
  '--data-raw': null, '--form-string': null, '--form-escape': null, '--head': null, '--url': null,
}
const CURL_SHORT: Readonly<Record<string, CurlRead>> = { d: 'at', H: 'at', F: 'form' }
/** curl's short options that take a value (`curl --help all`): in a cluster, the rest of the word, or else the next word, is it. */
const CURL_VALUES = 'EKCbcdDFPHhmoUQreXYytzTuAw'

/**
 * How a long option word reads its value: curl takes any prefix of a long
 * option that names one alone (`--data-b` is `--data-binary`), and
 * `--expand-<option>` as the option with `{{var}}` expanded. A prefix of
 * both a reading option and another is refused by curl as ambiguous; it is
 * judged as each reading one it could be all the same.
 */
function curlLong(name: string): CurlRead[] {
  const bare = name.startsWith('--expand-') ? `--${name.slice('--expand-'.length)}` : name
  const exact = CURL_LONG[bare]
  if (exact !== undefined) {
    return exact === null ? [] : [exact]
  }
  if (bare.length < 3) {
    return []
  }
  const kinds = Object.entries(CURL_LONG).filter(([long]) => long.startsWith(bare)).map(([, kind]) => kind)

  return [...new Set(kinds.filter((kind): kind is CurlRead => kind !== null))]
}

/** The files one value of a reading option names (EE2), by curl's rules for its kind. */
function curlFiles(kind: CurlRead, value: string, isQuery: boolean): string[] {
  const file = (text: string): string[] => (text === '' || text === '-' ? [] : [text])
  if (kind === 'at') {
    return value.startsWith('@') ? file(value.slice(1)) : []
  }
  if (kind === 'encoded') {
    if (isQuery && value.startsWith('+')) {
      return []
    }
    const at = value.search(/[@=]/)

    return at >= 0 && value[at] === '@' ? file(value.slice(at + 1)) : []
  }
  // A form part: `name=content;key=value…`, where a quoted content or value may hold `;` and `,`.
  const eq = value.indexOf('=')
  if (eq < 0) {
    return []
  }
  const parts: string[] = []
  let current = ''
  let isInQuote = false
  for (let i = eq + 1; i < value.length; i += 1) {
    const ch = value[i] as string
    if (isInQuote && ch === '\\' && i + 1 < value.length) {
      current += value[i + 1]
      i += 1
    } else if (ch === '"') {
      isInQuote = !isInQuote
    } else if (ch === ';' && !isInQuote) {
      parts.push(current)
      current = ''
    } else {
      current += ch === ',' && !isInQuote ? '\u0000' : ch
    }
  }
  parts.push(current)
  const [content = '', ...rest] = parts
  const contentFiles = /^[@<]/.test(content) ? content.slice(1).split('\u0000').flatMap(file) : []
  const headerFiles = rest.filter(one => /^headers=@/.test(one)).flatMap(one => file(one.slice('headers=@'.length).replace(/\u0000/g, ',')))

  return [...contentFiles, ...headerFiles]
}

/**
 * The files curl reads and sends through its options (EE2): `-d`/`--data`
 * and its spellings, `--json`, `-H`/`--header`, `--data-urlencode`,
 * `--url-query`, `--variable` and `-F`/`--form`, each written `-d x`,
 * `-dx`, clustered (`-sSd x`), `--data x`, by a prefix curl takes or as
 * `--data=x` (which curl itself refuses), with `--expand-` in front too.
 * A value with an expansion the model could not resolve is left out, as for
 * any read path. `--data-raw`, `--form-string`, and values without curl's
 * file markers, are not reads.
 */
export function curlReads(args: readonly Word[]): Word[] {
  const out: Word[] = []
  const take = (kinds: readonly CurlRead[], value: Word | undefined, isQuery: boolean): void => {
    if (value === undefined || value.hasExpansion) {
      return
    }
    for (const kind of kinds) {
      out.push(...curlFiles(kind, value.text, isQuery).map(text => ({ ...literal(text), isQuoted: value.isQuoted })))
    }
  }
  for (let i = 0; i < args.length; i += 1) {
    const word = args[i] as Word
    const text = word.text
    if (word.hasExpansion || text === '--' || !text.startsWith('-') || text === '-') {
      continue
    }
    if (text.startsWith('--')) {
      const eq = text.indexOf('=')
      const name = eq < 0 ? text : text.slice(0, eq)
      const kinds = curlLong(name)
      const isQuery = name !== '--' && '--url-query'.startsWith(name.replace(/^--expand-/, '--'))
      if (eq >= 0) {
        take(kinds, { ...word, text: text.slice(eq + 1) }, isQuery)
      } else if (kinds.length > 0) {
        take(kinds, args[i + 1], isQuery)
        i += 1
      }
      continue
    }
    // A cluster of short options: the first that takes a value takes the rest of the word, or else the next word.
    for (let j = 1; j < text.length; j += 1) {
      const letter = text[j] as string
      if (!CURL_VALUES.includes(letter)) {
        continue
      }
      const kind = CURL_SHORT[letter]
      const rest = text.slice(j + 1)
      const value = rest === '' ? args[i + 1] : { ...word, text: rest }
      if (kind !== undefined) {
        take([kind], value, false)
      }
      if (rest === '') {
        i += 1
      }
      break
    }
  }

  return out
}

/** `git config` options that write, and those that only read. */
const CONFIG_WRITES = ['--unset', '--unset-all', '--add', '--replace-all', '--rename-section', '--remove-section', '--edit']
const CONFIG_READS = ['--get', '--get-all', '--get-regexp', '--list', '--show-origin', '--show-scope', '--get-urlmatch', '--get-color', '--get-colorbool', '--name-only']

/**
 * What a git sub-command writes in the working tree, or `.` for the whole of
 * it. Options that make it write are matched as git matches them, by prefix
 * (`gitOption`); options that let it off writing only when spelled in full.
 */
function gitEffects(sub: string | null, args: Word[]): Effects {
  const { at } = gitSub(args)
  const rest = args.slice(at + 1)
  const none: Effects = { writes: [], reads: [], isUnknown: false }
  // An alias defined on the line may run any code (C2.1 F10).
  if (hasGitAlias(args)) {
    return { ...none, isUnknown: true }
  }
  switch (sub) {
    case 'checkout': {
      const dash = rest.findIndex(word => word.text === '--')
      if (dash >= 0) {
        return { ...none, writes: operands(rest.slice(dash + 1)) }
      }
      // Without `--` one word is a path only if it is tracked (the hook asks git), else a branch; with more, the first is the source.
      const words = operands(rest, 'bB', ['--orphan'])
      // A new branch writes no path: an option that lets it off, so only when spelled in full (R1's helper).
      if (gitOptionExactly(rest, ['--orphan'], 'b') || gitOptionExactly(rest, [], 'B')) {
        return none
      }
      if (words.length === 1) {
        const only = words[0] as Word

        return only.text === '.' || only.hasGlob ? { ...none, writes: words } : { ...none, maybe: words }
      }

      return { ...none, writes: words.slice(1) }
    }
    case 'restore':
      // `--staged` alone touches only the index.
      return gitOptionExactly(rest, ['--staged'], 'S') && gitOption(rest, ['--worktree'], 'W') === null ? none : { ...none, writes: operands(rest, 's', ['--source']) }
    case 'rm':
      return gitOptionExactly(rest, ['--cached']) ? none : { ...none, writes: operands(rest) }
    case 'mv':
      return { ...none, writes: operands(rest) }
    case 'reset':
      return gitOption(rest, ['--hard', '--merge', '--keep']) !== null ? { ...none, writes: [literal('.')] } : none
    case 'clean':
      return gitOption(rest, ['--force'], 'f') !== null && !gitOptionExactly(rest, ['--dry-run'], 'n')
        ? { ...none, writes: operands(rest, 'e', ['--exclude']).length > 0 ? operands(rest, 'e', ['--exclude']) : [literal('.')] }
        : none
    case 'apply': case 'am':
      return gitOptionExactly(rest, ['--check', '--stat', '--numstat', '--summary']) && gitOption(rest, ['--apply']) === null ? none : { ...none, isUnknown: true }
    case 'stash': {
      const action = operands(rest)[0]?.text ?? 'push'

      return ['pop', 'apply'].includes(action) ? { ...none, isUnknown: true } : none
    }
    case 'config': {
      // A name alone reads its value; a name and a value, or a writing option, writes.
      const said = operands(rest, 'ft', ['--file', '--blob', '--type', '--default', '--comment', '--value'])
      const action = said[0]?.text ?? ''
      const isWrite = gitOption(rest, CONFIG_WRITES, 'e') !== null || ['set', 'unset', 'rename-section', 'remove-section', 'edit'].includes(action)
      const isRead = !isWrite && (gitOptionExactly(rest, CONFIG_READS, 'l') || ['get', 'list', 'get-color', 'get-colorbool'].includes(action) || said.length <= 1)
      if (isRead) {
        return none
      }
      // The file it writes: `-f`, or `--file` by any prefix git takes (R1's helper); `--global` by any prefix too.
      const file = gitOptionValues(rest, '--file')[0]?.text ?? flagValue(rest, '-f', null)

      return { ...none, writes: [literal(file ?? (gitOption(rest, ['--global']) !== null ? '~/.gitconfig' : '.git/config'))] }
    }
    case 'diff': case 'log': case 'show': case 'format-patch': {
      // `--output` and `--output-directory` by any prefix git takes (R1's helper: `--out` counts as either); `-o` is format-patch's.
      const long = [...gitOptionValues(rest, '--output'), ...gitOptionValues(rest, '--output-directory')]
      const short = sub === 'format-patch' ? flagValue(rest, '-o', null) : null
      const outs = [...new Set([...long.map(word => word.text), ...(short === null ? [] : [short])])]

      return outs.length === 0 ? none : { ...none, writes: outs.map(literal) }
    }
    default:
      return none
  }
}

// ---------------------------------------------------------------- hosts

const URL_HOST = /\b[a-z][a-z0-9+.-]*:\/\/(?:[^\s/@'"]*@)?(\[[^\]\s]+\]|[^\s/:'"?#)]+)/gi
/** `user@host:path`, as scp and git's SSH remotes spell it. */
const SCP_HOST = /^[\w.+-]+@([a-z0-9][a-z0-9.-]*)(?=:)/i
const HOST_WORD = /^(?:[\w.+-]+@)?(\[[0-9a-f:]+\]|[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*)(?::[^\s]*)?$/i
const IPV4 = /^\d{1,3}(?:\.\d{1,3}){3}(?::\d+)?(?:\/|$)/

const cleanHost = (host: string): string => host.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '')

const NC = { short: 'eIiMmOPpqsTVWwxX', long: [] }

/** Network tools, with the flags that take the next word as their value: that word is no host. */
const NETWORK: Record<string, { short: string; long: readonly string[] }> = {
  curl: {
    short: 'AbcCdDeEFHKmorTuUwxXyYz',
    long: ['--output', '--header', '--data', '--data-raw', '--data-binary', '--data-urlencode', '--user', '--request', '--user-agent', '--referer', '--upload-file', '--form', '--cookie', '--cookie-jar', '--config', '--max-time', '--range', '--write-out', '--proxy', '--cert', '--key', '--connect-timeout', '--retry'],
  },
  wget: {
    short: 'aBeiOoPtTUw',
    long: ['--output-document', '--output-file', '--directory-prefix', '--user-agent', '--header', '--tries', '--timeout', '--wait', '--input-file', '--base', '--post-data', '--post-file', '--user', '--password'],
  },
  ssh: { short: 'BbcDEeFIiJLlmOoPpQRSWw', long: [] },
  scp: { short: 'cDFiJloPSX', long: [] },
  sftp: { short: 'BbcDFiJloPRSs', long: [] },
  rsync: { short: 'e', long: ['--rsh', '--exclude', '--include', '--filter'] },
  nc: NC,
  ncat: NC,
  netcat: NC,
  telnet: { short: 'bel', long: [] },
}

/**
 * Programs that only handle text: a URL among their arguments is data they
 * print, search or record (`grep "https://…"`, `echo`, a commit message),
 * not a host they contact.
 */
const TEXT_TOOLS = ['grep', 'egrep', 'fgrep', 'rg', 'echo', 'printf', 'sed', 'awk', 'jq', 'cat', 'head', 'tail', 'sort', 'uniq', 'wc', 'cut', 'tr', 'tee', 'diff']
const GIT_TEXT = ['commit', 'tag', 'log', 'show', 'grep', 'notes', 'diff', 'blame', 'stash']

/** The hosts one simple command names: URLs and remotes in any argument, and a network tool's destination. */
function hostsOf(program: string | null, args: Word[]): string[] {
  const hosts = new Set<string>()
  if (program !== null && (TEXT_TOOLS.includes(program) || (program === 'git' && GIT_TEXT.includes(gitSub(args).sub ?? '')))) {
    return []
  }
  // A word with whitespace is data (a message, a pattern), not an address.
  const words = args.filter(word => !/\s/.test(word.text))
  for (const word of words) {
    for (const match of word.text.matchAll(URL_HOST)) {
      hosts.add(cleanHost(match[1] ?? ''))
    }
    const remote = SCP_HOST.exec(word.text.replace(/^[^=]*=/, ''))
    if (remote !== null) {
      hosts.add(cleanHost(remote[1] ?? ''))
    }
  }
  const flags = program === null ? undefined : NETWORK[program]
  if (program !== null && flags !== undefined) {
    const positional = operands(args, flags.short, flags.long).map(word => word.text).filter(text => !/^[a-z][a-z0-9+.-]*:\/\//i.test(text))
    // ssh, nc and telnet name one destination first; the rest is a command or a port.
    const named = ['ssh', 'nc', 'ncat', 'netcat', 'telnet'].includes(program)
      ? positional.slice(0, 1)
      : ['scp', 'sftp', 'rsync'].includes(program)
        ? positional.filter(text => text.includes(':') || program === 'sftp')
        : positional.filter(text => /\.[a-z]{2,}(?::\d+)?(?:\/|$)/i.test(text) || /^localhost\b/i.test(text) || IPV4.test(text))
    for (const text of named) {
      const host = HOST_WORD.exec(text.replace(/\/.*$/, ''))?.[1]
      if (host !== undefined) {
        hosts.add(cleanHost(host))
      }
    }
  }
  hosts.delete('')

  return [...hosts]
}

// ---------------------------------------------------------------- parsing

/** Path-like words inside a piece of inline code: quoted strings and bare words that look like files. */
function pathsInCode(code: string): string[] {
  const found = new Set<string>()
  for (const match of code.matchAll(/["'`]([^"'`\s]+)["'`]|(?:^|[\s(,=])((?:\.{0,2}\/|~\/)?[\w.-]+(?:\/[\w.*-]+)+|\.[\w.-]+|[\w-]+\.[A-Za-z0-9]{1,8})(?=$|[\s),;])/g)) {
    const text = match[1] ?? match[2]
    if (text !== undefined && text !== '') {
      found.add(text)
    }
  }

  return [...found]
}

/** Numbers pipelines across nested parses, so stages of different lines never share one. */
type Counter = { next: number }

/** The words before a `find` expression: where it starts looking. */
function findRoots(args: readonly Word[]): Word[] {
  // `\(` and `\!` are how a shell line spells find's own operators.
  const end = args.findIndex(word => word.text === '(' || word.text === '!' || (!word.isQuoted && word.text.startsWith('-')))
  const roots = args.slice(0, end < 0 ? args.length : end)

  return roots.length > 0 ? roots : [literal('.')]
}

/** `find` tests that narrow what it matches by name or path. */
const FIND_FILTERS = ['-name', '-iname', '-path', '-ipath', '-wholename', '-iwholename']

/**
 * What a `find` expression's name and path filters select under each root,
 * as globs (`find . -name "*.pyc"` selects `./**\/*.pyc`); null when some
 * branch of it has no such filter, or a test is negated, so the roots stand in.
 */
function findFilters(args: readonly Word[], roots: readonly Word[]): Word[] | null {
  const expression = args.slice(args.indexOf(roots[roots.length - 1] as Word) + 1)
  if (expression.some(word => word.text === '!' || (!word.isQuoted && ['-not', '-regex', '-iregex'].includes(word.text)))) {
    return null
  }
  // Each branch of an `-o` must be narrowed by a filter of its own.
  const branches: Word[][] = [[]]
  for (const word of expression) {
    if (!word.isQuoted && ['-o', '-or', ','].includes(word.text)) {
      branches.push([])
    } else {
      branches[branches.length - 1]?.push(word)
    }
  }
  if (!branches.every(branch => branch.some(word => !word.isQuoted && FIND_FILTERS.includes(word.text)))) {
    return null
  }
  const globs: Word[] = []
  for (let i = 0; i < expression.length; i += 1) {
    const flag = expression[i] as Word
    const value = expression[i + 1]
    if (flag.isQuoted || !FIND_FILTERS.includes(flag.text) || value === undefined || value.hasExpansion) {
      continue
    }
    for (const root of roots) {
      const base = root.text.replace(/\/+$/, '') || '/'
      // `-name` matches the last part at any depth; `-path` the whole path, where `*` crosses folders.
      const text = flag.text.endsWith('name') && !flag.text.endsWith('wholename')
        ? `${base}/**/${value.text}`
        : value.text.startsWith(`${base}/`) ? value.text.replace(/\*+/g, '**') : `${base}/${value.text.replace(/\*+/g, '**').replace(/^\/+/, '')}`
      globs.push({ text, isQuoted: false, hasExpansion: false, hasGlob: true })
    }
    i += 1
  }

  return globs.length > 0 ? globs : null
}

/** Test runners a computed command name may end in (`"$VENV/bin/pytest"`), and modules run with `-m`. */
const TEST_RUNNERS = ['pytest', 'py.test', 'jest', 'vitest', 'mocha', 'ava', 'phpunit', 'rspec', 'tox', 'nox', 'ctest', 'bats', 'karma', 'playwright']
const TEST_MODULES = ['pytest', 'unittest', 'nose2', 'tox', 'nox']

/** The interpreter's inline-code flag in `args`, or -1: `python -c`, `node -e`, `perl -e`. */
function inlineCode(program: string, args: readonly Word[]): number {
  const flags = INTERPRETERS[program] ?? INTERPRETERS[program.replace(/[0-9.]+$/, '')]
  if (flags === undefined) {
    return -1
  }

  return args.findIndex(word => !word.isQuoted && (flags.includes(word.text) ||
    (/^-[a-zA-Z]+$/.test(word.text) && flags.some(flag => flag.length === 2 && word.text.endsWith(flag.slice(1))))))
}

/**
 * What a line knows of its variables as it goes (R8): each name a literal
 * assignment earlier on the line gave a value, or null where the line gave it
 * one the model cannot compute (an expansion, an append, two different
 * values, an `unset`, a `read`); and the judging process's own values of
 * `ENV_NAMES`, used only for a name the line does not set. `globs`: what the
 * hook found each wildcard target of a `cd` or `pushd` to match on disk
 * (`movePattern`), the same for the whole line.
 */
type Vars = { line: Map<string, string | null>; env: Env; globs: Globs | undefined; reading: Reading }

/** What each wildcard pattern matched on disk (P-C), by the pattern the model asked for: the matches, or `capped`. */
type Globs = Readonly<Record<string, readonly string[] | 'capped'>>

/**
 * The pattern a wildcard target of a `cd`, or any target of a `pushd`, is
 * looked up by (the twelfth round, X11; Y1: a `pushd` is followed only to a
 * folder that exists): absolute, from the folder the move runs in, with the
 * characters that were quoted escaped (the word's template), and a trailing
 * `/`, so that only folders match. Null when the move's folder is not known,
 * the target holds an expansion, or a `cd` target holds no wildcard the shell
 * expands.
 */
function movePattern(target: Word, at: string | null, home: string | null, isPushd: boolean): string | null {
  if ((!target.hasGlob && !isPushd) || target.hasExpansion) {
    return null
  }
  const glob = target.template ?? target.text
  const spelled = glob === '~' || glob.startsWith('~/') ? (home === null ? null : `${home}${glob.slice(1)}`) : glob.startsWith('~') ? null : glob
  const abs = spelled === null ? null : spelled.startsWith('/') ? spelled : at === null || !at.startsWith('/') ? null : `${at}/${spelled}`

  return abs === null ? null : `${abs.replace(/\/+$/, '')}/`
}

/**
 * The word a `cd` names, or the one word of a `pushd` the model follows (none
 * for a form it cannot follow); undefined for `cd` alone. `pushd -- dir` is
 * `pushd dir` (Y1), but `pushd -- -` is the previous folder, which the model
 * does not keep.
 */
function moveTarget(program: string | null, args: readonly Word[]): Word | undefined {
  if (program === 'cd') {
    return operands(args)[0]
  }
  if (program !== 'pushd') {
    return undefined
  }
  const word = args.length === 1 ? args[0] : args.length === 2 && args[0]?.text === '--' ? args[1] : undefined

  return word === undefined || word.text === '' || (args.length === 1 ? /^[-+]/.test(word.text) : word.text === '-') ? undefined : word
}

/** Programs that set the variables their arguments name. */
const DECLARERS = ['export', 'declare', 'typeset', 'readonly', 'local']

/** A word as the shell would expand it (R8, R9): variables the line knows replaced, then braces expanded. Unchanged when it holds neither. */
function expandWord(word: Word, value: (name: string) => string | null, isAssigning: boolean): Word[] {
  const template = word.template
  if (template === undefined || template === '' || (!hasMarker(template) && (isAssigning || !holds(template, '{')))) {
    return [word]
  }
  const resolved = hasMarker(template) ? resolveTemplate(template, value) : template
  if (resolved === null && (isAssigning || !holds(template, '{'))) {
    // Nothing the line knows: the word stays as the tokenizer read it.
    return [word]
  }
  const alternatives = isAssigning ? [resolved ?? template] : braceExpand(resolved ?? template)
  if (alternatives === null) {
    return [{ ...word, isCapped: true }]
  }

  return alternatives.map(one => {
    const isOpen = resolved === null && hasMarker(one)

    return {
      text: templateText(one),
      isQuoted: word.isQuoted,
      hasExpansion: isOpen,
      hasGlob: isGlobTemplate(one) || (isOpen && word.hasGlob),
      template: one,
      ...(isOpen ? { lead: word.lead ?? null } : {}),
    }
  })
}

/**
 * Builds the segments of one command line. `cwd` is where relative paths
 * start; `cd` moves it for the commands after it, within their subshell.
 */
function build(text: string, cwd: string, depth: number, counter: Counter, isNested: boolean, vars: Vars): Segment[] {
  const segments: Segment[] = []
  let pipeline = counter.next
  counter.next += 1
  let place = 0
  const scopes: { at: string | null; dirs: (string | null)[] }[] = []
  let at: string | null = cwd
  /** The folders `pushd` kept, the latest last (N2). */
  let dirs: (string | null)[] = []
  let words: Word[] = []
  let redirects: { op: string; target: Word | null }[] = []
  let subs: string[] = []
  /**
   * A word that starts with `~+` (the shell's `$PWD`) as the folder the model
   * follows, where it is known (the twelfth round, W1). The extended reading
   * only: the reviewed reading judges the word as written, as `2374c49` did
   * (the fourteenth round, CC1, CC-F3).
   */
  const tildeHere = (word: Word): Word => {
    if (vars.reading === 'reviewed' || at === null || !at.startsWith('/') || word.hasExpansion || !/^~\+(?:\/|$)/.test(word.text)) {
      return word
    }
    const template = word.template === undefined ? undefined : `${[...at].map(c => encode(c, true)).join('')}${word.template.slice(2)}`

    return { ...word, text: `${at}${word.text.slice(2)}`, ...(template === undefined ? {} : { template }) }
  }
  /** A variable's value, as far as the line knows it: the line's own, else the environment's for the names it may give. */
  const valueOf = (name: string): string | null => {
    if (vars.line.has(name)) {
      return vars.line.get(name) ?? null
    }
    if (name === 'PWD' && at !== null && at.startsWith('/')) {
      return at
    }
    if (!ENV_NAMES.includes(name)) {
      return null
    }
    const found = vars.env[name]

    return found === undefined || found === null || found === '' ? null : found
  }
  const setVar = (name: string, value: string | null): void => {
    const known = vars.line.get(name)
    vars.line.set(name, vars.line.has(name) && known !== value ? null : value)
  }

  const nested = (code: string, from: string | null, inline: readonly Assigned[] = []): void => {
    if (depth < MAX_NESTING) {
      const line = new Map(vars.line)
      for (const one of inline) {
        line.set(one.name, one.isComputed ? null : one.value)
      }
      segments.push(...build(code, from ?? cwd, depth + 1, counter, true, { line, env: vars.env, globs: vars.globs, reading: vars.reading }))

      return
    }
    // Past the limit the code is not followed, and not taken for nothing: an unknown writer and a possible ship (D1 F12).
    const words = tokenize(code, vars.reading).flatMap(token => (token.kind === 'word' ? [token.word] : []))
    segments.push({
      words, wrappers: [], assignments: [], assigned: [], program: null, args: [], sub: null, redirects: [], writes: [], isWriteOpen: true, maybeWrites: [], reads: [], isReadKnown: false, readsDeep: [], replaces: [], links: [], capped: [], hosts: [],
      isUnknown: true, named: [...new Set([...words.filter(isPathLike).map(word => word.text.replace(/^[^=]*=/, '')), ...pathsInCode(code)])].filter(path => path !== ''),
      cwd: from ?? cwd, moveGlob: null, pipeline: counter.next, place: 0, isNested: true, isFedByInput: false, isBeyondDepth: true,
    })
    counter.next += 1
  }
  const fresh = (): void => {
    pipeline = counter.next
    counter.next += 1
    place = 0
  }

  const close = (): void => {
    for (const sub of subs) {
      nested(sub, at)
    }
    subs = []
    if (words.length === 0 && redirects.length === 0) {
      return
    }
    // Variables the line knows are replaced, and braces expanded, before anything is judged (R8, R9).
    const expanded = words.flatMap(word => expandWord(tildeHere(word), valueOf, isAssignment(word)))
    const peeled = peel(expanded)
    const rest = peeled.isLookup ? [] : peeled.rest
    const head = rest[0]
    const args = rest.slice(1)
    let program: string | null = null
    let isUnknown = false
    const named: string[] = []
    if (head !== undefined && !CLOSERS.includes(head.text)) {
      if (head.hasExpansion) {
        // A computed command name: what runs is known only when it runs,
        // unless it is plainly a test run (`$PYTHON -m pytest`, `"$VENV/bin/pytest"`).
        const runner = basename(head.text)
        if (TEST_RUNNERS.includes(runner)) {
          program = runner
        } else if (!(args[0]?.text === '-m' && TEST_MODULES.includes(args[1]?.text ?? ''))) {
          isUnknown = true
        }
      } else {
        program = basename(head.text)
      }
    }
    const assigned = peeled.assigned.map(assignedOf)
    const moved = peeled.cwd
    let segCwd = moved === null ? at : moved.startsWith('/') ? moved : at === null ? null : `${at}/${moved}`
    let sub: string | null = null
    if (program === 'git') {
      const found = gitSub(args)
      sub = found.sub
      if (found.dir !== null) {
        segCwd = found.dir.startsWith('/') ? found.dir : segCwd === null ? null : `${segCwd}/${found.dir}`
      }
    } else {
      sub = operands(args)[0]?.text ?? null
    }
    if (peeled.split !== null) {
      nested(peeled.split, segCwd, assigned)
    }
    // A shell given a script on the line runs that script: judge it too.
    if (program !== null && SHELLS.includes(program)) {
      const flag = args.findIndex(word => !word.isQuoted && /^-[a-zA-Z]*c[a-zA-Z]*$/.test(word.text))
      const script = flag >= 0 ? args[flag + 1] : undefined
      if (script !== undefined) {
        isUnknown ||= script.hasExpansion
        nested(script.text, segCwd, assigned)
      }
    }
    if (program === 'eval') {
      isUnknown = true
      nested(args.map(word => word.text).join(' '), segCwd, assigned)
    }
    if (program !== null) {
      const flag = inlineCode(program, args)
      if (flag >= 0) {
        isUnknown = true
        named.push(...pathsInCode(args[flag + 1]?.text ?? ''))
      }
    }
    let writes: Word[] = []
    let reads: Word[] = []
    let maybe: Word[] = []
    let isReadKnown = program !== null && READ_KNOWN.includes(program)
    let readsDeep: Word[] = []
    let replaces: Word[] = []
    let links: { name: Word; target: Word; isSymbolic: boolean }[] = []
    if (program !== null) {
      const found = effects(program, sub, args)
      writes = found.writes
      reads = found.reads
      maybe = found.maybe ?? []
      isUnknown ||= found.isUnknown
      isReadKnown &&= found.isReadKnown !== false
      readsDeep = found.readsDeep ?? []
      replaces = found.replaces ?? []
      links = found.links ?? []
    }
    if (program === 'curl') {
      // A file curl's options read and send (EE2) is a path the line names, judged as any other (secrets, links, wildcards, budgets).
      named.push(...reads.filter(word => !word.hasExpansion).map(word => word.text))
    }
    if (program === 'find') {
      // `-exec cmd {} ;` runs a command per path found; `-delete` and `-fprint` write.
      // With a name or path filter, what the filter selects stands for the paths found; without one, the roots do.
      const roots = findRoots(args)
      const filtered = findFilters(args, roots)
      reads = roots
      for (let i = 0; i < args.length; i += 1) {
        const flag = args[i]?.text ?? ''
        if (['-exec', '-execdir', '-ok', '-okdir'].includes(flag)) {
          const end = args.findIndex((word, j) => j > i && (word.text === ';' || word.text === '+'))
          const body = args.slice(i + 1, end < 0 ? args.length : end)
          // A filter's glob goes in quoted, so it is judged as the paths it selects, not expanded.
          for (const found of filtered ?? roots) {
            const path = filtered === null ? found.text : `'${found.text}'`
            nested(body.map(word => (word.text === '{}' ? path : /[\s'"]/.test(word.text) ? `'${word.text.replace(/'/g, '')}'` : word.text)).join(' '), segCwd)
          }
          i = end < 0 ? args.length : end
        } else if (flag === '-delete') {
          writes = [...writes, ...(filtered ?? roots)]
        } else if (['-fprint', '-fprint0', '-fprintf', '-fls'].includes(flag) && args[i + 1] !== undefined) {
          writes = [...writes, args[i + 1] as Word]
        }
      }
    }
    if (isUnknown) {
      named.push(...args.filter(isPathLike).map(word => word.text.replace(/^[^=]*=/, '')))
    }
    // A redirect's target is a word like any other: variables the line knows are replaced in it (R8).
    // (A brace in a redirect is an error to the shell; each of its words is taken as a target all the same.)
    const placedRedirects: Redirect[] = []
    // Whether a path it writes holds an expansion the model could not resolve (P-B): an always-held rule takes it for the forbidden place.
    let isWriteOpen = writes.some(word => word.hasExpansion)
    for (const { op, target } of redirects) {
      const isHere = /<<<?-?$/.test(op)
      for (const word of target === null ? [null] : isHere ? [target] : expandWord(tildeHere(target), valueOf, false)) {
        const shown = word?.text ?? ''
        const isDescriptor = target === null
        const isNull = /^\/dev\/(?:null|stdout|stderr|stdin|tty|fd\/\d+)$/.test(shown)
        const isPlain = !isDescriptor && !isNull && !isHere
        placedRedirects.push({ op, target: shown, isWrite: isPlain && op.includes('>'), isRead: isPlain && op.includes('<') })
        isWriteOpen ||= isPlain && op.includes('>') && word?.hasExpansion === true
      }
    }
    for (const one of placedRedirects) {
      if (one.isWrite) {
        writes = [...writes, literal(one.target)]
      } else if (one.isRead) {
        reads = [...reads, literal(one.target)]
      }
    }
    const isText = (word: Word): boolean => word.text !== ''
    // A wildcard target of a move, and any `pushd` target, is looked up by the hook and followed only where it matched one folder (X11, Y1).
    const target = moveTarget(program, args)
    const home = valueOf('HOME')
    // The reviewed reading looks nothing up for a move (BB1): it does not follow `pushd`, and a `cd` target is its text.
    const pattern = target === undefined || vars.reading === 'reviewed' ? null : movePattern(target, at, home, program === 'pushd')
    segments.push({
      words: expanded,
      wrappers: peeled.wrappers,
      assignments: peeled.assignments,
      assigned,
      program,
      args,
      sub,
      redirects: placedRedirects,
      writes: writes.map(word => word.text).filter(path => path !== ''),
      isWriteOpen,
      maybeWrites: maybe.filter(word => !word.hasExpansion).map(word => word.text).filter(path => path !== ''),
      reads: reads.filter(word => !word.hasExpansion).map(word => word.text).filter(path => path !== ''),
      isReadKnown: isReadKnown && reads.every(word => !word.hasExpansion),
      readsDeep: readsDeep.filter(word => !word.hasExpansion && isText(word)).map(word => word.text),
      replaces: replaces.filter(word => !word.hasExpansion && isText(word)).map(word => word.text),
      links: links.filter(one => !one.name.hasExpansion && !one.target.hasExpansion && isText(one.name) && isText(one.target)).map(one => ({ name: one.name.text, target: one.target.text, isSymbolic: one.isSymbolic })),
      capped: expanded.filter(word => word.isCapped === true).map(word => word.text),
      hosts: hostsOf(program, args),
      isUnknown,
      named: [...new Set(named)].filter(path => path !== ''),
      cwd: segCwd,
      moveGlob: pattern,
      pipeline,
      place,
      isNested,
      isFedByInput: peeled.wrappers.includes('xargs'),
    })
    // What a bare assignment or a declaration sets holds for the rest of the line (R8); one the model cannot compute is unknown.
    if (program === null && head === undefined) {
      for (const one of assigned) {
        setVar(one.name, one.isComputed ? null : one.value)
      }
    } else if (program !== null && DECLARERS.includes(program)) {
      for (const word of args.filter(isAssignment)) {
        const one = assignedOf(word)
        setVar(one.name, one.isComputed ? null : one.value)
      }
    } else if (program === 'unset' || program === 'read' || program === 'mapfile' || program === 'readarray' || program === 'getopts') {
      for (const word of operands(args, program === 'read' ? 'adinNpt' : 'dnOsuCc')) {
        if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(word.text)) {
          vars.line.set(word.text, null)
        }
      }
    }
    // `cd` moves the commands after it; one that cannot be followed loses the place. `~` is the home the line knows (R8).
    // `pushd <dir>` moves as `cd` does and keeps the old place; `popd` returns to it (ninth round, N2). Any other `pushd`
    // or `popd` (no word, an option or `+N`/`-N`, more words, a target the model cannot follow; `popd` with a word or with
    // nothing kept) leaves the place and the stack as they were (the twelfth round, W1). A wildcard target is followed
    // only where it matched exactly one folder (X11); a `pushd` only where its target, as the hook looked it up on disk,
    // is exactly one existing folder: one not looked up, missing, or past the cap leaves both as they were (Y1).
    if (vars.reading === 'reviewed') {
      // As `2374c49` (its hooks/shell.ts, lines 1731-1740): only `cd` moves, and its target as written, a wildcard too.
      if (program === 'cd') {
        const text = target === undefined ? '~' : target.text
        const spelled = target !== undefined && target.hasExpansion ? null : text === '~' || text.startsWith('~/') ? (home === null ? null : `${home}${text.slice(1)}`) : text
        at = spelled === null || spelled === '-' || spelled.startsWith('~')
          ? null
          : spelled.startsWith('/') ? spelled : at === null ? null : `${at}/${spelled}`
      }
    } else if (program === 'popd') {
      if (args.length === 0 && dirs.length > 0) {
        at = dirs.pop() ?? null
      }
    } else if (program === 'pushd') {
      const matched = pattern === null ? undefined : vars.globs?.[pattern]
      const found = Array.isArray(matched) && matched.length === 1 ? matched[0] : undefined
      if (found !== undefined) {
        dirs.push(at)
        at = found
      }
    } else if (program === 'cd') {
      const text = target === undefined ? '~' : target.text
      const matched = pattern === null ? undefined : vars.globs?.[pattern]
      const spelled = target !== undefined && target.hasExpansion ? null
        : target !== undefined && target.hasGlob ? (Array.isArray(matched) && matched.length === 1 ? (matched[0] ?? null) : null)
        : text === '~' || text.startsWith('~/') ? (home === null ? null : `${home}${text.slice(1)}`) : text
      const to = spelled === null || spelled === '-' || spelled.startsWith('~')
        ? null
        : spelled.startsWith('/') ? spelled : at === null ? null : `${at}/${spelled}`
      at = to
    }
    words = []
    redirects = []
    place += 1
  }

  for (const token of tokenize(text, vars.reading)) {
    if (token.kind === 'word') {
      words.push(token.word)
      subs.push(...token.subs)
    } else if (token.kind === 'redirect') {
      subs.push(...token.subs)
      redirects.push({ op: token.op, target: token.target })
    } else {
      close()
      if (token.op === '(') {
        scopes.push({ at, dirs: [...dirs] })
      } else if (token.op === ')') {
        const scope = scopes.pop()
        if (scope !== undefined) {
          at = scope.at
          dirs = scope.dirs
        }
      }
      if (token.op !== '|' && token.op !== '|&') {
        fresh()
      }
    }
  }
  close()

  return segments
}

/**
 * The simple commands a line runs, in order, nested ones (from `bash -c`,
 * substitutions, `find -exec`, `env -S`) included. `cwd` anchors relative
 * paths and is moved by `cd`. `env` gives the judging process's values of
 * `ENV_NAMES` (R8): a path held in one of them, or in a variable a literal
 * assignment earlier on the line set, is placed by its value. `globs`: what
 * the hook found the wildcard targets of the line's moves to match (X11).
 */
export function parse(command: string, reading: Reading, cwd = '.', env: Env = {}, globs?: Globs): Segment[] {
  return build(command, cwd, 0, { next: 0 }, false, { line: new Map(), env, globs, reading })
}

/**
 * The line under both readings (BB1), the reviewed one first: what every
 * place that judges a line parses it with, so that none judges it under one
 * alone. Each caller combines them: refusals and places as the union, and
 * an answer of "allowed" or "nothing here" only where both give it.
 */
export function readings(command: string, cwd = '.', env: Env = {}, globs?: Globs): Segment[][] {
  return READINGS.map(reading => parse(command, reading, cwd, env, globs))
}

/** Whether a line is more than one simple command joined by pipes, under both readings: a list, a newline, a background job, a subshell. */
export function isOneLine(command: string): boolean {
  return READINGS.every(reading => tokenize(command, reading).every(token => token.kind !== 'op' || token.op === '|' || token.op === '|&'))
}

/** The command as the policy's patterns read it: wrappers peeled, data strings blanked. */
export function view(segment: Segment, isPeeled: boolean): string {
  const words = isPeeled ? (segment.program === null ? [] : [{ text: segment.program } as Word, ...segment.args]) : segment.words
  const shown = words.map(word => (word.isQuoted && /\s/.test(word.text) ? '"…"' : word.text))

  return shown.join(' ')
}

/**
 * Every value a line gives an environment variable in the segments before a
 * command (final round, D1 F3, D2 F8; the last review's F3): an `export`,
 * `declare -x`, `typeset -x` or `readonly` of it, a bare assignment (which
 * also changes it where it is already exported), or one inline before a
 * command. All of them, in order: a value exported or assigned anywhere
 * earlier on the line holds for the rules, and nothing later on the line
 * (another assignment, one-command or not, an `unset`) cancels it. Each
 * says whether it held an expansion the model could not resolve (the
 * cache-guard round, R2, P-B), which an always-held rule takes for the value
 * it protects. Empty when the line sets none.
 */
export function assignedBefore(name: string, earlier: readonly Segment[]): Assigned[] {
  const values: Assigned[] = []
  for (const segment of earlier) {
    const declared = segment.program !== null && DECLARERS.includes(segment.program) ? segment.args.filter(isAssignment).map(assignedOf) : []
    for (const one of [...segment.assigned, ...declared]) {
      if (one.name === name) {
        values.push(one)
      }
    }
  }

  return values
}
