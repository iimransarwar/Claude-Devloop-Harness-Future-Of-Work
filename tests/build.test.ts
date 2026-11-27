import { expect, test } from 'claude-code/testing'

import { approved, bash, CONFIG, change, devloop, edit, feature, ledgerOf, start, stop, world } from './world'
import type { Dollar, World } from './world'

// The spec, risk and gate work of B2 (DESIGN 4.4, 4.6, 11, the rea note), through the world() helper.

const SPEC = '# login\n\n## Intent\nSign in.\n\n## Acceptance criteria\n1. A wrong password is refused.\n2. A right password signs in.\n3. Locked accounts say so.\n'

/** Writes a spec as given and starts it, without approving. */
async function writeSpec($: Dollar, w: World, features: object[], spec = SPEC): Promise<void> {
  await devloop($, 'spec login')
  w.files['/repo/specs/login/SPEC.md'] = spec
  w.files['/repo/specs/login/features.json'] = JSON.stringify(features)
}

const loopOf = (w: World) => (w.store['loop:/repo'] as { value: Record<string, unknown> & { approval: { vacuous: string[]; lint: string[]; unmapped: number[] } | null; assertionDrops: string[]; newTests: string[] } }).value
const AWS = `AKIA${'Q3EGRVLN5WZKT7PB'}`

// ---------------------------------------------------------------- approval

test('approval runs every check first: vacuous ones, lint and unmapped criteria are in the dialog, and recorded', async ($, on) => {
  const w = world(on)
  await start($)
  await writeSpec($, w, [
    { id: 'refuses', description: 'd', check: 'npm test -- refuses', criteria: [1] },
    { id: 'signs-in', description: 'd', check: 'npm test -- signs-in || true', criteria: [2] },
  ])
  w.exits['npm test -- refuses'] = 1
  w.answer = 'Not yet'
  expect(await devloop($, 'approve')).toMatch(/Not approved/)
  const asked = w.questions.at(-1) ?? ''
  expect(asked).toMatch(/Already passing before any implementation \(vacuous\): signs-in\./)
  expect(asked).toMatch(/Check integrity: signs-in: `\|\| true` turns any failure into a pass\./)
  expect(asked).toMatch(/Acceptance criteria no feature covers: 3\./)
  expect(w.ran).toEqual(['npm test -- refuses', 'npm test -- signs-in || true'])

  w.answer = 'Approve'
  expect(await devloop($, 'approve')).toMatch(/Vacuous checks, approved as they are and recorded on the change: signs-in\.[\s\S]*criteria no feature covers: 3/)
  expect(loopOf(w).approval).toMatchObject({ vacuous: ['signs-in'], unmapped: [3] })
  change(w, 'src/login.ts')
  expect(await devloop($, 'status')).toMatch(/\[x\] Vacuous checks at approval: signs-in already passed before any implementation/)
  // Every feature still starts at not passing.
  expect(await devloop($, 'status')).toMatch(/0\/2 features/)
})

test('approval refuses an open question, a feature without a check, duplicate ids, the template; a person only', async ($, on) => {
  const w = world(on)
  await start($)
  await writeSpec($, w, [{ id: 'a', check: 'npm test -- a' }, { id: 'a', check: 'x' }, { id: 'b' }], `${SPEC}\n[NEEDS CLARIFICATION: who unlocks?]\n`)
  const refused = await devloop($, 'approve')
  expect(refused).toMatch(/cannot be approved yet/)
  expect(refused).toMatch(/repeats "a"/)
  expect(refused).toMatch(/feature "b" has no "check" command/)
  expect(refused).toMatch(/1 \[NEEDS CLARIFICATION\] marker/)
  expect(w.questions).toEqual([])
  expect(w.ran).toEqual([])
  expect(await devloop($, 'approve', { kind: 'sdk' })).toMatch(/approved by a person/)
})

