/**
 * Git Integration — Branch, Commit, and Sync Operations
 *
 * Bridges git operations with Favro cards:
 * - Project config in .favro.json (board link, card ID patterns)
 * - Branch creation from cards with slugified names
 * - Smart commits with auto-card references
 * - Branch ↔ card sync (merged → Done, open → In Progress)
 */
import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { RefusalError } from './refusal';

// ─── Project Config (.favro.json) ─────────────────────────────────────────────

export interface FavroProjectConfig {
  boardId: string;
  boardName?: string;
  cardPrefix?: string;       // e.g. "CARD" for CARD-123 style IDs
  branchPattern?: string;    // e.g. "feature/{{cardId}}-{{slug}}"
  branches?: Record<string, string>;  // branch name → cardId mapping
}

const CONFIG_FILE = '.favro.json';

/**
 * Find the project root by walking up from cwd looking for .git or .favro.json.
 */
export function findProjectRoot(startDir?: string): string {
  let dir = startDir ?? process.cwd();
  while (dir !== path.dirname(dir)) {
    if (fs.existsSync(path.join(dir, '.git')) || fs.existsSync(path.join(dir, CONFIG_FILE))) {
      return dir;
    }
    dir = path.dirname(dir);
  }
  return process.cwd();
}

export function getConfigPath(projectRoot?: string): string {
  return path.join(projectRoot ?? findProjectRoot(), CONFIG_FILE);
}

export function readProjectConfig(projectRoot?: string): FavroProjectConfig | null {
  const configPath = getConfigPath(projectRoot);
  if (!fs.existsSync(configPath)) return null;
  return JSON.parse(fs.readFileSync(configPath, 'utf-8'));
}

export function writeProjectConfig(config: FavroProjectConfig, projectRoot?: string): string {
  const configPath = getConfigPath(projectRoot);
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n', 'utf-8');
  return configPath;
}

// ─── Git Helpers ──────────────────────────────────────────────────────────────

/**
 * Run git with an argv array — never a composed shell string (#146).
 *
 * Branch names and commit messages carry card titles authored in Favro, and
 * `favro_run` lets an MCP agent compose them, so both cross a trust boundary
 * before they get here. execFileSync spawns git directly: no /bin/sh, so
 * `$(…)`, backticks and `;` are ordinary characters. Every argument is passed
 * verbatim; no call site here wants a pipe, a glob or `&&`, so there is no
 * shell exception to make.
 *
 * Like execSync, this returns stdout and throws on a non-zero exit — the
 * boolean probes below depend on that.
 */
function git(...args: string[]): string {
  return execFileSync('git', args, {
    cwd: findProjectRoot(),
    encoding: 'utf-8',
    stdio: ['pipe', 'pipe', 'pipe'],
  }).trim();
}

/**
 * Get the current branch name.
 */
export function getCurrentBranch(): string {
  return git('rev-parse', '--abbrev-ref', 'HEAD');
}

/**
 * List all local branches.
 */
export function listBranches(): string[] {
  return git('branch', '--list', '--format=%(refname:short)')
    .split('\n')
    .filter(Boolean);
}

/**
 * Check if a branch has been merged into the default branch (main/master).
 *
 * THROWS when the check cannot run. It used to answer `false`, which was
 * classified conservative on the grounds that `false` never advertises a branch
 * as safe to delete — but nothing here deletes, and BOTH answers write:
 * `analyzeBranches` spells `false` as status `'open'`, and `favro git sync`
 * PATCHes every `'open'` card to "In Progress" (`git.ts:304` builds the target,
 * `git.ts:373` sends it). So one failed `git branch --merged` moved finished
 * work BACKWARDS, in volume — `getDefaultBranch()` naming a ref this clone does
 * not have fails every branch at once. There is no safe default when both
 * directions write, so the failure reaches `git sync`, which refuses through its
 * error boundary rather than guessing.
 *
 * ponytail: the whole pass refuses, and there is no partial answer to salvage —
 * CORRECTED in review, the first version of this note named a ceiling that
 * cannot occur. The git call below is the SAME for every branch (its argument is
 * the default branch, not `branch`; `merged.includes(branch)` is the only
 * per-branch step), so a failure here is global by construction: every branch
 * fails or none does. An `'unknown'` status arm would mark them all unknown,
 * which is this refusal with extra steps. The cost that IS real, measured on the
 * built CLI: a `develop`-default clone with no `origin/HEAD` exits 1 on
 * `git sync` even with nothing to sync, where it used to print "No branches with
 * card references found." at exit 0. The upgrade path for that is a lazy default
 * resolve — refuse when a target exists rather than when the listing starts —
 * not a status arm.
 */
export function isBranchMerged(branch: string): boolean {
  const defaultBranch = getDefaultBranch();
  const merged = git('branch', '--merged', defaultBranch, '--format=%(refname:short)')
    .split('\n')
    .filter(Boolean);
  return merged.includes(branch);
}

/**
 * Get the default branch (main or master).
 *
 * REFUSES rather than answering `'main'` for a repo that has no `main`. That
 * answer was the trigger for the swallow above: `git branch --merged main` fails
 * for every branch at once in a clone whose default is `develop`, and the
 * failure then read as "nothing is merged". Naming a ref we did not find is a
 * plausible answer built from input we could not read, which is the same defect
 * one hop earlier.
 */
