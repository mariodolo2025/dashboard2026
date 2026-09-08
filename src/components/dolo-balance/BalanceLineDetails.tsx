import { useState, type FormEvent } from 'react';
import { AlertCircle, ExternalLink, FileCheck2, LockKeyhole, Pencil } from 'lucide-react';
import { CASH_CONCEPT_KEYS, type BalanceLine, type BalanceLineInput, type BalanceSnapshot, balanceSourceLabel, formatCollectedAt, formatMoney, decimalToCents, formatAsAt, snapshotCutoffDate, lineIssues } from '@/lib/doloBalance';
import { getBalanceEvidenceUrl, saveBalanceLine, uploadBalanceEvidence } from '@/lib/doloBalanceApi';
import { DoloHelp } from './DoloPrimitives';
import { BalanceSourceProof } from './BalanceSourceProof';

function inputFor(line: BalanceLine): BalanceLineInput {
  return {
    classification: line.classification, is_included: line.is_included, definition: line.definition,
    amount_native: line.amount_native, currency: line.currency, fx_to_aud: line.fx_to_aud,
    fx_date: line.fx_date, fx_source: line.fx_source, available_native: line.available_native,
    liquidity_eligible: line.liquidity_eligible, source_label: line.source_label,
    source_record_id: line.source_record_id, source_as_at: line.source_as_at,
    evidence_path: line.evidence_path, note: line.note, status: line.status,
  };
}

function errorMessage(error: unknown) { return error instanceof Error ? error.message : 'The change could not be saved. Please try again.'; }