test('the fingerprint covers dependsOn and criteria: a change after approval freezes feature_check', async ($, on) => {
  const w = world(on)
  await start($)
  await approved($, w, [{ id: 'a', description: 'a', check: 'npm test -- a' }, { id: 'b', description: 'b', check: 'npm test -- b', dependsOn: ['a'] }] as never)
  expect(await feature($, 'a')).toMatch(/^PASS/)
  w.files['/repo/specs/login/features.json'] = JSON.stringify([{ id: 'a', description: 'a', check: 'npm test -- a' }, { id: 'b', description: 'b', check: 'npm test -- b' }])
  expect(await feature($, 'a')).toMatch(/changed after it was approved/)
  w.files['/repo/specs/login/features.json'] = JSON.stringify([{ id: 'a', description: 'a', check: 'npm test -- a', criteria: [1] }, { id: 'b', description: 'b', check: 'npm test -- b', dependsOn: ['a'] }])
  expect(await feature($, 'a')).toMatch(/changed after it was approved/)
})

test('dependsOn: a feature runs only on dependencies passing on this tree; the status lists what is ready', async ($, on) => {
  const w = world(on)
  await start($)
  await approved($, w, [
    { id: 'a', description: 'a', check: 'npm test -- a' },
    { id: 'b', description: 'b', check: 'npm test -- b', dependsOn: ['a'] },
    { id: 'c', description: 'c', check: 'npm test -- c' },
  ] as never)
  change(w, 'src/a.ts')
  expect(await devloop($, 'status')).toMatch(/Ready to build \(dependencies pass on this tree\): a, c/)
  // (Approval already ran every check once: red before green.)
  const before = w.ran.length
  expect(await feature($, 'b')).toMatch(/Not run: "b" depends on a, which does not pass/)
  expect(w.ran.length).toBe(before)
  expect(await feature($, 'a')).toMatch(/^PASS/)
  expect(await devloop($, 'status')).toMatch(/Ready to build \(dependencies pass on this tree\): b, c/)
  expect(await feature($, 'b')).toMatch(/^PASS/)
  // A pass on an older tree is not a dependency passing now.
  change(w, 'src/b.ts')
  expect(await feature($, 'b')).toMatch(/depends on a/)
})

// ---------------------------------------------------------------- tests locked, tests weakened

test('test-lock evidence: hashes at approval; a changed test unmeets the row, a new one is named, an exemption covers', async ($, on) => {
  const w = world(on)
  w.testHashes = { 'src/a.test.ts': 'h1', 'src/b.test.ts': 'h2' }
  await start($)
  await approved($, w)
  change(w, 'src/a.ts')
  const label = 'Tests unchanged since approval'
  expect(await devloop($, 'status')).toMatch(new RegExp(`\\[x\\] ${label}: no approved test changed`))
  // A shell write the tripwire did not catch shows here.
  w.testHashes = { 'src/a.test.ts': 'h1-moved', 'src/b.test.ts': 'h2', 'src/c.test.ts': 'h3' }
  change(w, 'src/a.test.ts')
  expect(await devloop($, 'status')).toMatch(new RegExp(`\\[ \\] ${label}: changed since approval: src/a.test.ts; new test files: src/c.test.ts`))
  expect((await bash($, 'git push -u origin feature')).deny).toMatch(/Tests unchanged since approval/)
  // A person's exemption that an edit used covers it.
  w.answer = 'Allow once'
  await devloop($, 'allow src/a.test.ts')
  expect((await edit($, '/repo/src/a.test.ts')).deny).toBeUndefined()
  expect(await devloop($, 'status')).toMatch(new RegExp(`\\[x\\] ${label}: no approved test changed; changed under a person's exemption: src/a.test.ts`))
})

