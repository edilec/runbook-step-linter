/**
 * runbook-step-linter
 *
 * Reads a directory of runbooks and checks each step for the five things a
 * person woken at 03:00 actually needs: a named owner, stated prerequisites, an
 * expected output that makes success checkable, a recovery path for when it
 * fails, and command boundaries that leave no doubt where a command starts and
 * ends.
 *
 * Two properties are structural rather than incidental:
 *
 * 1. **Command text is data.** A command found in a runbook is located,
 *    bounded, sanitised and quoted. It is never executed, evaluated,
 *    interpolated into another command, or passed to a shell. This package
 *    imports no `node:child_process`, calls no `eval` and builds no `Function`,
 *    and `test/no-execution.test.mjs` fails if any of that changes. A runbook is
 *    input, and input never acquires the authority to make this tool act.
 * 2. **Unknown is never a pass.** A document that could not be read, decoded or
 *    parsed to the end, and a step that a limit stopped short of, make the run
 *    `incomplete`. The tool reports what it did not see rather than reporting
 *    silence as health.
 */

import { readFile, readdir, realpath, stat } from 'node:fs/promises'
import { extname, join, resolve, sep } from 'node:path'

import {
  DEFAULT_STEP_LEVEL,
  byCodeUnit,
  decodeUtf8,
  excerpt,
  parseRunbook,
} from './parse.mjs'
import { createFinding, lintDocument, sortRows } from './rules.mjs'

export const TOOL_ID = 'runbook-step-linter'
export const REPORT_SCHEMA_VERSION = '1'

/**
 * Bounds are part of the contract, not a safety net.
 *
 * A runbook directory is ordinary untrusted input: it can hold a generated
 * 50 MB document, a tree that nests forever, or one step whose body never ends.
 * Every limit below is explicit, overridable from the CLI, and reported by name
 * when it is hit. Exceeding one produces a finding and an `incomplete` report --
 * never a quietly shorter answer, and never a pass.
 */
export const DEFAULT_LIMITS = Object.freeze({
  maxDocuments: 500,
  maxDocumentBytes: 524288,
  maxDepth: 8,
  maxSteps: 200,
  maxStepLines: 400,
})

const DOCUMENT_EXTENSIONS = Object.freeze(['.markdown', '.md'])
const SKIPPED_DIRECTORIES = Object.freeze(['node_modules'])
const SKIPPED_FILENAMES = Object.freeze(['index.md', 'readme.md'])
const ALLOWED_OPTIONS = Object.freeze(['limits', 'root', 'stepLevel'])
const TEXT_OPTIONS = Object.freeze(['file', 'limits', 'stepLevel'])
const ROOT_LOCATION = Object.freeze({ file: '.', pointer: '/' })

function isRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

/**
 * Whether an entry name is one this tool would lint.
 *
 * One definition, used both to decide what to collect and to decide what an
 * entry refused before collection was: a refused `notes.txt` was never a
 * runbook, and reporting it as a document nobody linted would be a second
 * untruth on top of the refusal.
 */
function isDocumentName(name) {
  if (!DOCUMENT_EXTENSIONS.includes(extname(name).toLowerCase())) return false
  return !SKIPPED_FILENAMES.includes(name.toLowerCase())
}

/**
 * Containment, decided on real paths.
 *
 * Refusing `../` and absolute strings is not confinement: a symbolic link
 * planted inside the declared root resolves out of the tree without ever
 * spelling a traversal. Both sides of this comparison have been through
 * `realpath` before they arrive -- comparing a real root against a path that
 * was not resolved is the over-correction, and it refuses files that genuinely
 * are inside a root reached through a symlink. A false refusal is a bug too.
 */
export function isInside(root, candidate) {
  if (candidate === root) return true
  return candidate.startsWith(root.endsWith(sep) ? root : `${root}${sep}`)
}

/**
 * Only an absent `limits` means "use the defaults". `null` is a value the
 * caller computed and lost, not an omission, and accepting it as `{}` is the
 * same silent ignore this tool refuses everywhere else: an unknown limit name,
 * a misspelled option key and a fractional limit are all errors, so a limits
 * object that turned out to be null cannot be the one thing that is waved
 * through.
 */
export function validateLimits(overrides = {}) {
  if (!isRecord(overrides)) throw new TypeError('Limits must be an object')
  const limits = { ...DEFAULT_LIMITS }
  for (const [name, value] of Object.entries(overrides)) {
    if (!Object.hasOwn(DEFAULT_LIMITS, name)) throw new TypeError(`Unknown limit "${name}"`)
    if (!Number.isInteger(value) || value < 1) {
      throw new TypeError(`Limit "${name}" must be a positive integer`)
    }
    limits[name] = value
  }
  return Object.freeze(limits)
}

