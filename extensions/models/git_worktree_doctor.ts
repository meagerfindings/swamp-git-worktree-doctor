/**
 * Git worktree health checker that parses `git worktree list --porcelain`,
 * validates worktree paths exist on disk, detects stale or locked entries,
 * and optionally prunes them. Works with any git repository that uses
 * worktrees — no project-specific assumptions.
 *
 * @module
 */

import { z } from "npm:zod@4";

/** Global configuration for the git-worktree-doctor model. */
const GlobalArgsSchema: z.ZodObject<{
  repoPath: z.ZodDefault<z.ZodString>;
}> = z.object({
  repoPath: z.string().default(".").describe(
    "Path to the git repository (main worktree or any linked worktree)",
  ),
});

/** Schema for a single worktree entry parsed from porcelain output. */
const WorktreeEntrySchema: z.ZodObject<{
  path: z.ZodString;
  head: z.ZodString;
  branch: z.ZodOptional<z.ZodString>;
  isDetached: z.ZodBoolean;
  isBare: z.ZodBoolean;
  isLocked: z.ZodBoolean;
  lockReason: z.ZodOptional<z.ZodString>;
  isPrunable: z.ZodBoolean;
  pruneReason: z.ZodOptional<z.ZodString>;
  pathExists: z.ZodBoolean;
  isMain: z.ZodBoolean;
}> = z.object({
  path: z.string(),
  head: z.string(),
  branch: z.string().optional(),
  isDetached: z.boolean(),
  isBare: z.boolean(),
  isLocked: z.boolean(),
  lockReason: z.string().optional(),
  isPrunable: z.boolean(),
  pruneReason: z.string().optional(),
  pathExists: z.boolean(),
  isMain: z.boolean(),
});

/** Schema for the diagnose method output. */
const DiagnosisSchema: z.ZodObject<{
  repoPath: z.ZodString;
  totalWorktrees: z.ZodNumber;
  healthy: z.ZodNumber;
  stale: z.ZodNumber;
  locked: z.ZodNumber;
  prunable: z.ZodNumber;
  detached: z.ZodNumber;
  worktrees: z.ZodArray<typeof WorktreeEntrySchema>;
  overallHealthy: z.ZodBoolean;
  diagnosedAt: z.ZodString;
}> = z.object({
  repoPath: z.string(),
  totalWorktrees: z.number(),
  healthy: z.number(),
  stale: z.number(),
  locked: z.number(),
  prunable: z.number(),
  detached: z.number(),
  worktrees: z.array(WorktreeEntrySchema),
  overallHealthy: z.boolean(),
  diagnosedAt: z.string(),
});

/** Schema for the prune method output. */
const PruneResultSchema: z.ZodObject<{
  repoPath: z.ZodString;
  dryRun: z.ZodBoolean;
  prunedCount: z.ZodNumber;
  prunedPaths: z.ZodArray<z.ZodString>;
  stdout: z.ZodString;
  stderr: z.ZodString;
  exitCode: z.ZodNumber;
  success: z.ZodBoolean;
  prunedAt: z.ZodString;
}> = z.object({
  repoPath: z.string(),
  dryRun: z.boolean(),
  prunedCount: z.number(),
  prunedPaths: z.array(z.string()),
  stdout: z.string(),
  stderr: z.string(),
  exitCode: z.number(),
  success: z.boolean(),
  prunedAt: z.string(),
});

/** Default untracked paths that do not count as work: agent overlay files. */
const DEFAULT_IGNORE_UNTRACKED = [
  ".agents/",
  ".amp/",
  ".claude/",
  ".opencode/",
  ".ralph/",
  ".adw/",
  ".codex/",
  ".swamp*",
  "skills-lock.json",
];

/** Why removeStale kept a worktree. */
const KeepReasonSchema = z.enum([
  "main",
  "bare",
  "locked",
  "missing-path",
  "in-use",
  "operation-in-progress",
  "tracked-changes",
  "untracked-files",
  "active",
  "backup-failed",
  "remove-failed",
]);