test('test-weakening: more skips is refused wherever tests are editable; fewer assertions is a gate note', async ($, on) => {
  const w = world(on)
  w.files['/repo/src/a.test.ts'] = 'it("adds", () => {\n  expect(add(1, 1)).toBe(2)\n  expect(add(1, 2)).toBe(3)\n})\n'
  // B2.1 F9: for deletion, a test is a file git tracks.
  w.tracked = ['src/a.test.ts']
  await start($)
  const skip = await $.tool.call({ tool: 'Edit', file_path: '/repo/src/a.test.ts', old_string: 'it("adds"', new_string: 'it.skip("adds"' })
  expect(skip.deny).toMatch(/adds skip, only, todo or xfail markers to src\/a.test.ts \(0 before, 1 after\)/)
  expect(skip.deny).toMatch(/\(A person can lift it\.\)$/)
  expect(ledgerOf(w).map(one => `${one.kind} ${one.key}`)).toContain('guard-deny test-weakened')
  // Emptying it by the edit tool is a deletion.
  expect((await $.tool.call({ tool: 'Write', file_path: '/repo/src/a.test.ts', content: '' })).deny).toMatch(/empties src\/a.test.ts/)
  // A shell delete or a rename away is refused too.
  expect((await bash($, 'rm src/a.test.ts')).deny).toMatch(/deleting it removes what it checks/)
  expect((await bash($, 'mv src/a.test.ts src/a.ts.off')).deny).toMatch(/renaming it to src\/a.ts.off/)
  // Fewer assertions passes, and the gate says so.
  expect((await $.tool.call({ tool: 'Edit', file_path: '/repo/src/a.test.ts', old_string: '  expect(add(1, 2)).toBe(3)\n', new_string: '' })).deny).toBeUndefined()
  change(w, 'src/a.test.ts')
  expect(await devloop($, 'status')).toMatch(/\[x\] Assertions removed in src\/a.test.ts/)
  // A person's one-turn exemption lifts it.
  w.answer = 'Allow once'
  await devloop($, 'allow src/a.test.ts')
  expect((await $.tool.call({ tool: 'Edit', file_path: '/repo/src/a.test.ts', old_string: 'it("adds"', new_string: 'it.skip("adds"' })).deny).toBeUndefined()
})

test('test-weakening holds in the spec phase too', async ($, on) => {
  const w = world(on)
  w.files['/repo/src/a.test.ts'] = 'def test_a():\n    assert a\n'
  await start($)
  await devloop($, 'spec login')
  expect((await $.tool.call({ tool: 'Write', file_path: '/repo/src/a.test.ts', content: '@pytest.mark.skip\ndef test_a():\n    assert a\n' })).deny).toMatch(/skip, only, todo or xfail/)
  expect((await $.tool.call({ tool: 'Write', file_path: '/repo/src/a.test.ts', content: 'def test_a():\n    assert a\n\ndef test_b():\n    assert b\n' })).deny).toBeUndefined()
})

test('while building, a new test file may be written (and weakening is still judged); approved tests stay locked', async ($, on) => {
  const w = world(on)
  w.files['/repo/src/old.test.ts'] = 'it("x", f)'
  w.testHashes = { 'src/old.test.ts': 'h1' }
  await start($)
  await approved($, w)
  expect((await $.tool.call({ tool: 'Write', file_path: '/repo/src/old.test.ts', content: 'it("x", g)' })).deny).toMatch(/tests are locked/)
  expect((await $.tool.call({ tool: 'Write', file_path: '/repo/src/new.test.ts', content: 'it("y", () => expect(1).toBe(1))' })).deny).toBeUndefined()
  w.files['/repo/src/new.test.ts'] = 'it("y", () => expect(1).toBe(1))'
  expect(loopOf(w).newTests).toEqual(['src/new.test.ts'])
  expect((await $.tool.call({ tool: 'Edit', file_path: '/repo/src/new.test.ts', old_string: 'it("y"', new_string: 'it("z"' })).deny).toBeUndefined()
  expect((await $.tool.call({ tool: 'Edit', file_path: '/repo/src/new.test.ts', old_string: 'it("y"', new_string: 'xit("y"' })).deny).toMatch(/skip, only, todo or xfail/)
  // B2.1 F3: a brand-new test file is judged at creation, against nothing: a skipped test in it is a rise.
  expect((await $.tool.call({ tool: 'Write', file_path: '/repo/src/later.test.ts', content: 'it.todo("later")' })).deny).toMatch(/creates a test file with skip, only, todo or xfail markers/)
  expect((await $.tool.call({ tool: 'Write', file_path: '/repo/src/later.test.ts', content: 'it("later", () => expect(1).toBe(1))' })).deny).toBeUndefined()
})

