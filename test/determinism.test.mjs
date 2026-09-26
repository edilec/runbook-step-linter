import assert from 'node:assert/strict'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import { byCodeUnit, formatReport, lintRunbooks } from '../src/index.mjs'

const projectDirectory = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const CLEAN_ROOT = join(projectDirectory, 'examples/runbook-clean')
const BROKEN_ROOT = join(projectDirectory, 'examples/runbook-broken')

/**
 * Two runs inside one process and one locale agree with each other whatever the
 * comparator does, so a "run it twice" test alone proves very little. These
 * tests pin the properties themselves: the comparator's ordering against pairs
 * an English collator orders the other way, the sort that stands between
 * directory enumeration and the report, and the absence of every non-
 * deterministic input from the shipped source.
 */

const STEP = [
  '## 1. Cordon the node',
  '',
  '- **Owner:** platform-oncall',
  '- **Prerequisites:** cluster access confirmed',
  '- **Expected output:** the node reports SchedulingDisabled',
  '- **Recovery:** uncordon the node and stop',
  '',
].join('\n')

async function shippedSource() {
  const parts = []
  for (const directory of ['src', 'bin']) {
    for (const name of await readdir(join(projectDirectory, directory))) {
      parts.push(await readFile(join(projectDirectory, directory, name), 'utf8'))
    }
  }
  return parts.join('\n')
}

test('two runs over the same bytes produce byte-identical output', async () => {
  const first = await lintRunbooks({ root: BROKEN_ROOT })
  const second = await lintRunbooks({ root: BROKEN_ROOT })

  assert.equal(JSON.stringify(first), JSON.stringify(second))
  assert.equal(formatReport(first), formatReport(second))
  assert.equal(first.findings.length > 10, true, 'the comparison is over a report with something in it')
})

test('the comparator disagrees with an English collator wherever they differ', () => {
  const collator = new Intl.Collator('en')
  // Pairs the comparator orders one way and an English collator the other. If
  // byCodeUnit ever became localeCompare, every assertion below flips.
  for (const [left, right] of [
    ['MAX_DUPLICATE_URLS', 'MAX_DUPLICATE_URL_ENTRIES'],
    ['URLS.md', 'URL_ENTRIES.md'],
    ['Zebra', 'apple'],
  ]) {
    assert.equal(byCodeUnit(left, right), -1, `${left} must precede ${right} by code unit`)
    assert.equal(collator.compare(left, right) > 0, true, `the collator puts ${right} first, which is the disagreement being pinned`)
  }
  for (const [left, right] of [['step_two', 'stepTwo'], ['a_b', 'aB']]) {
    assert.equal(byCodeUnit(left, right), 1, `${right} must precede ${left} by code unit`)
    assert.equal(collator.compare(left, right) < 0, true, 'the collator disagrees in this direction too')
  }
})

test('directory entries are ordered by code unit, not by collation', async () => {
  const base = await mkdtemp(join(tmpdir(), 'runbook-step-linter-order-'))
  try {
    // `S` (0x53) precedes `_` (0x5F) by code point, while an English collator
    // treats the underscore as ignorable and puts URL_ENTRIES first. The report
    // must follow the code units.
    await writeFile(join(base, 'URL_ENTRIES.md'), `${STEP}\nsudo systemctl stop api\n`)
    await writeFile(join(base, 'URLS.md'), `${STEP}\nsudo systemctl stop api\n`)

    const report = await lintRunbooks({ root: base })
    const files = report.findings.map((finding) => finding.location.file)

    assert.deepEqual(files, ['URLS.md', 'URL_ENTRIES.md'])
    assert.equal(new Intl.Collator('en').compare('URLS.md', 'URL_ENTRIES.md') > 0, true, 'a collator would have ordered these the other way')
  } finally {
    await rm(base, { recursive: true, force: true })
  }
})

