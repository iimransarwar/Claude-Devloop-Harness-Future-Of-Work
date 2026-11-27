// The few Node APIs the command line uses, declared here so `tsc -p .`
// type-checks cli/ without giving the hooks module Node's globals (the
// module runs with no Node: DESIGN 7). Only what cli/ calls is declared.

declare module 'node:fs' {
  export type Stats = { isDirectory(): boolean; isFile(): boolean; isSymbolicLink(): boolean; mtimeMs: number; size: number }
  export type Dirent = { name: string; isDirectory(): boolean; isFile(): boolean; isSymbolicLink(): boolean }
  export function readFileSync(path: string | number, encoding: 'utf8'): string
  export function writeFileSync(path: string, data: string, options?: { mode?: number; flag?: string }): void
  export function appendFileSync(path: string, data: string): void
  export function existsSync(path: string): boolean
  export function mkdirSync(path: string, options?: { recursive?: boolean }): string | undefined
  export function readdirSync(path: string): string[]
  export function readdirSync(path: string, options: { withFileTypes: true }): Dirent[]
  export function statSync(path: string): Stats
  export function lstatSync(path: string): Stats
  export function realpathSync(path: string): string
  export function unlinkSync(path: string): void
  export function renameSync(from: string, to: string): void
  export function symlinkSync(target: string, path: string): void
}

declare module 'node:child_process' {
  export type SpawnSyncReturns = { status: number | null; signal: string | null; stdout: string; stderr: string; error?: Error }
  export function spawnSync(command: string, args: readonly string[], options: {
    cwd?: string
    input?: string
    encoding: 'utf8'
    timeout?: number
    env?: Record<string, string | undefined>
    maxBuffer?: number
    stdio?: unknown
  }): SpawnSyncReturns
}

declare module 'node:process' {
  const process: {
    argv: string[]
    env: Record<string, string | undefined>
    exitCode: number | undefined
    cwd(): string
    exit(code?: number): never
    stdin: { setEncoding(encoding: 'utf8'): void; on(event: 'data' | 'end' | 'error', listener: (value: string) => void): void; destroy(): void }
    stdout: { write(text: string): boolean }
    stderr: { write(text: string): boolean }
    hrtime: { bigint(): bigint }
  }
  export default process
}

declare module 'node:timers' {
  export function setTimeout(callback: () => void, ms: number): unknown
  export function clearTimeout(timer: unknown): void
}
