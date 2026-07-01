// Consume docs/data/alerts.json (written by probe.mjs) and raise/resolve alerts.
// Channel 1 (always on in Actions): GitHub issues labeled "incident" - opening
// an issue notifies watchers via GitHub's own email/push notifications.
// Channel 2 (optional): direct email via Resend when RESEND_API_KEY is set.
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const alertsPath = join(root, 'docs', 'data', 'alerts.json');
if (!existsSync(alertsPath)) process.exit(0);
const alerts = JSON.parse(readFileSync(alertsPath, 'utf8'));
if (!alerts.length) { console.log('no state changes'); process.exit(0); }

const repo = process.env.GITHUB_REPOSITORY;
const token = process.env.GITHUB_TOKEN;
const api = async (path, init = {}) => {
  const res = await fetch(`https://api.github.com${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'User-Agent': 'hct-pulse',
      ...(init.body ? { 'Content-Type': 'application/json' } : {}),
    },
  });
  if (!res.ok) throw new Error(`${path} -> ${res.status}: ${await res.text()}`);
  return res.json();
};

const icon = s => (s === 'down' ? '🔴' : s === 'slow' ? '🟡' : '🟢');

async function findOpenIncident(id) {
  const issues = await api(`/repos/${repo}/issues?labels=incident&state=open&per_page=100`);
  return issues.find(i => i.title.includes(`[${id}]`));
}

for (const a of alerts) {
  const detail = [
    `**Service:** ${a.service}`,
    `**Endpoint:** ${a.url}`,
    `**Transition:** ${icon(a.from)} ${a.from} → ${icon(a.to)} ${a.to}`,
    `**Last probe:** ${a.total ?? '?'}ms, HTTP ${a.status ?? 'n/a'}${a.error ? `, error: ${a.error}` : ''}`,
    `**Since:** ${a.since}`,
  ].join('\n');

  if (!token || !repo) { console.log(`(no GH token) ${a.id}: ${a.from} -> ${a.to}`); continue; }

  const existing = await findOpenIncident(a.id);
  if (a.to === 'up') {
    if (existing) {
      await api(`/repos/${repo}/issues/${existing.number}/comments`, {
        method: 'POST',
        body: JSON.stringify({ body: `🟢 **Recovered** at ${new Date().toISOString()}\n\n${detail}` }),
      });
      await api(`/repos/${repo}/issues/${existing.number}`, { method: 'PATCH', body: JSON.stringify({ state: 'closed' }) });
      console.log(`closed incident #${existing.number} for ${a.id}`);
    }
  } else if (existing) {
    await api(`/repos/${repo}/issues/${existing.number}/comments`, {
      method: 'POST',
      body: JSON.stringify({ body: `${icon(a.to)} Status changed to **${a.to}**\n\n${detail}` }),
    });
    console.log(`updated incident #${existing.number} for ${a.id}`);
  } else {
    const issue = await api(`/repos/${repo}/issues`, {
      method: 'POST',
      body: JSON.stringify({
        title: `${icon(a.to)} [${a.id}] ${a.name} is ${a.to}`,
        body: detail,
        labels: ['incident'],
      }),
    });
    console.log(`opened incident #${issue.number} for ${a.id}`);
  }

  // Optional branded email alerts.
  if (process.env.RESEND_API_KEY && process.env.ALERT_EMAILS) {
    try {
      await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          from: process.env.ALERT_FROM || 'alerts@catholicowned.com',
          to: process.env.ALERT_EMAILS.split(',').map(s => s.trim()),
          subject: `${icon(a.to)} ${a.name} is ${a.to}`,
          text: detail.replace(/\*\*/g, ''),
        }),
      });
    } catch (e) {
      console.log(`resend failed: ${e.message}`);
    }
  }
}
