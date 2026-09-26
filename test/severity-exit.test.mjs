import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

import { RULE_SEVERITY } from '../src/index.mjs'

const run = promisify(execFile)
const projectDirectory = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const CLI = join(projectDirectory, 'bin/runbook-step-linter.mjs')

/**
 * Severity, pinned by what actually happens.
 *
 * `test/severity-table.test.mjs` asserts the table against the documented
 * catalog and against a hand-written copy. That is worth having, but it is
 * three declarations agreeing with each other: an edit that changes all three
 * at once passes every one of those assertions, and a rule quietly demoted
 * from `error` to `warning` reaches exit 0 with the suite green.
 *
 * These tests assert the consequence instead. Each case builds a root that
 * isolates one rule, runs the real binary, and pins the exact set of rules
 * raised, the report status and the process exit code. A demotion changes the
 * observable outcome -- `fail` becomes `pass`, exit 1 becomes exit 0 -- so no
 * coordinated edit to the table, the docs and a test map can satisfy it.
 *
 * The table stays the single source of truth. What stops being the test is the
 * table agreeing with a copy of itself.
 */

const CLEAN_STEP = [
  '## 1. Cordon the node',
  '',
  '- **Owner:** platform-oncall',
  '- **Prerequisites:** cluster access confirmed',
  '- **Expected output:** the node reports SchedulingDisabled',
  '- **Recovery:** uncordon the node and stop',
  '',
  '```sh',
  'kubectl cordon node-7',
  '```',
  '',
].join('\n')

function withoutLine(fragment) {
  const line = CLEAN_STEP.split('\n').find((row) => row.includes(fragment))
  return CLEAN_STEP.replace(`${line}\n`, '')
}

async function withBase(body) {
  const base = await mkdtemp(join(tmpdir(), 'runbook-step-linter-severity-'))
  try {
    return await body(base)
  } finally {
    await rm(base, { recursive: true, force: true })
  }
}

/** Build the case's root, run the real binary over it, and report what happened. */
async function lint(build) {
  return withBase(async (base) => {
    const root = await build(base)
    try {
      const { stdout } = await run(process.execPath, [CLI, '--root', root, '--json'], { cwd: projectDirectory })
      return { code: 0, report: JSON.parse(stdout) }
    } catch (error) {
      return { code: error.code, report: JSON.parse(error.stdout) }
    }
  })
}

/** A root holding exactly one document. */
function singleDocument(text, name = 'drain.md') {
  return async (base) => {
    await writeFile(join(base, name), text)
    return base
  }
}

/**
 * Every error rule whose severity alone decides the verdict. The rest of the
 * error rules -- directory-too-deep, document-not-utf8, document-too-large,
 * document-unreadable, fence-unterminated, step-too-long, too-many-documents,
 * too-many-steps -- are backstopped by the `incomplete` flag, so they exit 2
 * whatever their severity says, and their own tests pin that exit code. These
 * eight have no second line of defence: severity is the whole of it.
 */
const FAILING = [
  {
    ruleId: 'step-recovery-missing',
    raised: ['step-recovery-missing'],
    build: singleDocument(withoutLine('**Recovery:**')),
  },
  {
    ruleId: 'step-owner-missing',
    raised: ['step-owner-missing'],
    build: singleDocument(withoutLine('**Owner:**')),
  },
  {
    ruleId: 'step-expected-output-missing',
    raised: ['step-expected-output-missing'],
    build: singleDocument(withoutLine('**Expected output:**')),
  },
  {
    ruleId: 'command-in-prose',
    raised: ['command-in-prose'],
    build: singleDocument(`${CLEAN_STEP}sudo systemctl stop edilec-ingest\n`),
  },
  {
    // Refused unread, and nothing else in the run is wrong. Severity is the
    // only thing keeping this run out of a pass: unlike every other error rule
    // on a refusal path, this one does not set the incomplete flag.
    ruleId: 'path-escapes-root',
    raised: ['path-escapes-root'],
    build: async (base) => {
      const root = join(base, 'runbooks')
      const outside = join(base, 'outside')
      await mkdir(root)
      await mkdir(outside)
      await writeFile(join(outside, 'secret.md'), `${CLEAN_STEP}OUTSIDE_CONTENT_MARKER\n`)
      await writeFile(join(root, 'real.md'), CLEAN_STEP)
      await symlink(join(outside, 'secret.md'), join(root, 'escape.md'))
      return root
    },
  },
]

