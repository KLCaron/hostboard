import { LogSection } from './Logs';
import { incidentLogWindow } from './log-types';
import { useEffect, useState } from 'react';
import { chartTooltipTheme } from './chartTheme';
import { ResponsiveContainer, LineChart, Line, XAxis, YAxis, Tooltip } from 'recharts';
import { serviceGroup, activeIssueCount } from './issues';
import type { Host } from './types';
import type { CheckView, IncidentView, MonitorView } from './monitor-types';

export const date = (t: number | null) => t === null ? '—' : new Date(t * 1000).toLocaleString();
const elapsed = (s: number) => s >= 86400 ? `${(s / 86400).toFixed(1)}d` : s >= 3600 ? `${(s / 3600).toFixed(1)}h` : s >= 60 ? `${Math.floor(s / 60)}m ${Math.floor(s % 60)}s` : `${Math.floor(s)}s`;
export const checkLabel = (c: CheckView) => c.state === 'disabled' ? 'Check disabled' : c.state === 'up' ? 'Reachable' : c.state === 'down' ? 'Unreachable' : c.state === 'pending' ? `Confirming failure ${c.failures}/${c.failureThreshold}` : 'Monitoring unavailable';
export function useMonitoring(refresh: number, interval=10) {
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
    void load(); const timer = setInterval(load, interval*1000);
    return () => { stopped = true; controller.abort(); clearInterval(timer); };
  }, [refresh,interval]);
  const stale = error || !!data && Date.now() / 1000 - data.generatedAt > Math.max(30,interval*2);
  return { data: data && stale ? { ...data, healthy: false, checks: data.checks.map(c => ({ ...c, state: c.state==='disabled'?'disabled' as const:'unknown' as const, responseMs: null, reason: 'Monitoring updates unavailable' })) } : data, error: stale };
}
export function Incident({ incident: i }: { incident: IncidentView }) {
  return <details className="incident-row" id={`incident-${i.id}`}>
    <summary><span className={`check-state ${i.endedAt === null ? 'down' : i.resolution === 'Reachability restored' ? 'up' : 'unknown'}`}>{i.endedAt === null ? 'Open' : i.resolution === 'Reachability restored' ? 'Recovered' : 'Retired'}</span><b>{i.name}</b><span>{i.hostId}</span><span>{date(i.startedAt)}</span><span>{elapsed((i.endedAt ?? Date.now() / 1000) - i.startedAt)}</span></summary>
    <div className="incident-detail"><p>{i.reason}</p>{i.source === 'watchdog' && <p className="muted">Detected and notified independently by the watchdog.</p>}<dl><dt>Confirmed</dt><dd>{date(i.detectedAt)}</dd><dt>Ended</dt><dd>{date(i.endedAt)}</dd><dt>Latest observation</dt><dd>{i.lastReason}{i.responseMs !== null ? ` · ${Math.round(i.responseMs)} ms` : ''}</dd><dt>Severity</dt><dd>{i.severity}</dd></dl>
      {i.monitoringGap && <p className="notice">Monitoring was interrupted during this incident. Elapsed duration includes an unobserved interval.</p>}
      <LogSection context={{hostId:i.hostId,incidentId:i.id}} initialWindow={incidentLogWindow(i.startedAt,i.endedAt)}/><div className="delivery-list"><b>Notifications</b>{i.notifications.map(n => <p key={n.id}>{n.event}: <strong>{n.state}</strong> · {n.attempts} attempts{n.deliveredAt ? ` · SMTP accepted ${date(n.deliveredAt)}` : ''}{n.error ? ` · ${n.error}` : ''}</p>)}{!i.notifications.length && <p>No notifications recorded.</p>}</div>
      <a className="text-link" href={`#host=${i.hostId}`}>Host metrics and diagnostics →</a> · <a className="text-link" href={`#service=${i.checkId}`}>Service checks →</a> · <a className="text-link" href={`#incident=${i.id}`}>Direct incident link ↗</a>
    </div>
  </details>;
}
function Checks({ checks }: { checks: CheckView[] }) {
  return <div className="check-grid">{checks.map(c => <CheckCard key={c.id} c={c}/>)}</div>;
}
function CheckCard({ c }: { c: CheckView }) {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    const update = () => { if(location.hash === `#service=${c.id}`) { const card = document.getElementById(`service-${c.id}`) as HTMLDetailsElement | null; if(card) { card.open = true; card.scrollIntoView({block:'center'}); } } };
    update(); window.addEventListener('hashchange',update); return()=>window.removeEventListener('hashchange',update);
  },[c.id]);
  return <details id={`service-${c.id}`} className="check-card" onToggle={e=>setOpen(e.currentTarget.open)}><summary><div><b>{c.name}</b><span>{c.hostId} · {c.type.toUpperCase()}</span></div><span className={`check-state ${c.state}`}>{checkLabel(c)}</span></summary>
    <div className="check-detail"><p>{c.reason}</p><dl><dt>Last observation</dt><dd>{date(c.checkedAt)}</dd><dt>Freshness</dt><dd>{c.checkedAt === null ? 'Not checked yet' : c.state === 'unknown' ? 'Monitoring unavailable' : 'Recent observation'}</dd><dt>Last successful check</dt><dd>{date(c.lastSuccessfulAt ?? null)}</dd><dt>Response time</dt><dd>{c.responseMs === null ? 'Unknown' : `${Math.round(c.responseMs)} ms`}</dd><dt>Schedule</dt><dd>Every {c.intervalSeconds}s · {c.failureThreshold} failures to confirm</dd><dt>Notifications</dt><dd>{c.notify ? `${c.severity} · outage and recovery` : 'Owned elsewhere or disabled'}</dd></dl>
      <p className="small muted">Reachability verifies the configured response or connection only. It does not verify every application function.</p>
      <LogSection context={{hostId:c.hostId,serviceId:c.id,generation:c.generation}}/><h4>Last 24 hours</h4><p>{c.summary.availability === null ? 'Insufficient coverage for an availability percentage.' : `${c.summary.availability.toFixed(2)}% of observed time reachable.`} Observed {elapsed(c.summary.observedSeconds)} · unknown {elapsed(c.summary.unknownSeconds)}.</p>
      {open && <div className="response-chart" aria-label={`${c.name} response time history`}><ResponsiveContainer width="100%" height="100%"><LineChart data={c.trend}><XAxis dataKey="time" tickFormatter={t => new Date(t * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} minTickGap={40} stroke="#88968e" fontSize={11}/><YAxis width={45} stroke="#88968e" fontSize={11} unit="ms"/><Tooltip {...chartTooltipTheme} labelFormatter={v => date(Number(v))} formatter={v => [`${Math.round(Number(v))} ms`, 'Response time']}/><Line dataKey="responseMs" stroke="#bbdf93" dot={{ r: 2 }} connectNulls={false} isAnimationActive={false}/></LineChart></ResponsiveContainer></div>}
      <p className="small muted">10 minute averages of successful and failed request durations. Blank intervals have no observations. Raw sample retention is configured in Settings.</p>
      <a className="text-link" href={`#host=${c.hostId}`}>Open host →</a>{c.activeIncident && <a className="text-link" href={`#incident=${c.activeIncident}`}> · Open incident →</a>} · <a className="text-link" href={`#issues?tab=history&type=availability&service=${c.id}`}>Incident history →</a>
    </div></details>;
}
export function MonitorNotice({ data, error }: { data?: MonitorView; error: boolean }) {
  return error ? <p className="notice danger" role="alert">Monitoring updates unavailable. Previously observed states are unknown.</p> : data && !data.healthy ? <p className="notice">Service monitor coverage is incomplete.</p> : null;
}
export function ServiceChecks({ data, error }: { data?: MonitorView; error: boolean }) {
  const [query, setQuery] = useState('');
  if (!data) return <p role="status">{error ? 'Service monitor unavailable. Retrying…' : 'Loading service checks…'}</p>;
  const checks = data.checks.filter(c=>`${c.name} ${c.hostId}`.toLowerCase().includes(query.toLowerCase()));
  return <div className="monitoring-view"><MonitorNotice data={data} error={error}/>
    <p className="detail-description">Independent checks verify application responses and infrastructure reachability.</p>
    <input className="search" aria-label="Filter monitored services" placeholder="Find a service or host…" value={query} onChange={e=>setQuery(e.target.value)}/>
    {(['Applications','Infrastructure'] as const).map(group=><section className="monitor-panel service-group" aria-label={group} key={group}><h2>{group}</h2><p className="detail-description">{group === 'Applications' ? 'Application availability, independent of container health.' : 'Monitoring endpoints, connectivity and independent supervision.'}</p><Checks checks={checks.filter(c=>serviceGroup(c)===group)}/>{!checks.some(c=>serviceGroup(c)===group)&&<p className="muted">No matching checks.</p>}</section>)}
    {!data.checks.length&&<p>No checks configured. Authorized administrators can add a check in Settings → Services.</p>}
  </div>;
}
export function HealthSummary({ hosts, data, error }: { hosts: Host[]; data?: MonitorView; error: boolean }) {
  const unhealthy = data?.checks.filter(c=>c.state !== 'up'&&c.state!=='disabled') ?? [];
  const count = activeIssueCount(hosts,data);
  const complete = !!hosts.length && hosts.every(h=>h.status==='online'&&h.alerts!==null) && !!data?.healthy && !error;
  return <section className="monitor-panel health-summary" aria-label="Monitoring health summary">
    <div><h2>{complete && !unhealthy.length && !count ? 'Everything is healthy' : !complete ? 'Health coverage needs attention' : 'Issues need attention'}</h2>
    <p>{data ? `${data.checks.filter(c=>c.state==='up').length}/${data.checks.filter(c=>c.state!=='disabled').length} services healthy` : 'Service health loading…'} · <a className="text-link" href="#issues">{count} active issue{count===1?'':'s'}</a>{!complete && ' · coverage incomplete'}</p></div>
    <a className="text-link" href="#services">View services →</a>
    {!!unhealthy.length&&<div className="health-attention">{unhealthy.map(c=><a key={c.id} className={`check-state ${c.state}`} href={`#service=${c.id}`}>{c.name}: {checkLabel(c)}</a>)}</div>}
    {hosts.filter(h=>h.status!=='online').map(h=><a key={h.id} className="warning-text" href={`#host=${h.id}`}>{h.name}: {h.status}</a>)}
    {(data?.activeIncidents??data?.incidents??[]).filter(i=>i.endedAt===null).slice(0,3).map(i=><a className="warning-text" key={i.id} href={`#incident=${i.id}`}>{i.name}: confirmed availability failure</a>)}
    {count>0&&<p className="warning-text">{hosts.flatMap(h=>(h.alerts??[]).map(a=>`${h.name}: ${a.summary}`)).slice(0,3).join(' · ')}{data?.notifications.failed ? ' · SMTP delivery needs attention' : ''}</p>}
  </section>;
}
export function Settings({ data, error }: { data?: MonitorView; error: boolean }) {
  if(!data) return <p role="status">{error ? 'Notification status unavailable. Retrying…' : 'Loading operational status…'}</p>;
  return <div className="monitoring-view"><MonitorNotice data={data} error={error}/>
    <section className="monitor-panel notification-settings"><h2>Notification delivery</h2><p className={data.notifications.failed?'warning-text':data.notifications.configured?'check-state up':'check-state unknown'}>{data.notifications.configured ? data.notifications.failed ? 'Delivery needs attention' : 'SMTP configured' : 'Not configured'}</p>
    <p>Service checks: {data.notifications.minimumSeverity} and above · {data.notifications.delivered} SMTP accepted · {data.notifications.pending} queued · {data.notifications.failed} retrying.</p>
    <p>Last SMTP acceptance: {date(data.notifications.lastDeliveredAt)}. SMTP acceptance does not confirm inbox receipt.</p>
    {!data.notifications.lastDeliveredAt&&<p className="muted">No SMTP acceptance recorded in the Hostboard service queue. Separate transport tests and other notification queues are not included here.</p>}
    {data.notifications.failed>0&&<a className="text-link" href="#issues?type=notification">Investigate delivery failures →</a>}
    <p className="small muted">Netdata delivers its evaluated critical alerts separately. The independent watchdog owns Hostboard and hosting-server availability notifications. Live delivery-check results for those separate queues are not exposed by this API.</p>
    <p className="small muted">SMTP credentials are configured on the server. Hostboard preferences are editable by authorized administrators.</p></section>
    <section className="monitor-panel"><h2>Monitoring configuration</h2><p>{data.checks.length} independent checks · {data.retentionDays} days of raw check samples · persistent availability incident history.</p><p className={data.healthy&&!error?'check-state up':'warning-text'}>Scheduler: {data.healthy&&!error?'reporting':'coverage incomplete'}</p><p className="detail-description">Check identities and history persist in SQLite. Netdata metrics are retained independently.</p></section>
  </div>;
}
