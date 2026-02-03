# Changelog

All notable changes to this project are documented in this file.

## Unreleased

### Added

- a step parser for the documented Markdown subset — ATX headings, fenced blocks
  with backtick or tilde markers, list and blockquote markers, inline code spans
  — that finds steps at a configurable heading level and reads the preamble
  before the first one;
- a closed field vocabulary for the five things a step has to answer, accepted as
  labelled lines or as field sub-headings, with a near-miss label such as
  `Recovry:` reported and satisfying nothing, so a one-character typo cannot turn
  a real failure green;
- placeholder detection, so a field carrying `TBD` or `???` is reported and does
  not satisfy the requirement it labels, which is then reported missing at its
  own severity; `none` is deliberately accepted as an explicit answer;
- command boundary rules: a command in prose or behind a shell prompt is an
  error, a command with arguments in an inline code span is a warning, and a
  fenced block with no language tag is a warning;
- strict UTF-8 decoding with `TextDecoder('utf-8', { fatal: true })`, so whether
  a document is decodable is the decoder's decision and never an inference drawn
  from the decoded text;
- explicit document-count, byte, directory-depth, step-count and step-length
  limits, each reported by name when hit and each making the run `incomplete`
  instead of truncating;
- real-path containment for every entry under the root, resolved on both sides,
  so a symbolic link out of the tree is refused unread while a file genuinely
  inside a symlinked root is still linted;
- sanitisation of every untrusted string that reaches output — file paths, step
  headings, field labels, values and command excerpts — so an identifier
  carrying a newline cannot forge extra lines in the human report; the removed
  set is C0, DEL, the whole C1 range (where `U+0085` NEL and the 8-bit CSI
  `U+009B` live), `U+2028`, `U+2029` and the bidi formatting characters, whose
  `U+202E` would otherwise reverse everything displayed after it;
- a summary that separates what was found from what was read: `documents`
  counts the documents found, including the ones refused before they could be
  collected, `skipped` counts those of them that were not linted, `steps`
  counts the steps found and `checked` counts the steps read to the end — a
  step a limit cut short is found, reported, and not counted as checked;
- a CLI with `--help`, `--json`, `--step-level` and the limit flags, the report
  on stdout, diagnostics on stderr, and exit codes 0 / 1 / 2 — with an empty
  stdout for a configuration error and an `incomplete` report for evidence that
  could not be obtained, and with an unknown option or a repeated value-carrying
  flag refused instead of silently overwriting the earlier value;
- `lintRunbookText` for linting a document that does not live on disk, with no
  filesystem access at all;
- runnable clean and deliberately broken example runbook sets; the broken set
  spreads its findings over two documents, so the documented finding order is
  demonstrated as well as the rules;
- the rule catalog, field vocabulary, command vocabulary, limits, report shape,
  exit codes, determinism guarantee and the list of things this tool cannot
  conclude in `docs/runbook-rules.md`.

### Guaranteed

- No command found in a document is ever executed, evaluated, interpolated into
  another command, or handed to a shell. There is no `node:child_process` import,
  no `eval` and no `new Function` in `src/` or `bin/`, and a fixture whose fenced
  block would create a marker file leaves none behind.
- A step without recovery evidence is flagged, including one whose recovery label
  is a near miss for the real one.
- A run that linted no step is `incomplete` and exits 2. `pass` with
  `checked: 0` is not reachable.
- Every finding takes its severity from one frozen `ruleId -> severity` table and
  an unknown rule id throws. The table, the documented catalog and a hand-written
  copy are asserted against each other, but a coordinated edit to three
  declarations agrees with itself, so severity is pinned by consequence as well:
  every rule whose severity alone decides the verdict is driven through the real
  binary on a root that isolates it, and the report status and the process exit
  code are asserted. A demotion turns `fail` into `pass` and exit 1 into exit 0,
  which no edit to a declaration can hide.
- No wall clock, locale, `localeCompare`, `Intl.Collator`, random source, network
  access or filesystem enumeration order affects the output. Ordering is pinned
  by the order the report emits for pairs that a collator orders the other way —
  `URLS.md` before `URL_ENTRIES.md`, `Zebra.md` before `apple.md`, `a-b` before
  `a_b` — rather than by scanning the source for a comparator's name.

No release has been published.
