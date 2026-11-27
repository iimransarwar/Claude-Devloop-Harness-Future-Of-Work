import { describe, expect, test } from 'claude-code/testing'

import { DEFAULTS, parseConfig } from '../hooks/config'
import type { Config } from '../hooks/config'
import { approvers, blastReasons, gate, isShippable, specialistsFor, tierFor } from '../hooks/gate'
import { classify } from '../hooks/output'
import { isReviewerCommand, liftClause, liftOf, RULES } from '../hooks/rules'
import { addedLines, credentialKinds, entropy, scanCredentials } from '../hooks/scan'
import { FRESH } from '../hooks/state'
import type { Loop } from '../types'

// Token shapes are put together here, so this file holds none whole.
const AWS = `AKIA${'Q3EGRVLN5WZKT7PB'}`
const GH = `ghp_${'a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8'}`
const SLACK = `xoxb-${'2741-9035-Qm7Lp2Zr8Tk'}`
const PEM = `-----BEGIN ${'RSA PRIVATE'} KEY-----`

describe('the credential scan of added lines', () => {
  test('well-known shapes fire', async () => {
    expect(credentialKinds(`const id = "${AWS}"`)).toEqual(['AWS access key id'])
    expect(credentialKinds(`token: ${GH}`)).toContain('GitHub token')
    expect(credentialKinds(`SLACK=${SLACK}`)).toEqual(['Slack token'])
    expect(credentialKinds(PEM)).toEqual(['private key'])
    expect(credentialKinds('const apiKey = "Zx8qL2vR9tW4mN7pK3sJ6hB1"')).toEqual(['API key or secret assignment'])
    expect(credentialKinds('"client_secret": "q9W8e7R6t5Y4u3I2o1P0aSdF"')).toEqual(['API key or secret assignment'])
  })

  test('placeholders, documentation examples and low-entropy values do not', async () => {
    for (const line of [
      'const id = "AKIAIOSFODNN7EXAMPLE"',
      'api_key = "xxxxxxxxxxxxxxxxxxxxxxxx"',
      'apiKey: "your-api-key-goes-here-12345"',
      'password = "<insert password here please>"',
      'secret = "${SECRET_FROM_THE_ENVIRONMENT}"',
      'token = "aaaaaaaaaaaaaaaaaaaaaaaaaaaa"',
      'const apiKey = process.env.API_KEY',
      'password = "changeme-changeme-changeme"',
      'This README says the api key is a long string.',
    ]) {
      expect(credentialKinds(line)).toEqual([])
    }
    expect(entropy('aaaa')).toBe(0)
    expect(entropy('Zx8qL2vR9tW4mN7pK3sJ6hB1')).toBeGreaterThan(3.5)
  })

  // B2.1 F10: environment, YAML and ini assignments; the key must end in a credential word; the value must look like one.
  test('unquoted assignments are caught: environment, YAML, ini', async () => {
    for (const line of [
      'API_KEY=Zx8qL2vR9tW4mN7pK3sJ6hB1',
      'export DB_PASSWORD=q9W8e7R6t5Y4u3I2o1P0aSdF',
      'api_key: Zx8qL2vR9tW4mN7pK3sJ6hB1',
      '  client_secret: q9W8e7R6t5Y4u3I2o1P0aSdF  # rotated monthly',
      'secret = q9W8e7R6t5Y4u3I2o1P0aSdF',
      'SECRET_KEY = "q9W8e7R6t5Y4u3I2o1P0aSdF"',
    ]) {
      expect({ line, kinds: credentialKinds(line) }).toEqual({ line, kinds: ['API key or secret assignment'] })
    }
    expect(credentialKinds(`  ${PEM}  `)).toEqual(['private key'])
  })

  test('ordinary lines are not credentials', async () => {
    for (const line of [
      'tokenizer = AutoTokenizer.from_pretrained("bert-base-uncased-whole-word")',
      'token_url = "https://auth.internal.dev/oauth2/v1/token"',
      'password_regex = "^(?=.*[A-Z])(?=.*[0-9])(?=.*[!@#]).{12,64}$"',
      'secretName: payments-service-db-credentials-v2',
      'API_TOKEN=${{ secrets.API_TOKEN_FOR_DEPLOYS }}',
      'export GITHUB_TOKEN=GITHUB_TOKEN_FROM_THE_RUNNER',
      'password: /run/secrets/database-password-file',
      'token = self.session.headers.authorization_value',
      'const tokenCount = encodeTokensForModelInput(text)',
      'SECRET_KEY_BASE_PATH=/etc/app/keys/secret_key_base',
      'password_hint = "q9W8e7R6t5Y4u3I2o1P0aSdF"',
      `const header = "${PEM}"`,
      `expect(pem.startsWith("${PEM}")).toBe(true)`,
    ]) {
      expect({ line, kinds: credentialKinds(line) }).toEqual({ line, kinds: [] })
    }
  })

  // L1: for a recognised prefix and exact length, only obvious placeholders are skipped.
  test('a provider token of the exact length is caught even when its characters look hand-written', async () => {
    const gh = (head: string): string => `ghp_${`${head}q7R8s9T0u1V2w3X4y5Z6a7B8c9D0e1F2g3H4`.slice(0, 36)}`
    for (const line of [gh('sample'), gh('fakeDummy'), gh('abcdefgh'), gh('12345678'), gh('Redacted'), `AKIA${'FAKEQ3EGRVLN5WZK'}`, `AKIA${'Q3EG12345678RVLN'}`]) {
      expect({ line, kinds: credentialKinds(`token: ${line}`).filter(kind => kind !== 'API key or secret assignment') }).toEqual({ line, kinds: [line.startsWith('AKIA') ? 'AWS access key id' : 'GitHub token'] })
    }
    for (const line of [`ghp_${'x'.repeat(36)}`, `ghp_${'a'.repeat(36)}`, gh('your'), gh('EXAMPLE'), gh('placeholder'), `AKIA${'IOSFODNN7EXAMPLE'}`, `AKIA${'XXXX'}${'Q3EGRVLN5WZK'}`]) {
      expect({ line, kinds: credentialKinds(`id = ${line}`) }).toEqual({ line, kinds: [] })
    }
  })

  test('added lines carry their file and new line number; removed and context lines do not count', async () => {
    const diff = [
      'diff --git a/src/a.ts b/src/a.ts',
      '--- a/src/a.ts',
      '+++ b/src/a.ts',
      '@@ -3,0 +4,2 @@ function x() {',
      `+const id = "${AWS}"`,
      '+const fine = 1',
      'diff --git a/old.ts b/old.ts',
      '--- a/old.ts',
      '+++ /dev/null',
      '@@ -1 +0,0 @@',
      `-const id = "${AWS}"`,
      'diff --git a/b.ts b/b.ts',
      '--- a/b.ts',
      '+++ b/b.ts',
      '@@ -1,2 +1,3 @@',
      ' kept',
      '++++ not a header',
    ].join('\n')
    expect(addedLines(diff)).toEqual([
      { file: 'src/a.ts', line: 4, text: `const id = "${AWS}"` },
      { file: 'src/a.ts', line: 5, text: 'const fine = 1' },
      { file: 'b.ts', line: 2, text: '+++ not a header' },
    ])
    expect(scanCredentials(addedLines(diff))).toEqual([{ file: 'src/a.ts', line: 4, kind: 'AWS access key id' }])
  })
})