/** A worktree removeStale removed (or would remove, on a dry run). */
const RemovedWorktreeSchema = z.object({
  path: z.string(),
  branch: z.string().optional(),
  head: z.string(),
  lastActivityAt: z.string(),
  branchLocation: z.enum(["remote", "local-only", "detached"]).describe(
    "remote: a remote branch matches the worktree's branch; local-only: none does. The local branch is kept either way",
  ),
  remoteBranch: z.string().optional(),
  unpushedCommits: z.number().describe(
    "Commits reachable from HEAD that are on no remote ref",
  ),
  backupBranch: z.string().optional(),
  durationMs: z.number().optional(),
});

/** A worktree removeStale kept, with the reason. */
const KeptWorktreeSchema = z.object({
  path: z.string(),
  branch: z.string().optional(),
  head: z.string(),
  reason: KeepReasonSchema,
  detail: z.string().optional(),
  lastActivityAt: z.string().optional(),
});

/** Schema for the removeStale method output. */
const StaleSweepSchema = z.object({
  repoPath: z.string(),
  dryRun: z.boolean(),
  staleDays: z.number(),
  baseBranch: z.string().optional(),
  ignoreUntracked: z.array(z.string()),
  totalWorktrees: z.number(),
  removedCount: z.number(),
  keptCount: z.number(),
  keptByReason: z.record(z.string(), z.number()),
  removed: z.array(RemovedWorktreeSchema),
  kept: z.array(KeptWorktreeSchema),
  startedAt: z.string(),
  finishedAt: z.string(),
});

/** Method execution context provided by swamp. */
type MethodContext = {
  globalArgs: z.infer<typeof GlobalArgsSchema>;
  logger: {
    info: (msg: string, props?: Record<string, unknown>) => void;
    warning: (msg: string, props?: Record<string, unknown>) => void;
    error: (msg: string, props?: Record<string, unknown>) => void;
  };
  writeResource: (
    specName: string,
    instanceName: string,
    data: Record<string, unknown>,
  ) => Promise<Record<string, unknown>>;
};

/** Result of running a shell command. */
interface CmdResult {
  stdout: string;
  stderr: string;
  code: number;
}

/** Run a shell command and return stdout, stderr, and exit code. */
async function runCmd(cmd: string[], cwd?: string): Promise<CmdResult> {
  const command = new Deno.Command(cmd[0], {
    args: cmd.slice(1),
    stdout: "piped",
    stderr: "piped",
    cwd,
  });
  const output = await command.output();
  return {
    stdout: new TextDecoder().decode(output.stdout),
    stderr: new TextDecoder().decode(output.stderr),
    code: output.code,
  };
}

/** Resolve a repo path to an absolute path. */
async function resolveRepoPath(repoPath: string): Promise<string> {
  if (repoPath === ".") return Deno.cwd();
  const result = await runCmd(["realpath", repoPath]);
  if (result.code !== 0) throw new Error(`Cannot resolve path: ${repoPath}`);
  return result.stdout.trim();
}

/** Check whether a filesystem path exists. */
async function pathExists(p: string): Promise<boolean> {
  try {
    await Deno.stat(p);
    return true;
  } catch {
    return false;
  }
}

