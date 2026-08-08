import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { run, slugify, readJson, writeJsonAtomic, ensureDir, WingmanError } from './util.js';

/**
 * Normalise any git remote URL to a canonical `host/owner/repo` string so the
 * same project resolves identically no matter how it was cloned.
 *
 *   git@github.com:User/Repo.git      -> github.com/user/repo
 *   https://github.com/User/Repo.git  -> github.com/user/repo
 *   ssh://git@github.com:22/u/r       -> github.com/u/r
 */
export function normalizeRemote(url) {
  if (!url || typeof url !== 'string') return null;
  let s = url.trim();
  if (!s) return null;

  s = s.replace(/^[a-z0-9._-]+::/i, '');            // git remote helper prefix
  s = s.replace(/\/+$/, '');

  const scp = s.match(/^(?:([^@/]+)@)?([^:/]+):(?!\/)(.+)$/);
  if (scp) {
    s = `${scp[2]}/${scp[3]}`;
  } else {
    const withScheme = s.match(/^[a-z][a-z0-9+.-]*:\/\/(.*)$/i);
    if (withScheme) s = withScheme[1];
    s = s.replace(/^[^@/]+@/, '');                   // strip user@
    s = s.replace(/^([^/]+):\d+\//, '$1/');          // strip :port
  }

  s = s.replace(/\.git$/i, '').replace(/\/+$/, '').replace(/\/{2,}/g, '/');
  if (!s || !s.includes('/')) return null;
  return s.toLowerCase();
}

export function repoSlugFromRemote(normalized) {
  if (!normalized) return null;
  const parts = normalized.split('/').filter(Boolean);
  return slugify(parts[parts.length - 1] || 'project');
}

export function hashId(input) {
  return crypto.createHash('sha256').update(String(input)).digest('hex').slice(0, 12);
}

/** `a3f9c21b8e04-myapp` — collision-safe prefix plus a human-readable tail. */
export function makeProjectId(seed, name) {
  return `${hashId(seed)}-${slugify(name)}`;
}

export function isValidProjectId(id) {
  return typeof id === 'string' && /^[0-9a-f]{12}-[a-z0-9-]{1,40}$/.test(id);
}

export function gitTopLevel(cwd) {
  const res = run('git', ['rev-parse', '--show-toplevel'], { cwd });
  if (!res.ok) return null;
  const dir = res.stdout.trim();
  return dir ? path.resolve(dir) : null;
}

export function gitRemote(cwd) {
  for (const name of ['origin', 'upstream']) {
    const res = run('git', ['remote', 'get-url', name], { cwd });
    if (res.ok && res.stdout.trim()) return res.stdout.trim();
  }
  const list = run('git', ['remote'], { cwd });
  if (list.ok) {
    const first = list.stdout.split('\n').map((s) => s.trim()).filter(Boolean)[0];
    if (first) {
      const res = run('git', ['remote', 'get-url', first], { cwd });
      if (res.ok && res.stdout.trim()) return res.stdout.trim();
    }
  }
  return null;
}

export function markerPath(dir) {
  return path.join(dir, '.wingman', 'project.json');
}

/** Nearest `.wingman/project.json` walking upwards. Wins over remote detection. */
export function findMarker(startDir) {
  let dir = path.resolve(startDir);
  const root = path.parse(dir).root;
  for (let i = 0; i < 64; i++) {
    const file = markerPath(dir);
    if (fs.existsSync(file)) {
      const data = readJson(file, null);
      if (data && isValidProjectId(data.id)) return { dir, file, data };
    }
    if (dir === root) break;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

/**
 * Write the local marker and keep it out of the project's git history via
 * .git/info/exclude, which is local-only and invisible to collaborators.
 */
export function writeMarker(dir, { id, name, remote }) {
  const file = markerPath(dir);
  ensureDir(path.dirname(file));
  writeJsonAtomic(file, { id, name, remote: remote || null, createdAt: new Date().toISOString() });
  excludeLocally(dir);
  return file;
}

export function excludeLocally(dir) {
  const gitDirRes = run('git', ['rev-parse', '--git-dir'], { cwd: dir });
  if (!gitDirRes.ok) return false;
  const gitDir = path.resolve(dir, gitDirRes.stdout.trim());
  const infoDir = path.join(gitDir, 'info');
  const excludeFile = path.join(infoDir, 'exclude');
  try {
    ensureDir(infoDir);
    const current = fs.existsSync(excludeFile) ? fs.readFileSync(excludeFile, 'utf8') : '';
    if (current.split('\n').some((l) => l.trim() === '.wingman/')) return true;
    const prefix = current.length && !current.endsWith('\n') ? '\n' : '';
    fs.appendFileSync(excludeFile, `${prefix}\n# added by wingman (local only, never committed)\n.wingman/\n`);
    return true;
  } catch {
    return false;
  }
}

/**
 * Resolve which project the current directory belongs to.
 * Marker file > git remote > nothing (caller must ask the user for a name).
 */
export function resolveProject(cwd = process.cwd()) {
  const marker = findMarker(cwd);
  if (marker) {
    return {
      id: marker.data.id,
      name: marker.data.name || marker.data.id.split('-').slice(1).join('-'),
      remote: marker.data.remote || null,
      root: marker.dir,
      source: 'marker',
    };
  }

  const top = gitTopLevel(cwd);
  if (top) {
    const remote = gitRemote(top);
    const normalized = normalizeRemote(remote);
    if (normalized) {
      const name = repoSlugFromRemote(normalized);
      return {
        id: makeProjectId(normalized, name),
        name,
        remote: normalized,
        root: top,
        source: 'remote',
      };
    }
    return { id: null, name: path.basename(top), remote: null, root: top, source: 'git-no-remote' };
  }

  return { id: null, name: path.basename(path.resolve(cwd)), remote: null, root: path.resolve(cwd), source: 'plain-dir' };
}

/** A project id derived from a user-supplied name, for folders with no remote. */
export function projectFromName(name, root) {
  const clean = slugify(name);
  if (!clean) throw new WingmanError('Project name cannot be empty.');
  const seed = `name:${clean}`;
  return { id: makeProjectId(seed, clean), name: clean, remote: null, root, source: 'named' };
}

export function defaultDeviceId() {
  const host = os.hostname().split('.')[0];
  return slugify(host, 32) || 'device';
}

export function isValidDeviceId(id) {
  return typeof id === 'string' && /^[a-z0-9][a-z0-9-]{0,31}$/.test(id);
}
