import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.resolve(HERE, '..', 'bin', 'wingman.mjs');

let ROOT;

/** Run the CLI as a real subprocess with an isolated WINGMAN_HOME. */
function wingman(args, { home, cwd, input, env = {} } = {}) {
  const res = spawnSync(process.execPath, [CLI, ...args], {
    cwd,
    encoding: 'utf8',
    input,
    timeout: 60000,
    env: {
      ...process.env,
      WINGMAN_HOME: home,
      NO_COLOR: '1',
      HOME: path.join(ROOT, 'fakehome'),   // keep adapters away from the real machine
      USERPROFILE: path.join(ROOT, 'fakehome'),
      GIT_TERMINAL_PROMPT: '0',
      ...env,
    },
  });
  return {
    code: res.status,
    stdout: res.stdout || '',
    stderr: res.stderr || '',
    all: (res.stdout || '') + (res.stderr || ''),
  };
}

function git(args, cwd) {
  return spawnSync('git', ['-c', 'user.name=T', '-c', 'user.email=t@t', ...args], { cwd, encoding: 'utf8' });
}

/** Point a machine's store at the fake "GitHub" and mark sync as on. */
function connectStore(home, bareRepo) {
  const store = path.join(home, 'store');
  fs.mkdirSync(store, { recursive: true });
  if (!fs.existsSync(path.join(store, '.git'))) git(['init', '-b', 'main'], store);
  git(['remote', 'remove', 'origin'], store);
  git(['remote', 'add', 'origin', bareRepo], store);
  const cfgPath = path.join(home, 'config.json');
  const cfg = fs.existsSync(cfgPath) ? JSON.parse(fs.readFileSync(cfgPath, 'utf8')) : {};
  cfg.syncEnabled = true;
  cfg.autoPush = true;
  cfg.storeRepo = 'test/wingman-memory';
  fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));
}

before(() => {
  ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'wingman-e2e-'));
  fs.mkdirSync(path.join(ROOT, 'fakehome'), { recursive: true });
});

after(() => {
  try { fs.rmSync(ROOT, { recursive: true, force: true }); } catch { /* best effort */ }
});

