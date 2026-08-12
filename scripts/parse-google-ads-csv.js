// Parse the Google Ads daily CSV export -> SQL for google_ads_daily.
// Handles quoted numbers with thousand separators ("3,237.03") and maps the
// account's campaign names onto the closed enum used by the store-side buckets.
import fs from 'node:fs';

const SRC = process.argv[2];
const OUT = process.argv[3];

const MAP = [
  [/search - brand/i, 'brand-search'],
  [/non brand|non-brand/i, 'non-brand'],
  [/shopping/i, 'shopping'],           // both Smart Shopping (PMax) and Standard Shopping AU
];

function splitCsvLine(line) {
  const out = [];
  let cur = '', inQ = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') { inQ = !inQ; continue; }
    if (c === ',' && !inQ) { out.push(cur); cur = ''; continue; }
    cur += c;
  }
  out.push(cur);
  return out;
}

const num = (s) => {
  const n = parseFloat(String(s ?? '').replace(/,/g, '').trim());
  return isNaN(n) ? 0 : n;
};

const raw = fs.readFileSync(SRC, 'utf8').split(/\r?\n/).filter((l) => l.trim() !== '');
// The Report editor has exported at least two shapes ('Day,Campaign,...' on
// 2026-08-10; 'Campaign,Day,Currency code,...' on 2026-08-13), so columns are
// resolved BY NAME from whatever header row appears, never by position.
const headerIdx = raw.findIndex((l) => {
  const cells = splitCsvLine(l).map((c) => c.trim().toLowerCase());
  return cells.includes('day') && cells.includes('campaign');
});
if (headerIdx < 0) throw new Error('header row not found');
const header = splitCsvLine(raw[headerIdx]).map((c) => c.trim().toLowerCase());
const col = (re, label) => {
  const i = header.findIndex((c) => re.test(c));
  if (i < 0) throw new Error(`column not found: ${label} (header: ${header.join('|')})`);
  return i;
};
const IDX = {
  day: col(/^day$/, 'Day'),
  campaign: col(/^campaign$/, 'Campaign'),
  cost: col(/^cost$/, 'Cost'),
  conversions: col(/^conversions$/, 'Conversions'),
  convValue: col(/^conv\.? value$/, 'Conv. value'),
  currency: col(/^currency/, 'Currency'),
};
const rows = raw.slice(headerIdx + 1).map(splitCsvLine);

const agg = new Map();     // date|campaign -> {conv, cost, value, names:Set}
const currencies = new Set();
const unmapped = new Set();

for (const r of rows) {
  const day = r[IDX.day], campaign = r[IDX.campaign], conversions = r[IDX.conversions],
        currency = r[IDX.currency], cost = r[IDX.cost], convValue = r[IDX.convValue];
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) { console.error('SKIP bad date row:', r.join(',')); continue; }
  currencies.add((currency || '').trim());
  const hit = MAP.find(([re]) => re.test(campaign));
  if (!hit) { unmapped.add(campaign); continue; }
  const key = `${day}|${hit[1]}`;
  const a = agg.get(key) ?? { conv: 0, cost: 0, value: 0, names: new Set() };
  a.conv += num(conversions);
  a.cost += num(cost);
  a.value += num(convValue);
  a.names.add(campaign.trim());
  agg.set(key, a);
}

if (unmapped.size) { console.error('UNMAPPED CAMPAIGNS:', [...unmapped]); process.exit(1); }

const r2 = (n) => Math.round(n * 100) / 100;
const keys = [...agg.keys()].sort();
const values = keys.map((k) => {
  const [date, campaign] = k.split('|');
  const a = agg.get(k);
  const names = [...a.names].sort().join(' + ').replace(/'/g, "''");
  return `('${date}','${campaign}',${r2(a.cost)},${r2(a.conv)},${r2(a.value)},'csv','${names}')`;
});

const totals = keys.reduce((t, k) => {
  const a = agg.get(k);
  return { conv: t.conv + a.conv, cost: t.cost + a.cost, value: t.value + a.value };
}, { conv: 0, cost: 0, value: 0 });

const sql = `-- Google Ads daily spend & claims, loaded from the account's CSV export
-- (May 1 - Aug 10 2026 requested; the account's first spending day is the
-- earliest row below). Currency: ${[...currencies].join(',')} = the account's
-- own currency, no conversion needed (google_ads_daily.spend_aud is AUD).
insert into public.google_ads_daily
  (date, campaign, spend_aud, claimed_conversions, claimed_value_aud, source, campaign_name_raw)
values
${values.join(',\n')}
on conflict (date, campaign) do update set
  spend_aud = excluded.spend_aud,
  claimed_conversions = excluded.claimed_conversions,
  claimed_value_aud = excluded.claimed_value_aud,
  source = excluded.source,
  campaign_name_raw = excluded.campaign_name_raw,
  updated_by = 'csv-import-to-${keys[keys.length - 1].split('|')[0]}',
  updated_at = now();
`;

fs.writeFileSync(OUT, sql, 'utf8');
console.log(JSON.stringify({
  rowsIn: rows.length,
  rowsOut: keys.length,
  dateMin: keys[0].split('|')[0],
  dateMax: keys[keys.length - 1].split('|')[0],
  currencies: [...currencies],
  totals: { conversions: r2(totals.conv), costAud: r2(totals.cost), convValueAud: r2(totals.value) },
  campaignsSeen: [...new Set(rows.map((r) => r[IDX.campaign]).filter(Boolean))],
}, null, 2));
