/**
 * The settings popup's handlers: opening it, a pick, Save, Cancel, and the
 * buttons that change tests and cache-guard. The popup itself is drawn by the
 * `ui.render` hook in register.tsx.
 */
import type { SettingsDraft } from '../types'
import type { CommandRunInput, CommandRunResult } from 'claude-code'
import { reasonOf } from './actions'
import { DEFAULTS } from './config'
import { audit, isFromPerson } from './journal'
import type { Actor } from './records'
import { applyChanges, changedKeys, effectLine, readSettings } from './settings'
import type { RowKey, SettingsView } from './settings'
import { detectVerify, foundLabel, setup } from './setup'
import { forget, heldPolicy, locate, look, policyInForce, settingsDraftOf, updateSettingsDraft } from './state'
import type { Engine } from './state'
import { cacheCommand, cacheGuardState } from './cachecmd'

/** The settings popup: a person's, opened by /devloop settings. */
export const SETTINGS_PANE = 'devloop-settings'

export const SETTINGS_OPEN = 'Settings are open.'
const SETTINGS_REFUSED = "Settings are a person's: type /devloop settings."
export const SETTINGS_FOOTER = 'Tiers, protected paths, reviewers and the rest: edit devloop.json.'
/** The width of the label column: the longest label and a space. */
export const SETTINGS_LABEL = 23
/** Who a Save is from in the audit trail: a press on the popup, which only a person's surface raises. */
const SETTINGS_ACTOR: Actor = { kind: 'person', name: 'settings' }

/**
 * Whether the session's Python was missing when the popup last opened: a
 * render runs nothing, so cache-guard's row learns it from the opening.
 */
let isPythonMissing = false

/** Whether the session's Python was missing when the popup last opened. */
export const pythonMissing = (): boolean => isPythonMissing

export const isSettings = (args: string): boolean => args.trim().split(/\s+/)[0] === 'settings'

/** Each row's value as the popup shows it before any pick. */
export const openedWithOf = (view: SettingsView): Record<RowKey, string> => Object.fromEntries(view.rows.map(row => [row.key, row.current])) as Record<RowKey, string>

/** Why the popup cannot show devloop.json, as a person reads it. */
export const unreadableOf = (error: string): string => `${error.replace(/; every field takes its default$/, '')}. Fix it by hand, then open settings again.`

/** Why the popup has no devloop.json to show: only the base branch has one, or none is here. */
export function absentOf(policy: { cfg: { defaultBranch: string }; source: string } | null): string {
  if (policy?.source === 'base') {
    const base = policy.cfg.defaultBranch

    return `devloop.json is only on ${base}. Restore it to this working tree (git checkout ${base} -- devloop.json), then open settings again.`
  }

  return 'devloop.json is not in this working tree. Fix it by hand, then open settings again.'
}

/**
 * /devloop settings and /devloop-settings, a person's: where a policy
 * governs, opens the popup with a fresh draft (so a draft an Esc left is never
 * shown again); where none does, runs setup, as a person's bare /devloop does.
 */
export async function settingsCommand($: Engine, e: CommandRunInput): Promise<CommandRunResult> {
  if (!isFromPerson(e)) {
    return { text: SETTINGS_REFUSED }
  }
  // Read afresh: a Save or a hand edit a moment ago shows at once.
  forget()
  const at = await locate($)
  // Asked here, as locate asks only where the working tree has no copy: the popup's line says whether the base branch's copy governs.
  if ((await policyInForce($, at)) === null) {
    return setup($, e)
  }
  const view = at.text === null ? null : readSettings(at.text)
  await updateSettingsDraft($, () => (view === null || 'error' in view ? null : { changes: {}, openedWith: openedWithOf(view) }))
  isPythonMissing = (await cacheGuardState($).catch(() => 'available' as const)) === 'no-python'
  void Promise.resolve()
    .then(() => $.ui.open({ id: SETTINGS_PANE, title: 'devloop settings', focus: true, closeOnEscape: true, backgroundColor: 'transparent' }))
    .catch(() => undefined)

  return { text: SETTINGS_OPEN }
}

/**
 * A pick goes into the draft; picking the value devloop.json holds now takes
 * the change back out. Compared with the file as it is now, not as the popup
 * opened: a hand edit made while it was open never drops a pick.
 */
export async function pickSetting($: Engine, key: Exclude<RowKey, 'tests'>, value: string, opened: Record<RowKey, string>): Promise<void> {
  // Read the file afresh, but leave the policy in force held: it says whether the base branch's copy governs.
  const at = await look($).catch(() => null)
  const text = at === null ? null : await $.fs.read(`${at.root}/devloop.json`).catch(() => null)
  const view = text === null ? null : readSettings(text)
  const held = view !== null && 'rows' in view ? view.rows.find(row => row.key === key)?.current : undefined
  await updateSettingsDraft($, (draft): SettingsDraft => {
    const openedWith = draft?.openedWith ?? opened
    const changes = { ...draft?.changes }
    if (value === (held ?? openedWith[key])) {
      delete changes[key]
    } else {
      changes[key] = value
    }

    return { changes, openedWith }
  })
}