export function validateStepLevel(level) {
  if (level === undefined) return DEFAULT_STEP_LEVEL
  if (!Number.isInteger(level) || level < 1 || level > 6) {
    throw new TypeError('Step heading level must be an integer between 1 and 6')
  }
  return level
}

function createCollector() {
  // `skipped` counts documents that were found and not linted -- including the
  // ones refused before they could be collected, which are invisible in
  // `files` and were previously invisible in the report as well.
  return { rows: [], incomplete: false, skipped: 0 }
}

function record(collector, row) {
  collector.rows.push({ pointer: '/', line: 0, ...row })
}

/**
 * Walk the runbook root.
 *
 * Directory entries are sorted by UTF-16 code unit before use, so the order
 * documents are visited never depends on the order the filesystem returned
 * them. Every entry is resolved to its real path and re-checked against the
 * real root before anything is read from it, and a real path already visited is
 * not visited twice.
 */
async function collectDocuments(rootReal, limits, collector) {
  const files = []
  const visited = new Set([rootReal])
  let stopped = false

  async function walk(absolute, relativePath, depth) {
    if (stopped) return
    if (depth > limits.maxDepth) {
      record(collector, {
        file: relativePath === '' ? '.' : relativePath,
        ruleId: 'directory-too-deep',
        message: `Directory nesting exceeded the maxDepth limit of ${limits.maxDepth}; its contents were not examined.`,
        suggestion: 'Raise --max-depth or flatten the runbook directory.',
      })
      collector.incomplete = true
      return
    }

    let entries
    try {
      entries = await readdir(absolute, { withFileTypes: true })
    } catch (error) {
      record(collector, {
        file: relativePath === '' ? '.' : relativePath,
        ruleId: 'document-unreadable',
        message: `Directory could not be read: ${error.code ?? 'unknown error'}.`,
      })
      collector.incomplete = true
      return
    }

    entries.sort((left, right) => byCodeUnit(left.name, right.name))

    for (const entry of entries) {
      if (stopped) return
      if (entry.name.startsWith('.')) continue
      const childRelative = relativePath === '' ? entry.name : `${relativePath}/${entry.name}`
      const childAbsolute = join(absolute, entry.name)

      // Resolve and inspect in one step: an entry whose real path cannot be
      // obtained is unknown evidence, and unknown evidence is never a pass.
      let realPath
      let info
      try {
        realPath = await realpath(childAbsolute)
        info = await stat(realPath)
      } catch (error) {
        record(collector, {
          file: childRelative,
          ruleId: 'document-unreadable',
          message: `Entry could not be resolved: ${error.code ?? 'unknown error'}.`,
        })
        collector.incomplete = true
        if (isDocumentName(entry.name)) collector.skipped += 1
        continue
      }

      // Containment is decided on the real path, before the entry is opened or
      // walked. Neither its content nor its real location leaves this function.
      if (!isInside(rootReal, realPath)) {
        record(collector, {
          file: childRelative,
          ruleId: 'path-escapes-root',
          message: 'Entry resolves outside the runbook root and was refused; its content was never read.',
          suggestion: 'Move the runbook inside the root, or lint the other location separately.',
        })
        if (isDocumentName(entry.name)) collector.skipped += 1
        continue
      }
      if (visited.has(realPath)) continue
      visited.add(realPath)

      if (info.isDirectory()) {
        if (SKIPPED_DIRECTORIES.includes(entry.name)) continue
        await walk(realPath, childRelative, depth + 1)
        continue
      }
      if (!isDocumentName(entry.name)) continue

      // An entry named like a runbook that is not a regular file -- a FIFO, a
      // socket, a device node -- cannot be read as one, and reading from it
      // could block forever. Dropping it in silence would leave an unexamined
      // runbook-shaped entry inside a passing run, so it is reported and the
      // run is incomplete. Entries that are not runbook-shaped stay skipped in
      // silence: they were never candidates.
      if (!info.isFile()) {
        record(collector, {
          file: childRelative,
          ruleId: 'document-unreadable',
          message: 'Entry is named like a runbook but is not a regular file, so nothing could be read from it.',
          suggestion: 'Remove the entry, or replace it with a regular Markdown file.',
        })
        collector.incomplete = true
        collector.skipped += 1
        continue
      }

      if (files.length >= limits.maxDocuments) {
        record(collector, {
          file: childRelative,
          ruleId: 'too-many-documents',
          message: `Root holds more than the maxDocuments limit of ${limits.maxDocuments}; the scan stopped here and no later document was examined.`,
          suggestion: 'Raise --max-documents or lint a smaller subtree.',
        })
        collector.incomplete = true
        collector.skipped += 1
        stopped = true
        return
      }
      files.push({ file: childRelative, realPath, size: info.size })
    }
  }

  await walk(rootReal, '', 0)
  files.sort((left, right) => byCodeUnit(left.file, right.file))
  return files
}

