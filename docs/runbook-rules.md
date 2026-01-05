# Rules, limits and determinism

This document is the reference for what `runbook-step-linter` reads, what each rule means, what the
report contains, and what the tool refuses to claim. Rule ids are stable: renaming one is a breaking
change and is recorded in the changelog.

## The one rule that is not negotiable

**Command text found in a document is data.** A command in a runbook is located, bounded, sanitised
and quoted back as evidence. It is never executed, evaluated, interpolated into another command, or
handed to a shell. There is no `node:child_process` import, no `eval` and no `new Function` anywhere
in `src/` or `bin/`, and `test/no-execution.test.mjs` fails if one appears. That test also lints a
fixture whose fenced block would create a marker file if anything ran it, and asserts the marker
does not exist afterwards.

This matters because a runbook is untrusted input in exactly the way a web page is. A linter that
ran what it read would be a remote code execution primitive dressed as a documentation tool.

## What is read

The tool walks the directory given as `--root` and reads files ending in `.md` or `.markdown`.

- Entries whose name begins with `.` are skipped, as is any directory named `node_modules`.
- `index.md` and `readme.md` are skipped by name, case-insensitively: they are navigation, not
  runbooks.
- Every entry is resolved to its real path and checked against the real root before it is opened. An
  entry that resolves outside the root is refused and reported as `path-escapes-root`; its content
  never reaches the report. Both sides of that comparison are real paths, so a legitimate file
  reached through a symlinked root is linted rather than falsely refused.
- A real path already seen is not read twice, so a symbolic link inside the root cannot duplicate a
  document or loop the walk.
- An entry named like a runbook that is not a regular file — a FIFO, a socket, a device node — is
  reported as `document-unreadable` and makes the run `incomplete`. It is never opened: reading one
  can block forever, and an unexamined runbook-shaped entry must not sit inside a passing run.
- File bytes are decoded with `TextDecoder('utf-8', { fatal: true })`. Whether bytes are UTF-8 is
  the decoder's decision; the decoded text is never inspected to make that judgement.

**Nothing in the root is ever written to.** There is no auto-fix and no reformat.

## What a step is

A step is a heading at exactly `--step-level` (default 2). Everything before the first such heading
is the **preamble**. Headings deeper than the step level belong to the step body.

```markdown
## 2. Cordon the node

- **Prerequisites:** step 1 finished and the node was Ready.
- **Expected output:** the node reports Ready,SchedulingDisabled.
- **Recovery:** uncordon the node and stop.

```sh
kubectl cordon node-7
```
```

## The field vocabulary

A field is written as `Label: value` at the start of a line, optionally behind a list marker
(`-`, `*`, `+`, `1.`) or a blockquote marker, and optionally wrapped in Markdown emphasis
(`**Owner:**`, `**Owner**:`, `_Owner:_`). A sub-heading whose text is a label opens that field, and
the following lines up to the next heading, fence or field line are its value.

| Label | Requirement it answers |
| --- | --- |
| `owner`, `owners` | who runs the step and is accountable for it |
| `prerequisites`, `prerequisite`, `preconditions` | what must already be true |
| `expected output`, `expected result`, `verification`, `verify` | how a reader tells it worked |
| `recovery`, `rollback`, `on failure` | what to do when it fails |

A label is at most two words of letters, which keeps ordinary prose containing a colon out of the
vocabulary. A label outside the vocabulary answers nothing. When it is within two edits of a
vocabulary label and at least four characters long, it is reported as `step-field-misspelled` — and
it still answers nothing, so the requirement it resembles is reported missing at its own severity.
That is the point: `Recovry:` must not be mistaken for recovery evidence.

`owner` is the **only** field inherited from the preamble. A runbook with one owner may state it
once before the first step. Prerequisites, expected output and recovery are step-specific by
definition, and a document-wide answer to a step-specific question is the vagueness this linter
exists to find; stating one in the preamble is reported as `document-field-not-inherited` and
satisfies no step.

### Values that are not answers

A field whose value is empty, or is one of `-`, `--`, `...`, `?`, `???`, `fixme`, `n/a`, `na`,
`t.b.d.`, `tbd`, `tk`, `todo`, `xxx` (compared case-insensitively), is reported as
`step-field-placeholder` and does not satisfy the requirement, which is then also reported missing.

`none` is deliberately **not** in that list. "Prerequisites: none" is an explicit answer and is
accepted. The linter checks that the question was answered, not that the answer is good.

A requirement declared twice in one step is reported as `step-field-duplicate`; the first
declaration is the one used.

## Command boundaries

