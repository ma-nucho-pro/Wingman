import fs from 'node:fs';
import os from 'node:os';
import crypto from 'node:crypto';
import path from 'node:path';
import {
  STORE_DIR, ensureDir, writeFileAtomic, writeJsonAtomic, readJson,
  acquireLock, logLine,
} from './util.js';
import * as G from './git.js';

/**
 * Store layout — every mutable path is owned by exactly one device, which is
 * what makes concurrent use across machines conflict-free by construction.
 *
 *   projects/<project-id>/meta.json                 written once, then read-only
 *   projects/<project-id>/journal/<device>/<ts>--<agent>.md
 *   devices/<device-id>.json
 *   README.md
 */
export function storeDir() {
  return STORE_DIR;
}

export function projectDir(projectId) {
  return path.join(STORE_DIR, 'projects', projectId);
}

/**
 * Storage key for this machine: the human name plus a short fingerprint.
 *
 * The whole conflict-free design rests on no two machines ever writing to the
 * same path. A human name alone cannot guarantee that — two people, or one
 * person twice, will eventually type "laptop". Appending the fingerprint makes
 * collision impossible by construction, so there is no rename logic, no
 * tiebreak, and no migration to get wrong. The friendly name is what gets
 * displayed; the key is only ever a folder name.
 */
export function deviceKey(deviceId) {
  return `${deviceId}--${machineFingerprint().slice(0, 4)}`;
}

export function journalDir(projectId, deviceKeyOrId) {
  return path.join(projectDir(projectId), 'journal', deviceKeyOrId);
}

export function deviceFile(key) {
  return path.join(STORE_DIR, 'devices', `${key}.json`);
}

export function ensureStore() {
  ensureDir(STORE_DIR);
  if (!G.isRepo(STORE_DIR)) G.initRepo(STORE_DIR);
  const readme = path.join(STORE_DIR, 'README.md');
  if (!fs.existsSync(readme)) {
    writeFileAtomic(readme, STORE_README);
  }
  const attrs = path.join(STORE_DIR, '.gitattributes');
  if (!fs.existsSync(attrs)) {
    writeFileAtomic(attrs, '* -text\n*.md diff\n');
  }
  return STORE_DIR;
}

/**
 * A stable, non-identifying fingerprint for this machine. Used only to notice
 * when two different computers were given the same device name.
 */
export function machineFingerprint() {
  const seed = [os.hostname(), os.platform(), os.arch(), os.homedir(), os.userInfo().username].join('|');
  return crypto.createHash('sha256').update(seed).digest('hex').slice(0, 16);
}

/**
 * Two machines sharing a device id would write into the same journal folder,
 * which is the one thing that could produce a real git conflict. If the name is
 * already claimed by a different machine we pick the next free suffix.
 */
/** True when another machine already displays under this name. Informational only. */
export function nameSharedWithAnotherMachine(deviceId) {
  const mine = deviceKey(deviceId);
  return listDevices().some((d) => d.deviceId === deviceId && d.key !== mine);
}

export function registerDevice(deviceId, extra = {}) {
  const key = deviceKey(deviceId);
  const file = deviceFile(key);
  const existing = readJson(file, null);
  const record = {
    deviceId,
    key,
    platform: process.platform,
    fingerprint: machineFingerprint(),
    firstSeen: existing?.firstSeen || new Date().toISOString(),
    lastSeen: new Date().toISOString(),
    ...extra,
  };
  writeJsonAtomic(file, record);
  return record;
}

export function listDevices() {
  const dir = path.join(STORE_DIR, 'devices');
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .map((f) => {
      const rec = readJson(path.join(dir, f), null);
      if (!rec) return null;
      return { ...rec, key: rec.key || f.replace(/\.json$/, '') };
    })
    .filter(Boolean)
    .sort((a, b) => String(b.lastSeen).localeCompare(String(a.lastSeen)));
}

export function saveProjectMeta(project) {
  const file = path.join(projectDir(project.id), 'meta.json');
  const existing = readJson(file, null);
  if (existing && existing.id === project.id && existing.name === project.name) return existing;
  const record = {
    id: project.id,
    name: project.name,
    remote: project.remote || existing?.remote || null,
    createdAt: existing?.createdAt || new Date().toISOString(),
  };
  writeJsonAtomic(file, record);
  return record;
}