// ---------------------------------------------------------------- check outcomes

test('a check that cannot be found is infrastructure: no block, no fix round, ledger check-infra, gate row "could not run"', async ($, on) => {
  const w = world(on)
  await start($)
  change(w, 'src/a.ts')
  w.exits['npm test'] = 127
  w.outputs['npm test'] = 'bash: line 1: npm: command not found'
  const stopped = await stop($)
  expect(stopped.block).toBeUndefined()
  expect(stopped.additionalContext?.join(' ')).toMatch(/could not run, so the stop is not blocked and no fix round is spent/)
  expect(w.toasts.join(' ')).toMatch(/`npm test` could not run: its program was not found \(exit 127\)\. Install it, or fix the command in devloop.json/)
  expect(ledgerOf(w).map(one => `${one.kind} ${one.key}`)).toEqual(['check-infra npm test (not-found)'])
  expect(await devloop($, 'status')).toMatch(/\[ \] Verification: could not run: npm test \(not-found\)/)
  const saved = (w.store['loop:/repo'] as { value: { verify: { rounds: number } } }).value
  expect(saved.verify.rounds).toBe(0)
})

test('a check that times out or is killed is infrastructure too; a real failure still blocks', async ($, on) => {
  const w = world(on)
  await start($)
  change(w, 'src/a.ts')
  w.exits['npm test'] = 137
  expect((await stop($)).block).toBeUndefined()
  expect(w.toasts.join(' ')).toMatch(/was killed before it finished/)
  change(w, 'src/b.ts')
  w.exits['npm test'] = 124
  expect((await stop($)).block).toBeUndefined()
  expect(w.toasts.join(' ')).toMatch(/did not finish within 300s/)
  change(w, 'src/c.ts')
  w.exits['npm test'] = 1
  expect((await stop($)).block).toMatch(/fix round 1 of 2/)
})

test('a feature check that cannot run is said so, and recorded as infrastructure', async ($, on) => {
  const w = world(on)
  await start($)
  await approved($, w, [{ id: 'a', description: 'a', check: 'npm test -- a' }])
  w.exits['npm test -- a'] = 127
  expect(await feature($, 'a')).toMatch(/^COULD NOT RUN a: `npm test -- a` could not run: its program was not found/)
  expect(ledgerOf(w).map(one => one.kind)).toContain('check-infra')
})

// ---------------------------------------------------------------- credentials

test('a credential in the added lines unmeets its row by file and line, never by value, and nothing ships', async ($, on) => {
  const w = world(on)
  w.added = ['diff --git a/src/aws.ts b/src/aws.ts', '--- /dev/null', '+++ b/src/aws.ts', '@@ -0,0 +1,2 @@', '+// keys', `+const id = "${AWS}"`].join('\n')
  await start($)
  change(w, 'src/aws.ts')
  await stop($)
  const status = await devloop($, 'status')
  expect(status).toMatch(/\[ \] No credentials in the diff: src\/aws.ts:2 \(AWS access key id\)/)
  expect(status).not.toContain(AWS)
  const refused = (await bash($, 'git push -u origin feature')).deny ?? ''
  expect(refused).toMatch(/No credentials in the diff/)
  expect(refused).not.toContain(AWS)
  w.added = ''
  change(w, 'src/aws.ts ')
  await stop($)
  expect(await devloop($, 'status')).toMatch(/\[x\] No credentials in the diff/)
})

// ---------------------------------------------------------------- lift classes

