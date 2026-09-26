import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { access, constants, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const run = promisify(execFile)
const projectDirectory = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const CLI = join(projectDirectory, 'bin/runbook-step-linter.mjs')
const CLEAN_ROOT = join(projectDirectory, 'examples/runbook-clean')
const BROKEN_ROOT = join(projectDirectory, 'examples/runbook-broken')

/**
 * Run the real binary and report what actually reached each stream.
 *
 * `killed` matters: a run that had to be killed produced no report at all, and
 * a test that only parses stdout would report that as a parse error rather
 * than as the hang it is.
 */
async function cli(args, options = {}) {
  try {
    const { stdout, stderr } = await run(process.execPath, [CLI, ...args], { cwd: projectDirectory, ...options })
    return { code: 0, stdout, stderr, killed: false }
  } catch (error) {
    return { code: error.code, stdout: error.stdout, stderr: error.stderr, killed: error.killed === true, signal: error.signal }
  }
}

async function withRoot(body) {
  const directory = await mkdtemp(join(tmpdir(), 'runbook-step-linter-cli-'))
  try {
    return await body(directory)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

const STEP = [
  '## 1. Cordon the node',
  '',
  '- **Owner:** platform-oncall',
  '- **Prerequisites:** cluster access confirmed',
  '- **Expected output:** the node reports SchedulingDisabled',
  '- **Recovery:** uncordon the node and stop',
  '',
].join('\n')

test('the binary carries a shebang and is executable', async () => {
  const source = await readFile(CLI, 'utf8')
  assert.equal(source.startsWith('#!/usr/bin/env node\n'), true)
  await access(CLI, constants.X_OK)
})

test('--help prints usage on stdout and exits 0', async () => {
  const result = await cli(['--help'])
  assert.equal(result.code, 0)
  assert.equal(result.stdout.includes('runbook-step-linter'), true)
  assert.equal(result.stdout.includes('--step-level'), true)
  assert.equal(result.stdout.includes('never executed'), true)
  assert.equal(result.stderr, '')
})

test('the clean example exits 0 with a human summary on stdout', async () => {
  const result = await cli(['--root', CLEAN_ROOT])
  assert.equal(result.code, 0)
  assert.equal(result.stdout.includes('status pass'), true)
  assert.equal(result.stdout.includes('No command was executed.'), true)
})

test('the broken example exits 1 and names the step with no recovery path', async () => {
  const result = await cli(['--root', BROKEN_ROOT])
  assert.equal(result.code, 1)
  assert.equal(result.stdout.includes('step-recovery-missing'), true)
  assert.equal(result.stdout.includes('status fail'), true)
})

test('--json puts a parseable report on stdout and nothing else', async () => {
  const result = await cli(['--root', BROKEN_ROOT, '--json'])
  assert.equal(result.code, 1)

  const report = JSON.parse(result.stdout)
  assert.equal(report.schemaVersion, '1')
  assert.equal(report.tool, 'runbook-step-linter')
  assert.equal(report.status, 'fail')
  assert.equal(report.findings.some((finding) => finding.ruleId === 'step-recovery-missing'), true)
})

test('a destructive command in the broken example is quoted as evidence and nothing else happened', async () => {
  const before = await readFile(join(BROKEN_ROOT, 'restart-the-ingest-worker.md'), 'utf8')
  const result = await cli(['--root', BROKEN_ROOT, '--json'])
  const report = JSON.parse(result.stdout)
  const prose = report.findings.filter((finding) => finding.ruleId === 'command-in-prose')

  assert.equal(prose.some((finding) => finding.evidence.includes('rm -rf /var/lib/ingest/spool')), true)
  assert.equal(await readFile(join(BROKEN_ROOT, 'restart-the-ingest-worker.md'), 'utf8'), before, 'the document was modified')
})

test('an unknown option exits 2 with an EMPTY stdout and the message on stderr', async () => {
  const result = await cli(['--root', CLEAN_ROOT, '--step-levels', '2'])
  assert.equal(result.code, 2)
  assert.equal(result.stdout, '', 'a configuration error never had a subject, so there is nothing to report')
  assert.equal(result.stderr.includes('Unknown option "--step-levels"'), true)
})

test('a one-character typo in a limit flag is refused rather than ignored', async () => {
  const result = await cli(['--root', BROKEN_ROOT, '--max-step', '1'])
  assert.equal(result.code, 2)
  assert.equal(result.stdout, '')
  assert.equal(result.stderr.includes('Unknown option'), true)
})

test('a repeated value-carrying flag is refused instead of silently overwriting', async () => {
  const result = await cli(['--root', CLEAN_ROOT, '--root', BROKEN_ROOT])
  assert.equal(result.code, 2)
  assert.equal(result.stdout, '')
  assert.equal(result.stderr.includes('--root was given more than once'), true)
})

test('a missing or unusable --root exits 2 with an empty stdout', async () => {
  const missing = await cli([])
  assert.equal(missing.code, 2)
  assert.equal(missing.stdout, '')
  assert.equal(missing.stderr.includes('--root is required'), true)

  const absent = await cli(['--root', join(projectDirectory, 'examples/does-not-exist')])
  assert.equal(absent.code, 2)
  assert.equal(absent.stdout, '')
  assert.equal(absent.stderr.includes('could not be read'), true)

  const noValue = await cli(['--root'])
  assert.equal(noValue.code, 2)
  assert.equal(noValue.stdout, '')
  assert.equal(noValue.stderr.includes('--root requires a value'), true)
})

test('--step-level is validated before anything is read', async () => {
  const result = await cli(['--root', CLEAN_ROOT, '--step-level', '9'])
  assert.equal(result.code, 2)
  assert.equal(result.stdout, '')
  assert.equal(result.stderr.includes('between 1 and 6'), true)
})

test('an unreadable input exits 2 WITH an incomplete report on stdout', async () => {
  await withRoot(async (root) => {
    await writeFile(join(root, 'good.md'), STEP)
    await writeFile(join(root, 'bad.md'), Buffer.from([0x23, 0x23, 0x20, 0xff, 0xfe, 0x0a]))

    const result = await cli(['--root', root, '--json'])
    assert.equal(result.code, 2)

    const report = JSON.parse(result.stdout)
    assert.equal(report.status, 'incomplete', 'a consumer needs the report to know which input was not read')
    assert.equal(report.findings.some((finding) => finding.ruleId === 'document-not-utf8'), true)
    assert.equal(result.stderr.includes('incomplete:'), true)
  })
})

/**
 * The stderr diagnostic is the only place a human is told how much of the run
 * was not done. It counted only documents that failed to load, so a run made
 * incomplete by an entry refused before collection announced "0 document(s)
 * were not linted out of 1 found" -- a self-contradiction, and the one entry
 * that mattered invisible in both numbers.
 */
test('the incomplete diagnostic names the entry that was not linted', async () => {
  await withRoot(async (root) => {
    await writeFile(join(root, 'good.md'), STEP)
    await symlink(join(root, 'nothing-here.md'), join(root, 'dangling.md'))

    const result = await cli(['--root', root, '--json'])
    assert.equal(result.code, 2)

    const report = JSON.parse(result.stdout)
    assert.equal(report.status, 'incomplete')
    assert.equal(report.summary.skipped, 1)
    assert.equal(report.summary.documents, 2)
    assert.equal(
      result.stderr.includes('1 document(s) of 2 found were not linted'),
      true,
      `the diagnostic hides the entry that made the run incomplete: ${result.stderr}`,
    )
    assert.equal(result.stderr.includes('1 step(s) of 1 found were read'), true)
    assert.equal(result.stdout.includes('incomplete:'), false, 'and it stays off stdout')
  })
})

test('the incomplete diagnostic counts steps too, for a run where every document was linted', async () => {
  await withRoot(async (root) => {
    const padded = STEP.replace('- **Recovery:**', `${'filler\n'.repeat(20)}- **Recovery:**`)
    await writeFile(join(root, 'long.md'), padded)

    const result = await cli(['--root', root, '--json', '--max-step-lines', '5'])
    assert.equal(result.code, 2)
    assert.equal(result.stderr.includes('0 document(s) of 1 found were not linted'), true)
    assert.equal(
      result.stderr.includes('0 step(s) of 1 found were read'),
      true,
      `a cut-short step leaves every document linted, so the step counts are what say so: ${result.stderr}`,
    )
  })
})

test('a root that holds no step exits 2 and never reports a pass', async () => {
  await withRoot(async (root) => {
    await writeFile(join(root, 'notes.md'), '# Just prose\n\nNo steps here.\n')
    const result = await cli(['--root', root, '--json'])

    assert.equal(result.code, 2)
    const report = JSON.parse(result.stdout)
    assert.equal(report.summary.checked, 0)
    assert.equal(report.status, 'incomplete')
  })
})

test('a limit flag is wired through to the run, not accepted and ignored', async () => {
  await withRoot(async (root) => {
    await writeFile(join(root, 'two.md'), `${STEP}\n${STEP.replace('1. Cordon', '2. Drain')}`)

    const bounded = JSON.parse((await cli(['--root', root, '--json', '--max-steps', '1'])).stdout)
    assert.equal(bounded.status, 'incomplete')
    assert.equal(bounded.summary.checked, 1)
    assert.equal(bounded.findings.some((finding) => finding.ruleId === 'too-many-steps'), true)

    const whole = await cli(['--root', root, '--json'])
    assert.equal(whole.code, 0)
    assert.equal(JSON.parse(whole.stdout).summary.checked, 2)
  })
})

test('--step-level is wired through to the run', async () => {
  await withRoot(async (root) => {
    await writeFile(join(root, 'deep.md'), `# Title\n\n## Section\n\n#${STEP}`)

    const level3 = await cli(['--root', root, '--json', '--step-level', '3'])
    assert.equal(level3.code, 0)
    assert.equal(JSON.parse(level3.stdout).summary.checked, 1)

    const level4 = await cli(['--root', root, '--json', '--step-level', '4'])
    assert.equal(level4.code, 2, 'no level-4 heading exists, so nothing was checked')
    assert.equal(JSON.parse(level4.stdout).summary.checked, 0)
  })
})

test('diagnostics go to stderr so stdout stays pipeable', async () => {
  await withRoot(async (root) => {
    await writeFile(join(root, 'good.md'), STEP)
    await writeFile(join(root, 'bad.md'), Buffer.from([0xff, 0xfe]))

    const result = await cli(['--root', root, '--json'])
    assert.doesNotThrow(() => JSON.parse(result.stdout))
    assert.notEqual(result.stderr, '')
    assert.equal(result.stdout.includes('incomplete:'), false, 'the stderr diagnostic must not be on stdout')
  })
})

/**
 * Defect class: a guard whose stated reason nobody tested. The `isFile` check
 * exists because "reading one can block forever", and the suite's only
 * non-regular-file fixture is a unix socket -- whose read fails instantly, so
 * it lands on the same finding by a path that actually opened the entry. The
 * guard can be deleted and that test still passes.
 *
 * A FIFO is the case the comment is about: opening one for reading blocks
 * until a writer arrives, which is never. Without the guard the binary hangs
 * with an empty stdout and no report at all; with it, the entry is reported
 * unopened and the run ends immediately.
 */
test('a FIFO named like a runbook is reported without ever being opened', async (t) => {
  await withRoot(async (root) => {
    await writeFile(join(root, 'drain.md'), STEP)
    const fifo = join(root, 'pipe.md')
    try {
      await run('mkfifo', [fifo])
    } catch {
      t.skip('mkfifo is not available on this platform')
      return
    }

    // No writer is ever opened on this FIFO, so an implementation that opens it
    // waits forever and is killed here instead of returning a report.
    const result = await cli(['--root', root, '--json'], { timeout: 15000 })

    assert.equal(result.killed, false, 'the run had to be killed: it opened the FIFO and blocked')
    assert.equal(result.code, 2, 'an unexamined runbook-shaped entry makes the run incomplete')

    const report = JSON.parse(result.stdout)
    const unreadable = report.findings.filter((finding) => finding.ruleId === 'document-unreadable')
    assert.equal(unreadable.length, 1)
    assert.equal(unreadable[0].location.file, 'pipe.md')
    assert.equal(report.status, 'incomplete')
    assert.equal(report.summary.checked, 1, 'the real document beside it was still linted')
  })
})

test('two runs of the binary produce byte-identical stdout', async () => {
  const first = await cli(['--root', BROKEN_ROOT, '--json'])
  const second = await cli(['--root', BROKEN_ROOT, '--json'])
  assert.equal(first.stdout, second.stdout)
  assert.equal(first.stdout.length > 500, true, 'the comparison is over a report with something in it')
})
