import { useState } from 'react';
import { AlertCircle, Download } from 'lucide-react';
import { decimalToCents, formatAsAt, formatCollectedAt, formatMoney, type BalanceLine } from '@/lib/doloBalance';

type Evidence = Record<string, unknown>;
function evidence(value: unknown): Evidence {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Evidence : {};
}
function text(value: unknown): string | null { return typeof value === 'string' && value.trim() ? value.trim() : null; }
function count(value: unknown): number | null { return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null; }
function amount(value: unknown): string {
  if (typeof value !== 'string' && typeof value !== 'number') return 'Not provided';
  const cents = decimalToCents(value);
  return cents === null ? 'Not provided' : formatMoney(cents);
}
function day(value: unknown): string {
  const date = text(value);
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return 'Not provided';
  return formatAsAt(date) === 'Unknown date' ? 'Not provided' : formatAsAt(date);
}
function timestamp(value: unknown): string {
  const date = text(value);
  if (!date || !Number.isFinite(Date.parse(date))) return 'Not recorded';
  if (!/(?:Z|[+-]\d{2}(?::?\d{2})?)$/i.test(date) || !/[T ]\d{2}:\d{2}/.test(date)) return `${date} (timezone not stated)`;
  return formatCollectedAt(date);
}

function StockEvidence({ proof }: { proof: Evidence }) {
  const checks = evidence(proof.checks);
  const components = Array.isArray(proof.components) ? proof.components.map(evidence) : [];
  const comparison = evidence(proof.unleashed_comparison);
  const missingCosts = count(checks.missing_cost_skus);
  const costedSkus = count(checks.costed_skus);
  return <>
    <h3>How Stock is valued</h3>
    {text(proof.valuation_basis) && <p className="dolo-muted">{text(proof.valuation_basis)}</p>}
    <dl className="dolo-detail-grid">
      <div><dt>Snapshot record date</dt><dd>{day(proof.source_snapshot_date)}</dd></div>
      <div><dt>Record captured</dt><dd>{timestamp(proof.source_captured_at)}</dd></div>
      <div><dt>Costs recalculated</dt><dd>{timestamp(proof.source_recalculated_at)}</dd></div>
      <div><dt>Production included</dt><dd>{proof.includes_production === true ? 'Yes' : proof.includes_production === false ? 'No' : 'Not stated'}</dd></div>
      <div><dt>SKU rows with a cost</dt><dd>{costedSkus === null ? 'Not provided' : costedSkus.toLocaleString('en-AU')}</dd></div>
      <div><dt>SKU rows missing a cost</dt><dd>{missingCosts === null ? 'Not provided' : missingCosts.toLocaleString('en-AU')}</dd></div>
    </dl>
    {missingCosts !== null && missingCosts > 0 && <div className="dolo-notice"><AlertCircle size={16} /><span>{missingCosts.toLocaleString('en-AU')} SKU rows have missing costs. The Stock valuation needs review.</span></div>}
    {checks.source_capture_after_cutoff === true && <div className="dolo-notice"><AlertCircle size={16} /><span>This record was captured after the cut-off. Verify that its saved quantities belong to the cut-off.</span></div>}
    {checks.source_recalculated_after_cutoff === true && <div className="dolo-notice"><AlertCircle size={16} /><span>Costs were recalculated after the cut-off. This is not an untouched month-end valuation.</span></div>}
    {components.length > 0 && <div className="dolo-proof-table-wrap"><table className="dolo-proof-table">
      <caption>Dashboard Stock composition</caption>
      <thead><tr><th scope="col">Location / stage</th><th scope="col" className="dolo-proof-number">Value in AUD</th></tr></thead>
      <tbody>{components.map((component, index) => <tr key={`${text(component.key) ?? 'component'}-${index}`}>
        <th scope="row">{text(component.label) ?? 'Not identified'}</th><td className="dolo-proof-number">{amount(component.amount_aud)}</td>
      </tr>)}</tbody>
      <tfoot><tr><th scope="row">Saved dashboard total</th><td className="dolo-proof-number">{amount(proof.total_inventory_aud)}</td></tr></tfoot>
    </table></div>}
    {(checks.components_sum_aud !== undefined || checks.rounding_difference_aud !== undefined) && <dl className="dolo-detail-grid">
      <div><dt>Sum of components</dt><dd>{amount(checks.components_sum_aud)}</dd></div>
      <div><dt>Recorded rounding difference</dt><dd>{amount(checks.rounding_difference_aud)}</dd></div>
    </dl>}
    {Object.keys(comparison).length > 0 && <section className="dolo-detail-block" aria-label="Separate Unleashed comparison">
      <h3>Unleashed comparison</h3>
      <p className="dolo-muted">Separate comparison only. This amount is not added to the dashboard Stock total.</p>
      {comparison.available === true ? <>
        <dl className="dolo-detail-grid">
          <div><dt>Unleashed value</dt><dd>{amount(comparison.amount_aud)}</dd></div>
          <div><dt>Source cut-off</dt><dd>{day(comparison.source_as_at)}</dd></div>
          <div><dt>Collected</dt><dd>{timestamp(comparison.source_collected_at)}</dd></div>
          <div><dt>In-stock SKUs missing a cost</dt><dd>{count(comparison.positive_stock_missing_cost_count)?.toLocaleString('en-AU') ?? 'Not provided'}</dd></div>
        </dl>
        {text(comparison.note) && <p className="dolo-muted">{text(comparison.note)}</p>}
      </> : <p className="dolo-muted">{text(comparison.reason) ?? 'A comparable Unleashed value was not available.'}</p>}
    </section>}
  </>;
}