describe('two machines sharing one project', () => {
  let bare, homeA, homeB, projA, projB;

  before(() => {
    bare = path.join(ROOT, 'github', 'wingman-memory.git');
    fs.mkdirSync(path.dirname(bare), { recursive: true });
    spawnSync('git', ['init', '--bare', '-b', 'main', bare], { encoding: 'utf8' });

    // The shared project, cloned to a different path on each machine —
    // exactly the situation that breaks path-based identity.
    const originProject = path.join(ROOT, 'origin', 'myapp.git');
    fs.mkdirSync(path.dirname(originProject), { recursive: true });
    spawnSync('git', ['init', '--bare', '-b', 'main', originProject], { encoding: 'utf8' });

    homeA = path.join(ROOT, 'machineA', '.wingman');
    homeB = path.join(ROOT, 'machineB', '.wingman');
    projA = path.join(ROOT, 'machineA', 'work', 'myapp');
    projB = path.join(ROOT, 'machineB', 'projects', 'clone-of-myapp');

    for (const [dir, url] of [[projA, originProject], [projB, originProject]]) {
      fs.mkdirSync(dir, { recursive: true });
      git(['init', '-b', 'main'], dir);
      git(['remote', 'add', 'origin', url], dir);
      fs.writeFileSync(path.join(dir, 'README.md'), '# myapp\n');
      git(['add', '-A'], dir);
      git(['commit', '-m', 'init'], dir);
    }

    for (const home of [homeA, homeB]) fs.mkdirSync(home, { recursive: true });
  });

  test('init works offline and stays local when GitHub is absent', () => {
    const res = wingman(['init', '--yes', '--local', '--device', 'pc-trabajo'], { home: homeA, cwd: projA });
    assert.equal(res.code, 0, res.all);
    assert.match(res.all, /Wingman is ready/);
    assert.match(res.all, /local only/i);
    assert.ok(fs.existsSync(path.join(projA, '.wingman', 'project.json')));
  });

  test('the project marker is excluded from the project repo, not committed', () => {
    const status = git(['status', '--porcelain'], projA).stdout;
    assert.ok(!status.includes('.wingman'), `marker leaked into git status:\n${status}`);
    const exclude = fs.readFileSync(path.join(projA, '.git', 'info', 'exclude'), 'utf8');
    assert.match(exclude, /^\.wingman\/$/m);
  });

  test('machine A saves a handoff', () => {
    connectStore(homeA, bare);
    const body = '## Goal\nMigrate auth to JWT.\n\n## Decisions made\n- RS256 not HS256\n\n## Next concrete step\nFix clock skew in verify.ts:42\n';
    const res = wingman(['save', '--agent', 'claude-code', '--title', 'JWT migration', '--stdin'],
      { home: homeA, cwd: projA, input: body });
    assert.equal(res.code, 0, res.all);
    assert.match(res.all, /Saved to/);
  });

  test('machine A pushed to the shared remote', () => {
    const log = git(['log', '--oneline', 'main'], bare).stdout;
    assert.ok(log.trim().length > 0, 'bare repo should have commits');
  });

  test('machine B init finds the same project id from the git remote alone', () => {
    const res = wingman(['init', '--yes', '--local', '--device', 'pc-casa'], { home: homeB, cwd: projB });
    assert.equal(res.code, 0, res.all);

    const idA = JSON.parse(fs.readFileSync(path.join(projA, '.wingman', 'project.json'), 'utf8')).id;
    const idB = JSON.parse(fs.readFileSync(path.join(projB, '.wingman', 'project.json'), 'utf8')).id;
    assert.equal(idA, idB, 'same remote must yield the same project id despite different paths');
  });

  test('machine B pulls machine A\'s context', () => {
    connectStore(homeB, bare);
    const res = wingman(['load'], { home: homeB, cwd: projB });
    assert.equal(res.code, 0, res.all);
    assert.match(res.stdout, /Migrate auth to JWT/);
    assert.match(res.stdout, /RS256 not HS256/);
    assert.match(res.stdout, /clock skew/);
    assert.match(res.stdout, /claude-code on pc-trabajo/);
  });

  test('machine B adds its own entry and machine A sees it', () => {
    const res = wingman(['save', '--agent', 'codex', '--title', 'Skew fixed', '--message',
      '## Current state\nTests 17/17 green.\n\n## Next concrete step\nOpen the PR.'],
    { home: homeB, cwd: projB });
    assert.equal(res.code, 0, res.all);

    const back = wingman(['load'], { home: homeA, cwd: projA });
    assert.equal(back.code, 0, back.all);
    assert.match(back.stdout, /Tests 17\/17 green/);
    assert.match(back.stdout, /Migrate auth to JWT/, 'earlier entry must survive');
    assert.match(back.stdout, /2 machines/);
    assert.match(back.stdout, /2 tools/);
  });

  test('entries appear in chronological order regardless of which machine wrote them', () => {
    const out = wingman(['load'], { home: homeA, cwd: projA }).stdout;
    assert.ok(out.indexOf('Migrate auth to JWT') < out.indexOf('Tests 17/17 green'),
      'older entry must come first');
  });

  test('simultaneous writes from both machines merge without conflict', () => {
    // Neither machine pulls first: the classic conflict setup.
    const a = wingman(['save', '--agent', 'claude-code', '--message', '## Note\nFrom A at the same time.', '--quiet'],
      { home: homeA, cwd: projA });
    const b = wingman(['save', '--agent', 'codex', '--message', '## Note\nFrom B at the same time.', '--quiet'],
      { home: homeB, cwd: projB });
    assert.equal(a.code, 0, a.all);
    assert.equal(b.code, 0, b.all);

    const syncA = wingman(['sync'], { home: homeA, cwd: projA });
    const syncB = wingman(['sync'], { home: homeB, cwd: projB });
    assert.equal(syncA.code, 0, syncA.all);
    assert.equal(syncB.code, 0, syncB.all);
    assert.ok(!/conflict/i.test(syncA.all + syncB.all), `unexpected conflict:\n${syncA.all}\n${syncB.all}`);

    wingman(['sync'], { home: homeA, cwd: projA });
    const out = wingman(['load'], { home: homeA, cwd: projA }).stdout;
    assert.match(out, /From A at the same time/);
    assert.match(out, /From B at the same time/, 'both writes must survive');
  });

  test('each machine wrote only into its own journal folder', () => {
    const store = path.join(homeA, 'store', 'projects');
    const pid = fs.readdirSync(store)[0];
    const journal = path.join(store, pid, 'journal');
    const folders = fs.readdirSync(journal).sort();
    assert.equal(folders.length, 2, `expected two journal folders, got ${folders.join(', ')}`);
    // Folder names are <display-name>--<fingerprint4>, unique per machine.
    for (const f of folders) assert.match(f, /^pc-(casa|trabajo)--[0-9a-f]{4}$/, `unexpected folder: ${f}`);
    for (const folder of folders) {
      const display = folder.replace(/--[0-9a-f]{4}$/, '');
      for (const entry of fs.readdirSync(path.join(journal, folder))) {
        const meta = fs.readFileSync(path.join(journal, folder, entry), 'utf8');
        assert.match(meta, new RegExp(`device: ${display}`), `${folder}/${entry} written by the wrong device`);
      }
    }
  });

  test('status and devices reflect both machines', () => {
    const status = wingman(['status'], { home: homeA, cwd: projA });
    assert.equal(status.code, 0, status.all);
    assert.match(status.all, /pc-trabajo/);

    const devices = wingman(['devices'], { home: homeA, cwd: projA });
    assert.match(devices.all, /pc-trabajo/);
    assert.match(devices.all, /pc-casa/);
  });
});

