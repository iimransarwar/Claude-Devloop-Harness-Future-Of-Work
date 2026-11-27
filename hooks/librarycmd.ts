// The spec library at work (docs/design-notes/spec-library.md, DESIGN 4.18):
// where it lives (the person's choice, kept in the store under a key of no
// repository), saving an approved spec into it at /devloop done and on a
// person's /devloop library save, the devloop_library tool's search, a
// defect recorded later against a saved change, doctor's lines, and the
// person's /devloop library commands. The entry, the index's lines, the
// scan and the ranking are pure, in library.ts. The harness writes the
// folder; it never commits, pulls or pushes it.

import type { CommandRunInput, CommandRunResult } from 'claude-code'

import type { Loop } from '../types'
import type { Config } from './config'
import { actorOf, audit, checkRecord, confirm, isFromPerson, listOf } from './journal'
import { contentHash, entryOf, indexLine, listLine, readIndex, resultText, scanSpecFiles, searchLibrary } from './library'
import type { IndexState, LibraryEntry } from './library'
import { clip, firstLine, HARNESS_VERSION, validate } from './records'
import type { Actor } from './records'
import { isSecret, normalize } from './rules'
import { parseFeatures } from './spec'
import { fingerprintOf, git, heldMainRoot, loopOf, specDir, stateRootOf } from './state'
import type { Engine, Place } from './state'

type Answer = CommandRunResult

/** The person's choice of folder: one key for every repository (decision 1). */
const PATH_KEY = 'library:path'

/** What this repository saved, by change, so a defect recorded later finds its entry. */
const savedKey = (root: string): string => `library-saved:${root}`

/** One save this repository made: the entry, the library it went to, its change (null while open) and its content hash. */
type SavedRef = { id: string; dir: string; spec: string; hash: string; change: string | null }

/** The default library: `library/` in the plugin's data folder. */
export async function defaultLibrary($: Engine): Promise<string> {
  return `${await stateRootOf($)}/library`
}

/** The library in use: the folder a person set, or the default. */
export async function libraryOf($: Engine): Promise<{ dir: string; isDefault: boolean }> {
  const kept = await $.store.get(PATH_KEY).catch(() => undefined)
  if (typeof kept === 'string' && kept.startsWith('/')) {
    return { dir: kept, isDefault: false }
  }

  return { dir: await defaultLibrary($), isDefault: true }
}

/** Where a library's links lead, once looked up per folder. */
const realOf = new Map<string, string | null>()

/**
 * The library's spellings for the guards: the folder as set, and where its
 * links lead when that differs. Reads inside them are answered for every
 * agent; writes into them are refused.
 */
export async function librarySpellings($: Engine): Promise<string[]> {
  const { dir } = await libraryOf($)
  // Looked up until the folder is there, then kept.
  if (realOf.get(dir) === undefined || realOf.get(dir) === null) {
    const found = await $.fs.stat(dir, { resolve: true }).then(one => one.realPath ?? null, () => null)
    realOf.set(dir, found === null ? null : normalize(found))
  }
  const real = realOf.get(dir) ?? null

  return real === null || real === dir ? [dir] : [dir, real]
}

/** The index's text, or '' when there is none yet; rejects when it is there and cannot be read (never overwritten then). */
async function indexText($: Engine, dir: string): Promise<string> {
  const file = `${dir}/index.jsonl`
  if (!(await $.fs.exists(file).catch(() => false))) {
    return ''
  }
  const text = await $.fs.read(file)

  return typeof text === 'string' ? text : ''
}

/** The index as it stands; empty when it cannot be read. */
async function indexOf($: Engine, dir: string): Promise<IndexState> {
  return readIndex(await indexText($, dir).catch(() => ''))
}

/** Appends run one after another, so two lines never overwrite each other. */
let chain: Promise<unknown> = Promise.resolve()

