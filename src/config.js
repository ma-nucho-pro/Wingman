import fs from 'node:fs';
import path from 'node:path';
import {
  CONFIG_PATH, WINGMAN_HOME, STORE_DIR,
  readJson, writeJsonAtomic, ensureDir,
} from './util.js';
import { defaultDeviceId } from './identity.js';

const DEFAULTS = {
  version: 1,
  deviceId: null,
  storeRepo: null,       // owner/name on GitHub, null while local-only
  storeRemote: null,     // full URL actually used by git
  syncEnabled: false,
  authMethod: 'none',    // gh | https | ssh | none
  encrypt: false,
  autoPush: true,
  maxEntryChars: 24000,
  rollingMinutes: 20,
  createdAt: null,
};

export function loadConfig() {
  const raw = readJson(CONFIG_PATH, null);
  const cfg = { ...DEFAULTS, ...(raw || {}) };
  if (!cfg.deviceId) cfg.deviceId = process.env.WINGMAN_DEVICE_ID || defaultDeviceId();
  if (process.env.WINGMAN_STORE_REPO) cfg.storeRepo = process.env.WINGMAN_STORE_REPO;
  return cfg;
}

export function saveConfig(cfg) {
  ensureDir(WINGMAN_HOME);
  const next = { ...cfg };
  if (!next.createdAt) next.createdAt = new Date().toISOString();
  writeJsonAtomic(CONFIG_PATH, next);
  try { fs.chmodSync(CONFIG_PATH, 0o600); } catch { /* windows */ }
  return next;
}

export function configExists() {
  return fs.existsSync(CONFIG_PATH);
}

export function storeExists() {
  return fs.existsSync(path.join(STORE_DIR, '.git')) || fs.existsSync(path.join(STORE_DIR, 'projects'));
}

export { DEFAULTS };
