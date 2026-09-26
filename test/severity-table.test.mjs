import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import {
  COMMAND_WORDS,
  DEFAULT_LIMITS,
  FIELD_POINTERS,
  PLACEHOLDER_VALUES,
  RULE_SEVERITY,
  SEVERITY_VALUES,
  STEP_FIELDS,
} from '../src/index.mjs'

const projectDirectory = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/**
 * Severity decides whether a run fails or passes, so it is the one thing in
 * this tool most worth pinning. Two dozen construction sites each carrying
 * their own literal is exactly the shape that drifts silently; these tests
 * assert the single table, the documented catalog and the shipped source all
 * agree, in both directions.
 */

async function readProjectFile(relativePath) {
  return readFile(resolve(projectDirectory, relativePath), 'utf8')
}

async function documentedSeverities() {
  const text = await readProjectFile('docs/runbook-rules.md')
  const rows = [...text.matchAll(/\|\s*`([a-z0-9-]+)`\s*\|\s*(error|warning|info)\s*\|/g)]
  return Object.fromEntries(rows.map((row) => [row[1], row[2]]))
}

test('the documented rule catalog matches the severity table exactly', async () => {
  const documented = await documentedSeverities()

  assert.equal(Object.keys(documented).length, 24)
  assert.deepEqual(
    Object.keys(documented).sort(),
    Object.keys(RULE_SEVERITY).sort(),
    'docs/runbook-rules.md and RULE_SEVERITY list different rules',
  )
  assert.deepEqual(documented, { ...RULE_SEVERITY })
})

test('every rule the source emits is defined in the severity table', async () => {
  const source = `${await readProjectFile('src/rules.mjs')}\n${await readProjectFile('src/index.mjs')}`
  const emitted = new Set([...source.matchAll(/ruleId:\s*'([a-z0-9-]+)'/g)].map((match) => match[1]))

  assert.equal(emitted.size > 18, true, 'the rule scan found suspiciously few construction sites')
  for (const ruleId of emitted) {
    assert.ok(Object.hasOwn(RULE_SEVERITY, ruleId), `${ruleId} is emitted but missing from RULE_SEVERITY`)
  }
})

test('no severity literal is written at a finding construction site', async () => {
  // A `severity:` beside a `ruleId:` is the defect this table exists to prevent:
  // it lets one rule be downgraded without the table, the docs or a test noticing.
  for (const path of ['src/rules.mjs', 'src/index.mjs', 'src/parse.mjs']) {
    const source = await readProjectFile(path)
    assert.equal(
      /severity:\s*'(error|warning|info)'/.test(source),
      false,
      `${path} writes a severity literal instead of reading RULE_SEVERITY`,
    )
  }
})

test('every rule severity is pinned here, rule by rule', () => {
  // The table and the documented catalog are asserted against each other, so a
  // coordinated edit to both agrees with itself and passes. This is the third
  // copy, written out by hand: a downgrade has to walk past an expectation that
  // shares no source with either of them. Downgrading any `error` below turns a
  // refusal into a green build -- a step with no recovery path, a command with
  // no boundary, or a document that was never read still reaches status pass.
  assert.deepEqual({ ...RULE_SEVERITY }, {
    'command-fence-unlabelled': 'warning',
    'command-in-prose': 'error',
    'command-inline-span': 'warning',
    'directory-too-deep': 'error',
    'document-field-not-inherited': 'warning',
    'document-not-utf8': 'error',
    'document-too-large': 'error',
    'document-unreadable': 'error',
    'fence-unterminated': 'error',
    'no-documents-found': 'warning',
    'no-steps-found': 'warning',
    'path-escapes-root': 'error',
    'step-expected-output-missing': 'error',
    'step-field-duplicate': 'warning',
    'step-field-misspelled': 'warning',
    'step-field-placeholder': 'warning',
    'step-heading-duplicate': 'warning',
    'step-numbering-gap': 'warning',
    'step-owner-missing': 'error',
    'step-prerequisites-missing': 'warning',
    'step-recovery-missing': 'error',
    'step-too-long': 'error',
    'too-many-documents': 'error',
    'too-many-steps': 'error',
  })
})

test('the rule that carries the acceptance evidence is an error, and stays one', () => {
  // "A step without recovery evidence is flagged." A warning here would leave a
  // runbook with no recovery path exiting 0.
  assert.equal(RULE_SEVERITY['step-recovery-missing'], 'error')
  assert.equal(RULE_SEVERITY['step-owner-missing'], 'error')
  assert.equal(RULE_SEVERITY['step-expected-output-missing'], 'error')
})

test('every table entry uses a severity the report contract defines', () => {
  for (const [ruleId, severity] of Object.entries(RULE_SEVERITY)) {
    assert.ok(SEVERITY_VALUES.includes(severity), `${ruleId} has severity ${severity}`)
  }
  assert.deepEqual([...SEVERITY_VALUES], ['error', 'warning', 'info'])
})

test('the severity table is frozen, so nothing can rewrite it at run time', () => {
  assert.equal(Object.isFrozen(RULE_SEVERITY), true)
  assert.throws(() => {
    'use strict'
    RULE_SEVERITY['step-recovery-missing'] = 'info'
  }, TypeError)
  assert.equal(RULE_SEVERITY['step-recovery-missing'], 'error')
})

test('the documented limits are the shipped limits', async () => {
  const text = await readProjectFile('docs/runbook-rules.md')
  const rows = [...text.matchAll(/\|\s*`(max[A-Za-z]+)`\s*\|\s*`(--[a-z-]+)`\s*\|\s*(\d+)\s*\|/g)]
  const documented = Object.fromEntries(rows.map((row) => [row[1], Number(row[3])]))

  assert.deepEqual(documented, { ...DEFAULT_LIMITS })

  const help = await readProjectFile('bin/runbook-step-linter.mjs')
  for (const row of rows) {
    assert.equal(help.includes(row[2]), true, `${row[2]} is documented but not offered by the CLI`)
  }
})

test('the documented field vocabulary is the shipped field vocabulary', async () => {
  const text = await readProjectFile('docs/runbook-rules.md')
  for (const label of Object.keys(STEP_FIELDS)) {
    assert.equal(text.includes(`\`${label}\``), true, `label "${label}" is accepted but not documented`)
  }
  assert.equal(text.includes('`postconditions`'), false, 'the docs name a label the tool does not accept')
  assert.deepEqual(Object.keys(FIELD_POINTERS).sort(), [...new Set(Object.values(STEP_FIELDS))].sort())
})

test('the documented command vocabulary is the shipped command vocabulary', async () => {
  const text = await readProjectFile('docs/runbook-rules.md')
  const section = text.slice(text.indexOf('The command vocabulary'), text.indexOf('Matching is **case-sensitive**'))
  const documented = [...section.matchAll(/`([a-z0-9_]+)`/g)].map((match) => match[1]).sort()

  assert.deepEqual(documented, [...COMMAND_WORDS].sort())
})

test('the documented placeholder values are the shipped placeholder values', async () => {
  const text = await readProjectFile('docs/runbook-rules.md')
  for (const value of PLACEHOLDER_VALUES) {
    assert.equal(text.includes(`\`${value}\``), true, `placeholder "${value}" is enforced but not documented`)
  }
  assert.equal(PLACEHOLDER_VALUES.includes('none'), false, 'the docs promise that "none" is an explicit answer')
  assert.equal(text.includes('`none` is deliberately **not** in that list'), true)
})
