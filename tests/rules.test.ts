import { describe, expect, test } from 'claude-code/testing'

import { DEFAULTS, parseConfig } from '../hooks/config'
import { gate, isShippable } from '../hooks/gate'
import {
  isReviewerCommand, judgeCommand, judgeEdit, matches, normalize, relative, tierOf, whereOf,
} from '../hooks/rules'
import { parseFeatures } from '../hooks/spec'
import { FRESH } from '../hooks/state'
import type { Loop } from '../types'

const cfg = { ...DEFAULTS, verify: [{ run: 'npm test', profile: 'fast' as const, when: null }] }
const building: Loop = { ...FRESH, phase: 'build', spec: 'login', approvedHash: 'h' }
const inRepo = whereOf('/repo')

describe('paths', () => {
  test('a glob with no slash matches the file name at any depth', async () => {
    expect(matches('a/b/.env', '.env')).toBe(true)
    expect(matches('a/b/.env.local', '.env.*')).toBe(true)
    expect(matches('src/env.ts', '.env')).toBe(false)
  })

  test('** spans folders and * stays in one', async () => {
    expect(matches('src/auth/token.ts', '**/auth/**')).toBe(true)
    expect(matches('auth/token.ts', '**/auth/**')).toBe(true)
    expect(matches('src/login.test.ts', '**/*.test.*')).toBe(true)
    expect(matches('specs/login/features.json', 'specs/**/features.json')).toBe(true)
    expect(matches('src/a/b.ts', 'src/*.ts')).toBe(false)
  })

  test('a path that climbs out of the repository is outside it', async () => {
    expect(normalize('/repo/src/../../etc/passwd')).toBe('/etc/passwd')
    expect(relative('/repo', '/repo', 'src/../tests/a.test.ts')).toBe('tests/a.test.ts')
    expect(relative('/repo', '/repo', '../other/file')).toBe(null)
  })
})

describe('edits', () => {
  test('a secret is refused in every phase, its example file is not', async () => {
    expect(judgeEdit('.env', cfg, FRESH)?.rule).toBe('secret')
    expect(judgeEdit('config/.env.production', cfg, building)?.rule).toBe('secret')
    expect(judgeEdit('.env.example', cfg, FRESH)).toBe(null)
  })

  test('tests are open in small-fix mode and locked while building', async () => {
    expect(judgeEdit('src/login.test.ts', cfg, FRESH)).toBe(null)
    expect(judgeEdit('src/login.test.ts', cfg, building)?.rule).toBe('tests-locked')
    expect(judgeEdit('src/login.ts', cfg, building)).toBe(null)
  })

  test('the spec is open while it is written and locked once approved', async () => {
    const writing: Loop = { ...FRESH, phase: 'spec', spec: 'login' }
    expect(judgeEdit('specs/login/SPEC.md', cfg, writing)).toBe(null)
    expect(judgeEdit('specs/login/features.json', cfg, writing)).toBe(null)
    expect(judgeEdit('src/login.ts', cfg, writing)?.rule).toBe('spec-first')
    expect(judgeEdit('specs/login/features.json', cfg, building)?.rule).toBe('spec-locked')
  })

  test('the harness and its policy are never the builder\'s to edit', async () => {
    for (const path of ['devloop.json', 'REVIEW.md', '.claude/settings.json', 'evals/tasks/a.json', 'specs/other/features.json']) {
      expect(judgeEdit(path, cfg, building)?.rule).toBe('protected')
    }
  })

  test('a high-risk path needs an approved spec', async () => {
    expect(judgeEdit('src/auth/session.ts', cfg, FRESH)?.rule).toBe('high-needs-spec')
    expect(judgeEdit('src/auth/session.ts', cfg, building)).toBe(null)
  })

  test('a person\'s exemption lifts every rule but the one on secrets', async () => {
    const exempt: Loop = { ...building, allow: [{ kind: 'path', value: 'src/login.test.ts', turnId: null }, { kind: 'path', value: '.env', turnId: null }] }
    expect(judgeEdit('src/login.test.ts', cfg, exempt)).toBe(null)
    expect(judgeEdit('.env', cfg, exempt)?.rule).toBe('secret')
  })
})

describe('commands', () => {
  test('reading a secret is refused, running the tests is not', async () => {
    expect(judgeCommand('cat .env', cfg, FRESH, inRepo)?.rule).toBe('secret')
    expect(judgeCommand('grep KEY config/.env.local | head', cfg, FRESH, inRepo)?.rule).toBe('secret')
    expect(judgeCommand('npm test -- login', cfg, building, inRepo)).toBe(null)
    expect(judgeCommand('cat src/login.test.ts', cfg, building, inRepo)).toBe(null)
  })

  test('a command that writes to a locked file is refused', async () => {
    expect(judgeCommand('rm src/login.test.ts', cfg, building, inRepo)?.rule).toBe('tests-locked')
    expect(judgeCommand("sed -i 's/true/false/' specs/login/features.json", cfg, building, inRepo)?.rule).toBe('spec-locked')
    expect(judgeCommand('echo "{}" > devloop.json', cfg, building, inRepo)?.rule).toBe('protected')
    // B2: deleting a test file is test-weakening wherever tests are editable (it was allowed in small-fix mode before).
    expect(judgeCommand('rm src/login.test.ts', cfg, FRESH, inRepo)?.rule).toBe('test-weakened')
    expect(judgeCommand('rm src/login.ts', cfg, FRESH, inRepo)).toBe(null)
  })

  test('skipping hooks and forcing a push are refused', async () => {
    expect(judgeCommand('git commit -m x --no-verify', cfg, FRESH, inRepo)?.rule).toBe('no-verify')
    expect(judgeCommand('git push --force origin feature', cfg, FRESH, inRepo)?.rule).toBe('force-push')
    expect(judgeCommand('git push --force-with-lease origin feature', cfg, FRESH, inRepo)).toBe(null)
  })

  test('the reviewer runs plain reads and the exact checks, nothing else', async () => {
    const checks = ['npm test', 'npm test -- login']
    expect(isReviewerCommand('git diff main...HEAD | head -200', checks)).toBe(true)
    expect(isReviewerCommand('npm test -- login', checks)).toBe(true)
    expect(isReviewerCommand('npm test -- login && rm -rf src', checks)).toBe(false)
    expect(isReviewerCommand('cat src/a.ts > src/b.ts', checks)).toBe(false)
    expect(isReviewerCommand('git commit -am fix', checks)).toBe(false)
    expect(isReviewerCommand('find . -name "*.ts" -delete', checks)).toBe(false)
    // F8/F30: each of the reviewer's reproduced escapes.
    for (const escape of ['git status\ngit push', 'sort -o src/a.ts src/a.ts', 'uniq src/a.ts src/b.ts', 'git diff --output=src/a.ts', 'rg --pre ./x.sh pattern', 'find . -fprint src/a.ts', 'git status && git push']) {
      expect(isReviewerCommand(escape, checks)).toBe(false)
    }
  })
})

