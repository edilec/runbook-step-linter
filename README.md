# runbook-step-linter

Lint runbook steps for the five things a person woken at 03:00 actually needs: a named **owner**,
stated **prerequisites**, an **expected output** that makes success checkable, a **recovery path**
for when it fails, and **command boundaries** that leave no doubt where a command starts and ends.

- **Repository:** [edilec/runbook-step-linter](https://github.com/edilec/runbook-step-linter)
- **Area:** Docs & Knowledge
- **License:** MIT
- **Dependencies:** none. Node built-ins only, Node >= 22.

## Command text is data

A command found in a runbook is located, bounded, sanitised, and quoted back as evidence. It is
**never executed, evaluated, interpolated into another command, or handed to a shell.** This package
imports no `node:child_process`, calls no `eval`, and builds no `Function`; `test/no-execution.test.mjs`
fails if any of that changes, and separately lints a fixture whose fenced block would create a marker
file if anything ran it, then asserts the marker does not exist.

A runbook is untrusted input in exactly the way a web page is. A linter that ran what it read would
be a remote code execution primitive dressed as a documentation tool.

Nothing is fetched over a network, and no runbook is ever written to. There is no auto-fix.

## Install

```sh
npm install runbook-step-linter
```

Or run it from a checkout with no install at all:

```sh
node bin/runbook-step-linter.mjs --root docs/runbooks
```

## Use

```sh
runbook-step-linter --root docs/runbooks
runbook-step-linter --root docs/runbooks --json
runbook-step-linter --root docs/runbooks --step-level 3 --max-steps 40
```

The human summary goes to stdout; `--json` replaces it with the machine-readable report. Diagnostics
go to stderr, always.

```
8 step(s) linted in 2 document(s): 0 error, 0 warning, 0 info, status pass.
evidence: owner 8/8, prerequisites 8/8, expected output 8/8, recovery 8/8.
commands: 9 fenced block(s), 0 outside a fence. No command was executed.
```

The deliberately broken example shows what a finding looks like, including a destructive command
quoted as evidence and nothing more:

```
ERROR  restart-the-ingest-worker.md:9/steps/1/recovery step-recovery-missing Step states no
       recovery path, so there is no written answer to "it failed, now what?".
ERROR  restart-the-ingest-worker.md:15/steps/1/commands command-in-prose Command text sits in
       prose with no fenced block around it -- sudo systemctl stop edilec-ingest && rm -rf ...
```

Try both example sets:

```sh
node bin/runbook-step-linter.mjs --root examples/runbook-clean    # exits 0
node bin/runbook-step-linter.mjs --root examples/runbook-broken   # exits 1
```

## What a step looks like

A step is a heading at `--step-level` (default 2). Fields are labelled lines, optionally behind a
list marker and optionally emphasised; a sub-heading whose text is a label works too.

```markdown
## 2. Cordon the node

- **Prerequisites:** step 1 finished and the node was Ready.
- **Expected output:** the node reports Ready,SchedulingDisabled.
- **Recovery:** uncordon the node and stop. Nothing has moved yet.

```sh
kubectl cordon node-7
```
```

`Owner:` may be stated once before the first step and is inherited by every step. The other three
are step-specific and are not inherited, because a document-wide answer to a step-specific question
is exactly the vagueness this linter exists to find.

## API

```js
import { lintRunbooks, lintRunbookText, formatReport } from 'runbook-step-linter'

const report = await lintRunbooks({ root: 'docs/runbooks', stepLevel: 2 })
console.log(formatReport(report))

// Or lint text that does not live on disk. No filesystem access, no execution.
const single = lintRunbookText(markdown, { file: 'drain-a-node.md' })
```

An unknown option key, an unknown limit name and an out-of-range step level all throw rather than
being ignored.

## Exit codes

| Code | Meaning | stdout |
| ---: | --- | --- |
| 0 | every step carried the evidence it needs | the report |
| 1 | the runbook set failed the check | the report |
| 2 | invalid usage or configuration | **empty** — the message is on stderr |
| 2 | evidence missing, undecodable or bounded out | an `incomplete` report |

A consumer piping stdout must handle an empty stdout on exit 2. A configuration error means the run
never had a subject, so there is nothing to report about; emitting a fake report for a run that never
started would be worse.

## Guarantees, each with a test that fails when it is removed

- **No command is ever executed.** No `child_process`, `eval` or `Function` in `src/` or `bin/`, and
  a fixture whose command would leave a marker file leaves none.
- **A step without recovery evidence is flagged.** A missing `Recovery:` is an error, and so is a
  `Recovry:` that is within one edit of it — a near-miss label satisfies nothing.
- **`pass` with `checked: 0` is unreachable.** A run that linted no step is `incomplete`.
- **Every limit is enforced where it is documented**, and exceeding one is an explicit finding with
  an `incomplete` report, never a silent truncation.
- **Every finding's severity comes from one frozen table.** An unknown rule id throws; the table is
  asserted against the documented catalog in both directions and pinned again rule by rule.
- **Containment is decided on real paths, both sides.** A symlink escaping the root is refused; a
  file genuinely inside a symlinked root is still linted.
- **Every untrusted string reaching output is sanitised** — paths, headings, labels and excerpts, not
  only `evidence`. C0, DEL, the C1 range (`U+0085` NEL and `U+009B` CSI included), `U+2028`,
  `U+2029` and the bidi overrides are removed, so nothing read can forge a report line or reverse
  one.
- **Output is deterministic.** No wall clock, locale, `localeCompare`, random source or network.

## Limits and non-goals

This tool reads what a runbook says about itself. It cannot tell you:

- **Whether a step works.** A recovery path that is written down but wrong reads exactly like one
  that is written down and right. This linter checks that the question was answered, not that the
  answer is correct.
- **Whether the stated owner exists**, is still on the rota, or would answer the page.
- **Whether an expected output matches reality.** It checks that success was made checkable.
- **Whether a command is correct, safe or idempotent.** Commands are never executed, so nothing here
  is evidence about what one would do if it ran.
- **Whether the runbook set is complete.** A procedure nobody wrote down leaves no trace.
- **Whether prose outside the field vocabulary answers a requirement.** A step that explains its
  recovery in an unlabelled paragraph is reported as missing one. That is deliberate: the thing being
  checked is a field a reader can find under pressure, and the linter cannot read intent.
- **Whether a command hidden in the preamble is safe.** Only step bodies are linted for command
  boundaries.
- **Anything about a runbook it could not read.** A document that is too large, not UTF-8, or cut
  short by a limit makes the run `incomplete`. Unknown is never reported as a pass.

Markdown support is deliberately narrow: ATX headings, fenced blocks with backticks or tildes, list
markers, blockquote markers and inline code spans. HTML blocks, setext headings, reference
definitions and indented code blocks are read as ordinary text.

## Development

```sh
npm run check     # lint, test, run the example, and verify the package contents
npm test
npm run test:coverage
```

Zero runtime and zero development dependencies. `node --test` and `node --check` only.

Full rule catalog, field vocabulary, limits, report shape and determinism guarantees:
[`docs/runbook-rules.md`](./docs/runbook-rules.md).

## License

MIT. See [LICENSE](./LICENSE).
