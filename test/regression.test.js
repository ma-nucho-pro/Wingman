import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PKG = path.resolve(HERE, '..');

let ROOT;

function wingman(cli, args, { home, cwd, input } = {}) {
  const res = spawnSync(process.execPath, [cli, ...args], {
    cwd, encoding: 'utf8', input, timeout: 60000,
    env: {
      ...process.env,
      WINGMAN_HOME: home,
      HOME: path.join(ROOT, 'fakehome'),
      USERPROFILE: path.join(ROOT, 'fakehome'),
      NO_COLOR: '1',
      GIT_TERMINAL_PROMPT: '0',
    },
  });
  return { code: res.status, stdout: res.stdout || '', stderr: res.stderr || '', all: (res.stdout || '') + (res.stderr || '') };
}

function git(args, cwd) {
  return spawnSync('git', ['-c', 'user.name=T', '-c', 'user.email=t@t', ...args], { cwd, encoding: 'utf8' });
}

before(() => {
  ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'wingman-reg-'));
  fs.mkdirSync(path.join(ROOT, 'fakehome'), { recursive: true });
});
after(() => { try { fs.rmSync(ROOT, { recursive: true, force: true }); } catch { /* best effort */ } });

describe('runtime survives an npx cache being deleted', () => {
  let cacheDir, home, proj;

  before(() => {
    // Simulate `npx wingman-ai`: the package lives in a throwaway cache dir.
    cacheDir = path.join(ROOT, 'npx-cache', 'node_modules', 'wingman-ai');
    fs.mkdirSync(cacheDir, { recursive: true });
    for (const item of ['bin', 'src', 'mcp', 'package.json']) {
      fs.cpSync(path.join(PKG, item), path.join(cacheDir, item), { recursive: true });
    }
    home = path.join(ROOT, 'npxrun', '.wingman');
    proj = path.join(ROOT, 'npxrun', 'app');
    fs.mkdirSync(home, { recursive: true });
    fs.mkdirSync(proj, { recursive: true });
  });

  test('init from a cache dir vendors the runtime to a stable path', () => {
    const res = wingman(path.join(cacheDir, 'bin', 'wingman.mjs'),
      ['init', '--yes', '--local', '--name', 'npx-app', '--device', 'npxbox'],
      { home, cwd: proj });
    assert.equal(res.code, 0, res.all);
    assert.ok(fs.existsSync(path.join(home, 'runtime', 'bin', 'wingman.mjs')),
      'runtime should be copied into WINGMAN_HOME');
    assert.match(res.all, /Runtime pinned/);
  });

  test('the vendored runtime still works after the cache is deleted', () => {
    wingman(path.join(cacheDir, 'bin', 'wingman.mjs'),
      ['save', '--agent', 'test', '--message', '## Note\nsurvives npx cleanup'],
      { home, cwd: proj });

    fs.rmSync(path.join(ROOT, 'npx-cache'), { recursive: true, force: true });
    assert.ok(!fs.existsSync(cacheDir), 'cache should be gone');

    const res = wingman(path.join(home, 'runtime', 'bin', 'wingman.mjs'), ['load'], { home, cwd: proj });
    assert.equal(res.code, 0, res.all);
    assert.match(res.stdout, /survives npx cleanup/);
  });

  test('hooks written into agent config point at the vendored path', () => {
    const settings = path.join(ROOT, 'fakehome', '.claude', 'settings.json');
    if (!fs.existsSync(settings)) return;   // Claude Code not simulated on this run
    const json = JSON.parse(fs.readFileSync(settings, 'utf8'));
    const commands = JSON.stringify(json.hooks || {});
    assert.ok(commands.includes(path.join(home, 'runtime')),
      `hooks should reference the vendored runtime, got: ${commands}`);
  });
});