/** Parse one worktree block from porcelain output into a structured entry. */
function parseWorktreeBlock(
  block: string,
  isFirst: boolean,
): z.infer<typeof WorktreeEntrySchema> | null {
  const lines = block.trim().split("\n");
  if (lines.length === 0) return null;

  const entry: Record<string, unknown> = {
    isDetached: false,
    isBare: false,
    isLocked: false,
    isPrunable: false,
    isMain: isFirst,
    pathExists: false,
  };

  for (const line of lines) {
    if (line.startsWith("worktree ")) {
      entry.path = line.slice("worktree ".length);
    } else if (line.startsWith("HEAD ")) {
      entry.head = line.slice("HEAD ".length);
    } else if (line.startsWith("branch ")) {
      entry.branch = line.slice("branch ".length);
    } else if (line === "detached") {
      entry.isDetached = true;
    } else if (line === "bare") {
      entry.isBare = true;
    } else if (line.startsWith("locked")) {
      entry.isLocked = true;
      const reason = line.slice("locked".length).trim();
      if (reason) entry.lockReason = reason;
    } else if (line.startsWith("prunable")) {
      entry.isPrunable = true;
      const reason = line.slice("prunable".length).trim();
      if (reason) entry.pruneReason = reason;
    }
  }

  if (!entry.path || !entry.head) return null;
  return entry as unknown as z.infer<typeof WorktreeEntrySchema>;
}

/** List every worktree of the repository, with pathExists filled in. */
async function listWorktrees(
  repoPath: string,
): Promise<z.infer<typeof WorktreeEntrySchema>[]> {
  const result = await runCmd(
    ["git", "worktree", "list", "--porcelain"],
    repoPath,
  );
  if (result.code !== 0) {
    throw new Error(
      `git worktree list failed (exit ${result.code}): ${
        result.stderr.slice(0, 500)
      }`,
    );
  }

  const blocks = result.stdout.split("\n\n").filter((b) => b.trim().length > 0);
  const worktrees: z.infer<typeof WorktreeEntrySchema>[] = [];
  for (let i = 0; i < blocks.length; i++) {
    const entry = parseWorktreeBlock(blocks[i], i === 0);
    if (!entry) continue;
    entry.pathExists = await pathExists(entry.path);
    worktrees.push(entry);
  }
  return worktrees;
}

/**
 * Working directories of every running process, from `lsof -d cwd`. lsof
 * exits non-zero when it cannot inspect some processes, so only empty
 * output counts as failure.
 */
async function processCwds(): Promise<string[]> {
  const result = await runCmd(["lsof", "-d", "cwd", "-F", "n"]);
  const cwds = result.stdout.split("\n")
    .filter((line) => line.startsWith("n"))
    .map((line) => line.slice(1));
  if (cwds.length === 0) {
    throw new Error(
      `lsof -d cwd returned no processes (exit ${result.code}): ${
        result.stderr.slice(0, 500)
      }`,
    );
  }
  return cwds;
}

/** Whether any process runs inside the worktree directory. */
function cwdInside(cwds: string[], worktreePath: string): string | undefined {
  return cwds.find((cwd) =>
    cwd === worktreePath || cwd.startsWith(`${worktreePath}/`)
  );
}

/**
 * Match a `git status` path against an ignore pattern. A pattern matches the
 * path itself or anything below it; `*` matches within one path segment.
 */
function matchesIgnore(path: string, pattern: string): boolean {
  const base = pattern.replace(/\/+$/, "");
  const glob = base.split("*").map((part) =>
    part.replace(/[.+?^${}()|[\]\\]/g, "\\$&")
  ).join("[^/]*");
  return new RegExp(`^${glob}(/.*)?$`).test(path);
}

/**
 * Check the worktree for tracked changes and for untracked files outside the
 * ignore list. Uses --no-optional-locks so the check does not rewrite the
 * index, whose mtime counts as activity.
 */
async function worktreeChanges(
  worktreePath: string,
  ignoreUntracked: string[],
): Promise<
  { reason: "tracked-changes" | "untracked-files"; detail: string } | null
