import fs from 'node:fs';
import path from 'node:path';
import {
  STORE_DIR, CONFIG_PATH,
  info, ok, warn, fail, step, color, relativeTime, hasBin, WingmanError,
} from '../util.js';
import { loadConfig, configExists } from '../config.js';
import { writeMarker, gitTopLevel } from '../identity.js';
import * as G from '../git.js';
import * as GH from '../github.js';
import { ensureStore, listProjects, listDevices, findProjectById, sync } from '../store.js';
import { VAULT_DIR, vaultIsOutsideStore } from '../vault.js';
import { readEntries } from '../journal.js';
import { detectAgents, getAdapter } from '../adapters/index.js';
import { installRuntime, runtimePaths } from '../runtime.js';
import { wireProject, unwireProject, contextFilePath } from '../context-file.js';
import { pickProject } from './context.js';

export async function cmdStatus(args) {
  const cfg = loadConfig();
  info('');
  info(color.bold('  Wingman status'));
  info('');

  let project = null;
  try { project = pickProject({ project: args.project }); } catch { /* not in a project */ }

  if (project) {
    const entries = readEntries(project.id);
    const last = entries[entries.length - 1];
    info(`  Project    ${color.cyan(project.name)}  ${color.dim(project.id)}`);
    info(`  Source     ${color.dim(describeSource(project.source))}`);
    info(`  Entries    ${entries.length}${last ? color.dim(`  · last: ${last.agent} on ${last.device}, ${relativeTime(last.at)}`) : ''}`);
  } else {
    info(`  Project    ${color.yellow('none here')}  ${color.dim('(run  wingman init  in a project folder)')}`);
  }

  info(`  Machine    ${color.cyan(cfg.deviceId)}`);
  info(`  Store      ${color.dim(STORE_DIR)}`);

  if (cfg.syncEnabled) {
    const unpushed = G.countUnpushed(STORE_DIR);
    const lastCommit = G.lastCommitDate(STORE_DIR);
    info(`  Sync       ${color.green('on')} → ${cfg.storeRepo} ${color.dim('(private)')}`);
    info(`  Pending    ${unpushed ? color.yellow(`${unpushed} commit(s) not pushed`) : color.dim('nothing')}`);
    if (lastCommit) info(`  Last write ${color.dim(relativeTime(lastCommit))}`);
  } else {
    info(`  Sync       ${color.yellow('off')} ${color.dim('— local only. Run  wingman connect  to share across machines.')}`);
  }

  const devices = listDevices();
  if (devices.length > 1) {
    info(`  Machines   ${devices.map((d) => (d.deviceId === cfg.deviceId ? color.cyan(d.deviceId) : d.deviceId)).join(', ')}`);
  }
  info('');
  return 0;
}

function describeSource(source) {
  return {
    marker: 'matched .wingman/project.json',
    remote: 'matched by git remote',
    flag: 'given with --project',
    tag: 'read from the pasted text',
    named: 'named manually',
  }[source] || String(source || 'unknown');
}

/* --------------------------------------------------------------- doctor -- */

