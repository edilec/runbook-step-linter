/**
 * runbook-step-linter -- turning runbook text into a step structure.
 *
 * Nothing in this module touches the filesystem, the clock, the locale or the
 * network, and nothing in it runs anything. A command found in a runbook is
 * text: it is located, bounded and excerpted, and it is never executed,
 * evaluated, interpolated into another command, or handed to a shell. There is
 * no import of `node:child_process`, `eval` or `new Function` anywhere in this
 * package, and `test/no-execution.test.mjs` fails if one appears.
 */

export function byCodeUnit(left, right) {
  if (left === right) return 0
  return left < right ? -1 : 1
}

/**
 * Characters removed before any runbook text is embedded in a report.
 *
 * Written as escapes rather than literally, because a literal U+2028 inside a
 * module is a hazard of its own. This is applied to every untrusted string that
 * reaches output -- file paths, headings, field labels, values and command
 * excerpts alike -- not only to the evidence field. An identifier is as
 * dangerous as an excerpt here: a file name carrying U+0085 forges a report
 * line just as well as a heading does.
 *
 * Five classes, each for a reason a reader would care about:
 *
 * - `U+0000-U+001F` C0, and `U+007F` DEL -- a newline forges a report line, and
 *   an ESC starts a terminal escape sequence.
 * - `U+0080-U+009F` C1. Half-forgotten and twice as dangerous: `U+0085` NEL is
 *   a line break to a great many readers, and `U+009B` is the 8-bit form of
 *   CSI, so it opens a terminal control sequence without an ESC in sight.
 * - `U+2028` and `U+2029` -- line and paragraph separators.
 * - `U+200E`, `U+200F`, `U+202A-U+202E`, `U+2066-U+2069` -- the bidirectional
 *   formatting characters. `U+202E` RIGHT-TO-LEFT OVERRIDE reverses everything
 *   displayed after it, so a rule id or a path can be made to read as something
 *   else entirely while the bytes say otherwise.
 */
const CONTROL = /[\u0000-\u001F\u007F-\u009F\u2028\u2029\u200E\u200F\u202A-\u202E\u2066-\u2069]/g

const BOM = String.fromCharCode(0xfeff)

export const EXCERPT_LIMIT = 160

/** A bounded, single-line excerpt. Runbook content is data, never an instruction. */
export function excerpt(value, limit = EXCERPT_LIMIT) {
  const flattened = String(value).replace(CONTROL, ' ').replace(/\s+/g, ' ').trim()
  if (flattened.length <= limit) return flattened
  return `${flattened.slice(0, limit)}...`
}

/**
 * Decode bytes as UTF-8, strictly.
 *
 * `fatal: true` is the entire point. Decoding leniently and then hunting for
 * U+FFFD cannot tell undecodable bytes from a document that legitimately
 * contains a replacement character, and that confusion is how an unreadable
 * input reports a pass. The decoder decides; the decoded text never gets a
 * vote. Every byte source in this tool goes through here, including any file
 * the CLI is pointed at.
 */
export function decodeUtf8(bytes) {
  try {
    return { ok: true, text: new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes) }
  } catch {
    return { ok: false, reason: 'not-utf8' }
  }
}

/**
 * The field vocabulary: the label a runbook writes, and the requirement it
 * answers. A label outside this map answers nothing, which is the point --
 * `Recovry:` must not be mistaken for recovery evidence.
 */
export const STEP_FIELDS = Object.freeze({
  owner: 'owner',
  owners: 'owner',
  'on failure': 'recovery',
  preconditions: 'prerequisites',
  prerequisite: 'prerequisites',
  prerequisites: 'prerequisites',
  'expected output': 'expectedOutput',
  'expected result': 'expectedOutput',
  recovery: 'recovery',
  rollback: 'recovery',
  verification: 'expectedOutput',
  verify: 'expectedOutput',
})

/** The four requirements a step is linted against, in report order. */
export const FIELD_NAMES = Object.freeze(['expectedOutput', 'owner', 'prerequisites', 'recovery'])

export const FIELD_LABELS = Object.freeze(Object.keys(STEP_FIELDS).sort(byCodeUnit))

/**
 * Values that look like an answer but are not one.
 *
 * `none` is deliberately absent: "Prerequisites: none" is an explicit answer
 * and is accepted. A placeholder is a promise to answer later, and a step that
 * still carries one has not answered.
 */
