import assert from 'node:assert/strict'
import test from 'node:test'

import {
  COMMAND_WORDS,
  EXCERPT_LIMIT,
  FIELD_LABELS,
  STEP_FIELDS,
  byCodeUnit,
  decodeUtf8,
  displayLabel,
  editDistance,
  excerpt,
  nearestLabel,
  normalizeLabel,
  normalizeTitle,
  parseFieldLine,
  parseRunbook,
  scanCommands,
} from '../src/parse.mjs'

const LINE_SEPARATOR = String.fromCharCode(0x2028)
const PARAGRAPH_SEPARATOR = String.fromCharCode(0x2029)

test('byCodeUnit orders by code unit, disagreeing with an English collator where they differ', () => {
  // The documented catalog defect: `S` (0x53) precedes `_` (0x5F) by code point,
  // while collation treats the underscore as ignorable punctuation. If this
  // comparator ever became localeCompare, this assertion flips.
  const left = 'MAX_DUPLICATE_URLS'
  const right = 'MAX_DUPLICATE_URL_ENTRIES'
  const collator = new Intl.Collator('en')

  assert.equal(byCodeUnit(left, right), -1, 'by code unit S (0x53) precedes _ (0x5F)')
  assert.equal(collator.compare(left, right) > 0, true, 'the collator disagrees, which is the point')
  assert.equal(byCodeUnit(right, left), 1)
  assert.equal(byCodeUnit(left, left), 0)
})

test('byCodeUnit sorts a list the way the report documents', () => {
  const sorted = ['Zebra', 'apple', 'Apple', 'banana'].sort(byCodeUnit)
  assert.deepEqual(sorted, ['Apple', 'Zebra', 'apple', 'banana'])
})

test('excerpt flattens newlines, tabs and the separator characters that forge report lines', () => {
  const forged = `owner\nERROR forged line\ttail`
  assert.equal(excerpt(forged), 'owner ERROR forged line tail')
  assert.equal(excerpt(`a${LINE_SEPARATOR}b`), 'a b')
  assert.equal(excerpt(`a${PARAGRAPH_SEPARATOR}b`), 'a b')
  assert.equal(excerpt(`a${String.fromCharCode(0)}b`), 'a b')
  assert.equal(excerpt('  spaced   out  '), 'spaced out')
})

/**
 * Defect class: a sanitisation class that covers the characters everybody
 * remembers and lets the rest through. C0 and the two separators are the ones
 * every tool strips; the C1 range is the one that gets forgotten, and it holds
 * U+0085 NEL -- a line break to a great many readers -- and U+009B, the 8-bit
 * CSI that opens a terminal control sequence with no ESC in sight. The bidi
 * overrides are worse still: U+202E reverses everything displayed after it, so
 * a path or a rule id can be made to read as something else entirely.
 *
 * Each class is asserted separately, so removing any one of them from the
 * character class fails a named assertion rather than a single lump.
 */
test('excerpt removes every class of character that can forge or reverse a report line', () => {
  const classes = {
    'C0 control': [0x00, 0x07, 0x08, 0x1b, 0x1f],
    DEL: [0x7f],
    'C1 control': [0x80, 0x85, 0x9b, 0x9f],
    'line and paragraph separator': [0x2028, 0x2029],
    'bidi formatting': [0x200e, 0x200f, 0x202a, 0x202b, 0x202c, 0x202d, 0x202e, 0x2066, 0x2067, 0x2068, 0x2069],
  }
  for (const [name, points] of Object.entries(classes)) {
    for (const point of points) {
      const marked = `a${String.fromCharCode(point)}b`
      assert.equal(excerpt(marked), 'a b', `${name} U+${point.toString(16).padStart(4, '0')} survived excerpt`)
    }
  }

  // The whole C0 and C1 range, exhaustively: a range written by hand is exactly
  // where an off-by-one hides.
  for (let point = 0; point <= 0x9f; point += 1) {
    if (point >= 0x20 && point <= 0x7e) continue
    assert.equal(excerpt(`a${String.fromCharCode(point)}b`), 'a b', `U+${point.toString(16).padStart(4, '0')} survived excerpt`)
  }
  assert.equal(excerpt('a~b'), 'a~b', 'printable characters are left alone')
  assert.equal(excerpt('a\u00e9b'), 'a\u00e9b', 'so is ordinary accented text')
})

