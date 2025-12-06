/**
 * runbook-step-linter -- the rules, and the one table that pins their severity.
 *
 * This module decides what a parsed runbook is missing. It reads structure and
 * writes findings; it does not read the filesystem, and it does not run
 * anything. Command text arrives here as a string, is bounded and sanitised,
 * and leaves as evidence.
 */

import {
  FIELD_NAMES,
  PLACEHOLDER_VALUES,
  STEP_FIELDS,
  byCodeUnit,
  displayLabel,
  excerpt,
  normalizeLabel,
} from './parse.mjs'

/**
 * The authoritative rule severity table.
 *
 * Severity is the whole difference between a run that fails and one that
 * passes. Written as a literal at each construction site it drifts silently,
 * and flipping one rule down to a warning turns a refusal into a green build
 * with every test still passing. Every finding takes its severity from here, an
 * unknown rule id throws, and `docs/runbook-rules.md` is asserted against this
 * table in both directions -- plus, independently, rule by rule.
 */
export const RULE_SEVERITY = Object.freeze({
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

export const SEVERITY_VALUES = Object.freeze(['error', 'warning', 'info'])

const PATH_LIMIT = 200
const MESSAGE_LIMIT = 400

/**
 * Build one finding, taking its severity from the single table.
 *
 * Every untrusted string is sanitised here, not only `evidence`. A step heading
 * or a file name carrying a newline would otherwise forge extra lines in the
 * human report, and a report a reader cannot trust line by line is worse than
 * no report. Exported so a test can prove the refusal below actually throws.
 */
export function createFinding(row) {
  const severity = RULE_SEVERITY[row.ruleId]
  if (severity === undefined) {
    throw new Error(
      `Rule "${row.ruleId}" is not in RULE_SEVERITY; add it to the table and to docs/runbook-rules.md.`,
    )
  }
  const finding = {
    ruleId: row.ruleId,
    severity,
    message: excerpt(row.message, MESSAGE_LIMIT),
    location: { file: excerpt(row.file, PATH_LIMIT), pointer: excerpt(row.pointer, PATH_LIMIT) },
  }
  if (row.evidence !== undefined && row.evidence !== '') finding.evidence = excerpt(row.evidence)
  if (row.suggestion !== undefined) finding.suggestion = excerpt(row.suggestion, MESSAGE_LIMIT)
  if (row.line > 0) finding.line = row.line
  return finding
}

/** The pointer segment each requirement is reported under. */
export const FIELD_POINTERS = Object.freeze({
  expectedOutput: 'expected-output',
  owner: 'owner',
  prerequisites: 'prerequisites',
  recovery: 'recovery',
})

/** The rule each missing requirement raises, and how to say it. */
const MISSING_RULES = Object.freeze({
  expectedOutput: {
    ruleId: 'step-expected-output-missing',
    message: 'Step states no expected output, so nobody running it can tell whether it worked.',
    suggestion: 'Add "Expected output:" describing what success looks like -- an exit status, a row count, a log line.',
  },
  owner: {
    ruleId: 'step-owner-missing',
    message: 'Step names no owner, so at 03:00 there is nobody to ask and nobody accountable for running it.',
    suggestion: 'Add "Owner:" naming a rota or a team, or state a document-wide owner before the first step.',
  },
  prerequisites: {
    ruleId: 'step-prerequisites-missing',
    message: 'Step states no prerequisites, so a reader cannot tell what must already be true before running it.',
    suggestion: 'Add "Prerequisites:" -- "none" is an acceptable answer when it is genuinely true.',
  },
  recovery: {
    ruleId: 'step-recovery-missing',
    message: 'Step states no recovery path, so there is no written answer to "it failed, now what?".',
    suggestion: 'Add "Recovery:" (or "Rollback:") describing what to do when this step fails.',
  },
})

export function isPlaceholder(value) {
  const folded = normalizeLabel(value)
  return folded === '' || PLACEHOLDER_VALUES.includes(folded)
}

function push(collector, row) {
  collector.rows.push({ pointer: '/', line: 0, ...row })
}

/**
 * Resolve the declared fields of one section.
 *
 * A field is satisfied only by a label from the vocabulary carrying a value
 * that is not a placeholder. A near-miss label is reported and satisfies
 * nothing: that is the whole point, because a `Recovry:` that quietly counted
 * as recovery would turn a real failure into a green run.
 */
function resolveFields(collector, file, pointerBase, section) {
  const resolved = new Map()
  for (const entry of section.fields) {
    if (entry.field === null) {
      if (entry.nearest === null) continue
      push(collector, {
        file,
        pointer: `${pointerBase}/${FIELD_POINTERS[STEP_FIELDS[entry.nearest.label]]}`,
        line: entry.line,
        ruleId: 'step-field-misspelled',
        message: `Label "${excerpt(displayLabel(entry.rawLabel), 40)}" is not in the field vocabulary but is within ${entry.nearest.distance} edit(s) of "${entry.nearest.label}"; it satisfies nothing.`,
        evidence: excerpt(entry.rawLabel, 60),
        suggestion: `Write the label exactly as "${entry.nearest.label}".`,
      })
      continue
    }
    const pointer = `${pointerBase}/${FIELD_POINTERS[entry.field]}`
    if (resolved.has(entry.field)) {
      push(collector, {
        file,
        pointer,
        line: entry.line,
        ruleId: 'step-field-duplicate',
        message: `"${excerpt(displayLabel(entry.rawLabel), 40)}" restates ${FIELD_POINTERS[entry.field]}, which was already declared on line ${resolved.get(entry.field).line}; the first declaration is the one used.`,
        suggestion: 'Keep one declaration per requirement so there is no doubt which one is in force.',
      })
      continue
    }
    if (isPlaceholder(entry.value)) {
      push(collector, {
        file,
        pointer,
        line: entry.line,
        ruleId: 'step-field-placeholder',
        message: `"${excerpt(displayLabel(entry.rawLabel), 40)}" carries no answer${entry.value === '' ? '' : `, only the placeholder "${excerpt(entry.value, 40)}"`}; it does not satisfy the requirement.`,
        evidence: excerpt(entry.value, 60),
        suggestion: 'Replace the placeholder with the real answer, or delete the label so the gap is honest.',
      })
      resolved.set(entry.field, { line: entry.line, value: '', satisfied: false })
      continue
    }
    resolved.set(entry.field, { line: entry.line, value: entry.value, satisfied: true })
  }
  return resolved
}

function lintCommands(collector, file, pointer, step) {
  for (const command of step.commands) {
    if (command.kind === 'prose') {
      push(collector, {
        file,
        pointer: `${pointer}/commands`,
        line: command.line,
        ruleId: 'command-in-prose',
        message: 'Command text sits in prose with no fenced block around it, so where it starts and ends is a guess.',
        evidence: excerpt(command.text, 120),
        suggestion: 'Move the command into a fenced block with a language tag so its boundaries are exact.',
      })
      continue
    }
    push(collector, {
      file,
      pointer: `${pointer}/commands`,
      line: command.line,
      ruleId: 'command-inline-span',
      message: 'Command with arguments is written as an inline code span; an inline span cannot hold a line break, so a longer command loses lines when it is copied.',
      evidence: excerpt(command.text, 120),
      suggestion: 'Move the command into a fenced block with a language tag.',
    })
  }
  for (const fence of step.fences) {
    if (fence.info !== '') continue
    push(collector, {
      file,
      pointer: `${pointer}/commands`,
      line: fence.line,
      ruleId: 'command-fence-unlabelled',
      message: 'Fenced block carries no language tag, so a reader cannot tell whether it is a command to run or output to compare against.',
      suggestion: 'Tag the fence, for example ```sh for a command and ```text for expected output.',
    })
  }
}

function lintNumbering(collector, file, steps) {
  const numbered = steps.filter((step) => step.number !== null)
  if (numbered.length === 0 || numbered.length !== steps.length) return
  for (let index = 0; index < steps.length; index += 1) {
    const step = steps[index]
    if (step.number === index + 1) continue
    push(collector, {
      file,
      pointer: `/steps/${step.index}`,
      line: step.line,
      ruleId: 'step-numbering-gap',
      message: `Step headings are numbered, but the step in position ${index + 1} is numbered ${step.number}; a reader following "go back to step ${index + 1}" lands somewhere else.`,
      evidence: excerpt(step.title, 60),
      suggestion: 'Renumber the steps so the numbers run 1, 2, 3 in document order.',
    })
    return
  }
}

function lintDuplicateHeadings(collector, file, steps) {
  const seen = new Map()
  for (const step of steps) {
    if (step.normalizedTitle === '') continue
    const first = seen.get(step.normalizedTitle)
    if (first === undefined) {
      seen.set(step.normalizedTitle, step)
      continue
    }
    push(collector, {
      file,
      pointer: `/steps/${step.index}`,
      line: step.line,
      ruleId: 'step-heading-duplicate',
      message: `Step heading repeats the heading of the step on line ${first.line}, so a reference to it by name is ambiguous.`,
      evidence: excerpt(step.title, 60),
      suggestion: 'Give each step a distinct heading.',
    })
  }
}

/**
 * Lint one parsed document.
 *
 * Returns the findings, the per-document counts, and whether evidence was
 * missing. `incomplete` is set on every path where the document was not read to
 * the end or a step was not fully examined -- a limit that stopped the parse,
 * an unterminated fence, a document with no steps. Several of those findings
 * are warnings, which makes that flag the only thing standing between an
 * unexamined document and a `pass`; each has a test that fails when the flag is
 * removed.
 */
export function lintDocument(file, parsed, options = {}) {
  const limits = options.limits ?? {}
  const collector = { rows: [], incomplete: false }
  const stats = {
    steps: parsed.steps.length,
    fences: 0,
    looseCommands: 0,
    satisfied: { expectedOutput: 0, owner: 0, prerequisites: 0, recovery: 0 },
  }

  const preambleResolved = resolveFields(collector, file, '/preamble', parsed.preamble)
  for (const [field, entry] of preambleResolved) {
    if (field === 'owner' || !entry.satisfied) continue
    push(collector, {
      file,
      pointer: `/preamble/${FIELD_POINTERS[field]}`,
      line: entry.line,
      ruleId: 'document-field-not-inherited',
      message: `"${FIELD_POINTERS[field]}" is stated before the first step; only "owner" is inherited by steps, so this satisfies no step.`,
      suggestion: 'State this requirement inside each step it applies to; a document-wide answer to a step-specific question is the vagueness this linter exists to find.',
    })
  }
  const inheritedOwner = preambleResolved.get('owner')
  const ownerInherited = inheritedOwner !== undefined && inheritedOwner.satisfied

  if (parsed.unterminatedFence !== null) {
    push(collector, {
      file,
      pointer: '/',
      line: parsed.unterminatedFence.line,
      ruleId: 'fence-unterminated',
      message: 'A fenced block was opened and never closed, so the rest of the document was read as command text and no step after it was examined.',
      suggestion: 'Close the fence. Until it is closed, this run has not seen the whole runbook.',
    })
    collector.incomplete = true
  }

  if (parsed.overflow !== null) {
    push(collector, {
      file,
      pointer: '/',
      line: parsed.overflow.line,
      ruleId: 'too-many-steps',
      message: `Document holds more than the maxSteps limit of ${limits.maxSteps}; the scan stopped at this heading and no later step was examined.`,
      evidence: excerpt(parsed.overflow.title, 60),
      suggestion: 'Raise --max-steps or split the runbook.',
    })
    collector.incomplete = true
  }

  for (const step of parsed.steps) {
    const pointer = `/steps/${step.index}`
    if (step.truncated) {
      push(collector, {
        file,
        pointer,
        line: step.line,
        ruleId: 'step-too-long',
        message: `Step body exceeded the maxStepLines limit of ${limits.maxStepLines}; the rest of the step was not examined, so nothing here says whether it states an owner, an expected output or a recovery path.`,
        evidence: excerpt(step.title, 60),
        suggestion: 'Raise --max-step-lines or split the step.',
      })
      collector.incomplete = true
      continue
    }

    const resolved = resolveFields(collector, file, pointer, step)
    stats.fences += step.fences.length
    stats.looseCommands += step.commands.length
    lintCommands(collector, file, pointer, step)

    for (const field of FIELD_NAMES) {
      const entry = resolved.get(field)
      if (entry !== undefined && entry.satisfied) {
        stats.satisfied[field] += 1
        continue
      }
      if (field === 'owner' && ownerInherited) {
        stats.satisfied.owner += 1
        continue
      }
      const rule = MISSING_RULES[field]
      push(collector, {
        file,
        pointer: `${pointer}/${FIELD_POINTERS[field]}`,
        line: step.line,
        ruleId: rule.ruleId,
        message: rule.message,
        evidence: excerpt(step.title, 60),
        suggestion: rule.suggestion,
      })
    }
  }

  lintDuplicateHeadings(collector, file, parsed.steps)
  lintNumbering(collector, file, parsed.steps)

  /**
   * A document that yielded no step was not linted, whatever its findings say.
   * Calling that a pass would be green on no evidence, so it is reported and
   * the run is incomplete. The finding is a warning; the flag below is what
   * actually prevents the pass.
   */
  if (parsed.steps.length === 0 && parsed.overflow === null) {
    push(collector, {
      file,
      pointer: '/',
      line: 0,
      ruleId: 'no-steps-found',
      message: `No heading at level ${parsed.stepLevel} was found, so this document contributed no step and nothing in it was checked.`,
      suggestion: `Use level-${parsed.stepLevel} headings for steps, or set --step-level to the level this runbook uses.`,
    })
    collector.incomplete = true
  }

  return { rows: collector.rows, incomplete: collector.incomplete, stats }
}

/** Findings sort by file, then line, then pointer, rule and message. All by code unit. */
export function sortRows(rows) {
  return rows.sort((left, right) =>
    byCodeUnit(left.file, right.file) ||
    left.line - right.line ||
    byCodeUnit(left.pointer, right.pointer) ||
    byCodeUnit(left.ruleId, right.ruleId) ||
    byCodeUnit(left.message, right.message))
}
