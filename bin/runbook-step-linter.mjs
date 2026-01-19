#!/usr/bin/env node

import { lintRunbooks, formatReport } from '../src/index.mjs'

const HELP = `runbook-step-linter

Lint runbook steps for a named owner, stated prerequisites, a checkable
expected output, a recovery path, and unambiguous command boundaries.

Command text found in a runbook is data. It is located, bounded, sanitised and
quoted in the report. It is never executed, evaluated, interpolated into another
command, or passed to a shell. This tool imports no child_process, and nothing
is fetched over a network.

Usage:
  runbook-step-linter --root DIR [--json] [--step-level N] [limits]

Options:
  --root DIR                Directory holding the runbooks (required)
  --json                    Emit the machine-readable report on stdout
  --step-level N            Heading level that marks a step, 1-6 (default 2)
  --max-documents N         Maximum documents to lint (default 500)
  --max-document-bytes N    Maximum bytes per document (default 524288)
  --max-depth N             Maximum directory depth below the root (default 8)
  --max-steps N             Maximum steps per document (default 200)
  --max-step-lines N        Maximum body lines per step (default 400)
  -h, --help                Show this help

Every option that carries a value may be given only once: a repeated flag is a
configuration error, not a silent last-wins. An unknown option is refused, so a
one-character typo cannot quietly turn a real failure into a green run.

Runbooks are read, never written. There is no auto-fix.

Exit codes:
  0  every step carried the evidence it needs
  1  the runbook set failed the check
  2  invalid usage or configuration (no report on stdout), or evidence that was
     missing, undecodable or bounded out (an "incomplete" report on stdout)
`

const LIMIT_FLAGS = new Map([
  ['--max-documents', 'maxDocuments'],
  ['--max-document-bytes', 'maxDocumentBytes'],
  ['--max-depth', 'maxDepth'],
  ['--max-steps', 'maxSteps'],
  ['--max-step-lines', 'maxStepLines'],
])

function parseArguments(argv) {
  if (argv.includes('-h') || argv.includes('--help')) return { help: true }
  const options = { root: null, json: false, stepLevel: null, limits: {} }
  const given = new Set()

  /**
   * A flag that carries a value is accepted once.
   *
   * Letting it repeat discards the earlier value with no diagnostic, so
   * `--root a --root b` lints a directory nobody named and
   * `--max-steps 5 --max-steps 1` enforces a limit nobody asked for. That is
   * the same defect as an ignored typo, which this tool already refuses.
   */
  const once = (name) => {
    if (given.has(name)) throw new Error(`${name} was given more than once`)
    given.add(name)
  }

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    const takeValue = (name) => {
      const value = argv[index + 1]
      if (value === undefined || value.startsWith('-')) throw new Error(`${name} requires a value`)
      index += 1
      return value
    }

    if (argument === '--json') options.json = true
    else if (argument === '--root') {
      once('--root')
      options.root = takeValue('--root')
    } else if (argument === '--step-level') {
      once('--step-level')
      const raw = takeValue('--step-level')
      if (!/^[1-6]$/.test(raw)) throw new Error('--step-level requires an integer between 1 and 6')
      options.stepLevel = Number(raw)
    } else if (LIMIT_FLAGS.has(argument)) {
      once(argument)
      const raw = takeValue(argument)
      if (!/^\d+$/.test(raw) || Number(raw) < 1) throw new Error(`${argument} requires a positive integer`)
      options.limits[LIMIT_FLAGS.get(argument)] = Number(raw)
    } else throw new Error(`Unknown option "${argument}"`)
  }

  if (options.root === null) throw new Error('--root is required')
  return options
}

async function main(argv) {
  let options
  try {
    options = parseArguments(argv)
  } catch (error) {
    process.stderr.write(`${error.message}\n\n${HELP}`)
    return 2
  }
  if (options.help) {
    process.stdout.write(HELP)
    return 0
  }

  let report
  try {
    report = await lintRunbooks({
      root: options.root,
      limits: options.limits,
      ...(options.stepLevel === null ? {} : { stepLevel: options.stepLevel }),
    })
  } catch (error) {
    // Configuration never had a subject, so stdout stays empty.
    process.stderr.write(`${error.message}\n`)
    return 2
  }

  process.stdout.write(options.json ? `${JSON.stringify(report, null, 2)}\n` : formatReport(report))

  if (report.status === 'incomplete') {
    // Both counts, because either one alone can look complete on its own: a
    // step cut short leaves every document linted, and a subtree nobody could
    // read leaves every step that was found read. The findings say which.
    const { checked, documents, skipped, steps } = report.summary
    process.stderr.write(
      `incomplete: ${skipped} document(s) of ${documents} found were not linted, ` +
      `and ${checked} step(s) of ${steps} found were read. The findings say what was not examined.\n`,
    )
    return 2
  }
  return report.status === 'fail' ? 1 : 0
}

process.exitCode = await main(process.argv.slice(2))
