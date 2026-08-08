import fs from 'node:fs';
import path from 'node:path';
import {
  run, hasBin, info, ok, warn, step, color, logLine, WingmanError, setQuiet,
} from '../util.js';
import { loadConfig } from '../config.js';
import { resolveProject, isValidProjectId } from '../identity.js';
import { ensureStore, saveProjectMeta, registerDevice, sync, findProjectById } from '../store.js';
import { writeEntry, readEntries } from '../journal.js';
import { readVault, writeVault, clearVault } from '../vault.js';
import { renderContext, extractProjectTag, HANDOFF_TEMPLATE } from '../render.js';
import { refreshContextFile } from '../context-file.js';

/**
 * Work out which project a command applies to.
 *  --project flag  >  wingman: tag in the text  >  current directory  >  error
 */
export function pickProject({ project: flag, text, cwd = process.cwd(), allowUnknown = false } = {}) {
  if (flag) {
    const found = findProjectById(flag);
    if (found) return { ...found, source: 'flag' };
    if (isValidProjectId(flag)) return { id: flag, name: flag.split('-').slice(1).join('-'), remote: null, root: cwd, source: 'flag' };
    throw new WingmanError(`No project matches "${flag}".`, 'Run  wingman projects  to see what exists.');
  }

  if (text) {
    const tagged = extractProjectTag(text);
    if (tagged) {
      const found = findProjectById(tagged);
      if (found) return { ...found, source: 'tag' };
      return { id: tagged, name: tagged.split('-').slice(1).join('-'), remote: null, root: cwd, source: 'tag' };
    }
  }

  const local = resolveProject(cwd);
  if (local.id) return local;

  if (allowUnknown) return local;

  throw new WingmanError(
    `This folder is not a Wingman project yet.`,
    `Run  wingman init  here, or pass  --project <name>.  See  wingman projects  for the list.`,
  );
}

/* ---------------------------------------------------------------- load --- */

export async function cmdLoad(args) {
  const cfg = loadConfig();
  const isHook = !!args.hook;
  if (args.quiet || isHook) setQuiet(true);

  let project;
  try {
    project = pickProject({ project: args.project });
  } catch (err) {
    if (isHook) return 0;             // never disturb an agent session
    throw err;
  }

  if (cfg.syncEnabled && !args['no-sync']) {
    sync(cfg, { pull: true, push: false });
  }

  /*
   * Hook mode delivers context by refreshing the file each agent already loads,
   * and prints nothing at all.
   *
   * Printing is the trap here: Claude Code injects raw stdout, Gemini CLI
   * rejects any stdout that is not strict JSON, and Codex expects its own
   * envelope. Those formats also drift between releases. Silence is the only
   * output no parser can reject, so the file becomes the delivery channel and
   * the hook becomes unbreakable.
   */
  if (isHook) {
    refreshContextFile(project, {
      recent: toInt(args.recent, 6),
      maxChars: toInt(args['max-chars'], 16000),
    });
    if (args.emit === 'json') process.stdout.write('{}\n');
    return 0;
  }

  const rendered = renderContext(project, {
    recent: toInt(args.recent, 6),
    maxChars: toInt(args['max-chars'], 16000),
  });
  refreshContextFile(project);

  if (rendered.empty) {
    info(color.dim(`No saved context yet for "${project.name}". Nothing to load.`));
    return 0;
  }

  process.stdout.write(rendered.text.endsWith('\n') ? rendered.text : rendered.text + '\n');
  info(color.dim(`\n(${rendered.stats.total} entries · ${rendered.stats.devices} machines · ${rendered.stats.agents} tools)`));
  return 0;
}

/* ---------------------------------------------------------------- save --- */

