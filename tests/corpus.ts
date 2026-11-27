/// <reference path="../cli/node.d.ts" />
// The comparison corpus (the fourteenth round, CC2): about 2,000 command
// lines (tests/corpus.jsonl), each with the verdict the reviewed build's
// bundle (`git show 2374c49:dist/devloop.mjs`) gave it in the world
// tests/corpus-world.sh builds. The rule of construction this checks (BB1,
// CC1): the reviewed reading is the whole of that build's reading, so no line
// it refused may be allowed now. A line whose recorded verdict is a refusal
// and whose verdict now is not fails the run; nothing else is compared (a
// line refused now that the reference allowed is the extended reading's
// doing, and the parity table holds those).
// Run by tests/smoke.sh with bun; each line is judged by the built bundle's
// own `main` (`check-command <line> --phase idle --json`), loaded once per
// worker in Node, so that 2,000 lines cost seconds, not a process each:
//   bun tests/corpus.ts <bundle> <work folder>
// To record the reference verdicts again (a person's step, from a list of
// lines, one per line, `⏎` for a newline and `@W@` for the world's folder):
//   bun tests/corpus.ts --record <reference bundle> <work folder> <list> > tests/corpus.jsonl

import { spawnSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import process from 'node:process'

/** One corpus line: the command as written (`@W@` is the world's folder) and the reference bundle's verdict, null when it allowed it. */
type Entry = { ref: string | null; line: string }

/** How many Node workers judge the corpus at once. */
const WORKERS = 4

/** The folder this file is in (tests/), where the world script and the corpus are. */
const HERE = (process.argv[1] ?? '').slice(0, (process.argv[1] ?? '').lastIndexOf('/')) || '.'

/** The worker each Node process runs: it loads the bundle once and judges its share of the lines with the bundle's `main`. */
const WORKER = `
import { readFileSync, writeFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
const [bundle, input, output, world] = process.argv.slice(2)
const lines = JSON.parse(readFileSync(input, 'utf8'))
const write = process.stdout.write.bind(process.stdout)
let said = ''
process.stdout.write = chunk => { said += String(chunk); return true }
process.argv = [process.argv[0], bundle, 'help']
process.chdir(world)
const { main } = await import(pathToFileURL(bundle).href)
const out = []
for (const line of lines) {
  said = ''
  const code = main(['check-command', line, '--phase', 'idle', '--json'])
  if (typeof code !== 'number') { await code }
  try {
    const j = JSON.parse(said)
    out.push(j.rule === null ? null : j.isHeld ? j.rule : 'recorded:' + j.rule)
  } catch {
    out.push('unread:' + said.slice(0, 80))
  }
}
process.stdout.write = write
writeFileSync(output, JSON.stringify(out))
`

/** Builds the world, then judges every line with the bundle; the verdicts in the corpus's order (null: allowed). */
function judgeAll(bundle: string, work: string, lines: readonly string[]): (string | null)[] {
  const world = `${work}/world`
  const module = bundle.startsWith('/') ? bundle : `${process.cwd()}/${bundle}`
  const built = spawnSync('bash', [`${HERE}/corpus-world.sh`, world], { encoding: 'utf8' })
  if (built.status !== 0) {
    throw new Error(`the corpus world was not built: ${built.stderr}`)
  }
  mkdirSync(`${work}/home`, { recursive: true })
  mkdirSync(`${work}/state`, { recursive: true })
  writeFileSync(`${work}/worker.mjs`, WORKER)
  const filled = lines.map(line => line.replaceAll('@W@', world))
  const share = Math.ceil(filled.length / WORKERS)
  for (let n = 0; n < WORKERS; n += 1) {
    writeFileSync(`${work}/in-${n}.json`, JSON.stringify(filled.slice(n * share, (n + 1) * share)))
  }
  // The workers run side by side, under one shell that waits for them all.
  const q = (text: string): string => `'${text.replaceAll("'", "'\\''")}'`
  const script = Array.from({ length: WORKERS }, (_, n) => `node ${q(`${work}/worker.mjs`)} ${q(module)} ${q(`${work}/in-${n}.json`)} ${q(`${work}/out-${n}.json`)} ${q(world)} &`).join('\n')
  const ran = spawnSync('bash', ['-c', `${script}\nfailed=0; for job in $(jobs -p); do wait "$job" || failed=1; done; exit $failed`], {
    encoding: 'utf8', env: { ...process.env, HOME: `${work}/home`, CLAUDE_PLUGIN_DATA: `${work}/state` }, maxBuffer: 1 << 26,
  })
  if (ran.status !== 0) {
    throw new Error(`a corpus worker failed: ${ran.stderr.slice(0, 400)}`)
  }
  const parts = Array.from({ length: WORKERS }, (_, n) => JSON.parse(readFileSync(`${work}/out-${n}.json`, 'utf8')) as (string | null)[])

  return parts.flat()
}

function main(argv: readonly string[]): number {
  if (argv[0] === '--record') {
    const [, bundle, work, list] = argv
    if (bundle === undefined || work === undefined || list === undefined) {
      process.stderr.write('usage: bun tests/corpus.ts --record <reference bundle> <work folder> <list>\n')

      return 2
    }
    const lines = readFileSync(list, 'utf8').split('\n').filter(one => one !== '' && !one.startsWith('#')).map(one => one.replaceAll('⏎', '\n'))
    const verdicts = judgeAll(bundle, work, lines)
    process.stdout.write(lines.map((line, i) => JSON.stringify({ ref: verdicts[i] ?? null, line })).join('\n') + '\n')

    return 0
  }
  const [bundle, work] = argv
  if (bundle === undefined || work === undefined) {
    process.stderr.write('usage: bun tests/corpus.ts <bundle> <work folder>\n')

    return 2
  }
  const corpus = readFileSync(`${HERE}/corpus.jsonl`, 'utf8').split('\n').filter(one => one !== '').map(one => JSON.parse(one) as Entry)
  const now = judgeAll(bundle, work, corpus.map(one => one.line))
  const refused = corpus.filter(one => one.ref !== null && !one.ref.startsWith('recorded:'))
  const looser = corpus.flatMap((one, i) => (one.ref !== null && !one.ref.startsWith('recorded:') && (now[i] === null || now[i] === undefined || String(now[i]).startsWith('recorded:')) ? [{ ...one, now: now[i] ?? null }] : []))
  const unread = now.filter(one => one !== null && one.startsWith('unread:')).length
  for (const one of looser) {
    process.stdout.write(`FAIL corpus ${JSON.stringify(one.line)}: the reviewed bundle refused it (${one.ref ?? ''}), now ${one.now ?? 'allowed'}\n`)
  }
  process.stdout.write(`corpus: ${corpus.length} lines, ${refused.length} refused by the reviewed bundle, ${looser.length} of them allowed now, ${unread} unread\n`)

  return looser.length === 0 && unread === 0 ? 0 : 1
}

process.exitCode = main(process.argv.slice(2))
