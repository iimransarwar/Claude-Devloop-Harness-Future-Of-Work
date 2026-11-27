import { describe, expect, test } from 'claude-code/testing'

import { PARITY_FILES, PARITY_LINKS, PARITY_OUTSIDE_LINKS, PARITY_POLICY, PARITY_UNTRACKED, ROWS, callOf } from './parity-table'
import type { Row } from './parity-table'
import { approved, devloop, ledgerOf, start, world } from './world'
import type { Dollar, World } from './world'

// Parity through the real module (final round, D1 F8): every row of the
// parity table (tests/parity-table.ts, which tests/parity.ts runs through the
// command line and the classic hook) is driven through the hooks module's own
// `tool.call` hook in the test world, and the rule it gives must be the one
// the table expects. The rule is read from the ledger's `guard-deny` entry the
// module writes for a refusal it holds (a content rule's entry names its id);
// in a dormant repository nothing is recorded, so a refusal there is read from
// its words, which can only be the secrets rule's.

const ROOT = '/repo'
const STATE = '/data/devloop'
const PROBE_ON = 'tree:yes\nversion: 2\ncommand:yes'

/** The world as the table describes the repository: its files, links, tracked files, the .tasks integration on (or, dormant, no policy at all). */
function setUp(on: Parameters<typeof world>[0], row: Row): World {
  const w = world(on, row.dormant === true ? null : PARITY_POLICY)
  for (const [rel, text] of Object.entries({ ...PARITY_FILES, ...PARITY_UNTRACKED })) {
    w.files[`${ROOT}/${rel}`] = text
  }
  for (const [rel, to] of Object.entries(PARITY_LINKS)) {
    w.links[`${ROOT}/${rel}`] = `${ROOT}/${to}`
  }
  for (const [path, to] of Object.entries(row.dormant === true ? {} : PARITY_OUTSIDE_LINKS)) {
    w.links[path.replace('$ROOT', ROOT)] = `${ROOT}/${to}`
  }
  w.tracked = Object.keys(PARITY_FILES)
  // The wildcard expander lists folders as a disk would (the cache-guard round, P-C).
  w.isDiskListed = true
  w.testHashes = { 'tests/a.test.ts': 'h-a' }
  w.outputs['#tasks-probe'] = PROBE_ON
  w.outputs['#remote-url'] = 'git@github.com:acme/app.git'
  // A change in progress that no review has seen: the gate is not green, so a task is not finished (the stateless points cannot prove a gate at all).
  w.changed = ['src/a.ts']
  w.tree = 't1-src'

  return w
}

/** The phase a row is judged in, reached the way a person reaches it. */
async function enter($: Dollar, w: World, row: Row): Promise<void> {
  await start($)
  if (row.phase === 'spec') {
    expect(await devloop($, 'spec login')).toMatch(/login/)
  } else if (row.phase === 'build') {
    await approved($, w)
  }
}

/** The rule the module gave the call: what it recorded for a held refusal, or none. */
async function viaModule($: Dollar, w: World, row: Row): Promise<string | null> {
  const before = ledgerOf(w).length
  const call = callOf(row, ROOT, STATE, '/home/u')
  const ran = await $.tool.call({ tool: call.tool, ...call.input } as never)
  if (ran.deny === undefined) {
    return null
  }
  if (row.dormant === true) {
    return /holds secrets|secret files|hold secrets/.test(ran.deny) ? 'secret' : `unrecorded: ${ran.deny}`
  }
  const denied = ledgerOf(w).slice(before).filter(one => one.kind === 'guard-deny').pop()

  return denied === undefined ? `unrecorded: ${ran.deny}` : denied.key === 'no-console' ? 'content-rule' : denied.key
}

describe('parity through the module\'s own tool.call hook (final round, D1 F8)', () => {
  ROWS.forEach((row, n) => {
    const shown = row.kind === 'grep' || row.kind === 'glob' ? `${row.kind} ${row.text}${row.path === undefined ? '' : ` in ${row.path}`}` : `${row.kind} ${row.text}`
    test(`row ${n + 1}: ${shown} (${row.phase}${row.dormant === true ? ', dormant' : ''}) gets ${row.expect ?? 'no refusal'}`, async ($, on) => {
      const w = setUp(on, row)
      await enter($, w, row)
      expect(await viaModule($, w, row)).toBe(row.expect)
    })
  })

  test('the table covers the search tools, a link, an anchored secret by absolute path and a repository that has not opted in', () => {
    expect(ROWS.some(one => one.kind === 'grep')).toBe(true)
    expect(ROWS.some(one => one.kind === 'glob')).toBe(true)
    expect(ROWS.some(one => one.text.includes('src/creds') || (one.kind === 'grep' && one.path?.includes('src/creds') === true))).toBe(true)
    expect(ROWS.some(one => one.text === '$ROOT/config/secrets/token.txt')).toBe(true)
    expect(ROWS.filter(one => one.dormant === true).length).toBeGreaterThan(4)
  })
})
