#!/usr/bin/env node
/**
 * Wingman — shared AI context across tools and machines.
 * https://github.com/ma-nucho-pro/Wingman
 */
import { WingmanError, fail, info, color, logLine } from '../src/util.js';

const VERSION = '1.0.0';

const HELP = `
  ${color.bold('wingman')} — one context across every AI tool and every machine

  ${color.bold('Setup')}
    wingman init              Set up Wingman here (first run, and on each new machine)
    wingman connect           Turn on GitHub sync later
    wingman doctor            Check that everything works

  ${color.bold('Everyday')}
    wingman load              Print the context for this project
    wingman save              Save a handoff (pipe Markdown in, or use --message)
    wingman status            Where things stand
    wingman sync              Pull and push now

  ${color.bold('Private to this machine')}
    wingman vault             Notes injected locally but never synced

  ${color.bold('Web chats')}
    wingman paste             Copy the context, ready to paste into any chat
    wingman capture           Bring a web chat's reply back into the project

  ${color.bold('Managing')}
    wingman projects          List projects
    wingman devices           List machines
    wingman use <name>        Link this folder to an existing project
    wingman template          Print the handoff template
    wingman install           (Re)configure your AI tools
    wingman uninstall         Remove Wingman from your AI tools

  ${color.bold('Common flags')}
    --project <name|id>       Act on a specific project
    --agent <name>            Label the entry with the tool that wrote it
    --title "<text>"          Short summary for the entry
    --message "<text>"        Body inline instead of stdin
    --file <path>             Body from a file
    --stdin                   Read the body from stdin
    --pin                     Keep this entry in context permanently
    --local                   init only: skip GitHub entirely
    --repo <name>             init/connect: use a different repo name
    --device <name>           init: name this machine
    --yes                     Never prompt
    --quiet                   Suppress progress output
    --emit json               Hook mode: print '{}' for tools that demand JSON
    --json                    Machine-readable output where supported

  Docs: https://github.com/ma-nucho-pro/Wingman
`;

const BOOLEAN_FLAGS = new Set([
  'help', 'version', 'quiet', 'json', 'stdin', 'pin', 'local', 'yes',
  'hook', 'no-sync', 'stdout', 'force', 'rolling', 'clear',
]);

export function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (token === '--') { args._.push(...argv.slice(i + 1)); break; }
    if (token.startsWith('--')) {
      const eq = token.indexOf('=');
      if (eq !== -1) {
        args[token.slice(2, eq)] = token.slice(eq + 1);
        continue;
      }
      const key = token.slice(2);
      if (BOOLEAN_FLAGS.has(key)) { args[key] = true; continue; }
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) { args[key] = true; continue; }
      args[key] = next;
      i++;
      continue;
    }
    if (token.startsWith('-') && token.length > 1) {
      const map = { h: 'help', v: 'version', q: 'quiet', m: 'message', p: 'project', t: 'title', a: 'agent' };
      const key = map[token.slice(1)];
      if (key) {
        if (BOOLEAN_FLAGS.has(key)) { args[key] = true; continue; }
        const next = argv[i + 1];
        if (next !== undefined && !next.startsWith('-')) { args[key] = next; i++; continue; }
        args[key] = true;
        continue;
      }
      args._.push(token);
      continue;
    }
    args._.push(token);
  }
  return args;
}

const ROUTES = {
  init: () => import('../src/commands/init.js').then((m) => m.cmdInit),
  connect: () => import('../src/commands/init.js').then((m) => m.cmdConnect),

  load: () => import('../src/commands/context.js').then((m) => m.cmdLoad),
  save: () => import('../src/commands/context.js').then((m) => m.cmdSave),
  autosave: () => import('../src/commands/context.js').then((m) => m.cmdAutosave),
  paste: () => import('../src/commands/context.js').then((m) => m.cmdPaste),
  capture: () => import('../src/commands/context.js').then((m) => m.cmdCapture),
  template: () => import('../src/commands/context.js').then((m) => m.cmdTemplate),
  vault: () => import('../src/commands/context.js').then((m) => m.cmdVault),

  status: () => import('../src/commands/manage.js').then((m) => m.cmdStatus),
  doctor: () => import('../src/commands/manage.js').then((m) => m.cmdDoctor),
  projects: () => import('../src/commands/manage.js').then((m) => m.cmdProjects),
  devices: () => import('../src/commands/manage.js').then((m) => m.cmdDevices),
  use: () => import('../src/commands/manage.js').then((m) => m.cmdUse),
  link: () => import('../src/commands/manage.js').then((m) => m.cmdLink),
  sync: () => import('../src/commands/manage.js').then((m) => m.cmdSync),
  install: () => import('../src/commands/manage.js').then((m) => m.cmdInstall),
  uninstall: () => import('../src/commands/manage.js').then((m) => m.cmdUninstall),
};

const ALIASES = {
  setup: 'init', context: 'load', handoff: 'save', ls: 'projects',
  check: 'doctor', pull: 'sync', push: 'sync', copy: 'paste',
};

export async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);

  if (args.version) { process.stdout.write(VERSION + '\n'); return 0; }

  const raw = args._.shift();
  const name = ALIASES[raw] || raw;

  if (!name || args.help || name === 'help') {
    process.stdout.write(HELP + '\n');
    return name && !ROUTES[name] && name !== 'help' ? 1 : 0;
  }

  const loader = ROUTES[name];
  if (!loader) {
    fail(`Unknown command: ${raw}`);
    const guess = closest(name, Object.keys(ROUTES));
    if (guess) info(`  Did you mean  ${color.bold(`wingman ${guess}`)} ?`);
    info(`  Run  ${color.bold('wingman --help')}  for the full list.`);
    return 1;
  }

  const handler = await loader();
  return (await handler(args)) ?? 0;
}

function closest(input, candidates) {
  let best = null;
  let bestScore = Infinity;
  for (const c of candidates) {
    const score = distance(input, c);
    if (score < bestScore) { bestScore = score; best = c; }
  }
  return bestScore <= 3 ? best : null;
}

function distance(a, b) {
  const m = a.length; const n = b.length;
  const prev = new Array(n + 1);
  const cur = new Array(n + 1);
  for (let j = 0; j <= n; j++) prev[j] = j;
  for (let i = 1; i <= m; i++) {
    cur[0] = i;
    for (let j = 1; j <= n; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    for (let j = 0; j <= n; j++) prev[j] = cur[j];
  }
  return prev[n];
}

const invokedDirectly = process.argv[1]
  && (process.argv[1].endsWith('wingman.mjs') || process.argv[1].endsWith('wingman'));

if (invokedDirectly) {
  main()
    .then((code) => { process.exitCode = code ?? 0; })
    .catch((err) => {
      if (err instanceof WingmanError) {
        fail(err.message);
        if (err.hint) {
          for (const line of String(err.hint).split('\n')) info('  ' + color.dim(line));
        }
        process.exitCode = 1;
        return;
      }
      fail(`Unexpected error: ${err.message}`);
      info(color.dim('  Details were written to ~/.wingman/logs/'));
      logLine('fatal', err.stack || err.message);
      process.exitCode = 1;
    });
}