test('every refusal says who can lift it, and doctor lists the rules with theirs', async ($, on) => {
  world(on, { ...CONFIG, network: { allow: ['github.com'] } })
  await start($)
  expect((await bash($, 'cat .env')).deny).toMatch(/\(Always held: no one lifts it\.\)$/)
  expect((await bash($, 'curl https://elsewhere.dev/x')).deny).toMatch(/\(Lifted by a change to devloop.json\.\)$/)
  expect((await edit($, '/repo/REVIEW.md')).deny).toMatch(/\(A person can lift it\.\)/)
  const doctor = await devloop($, 'doctor')
  expect(doctor).toMatch(/refusals and who lifts them: secret \[Always held: no one lifts it\]/)
  expect(doctor).toMatch(/egress \[Lifted by a change to devloop.json\]/)
  expect(doctor).toMatch(/test-weakened \[A person can lift it\]/)
  expect(doctor).toMatch(/budget \[A person can lift it\]/)
})

// ---------------------------------------------------------------- risk and approvals

test('blast radius: a dependency manifest or a big diff raises the tier one step, and the gate says why', async ($, on) => {
  const w = world(on, { ...CONFIG, blastRadius: { maxFiles: 3 } })
  await start($)
  change(w, 'docs/a.md')
  expect(await devloop($, 'status')).toMatch(/low risk/)
  change(w, 'docs/package.json')
  const status = await devloop($, 'status')
  expect(status).toMatch(/medium risk/)
  expect(status).toMatch(/\[x\] Blast radius: a dependency manifest changed \(docs\/package.json\): the change is one tier riskier \(medium\)/)
  for (const file of ['docs/b.md', 'docs/c.md']) {
    change(w, file)
  }
  expect(await devloop($, 'status')).toMatch(/4 files changed, over the 3 blastRadius.maxFiles allows/)
})

test('approvals come from policy: the merge line and the push-to-default rule read them', async ($, on) => {
  const w = world(on, { ...CONFIG, approvals: { medium: 0, high: 3 } })
  w.branch = 'main'
  await start($)
  w.pushRange = ['src/a.ts']
  expect((await bash($, 'git push origin main')).deny).toBeUndefined()
  w.pushRange = ['src/auth/a.ts']
  expect((await bash($, 'git push origin main')).deny).toMatch(/high-risk change on main: 3 people approve and merge/)
  w.branch = 'feature'
  change(w, 'src/a.ts')
  expect(await devloop($, 'status')).toMatch(/Merge: merge once the gate is green/)
})

// ---------------------------------------------------------------- /devloop gate

test('/devloop gate proves the gate on demand and answers with an exit code for CI', async ($, on) => {
  const w = world(on, { verify: ['npm test', { run: 'npm run e2e', profile: 'full' }], mode: 'enforce' })
  await start($)
  const run = (args: string) => $.command.run({ command: 'devloop', args, origin: { kind: 'sdk' }, presentation: { isFullscreen: false, columns: 80 } })
  const clean = await run('gate')
  expect(clean.exitCode).toBe(0)
  expect(clean.text).toMatch(/^devloop gate: green \(no changes/)
  change(w, 'docs/a.md')
  w.exits['npm run e2e'] = 1
  const failing = await run('gate')
  expect(failing.exitCode).toBe(1)
  expect(failing.text).toMatch(/\[ \] Verification: failing: npm run e2e/)
  // It ran the checks itself, fast and full.
  expect(w.ran).toEqual(['npm test', 'npm run e2e'])
  w.exits['npm run e2e'] = 0
  change(w, 'docs/b.md')
  const green = await run('gate')
  expect(green.exitCode).toBe(0)
  expect(green.text).toMatch(/\[x\] Verification: fast and full checks pass/)
  expect(green.text).toMatch(/Merge: merge once the gate is green \(0 approvals/)
})

test('models: the eval agent runs on models.eval when policy sets it', async ($, on) => {
  const w = world(on, { ...CONFIG, models: { eval: 'haiku' } })
  w.files['/repo/evals/tasks/one.json'] = JSON.stringify({ prompt: 'do it', check: 'npm test -- one' })
  w.lists['/repo/evals/tasks'] = ['one.json']
  w.exits['npm test -- one'] = 1
  w.answer = 'Start the run'
  await start($)
  expect(await devloop($, 'eval')).toMatch(/1 task on haiku/)
  expect(w.spawned[0]?.model).toBe('haiku')
})