describe('tiers and the gate', () => {
  test('the riskiest file decides the tier', async () => {
    expect(tierOf([], cfg, false)).toBe('none')
    expect(tierOf(['README.md', 'docs/a.md'], cfg, false)).toBe('low')
    expect(tierOf(['README.md', 'src/a.ts'], cfg, false)).toBe('medium')
    expect(tierOf(['README.md'], cfg, true)).toBe('medium')
    expect(tierOf(['src/a.ts', 'src/payments/charge.ts'], cfg, false)).toBe('high')
    expect(tierOf(['devloop.json'], cfg, false)).toBe('high')
  })

  test('a medium change ships only verified and reviewed', async () => {
    const changed: Loop = { ...FRESH, tier: 'medium', changed: ['src/a.ts'], isDirty: true }
    expect(isShippable(changed, cfg)).toBe(false)
    const verified: Loop = { ...changed, isDirty: false, verify: { ...FRESH.verify, status: 'pass' } }
    // B2.1: outside git (no tree) the credential scan has no diff to read, so at medium it stays unmet.
    expect(gate(verified, cfg).filter(check => !check.isMet).map(check => check.label)).toEqual(['Independent review', 'No credentials in the diff'])
    const reviewed: Loop = { ...verified, review: { ...FRESH.review, status: 'pass', round: 1 } }
    expect(isShippable(reviewed, cfg)).toBe(false)
    const inGit: Loop = { ...reviewed, tree: 't1', verify: { ...reviewed.verify, tree: 't1', passedOn: { 'npm test': 't1' } }, review: { ...reviewed.review, tree: 't1' }, evidence: { ...FRESH.evidence, tree: 't1' } }
    expect(isShippable(inGit, cfg)).toBe(true)
  })

  test('a low change needs no review, and a stale pass is not a pass', async () => {
    const docs: Loop = { ...FRESH, tier: 'low', changed: ['README.md'], verify: { ...FRESH.verify, status: 'pass' } }
    expect(isShippable(docs, cfg)).toBe(true)
    expect(isShippable({ ...docs, isDirty: true }, cfg)).toBe(false)
  })

  test('a build is not shippable until every feature passes', async () => {
    const pass = { passes: true, tree: 't1' }
    const done: Loop = {
      ...building, tier: 'medium', changed: ['src/a.ts'], tree: 't1', features: { a: pass, b: pass, c: { passes: false, tree: 't1' } },
      // Decision 3: a pass of each check on this tree; B2: the credential scan covers it too.
      verify: { ...FRESH.verify, status: 'pass', tree: 't1', passedOn: { 'npm test': 't1' } }, review: { ...FRESH.review, status: 'pass', round: 1, tree: 't1' },
      evidence: { ...FRESH.evidence, tree: 't1' },
      // B2.1: approval's record of the tests (none here); without one the tests row is unmet.
      testHashes: {},
    }
    expect(isShippable(done, cfg)).toBe(false)
    expect(isShippable({ ...done, features: { a: pass, b: pass, c: pass } }, cfg)).toBe(true)
  })
})

describe('files the plugin reads', () => {
  test('a half-written config keeps every guard', async () => {
    const { cfg: parsed, errors } = parseConfig('{ "verify": ["make test"], "protected": "oops", "mode": "observe" }')
    expect(parsed.verify).toEqual([{ run: 'make test', profile: 'fast', when: null }])
    expect(parsed.protected).toEqual(DEFAULTS.protected)
    expect(parsed.mode).toBe('observe')
    expect(errors).toEqual(['protected: expected a list of strings; using the default'])
    // A file that does not parse still opts in, with every default.
    const broken = parseConfig('not json')
    expect(broken.cfg).toEqual(DEFAULTS)
    expect(broken.errors[0]).toMatch(/not valid JSON/)
  })

  test('decision 1: features.json\'s passes is ignored on read; there is no mirror to write', async () => {
    const text = JSON.stringify([{ id: 'a', check: 'x', passes: true, owner: 'sam' }, { id: 'b', check: 'y', passes: false }])
    expect(parseFeatures(text)).toEqual([
      { id: 'a', description: '', check: 'x', dependsOn: [], criteria: [], checklist: [] },
      { id: 'b', description: '', check: 'y', dependsOn: [], criteria: [], checklist: [] },
    ])
  })
})
