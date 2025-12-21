import assert from 'node:assert/strict'
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { DEFAULT_LIMITS, lintRunbookText, lintRunbooks, validateLimits, validateStepLevel } from '../src/index.mjs'

const STEP = [
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

async function withRoot(body) {
  const directory = await mkdtemp(join(tmpdir(), 'runbook-step-linter-'))
  try {
    return await body(directory)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

function ruleIds(report) {
  return report.findings.map((finding) => finding.ruleId)
}

test('a clean root passes and reports what it actually checked', async () => {
  await withRoot(async (root) => {
    await writeFile(join(root, 'drain.md'), STEP)
    const report = await lintRunbooks({ root })

    assert.equal(report.status, 'pass')
    assert.deepEqual(report.findings, [])
    assert.equal(report.summary.checked, 1)
    assert.equal(report.summary.documents, 1)
    assert.equal(report.summary.stepsWithRecovery, 1)
  })
})

/**
 * Defect class: green on no evidence. `pass` with `checked: 0` must not be
 * reachable. The finding that accompanies this path is a warning, so the
 * `incomplete` flag is the only thing preventing a pass -- delete it and this
 * test reports `pass`.
 */
test('a root with no runbook is incomplete, never a pass', async () => {
  await withRoot(async (root) => {
    await writeFile(join(root, 'readme.md'), '# Not a runbook\n')
    const report = await lintRunbooks({ root })

    assert.equal(report.summary.checked, 0)
    assert.equal(ruleIds(report).includes('no-documents-found'), true)
    assert.equal(report.status, 'incomplete', 'checked: 0 must never be a pass')
    assert.equal(report.summary.errors, 0, 'nothing here is an error, so only the flag prevents a pass')
  })
})

test('a document with no step at the configured level is incomplete, never a pass', async () => {
  await withRoot(async (root) => {
    await writeFile(join(root, 'notes.md'), '# Notes\n\nSome prose, no steps.\n')
    const report = await lintRunbooks({ root })

    assert.equal(ruleIds(report).includes('no-steps-found'), true)
    assert.equal(report.status, 'incomplete')
    assert.equal(report.summary.errors, 0, 'both findings are warnings, so only the flag prevents a pass')
  })
})

/**
 * The same invariant, isolated. Above, the root-level "no step anywhere" guard
 * also sets the flag, so that test would still pass if the per-document one
 * were deleted -- an invariant true only by accident. Here one document is
 * clean, so the run has evidence and the root-level guard stays silent: the
 * per-document flag is the only thing standing between an unexamined document
 * and a pass.
 */
test('one unexamined document makes the whole run incomplete even when another passes', async () => {
  await withRoot(async (root) => {
    await writeFile(join(root, 'drain.md'), STEP)
    await writeFile(join(root, 'notes.md'), '# Notes\n\nSome prose, no steps.\n')
    const report = await lintRunbooks({ root })

    assert.equal(report.summary.checked, 1, 'the clean document was checked, so the root-level guard does not fire')
    assert.equal(ruleIds(report).includes('no-documents-found'), false)
    assert.equal(ruleIds(report).includes('no-steps-found'), true)
    assert.equal(report.summary.errors, 0, 'nothing here is an error, so only the flag prevents a pass')
    assert.equal(report.status, 'incomplete')
  })
})

test('--step-level decides what counts as a step, and is actually wired through', async () => {
  await withRoot(async (root) => {
    const second = STEP.replace('1. Cordon the node', '2. Drain the node')
    await writeFile(join(root, 'deep.md'), `# Title\n\n## Section\n\n#${STEP}\n#${second}`)

    const deep = await lintRunbooks({ root, stepLevel: 3 })
    assert.equal(deep.summary.checked, 2, 'two level-3 headings are two steps')
    assert.equal(deep.status, 'pass')

    // At level 2 the same file holds one step whose body swallows both sets of
    // fields, so each requirement is declared twice. Different level, different
    // answer: the option is not being ignored.
    const shallow = await lintRunbooks({ root, stepLevel: 2 })
    assert.equal(shallow.summary.checked, 1)
    assert.equal(ruleIds(shallow).filter((id) => id === 'step-field-duplicate').length, 4)
  })
})

/**
 * Defect class: lexical-only path confinement, and its over-correction. A
 * symlink out of the tree is refused on its real path, and its content never
 * reaches the report.
 */
test('a symlink escaping the root is refused and its content is never read', async () => {
  await withRoot(async (base) => {
    const root = join(base, 'runbooks')
    const outside = join(base, 'outside')
    await mkdir(root)
    await mkdir(outside)
    await writeFile(join(outside, 'secret.md'), `${STEP}\nOUTSIDE_CONTENT_MARKER\n`)
    await writeFile(join(root, 'real.md'), STEP)
    await symlink(join(outside, 'secret.md'), join(root, 'escape.md'))

    const report = await lintRunbooks({ root })
    const escaped = report.findings.filter((finding) => finding.ruleId === 'path-escapes-root')

    assert.equal(escaped.length, 1)
    assert.equal(escaped[0].location.file, 'escape.md')
    assert.equal(report.summary.documents, 1, 'only the real document was collected')
    assert.equal(JSON.stringify(report).includes('OUTSIDE_CONTENT_MARKER'), false, 'out-of-root content leaked into the report')
  })
})

/**
 * The over-correction: comparing a realpath'd root against a target that was
 * not resolved refuses files that genuinely are inside the root. A false
 * refusal is a bug too.
 */
test('a file genuinely inside a symlinked root is still linted', async () => {
  await withRoot(async (base) => {
    const real = join(base, 'real-runbooks')
    await mkdir(real)
    await writeFile(join(real, 'drain.md'), STEP)
    const link = join(base, 'runbooks-link')
    await symlink(real, link)

    const report = await lintRunbooks({ root: link })
    assert.equal(report.status, 'pass')
    assert.equal(report.summary.checked, 1)
    assert.equal(ruleIds(report).includes('path-escapes-root'), false, 'the root was reached through a symlink, not escaped')
  })
})

test('a symlinked subdirectory that stays inside the root is linted, not refused', async () => {
  await withRoot(async (root) => {
    const real = join(root, 'shared')
    await mkdir(real)
    await writeFile(join(real, 'drain.md'), STEP)
    await symlink(real, join(root, 'alias'))

    const report = await lintRunbooks({ root })
    assert.equal(ruleIds(report).includes('path-escapes-root'), false)
    assert.equal(report.summary.documents, 1, 'the same real path is not collected twice')
    assert.equal(report.status, 'pass')
  })
})

test('bytes that are not UTF-8 make the run incomplete and are never parsed', async () => {
  await withRoot(async (root) => {
    await writeFile(join(root, 'good.md'), STEP)
    await writeFile(join(root, 'bad.md'), Buffer.from([0x23, 0x23, 0x20, 0xff, 0xfe, 0x0a]))

    const report = await lintRunbooks({ root })
    assert.equal(ruleIds(report).includes('document-not-utf8'), true)
    assert.equal(report.status, 'incomplete')
    assert.equal(report.summary.skipped, 1)
    assert.equal(report.summary.documents, 2)
  })
})

test('a document that cannot be opened makes the run incomplete', async () => {
  await withRoot(async (root) => {
    // The clean sibling keeps `checked` above zero so the root-level guard stays
    // silent and this path's own flag is what prevents the pass.
    await writeFile(join(root, 'good.md'), STEP)
    const locked = join(root, 'locked.md')
    await writeFile(locked, STEP)
    await chmod(locked, 0o000)
    try {
      const report = await lintRunbooks({ root })
      assert.equal(ruleIds(report).includes('document-unreadable'), true)
      assert.equal(ruleIds(report).includes('no-documents-found'), false)
      assert.equal(report.summary.checked, 1)
      assert.equal(report.summary.skipped, 1)
      assert.equal(report.status, 'incomplete')
    } finally {
      await chmod(locked, 0o600)
    }
  })
})

test('an entry named like a runbook that is not a regular file is reported, not opened', async () => {
  await withRoot(async (root) => {
    await writeFile(join(root, 'drain.md'), STEP)
    const socketPath = join(root, 'socket.md')
    const server = createServer()
    await new Promise((resolve, reject) => {
      server.once('error', reject)
      server.listen(socketPath, resolve)
    })
    try {
      const report = await lintRunbooks({ root })
      const unreadable = report.findings.filter((finding) => finding.ruleId === 'document-unreadable')
      assert.equal(unreadable.length, 1)
      assert.equal(unreadable[0].location.file, 'socket.md')
      assert.equal(report.status, 'incomplete', 'an unexamined runbook-shaped entry must not sit inside a passing run')
    } finally {
      await new Promise((resolve) => server.close(resolve))
    }
  })
})

test('maxDocuments stops the scan with a named finding and an incomplete run', async () => {
  await withRoot(async (root) => {
    await writeFile(join(root, 'a.md'), STEP)
    await writeFile(join(root, 'b.md'), STEP)

    const bounded = await lintRunbooks({ root, limits: { maxDocuments: 1 } })
    assert.equal(ruleIds(bounded).includes('too-many-documents'), true)
    assert.equal(bounded.status, 'incomplete')
    assert.equal(bounded.summary.documents, 1)

    const whole = await lintRunbooks({ root, limits: { maxDocuments: 2 } })
    assert.equal(whole.status, 'pass', 'the same tree inside the limit passes, so the limit is what stopped it')
  })
})

test('maxDocumentBytes refuses to parse an oversized document', async () => {
  await withRoot(async (root) => {
    // A clean sibling keeps `checked` above zero, so the root-level "nothing was
    // linted" guard stays silent and this limit's own flag is what prevents the
    // pass.
    await writeFile(join(root, 'small.md'), STEP)
    await writeFile(join(root, 'big.md'), `${STEP}${'padding padding padding\n'.repeat(200)}`)

    const bounded = await lintRunbooks({ root, limits: { maxDocumentBytes: 1024 } })
    assert.equal(ruleIds(bounded).includes('document-too-large'), true)
    assert.equal(ruleIds(bounded).includes('no-documents-found'), false)
    assert.equal(bounded.summary.checked, 1)
    assert.equal(bounded.summary.skipped, 1)
    assert.equal(bounded.status, 'incomplete')

    const whole = await lintRunbooks({ root, limits: { maxDocumentBytes: 65536 } })
    assert.equal(whole.status, 'pass', 'the same tree inside the limit passes, so the limit is what stopped it')
  })
})

test('maxDepth stops the walk with a named finding and an incomplete run', async () => {
  await withRoot(async (root) => {
    const nested = join(root, 'one', 'two')
    await mkdir(nested, { recursive: true })
    await writeFile(join(nested, 'drain.md'), STEP)
    // As above: a clean document at the top keeps the root-level guard silent.
    await writeFile(join(root, 'top.md'), STEP)

    const bounded = await lintRunbooks({ root, limits: { maxDepth: 1 } })
    assert.equal(ruleIds(bounded).includes('directory-too-deep'), true)
    assert.equal(ruleIds(bounded).includes('no-documents-found'), false)
    assert.equal(bounded.summary.checked, 1)
    assert.equal(bounded.status, 'incomplete')

    const whole = await lintRunbooks({ root, limits: { maxDepth: 2 } })
    assert.equal(whole.summary.checked, 2)
    assert.equal(whole.status, 'pass')
  })
})

test('maxSteps stops a document with a named finding and an incomplete run', () => {
  const text = [STEP, STEP.replace('1. Cordon the node', '2. Drain the node')].join('\n')
  const bounded = lintRunbookText(text, { file: 'a.md', limits: { maxSteps: 1 } })
  assert.equal(ruleIds(bounded).includes('too-many-steps'), true)
  assert.equal(bounded.status, 'incomplete')
  assert.equal(bounded.summary.checked, 1)

  const whole = lintRunbookText(text, { file: 'a.md', limits: { maxSteps: 2 } })
  assert.equal(whole.status, 'pass')
  assert.equal(whole.summary.checked, 2)
})

/**
 * A truncated step is the sharpest case: nothing in the unexamined remainder
 * says whether the step states an owner or a recovery path, so reporting
 * anything but `incomplete` would be a verdict on evidence never obtained.
 */
test('maxStepLines truncates a step, reports it, and makes the run incomplete', () => {
  const padded = STEP.replace('```sh\n', `${'filler\n'.repeat(20)}\`\`\`sh\n`)
  const bounded = lintRunbookText(padded, { file: 'a.md', limits: { maxStepLines: 5 } })

  assert.equal(ruleIds(bounded).includes('step-too-long'), true)
  assert.equal(bounded.status, 'incomplete')
  assert.equal(bounded.summary.stepsWithRecovery, 0, 'nothing was concluded about the unexamined remainder')
  assert.equal(ruleIds(bounded).includes('step-recovery-missing'), false, 'and nothing was concluded against it either')

  const whole = lintRunbookText(padded, { file: 'a.md', limits: { maxStepLines: 400 } })
  assert.equal(whole.status, 'pass')
})

test('an unterminated fence makes the run incomplete rather than reporting what it never saw', () => {
  const text = `${STEP.replace(/```\n$/, '')}\n## 2. Drain the node\n\nOwner: platform-oncall\n`
  const report = lintRunbookText(text, { file: 'a.md' })

  assert.equal(ruleIds(report).includes('fence-unterminated'), true)
  assert.equal(report.status, 'incomplete')
  assert.equal(report.summary.checked, 1, 'the second step was inside the open fence and was never read')
})

test('readme.md, index.md, dotfiles and node_modules are skipped by name', async () => {
  await withRoot(async (root) => {
    await writeFile(join(root, 'drain.md'), STEP)
    await writeFile(join(root, 'README.md'), '# Nope\n')
    await writeFile(join(root, 'index.md'), '# Nope\n')
    await writeFile(join(root, 'notes.txt'), 'not markdown')
    await mkdir(join(root, '.hidden'))
    await writeFile(join(root, '.hidden', 'drain.md'), '# Nope\n')
    await mkdir(join(root, 'node_modules'))
    await writeFile(join(root, 'node_modules', 'drain.md'), '# Nope\n')

    const report = await lintRunbooks({ root })
    assert.equal(report.summary.documents, 1)
    assert.equal(report.status, 'pass')
  })
})

test('findings are ordered by file whatever order the filesystem returned', async () => {
  await withRoot(async (root) => {
    for (const name of ['zulu.md', 'alpha.md', 'mike.md']) {
      await writeFile(join(root, name), '## 1. Do it\n\nnothing\n')
    }
    const report = await lintRunbooks({ root })
    const files = [...new Set(report.findings.map((finding) => finding.location.file))]

    assert.deepEqual(files, ['alpha.md', 'mike.md', 'zulu.md'])
    assert.notDeepEqual(files, ['zulu.md', 'alpha.md', 'mike.md'])
  })
})

/**
 * Directory entries are sorted before use, and the visible consequence is which
 * document survives a document-count cut-off. Without that sort the answer is
 * whatever order the filesystem happened to return, which is exactly the
 * non-determinism the report contract forbids.
 */
test('the document-count cut-off keeps the code-unit-first document, not the first one enumerated', async () => {
  await withRoot(async (root) => {
    const bare = '## 1. Do the thing\n\nNothing is stated here.\n'
    for (const name of ['zulu.md', 'alpha.md', 'mike.md']) {
      await writeFile(join(root, name), bare)
    }
    const report = await lintRunbooks({ root, limits: { maxDocuments: 1 } })
    const linted = [...new Set(
      report.findings.filter((finding) => finding.ruleId === 'step-recovery-missing').map((finding) => finding.location.file),
    )]
    const stopped = report.findings.filter((finding) => finding.ruleId === 'too-many-documents')

    assert.deepEqual(linted, ['alpha.md'], 'the walk must visit entries in code-unit order')
    assert.equal(stopped.length, 1)
    assert.equal(stopped[0].location.file, 'mike.md', 'and must stop at the next one in that same order')
    assert.equal(report.status, 'incomplete')
  })
})

test('lintRunbooks refuses configuration it cannot honour', async () => {
  await withRoot(async (root) => {
    await writeFile(join(root, 'drain.md'), STEP)
    await assert.rejects(() => lintRunbooks({ root, roots: root }), /Unknown option "roots"/)
    await assert.rejects(() => lintRunbooks({ root, limits: { maxStep: 1 } }), /Unknown limit "maxStep"/)
    await assert.rejects(() => lintRunbooks({ root, limits: { maxSteps: 0 } }), /positive integer/)
    await assert.rejects(() => lintRunbooks({ root, stepLevel: 0 }), /between 1 and 6/)
    await assert.rejects(() => lintRunbooks({ root: join(root, 'missing') }), /could not be read/)
    await assert.rejects(() => lintRunbooks({ root: join(root, 'drain.md') }), /must be a directory/)
    await assert.rejects(() => lintRunbooks({}), /root is required/)
  })
})

test('validateLimits and validateStepLevel default to the documented values', () => {
  assert.deepEqual(validateLimits(), { ...DEFAULT_LIMITS })
  assert.equal(validateLimits({ maxSteps: 7 }).maxSteps, 7)
  assert.equal(validateLimits({ maxSteps: 7 }).maxDepth, DEFAULT_LIMITS.maxDepth)
  assert.equal(validateStepLevel(), 2)
  assert.equal(validateStepLevel(4), 4)
  assert.throws(() => validateLimits({ maxSteps: 1.5 }), /positive integer/)
})