test('the same classes are removed from labels, not only from excerpts', () => {
  const nel = String.fromCharCode(0x85)
  const rlo = String.fromCharCode(0x202e)
  assert.equal(displayLabel(`Reco${nel}very:`), 'Reco very')
  assert.equal(normalizeLabel(`Reco${rlo}very:`), 'reco very')
  assert.equal(normalizeLabel(`Owner${String.fromCharCode(0x9b)}31m`), 'owner 31m')
})

test('excerpt bounds its output at the documented limit', () => {
  const long = 'x'.repeat(EXCERPT_LIMIT + 50)
  const result = excerpt(long)
  assert.equal(result.length, EXCERPT_LIMIT + 3)
  assert.equal(result.endsWith('...'), true)
  assert.equal(excerpt('short').length, 5)
  assert.equal(excerpt('abcdef', 3), 'abc...')
})

test('decodeUtf8 refuses undecodable bytes and never infers from decoded content', () => {
  const invalid = Uint8Array.from([0x68, 0x69, 0xff, 0xfe])
  const decoded = decodeUtf8(invalid)
  assert.equal(decoded.ok, false)
  assert.equal(decoded.reason, 'not-utf8')

  // A document that legitimately contains U+FFFD is valid UTF-8. A lenient
  // decoder plus a search for U+FFFD cannot tell these two cases apart, which is
  // how an unreadable input reports a pass.
  const legitimate = new TextEncoder().encode('recovery: restore � from backup')
  const second = decodeUtf8(legitimate)
  assert.equal(second.ok, true)
  assert.equal(second.text.includes('�'), true)
})

test('normalizeLabel and displayLabel strip emphasis, and only one of them folds case', () => {
  assert.equal(normalizeLabel('**Expected Output:**'), 'expected output')
  assert.equal(displayLabel('**Expected Output:**'), 'Expected Output')
  assert.equal(normalizeTitle('## is not reachable here'), '## is not reachable here')
  assert.equal(normalizeTitle('Step 3 — Cordon the node.'), '— cordon the node')
  assert.equal(normalizeTitle('3) Cordon the node'), 'cordon the node')
})

test('parseFieldLine reads every documented label shape and rejects prose', () => {
  const shapes = [
    'Owner: platform-oncall',
    '- **Owner:** platform-oncall',
    '* **Owner**: platform-oncall',
    '_Owner:_ platform-oncall',
    '1. Owner: platform-oncall',
    '> Owner: platform-oncall',
  ]
  for (const shape of shapes) {
    const parsed = parseFieldLine(shape)
    assert.notEqual(parsed, null, `${shape} should be field-shaped`)
    assert.equal(parsed.label, 'owner', shape)
    assert.equal(parsed.value, 'platform-oncall', shape)
  }

  // Three words is not a label, so ordinary prose with a colon stays prose.
  assert.equal(parseFieldLine('Note the following: the queue drains slowly'), null)
  assert.equal(parseFieldLine('Drain the node before patching it'), null)
  assert.equal(parseFieldLine('Owner platform-oncall'), null)
})

test('parseFieldLine keeps bold inside a value instead of eating it as a delimiter', () => {
  const parsed = parseFieldLine('**Recovery:** **stop** and page the lead')
  assert.equal(parsed.label, 'recovery')
  assert.equal(parsed.value, '**stop** and page the lead')
})

test('every label in the vocabulary maps to one of the four requirements', () => {
  const requirements = new Set(Object.values(STEP_FIELDS))
  assert.deepEqual([...requirements].sort(byCodeUnit), ['expectedOutput', 'owner', 'prerequisites', 'recovery'])
  assert.equal(FIELD_LABELS.length, Object.keys(STEP_FIELDS).length)
  // The order written out, not re-derived: comparing a list against a sort of
  // itself agrees with whatever comparator produced it.
  assert.deepEqual([...FIELD_LABELS], [
    'expected output',
    'expected result',
    'on failure',
    'owner',
    'owners',
    'preconditions',
    'prerequisite',
    'prerequisites',
    'recovery',
    'rollback',
    'verification',
    'verify',
  ])
})

/**
 * Two vocabulary labels can sit the same distance from one written label, and
 * which one a reader is told to write must not depend on the order the
 * vocabulary happens to be in. The tie is broken by code unit, deliberately.
 */