describe('check outcome classification', () => {
  test('not found, timed out and killed are infrastructure; any other exit is a failure', async () => {
    expect(classify(0, '')).toBe('pass')
    expect(classify(1, 'FAIL src/a.test.ts')).toBe('fail')
    expect(classify(127, 'bash: line 1: vitest: command not found')).toBe('not-found')
    // B2.1: decided by exit code, never by the output text alone (127 is the shell's own).
    expect(classify(1, 'sh: 1: jest: not found')).toBe('fail')
    expect(classify(126, 'permission denied')).toBe('not-found')
    expect(classify(-1, 'No result within 300s')).toBe('timeout')
    expect(classify(124, '')).toBe('timeout')
    expect(classify(137, 'Killed')).toBe('killed')
    expect(classify(143, '')).toBe('killed')
    expect(classify(2, 'error: the test said command not found earlier\nFAIL')).toBe('fail')
  })
})

describe('lift classes', () => {
  test('always held, a person, or policy; in one short clause', async () => {
    expect(['secret', 'harness-state', 'reviewer-read-only', 'eval-containment'].map(liftOf)).toEqual(['none', 'none', 'none', 'none'])
    expect(['forbidden', 'egress'].map(liftOf)).toEqual(['policy', 'policy'])
    expect(['tests-locked', 'test-weakened', 'destructive', 'human-merge', 'gate'].map(liftOf)).toEqual(['person', 'person', 'person', 'person', 'person'])
    expect(liftClause('secret')).toBe('(Always held: no one lifts it.)')
    expect(liftClause('egress')).toBe('(Lifted by a change to devloop.json.)')
    expect(liftClause('protected')).toBe('(A person can lift it.)')
    expect(RULES).toContain('test-weakened')
  })
})