describe('store on a non-main default branch', () => {
  let home, proj, bare;

  before(() => {
    home = path.join(ROOT, 'master', '.wingman');
    proj = path.join(ROOT, 'master', 'app');
    bare = path.join(ROOT, 'master', 'remote.git');
    fs.mkdirSync(home, { recursive: true });
    fs.mkdirSync(proj, { recursive: true });
    spawnSync('git', ['init', '--bare', '-b', 'master', bare], { encoding: 'utf8' });

    // Seed the remote so origin/HEAD resolves to master.
    const seed = path.join(ROOT, 'master', 'seed');
    fs.mkdirSync(seed, { recursive: true });
    git(['init', '-b', 'master'], seed);
    fs.writeFileSync(path.join(seed, 'README.md'), '# store\n');
    git(['add', '-A'], seed);
    git(['commit', '-m', 'seed'], seed);
    git(['remote', 'add', 'origin', bare], seed);
    git(['push', '-u', 'origin', 'master'], seed);
  });

  test('syncs against master without assuming main', () => {
    const cli = path.join(PKG, 'bin', 'wingman.mjs');
    let res = wingman(cli, ['init', '--yes', '--local', '--name', 'master-app', '--device', 'masterbox'],
      { home, cwd: proj });
    assert.equal(res.code, 0, res.all);

    const store = path.join(home, 'store');
    git(['remote', 'add', 'origin', bare], store);
    const cfgPath = path.join(home, 'config.json');
    const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
    cfg.syncEnabled = true;
    fs.writeFileSync(cfgPath, JSON.stringify(cfg));

    res = wingman(cli, ['save', '--agent', 'test', '--message', '## Note\non master branch'],
      { home, cwd: proj });
    assert.equal(res.code, 0, res.all);

    const log = git(['log', '--oneline', 'master'], bare).stdout;
    assert.ok(log.trim().length > 0, 'commits should land on master');

    const branches = git(['branch', '--list'], bare).stdout;
    assert.ok(!/\bmain\b/.test(branches), `should not have created a stray main branch:\n${branches}`);
  });
});

describe('idempotency', () => {
  test('running init twice changes nothing and never errors', () => {
    const home = path.join(ROOT, 'idem', '.wingman');
    const proj = path.join(ROOT, 'idem', 'app');
    fs.mkdirSync(home, { recursive: true });
    fs.mkdirSync(proj, { recursive: true });
    const cli = path.join(PKG, 'bin', 'wingman.mjs');

    const first = wingman(cli, ['init', '--yes', '--local', '--name', 'idem-app', '--device', 'idembox'], { home, cwd: proj });
    assert.equal(first.code, 0, first.all);
    const idAfterFirst = JSON.parse(fs.readFileSync(path.join(proj, '.wingman', 'project.json'), 'utf8')).id;

    for (let i = 0; i < 3; i++) {
      const again = wingman(cli, ['init', '--yes', '--local', '--device', 'idembox'], { home, cwd: proj });
      assert.equal(again.code, 0, again.all);
    }

    const idAfter = JSON.parse(fs.readFileSync(path.join(proj, '.wingman', 'project.json'), 'utf8')).id;
    assert.equal(idAfter, idAfterFirst, 'project id must be stable across re-inits');

    const excludeFile = path.join(proj, '.git', 'info', 'exclude');
    if (fs.existsSync(excludeFile)) {
      const lines = fs.readFileSync(excludeFile, 'utf8').split('\n').filter((l) => l.trim() === '.wingman/');
      assert.equal(lines.length, 1, 'exclude entry must not be duplicated');
    }
  });

  test('install can be run repeatedly without duplicating hooks', () => {
    const home = path.join(ROOT, 'idem2', '.wingman');
    const proj = path.join(ROOT, 'idem2', 'app');
    fs.mkdirSync(home, { recursive: true });
    fs.mkdirSync(proj, { recursive: true });
    const cli = path.join(PKG, 'bin', 'wingman.mjs');

    wingman(cli, ['init', '--yes', '--local', '--name', 'idem2', '--device', 'idem2box'], { home, cwd: proj });
    for (let i = 0; i < 3; i++) {
      wingman(cli, ['install', '--agent', 'claude-code'], { home, cwd: proj });
    }

    const settings = path.join(ROOT, 'fakehome', '.claude', 'settings.json');
    const json = JSON.parse(fs.readFileSync(settings, 'utf8'));
    for (const [event, groups] of Object.entries(json.hooks || {})) {
      const wingmanGroups = groups.filter((g) => JSON.stringify(g).includes('wingman.mjs'));
      assert.equal(wingmanGroups.length, 1, `${event} should have exactly one Wingman hook, found ${wingmanGroups.length}`);
    }
  });

  test('existing user hooks are preserved, not overwritten', () => {
    const settingsDir = path.join(ROOT, 'fakehome2', '.claude');
    fs.mkdirSync(settingsDir, { recursive: true });
    const settings = path.join(settingsDir, 'settings.json');
    fs.writeFileSync(settings, JSON.stringify({
      theme: 'dark',
      hooks: { SessionStart: [{ hooks: [{ type: 'command', command: 'echo mine' }] }] },
    }, null, 2));

    const home = path.join(ROOT, 'preserve', '.wingman');
    const proj = path.join(ROOT, 'preserve', 'app');
    fs.mkdirSync(home, { recursive: true });
    fs.mkdirSync(proj, { recursive: true });

    const res = spawnSync(process.execPath,
      [path.join(PKG, 'bin', 'wingman.mjs'), 'init', '--yes', '--local', '--name', 'preserve', '--device', 'pbox'],
      {
        cwd: proj, encoding: 'utf8', timeout: 60000,
        env: { ...process.env, WINGMAN_HOME: home, HOME: path.join(ROOT, 'fakehome2'), USERPROFILE: path.join(ROOT, 'fakehome2'), NO_COLOR: '1' },
      });
    assert.equal(res.status, 0, (res.stdout || '') + (res.stderr || ''));

    const json = JSON.parse(fs.readFileSync(settings, 'utf8'));
    assert.equal(json.theme, 'dark', 'unrelated settings must survive');
    const startCommands = JSON.stringify(json.hooks.SessionStart);
    assert.ok(startCommands.includes('echo mine'), 'the user\'s own hook must survive');
    assert.ok(startCommands.includes('wingman.mjs'), 'ours must be added alongside');

    const backups = fs.readdirSync(settingsDir).filter((f) => f.includes('wingman-backup'));
    assert.ok(backups.length >= 1, 'a backup must be written before touching settings.json');
  });
});

