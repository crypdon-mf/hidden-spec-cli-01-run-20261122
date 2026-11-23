# mend: one patch tool for every AI edit format

[![make.fun · hidden-spec-cli-01-run-20261122](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![make.fun · rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/crypdon-mf/hidden-spec-cli-01-run-20261122/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![make.fun · reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/crypdon-mf/hidden-spec-cli-01-run-20261122/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)

mend applies an edit that an AI model wrote to a tree of text files, built for the
[make.fun bounty "Build mend, one patch tool for every AI edit format"](https://make.fun/bounty/hidden-spec-cli-01-run-20261122).

Models write edits in four formats, and mend reads them all: a unified diff (often with
wrong line numbers), SEARCH/REPLACE blocks, the V4A patch format, and text-editor tool
calls as JSON. Each format is read exactly as `SPEC.md` says, and every file is changed
or nothing is: a failed edit changes nothing, the edits after it still run, and when any
edit failed no file is written at all.

## Usage

```sh
node main.ts [--format=NAME] [--check] [--strict] [PATCH]
```

- `PATCH` is the patch file, relative to the working directory; when absent or `-`, the
  patch is read from standard input. The working directory is the root of the tree.
- `--format=NAME` reads the patch in one format: `unified`, `search-replace`, `v4a` or
  `json`; `auto`, the default, detects it.
- `--check` does everything but write: the same output and exit code, and no file is
  created, changed or deleted.
- `--strict` matches lines exactly (tier 0 only).

Exit 0 prints one line per changed path (`A` created, `D` deleted, `M` modified,
`R old -> new` moved) and `ok: <n> files`. Exit 1 lists each failed edit and
`failed: <k> of <n> edits`. Exit 2 is a usage, patch-read, format or parse error.

Line matching runs at three tiers: exact, trailing whitespace stripped, then leading
and trailing whitespace stripped, with the tier-2 re-indent rule. Unified hunks take
the occurrence nearest their (possibly wrong) line number; SEARCH/REPLACE blocks need
exactly one occurrence; V4A chunks follow an anchor and a cursor. CRLF files keep
their line breaks, and a file without a final line break keeps it that way unless a
unified hunk says otherwise.

## Files

- `main.ts`: the CLI. Node 22, standard library alone.
- `runner.ts`: the kit's runner (kept as is). In a trial it reads the checks from the
  environment and runs `main.ts` on each one.
- `check.ts`: the practice set on your own machine:
  `node check.ts ../program/generator/practice.json`
- `SPEC.md`: the specification — the whole contract.
- `LICENSE`: MIT.

## Practice score

100 of 100 practice checks pass (practice score 1000).

Built with [make.fun](https://make.fun/r/tw2c9rvf).
