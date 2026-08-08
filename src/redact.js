/**
 * Secret redaction.
 *
 * Everything Wingman writes passes through here first. This runs before the
 * file is created, so a redacted secret never touches disk and therefore never
 * reaches git history. Order matters: block patterns (private keys) run before
 * token patterns so we do not shred a key block into fragments.
 */

const PATTERNS = [
  // Multi-line blocks first.
  { name: 'private-key', re: /-----BEGIN[ A-Z]*PRIVATE KEY-----[\s\S]*?-----END[ A-Z]*PRIVATE KEY-----/g },

  // Provider-specific tokens. These have distinctive prefixes, so false positives are rare.
  { name: 'github-pat', re: /\bgithub_pat_[A-Za-z0-9_]{20,}/g },
  { name: 'github-token', re: /\bgh[pousr]_[A-Za-z0-9]{16,}/g },
  { name: 'anthropic-key', re: /\bsk-ant-[A-Za-z0-9\-_]{16,}/g },
  { name: 'openai-key', re: /\bsk-(?:proj-|svcacct-)?[A-Za-z0-9\-_]{20,}/g },
  { name: 'aws-access-key', re: /\b(?:AKIA|ASIA|ABIA|ACCA)[0-9A-Z]{16}\b/g },
  { name: 'google-api-key', re: /\bAIza[0-9A-Za-z\-_]{35}\b/g },
  { name: 'slack-token', re: /\bxox[baprse]-[A-Za-z0-9-]{10,}/g },
  { name: 'stripe-key', re: /\b[rs]k_(?:live|test)_[A-Za-z0-9]{20,}/g },
  { name: 'gitlab-pat', re: /\bglpat-[A-Za-z0-9\-_]{20,}/g },
  { name: 'npm-token', re: /\bnpm_[A-Za-z0-9]{36}\b/g },
  { name: 'digitalocean-token', re: /\bdop_v1_[a-f0-9]{64}\b/g },
  { name: 'hugging-face-token', re: /\bhf_[A-Za-z0-9]{30,}/g },
  { name: 'jwt', re: /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g },

  // Credentials embedded in URLs: https://user:password@host
  { name: 'url-credentials', re: /\b([a-z][a-z0-9+.-]*:\/\/)([^\s/:@]+):([^\s/@]{3,})@/gi, replace: (_m, scheme, user) => `${scheme}${user}:${MASK}@` },

  // Generic assignments. Deliberately last and deliberately narrow: the key name
  // must look like a credential AND the value must be long enough to be one.
  {
    name: 'assigned-secret',
    re: /\b((?:[A-Za-z0-9_]*)?(?:API[_-]?KEY|SECRET(?:[_-]?KEY)?|ACCESS[_-]?TOKEN|AUTH[_-]?TOKEN|PASSWORD|PASSWD|PRIVATE[_-]?KEY|CLIENT[_-]?SECRET)[A-Za-z0-9_]*)(\s*[:=]\s*)(["']?)([^\s"'`,;)]{8,})\3/gi,
    replace: (_m, key, sep, quote) => `${key}${sep}${quote}${MASK}${quote}`,
  },
];

const MASK = '[redacted-by-wingman]';

/**
 * A redaction should still carry its useful half.
 *
 * "There was an Anthropic key here" tells the next tool that a credential
 * exists and which one, so it can look in the right place. The value itself is
 * the only part that must not travel, because git history is permanent.
 */
function maskFor(type) {
  return type === 'url-credentials' ? MASK : `[redacted-by-wingman: ${type}]`;
}

/** Values that look like secrets but are placeholders people paste in docs. */
const ALLOW = [
  /^x{3,}$/i, /^y{3,}$/i, /^\.{3,}$/, /^\*{3,}$/, /^<[^>]+>$/, /^\$\{?[A-Za-z_][A-Za-z0-9_]*\}?$/,
  /^your[-_]/i, /^my[-_]/i, /^example/i, /^changeme/i, /^placeholder/i, /^dummy/i, /^test$/i,
  /^\[redacted-by-wingman(?::[^\]]*)?\]$/,
];

function isPlaceholder(value) {
  const v = String(value).trim();
  if (!v) return true;
  return ALLOW.some((re) => re.test(v));
}

/**
 * @param {string} text
 * @returns {{ text: string, findings: Array<{type: string, count: number}> }}
 */
export function redact(text) {
  if (typeof text !== 'string' || !text) return { text: text || '', findings: [] };
  let out = text;
  const counts = new Map();

  for (const { name, re, replace } of PATTERNS) {
    out = out.replace(re, (...args) => {
      const match = args[0];
      // For the generic assignment rule, skip obvious placeholders.
      if (name === 'assigned-secret' && isPlaceholder(args[4])) return match;
      if (name === 'url-credentials' && isPlaceholder(args[3])) return match;
      counts.set(name, (counts.get(name) || 0) + 1);
      // The assigned-secret rule already keeps the variable name visible in the
      // output, so a bare mask there is self-describing.
      if (typeof replace === 'function') return replace(...args);
      return name === 'assigned-secret' ? MASK : maskFor(name);
    });
  }

  const findings = [...counts.entries()].map(([type, count]) => ({ type, count }));
  return { text: out, findings };
}

/** Convenience: does this text contain anything we would redact? */
export function hasSecrets(text) {
  return redact(text).findings.length > 0;
}

export { MASK };
