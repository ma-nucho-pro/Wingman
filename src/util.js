import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

export const HOME = os.homedir();
export const WINGMAN_HOME = process.env.WINGMAN_HOME || path.join(HOME, '.wingman');
export const STORE_DIR = path.join(WINGMAN_HOME, 'store');
export const CONFIG_PATH = path.join(WINGMAN_HOME, 'config.json');
export const LOG_DIR = path.join(WINGMAN_HOME, 'logs');
export const LOCK_PATH = path.join(WINGMAN_HOME, 'wingman.lock');

const NO_COLOR = !!process.env.NO_COLOR || process.env.TERM === 'dumb' || !process.stdout.isTTY;

const C = {
  reset: '\u001b[0m', dim: '\u001b[2m', bold: '\u001b[1m',
  red: '\u001b[31m', green: '\u001b[32m', yellow: '\u001b[33m', cyan: '\u001b[36m',
};

function paint(code, s) { return NO_COLOR ? s : code + s + C.reset; }

export const color = {
  dim: (s) => paint(C.dim, s),
  bold: (s) => paint(C.bold, s),
  red: (s) => paint(C.red, s),
  green: (s) => paint(C.green, s),
  yellow: (s) => paint(C.yellow, s),
  cyan: (s) => paint(C.cyan, s),
};

/** Errors we raise on purpose. Printed as a clean message, never a stack trace. */
export class WingmanError extends Error {
  constructor(message, hint) {
    super(message);
    this.name = 'WingmanError';
    this.hint = hint;
  }
}

let quiet = false;
export function setQuiet(v) { quiet = !!v; }
export function isQuiet() { return quiet; }

export function info(msg) { if (!quiet) process.stderr.write(msg + '\n'); }
export function ok(msg) { if (!quiet) process.stderr.write(color.green('✓ ') + msg + '\n'); }
export function warn(msg) { if (!quiet) process.stderr.write(color.yellow('! ') + msg + '\n'); }
export function fail(msg) { process.stderr.write(color.red('✗ ') + msg + '\n'); }
export function step(msg) { if (!quiet) process.stderr.write(color.dim('  → ') + msg + '\n'); }

/**
 * Run a command without ever throwing. Returns {code, stdout, stderr, ok}.
 * Never inherits stdio, so nothing an agent runs can be polluted by our output.
 */
export function run(cmd, args = [], opts = {}) {
  const res = spawnSync(cmd, args, {
    encoding: 'utf8',
    cwd: opts.cwd,
    env: { ...process.env, ...(opts.env || {}) },
    input: opts.input,
    timeout: opts.timeout ?? 120000,
    maxBuffer: 32 * 1024 * 1024,
    windowsHide: true,
    shell: false,
  });
  return {
    code: res.status === null ? -1 : res.status,
    ok: res.status === 0,
    stdout: (res.stdout || '').toString(),
    stderr: (res.stderr || '').toString(),
    error: res.error,
  };
}

/** True when a binary is callable. Cached per process. */
const binCache = new Map();
export function hasBin(name) {
  if (binCache.has(name)) return binCache.get(name);
  const probe = process.platform === 'win32'
    ? run('where', [name])
    : run('sh', ['-c', `command -v ${JSON.stringify(name).slice(1, -1)}`]);
  const found = probe.ok && probe.stdout.trim().length > 0;
  binCache.set(name, found);
  return found;
}

export function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
  // Everything under ~/.wingman is private to this user.
  if (dir === WINGMAN_HOME || dir.startsWith(WINGMAN_HOME + path.sep)) {
    try { fs.chmodSync(WINGMAN_HOME, 0o700); } catch { /* windows */ }
  }
  return dir;
}

export function readJson(file, fallback = null) {
  try {
    const raw = fs.readFileSync(file, 'utf8');
    if (!raw.trim()) return fallback;
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

/** Atomic write: temp file in the same directory, then rename. */
export function writeFileAtomic(file, contents) {
  ensureDir(path.dirname(file));
  const tmp = file + '.tmp-' + process.pid + '-' + Date.now();
  fs.writeFileSync(tmp, contents, { mode: 0o600 });
  fs.renameSync(tmp, file);
}

export function writeJsonAtomic(file, obj) {
  writeFileAtomic(file, JSON.stringify(obj, null, 2) + '\n');
}

/** Backs a file up before we touch it. Returns the backup path, or null. */
export function backupFile(file) {
  if (!fs.existsSync(file)) return null;
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const dest = `${file}.wingman-backup-${stamp}`;
  fs.copyFileSync(file, dest);
  return dest;
}

export function slugify(s, max = 40) {
  return String(s)
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, max) || 'untitled';
}

/** Filesystem-safe UTC stamp, sortable lexicographically. */
export function stamp(date = new Date()) {
  return date.toISOString().replace(/\.\d+Z$/, 'Z').replace(/:/g, '-');
}

export function parseStamp(name) {
  const m = String(name).match(/^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})Z/);
  if (!m) return null;
  const d = new Date(`${m[1]}T${m[2]}:${m[3]}:${m[4]}Z`);
  return Number.isNaN(d.getTime()) ? null : d;
}

export function relativeTime(date, now = new Date()) {
  const secs = Math.round((now - date) / 1000);
  if (!Number.isFinite(secs)) return 'unknown';
  if (secs < 90) return 'just now';
  const mins = Math.round(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 36) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days < 45) return `${days}d ago`;
  return `${Math.round(days / 30)}mo ago`;
}

/**
 * Cross-process lock. Stale locks (dead PID, or older than ttl) are reclaimed
 * so a crashed run can never wedge the tool permanently.
 */
export function acquireLock({ ttlMs = 120000 } = {}) {
  ensureDir(WINGMAN_HOME);
  const mine = { pid: process.pid, at: Date.now() };
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = fs.openSync(LOCK_PATH, 'wx');
      fs.writeFileSync(fd, JSON.stringify(mine));
      fs.closeSync(fd);
      return () => { try { fs.unlinkSync(LOCK_PATH); } catch { /* already gone */ } };
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
      const held = readJson(LOCK_PATH, null);
      const expired = !held || (Date.now() - (held.at || 0)) > ttlMs || !pidAlive(held.pid);
      if (!expired) return null;
      try { fs.unlinkSync(LOCK_PATH); } catch { /* raced with the holder */ }
    }
  }
  return null;
}

function pidAlive(pid) {
  if (!pid || !Number.isInteger(pid)) return false;
  try { process.kill(pid, 0); return true; }
  catch (err) { return err.code === 'EPERM'; }
}

export function logLine(scope, message) {
  try {
    ensureDir(LOG_DIR);
    const file = path.join(LOG_DIR, `${new Date().toISOString().slice(0, 10)}.log`);
    fs.appendFileSync(file, `${new Date().toISOString()} [${scope}] ${message}\n`);
  } catch { /* logging must never break a command */ }
}

export function truncate(text, maxChars, note = '\n\n_[truncated by wingman]_\n') {
  if (text.length <= maxChars) return text;
  return text.slice(0, maxChars - note.length) + note;
}