/**
 * Read one document. The bytes are decoded strictly and the text is parsed.
 * Nothing read here is ever executed: the return value is a data structure.
 */
async function loadDocument(collector, limits, entry) {
  if (entry.size > limits.maxDocumentBytes) {
    record(collector, {
      file: entry.file,
      ruleId: 'document-too-large',
      message: `Document is ${entry.size} bytes, above the maxDocumentBytes limit of ${limits.maxDocumentBytes}; it was not parsed and none of its steps were checked.`,
      suggestion: 'Raise --max-document-bytes or split the runbook.',
    })
    collector.incomplete = true
    return null
  }

  let bytes
  try {
    bytes = await readFile(entry.realPath)
  } catch (error) {
    record(collector, {
      file: entry.file,
      ruleId: 'document-unreadable',
      message: `Document could not be read: ${error.code ?? 'unknown error'}.`,
    })
    collector.incomplete = true
    return null
  }

  const decoded = decodeUtf8(bytes)
  if (!decoded.ok) {
    record(collector, {
      file: entry.file,
      ruleId: 'document-not-utf8',
      message: 'Document is not valid UTF-8; it was not parsed and none of its steps were checked.',
      suggestion: 'Re-encode the runbook as UTF-8.',
    })
    collector.incomplete = true
    return null
  }
  return decoded.text
}

function emptySummary() {
  return { expectedOutput: 0, owner: 0, prerequisites: 0, recovery: 0 }
}

function buildReport(collector, counts) {
  const findings = sortRows(collector.rows).map(createFinding)
  const errors = findings.filter((item) => item.severity === 'error').length
  const warnings = findings.filter((item) => item.severity === 'warning').length
  const status = collector.incomplete ? 'incomplete' : errors > 0 ? 'fail' : 'pass'

  return {
    schemaVersion: REPORT_SCHEMA_VERSION,
    tool: TOOL_ID,
    status,
    summary: {
      checked: counts.checked,
      errors,
      warnings,
      info: findings.length - errors - warnings,
      documents: counts.documents,
      skipped: counts.skipped,
      steps: counts.steps,
      fencedCommands: counts.fences,
      looseCommands: counts.looseCommands,
      stepsWithOwner: counts.satisfied.owner,
      stepsWithPrerequisites: counts.satisfied.prerequisites,
      stepsWithExpectedOutput: counts.satisfied.expectedOutput,
      stepsWithRecovery: counts.satisfied.recovery,
    },
    findings,
  }
}

/**
 * Lint a single runbook given as text. No filesystem access, no execution.
 *
 * Exported because it is the honest unit of this tool: bytes in, findings out.
 * It is also how a caller lints a document that does not live on disk.
 */
export function lintRunbookText(text, options = {}) {
  if (typeof text !== 'string') throw new TypeError('Runbook text must be a string')
  if (!isRecord(options)) throw new TypeError('Options must be an object')
  for (const key of Object.keys(options)) {
    if (!TEXT_OPTIONS.includes(key)) throw new TypeError(`Unknown option "${key}"`)
  }
  const limits = validateLimits(options.limits)
  const stepLevel = validateStepLevel(options.stepLevel)
  const file = options.file === undefined ? 'runbook.md' : options.file
  if (typeof file !== 'string' || file.trim() === '') throw new TypeError('File label must be a non-empty string')

  const parsed = parseRunbook(text, {
    stepLevel,
    maxSteps: limits.maxSteps,
    maxStepLines: limits.maxStepLines,
  })
  const result = lintDocument(excerpt(file, 200), parsed, { limits })

  const collector = createCollector()
  collector.rows.push(...result.rows)
  collector.incomplete = result.incomplete

  return buildReport(collector, {
    documents: 1,
    skipped: 0,
    checked: result.stats.checked,
    steps: result.stats.steps,
    fences: result.stats.fences,
    looseCommands: result.stats.looseCommands,
    satisfied: result.stats.satisfied,
  })
}

/**
 * Lint every runbook under a root directory.
 *
 * Nothing here reads the network, the clock, the locale or the environment, so
 * two runs over the same bytes produce byte-identical output. The root is
 * opened read-only: this tool has no write path into a runbook and no auto-fix.
 */