describe('device name collisions', () => {
  test('two machines with the same name still get separate, syncing journals', () => {
    const cli = path.join(PKG, 'bin', 'wingman.mjs');
    const bare = path.join(ROOT, 'collide', 'remote.git');
    fs.mkdirSync(path.dirname(bare), { recursive: true });
    spawnSync('git', ['init', '--bare', '-b', 'main', bare], { encoding: 'utf8' });

    const originProject = path.join(ROOT, 'collide', 'shared.git');
    spawnSync('git', ['init', '--bare', '-b', 'main', originProject], { encoding: 'utf8' });

    const machines = ['one', 'two'].map((tag) => {
      const home = path.join(ROOT, 'collide', tag, '.wingman');
      const proj = path.join(ROOT, 'collide', tag, 'app');
      const fake = path.join(ROOT, 'collide', tag, 'home');
      fs.mkdirSync(home, { recursive: true });
      fs.mkdirSync(proj, { recursive: true });
      fs.mkdirSync(fake, { recursive: true });
      git(['init', '-b', 'main'], proj);
      git(['remote', 'add', 'origin', originProject], proj);
      fs.writeFileSync(path.join(proj, 'f.txt'), tag);
      git(['add', '-A'], proj);
      git(['commit', '-m', 'x'], proj);
      return { home, proj, fake };
    });

    const runAs = (m, args) => spawnSync(process.execPath, [cli, ...args], {
      cwd: m.proj, encoding: 'utf8', timeout: 60000,
      env: { ...process.env, WINGMAN_HOME: m.home, HOME: m.fake, USERPROFILE: m.fake, NO_COLOR: '1', GIT_TERMINAL_PROMPT: '0' },
    });

    // Both machines ask to be called "laptop".
    for (const m of machines) {
      const r = runAs(m, ['init', '--yes', '--local', '--device', 'laptop']);
      assert.equal(r.status, 0, (r.stdout || '') + (r.stderr || ''));
      const store = path.join(m.home, 'store');
      git(['remote', 'add', 'origin', bare], store);
      const cfgPath = path.join(m.home, 'config.json');
      const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
      cfg.syncEnabled = true;
      fs.writeFileSync(cfgPath, JSON.stringify(cfg));
    }

    runAs(machines[0], ['save', '--agent', 'a', '--message', '## Note\nfrom machine one', '--quiet']);
    runAs(machines[1], ['sync']);
    // Re-running init must not disable the sync that was already turned on.
    const second = runAs(machines[1], ['init', '--yes', '--local', '--device', 'laptop']);
    assert.equal(second.status, 0, (second.stdout || '') + (second.stderr || ''));
    assert.match((second.stdout || '') + (second.stderr || ''), /also calls itself/i,
      'the duplicate name should be pointed out, without breaking anything');

    runAs(machines[1], ['save', '--agent', 'b', '--message', '## Note\nfrom machine two', '--quiet']);
    runAs(machines[0], ['sync']);
    runAs(machines[1], ['sync']);
    runAs(machines[0], ['sync']);

    const out = runAs(machines[0], ['load']).stdout || '';
    assert.match(out, /from machine one/);
    assert.match(out, /from machine two/, 'the renamed machine\'s entries must still arrive');

    const store = path.join(machines[0].home, 'store', 'projects');
    const pid = fs.readdirSync(store)[0];
    const devices = fs.readdirSync(path.join(store, pid, 'journal')).sort();
    assert.equal(devices.length, 2, `two same-named machines must still get separate folders, got ${devices.join(', ')}`);
    for (const d of devices) assert.match(d, /^laptop--[0-9a-f]{4}$/, `unexpected folder: ${d}`);
    assert.equal(new Set(devices).size, 2, 'the two folders must be distinct');
  });
});

