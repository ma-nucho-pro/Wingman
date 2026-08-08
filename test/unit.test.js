import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { redact, hasSecrets, MASK } from '../src/redact.js';
import {
  normalizeRemote, repoSlugFromRemote, makeProjectId, isValidProjectId,
  isValidDeviceId, hashId,
} from '../src/identity.js';
import { serializeEntry, parseEntry } from '../src/journal.js';
import { extractProjectTag, projectTag } from '../src/render.js';
import { slugify, stamp, parseStamp, relativeTime, truncate } from '../src/util.js';
import { parseArgs } from '../bin/wingman.mjs';

describe('redact', () => {
  test('catches provider tokens', () => {
    const cases = [
      ['github', 'token is ghp_' + 'a'.repeat(36) + ' ok'],
      ['github pat', 'github_pat_' + 'A1b2'.repeat(8)],
      ['anthropic', 'key sk-ant-api03-' + 'x9'.repeat(20)],
      ['openai', 'OPENAI sk-proj-' + 'Ab3d'.repeat(12)],
      ['aws', 'AKIAIOSFODNN7EXAMPLE'],
      ['google', 'AIza' + 'B'.repeat(35)],
      ['slack', 'xoxb-123456789012-abcdefghijkl'],
      ['stripe', 'sk_live_' + 'Zz9'.repeat(9)],
      ['gitlab', 'glpat-' + 'q'.repeat(24)],
      ['npm', 'npm_' + 'k'.repeat(36)],
    ];
    for (const [label, input] of cases) {
      const { text, findings } = redact(input);
      assert.ok(findings.length > 0, `${label}: expected a finding`);
      assert.ok(text.includes('[redacted-by-wingman'), `${label}: expected mask in output`);
      // The mask must say what kind of credential it replaced, so the next tool
      // knows one exists and where to look for the real value.
      assert.match(text, /\[redacted-by-wingman: [a-z-]+\]/, `${label}: mask should name the type`);
    }
  });

  test('catches private key blocks whole', () => {
    const key = '-----BEGIN RSA PRIVATE KEY-----\nMIIEow\nlines\n-----END RSA PRIVATE KEY-----';
    const { text, findings } = redact(`before\n${key}\nafter`);
    assert.equal(findings.filter((f) => f.type === 'private-key').length, 1);
    assert.ok(!text.includes('MIIEow'));
    assert.ok(text.includes('before') && text.includes('after'));
  });

  test('catches credentials in URLs but keeps the host', () => {
    const { text, findings } = redact('git clone https://bob:s3cretpassword@github.com/o/r.git');
    assert.ok(findings.some((f) => f.type === 'url-credentials'));
    assert.ok(text.includes('github.com/o/r.git'));
    assert.ok(text.includes('bob'));
    assert.ok(!text.includes('s3cretpassword'));
  });

  test('catches assigned secrets', () => {
    const { text } = redact('DATABASE_PASSWORD=hunter2hunter2\nAPI_KEY: "abc123def456ghi"');
    assert.ok(!text.includes('hunter2hunter2'));
    assert.ok(!text.includes('abc123def456ghi'));
    assert.ok(text.includes('DATABASE_PASSWORD='));
  });

  test('leaves placeholders and ordinary prose alone', () => {
    const safe = [
      'API_KEY=<your-key-here>',
      'SECRET=${MY_SECRET}',
      'PASSWORD=changeme',
      'API_KEY=xxxxxxxxxx',
      'We decided to use RS256 instead of HS256 for the mobile clients.',
      'Run npm install and then npm test.',
      'The function returns a promise that resolves to the parsed body.',
    ];
    for (const s of safe) {
      assert.equal(hasSecrets(s), false, `should not flag: ${s}`);
    }
  });

  test('is idempotent', () => {
    const once = redact('ghp_' + 'a'.repeat(36)).text;
    const twice = redact(once).text;
    assert.equal(once, twice);
  });

  test('an assigned secret keeps its variable name visible', () => {
    const { text } = redact('STRIPE_SECRET_KEY=sk_live_' + 'Zz9'.repeat(9));
    assert.match(text, /^STRIPE_SECRET_KEY=/, 'the variable name is the useful half');
    assert.ok(!text.includes('Zz9Zz9'), 'the value must be gone');
  });

  test('handles empty and non-string input', () => {
    assert.deepEqual(redact('').findings, []);
    assert.deepEqual(redact(null).findings, []);
    assert.equal(redact(undefined).text, '');
  });
});

