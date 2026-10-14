import { Octokit } from '@octokit/rest';
import { config } from './config';
import { TTLCache } from './cache';

const octokit = new Octokit({ auth: config.githubToken });

const TREE_TTL_MS = 24 * 60 * 60 * 1000;
const CODEOWNERS_TTL_MS = 24 * 60 * 60 * 1000;

const treeCache = new TTLCache<string[]>(TREE_TTL_MS);
const codeownersCache = new TTLCache<string>(CODEOWNERS_TTL_MS);

async function loadRepoTree(): Promise<string[]> {
  const cached = treeCache.get('tree');
  if (cached) return cached;

  const branch = config.githubBranch ?? (await octokit.rest.repos.get({
    owner: config.githubOwner,
    repo: config.githubRepo,
  })).data.default_branch;

  const ref = await octokit.rest.git.getRef({
    owner: config.githubOwner,
    repo: config.githubRepo,
    ref: `heads/${branch}`,
  });

  const tree = await octokit.rest.git.getTree({
    owner: config.githubOwner,
    repo: config.githubRepo,
    tree_sha: ref.data.object.sha,
    recursive: 'true',
  });

  const paths = (tree.data.tree ?? [])
    .filter((entry) => entry.type === 'blob' && entry.path)
    .map((entry) => entry.path as string);

  treeCache.set('tree', paths);
  return paths;
}

/**
 * Crashlytics only gives us a bare filename (e.g. "MainActivity.kt"), so we
 * resolve it against the repo's full file tree. Returns every path whose
 * basename matches; caller decides how to handle ambiguity.
 */
export async function findFullPath(filename: string): Promise<string[]> {
  const paths = await loadRepoTree();
  return paths.filter((p) => p === filename || p.endsWith(`/${filename}`));
}

export interface LastEditor {
  name: string;
  email: string;
  /** The release branch the author was read from, when the alert's version had one. */
  releaseBranch?: string;
  /** The release branch we wanted but couldn't use, so the default branch was read instead. */
  missingReleaseBranch?: string;
}

async function lastCommitAuthor(filePath: string, sha: string | undefined): Promise<{ name: string; email: string } | null> {
  const { data } = await octokit.rest.repos.listCommits({
    owner: config.githubOwner,
    repo: config.githubRepo,
    path: filePath,
    sha,
    per_page: 1,
  });

  const author = data[0]?.commit?.author;
  if (!author?.email) return null;

  return { name: author.name ?? author.email, email: author.email };
}

/**
 * Most recent commit that touched this exact file, deliberately uncached since
 * "last edited" should reflect the current state at alert time. When the alert
 * carries an app version, read it from that version's release branch so we
 * blame the code that actually shipped, not whatever landed afterwards.
 */
export async function getLastEditor(filePath: string, version?: string): Promise<LastEditor | null> {
  const releaseBranch = version ? `release/${version}` : undefined;

  if (releaseBranch) {
    try {
      const author = await lastCommitAuthor(filePath, releaseBranch);
      if (author) return { ...author, releaseBranch };
    } catch (err: any) {
      if (err?.status !== 404) throw err;
    }
  }

  const author = await lastCommitAuthor(filePath, config.githubBranch);
  if (!author) return null;

  return { ...author, missingReleaseBranch: releaseBranch };
}

export async function getCodeownersContent(): Promise<string> {
  const cached = codeownersCache.get('codeowners');
  if (cached) return cached;

  const response = await octokit.rest.repos.getContent({
    owner: config.githubOwner,
    repo: config.githubRepo,
    path: config.codeownersPath,
    ref: config.githubBranch,
  });

  const data = response.data;
  if (Array.isArray(data) || !('content' in data)) {
    throw new Error(`CODEOWNERS path "${config.codeownersPath}" did not resolve to a single file`);
  }

  const content = Buffer.from(data.content, 'base64').toString('utf-8');
  codeownersCache.set('codeowners', content);
  return content;
}