/**
 * Cancel, and the end of a Save: the draft goes, then the popup. Dropped here,
 * as devloop's own close does not reach its own `ui.close` hook; Esc does.
 */
export async function closeSettings($: Engine): Promise<void> {
  await updateSettingsDraft($, () => null)
  await $.ui.close({ id: SETTINGS_PANE })
}

/**
 * Save: sets only the keys the person changed in devloop.json as it is now
 * (merging nested objects, keeping every other field), writes the audit
 * entry, closes the popup and says when the change applies. A file that does
 * not read, or a write that fails, leaves the popup and its draft open.
 */
export async function saveSettings($: Engine): Promise<void> {
  const changes = (await settingsDraftOf($))?.changes ?? {}
  forget()
  const at = await locate($)
  // Checked again now, so the line below says what holds: the base branch's copy, when it has one, governs until this is committed.
  // undefined: the check failed, so which copy governs is not known.
  const found = await policyInForce($, at).catch(() => undefined)
  const policy = found === undefined ? undefined : found ?? heldPolicy(at)
  const view = at.text === null ? null : readSettings(at.text)
  if (at.text === null || view === null || 'error' in view) {
    $.ui.toast(`devloop: nothing was saved. ${view !== null && 'error' in view ? unreadableOf(view.error) : absentOf(policy ?? null)}`, { timeoutMs: 12_000 })

    return
  }
  const keys = changedKeys(changes)
  const next = applyChanges(at.text, changes)
  let said: string | null = null
  if (keys.length > 0 && next !== at.text) {
    try {
      await $.fs.write(`${at.root}/devloop.json`, next)
    } catch (error) {
      $.ui.toast(`devloop: devloop.json could not be written (${reasonOf(error)}). Nothing was saved.`, { timeoutMs: 12_000 })

      return
    }
    // The next read sees the file just written, and the panes the policy in force found again.
    forget()
    const held = await locate($).then(fresh => policyInForce($, fresh)).catch(() => undefined)
    await audit($, at.root, 'settings-changed', SETTINGS_ACTOR, keys.join(', '), null)
    // Judged by the policy found before the write, else after it; neither known says so rather than "now".
    const known = policy === undefined ? held : policy
    said = effectLine(known?.cfg.defaultBranch ?? DEFAULTS.defaultBranch, known === undefined ? null : known?.source === 'base', true)
  }
  await closeSettings($)
  if (said !== null) {
    $.ui.toast(said, { timeoutMs: 12_000 })
  }
}


const KEEP_CHECKS = 'Keep the current checks'
const NO_CHECKS = 'None for now'
/** A press on the popup is a person's: the surface raises it only for one. */
const PRESS: CommandRunInput = { command: 'devloop', args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 80 } }

/** Redraws the popup: the render reads the draft, so a rewrite of it (same content) draws it again. */
async function redraw($: Engine): Promise<void> {
  await updateSettingsDraft($, draft => (draft === null ? null : { ...draft }))
}

/**
 * The Tests row's Change: asks what should run, and puts the answer in the
 * draft as `verify`. Never saves by itself; Keep, or a dismissed question,
 * changes nothing.
 */
export async function changeTests($: Engine): Promise<void> {
  const at = await look($).catch(() => null)
  const view = at?.text == null ? null : readSettings(at.text)
  if (at === null || view === null || 'error' in view) {
    return
  }
  const found = await detectVerify($, at.root).catch(() => [])
  const offered = found.length > 0 && JSON.stringify(found) !== JSON.stringify(view.verify) ? foundLabel(found) : null
  const hasScoped = view.verify.some(one => typeof one === 'object' && one !== null)
  const warning = hasScoped ? ` This replaces your ${view.verify.length} checks, including ones that run before shipping or only for some files.` : ''
  const question = `What runs your tests? A command typed under Other replaces the current checks with that one.${warning}`
  const options = [KEEP_CHECKS, ...(offered === null ? [] : [offered]), NO_CHECKS]
  const answer = (await $.ui.ask(question, { options, header: 'Tests' }).catch(() => null))?.trim() ?? ''
  const verify: readonly unknown[] | null =
    answer === '' || answer === KEEP_CHECKS ? null : answer === NO_CHECKS ? [] : offered !== null && answer === offered ? found : [answer]
  if (verify === null) {
    return
  }
  await updateSettingsDraft($, (draft): SettingsDraft => {
    const openedWith = draft?.openedWith ?? openedWithOf(view)

    return { changes: { ...draft?.changes, verify }, openedWith }
  })
}

/** cache-guard's Install and Remove: its own command with its own confirmation, applied at once and apart from Save. */
async function runGuard($: Engine, sub: 'install --all' | 'uninstall'): Promise<void> {
  const at = await locate($)
  const done = await cacheCommand($, at, sub.split(' '), PRESS).catch(error => ({ text: `cache-guard could not be changed (${reasonOf(error)}).` }))
  $.ui.toast(`devloop: ${(done.text ?? '').split('\n')[0]?.slice(0, 200) ?? ''}`, { timeoutMs: 12_000 })
  await redraw($)
}

export function installGuard($: Engine): Promise<void> {
  return runGuard($, 'install --all')
}

export function removeGuard($: Engine): Promise<void> {
  return runGuard($, 'uninstall')
}