export function getDefaultBranch(): string {
  try {
    const ref = git('symbolic-ref', 'refs/remotes/origin/HEAD');
    return ref.replace('refs/remotes/origin/', '');
  } catch {
    // Fallback: check if main or master exists
    const branches = listBranches();
    if (branches.includes('main')) return 'main';
    if (branches.includes('master')) return 'master';
    throw new RefusalError(
      'Cannot determine the default branch: this repo has no refs/remotes/origin/HEAD, ' +
      'and no local `main` or `master`. Point origin/HEAD at the right branch with ' +
      '`git remote set-head origin <branch>`.',
    );
  }
}

/**
 * Create and checkout a new branch.
 */
export function createBranch(name: string): void {
  git('checkout', '-b', name);
}

/**
 * Get the last commit hash (short).
 */
export function getLastCommitHash(): string {
  return git('rev-parse', '--short', 'HEAD');
}

/**
 * Get the last commit message.
 */
export function getLastCommitMessage(): string {
  return git('log', '-1', '--format=%s');
}

/**
 * Commit with a message (assumes files are already staged).
 */
export function commitWithMessage(message: string): string {
  git('commit', '-m', message);
  return getLastCommitHash();
}

/**
 * Check if there are staged changes.
 */
export function hasStagedChanges(): boolean {
  try {
    git('diff', '--cached', '--quiet');
    return false;
  } catch {
    return true;
  }
}

/**
 * Check if we're in a git repo.
 */
export function isGitRepo(): boolean {
  try {
    git('rev-parse', '--git-dir');
    return true;
  } catch {
    return false;
  }
}

// ─── Card ID Extraction ──────────────────────────────────────────────────────

/**
 * Extract a card ID from a branch name.
 *
 * Supports patterns:
 * - feature/<cardId>-slug       → cardId
 * - fix/<cardId>-slug           → cardId
 * - <prefix>-123                → prefix-123 (with custom prefix)
 * - raw hex IDs in branch name  → matches Favro card ID format
 */
export function extractCardIdFromBranch(branch: string, cardPrefix?: string): string | null {
  // Custom prefix pattern: PREFIX-123
  if (cardPrefix) {
    const prefixRegex = new RegExp(`(${cardPrefix}-\\d+)`, 'i');
    const prefixMatch = branch.match(prefixRegex);
    if (prefixMatch) return prefixMatch[1];
  }

  // Standard pattern: feature/<id>-slug or fix/<id>-slug
  const pathMatch = branch.match(/^(?:feature|fix|bugfix|hotfix|chore)\/([\w-]+?)(?:-[a-z]|$)/i);
  if (pathMatch) {
    const candidate = pathMatch[1];
    // If it looks like a Favro card ID (hex string), return it
    if (/^[a-f0-9]{10,}$/i.test(candidate)) return candidate;
    // If custom prefix matches
    if (cardPrefix && candidate.startsWith(cardPrefix)) return candidate;
    return candidate;
  }

  // Fallback: look for hex ID anywhere in branch name (Favro card IDs are long hex)
  const hexMatch = branch.match(/([a-f0-9]{16,})/i);
  if (hexMatch) return hexMatch[1];

  return null;
}

// ─── Slug Generation ──────────────────────────────────────────────────────────

/**
 * Convert a card title to a branch-safe slug.
 */
export function slugify(title: string): string {
  return title
    // NFC first: the strip below removes a combining mark but keeps the base
    // letter it sits on, so a decomposed `café` slugged to `cafe` while the
    // precomposed one slugged to `caf`. Same title, two branch names,
    // depending only on where it was typed (#141).
    //
    // ponytail: a precomposed accent is still dropped whole. Decompose and
    // strip only U+0300–U+036F if a branch name should keep the base letter.
    .normalize('NFC')
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 50);
}

/**
 * Generate a branch name from a card ID and title.
 */
export function generateBranchName(cardId: string, title: string, pattern?: string): string {
  const slug = slugify(title);
  if (pattern) {
    return pattern
      .replace('{{cardId}}', cardId)
      .replace('{{slug}}', slug);
  }
  return `feature/${cardId}-${slug}`;
}

// ─── Branch Sync Analysis ─────────────────────────────────────────────────────

export interface BranchCardMapping {
  branch: string;
  cardId: string | null;
  status: 'merged' | 'open' | 'current';
}

/**
 * Analyze all branches and map them to card IDs with merge status.
 */
export function analyzeBranches(cardPrefix?: string): BranchCardMapping[] {
  const branches = listBranches();
  const currentBranch = getCurrentBranch();
  const defaultBranch = getDefaultBranch();

  return branches
    .filter(b => b !== defaultBranch)
    .map(branch => {
      const cardId = extractCardIdFromBranch(branch, cardPrefix);
      const isMerged = isBranchMerged(branch);
      const isCurrent = branch === currentBranch;

      return {
        branch,
        cardId,
        status: isCurrent ? 'current' as const : isMerged ? 'merged' as const : 'open' as const,
      };
    });
}
