import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AlertCircle, ArrowRight, ChevronRight, FileClock, LockKeyhole, Plus, RefreshCw, ShieldCheck } from 'lucide-react';
import {
  BALANCE_HELP, type BalanceBundle, type BalanceLine, type BalanceSnapshot, type DoloBalanceAccess,
  changeInCents, decimalToCents, defaultAsAtDate, formatAsAt, formatMoney, snapshotCutoffDate, summarizeBalance,
} from '@/lib/doloBalance';
import { closeBalanceSnapshot, createBalanceSnapshot, listBalanceSnapshots, loadBalanceSnapshot, restateBalanceSnapshot } from '@/lib/doloBalanceApi';
import { BalanceLineDetails } from './BalanceLineDetails';
import { BalanceAccessPanel } from './BalanceAccessPanel';
import { DoloConfirm, DoloDrawer, DoloHelp } from './DoloPrimitives';
import './dolo-balance.css';

export interface DoloBalanceContentProps { access: DoloBalanceAccess; onPrintMetadata?: (text: string) => void }

function signedMoney(value: bigint | null) { return value === null ? '—' : `${value > 0n ? '+' : ''}${formatMoney(value, false)}`; }
function failureText(failure: unknown) { return failure instanceof Error ? failure.message : 'DOLO Balance is unavailable. No financial data has been loaded.'; }
function snapshotLabel(snapshot: BalanceSnapshot) { return `${formatAsAt(snapshot.as_at_date)} · v${snapshot.version}${snapshot.status === 'closed' ? '' : ' · Draft'}`; }

function Kpi({ label, help, value, note, hero = false }: { label: string; help: string; value: bigint | null; note: string; hero?: boolean }) {
  return <div className={`dolo-kpi ${hero ? 'dolo-kpi-hero' : ''} ${value !== null && formatMoney(value, false).length > 14 ? 'dolo-kpi-long' : ''}`}>
    <h2 className="dolo-kpi-title"><DoloHelp label={label}>{help}</DoloHelp></h2>
    <div className={`dolo-kpi-amount ${value === null ? 'dolo-kpi-pending' : ''}`}>{value === null ? 'Pending' : <><span className="dolo-currency">AUD</span>{formatMoney(value, false)}</>}</div>
    <p className="dolo-kpi-note">{note}</p>
  </div>;
}

function BalanceSection({ title, help, lines, comparison, total, kind, onSelect }: {
  title: string; help: string; lines: BalanceLine[]; comparison: BalanceLine[]; total: bigint | null;
  kind: 'asset' | 'liability' | 'unclassified'; onSelect: (key: string) => void;
}) {
  return <section className={`dolo-section dolo-section-${kind} ${total !== null && formatMoney(total, false).length > 14 ? 'dolo-section-long' : ''}`} aria-label={title}>
    <div className="dolo-section-header"><h2><DoloHelp label={title}>{help}</DoloHelp></h2>{kind !== 'unclassified' && <div className="dolo-section-total"><small>{total === null ? 'Incomplete' : 'Total'}</small>{formatMoney(total)}</div>}</div>
    <div className="dolo-row-head"><span>All amounts in AUD</span><span>At cut-off</span><span><DoloHelp label="Change">{BALANCE_HELP.change}</DoloHelp></span><span /></div>
    {lines.map((line) => {
      const previous = comparison.find((candidate) => candidate.key === line.key);
      const reference = line.classification === 'reference' || !line.is_included;
      const change = previous && previous.classification === line.classification && previous.is_included === line.is_included ? changeInCents(line.amount_aud, previous.amount_aud) : null;
      const longAmount = formatMoney(decimalToCents(line.amount_aud), false).length > 12 || signedMoney(change).length > 12;
      return <button key={line.id} type="button" onClick={() => onSelect(line.key)} className={`dolo-line ${reference ? 'dolo-line-reference' : ''} ${longAmount ? 'dolo-line-wide' : ''}`} aria-label={`View ${line.label} details`}>
        <span className="dolo-line-label">{line.label}{reference && <span className="dolo-line-subtitle">{line.key === 'meta_usd' ? 'Included in Meta' : 'Reference only · excluded'}</span>}{!reference && line.status !== 'reviewed' && line.amount_aud !== null && <span className="dolo-line-subtitle">Pending review</span>}</span>
        <span className={`dolo-line-amount ${line.amount_aud === null && !reference ? 'dolo-line-missing' : ''}`}>{reference ? '—' : line.amount_aud === null ? 'Not entered' : formatMoney(decimalToCents(line.amount_aud), false)}</span>
        <span className="dolo-line-change">{reference ? '—' : signedMoney(change)}</span><ChevronRight size={13} aria-hidden="true" />
      </button>;
    })}
    {!lines.length && <p className="dolo-muted" style={{ padding: '5px 9px 15px' }}>No lines classified here yet.</p>}
  </section>;
}

