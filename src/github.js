import { run, hasBin, logLine } from './util.js';

const API = 'https://api.github.com';
const UA = 'wingman-cli';

/**
 * Detect how (or whether) this machine can talk to GitHub.
 * Ordered cheapest-and-most-capable first. Never prompts, never opens a browser.
 *
 * @returns {{method:'gh'|'https'|'ssh'|'none', login:string|null, token:string|null, detail:string}}
 */
export function detectAuth() {
  if (hasBin('gh')) {
    const status = run('gh', ['auth', 'status'], { timeout: 15000 });
    if (status.ok) {
      const login = parseGhLogin(status.stderr + status.stdout);
      return { method: 'gh', login, token: null, detail: 'GitHub CLI is authenticated' };
    }
  }

  const token = credentialToken();
  if (token) {
    // The login is resolved lazily by whoAmI() so detection stays synchronous
    // and free of network calls.
    return { method: 'https', login: null, token, detail: 'git credential helper' };
  }

  if (hasBin('ssh')) {
    const probe = run('ssh', ['-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=accept-new',
      '-o', 'ConnectTimeout=8', '-T', 'git@github.com'], { timeout: 20000 });
    const out = probe.stdout + probe.stderr;
    const m = out.match(/Hi ([A-Za-z0-9-]+)!\s*You've successfully authenticated/i);
    if (m) return { method: 'ssh', login: m[1], token: null, detail: 'SSH key accepted by GitHub' };
  }

  return { method: 'none', login: null, token: null, detail: 'no GitHub credentials found' };
}

function parseGhLogin(text) {
  const m = String(text).match(/account\s+([A-Za-z0-9-]+)|Logged in to github\.com (?:account )?(?:as )?([A-Za-z0-9-]+)/i);
  return m ? (m[1] || m[2]) : null;
}

/** Ask git's configured credential helper for a github.com token. */
function credentialToken() {
  const res = run('git', ['credential', 'fill'], {
    input: 'protocol=https\nhost=github.com\n\n',
    timeout: 15000,
    env: { GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: 'echo' },
  });
  if (!res.ok) return null;
  const m = res.stdout.match(/^password=(.+)$/m);
  const token = m ? m[1].trim() : null;
  if (!token || token.length < 8) return null;
  return token;
}

async function api(pathname, { token, method = 'GET', body } = {}) {
  const headers = {
    'Accept': 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': UA,
  };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body) headers['Content-Type'] = 'application/json';

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20000);
  try {
    const res = await fetch(`${API}${pathname}`, {
      method, headers,
      body: body ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });
    const text = await res.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { /* non-json error page */ }
    return { status: res.status, ok: res.ok, json, text };
  } catch (err) {
    logLine('github', `api ${pathname}: ${err.message}`);
    return { status: 0, ok: false, json: null, text: String(err.message), offline: true };
  } finally {
    clearTimeout(timer);
  }
}

export async function whoAmI(auth) {
  if (auth.method === 'gh') {
    const res = run('gh', ['api', 'user', '--jq', '.login'], { timeout: 20000 });
    if (res.ok && res.stdout.trim()) return res.stdout.trim();
    return auth.login;
  }
  if (auth.method === 'https' && auth.token) {
    const r = await api('/user', { token: auth.token });
    if (r.ok && r.json?.login) return r.json.login;
    return auth.login;
  }
  if (auth.method === 'ssh') return auth.login;
  return null;
}

export async function repoExists(auth, owner, name) {
  if (auth.method === 'gh') {
    const res = run('gh', ['repo', 'view', `${owner}/${name}`, '--json', 'isPrivate,name'], { timeout: 25000 });
    if (res.ok) {
      try { return { exists: true, isPrivate: !!JSON.parse(res.stdout).isPrivate }; } catch { return { exists: true, isPrivate: null }; }
    }
    if (/could not resolve|network|timeout/i.test(res.stderr)) return { exists: null, offline: true };
    return { exists: false };
  }
  const r = await api(`/repos/${owner}/${name}`, { token: auth.token });
  if (r.offline) return { exists: null, offline: true };
  if (r.status === 404) return { exists: false };
  if (r.ok) return { exists: true, isPrivate: !!r.json?.private };
  return { exists: null, error: r.text?.slice(0, 200) };
}

export async function createPrivateRepo(auth, name, description) {
  if (auth.method === 'gh') {
    const res = run('gh', ['repo', 'create', name, '--private', '--description', description], { timeout: 60000 });
    if (!res.ok) {
      return { ok: false, reason: (res.stderr || res.stdout).trim().slice(0, 400) };
    }
    return { ok: true };
  }
  if (auth.method === 'https' && auth.token) {
    const r = await api('/user/repos', {
      token: auth.token,
      method: 'POST',
      body: { name, description, private: true, auto_init: false, has_issues: false, has_wiki: false, has_projects: false },
    });
    if (r.ok) return { ok: true };
    return { ok: false, reason: r.json?.message || r.text?.slice(0, 200) || `HTTP ${r.status}` };
  }
  return {
    ok: false,
    reason: 'Cannot create a repository over SSH alone.',
    manual: true,
  };
}

/**
 * Hard safety gate. We refuse to push memory into a repository that is public,
 * or whose visibility we could not confirm.
 */
export async function assertPrivate(auth, owner, name) {
  const info = await repoExists(auth, owner, name);
  if (info.offline) return { ok: false, offline: true, reason: 'Could not reach GitHub to verify repo visibility.' };
  if (info.exists === false) return { ok: false, reason: 'Repository does not exist.' };
  if (info.isPrivate === true) return { ok: true };
  if (info.isPrivate === false) {
    return {
      ok: false,
      reason: `${owner}/${name} is PUBLIC. Wingman will not write your context to a public repository.`,
    };
  }
  return { ok: false, reason: 'Could not confirm the repository is private.' };
}

export function remoteUrl(auth, owner, name) {
  if (auth.method === 'ssh') return `git@github.com:${owner}/${name}.git`;
  return `https://github.com/${owner}/${name}.git`;
}

export function loginHint() {
  if (hasBin('gh')) return 'Run:  gh auth login --web';
  if (process.platform === 'darwin') return 'Install the GitHub CLI:  brew install gh   then:  gh auth login --web';
  if (process.platform === 'win32') return 'Install the GitHub CLI:  winget install --id GitHub.cli   then:  gh auth login --web';
  return 'Install the GitHub CLI: https://github.com/cli/cli#installation   then:  gh auth login --web';
}
