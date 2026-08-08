#!/usr/bin/env node
/**
 * Wingman MCP server — JSON-RPC 2.0 over stdio, no dependencies.
 * Exposes the same store the CLI uses, for clients that prefer tools over shell.
 */
import { loadConfig } from '../src/config.js';
import { resolveProject } from '../src/identity.js';
import { ensureStore, listProjects, findProjectById, saveProjectMeta, registerDevice, sync } from '../src/store.js';
import { writeEntry } from '../src/journal.js';
import { renderContext, HANDOFF_TEMPLATE } from '../src/render.js';
import { logLine } from '../src/util.js';

const PROTOCOL_VERSION = '2024-11-05';

const TOOLS = [
  {
    name: 'wingman_load_context',
    description:
      'Load the shared Wingman context for a project: what was decided, what failed, and the next step, '
      + 'gathered from every AI tool and machine that has worked on it. Call this before starting work.',
    inputSchema: {
      type: 'object',
      properties: {
        project: { type: 'string', description: 'Project name or id. Omit to use the current working directory.' },
        recent: { type: 'number', description: 'How many recent entries to include in full (default 6).' },
      },
    },
  },
  {
    name: 'wingman_save_handoff',
    description:
      'Save a handoff so the next tool or machine can continue. Write state, not transcript: goal, current state, '
      + 'decisions, dead ends, files touched, next concrete step. Call this when context is running low or work is pausing.',
    inputSchema: {
      type: 'object',
      properties: {
        body: { type: 'string', description: 'Markdown handoff. Use the sections from wingman_handoff_template.' },
        title: { type: 'string', description: 'Short summary, a few words.' },
        agent: { type: 'string', description: 'Name of the tool writing this, e.g. cursor.' },
        project: { type: 'string', description: 'Project name or id. Omit to use the current working directory.' },
        pin: { type: 'boolean', description: 'Keep this entry in context permanently.' },
      },
      required: ['body'],
    },
  },
  {
    name: 'wingman_list_projects',
    description: 'List every project in the Wingman store, with entry counts.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'wingman_handoff_template',
    description: 'Return the handoff template to fill in before calling wingman_save_handoff.',
    inputSchema: { type: 'object', properties: {} },
  },
];

function resolve(projectArg) {
  if (projectArg) {
    const found = findProjectById(projectArg);
    if (found) return found;
    throw new Error(`No project matches "${projectArg}". Call wingman_list_projects to see what exists.`);
  }
  const local = resolveProject(process.cwd());
  if (!local.id) throw new Error('This directory is not a Wingman project. Run `wingman init` here, or pass a project name.');
  return local;
}

const HANDLERS = {
  wingman_load_context(input) {
    const cfg = loadConfig();
    const project = resolve(input.project);
    if (cfg.syncEnabled) sync(cfg, { pull: true, push: false });
    const rendered = renderContext(project, { recent: clampInt(input.recent, 6, 1, 40) });
    if (rendered.empty) return `No saved context yet for "${project.name}". Start work normally; save a handoff when you pause.`;
    return rendered.text;
  },

  wingman_save_handoff(input) {
    if (!input.body || !String(input.body).trim()) throw new Error('body is required and cannot be empty.');
    const cfg = loadConfig();
    const project = resolve(input.project);
    ensureStore();
    saveProjectMeta(project);
    registerDevice(cfg.deviceId);
    const res = writeEntry({
      projectId: project.id,
      deviceId: cfg.deviceId,
      agent: input.agent || 'mcp',
      title: input.title || '',
      body: String(input.body),
      pinned: !!input.pin,
      maxChars: cfg.maxEntryChars,
    });
    const s = sync(cfg, { pull: true, push: cfg.autoPush, message: `wingman: ${project.name} · mcp` });
    const redacted = res.findings.length
      ? ` Redacted ${res.findings.reduce((n, f) => n + f.count, 0)} possible secret(s).`
      : '';
    const synced = cfg.syncEnabled ? (s.pushed ? ' Pushed to your private repo.' : ' Saved locally; will push when online.') : '';
    return `Saved to "${project.name}" as ${res.name}.${redacted}${synced}`;
  },

  wingman_list_projects() {
    const projects = listProjects();
    if (!projects.length) return 'No projects yet. Run `wingman init` inside a project folder.';
    return projects.map((p) => `- ${p.name} (${p.id}) — ${p.entryCount} entries${p.remote ? `, ${p.remote}` : ''}`).join('\n');
  },

  wingman_handoff_template() {
    return HANDOFF_TEMPLATE;
  },
};

function clampInt(v, dflt, lo, hi) {
  const n = parseInt(v, 10);
  if (!Number.isFinite(n)) return dflt;
  return Math.min(hi, Math.max(lo, n));
}

function reply(id, result) {
  if (id === undefined || id === null) return;
  write({ jsonrpc: '2.0', id, result });
}

function replyError(id, code, message) {
  if (id === undefined || id === null) return;
  write({ jsonrpc: '2.0', id, error: { code, message } });
}

function write(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n');
}

function handle(msg) {
  const { id, method, params } = msg;

  if (method === 'initialize') {
    return reply(id, {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: { tools: {} },
      serverInfo: { name: 'wingman', version: '1.0.0' },
    });
  }
  if (method === 'notifications/initialized' || method === 'initialized') return;
  if (method === 'ping') return reply(id, {});
  if (method === 'tools/list') return reply(id, { tools: TOOLS });

  if (method === 'tools/call') {
    const name = params?.name;
    const handler = HANDLERS[name];
    if (!handler) return replyError(id, -32601, `Unknown tool: ${name}`);
    try {
      const text = handler(params?.arguments || {});
      return reply(id, { content: [{ type: 'text', text: String(text) }] });
    } catch (err) {
      logLine('mcp', `${name}: ${err.stack || err.message}`);
      return reply(id, { content: [{ type: 'text', text: `Wingman error: ${err.message}` }], isError: true });
    }
  }

  if (typeof method === 'string' && method.startsWith('notifications/')) return;
  return replyError(id, -32601, `Method not found: ${method}`);
}

let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  let nl;
  while ((nl = buffer.indexOf('\n')) !== -1) {
    const line = buffer.slice(0, nl).trim();
    buffer = buffer.slice(nl + 1);
    if (!line) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { continue; }
    try { handle(msg); } catch (err) {
      logLine('mcp', err.stack || err.message);
      replyError(msg?.id, -32603, err.message);
    }
  }
});
process.stdin.on('error', () => process.exit(0));
process.on('SIGINT', () => process.exit(0));
process.on('SIGTERM', () => process.exit(0));