describe('the reviewer\'s allowlist (decision 2)', () => {
  test('git grep -o is a read; -O opens a pager and stays refused', async () => {
    expect(isReviewerCommand('git grep -o "TODO.*" src', [])).toBe(true)
    expect(isReviewerCommand('git grep --only-matching TODO', [])).toBe(true)
    expect(isReviewerCommand('git grep -Ovim TODO', [])).toBe(false)
  })
})

const cfg: Config = { ...DEFAULTS, verify: [{ run: 'npm test', profile: 'fast', when: null }, { run: 'npm run e2e', profile: 'full', when: null }] }
const green: Loop = {
  ...FRESH, changed: ['src/a.ts'], tree: 't1', size: { files: 1, lines: 10 },
  verify: { ...FRESH.verify, status: 'pass', tree: 't1', profile: 'full', passedOn: { 'npm test': 't1', 'npm run e2e': 't1' } },
  review: { ...FRESH.review, status: 'pass', round: 1, tree: 't1', agents: [] },
  evidence: { ...FRESH.evidence, tree: 't1' },
}
const row = (loop: Loop, label: string, config: Config = cfg) => gate(loop, config).find(one => one.label === label)

describe('the gate', () => {
  test('decision 3: Verification is met only when every fast and full check has a pass on this tree, and names the rest', async () => {
    expect(isShippable(green, cfg)).toBe(true)
    const fastOnly = { ...green, verify: { ...green.verify, passedOn: { 'npm test': 't1' } } }
    expect(row(fastOnly, 'Verification')).toEqual({ label: 'Verification', isMet: false, note: 'fast checks pass; the full checks run when the change ships: still to run npm run e2e' })
    // A pass on another tree covers nothing here.
    const stale = { ...green, verify: { ...green.verify, passedOn: { 'npm test': 't0', 'npm run e2e': 't1' } } }
    expect(row(stale, 'Verification')?.note).toBe('not run since the last edit; still to run: npm test')
    // A check that could not run says so.
    const infra = { ...green, verify: { ...green.verify, status: 'fail' as const, failed: 'npm test', infra: 'not-found' } }
    expect(row(infra, 'Verification')).toEqual({ label: 'Verification', isMet: false, note: 'could not run: npm test (not-found)' })
  })

  test('the credential row names file, line and kind, never the value; unscanned is unmet', async () => {
    const hit = { ...green, evidence: { ...green.evidence, credentials: [{ file: 'src/a.ts', line: 4, kind: 'AWS access key id' }] } }
    const found = row(hit, 'No credentials in the diff')
    expect(found?.isMet).toBe(false)
    expect(found?.note).toMatch(/^src\/a\.ts:4 \(AWS access key id\)/)
    expect(row(green, 'No credentials in the diff')?.isMet).toBe(true)
    expect(row({ ...green, evidence: { ...green.evidence, tree: 't0' } }, 'No credentials in the diff')?.note).toMatch(/not scanned on this tree/)
  })

  test('tests unchanged since approval: differing files listed, a person\'s exemption covers one, new files named', async () => {
    const building: Loop = { ...green, phase: 'build', spec: 's', features: {}, testHashes: { 'src/a.test.ts': 'h1', 'src/b.test.ts': 'h2' } }
    const label = 'Tests unchanged since approval'
    expect(row(building, label)).toEqual({ label, isMet: true, note: 'no approved test changed' })
    const moved = { ...building, evidence: { ...building.evidence, testsChanged: ['src/a.test.ts', 'src/b.test.ts'], testsAdded: ['src/c.test.ts'] } }
    expect(row(moved, label)).toEqual({ label, isMet: false, note: 'changed since approval: src/a.test.ts, src/b.test.ts; new test files: src/c.test.ts' })
    const exempted = { ...moved, exemptionsUsed: ['src/*.test.ts'] }
    expect(row(exempted, label)).toEqual({ label, isMet: true, note: 'no approved test changed; changed under a person\'s exemption: src/a.test.ts, src/b.test.ts; new test files: src/c.test.ts' })
  })

  test('assertion drops and vacuous checks are notes a person reads', async () => {
    const loop = { ...green, assertionDrops: ['src/a.test.ts'], approval: { vacuous: ['a'], infra: [], lint: [], unmapped: [], at: 1 } }
    expect(row(loop, 'Assertions removed in src/a.test.ts')?.isMet).toBe(true)
    expect(row(loop, 'Vacuous checks at approval')?.note).toMatch(/^a already passed/)
  })

  test('blast radius raises the tier one step and says why', async () => {
    const small = { ...DEFAULTS.blastRadius, maxFiles: 2, maxLines: 50 }
    const config = { ...cfg, blastRadius: small }
    expect(tierFor(green, config)).toBe('medium')
    expect(tierFor({ ...green, changed: ['a.ts', 'b.ts', 'c.ts'] }, config)).toBe('high')
    expect(tierFor({ ...green, size: { files: 1, lines: 51 } }, config)).toBe('high')
    expect(tierFor({ ...green, changed: ['docs/a.md'] }, config)).toBe('low')
    expect(tierFor({ ...green, changed: ['docs/a.md', 'docs/package.json'] }, config)).toBe('medium')
    expect(blastReasons(['docs/a.md', 'web/package.json'], 0, config)).toEqual(['a dependency manifest changed (web/package.json)'])
    expect(row({ ...green, changed: ['src/a.ts', 'go.mod'] }, 'Blast radius')?.note).toMatch(/go\.mod.*one tier riskier \(high\)/)
  })

  test('approvals come from policy', async () => {
    expect(approvers('medium', cfg)).toBe('one person other than the author approves and merges')
    expect(approvers('medium', { ...cfg, approvals: { low: 0, medium: 0, high: 3 } })).toBe('merge once the gate is green')
    expect(approvers('high', { ...cfg, approvals: { low: 0, medium: 0, high: 3 } })).toBe('3 people approve and merge')
  })

  test('a blocking specialist adds a row, met only once it ran on this tree with nothing blocking open', async () => {
    const config = { ...cfg, reviewers: [
      { name: 'security', when: ['src/**'], mode: 'blocking' as const, prompt: null, model: null },
      { name: 'a11y', when: ['**/*.tsx'], mode: 'shadow' as const, prompt: null, model: null },
    ] }
    expect(specialistsFor(green, config).map(one => one.name)).toEqual(['security'])
    expect(row(green, 'Review: security', config)?.note).toMatch(/did not run in round 1/)
    const ran = { ...green, review: { ...green.review, agents: [{ agentId: 'x', name: 'security', mode: 'blocking' as const, isRetry: false, answer: '' }] } }
    expect(row(ran, 'Review: security', config)?.isMet).toBe(true)
    expect(gate(ran, config).some(one => one.label === 'Review: a11y')).toBe(false)
  })
})

