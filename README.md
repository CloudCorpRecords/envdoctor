# envdoctor

envdoctor checks whether this machine's environment matches what a repo says it needs. Point it at a repo directory and it runs a small set of deterministic checks, each one passing or failing with the fix named. It never runs code from the repo, and it never prints a secret value.

## Install

Run it without installing:

```sh
npx @reneturcios/envdoctor doctor [path]
```

Or install it globally:

```sh
npm install -g @reneturcios/envdoctor
```

## CLI

```sh
envdoctor doctor [path] [--json]
envdoctor mcp
envdoctor --version
```

- `doctor [path]` checks the repo at `path` (default: the current directory) and prints a human readable report. Add `--json` for the machine readable report.
- `mcp` starts the MCP server on stdio.
- `--version` prints the version.

Exit codes: 0 when the verdict is HEALTHY, 1 when the verdict is ISSUES, 2 for a usage error such as a target that does not exist, and 141 when the reader closed the output pipe early.

## MCP

The MCP server exposes one tool:

- `doctor_env` takes a `path` argument, runs the same checks as the CLI, and returns the JSON report.

## Checks

v0.1 runs five checks, in this order:

1. **NODE-VERSION** - Compares the running Node version (`process.version`) against the `engines.node` range in the target's `package.json`. Supported range syntax: `>=`, `<=`, `>`, `<`, `=`, caret ranges such as `^20.0.0`, tilde ranges such as `~20.11.0`, exact versions such as `20.11.0`, x-ranges such as `20.x` and `20.11.x`, partial versions, and space separated combinations such as `>=18 <21`. A range outside that syntax is reported as an info finding with rule RANGE-UNSUPPORTED instead of a guess. When the target has no `package.json`, this check is skipped with an info finding with rule NO-PACKAGE-JSON, and the remaining checks still run.
2. **GIT-PRESENT** - Passes when `git --version` succeeds.
3. **NPM-PRESENT** - Passes when `npm --version` succeeds.
4. **LOCKFILE** - Passes when one of `package-lock.json`, `yarn.lock`, or `pnpm-lock.yaml` exists at the target (the report says which one). A missing lockfile is a medium finding with rule NO-LOCKFILE.
5. **ENV-FILE** - Only applies when `.env.example` exists at the target. If `.env` is missing, that is a medium finding with rule ENV-MISSING and the fix "copy .env.example to .env and fill values". If `.env` exists, the key names in `.env.example` are compared against the key names in `.env`, and each name missing from `.env` is a medium finding with rule ENV-KEYS-MISSING. When there is no `.env.example`, the check passes because no env file is required.

Every passed check is counted in `counts.checksPassed` and appears in the report findings as an info entry with rule CHECK-PASS, so the printed report lists every check that ran.

## Env values are never read into output

This guarantee is plain: envdoctor compares key **names** only.

- Both `.env.example` and `.env` are parsed by reading only the text left of the first `=` on each line. That text is the key name.
- Everything from the first `=` onward is a value. Values are discarded at parse time. They are not stored, not returned, not logged, and not printed in any report, finding, summary, or error.
- Findings about env files name keys, never values. For example, an ENV-KEYS-MISSING finding says a key named in `.env.example` is missing from `.env`; it says nothing about any value.

## Verdict rules

- **HEALTHY** - No medium or high findings. Passed checks, skipped checks with a stated reason, and info notes such as RANGE-UNSUPPORTED do not change this verdict.
- **ISSUES** - At least one medium or high finding exists.

The report counts are `checksRun`, `checksPassed`, `checksFailed`, `checksWarned`, and `checksSkipped`, plus a findings total broken down by severity.

## Limits

- v0.1 checks Node, git, npm, and files only: the `engines.node` range, the two tool versions, the lockfile, and the env files described above.
- Ports, running services, databases, and network reachability are not checked in v0.1. Port and service checks are future work.
- Disk space is out of scope.
- Only the Node range syntax listed under NODE-VERSION is supported. Any other range syntax produces a RANGE-UNSUPPORTED info finding rather than a pass or fail.
- Nothing in the target repo is executed. The only commands envdoctor runs are `git --version` and `npm --version`.