for (const item of FAILING) {
  test(`${item.ruleId} fails the run and exits 1, whatever a table says`, async () => {
    const { code, report } = await lint(item.build)
    const raised = [...new Set(report.findings.map((finding) => finding.ruleId))].sort()

    assert.deepEqual(raised, [...item.raised].sort(), 'the fixture must isolate the rule under test')
    assert.equal(report.status, 'fail', `${item.ruleId} must fail the run`)
    assert.equal(code, 1, `${item.ruleId} must exit 1`)
    assert.equal(report.summary.errors > 0, true)
    assert.equal(RULE_SEVERITY[item.ruleId], 'error', 'and the table must still say so')
  })
}

/**
 * The other direction, which is the half a severity table usually forgets: a
 * warning must not fail the run either. Promoting one of these to `error`
 * turns a runbook that is merely untidy into a broken build, and the table
 * agreeing with a copy of itself would never show it.
 */
const PASSING = [
  {
    ruleId: 'step-prerequisites-missing',
    raised: ['step-prerequisites-missing'],
    build: singleDocument(withoutLine('**Prerequisites:**')),
  },
  {
    ruleId: 'step-field-placeholder',
    raised: ['step-field-placeholder', 'step-prerequisites-missing'],
    build: singleDocument(CLEAN_STEP.replace('cluster access confirmed', 'TBD')),
  },
  {
    ruleId: 'step-field-misspelled',
    raised: ['step-field-misspelled'],
    build: singleDocument(CLEAN_STEP.replace(
      '- **Recovery:** uncordon the node and stop\n',
      '- **Recovery:** uncordon the node and stop\n- **Recovry:** and page the lead\n',
    )),
  },
  {
    ruleId: 'command-inline-span',
    raised: ['command-inline-span'],
    build: singleDocument(`${CLEAN_STEP}Then run \`kubectl drain node-7 --force\` and wait.\n`),
  },
  {
    ruleId: 'command-fence-unlabelled',
    raised: ['command-fence-unlabelled'],
    build: singleDocument(CLEAN_STEP.replace('```sh', '```')),
  },
  {
    ruleId: 'document-field-not-inherited',
    raised: ['document-field-not-inherited'],
    build: singleDocument(`Recovery: restore from the nightly backup\n\n${CLEAN_STEP}`),
  },
  {
    ruleId: 'step-heading-duplicate',
    raised: ['step-heading-duplicate', 'step-numbering-gap'],
    build: singleDocument(`${CLEAN_STEP}\n${CLEAN_STEP}`),
  },
  {
    ruleId: 'step-numbering-gap',
    raised: ['step-heading-duplicate', 'step-numbering-gap'],
    build: singleDocument(`${CLEAN_STEP}\n${CLEAN_STEP}`),
  },
]

for (const item of PASSING) {
  test(`${item.ruleId} is reported without failing the run, and exits 0`, async () => {
    const { code, report } = await lint(item.build)
    const raised = [...new Set(report.findings.map((finding) => finding.ruleId))].sort()

    assert.deepEqual(raised, [...item.raised].sort(), 'the fixture must isolate the rule under test')
    assert.equal(report.findings.some((finding) => finding.ruleId === item.ruleId), true)
    assert.equal(report.status, 'pass', `${item.ruleId} must not fail the run`)
    assert.equal(code, 0, `${item.ruleId} must exit 0`)
    assert.equal(report.summary.errors, 0)
    assert.equal(RULE_SEVERITY[item.ruleId], 'warning', 'and the table must still say so')
  })
}

test('the clean fixture these cases are cut from raises nothing at all', async () => {
  const { code, report } = await lint(singleDocument(CLEAN_STEP))

  assert.deepEqual(report.findings, [], 'otherwise every case above is measuring the wrong thing')
  assert.equal(report.status, 'pass')
  assert.equal(code, 0)
  assert.equal(report.summary.checked, 1)
})

test('every rule that decides pass or fail by severity alone is pinned above', () => {
  // The list of error rules this file drives through the binary, against the
  // table. A new error rule that nobody pins here has to be added to one list
  // or the other, deliberately.
  const backstopped = [
    'directory-too-deep',
    'document-not-utf8',
    'document-too-large',
    'document-unreadable',
    'fence-unterminated',
    'step-too-long',
    'too-many-documents',
    'too-many-steps',
  ]
  const errors = Object.entries(RULE_SEVERITY)
    .filter(([, severity]) => severity === 'error')
    .map(([ruleId]) => ruleId)
    .sort()

  assert.deepEqual(errors, [...FAILING.map((item) => item.ruleId), ...backstopped].sort())
})