export async function cmdSave(args) {
  const cfg = loadConfig();
  if (args.quiet) setQuiet(true);

  const body = await readBody(args);
  if (!body || !body.trim()) {
    throw new WingmanError(
      'Nothing to save — no body was provided.',
      `Pipe Markdown in:  wingman save --stdin < notes.md\nOr write one inline:  wingman save --message "..."\nTemplate:  wingman template`,
    );
  }

  const project = pickProject({ project: args.project, text: body });
  ensureStore();
  saveProjectMeta(project);
  registerDevice(cfg.deviceId);

  const res = writeEntry({
    projectId: project.id,
    deviceId: cfg.deviceId,
    agent: args.agent || 'manual',
    title: args.title || '',
    body,
    pinned: !!args.pin,
    maxChars: cfg.maxEntryChars,
  });

  ok(`Saved to ${color.cyan(project.name)} — ${path.basename(res.file)}`);
  if (res.findings.length) {
    warn(`Redacted ${res.findings.reduce((n, f) => n + f.count, 0)} possible secret(s): ${res.findings.map((f) => f.type).join(', ')}`);
  }

  refreshContextFile(project);
  const s = sync(cfg, { pull: true, push: cfg.autoPush, message: `wingman: ${project.name} · ${args.agent || 'manual'}` });
  reportSync(s, cfg);
  return 0;
}

/* ------------------------------------------------------------ autosave --- */

/**
 * Hook entry point. Reads the agent's transcript path from the hook payload on
 * stdin when available, but never fails: if we cannot produce a useful entry we
 * exit quietly rather than interrupting the agent.
 */
export async function cmdAutosave(args) {
  setQuiet(true);
  try {
    const cfg = loadConfig();
    const payload = await readStdinJson(600);
    const project = pickProject({ project: args.project, allowUnknown: true });
    if (!project.id) return 0;

    /*
     * Rolling mode fires after every agent turn, so it must be cheap and quiet.
     * We only actually write once the configured interval has passed, which
     * keeps a recent snapshot on disk at all times without one entry per reply.
     * The point is to already have something saved *before* the context window
     * fills up, since that is the moment you can no longer ask for a summary.
     */
    if (args.rolling) {
      const mine = readEntries(project.id).filter((e) => e.device === cfg.deviceId);
      const last = mine[mine.length - 1];
      const minutes = Number(cfg.rollingMinutes) || 20;
      if (last && (Date.now() - last.at.getTime()) < minutes * 60000) return 0;
    }

    const summary = summariseFromPayload(payload, args);
    if (!summary) {
      // Nothing meaningful happened; still push anything pending from earlier.
      sync(cfg, { pull: false, push: cfg.autoPush });
      return 0;
    }

    ensureStore();
    saveProjectMeta(project);
    registerDevice(cfg.deviceId);
    writeEntry({
      projectId: project.id,
      deviceId: cfg.deviceId,
      agent: args.agent || 'agent',
      title: args.rolling
        ? 'Rolling checkpoint'
        : (args.reason === 'compact' ? 'Auto-saved before compaction' : 'Auto-saved at session end'),
      body: summary,
      maxChars: cfg.maxEntryChars,
    });
    refreshContextFile(project);
    sync(cfg, { pull: false, push: cfg.autoPush, message: `wingman: autosave ${project.name}` });
  } catch (err) {
    logLine('autosave', err.stack || err.message);
  }
  if (args.emit === 'json') process.stdout.write('{}\n');
  return 0;
}

