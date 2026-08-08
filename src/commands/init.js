import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import {
  STORE_DIR, WINGMAN_HOME, ensureDir, info, ok, warn, step, fail, color, WingmanError,
} from '../util.js';
import { loadConfig, saveConfig } from '../config.js';
import {
  resolveProject, projectFromName, writeMarker, defaultDeviceId, isValidDeviceId,
} from '../identity.js';
import * as G from '../git.js';
import * as GH from '../github.js';
import { ensureStore, saveProjectMeta, registerDevice, sync, nameSharedWithAnotherMachine } from '../store.js';
import { detectAgents, getAdapter } from '../adapters/index.js';
import { installRuntime } from '../runtime.js';
import { wireProject } from '../context-file.js';

const DEFAULT_REPO_NAME = 'wingman-memory';

export async function cmdInit(args) {
  const cfg = loadConfig();
  ensureDir(WINGMAN_HOME);

  info('');
  info(color.bold('  Wingman — setting up'));
  info('');

  /* 1. Node version -------------------------------------------------- */
  const major = parseInt(process.versions.node.split('.')[0], 10);
  if (major < 18) {
    throw new WingmanError(
      `Node ${process.versions.node} is too old — Wingman needs Node 18 or newer.`,
      'Install a current Node: https://nodejs.org/en/download',
    );
  }
  step(`Node ${process.versions.node}`);

  if (!G.gitAvailable()) {
    throw new WingmanError('git is not installed or not on PATH.', 'Install git: https://git-scm.com/downloads');
  }
  step('git found');

  /* 2. Device -------------------------------------------------------- */
  let deviceId = args.device || cfg.deviceId || defaultDeviceId();
  if (!isValidDeviceId(deviceId)) deviceId = defaultDeviceId();
  if (!args.yes && !args.device && process.stdin.isTTY) {
    const answer = await ask(`  Name for this machine [${deviceId}]: `);
    if (answer.trim()) {
      const cleaned = answer.trim().toLowerCase().replace(/[^a-z0-9-]/g, '-').slice(0, 32);
      if (isValidDeviceId(cleaned)) deviceId = cleaned;
      else warn(`"${answer.trim()}" is not a valid name; keeping "${deviceId}".`);
    }
  }
  cfg.deviceId = deviceId;
  step(`This machine: ${color.cyan(deviceId)}`);

  /* 3. Project ------------------------------------------------------- */
  const cwd = process.cwd();
  let project = resolveProject(cwd);
  if (!project.id) {
    let name = args.name;
    if (!name && !args.yes && process.stdin.isTTY) {
      const suggested = project.name;
      const answer = await ask(`  No git remote here. Name for this project [${suggested}]: `);
      name = answer.trim() || suggested;
    }
    name = name || project.name;
    project = projectFromName(name, project.root);
  }
  writeMarker(project.root, project);
  step(`Project: ${color.cyan(project.name)} ${color.dim(`(${project.id})`)}`);
  if (project.remote) step(color.dim(`Identified by remote: ${project.remote}`));
  step(color.dim('Marker written to .wingman/ and excluded from this repo locally.'));

  /* 4. Store --------------------------------------------------------- */
  ensureStore();
  saveProjectMeta(project);

  if (nameSharedWithAnotherMachine(deviceId)) {
    warn(`Another machine also calls itself "${deviceId}".`);
    step('Both still work — their entries are stored separately — but a distinct');
    step(`name reads better. Change it with:  wingman init --device <other-name>`);
  }
  registerDevice(deviceId, { lastProject: project.id });
  step(`Memory store: ${color.dim(STORE_DIR)}`);

  /* 5. GitHub -------------------------------------------------------- */
  let syncResult = { enabled: false };
  if (args.local) {
    // --local means "do not set sync up", never "tear down sync that already
    // works". Silently disabling a working store on a re-run would be the kind
    // of quiet data-stranding bug users never think to look for.
    if (cfg.syncEnabled && G.getRemote(STORE_DIR)) {
      syncResult = { enabled: true, remote: cfg.storeRemote, repo: cfg.storeRepo, method: cfg.authMethod };
      step(color.dim('--local ignored: sync is already configured and stays on.'));
    } else {
      warn('--local given: skipping GitHub sync entirely.');
    }
  } else {
    syncResult = await setUpSync(cfg, args);
  }
  cfg.syncEnabled = !!syncResult.enabled;
  if (syncResult.repo) cfg.storeRepo = syncResult.repo;
  if (syncResult.remote) cfg.storeRemote = syncResult.remote;
  if (syncResult.method) cfg.authMethod = syncResult.method;

  /* 6. Pin a stable runtime -------------------------------------------
     Hooks must survive `npx` cleaning its cache, so we copy the runtime to a
     fixed path and point every integration at that instead. */
  const runtime = installRuntime();
  if (runtime.failed) warn(`Could not vendor the runtime (${runtime.reason}); hooks will use the current path.`);
  else step(color.dim(`Runtime pinned at ${runtime.entry}`));

  /* 7. Agents -------------------------------------------------------- */
  const installed = installAgents({ projectRoot: project.root, only: args.agent });

  /* Point each present tool's instructions file at the generated context file,
     so context arrives with no command and no hook output format to break. */
  const wired = wireProject(project, { agents: installed.map((a) => a.id) });
  for (const f of wired) step(color.dim(`Wired ${path.basename(f)} to .wingman/CONTEXT.md`));

  /* 8. Commit -------------------------------------------------------- */
  saveConfig(cfg);
  const s = sync(cfg, { pull: false, push: cfg.syncEnabled, message: `wingman: register ${deviceId}` });

  /* 9. Summary ------------------------------------------------------- */
  info('');
  ok('Wingman is ready.');
  info('');
  info(`  Project    ${color.cyan(project.name)}`);
  info(`  Machine    ${color.cyan(deviceId)}`);
  info(`  Sync       ${cfg.syncEnabled ? color.green(`on → ${cfg.storeRepo} (private)`) : color.yellow('off (local only)')}`);
  info(`  Agents     ${installed.length ? installed.map((a) => a.label).join(', ') : color.dim('none detected')}`);
  info('');

  if (installed.length) {
    step(color.dim('Restart your AI tools once so they pick up the new hooks.'));
  }
  if (!cfg.syncEnabled && !args.local) {
    info(`  ${color.yellow('To use Wingman on more than one machine:')}  ${color.bold('wingman connect')}`);
    info('');
  }
  if (s.notes.length) for (const n of s.notes) step(color.dim(n));

  info(`  Next: open your AI tool in this folder. It will load the context on its own.`);
  info(`  Manual check: ${color.bold('wingman status')}`);
  info('');
  return 0;
}

