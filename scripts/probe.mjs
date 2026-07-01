// Probe every endpoint in targets.json, classify up/slow/down, persist results.
// Outputs (all under docs/data/):
//   latest.json          - most recent probe of every endpoint + overall status
//   history/<date>.jsonl - one line per probe run (30-day retention)
//   state.json           - per-endpoint alert state (consecutive counts, alerted status)
//   alerts.json          - state transitions detected THIS run (consumed by alert.mjs)
import { readFileSync, writeFileSync, mkdirSync, readdirSync, unlinkSync, existsSync, appendFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dataDir = join(root, 'docs', 'data');
const histDir = join(dataDir, 'history');
mkdirSync(histDir, { recursive: true });

const config = JSON.parse(readFileSync(join(root, 'targets.json'), 'utf8'));
const RETENTION_DAYS = 30;
// Two consecutive agreeing probes before a state change alerts (rides out single blips).
const CONSECUTIVE_TO_ALERT = 2;

async function probe(ep) {
  const timeoutMs = ep.timeoutMs ?? 30000;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  const t0 = performance.now();
  let ttfb = null, total = null, status = null, error = null, edge = null;
  try {
    const res = await fetch(ep.url, {
      method: ep.method ?? 'GET',
      headers: ep.headers ?? {},
      redirect: 'manual',
      signal: ctrl.signal,
    });
    ttfb = Math.round(performance.now() - t0);
    await res.arrayBuffer();
    total = Math.round(performance.now() - t0);
    status = res.status;
    edge = res.headers.get('x-railway-edge') || undefined;
  } catch (e) {
    error = e.name === 'AbortError' ? `timeout>${timeoutMs}ms` : (e.cause?.message || e.message);
    total = Math.round(performance.now() - t0);
  } finally {
    clearTimeout(timer);
  }
  const accept = ep.acceptStatus ?? [200];
  let state;
  if (error || !accept.includes(status)) state = 'down';
  else if (total >= (ep.critMs ?? 10000)) state = 'down';
  else if (total >= (ep.warnMs ?? 3000)) state = 'slow';
  else state = 'up';
  return { id: ep.id, name: ep.name, url: ep.url, state, status, ttfb, total, edge, error: error ?? undefined };
}

// check-host.net multi-vantage: catches path-specific outages (e.g. one bad
// anycast POP) that a single-vantage probe from a GitHub runner can't see.
async function vantageCheck(url, nodes) {
  const nodeParams = nodes.map(n => `node=${n}`).join('&');
  const opts = { headers: { Accept: 'application/json' } };
  const kick = await fetch(`https://check-host.net/check-http?host=${encodeURIComponent(url)}&${nodeParams}`, opts);
  const { request_id } = await kick.json();
  await new Promise(r => setTimeout(r, 25000));
  const res = await fetch(`https://check-host.net/check-result/${request_id}`, opts);
  const data = await res.json();
  const out = {};
  for (const [node, r] of Object.entries(data)) {
    const v = r && r[0];
    out[node.replace('.node.check-host.net', '')] = v
      ? { ok: v[0] === 1, seconds: Math.round(v[1] * 1000) / 1000, detail: v[2] }
      : { ok: null, detail: 'pending' };
  }
  return out;
}

const now = new Date();
const ts = now.toISOString();
const endpoints = config.services.flatMap(s => s.endpoints.map(ep => ({ ...ep, service: s.name })));
const results = await Promise.all(endpoints.map(ep => probe(ep).catch(e => ({ id: ep.id, name: ep.name, url: ep.url, state: 'down', error: e.message }))));
for (const r of results) r.service = endpoints.find(e => e.id === r.id)?.service;

// --- alert state machine ---
const statePath = join(dataDir, 'state.json');
const prev = existsSync(statePath) ? JSON.parse(readFileSync(statePath, 'utf8')) : {};
const alerts = [];
for (const r of results) {
  const ep = endpoints.find(e => e.id === r.id);
  const s = prev[r.id] ?? { status: 'up', consecutive: 0, alertedStatus: 'up', since: ts };
  if (r.state === s.status) s.consecutive += 1;
  else { s.status = r.state; s.consecutive = 1; s.since = ts; }
  if (s.status !== s.alertedStatus && s.consecutive >= CONSECUTIVE_TO_ALERT) {
    if (ep?.alert !== false) {
      alerts.push({ id: r.id, name: r.name, service: r.service, url: r.url, from: s.alertedStatus, to: s.status, since: s.since, total: r.total, status: r.status, error: r.error });
    }
    s.alertedStatus = s.status;
  }
  prev[r.id] = s;
}
writeFileSync(statePath, JSON.stringify(prev, null, 2));
writeFileSync(join(dataDir, 'alerts.json'), JSON.stringify(alerts, null, 2));

// --- multi-vantage (top of each hour, or forced) ---
let vantage;
const lastVantagePath = join(dataDir, 'vantage.json');
if (config.vantage && (process.env.RUN_VANTAGE === '1' || now.getUTCMinutes() < 5)) {
  vantage = { ts, results: {} };
  for (const url of config.vantage.urls) {
    try {
      vantage.results[url] = await vantageCheck(url, config.vantage.nodes);
    } catch (e) {
      vantage.results[url] = { error: e.message };
    }
  }
  writeFileSync(lastVantagePath, JSON.stringify(vantage, null, 2));
}

// --- latest + history ---
const rank = { down: 2, slow: 1, up: 0 };
const alerting = results.filter(r => endpoints.find(e => e.id === r.id)?.alert !== false);
const overall = alerting.reduce((w, r) => (rank[r.state] > rank[w] ? r.state : w), 'up');
writeFileSync(join(dataDir, 'latest.json'), JSON.stringify({ ts, overall, results }, null, 2));

const day = ts.slice(0, 10);
const compact = { ts, r: Object.fromEntries(results.map(r => [r.id, [r.state, r.total, r.status ?? 0]])) };
appendFileSync(join(histDir, `${day}.jsonl`), JSON.stringify(compact) + '\n');

const cutoff = new Date(now.getTime() - RETENTION_DAYS * 86400e3).toISOString().slice(0, 10);
for (const f of readdirSync(histDir)) {
  if (f.endsWith('.jsonl') && f.slice(0, 10) < cutoff) unlinkSync(join(histDir, f));
}

for (const r of results) {
  console.log(`${r.state.padEnd(4)} ${String(r.total ?? '-').padStart(6)}ms ${r.id}${r.error ? ' err=' + r.error : ''}${r.edge ? ' edge=' + r.edge : ''}`);
}
console.log(`overall=${overall} alerts=${alerts.length}`);
