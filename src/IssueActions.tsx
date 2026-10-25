import { useEffect, useRef, useState } from 'react';
import type { Issue } from './issues';
import type { HandlingMode } from './issue-handling-types';

export function IssueActions({issue, revision, onSaved}: {issue: Issue; revision: number; onSaved: () => void}) {
  const [open, setOpen] = useState(false), [mode, setMode] = useState<HandlingMode>('acknowledged');
  const [reason, setReason] = useState(''), [duration, setDuration] = useState('3600');
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const [draftRevision, setDraftRevision] = useState(revision);
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => { if (open) dialog.current?.showModal(); }, [open]);
  return <>
    <button className="text-link" onClick={() => {setDraftRevision(revision); setOpen(true); setError('');}} aria-label={`Manage issue: ${issue.name}`}>Manage issue</button>
    {open && <dialog ref={dialog} className="modal issue-action-dialog" aria-labelledby="issue-action-title" onCancel={e => {if (busy) e.preventDefault(); else setOpen(false);}}>
      <form onSubmit={async e => {
        e.preventDefault(); setBusy(true); setError('');
        try {
          const r = await fetch('/api/admin/issues/handling', {method: 'POST', headers: {'Content-Type': 'application/json', 'X-Hostboard-Request': '1'}, body: JSON.stringify({
            revision: draftRevision, kind: issue.type, hostId: issue.hostId, ...(issue.alert ? {alertId: issue.alert.id} : {incidentId: issue.incident!.id}),
            mode, reason, ...(mode === 'snoozed' ? {durationSeconds: Number(duration)} : {}),
          })});
          const d = await r.json(); if (!r.ok) throw Error(d.error || 'Could not save issue action');
          setOpen(false); onSaved();
        } catch(e) {setError((e as Error).message);} finally {setBusy(false);}
      }}>
        <h2 id="issue-action-title">Manage issue</h2><p><b>{issue.name}</b> · {issue.hostId}</p>
        <label>Action<select autoFocus aria-label="Issue action" value={mode} disabled={busy} onChange={e => setMode(e.target.value as HandlingMode)}>
          <option value="acknowledged">Acknowledge this occurrence</option><option value="snoozed">Snooze</option><option value="ignored">Treat as expected / ignore</option>
        </select></label>
        <p className="muted">{mode === 'acknowledged' ? 'Remove this occurrence from Active. A new occurrence or higher severity appears again.' : mode === 'snoozed' ? 'Hide this condition temporarily. It returns when the snooze expires; higher severity appears immediately.' : 'Hide this specific condition until you restore it. Changed alert rules, a replacement server or higher severity appear again.'}</p>
        {mode === 'snoozed' && <label>Duration<select aria-label="Snooze duration" value={duration} disabled={busy} onChange={e => setDuration(e.target.value)}><option value="3600">1 hour</option><option value="86400">24 hours</option><option value="604800">7 days</option></select></label>}
        <label>Reason<textarea aria-label="Handling reason" required minLength={3} maxLength={500} value={reason} disabled={busy} onChange={e => setReason(e.target.value)}/></label>
        <p className="notice">Applies to Hostboard's Active list, counts and service-check emails. Netdata, Netdata Cloud and the independent watchdog keep their own notification settings. Collection continues and history is preserved; this does not report recovery or change a hardware baseline.</p>
        {error && <p role="alert" className="notice danger">{error}</p>}
        <div className="context-actions"><button className="action-link" type="submit" disabled={busy}>{busy ? 'Saving…' : 'Save action'}</button><button className="text-link" type="button" disabled={busy} onClick={() => setOpen(false)}>Cancel</button></div>
      </form>
    </dialog>}
  </>;
}
