// Sandbox settings from the same policy (DESIGN 4.11, 11 "Portability"): the
// block of Claude Code settings whose sandbox matches devloop.json, and a
// comparison of what the settings files configure with what the policy
// implies. The tripwire is the policy; the sandbox is the boundary
// (principle 4), and the two should say the same thing. Setting names as the
// sandboxing documentation gives them: `sandbox.enabled`,
// `sandbox.network.allowedDomains`, `sandbox.filesystem.denyRead|denyWrite|
// allowWrite`, and the flags that weaken it. Writes nothing. Pure: no `$`.

import { BUILTIN_PROTECTED } from './config'
import type { Config } from './config'
import type { LintItem } from './lint'

/** The settings block a policy implies. */
export type SandboxBlock = {
  sandbox: {
    enabled: true
    allowUnsandboxedCommands: false
    network?: { allowedDomains: string[] }
    filesystem: { denyRead: string[]; denyWrite: string[] }
  }
}

/**
 * The sandbox settings that match a policy: the egress tripwire's hosts as
 * the allowed domains (no `network` key when `network.allow` is not set: the
 * policy names no hosts), the secrets as denied reads, the protected paths
 * (the policy's and the built-in ones) and the harness's own state as denied
 * writes, and no way to retry outside the sandbox. Globs are given as the
 * policy writes them.
 */
export function sandboxSettings(cfg: Config, stateRoot: string): SandboxBlock {
  const unique = (items: readonly string[]): string[] => [...new Set(items.filter(one => one.trim() !== ''))]

  return {
    sandbox: {
      enabled: true,
      allowUnsandboxedCommands: false,
      ...(cfg.network === null ? {} : { network: { allowedDomains: unique(cfg.network.allow) } }),
      filesystem: {
        denyRead: unique(cfg.secrets),
        denyWrite: unique([...cfg.protected, ...BUILTIN_PROTECTED, stateRoot]),
      },
    },
  }
}

/** The sandbox part of one settings file, as far as it is an object. */
type Raw = Record<string, unknown>
const isObject = (value: unknown): value is Raw => typeof value === 'object' && value !== null && !Array.isArray(value)
const strings = (value: unknown): string[] => (Array.isArray(value) ? value.filter((one): one is string => typeof one === 'string') : [])

/** What the settings files configure, merged as Claude Code merges arrays (each file's entries added) and later scalars win. */
export function sandboxOf(files: readonly { name: string; text: string | null }[]): { found: Raw; errors: string[] } {
  const merged: Raw = {}
  const errors: string[] = []
  const network: Raw = {}
  const filesystem: Raw = {}
  for (const file of files) {
    if (file.text === null) {
      continue
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(file.text)
    } catch {
      errors.push(`${file.name} is not JSON`)
      continue
    }
    const box = isObject(parsed) && isObject(parsed.sandbox) ? parsed.sandbox : null
    if (box === null) {
      continue
    }
    for (const [key, value] of Object.entries(box)) {
      if (key === 'network' && isObject(value)) {
        for (const [k, v] of Object.entries(value)) {
          network[k] = Array.isArray(v) ? [...strings(network[k]), ...strings(v)] : v
        }
      } else if (key === 'filesystem' && isObject(value)) {
        for (const [k, v] of Object.entries(value)) {
          filesystem[k] = Array.isArray(v) ? [...strings(filesystem[k]), ...strings(v)] : v
        }
      } else {
        merged[key] = Array.isArray(value) ? [...strings(merged[key]), ...strings(value)] : value
      }
    }
  }

  return { found: { ...merged, network, filesystem }, errors }
}

/** Allowed domains wide enough to defeat an allow-list: everything, a whole top-level domain, or hosting anyone can publish under. */
const SHARED_HOSTING = ['amazonaws.com', 'cloudfront.net', 'githubusercontent.com', 'herokuapp.com', 'vercel.app', 'netlify.app', 'pages.dev', 'workers.dev', 'azurewebsites.net', 'appspot.com', 'blob.core.windows.net', 'storage.googleapis.com', 'ngrok.io', 'ngrok-free.app']

export function isBroadDomain(domain: string): boolean {
  const bare = domain.trim().toLowerCase()
  if (bare === '*' || bare === '*.*' || bare === '') {
    return true
  }
  if (bare.startsWith('*.')) {
    const rest = bare.slice(2)

    return !rest.includes('.') || SHARED_HOSTING.some(one => rest === one || rest.endsWith(`.${one}`))
  }

  return false
}

const RC_FILES = ['.bashrc', '.bash_profile', '.bash_login', '.profile', '.zshrc', '.zshenv', '.zprofile', '.zlogin', '.envrc', '.gitconfig']

/** Whether a writable path reaches a shell start-up file, or a folder on `$PATH` (a program planted there runs as any command). */
function writableRisk(path: string, home: string | null, pathDirs: readonly string[]): string | null {
  const expanded = home !== null && (path === '~' || path.startsWith('~/')) ? `${home}${path.slice(1)}` : path
  const clean = expanded.replace(/\/+$/, '') || '/'
  if (clean === '~' || clean === home || clean === '/') {
    return `${path} (a whole home or root folder: its shell start-up files and any bin folder)`
  }
  const name = clean.slice(clean.lastIndexOf('/') + 1)
  if (RC_FILES.includes(name)) {
    return `${path} (a shell start-up file)`
  }
  const dir = pathDirs.find(one => one !== '' && (clean === one.replace(/\/+$/, '') || one.startsWith(`${clean}/`)))
  if (dir !== undefined) {
    return `${path} (${dir} is on $PATH)`
  }

  return null
}

