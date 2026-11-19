# @mgreten/git-worktree-doctor

Diagnose and maintain git worktrees. Parses `git worktree list --porcelain`,
validates that each worktree path still exists on disk, flags stale/locked/prunable
entries, optionally prunes dead worktrees, and removes stale ones. Works with any git repository — no
project-specific assumptions.

Useful as a preflight check before branch operations, a periodic health monitor,
or a post-incident triage tool when worktrees accumulate and rot.

## Installation

```sh
swamp extension pull @mgreten/git-worktree-doctor
```

## Setup

Create a model instance pointing at your repository:

```sh
swamp model create wt-doctor --type @mgreten/git-worktree-doctor \
  --global-args '{"repoPath": "/path/to/your/repo"}'
```

Or use the default (current directory):

```sh
swamp model create wt-doctor --type @mgreten/git-worktree-doctor
```

## Usage

### Diagnose all worktrees

```sh
swamp model method run wt-doctor diagnose --json
```

Returns a structured report with counts of healthy, stale, locked, prunable,
and detached worktrees, plus the full list of entries with their status.

### Preview what would be pruned

```sh
swamp model method run wt-doctor prune \
  --input '{"dryRun": true, "verbose": true}' --json
```

### Actually prune stale entries

```sh
swamp model method run wt-doctor prune \
  --input '{"dryRun": false}' --json
```

## Global Arguments

| Argument   | Type   | Default | Description                            |
| ---------- | ------ | ------- | -------------------------------------- |
| `repoPath` | string | `.`     | Path to the git repo (main or linked)  |

## Method: `diagnose`

Parses porcelain output from `git worktree list` and validates each entry.

| Argument   | Type   | Required | Description                |
| ---------- | ------ | -------- | -------------------------- |
| `repoPath` | string | no       | Override the global path   |

**Output fields:** `totalWorktrees`, `healthy`, `stale`, `locked`, `prunable`,
`detached`, `worktrees[]` (full entry list), `overallHealthy`.

## Method: `prune`

Runs `git worktree prune` with optional dry-run and verbose flags. Defaults to
`dryRun: true` so you never accidentally prune without explicitly opting in.

| Argument   | Type    | Required | Default | Description                          |
| ---------- | ------- | -------- | ------- | ------------------------------------ |
| `dryRun`   | boolean | no       | `true`  | Preview without removing             |
| `repoPath` | string  | no       | —       | Override the global path             |
| `verbose`  | boolean | no       | `false` | Pass `--verbose` to git              |

**Output fields:** `prunedCount`, `prunedPaths`, `exitCode`, `success`.

## Method: `removeStale`

Removes stale linked worktrees in one run with `git worktree remove --force`,
which deletes the directory and keeps the branch. Defaults to `dryRun: true`.

```sh
swamp model method run wt-doctor removeStale --input dryRun=false --json
```

A worktree is kept, with a reason, when it is:

- the main worktree, bare, or locked (`main`, `bare`, `locked`)
- gone from disk (`missing-path`; `prune` drops its metadata)
- the working directory of a running process, per `lsof -d cwd` (`in-use`); live
  runs refresh this before every removal
- mid rebase, merge, cherry-pick, revert, or bisect (`operation-in-progress`)
- carrying tracked changes (`tracked-changes`) or untracked files outside
  `ignoreUntracked` (`untracked-files`)
- active within `staleDays`, where activity is the newer of the worktree's index
  mtime and its HEAD commit time (`active`)

A detached HEAD whose commits are on no remote ref and not on the base branch
gets a `backup/wt-<dirname>` branch at that commit before removal.

| Argument          | Type     | Default            | Description                                 |
| ----------------- | -------- | ------------------ | ------------------------------------------- |
| `dryRun`          | boolean  | `true`             | Report without removing                     |
| `repoPath`        | string   | —                  | Override the global path                    |
| `staleDays`       | number   | `14`               | Keep worktrees active within this many days |
| `ignoreUntracked` | string[] | agent overlay dirs | Untracked paths that do not block removal   |
| `baseBranch`      | string   | origin/HEAD branch | Branch whose commits count as saved         |

`ignoreUntracked` defaults to `.agents/`, `.amp/`, `.claude/`, `.opencode/`,
`.ralph/`, `.adw/`, `.codex/`, `.swamp*`, and `skills-lock.json`. A pattern
matches the path and everything below it; `*` matches within one segment.

**Output:** one `staleSweep` resource per run with `removed[]` (path, branch,
`branchLocation` of `remote`, `local-only`, or `detached`, `remoteBranch`,
`unpushedCommits`, `backupBranch`, `durationMs`), `kept[]` (path, `reason`,
`detail`), and `keptByReason` counts. On a dry run, `removed[]` lists what would
be removed.

## How It Works

The `diagnose` method runs `git worktree list --porcelain` and parses each
worktree block into a structured entry: path, HEAD commit, branch, and status
flags (detached, bare, locked, prunable). It then validates each path exists on
disk via `Deno.stat`. The first entry is marked as the main worktree (never
prunable).

The `prune` method delegates to `git worktree prune` — the same command you'd
run manually — and captures what was (or would be) removed. It parses the
"Removing" lines from git's output to report which entries were pruned.

No external dependencies beyond Zod and git.

## License

MIT — see LICENSE for details.
