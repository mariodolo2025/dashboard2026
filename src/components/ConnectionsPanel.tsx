// =============================================================================
// Connections panel — auto-refresh control + per-source status.
//
// Rendered inside the Config dialog. Two kinds of card:
//  • Master "Auto-refresh": one multi-time schedule that drives the whole
//    refresh chain (Unleashed sales + inventory, later Shopify/Meta), a
//    "Refresh all now" button, and a log of recent runs with each step's result.
//  • Per-source cards (Xero, …): liveness + last sync, optional single-time
//    schedule, and a Sync-now button.
//
// It renders whatever connection-status reports, so new sources only need a
// server-side entry.
// =============================================================================

import { useCallback, useEffect, useMemo, useState } from 'react';
import { RefreshCw, Check, AlertTriangle, Plug, X, Plus, Clock, ChevronRight } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

interface StepLog {
  name: string;
  status: string;
  rows: number | null;
  ms: number;
  message: string | null;
  at: string;
}
interface RunLog {
  id: number;
  status: string; // running | done | error
  cursor: number;
  total_steps: number;
  trigger: string | null;
  steps: StepLog[];
  started_at: string;
  finished_at: string | null;
}

interface ConnectionCron {
  schedule: string;
  active: boolean;
  aest: { days: number[]; hourAest: number } | null;
  hoursAest?: number[];        // master: times/day (Brisbane)
  driverActive?: boolean;      // master: is the every-minute engine alive
  intervalMinutes?: number | null; // fast: every-N-minutes interval
}

interface ConnectionInfo {
  id: string;
  name: string;
  connected: boolean;
  detail?: string;
  master?: boolean;
  runs?: RunLog[];
  tokenUpdatedAt?: string | null;
  lastSync?: { at: string; ok: boolean; step?: string; error?: string } | null;
  cron: ConnectionCron | null;
}

/** Which function to invoke for "Sync now" / "Refresh all now", per connection id. */
const SYNC_FUNCTIONS: Record<string, { fn: string; body: unknown }> = {
  'auto-refresh': { fn: 'sync-orchestrate', body: { kickoff: true, trigger: 'button' } },
  xero: { fn: 'xero-sync', body: { step: 'all' } },
  'unleashed-sales': { fn: 'unleashed-sales-sync', body: {} },
  'shopify-sales': { fn: 'shopify-sales-sync', body: {} },
  'shopify-sales-fast': { fn: 'shopify-sales-sync', body: {} },
};

const FAST_INTERVAL_OPTIONS = [5, 10, 15, 20, 30, 60];

const DAY_LABELS = ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'];

const baseUrl = () => import.meta.env.VITE_SUPABASE_URL;
const authHeaders = () => ({
  Authorization: `Bearer ${import.meta.env.VITE_SUPABASE_ANON_KEY}`,
  'Content-Type': 'application/json',
});

const fmtDateTime = (s: string) =>
  new Date(s).toLocaleString('en-AU', { dateStyle: 'medium', timeStyle: 'short' });
const fmtDuration = (ms: number) => {
  if (ms < 1000) return `${ms}ms`;
  const s = Math.round(ms / 1000);
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
};
const shortStep = (name: string) => name.replace(/^Inventory · /, '');

/** Last-24h summary of the front page / By Channel loads (dashboard_load_health). */
interface DashboardLoads {
  loads24h: number;
  failed24h: number;
  p95Ms24h: number | null;
  maxMs24h: number | null;
  lastFailure: { at: string; from: string | null; to: string | null; message: string | null } | null;
}

/** ops_health(): every automatic job's real result, from the ops watchdog. */
export interface OpsJob {
  jobname: string;
  label: string;
  kind: 'cron' | 'freshness';
  optional: boolean;
  threshold: number;
  note: string | null;
  state: 'ok' | 'warn' | 'failing' | 'paused' | 'off' | 'unknown';
  consecutiveFailures: number;
  lastOkAt: string | null;
  lastFailAt: string | null;
  failingSince: string | null;
  lastError: string | null;
  pausedAt: string | null;
  pausedReason: string | null;
}
export interface OpsHealth {
  checkedAt: string | null;
  watchdogStale: boolean;
  failingCount: number;
  jobs: OpsJob[];
}