test('a label equally close to two vocabulary labels resolves the same way every time', () => {
  assert.deepEqual(nearestLabel('ownerz'), { label: 'owner', distance: 1 }, 'owner precedes owners by code unit')
  assert.deepEqual(nearestLabel('prerequisitez'), { label: 'prerequisite', distance: 1 })
  assert.equal(editDistance('ownerz', 'owner'), editDistance('ownerz', 'owners'), 'the two candidates really are tied')
})

test('editDistance is exact below the cap and saturates above it', () => {
  assert.equal(editDistance('recovery', 'recovery'), 0)
  assert.equal(editDistance('recovry', 'recovery'), 1)
  assert.equal(editDistance('onwer', 'owner'), 2)
  assert.equal(editDistance('recovery', 'prerequisites'), 3, 'a far pair saturates at cap + 1')
  assert.equal(editDistance('ab', 'abcdefgh'), 3, 'a length gap beyond the cap short-circuits')
})

test('nearestLabel catches a typo that would otherwise turn a real failure green', () => {
  assert.deepEqual(nearestLabel('recovry'), { label: 'recovery', distance: 1 })
  assert.deepEqual(nearestLabel('onwer'), { label: 'owner', distance: 2 })
  assert.deepEqual(nearestLabel('roll back'), { label: 'rollback', distance: 1 })
  assert.equal(nearestLabel('owner'), null, 'an exact label is not a near miss')
  assert.equal(nearestLabel('note'), null, 'ordinary prose labels are left alone')
  assert.equal(nearestLabel('warning'), null)
  assert.equal(nearestLabel('tip'), null, 'labels under four characters are never matched')
})

test('scanCommands separates a command from a sentence that merely starts with one', () => {
  const command = scanCommands('sudo systemctl stop edilec-ingest')
  assert.equal(command.length, 1)
  assert.equal(command[0].kind, 'prose')
  assert.equal(command[0].word, 'sudo')

  // Case-sensitivity is what does the separating.
  assert.deepEqual(scanCommands('Sudo is required for this step.'), [])
  assert.deepEqual(scanCommands('Make sure the queue is empty first.'), [])
  assert.deepEqual(scanCommands('kubectl'), [], 'a bare tool name with no arguments is prose')
})

test('scanCommands reports a shell prompt and an inline span separately', () => {
  const prompt = scanCommands('$ ./scripts/repoint-writers.sh --target eu-west-2')
  assert.equal(prompt.length, 1)
  assert.equal(prompt[0].kind, 'prose')

  const inline = scanCommands('Then run `kubectl drain node-7 --force` and wait.')
  assert.equal(inline.length, 1)
  assert.equal(inline[0].kind, 'inline')
  assert.equal(inline[0].text, 'kubectl drain node-7 --force')

  assert.deepEqual(scanCommands('The node is called `node-7`.'), [], 'a one-word span is not a command')
})

test('scanCommands sees through list and blockquote markers', () => {
  assert.equal(scanCommands('- rm -rf /var/lib/ingest/spool')[0].kind, 'prose')
  assert.equal(scanCommands('> sudo systemctl stop api')[0].kind, 'prose')
})

test('the command vocabulary is a closed, sorted list of names and nothing else', () => {
  assert.deepEqual([...COMMAND_WORDS], [...COMMAND_WORDS].sort(byCodeUnit))
  assert.equal(COMMAND_WORDS.includes('rm'), true)
  assert.equal(COMMAND_WORDS.includes('kubectl'), true)
  assert.equal(new Set(COMMAND_WORDS).size, COMMAND_WORDS.length, 'no duplicates')
})

const RUNBOOK = [
  '# Drain a node',
  '',
  'Owner: platform-oncall',
  '',
  '## 1. Cordon',
  '',
  '- **Prerequisites:** cluster access',
  '',
  '### Expected output',
  'The node is SchedulingDisabled.',
  '',
  '```sh',
  'kubectl cordon node-7',
  '```',
  '',
  '## 2. Evict',
  '',
  'Run `kubectl drain node-7 --force` and wait.',
  '',
].join('\n')

