// =============================================================================
// Google Ads CSV upload — the whole monthly refresh, from the dashboard
// =============================================================================
// Mario, 2026-08-18: "no quiero tener que darte el archivo todas las veces, no
// me gusta depender de Claude." This is that: pick the export, see the result.
//
// The file is parsed HERE and the rows go to the same google-ads-load edge
// function the manual form uses — the single audited write path into
// google_ads_daily, which re-validates everything server-side and stamps who
// loaded it from the session. Nothing is trusted because it came from a file.
//
// The parsing rules mirror scripts/parse-google-ads-csv.js exactly, including
// the two learned the hard way:
//   * columns are resolved BY HEADER NAME — the Report editor has already
//     exported at least two different column orders;
//   * an unrecognised campaign name FAILS LOUD instead of being dropped, so a
//     new campaign can never silently vanish from the spend totals.
import { useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { supabase } from '@/lib/supabase';

/** Account campaign name → the closed enum the engine buckets on. Four
 *  campaigns map onto three values: PMax and Standard Shopping are both
 *  'shopping' (they never overlap on a day; summed if they ever do).
 *  Keep in step with scripts/parse-google-ads-csv.js. */
const MAP: [RegExp, string][] = [
  [/search - brand/i, 'brand-search'],
  [/non brand|non-brand/i, 'non-brand'],
  [/shopping/i, 'shopping'],
];

type Row = {
  date: string; campaign: string;
  spend_aud: number; claimed_conversions: number; claimed_value_aud: number;
};
type Parsed = {
  rows: Row[]; from: string; to: string; days: number; gaps: number;
  spend: number; value: number; currencies: string[];
};

/** Splits one CSV line, honouring the quotes Google puts around thousands
 *  separators ("3,237.03"). */
function splitCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  let inQ = false;
  for (const c of line) {
    if (c === '"') { inQ = !inQ; continue; }
    if (c === ',' && !inQ) { out.push(cur); cur = ''; continue; }
    cur += c;
  }
  out.push(cur);
  return out;
}

const num = (s: string | undefined) => {
  const n = parseFloat(String(s ?? '').replace(/,/g, '').trim());
  return Number.isNaN(n) ? 0 : n;
};

function parseCsv(text: string): Parsed {
  const lines = text.split(/\r?\n/).filter((l) => l.trim() !== '');
  const headerIdx = lines.findIndex((l) => {
    const c = splitCsvLine(l).map((x) => x.trim().toLowerCase());
    return c.includes('day') && c.includes('campaign');
  });
  if (headerIdx < 0) throw new Error('No header row with Day and Campaign — is this the right export?');

  const header = splitCsvLine(lines[headerIdx]).map((c) => c.trim().toLowerCase());
  const col = (re: RegExp, label: string) => {
    const i = header.findIndex((c) => re.test(c));
    if (i < 0) throw new Error(`Column missing: ${label}. Found: ${header.join(', ')}`);
    return i;
  };
  const IDX = {
    day: col(/^day$/, 'Day'),
    campaign: col(/^campaign$/, 'Campaign'),
    cost: col(/^cost$/, 'Cost'),
    conversions: col(/^conversions$/, 'Conversions'),
    convValue: col(/^conv\.? value$/, 'Conv. value'),
    currency: header.findIndex((c) => /^currency/.test(c)),
  };

  const agg = new Map<string, Row>();
  const unmapped = new Set<string>();
  const currencies = new Set<string>();

  for (const line of lines.slice(headerIdx + 1)) {
    const r = splitCsvLine(line);
    const day = (r[IDX.day] ?? '').trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) continue; // totals row, stray line
    const name = (r[IDX.campaign] ?? '').trim();
    if (IDX.currency >= 0) currencies.add((r[IDX.currency] ?? '').trim());
    const hit = MAP.find(([re]) => re.test(name));
    if (!hit) { unmapped.add(name); continue; }
    const key = `${day}|${hit[1]}`;
    const a = agg.get(key) ?? {
      date: day, campaign: hit[1], spend_aud: 0, claimed_conversions: 0, claimed_value_aud: 0,
    };
    a.spend_aud += num(r[IDX.cost]);
    a.claimed_conversions += num(r[IDX.conversions]);
    a.claimed_value_aud += num(r[IDX.convValue]);
    agg.set(key, a);
  }

  if (unmapped.size) {
    throw new Error(
      `Campaign not recognised: ${[...unmapped].join(' · ')}. It would be dropped from the spend `
      + 'totals, so nothing was loaded. A new campaign has to be added to the mapping first.');
  }
  if (agg.size === 0) throw new Error('No dated rows found in the file.');

  const r2 = (n: number) => Math.round(n * 100) / 100;
  const rows = [...agg.values()]
    .map((r) => ({
      ...r,
      spend_aud: r2(r.spend_aud),
      claimed_conversions: r2(r.claimed_conversions),
      claimed_value_aud: r2(r.claimed_value_aud),
    }))
    .sort((a, b) => a.date.localeCompare(b.date) || a.campaign.localeCompare(b.campaign));

  const dates = [...new Set(rows.map((r) => r.date))].sort();
  const from = dates[0];
  const to = dates[dates.length - 1];
  const span = Math.round((Date.parse(to) - Date.parse(from)) / 86_400_000) + 1;

  return {
    rows,
    from,
    to,
    days: dates.length,
    gaps: span - dates.length,
    spend: r2(rows.reduce((s, r) => s + r.spend_aud, 0)),
    value: r2(rows.reduce((s, r) => s + r.claimed_value_aud, 0)),
    currencies: [...currencies].filter(Boolean),
  };
}

