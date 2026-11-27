// The injection scan of instruction and skill files (DESIGN 4.7, C1): text a
// later session reads as instructions is checked for what has no innocent
// use there. Pure: no `$`. What it knowingly misses is in RESIDUAL-RISK.md.

/** What a hit is: the first two classes have no innocent use and keep the gate shut. */
export type InjectionKind = 'invisible' | 'bidi' | 'decode-exec' | 'secret-read' | 'pipe-to-shell' | 'harness-edit'

export type Injection = { file: string; line: number; kind: InjectionKind; text: string }

/** The kinds that make the "Instruction files changed" row unmet; the rest are reported. */
export const BLOCKING_KINDS: readonly InjectionKind[] = ['invisible', 'bidi']

/**
 * Zero-width and other invisible characters, and the Unicode tag block
 * (U+E0000–U+E007F, written as surrogate pairs), which can carry text a
 * reader never sees. A byte-order mark is allowed as a file's first character.
 */
const INVISIBLE = /[​‌‍⁠⁡⁢⁣⁤᠎﻿]|\uDB40[\uDC00-\uDC7F]/
/** Bidirectional embeddings, overrides and isolates: text that displays in another order than it reads. */
const BIDI = /[‪-‮⁦-⁩]/
/** Decoding something and running it: `base64 -d | sh`, `eval(atob(…))`, `exec(b64decode(…))`. */
const DECODE_EXEC = [
  /(?:base64\s+(?:-d|--decode|-D)|b64decode|atob\s*\(|xxd\s+-r|fromCharCode)[^\n]{0,120}?(?:\|\s*(?:sudo\s+)?(?:ba|z|da|k)?sh\b|\beval\b|\bexec\b|\|\s*(?:python3?|node|perl|ruby)\b)/i,
  /\b(?:eval|exec)\s*\(?[^\n]{0,40}?(?:b64decode|atob\s*\(|base64)/i,
]
/** A download handed to a shell as its program. */
const PIPE_TO_SHELL = /\b(?:curl|wget)\b[^\n|;]*\|\s*(?:sudo\s+)?(?:ba|z|da|k)?sh\b/i
/** A line that says not to do something is no directive to do it. */
const NEGATED = /\b(?:never|do not|don't|dont|must not|mustn't|should not|shouldn't|avoid|no)\b/i
/** Reading or sending a secret: a verb of reading or sending, then a secret's usual place. */
const SECRET_READ = /\b(?:read|cat|print|show|send|upload|post|curl|exfiltrat\w*|copy|paste|include|output|echo)\b[^\n]{0,60}?(?:\.env\b|id_rsa|id_ed25519|\.ssh\/|\.aws\/credentials|\.netrc|\.npmrc|private key|api[_ -]?keys?\b|access tokens?\b|\$[A-Z_]*(?:TOKEN|SECRET|PASSWORD|API_KEY)\b)/i
/** Changing what judges or runs on the builder's behalf: hooks, settings, the policy. */
const HARNESS_EDIT = /\b(?:edit|modify|change|update|disable|delete|remove|overwrite|rewrite|write to|append to|turn off)\b[^\n]{0,50}?(?:\.claude\/settings|settings(?:\.local)?\.json|\.claude\/hooks|\.git\/hooks|\.husky|devloop\.json|pre-commit hook|git hooks?)/i

/**
 * Scripts that need a zero-width non-joiner between their letters (Persian
 * and other Arabic-script languages, the Indic scripts, and a few more): one
 * there is spelling, not hiding (C1 review F7).
 */
const ZWNJ_SCRIPTS = '\\p{Script=Arabic}\\p{Script=Syriac}\\p{Script=Thaana}\\p{Script=Nko}\\p{Script=Devanagari}\\p{Script=Bengali}\\p{Script=Gurmukhi}\\p{Script=Gujarati}\\p{Script=Oriya}\\p{Script=Tamil}\\p{Script=Telugu}\\p{Script=Kannada}\\p{Script=Malayalam}\\p{Script=Sinhala}\\p{Script=Khmer}\\p{Script=Myanmar}\\p{Script=Mongolian}'
const INNOCENT_ZWNJ = new RegExp(`([${ZWNJ_SCRIPTS}]\\p{M}*)\\u200C(?=\\p{M}*[${ZWNJ_SCRIPTS}])`, 'gu')
/** A zero-width joiner inside an emoji sequence (a family, a profession, a flag): the emoji needs it (F7). */
const INNOCENT_ZWJ = /(\p{Extended_Pictographic}(?:\uFE0F|[\u{1F3FB}-\u{1F3FF}])?)\u200D(?=\p{Extended_Pictographic})/gu

/** A line with the joiners that have an innocent use taken out: what is left is checked for hidden characters. */
export const withoutInnocentJoiners = (line: string): string => line.replace(INNOCENT_ZWJ, '$1').replace(INNOCENT_ZWNJ, '$1')

/** An example or template file a line may name (`.env.example`, `config.sample.json`): naming one is no secret read (F8). */
const EXAMPLE_FILE = /(?:^|[\s`'"(/])[\w.-]*\.(?:example|sample|template|dist|tmpl)(?:\.[\w]+)?\b|\bexample[\w.-]*\.(?:env|json|ya?ml|toml)\b/i

/**
 * Scans one file's text, line by line; `file` names it in each hit. Hidden
 * characters are always hits (but for the joiners emoji and some scripts
 * need); every other class is a warning, and a line that says not to do it
 * is no hit for any of them (F8). A line that names an example or template
 * file is no secret read.
 */
export function scanInjection(file: string, text: string): Injection[] {
  const out: Injection[] = []
  const lines = text.split('\n')
  lines.forEach((raw, i) => {
    const line = i === 0 ? raw.replace(/^\uFEFF/, '') : raw
    const at = i + 1
    const shown = line.replace(/[\u200B-\u200D\u2060-\u2064\u180E\uFEFF\u202A-\u202E\u2066-\u2069]|\uDB40[\uDC00-\uDC7F]/g, '?').trim().slice(0, 100)
    const add = (kind: InjectionKind): void => {
      out.push({ file, line: at, kind, text: shown })
    }
    if (INVISIBLE.test(withoutInnocentJoiners(line))) {
      add('invisible')
    }
    if (BIDI.test(line)) {
      add('bidi')
    }
    const isNegated = NEGATED.test(line)
    if (!isNegated && DECODE_EXEC.some(one => one.test(line))) {
      add('decode-exec')
    }
    if (!isNegated && PIPE_TO_SHELL.test(line)) {
      add('pipe-to-shell')
    }
    if (!isNegated && !EXAMPLE_FILE.test(line) && SECRET_READ.test(line)) {
      add('secret-read')
    }
    if (!isNegated && HARNESS_EDIT.test(line)) {
      add('harness-edit')
    }
  })

  return out
}

/** Only the hits that keep the gate shut: invisible and bidirectional characters. */
export const hiddenOf = (file: string, text: string): Injection[] =>
  scanInjection(file, text).filter(one => BLOCKING_KINDS.includes(one.kind))

/** What a kind means, for doctor. */
export const KIND_WORDS: Record<InjectionKind, string> = {
  'invisible': 'invisible or tag characters',
  'bidi': 'a bidirectional override',
  'decode-exec': 'decodes something and runs it',
  'pipe-to-shell': 'pipes a download into a shell',
  'secret-read': 'tells the reader to read or send a secret',
  'harness-edit': 'tells the reader to edit hooks, settings or the policy',
}