describe('local vault', () => {
  let home, proj, cli;

  before(() => {
    cli = path.join(PKG, 'bin', 'wingman.mjs');
    home = path.join(ROOT, 'vault', '.wingman');
    proj = path.join(ROOT, 'vault', 'app');
    fs.mkdirSync(home, { recursive: true });
    fs.mkdirSync(proj, { recursive: true });
    const r = wingman(cli, ['init', '--yes', '--local', '--name', 'vault-app', '--device', 'vaultbox'], { home, cwd: proj });
    assert.equal(r.code, 0, r.all);
  });

  test('vault content reaches the agent verbatim, secrets included', () => {
    const secret = 'ghp_' + 'v'.repeat(36);
    const set = wingman(cli, ['vault', '--message', `The deploy token is ${secret}`], { home, cwd: proj });
    assert.equal(set.code, 0, set.all);
    assert.match(set.all, /NOT redacted/i, 'the user must be warned that vault content is stored as-is');

    const loaded = wingman(cli, ['load'], { home, cwd: proj }).stdout;
    assert.ok(loaded.includes(secret), 'vault content must not be redacted — that is its purpose');
    assert.match(loaded, /this machine only/i);
  });

  test('vault content never enters the store or any commit', () => {
    const secret = 'ghp_' + 'v'.repeat(36);
    const store = path.join(home, 'store');

    const onDisk = spawnSync('grep', ['-r', secret, store], { encoding: 'utf8' });
    assert.notEqual(onDisk.status, 0, 'vault content must not exist anywhere in the store directory');

    const inHistory = spawnSync('git', ['-C', store, 'log', '-p', '--all'], { encoding: 'utf8' });
    assert.ok(!(inHistory.stdout || '').includes(secret), 'vault content must never appear in git history');

    const tracked = (spawnSync('git', ['-C', store, 'ls-files'], { encoding: 'utf8' }).stdout || '')
      .split('\n').filter(Boolean);
    assert.ok(!tracked.some((f) => f.startsWith('vault/')),
      `no vault path may be tracked, got:\n${tracked.join('\n')}`);
  });

  test('the vault directory is a sibling of the store, not inside it', () => {
    const vaultDir = path.join(home, 'vault');
    const store = path.join(home, 'store');
    assert.ok(fs.existsSync(vaultDir));
    assert.ok(!path.resolve(vaultDir).startsWith(path.resolve(store) + path.sep));
    const doctor = wingman(cli, ['doctor'], { home, cwd: proj });
    assert.match(doctor.all, /vault isolated/);
  });

  test('journal entries are still redacted, unlike the vault', () => {
    const secret = 'ghp_' + 'j'.repeat(36);
    const r = wingman(cli, ['save', '--agent', 'test', '--message', `## Note\ntoken ${secret}`], { home, cwd: proj });
    assert.equal(r.code, 0, r.all);
    assert.match(r.all, /Redacted/i);
    const found = spawnSync('grep', ['-r', secret, path.join(home, 'store')], { encoding: 'utf8' });
    assert.notEqual(found.status, 0);
  });

  test('vault can be cleared', () => {
    const r = wingman(cli, ['vault', '--clear'], { home, cwd: proj });
    assert.equal(r.code, 0, r.all);
    const loaded = wingman(cli, ['load'], { home, cwd: proj }).stdout;
    assert.ok(!/this machine only/i.test(loaded));
  });
});