type State =
  | { kind: 'idle' }
  | { kind: 'parsed'; parsed: Parsed; name: string }
  | { kind: 'saving' }
  | { kind: 'done'; upserted: number; parsed: Parsed }
  | { kind: 'error'; message: string };

export default function GoogleCsvUpload({ onSaved }: { onSaved: () => void }) {
  const [state, setState] = useState<State>({ kind: 'idle' });
  const fileRef = useRef<HTMLInputElement>(null);

  const onPick = async (file: File | undefined) => {
    if (!file) return;
    try {
      setState({ kind: 'parsed', parsed: parseCsv(await file.text()), name: file.name });
    } catch (e) {
      setState({ kind: 'error', message: e instanceof Error ? e.message : 'Could not read the file' });
    }
  };

  const load = async (parsed: Parsed) => {
    setState({ kind: 'saving' });
    try {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session?.access_token) {
        setState({ kind: 'error', message: 'Your session expired — reload the page.' });
        return;
      }
      // One call for the whole export: the function validates the payload as a
      // unit, and a partial load would leave the MER line half-repaired.
      const res = await fetch(`${import.meta.env.VITE_SUPABASE_URL}/functions/v1/google-ads-load`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${session.access_token}`,
          apikey: import.meta.env.VITE_SUPABASE_ANON_KEY,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ rows: parsed.rows }),
      });
      const body = await res.json().catch(() => ({ success: false, message: 'Invalid server response' }));
      if (!res.ok || body?.success === false) {
        setState({ kind: 'error', message: body?.message ?? `Server error ${res.status}` });
        return;
      }
      setState({ kind: 'done', upserted: body.upserted ?? parsed.rows.length, parsed });
      if (fileRef.current) fileRef.current.value = '';
      onSaved();
    } catch (e) {
      setState({ kind: 'error', message: e instanceof Error ? e.message : 'Network error' });
    }
  };

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2 flex-wrap">
        <input
          ref={fileRef}
          type="file"
          accept=".csv,text/csv"
          onChange={(e) => onPick(e.target.files?.[0])}
          className="text-[13px] file:mr-2 file:rounded-md file:border file:border-border file:bg-background file:px-2.5 file:py-1 file:text-[13px] file:font-medium hover:file:bg-muted"
        />
        {state.kind === 'parsed' && (
          <Button size="sm" onClick={() => load(state.parsed)}>
            Load {state.parsed.rows.length} rows
          </Button>
        )}
        {state.kind === 'saving' && <span className="text-[13px] text-muted-foreground">Loading…</span>}
      </div>

      {state.kind === 'parsed' && (
        <div className="text-[13px] text-muted-foreground leading-relaxed">
          <b>{state.parsed.from}</b> to <b>{state.parsed.to}</b> · {state.parsed.days} days
          {state.parsed.gaps > 0
            ? (
              <span className="text-amber-700 dark:text-amber-400">
                {' '}· {state.parsed.gaps} day{state.parsed.gaps === 1 ? '' : 's'} missing inside that span
              </span>
            )
            : ' · no gaps'}
          {' '}· spend A${state.parsed.spend.toLocaleString('en-AU')} · claimed A${state.parsed.value.toLocaleString('en-AU')}
          {state.parsed.currencies.some((c) => c !== 'AUD') && (
            <span className="text-amber-700 dark:text-amber-400">
              {' '}· currency is {state.parsed.currencies.join('/')}, not AUD — wrong account?
            </span>
          )}
          <div className="mt-0.5">
            Check those totals against Google's own screen before loading. Days already loaded are replaced.
          </div>
        </div>
      )}

      {state.kind === 'done' && (
        <p className="text-[13px] text-emerald-700 dark:text-emerald-400">
          Loaded {state.upserted} rows, {state.parsed.from} to {state.parsed.to}. The tab has been refreshed.
        </p>
      )}

      {state.kind === 'error' && (
        <p className="text-[13px] text-red-600 dark:text-red-400">{state.message}</p>
      )}
    </div>
  );
}