export async function lintRunbooks(options = {}) {
  if (!isRecord(options)) throw new TypeError('Options must be an object')
  for (const key of Object.keys(options)) {
    if (!ALLOWED_OPTIONS.includes(key)) throw new TypeError(`Unknown option "${key}"`)
  }
  if (typeof options.root !== 'string' || options.root.trim() === '') {
    throw new TypeError('A runbook root is required')
  }
  const limits = validateLimits(options.limits)
  const stepLevel = validateStepLevel(options.stepLevel)

  let rootReal
  try {
    rootReal = await realpath(resolve(options.root))
  } catch (error) {
    throw new TypeError(`Runbook root could not be read: ${error.code ?? 'unknown error'}`)
  }
  const rootInfo = await stat(rootReal)
  if (!rootInfo.isDirectory()) throw new TypeError('Runbook root must be a directory')

  const collector = createCollector()
  const files = await collectDocuments(rootReal, limits, collector)

  const counts = {
    // Everything found as a runbook: the documents collected, plus the ones
    // refused before collection. A run that refused an entry and reported
    // `documents: 1, skipped: 0` hid the very entry that made it incomplete.
    documents: files.length + collector.skipped,
    skipped: collector.skipped,
    checked: 0,
    steps: 0,
    fences: 0,
    looseCommands: 0,
    satisfied: emptySummary(),
  }

  for (const entry of files) {
    const text = await loadDocument(collector, limits, entry)
    if (text === null) {
      counts.skipped += 1
      continue
    }
    const parsed = parseRunbook(text, {
      stepLevel,
      maxSteps: limits.maxSteps,
      maxStepLines: limits.maxStepLines,
    })
    const result = lintDocument(entry.file, parsed, { limits })
    collector.rows.push(...result.rows)
    if (result.incomplete) collector.incomplete = true
    counts.checked += result.stats.checked
    counts.steps += result.stats.steps
    counts.fences += result.stats.fences
    counts.looseCommands += result.stats.looseCommands
    for (const field of Object.keys(counts.satisfied)) {
      counts.satisfied[field] += result.stats.satisfied[field]
    }
  }

  /**
   * Green on no evidence is a defect, not a clean bill of health. A run that
   * linted no step checked nothing, so it is reported and marked incomplete --
   * `pass` with `checked: 0` is not reachable from here.
   *
   * The test is `checked`, the field the guarantee is written in terms of, and
   * not `steps`: a document whose every step a limit cut short found steps and
   * examined none of them, and saying so here does not depend on the flag that
   * the limit itself sets.
   */
  if (counts.checked === 0) {
    record(collector, {
      ...ROOT_LOCATION,
      ruleId: 'no-documents-found',
      message: `No runbook step was linted, so this run checked nothing. ${counts.documents} document(s) were found, ${counts.skipped} of them not linted.`,
      suggestion: 'Point --root at the directory that holds the runbooks, or set --step-level to the heading level they use.',
    })
    collector.incomplete = true
  }

  return buildReport(collector, counts)
}

const SEVERITY_WIDTH = 7

export function formatReport(report) {
  const { summary } = report
  const lines = [
    `${summary.checked} step(s) linted in ${summary.documents} document(s): ${summary.errors} error, ${summary.warnings} warning, ${summary.info} info, status ${report.status}.`,
    `evidence: owner ${summary.stepsWithOwner}/${summary.steps}, prerequisites ${summary.stepsWithPrerequisites}/${summary.steps}, expected output ${summary.stepsWithExpectedOutput}/${summary.steps}, recovery ${summary.stepsWithRecovery}/${summary.steps}.`,
    `commands: ${summary.fencedCommands} fenced block(s), ${summary.looseCommands} outside a fence. No command was executed.`,
  ]
  for (const finding of report.findings) {
    const place = finding.line === undefined
      ? `${finding.location.file}${finding.location.pointer}`
      : `${finding.location.file}:${finding.line}${finding.location.pointer}`
    // Evidence is quoted, never acted on. It is runbook text and nothing else.
    const quoted = finding.evidence === undefined ? '' : ` -- ${finding.evidence}`
    lines.push(`${finding.severity.toUpperCase().padEnd(SEVERITY_WIDTH)} ${place} ${finding.ruleId} ${finding.message}${quoted}`)
  }
  return `${lines.join('\n')}\n`
}

export { RULE_SEVERITY, createFinding, lintDocument, sortRows } from './rules.mjs'
export { FIELD_POINTERS, SEVERITY_VALUES, isPlaceholder } from './rules.mjs'
export {
  COMMAND_WORDS,
  DEFAULT_STEP_LEVEL,
  FIELD_LABELS,
  FIELD_NAMES,
  PLACEHOLDER_VALUES,
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
} from './parse.mjs'
