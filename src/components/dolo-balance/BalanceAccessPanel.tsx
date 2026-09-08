import { useEffect, useState } from 'react';
import { AlertCircle, LoaderCircle, ShieldCheck } from 'lucide-react';
import { type BalanceUserAccess } from '@/lib/doloBalance';
import { listBalanceUsers, setBalanceUserAccess } from '@/lib/doloBalanceApi';

type Grants = Pick<BalanceUserAccess, 'can_view' | 'can_edit' | 'can_close'>;

function UserPermissions({ user }: { user: BalanceUserAccess }) {
  const [grants, setGrants] = useState<Grants>({ can_view: user.can_view, can_edit: user.can_edit, can_close: user.can_close });
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [failed, setFailed] = useState(false);
  const [saved, setSaved] = useState(grants);
  const changed = grants.can_view !== saved.can_view || grants.can_edit !== saved.can_edit || grants.can_close !== saved.can_close;

  async function save() {
    setBusy(true); setMessage(''); setFailed(false);
    try { await setBalanceUserAccess(user.user_id, grants); setSaved(grants); setMessage('Access updated.'); }
    catch (failure) { setFailed(true); setMessage(failure instanceof Error ? failure.message : 'Access could not be updated.'); }
    finally { setBusy(false); }
  }

  function toggle(key: keyof Grants, checked: boolean) {
    setMessage('');
    setGrants((current) => key === 'can_view' && !checked ? { can_view: false, can_edit: false, can_close: false } : { ...current, [key]: checked, can_view: checked ? true : current.can_view });
  }

  return <div className="dolo-access-row">
    <p>{user.email || user.user_id} {user.is_admin && <span className="dolo-status dolo-status-closed">Administrator</span>}</p>
    {user.is_admin ? <span className="dolo-muted">Administrator access is verified by the server.</span> : <>
      <div className="dolo-access-permissions">{([['can_view', 'View'], ['can_edit', 'Edit'], ['can_close', 'Close']] as const).map(([key, label]) => <label className="dolo-check" key={key}><input type="checkbox" checked={grants[key]} onChange={(event) => toggle(key, event.target.checked)} disabled={busy} /><span>{label}</span></label>)}</div>
      <div className="dolo-form-actions"><button className="dolo-button" disabled={!changed || busy} onClick={save} type="button">{busy ? 'Saving…' : 'Save access'}</button></div>
    </>}
    {message && <p className={failed ? 'dolo-notice dolo-notice-error' : 'dolo-muted'} role={failed ? 'alert' : 'status'}>{message}</p>}
  </div>;
}

export function BalanceAccessPanel() {
  const [users, setUsers] = useState<BalanceUserAccess[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    let cancelled = false;
    listBalanceUsers().then((result) => { if (!cancelled) setUsers(result); }).catch((failure) => { if (!cancelled) setError(failure instanceof Error ? failure.message : 'User permissions could not be loaded.'); }).finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, []);

  return <>
    <div className="dolo-notice"><ShieldCheck size={17} /><span>These permissions apply only to DOLO Balance. Access to Reports does not grant access to this balance or its private supporting documents.</span></div>
    <p className="dolo-muted">View opens snapshots and documents. Edit manages draft entries. Close freezes a reviewed snapshot. Creating a correction requires both Edit and Close. Edit and Close also require View.</p>
    {loading && <p className="dolo-muted" role="status"><LoaderCircle size={15} className="animate-spin" style={{ display: 'inline', marginRight: 7 }} />Loading users…</p>}
    {error && <div className="dolo-notice dolo-notice-error" role="alert"><AlertCircle size={16} /><span>{error}</span></div>}
    {!loading && !error && users.length === 0 && <p className="dolo-muted">No users are available.</p>}
    {users.map((user) => <UserPermissions key={user.user_id} user={user} />)}
  </>;
}
