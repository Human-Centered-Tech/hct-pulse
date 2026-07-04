// Collect HTTP traffic stats from Railway edge logs for each entry in
// targets.json "traffic". No client-side analytics needed: Railway already
// logs every request (path, status, srcIp, user-agent).
//
// Outputs docs/data/traffic.json:
//   { updated, series: { <key>: { label, hours: { "YYYY-MM-DDTHH": {req,bot,human,pv,uniq} } } } }
// Humans vs bots are split by user-agent. "pv" = human page views (GET,
// <400, non-asset paths). "uniq" = distinct human IPs seen that hour
// (stored only as salted HMAC hashes, never raw IPs).
//
// State (docs/data/traffic-state.json) carries the last-collected timestamp
// and the per-hour IP-hash sets for the trailing 2 hours so unique counts
// survive across runs. Requires RAILWAY_PROJECT_TOKEN.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHmac } from 'node:crypto';

const token = process.env.RAILWAY_PROJECT_TOKEN;
if (!token) { console.log('RAILWAY_PROJECT_TOKEN not set - skipping traffic collection'); process.exit(0); }

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dataDir = join(root, 'docs', 'data');
const config = JSON.parse(readFileSync(join(root, 'targets.json'), 'utf8'));
const targets = config.traffic ?? [];
if (!targets.length) process.exit(0);

const RETENTION_HOURS = 7 * 24;
const MAX_PAGES = 15;          // per run, 1000 logs/page
const BOT_RE = /bot|crawl|spider|slurp|curl|wget|python|go-http|okhttp|headless|lighthouse|pingdom|uptime|monitor|checkly|gptbot|claude|bytespider|petalbot|ahrefs|semrush|mj12|dotbot|applebot|amazonbot|yandex|facebookexternalhit|whatsapp|telegram|discord|preview|scrapy|httpclient|libwww|java\/|undici|node|axios|censys|zgrab|dataprovider|expanse|nmap|masscan/i;
const ASSET_RE = /\.(js|css|map|png|jpe?g|gif|svg|ico|webp|avif|woff2?|ttf|txt|xml|json)$|^\/_next\/|^\/api\/|^\/favicon|^\/icons?\//i;

async function gql(query, variables) {
  const res = await fetch('https://backboard.railway.com/graphql/v2', {
    method: 'POST',
    headers: { 'Project-Access-Token': token, 'Content-Type': 'application/json', 'User-Agent': 'hct-pulse' },
    body: JSON.stringify({ query, variables }),
  });
  const body = await res.json();
  if (body.errors) throw new Error(JSON.stringify(body.errors).slice(0, 300));
  return body.data;
}

// Purchase-funnel classification for docs/funnel.html. The locale prefix
// (/us, /es, ...) varies, so strip one leading 2-letter segment then match.
const FUNNEL_STEPS = [
  ['purchase', /^\/order\/[^/]+\/confirmed/],
  ['checkout', /^\/checkout/],
  ['cart', /^\/cart$/],
  ['product', /^\/products\/[^/]+/],
  ['shop', /^\/(categories|search)(\/|$)/],
  ['directory', /^\/directory(\/|$)/],
  ['home', /^\/?$/],
];
function funnelStep(path) {
  let p = (path || '').split('?')[0];
  p = p.replace(/^\/[a-z]{2}(?=\/|$)/i, '');
  if (p === '') p = '/';
  for (const [k, re] of FUNNEL_STEPS) if (re.test(p)) return k;
  return null;
}

const hashIp = ip => createHmac('sha256', token).update(ip || '?').digest('base64url').slice(0, 10);
const hourKey = ts => ts.slice(0, 13);

const statePath = join(dataDir, 'traffic-state.json');
const outPath = join(dataDir, 'traffic.json');
const state = existsSync(statePath) ? JSON.parse(readFileSync(statePath, 'utf8')) : {};
const out = existsSync(outPath) ? JSON.parse(readFileSync(outPath, 'utf8')) : { series: {} };

const now = new Date();
const nowIso = now.toISOString();

