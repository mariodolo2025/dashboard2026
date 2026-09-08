import { useState } from 'react';
import { Download } from 'lucide-react';
import type { BalanceLine } from '@/lib/doloBalance';

/** Proof is private snapshot data, rendered as text only and expanded on demand. */
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
    <details onToggle={(event) => setOpen(event.currentTarget.open)}>
      <summary>Inspect saved source evidence</summary>
      {open && <><p className="dolo-muted">Saved evidence from this collection. Large records are abbreviated here; the download contains the full record.</p><pre>{JSON.stringify(proof, null, 2).slice(0, 12000)}</pre></>}
    </details>
    <button className="dolo-button" type="button" onClick={download}><Download size={13} /> Download source evidence</button>
  </div>;
}