export function listProjects() {
  const dir = path.join(STORE_DIR, 'projects');
  if (!fs.existsSync(dir)) return [];
  const out = [];
  for (const id of fs.readdirSync(dir)) {
    const meta = readJson(path.join(dir, id, 'meta.json'), null);
    if (!meta) continue;
    out.push({ ...meta, entryCount: countEntries(id), lastEntryAt: lastEntryDate(id) });
  }
  return out.sort((a, b) => String(b.lastEntryAt || '').localeCompare(String(a.lastEntryAt || '')));
}

export function findProjectById(idOrName) {
  const projects = listProjects();
  return projects.find((p) => p.id === idOrName)
    || projects.find((p) => p.name === idOrName)
    || projects.find((p) => p.id.startsWith(idOrName))
    || null;
}

function countEntries(projectId) {
  return listEntryFiles(projectId).length;
}

function lastEntryDate(projectId) {
  const files = listEntryFiles(projectId);
  if (!files.length) return null;
  return files[files.length - 1].name.slice(0, 20);
}

/** All journal files across every device, sorted oldest first by timestamp. */
export function listEntryFiles(projectId) {
  const base = path.join(projectDir(projectId), 'journal');
  if (!fs.existsSync(base)) return [];
  const out = [];
  for (const key of fs.readdirSync(base)) {
    const dir = path.join(base, key);
    let stat;
    try { stat = fs.statSync(dir); } catch { continue; }
    if (!stat.isDirectory()) continue;
    const display = key.replace(/--[0-9a-f]{4}$/, '');
    for (const name of fs.readdirSync(dir)) {
      if (!name.endsWith('.md')) continue;
      out.push({ device: display, key, name, file: path.join(dir, name) });
    }
  }
  return out.sort((a, b) => (a.name === b.name ? a.device.localeCompare(b.device) : a.name.localeCompare(b.name)));
}

/**
 * Sync wrapper. Every failure is non-fatal: the caller keeps working locally
 * and we retry on the next command. Nothing here may ever throw into a hook.
 */
export function sync(cfg, { pull = true, push = true, message } = {}) {
  const result = { pulled: false, pushed: false, committed: false, offline: false, notes: [] };
  if (!fs.existsSync(STORE_DIR)) return result;

  const release = acquireLock();
  if (!release) {
    result.notes.push('another wingman process is syncing; skipped');
    return result;
  }

  try {
    if (pull && cfg.syncEnabled) {
      const r = G.pull(STORE_DIR);
      result.pulled = !!r.ok && !r.skipped;
      if (!r.ok) {
        result.offline = !!r.offline;
        result.notes.push(r.conflict ? `merge conflict: ${r.reason}` : `pull failed: ${r.reason || 'unknown'}`);
      }
    }

    if (G.isDirty(STORE_DIR)) {
      const c = G.commit(STORE_DIR, message || `wingman: update ${new Date().toISOString()}`);
      result.committed = !!c.ok && !c.skipped;
      if (!c.ok) result.notes.push(`commit failed: ${c.reason}`);
    }

    if (push && cfg.syncEnabled) {
      const p = G.push(STORE_DIR, { setUpstream: true });
      result.pushed = !!p.ok && !p.skipped;
      if (!p.ok) {
        result.offline = result.offline || !!p.offline;
        result.notes.push(`push failed: ${p.reason || 'unknown'}`);
      }
    }
  } catch (err) {
    result.notes.push(`sync error: ${err.message}`);
    logLine('sync', err.stack || err.message);
  } finally {
    release();
  }

  for (const n of result.notes) logLine('sync', n);
  return result;
}

const STORE_README = `# wingman-memory

Private context store for [Wingman](https://github.com/ma-nucho-pro/Wingman).

Everything here is plain Markdown you can read, grep, and edit — including from
your phone via the GitHub web UI.

    projects/<project-id>/meta.json       what this project is
    projects/<project-id>/journal/        one folder per machine
    devices/<device-id>.json              machines that use this store

**Each machine writes only inside its own journal folder.** Filenames are
timestamped and unique, so two machines can push at the same time and git never
has to merge anything.

To read your context on a phone: open \`projects/\`, pick your project, open the
newest file under \`journal/\`, copy it into any AI chat.

Delete anything you do not want kept. Wingman will not put it back.
`;

export { STORE_README };