test('parseRunbook splits a document into a preamble and steps at the configured level', () => {
  const parsed = parseRunbook(RUNBOOK)
  assert.equal(parsed.steps.length, 2)
  assert.equal(parsed.steps[0].title, '1. Cordon')
  assert.equal(parsed.steps[0].line, 5)
  assert.equal(parsed.steps[0].number, 1)
  assert.equal(parsed.steps[1].number, 2)
  assert.equal(parsed.preamble.fields.length, 1)
  assert.equal(parsed.preamble.fields[0].field, 'owner')
  assert.equal(parsed.preamble.fields[0].value, 'platform-oncall')
})

test('parseRunbook reads a field written as a sub-heading with its body as the value', () => {
  const parsed = parseRunbook(RUNBOOK)
  const heading = parsed.steps[0].fields.find((entry) => entry.shape === 'heading')
  assert.equal(heading.field, 'expectedOutput')
  assert.equal(heading.value, 'The node is SchedulingDisabled.')
  assert.equal(heading.line, 9)
})

test('parseRunbook records fences with their language tag and never their content as a command', () => {
  const parsed = parseRunbook(RUNBOOK)
  assert.equal(parsed.steps[0].fences.length, 1)
  assert.equal(parsed.steps[0].fences[0].info, 'sh')
  assert.equal(parsed.steps[0].fences[0].closed, true)
  assert.deepEqual(parsed.steps[0].commands, [], 'fenced command text produces no loose-command finding')
  assert.equal(parsed.steps[1].commands.length, 1)
  assert.equal(parsed.steps[1].commands[0].kind, 'inline')
})

test('parseRunbook honours --step-level so a level-3 runbook is not read as one step', () => {
  const text = ['# Title', '', '## Section', '', '### Do the thing', '', 'Owner: me', ''].join('\n')
  assert.equal(parseRunbook(text, { stepLevel: 2 }).steps.length, 1)
  const deeper = parseRunbook(text, { stepLevel: 3 })
  assert.equal(deeper.steps.length, 1)
  assert.equal(deeper.steps[0].title, 'Do the thing')
  assert.equal(deeper.steps[0].fields[0].field, 'owner')
})

test('parseRunbook reports an unterminated fence instead of pretending it read the rest', () => {
  const text = ['## 1. One', '', '```sh', 'kubectl cordon node-7', '', '## 2. Two', '', 'Owner: me', ''].join('\n')
  const parsed = parseRunbook(text)
  assert.notEqual(parsed.unterminatedFence, null)
  assert.equal(parsed.unterminatedFence.line, 3)
  assert.equal(parsed.steps.length, 1, 'the heading inside the open fence is fence content, not a step')
})

test('parseRunbook stops at maxSteps and says where it stopped', () => {
  const text = ['## 1. a', 'x', '## 2. b', 'y', '## 3. c', 'z', ''].join('\n')
  const parsed = parseRunbook(text, { maxSteps: 2 })
  assert.equal(parsed.steps.length, 2)
  assert.notEqual(parsed.overflow, null)
  assert.equal(parsed.overflow.title, '3. c')
  assert.equal(parseRunbook(text, { maxSteps: 3 }).overflow, null)
})

test('parseRunbook marks a step truncated at maxStepLines and stops extracting from it', () => {
  const body = Array.from({ length: 12 }, (_, index) => `line ${index}`)
  const text = ['## 1. a', ...body, 'Owner: platform-oncall', ''].join('\n')
  const truncated = parseRunbook(text, { maxStepLines: 5 })
  assert.equal(truncated.steps[0].truncated, true)
  assert.equal(truncated.steps[0].fields.length, 0, 'nothing after the limit is read')

  const whole = parseRunbook(text, { maxStepLines: 400 })
  assert.equal(whole.steps[0].truncated, false)
  assert.equal(whole.steps[0].fields.length, 1)
})

test('parseRunbook tolerates CRLF line endings and a byte order mark', () => {
  const text = `﻿## 1. Cordon\r\n\r\nOwner: platform-oncall\r\n`
  const parsed = parseRunbook(text)
  assert.equal(parsed.steps.length, 1)
  assert.equal(parsed.steps[0].title, '1. Cordon')
  assert.equal(parsed.steps[0].fields[0].value, 'platform-oncall')
})

test('parseRunbook does not scan the preamble for loose commands', () => {
  const text = ['sudo systemctl stop api', '', '## 1. Step', '', 'sudo systemctl start api', ''].join('\n')
  const parsed = parseRunbook(text)
  assert.deepEqual(parsed.preamble.commands, [])
  assert.equal(parsed.steps[0].commands.length, 1)
})