> {
  const result = await runCmd([
    "git",
    "--no-optional-locks",
    "-C",
    worktreePath,
    "status",
    "--porcelain=v1",
    "-z",
    "--untracked-files=normal",
  ]);
  if (result.code !== 0) {
    return {
      reason: "tracked-changes",
      detail: `git status failed: ${result.stderr.trim().slice(0, 300)}`,
    };
  }
  const tracked: string[] = [];
  const untracked: string[] = [];
  const entries = result.stdout.split("\0").filter((e) => e.length > 0);
  for (let i = 0; i < entries.length; i++) {
    const status = entries[i].slice(0, 2);
    const path = entries[i].slice(3);
    if (status === "??") {
      if (!ignoreUntracked.some((p) => matchesIgnore(path, p))) {
        untracked.push(path);
      }
    } else {
      tracked.push(path);
      // Renames and copies are followed by their original path.
      if (status.includes("R") || status.includes("C")) i++;
    }
  }
  const sample = (paths: string[]) =>
    `${paths.length} path(s): ${paths.slice(0, 5).join(", ")}${
      paths.length > 5 ? ", …" : ""
    }`;
  if (tracked.length > 0) {
    return { reason: "tracked-changes", detail: sample(tracked) };
  }
  if (untracked.length > 0) {
    return { reason: "untracked-files", detail: sample(untracked) };
  }
  return null;
}

/** Names git leaves in a worktree's git dir while an operation is underway. */
const IN_PROGRESS_MARKERS = [
  "rebase-merge",
  "rebase-apply",
  "MERGE_HEAD",
  "CHERRY_PICK_HEAD",
  "REVERT_HEAD",
  "BISECT_LOG",
];

