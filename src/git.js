import fs from 'node:fs';
import path from 'node:path';
import { run, hasBin, logLine, WingmanError } from './util.js';

/**
 * Git calls are made with identity and hooks forced to safe values so we never
 * depend on (or disturb) the user's global git config, and never execute a
 * hook that happens to live in the memory repo.
 */
const SAFE_ENV = {
  GIT_TERMINAL_PROMPT: '0',
  GIT_ASKPASS: 'echo',
  GIT_CONFIG_NOSYSTEM: '0',
};

const IDENTITY = [
  '-c', 'user.name=Wingman',
  '-c', 'user.email=wingman@localhost',
  '-c', 'core.hooksPath=/dev/null',
  '-c', 'commit.gpgsign=false',
  '-c', 'gc.auto=0',
];

export function gitAvailable() {
  return hasBin('git');
}

export function git(args, { cwd, timeout, input } = {}) {
  if (!gitAvailable()) {
    throw new WingmanError('git is not installed or not on PATH.', 'Install git: https://git-scm.com/downloads');
  }
  const res = run('git', [...IDENTITY, ...args], { cwd, timeout, input, env: SAFE_ENV });
  if (!res.ok) logLine('git', `${args.join(' ')} -> exit ${res.code}: ${res.stderr.trim().slice(0, 300)}`);
  return res;
}

export function isRepo(dir) {
  if (!dir || !fs.existsSync(dir)) return false;
  return git(['rev-parse', '--is-inside-work-tree'], { cwd: dir }).ok;
}

export function initRepo(dir) {
  fs.mkdirSync(dir, { recursive: true });
  const res = git(['init', '-b', 'main'], { cwd: dir });
  if (!res.ok) {
    // Older git without -b support.
    const legacy = git(['init'], { cwd: dir });
    if (!legacy.ok) throw new WingmanError(`Could not create the memory repo at ${dir}.`, legacy.stderr.trim());
    git(['checkout', '-b', 'main'], { cwd: dir });
  }
  return dir;
}

/**
 * Which branch the store uses. GitHub's default is `main`, but an account
 * configured for `master`, or a repo created before the change, would silently
 * never sync if we assumed. Resolved once per process and cached.
 */