describe('policy fields of B2', () => {
  test('blastRadius, approvals, reviewers and models parse strictly, with their defaults', async () => {
    const { cfg: parsed, errors } = parseConfig(JSON.stringify({
      blastRadius: { maxFiles: 10 },
      approvals: { medium: 2 },
      reviewers: [{ name: 'security', when: ['src/auth/**'], mode: 'blocking' }, { name: 'a11y', when: ['**/*.tsx'], mode: 'shadow', prompt: 'Check accessibility.', model: 'haiku' }],
      models: { reviewer: 'sonnet', eval: 'haiku' },
    }))
    expect(errors).toEqual([])
    expect(parsed.blastRadius).toEqual({ ...DEFAULTS.blastRadius, maxFiles: 10 })
    expect(parsed.approvals).toEqual({ low: 0, medium: 2, high: 2 })
    expect(parsed.reviewers.map(one => [one.name, one.mode, one.prompt, one.model])).toEqual([['security', 'blocking', null, null], ['a11y', 'shadow', 'Check accessibility.', 'haiku']])
    expect(parsed.models).toEqual({ reviewer: 'sonnet', specialist: null, eval: 'haiku', learner: null })
  })

  test('a wrong field is named and keeps the stricter reading', async () => {
    const { cfg: parsed, errors } = parseConfig(JSON.stringify({
      blastRadius: { maxFiles: -1, extra: 1 },
      approvals: { high: 'two' },
      reviewers: [{ name: 'Security!', when: [] }, { name: 'perf', when: ['src/**'], mode: 'loud' }],
      models: { reviewer: 7 },
    }))
    expect(errors).toEqual([
      'blastRadius.extra: unknown field',
      'blastRadius.maxFiles: expected a number from 0 to 100000; using 25',
      'approvals.high: expected a number from 0 to 10; using 2',
      'reviewers[0]: expected { "name": "<lowercase-name>", "when": ["<glob>", ...], "mode": "blocking" | "shadow" }; left out',
      'reviewers[1].mode: expected "blocking" or "shadow"; using "blocking"',
      'models.reviewer: expected a model name; using the session\'s',
    ])
    expect(parsed.approvals.high).toBe(2)
    expect(parsed.reviewers.map(one => one.mode)).toEqual(['blocking'])
  })
})