export function ConnectionsPanel() {
  const [connections, setConnections] = useState<ConnectionInfo[]>([]);
  const [dashboardLoads, setDashboardLoads] = useState<DashboardLoads | null>(null);
  const [opsHealth, setOpsHealth] = useState<OpsHealth | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [syncing, setSyncing] = useState<string | null>(null);
  const [savingSchedule, setSavingSchedule] = useState<string | null>(null);
  // Local schedule edits keyed by connection id.
  const [edits, setEdits] = useState<Record<string, { days: number[]; hourAest: number }>>({});
  // Local multi-hour edits for the master, keyed by connection id.
  const [hourEdits, setHourEdits] = useState<Record<string, number[]>>({});

  const load = useCallback(async () => {
    setError(null);
    try {
      const res = await fetch(`${baseUrl()}/functions/v1/connection-status`, { headers: authHeaders() });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = await res.json();
      setConnections(body.connections ?? []);
      setDashboardLoads(body.dashboardLoads ?? null);
      setOpsHealth(body.opsHealth ?? null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load connections');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  // While any run is in progress, poll so the log advances live.
  const anyRunning = useMemo(
    () => connections.some((c) => c.master && (c.runs ?? []).some((r) => r.status === 'running')),
    [connections],
  );
  useEffect(() => {
    if (!anyRunning) return;
    const t = setInterval(load, 5000);
    return () => clearInterval(t);
  }, [anyRunning, load]);

  // --- single-time schedule (per-source) ---
  const getEdit = (c: ConnectionInfo) =>
    edits[c.id] ?? { days: c.cron?.aest?.days ?? [], hourAest: c.cron?.aest?.hourAest ?? 5 };
  const toggleDay = (c: ConnectionInfo, day: number) => {
    const cur = getEdit(c);
    const days = cur.days.includes(day) ? cur.days.filter((d) => d !== day) : [...cur.days, day].sort();
    setEdits((prev) => ({ ...prev, [c.id]: { ...cur, days } }));
  };
  const saveSchedule = async (c: ConnectionInfo) => {
    const cur = getEdit(c);
    setSavingSchedule(c.id);
    try {
      const res = await fetch(`${baseUrl()}/functions/v1/connection-status`, {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({ id: c.id, action: 'set-schedule', days: cur.days, hourAest: cur.hourAest }),
      });
      const body = await res.json();
      if (!body.success) throw new Error(body.message ?? 'Failed');
      await load();
      setEdits((prev) => { const n = { ...prev }; delete n[c.id]; return n; });
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to save schedule');
    } finally {
      setSavingSchedule(null);
    }
  };

  // --- multi-time schedule (master) ---
  const getHours = (c: ConnectionInfo) =>
    hourEdits[c.id] ?? c.cron?.hoursAest ?? [];
  const setHours = (c: ConnectionInfo, hours: number[]) =>
    setHourEdits((prev) => ({ ...prev, [c.id]: [...new Set(hours)].sort((a, b) => a - b) }));
  const saveHours = async (c: ConnectionInfo) => {
    const hoursAest = getHours(c);
    if (hoursAest.length === 0) { setError('Pick at least one time'); return; }
    setSavingSchedule(c.id);
    try {
      const res = await fetch(`${baseUrl()}/functions/v1/connection-status`, {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({ id: c.id, action: 'set-schedule', hoursAest }),
      });
      const body = await res.json();
      if (!body.success) throw new Error(body.message ?? 'Failed');
      await load();
      setHourEdits((prev) => { const n = { ...prev }; delete n[c.id]; return n; });
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to save schedule');
    } finally {
      setSavingSchedule(null);
    }
  };

  // --- interval schedule (fast sales refresh) ---
  const saveInterval = async (c: ConnectionInfo, minutes: number) => {
    setSavingSchedule(c.id);
    try {
      const res = await fetch(`${baseUrl()}/functions/v1/connection-status`, {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({ id: c.id, action: 'set-interval', minutes }),
      });
      const body = await res.json();
      if (!body.success) throw new Error(body.message ?? 'Failed');
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to save interval');
    } finally {
      setSavingSchedule(null);
    }
  };

  const syncNow = async (c: ConnectionInfo) => {
    const target = SYNC_FUNCTIONS[c.id];
    if (!target) return;
    setSyncing(c.id);
    try {
      await fetch(`${baseUrl()}/functions/v1/${target.fn}`, {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify(target.body),
      });
      await load();
    } finally {
      setSyncing(null);
    }
  };

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <h3 className="flex items-center gap-1.5 text-sm font-semibold">
          <Plug className="h-4 w-4" />
          Connections
        </h3>
        <Button variant="ghost" size="sm" className="h-7 px-2" onClick={load} disabled={loading}>
          <RefreshCw className={cn('h-3.5 w-3.5', loading && 'animate-spin')} />
        </Button>
      </div>

      {error && (
        <p className="flex items-center gap-1.5 text-xs text-red-600">
          <AlertTriangle className="h-3.5 w-3.5" /> {error}
        </p>
      )}

      {opsHealth && renderOpsHealth(opsHealth)}

      {dashboardLoads && renderDashboardLoads(dashboardLoads)}

      {connections.map((c) =>
        c.master
          ? renderMaster(c)
          : c.cron?.intervalMinutes != null
            ? renderFast(c)
            : renderConnection(c),
      )}

      {!loading && connections.length === 0 && !error && (
        <p className="text-xs text-muted-foreground">No connections registered.</p>
      )}
    </div>
  );

  // ---------- automatic jobs (ops watchdog) ----------
  // One line per watched job or data check. Problems first. A job that only
  // queues an HTTP call shows the function's real answer, not pg_cron's
  // "Succeeded". Source: ops_health(), snapshot written every 15 min.
  function renderOpsHealth(h: OpsHealth) {
    const bad = h.watchdogStale || h.failingCount > 0;
    const dot: Record<OpsJob['state'], string> = {
      ok: 'bg-emerald-500', warn: 'bg-amber-500', failing: 'bg-red-500',
      paused: 'bg-red-500', off: 'bg-slate-300', unknown: 'bg-slate-300',
    };
    const word: Record<OpsJob['state'], string> = {
      ok: 'OK', warn: 'failed recently', failing: 'failing', paused: 'paused by watchdog',
      off: 'off', unknown: 'no result yet',
    };
    const when = (s: string | null) => (s ? fmtDateTime(s) : '—');
    return (
      <div
        className={cn('rounded-md border px-3 py-2 text-[13px]', bad ? 'border-red-200 bg-red-50' : 'bg-muted/30')}
        title="Every automatic job and data check, read by the watchdog (ops_watchdog) every 15 minutes. For jobs that call a function, this is the function's real answer: the Supabase cron screen says Succeeded as soon as the call is queued, even if the function then fails. Optional jobs are paused automatically after their failure limit; business syncs only raise the alarm."
      >
        <div className="flex items-center justify-between gap-2">
          <span className="font-medium">Automatic jobs</span>
          <span className={cn('flex items-center gap-1 font-medium', bad ? 'text-red-700' : 'text-emerald-700')}>
            {bad && <AlertTriangle className="h-3.5 w-3.5" />}
            {h.watchdogStale
              ? 'watchdog not running'
              : h.failingCount > 0 ? `${h.failingCount} need attention` : 'all OK'}
          </span>
        </div>
        <div className="mt-0.5 text-muted-foreground">Checked {when(h.checkedAt)}</div>
        <div className="mt-1.5 space-y-1">
          {h.jobs.map((j) => (
            <div
              key={j.jobname}
              className="cursor-help"
              title={[
                j.note,
                j.kind === 'cron'
                  ? `Cron job "${j.jobname}". Red after ${j.threshold} failure${j.threshold === 1 ? '' : 's'} in a row${j.optional ? '; paused automatically at that point' : ''}.`
                  : 'Data check: looks at the data itself, whatever the job reports.',
                `Last OK: ${when(j.lastOkAt)}. Last failure: ${when(j.lastFailAt)}.`,
              ].filter(Boolean).join(' ')}
            >
              <div className="flex items-center gap-2">
                <span className={cn('h-2 w-2 shrink-0 rounded-full', dot[j.state])} />
                <span className="font-medium">{j.label}</span>
                <span className={cn('ml-auto shrink-0', j.state === 'failing' || j.state === 'paused' ? 'font-medium text-red-700' : j.state === 'warn' ? 'text-amber-700' : 'text-muted-foreground')}>
                  {word[j.state]}
                  {(j.state === 'failing' || j.state === 'warn') && j.kind === 'cron' && ` · ${j.consecutiveFailures} in a row`}
                  {(j.state === 'failing' || j.state === 'paused') && j.failingSince && ` · since ${when(j.failingSince)}`}
                </span>
              </div>
              {(j.state === 'failing' || j.state === 'paused' || j.state === 'warn') && (j.pausedReason || j.lastError) && (
                <div className="ml-4 truncate text-red-700">{(j.pausedReason ?? j.lastError ?? '').slice(0, 160)}</div>
              )}
              {j.kind === 'freshness' && j.state === 'ok' && j.lastError && (
                <div className="ml-4 truncate text-muted-foreground">{j.lastError}</div>
              )}
            </div>
          ))}
        </div>
      </div>
    );
  }

  // ---------- front page / By Channel loads ----------
  // Not a connection, but the thing every connection feeds: if the screens
  // that read this data fail to load it, it shows here before Mario sees a
  // popup. Source: dashboard_load_log, one row per dashboard-data call.
  function renderDashboardLoads(d: DashboardLoads) {
    const failed = d.failed24h > 0;
    return (
      <div
        className={cn('rounded-md border px-3 py-2 text-xs', failed ? 'border-red-200 bg-red-50' : 'bg-muted/30')}
        title="Every load of the front page and By Channel in the last 24 hours (dashboard_load_log, written by the dashboard-data function). Slowest = the longest successful load; p95 = 95% of loads were at least this fast."
      >
        <div className="flex items-center justify-between gap-2">
          <span className="font-medium">Front page &amp; By Channel loads · 24 h</span>
          <span className={cn('flex items-center gap-1 font-medium', failed ? 'text-red-700' : 'text-emerald-700')}>
            {failed ? <AlertTriangle className="h-3.5 w-3.5" /> : null}
            {failed ? `${d.failed24h} failed` : 'no failures'}
          </span>
        </div>
        <div className="mt-0.5 text-muted-foreground">
          {d.loads24h} loads
          {d.p95Ms24h != null && <> · p95 {fmtDuration(d.p95Ms24h)}</>}
          {d.maxMs24h != null && <> · slowest {fmtDuration(d.maxMs24h)}</>}
        </div>
        {d.lastFailure && (
          <div className="mt-1 text-red-700" title={d.lastFailure.message ?? ''}>
            Last failure {fmtDateTime(d.lastFailure.at)}
            {d.lastFailure.from && <> · {d.lastFailure.from} to {d.lastFailure.to}</>}
            {d.lastFailure.message && <>: {d.lastFailure.message.slice(0, 90)}</>}
          </div>
        )}
      </div>
    );
  }

  // ---------- master auto-refresh card ----------
  function renderMaster(c: ConnectionInfo) {
    const hours = getHours(c);
    const dirty = hourEdits[c.id] !== undefined;
    const running = (c.runs ?? []).some((r) => r.status === 'running');
    return (
      <div key={c.id} className="rounded-lg border p-3 space-y-3">
        {/* Header */}
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <span className={cn('h-2.5 w-2.5 rounded-full', c.cron?.driverActive ? 'bg-emerald-500' : 'bg-amber-500')} />
            <span className="text-sm font-semibold">{c.name}</span>
            {c.detail && <span className="text-xs text-muted-foreground">{c.detail}</span>}
          </div>
          <Button
            variant="outline"
            size="sm"
            className="h-7 gap-1.5 text-xs"
            onClick={() => syncNow(c)}
            disabled={syncing === c.id || running}
          >
            <RefreshCw className={cn('h-3 w-3', (syncing === c.id || running) && 'animate-spin')} />
            {running ? 'Refreshing…' : 'Refresh all now'}
          </Button>
        </div>

        {/* Multi-time schedule */}
        {c.cron && (
          <div className="space-y-1.5">
            <div className="flex flex-wrap items-center gap-2 text-xs">
              <Clock className="h-3.5 w-3.5 text-muted-foreground" />
              <span className="text-muted-foreground">Every day at</span>
              {hours.map((h) => (
                <span key={h} className="flex items-center gap-1 rounded border border-blue-500 bg-blue-50 px-1.5 py-0.5 text-blue-700">
                  {String(h).padStart(2, '0')}:00
                  <button type="button" onClick={() => setHours(c, hours.filter((x) => x !== h))} className="hover:text-blue-900">
                    <X className="h-3 w-3" />
                  </button>
                </span>
              ))}
              <select
                value=""
                onChange={(e) => e.target.value !== '' && setHours(c, [...hours, Number(e.target.value)])}
                className="h-6 rounded border bg-white px-1"
              >
                <option value="">+ time</option>
                {Array.from({ length: 24 }, (_, h) => h).filter((h) => !hours.includes(h)).map((h) => (
                  <option key={h} value={h}>{String(h).padStart(2, '0')}:00</option>
                ))}
              </select>
              <span className="text-muted-foreground">Brisbane</span>
              <Button
                variant="outline"
                size="sm"
                className="h-6 px-2 text-xs"
                onClick={() => saveHours(c)}
                disabled={savingSchedule === c.id || !dirty}
              >
                {savingSchedule === c.id ? 'Saving…' : 'Save'}
              </Button>
            </div>
            {!c.cron.driverActive && (
              <p className="flex items-center gap-1 text-[11px] text-amber-600">
                <AlertTriangle className="h-3 w-3" /> refresh engine (driver) is inactive — runs won't advance
              </p>
            )}
          </div>
        )}

        {/* Runs log — separated from the schedule config above */}
        <div className="space-y-1 border-t pt-2.5">
          <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">Recent updates</p>
          {(c.runs ?? []).length === 0 && <p className="text-xs text-muted-foreground">No runs yet.</p>}
          <div className="max-h-64 space-y-0.5 overflow-y-auto pr-0.5">
            {(c.runs ?? []).map((r) => (
              <RunRow key={r.id} run={r} />
            ))}
          </div>
        </div>
      </div>
    );
  }

  // ---------- fast interval card (its own module, at master level) ----------
  function renderFast(c: ConnectionInfo) {
    const minutes = c.cron?.intervalMinutes ?? 15;
    return (
      <div key={c.id} className="rounded-lg border p-3 space-y-2.5">
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <span className={cn('h-2.5 w-2.5 rounded-full', c.cron?.active ? 'bg-emerald-500' : 'bg-amber-500')} />
            <span className="text-sm font-semibold">{c.name}</span>
            {c.detail && <span className="text-xs text-muted-foreground">{c.detail}</span>}
          </div>
          {SYNC_FUNCTIONS[c.id] && (
            <Button variant="outline" size="sm" className="h-7 gap-1.5 text-xs" onClick={() => syncNow(c)} disabled={!c.connected || syncing === c.id}>
              <RefreshCw className={cn('h-3 w-3', syncing === c.id && 'animate-spin')} />
              {syncing === c.id ? 'Syncing…' : 'Sync now'}
            </Button>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-2 text-xs">
          <Clock className="h-3.5 w-3.5 text-muted-foreground" />
          <span className="text-muted-foreground">Refresh every</span>
          <div className="flex items-center gap-1">
            {FAST_INTERVAL_OPTIONS.map((m) => (
              <button
                key={m}
                type="button"
                onClick={() => m !== minutes && saveInterval(c, m)}
                disabled={savingSchedule === c.id}
                className={cn(
                  'h-6 rounded border px-2 text-[11px] font-medium transition-colors',
                  m === minutes ? 'border-blue-500 bg-blue-50 text-blue-700' : 'border-gray-200 text-gray-500 hover:border-gray-300',
                )}
              >
                {m}m
              </button>
            ))}
          </div>
          {savingSchedule === c.id && <span className="text-muted-foreground">saving…</span>}
          {!c.cron?.active && <span className="text-amber-600">paused</span>}
        </div>
      </div>
    );
  }

  // ---------- per-source card ----------
  function renderConnection(c: ConnectionInfo) {
    const edit = getEdit(c);
    const last = c.lastSync;
    return (
      <div key={c.id} className="rounded-lg border p-3 space-y-2.5">
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <span className={cn('h-2.5 w-2.5 rounded-full', c.connected ? 'bg-emerald-500' : 'bg-red-500')} />
            <span className="text-sm font-medium">{c.name}</span>
            {c.detail && <span className="text-xs text-muted-foreground">{c.detail}</span>}
            <span className={cn(
              'rounded-full px-1.5 py-0.5 text-[10px] font-semibold',
              c.connected ? 'bg-emerald-50 text-emerald-700' : 'bg-red-50 text-red-700',
            )}>
              {c.connected ? 'CONNECTED' : 'NOT CONNECTED'}
            </span>
          </div>
          {SYNC_FUNCTIONS[c.id] && (
            <Button
              variant="outline"
              size="sm"
              className="h-7 gap-1.5 text-xs"
              onClick={() => syncNow(c)}
              disabled={!c.connected || syncing === c.id}
            >
              <RefreshCw className={cn('h-3 w-3', syncing === c.id && 'animate-spin')} />
              {syncing === c.id ? 'Syncing…' : 'Sync now'}
            </Button>
          )}
        </div>

        <div className="text-xs text-muted-foreground">
          {last ? (
            <span className="flex items-center gap-1.5">
              {last.ok ? <Check className="h-3 w-3 text-emerald-600" /> : <AlertTriangle className="h-3 w-3 text-red-600" />}
              Last sync: {fmtDateTime(last.at)}
              {last.ok ? ' — OK' : ` — FAILED: ${last.error ?? 'unknown error'}`}
            </span>
          ) : 'No sync recorded yet'}
          {c.tokenUpdatedAt && <span className="ml-2">· token refreshed {fmtDateTime(c.tokenUpdatedAt)}</span>}
        </div>

        {c.cron && (
          <div className="flex flex-wrap items-center gap-2 text-xs">
            <span className="text-muted-foreground">Auto-sync:</span>
            <div className="flex items-center gap-0.5">
              {DAY_LABELS.map((label, day) => {
                const selected = edit.days.length === 0 || edit.days.includes(day);
                const explicit = edit.days.includes(day);
                return (
                  <button
                    key={day}
                    type="button"
                    onClick={() => toggleDay(c, day)}
                    title={edit.days.length === 0 ? 'Every day (click to restrict)' : undefined}
                    className={cn(
                      'h-6 w-7 rounded border text-[10px] font-medium',
                      explicit ? 'border-blue-500 bg-blue-50 text-blue-700'
                        : selected ? 'border-gray-200 bg-gray-50 text-gray-500'
                          : 'border-gray-200 text-gray-300',
                    )}
                  >
                    {label}
                  </button>
                );
              })}
            </div>
            <span className="text-muted-foreground">{edit.days.length === 0 ? '(every day)' : ''} at</span>
            <select
              value={edit.hourAest}
              onChange={(e) => setEdits((prev) => ({ ...prev, [c.id]: { ...edit, hourAest: Number(e.target.value) } }))}
              className="h-6 rounded border bg-white px-1"
            >
              {Array.from({ length: 24 }, (_, h) => (
                <option key={h} value={h}>{String(h).padStart(2, '0')}:00</option>
              ))}
            </select>
            <span className="text-muted-foreground">Brisbane</span>
            <Button variant="outline" size="sm" className="h-6 px-2 text-xs" onClick={() => saveSchedule(c)} disabled={savingSchedule === c.id}>
              {savingSchedule === c.id ? 'Saving…' : 'Save schedule'}
            </Button>
            {!c.cron.active && <span className="text-red-600">cron inactive!</span>}
          </div>
        )}
      </div>
    );
  }
}

/** One run in the log: a tidy collapsed summary; click to expand every step's
 *  full detail (rows, duration, error message). */
function RunRow({ run }: { run: RunLog }) {
  const [open, setOpen] = useState(false);
  const overall = run.status;
  const badge =
    overall === 'done' ? { cls: 'bg-emerald-100 text-emerald-700', label: 'OK' }
      : overall === 'error' ? { cls: 'bg-red-100 text-red-700', label: 'PARTIAL' }
        : { cls: 'bg-blue-100 text-blue-700', label: 'RUNNING' };
  const durationMs = run.finished_at
    ? new Date(run.finished_at).getTime() - new Date(run.started_at).getTime()
    : null;
  const failed = run.steps.filter((s) => s.status !== 'ok');
  const okCount = run.steps.length - failed.length;
  const pending = overall === 'running' ? Math.max(0, run.total_steps - run.steps.length) : 0;

  return (
    <div className="rounded-md border text-xs">
      {/* Collapsed summary — the whole thing is a toggle */}
      <button type="button" onClick={() => setOpen((o) => !o)} className="w-full px-2 py-1.5 text-left hover:bg-muted/40">
        <div className="flex items-center gap-1.5">
          <ChevronRight className={cn('h-3 w-3 shrink-0 text-muted-foreground transition-transform', open && 'rotate-90')} />
          <span className={cn('rounded px-1 py-0.5 text-[9px] font-bold tracking-wide', badge.cls)}>{badge.label}</span>
          <span className="text-muted-foreground">{fmtDateTime(run.started_at)}</span>
          {run.trigger && <span className="rounded bg-muted px-1 py-px text-[9px] text-muted-foreground">{run.trigger}</span>}
          <span className="ml-auto tabular-nums text-muted-foreground">
            <span className={failed.length ? 'text-red-600' : 'text-emerald-600'}>{okCount}</span>
            <span className="text-muted-foreground">/{run.total_steps}</span>
            {overall !== 'running' && durationMs != null && <span className="ml-1.5">{fmtDuration(durationMs)}</span>}
          </span>
        </div>
        {/* One dot per step */}
        <div className="mt-1 flex flex-wrap items-center gap-[3px] pl-[18px]">
          {run.steps.map((s, i) => (
            <span
              key={i}
              className={cn('h-2 w-2 rounded-full', s.status === 'ok' ? 'bg-emerald-500' : 'bg-red-500 ring-2 ring-red-200')}
            />
          ))}
          {Array.from({ length: pending }, (_, i) => (
            <span key={`p${i}`} className="h-2 w-2 rounded-full bg-gray-200" />
          ))}
        </div>
        {failed.length > 0 && !open && (
          <div className="mt-1 flex items-start gap-1 pl-[18px] text-[11px] text-red-600">
            <AlertTriangle className="mt-px h-3 w-3 shrink-0" />
            <span>{failed.map((s) => shortStep(s.name)).join(', ')}</span>
          </div>
        )}
      </button>

      {/* Expanded — every step, full detail */}
      {open && (
        <div className="space-y-0.5 border-t px-2 py-1.5">
          {run.steps.map((s, i) => (
            <div key={i}>
              <div className="flex items-center gap-1.5">
                <span className={cn('h-1.5 w-1.5 shrink-0 rounded-full', s.status === 'ok' ? 'bg-emerald-500' : 'bg-red-500')} />
                <span className={cn(s.status !== 'ok' && 'font-medium text-red-600')}>{shortStep(s.name)}</span>
                <span className="ml-auto tabular-nums text-muted-foreground">
                  {s.rows != null && <span>{s.rows.toLocaleString('en-AU')} rows · </span>}{fmtDuration(s.ms)}
                </span>
              </div>
              {s.message && <div className="pl-3 text-[11px] text-red-600">{s.message}</div>}
            </div>
          ))}
          {pending > 0 && <div className="pl-3 text-[11px] text-muted-foreground">{pending} step{pending > 1 ? 's' : ''} pending…</div>}
        </div>
      )}
    </div>
  );
}