export function BalanceLineDetails({ line, snapshot, canEdit, onSaved, onBusyChange }: {
  line: BalanceLine; snapshot: BalanceSnapshot; canEdit: boolean; onSaved: () => Promise<void>; onBusyChange?: (busy: boolean) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<BalanceLineInput>(() => inputFor(line));
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [reviewConfirmed, setReviewConfirmed] = useState(false);
  const editable = canEdit && snapshot.status === 'draft';
  const automatic = line.source_kind !== 'manual' && !line.manual_override;
  const canReviewImported = automatic && line.source_status === 'ready' && line.status !== 'reviewed'
    && lineIssues({ ...line, status: 'reviewed' }, snapshot.as_at_date, false).length === 0;
  const issues = lineIssues(line, snapshot.as_at_date);
  const set = <K extends keyof BalanceLineInput>(key: K, value: BalanceLineInput[K]) => setDraft((current) => ({ ...current, [key]: value, status: key === 'status' ? value as BalanceLineInput['status'] : 'pending' }));

  async function showEvidence() {
    if (!line.evidence_path) return;
    setError('');
    // Open synchronously so browsers do not block the eventual private signed URL.
    const evidenceWindow = window.open('about:blank', '_blank');
    if (evidenceWindow) evidenceWindow.opener = null;
    try {
      const url = await getBalanceEvidenceUrl(line.evidence_path);
      if (evidenceWindow) evidenceWindow.location.replace(url);
      else setError('Your browser blocked the document window. Allow pop-ups for this dashboard and try again.');
    } catch (failure) { evidenceWindow?.close(); setError(errorMessage(failure)); }
  }

  async function save(event: FormEvent) {
    event.preventDefault();
    if (!editable || busy) return;
    setBusy(true); onBusyChange?.(true); setError('');
    try {
      const evidencePath = file ? await uploadBalanceEvidence(snapshot.id, line.id, file) : draft.evidence_path;
      if (file) { set('evidence_path', evidencePath); setFile(null); }
      await saveBalanceLine(line.id, line.revision, { ...draft, evidence_path: evidencePath });
      await onSaved();
      setFile(null); setEditing(false);
    } catch (failure) { setError(errorMessage(failure)); }
    finally { setBusy(false); onBusyChange?.(false); }
  }

  async function reviewImported() {
    if (!editable || busy || !canReviewImported || !reviewConfirmed) return;
    setBusy(true); onBusyChange?.(true); setError('');
    try { await saveBalanceLine(line.id, line.revision, { ...inputFor(line), status: 'reviewed' }); await onSaved(); }
    catch (failure) { setError(errorMessage(failure)); }
    finally { setBusy(false); onBusyChange?.(false); }
  }

  return <>
    <p className="dolo-eyebrow">Balance at cut-off</p>
    <div className="dolo-detail-amount">{line.amount_aud === null ? line.source_status === 'unavailable' ? 'Source blocked' : 'Not entered' : formatMoney(decimalToCents(line.amount_aud))}</div>
    <span className={`dolo-status ${line.status === 'reviewed' && (!automatic || line.source_status === 'ready') ? 'dolo-status-closed' : ''}`}>{line.status === 'reviewed' ? automatic ? 'Reviewed source balance' : line.manual_override ? 'Reviewed manual override' : 'Reviewed manual entry' : 'Pending review'}</span>
    {!line.is_included && <p className="dolo-muted">Reference only. Not added to the balance.</p>}
    {line.definition && <p className="dolo-muted" style={{ marginTop: 16 }}>{line.definition}</p>}
    {error && <div className="dolo-notice dolo-notice-error" role="alert"><AlertCircle size={16} /><span>{error}</span></div>}

    {!editing && <>
      <section className="dolo-detail-block">
        <h3>Source and calculation</h3>
        <dl className="dolo-detail-grid">
          <div><dt>Source</dt><dd>{line.source_label || 'Not provided'}</dd></div>
          <div><dt>Entry method</dt><dd>{balanceSourceLabel(line)}</dd></div>
          <div><dt>Original amount</dt><dd>{line.amount_native === null ? 'Not entered' : `${line.currency} ${line.amount_native}`}</dd></div>
          <div><dt>Exchange rate</dt><dd>{line.fx_to_aud === null ? 'Not provided' : `1 ${line.currency} = ${line.fx_to_aud} AUD`}</dd></div>
          <div><dt>FX date / source</dt><dd>{line.fx_date || '—'} / {line.fx_source || 'Not provided'}</dd></div>
          <div><dt>Source cut-off</dt><dd>{line.source_as_at || 'Not provided'}</dd></div>
          <div><dt>Classification</dt><dd>{line.classification === 'unclassified' ? 'Awaiting classification' : line.classification === 'reference' ? 'Reference only' : line.classification === 'asset' ? 'Asset' : 'Liability'}</dd></div>
          <div><dt>Available cash contribution</dt><dd>{line.liquidity_eligible ? (line.available_aud === null ? 'Pending availability check' : formatMoney(decimalToCents(line.available_aud))) : 'Not included'}</dd></div>
          {line.source_record_id && <div><dt>Source reference</dt><dd>{line.source_record_id}</dd></div>}
          {line.source_collected_at && <div><dt>Collected</dt><dd>{formatCollectedAt(line.source_collected_at)}</dd></div>}
        </dl>
        {automatic && line.source_status !== 'ready' && <div className="dolo-notice"><AlertCircle size={16} /><span>{line.source_status === 'unavailable' ? 'This source could not supply a verified balance. Missing values are not zero.' : 'This is an imported candidate, not a validated balance. Resolve the source or cut-off issue before relying on it.'}</span></div>}
        {line.manual_override && <p className="dolo-muted">This manual exception is protected from automatic refresh. The collection evidence below describes the source result, not approval of the overridden amount.</p>}
        <BalanceSourceProof line={line} />
      </section>
      <section className="dolo-detail-block">
        <h3>Supporting documents (optional)</h3>
        {line.evidence_path ? <div className="dolo-document"><FileCheck2 size={18} /><span title={line.evidence_path.split('/').pop()}>{line.source_record_id || 'Supporting document'}<small className="dolo-line-subtitle">{line.evidence_path.split('.').pop()?.toUpperCase()} · Private document</small></span><button className="dolo-button" type="button" onClick={showEvidence}><ExternalLink size={13} /> View document</button></div> : <p className="dolo-muted">No supporting document has been attached.</p>}
        <p className="dolo-muted">Attachments are optional, private and linked to this snapshot. Connected-source evidence is retained with the collected result above.</p>
        {line.note && <><h3 style={{ marginTop: 20 }}>Review notes</h3><p className="dolo-muted" style={{ whiteSpace: 'pre-wrap' }}>{line.note}</p></>}
      </section>
      {issues.length > 0 && <section className="dolo-detail-block"><h3>Before closing</h3><ul className="dolo-muted" style={{ paddingLeft: 17, listStyle: 'disc' }}>{issues.map((issue) => <li key={issue}>{issue}</li>)}</ul></section>}
      {editable && canReviewImported && <section className="dolo-detail-block"><h3>Review the imported balance</h3><label className="dolo-check"><input type="checkbox" checked={reviewConfirmed} onChange={(event) => setReviewConfirmed(event.target.checked)} disabled={busy} /><span>I checked the source, amount, classification, cut-off and conversion. Cash availability is checked separately.</span></label><div className="dolo-form-actions"><button className="dolo-button dolo-button-primary" type="button" onClick={() => void reviewImported()} disabled={busy || !reviewConfirmed}>{busy ? 'Saving…' : 'Confirm source review'}</button></div></section>}
      <div className="dolo-form-actions">{editable ? <button className="dolo-button dolo-button-primary" type="button" disabled={busy} onClick={() => { setDraft({ ...inputFor(line), status: 'pending' }); setEditing(true); }}><Pencil size={14} /> {automatic ? 'Edit / add manual exception' : line.amount_native === null ? 'Enter balance' : 'Edit manual entry'}</button> : <p className="dolo-muted"><LockKeyhole size={13} style={{ display: 'inline', marginRight: 6 }} />{snapshot.status === 'closed' ? 'This snapshot is closed. Corrections require a new version.' : 'Editing is unavailable with your current access or while sources are being collected.'}</p>}</div>
    </>}

    {editing && <form className="dolo-form" onSubmit={save} style={{ marginTop: 24 }}>
      <h3>{automatic ? 'Review / manual exception' : 'Manual entry'}</h3>
      <p className="dolo-muted">Enter the balance checked against the named source for the cut-off on {formatAsAt(snapshotCutoffDate(snapshot.as_at_date))}. A saved entry replaces this line's previous amount; it is never added twice.</p>
      {automatic && <div className="dolo-notice"><AlertCircle size={16} /><span>Changing the collected financial values creates a manual override and protects it from future refreshes. Reviewing an unchanged imported value does not create an override. Explain any correction in the notes.</span></div>}
      <div className="dolo-form-grid">
        <label className="dolo-field"><span>Classification</span><select value={draft.classification} onChange={(event) => { const value = event.target.value as BalanceLineInput['classification']; setDraft((current) => ({ ...current, status: 'pending', classification: value, amount_native: value === 'reference' ? null : current.amount_native, liquidity_eligible: value === 'asset' ? current.liquidity_eligible : false, available_native: value === 'asset' ? current.available_native : null, is_included: value !== 'reference' })); }} disabled={busy || line.key === 'meta_usd'}><option value="unclassified">Awaiting classification</option><option value="asset">Asset</option><option value="liability">Liability</option><option value="reference">Reference only</option></select></label>
        <label className="dolo-field"><span>Currency</span><input value={draft.currency} onChange={(event) => set('currency', event.target.value.toUpperCase())} maxLength={3} pattern="[A-Z]{3}" required disabled={busy} /></label>
      </div>
      {draft.classification !== 'reference' && <label className="dolo-check"><input type="checkbox" checked={draft.is_included} onChange={(event) => setDraft((current) => ({ ...current, status: 'pending', is_included: event.target.checked, amount_native: event.target.checked ? current.amount_native : null, available_native: event.target.checked ? current.available_native : null, liquidity_eligible: event.target.checked ? current.liquidity_eligible : false }))} disabled={busy} /><span>Include this line in the balance. Any exclusion must be explained in the review notes.</span></label>}
      <label className="dolo-field"><span>What this line represents</span><textarea value={draft.definition || ''} onChange={(event) => set('definition', event.target.value)} disabled={busy} placeholder="Define the accounts or items included; identify exclusions." /></label>
      <div className="dolo-form-grid">
        <label className="dolo-field"><span>Amount in original currency</span><input inputMode="decimal" type="number" step="0.01" min="0" value={draft.amount_native ?? ''} onChange={(event) => set('amount_native', event.target.value === '' ? null : event.target.value)} disabled={busy || !draft.is_included} /><small>Enter a positive amount. Liabilities are deducted once.</small></label>
        <label className="dolo-field"><span>AUD per 1 {draft.currency || 'unit'}</span><input inputMode="decimal" type="number" step="0.00000001" min="0.00000001" max="10000" value={draft.fx_to_aud ?? ''} onChange={(event) => set('fx_to_aud', event.target.value === '' ? null : event.target.value)} disabled={busy || !draft.is_included} /><small>Use 1 for AUD. FX must match the selected cut-off.</small></label>
        <label className="dolo-field"><span>FX date</span><input type="date" value={draft.fx_date || ''} onChange={(event) => set('fx_date', event.target.value || null)} disabled={busy || draft.classification === 'reference'} /></label>
        <label className="dolo-field"><span>FX source</span><input value={draft.fx_source || ''} onChange={(event) => set('fx_source', event.target.value)} placeholder="Source and rate reference" disabled={busy || draft.classification === 'reference'} /></label>
      </div>
      <label className="dolo-field"><span>Source</span><input value={draft.source_label || ''} onChange={(event) => set('source_label', event.target.value)} placeholder="e.g. Xero / ANZ statement" disabled={busy} /><small>Airwallex wallet and Yield can be sourced from Xero after statement reconciliation.</small></label>
      <div className="dolo-form-grid">
        <label className="dolo-field"><span>Source balance date</span><input type="date" value={(draft.source_as_at || '').slice(0, 10)} onChange={(event) => set('source_as_at', event.target.value || null)} disabled={busy} /></label>
        <label className="dolo-field"><span>Account / document reference</span><input value={draft.source_record_id || ''} onChange={(event) => set('source_record_id', event.target.value)} disabled={busy} /></label>
      </div>
      {draft.classification === 'asset' && draft.is_included && CASH_CONCEPT_KEYS.includes(line.key) && <>
        <label className="dolo-check"><input type="checkbox" checked={draft.liquidity_eligible} onChange={(event) => setDraft((current) => ({ ...current, status: 'pending', liquidity_eligible: event.target.checked, available_native: event.target.checked ? current.available_native : null }))} disabled={busy} /><span>Include a verified usable portion in Available cash</span></label>
        <DoloHelp label="Cash availability">Use only funds available at the cut-off. Exclude pending payouts, restricted funds and unredeemed Yield. This amount is already part of Assets.</DoloHelp>
        {draft.liquidity_eligible && <label className="dolo-field"><span>Usable amount in {draft.currency}</span><input type="number" inputMode="decimal" min="0" step="0.01" value={draft.available_native ?? ''} onChange={(event) => set('available_native', event.target.value === '' ? null : event.target.value)} disabled={busy} /><small>Must be checked against the named source and cannot exceed the line balance.</small></label>}
      </>}
      <label className="dolo-field"><span>Supporting document (optional)</span><input type="file" accept=".pdf,.csv,.xlsx,.png,.jpg,.jpeg" onChange={(event) => { setFile(event.target.files?.[0] ?? null); set('status', 'pending'); }} disabled={busy} /><small>{file ? `Selected: ${file.name}` : draft.evidence_path ? 'Existing document retained unless replaced.' : 'You can review and close a manual entry without an attachment.'} PDF, CSV, XLSX, PNG or JPEG; maximum 10 MB.</small></label>
      <label className="dolo-field"><span>Review notes / reason for change</span><textarea value={draft.note || ''} onChange={(event) => set('note', event.target.value)} disabled={busy} /></label>
      <label className="dolo-check"><input type="checkbox" checked={draft.status === 'reviewed'} onChange={(event) => set('status', event.target.checked ? 'reviewed' : 'pending')} disabled={busy} /><span>I have checked the amount, classification, cut-off, exchange rate and availability against the named source.</span></label>
      <div className="dolo-form-actions"><button className="dolo-button" type="button" onClick={() => { setEditing(false); setFile(null); setError(''); }} disabled={busy}>Cancel</button><button className="dolo-button dolo-button-primary" type="submit" disabled={busy}>{busy ? 'Saving…' : 'Save entry'}</button></div>
    </form>}
  </>;
}
