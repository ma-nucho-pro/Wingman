import { relativeTime, truncate } from './util.js';
import { readEntries } from './journal.js';
import { readVault } from './vault.js';

export const TAG_PREFIX = 'wingman:';

/** The machine-readable line that lets a pasted block find its way home. */
export function projectTag(projectId) {
  return `${TAG_PREFIX} ${projectId}`;
}

export function extractProjectTag(text) {
  if (!text) return null;
  const m = String(text).match(/wingman:\s*([0-9a-f]{12}-[a-z0-9-]{1,40})/i);
  return m ? m[1].toLowerCase() : null;
}

/**
 * Build the context block.
 *
 * Recency-weighted rather than complete: pinned entries always survive, then
 * the most recent entries fill the remaining budget. Older entries collapse to
 * one-line summaries so the thread stays visible without eating the window.
 */
export function renderContext(project, {
  recent = 6,
  maxChars = 16000,
  includeTag = true,
  heading = true,
} = {}) {
  const entries = readEntries(project.id);
  const vault = readVault(project.id);

  // Vault-only projects are a real case: someone records their local notes
  // before any handoff exists. Returning empty here would silently drop them.
  if (!entries.length) {
    if (!vault) return { text: '', empty: true, stats: { total: 0, devices: 0, agents: 0 } };
    const only = [
      `# Wingman context — ${project.name}`,
      includeTag ? `<!-- ${projectTag(project.id)} -->` : '',
      '',
      '## Local notes (this machine only)',
      '',
      '_Never synced and never leaves this computer. May contain credentials._',
      '',
      vault,
      '',
    ].filter((l, i, a) => !(l === '' && a[i - 1] === '')).join('\n');
    return { text: only, empty: false, stats: { total: 0, devices: 0, agents: 0, vaultOnly: true } };
  }

  const now = new Date();
  const pinned = entries.filter((e) => e.pinned);
  const rest = entries.filter((e) => !e.pinned);
  const tail = rest.slice(-recent);
  const older = rest.slice(0, Math.max(0, rest.length - recent));

  const devices = new Set(entries.map((e) => e.device));
  const agents = new Set(entries.map((e) => e.agent));

  const out = [];

  if (heading) {
    out.push(`# Wingman context — ${project.name}`);
    if (includeTag) out.push(`<!-- ${projectTag(project.id)} -->`);
    out.push('');
    out.push(
      `Continuing prior work. ${entries.length} saved ${entries.length === 1 ? 'entry' : 'entries'} `
      + `across ${devices.size} ${devices.size === 1 ? 'machine' : 'machines'} `
      + `and ${agents.size} ${agents.size === 1 ? 'tool' : 'tools'}. `
      + `Treat this as established history: do not redo work already described here, `
      + `and do not retry anything listed as a dead end.`,
    );
    out.push('');
  }

  if (older.length) {
    out.push('## Earlier (summarised)');
    out.push('');
    for (const e of older.slice(-25)) {
      const when = e.at.toISOString().slice(0, 16).replace('T', ' ');
      const label = e.title || firstLine(e.body);
      out.push(`- ${when} · ${e.agent} on ${e.device} — ${truncate(label, 160, '…')}`);
    }
    if (older.length > 25) out.push(`- …and ${older.length - 25} older entries in the store`);
    out.push('');
  }

  if (vault) {
    out.push('## Local notes (this machine only)');
    out.push('');
    out.push('_Never synced and never leaves this computer. May contain credentials._');
    out.push('');
    out.push(vault);
    out.push('');
  }

  if (pinned.length) {
    out.push('## Pinned');
    out.push('');
    for (const e of pinned) {
      out.push(`### ${e.title || 'Pinned note'} — ${e.agent} on ${e.device}`);
      out.push('');
      out.push(e.body);
      out.push('');
    }
  }

  out.push('## Recent history');
  out.push('');
  for (const e of tail) {
    const when = `${e.at.toISOString().slice(0, 16).replace('T', ' ')} UTC (${relativeTime(e.at, now)})`;
    out.push(`### ${e.title || 'Session'} — ${e.agent} on ${e.device}`);
    out.push(`_${when}_`);
    out.push('');
    out.push(e.body);
    out.push('');
  }

  const latest = tail[tail.length - 1] || entries[entries.length - 1];
  out.push('---');
  out.push(`_End of Wingman context. Last update: ${latest.agent} on ${latest.device}, ${relativeTime(latest.at, now)}._`);
  out.push('');

  const text = truncate(out.join('\n'), maxChars);

  return {
    text,
    empty: false,
    stats: {
      total: entries.length,
      devices: devices.size,
      agents: agents.size,
      pinned: pinned.length,
      lastAt: latest.at,
      lastAgent: latest.agent,
      lastDevice: latest.device,
    },
  };
}

function firstLine(body) {
  const line = String(body).split('\n').map((l) => l.replace(/^#+\s*/, '').trim()).find(Boolean);
  return line || '(no summary)';
}

/** Template we ask agents to fill in. Short on purpose: state, not transcript. */
export const HANDOFF_TEMPLATE = `## Goal
<what we are trying to achieve, one or two sentences>

## Current state
Branch: <branch> · Last commit: <sha or "none">
Tests: <what passes, what fails>

## Decisions made
- <decision and the reason>

## Dead ends (do not retry)
- <thing that was tried and did not work, and why>

## Files touched
<comma-separated paths>

## Next concrete step
<the single next action, specific enough to start immediately>`;