for (const t of targets) {
  const st = (state[t.key] ??= { lastTs: new Date(now.getTime() - 3600e3).toISOString(), ipsByHour: {} });
  const series = (out.series[t.key] ??= { label: t.label, hours: {} });
  series.label = t.label;

  // A freshly-created deployment (BUILDING/DEPLOYING) has no traffic yet, and
  // after a cutover the tail of the window lives on the REMOVED deployment —
  // so read logs from the most recent deployments that actually served.
  let serving;
  try {
    const d = await gql(
      `query d($input: DeploymentListInput!, $first: Int) {
        deployments(input: $input, first: $first) { edges { node { id status } } }
      }`,
      { input: { projectId: t.projectId, environmentId: t.environmentId, serviceId: t.serviceId }, first: 5 });
    serving = d.deployments.edges.map(e => e.node)
      .filter(n => ['SUCCESS', 'REMOVED', 'CRASHED'].includes(n.status)).slice(0, 2);
  } catch (e) { console.log(`${t.key}: deployment resolve failed: ${e.message}`); continue; }
  if (!serving?.length) continue;

  // page backwards from now until we reach lastTs, per serving deployment
  const entries = [];
  for (const dep of serving) {
    let anchor = nowIso;
    for (let page = 0; page < MAX_PAGES; page++) {
      let batch;
      try {
        const d = await gql(
          `query h($deploymentId: String!, $anchorDate: String, $beforeLimit: Int) {
            httpLogs(deploymentId: $deploymentId, anchorDate: $anchorDate, beforeLimit: $beforeLimit) {
              timestamp method path httpStatus srcIp clientUa
            }
          }`,
          { deploymentId: dep.id, anchorDate: anchor, beforeLimit: 1000 });
        batch = d.httpLogs;
      } catch (e) { console.log(`${t.key}: httpLogs failed: ${e.message}`); break; }
      if (!batch?.length) break;
      const fresh = batch.filter(e => e.timestamp > st.lastTs && e.timestamp <= nowIso);
      entries.push(...fresh);
      const oldest = batch[0].timestamp;
      if (oldest <= st.lastTs || fresh.length < batch.length) break;
      anchor = oldest;
    }
  }

  // aggregate into hourly buckets
  for (const e of entries) {
    const hk = hourKey(e.timestamp);
    const b = (series.hours[hk] ??= { req: 0, bot: 0, human: 0, pv: 0, uniq: 0 });
    b.req++;
    const ua = e.clientUa || '';
    if (!ua || BOT_RE.test(ua)) { b.bot++; continue; }
    b.human++;
    const ips = (st.ipsByHour[hk] ??= []);
    const h = hashIp(e.srcIp);
    if (!ips.includes(h)) ips.push(h);
    b.uniq = ips.length;
    if (e.method === 'GET' && e.httpStatus < 400 && !ASSET_RE.test(e.path || '')) {
      b.pv++;
      const step = funnelStep(e.path);
      if (step) { const f = (b.fn ??= {}); f[step] = (f[step] || 0) + 1; }
    }
  }

  if (entries.length) st.lastTs = entries.reduce((m, e) => (e.timestamp > m ? e.timestamp : m), st.lastTs);
  else st.lastTs = nowIso; // nothing new; don't re-scan old ground next run

  // prune: state keeps 2h of IP sets, output keeps RETENTION_HOURS of buckets
  const ipCutoff = hourKey(new Date(now.getTime() - 2 * 3600e3).toISOString());
  for (const hk of Object.keys(st.ipsByHour)) if (hk < ipCutoff) delete st.ipsByHour[hk];
  const cutoff = hourKey(new Date(now.getTime() - RETENTION_HOURS * 3600e3).toISOString());
  for (const hk of Object.keys(series.hours)) if (hk < cutoff) delete series.hours[hk];

  const day = Object.entries(series.hours).filter(([hk]) => hk >= hourKey(new Date(now.getTime() - 24 * 3600e3).toISOString()));
  const sum = k => day.reduce((s, [, b]) => s + b[k], 0);
  console.log(`${t.key}: +${entries.length} logs | 24h: req=${sum('req')} human=${sum('human')} bot=${sum('bot')} pv=${sum('pv')}`);
}

out.updated = nowIso;
writeFileSync(outPath, JSON.stringify(out));
writeFileSync(statePath, JSON.stringify(state));
