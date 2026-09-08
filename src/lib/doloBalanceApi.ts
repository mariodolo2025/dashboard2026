import { supabase } from './supabase';
import type { BalanceBundle, BalanceLine, BalanceLineInput, BalanceSnapshot, BalanceSourceStatus, BalanceUserAccess, DoloBalanceAccess } from './doloBalance';

export class BalanceApiError extends Error {
  constructor(message: string, public readonly kind: 'setup' | 'denied' | 'conflict' | 'validation' | 'network' = 'network') {
    super(message);
    this.name = 'BalanceApiError';
  }
}

function fail(error: { code?: string; message?: string } | null): never {
  const message = error?.message ?? 'Unable to load DOLO Balance. Please retry.';
  if (['PGRST202', 'PGRST205', '42883', '42P01'].includes(error?.code ?? '')) {
    throw new BalanceApiError('DOLO Balance is not configured on this database. Its migration must be installed before real snapshots can be used.', 'setup');
  }
  if (error?.code === '42501' || /permission|not authorized|not authorised|access denied/i.test(message)) {
    throw new BalanceApiError('You do not have permission for this DOLO Balance operation.', 'denied');
  }
  if (error?.code === '40001' || /revision|concurrent|changed.*reload/i.test(message)) {
    throw new BalanceApiError('This snapshot changed while you were working. Reload it before saving.', 'conflict');
  }
  const known: Record<string, string> = {
    DOLO_SNAPSHOT_CLOSED: 'This snapshot is closed. Create a correction version to change it.',
    DOLO_LINE_INCOMPLETE: 'Complete and review every included line, including its definition, named source, cut-off date and exchange rate.',
    DOLO_CATALOG_INCOMPLETE: 'This snapshot does not contain the complete set of balance concepts.',
    DOLO_DEFINITION_REQUIRED: 'Explain what this line represents before marking it reviewed.',
    DOLO_FX_REQUIRED: 'Provide the exchange-rate date and source for the foreign-currency amount.',
    DOLO_FX_AFTER_CUTOFF: 'The exchange-rate date cannot be later than the snapshot cut-off.',
    DOLO_SOURCE_AFTER_CUTOFF: 'The source balance date cannot be later than the snapshot cut-off.',
    DOLO_AVAILABLE_CASH_REQUIRED: 'Enter the verified usable amount for this cash account.',
    DOLO_EVIDENCE_INVALID: 'The supporting document is missing or does not belong to this balance line.',
    DOLO_EVIDENCE_PATH_INVALID: 'The supporting document has an invalid snapshot or line reference.',
    DOLO_EVIDENCE_PATH_ALREADY_RESERVED: 'This upload reference is already in use. Select the document again and retry.',
    DOLO_EVIDENCE_RESERVATION_REQUIRED: 'This upload could not be verified. Reload the snapshot and attach the document again.',
    DOLO_EVIDENCE_IMMUTABLE: 'Supporting documents cannot be overwritten or deleted. Attach a new document to a draft instead.',
    DOLO_REFERENCE_MUST_REMAIN_EXCLUDED: 'Meta USD is included in Meta and cannot be counted again.',
    DOLO_EXCLUSION_REASON_REQUIRED: 'Explain why this line is excluded before marking it reviewed.',
    DOLO_RESTATEMENT_REASON_REQUIRED: 'Provide a reason for creating a correction version.',
    DOLO_RESTATEMENT_REQUIRES_CLOSED: 'Only a closed snapshot can have a correction version.',
    DOLO_RESTATEMENT_EXISTS: 'A newer correction version already exists. Select it from the snapshot list.',
    DOLO_SNAPSHOT_DATE_INVALID: 'Choose the first day of a month, no later than the current month in Brisbane.',
    DOLO_ADMIN_ACCESS_FIXED: 'The administrator retains access to manage this report.',
    DOLO_ACCESS_INVALID: 'Edit and Close permissions require View access.',
  };
  const friendly = known[message.split(':')[0]];
  if (friendly) throw new BalanceApiError(friendly, 'validation');
  if (['P0001', '22023', '23514', '23505'].includes(error?.code ?? '')) throw new BalanceApiError(message, 'validation');
  throw new BalanceApiError(message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function hasIdentity(value: unknown): value is Record<string, unknown> {
  return isRecord(value) && typeof value.id === 'string' && UUID.test(value.id)
    && Number.isInteger(value.revision) && Number(value.revision) > 0;
}

export async function fetchBalanceAccess(): Promise<DoloBalanceAccess> {
  const { data, error } = await supabase.rpc('dolo_balance_access');
  if (error) fail(error);
  if (!isRecord(data)) throw new BalanceApiError('Unable to verify DOLO Balance permissions.', 'denied');
  // Explicit booleans only: truthy strings or missing fields never grant access.
  return { can_view: data.can_view === true, can_edit: data.can_edit === true,
    can_close: data.can_close === true, can_manage_access: data.can_manage_access === true };
}

export async function listBalanceSnapshots(): Promise<BalanceSnapshot[]> {
  const { data, error } = await supabase.from('dolo_balance_snapshots').select('*')
    .order('as_at_date', { ascending: false }).order('version', { ascending: false }).limit(240);
  if (error) fail(error);
  return (data ?? []) as BalanceSnapshot[];
}

export async function loadBalanceSnapshot(id: string): Promise<BalanceBundle> {
  // One database statement prevents a new header being paired with stale lines
  // if another editor saves or closes between independent HTTP reads.
  const { data, error } = await supabase.rpc('dolo_balance_get_snapshot', { p_snapshot_id: id });
  if (error) fail(error);
  if (!isRecord(data) || !hasIdentity(data.snapshot) || data.snapshot.id !== id
    || !Array.isArray(data.lines) || !data.lines.every(hasIdentity)) throw new BalanceApiError('The server returned an invalid snapshot. No financial data can be shown.');
  return data as unknown as BalanceBundle;
}

async function rpcId(name: string, parameters: Record<string, unknown>): Promise<string> {
  const { data, error } = await supabase.rpc(name, parameters);
  if (error) fail(error);
  if (typeof data !== 'string' || !UUID.test(data)) throw new BalanceApiError('The server did not return a snapshot identifier. Reload to check its status.');
  return data;
}

export function createBalanceSnapshot(asAtDate: string): Promise<string> {
  return rpcId('dolo_balance_create_snapshot', { p_as_at_date: asAtDate });
}

export interface BalanceCollectionResult {
  run_id: string;
  imported: number;
  preserved: number;
  candidates: { key: string; status: BalanceSourceStatus; note: string; source_label: string }[];
  errors?: string[];
}

export async function connectBalanceXero(sourceBaseUrl: string): Promise<string> {
  const { data, error } = await supabase.functions.invoke('dolo-balance-collect', { body: { action: 'connect_xero' } });
  if (error) {
    let detail: unknown;
    try { detail = await error.context?.json(); } catch { /* A network failure has no response body. */ }
    if (isRecord(detail) && typeof detail.error === 'string') fail({ message: detail.error });
    fail({ message: error.message || 'Unable to start Xero authorisation.' });
  }
  let url: URL;
  try { url = new URL(isRecord(data) && typeof data.url === 'string' ? data.url : ''); }
  catch { throw new BalanceApiError('The server did not return a valid Xero authorisation URL.'); }
  let sourceOrigin: string;
  try { sourceOrigin = new URL(sourceBaseUrl).origin; } catch { throw new BalanceApiError('The dashboard source URL is not configured.'); }
  if (url.protocol !== 'https:' || url.origin !== sourceOrigin || url.pathname !== '/functions/v1/xero-oauth'
    || url.username || url.password || !/^balance-[0-9a-f-]{36}$/i.test(url.searchParams.get('balance_state') || '')) {
    throw new BalanceApiError('The server returned an unexpected authorisation destination.');
  }
  return url.toString();
}

export async function collectBalanceSources(snapshotId: string, expectedRevision: number): Promise<BalanceCollectionResult> {
  if (!UUID.test(snapshotId) || !Number.isInteger(expectedRevision) || expectedRevision < 1) throw new BalanceApiError('Invalid snapshot or revision.', 'validation');
  const { data, error } = await supabase.functions.invoke('dolo-balance-collect', {
    body: { snapshot_id: snapshotId, expected_revision: expectedRevision },
  });
  if (error) {
    // Edge-function failures carry their safe application error in the response body.
    let detail: unknown;
    try { detail = await error.context?.json(); } catch { /* Network failures may have no HTTP response. */ }
    if (isRecord(detail) && typeof detail.error === 'string') fail({ code: typeof detail.code === 'string' ? detail.code : undefined, message: detail.error });
    fail({ message: error.message || 'Source collection failed. Saved manual entries and closed snapshots are unchanged.' });
  }
  if (isRecord(data) && typeof data.error === 'string') fail({ message: data.error });
  if (!isRecord(data) || typeof data.run_id !== 'string' || !UUID.test(data.run_id)
    || !Number.isInteger(data.imported) || Number(data.imported) < 0 || !Number.isInteger(data.preserved) || Number(data.preserved) < 0
    || !Array.isArray(data.candidates) || !data.candidates.every((item) => isRecord(item)
      && typeof item.key === 'string' && ['ready', 'needs_review', 'unavailable'].includes(String(item.status))
      && typeof item.note === 'string' && typeof item.source_label === 'string')
    || (data.errors !== undefined && (!Array.isArray(data.errors) || !data.errors.every(item => typeof item === 'string')))) {
    throw new BalanceApiError('The source collection response could not be verified. Reload the snapshot to check its saved state.');
  }
  return data as unknown as BalanceCollectionResult;
}

export async function saveBalanceLine(lineId: string, expectedRevision: number, input: BalanceLineInput): Promise<BalanceLine> {
  // Explicit allowlist; never send client-calculated AUD totals or source_kind.
  const data: BalanceLineInput = {
    classification: input.classification, is_included: input.is_included, definition: input.definition,
    amount_native: input.amount_native, currency: input.currency.toUpperCase(), fx_to_aud: input.fx_to_aud,
    fx_date: input.fx_date, fx_source: input.fx_source, available_native: input.available_native,
    liquidity_eligible: input.liquidity_eligible, source_label: input.source_label,
    source_record_id: input.source_record_id, source_as_at: input.source_as_at,
    evidence_path: input.evidence_path, note: input.note, status: input.status,
  };
  const result = await supabase.rpc('dolo_balance_save_line', { p_line_id: lineId, p_expected_revision: expectedRevision, p_data: data });
  if (result.error) fail(result.error);
  if (!hasIdentity(result.data) || result.data.id !== lineId) throw new BalanceApiError('The server did not confirm this entry. Reload to check its status.');
  return result.data as unknown as BalanceLine;
}

export function closeBalanceSnapshot(id: string, revision: number): Promise<string> {
  return rpcId('dolo_balance_close_snapshot', { p_snapshot_id: id, p_expected_revision: revision });
}

export function restateBalanceSnapshot(id: string, reason: string): Promise<string> {
  return rpcId('dolo_balance_restate_snapshot', { p_snapshot_id: id, p_reason: reason });
}

const EVIDENCE_BUCKET = 'dolo-balance-evidence';
const MAX_EVIDENCE_BYTES = 10 * 1024 * 1024;
const EVIDENCE_TYPES: Record<string, string> = { pdf: 'application/pdf', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', csv: 'text/csv', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function uploadBalanceEvidence(snapshotId: string, lineId: string, file: File): Promise<string> {
  const extension = file.name.split('.').pop()?.toLowerCase() ?? '';
  if (!UUID.test(snapshotId) || !UUID.test(lineId)) throw new BalanceApiError('Invalid snapshot or line.', 'validation');
  if (!Object.prototype.hasOwnProperty.call(EVIDENCE_TYPES, extension)) throw new BalanceApiError('Upload a PDF, PNG, JPEG, CSV or XLSX supporting document.', 'validation');
  if (!file.size || file.size > MAX_EVIDENCE_BYTES) throw new BalanceApiError('Supporting documents must be non-empty and no larger than 10 MB.', 'validation');
  const path = `${snapshotId}/${lineId}/${crypto.randomUUID()}.${extension}`;
  // Reserve this exact path under the editor identity before Storage finalizes
  // the object using its internal service connection. Reservation is single-use.
  const prepared = await supabase.rpc('dolo_balance_prepare_evidence', { p_line_id: lineId, p_path: path });
  if (prepared.error) fail(prepared.error);
  const { error } = await supabase.storage.from(EVIDENCE_BUCKET).upload(path, file, {
    upsert: false, contentType: EVIDENCE_TYPES[extension], cacheControl: '0',
  });
  if (error) fail(error);
  return path;
}

export async function getBalanceEvidenceUrl(path: string): Promise<string> {
  // Stored object paths only. Never open user-supplied external URLs as evidence.
  const parts = path.split('/');
  const filename = parts[2]?.match(/^(.+)\.(pdf|png|jpe?g|csv|xlsx)$/i);
  if (parts.length !== 3 || !UUID.test(parts[0]) || !UUID.test(parts[1]) || !filename || !UUID.test(filename[1])) {
    throw new BalanceApiError('Invalid supporting-document reference.', 'validation');
  }
  const { data, error } = await supabase.storage.from(EVIDENCE_BUCKET).createSignedUrl(path, 60);
  if (error) fail(error);
  if (typeof data?.signedUrl !== 'string' || !data.signedUrl.trim()) throw new BalanceApiError('The supporting document is not available.');
  return data.signedUrl;
}

export async function listBalanceUsers(): Promise<BalanceUserAccess[]> {
  const { data, error } = await supabase.rpc('dolo_balance_list_users');
  if (error) fail(error);
  return Array.isArray(data) ? data as BalanceUserAccess[] : [];
}

export async function setBalanceUserAccess(userId: string, access: Pick<BalanceUserAccess, 'can_view' | 'can_edit' | 'can_close'>): Promise<void> {
  const { error } = await supabase.rpc('dolo_balance_set_access', {
    p_user_id: userId, p_can_view: access.can_view, p_can_edit: access.can_edit, p_can_close: access.can_close,
  });
  if (error) fail(error);
}
