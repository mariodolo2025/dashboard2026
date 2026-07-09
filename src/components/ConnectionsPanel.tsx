// =============================================================================
// Connections panel — status + auto-sync schedule per external connection.
//
// Rendered inside the Config dialog. Generic: it lists whatever the
// connection-status edge function reports, so adding Unleashed/Shopify/Meta
// later only requires registering them server-side.
//
// Per connection: liveness dot, org/detail, last sync (time + result),
// schedule editor (days of week + hour, Brisbane time) and a Sync now button
// that calls the connection's own sync function.
// =============================================================================

import { useCallback, useEffect, useState } from 'react';
import { RefreshCw, Check, AlertTriangle, Plug } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

interface ConnectionCron {
  schedule: string;
  active: boolean;
  aest: { days: number[]; hourAest: number } | null;
}

interface ConnectionInfo {
  id: string;
  name: string;
  connected: boolean;
  detail?: string;
  tokenUpdatedAt?: string | null;
  lastSync?: { at: string; ok: boolean; step?: string; error?: string } | null;
  cron: ConnectionCron | null;
}

/** Which function to invoke for "Sync now", per connection id. */
const SYNC_FUNCTIONS: Record<string, { fn: string; body: unknown }> = {
  xero: { fn: 'xero-sync', body: { step: 'all' } },
  'unleashed-sales': { fn: 'unleashed-sales-sync', body: {} },
};

const DAY_LABELS = ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'];

const baseUrl = () => import.meta.env.VITE_SUPABASE_URL;
const authHeaders = () => ({
  Authorization: `Bearer ${import.meta.env.VITE_SUPABASE_ANON_KEY}`,
  'Content-Type': 'application/json',
});

export function ConnectionsPanel() {
  const [connections, setConnections] = useState<ConnectionInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [syncing, setSyncing] = useState<string | null>(null);
  const [savingSchedule, setSavingSchedule] = useState<string | null>(null);
  // Local schedule edits keyed by connection id.
  const [edits, setEdits] = useState<Record<string, { days: number[]; hourAest: number }>>({});

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`${baseUrl()}/functions/v1/connection-status`, { headers: authHeaders() });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = await res.json();
      setConnections(body.connections ?? []);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load connections');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

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
      setEdits((prev) => {
        const next = { ...prev };
        delete next[c.id];
        return next;
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to save schedule');
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

      {connections.map((c) => {
        const edit = getEdit(c);
        const last = c.lastSync;
        return (
          <div key={c.id} className="rounded-lg border p-3 space-y-2.5">
            {/* Status row */}
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
            </div>

            {/* Last sync */}
            <div className="text-xs text-muted-foreground">
              {last ? (
                <span className="flex items-center gap-1.5">
                  {last.ok
                    ? <Check className="h-3 w-3 text-emerald-600" />
                    : <AlertTriangle className="h-3 w-3 text-red-600" />}
                  Last sync: {new Date(last.at).toLocaleString('en-AU', { dateStyle: 'medium', timeStyle: 'short' })}
                  {last.ok ? ' — OK' : ` — FAILED: ${last.error ?? 'unknown error'}`}
                </span>
              ) : (
                'No sync recorded yet'
              )}
              {c.tokenUpdatedAt && (
                <span className="ml-2">
                  · token refreshed {new Date(c.tokenUpdatedAt).toLocaleString('en-AU', { dateStyle: 'medium', timeStyle: 'short' })}
                </span>
              )}
            </div>

            {/* Schedule editor */}
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
                          explicit
                            ? 'border-blue-500 bg-blue-50 text-blue-700'
                            : selected
                              ? 'border-gray-200 bg-gray-50 text-gray-500'
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
                <Button
                  variant="outline"
                  size="sm"
                  className="h-6 px-2 text-xs"
                  onClick={() => saveSchedule(c)}
                  disabled={savingSchedule === c.id}
                >
                  {savingSchedule === c.id ? 'Saving…' : 'Save schedule'}
                </Button>
                {!c.cron.active && <span className="text-red-600">cron inactive!</span>}
              </div>
            )}
          </div>
        );
      })}

      {!loading && connections.length === 0 && !error && (
        <p className="text-xs text-muted-foreground">No connections registered.</p>
      )}
    </div>
  );
}