/** Appends one line to the index: only the harness writes it, and a line is never edited. */
async function appendIndex($: Engine, dir: string, line: string): Promise<void> {
  const step = chain.then(async () => {
    const before = await indexText($, dir)
    await $.fs.write(`${dir}/index.jsonl`, `${before}${before === '' || before.endsWith('\n') ? '' : '\n'}${line}\n`)
  })
  chain = step.catch(() => undefined)
  await step
}

/** An entry as a record holds it: without the index's order. */
function bare(entry: LibraryEntry & { order?: number; score?: number }): LibraryEntry {
  const out: LibraryEntry & { order?: number; score?: number } = { ...entry }
  delete out.order
  delete out.score

  return out
}

/** The repository's name, as an entry names its project: the main checkout's folder. */
const projectOf = (at: Place): string => {
  const root = heldMainRoot(at.root).replace(/\/+$/, '')

  return root.slice(root.lastIndexOf('/') + 1) || 'root'
}

export type Saved = { kind: 'saved' | 'off' | 'none' | 'stopped' | 'failed'; text: string }

/**
 * Saves the approved spec into the library (decision 3): at /devloop done
 * (`closed` names the change record) or on a person's /devloop library save
 * (`closed` null: the outcome says open). Nothing is written when the policy
 * says `off`, with no approved spec, for a spec folder the policy's secrets
 * globs match, for files that changed since approval, or when the credential
 * scan finds anything in them (the file and line are named, never the
 * value). Resolves to a line for the person; it never stops the close.
 */
export async function saveSpec($: Engine, at: Place, cfg: Config, loop: Loop, closed: { id: string; at: number } | null, actor: Actor): Promise<Saved> {
  if (cfg.library.save === 'off') {
    return { kind: 'off', text: 'Not saved to the spec library: this repository\'s policy sets library.save to "off".' }
  }
  if (loop.spec === null || loop.phase !== 'build' || loop.approvedHash === null) {
    return { kind: 'none', text: 'No approved spec, so nothing was saved to the spec library.' }
  }
  const name = loop.spec
  const folder = `specs/${name}`
  if ([folder, `${folder}/SPEC.md`, `${folder}/features.json`].some(one => isSecret(one, cfg))) {
    return { kind: 'stopped', text: `Not saved to the spec library: ${folder} matches the policy's secrets globs, so it is never copied.` }
  }
  const { dir: lib } = await libraryOf($)
  const dir = specDir(at, loop)
  const specText = await $.fs.read(`${dir}/SPEC.md`).then(text => (typeof text === 'string' ? text : null), () => null)
  const featuresText = await $.fs.read(`${dir}/features.json`).then(text => (typeof text === 'string' ? text : null), () => null)
  if (specText === null || featuresText === null) {
    return { kind: 'failed', text: `Not saved to the spec library: ${folder}/${specText === null ? 'SPEC.md' : 'features.json'} could not be read.` }
  }
  if ((await fingerprintOf(specText, parseFeatures(featuresText))) !== loop.approvedHash) {
    return { kind: 'stopped', text: `Not saved to the spec library: ${folder} no longer holds the spec as approved.` }
  }
  const hits = scanSpecFiles(specText, featuresText)
  if (hits.length > 0) {
    const where = hits.map(one => `${one.kind} at ${folder}/${one.file}:${one.line}`)
    await audit($, at.root, 'library-save-stopped', actor, name, loop.tree, `credential scan: ${where.join('; ')}`)

    return {
      kind: 'stopped',
      text: `Not saved to the spec library: the credential scan found ${where.join('; ')}. Fix the spec first: take the value out, then save it again (${closed === null ? '/devloop library save' : `/devloop spec ${name}, /devloop approve, /devloop library save`}).${closed === null ? '' : ' The change closed all the same.'}`,
    }
  }
  const now = await $.clock.now()
  const refs = await listOf<SavedRef>($, savedKey(at.root))
  const hash = contentHash(specText, featuresText)
  // An earlier save of this spec as approved, still open, is superseded by this one: the same folder.
  const earlier = [...refs].reverse().find(one => one.dir === lib && one.spec === name && one.hash === hash && one.change === null)
  const entry = entryOf({
    project: projectOf(at), spec: name, specText, featuresText, approvedAt: loop.approval?.at ?? null, closedAt: closed?.at ?? null,
    isAllPassing: Object.values(loop.features).length > 0 && Object.values(loop.features).every(one => one.passes), reviewRounds: loop.review.round,
    savedAt: now, harness: HARNESS_VERSION, ...(earlier === undefined ? {} : { id: earlier.id }),
  })
  if (!(await checkRecord($, at.root, 'library-entry@1', entry))) {
    return { kind: 'failed', text: 'Not saved to the spec library: its entry did not fit the record (the harness recorded why).' }
  }
  const target = `${lib}/${entry.id}`
  try {
    await $.fs.write(`${target}/SPEC.md`, specText)
    await $.fs.write(`${target}/features.json`, featuresText)
    await $.fs.write(`${target}/entry.json`, `${JSON.stringify(entry, null, 2)}\n`)
    await appendIndex($, lib, indexLine(entry))
  } catch (error) {
    return { kind: 'failed', text: `Not saved to the spec library: ${target} could not be written (${firstLine(String((error as Error)?.message ?? error), 160)}).` }
  }
  await $.store.set(savedKey(at.root), [...refs.filter(one => !(one.dir === lib && one.id === entry.id)), { id: entry.id, dir: lib, spec: name, hash, change: closed?.id ?? null }].slice(-200))
  await audit($, at.root, 'library-saved', actor, entry.id, loop.tree, `${closed === null ? 'open' : `closed as ${closed.id}`}; ${clip(lib, 400)}`)

  return { kind: 'saved', text: `Saved to the spec library: ${target}${earlier === undefined ? '' : ' (superseding the earlier save)'}.` }
}