describe('normalizeRemote', () => {
  const same = [
    'git@github.com:User/Repo.git',
    'https://github.com/User/Repo.git',
    'https://github.com/user/repo',
    'ssh://git@github.com/User/Repo.git',
    'ssh://git@github.com:22/User/Repo',
    'git://github.com/user/repo.git',
    'https://token@github.com/User/Repo.git',
    'https://github.com/User/Repo/',
  ];
  test('all github spellings collapse to one identity', () => {
    const ids = new Set(same.map((u) => normalizeRemote(u)));
    assert.equal(ids.size, 1, `got: ${[...ids].join(' | ')}`);
    assert.equal([...ids][0], 'github.com/user/repo');
  });

  test('distinguishes different repos and hosts', () => {
    assert.notEqual(normalizeRemote('git@github.com:a/b.git'), normalizeRemote('git@github.com:a/c.git'));
    assert.notEqual(normalizeRemote('git@github.com:a/b.git'), normalizeRemote('git@gitlab.com:a/b.git'));
  });

  test('handles self-hosted and nested groups', () => {
    assert.equal(normalizeRemote('git@git.corp.internal:team/sub/app.git'), 'git.corp.internal/team/sub/app');
    assert.equal(normalizeRemote('https://git.corp.internal:8443/team/app.git'), 'git.corp.internal/team/app');
  });

  test('rejects garbage', () => {
    for (const bad of ['', null, undefined, 'not-a-url', '   ', 'github.com']) {
      assert.equal(normalizeRemote(bad), null, `should reject: ${JSON.stringify(bad)}`);
    }
  });
});

describe('project identity', () => {
  test('id is stable, valid, and unique per remote', () => {
    const a = makeProjectId('github.com/user/repo', 'repo');
    const b = makeProjectId('github.com/user/repo', 'repo');
    const c = makeProjectId('github.com/user/other', 'other');
    assert.equal(a, b);
    assert.notEqual(a, c);
    assert.ok(isValidProjectId(a), a);
  });

  test('slug survives awkward names', () => {
    assert.equal(repoSlugFromRemote('github.com/u/My_Cool.App'), 'my-cool-app');
    assert.equal(slugify('Проект 2024'), '2024');
    assert.equal(slugify('café-münchen'), 'cafe-munchen');
    assert.equal(slugify('!!!'), 'untitled');
  });

  test('id validation rejects malformed input', () => {
    for (const bad of ['', 'abc', 'ZZZZZZZZZZZZ-name', 'a3f9c21b8e04', 'a3f9c21b8e04-UPPER', null]) {
      assert.equal(isValidProjectId(bad), false, `should reject: ${bad}`);
    }
    assert.ok(isValidProjectId('a3f9c21b8e04-my-app'));
  });

  test('device id validation', () => {
    assert.ok(isValidDeviceId('pc-trabajo'));
    assert.ok(isValidDeviceId('mac'));
    assert.equal(isValidDeviceId('PC-Trabajo'), false);
    assert.equal(isValidDeviceId('-leading'), false);
    assert.equal(isValidDeviceId('a'.repeat(40)), false);
    assert.equal(isValidDeviceId(''), false);
  });

  test('hash is deterministic and short', () => {
    assert.equal(hashId('x').length, 12);
    assert.equal(hashId('x'), hashId('x'));
  });
});

describe('journal front matter', () => {
  test('round-trips', () => {
    const meta = { agent: 'codex', device: 'pc-casa', project: 'a3f9c21b8e04-app', at: '2026-08-05T00:18:00.000Z', title: 'Fix clock skew' };
    const body = '## Goal\nMigrate auth.\n\n## Next\nFix verify.ts:42\n';
    const parsed = parseEntry(serializeEntry(meta, body));
    assert.equal(parsed.meta.agent, 'codex');
    assert.equal(parsed.meta.title, 'Fix clock skew');
    assert.ok(parsed.body.startsWith('## Goal'));
    assert.ok(parsed.body.includes('verify.ts:42'));
  });

  test('tolerates missing or broken front matter', () => {
    assert.equal(parseEntry('just a body').body, 'just a body');
    assert.deepEqual(parseEntry('just a body').meta, {});
    const unterminated = '---\nagent: x\nstill going';
    assert.equal(parseEntry(unterminated).body, unterminated);
  });

  test('strips newlines from metadata values so front matter cannot be broken', () => {
    const out = serializeEntry({ title: 'line one\nline two' }, 'body');
    assert.equal(out.split('---')[1].trim(), 'title: line one line two');
    assert.equal(parseEntry(out).meta.title, 'line one line two');
  });

  test('body containing --- does not confuse the parser', () => {
    const body = 'before\n---\nafter\n';
    const parsed = parseEntry(serializeEntry({ agent: 'x' }, body));
    assert.equal(parsed.meta.agent, 'x');
    assert.ok(parsed.body.includes('before'));
    assert.ok(parsed.body.includes('after'));
  });
});

