import fs from 'node:fs';
import path from 'node:path';
import { WINGMAN_HOME, ensureDir, writeFileAtomic, WingmanError } from './util.js';

/**
 * The vault holds things you want your agents to see on *this* machine but
 * never want replicated: credentials, internal URLs, client names.
 *
 * It lives outside the store directory on purpose. The store is a git repo that
 * gets pushed; the vault is a sibling folder that git has never heard of. There
 * is no flag that can accidentally sync it, because no code path ever adds it
 * to a commit. That is a stronger guarantee than a .gitignore entry.
 *
 * Vault content is deliberately NOT redacted — holding secrets is its job.
 */
export const VAULT_DIR = path.join(WINGMAN_HOME, 'vault');

export function vaultFile(projectId) {
  if (!projectId) throw new WingmanError('No project selected.');
  return path.join(VAULT_DIR, `${projectId}.md`);
}

export function readVault(projectId) {
  try {
    const text = fs.readFileSync(vaultFile(projectId), 'utf8');
    return text.trim();
  } catch {
    return '';
  }
}

export function writeVault(projectId, text) {
  const file = vaultFile(projectId);
  ensureDir(VAULT_DIR);
  try { fs.chmodSync(VAULT_DIR, 0o700); } catch { /* windows */ }
  writeFileAtomic(file, String(text).trim() + '\n');
  try { fs.chmodSync(file, 0o600); } catch { /* windows */ }
  return file;
}

export function clearVault(projectId) {
  const file = vaultFile(projectId);
  try { fs.rmSync(file, { force: true }); return true; } catch { return false; }
}

export function hasVault(projectId) {
  return readVault(projectId).length > 0;
}

/**
 * Safety net: assert nothing under the vault ever ends up inside the store.
 * Called by `wingman doctor`.
 */
export function vaultIsOutsideStore(storeDir) {
  const v = path.resolve(VAULT_DIR);
  const s = path.resolve(storeDir);
  return !v.startsWith(s + path.sep) && v !== s;
}