/**
 * A defect recorded later against a change (decision 2's outcome): its
 * entry's count rises, in entry.json and in a superseding index line. Best
 * effort, and nothing with the policy `off` or the entry removed.
 */
export async function noteLibraryDefect($: Engine, at: Place, cfg: Config, change: string | null): Promise<void> {
  if (change === null || cfg.library.save === 'off') {
    return
  }
  const ref = [...(await listOf<SavedRef>($, savedKey(at.root)))].reverse().find(one => one.change === change)
  if (ref === undefined) {
    return
  }
  const live = (await indexOf($, ref.dir)).entries.find(one => one.id === ref.id)
  if (live === undefined) {
    return
  }
  const file = `${ref.dir}/${ref.id}/entry.json`
  const kept = await $.fs.read(file).then(text => JSON.parse(String(text)) as LibraryEntry, () => null)
  const before = kept !== null && validate('library-entry@1', kept).length === 0 ? kept : bare(live)
  const entry: LibraryEntry = { ...before, outcome: { ...before.outcome, defects: before.outcome.defects + 1 } }
  if (kept !== null) {
    await $.fs.write(file, `${JSON.stringify(entry, null, 2)}\n`)
  }
  await appendIndex($, ref.dir, indexLine(entry))
}

/** The devloop_library tool (decision 4): the index searched, then each result's criteria from its entry.json. Reads only. */
export async function searchCommand($: Engine, query: string, limit: unknown): Promise<string> {
  const { dir } = await libraryOf($)
  const index = await indexOf($, dir)
  if (index.entries.length === 0) {
    return `The spec library (${dir}) holds no entries yet.`
  }
  const found = searchLibrary(index.entries, query, limit)
  if (found.length === 0) {
    return query.trim() === ''
      ? 'Give the words to search for: the area, the kind of work, the behaviour.'
      : `No entry in the spec library (${dir}, ${index.entries.length} entr${index.entries.length === 1 ? 'y' : 'ies'}) holds any of those words.`
  }
  const out: string[] = []
  for (const one of found) {
    const folder = `${dir}/${one.id}`
    const kept = await $.fs.read(`${folder}/entry.json`).then(text => JSON.parse(String(text)) as LibraryEntry, () => null)
    const criteria = kept !== null && validate('library-entry@1', kept).length === 0 ? kept.criteria ?? [] : null
    out.push(resultText(one, folder, criteria))
  }

  return [`${found.length} of ${index.entries.length} entr${index.entries.length === 1 ? 'y' : 'ies'} in the spec library (${dir}), the most matching words first. Name each spec you use, with its project, to the person.`, ...out].join('\n')
}

