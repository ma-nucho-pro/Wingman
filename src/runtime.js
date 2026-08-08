import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WINGMAN_HOME, ensureDir, readJson, writeJsonAtomic, logLine } from './util.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const PACKAGE_ROOT = path.resolve(HERE, '..');
export const RUNTIME_DIR = path.join(WINGMAN_HOME, 'runtime');
export const RUNTIME_ENTRY = path.join(RUNTIME_DIR, 'bin', 'wingman.mjs');
export const RUNTIME_MCP = path.join(RUNTIME_DIR, 'mcp', 'server.mjs');

const COPY = ['bin', 'src', 'mcp', 'package.json'];

/**
 * Hooks must point at a path that still exists next week.
 *
 * When Wingman is run through `npx`, the package lives in a cache directory
 * that npm is free to delete at any time. A hook wired to that path would fail
 * silently forever afterwards. So we copy the runtime into ~/.wingman/runtime
 * and wire every hook, extension and MCP entry to that stable location instead.
 */
export function installRuntime({ force = false } = {}) {
  const selfVersion = readJson(path.join(PACKAGE_ROOT, 'package.json'), {})?.version || '0.0.0';

  // Already running from the vendored copy: nothing to do.
  if (path.resolve(PACKAGE_ROOT) === path.resolve(RUNTIME_DIR)) {
    return { entry: RUNTIME_ENTRY, mcp: RUNTIME_MCP, version: selfVersion, skipped: true };
  }

  const installedVersion = readJson(path.join(RUNTIME_DIR, 'package.json'), {})?.version || null;
  if (!force && installedVersion === selfVersion && fs.existsSync(RUNTIME_ENTRY)) {
    return { entry: RUNTIME_ENTRY, mcp: RUNTIME_MCP, version: selfVersion, upToDate: true };
  }

  const staging = RUNTIME_DIR + '.new-' + process.pid;
  try {
    fs.rmSync(staging, { recursive: true, force: true });
    ensureDir(staging);
    for (const item of COPY) {
      const from = path.join(PACKAGE_ROOT, item);
      if (!fs.existsSync(from)) continue;
      fs.cpSync(from, path.join(staging, item), { recursive: true, force: true });
    }
    writeJsonAtomic(path.join(staging, 'INSTALLED.json'), {
      version: selfVersion,
      installedAt: new Date().toISOString(),
      copiedFrom: PACKAGE_ROOT,
    });

    const previous = RUNTIME_DIR + '.old-' + process.pid;
    if (fs.existsSync(RUNTIME_DIR)) fs.renameSync(RUNTIME_DIR, previous);
    fs.renameSync(staging, RUNTIME_DIR);
    fs.rmSync(previous, { recursive: true, force: true });

    try { fs.chmodSync(RUNTIME_ENTRY, 0o755); } catch { /* windows */ }
    try { fs.chmodSync(RUNTIME_MCP, 0o755); } catch { /* windows */ }

    return { entry: RUNTIME_ENTRY, mcp: RUNTIME_MCP, version: selfVersion, installed: true };
  } catch (err) {
    logLine('runtime', `install failed: ${err.stack || err.message}`);
    fs.rmSync(staging, { recursive: true, force: true });
    // Fall back to wherever we are running from: worse, but still functional.
    return {
      entry: path.join(PACKAGE_ROOT, 'bin', 'wingman.mjs'),
      mcp: path.join(PACKAGE_ROOT, 'mcp', 'server.mjs'),
      version: selfVersion,
      failed: true,
      reason: err.message,
    };
  }
}

/** Where hooks should point today, whether or not the runtime is vendored. */
export function runtimePaths() {
  if (fs.existsSync(RUNTIME_ENTRY)) return { entry: RUNTIME_ENTRY, mcp: RUNTIME_MCP };
  return {
    entry: path.join(PACKAGE_ROOT, 'bin', 'wingman.mjs'),
    mcp: path.join(PACKAGE_ROOT, 'mcp', 'server.mjs'),
  };
}