/** The base branch: the argument, else origin/HEAD's target, else none. */
async function resolveBaseBranch(
  repoPath: string,
  baseBranch?: string,
): Promise<string | undefined> {
  if (baseBranch) return baseBranch;
  const result = await runCmd(
    ["git", "symbolic-ref", "--short", "refs/remotes/origin/HEAD"],
    repoPath,
  );
  if (result.code !== 0) return undefined;
  return result.stdout.trim().replace(/^origin\//, "") || undefined;
}

/**
 * Whether the commit has history found on no remote ref and not on the
 * local base branch, so removing its detached worktree could lose it.
 */
async function hasUnsavedCommits(
  repoPath: string,
  sha: string,
  baseBranch: string | undefined,
): Promise<boolean> {
  const cmd = ["git", "rev-list", "-n", "1", sha, "--not", "--remotes"];
  if (baseBranch) {
    const base = await runCmd(
      ["git", "rev-parse", "--verify", "--quiet", `refs/heads/${baseBranch}`],
      repoPath,
    );
    if (base.code === 0) cmd.push(`refs/heads/${baseBranch}`);
  }
  const result = await runCmd(cmd, repoPath);
  if (result.code !== 0) {
    throw new Error(`git rev-list failed: ${result.stderr.trim()}`);
  }
  return result.stdout.trim().length > 0;
}

/**
 * Create backup/wt-<dirname> at the commit, reusing the name when it already
 * points there and adding the short SHA when it points elsewhere.
 */
async function createBackupBranch(
  repoPath: string,
  worktreePath: string,
  sha: string,
): Promise<string> {
  const name0 = backupBranchName(worktreePath);
  for (const name of [name0, `${name0}-${sha.slice(0, 10)}`]) {
    const existing = await runCmd(
      ["git", "rev-parse", "--verify", "--quiet", `refs/heads/${name}`],
      repoPath,
    );
    if (existing.code === 0) {
      if (existing.stdout.trim() === sha) return name;
      continue;
    }
    const created = await runCmd(["git", "branch", name, sha], repoPath);
    if (created.code !== 0) {
      throw new Error(`git branch ${name} failed: ${created.stderr.trim()}`);
    }
    return name;
  }
  throw new Error(
    `backup branch names ${name0}(-<sha>) already point elsewhere`,
  );
}

/** backup/wt-<dirname> for a worktree path. */
function backupBranchName(worktreePath: string): string {
  const dirname = worktreePath.split("/").pop()!;
  return `backup/wt-${dirname.replace(/[^A-Za-z0-9._-]/g, "-")}`;
}

/**
 * Where a removed worktree's work lives: the remote branch matching its
 * branch (its upstream, else origin/<name>) and how many commits of its HEAD
 * are on no remote ref.
 */
async function branchLocation(
  repoPath: string,
  wt: z.infer<typeof WorktreeEntrySchema>,
): Promise<
  Pick<
    z.infer<typeof RemovedWorktreeSchema>,
    "branchLocation" | "remoteBranch" | "unpushedCommits"
  >
> {
  const unpushed = await runCmd(
    ["git", "rev-list", "--count", wt.head, "--not", "--remotes"],
    repoPath,
  );
  const unpushedCommits = Number(unpushed.stdout.trim()) || 0;
  if (!wt.branch) return { branchLocation: "detached", unpushedCommits };

  const upstream = await runCmd(
    ["git", "for-each-ref", "--format=%(upstream)", wt.branch],
    repoPath,
  );
  const candidates = [
    upstream.stdout.trim(),
    wt.branch.replace(/^refs\/heads\//, "refs/remotes/origin/"),
  ].filter((ref) => ref.startsWith("refs/remotes/"));
  for (const ref of candidates) {
    const exists = await runCmd(
      ["git", "rev-parse", "--verify", "--quiet", ref],
      repoPath,
    );
    if (exists.code === 0) {
      return {
        branchLocation: "remote",
        remoteBranch: ref.replace(/^refs\/remotes\//, ""),
        unpushedCommits,
      };
    }
  }
  return { branchLocation: "local-only", unpushedCommits };
}

/** The git-worktree-doctor swamp model definition. */
export const model = {
  type: "@mgreten/git-worktree-doctor",
  version: "2026.11.19.1",
  globalArguments: GlobalArgsSchema,
  upgrades: [
    {
      toVersion: "2026.11.19.1",
      description: "Add removeStale; global arguments unchanged",
      upgradeAttributes: (old: Record<string, unknown>) => old,
    },
  ],
  resources: {
    diagnosis: {
      description:
        "Structured health report of all git worktrees in a repository",
      schema: DiagnosisSchema,
      lifetime: "7d" as const,
      garbageCollection: 50,
    },
    pruneResult: {
      description: "Result of a git worktree prune operation",
      schema: PruneResultSchema,
      lifetime: "30d" as const,
      garbageCollection: 20,
    },
    staleSweep: {
      description:
        "One removeStale run: worktrees removed (or that would be) and worktrees kept, with reasons",
      schema: StaleSweepSchema,
      lifetime: "90d" as const,
      garbageCollection: 100,
    },
  },
  methods: {
    diagnose: {
      description:
        "Parse `git worktree list --porcelain`, validate paths, and report health of all worktrees",
      arguments: z.object({
        repoPath: z.string().optional().describe(
          "Override the global repoPath for this invocation",
        ),
      }),
      execute: async (
        args: { repoPath?: string },
        context: MethodContext,
      ): Promise<{ dataHandles: Record<string, unknown>[] }> => {
        const rawPath = args.repoPath || context.globalArgs.repoPath;
        const repoPath = await resolveRepoPath(rawPath);

        context.logger.info("Diagnosing worktrees in {path}", {
          path: repoPath,
        });

        const worktrees = await listWorktrees(repoPath);

        const stale = worktrees.filter((w) => !w.pathExists && !w.isMain);
        const locked = worktrees.filter((w) => w.isLocked);
        const prunable = worktrees.filter((w) => w.isPrunable);
        const detached = worktrees.filter((w) => w.isDetached && !w.isMain);
        const healthy = worktrees.filter((w) =>
          w.pathExists && !w.isLocked && !w.isPrunable
        );

        const diagnosis = {
          repoPath,
          totalWorktrees: worktrees.length,
          healthy: healthy.length,
          stale: stale.length,
          locked: locked.length,
          prunable: prunable.length,
          detached: detached.length,
          worktrees,
          overallHealthy: stale.length === 0 && prunable.length === 0,
          diagnosedAt: new Date().toISOString(),
        };

        if (stale.length > 0) {
          context.logger.warning("{count} stale worktrees (path missing)", {
            count: stale.length,
          });
        }
        if (prunable.length > 0) {
          context.logger.warning("{count} prunable worktrees", {
            count: prunable.length,
          });
        }
        if (locked.length > 0) {
          context.logger.info("{count} locked worktrees", {
            count: locked.length,
          });
        }

        context.logger.info(
          "Diagnosis complete: {total} worktrees, {healthy} healthy, {stale} stale",
          {
            total: worktrees.length,
            healthy: healthy.length,
            stale: stale.length,
          },
        );

        const handle = await context.writeResource(
          "diagnosis",
          `diagnosis-${Date.now()}`,
          diagnosis as unknown as Record<string, unknown>,
        );

        return { dataHandles: [handle] };
      },
    },

    prune: {
      description:
        "Run `git worktree prune` to remove stale worktree entries. Use dryRun=true to preview without removing.",
      arguments: z.object({
        dryRun: z.boolean().default(true).describe(
          "Preview what would be pruned without actually removing (default: true)",
        ),
        repoPath: z.string().optional().describe(
          "Override the global repoPath for this invocation",
        ),
        verbose: z.boolean().default(false).describe(
          "Pass --verbose to git worktree prune",
        ),
      }),
      execute: async (
        args: { dryRun?: boolean; repoPath?: string; verbose?: boolean },
        context: MethodContext,
      ): Promise<{ dataHandles: Record<string, unknown>[] }> => {
        const rawPath = args.repoPath || context.globalArgs.repoPath;
        const repoPath = await resolveRepoPath(rawPath);
        const dryRun = args.dryRun ?? true;
        const verbose = args.verbose ?? false;

        const cmd = ["git", "worktree", "prune"];
        if (dryRun) cmd.push("--dry-run");
        if (verbose) cmd.push("--verbose");

        context.logger.info("{mode} worktree prune in {path}", {
          mode: dryRun ? "Dry-run" : "Live",
          path: repoPath,
        });

        const result = await runCmd(cmd, repoPath);
        const combinedOutput = `${result.stdout}\n${result.stderr}`.trim();
        const prunedPaths = combinedOutput
          .split("\n")
          .filter((line) => line.includes("Removing"))
          .map((line) => {
            const match = line.match(/Removing\s+worktrees\/([^:]+)/);
            return match ? match[1] : line;
          });

        const pruneResult = {
          repoPath,
          dryRun,
          prunedCount: prunedPaths.length,
          prunedPaths,
          stdout: result.stdout.slice(0, 2000),
          stderr: result.stderr.slice(0, 2000),
          exitCode: result.code,
          success: result.code === 0,
          prunedAt: new Date().toISOString(),
        };

        if (prunedPaths.length > 0) {
          context.logger.info("{mode} {count} worktree entries", {
            mode: dryRun ? "Would prune" : "Pruned",
            count: prunedPaths.length,
          });
        } else {
          context.logger.info("No worktrees to prune");
        }

        const handle = await context.writeResource(
          "pruneResult",
          `prune-${Date.now()}`,
          pruneResult as unknown as Record<string, unknown>,
        );

        return { dataHandles: [handle] };
      },
    },

    removeStale: {
      description:
        "Remove stale linked worktrees with `git worktree remove --force`, keeping branches. Keeps the main, locked, in-use (a process cwd), dirty, and recently active worktrees, and backs up unsaved detached HEADs to backup/wt-<dirname>. Writes one staleSweep report per run. dryRun defaults to true.",
      arguments: z.object({
        dryRun: z.boolean().default(true).describe(
          "Report what would be removed without removing (default: true)",
        ),
        repoPath: z.string().optional().describe(
          "Override the global repoPath for this invocation",
        ),
        staleDays: z.number().positive().default(14).describe(
          "Keep worktrees active within this many days; activity is the newer of the index mtime and the HEAD commit time",
        ),
        ignoreUntracked: z.array(z.string()).default(DEFAULT_IGNORE_UNTRACKED)
          .describe(
            "Untracked paths that do not block removal. A pattern matches the path and everything below it; * matches within one path segment",
          ),
        baseBranch: z.string().optional().describe(
          "Branch whose commits count as saved for detached HEADs (default: origin/HEAD's branch)",
        ),
      }),
      execute: async (
        args: {
          dryRun?: boolean;
          repoPath?: string;
          staleDays?: number;
          ignoreUntracked?: string[];
          baseBranch?: string;
        },
        context: MethodContext,
      ): Promise<{ dataHandles: Record<string, unknown>[] }> => {
        const startedAt = new Date();
        const repoPath = await resolveRepoPath(
          args.repoPath || context.globalArgs.repoPath,
        );
        const dryRun = args.dryRun ?? true;
        const staleDays = args.staleDays ?? 14;
        const ignoreUntracked = args.ignoreUntracked ??
          DEFAULT_IGNORE_UNTRACKED;

        const worktrees = await listWorktrees(repoPath);
        // Run repo-level commands from the main worktree, which is never
        // removed, in case repoPath is a linked worktree.
        const mainPath = worktrees.find((w) => w.isMain)?.path ?? repoPath;
        const baseBranch = await resolveBaseBranch(mainPath, args.baseBranch);
        const cutoffMs = startedAt.getTime() - staleDays * 86_400_000;

        context.logger.info(
          "{mode} stale worktree sweep of {count} worktrees in {path}",
          {
            mode: dryRun ? "Dry-run" : "Live",
            count: worktrees.length,
            path: repoPath,
          },
        );

        const removed: z.infer<typeof RemovedWorktreeSchema>[] = [];
        const kept: z.infer<typeof KeptWorktreeSchema>[] = [];
        const keep = (
          wt: z.infer<typeof WorktreeEntrySchema>,
          reason: z.infer<typeof KeepReasonSchema>,
          detail?: string,
          lastActivityAt?: string,
        ) => {
          kept.push({
            path: wt.path,
            branch: wt.branch,
            head: wt.head,
            reason,
            detail,
            lastActivityAt,
          });
          context.logger.info("Keep {path}: {reason} {detail}", {
            path: wt.path,
            reason,
            detail: detail ?? "",
          });
        };

        let cwds = await processCwds();

        for (const wt of worktrees) {
          if (wt.isMain) {
            keep(wt, "main");
            continue;
          }
          if (wt.isBare) {
            keep(wt, "bare");
            continue;
          }
          if (wt.isLocked) {
            keep(wt, "locked", wt.lockReason);
            continue;
          }
          if (!wt.pathExists) {
            keep(wt, "missing-path", "run prune to drop its metadata");
            continue;
          }

          // Refresh before each live decision: a long sweep can outlast the
          // first snapshot.
          if (!dryRun) cwds = await processCwds();
          const realPath = await Deno.realPath(wt.path).catch(() => wt.path);
          const cwd = cwdInside(cwds, realPath) ?? cwdInside(cwds, wt.path);
          if (cwd) {
            keep(wt, "in-use", `a process has cwd ${cwd}`);
            continue;
          }

          const gitDirResult = await runCmd([
            "git",
            "-C",
            wt.path,
            "rev-parse",
            "--absolute-git-dir",
          ]);
          if (gitDirResult.code !== 0) {
            keep(
              wt,
              "tracked-changes",
              `git rev-parse failed: ${gitDirResult.stderr.trim()}`,
            );
            continue;
          }
          const gitDir = gitDirResult.stdout.trim();
          const marker = (await Promise.all(
            IN_PROGRESS_MARKERS.map(async (m) =>
              await pathExists(`${gitDir}/${m}`) ? m : null
            ),
          )).find((m) => m !== null);
          if (marker) {
            keep(wt, "operation-in-progress", `${marker} present`);
            continue;
          }

          // Read the index mtime before git status touches anything.
          const indexMs = (await Deno.stat(`${gitDir}/index`).catch(() =>
            null
          ))?.mtime?.getTime() ?? 0;
          const headTime = await runCmd(
            ["git", "show", "-s", "--format=%ct", wt.head],
            mainPath,
          );
          const headMs = (Number(headTime.stdout.trim()) || 0) * 1000;
          const lastActivityAt = new Date(Math.max(indexMs, headMs))
            .toISOString();

          const changes = await worktreeChanges(wt.path, ignoreUntracked);
          if (changes) {
            keep(wt, changes.reason, changes.detail, lastActivityAt);
            continue;
          }
          if (Math.max(indexMs, headMs) > cutoffMs) {
            keep(
              wt,
              "active",
              `last activity within ${staleDays} days (${
                indexMs >= headMs ? "index" : "HEAD commit"
              })`,
              lastActivityAt,
            );
            continue;
          }

          let backupBranch: string | undefined;
          if (
            wt.isDetached &&
            await hasUnsavedCommits(mainPath, wt.head, baseBranch)
          ) {
            if (dryRun) {
              backupBranch = backupBranchName(wt.path);
            } else {
              try {
                backupBranch = await createBackupBranch(
                  mainPath,
                  wt.path,
                  wt.head,
                );
                context.logger.info("Backed up {head} to {branch}", {
                  head: wt.head,
                  branch: backupBranch,
                });
              } catch (err) {
                keep(wt, "backup-failed", String(err), lastActivityAt);
                continue;
              }
            }
          }

          const location = await branchLocation(mainPath, wt);
          if (dryRun) {
            removed.push({
              path: wt.path,
              branch: wt.branch,
              head: wt.head,
              lastActivityAt,
              ...location,
              backupBranch,
            });
            context.logger.info("Would remove {path}", { path: wt.path });
            continue;
          }

          const t0 = Date.now();
          const result = await runCmd(
            ["git", "worktree", "remove", "--force", wt.path],
            mainPath,
          );
          if (result.code !== 0) {
            keep(
              wt,
              "remove-failed",
              `${result.stderr.trim().slice(0, 300)}${
                backupBranch ? ` (backup ${backupBranch} created)` : ""
              }`,
              lastActivityAt,
            );
            continue;
          }
          removed.push({
            path: wt.path,
            branch: wt.branch,
            head: wt.head,
            lastActivityAt,
            ...location,
            backupBranch,
            durationMs: Date.now() - t0,
          });
          context.logger.info("Removed {path} in {ms}ms", {
            path: wt.path,
            ms: Date.now() - t0,
          });
        }

        const keptByReason: Record<string, number> = {};
        for (const k of kept) {
          keptByReason[k.reason] = (keptByReason[k.reason] ?? 0) + 1;
        }

        const sweep: z.infer<typeof StaleSweepSchema> = {
          repoPath,
          dryRun,
          staleDays,
          baseBranch,
          ignoreUntracked,
          totalWorktrees: worktrees.length,
          removedCount: removed.length,
          keptCount: kept.length,
          keptByReason,
          removed,
          kept,
          startedAt: startedAt.toISOString(),
          finishedAt: new Date().toISOString(),
        };

        context.logger.info(
          "{mode} {removed} worktrees, kept {kept}",
          {
            mode: dryRun ? "Would remove" : "Removed",
            removed: removed.length,
            kept: kept.length,
          },
        );

        const handle = await context.writeResource(
          "staleSweep",
          `sweep-${Date.now()}`,
          sweep as unknown as Record<string, unknown>,
        );

        return { dataHandles: [handle] };
      },
    },
  },
};
