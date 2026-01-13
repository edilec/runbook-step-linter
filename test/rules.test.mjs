import assert from 'node:assert/strict'
import test from 'node:test'

import { lintRunbookText } from '../src/index.mjs'
import { RULE_SEVERITY, createFinding, isPlaceholder, sortRows } from '../src/rules.mjs'

const LINE_SEPARATOR = String.fromCharCode(0x2028)

function ids(report) {
  return report.findings.map((finding) => finding.ruleId)
}

function find(report, ruleId) {
  return report.findings.filter((finding) => finding.ruleId === ruleId)
}

const COMPLETE_STEP = [
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

test('a fully documented step produces no finding at all', () => {
  const report = lintRunbookText(COMPLETE_STEP, { file: 'clean.md' })
  assert.deepEqual(report.findings, [])
  assert.equal(report.status, 'pass')
  assert.equal(report.summary.checked, 1)
  assert.equal(report.summary.stepsWithRecovery, 1)
})

/**
 * The acceptance evidence for this tool, stated three ways: absent, misspelled,
 * and present-but-a-placeholder. All three are "no recovery evidence", and all
 * three must fail the run.
 */
test('a step with no recovery field is flagged as an error and fails the run', () => {
  const text = COMPLETE_STEP.replace('- **Recovery:** uncordon the node and stop\n', '')
  const report = lintRunbookText(text, { file: 'no-recovery.md' })
  const flagged = find(report, 'step-recovery-missing')

  assert.equal(flagged.length, 1)
  assert.equal(flagged[0].severity, 'error')
  assert.equal(flagged[0].location.file, 'no-recovery.md')
  assert.equal(flagged[0].location.pointer, '/steps/1/recovery')
  assert.equal(report.status, 'fail')
  assert.equal(report.summary.stepsWithRecovery, 0)
  assert.equal(report.summary.stepsWithOwner, 1, 'the other requirements were still satisfied')
})

test('a near-miss recovery label satisfies nothing, so the step is still flagged', () => {
  const text = COMPLETE_STEP.replace('**Recovery:**', '**Recovry:**')
  const report = lintRunbookText(text, { file: 'typo.md' })

  assert.equal(find(report, 'step-recovery-missing').length, 1, 'a one-character typo must not turn a real failure green')
  assert.equal(find(report, 'step-field-misspelled').length, 1)
  assert.equal(find(report, 'step-field-misspelled')[0].evidence.includes('Recovry'), true)
  assert.equal(report.status, 'fail')
  assert.equal(report.summary.stepsWithRecovery, 0)
})

test('a near-miss field written as a sub-heading also satisfies nothing', () => {
  // The same guarantee on the other parsing path. A label can be written as a
  // line or as a sub-heading, and a typo has to fail to satisfy on both.
  const text = COMPLETE_STEP.replace(
    '- **Recovery:** uncordon the node and stop\n',
    '\n### Recovry\n\nUncordon the node and stop.\n',
  )
  const report = lintRunbookText(text, { file: 'heading-typo.md' })

  assert.equal(find(report, 'step-recovery-missing').length, 1)
  assert.equal(find(report, 'step-field-misspelled').length, 1)
  assert.equal(find(report, 'step-field-misspelled')[0].location.pointer, '/steps/1/recovery')
  assert.equal(report.summary.stepsWithRecovery, 0)
  assert.equal(report.status, 'fail')
})

test('a correctly spelled sub-heading field does satisfy the requirement', () => {
  // The counterpart, so the test above is about the spelling and not about the
  // heading shape being ignored wholesale.
  const text = COMPLETE_STEP.replace(
    '- **Recovery:** uncordon the node and stop\n',
    '\n### Recovery\n\nUncordon the node and stop.\n',
  )
  const report = lintRunbookText(text, { file: 'heading-ok.md' })

  assert.deepEqual(report.findings, [])
  assert.equal(report.summary.stepsWithRecovery, 1)
})

test('a placeholder recovery value satisfies nothing, so the step is still flagged', () => {
  const text = COMPLETE_STEP.replace('uncordon the node and stop', 'TBD')
  const report = lintRunbookText(text, { file: 'tbd.md' })

  assert.equal(find(report, 'step-recovery-missing').length, 1)
  assert.equal(find(report, 'step-field-placeholder').length, 1)
  assert.equal(report.summary.stepsWithRecovery, 0)
  assert.equal(report.status, 'fail')
})

test('"none" is an explicit answer and is accepted, unlike a placeholder', () => {
  const text = COMPLETE_STEP.replace('cluster access confirmed', 'none')
  const report = lintRunbookText(text, { file: 'none.md' })

  assert.deepEqual(report.findings, [])
  assert.equal(report.summary.stepsWithPrerequisites, 1)
  assert.equal(isPlaceholder('none'), false)
  assert.equal(isPlaceholder('TBD'), true)
  assert.equal(isPlaceholder('  '), true)
  assert.equal(isPlaceholder('???'), true)
})

test('each of the four requirements has its own rule and its own severity', () => {
  const report = lintRunbookText('## 1. Do the thing\n\nNothing is stated here.\n', { file: 'bare.md' })
  const bySeverity = Object.fromEntries(report.findings.map((finding) => [finding.ruleId, finding.severity]))

  assert.deepEqual(bySeverity, {
    'step-expected-output-missing': 'error',
    'step-owner-missing': 'error',
    'step-prerequisites-missing': 'warning',
    'step-recovery-missing': 'error',
  })
  assert.equal(report.summary.errors, 3)
  assert.equal(report.summary.warnings, 1)
  assert.equal(report.status, 'fail')
})

test('a document owner is inherited by every step, and the other fields are not', () => {
  const text = [
    'Owner: platform-oncall',
    'Recovery: page the lead',
    '',
    COMPLETE_STEP.replace('- **Owner:** platform-oncall\n', '').replace('- **Recovery:** uncordon the node and stop\n', ''),
  ].join('\n')
  const report = lintRunbookText(text, { file: 'inherited.md' })

  assert.equal(find(report, 'step-owner-missing').length, 0, 'owner is inherited')
  assert.equal(report.summary.stepsWithOwner, 1)
  assert.equal(find(report, 'step-recovery-missing').length, 1, 'recovery is step-specific and is not inherited')
  assert.equal(find(report, 'document-field-not-inherited').length, 1)
  assert.equal(find(report, 'document-field-not-inherited')[0].location.pointer, '/preamble/recovery')
})

test('a placeholder document owner does not silently cover every step', () => {
  const text = ['Owner: TBD', '', COMPLETE_STEP.replace('- **Owner:** platform-oncall\n', '')].join('\n')
  const report = lintRunbookText(text, { file: 'tbd-owner.md' })

  assert.equal(find(report, 'step-owner-missing').length, 1)
  assert.equal(find(report, 'step-field-placeholder')[0].location.pointer, '/preamble/owner')
  assert.equal(report.summary.stepsWithOwner, 0)
})

test('a command in prose is an error and a command in an inline span is a warning', () => {
  const text = [
    COMPLETE_STEP,
    '## 2. Clear the spool',
    '',
    '- **Owner:** ingest-oncall',
    '- **Prerequisites:** step 1 finished',
    '- **Expected output:** the spool is empty',
    '- **Recovery:** the spool is a cache and rebuilds itself',
    '',
    'rm -rf /var/lib/ingest/spool',
    '',
    'Then run `systemctl start edilec-ingest` to bring it back.',
    '',
  ].join('\n')
  const report = lintRunbookText(text, { file: 'commands.md' })

  const prose = find(report, 'command-in-prose')
  assert.equal(prose.length, 1)
  assert.equal(prose[0].severity, 'error')
  assert.equal(prose[0].location.pointer, '/steps/2/commands')
  assert.equal(prose[0].evidence, 'rm -rf /var/lib/ingest/spool', 'the command is quoted back, and that is all that happens to it')

  const inline = find(report, 'command-inline-span')
  assert.equal(inline.length, 1)
  assert.equal(inline[0].severity, 'warning')
  assert.equal(report.summary.looseCommands, 2)
})

test('an unlabelled fence is reported and a labelled one is not', () => {
  const unlabelled = lintRunbookText(COMPLETE_STEP.replace('```sh', '```'), { file: 'fence.md' })
  assert.equal(find(unlabelled, 'command-fence-unlabelled').length, 1)
  assert.equal(unlabelled.summary.fencedCommands, 1)

  const labelled = lintRunbookText(COMPLETE_STEP, { file: 'fence.md' })
  assert.equal(find(labelled, 'command-fence-unlabelled').length, 0)
})

test('a requirement declared twice is reported and the first declaration is the one used', () => {
  const text = COMPLETE_STEP.replace(
    '- **Owner:** platform-oncall\n',
    '- **Owner:** platform-oncall\n- **Owner:** whoever is around\n',
  )
  const report = lintRunbookText(text, { file: 'twice.md' })
  const duplicate = find(report, 'step-field-duplicate')

  assert.equal(duplicate.length, 1)
  assert.equal(duplicate[0].line, 4, 'the second declaration is the one reported')
  assert.equal(find(report, 'step-owner-missing').length, 0)
})

test('a placeholder in the first declaration is not rescued by a later restatement', () => {
  const text = COMPLETE_STEP.replace(
    '- **Owner:** platform-oncall\n',
    '- **Owner:** TBD\n- **Owner:** platform-oncall\n',
  )
  const report = lintRunbookText(text, { file: 'rescue.md' })

  assert.equal(find(report, 'step-owner-missing').length, 1)
  assert.equal(report.summary.stepsWithOwner, 0)
})

test('duplicate step headings and a numbering gap are both reported', () => {
  const text = [
    '## 1. Promote the replica',
    '',
    '- **Owner:** data-oncall',
    '- **Prerequisites:** the primary is unreachable',
    '- **Expected output:** the replica accepts a write',
    '- **Recovery:** demote the replica',
    '',
    '## 3. Promote the replica',
    '',
    '- **Owner:** data-oncall',
    '- **Prerequisites:** step 1 finished',
    '- **Expected output:** writers point at the new primary',
    '- **Recovery:** repoint writers back',
    '',
  ].join('\n')
  const report = lintRunbookText(text, { file: 'dup.md' })

  assert.equal(find(report, 'step-heading-duplicate').length, 1)
  assert.equal(find(report, 'step-heading-duplicate')[0].location.pointer, '/steps/2')
  assert.equal(find(report, 'step-numbering-gap').length, 1)
  assert.equal(report.status, 'pass', 'both are warnings, so a documented set of steps still passes')
})

test('numbering is only checked when every step heading carries a number', () => {
  const text = ['## Start here', '', 'Owner: me', '', '## 4. Then this', '', 'Owner: me', ''].join('\n')
  const report = lintRunbookText(text, { file: 'mixed.md' })
  assert.equal(find(report, 'step-numbering-gap').length, 0)
})

test('createFinding throws on a rule that nobody pinned a severity for', () => {
  assert.throws(
    () => createFinding({ ruleId: 'not-a-rule', message: 'x', file: 'a.md', pointer: '/', line: 0 }),
    /not in RULE_SEVERITY/,
  )
  assert.equal(createFinding({ ruleId: 'step-recovery-missing', message: 'x', file: 'a.md', pointer: '/', line: 0 }).severity, 'error')
})

test('createFinding sanitises identifiers and paths, not only evidence', () => {
  // The catalog defect: a tool sanitised evidence but not identifiers, so an id
  // containing a newline forged extra lines in the human report.
  const finding = createFinding({
    ruleId: 'step-recovery-missing',
    message: `broken\nERROR forged message`,
    file: `a.md\nERROR forged.md`,
    pointer: `/steps/1${LINE_SEPARATOR}/forged`,
    line: 3,
    evidence: 'title\nsecond line',
    suggestion: 'do\nthis',
  })

  for (const value of [finding.message, finding.location.file, finding.location.pointer, finding.evidence, finding.suggestion]) {
    assert.equal(/[\n\r]/.test(value), false, `${value} still carries a line break`)
    assert.equal(value.includes(LINE_SEPARATOR), false)
  }
  assert.equal(finding.location.file, 'a.md ERROR forged.md')
})

test('a step heading carrying a newline cannot forge a line in the human report', () => {
  const report = lintRunbookText('## 1. Do it\n\nnothing\n', { file: `a.md\nERROR forged` })
  assert.equal(report.findings.length > 0, true)
  for (const finding of report.findings) {
    assert.equal(finding.location.file, 'a.md ERROR forged')
  }
})

test('findings sort by file, then line, then pointer, rule and message', () => {
  const rows = [
    { file: 'b.md', line: 1, pointer: '/', ruleId: 'x', message: 'm' },
    { file: 'a.md', line: 9, pointer: '/', ruleId: 'x', message: 'm' },
    { file: 'a.md', line: 2, pointer: '/steps/2', ruleId: 'x', message: 'm' },
    { file: 'a.md', line: 2, pointer: '/steps/1', ruleId: 'x', message: 'm' },
    { file: 'a.md', line: 2, pointer: '/steps/1', ruleId: 'a', message: 'm' },
  ]
  const sorted = sortRows([...rows]).map((row) => `${row.file}:${row.line}${row.pointer}:${row.ruleId}`)

  assert.deepEqual(sorted, [
    'a.md:2/steps/1:a',
    'a.md:2/steps/1:x',
    'a.md:2/steps/2:x',
    'a.md:9/:x',
    'b.md:1/:x',
  ])
})

/**
 * Defect class: ordering held only by a source grep for `localeCompare`. Each
 * key of the finding sort is pinned here against a pair the two comparators
 * order differently, so substituting `Intl.Collator` -- identical drift,
 * different spelling -- changes the emitted order and fails this test.
 *
 * `sortRows` is exported, and the rows it is given carry untrusted strings, so
 * these pairs are not hypothetical: a file name really can be `Zebra.md` next
 * to `apple.md`, and a message really can quote a label written `a-b` next to
 * one written `a_b`.
 */
test('every key of the finding sort orders by code unit, not by collation', () => {
  const collator = new Intl.Collator('en')
  const base = { file: 'a.md', line: 1, pointer: '/steps/1', ruleId: 'step-owner-missing', message: 'm' }
  const cases = [
    { key: 'file', first: 'Zebra.md', second: 'apple.md' },
    { key: 'pointer', first: '/steps/1/URLS', second: '/steps/1/URL_ENTRIES' },
    { key: 'ruleId', first: 'step-two', second: 'step_two' },
    { key: 'message', first: 'a-b restates it', second: 'a_b restates it' },
  ]

  for (const { key, first, second } of cases) {
    assert.equal(first < second, true, `${first} precedes ${second} by code unit`)
    assert.equal(collator.compare(first, second) > 0, true, `a collator puts ${second} first, which is the disagreement being pinned`)

    const rows = [{ ...base, [key]: second }, { ...base, [key]: first }]
    assert.deepEqual(
      sortRows(rows).map((row) => row[key]),
      [first, second],
      `the ${key} tiebreak stopped comparing code units`,
    )
  }
})

test('the sort puts the lower line first whatever the line numbers look like as text', () => {
  const base = { file: 'a.md', pointer: '/', ruleId: 'step-owner-missing', message: 'm' }
  const rows = [{ ...base, line: 100 }, { ...base, line: 9 }, { ...base, line: 10 }]
  assert.deepEqual(sortRows(rows).map((row) => row.line), [9, 10, 100], 'lines are numbers, not strings')
})

test('the report envelope matches the Edilec report contract', () => {
  const report = lintRunbookText(COMPLETE_STEP, { file: 'clean.md' })
  assert.equal(report.schemaVersion, '1')
  assert.equal(report.tool, 'runbook-step-linter')
  assert.equal(Array.isArray(report.findings), true)
  for (const key of ['checked', 'errors', 'warnings']) {
    assert.equal(Number.isInteger(report.summary[key]), true, `${key} must be an integer`)
  }
})

test('lintRunbookText refuses an unknown option instead of ignoring it', () => {
  assert.throws(() => lintRunbookText('## 1. a\n', { stepLevl: 3 }), /Unknown option "stepLevl"/)
  assert.throws(() => lintRunbookText('## 1. a\n', { limits: { maxStep: 2 } }), /Unknown limit "maxStep"/)
  assert.throws(() => lintRunbookText('## 1. a\n', { stepLevel: 9 }), /between 1 and 6/)
  assert.throws(() => lintRunbookText(Buffer.from('x')), /must be a string/)
})

test('every rule id used anywhere in this suite is a rule the table knows', () => {
  const report = lintRunbookText('## 1. Do it\n\nnothing\n', { file: 'a.md' })
  for (const ruleId of ids(report)) {
    assert.equal(Object.hasOwn(RULE_SEVERITY, ruleId), true, `${ruleId} is emitted but unpinned`)
  }
})