describe('rolling checkpoints', () => {
  let home, proj, cli;

  before(() => {
    cli = path.join(PKG, 'bin', 'wingman.mjs');
    home = path.join(ROOT, 'rolling', '.wingman');
    proj = path.join(ROOT, 'rolling', 'app');
    fs.mkdirSync(home, { recursive: true });
    fs.mkdirSync(proj, { recursive: true });
    wingman(cli, ['init', '--yes', '--local', '--name', 'rolling-app', '--device', 'rollbox'], { home, cwd: proj });
  });

  function entryCount() {
    const base = path.join(home, 'store', 'projects');
    const pid = fs.readdirSync(base)[0];
    const journal = path.join(base, pid, 'journal');
    if (!fs.existsSync(journal)) return 0;
    return fs.readdirSync(journal)
      .flatMap((d) => fs.readdirSync(path.join(journal, d)))
      .filter((f) => f.endsWith('.md')).length;
  }

  test('the first rolling call writes a checkpoint', () => {
    const before = entryCount();
    const r = wingman(cli, ['autosave', '--agent', 'claude-code', '--hook', '--rolling'],
      { home, cwd: proj, input: JSON.stringify({ cwd: proj }) });
    assert.equal(r.code, 0, r.all);
    assert.equal(entryCount(), before + 1);
  });

  test('rapid repeats are debounced, not one entry per agent turn', () => {
    const before = entryCount();
    for (let i = 0; i < 8; i++) {
      const r = wingman(cli, ['autosave', '--agent', 'claude-code', '--hook', '--rolling'],
        { home, cwd: proj, input: JSON.stringify({ cwd: proj }) });
      assert.equal(r.code, 0, r.all);
    }
    assert.equal(entryCount(), before, 'eight turns inside the interval must produce zero new entries');
  });

  test('a checkpoint exists before the context ever fills, and is loadable', () => {
    const loaded = wingman(cli, ['load'], { home, cwd: proj }).stdout;
    assert.match(loaded, /Rolling checkpoint/);
    assert.match(loaded, /no model call/i, 'checkpoints must be free to produce');
  });

  test('rolling mode still cannot fail an agent session', () => {
    const outside = path.join(ROOT, 'rolling', 'not-a-project');
    fs.mkdirSync(outside, { recursive: true });
    const r = wingman(cli, ['autosave', '--agent', 'x', '--hook', '--rolling'], { home, cwd: outside, input: 'garbage' });
    assert.equal(r.code, 0);
  });
});