describe('project tag', () => {
  test('survives a round trip through pasted text', () => {
    const id = 'a3f9c21b8e04-my-app';
    const pasted = `Sure, here is my answer.\n\n<!-- ${projectTag(id)} -->\n\nSome more text.`;
    assert.equal(extractProjectTag(pasted), id);
  });

  test('is case-insensitive and ignores noise', () => {
    assert.equal(extractProjectTag('WINGMAN: A3F9C21B8E04-APP'), 'a3f9c21b8e04-app');
    assert.equal(extractProjectTag('no tag here'), null);
    assert.equal(extractProjectTag(''), null);
    assert.equal(extractProjectTag(null), null);
  });

  test('rejects a malformed id', () => {
    assert.equal(extractProjectTag('wingman: not-an-id'), null);
  });
});

describe('time helpers', () => {
  test('stamp is filesystem-safe and sorts chronologically', () => {
    const a = stamp(new Date('2026-08-05T00:18:42.000Z'));
    const b = stamp(new Date('2026-08-05T09:02:00.000Z'));
    assert.equal(a, '2026-08-05T00-18-42Z');
    assert.ok(a < b, 'lexicographic order must match chronological order');
    assert.ok(!/[:*?"<>|]/.test(a), 'must be safe on Windows');
  });

  test('stamp parses back', () => {
    const d = new Date('2026-08-05T00:18:42.000Z');
    assert.equal(parseStamp(stamp(d) + '--codex.md').toISOString(), d.toISOString());
    assert.equal(parseStamp('garbage.md'), null);
  });

  test('relativeTime reads naturally', () => {
    const now = new Date('2026-08-05T12:00:00Z');
    assert.equal(relativeTime(new Date('2026-08-05T11:59:30Z'), now), 'just now');
    assert.equal(relativeTime(new Date('2026-08-05T11:30:00Z'), now), '30m ago');
    assert.equal(relativeTime(new Date('2026-08-04T12:00:00Z'), now), '24h ago');
    assert.equal(relativeTime(new Date('2026-07-05T12:00:00Z'), now), '31d ago');
  });

  test('truncate never exceeds the budget', () => {
    const long = 'x'.repeat(5000);
    const out = truncate(long, 100);
    assert.ok(out.length <= 100, `got ${out.length}`);
    assert.equal(truncate('short', 100), 'short');
  });
});

describe('argument parsing', () => {
  test('handles flags, values, equals form and positionals', () => {
    const a = parseArgs(['save', '--agent', 'codex', '--title=Fix auth', '--pin', 'extra']);
    assert.deepEqual(a._, ['save', 'extra']);
    assert.equal(a.agent, 'codex');
    assert.equal(a.title, 'Fix auth');
    assert.equal(a.pin, true);
  });

  test('boolean flags do not swallow the next token', () => {
    const a = parseArgs(['load', '--quiet', '--project', 'app']);
    assert.equal(a.quiet, true);
    assert.equal(a.project, 'app');
  });

  test('a value flag at the end does not crash', () => {
    const a = parseArgs(['save', '--title']);
    assert.equal(a.title, true);
  });

  test('short flags map correctly', () => {
    const a = parseArgs(['save', '-m', 'hello', '-p', 'app', '-q']);
    assert.equal(a.message, 'hello');
    assert.equal(a.project, 'app');
    assert.equal(a.quiet, true);
  });

  test('-- passes the rest through untouched', () => {
    const a = parseArgs(['save', '--', '--not-a-flag']);
    assert.deepEqual(a._, ['save', '--not-a-flag']);
  });
});
