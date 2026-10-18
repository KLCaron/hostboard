import { LogPanel } from './Logs';
import {useDisplay} from './display';
import { chartTooltipTheme } from './chartTheme';
import type { CheckView } from './monitor-types';
import { checkLabel } from './Monitoring';
import { HistorySelection, type Selection } from './HistorySelection';
import { servicesFromHosts } from './services';
import { useEffect, useMemo, useRef, useState } from 'react';
import { CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import type { Host, Container, Range } from './types';
import type { AlertDetail, AlertHistory, Diagnostic, Metric, MetricHistory, Window as TimeWindow } from './investigation-types';
import { containerStatus, readPreference, savePreference, sortContainers, type Sort } from './preferences';
const seconds = { '15m': 900, '1h': 3600, '6h': 21600, '24h': 86400 };
const date = (t: number | null) => t ? new Date(t * 1000).toLocaleString() : 'Unavailable';
const fmt = (v: number | null | undefined) => v == null ? '—' : v.toLocaleString(undefined, { maximumFractionDigits: 2 });
const duration = (s: number | null) => s == null ? 'Unavailable' : s >= 3600 ? `${fmt(s/3600)} hours` : `${fmt(s/60)} minutes`;
async function request<T>(url: string, signal: AbortSignal): Promise<T> {
  const response = await fetch(url, { signal: AbortSignal.any([signal, AbortSignal.timeout(20000)]) });
  if (!response.ok) { const body = await response.json().catch(() => ({})); throw new Error(body.error || `Request failed (${response.status})`); }
  return response.json();
}
function useData<T>(url: string | null, refresh = 30000) {
  const [data, setData] = useState<T>(), [error, setError] = useState(''), [loading, setLoading] = useState(false);
  useEffect(() => {
    if (!url) return;
    let active = true;
    const controller = new AbortController();
    setData(undefined); setLoading(true); setError('');
    const load = async () => {
      try { const value = await request<T>(url, controller.signal); if (active) { setData(value); setError(''); } }
      catch (e) { if (active) setError((e as Error).message); }
      finally { if (active) setLoading(false); }
    };
    void load(); const timer = refresh ? setInterval(() => void load(), refresh) : undefined;
    return () => { active = false; controller.abort(); clearInterval(timer); };
  }, [url, refresh]);
  return { data, error, loading };
}
export type InvestigationTarget = { host: Host; chart?: string; container?: Container; alert?: AlertDetail };
function localDate(t: number) {
  const d = new Date(t * 1000); return new Date(d.getTime() - d.getTimezoneOffset()*60000).toISOString().slice(0,16);
}
export function Explorer({ host, charts, initialChart, initialWindow, range = '1h' }: {
  host: Host; charts: Metric[]; initialChart?: string; initialWindow?: TimeWindow; range?: Range;
}) {
  const display=useDisplay();
  const [chart, setChart] = useState(initialChart || readPreference(`metric:${host.id}:${charts[0]?.group}`,charts[0]?.id || '',v=>charts.some(c=>c.id===v)));
  useEffect(()=>{savePreference(`metric:${host.id}:${charts[0]?.group}`,chart);},[chart,host.id]);
  const [preset, setPreset] = useState<Range>(() => readPreference('chartRange', range, v => typeof v === 'string' && v in seconds));
  const [window, setWindow] = useState<TimeWindow | null>(initialWindow || null);
  const [paused, setPaused] = useState(!!initialWindow), [tick, setTick] = useState(0);
  const [dimension, setDimension] = useState('');
  const [customError, setCustomError] = useState('');
  const [after, setAfter] = useState(localDate(initialWindow?.after || Date.now()/1000-seconds[preset]));
  const [before, setBefore] = useState(localDate(initialWindow?.before || Date.now()/1000));
  const [selection, setSelection] = useState<Selection | null>(null);
  useEffect(() => { if (paused || window) return; const timer = setInterval(() => setTick(v => v+1), 30000); return () => clearInterval(timer); }, [paused, window]);
  const liveEnd = useMemo(() => Math.floor(Date.now()/1000), [tick, preset]);
  const end = window?.before || liveEnd;
  const start = window?.after || end-seconds[preset];
  const url = chart ? `/api/hosts/${host.id}/metric-history?chart=${encodeURIComponent(chart)}&after=${Math.floor(start)}&before=${Math.floor(end)}&tick=${tick}` : null;
  const { data, error, loading } = useData<MetricHistory>(url, 0);
  useEffect(() => { if (data && !data.dimensions.includes(dimension)) setDimension(data.dimensions[0] || ''); setSelection(null); }, [data]);
  const metric = charts.find(c => c.id === chart);
  const isTemperature=/celsius|°c/i.test(metric?.units??'');
  const units=isTemperature?`°${display.temperature}`:metric?.units;
  const points=(data?.points||[]).map(p=>isTemperature&&display.temperature==='F'?Object.fromEntries(Object.entries(p).map(([k,v])=>[k,k==='time'||v===null?v:v*9/5+32])) as typeof p:p);
  const values = (agg: string) => points.map(p => p[`${dimension}:${agg}`]).filter((v): v is number => typeof v === 'number');
  const lo = values('min'), hi = values('max'), avg = values('average');
  const fixed = (w: TimeWindow) => { setWindow(w); setPaused(true); setSelection(null); };
  const pan = (direction: number) => { const width = end-start; const b = Math.min(Math.floor(Date.now()/1000), Math.floor(end+width*direction/2)); fixed({ after: Math.floor(b-width), before: b }); };
  const zoom = (factor: number) => { const width = Math.min(31*86400, Math.max(30, (end-start)*factor)); fixed({ after: Math.floor(end-width), before: Math.floor(end) }); };
  return <section className="explorer" aria-label="Metric investigation">
    <div className="chart-heading"><div><h3>{metric?.name || 'Metric unavailable'}</h3><p>{metric?.description}</p></div>
      <select aria-label="Investigation metric" value={chart} onChange={e => setChart(e.target.value)}>
        {initialChart && !charts.some(c=>c.id === initialChart) && <option value={initialChart}>Metric no longer collected</option>}
        {charts.map(c => <option key={c.id} value={c.id}>{c.context} · {c.name}</option>)}
      </select>
    </div>
    <div className="investigation-controls">
      {(Object.keys(seconds) as Range[]).map(r => <button key={r} aria-pressed={!window && preset===r} onClick={() => { setPreset(r); savePreference('chartRange',r); setWindow(null); setPaused(false); setTick(v=>v+1); }}>{r}</button>)}
      <button onClick={() => { if (!paused) fixed({after:start,before:end}); else {setWindow(null);setPaused(false);setTick(v=>v+1);} }}>{paused ? 'Resume live' : 'Pause'}</button>
      <button aria-label="Pan earlier" onClick={()=>pan(-1)}>←</button><button aria-label="Pan later" onClick={()=>pan(1)}>→</button>
      <button aria-label="Zoom in" onClick={()=>zoom(.5)}>Zoom +</button><button aria-label="Zoom out" onClick={()=>zoom(2)}>Zoom −</button>
    </div>
    <details className="custom-window"><summary>Custom time window</summary><form onSubmit={e=>{e.preventDefault(); const a=Date.parse(after)/1000,b=Date.parse(before)/1000; if(!Number.isFinite(a)||!Number.isFinite(b)||b-a<30||b-a>31*86400||b>Date.now()/1000+60) {setCustomError('Choose a past window between 30 seconds and 31 days.');return;}setCustomError('');fixed({after:a,before:b});}}>
      <label>From<input required type="datetime-local" value={after} onChange={e=>setAfter(e.target.value)}/></label><label>To<input required type="datetime-local" value={before} onChange={e=>setBefore(e.target.value)}/></label><button type="submit">Apply window</button>
      {customError && <p role="alert">{customError}</p>}
    </form></details>
    <p className="detail-description">{date(start)} — {date(end)} · {paused ? 'Paused' : 'Live · updates every 30s'} · {units}</p>
    {host.status !== 'online' && <div className="notice">Host {host.status}. Retained history may still be available; these readings are not live.</div>}
    {error && <div className="notice danger" role="alert">{error} <button onClick={()=>setTick(v=>v+1)}>Retry</button></div>}
    {loading && <p role="status">Loading history…</p>}
    {data && <>
      <select aria-label="Chart dimension" value={dimension} onChange={e=>setDimension(e.target.value)}>{data.dimensions.map(d=><option key={d}>{d}</option>)}</select>
      <div className="chart-statistics"><span>Min <b>{lo.length?fmt(Math.min(...lo)):'—'}</b></span><span>Peak <b>{hi.length?fmt(Math.max(...hi)):'—'}</b></span><span>Average <b>{avg.length?fmt(avg.reduce((a,b)=>a+b,0)/avg.length):'—'}</b></span><span>{units}</span></div>
      <p className="detail-description">Solid: average · gold: bucket peak · muted: minimum. Extrema apply to the selected dimension. Gaps mean no data. Average is across returned buckets.</p>
      {points.some(p=>p[`${dimension}:average`] != null) ? <>
      <HistorySelection times={points.map(p=>p.time)} selection={selection} onChange={setSelection} onStart={()=>setPaused(true)}><ResponsiveContainer width="100%" height="100%"><LineChart data={points} margin={{left:0,right:12,top:8,bottom:0}}>
        <CartesianGrid vertical={false} stroke="#292e36"/><XAxis dataKey="time" type="number" domain={['dataMin','dataMax']} tickFormatter={t=>new Date(t*1000).toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'})} minTickGap={45} tick={{fontSize:12}}/><YAxis width={54} tick={{fontSize:12}} domain={['auto','auto']}/>
        <Tooltip {...chartTooltipTheme} labelFormatter={t=>date(Number(t))} formatter={(v)=>fmt(typeof v==='number'?v:null)}/>
        <Line dataKey={`${dimension}:min`} name="Minimum" stroke="#71808e" dot={false} isAnimationActive={false} connectNulls={false}/>
        <Line dataKey={`${dimension}:max`} name="Peak" stroke="#dfbe8b" dot={false} isAnimationActive={false} connectNulls={false}/>
        <Line dataKey={`${dimension}:average`} name="Average" stroke="#b9e692" strokeWidth={2} dot={false} isAnimationActive={false} connectNulls={false}/>

      </LineChart></ResponsiveContainer></HistorySelection>
      <button className="subtle-button" disabled={!selection || points[selection.endIndex].time-points[selection.startIndex].time<30} onClick={()=>{ const a=points[selection!.startIndex]?.time,b=points[selection!.endIndex]?.time;if(b-a>=30)fixed({after:a,before:b}); }}>Zoom to brushed selection</button>
      </> : <p className="empty-chart">No recorded samples in this window. Choose another range or metric.</p>}
      <p className="detail-description">Available retention: {date(data.retention.first)} — {date(data.retention.last)} · returned buckets: {fmt(data.retention.interval)}s. Retention and resolution vary by metric and Netdata storage tier; spikes shorter than collection resolution cannot be recovered.</p>
      {!!data.errors.length && <div className="notice">{data.errors.join(' · ')}</div>}
    </>}
  </section>;
}
export function HostDiagnostics({host, range}:{host:Host;range:Range}) {
  const {data,loading,error}=useData<Diagnostic[]>(`/api/hosts/${host.id}/diagnostics`);
  const [selected,setSelected]=useState('');
  return <><p className="detail-description">Select a reading to investigate its history. PSI is the percentage of time tasks were stalled, not resource utilization.</p>
    {loading&&<p role="status">Loading diagnostics…</p>}{error&&<div className="notice danger">{error}</div>}
    {data?.length===0&&<p className="empty-chart">No advanced collectors reported by this Agent.</p>}
    {['CPU','Memory','Storage','Filesystems'].map(group=><details key={group} open={group==='CPU'} className="diagnostic-group"><summary>{group} diagnostics</summary><div className="diagnostic-grid">
      {data?.filter(d=>d.group===group).map(d=><button key={d.id} onClick={()=>setSelected(d.id)} title={d.description}><b>{d.context.replaceAll('_',' ')} · {d.name}</b><span>{Object.entries(d.values).map(([k,v])=>`${k}: ${fmt(v)}`).join(' · ')||'Readings unavailable'} {d.units}</span></button>)}
      {data&&!data.some(d=>d.group===group)&&<p className="muted">Collector unavailable.</p>}
    </div></details>)}
    {data&&selected&&<Explorer key={selected} host={host} charts={data} initialChart={selected} range={range}/>}
  </>;
}
export function HostExplorer({host,range}:{host:Host;range:Range}) {
  const {data,error,loading}=useData<Metric[]>(`/api/hosts/${host.id}/metrics`,60000);
  const contexts=['system.cpu','system.ram','system.net','system.io','system.load'];
  const [hash,setHash]=useState(location.hash);
  useEffect(()=>{const update=()=>setHash(location.hash);window.addEventListener('hashchange',update);return()=>window.removeEventListener('hashchange',update);},[]);
  const params=new URLSearchParams(hash.split('?')[1]??'');
  const after=Number(params.get('after')),before=Number(params.get('before'));
  const initialWindow=Number.isSafeInteger(after)&&Number.isSafeInteger(before)&&after>0&&before>after&&before-after<=86400&&before<=Date.now()/1000+60?{after,before}:undefined;
  const incident=params.get('incident');
  return <>{loading&&<p role="status">Loading metric catalog…</p>}{error&&<div className="notice danger">{error}</div>}{initialWindow&&<p className="small muted">Historical log investigation window · {date(after)} – {date(before)}{incident&&/^[1-9]\d{0,14}$/.test(incident)&&<> · <a className="text-link" href={`#incident=${incident}`}>Return to incident →</a></>}</p>}{data&&<Explorer key={hash} host={host} charts={data.filter(c=>contexts.includes(c.context))} range={range} initialWindow={initialWindow}/>}</>;
}
export function Containers({host,onInvestigate}:{host:Host;onInvestigate:(target:InvestigationTarget)=>void}) {
  const [sort,setSort]=useState<Sort>(()=>readPreference('containerSort','name',v=>['name','cpu','memory'].includes(String(v))));
  return <><div className="chart-heading"><p className="detail-description">{host.name} · CPU: 100% per core · RAM: resident MiB. Running does not confirm application availability.</p><select aria-label="Sort containers" value={sort} onChange={e=>{setSort(e.target.value as Sort);savePreference('containerSort',e.target.value);}}><option value="name">Name</option><option value="cpu">Highest CPU</option><option value="memory">Highest RAM</option></select></div>
    {!host.dockerAvailable&&<p className="notice">Docker collector unavailable. Last reported container states may be unknown.</p>}
    <div className="table-scroll"><table><thead><tr><th>Container / host</th><th>State / health check</th><th>CPU</th><th>RAM</th><th>Activity</th></tr></thead><tbody>{sortContainers(host.containers,sort).map(c=><tr key={c.name}>
      <td><button className="text-link" onClick={()=>onInvestigate({host,container:c})}>{c.name}</button><span>{host.name} · {c.image}</span></td>
      <td><span className={containerStatus(c,host.status==='online')==='unhealthy'?'warning-text':''}>{containerStatus(c,host.status==='online')}</span><small>{host.status!=='online'?'Health unknown':!c.health||c.health==='no_healthcheck'?'No health check':c.health.replaceAll('_',' ')}</small></td>
      <td>{host.status==='online'?fmt(c.cpu):'—'}%</td><td>{host.status==='online'?fmt(c.memory):'—'} MiB</td><td><button className="text-link" onClick={()=>onInvestigate({host,container:c})}>History & I/O →</button></td>
    </tr>)}</tbody></table></div>{!host.containers.length&&<p className="empty-chart">No containers reported by this Agent.</p>}
  </>;
}
export function Services({hosts,checks=[],onInvestigate}:{hosts:Host[];checks?:CheckView[];onInvestigate:(target:InvestigationTarget)=>void}) {
  const services=servicesFromHosts(hosts);
  const [filter,setFilter]=useState('');
  return <details className="services-panel"><summary>Container resources <span>{services.length} containers · expand to inspect</span></summary>
    <p className="detail-description">Container state, configured Docker health checks, and independent application availability are separate signals.</p>
    <input aria-label="Filter services" placeholder="Find an application or host…" value={filter} onChange={e=>setFilter(e.target.value)}/>
    <div className="service-list">{services.filter(({host,container:c})=>`${host.name} ${c.name}`.toLowerCase().includes(filter.toLowerCase())).map(({host,container:c,availability})=><details key={host.id+c.name}><summary><b>{c.name}</b><span>{host.name}</span><span>{containerStatus(c,host.status==='online')}</span>{checks.filter(x=>x.hostId===host.id&&x.container===c.name).map(x=><span key={x.id} className={`check-state ${x.state}`}>{checkLabel(x)}</span>)}<span>{host.status==='online'?fmt(c.cpu):'—'}% · {host.status==='online'?fmt(c.memory):'—'} MiB</span></summary>
      <p>Docker health check: {host.status!=='online'?'unknown':c.health==='no_healthcheck'?'not configured':c.health||'unknown'}. Application availability: {availability.state==='unchecked'?(checks.some(x=>x.hostId===host.id&&x.container===c.name)?'see independent check below':'not independently checked'):`${availability.state} (${availability.method}, ${availability.checkedAt})`}.</p>
      {checks.filter(x=>x.hostId===host.id&&x.container===c.name).map(x=><p key={x.id}>Application availability: {checkLabel(x)} · {x.reason} · <a className="text-link" href={`#service=${x.id}`}>Check history →</a></p>)}
      <button className="text-link" onClick={()=>onInvestigate({host,container:c})}>Investigate resources →</button> · <a className="text-link" href={`#host=${host.id}`}>Open host</a>
    </details>)}</div>{!services.length&&<p className="muted">No Docker services are currently reported.</p>}
  </details>;
}
export function Alerts({hosts,onInvestigate}:{hosts:Host[];onInvestigate:(target:InvestigationTarget)=>void}) {
  return <section className="alerts-panel"><div className="alerts-heading"><h2>Alert investigation</h2><p>Current incidents and recently resolved alerts · last 7 days, up to 200 transitions per host</p></div>{hosts.map(host=><HostAlerts key={host.id} host={host} onInvestigate={onInvestigate}/>)}</section>;
}
function HostAlerts({host,onInvestigate}:{host:Host;onInvestigate:(target:InvestigationTarget)=>void}) {
  const {data,error,loading}=useData<AlertHistory>(`/api/hosts/${host.id}/alerts`);
  const render=(a:AlertDetail)=><button className="alert-row investigation-alert" key={a.id} onClick={()=>onInvestigate({host,alert:a,chart:a.chart})}><span className={`severity ${a.severity}`}>{a.resolved?'Resolved':a.state}</span><div><b>{a.summary}</b><span>{host.name} · {a.resource} · {fmt(a.value)} {a.units}</span><span>{a.resolved?`Resolved ${date(a.endedAt)} · active ${duration(a.duration)}`:`State since ${date(a.startedAt)} · ${duration(a.startedAt?Date.now()/1000-a.startedAt:null)}`}</span></div><span>Investigate →</span></button>;
  return <div className="host-alerts"><h3><a href={`#host=${host.id}`}>{host.name}</a></h3>{host.status!=='online'&&<p className="notice">Host {host.status}; current alert state cannot be confirmed.</p>}{loading&&<p role="status">Loading alert details…</p>}{error&&<div role="alert" className="notice danger">{error}</div>}{data&&<>{data.active.map(render)}{!data.active.length&&!data.errors.length&&<p className="muted">No active warnings or critical alerts.</p>}<details><summary>Recently resolved ({data.resolved.length})</summary>{data.resolved.map(render)}{!data.resolved.length&&<p className="muted">No resolved incidents in the returned transition history.</p>}</details>{data.errors.map(e=><p className="notice" key={e}>{e}</p>)}</>}</div>;
}
export function InvestigationDialog({target,onClose}:{target:InvestigationTarget;onClose:()=>void}) {
  const ref=useRef<HTMLDialogElement>(null);
  const [tab,setTab]=useState('metrics');
  const {host,container,alert}=target;
  const {data,error,loading}=useData<Metric[]>(`/api/hosts/${host.id}/metrics`,0);
  useEffect(()=>{ const dialog=ref.current!;dialog.showModal();return()=>dialog.close(); },[]);
  const charts=data?.filter(c=>container ? c.group==='Containers'&&c.name===container.name&&['cgroup.cpu','cgroup.mem_usage','cgroup.io','cgroup.net_net'].includes(c.context) : c.id===target.chart || c.context===alert?.context)||[];
  const end=alert?.endedAt || (alert?.startedAt ? Math.min(Date.now()/1000,alert.startedAt+1800) : Date.now()/1000);
  const initialWindow=alert?.startedAt?{after:Math.floor(Math.max(alert.startedAt-900, end-31*86400+900)),before:Math.floor(Math.min(Date.now()/1000, Math.max(end+(!alert.endedAt?0:900),alert.startedAt+30)))}:undefined;
  return <dialog ref={ref} className="investigation-dialog" onCancel={onClose}><div className="dialog-heading"><div><h2>{alert?.summary||container?.name||'Metric investigation'}</h2><a className="text-link" href={`#host=${host.id}`} onClick={onClose}>{host.name} →</a></div><button autoFocus aria-label="Close investigation" onClick={onClose}>×</button></div>
    {alert&&<><div className="chart-statistics"><span>{alert.state} · {alert.severity}</span><span>{alert.resource}</span><span>{fmt(alert.value)} {alert.units}{alert.resolved?' before clearing':''}</span></div><p className="detail-description">{alert.info}</p><p>Started / state changed: {date(alert.startedAt)} · {alert.resolved?`resolved ${date(alert.endedAt)}`:'active'} · duration {duration(alert.duration??(alert.startedAt?Date.now()/1000-alert.startedAt:null))}</p><p className="detail-description">Warning rule: {alert.warning||'Unavailable'}<br/>Critical rule: {alert.critical||'Unavailable'}</p><p className="detail-description">Rules are Netdata expressions. Chart dimensions may differ from the alert’s calculated or rolling value.</p></>}
    {container&&<p className="detail-description">{containerStatus(container,host.status==='online')} · Docker check: {container.health||'unknown'} · See Services for configured application availability checks. CPU 100% = one core; memory in MiB. Network in kilobits/s, disk in KiB/s.</p>}
    <div className="detail-tabs" role="tablist" aria-label="Investigation view">{['metrics','logs'].map(t=><button key={t} role="tab" aria-selected={tab===t} className={tab===t?'active':''} onClick={()=>setTab(t)}>{t==='metrics'?'Metrics':'Logs'}</button>)}</div>{tab==='logs'?<LogPanel context={{hostId:host.id,container:container?.name}} initialWindow={initialWindow?{after:new Date(initialWindow.after*1000).toISOString(),before:new Date(Math.min(initialWindow.before,initialWindow.after+86400)*1000).toISOString()}:undefined}/>:<>{loading&&<p role="status">Loading metrics…</p>}{error&&<div className="notice danger">{error}</div>}{data&&(charts.length?<Explorer host={host} charts={charts} initialChart={target.chart||charts.find(c=>c.context==='cgroup.cpu')?.id} initialWindow={initialWindow}/>:<p className="empty-chart">This resource’s metric is no longer collected or is unavailable. Alert details remain available above.</p>)}</>}
  </dialog>;
}