/**
 * Doctor's sandbox lines: what the settings configure against what the
 * policy implies (missing hosts, reads and writes, and hosts the policy does
 * not list), and the warnings that hold whatever the policy: broad domains,
 * a container socket, write access to shell start-up files or `$PATH`
 * folders, and every flag that weakens the sandbox. Warnings, never errors:
 * the sandbox is the person's to configure.
 */
export function compareSandbox(found: Raw, cfg: Config, stateRoot: string, env: { home: string | null; pathDirs: readonly string[] }): LintItem[] {
  const out: LintItem[] = []
  const want = sandboxSettings(cfg, stateRoot).sandbox
  if (found.enabled !== true) {
    out.push({ level: 'warn', text: 'sandbox: not enabled in .claude/settings.json or .claude/settings.local.json ("sandbox": { "enabled": true }); this plugin is a tripwire, the sandbox is the boundary. /devloop sandbox prints the block that matches the policy' })
  } else {
    out.push({ level: 'ok', text: 'sandbox: enabled in the project settings' })
  }
  const network = isObject(found.network) ? found.network : {}
  const filesystem = isObject(found.filesystem) ? found.filesystem : {}
  const domains = strings(network.allowedDomains)
  if (want.network !== undefined) {
    const missing = want.network.allowedDomains.filter(one => !domains.includes(one))
    const extra = domains.filter(one => !want.network?.allowedDomains.includes(one))
    if (missing.length > 0) {
      out.push({ level: 'warn', text: `sandbox: network.allow names hosts the sandbox does not allow: ${missing.join(', ')}` })
    }
    if (extra.length > 0) {
      out.push({ level: 'warn', text: `sandbox: allows hosts devloop.json's network.allow does not name: ${extra.join(', ')} (commands that reach them are refused by the tripwire; the sandbox lets other programs reach them)` })
    }
  } else if (found.enabled === true && domains.length > 0) {
    out.push({ level: 'ok', text: `sandbox: allows ${domains.length} host${domains.length === 1 ? '' : 's'}; devloop.json sets no network.allow, so the egress tripwire is off` })
  }
  const denyRead = strings(filesystem.denyRead)
  const unread = want.filesystem.denyRead.filter(one => !denyRead.includes(one))
  if (found.enabled === true && unread.length > 0) {
    out.push({ level: 'warn', text: `sandbox: the policy's secrets are not denied reads: ${unread.slice(0, 8).join(', ')}${unread.length > 8 ? ', …' : ''}` })
  }
  const denyWrite = strings(filesystem.denyWrite)
  const unwritten = want.filesystem.denyWrite.filter(one => !denyWrite.includes(one))
  if (found.enabled === true && unwritten.length > 0) {
    out.push({ level: 'warn', text: `sandbox: protected paths are not denied writes: ${unwritten.slice(0, 8).join(', ')}${unwritten.length > 8 ? ', …' : ''}` })
  }
  for (const domain of domains.filter(isBroadDomain)) {
    out.push({ level: 'warn', text: `sandbox: the allowed domain ${domain} is broad enough to defeat the allow-list (anyone can publish under it)` })
  }
  const sockets = strings(network.allowUnixSockets)
  if (network.allowAllUnixSockets === true) {
    out.push({ level: 'warn', text: 'sandbox: network.allowAllUnixSockets is on: a container socket among them hands out the machine' })
  }
  for (const one of sockets.filter(each => /docker\.sock|podman\.sock|containerd\.sock|\/run\/docker/.test(each))) {
    out.push({ level: 'warn', text: `sandbox: a container socket is reachable (${one}): whoever reaches it can start a container that mounts the host` })
  }
  for (const one of strings(filesystem.allowWrite)) {
    const risk = writableRisk(one, env.home, env.pathDirs)
    if (risk !== null) {
      out.push({ level: 'warn', text: `sandbox: writes are allowed to ${risk}` })
    }
  }
  const weakened: [boolean, string][] = [
    [found.allowUnsandboxedCommands !== false && found.enabled === true, 'allowUnsandboxedCommands is not false: a command that fails in the sandbox may be retried outside it'],
    [strings(found.excludedCommands).length > 0, `excludedCommands run outside the sandbox: ${strings(found.excludedCommands).slice(0, 5).join(', ')}`],
    [found.enableWeakerNestedSandbox === true, 'enableWeakerNestedSandbox is on (it exposes process information)'],
    [found.enableWeakerNetworkIsolation === true, 'enableWeakerNetworkIsolation is on'],
    [found.allowNestedUserNamespaces === true, 'allowNestedUserNamespaces is on (it turns off a security boundary)'],
    [network.allowLocalBinding === true, 'network.allowLocalBinding is on'],
    [filesystem.disabled === true, 'filesystem.disabled is on: only the network is isolated'],
  ]
  for (const [isSet, text] of weakened) {
    if (isSet) {
      out.push({ level: 'warn', text: `sandbox: ${text}` })
    }
  }

  return out
}