export async function cmdDoctor() {
  const checks = [];
  const cfg = loadConfig();
  let project = null;
  try { project = pickProject({}); } catch { /* not inside a project */ }

  const major = parseInt(process.versions.node.split('.')[0], 10);
  checks.push(check('Node 18+', major >= 18, `found ${process.versions.node}`,
    'Install a current Node: https://nodejs.org/en/download'));

  checks.push(check('git installed', G.gitAvailable(), G.gitAvailable() ? 'ok' : 'missing',
    'Install git: https://git-scm.com/downloads'));

  checks.push(check('config file', configExists(), configExists() ? CONFIG_PATH : 'not created yet',
    'Run  wingman init  in a project folder.'));

  const storeOk = fs.existsSync(STORE_DIR) && G.isRepo(STORE_DIR);
  checks.push(check('memory store', storeOk, storeOk ? STORE_DIR : 'not initialised',
    'Run  wingman init.'));

  if (cfg.syncEnabled) {
    const remote = G.getRemote(STORE_DIR);
    checks.push(check('store remote', !!remote, remote || 'none', 'Run  wingman connect.'));

    const auth = GH.detectAuth();
    checks.push(check('GitHub auth', auth.method !== 'none', auth.detail, GH.loginHint()));

    if (auth.method !== 'none' && cfg.storeRepo) {
      const [owner, name] = cfg.storeRepo.split('/');
      const privacy = await GH.assertPrivate(auth, owner, name);
      checks.push(check('repo is private', privacy.ok,
        privacy.ok ? 'verified' : (privacy.reason || 'unknown'),
        `Make it private: https://github.com/${cfg.storeRepo}/settings`));
    }

    const unpushed = G.countUnpushed(STORE_DIR);
    checks.push(check('nothing pending', unpushed === 0, unpushed ? `${unpushed} unpushed commit(s)` : 'clean',
      'Run  wingman sync.'));
  } else {
    checks.push(check('sync', true, 'off (local only) — this is fine', null, true));
  }

  checks.push(check('vault isolated', vaultIsOutsideStore(STORE_DIR),
    `${VAULT_DIR} (never synced)`,
    'The vault must live outside the store. Report this as a bug.'));

  if (project) {
    const ctx = contextFilePath(project.root);
    checks.push(check('context file', fs.existsSync(ctx), fs.existsSync(ctx) ? ctx : 'not generated yet',
      'Run  wingman load  once, or  wingman install  to re-wire this project.', true));
  }

  const clip = hasClipboard();
  checks.push(check('clipboard tool', clip.ok, clip.detail, clip.hint, true));

  const agents = detectAgents().filter((a) => a.present);
  checks.push(check('agents detected', agents.length > 0,
    agents.length ? agents.map((a) => a.label).join(', ') : 'none found',
    'Wingman still works — call  wingman load  manually.', true));

  const rt = runtimePaths();
  checks.push(check('cli reachable', fs.existsSync(rt.entry), rt.entry,
    'Run  wingman install --force  to re-pin the runtime.'));
  checks.push(check('mcp server', fs.existsSync(rt.mcp), rt.mcp,
    'Run  wingman install --force.', true));

  info('');
  info(color.bold('  wingman doctor'));
  info('');
  let hardFailures = 0;
  for (const c of checks) {
    const icon = c.pass ? color.green('✓') : (c.soft ? color.yellow('!') : color.red('✗'));
    info(`  ${icon} ${c.name.padEnd(18)} ${color.dim(c.detail)}`);
    if (!c.pass) {
      if (c.hint) info(`    ${color.dim('→ ' + c.hint)}`);
      if (!c.soft) hardFailures++;
    }
  }
  info('');
  if (hardFailures === 0) ok('Everything Wingman needs is in place.');
  else fail(`${hardFailures} problem(s) need attention.`);
  info('');
  return hardFailures === 0 ? 0 : 1;
}

function check(name, pass, detail, hint, soft = false) {
  return { name, pass: !!pass, detail: detail || '', hint, soft };
}

function hasClipboard() {
  if (process.platform === 'darwin') return { ok: hasBin('pbcopy'), detail: 'pbcopy' };
  if (process.platform === 'win32') return { ok: true, detail: 'clip' };
  for (const [bin, label] of [['wl-copy', 'wl-copy'], ['xclip', 'xclip'], ['xsel', 'xsel'], ['clip.exe', 'clip.exe (WSL)']]) {
    if (hasBin(bin)) return { ok: true, detail: label };
  }
  return { ok: false, detail: 'none', hint: 'Install xclip or wl-clipboard for  wingman paste. Not required otherwise.' };
}

/* ------------------------------------------------------------- projects -- */

export async function cmdProjects() {
  const projects = listProjects();
  if (!projects.length) {
    info('No projects yet. Run  wingman init  inside a project folder.');
    return 0;
  }
  info('');
  for (const p of projects) {
    const when = p.lastEntryAt ? color.dim(`last ${p.lastEntryAt.slice(0, 10)}`) : color.dim('empty');
    info(`  ${color.cyan(p.name.padEnd(22))} ${String(p.entryCount).padStart(4)} entries  ${when}`);
    info(`  ${color.dim(p.id.padEnd(22))} ${color.dim(p.remote || 'no remote')}`);
    info('');
  }
  return 0;
}

