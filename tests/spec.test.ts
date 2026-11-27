import { describe, expect, test } from 'claude-code/testing'

import { DEFAULTS } from '../hooks/config'
import type { Config } from '../hooks/config'
import { judgeCommand, judgeEdit, removedTests, whereOf } from '../hooks/rules'
import { parse as parseIn } from '../hooks/shell'
import {
  coveredBy, criteriaOf, fingerprintInput, missingDeps, parseFeatures, readyFeatures, specProblems, unmappedCriteria,
} from '../hooks/spec'
import { FRESH } from '../hooks/state'
import { FEATURES, spec as specTemplate } from '../hooks/templates'
import { countMarkers, editedText, judgeTestEdit } from '../hooks/weaken'
import type { Loop } from '../types'
import { devloop, start, world } from './world'

/** The extended reading (BB1), which these tests were written against; `parseIn` names a reading. */
const parse = (command: string, ...rest: Parameters<typeof parseIn> extends [string, unknown, ...infer R] ? R : never) => parseIn(command, 'extended', ...rest)

const cfg: Config = { ...DEFAULTS, verify: [{ run: 'npm test', profile: 'fast', when: null }] }
const at = whereOf('/repo', '/repo')
const SPEC = '# login\n\n## Intent\nSign in.\n\n## Acceptance criteria\n1. A wrong password is refused.\n2) A right password signs in.\n3. Locked accounts say so.\n\n## Notes\n4. not a criterion\n'
const list = (features: object[]): string => JSON.stringify(features)