/** Doctor's lines (decision 1): the path, whether it exists and is writable, its entries, and the policy's `library.save`. */
export async function libraryDoctor($: Engine, cfg: Config): Promise<{ isGood: boolean; text: string }[]> {
  const { dir, isDefault } = await libraryOf($)
  const kind = await $.fs.stat(dir).then(one => one.kind, () => null)
  const isWritable = kind === 'dir' && (await $.fs.write(`${dir}/.devloop-write-check`, '').then(() => true, () => false))
  const entries = kind === 'dir' ? (await indexOf($, dir)).entries.length : 0
  const where = `spec library: ${dir} (${isDefault ? 'the default, in the plugin\'s data folder' : 'set by you'})`
  const state = kind === null
    ? 'not there yet; the first save creates it'
    : kind !== 'dir' ? 'not a folder' : `${isWritable ? 'writable' : 'not writable'}, ${entries} entr${entries === 1 ? 'y' : 'ies'}`

  return [
    { isGood: kind === null || isWritable, text: `${where}: ${state}` },
    { isGood: true, text: `library.save: ${cfg.library.save}${cfg.library.save === 'off' ? ' (nothing of this repository\'s specs is saved)' : ' (an approved spec is saved when its change closes)'}` },
  ]
}

const LIBRARY_REMOVE = `
# devloop:library-remove
rm -f -- "$1/SPEC.md" "$1/features.json" "$1/entry.json"
rmdir -- "$1" 2>/dev/null || echo kept
`

/**
 * `/devloop library [path <dir> | save | remove <entry>]` (decision 5), all
 * a person's, and audited where they change something: the listing; the
 * folder set (created if missing); the current spec saved now; an entry
 * removed after a dialog (its folder deleted, a line marking it removed).
 */
export async function libraryCommand($: Engine, at: Place, cfg: Config | null, words: readonly string[], e: CommandRunInput): Promise<Answer> {
  if (!isFromPerson(e)) {
    return { text: 'The spec library is a person\'s to manage, from the prompt (the agent searches it with the devloop_library tool).' }
  }
  const sub = words[0] ?? ''
  const { dir, isDefault } = await libraryOf($)
  if (sub === '') {
    const index = await indexOf($, dir)
    const last = [...index.entries].reverse().slice(0, 10)

    return {
      text: [
        `Spec library: ${dir}${isDefault ? ' (the default; /devloop library path <dir> points it elsewhere)' : ''}`,
        `${index.entries.length} entr${index.entries.length === 1 ? 'y' : 'ies'}${index.removed.length > 0 ? `, ${index.removed.length} removed` : ''}${last.length > 0 ? `; the last ${last.length}:` : '.'}`,
        ...last.map(listLine),
        '/devloop library save saves the current spec now; /devloop library remove <entry> deletes one (each a person\'s call).',
      ].join('\n'),
    }
  }
  if (sub === 'path') {
    return setPath($, at, words.slice(1).join(' ').trim(), e)
  }
  if (sub === 'save') {
    if (cfg === null) {
      return { text: 'This repository is not set up for the loop yet, so it has no approved spec to save. Run /devloop init.' }
    }
    const saved = await saveSpec($, at, cfg, await loopOf($), null, actorOf(e))

    return { text: saved.text }
  }
  if (sub === 'remove') {
    return removeEntry($, at, dir, words[1] ?? '', e)
  }

  return { text: 'Usage: /devloop library | library path <dir> | library save | library remove <entry>' }
}