describe('every tool is automatic, and no hook can print', () => {
  let home, proj, fake, cli;

  before(() => {
    cli = path.join(PKG, 'bin', 'wingman.mjs');
    home = path.join(ROOT, 'auto', '.wingman');
    proj = path.join(ROOT, 'auto', 'app');
    fake = path.join(ROOT, 'auto', 'home');
    // Make every agent look installed so all four adapters run.
    for (const d of ['.claude', '.codex', '.gemini', '.cursor']) {
      fs.mkdirSync(path.join(fake, d), { recursive: true });
    }
    fs.mkdirSync(home, { recursive: true });
    fs.mkdirSync(proj, { recursive: true });
  });

  const runAs = (args, input) => spawnSync(process.execPath, [cli, ...args], {
    cwd: proj, encoding: 'utf8', timeout: 60000, input,
    env: { ...process.env, WINGMAN_HOME: home, HOME: fake, USERPROFILE: fake, NO_COLOR: '1', GIT_TERMINAL_PROMPT: '0' },
  });

  test('init configures all four tools with real hooks', () => {
    const r = runAs(['init', '--yes', '--local', '--name', 'auto-app', '--device', 'autobox']);
    assert.equal(r.status, 0, (r.stdout || '') + (r.stderr || ''));

    const claude = JSON.parse(fs.readFileSync(path.join(fake, '.claude', 'settings.json'), 'utf8'));
    assert.ok(claude.hooks.SessionStart, 'Claude Code needs SessionStart');
    assert.ok(claude.hooks.Stop, 'Claude Code needs a rolling checkpoint hook');

    const codex = JSON.parse(fs.readFileSync(path.join(fake, '.codex', 'hooks.json'), 'utf8'));
    assert.ok(codex.hooks.SessionStart, 'Codex needs SessionStart');
    assert.ok(codex.hooks.Stop, 'Codex needs Stop');

    const gemini = JSON.parse(fs.readFileSync(path.join(fake, '.gemini', 'settings.json'), 'utf8'));
    assert.ok(gemini.hooks.SessionStart, 'Gemini CLI needs SessionStart');
    assert.ok(gemini.hooks.BeforeAgent, 'Gemini CLI needs BeforeAgent as the reliable fallback');

    const rule = fs.readFileSync(path.join(proj, '.cursor', 'rules', 'wingman.mdc'), 'utf8');
    assert.match(rule, /alwaysApply:\s*true/, 'Cursor rule must apply without being asked');
  });

  test('Codex config.toml is never touched — credentials live there', () => {
    assert.ok(!fs.existsSync(path.join(fake, '.codex', 'config.toml')),
      'Wingman must not create or modify config.toml');
  });

  test('the context file is generated and the pointers reference it', () => {
    runAs(['save', '--agent', 'test', '--message', '## Goal\nProve automatic delivery works.']);
    const ctx = path.join(proj, '.wingman', 'CONTEXT.md');
    assert.ok(fs.existsSync(ctx), 'CONTEXT.md must be generated');
    assert.match(fs.readFileSync(ctx, 'utf8'), /Prove automatic delivery works/);

    for (const f of ['CLAUDE.md', 'AGENTS.md', 'GEMINI.md']) {
      const p = path.join(proj, f);
      assert.ok(fs.existsSync(p), `${f} should point at the context file`);
      assert.match(fs.readFileSync(p, 'utf8'), /\.wingman\/CONTEXT\.md/);
    }
  });

  test('hooks print absolutely nothing — the one thing that breaks Gemini CLI', () => {
    const silent = runAs(['load', '--agent', 'claude-code', '--hook', '--quiet'], JSON.stringify({ cwd: proj }));
    assert.equal(silent.status, 0);
    assert.equal(silent.stdout, '', `hook stdout must be empty, got: ${JSON.stringify(silent.stdout)}`);

    const asJson = runAs(['load', '--agent', 'gemini-cli', '--hook', '--quiet', '--emit', 'json'], JSON.stringify({ cwd: proj }));
    assert.equal(asJson.status, 0);
    assert.doesNotThrow(() => JSON.parse(asJson.stdout), 'JSON mode must emit parseable JSON and nothing else');

    const save = runAs(['autosave', '--agent', 'codex', '--hook', '--quiet', '--emit', 'json'], JSON.stringify({ cwd: proj }));
    assert.equal(save.status, 0);
    assert.doesNotThrow(() => JSON.parse(save.stdout));
  });

  test('the hook refreshes the context file rather than printing it', () => {
    const ctx = path.join(proj, '.wingman', 'CONTEXT.md');
    fs.writeFileSync(ctx, 'stale garbage\n');
    runAs(['load', '--agent', 'claude-code', '--hook', '--quiet'], JSON.stringify({ cwd: proj }));
    const after = fs.readFileSync(ctx, 'utf8');
    assert.ok(!after.includes('stale garbage'), 'the hook must rewrite the file');
    assert.match(after, /Prove automatic delivery works/);
  });

  test('pointers are idempotent and preserve the team\'s own instructions', () => {
    const claudeMd = path.join(proj, 'CLAUDE.md');
    fs.writeFileSync(claudeMd, '# Our house rules\n\nAlways use tabs.\n');
    for (let i = 0; i < 3; i++) runAs(['install']);
    const content = fs.readFileSync(claudeMd, 'utf8');
    assert.match(content, /Always use tabs/, 'existing instructions must survive');
    assert.equal((content.match(/wingman:context:start/g) || []).length, 1, 'exactly one pointer block');
  });

  test('uninstall removes the pointers and the context file', () => {
    const r = runAs(['uninstall']);
    assert.equal(r.status, 0, (r.stdout || '') + (r.stderr || ''));
    assert.ok(!fs.existsSync(path.join(proj, '.wingman', 'CONTEXT.md')));
    const claudeMd = fs.readFileSync(path.join(proj, 'CLAUDE.md'), 'utf8');
    assert.ok(!claudeMd.includes('wingman:context'));
    assert.match(claudeMd, /Always use tabs/, 'the team\'s own file must be left intact');
  });
});
