import fs from 'node:fs';
import path from 'node:path';
import {
  ensureDir, writeFileAtomic, stamp, parseStamp, slugify, truncate, WingmanError,
} from './util.js';
import { redact } from './redact.js';
import { journalDir, listEntryFiles, deviceKey } from './store.js';

const FM_OPEN = '---';

/** Minimal, dependency-free front matter. Values are plain strings only. */
export function serializeEntry(meta, body) {
  const lines = [FM_OPEN];
  for (const [k, v] of Object.entries(meta)) {
    if (v === undefined || v === null || v === '') continue;
    lines.push(`${k}: ${String(v).replace(/\r?\n/g, ' ').trim()}`);
  }
  lines.push(FM_OPEN, '');
  return lines.join('\n') + body.trimStart() + (body.endsWith('\n') ? '' : '\n');
}

export function parseEntry(raw) {
  const text = String(raw).replace(/^\uFEFF/, '');
  if (!text.startsWith(FM_OPEN)) return { meta: {}, body: text };
  const end = text.indexOf(`\n${FM_OPEN}`, FM_OPEN.length);
  if (end === -1) return { meta: {}, body: text };
  const head = text.slice(FM_OPEN.length, end);
  const body = text.slice(end + FM_OPEN.length + 1).replace(/^\r?\n/, '');
  const meta = {};
  for (const line of head.split('\n')) {
    const m = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (m) meta[m[1]] = m[2].trim();
  }
  return { meta, body };
}

/**
 * Append one entry. Filename is `<utc-stamp>--<agent>.md`, unique per device,
 * with a numeric suffix on the astronomically unlikely same-second collision.
 */
export function writeEntry({ projectId, deviceId, agent = 'manual', title = '', body, pinned = false, maxChars = 24000 }) {
  if (!projectId) throw new WingmanError('No project selected.');
  if (!body || !String(body).trim()) throw new WingmanError('Refusing to save an empty entry.');

  const { text: safeBody, findings } = redact(String(body));
  const clipped = truncate(safeBody.trim(), maxChars);

  const dir = ensureDir(journalDir(projectId, deviceKey(deviceId)));
  const agentSlug = slugify(agent, 24) || 'manual';
  const base = `${stamp()}--${agentSlug}`;
  let file = path.join(dir, `${base}.md`);
  let n = 1;
  while (fs.existsSync(file)) file = path.join(dir, `${base}-${n++}.md`);

  const contents = serializeEntry({
    agent: agentSlug,
    device: deviceId,
    project: projectId,
    at: new Date().toISOString(),
    title: title || '',
    pinned: pinned ? 'true' : '',
  }, clipped);

  writeFileAtomic(file, contents);
  // 600, not 644: on a shared machine no other account should be able to read
  // your context. Git only records the executable bit, so this is safe to commit.
  try { fs.chmodSync(file, 0o600); } catch { /* windows */ }

  return { file, findings, bytes: Buffer.byteLength(contents), name: path.basename(file) };
}

/** Read entries oldest-first, with parsed metadata. */
export function readEntries(projectId, { limit = 0 } = {}) {
  const files = listEntryFiles(projectId);
  const chosen = limit > 0 ? files.slice(-limit) : files;
  const out = [];
  for (const f of chosen) {
    let raw;
    try { raw = fs.readFileSync(f.file, 'utf8'); } catch { continue; }
    const { meta, body } = parseEntry(raw);
    const at = meta.at ? new Date(meta.at) : parseStamp(f.name);
    out.push({
      file: f.file,
      name: f.name,
      device: meta.device || f.device,
      agent: meta.agent || 'unknown',
      title: meta.title || '',
      pinned: meta.pinned === 'true',
      at: at && !Number.isNaN(at.getTime()) ? at : new Date(0),
      body: body.trim(),
    });
  }
  return out.sort((a, b) => a.at - b.at);
}

export function pinnedEntries(projectId) {
  return readEntries(projectId).filter((e) => e.pinned);
}