function summariseFromPayload(payload, args) {
  const lines = [];
  const cwd = payload?.cwd || process.cwd();
  const branch = run('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd });
  const sha = run('git', ['log', '-1', '--format=%h %s'], { cwd });
  const changed = run('git', ['status', '--porcelain'], { cwd });

  lines.push('## Current state');
  if (branch.ok) lines.push(`Branch: ${branch.stdout.trim()}`);
  if (sha.ok && sha.stdout.trim()) lines.push(`Last commit: ${sha.stdout.trim()}`);
  if (changed.ok && changed.stdout.trim()) {
    const files = changed.stdout.split('\n').filter(Boolean).slice(0, 25).map((l) => l.slice(3).trim());
    lines.push('');
    lines.push('## Uncommitted changes');
    for (const f of files) lines.push(`- ${f}`);
  }

  const last = typeof payload?.last_assistant_message === 'string' ? payload.last_assistant_message.trim() : '';
  if (last) {
    lines.push('');
    lines.push('## Last message from the tool');
    lines.push(last.slice(0, 4000));
  }

  lines.push('');
  lines.push('## Note');
  lines.push(
    args.rolling
      ? '_Rolling checkpoint, read from disk with no model call. A handoff written by the agent via `wingman save` is more useful._'
      : args.reason === 'compact'
        ? '_Auto-saved by Wingman before context compaction. Machine-generated: a handoff written by the agent via `wingman save` is more useful._'
        : '_Auto-saved by Wingman at session end. Machine-generated: a handoff written by the agent via `wingman save` is more useful._',
  );

  const text = lines.join('\n').trim();
  return text.length > 80 ? text : null;
}

/* --------------------------------------------------------------- paste --- */

export async function cmdPaste(args) {
  const cfg = loadConfig();
  const project = pickProject({ project: args.project });

  if (cfg.syncEnabled && !args['no-sync']) sync(cfg, { pull: true, push: false });

  const rendered = renderContext(project, {
    recent: toInt(args.recent, 6),
    maxChars: toInt(args['max-chars'], 16000),
  });

  if (rendered.empty) {
    warn(`No saved context yet for "${project.name}".`);
    return 1;
  }

  const preamble = [
    'You are picking up an in-progress project. The block below is the shared',
    'context from other AI tools and machines. Read it, then continue from the',
    '"Next concrete step". Do not redo completed work or retry listed dead ends.',
    '',
  ].join('\n');

  const payload = preamble + rendered.text;

  info(`Project: ${color.cyan(project.name)}  ${color.dim(`(${project.id})`)}`);
  info(color.dim(`${rendered.stats.total} entries · ${rendered.stats.devices} machines · ${rendered.stats.agents} tools`));

  if (args.stdout || !copyToClipboard(payload)) {
    if (!args.stdout) warn('No clipboard tool available — printing instead.');
    process.stdout.write(payload.endsWith('\n') ? payload : payload + '\n');
    return 0;
  }

  ok('Copied to clipboard. Paste it into ChatGPT, Claude, Gemini, or any chat.');
  step(`When you are done there, bring the reply back with:  ${color.bold('wingman capture')}`);
  return 0;
}

/* ------------------------------------------------------------- capture --- */

export async function cmdCapture(args) {
  const cfg = loadConfig();
  let body = await readBody(args);

  if (!body) body = readFromClipboard();
  if (!body || !body.trim()) {
    throw new WingmanError(
      'Nothing to capture.',
      `Copy the reply from the web chat first, then run  wingman capture.\nOr pipe it in:  wingman capture --stdin`,
    );
  }

  const project = pickProject({ project: args.project, text: body });
  ensureStore();
  saveProjectMeta(project);
  registerDevice(cfg.deviceId);

  const res = writeEntry({
    projectId: project.id,
    deviceId: cfg.deviceId,
    agent: args.agent || 'web-chat',
    title: args.title || 'From a web chat',
    body,
    maxChars: cfg.maxEntryChars,
  });

  ok(`Captured into ${color.cyan(project.name)} — ${path.basename(res.file)}`);
  if (res.findings.length) {
    warn(`Redacted ${res.findings.reduce((n, f) => n + f.count, 0)} possible secret(s): ${res.findings.map((f) => f.type).join(', ')}`);
  }
  const s = sync(cfg, { pull: true, push: cfg.autoPush, message: `wingman: capture ${project.name}` });
  reportSync(s, cfg);
  return 0;
}

/* --------------------------------------------------------------- vault --- */

export async function cmdVault(args) {
  const project = pickProject({ project: args.project });

  if (args.clear) {
    clearVault(project.id);
    ok(`Local notes cleared for ${color.cyan(project.name)}.`);
    return 0;
  }

  const incoming = await readBody(args);
  if (incoming && incoming.trim()) {
    const file = writeVault(project.id, incoming);
    ok(`Local notes saved for ${color.cyan(project.name)}.`);
    step(color.dim(file));
    step(color.dim('Never committed, never synced, never leaves this machine.'));
    warn('Content here is stored exactly as written — secrets are NOT redacted.');
    return 0;
  }

  const current = readVault(project.id);
  if (!current) {
    info(`No local notes for ${color.cyan(project.name)}.`);
    info('');
    info(color.dim('  Local notes are injected into every agent on this machine but'));
    info(color.dim('  are never committed or synced. Useful for credentials, internal'));
    info(color.dim('  URLs, or anything you do not want replicated.'));
    info('');
    info(`  Set them with:  ${color.bold('wingman vault --stdin < notes.md')}`);
    info(`  Or inline:      ${color.bold('wingman vault -m "The staging key is in 1Password under Acme"')}`);
    info(`  Clear them:     ${color.bold('wingman vault --clear')}`);
    return 0;
  }
  process.stdout.write(current.endsWith('\n') ? current : current + '\n');
  return 0;
}

/* ------------------------------------------------------------ template --- */

export async function cmdTemplate() {
  process.stdout.write(HANDOFF_TEMPLATE + '\n');
  return 0;
}

/* -------------------------------------------------------------- helpers -- */

function toInt(v, dflt) {
  const n = parseInt(v, 10);
  return Number.isFinite(n) && n >= 0 ? n : dflt;
}

async function readBody(args) {
  if (args.message) return String(args.message);
  if (args.file) {
    const file = path.resolve(String(args.file));
    if (!fs.existsSync(file)) throw new WingmanError(`File not found: ${file}`);
    return fs.readFileSync(file, 'utf8');
  }
  if (args.stdin || !process.stdin.isTTY) return readStdin(3000);
  return '';
}

function readStdin(timeoutMs = 3000) {
  return new Promise((resolve) => {
    if (process.stdin.isTTY) return resolve('');
    let data = '';
    let done = false;
    const finish = () => { if (!done) { done = true; resolve(data); } };
    const timer = setTimeout(finish, timeoutMs);
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (c) => { data += c; });
    process.stdin.on('end', () => { clearTimeout(timer); finish(); });
    process.stdin.on('error', () => { clearTimeout(timer); finish(); });
  });
}