/** Sets the library's folder, creating it: a folder outside this repository, and outside the harness's own state but for the default. */
async function setPath($: Engine, at: Place, raw: string, e: CommandRunInput): Promise<Answer> {
  if (raw === '') {
    return { text: 'Name the folder: /devloop library path <dir> (an absolute path, or one under ~).' }
  }
  const home = (await $.env.get('HOME').catch(() => undefined)) ?? null
  const spelled = raw === '~' || raw.startsWith('~/') ? (home === null ? null : `${home}${raw.slice(1)}`) : raw
  if (spelled === null || !spelled.startsWith('/')) {
    return { text: `${raw} is not an absolute path: name the folder from /, or from ~.` }
  }
  const dir = normalize(spelled).replace(/\/+$/, '') || '/'
  const inside = (path: string, folder: string): boolean => path === folder || path.startsWith(`${folder}/`)
  const roots = [...new Set([normalize(at.root), normalize(heldMainRoot(at.root))])]
  if (roots.some(root => inside(dir, root) || inside(root, dir))) {
    return { text: `${dir} is not outside this repository: the library lives outside every project.` }
  }
  const stateRoot = await stateRootOf($)
  const fallback = await defaultLibrary($)
  if (inside(dir, stateRoot) && !inside(dir, fallback)) {
    return { text: `${dir} is inside the harness's own state; the library may be ${fallback} (the default) or a folder outside ${stateRoot}.` }
  }
  try {
    if (!(await $.fs.exists(`${dir}/index.jsonl`))) {
      await $.fs.write(`${dir}/index.jsonl`, '')
    }
  } catch (error) {
    return { text: `${dir} could not be created or written (${firstLine(String((error as Error)?.message ?? error), 160)}); the library stays where it was.` }
  }
  if (dir === fallback) {
    await $.store.delete(PATH_KEY)
  } else {
    await $.store.set(PATH_KEY, dir)
  }
  realOf.delete(dir)
  await audit($, at.root, 'library-path-set', actorOf(e), clip(dir, 200), null, dir === fallback ? 'the default' : 'set by a person')
  const count = (await indexOf($, dir)).entries.length

  return { text: `The spec library is now ${dir} (${count} entr${count === 1 ? 'y' : 'ies'}). The harness writes entries there; keeping a shared folder in step (sync, commit, pull) is yours or your team's tool's job.` }
}

/** Removes one entry after a dialog: its folder deleted, a line in the index marking it removed. */
async function removeEntry($: Engine, at: Place, dir: string, id: string, e: CommandRunInput): Promise<Answer> {
  if (id === '') {
    return { text: 'Name the entry: /devloop library remove <entry> (/devloop library lists them).' }
  }
  const entry = (await indexOf($, dir)).entries.find(one => one.id === id)
  if (entry === undefined) {
    return { text: `No entry ${id} in the spec library (${dir}). /devloop library lists them.` }
  }
  if (!(await confirm($, `Remove ${id} (${entry.project}, "${entry.spec}") from the spec library? Its folder ${dir}/${id} is deleted.`, 'Remove it', 'Keep it'))) {
    return { text: `${id} is kept.` }
  }
  const ran = await git($, at, LIBRARY_REMOVE, [`${dir}/${id}`])
  const now = await $.clock.now()
  await appendIndex($, dir, indexLine({ ...bare(entry), removedAt: now }))
  await audit($, at.root, 'library-removed', actorOf(e), id, null, clip(dir, 400))
  const isKept = ran !== null && ran.out.trim() === 'kept'

  return { text: `${id} is removed from the spec library.${isKept ? ` Its folder held other files, which were left in ${dir}/${id}.` : ''}` }
}