/**
 * Defect class: code-unit ordering defended by grepping the source for the
 * literal `localeCompare`. `Intl.Collator` collates identically and spells
 * differently, so the grep passes while the walk order silently becomes
 * dependent on the ICU data of whatever Node build is running.
 *
 * The walk order is not cosmetic: it decides which document survives a
 * document-count cut-off, and therefore which document is linted at all. Both
 * pairs below are ordered one way by code unit and the other way by an English
 * collator, so substituting one comparator for the other changes which file
 * appears in the report.
 */
test('the document-count cut-off follows code units, not collation', async () => {
  const collator = new Intl.Collator('en')
  const bare = '## 1. Do the thing\n\nNothing is stated here.\n'

  for (const [first, second] of [['URLS.md', 'URL_ENTRIES.md'], ['Zebra.md', 'apple.md']]) {
    assert.equal(byCodeUnit(first, second), -1, `${first} precedes ${second} by code unit`)
    assert.equal(collator.compare(first, second) > 0, true, 'and a collator puts it second, which is the disagreement being pinned')

    const base = await mkdtemp(join(tmpdir(), 'runbook-step-linter-cutoff-'))
    try {
      await writeFile(join(base, second), bare)
      await writeFile(join(base, first), bare)

      const report = await lintRunbooks({ root: base, limits: { maxDocuments: 1 } })
      const linted = [...new Set(
        report.findings.filter((finding) => finding.ruleId === 'step-recovery-missing').map((finding) => finding.location.file),
      )]
      const stopped = report.findings.filter((finding) => finding.ruleId === 'too-many-documents')

      assert.deepEqual(linted, [first], `the walk must lint ${first} and never reach ${second}`)
      assert.equal(stopped.length, 1)
      assert.equal(stopped[0].location.file, second, 'and must stop at the next entry in code-unit order')
      assert.equal(report.status, 'incomplete')
    } finally {
      await rm(base, { recursive: true, force: true })
    }
  }
})

/**
 * A secondary guard, and only that. The tests above are what actually pin the
 * ordering: a source scan cannot tell a comparator apart from its replacement,
 * and `Intl.Collator` was exactly that replacement -- identical drift,
 * different spelling. Both spellings are named here because there is no
 * legitimate use for either in a tool whose output must not move with the ICU
 * data of the Node build that happens to run it.
 */
test('the shipped source never reaches for a locale-aware comparison', async () => {
  const source = await shippedSource()
  assert.equal(source.includes('localeCompare'), false, 'localeCompare depends on ICU data that varies between Node builds')
  assert.equal(/\bIntl\b/.test(source), false, 'Intl.Collator drifts exactly as localeCompare does')
  assert.equal(/\btoLocale(?:Lower|Upper)Case\b/.test(source), false, 'locale-aware case folding drifts too')
})

test('the shipped source reads no clock, no random source and no environment', async () => {
  const source = await shippedSource()
  assert.equal(/\bnew\s+Date\b/.test(source), false, 'a wall clock in the output breaks byte-identical runs')
  assert.equal(/\bDate\.now\s*\(/.test(source), false)
  assert.equal(/\bMath\.random\s*\(/.test(source), false)
  assert.equal(/\bprocess\.env\b/.test(source), false)
  assert.equal(/\bperformance\.now\s*\(/.test(source), false)
})

test('the shipped source opens no network connection of any kind', async () => {
  const source = await shippedSource()
  const forbidden = ['node:net', 'node:http', 'node:https', 'node:dns', 'node:tls', 'fetch(', 'XMLHttpRequest']
  for (const name of forbidden) {
    assert.equal(source.includes(name), false, `the source reaches for ${name}`)
  }
})

test('the clean example is stable and the broken example is stable, separately', async () => {
  const clean = await lintRunbooks({ root: CLEAN_ROOT })
  const broken = await lintRunbooks({ root: BROKEN_ROOT })

  assert.equal(clean.status, 'pass')
  assert.equal(broken.status, 'fail')
  assert.notEqual(JSON.stringify(clean.findings), JSON.stringify(broken.findings))
  assert.equal(JSON.stringify(await lintRunbooks({ root: CLEAN_ROOT })), JSON.stringify(clean))
})
