import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  HOME, ensureDir, readJson, writeJsonAtomic, writeFileAtomic, backupFile, run,
} from '../util.js';
import { runtimePaths } from '../runtime.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** Where the CLI lives right now (may be an npx cache: not safe to hardcode). */
export const CLI_ENTRY = path.resolve(HERE, '..', '..', 'bin', 'wingman.mjs');

/**
 * Absolute command pointing at the vendored runtime, so hooks never depend on
 * PATH, on npx, on the network, or on a cache directory that npm may delete.
 */
export function hookCommand(args) {
  const node = process.execPath;
  return `${quote(node)} ${quote(runtimePaths().entry)} ${args}`;
}

function quote(s) {
  return /[\s"']/.test(s) ? `"${s.replace(/"/g, '\\"')}"` : s;
}

const MARK_START = '<!-- wingman:start -->';
const MARK_END = '<!-- wingman:end -->';

export const INSTRUCTIONS = `${MARK_START}
## Wingman — shared context across tools and machines

This project uses Wingman to carry context between AI tools and computers.

**At the start of a task**, if you have not already been given a Wingman context
block, run:

\`\`\`
${'`'}wingman load${'`'}
\`\`\`

Read the output before doing anything else. It is established history: do not
redo work described there, and do not retry anything listed as a dead end.

**When the user says they are running low on context, switching tools, or
stopping** — and before any compaction — write a handoff:

\`\`\`
wingman save --agent <your-tool-name> --title "<short summary>" --stdin
\`\`\`

Pipe a Markdown body to stdin using exactly these sections:

    ## Goal
    ## Current state          (branch, last commit, what passes, what fails)
    ## Decisions made         (and why)
    ## Dead ends              (tried, did not work, do not retry)
    ## Files touched
    ## Next concrete step     (specific enough to start immediately)

Write **state, not transcript**. Aim for 200-400 words. The code is already on
disk; what is lost between tools is the reasoning, not the diff.

Never put API keys, tokens, or passwords in a handoff. Wingman redacts what it
recognises, but do not rely on it.
${MARK_END}`;

/** Idempotent insert/replace of the Wingman block in a Markdown instructions file. */
export function upsertInstructions(file) {
  ensureDir(path.dirname(file));
  const existing = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  if (existing.includes(MARK_START)) {
    const start = existing.indexOf(MARK_START);
    const endIdx = existing.indexOf(MARK_END);
    if (endIdx > start) {
      const next = existing.slice(0, start) + INSTRUCTIONS + existing.slice(endIdx + MARK_END.length);
      if (next === existing) return { file, changed: false };
      backupFile(file);
      writeFileAtomic(file, next);
      return { file, changed: true, updated: true };
    }
  }
  if (existing) backupFile(file);
  const sep = existing && !existing.endsWith('\n\n') ? (existing.endsWith('\n') ? '\n' : '\n\n') : '';
  writeFileAtomic(file, existing + sep + INSTRUCTIONS + '\n');
  return { file, changed: true, created: !existing };
}

export function removeInstructions(file) {
  if (!fs.existsSync(file)) return { file, changed: false };
  const existing = fs.readFileSync(file, 'utf8');
  const start = existing.indexOf(MARK_START);
  const endIdx = existing.indexOf(MARK_END);
  if (start === -1 || endIdx < start) return { file, changed: false };
  backupFile(file);
  const next = (existing.slice(0, start) + existing.slice(endIdx + MARK_END.length)).replace(/\n{3,}/g, '\n\n').trimStart();
  writeFileAtomic(file, next);
  return { file, changed: true };
}

/* ------------------------------------------------------------------ *
 * Claude Code
 * ------------------------------------------------------------------ */

const claudeCode = {
  id: 'claude-code',
  label: 'Claude Code',
  detect() {
    return fs.existsSync(path.join(HOME, '.claude')) || !!run('claude', ['--version'], { timeout: 8000 }).ok;
  },
  install() {
    const settingsFile = path.join(HOME, '.claude', 'settings.json');
    ensureDir(path.dirname(settingsFile));
    const settings = readJson(settingsFile, {}) || {};
    if (typeof settings !== 'object' || Array.isArray(settings)) {
      return { ok: false, reason: 'settings.json is not a JSON object; left untouched.' };
    }

    const backup = backupFile(settingsFile);
    settings.hooks = settings.hooks && typeof settings.hooks === 'object' ? settings.hooks : {};

    addHook(settings.hooks, 'SessionStart', hookCommand('load --agent claude-code --hook --quiet'));
    addHook(settings.hooks, 'SessionEnd', hookCommand('autosave --agent claude-code --hook --quiet'));
    addHook(settings.hooks, 'PreCompact', hookCommand('autosave --agent claude-code --hook --quiet --reason compact'));
    addHook(settings.hooks, 'Stop', hookCommand('autosave --agent claude-code --hook --quiet --rolling'));

    try {
      JSON.parse(JSON.stringify(settings));
      writeJsonAtomic(settingsFile, settings);
    } catch (err) {
      return { ok: false, reason: `refused to write invalid settings.json: ${err.message}`, backup };
    }

    const memo = upsertInstructions(path.join(HOME, '.claude', 'CLAUDE.md'));
    return { ok: true, files: [settingsFile, memo.file].filter(Boolean), backup, automatic: true };
  },
  uninstall() {
    const settingsFile = path.join(HOME, '.claude', 'settings.json');
    const settings = readJson(settingsFile, null);
    if (settings?.hooks) {
      backupFile(settingsFile);
      for (const evt of Object.keys(settings.hooks)) removeHook(settings.hooks, evt);
      writeJsonAtomic(settingsFile, settings);
    }
    removeInstructions(path.join(HOME, '.claude', 'CLAUDE.md'));
    return { ok: true };
  },
};

function addHook(hooks, event, command, { matcher, name = 'wingman' } = {}) {
  if (!Array.isArray(hooks[event])) hooks[event] = [];
  hooks[event] = hooks[event].filter((g) => !isWingmanGroup(g));
  const inner = { name, type: 'command', command, timeout: 30 };
  const group = matcher === undefined ? { hooks: [inner] } : { matcher, hooks: [inner] };
  hooks[event].push(group);
}

function removeHook(hooks, event) {
  if (!Array.isArray(hooks[event])) return;
  hooks[event] = hooks[event].filter((g) => !isWingmanGroup(g));
  if (!hooks[event].length) delete hooks[event];
}

function isWingmanGroup(group) {
  const inner = group && Array.isArray(group.hooks) ? group.hooks : [];
  return inner.some((h) => typeof h?.command === 'string' && /wingman\.mjs/.test(h.command));
}

/* ------------------------------------------------------------------ *
 * Codex / ChatGPT CLI
 *
 * Hooks live in ~/.codex/hooks.json, which takes the same shape as Claude
 * Code's. We deliberately do NOT touch config.toml: it also holds credentials
 * and provider settings, and a malformed write there would break far more than
 * Wingman. hooks.json is a dedicated file we can own safely.
 * ------------------------------------------------------------------ */

const codex = {
  id: 'codex',
  label: 'Codex / ChatGPT CLI',
  detect() {
    return fs.existsSync(path.join(HOME, '.codex')) || !!run('codex', ['--version'], { timeout: 8000 }).ok;
  },
  install() {
    const dir = path.join(HOME, '.codex');
    ensureDir(dir);
    const hooksFile = path.join(dir, 'hooks.json');

    const current = readJson(hooksFile, {}) || {};
    if (typeof current !== 'object' || Array.isArray(current)) {
      return { ok: false, reason: 'hooks.json is not a JSON object; left untouched.' };
    }
    const backup = backupFile(hooksFile);
    current.hooks = current.hooks && typeof current.hooks === 'object' ? current.hooks : {};

    addHook(current.hooks, 'SessionStart', hookCommand('load --agent codex --hook --quiet --emit json'), { matcher: '*' });
    addHook(current.hooks, 'Stop', hookCommand('autosave --agent codex --hook --quiet --rolling --emit json'), { matcher: '*' });
    addHook(current.hooks, 'PreCompact', hookCommand('autosave --agent codex --hook --quiet --reason compact --emit json'), { matcher: '*' });

    try {
      JSON.parse(JSON.stringify(current));
      writeJsonAtomic(hooksFile, current);
    } catch (err) {
      return { ok: false, reason: `refused to write invalid hooks.json: ${err.message}`, backup };
    }

    const memo = upsertInstructions(path.join(dir, 'AGENTS.md'));
    return { ok: true, files: [hooksFile, memo.file].filter(Boolean), backup, automatic: true };
  },
  uninstall() {
    const hooksFile = path.join(HOME, '.codex', 'hooks.json');
    const current = readJson(hooksFile, null);
    if (current?.hooks) {
      backupFile(hooksFile);
      for (const evt of Object.keys(current.hooks)) removeHook(current.hooks, evt);
      writeJsonAtomic(hooksFile, current);
    }
    removeInstructions(path.join(HOME, '.codex', 'AGENTS.md'));
    return { ok: true };
  },
};

/* ------------------------------------------------------------------ *
 * Gemini CLI
 * ------------------------------------------------------------------ */

const geminiCli = {
  id: 'gemini-cli',
  label: 'Gemini CLI',
  detect() {
    return fs.existsSync(path.join(HOME, '.gemini')) || !!run('gemini', ['--version'], { timeout: 8000 }).ok;
  },
  install() {
    /*
     * Gemini CLI is strict: a hook must print valid JSON on stdout and nothing
     * else — a single stray character breaks parsing. Our hooks print '{}' and
     * deliver context by refreshing the file GEMINI.md imports, so there is
     * nothing to misparse.
     *
     * SessionStart is unreliable on some 0.24.x builds, so BeforeAgent is wired
     * as well. Both are idempotent and cheap, so firing twice is harmless.
     */
    const settingsFile = path.join(HOME, '.gemini', 'settings.json');
    ensureDir(path.dirname(settingsFile));
    const settings = readJson(settingsFile, {}) || {};
    if (typeof settings === 'object' && !Array.isArray(settings)) {
      backupFile(settingsFile);
      settings.hooks = settings.hooks && typeof settings.hooks === 'object' ? settings.hooks : {};
      addHook(settings.hooks, 'SessionStart', hookCommand('load --agent gemini-cli --hook --quiet --emit json'), { matcher: 'startup' });
      addHook(settings.hooks, 'BeforeAgent', hookCommand('load --agent gemini-cli --hook --quiet --no-sync --emit json'), { matcher: '*' });
      addHook(settings.hooks, 'SessionEnd', hookCommand('autosave --agent gemini-cli --hook --quiet --emit json'), { matcher: '*' });
      try {
        JSON.parse(JSON.stringify(settings));
        writeJsonAtomic(settingsFile, settings);
      } catch { /* leave the user's settings alone rather than write garbage */ }
    }

    const extDir = path.join(HOME, '.gemini', 'extensions', 'wingman');
    const cmdDir = path.join(extDir, 'commands', 'wingman');
    ensureDir(cmdDir);

    writeJsonAtomic(path.join(extDir, 'gemini-extension.json'), {
      name: 'wingman',
      version: '1.0.0',
      description: 'Shared AI context across tools and machines',
      contextFileName: 'GEMINI.md',
    });

    writeFileAtomic(path.join(extDir, 'GEMINI.md'), INSTRUCTIONS + '\n');

    writeFileAtomic(path.join(cmdDir, 'load.toml'),
      'description = "Load Wingman context for this project"\n'
      + `prompt = """\nRun this shell command and read the output carefully before doing anything else:\n\n!{${shellFor('load --agent gemini-cli')}}\n\nTreat it as established history. Do not redo work it describes, and do not retry anything it lists as a dead end.\n"""\n`);

    writeFileAtomic(path.join(cmdDir, 'save.toml'),
      'description = "Save a Wingman handoff for the next tool or machine"\n'
      + `prompt = """\nWrite a handoff for whoever picks this project up next, using exactly these sections: Goal, Current state, Decisions made, Dead ends, Files touched, Next concrete step. Write state, not transcript: 200-400 words. Never include keys or tokens.\n\nThen save it by piping that Markdown to:\n\n${shellFor('save --agent gemini-cli --stdin --title "<short summary>"')}\n"""\n`);

    return { ok: true, files: [settingsFile, extDir], automatic: true };
  },
  uninstall() {
    const settingsFile = path.join(HOME, '.gemini', 'settings.json');
    const settings = readJson(settingsFile, null);
    if (settings?.hooks) {
      backupFile(settingsFile);
      for (const evt of Object.keys(settings.hooks)) removeHook(settings.hooks, evt);
      writeJsonAtomic(settingsFile, settings);
    }
    const extDir = path.join(HOME, '.gemini', 'extensions', 'wingman');
    try { fs.rmSync(extDir, { recursive: true, force: true }); } catch { /* nothing to remove */ }
    return { ok: true };
  },
};

function shellFor(args) {
  return hookCommand(args);
}

/* ------------------------------------------------------------------ *
 * Cursor  (project-scoped rule + MCP entry)
 * ------------------------------------------------------------------ */

const cursor = {
  id: 'cursor',
  label: 'Cursor',
  detect() {
    return fs.existsSync(path.join(HOME, '.cursor'))
      || fs.existsSync(path.join(HOME, 'Library', 'Application Support', 'Cursor'));
  },
  install({ projectRoot } = {}) {
    const files = [];

    const mcpFile = path.join(HOME, '.cursor', 'mcp.json');
    ensureDir(path.dirname(mcpFile));
    const mcp = readJson(mcpFile, {}) || {};
    if (typeof mcp === 'object' && !Array.isArray(mcp)) {
      backupFile(mcpFile);
      mcp.mcpServers = mcp.mcpServers && typeof mcp.mcpServers === 'object' ? mcp.mcpServers : {};
      mcp.mcpServers.wingman = {
        command: process.execPath,
        args: [runtimePaths().mcp],
      };
      writeJsonAtomic(mcpFile, mcp);
      files.push(mcpFile);
    }

    if (projectRoot) {
      /*
       * alwaysApply means Cursor injects this on every request with no action
       * from the user, which is as automatic as Cursor gets. The rule points at
       * the generated context file rather than embedding context, so it stays
       * current without Cursor having to re-read anything.
       */
      const ruleFile = path.join(projectRoot, '.cursor', 'rules', 'wingman.mdc');
      ensureDir(path.dirname(ruleFile));
      writeFileAtomic(ruleFile,
        '---\ndescription: Shared AI context across tools and machines\nalwaysApply: true\n---\n\n'
        + '## Project context (Wingman)\n\n'
        + 'Read `.wingman/CONTEXT.md` before doing anything else. It holds what previous\n'
        + 'sessions decided, what was already tried and failed, and the next concrete step.\n'
        + 'Treat it as established history: do not redo work described there, and do not\n'
        + 'retry anything listed as a dead end. If the file is missing or empty, there is\n'
        + 'no prior context and you can start normally.\n\n'
        + INSTRUCTIONS + '\n');
      files.push(ruleFile);
    }

    return { ok: true, files, automatic: true };
  },
  uninstall({ projectRoot } = {}) {
    const mcpFile = path.join(HOME, '.cursor', 'mcp.json');
    const mcp = readJson(mcpFile, null);
    if (mcp?.mcpServers?.wingman) {
      backupFile(mcpFile);
      delete mcp.mcpServers.wingman;
      writeJsonAtomic(mcpFile, mcp);
    }
    if (projectRoot) {
      try { fs.rmSync(path.join(projectRoot, '.cursor', 'rules', 'wingman.mdc'), { force: true }); } catch { /* absent */ }
    }
    return { ok: true };
  },
};

export const ADAPTERS = [claudeCode, codex, geminiCli, cursor];

export function detectAgents() {
  return ADAPTERS.map((a) => ({ id: a.id, label: a.label, present: safeDetect(a) }));
}

function safeDetect(adapter) {
  try { return !!adapter.detect(); } catch { return false; }
}

export function getAdapter(id) {
  return ADAPTERS.find((a) => a.id === id) || null;
}