export const PLACEHOLDER_VALUES = Object.freeze([
  '-',
  '--',
  '...',
  '?',
  '???',
  'fixme',
  'n/a',
  'na',
  't.b.d.',
  'tbd',
  'tk',
  'todo',
  'xxx',
])

/**
 * The command vocabulary used to find a command that escaped its fence.
 *
 * Matching is case-sensitive and deliberate: `sudo systemctl stop api` is a
 * command, `Sudo is required for this step` is prose. These names are only ever
 * compared as strings -- nothing here is looked up on the host, resolved to an
 * executable, or run.
 */
export const COMMAND_WORDS = Object.freeze([
  'ansible',
  'aws',
  'bash',
  'cat',
  'chmod',
  'chown',
  'curl',
  'docker',
  'flyctl',
  'gcloud',
  'git',
  'helm',
  'journalctl',
  'kubectl',
  'make',
  'mv',
  'mysql',
  'npm',
  'openssl',
  'psql',
  'python3',
  'rm',
  'rsync',
  'scp',
  'service',
  'sh',
  'ssh',
  'sudo',
  'systemctl',
  'tar',
  'terraform',
  'wget',
])

const HEADING = /^(#{1,6})\s+(.*)$/
const FENCE_OPEN = /^(\s{0,3})(`{3,}|~{3,})(.*)$/
const LIST_PREFIX = /^\s{0,3}(?:[-*+]\s+|\d{1,3}[.)]\s+)?/
const BLOCKQUOTE = /^\s{0,3}>\s?/
const LABEL_SPLIT = /^([^:]{1,40}):\s*(.*)$/
const EMPHASIS_OPEN = /^(\*\*|__|\*|_)/
const LABEL_TEXT = /^[a-z]+(?: [a-z]+)?$/
const INLINE_CODE = /`([^`]+)`/g
const PROMPT = /^[$%]\s+\S/
const FIRST_WORD = /^([A-Za-z][A-Za-z0-9._-]*)/
const STEP_NUMBER = /^(?:step\s+)?(\d{1,4})\b/i
const TRAILING_HASHES = /\s+#+\s*$/
const MAX_FIELD_HEADING_LINES = 5

function stripCarriageReturn(value) {
  return value.endsWith('\r') ? value.slice(0, -1) : value
}

/** Fold a heading or label to the form the vocabulary is written in. */
export function normalizeLabel(value) {
  return String(value)
    .replace(CONTROL, ' ')
    .replace(/[*_`]/g, '')
    .replace(/:\s*$/, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()
}

/**
 * A label as written, with Markdown emphasis and the trailing colon removed but
 * its spelling and case intact. This is what a finding quotes back, so a reader
 * sees "Recovry" and not the raw "**Recovry".
 */
export function displayLabel(value) {
  return String(value).replace(CONTROL, ' ').replace(/[*_`]/g, '').replace(/:\s*$/, '').replace(/\s+/g, ' ').trim()
}

/** Fold a step title for duplicate detection: case, emphasis and numbering removed. */
export function normalizeTitle(value) {
  return normalizeLabel(value).replace(/^(?:step\s+)?\d{1,4}\s*[.):-]?\s*/, '').replace(/[.:;!?]+$/, '').trim()
}

/**
 * Bounded edit distance.
 *
 * Used only to recognise a near miss such as `Recovry:` for `recovery:`. It
 * returns `cap + 1` rather than an exact distance once the cap is passed, so
 * the cost stays bounded on adversarial input.
 */
export function editDistance(left, right, cap = 2) {
  if (left === right) return 0
  if (Math.abs(left.length - right.length) > cap) return cap + 1
  let previous = Array.from({ length: right.length + 1 }, (_, index) => index)
  for (let i = 1; i <= left.length; i += 1) {
    const current = [i]
    let best = i
    for (let j = 1; j <= right.length; j += 1) {
      const cost = left[i - 1] === right[j - 1] ? 0 : 1
      const value = Math.min(previous[j] + 1, current[j - 1] + 1, previous[j - 1] + cost)
      current[j] = value
      if (value < best) best = value
    }
    if (best > cap) return cap + 1
    previous = current
  }
  return previous[right.length]
}

/**
 * The vocabulary label a written label was probably meant to be.
 *
 * A one-character typo must not turn a real failure green, so a near miss is
 * reported and -- crucially -- does not satisfy the requirement it resembles.
 * Labels shorter than four characters are never matched: at that length almost
 * every English word is within two edits of something.
 */
export function nearestLabel(label) {
  if (Object.hasOwn(STEP_FIELDS, label)) return null
  if (label.length < 4) return null
  let best = null
  for (const candidate of FIELD_LABELS) {
    if (candidate.length < 4) continue
    const distance = editDistance(label, candidate)
    if (distance > 2) continue
    if (best === null || distance < best.distance || (distance === best.distance && byCodeUnit(candidate, best.label) < 0)) {
      best = { label: candidate, distance }
    }
  }
  return best
}

/**
 * Read one line as `Label: value`, tolerating list markers and emphasis.
 *
 * Returns null when the line is not field-shaped. A label is at most two words
 * of letters, which keeps ordinary prose containing a colon out of the field
 * vocabulary.
 */
export function parseFieldLine(raw) {
  const stripped = String(raw).replace(BLOCKQUOTE, '').replace(LIST_PREFIX, '')
  const match = LABEL_SPLIT.exec(stripped)
  if (match === null) return null
  const rawLabel = match[1]
  let value = match[2]
  const opener = EMPHASIS_OPEN.exec(rawLabel)
  if (opener !== null && !rawLabel.endsWith(opener[1])) {
    // "**Owner:** value" splits at the first colon, leaving the closing
    // emphasis marker at the head of the value. Remove exactly that marker.
    if (value.startsWith(opener[1])) value = value.slice(opener[1].length).trimStart()
  }
  const label = normalizeLabel(rawLabel)
  if (!LABEL_TEXT.test(label)) return null
  return { rawLabel: rawLabel.trim(), label, value: value.trim() }
}

function commandWordOf(text) {
  const match = FIRST_WORD.exec(text.trim())
  if (match === null) return null
  return COMMAND_WORDS.includes(match[1]) ? match[1] : null
}

/**
 * Find command text that is not inside a fence.
 *
 * Two shapes are recognised, and both are only ever read:
 *
 * - `inline` -- a backtick span whose first word is a command name and which
 *   carries arguments. It has boundaries, but it cannot hold a line break, so
 *   a multi-line command silently loses lines when it is copied.
 * - `prose` -- a shell prompt (`$` or `%` followed by a space), or a line whose
 *   first word is a command name written in lower case with at least one more
 *   word after it. Here the reader has to guess where the command ends.
 */
export function scanCommands(text) {
  const results = []
  const body = String(text).replace(BLOCKQUOTE, '').replace(LIST_PREFIX, '')

  for (const match of body.matchAll(INLINE_CODE)) {
    const span = match[1].trim()
    const word = commandWordOf(span)
    if (word !== null && /\s/.test(span)) results.push({ kind: 'inline', word, text: span })
  }

  const outside = body.replace(INLINE_CODE, ' ').trim()
  if (PROMPT.test(outside)) {
    results.push({ kind: 'prose', word: outside.slice(0, 1), text: outside })
    return results
  }
  const word = commandWordOf(outside)
  if (word !== null && /\s\S/.test(outside)) results.push({ kind: 'prose', word, text: outside })
  return results
}

export const DEFAULT_STEP_LEVEL = 2

function createSection(index, title, line, level) {
  return {
    index,
    title,
    normalizedTitle: normalizeTitle(title),
    number: null,
    line,
    level,
    fields: [],
    fences: [],
    commands: [],
    bodyLines: 0,
    truncated: false,
  }
}

/**
 * Parse a runbook document into a preamble and a list of steps.
 *
 * A step is a heading at exactly `stepLevel`. Everything before the first one
 * is the preamble. Headings deeper than `stepLevel` are part of the step body,
 * and a deeper heading whose text is a field label opens that field, with the
 * following lines as its value.
 *
 * `maxSteps` and `maxStepLines` are enforced here rather than afterwards: a
 * document built to be expensive must stop being read at the documented limit,
 * and the caller is told exactly which limit stopped it.
 */
export function parseRunbook(text, options = {}) {
  const stepLevel = options.stepLevel ?? DEFAULT_STEP_LEVEL
  const maxSteps = options.maxSteps ?? 200
  const maxStepLines = options.maxStepLines ?? 400

  const stripped = String(text).startsWith(BOM) ? String(text).slice(1) : String(text)
  const lines = stripped.split('\n').map(stripCarriageReturn)

  const preamble = createSection(0, '', 0, 0)
  const steps = []
  let current = preamble
  let fence = null
  let pending = null
  let unterminatedFence = null
  let overflow = null

  const flushPending = () => {
    if (pending === null) return
    const value = pending.parts.join(' ').trim()
    current.fields.push({
      field: STEP_FIELDS[pending.label] ?? null,
      label: pending.label,
      rawLabel: pending.rawLabel,
      value,
      line: pending.line,
      shape: 'heading',
      nearest: pending.nearest,
    })
    pending = null
  }

  for (let position = 0; position < lines.length; position += 1) {
    const raw = lines[position]
    const line = position + 1

    if (fence !== null) {
      if (fence.close.test(raw)) {
        fence.record.closed = true
        fence = null
      }
      continue
    }

    const fenceOpen = FENCE_OPEN.exec(raw)
    if (fenceOpen !== null) {
      flushPending()
      const info = fenceOpen[3].trim()
      // Backticks in an info string are not a fence opening in CommonMark; a
      // tilde fence may carry them. Treat an ambiguous line as prose.
      if (fenceOpen[2][0] === '`' && info.includes('`')) {
        if (!current.truncated) current.commands.push(...scanCommands(raw).map((item) => ({ ...item, line })))
        current.bodyLines += 1
        continue
      }
      const record = { line, info, closed: false, language: normalizeLabel(info.split(/\s+/)[0] ?? '') }
      if (!current.truncated) current.fences.push(record)
      current.bodyLines += 1
      const marker = fenceOpen[2]
      fence = {
        record,
        close: new RegExp(`^\\s{0,3}${marker[0] === '`' ? '`' : '~'}{${marker.length},}\\s*$`),
      }
      unterminatedFence = { line, section: current }
      continue
    }

    const heading = HEADING.exec(raw)
    if (heading !== null) {
      flushPending()
      const level = heading[1].length
      const title = heading[2].replace(TRAILING_HASHES, '').trim()

      if (level === stepLevel) {
        if (steps.length >= maxSteps) {
          overflow = { line, title }
          break
        }
        const step = createSection(steps.length + 1, title, line, level)
        const numbered = STEP_NUMBER.exec(normalizeLabel(title))
        step.number = numbered === null ? null : Number(numbered[1])
        steps.push(step)
        current = step
        continue
      }

      current.bodyLines += 1
      if (current.truncated) continue
      const label = normalizeLabel(title)
      if (Object.hasOwn(STEP_FIELDS, label)) {
        pending = { label, rawLabel: title, line, parts: [], nearest: null }
        continue
      }
      const nearest = nearestLabel(label)
      if (nearest !== null) {
        pending = { label, rawLabel: title, line, parts: [], nearest }
      }
      continue
    }

    current.bodyLines += 1
    if (!current.truncated && current !== preamble && current.bodyLines > maxStepLines) {
      flushPending()
      current.truncated = true
      continue
    }
    if (current.truncated) continue

    const field = parseFieldLine(raw)
    if (field !== null) {
      flushPending()
      current.fields.push({
        field: STEP_FIELDS[field.label] ?? null,
        label: field.label,
        rawLabel: field.rawLabel,
        value: field.value,
        line,
        shape: 'line',
        nearest: Object.hasOwn(STEP_FIELDS, field.label) ? null : nearestLabel(field.label),
      })
      if (current !== preamble) {
        current.commands.push(...scanCommands(field.value).map((item) => ({ ...item, line })))
      }
      continue
    }

    if (pending !== null && raw.trim() !== '' && pending.parts.length < MAX_FIELD_HEADING_LINES) {
      pending.parts.push(raw.trim())
    }
    if (current !== preamble) {
      current.commands.push(...scanCommands(raw).map((item) => ({ ...item, line })))
    }
  }

  flushPending()

  return {
    stepLevel,
    preamble,
    steps,
    overflow,
    unterminatedFence: fence === null ? null : unterminatedFence,
    lineCount: lines.length,
  }
}
