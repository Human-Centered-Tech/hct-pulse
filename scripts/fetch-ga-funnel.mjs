// Pull funnel-step user counts from GA4 (property 431914050, "catholic-owned")
// and write docs/data/funnel-ga.json for docs/funnel.html.
//
// Auth: service-account JWT (GA_FUNNEL_SA_KEY secret = the JSON key of
// hct-funnel-reader@thoughtweaver.iam.gserviceaccount.com). The SA must be
// granted Viewer on the GA property (Admin → Property access management) —
// until then the API 403s and this script writes {pending:true} and exits 0,
// so the page shows "awaiting access" rather than the workflow failing.
//
// Steps are classified from pagePath with the same rules as traffic.mjs, but
// counted in GA "totalUsers" — i.e. unique people per step, which the edge
// logs can't give us. Complementary, not duplicate.
import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createSign } from 'node:crypto';

const PROPERTY = 'properties/431914050';
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const outPath = join(root, 'docs', 'data', 'funnel-ga.json');

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

const writePending = (reason) => {
  writeFileSync(outPath, JSON.stringify({ pending: true, reason, updated: new Date().toISOString() }));
  console.log(`funnel-ga: pending (${reason})`);
};

const keyRaw = process.env.GA_FUNNEL_SA_KEY;
if (!keyRaw) { writePending('GA_FUNNEL_SA_KEY not set'); process.exit(0); }

let key;
try { key = JSON.parse(keyRaw); } catch { writePending('bad key JSON'); process.exit(0); }

const b64url = (buf) => Buffer.from(buf).toString('base64url');
async function accessToken() {
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claims = b64url(JSON.stringify({
    iss: key.client_email,
    scope: 'https://www.googleapis.com/auth/analytics.readonly',
    aud: 'https://oauth2.googleapis.com/token',
    iat: now,
    exp: now + 3600,
  }));
  const signer = createSign('RSA-SHA256');
  signer.update(`${header}.${claims}`);
  const sig = signer.sign(key.private_key, 'base64url');
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: `${header}.${claims}.${sig}`,
    }),
  });
  const body = await res.json();
  if (!res.ok) throw new Error(`token: ${JSON.stringify(body).slice(0, 200)}`);
  return body.access_token;
}

try {
  const token = await accessToken();
  const res = await fetch(`https://analyticsdata.googleapis.com/v1beta/${PROPERTY}:runReport`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      dateRanges: [{ startDate: '28daysAgo', endDate: 'today' }],
      dimensions: [{ name: 'date' }, { name: 'pagePath' }],
      metrics: [{ name: 'totalUsers' }, { name: 'screenPageViews' }],
      limit: 100000,
    }),
  });
  const body = await res.json();
  if (res.status === 403) { writePending('SA lacks GA property access — grant Viewer in GA Admin'); process.exit(0); }
  if (!res.ok) throw new Error(`runReport: ${JSON.stringify(body).slice(0, 300)}`);

  // days: { YYYYMMDD: { step: { users, views } } } — note users per step are
  // summed over paths within the step, so they're an upper bound on uniques
  // for multi-path steps (product/*); exact for single-path steps.
  const days = {};
  for (const row of body.rows ?? []) {
    const [date, path] = row.dimensionValues.map((d) => d.value);
    const step = funnelStep(path);
    if (!step) continue;
    const users = Number(row.metricValues[0].value) || 0;
    const views = Number(row.metricValues[1].value) || 0;
    const d = (days[date] ??= {});
    const s = (d[step] ??= { users: 0, views: 0 });
    s.users += users;
    s.views += views;
  }
  writeFileSync(outPath, JSON.stringify({ updated: new Date().toISOString(), property: PROPERTY, days }));
  console.log(`funnel-ga: wrote ${Object.keys(days).length} day(s)`);
} catch (e) {
  writePending(`error: ${e.message.slice(0, 160)}`);
}