describe('approval refusals (DESIGN 4.4, 11)', () => {
  test('a finished spec has none', async () => {
    expect(specProblems(list([{ id: 'a', check: 'npm test -- a', criteria: [1] }]), SPEC)).toEqual([])
  })

  test('the template placeholder: the example feature, an empty list, or the SPEC.md template lines', async () => {
    expect(specProblems(list([{ id: 'example', check: 'x' }]), SPEC)[0]).toMatch(/template's placeholder/)
    expect(specProblems('[]', SPEC)[0]).toMatch(/template's placeholder/)
    expect(specProblems(list([{ id: 'a', check: 'x' }]), '## Acceptance criteria\n1. (criterion)\n')[0]).toMatch(/template's placeholder/)
  })

  test('duplicate ids, a feature without a check, an entry with no id', async () => {
    const problems = specProblems(list([{ id: 'a', check: 'x' }, { id: 'a', check: 'y' }, { id: 'b' }, { id: 'c', check: '  ' }, { check: 'z' }]), SPEC)
    expect(problems).toContain('features.json repeats "a"; each id must be unique')
    expect(problems).toContain('feature "b" has no "check" command')
    expect(problems).toContain('feature "c" has no "check" command')
    expect(problems).toContain('features.json entry 5 has no "id"')
  })

  test('an open [NEEDS CLARIFICATION] refuses; the template\'s own instructions do not', async () => {
    expect(specProblems(list([{ id: 'a', check: 'x' }]), `${SPEC}\n[NEEDS CLARIFICATION: who may unlock?]\n`)).toEqual([
      'SPEC.md still has 1 [NEEDS CLARIFICATION] marker: answer each question in the spec first',
    ])
    expect(specProblems(list([{ id: 'a', check: 'x' }]), `${SPEC}\nMark anything undecided with the words NEEDS CLARIFICATION in square brackets\n`)).toEqual([])
  })

  test('dependencies must name features, without a circle; criteria must be numbers', async () => {
    expect(specProblems(list([{ id: 'a', check: 'x', dependsOn: ['ghost'] }]), SPEC)[0]).toMatch(/depends on "ghost", which is no feature/)
    expect(specProblems(list([{ id: 'a', check: 'x', dependsOn: ['b'] }, { id: 'b', check: 'y', dependsOn: ['a'] }]), SPEC)).toEqual([
      'the features depend on each other in a circle: a → b → a',
    ])
    expect(specProblems(list([{ id: 'a', check: 'x', criteria: ['one'] }]), SPEC)[0]).toMatch(/"criteria" must be a list/)
    expect(specProblems('{"id":"a"}', SPEC)).toEqual(['features.json must be a JSON list of features'])
  })
})

describe('spec coverage lint', () => {
  test('criteria are the numbered items under "Acceptance criteria" only', async () => {
    expect(criteriaOf(SPEC)).toEqual([1, 2, 3])
  })

  test('a feature covers its criteria list, or failing that "criterion N" / "ACN" in its description', async () => {
    const [a, b, c] = parseFeatures(list([
      { id: 'a', check: 'x', criteria: [1, 3], description: 'criterion 2' },
      { id: 'b', check: 'x', description: 'covers AC2 and criterion #3' },
      { id: 'c', check: 'x', description: 'handles 2 retries in 3 seconds' },
    ]))
    expect(coveredBy(a!)).toEqual([1, 3])
    expect(coveredBy(b!)).toEqual([2, 3])
    // A number in the prose is not a criterion.
    expect(coveredBy(c!)).toEqual([])
  })

  test('unmapped criteria are listed', async () => {
    expect(unmappedCriteria(SPEC, parseFeatures(list([{ id: 'a', check: 'x', criteria: [1] }])))).toEqual([2, 3])
    expect(unmappedCriteria(SPEC, parseFeatures(list([{ id: 'a', check: 'x', criteria: [1, 2, 3] }])))).toEqual([])
  })
})

describe('the SPEC.md template and the devloop:spec skill (spec-interview note, decisions 2, 6, 9)', () => {
  /** The template /devloop spec writes, with each placeholder line answered as the skill fills it. */
  const filled = (text: string): string =>
    text
      .replace('Kind: (new feature, integration, change, bug fix or small task) · Size: (full, standard or lite)', 'Kind: new feature · Size: lite')
      .replace('Related specs: (the earlier specs this one draws on, or none)', 'Related specs: none')
      .replace('(What should be true for the user when this is done, in two or three sentences.)', 'A user who forgot a password can set a new one.')
      .replace(/^- \(.*\)$/gm, '- one line')
      .replace('1. (criterion)', '1. A reset request sends one email.\n2. The email reads clearly (checked by a person).')
  const features = list([{ id: 'reset-email', description: 'one email', check: 'npm test -- reset', criteria: [1] }])

  test('the new template carries the new header lines and sections, and keeps the placeholders the approval refuses', async () => {
    const text = specTemplate('reset')
    expect(text).toMatch(/^# reset\nKind: .* · Size: .*\nRelated specs: /)
    expect(text.match(/^## .*$/gm)).toEqual([
      '## Intent', '## Context', '## Constraints', '## Out of scope', '## Acceptance criteria', '## Risks and assumptions', '## Notes for the reviewer',
    ])
    expect(specProblems(FEATURES, text)[0]).toMatch(/template's placeholder/)
    expect(specProblems(features, text)).toEqual([
      'the spec still holds the template\'s placeholder: each acceptance criterion needs a real entry in features.json with a "check" command',
    ])
  })

  test('filled, it passes the approval checks; an open question still refuses it; a criterion checked by a person is listed as uncovered', async () => {
    const text = filled(specTemplate('reset'))
    expect(specProblems(features, text)).toEqual([])
    expect(criteriaOf(text)).toEqual([1, 2])
    expect(unmappedCriteria(text, parseFeatures(features))).toEqual([2])
    expect(specProblems(features, text.replace('- one line', '- [NEEDS CLARIFICATION: who may reset an admin?]'))).toEqual([
      'SPEC.md still has 1 [NEEDS CLARIFICATION] marker: answer each question in the spec first',
    ])
    // A spec in the older shape, with no Kind line and none of the new sections, stays valid.
    expect(specProblems(features, SPEC)).toEqual([])
  })

  test('/devloop spec writes the new template, refuses it unfilled, and tells the agent to follow the devloop:spec skill', async ($, on) => {
    const w = world(on)
    await start($)
    const ran = await $.command.run({ command: 'devloop', args: 'spec reset', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 80 } })
    expect(w.files['/repo/specs/reset/SPEC.md']).toBe(specTemplate('reset'))
    const said = (ran.context ?? []).join('\n')
    expect(said).toMatch(/Follow the devloop:spec skill to fill specs\/reset\/SPEC\.md and specs\/reset\/features\.json with them/)
    expect(said).toMatch(/Write the tests those checks run, and confirm they fail for the right reason\. Do not implement anything yet\. When the spec is ready, ask the person to read it and run \/devloop approve\./)
    expect(await devloop($, 'approve')).toMatch(/template's placeholder/)
  })
})

describe('fingerprint and dependencies', () => {
  test('the fingerprint covers SPEC.md and each feature\'s id, description, check, dependsOn and criteria, not passes', async () => {
    const base = { id: 'a', description: 'd', check: 'x', dependsOn: ['b'], criteria: [1] }
    const of = (one: object): string => fingerprintInput(SPEC, parseFeatures(list([one, { id: 'b', check: 'y' }])))
    const before = of(base)
    for (const changed of [{ description: 'e' }, { check: 'z' }, { dependsOn: [] }, { criteria: [2] }]) {
      expect(of({ ...base, ...changed })).not.toBe(before)
    }
    expect(of({ ...base, passes: true })).toBe(before)
    expect(fingerprintInput(`${SPEC}!`, parseFeatures(list([base])))).not.toBe(fingerprintInput(SPEC, parseFeatures(list([base]))))
  })

  test('a feature is ready when its dependencies pass on this tree; a pass on an older tree is not enough', async () => {
    const loop: Loop = {
      ...FRESH, phase: 'build', spec: 's', tree: 't2',
      features: { a: { passes: true, tree: 't2' }, b: { passes: true, tree: 't1' }, c: { passes: false, tree: null }, d: { passes: false, tree: null } },
      dependsOn: { a: [], b: [], c: ['a'], d: ['a', 'b'] },
    }
    expect(missingDeps(loop, 'c')).toEqual([])
    expect(missingDeps(loop, 'd')).toEqual(['b'])
    expect(readyFeatures(loop)).toEqual(['b', 'c'])
  })
})

describe('test-weakening detection (DESIGN 11)', () => {
  // [framework, before, after, more skips?]
  const cases: [string, string, string, boolean][] = [
    ['jest .skip', 'it("a", () => { expect(1).toBe(1) })', 'it.skip("a", () => { expect(1).toBe(1) })', true],
    ['vitest .only', 'test("a", () => {})', 'test.only("a", () => {})', true],
    ['mocha .todo', 'describe("x", () => {})', 'describe.todo("x")', true],
    ['xit and xdescribe', 'it("a", f)\ndescribe("b", g)', 'xit("a", f)\nxdescribe("b", g)', true],
    ['pytest mark', 'def test_a():\n    assert a', '@pytest.mark.skip(reason="later")\ndef test_a():\n    assert a', true],
    ['pytest xfail', 'def test_a():\n    assert a', '@pytest.mark.xfail\ndef test_a():\n    assert a', true],
    ['pytest.skip call', 'def test_a():\n    assert a', 'def test_a():\n    pytest.skip("flaky")\n    assert a', true],
    ['go t.Skip', 'func TestA(t *testing.T) {\n  if x { t.Fatal("x") }\n}', 'func TestA(t *testing.T) {\n  t.Skip("later")\n  if x { t.Fatal("x") }\n}', true],
    ['rust #[ignore]', '#[test]\nfn a() { assert!(x) }', '#[test]\n#[ignore]\nfn a() { assert!(x) }', true],
    ['junit @Disabled', '@Test\nvoid a() { assertEquals(1, x); }', '@Disabled\n@Test\nvoid a() { assertEquals(1, x); }', true],
    ['junit4 @Ignore', '@Test\nvoid a() {}', '@Ignore\n@Test\nvoid a() {}', true],
    ['a skip taken out', 'it.skip("a", f)', 'it("a", f)', false],
    ['a renamed test', 'it("a", f)', 'it("b", f)', false],
  ]
  for (const [name, before, after, isWeakened] of cases) {
    test(`${name}: ${isWeakened ? 'refused' : 'allowed'}`, async () => {
      expect(judgeTestEdit(before, after).isWeakened).toBe(isWeakened)
    })
  }

  // B2.1 F8: a marker counts only at the start of a call, never after a dot or an identifier character.
  const ORDINARY_EDITS: [string, string][] = [
    ['model.fit', 'model.fit(X, y)\nexpect(model.score(X, y)).toBeGreaterThan(0.9)'],
    ['a method named xit', 'const v = parser.xit(token)\nexpect(v).toBe(1)'],
    ['a field named test.skip', 'cfg.test.skip = false\nexpect(cfg.ok).toBe(true)'],
    ['an identifier ending in fit', 'const r = refit(data)\nexpect(r).toBe(1)'],
    ['a $-prefixed helper', 'const r = $fdescribe(data)\nexpect(r).toBe(1)'],
    ['a pipeline step', 'pipe.fdescribe(stage)\nexpect(pipe.ok).toBe(true)'],
  ]
  for (const [name, added] of ORDINARY_EDITS) {
    test(`ordinary edits are not refused: ${name}`, async () => {
      expect(judgeTestEdit('it("a", () => { expect(1).toBe(1) })', `it("a", () => { expect(1).toBe(1) })\n${added}`).isWeakened).toBe(false)
    })
  }

  test('a marker at the start of a call is still caught, however the line starts', async () => {
    for (const after of ['fit("a", f)', '  xit("a", f)', '(it.only("a", f))', ';describe.skip("x", g)', '\ttest.todo("later")', 'await fdescribe("x", g)']) {
      expect({ after, isWeakened: judgeTestEdit('', after).isWeakened }).toEqual({ after, isWeakened: true })
    }
  })

  test('assertions are counted roughly, across frameworks, and a drop is reported, not refused', async () => {
    expect(countMarkers('expect(a).toBe(1)\nassert x == 1\nassertEquals(1, y)\nassert!(z)\nself.assertTrue(w)\nt.Errorf("no")').assertions).toBe(6)
    const drop = judgeTestEdit('expect(a).toBe(1)\nexpect(b).toBe(2)', 'expect(a).toBe(1)')
    expect(drop.isAssertionDrop).toBe(true)
    expect(drop.isWeakened).toBe(false)
    expect(judgeTestEdit('expect(a).toBe(1)', 'expect(a).toBe(1)\nexpect(b).toBe(2)').isAssertionDrop).toBe(false)
  })

  test('emptying a test file by the edit tool is a deletion', async () => {
    expect(judgeTestEdit('it("a", f)', '\n').isEmptied).toBe(true)
    expect(judgeTestEdit('', 'it("a", f)').isEmptied).toBe(false)
  })

  test('the text an edit leaves: Write\'s content, or Edit applied once (or everywhere)', async () => {
    expect(editedText('a a', { tool: 'Write', content: 'b' })).toBe('b')
    expect(editedText('a a', { tool: 'Edit', old_string: 'a', new_string: 'b' })).toBe('b a')
    expect(editedText('a a', { tool: 'Edit', old_string: 'a', new_string: 'b', replace_all: true })).toBe('b b')
    expect(editedText('a', { tool: 'Edit', old_string: 'zz', new_string: 'b' })).toBe(null)
    expect(editedText('$&', { tool: 'Edit', old_string: '$&', new_string: '$1' })).toBe('$1')
  })

  test('a shell command that deletes or renames a test file away is refused; one that keeps it a test is not', async () => {
    for (const command of ['rm src/a.test.ts', 'git rm src/a.test.ts', 'unlink tests/x.py', 'rm -rf tests', 'mv src/a.test.ts src/a.ts.skip', 'git mv tests/a.test.ts old.ts']) {
      expect(judgeCommand(command, cfg, FRESH, at)?.rule).toBe('test-weakened')
    }
    for (const command of ['mv src/a.test.ts src/b.test.ts', 'mv src/a.test.ts tests/', 'git rm --cached src/a.test.ts', 'rm src/a.ts', 'mv src/a.ts src/b.ts']) {
      expect(judgeCommand(command, cfg, FRESH, at)).toBe(null)
    }
    // A folder that holds a tracked test the hook listed.
    expect(judgeCommand('rm -r src', cfg, FRESH, { ...at, filesUnder: { src: ['src/a.ts', 'src/a.test.ts'] } })?.rule).toBe('test-weakened')
    expect(removedTests(parse('rm -r src')[0]!, cfg, FRESH, { ...at, filesUnder: { src: ['src/a.ts'] } })).toEqual([])
  })

  test('a person\'s path exemption lifts it', async () => {
    const exempt: Loop = { ...FRESH, allow: [{ kind: 'path', value: 'src/a.test.ts', turnId: null }] }
    expect(judgeCommand('rm src/a.test.ts', cfg, exempt, at)).toBe(null)
  })

  test('in build an approved test is locked, a test file the builder created is not', async () => {
    const building: Loop = { ...FRESH, phase: 'build', spec: 's', newTests: ['src/new.test.ts'] }
    expect(judgeEdit('src/a.test.ts', cfg, building)?.rule).toBe('tests-locked')
    expect(judgeEdit('src/new.test.ts', cfg, building)).toBe(null)
    // A locked test is refused as locked first.
    expect(judgeCommand('rm src/a.test.ts', cfg, building, at)?.rule).toBe('tests-locked')
  })
})
