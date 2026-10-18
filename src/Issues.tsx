import { useEffect, useRef, useState } from 'react';
import type { Host } from './types';
import type { MonitorView, IncidentView } from './monitor-types';
import type { AlertHistory } from './investigation-types';
import type { InvestigationTarget } from './Investigation';
import { Incident, MonitorNotice, date } from './Monitoring';
import { availabilityIssues, notificationIssues, filterIssues, defaultFilters, type Issue, type IssueFilters } from './issues';

function filtersFromHash(): IssueFilters {
  const params = new URLSearchParams(location.hash.split('?')[1]);
  return {...defaultFilters,...Object.fromEntries(Object.keys(defaultFilters).flatMap(k=>params.has(k)?[[k,params.get(k)!]]:[]))};
}
export function Issues({ hosts, data, error, onInvestigate }: { hosts: Host[]; data?: MonitorView; error: boolean; onInvestigate: (target: InvestigationTarget)=>void }) {
  const openedAlert = useRef('');
  const [filters,setFilters] = useState(filtersFromHash);
  const [metrics,setMetrics] = useState<Record<string,AlertHistory>>({});
  const [metricErrors,setMetricErrors] = useState<string[]>([]);
  const [older,setOlder] = useState<IncidentView[]>([]);
  const [linked,setLinked] = useState<IncidentView>();
  const [linkError,setLinkError] = useState('');
  const [hash,setHash] = useState(location.hash);
  const [loading,setLoading] = useState(false), [loadError,setLoadError] = useState(false), [exhausted,setExhausted] = useState(false);
  const ids = hosts.map(h=>h.id).join(',');
  useEffect(()=>{ const update=()=>{setHash(location.hash);setFilters(filtersFromHash());};window.addEventListener('hashchange',update);return()=>window.removeEventListener('hashchange',update); },[]);
  useEffect(()=>{
    if(!ids) return;
    let stopped=false; const controller=new AbortController();
    async function load() {
      const results = await Promise.allSettled(ids.split(',').map(async id=>{
        const r=await fetch(`/api/hosts/${id}/alerts`,{signal:AbortSignal.any([controller.signal,AbortSignal.timeout(20000)])});
        if(!r.ok) throw Error(id); return [id,await r.json() as AlertHistory] as const;
      }));
      if(stopped)return;
      setMetrics(Object.fromEntries(results.flatMap(r=>r.status==='fulfilled'?[r.value]:[])));
      setMetricErrors(results.flatMap((r,i)=>r.status==='rejected'?[ids.split(',')[i]]:[]));
    }
    void load();const timer=setInterval(load,30000);return()=>{stopped=true;controller.abort();clearInterval(timer);};
  },[ids]);
  useEffect(()=>{
    const id=hash.match(/^#incident=(\d+)$/)?.[1];
    if(!id || !data) return;
    const found=[...data.incidents,...(data.activeIncidents??[]),...older].find(i=>i.id===Number(id));
    if(found){setLinked(found);setLinkError('');return;}
    const controller=new AbortController();
    setLinked(undefined);setLinkError('');
    void fetch(`/api/incidents/${id}`,{signal:controller.signal}).then(r=>{if(!r.ok)throw Error();return r.json();}).then(setLinked).catch(()=>{if(!controller.signal.aborted)setLinkError('This incident is unavailable. Browse retained history below.');});
    return()=>controller.abort();
  },[hash,data,older]);
  useEffect(()=>{
    if(!hash.startsWith('#incident=')||!linked)return;
    setFilters({...defaultFilters,tab:linked.endedAt===null?'active':'history',type:'availability'});
  },[hash,linked]);
  const incidents=availabilityIssues([...(data?.incidents??[]),...(data?.activeIncidents??[]),...older,...(linked?[linked]:[])]);
  const metricIssues: Issue[] = hosts.flatMap(host=>{
    const value=metrics[host.id];
    return [...(value?.active??[]),...(value?.resolved??[])].map(a=>({id:`metric-${host.id}-${a.id}`,type:'metric' as const,name:a.summary,severity:a.severity,hostId:host.id,status:a.resolved?'resolved' as const:'active' as const,time:a.endedAt??a.startedAt,alert:a,host}));
  });
  const all=[...incidents,...metricIssues,...notificationIssues(data)];
  const visible=filterIssues(all,filters);
  const visibleIds=visible.map(i=>i.id).join(',');
  useEffect(()=>{
    const id=hash.match(/^#incident=(\d+)$/)?.[1];
    const row=id?document.getElementById(`incident-${id}`) as HTMLDetailsElement|null:null;
    if(row){row.open=true;row.scrollIntoView({block:'center'});}
  },[hash,visibleIds]);
  useEffect(()=>{
    const key=hash.match(/^#alert=(.+)$/)?.[1];if(!key){openedAlert.current='';return;}if(openedAlert.current===key)return;
    const found=metricIssues.find(i=>`${i.hostId}:${encodeURIComponent(i.alert!.id)}`===key);
    if(found){openedAlert.current=key;setFilters({...defaultFilters,tab:found.status==='active'?'active':'history',type:'metric'});onInvestigate({host:found.host!,alert:found.alert,chart:found.alert!.chart});}
  },[hash,metrics]);
  function change(patch: Partial<IssueFilters>) {
    const next={...filters,...patch};setFilters(next);
    location.hash=`issues?${new URLSearchParams(Object.entries(next).filter(([k,v])=>v!==defaultFilters[k as keyof IssueFilters])).toString()}`;
  }
  const cursor=[...(data?.incidents??[]),...older].at(-1)?.id;
  return <div className="issues-view"><MonitorNotice data={data} error={error}/>
    <p className="detail-description">Metric alerts are Netdata warnings or critical thresholds. Availability incidents confirm failed service checks. Sources evaluate independently; records without a verified relationship remain separate.</p>
    <div className="detail-tabs issue-tabs" role="tablist" aria-label="Issue period">{['active','history'].map(tab=><button key={tab} role="tab" aria-selected={filters.tab===tab} className={filters.tab===tab?'active':''} onClick={()=>change({tab,status:'all'})}>{tab==='active'?'Active':'History'}</button>)}</div>
    <div className="issue-filters">
      <label>Issue type<select aria-label="Issue type" value={filters.type} onChange={e=>change({type:e.target.value})}><option value="all">All types</option><option value="metric">Metric alerts</option><option value="availability">Availability incidents</option><option value="notification">Notification delivery</option></select></label>
      <label>Severity<select aria-label="Severity" value={filters.severity} onChange={e=>change({severity:e.target.value})}><option value="all">All severities</option><option value="critical">Critical</option><option value="warning">Warning</option></select></label>
      <label>Host<select aria-label="Host" value={filters.host} onChange={e=>change({host:e.target.value})}><option value="all">All hosts</option>{[...new Set([...hosts.map(h=>h.id),...incidents.map(i=>i.hostId)])].map(id=><option key={id} value={id}>{hosts.find(h=>h.id===id)?.name??id}</option>)}</select></label>
      <label>Service<select aria-label="Service" value={filters.service} onChange={e=>change({service:e.target.value})}><option value="all">All services</option>{[...new Map([...(data?.checks.map(c=>[c.id,c.name] as const)??[]),...incidents.map(i=>[i.serviceId!,i.name] as const)]).entries()].map(([id,name])=><option key={id} value={id}>{name}</option>)}</select></label>
      <label>Status<select aria-label="Status" value={filters.status} onChange={e=>change({status:e.target.value})}><option value="all">All statuses</option>{(filters.tab==='active'?['active']:['resolved','retired']).map(s=><option key={s} value={s}>{s[0].toUpperCase()+s.slice(1)}</option>)}</select></label>
      <button className="text-link" onClick={()=>change(defaultFilters)}>Reset filters</button>
    </div>
    {!!metricErrors.length&&<p className="notice danger" role="alert">Metric issue coverage unavailable for {metricErrors.join(', ')}. Retrying…</p>}
    {hosts.filter(h=>h.status!=='online').map(h=><p key={h.id} className="notice">{h.name} is {h.status}; current metric alert state cannot be confirmed.</p>)}
    {Object.entries(metrics).flatMap(([id,m])=>m.errors.map(e=><p key={id+e} className="notice">{id}: {e}</p>))}
    {!Object.keys(metrics).length&&!metricErrors.length&&!!hosts.length&&<p role="status">Loading metric issues…</p>}
    {linkError&&<p role="alert" className="notice">{linkError}</p>}
    {hash.startsWith('#alert=')&&Object.keys(metrics).length===hosts.length&&!!hosts.length&&!metricIssues.some(i=>`${i.hostId}:${encodeURIComponent(i.alert!.id)}`===hash.slice(7))&&<p className="notice">This metric alert is no longer in the returned Netdata history.</p>}
    <section className="monitor-panel issue-results" aria-label="Issue results"><h2>{filters.tab==='active'?'Active issues':'Issue history'}</h2><p className="muted small">{visible.length} matching records{filters.tab==='history'?' · Metric history: last 7 days, up to 200 transitions per host. Availability history persists with older pages available.':''}</p>
      {visible.map(i=><div className="issue-record" data-issue-type={i.type} key={i.id}><span className={`issue-source ${i.type}`}>{i.type==='availability'?'Availability failure':i.type==='metric'?'Metric alert':'Notification delivery'}</span><span className={`severity ${i.severity}`}>{i.severity}</span>
        {i.incident?<Incident incident={i.incident}/>:i.alert?<button className="alert-row investigation-alert" onClick={()=>onInvestigate({host:i.host!,alert:i.alert,chart:i.alert!.chart})}><div><b>{i.name}</b><span>{i.host!.name} · {i.alert.resource} · {i.status}</span><span>{i.status==='active'?'State since':'Resolved'} {date(i.time)} · {i.alert.duration!==null?`${Math.round(i.alert.duration)} seconds`:i.alert.startedAt!==null?`${Math.max(0,Math.round(Date.now()/1000-i.alert.startedAt))} seconds active`:'Duration unavailable'}</span></div><span>Investigate →</span></button>:<p>{data?.notifications.failed} notification(s) failed; retries are scheduled. <a className="text-link" href="#settings">Notification status →</a></p>}
        {i.alert&&<a className="text-link small" href={`#alert=${i.hostId}:${encodeURIComponent(i.alert.id)}`}>Direct alert link ↗</a>}
      </div>)}
      {!visible.length&&<p className="empty-issues">{filters.tab==='active'?'No active issues match these filters.':'No historical issues match these filters.'}</p>}
      {filters.tab==='history'&&!exhausted&&(data?.incidents.length??0)>=100&&<button className="text-link" disabled={loading} onClick={async()=>{
        setLoading(true);setLoadError(false);
        try{const r=await fetch(`/api/monitor?before=${cursor}`);if(!r.ok)throw Error();const value:MonitorView=await r.json();setOlder(v=>[...v,...value.incidents]);setExhausted(value.incidents.length<100);}catch{setLoadError(true);}finally{setLoading(false);}
      }}>{loading?'Loading…':'Load older incidents'}</button>}
      {loadError&&<p role="alert">Could not load older incidents. Retry.</p>}
    </section>
  </div>;
}