async function readStdinJson(timeoutMs = 600) {
  const raw = await readStdin(timeoutMs);
  if (!raw || !raw.trim()) return null;
  try { return JSON.parse(raw); } catch { return null; }
}

function clipboardWriter() {
  if (process.platform === 'darwin' && hasBin('pbcopy')) return ['pbcopy', []];
  if (process.platform === 'win32') return ['clip', []];
  if (process.env.WAYLAND_DISPLAY && hasBin('wl-copy')) return ['wl-copy', []];
  if (hasBin('xclip')) return ['xclip', ['-selection', 'clipboard']];
  if (hasBin('xsel')) return ['xsel', ['--clipboard', '--input']];
  if (hasBin('clip.exe')) return ['clip.exe', []];   // WSL
  return null;
}

function clipboardReader() {
  if (process.platform === 'darwin' && hasBin('pbpaste')) return ['pbpaste', []];
  if (process.env.WAYLAND_DISPLAY && hasBin('wl-paste')) return ['wl-paste', []];
  if (hasBin('xclip')) return ['xclip', ['-selection', 'clipboard', '-o']];
  if (hasBin('xsel')) return ['xsel', ['--clipboard', '--output']];
  if (process.platform === 'win32' && hasBin('powershell')) return ['powershell', ['-NoProfile', '-Command', 'Get-Clipboard']];
  return null;
}

export function copyToClipboard(text) {
  const tool = clipboardWriter();
  if (!tool) return false;
  const res = run(tool[0], tool[1], { input: text, timeout: 15000 });
  return res.ok;
}

export function readFromClipboard() {
  const tool = clipboardReader();
  if (!tool) return '';
  const res = run(tool[0], tool[1], { timeout: 15000 });
  return res.ok ? res.stdout : '';
}

export function reportSync(s, cfg) {
  if (!cfg.syncEnabled) {
    step(color.dim('Saved locally. Sync is off — run  wingman connect  to share across machines.'));
    return;
  }
  if (s.pushed) step(color.dim('Pushed to your private repo.'));
  else if (s.offline) warn('Offline — saved locally and queued. It will push on the next command.');
  else if (s.notes.length) warn(`Sync note: ${s.notes[0]}`);
}