A command belongs in a fenced block. Two shapes outside a fence are reported, and both are only ever
read as text:

- `command-in-prose` (**error**) — a shell prompt (`$` or `%` followed by a space), or a line whose
  first word is a command name written in lower case with at least one more word after it. Where the
  command ends is a guess, and at 03:00 a guess is a second incident.
- `command-inline-span` (**warning**) — a backtick span whose first word is a command name and which
  carries arguments. It has boundaries, but an inline span cannot hold a line break, so a longer
  command silently loses lines when it is copied.

The command vocabulary is a deliberately small, closed list of tool names: `ansible`, `aws`, `bash`,
`cat`, `chmod`, `chown`, `curl`, `docker`, `flyctl`, `gcloud`, `git`, `helm`, `journalctl`,
`kubectl`, `make`, `mv`, `mysql`, `npm`, `openssl`, `psql`, `python3`, `rm`, `rsync`, `scp`,
`service`, `sh`, `ssh`, `sudo`, `systemctl`, `tar`, `terraform`, `wget`. These names are only ever
compared as strings — nothing is looked up on the host, resolved to an executable, or run.

Matching is **case-sensitive**, which is what separates a command from a sentence:
`sudo systemctl stop api` is a command, `Sudo is required for this step` is prose.

A fenced block with no language tag is reported as `command-fence-unlabelled`: without one, a reader
cannot tell whether the block is a command to run or output to compare against.

Only step bodies are linted for command boundaries. The preamble is context, and is read for the
document owner only.

## Rule catalog

| Rule | Severity | Meaning |
| --- | --- | --- |
| `command-fence-unlabelled` | warning | A fenced block carries no language tag. |
| `command-in-prose` | error | Command text sits in prose with no fence around it. |
| `command-inline-span` | warning | A command with arguments is written as an inline code span. |
| `directory-too-deep` | error | Directory nesting exceeded `maxDepth`; its contents were not examined. |
| `document-field-not-inherited` | warning | A step-specific field is stated in the preamble, where it satisfies no step. |
| `document-not-utf8` | error | The bytes are not valid UTF-8; the document was not parsed. |
| `document-too-large` | error | The document exceeds `maxDocumentBytes` and was not parsed. |
| `document-unreadable` | error | A file or directory could not be read or resolved, or a runbook-shaped entry is not a regular file. |
| `fence-unterminated` | error | A fence was opened and never closed, so no step after it was examined. |
| `no-documents-found` | warning | No step was linted anywhere, so the run checked nothing. |
| `no-steps-found` | warning | A document held no heading at the step level, so nothing in it was checked. |
| `path-escapes-root` | error | An entry resolves outside the real runbook root and was refused unread. |
| `step-expected-output-missing` | error | The step states no expected output, so success is not checkable. |
| `step-field-duplicate` | warning | A requirement is declared twice in one step. |
| `step-field-misspelled` | warning | A label is a near miss for a vocabulary label and satisfies nothing. |
| `step-field-placeholder` | warning | A field carries a placeholder instead of an answer. |
| `step-heading-duplicate` | warning | Two steps share a heading, so a reference by name is ambiguous. |
| `step-numbering-gap` | warning | Numbered step headings do not run 1, 2, 3 in document order. |
| `step-owner-missing` | error | The step names no owner and none is inherited from the preamble. |
| `step-prerequisites-missing` | warning | The step states no prerequisites. |
| `step-recovery-missing` | error | The step states no recovery path. |
| `step-too-long` | error | The step body exceeded `maxStepLines`; the rest of it was not examined. |
| `too-many-documents` | error | The root holds more than `maxDocuments` documents; the scan stopped. |
| `too-many-steps` | error | A document holds more than `maxSteps` steps; the scan stopped. |

Severity is not written at the point a finding is constructed. It is read from a single frozen
`RULE_SEVERITY` table in `src/rules.mjs`, a rule missing from that table throws rather than
defaulting to anything, and `test/severity-table.test.mjs` asserts this catalog and that table
against each other in both directions. Because a coordinated edit to both would agree with itself,
that file also pins every rule's severity rule by rule, independently of either.

## Limits

| Limit | CLI flag | Default | Exceeding it |
| --- | --- | ---: | --- |
| `maxDocuments` | `--max-documents` | 500 | `too-many-documents`, run is `incomplete` |
| `maxDocumentBytes` | `--max-document-bytes` | 524288 | `document-too-large`, run is `incomplete` |
| `maxDepth` | `--max-depth` | 8 | `directory-too-deep`, run is `incomplete` |
| `maxSteps` | `--max-steps` | 200 | `too-many-steps`, run is `incomplete` |
| `maxStepLines` | `--max-step-lines` | 400 | `step-too-long`, run is `incomplete` |