function XeroEvidence({ proof }: { proof: Evidence }) {
  const components = Array.isArray(proof.components) ? proof.components.map(evidence) : [];
  if (!components.length) return null;
  return <div className="dolo-proof-table-wrap"><table className="dolo-proof-table">
    <caption>Xero accounts included in this source</caption>
    <thead><tr><th scope="col">Account</th><th scope="col">Account currency</th><th scope="col" className="dolo-proof-number">Report value in AUD</th></tr></thead>
    <tbody>{components.map((component, index) => <tr key={`${text(component.account_id) ?? 'account'}-${index}`}>
      <th scope="row">{text(component.name) ?? 'Not identified'}{text(component.code) && <span className="dolo-line-subtitle">Code {text(component.code)}</span>}</th>
      <td>{text(component.original_currency) ?? 'Not provided'}{component.account_type === 'CURRENT' && <span className="dolo-line-subtitle">Base-currency ledger</span>}</td>
      <td className="dolo-proof-number">{amount(component.amount_aud)}</td>
    </tr>)}</tbody>
  </table></div>;
}

function SupplierEvidence({ proof }: { proof: Evidence }) {
  const report = evidence(proof.report);
  if (!Array.isArray(report.header) || !Array.isArray(proof.report_rows)) return null;
  const headers = report.header.map(value => text(value) ?? '');
  const rows = proof.report_rows.map(evidence);
  const invoices = rows.filter(row => row.RowType === 'Row');
  const summaries = rows.filter(row => row.RowType === 'SummaryRow');
  const column = (label: string) => {
    const matches = headers.flatMap((header, index) => header.replace(/\s/g, '').toLowerCase() === label ? [index] : []);
    return matches.length === 1 ? matches[0] : -1;
  };
  const referenceColumn = column('reference');
  const dateColumn = column('date');
  const dueDateColumn = column('duedate');
  // Only explicitly labelled currencies are safe here. "Due" / "Due Local" are not AUD evidence.
  const dueColumns = headers.flatMap((header, index) => {
    const match = /^due\s+(?:in\s+)?\(?([a-z]{3})\)?$/i.exec(header);
    return match ? [{ index, currency: match[1].toUpperCase() }] : [];
  });
  const ambiguousCurrency = dueColumns.some((item, index) => dueColumns.findIndex(other => other.currency === item.currency) !== index);
  const amountColumns = ambiguousCurrency ? [] : dueColumns;
  const cell = (row: Evidence, index: number): unknown => Array.isArray(row.Cells) && index >= 0 ? evidence(row.Cells[index]).Value : null;
  const cents = (value: unknown) => typeof value === 'string' || typeof value === 'number' ? decimalToCents(value) : null;
  const sourceDate = (value: unknown) => {
    const valueText = text(value);
    return valueText && /^\d{4}-\d{2}-\d{2}$/.test(valueText) ? day(valueText) : valueText ?? 'Not provided';
  };
  const currencyAmount = (row: Evidence, index: number, currency: string) => {
    const value = cents(cell(row, index));
    return value === null ? 'Not provided' : `${currency} ${formatMoney(value, false)}`;
  };
  const paymentState = (row: Evidence) => {
    const dues = amountColumns.map(item => cents(cell(row, item.index)));
    if (!dues.length || dues.some(value => value === null)) return 'Not established';
    if (dues.every(value => value === 0n)) {
      const fullyPaid = amountColumns.some(({ currency }) => {
        const total = cents(cell(row, column(`total${currency.toLowerCase()}`)));
        const paid = cents(cell(row, column(`paid${currency.toLowerCase()}`)));
        const credited = cents(cell(row, column(`credited${currency.toLowerCase()}`)));
        return total !== null && total > 0n && paid !== null && paid >= total && credited === 0n;
      });
      return fullyPaid ? 'Paid' : 'Nothing due';
    }
    return dues.every(value => value !== null && value < 0n) ? 'Credit balance' : 'Amount due';
  };
  return <>
    {(!amountColumns.length || ambiguousCurrency) && <div className="dolo-notice"><AlertCircle size={16} /><span>The report does not identify an unambiguous currency for each amount due. Amounts are not relabelled as AUD; inspect the saved evidence.</span></div>}
    <div className="dolo-proof-table-wrap"><table className="dolo-proof-table">
      <caption>Xero supplier invoices</caption>
      <thead><tr><th scope="col">Invoice</th>{amountColumns.map(({ index, currency }) => <th key={index} scope="col" className="dolo-proof-number">Due {currency}</th>)}<th scope="col">Report status</th></tr></thead>
      <tbody>{invoices.map((row, index) => <tr key={index}>
        <th scope="row">{text(cell(row, referenceColumn)) ?? 'Reference not provided'}<span className="dolo-line-subtitle">Invoice date: {sourceDate(cell(row, dateColumn))}</span><span className="dolo-line-subtitle">Due date: {sourceDate(cell(row, dueDateColumn))}</span></th>
        {amountColumns.map(({ index: valueIndex, currency }) => <td key={valueIndex} className="dolo-proof-number">{currencyAmount(row, valueIndex, currency)}</td>)}
        <td>{paymentState(row)}</td>
      </tr>)}</tbody>
      {summaries.length > 0 && <tfoot>{summaries.map((row, index) => <tr key={index}>
        <th scope="row">Report summary — {text(cell(row, referenceColumn)) ?? text(cell(row, dateColumn)) ?? 'Total'}</th>
        {amountColumns.map(({ index: valueIndex, currency }) => <td key={valueIndex} className="dolo-proof-number">{currencyAmount(row, valueIndex, currency)}</td>)}
        <td>Not an invoice</td>
      </tr>)}</tfoot>}
    </table></div>
    {!invoices.length && <p className="dolo-muted">No invoice detail rows are included in this saved report.</p>}
    <p className="dolo-muted">These are the amounts due in the saved Xero report. Report summaries are shown separately and are not additional invoices.</p>
  </>;
}

