// =============================================================================
// Google spend entry — Juan's manual load
// =============================================================================
// The only write path into google_ads_daily until the Google Ads API token
// arrives (see supabase/functions/google-ads-load/index.ts). One date, one
// row per non-empty campaign, one POST with all of them. The function
// enforces the campaign enum, validates the date, dedupes and upserts by
// (date, campaign) — the audit identity comes from the session, never from
// the client.

import { useState } from 'react';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { supabase } from '@/lib/supabase';
import { storeToday } from '@/lib/storeDate';

// The DB enum for google_ads_daily.campaign — must match it exactly.
const CAMPAIGNS = ['brand-search', 'non-brand', 'shopping'] as const;
type CampaignKey = (typeof CAMPAIGNS)[number];

type RowState = { spend: string; conversions: string; value: string };
type FormState = Record<CampaignKey, RowState>;

const emptyState = (): FormState => ({
  'brand-search': { spend: '', conversions: '', value: '' },
  'non-brand': { spend: '', conversions: '', value: '' },
  shopping: { spend: '', conversions: '', value: '' },
});

type Status =
  | { kind: 'success'; upserted: number }
  | { kind: 'error'; message: string; errors?: string[] }
  | null;

export interface GoogleSpendFormProps {
  /** Called after a successful save so the tab can refetch the dashboard. */
  onSaved: () => void;
}

export default function GoogleSpendForm({ onSaved }: GoogleSpendFormProps) {
  const [date, setDate] = useState(storeToday());
  const [rows, setRows] = useState<FormState>(emptyState());
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState<Status>(null);

  const setField = (campaign: CampaignKey, field: keyof RowState, value: string) => {
    setRows((r) => ({ ...r, [campaign]: { ...r[campaign], [field]: value } }));
  };

  const handleSave = async () => {
    // Empty campaign inputs are omitted from rows, never sent as 0 — the
    // null-never-0 rule reaches the UI. A real zero-spend day still needs an
    // explicit 0 typed in, same as the edge function's own contract.
    const payloadRows = CAMPAIGNS.flatMap((campaign) => {
      const row = rows[campaign];
      if (row.spend.trim() === '') return [];
      const r: Record<string, unknown> = { date, campaign, spend_aud: Number(row.spend) };
      if (row.conversions.trim() !== '') r.claimed_conversions = Number(row.conversions);
      if (row.value.trim() !== '') r.claimed_value_aud = Number(row.value);
      return [r];
    });

    if (payloadRows.length === 0) {
      setStatus({ kind: 'error', message: 'Cargá al menos un gasto.' });
      return;
    }

    setSaving(true);
    setStatus(null);
    try {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session?.access_token) {
        setStatus({ kind: 'error', message: 'Tu sesión expiró — recargá la página.' });
        return;
      }
      const res = await fetch(`${import.meta.env.VITE_SUPABASE_URL}/functions/v1/google-ads-load`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${session.access_token}`, // REAL session — the function rejects the anon key
          apikey: import.meta.env.VITE_SUPABASE_ANON_KEY,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ rows: payloadRows }), // no `actor`: the function derives it from the session
      });

      if (res.status === 401) {
        setStatus({ kind: 'error', message: 'Tu sesión expiró — recargá la página.' });
        return;
      }

      const body = await res.json().catch(() => ({ success: false, message: 'Respuesta inválida del servidor' }));
      if (!res.ok || body?.success === false) {
        setStatus({ kind: 'error', message: body?.message ?? 'Error al guardar', errors: body?.errors });
        return;
      }

      setStatus({ kind: 'success', upserted: body.upserted });
      setRows(emptyState());
      onSaved();
    } catch (e) {
      setStatus({ kind: 'error', message: e instanceof Error ? e.message : 'Error de red' });
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <label className="text-xs text-muted-foreground" htmlFor="google-spend-date">Fecha</label>
        <input
          id="google-spend-date"
          type="date"
          value={date}
          onChange={(e) => setDate(e.target.value)}
          className="h-8 rounded-md border bg-background px-2 text-xs"
        />
      </div>

      <table className="w-full text-sm">
        <thead>
          <tr className="text-[11px] uppercase tracking-wider text-muted-foreground">
            <th className="text-left font-medium pb-1.5">Campaña</th>
            <th className="text-right font-medium pb-1.5">Gasto AUD</th>
            <th className="text-right font-medium pb-1.5">Conversiones reclamadas</th>
            <th className="text-right font-medium pb-1.5">Valor reclamado AUD</th>
          </tr>
        </thead>
        <tbody>
          {CAMPAIGNS.map((campaign) => (
            <tr key={campaign} className="border-t border-border/40">
              <td className="py-1.5 font-medium">{campaign}</td>
              <td className="py-1.5">
                <Input
                  type="number" min="0" step="0.01" placeholder="—"
                  value={rows[campaign].spend}
                  onChange={(e) => setField(campaign, 'spend', e.target.value)}
                  className="h-8 text-right text-xs"
                />
              </td>
              <td className="py-1.5">
                <Input
                  type="number" min="0" step="1" placeholder="—"
                  value={rows[campaign].conversions}
                  onChange={(e) => setField(campaign, 'conversions', e.target.value)}
                  className="h-8 text-right text-xs"
                />
              </td>
              <td className="py-1.5">
                <Input
                  type="number" min="0" step="0.01" placeholder="—"
                  value={rows[campaign].value}
                  onChange={(e) => setField(campaign, 'value', e.target.value)}
                  className="h-8 text-right text-xs"
                />
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <div className="flex items-center gap-3">
        <Button size="sm" onClick={handleSave} disabled={saving}>
          {saving ? 'Guardando…' : 'Guardar'}
        </Button>
        {status?.kind === 'success' && (
          <span className="text-xs text-emerald-600 dark:text-emerald-400">
            Guardado: {status.upserted} filas
          </span>
        )}
      </div>

      {status?.kind === 'error' && (
        <div className="text-xs text-red-600 dark:text-red-400">
          {status.errors?.length ? (
            <ul className="list-disc pl-4 space-y-0.5">
              {status.errors.map((e, i) => <li key={i}>{e}</li>)}
            </ul>
          ) : (
            <p>{status.message}</p>
          )}
        </div>
      )}
    </div>
  );
}