const branchCache = new Map();
export function defaultBranch(dir) {
  if (branchCache.has(dir)) return branchCache.get(dir);
  let branch = 'main';

  const head = git(['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'], { cwd: dir });
  if (head.ok && head.stdout.trim()) {
    branch = head.stdout.trim().replace(/^origin\//, '') || 'main';
  } else {
    const remoteHeads = git(['ls-remote', '--symref', 'origin', 'HEAD'], { cwd: dir, timeout: 30000 });
    const m = remoteHeads.ok && remoteHeads.stdout.match(/^ref:\s+refs\/heads\/(\S+)\s+HEAD$/m);
    if (m) branch = m[1];
    else {
      const local = git(['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: dir });
      const name = local.ok ? local.stdout.trim() : '';
      if (name && name !== 'HEAD') branch = name;
    }
  }

  branchCache.set(dir, branch);
  return branch;
}

export function currentBranch(dir) {
  const res = git(['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: dir });
  return res.ok ? res.stdout.trim() : 'main';
}

export function hasCommits(dir) {
  return git(['rev-parse', '--verify', 'HEAD'], { cwd: dir }).ok;
}

export function getRemote(dir, name = 'origin') {
  const res = git(['remote', 'get-url', name], { cwd: dir });
  return res.ok ? res.stdout.trim() : null;
}

export function setRemote(dir, url, name = 'origin') {
  if (getRemote(dir, name)) git(['remote', 'set-url', name, url], { cwd: dir });
  else git(['remote', 'add', name, url], { cwd: dir });
  return getRemote(dir, name);
}

export function isDirty(dir) {
  const res = git(['status', '--porcelain'], { cwd: dir });
  return res.ok && res.stdout.trim().length > 0;
}

export function clone(url, dir, { timeout = 180000 } = {}) {
  fs.mkdirSync(path.dirname(dir), { recursive: true });
  const res = git(['clone', '--quiet', url, dir], { timeout });
  return res;
}

export function stageAll(dir) {
  return git(['add', '-A', '--', '.'], { cwd: dir });
}

export function commit(dir, message) {
  if (!isDirty(dir)) return { ok: true, skipped: true };
  const staged = stageAll(dir);
  if (!staged.ok) return { ok: false, reason: staged.stderr.trim() };
  const res = git(['commit', '--no-verify', '-m', message], { cwd: dir });
  if (!res.ok && /nothing to commit/i.test(res.stdout + res.stderr)) return { ok: true, skipped: true };
  return { ok: res.ok, reason: res.stderr.trim() || res.stdout.trim() };
}

/**
 * Pull with rebase. Because every device writes only to filenames it owns,
 * conflicts should not occur; if one somehow does we abort cleanly and report
 * rather than leaving the repo mid-rebase.
 */
export function pull(dir, { branch, timeout = 90000 } = {}) {
  if (!getRemote(dir)) return { ok: true, skipped: true, reason: 'no remote' };
  branch = branch || defaultBranch(dir);
  const fetched = git(['fetch', '--quiet', 'origin', branch], { cwd: dir, timeout });
  if (!fetched.ok) return { ok: false, offline: true, reason: fetched.stderr.trim() };

  const remoteRef = git(['rev-parse', '--verify', `origin/${branch}`], { cwd: dir });
  if (!remoteRef.ok) return { ok: true, skipped: true, reason: 'remote branch does not exist yet' };

  if (!hasCommits(dir)) {
    const reset = git(['reset', '--hard', `origin/${branch}`], { cwd: dir });
    return { ok: reset.ok, reason: reset.stderr.trim() };
  }

  const res = git(['rebase', '--autostash', `origin/${branch}`], { cwd: dir, timeout });
  if (res.ok) return { ok: true };
  git(['rebase', '--abort'], { cwd: dir });

  const merged = git(['merge', '--no-edit', '--no-verify', `origin/${branch}`], { cwd: dir, timeout });
  if (merged.ok) return { ok: true, merged: true };
  git(['merge', '--abort'], { cwd: dir });

  /*
   * Second machine adopting an existing store: `wingman init` created a local
   * store with its own root commit, and the remote already has another
   * machine's history. The two share no ancestor, so plain merge refuses.
   *
   * Joining them is safe here precisely because of the store layout: journal
   * entries live under per-device paths with unique timestamped filenames, so
   * no entry can collide with another. The only files present on both sides are
   * the generated README and .gitattributes, and `-X ours` settles those
   * without discarding a single entry from either side.
   */
  const unrelated = /unrelated histories/i.test(merged.stderr + merged.stdout);
  if (unrelated) {
    const joined = git(
      ['merge', '--no-edit', '--no-verify', '--allow-unrelated-histories', '-X', 'ours', `origin/${branch}`],
      { cwd: dir, timeout },
    );
    if (joined.ok) return { ok: true, merged: true, joinedHistories: true };
    git(['merge', '--abort'], { cwd: dir });
    return { ok: false, conflict: true, reason: joined.stderr.trim() };
  }

  return { ok: false, conflict: true, reason: merged.stderr.trim() };
}

export function push(dir, { branch, timeout = 90000, setUpstream = false } = {}) {
  if (!getRemote(dir)) return { ok: true, skipped: true, reason: 'no remote' };
  branch = branch || defaultBranch(dir);
  const args = ['push', '--quiet'];
  if (setUpstream) args.push('-u');
  args.push('origin', `HEAD:${branch}`);
  const res = git(args, { cwd: dir, timeout });
  if (res.ok) return { ok: true };
  return { ok: false, offline: /could not resolve host|network|timed out|connection/i.test(res.stderr), reason: res.stderr.trim() };
}

export function lastCommitDate(dir) {
  const res = git(['log', '-1', '--format=%cI'], { cwd: dir });
  if (!res.ok || !res.stdout.trim()) return null;
  const d = new Date(res.stdout.trim());
  return Number.isNaN(d.getTime()) ? null : d;
}

export function countUnpushed(dir, branch) {
  if (!getRemote(dir) || !hasCommits(dir)) return 0;
  branch = branch || defaultBranch(dir);
  const res = git(['rev-list', '--count', `origin/${branch}..HEAD`], { cwd: dir });
  if (!res.ok) return 0;
  const n = parseInt(res.stdout.trim(), 10);
  return Number.isFinite(n) ? n : 0;
}