export async function cmdDevices() {
  const cfg = loadConfig();
  const devices = listDevices();
  if (!devices.length) {
    info('No machines registered yet.');
    return 0;
  }
  info('');
  for (const d of devices) {
    const me = d.deviceId === cfg.deviceId ? color.green('  ← this machine') : '';
    info(`  ${color.cyan(d.deviceId.padEnd(20))} ${color.dim(d.platform || '?')}  ${color.dim(`last seen ${String(d.lastSeen).slice(0, 10)}`)}${me}`);
  }
  info('');
  return 0;
}

/* ------------------------------------------------------------------ use -- */

export async function cmdUse(args) {
  const target = args._[0];
  if (!target) throw new WingmanError('Which project?', 'Usage:  wingman use <name-or-id>\nSee  wingman projects.');
  const found = findProjectById(target);
  if (!found) throw new WingmanError(`No project matches "${target}".`, 'Run  wingman projects  to see the list.');

  const root = gitTopLevel(process.cwd()) || process.cwd();
  writeMarker(root, { id: found.id, name: found.name, remote: found.remote });
  ok(`This folder is now linked to ${color.cyan(found.name)} ${color.dim(`(${found.id})`)}`);
  return 0;
}

export async function cmdLink(args) {
  return cmdUse(args);
}

/* ----------------------------------------------------------------- sync -- */

export async function cmdSync() {
  const cfg = loadConfig();
  ensureStore();
  if (!cfg.syncEnabled) {
    warn('Sync is off. Run  wingman connect  first.');
    return 1;
  }
  const s = sync(cfg, { pull: true, push: true, message: 'wingman: manual sync' });
  if (s.pulled) step('Pulled.');
  if (s.committed) step('Committed local changes.');
  if (s.pushed) ok('Pushed.');
  if (!s.pulled && !s.pushed && !s.committed) ok('Already up to date.');
  for (const n of s.notes) warn(n);
  return s.notes.length && !s.pushed ? 1 : 0;
}

/* -------------------------------------------------------------- install -- */

export async function cmdInstall(args) {
  const project = (() => { try { return pickProject({}); } catch { return null; } })();
  const projectRoot = project?.root || process.cwd();
  const only = args.agent;
  const runtime = installRuntime({ force: !!args.force });
  if (runtime.failed) warn(`Runtime could not be pinned: ${runtime.reason}`);
  const detected = detectAgents();
  let count = 0;

  for (const d of detected) {
    if (only && d.id !== only) continue;
    if (!d.present && !only) continue;
    const adapter = getAdapter(d.id);
    try {
      const res = adapter.install({ projectRoot });
      if (res.ok) { ok(`Configured ${d.label}`); count++; }
      else warn(`${d.label}: ${res.reason}`);
    } catch (err) {
      warn(`${d.label}: ${err.message}`);
    }
  }
  if (project?.id) {
    const wired = wireProject(project, {});
    for (const f of wired) step(color.dim(`Wired ${path.basename(f)}`));
  }
  if (!count) warn('No agents were configured. Use  --agent claude-code|codex|gemini-cli|cursor  to force one.');
  return count ? 0 : 1;
}

export async function cmdUninstall(args) {
  const projectRoot = gitTopLevel(process.cwd()) || process.cwd();
  for (const d of detectAgents()) {
    if (args.agent && d.id !== args.agent) continue;
    const adapter = getAdapter(d.id);
    try { adapter.uninstall({ projectRoot }); ok(`Removed Wingman from ${d.label}`); }
    catch (err) { warn(`${d.label}: ${err.message}`); }
  }
  unwireProject(projectRoot);
  ok('Removed the context pointers from this project');
  info('');
  info(color.dim(`Your memory store is untouched at ${STORE_DIR}`));
  info(color.dim('Delete it yourself if you want it gone.'));
  return 0;
}