Every limit is enforced where it is documented and has a test that fails if the enforcement is
removed. Exceeding a limit is always an explicit finding and an `incomplete` report — never a
silently shorter answer, and never a pass.

An unknown limit name, an unknown option key, an out-of-range `--step-level`, an unknown CLI option
and a value-carrying CLI flag given more than once are all refused as configuration errors. A
one-character typo must not quietly turn a real failure into a green run, and neither must a value
the caller can no longer see: `--root a --root b` is refused rather than resolved by last-wins.

## Report

The report follows the Edilec tool report contract v1.

- `status` is `pass`, `fail` or `incomplete`.
- `summary` carries `checked` (steps linted), `errors`, `warnings`, `info`, `documents`, `skipped`,
  `steps`, `fencedCommands`, `looseCommands`, `stepsWithOwner`, `stepsWithPrerequisites`,
  `stepsWithExpectedOutput` and `stepsWithRecovery`.
- `location.file` is always relative to the runbook root, never an absolute host path.
- `location.pointer` is a documented field path: `/steps/<n>`, `/steps/<n>/owner`,
  `/steps/<n>/prerequisites`, `/steps/<n>/expected-output`, `/steps/<n>/recovery`,
  `/steps/<n>/commands`, `/preamble`, `/preamble/<field>`, or `/` for a document-level finding.
  `<n>` is the step's 1-based position in its document.
- `line` is present when a finding has one, and is the 1-based line in the document.
- `evidence` is a bounded, flattened excerpt. Every untrusted string that reaches either report is
  sanitised the same way — file paths, step headings and field labels, not only `evidence` — and an
  identifier is treated as exactly as dangerous as an excerpt. Removed: `U+0000`-`U+001F` (C0),
  `U+007F` (DEL), `U+0080`-`U+009F` (C1, which is where `U+0085` NEL and the 8-bit CSI `U+009B`
  live), `U+2028` and `U+2029`, and the bidirectional formatting characters `U+200E`, `U+200F`,
  `U+202A`-`U+202E` and `U+2066`-`U+2069`. A name carrying `U+0085` would otherwise forge a line in
  the human report, and one carrying `U+202E` would reverse everything displayed after it.

### Exit codes

| Code | Meaning | stdout |
| ---: | --- | --- |
| 0 | every step carried the evidence it needs | the report |
| 1 | the runbook set failed the check | the report |
| 2 | invalid usage or configuration | **empty** — the message is on stderr |
| 2 | evidence missing, undecodable or bounded out | an `incomplete` report |

A run that linted no step is `incomplete`, never a pass. `pass` with `checked: 0` is green on no
evidence, so `no-documents-found` is emitted and the run is marked incomplete on that path.

## Determinism

- Directory entries are sorted by UTF-16 code unit before use, so filesystem enumeration order never
  reaches the output.
- Comparisons use a plain code-unit comparator. `localeCompare` is never used anywhere in this tool:
  its result depends on ICU data that varies between Node builds.
- Findings sort by `(location.file, line, location.pointer, ruleId, message)`.
- Nothing reads the wall clock, the locale, the environment or the network. Two runs over the same
  bytes produce byte-identical stdout.

Two runs inside one process and one locale agree with each other whatever the comparator does, so
`test/determinism.test.mjs` pins the properties themselves: the comparator's own ordering against
pairs an English collator orders the other way, the sort that stands between directory enumeration
and the report, and the absence of `localeCompare`, the clock, a random source, the environment and
the network from the shipped source.

## What this tool cannot conclude

- Whether a step **works**. It reads what a runbook says about itself. A recovery path that is
  written down but wrong reads exactly like one that is written down and right.
- Whether a stated **owner exists**, is still on the rota, or would answer at 03:00. `Owner:` is an
  uncontrolled string.
- Whether an **expected output is the real one**. It checks that success was made checkable, not
  that the description matches what the system actually prints.
- Whether a **command is correct, safe, or idempotent**. Commands are read as text and never
  executed, so nothing here is evidence about what one would do if run.
- Whether the runbook **set is complete**. A procedure nobody wrote down leaves no trace, and a
  clean run says nothing about it.
- Whether prose **outside the field vocabulary** answers a requirement. A step that explains its
  recovery path in an unlabelled paragraph is reported as missing one. That is deliberate: a field a
  reader can find under pressure is the thing being checked, and the linter cannot read intent.
- Whether a **command hidden in the preamble** is safe. Only step bodies are linted for command
  boundaries.
