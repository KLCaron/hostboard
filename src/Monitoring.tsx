import { useEffect, useState } from 'react';
import { ResponsiveContainer, LineChart, Line, XAxis, YAxis, Tooltip } from 'recharts';
import type { CheckView, IncidentView, MonitorView } from './monitor-types';

export const date = (t: number | null) => t === null ? '—' : new Date(t * 1000).toLocaleString();
const elapsed = (s: number) => s >= 86400 ? `${(s / 86400).toFixed(1)}d` : s >= 3600 ? `${(s / 3600).toFixed(1)}h` : s >= 60 ? `${Math.floor(s / 60)}m ${Math.floor(s % 60)}s` : `${Math.floor(s)}s`;
export const checkLabel = (c: CheckView) => c.state === 'up' ? 'Reachable' : c.state === 'down' ? 'Unreachable' : c.state === 'pending' ? `Confirming failure ${c.failures}/${c.failureThreshold}` : 'Monitoring unavailable';
export function useMonitoring(refresh: number) {
  const [data, setData] = useState<MonitorView>();
  const [error, setError] = useState(false);
  useEffect(() => {
    const controller = new AbortController(); let stopped = false;
    async function load() {
      try {
        const r = await fetch('/api/monitor', { signal: AbortSignal.any([controller.signal, AbortSignal.timeout(10000)]) });
        if (!r.ok) throw new Error();
        const value: MonitorView = await r.json();
        if (!stopped) { setData(value); setError(false); }
      } catch { if (!stopped) setError(true); }
    }
    void load(); const timer = setInterval(load, 10000);
    return () => { stopped = true; controller.abort(); clearInterval(timer); };
  }, [refresh]);
  const stale = error || !!data && Date.now() / 1000 - data.generatedAt > 30;
  return { data: data && stale ? { ...data, healthy: false, checks: data.checks.map(c => ({ ...c, state: 'unknown' as const, responseMs: null, reason: 'Monitoring updates unavailable' })) } : data, error: stale };
}
function Incident({ incident: i }: { incident: IncidentView }) {
  return <details className="incident-row" id={`incident-${i.id}`}>
    <summary><span className={`check-state ${i.endedAt === null ? 'down' : i.resolution === 'Reachability restored' ? 'up' : 'unknown'}`}>{i.endedAt === null ? 'Open' : i.resolution === 'Reachability restored' ? 'Recovered' : 'Retired'}</span><b>{i.name}</b><span>{i.hostId}</span><span>{date(i.startedAt)}</span><span>{elapsed((i.endedAt ?? Date.now() / 1000) - i.startedAt)}</span></summary>
    <div className="incident-detail"><p>{i.reason}</p>{i.source === 'watchdog' && <p className="muted">Detected and notified independently by the watchdog.</p>}<dl><dt>Confirmed</dt><dd>{date(i.detectedAt)}</dd><dt>Ended</dt><dd>{date(i.endedAt)}</dd><dt>Latest observation</dt><dd>{i.lastReason}{i.responseMs !== null ? ` · ${Math.round(i.responseMs)} ms` : ''}</dd><dt>Severity</dt><dd>{i.severity}</dd></dl>
      {i.monitoringGap && <p className="notice">Monitoring was interrupted during this incident. Elapsed duration includes an unobserved interval.</p>}
      <div className="delivery-list"><b>Notifications</b>{i.notifications.map(n => <p key={n.id}>{n.event}: <strong>{n.state}</strong> · {n.attempts} attempts{n.deliveredAt ? ` · SMTP accepted ${date(n.deliveredAt)}` : ''}{n.error ? ` · ${n.error}` : ''}</p>)}{!i.notifications.length && <p>No notifications recorded.</p>}</div>
      <a className="text-link" href={`#host=${i.hostId}`}>Host metrics and diagnostics →</a>
    </div>
  </details>;
}
function Checks({ checks }: { checks: CheckView[] }) {
  return <div className="check-grid">{checks.map(c => <CheckCard key={c.id} c={c}/>)}</div>;
}
function CheckCard({ c }: { c: CheckView }) {
  const [open, setOpen] = useState(false);
  return <details className="check-card" onToggle={e=>setOpen(e.currentTarget.open)}><summary><div><b>{c.name}</b><span>{c.hostId} · {c.type.toUpperCase()}</span></div><span className={`check-state ${c.state}`}>{checkLabel(c)}</span></summary>
    <div className="check-detail"><p>{c.reason}</p><dl><dt>Last observation</dt><dd>{date(c.checkedAt)}</dd><dt>Response time</dt><dd>{c.responseMs === null ? 'Unknown' : `${Math.round(c.responseMs)} ms`}</dd><dt>Schedule</dt><dd>Every {c.intervalSeconds}s · {c.failureThreshold} failures to confirm</dd><dt>Notifications</dt><dd>{c.notify ? `${c.severity} · outage and recovery` : 'Owned elsewhere or disabled'}</dd></dl>
      <p className="small muted">Reachability verifies the configured response or connection only. It does not verify every application function.</p>
      <h4>Last 24 hours</h4><p>{c.summary.availability === null ? 'Insufficient coverage for an availability percentage.' : `${c.summary.availability.toFixed(2)}% of observed time reachable.`} Observed {elapsed(c.summary.observedSeconds)} · unknown {elapsed(c.summary.unknownSeconds)}.</p>
      {open && <div className="response-chart" aria-label={`${c.name} response time history`}><ResponsiveContainer width="100%" height="100%"><LineChart data={c.trend}><XAxis dataKey="time" tickFormatter={t => new Date(t * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} minTickGap={40} stroke="#88968e" fontSize={11}/><YAxis width={45} stroke="#88968e" fontSize={11} unit="ms"/><Tooltip labelFormatter={v => date(Number(v))} formatter={v => [`${Math.round(Number(v))} ms`, 'Response time']}/><Line dataKey="responseMs" stroke="#bbdf93" dot={{ r: 2 }} connectNulls={false} isAnimationActive={false}/></LineChart></ResponsiveContainer></div>}
      <p className="small muted">10 minute averages of successful and failed request durations. Blank intervals have no observations. Raw check samples retained for 30 days.</p>
      <a className="text-link" href={`#host=${c.hostId}`}>Open host →</a>{c.activeIncident && <a className="text-link" href={`#incident=${c.activeIncident}`}> · Open incident →</a>}
    </div></details>;
}
export function RecentIncidents({ data, openHistory }: { data?: MonitorView; openHistory: () => void }) {
  return <section className="monitor-panel recent-incidents"><div className="alerts-heading"><div><h2>Service availability</h2><p>{data ? `${data.checks.filter(c => c.state === 'up').length}/${data.checks.length} reachable · ${data.checks.filter(c => c.state === 'unknown').length} unknown` : 'Connecting to service monitor'}</p></div><button className="text-button" onClick={openHistory}>Checks & incidents →</button></div>
    {data && !data.healthy && <p className="notice">Service monitor coverage is incomplete.</p>}
    {data?.incidents.slice(0, 3).map(i => <Incident key={i.id} incident={i}/>)}
    {data && !data.incidents.length && <p className="muted">No confirmed service incidents recorded.</p>}
  </section>;
}
export function Monitoring({ data, error }: { data?: MonitorView; error: boolean }) {
  const [hash, setHash] = useState(location.hash);
  useEffect(()=>{ const update=()=>setHash(location.hash); window.addEventListener('hashchange',update); return()=>window.removeEventListener('hashchange',update); },[]);
  const [linked, setLinked] = useState<IncidentView>();
  const [older, setOlder] = useState<IncidentView[]>([]), [loading, setLoading] = useState(false), [loadError, setLoadError] = useState(false), [exhausted, setExhausted] = useState(false);
  useEffect(() => {
    const id = hash.match(/^#incident=(\d+)$/)?.[1];
    if (id && data && !data.incidents.some(i => i.id === Number(id)) && linked?.id !== Number(id)) {
      const controller = new AbortController();
      void fetch(`/api/incidents/${id}`, {signal:controller.signal}).then(r=>{if(!r.ok)throw new Error();return r.json();}).then(setLinked).catch(()=>{});
      return ()=>controller.abort();
    }
    if (id && data) { const row = document.getElementById(`incident-${id}`) as HTMLDetailsElement | null; if (row) { row.open = true; row.scrollIntoView({ block: 'center' }); } }
  }, [data?.incidents.length, linked?.id, hash]);
  if (!data) return <p role="status">{error ? 'Service monitor unavailable. Retrying…' : 'Loading service checks…'}</p>;
  const incidents = [...(linked && !data.incidents.some(i=>i.id===linked.id) ? [linked] : []), ...data.incidents, ...older.filter(i => !data.incidents.some(j => j.id === i.id))];
  return <div className="monitoring-view">
    {error && <p className="notice danger" role="alert">Monitoring updates unavailable. Previously observed states are unknown.</p>}
    <section className="monitor-panel"><h2>Application checks</h2><p className="detail-description">Independent availability observations, separate from container state and Docker health.</p><Checks checks={data.checks}/>{!data.checks.length && <p>No checks configured. Add checks in the administrator’s server configuration and restart Hostboard.</p>}</section>
    <details className="monitor-panel notification-settings"><summary>Notification delivery <span>{data.notifications.configured ? data.notifications.failed ? 'Delivery needs attention' : 'SMTP configured' : 'Not configured'}</span></summary><p>Service checks: {data.notifications.minimumSeverity} and above · {data.notifications.delivered} SMTP accepted · {data.notifications.pending} queued · {data.notifications.failed} retrying.</p><p>Last SMTP acceptance: {date(data.notifications.lastDeliveredAt)}. SMTP acceptance does not confirm inbox receipt.</p><p className="small muted">Netdata delivers its evaluated critical alerts separately. The independent watchdog owns Hostboard and hosting-server availability notifications. Credentials, recipients and private check targets are configured on the server.</p></details>
    <section className="monitor-panel"><h2>Incident history</h2><p className="detail-description">Availability incidents persist across deployments. Monitoring gaps are never counted as verified uptime.</p>{incidents.map(i => <Incident key={i.id} incident={i}/>)}{!incidents.length && <p className="muted">No confirmed incidents recorded.</p>}
      {!exhausted && data.incidents.length >= 100 && <button className="text-button" disabled={loading} onClick={async () => {
        setLoading(true); setLoadError(false);
        try { const r = await fetch(`/api/monitor?before=${incidents.at(-1)!.id}`); if (!r.ok) throw new Error(); const value: MonitorView = await r.json(); setOlder(v => [...v, ...value.incidents]); setExhausted(value.incidents.length < 100); } catch { setLoadError(true); } finally { setLoading(false); }
      }}>{loading ? 'Loading…' : 'Load older incidents'}</button>}{loadError && <p role="alert">Could not load older incidents. Retry.</p>}
    </section>
  </div>;
}