export function DoloBalanceContent({ access, onPrintMetadata }: DoloBalanceContentProps) {
  const [snapshots, setSnapshots] = useState<BalanceSnapshot[]>([]);
  const [selectedId, setSelectedId] = useState('');
  const [comparisonId, setComparisonId] = useState('');
  const [bundle, setBundle] = useState<BalanceBundle | null>(null);
  const [comparison, setComparison] = useState<BalanceBundle | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingSnapshot, setLoadingSnapshot] = useState(false);
  const [loadingComparison, setLoadingComparison] = useState(false);
  const [error, setError] = useState('');
  const [comparisonError, setComparisonError] = useState('');
  const [selectedLineKey, setSelectedLineKey] = useState<string | null>(null);
  const [accessOpen, setAccessOpen] = useState(false);
  const [confirmation, setConfirmation] = useState<'create' | 'close' | 'restate' | null>(null);
  const [newMonth, setNewMonth] = useState(defaultAsAtDate().slice(0, 7));
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [lineSaving, setLineSaving] = useState(false);
  const [actionError, setActionError] = useState('');
  const requestId = useRef(0);

  const reloadList = useCallback(async (preferredId?: string) => {
    const result = (await listBalanceSnapshots()).sort((a, b) => b.as_at_date.localeCompare(a.as_at_date) || b.version - a.version);
    setSnapshots(result);
    setSelectedId((current) => preferredId || (result.some((snapshot) => snapshot.id === current) ? current : result[0]?.id || ''));
    return result;
  }, []);

  useEffect(() => {
    if (!access.can_view) { setLoading(false); return; }
    let cancelled = false;
    setLoading(true); setError('');
    listBalanceSnapshots().then((result) => {
      if (cancelled) return;
      result.sort((a, b) => b.as_at_date.localeCompare(a.as_at_date) || b.version - a.version);
      setSnapshots(result); setSelectedId(result[0]?.id || '');
    }).catch((failure) => { if (!cancelled) setError(failureText(failure)); }).finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [access.can_view]);

  useEffect(() => {
    const version = ++requestId.current;
    let cancelled = false;
    setBundle(null); setSelectedLineKey(null); setComparison(null); setComparisonId('');
    if (!selectedId || !access.can_view) return;
    setLoadingSnapshot(true); setError('');
    loadBalanceSnapshot(selectedId).then((result) => {
      if (cancelled || version !== requestId.current) return;
      setBundle(result);
      const previous = snapshots.find((snapshot) => snapshot.status === 'closed' && snapshot.as_at_date < result.snapshot.as_at_date);
      setComparisonId(previous?.id || '');
    }).catch((failure) => { if (!cancelled && version === requestId.current) setError(failureText(failure)); }).finally(() => { if (!cancelled && version === requestId.current) setLoadingSnapshot(false); });
    return () => { cancelled = true; };
    // Snapshot list updates during a save must not reset the user's comparison selection.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedId, access.can_view]);

  useEffect(() => {
    let cancelled = false;
    setComparison(null); setComparisonError('');
    if (!comparisonId || !access.can_view) { setLoadingComparison(false); return; }
    setLoadingComparison(true);
    loadBalanceSnapshot(comparisonId).then((result) => { if (!cancelled) setComparison(result); }).catch((failure) => { if (!cancelled) setComparisonError(failureText(failure)); }).finally(() => { if (!cancelled) setLoadingComparison(false); });
    return () => { cancelled = true; };
  }, [comparisonId, access.can_view]);

  const summary = useMemo(() => summarizeBalance(bundle?.lines ?? [], bundle?.snapshot.as_at_date), [bundle]);
  const previousSummary = useMemo(() => comparison ? summarizeBalance(comparison.lines, comparison.snapshot.as_at_date) : null, [comparison]);
  const selectedLine = bundle?.lines.find((line) => line.key === selectedLineKey) ?? null;
  const sortedLines = useMemo(() => [...(bundle?.lines ?? [])].sort((a, b) => a.sort_order - b.sort_order), [bundle]);
  const assets = sortedLines.filter((line) => line.classification === 'asset');
  const liabilities = sortedLines.filter((line) => line.classification === 'liability' || (line.key === 'meta_usd' && line.classification === 'reference'));
  const unclassified = sortedLines.filter((line) => line.classification === 'unclassified' || (line.classification === 'reference' && line.key !== 'meta_usd'));
  const selectedSnapshot = bundle?.snapshot;
  const metadata = selectedSnapshot ? `As at ${formatAsAt(selectedSnapshot.as_at_date)} · Cut-off ${formatAsAt(snapshotCutoffDate(selectedSnapshot.as_at_date))}, end of day Brisbane · Version ${selectedSnapshot.version} · ${selectedSnapshot.status === 'closed' ? 'Closed snapshot' : 'Draft — pending review'}` : 'DOLO Balance · No snapshot loaded';

  useEffect(() => { onPrintMetadata?.(metadata); }, [metadata, onPrintMetadata]);

  async function reloadCurrent() {
    if (!selectedId) return;
    const generation = requestId.current;
    const result = await loadBalanceSnapshot(selectedId);
    if (generation !== requestId.current) return;
    setBundle(result);
    await reloadList();
  }

  async function retry() {
    setLoading(true); setError('');
    try { await reloadList(); if (selectedId) await reloadCurrent(); }
    catch (failure) { setError(failureText(failure)); }
    finally { setLoading(false); }
  }

  async function performAction() {
    if (busy) return;
    setBusy(true); setActionError('');
    try {
      if (confirmation === 'create') {
        if (!access.can_edit) throw new Error('Edit permission is required.');
        if (!/^\d{4}-\d{2}$/.test(newMonth)) throw new Error('Select a snapshot month.');
        const id = await createBalanceSnapshot(`${newMonth}-01`);
        await reloadList(id);
      } else if (confirmation === 'close' && selectedSnapshot) {
        if (!access.can_close || !summary.readyToClose) throw new Error('Complete every review check before closing.');
        await closeBalanceSnapshot(selectedSnapshot.id, selectedSnapshot.revision);
        await reloadCurrent();
      } else if (confirmation === 'restate' && selectedSnapshot) {
        if (!access.can_close || !access.can_edit) throw new Error('Edit and Close permissions are required for a correction.');
        if (!reason.trim()) throw new Error('Enter a reason for the correction.');
        const id = await restateBalanceSnapshot(selectedSnapshot.id, reason.trim());
        await reloadList(id);
      }
      setConfirmation(null); setReason('');
    } catch (failure) { setActionError(failureText(failure)); }
    finally { setBusy(false); }
  }

  const openConfirmation = (action: 'create' | 'close' | 'restate') => { setActionError(''); setReason(''); setConfirmation(action); };
  const previousNote = (value: bigint | null | undefined) => !comparison ? 'No comparison selected' : value === null || value === undefined ? 'Comparison incomplete' : `Previous: ${formatMoney(value)}`;
  const netChange = summary.net !== null && previousSummary?.net !== null && previousSummary?.net !== undefined ? summary.net - previousSummary.net : null;

  if (!access.can_view) return <div className="dolo-balance"><div className="dolo-empty"><LockKeyhole size={30} /><h2>Restricted report</h2><p>You do not have permission to view DOLO Balance. No balance data has been loaded.</p></div></div>;

  return <div className="dolo-balance"><div className="dolo-balance-inner">
    <header className="dolo-heading">
      <div><p className="dolo-eyebrow" style={{ marginBottom: 8 }}>Reports / Monthly position</p><h1>DOLO Balance</h1><p>What we have, what we owe and what's left.</p></div>
      {snapshots.length > 0 && <div className="dolo-controls reports-no-print">
        <label className="dolo-field"><span>Snapshot</span><select value={selectedId} onChange={(event) => setSelectedId(event.target.value)} disabled={busy}>{snapshots.map((snapshot) => <option key={snapshot.id} value={snapshot.id}>{snapshotLabel(snapshot)}</option>)}</select></label>
        <label className="dolo-field"><span>Compare with</span><select value={comparisonId} onChange={(event) => setComparisonId(event.target.value)} disabled={busy || loadingSnapshot}><option value="">No comparison</option>{snapshots.filter((snapshot) => snapshot.id !== selectedId && snapshot.status === 'closed').map((snapshot) => <option key={snapshot.id} value={snapshot.id}>{snapshotLabel(snapshot)}</option>)}</select></label>
      </div>}
    </header>
    <div className="dolo-toolbar">
      <div>{selectedSnapshot ? <><span className={`dolo-status ${selectedSnapshot.status === 'closed' ? 'dolo-status-closed' : ''}`}>{selectedSnapshot.status === 'closed' ? <LockKeyhole size={12} /> : <FileClock size={12} />}{selectedSnapshot.status === 'closed' ? 'Closed' : 'Pending review'} · v{selectedSnapshot.version}</span>{selectedSnapshot.status !== 'closed' && <span className="dolo-progress" style={{ marginLeft: 10 }}>{bundle!.lines.length - summary.pendingCount} / {bundle!.lines.length} lines ready</span>}</> : <span className="dolo-muted">Monthly snapshots · AUD</span>}</div>
      <div className="dolo-toolbar-actions reports-no-print">
        {selectedSnapshot && <button className="dolo-button" type="button" onClick={retry} disabled={busy || loading || loadingSnapshot}><RefreshCw size={13} /> Reload</button>}
        {access.can_manage_access && <button className="dolo-button" type="button" onClick={() => setAccessOpen(true)}><ShieldCheck size={14} /> Access</button>}
        {access.can_edit && !error && <button className="dolo-button" type="button" onClick={() => openConfirmation('create')} disabled={loading || loadingSnapshot}><Plus size={14} /> New snapshot</button>}
        {selectedSnapshot?.status === 'draft' && access.can_close && <button className="dolo-button dolo-button-primary" type="button" onClick={() => openConfirmation('close')} disabled={busy || !summary.readyToClose}><LockKeyhole size={13} /> Close snapshot</button>}
        {selectedSnapshot?.status === 'closed' && access.can_close && access.can_edit && <button className="dolo-button" type="button" onClick={() => openConfirmation('restate')} disabled={busy}>Create correction</button>}
      </div>
    </div>
    {(loading || loadingSnapshot) && <div className="dolo-empty" role="status"><RefreshCw size={27} className="animate-spin" /><h2>Loading snapshot</h2><p>Fetching the saved balances and review status.</p></div>}
    {!loading && !loadingSnapshot && error && <div className="dolo-empty"><AlertCircle size={30} /><h2>DOLO Balance is unavailable</h2><p role="alert">{error}</p><p>No substitute or example balances are shown.</p><button className="dolo-button" type="button" onClick={retry}><RefreshCw size={14} /> Retry</button></div>}
    {!loading && !loadingSnapshot && !error && !bundle && <div className="dolo-empty"><FileClock size={34} /><h2>No snapshots yet</h2><p>The first snapshot starts with Andrea's original balance lines and no amounts. Enter source-backed values, confirm the classifications and review before closing.</p>{access.can_edit ? <button className="dolo-button dolo-button-primary" type="button" onClick={() => openConfirmation('create')}>Create first snapshot <ArrowRight size={14} /></button> : <p>An authorised editor needs to create the first monthly snapshot.</p>}</div>}
    {!loading && !loadingSnapshot && !error && bundle && <>
      {summary.issues.length > 0 && <div className="dolo-notice"><AlertCircle size={16} /><span>{summary.unclassifiedCount ? `${summary.unclassifiedCount} line${summary.unclassifiedCount === 1 ? '' : 's'} still need classification. ` : ''}{summary.pendingCount ? `${summary.pendingCount} line${summary.pendingCount === 1 ? '' : 's'} need review or source information. ` : 'Snapshot validation is incomplete. '}This is not a validated balance. Missing values are not treated as zero.</span></div>}
      {comparisonError && <div className="dolo-notice dolo-notice-error" role="alert"><AlertCircle size={16} /><span>Comparison unavailable: {comparisonError}</span></div>}
      <div className={`dolo-kpis ${[summary.assets, summary.liabilities, summary.net, summary.availableCash].some((value) => value !== null && formatMoney(value, false).length > 14) ? 'dolo-kpis-long' : ''}`}>
        <Kpi label="Assets" help={BALANCE_HELP.assets} value={summary.assets} note={summary.assets === null ? assets.some((line) => line.is_included && line.amount_aud !== null) ? `Entered subtotal: ${formatMoney(summary.partialAssets)} · incomplete` : 'No source-backed amounts entered' : previousNote(previousSummary?.assets)} />
        <Kpi label="Liabilities" help={BALANCE_HELP.liabilities} value={summary.liabilities} note={summary.liabilities === null ? liabilities.some((line) => line.is_included && line.amount_aud !== null) ? `Entered subtotal: ${formatMoney(summary.partialLiabilities)} · incomplete` : 'No source-backed amounts entered' : previousNote(previousSummary?.liabilities)} />
        <Kpi label="Net position" help={BALANCE_HELP.net} value={summary.net} hero note={netChange !== null ? `${netChange > 0n ? '+' : ''}${formatMoney(netChange)} vs. comparison` : summary.net === null ? 'Complete the missing inputs to calculate' : previousNote(previousSummary?.net)} />
        <Kpi label="Available cash" help={BALANCE_HELP.availableCash} value={summary.availableCash} note={summary.availableCash === null ? 'Availability requires separate verification' : 'Already included in Assets'} />
      </div>
      {loadingComparison && <p className="dolo-muted" role="status">Loading comparison…</p>}
      <div className="dolo-sections">
        <BalanceSection title="Assets" help={BALANCE_HELP.assets} lines={assets} comparison={comparison?.lines ?? []} total={summary.assets} kind="asset" onSelect={setSelectedLineKey} />
        <BalanceSection title="Liabilities" help={BALANCE_HELP.liabilities} lines={liabilities} comparison={comparison?.lines ?? []} total={summary.liabilities} kind="liability" onSelect={setSelectedLineKey} />
        {unclassified.length > 0 && <BalanceSection title="Awaiting classification / reference" help={BALANCE_HELP.pending} lines={unclassified} comparison={comparison?.lines ?? []} total={null} kind="unclassified" onSelect={setSelectedLineKey} />}
      </div>
      <footer className="dolo-footer"><span>Cut-off: {formatAsAt(snapshotCutoffDate(bundle.snapshot.as_at_date))} · end of day · Brisbane</span><span>Select a line to view its source and supporting document.</span><span><DoloHelp label="Source-backed manual entries">{BALANCE_HELP.source}</DoloHelp></span></footer>
    </>}

    <DoloDrawer open={!!selectedLine} title={selectedLine?.label || 'Balance details'} description={selectedSnapshot ? `As at ${formatAsAt(selectedSnapshot.as_at_date)} · Version ${selectedSnapshot.version}` : ''} onClose={() => { if (!lineSaving) setSelectedLineKey(null); }} canDismiss={!lineSaving}>
      {selectedLine && selectedSnapshot && <BalanceLineDetails key={`${selectedLine.id}:${selectedLine.revision}`} line={selectedLine} snapshot={selectedSnapshot} canEdit={access.can_edit} onSaved={reloadCurrent} onBusyChange={setLineSaving} />}
    </DoloDrawer>
    {access.can_manage_access && <DoloDrawer open={accessOpen} title="DOLO Balance access" description="Manage permissions for existing dashboard users." onClose={() => setAccessOpen(false)}>{accessOpen && <BalanceAccessPanel />}</DoloDrawer>}
    <DoloConfirm open={confirmation !== null} title={confirmation === 'create' ? 'Create monthly snapshot' : confirmation === 'close' ? 'Close this snapshot?' : 'Create a correction version'} description={confirmation === 'create' ? 'Create a real draft with empty amounts. The snapshot represents the previous month-end, as at the first day of the selected month.' : confirmation === 'close' ? 'This freezes the reviewed values and supporting documents. Later source updates cannot change this version. Corrections require a new version.' : 'The closed version stays unchanged. A new draft is created for corrections and must be reviewed and closed separately.'} confirmLabel={confirmation === 'create' ? 'Create draft' : confirmation === 'close' ? 'Confirm and close' : 'Create correction'} busy={busy} onConfirm={performAction} onClose={() => { if (!busy) setConfirmation(null); }}>
      {confirmation === 'create' && <label className="dolo-field"><span>Snapshot month</span><input type="month" value={newMonth} onChange={(event) => setNewMonth(event.target.value)} max={defaultAsAtDate().slice(0, 7)} disabled={busy} /></label>}
      {confirmation === 'restate' && <label className="dolo-field"><span>Reason for correction</span><textarea value={reason} onChange={(event) => setReason(event.target.value)} disabled={busy} required /></label>}
      {confirmation === 'close' && selectedSnapshot && <p className="dolo-muted">{metadata}<br />{bundle?.lines.length} balance lines checked. Assets {formatMoney(summary.assets)} · Liabilities {formatMoney(summary.liabilities)} · Net position {formatMoney(summary.net)}.</p>}
      {actionError && <div className="dolo-notice dolo-notice-error" role="alert"><AlertCircle size={16} /><span>{actionError}</span></div>}
    </DoloConfirm>
  </div></div>;
}