/** A readable summary of private saved evidence; the unchanged full record remains downloadable. */
export function BalanceSourceProof({ line }: { line: BalanceLine }) {
  const [open, setOpen] = useState(false);
  const proof = line.source_proof;
  if (!proof || Object.keys(proof).length === 0) return null;

  function download() {
    const url = URL.createObjectURL(new Blob([JSON.stringify({
      snapshot_id: line.snapshot_id, line_key: line.key, source: line.source_label,
      source_record_id: line.source_record_id, source_as_at: line.source_as_at,
      source_collected_at: line.source_collected_at, source_status: line.source_status,
      manual_override: !!line.manual_override, proof,
    }, null, 2)], { type: 'application/json' }));
    const anchor = document.createElement('a');
    anchor.href = url; anchor.download = `dolo-balance-${line.key}-${line.source_as_at || 'source'}-${line.snapshot_id}.json`;
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  return <div className="dolo-source-proof">
    <h3>Saved source evidence</h3>
    <dl className="dolo-detail-grid">
      <div><dt>Financial cut-off</dt><dd>{day(proof.cutoff_date ?? line.source_as_at)}</dd></div>
      <div><dt>Collected for this snapshot</dt><dd>{timestamp(proof.retrieved_at ?? line.source_collected_at)}</dd></div>
    </dl>
    {line.manual_override && <p className="dolo-muted">These are the original collected figures. They do not validate or replace the manual override above.</p>}
    {text(proof.amount_basis) && <p className="dolo-muted">{text(proof.amount_basis)}</p>}
    {text(proof.bank_statement_reconciliation) && <div className="dolo-notice"><AlertCircle size={16} /><span>{text(proof.bank_statement_reconciliation)}</span></div>}
    {proof.book_amount_aud !== undefined && <dl className="dolo-detail-grid"><div><dt>Accounting book balance only</dt><dd>{amount(proof.book_amount_aud)}</dd></div><div><dt>Included as bank funds</dt><dd>No — statement verification required</dd></div></dl>}
    {(line.source_status === 'unavailable' || line.source_status === 'needs_review') && line.note && <p className="dolo-muted">{line.note}</p>}
    {line.key === 'stock' && proof.provider === 'dashboard' && <StockEvidence proof={proof} />}
    {(line.source_kind === 'xero' || proof.provider === 'xero') && <><XeroEvidence proof={proof} /><SupplierEvidence proof={proof} /></>}
    <details onToggle={(event) => setOpen(event.currentTarget.open)}>
      <summary>Inspect saved source evidence</summary>
      {open && <><p className="dolo-muted">Saved evidence from this collection. Large records are abbreviated here; the download contains the full record.</p><pre>{JSON.stringify(proof, null, 2).slice(0, 12000)}</pre></>}
    </details>
    <button className="dolo-button" type="button" onClick={download}><Download size={13} /> Download source evidence</button>
  </div>;
}