describe('safety and failure modes', () => {
  let home, proj;

  before(() => {
    home = path.join(ROOT, 'safety', '.wingman');
    proj = path.join(ROOT, 'safety', 'plainfolder');
    fs.mkdirSync(home, { recursive: true });
    fs.mkdirSync(proj, { recursive: true });
  });

  test('works in a folder with no git at all', () => {
    const res = wingman(['init', '--yes', '--local', '--name', 'no-git-project', '--device', 'solo'],
      { home, cwd: proj });
    assert.equal(res.code, 0, res.all);
    assert.match(res.all, /no-git-project/);
  });

  test('secrets are redacted before they ever reach disk', () => {
    const secret = 'ghp_' + 'a'.repeat(36);
    const res = wingman(['save', '--agent', 'test', '--message', `## Note\ntoken is ${secret}`],
      { home, cwd: proj });
    assert.equal(res.code, 0, res.all);
    assert.match(res.all, /Redacted/i);

    const found = spawnSync('grep', ['-r', secret, path.join(home, 'store')], { encoding: 'utf8' });
    assert.notEqual(found.status, 0, 'the raw secret must not exist anywhere in the store');

    const loaded = wingman(['load'], { home, cwd: proj }).stdout;
    assert.ok(!loaded.includes(secret));
    assert.match(loaded, /redacted-by-wingman/);
  });

  test('refuses to save an empty entry with a useful hint', () => {
    const res = wingman(['save', '--message', '   '], { home, cwd: proj });
    assert.equal(res.code, 1);
    assert.match(res.all, /Nothing to save|empty/i);
    assert.match(res.all, /template|stdin|message/i);
  });

  test('load outside any project is quiet and non-fatal', () => {
    const outside = path.join(ROOT, 'safety', 'elsewhere');
    fs.mkdirSync(outside, { recursive: true });
    const res = wingman(['load'], { home, cwd: outside });
    assert.equal(res.code, 1);
    assert.match(res.all, /not a Wingman project/i);
  });

  test('hook mode never fails, even outside a project', () => {
    const outside = path.join(ROOT, 'safety', 'elsewhere');
    const res = wingman(['load', '--hook', '--quiet'], { home, cwd: outside });
    assert.equal(res.code, 0, 'a hook must never break the agent session');
    assert.equal(res.stdout.trim(), '');
  });

  test('autosave never fails, with or without a hook payload', () => {
    const withPayload = wingman(['autosave', '--agent', 'test', '--hook'],
      { home, cwd: proj, input: JSON.stringify({ cwd: proj, hook_event_name: 'SessionEnd' }) });
    assert.equal(withPayload.code, 0, withPayload.all);

    const garbage = wingman(['autosave', '--agent', 'test', '--hook'], { home, cwd: proj, input: 'not json{{' });
    assert.equal(garbage.code, 0, garbage.all);
  });

  test('unknown command exits 1 and suggests a real one', () => {
    const res = wingman(['stauts'], { home, cwd: proj });
    assert.equal(res.code, 1);
    assert.match(res.all, /Unknown command/);
    assert.match(res.all, /wingman status/);
  });

  test('a broken store remote degrades to local instead of crashing', () => {
    const cfgPath = path.join(home, 'config.json');
    const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
    cfg.syncEnabled = true;
    cfg.storeRepo = 'nobody/nothing';
    fs.writeFileSync(cfgPath, JSON.stringify(cfg));
    git(['remote', 'add', 'origin', path.join(ROOT, 'does-not-exist.git')], path.join(home, 'store'));

    const res = wingman(['save', '--agent', 'test', '--message', '## Note\nStill works offline.'],
      { home, cwd: proj });
    assert.equal(res.code, 0, 'saving must succeed even when the remote is unreachable');
    assert.match(res.all, /Saved to/);

    const loaded = wingman(['load'], { home, cwd: proj }).stdout;
    assert.match(loaded, /Still works offline/);
  });

  test('two concurrent saves both land', async () => {
    const runs = [1, 2, 3].map((n) => new Promise((resolve) => {
      resolve(wingman(['save', '--agent', 'test', '--message', `## Note\nconcurrent-${n}`, '--quiet'],
        { home, cwd: proj }));
    }));
    const results = await Promise.all(runs);
    for (const r of results) assert.equal(r.code, 0, r.all);
    const loaded = wingman(['load', '--recent', '20'], { home, cwd: proj }).stdout;
    for (const n of [1, 2, 3]) assert.match(loaded, new RegExp(`concurrent-${n}`));
  });

  test('doctor reports without throwing', () => {
    const res = wingman(['doctor'], { home, cwd: proj });
    assert.ok(res.code === 0 || res.code === 1, `unexpected exit ${res.code}`);
    assert.match(res.all, /wingman doctor/);
    assert.match(res.all, /Node 18\+/);
  });

  test('projects and template produce output', () => {
    assert.match(wingman(['projects'], { home, cwd: proj }).all, /no-git-project/);
    const tpl = wingman(['template'], { home, cwd: proj });
    assert.equal(tpl.code, 0);
    assert.match(tpl.stdout, /## Next concrete step/);
  });
});

describe('MCP server', () => {
  test('speaks JSON-RPC and lists its tools', async () => {
    const home = path.join(ROOT, 'mcp', '.wingman');
    const proj = path.join(ROOT, 'mcp', 'project');
    fs.mkdirSync(home, { recursive: true });
    fs.mkdirSync(proj, { recursive: true });
    wingman(['init', '--yes', '--local', '--name', 'mcp-project', '--device', 'mcpbox'], { home, cwd: proj });
    wingman(['save', '--agent', 'test', '--message', '## Goal\nProve MCP works.'], { home, cwd: proj });

    const server = path.resolve(HERE, '..', 'mcp', 'server.mjs');
    const requests = [
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05' } },
      { jsonrpc: '2.0', id: 2, method: 'tools/list' },
      { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'wingman_load_context', arguments: {} } },
      { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'wingman_handoff_template', arguments: {} } },
      { jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'nope', arguments: {} } },
    ].map((r) => JSON.stringify(r)).join('\n') + '\n';

    const res = spawnSync(process.execPath, [server], {
      input: requests,
      encoding: 'utf8',
      timeout: 30000,
      cwd: proj,
      env: { ...process.env, WINGMAN_HOME: home, HOME: path.join(ROOT, 'fakehome'), NO_COLOR: '1' },
    });

    const lines = res.stdout.trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
    const byId = Object.fromEntries(lines.map((l) => [l.id, l]));

    assert.equal(byId[1].result.serverInfo.name, 'wingman');
    assert.ok(byId[2].result.tools.length >= 4);
    assert.ok(byId[2].result.tools.every((t) => t.name && t.description && t.inputSchema));
    assert.match(byId[3].result.content[0].text, /Prove MCP works/);
    assert.match(byId[4].result.content[0].text, /Next concrete step/);
    assert.ok(byId[5].error, 'unknown tool must return an error, not crash');
  });
});