/* ------------------------------------------------------------ connect --- */

export async function cmdConnect(args) {
  const cfg = loadConfig();
  ensureStore();
  const result = await setUpSync(cfg, { ...args, interactive: true });
  cfg.syncEnabled = !!result.enabled;
  if (result.repo) cfg.storeRepo = result.repo;
  if (result.remote) cfg.storeRemote = result.remote;
  if (result.method) cfg.authMethod = result.method;
  saveConfig(cfg);

  if (cfg.syncEnabled) {
    const s = sync(cfg, { pull: true, push: true, message: 'wingman: connect' });
    ok(`Sync is on → ${cfg.storeRepo} (private)`);
    if (s.notes.length) for (const n of s.notes) step(color.dim(n));
    return 0;
  }
  return 1;
}

/**
 * The auth ladder. Returns without throwing in every branch: failing to reach
 * GitHub must never stop Wingman from working locally.
 */
async function setUpSync(cfg, args) {
  const repoName = args.repo || process.env.WINGMAN_STORE_REPO?.split('/').pop() || DEFAULT_REPO_NAME;

  const existingRemote = G.getRemote(STORE_DIR);
  if (existingRemote && !args.repo) {
    step(`Store already points at ${color.dim(existingRemote)}`);
    return { enabled: true, remote: existingRemote, repo: repoFromUrl(existingRemote), method: cfg.authMethod };
  }

  const auth = GH.detectAuth();
  if (auth.method === 'none') {
    warn('No GitHub credentials found on this machine.');
    step('Wingman works fine locally — sync is an upgrade, not a requirement.');
    step(color.dim(GH.loginHint()));
    step(color.dim('Then run:  wingman connect'));
    return { enabled: false };
  }
  step(`GitHub: ${auth.detail}`);

  const owner = await GH.whoAmI(auth);
  if (!owner) {
    warn('Could not determine your GitHub username. Staying local for now.');
    step(color.dim('Run  wingman connect  once GitHub is reachable.'));
    return { enabled: false };
  }

  const check = await GH.repoExists(auth, owner, repoName);
  if (check.offline) {
    warn('GitHub is unreachable right now. Staying local; run  wingman connect  later.');
    return { enabled: false };
  }

  if (check.exists === false) {
    step(`Creating private repo ${color.cyan(`${owner}/${repoName}`)}…`);
    const created = await GH.createPrivateRepo(auth, repoName, 'Private AI context store for Wingman');
    if (!created.ok) {
      warn(`Could not create the repo automatically: ${created.reason}`);
      step(`Create it yourself (private!) at  https://github.com/new  named  ${repoName}`);
      step(`Then run:  wingman connect`);
      return { enabled: false };
    }
    ok(`Created ${owner}/${repoName} (private)`);
  } else if (check.exists === true) {
    step(`Found existing ${color.cyan(`${owner}/${repoName}`)}`);
  }

  // Hard gate: never write context to a public repository.
  const privacy = await GH.assertPrivate(auth, owner, repoName);
  if (!privacy.ok) {
    if (privacy.offline) {
      warn('Could not verify repo visibility. Staying local rather than risking it.');
      return { enabled: false };
    }
    fail(privacy.reason);
    step('Wingman will not sync until the repository is private.');
    step(`Fix it at  https://github.com/${owner}/${repoName}/settings  then run  wingman connect`);
    return { enabled: false };
  }
  step(color.green('Verified: repository is private.'));

  const url = GH.remoteUrl(auth, owner, repoName);
  G.setRemote(STORE_DIR, url);

  const pulled = G.pull(STORE_DIR);
  if (pulled.ok && !pulled.skipped) step('Pulled existing memory from GitHub.');
  else if (!pulled.ok && pulled.conflict) warn(`Pull reported a conflict: ${pulled.reason}`);

  return { enabled: true, remote: url, repo: `${owner}/${repoName}`, method: auth.method };
}

function repoFromUrl(url) {
  const m = String(url).match(/[:/]([^/:]+)\/([^/]+?)(?:\.git)?$/);
  return m ? `${m[1]}/${m[2]}` : null;
}

function installAgents({ projectRoot, only }) {
  const detected = detectAgents().filter((a) => a.present).filter((a) => !only || a.id === only);
  const done = [];
  for (const d of detected) {
    const adapter = getAdapter(d.id);
    if (!adapter) continue;
    try {
      const res = adapter.install({ projectRoot });
      if (res.ok) {
        done.push({ ...d, automatic: !!res.automatic });
        step(`Configured ${color.cyan(d.label)}${res.automatic ? '' : color.dim(' (adds commands; restart it once)')}`);
      } else {
        warn(`${d.label}: ${res.reason}`);
      }
    } catch (err) {
      warn(`${d.label}: setup skipped (${err.message})`);
    }
  }
  return done;
}

function ask(question) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
    rl.question(question, (answer) => { rl.close(); resolve(answer || ''); });
  });
}
