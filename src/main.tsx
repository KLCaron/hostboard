import React, { useEffect, useId, useState } from 'react';
import { createRoot } from 'react-dom/client';
import {
  ArrowDownLeft,
  ArrowUpRight,
  Bell,
  Box,
  Check,
  ChevronDown,
  ChevronRight,
  CircleHelp,
  Clock3,
  Cpu,
  HardDrive,
  Layers3,
  LayoutDashboard,
  MemoryStick,
  Network,
  RefreshCw,
  Server,
  Thermometer,
  X,
} from 'lucide-react';
import {
  Area,
  AreaChart,
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import type { Fleet, History, Host, Point, Range } from './types';
import './style.css';
const ranges: Range[] = ['15m', '1h', '6h', '24h'];
const rangeLabels: Record<Range, string> = {
  '15m': '15 min',
  '1h': '1 hour',
  '6h': '6 hours',
  '24h': '24 hours',
};
const num = (n: number | null | undefined, d = 1) =>
  n == null
    ? '—'
    : n.toLocaleString(undefined, { maximumFractionDigits: d, minimumFractionDigits: d });
const percent = (n: number | null | undefined) => (n == null ? '—' : `${num(n)}%`);
function size(mib: number | null | undefined) {
  if (mib == null) return '—';
  return mib >= 1024 ? `${num(mib / 1024)} GiB` : `${num(mib)} MiB`;
}
function diskSize(gib: number | null) {
  return gib == null ? '—' : gib >= 1024 ? `${num(gib / 1024, 2)} TiB` : `${num(gib)} GiB`;
}
function rate(k: number | null | undefined, io = false) {
  if (k == null) return '—';
  const v = io ? k * 1024 : (k * 1000) / 8;
  return v >= 1048576
    ? `${num(v / 1048576)} MiB/s`
    : v >= 1024
      ? `${num(v / 1024)} KiB/s`
      : `${num(v, 0)} B/s`;
}
function uptime(seconds: number | null) {
  if (seconds == null) return 'Uptime unavailable';
  return seconds >= 86400
    ? `${Math.floor(seconds / 86400)}d ${Math.floor((seconds % 86400) / 3600)}h uptime`
    : `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m uptime`;
}
const time = (seconds: number) =>
  new Date(seconds * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
const errorText = (e: unknown) => (e instanceof Error ? e.message : 'Request failed');
async function get<T>(url: string, signal: AbortSignal): Promise<T> {
  const r = await fetch(url, { signal: AbortSignal.any([signal, AbortSignal.timeout(20000)]) });
  if (!r.ok) throw new Error(`Request failed (${r.status})`);
  return r.json();
}
function Spark({
  points,
  metric,
  color,
}: {
  points: Point[];
  metric: 'cpu' | 'memory';
  color: string;
}) {
  const id = useId().replaceAll(':', '');
  const valid = points.some((p) => p[metric] !== null);
  return (
    <div className="spark" aria-label={`${metric} history`}>
      {valid ? (
        <ResponsiveContainer width="100%" height="100%">
          <AreaChart data={points}>
            <defs>
              <linearGradient id={id} x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor={color} stopOpacity={0.24} />
                <stop offset="100%" stopColor={color} stopOpacity={0} />
              </linearGradient>
            </defs>
            <YAxis hide domain={[0, 'auto']} />
            <Area
              dataKey={metric}
              stroke={color}
              strokeWidth={1.7}
              fill={`url(#${id})`}
              isAnimationActive={false}
              connectNulls={false}
            />
            <Tooltip content={<ChartTip unit="%" />} />
          </AreaChart>
        </ResponsiveContainer>
      ) : (
        <span className="no-chart">History unavailable</span>
      )}
    </div>
  );
}
function ChartTip({
  active,
  payload,
  label,
  unit,
}: {
  active?: boolean;
  payload?: readonly { name?: string; value?: unknown; color?: string; payload?: Point }[];
  label?: unknown;
  unit: string;
}) {
  if (!active || !payload?.length) return null;
  const point = payload[0].payload;
  return (
    <div className="chart-tip">
      <b>{point ? time(point.time) : typeof label === 'number' ? time(label) : ''}</b>
      {payload.map((p, i) => (
        <span key={i} style={{ color: p.color }}>
          {p.name}:{' '}
          {typeof p.value === 'number'
            ? unit === 'network'
              ? rate(p.value)
              : unit === 'io'
                ? rate(p.value, true)
                : `${num(p.value)}${unit}`
            : '—'}
        </span>
      ))}
    </div>
  );
}
function HistoryChart({
  history,
  kind,
}: {
  history: History | undefined;
  kind: 'cpu' | 'memory' | 'network' | 'io' | 'load';
}) {
  const series =
    kind === 'network'
      ? [
          ['received', 'Received', '#a7dbe7'],
          ['sent', 'Sent', '#a7b3fa'],
        ]
      : kind === 'io'
        ? [
            ['read', 'Read', '#dfbe8b'],
            ['write', 'Write', '#b1d995'],
          ]
        : [
            [
              kind,
              kind === 'cpu'
                ? 'CPU utilization'
                : kind === 'memory'
                  ? 'RAM utilization'
                  : '1 minute load',
              kind === 'cpu' ? '#b9e692' : '#b0b9f6',
            ],
          ];
  const unit = ['cpu', 'memory'].includes(kind) ? '%' : kind === 'load' ? '' : kind;
  return (
    <div className="history-chart">
      {history?.points.some((p) => series.some(([key]) => p[key as keyof Point] !== null)) ? (
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={history.points} margin={{ top: 12, right: 8, left: 0, bottom: 0 }}>
            <CartesianGrid vertical={false} stroke="#262a31" strokeDasharray="3 5" />
            <XAxis
              dataKey="time"
              type="number"
              domain={['dataMin', 'dataMax']}
              tickFormatter={time}
              minTickGap={45}
              tick={{ fill: '#7f8592', fontSize: 11 }}
              axisLine={false}
              tickLine={false}
            />
            <YAxis
              width={kind === 'network' || kind === 'io' ? 78 : 40}
              domain={['cpu', 'memory'].includes(kind) ? [0, 100] : [0, 'auto']}
              tickFormatter={(v) =>
                unit === 'network' ? rate(v) : unit === 'io' ? rate(v, true) : `${num(v, 0)}${unit}`
              }
              tick={{ fill: '#7f8592', fontSize: 11 }}
              axisLine={false}
              tickLine={false}
            />
            <Tooltip content={<ChartTip unit={unit} />} />
            {series.map(([key, name, color]) => (
              <Line
                key={key}
                name={name}
                dataKey={key}
                stroke={color}
                strokeWidth={2}
                dot={false}
                connectNulls={false}
                isAnimationActive={false}
              />
            ))}
          </LineChart>
        </ResponsiveContainer>
      ) : (
        <div className="empty-chart">No recorded samples in this range.</div>
      )}
    </div>
  );
}
function Meter({ value, color = '#bbdf93' }: { value: number | null; color?: string }) {
  return (
    <div className="meter">
      <span
        style={{
          width: `${Math.max(0, Math.min(100, value ?? 0))}%`,
          background: value != null && value > 90 ? '#e4ac72' : color,
        }}
      />
    </div>
  );
}
function HostCard({
  host,
  history,
  range,
  expanded,
  onExpand,
}: {
  host: Host;
  history?: History;
  range: Range;
  expanded: boolean;
  onExpand: () => void;
}) {
  const [metric, setMetric] = useState<'cpu' | 'memory' | 'network' | 'io' | 'load'>('cpu');
  const [tab, setTab] = useState<'performance' | 'containers' | 'sensors'>('performance');
  const live = host.status === 'online',
    points = history?.points || [],
    running = host.containers.filter((c) => c.state === 'running').length;
  const alerts = host.alerts?.reduce((n, a) => n + a.count, 0),
    warmest = host.sensors.find((s) => s.value !== null);
  return (
    <article className={`host-card ${expanded ? 'expanded' : ''} ${!live ? 'not-live' : ''}`}>
      <div className="host-heading">
        <button className="host-title" onClick={onExpand} aria-expanded={expanded}>
          <span className="server-icon">
            <Server size={21} />
          </span>
          <span>
            <h2>{host.name}</h2>
            <span className="host-sub">
              {host.cores ? `${host.cores} cores` : 'Core count unavailable'}
              <i /> {host.os?.split(' (')[0] || host.hostname}
            </span>
          </span>
        </button>
        <span className={`status ${host.status}`}>
          <i />
          {host.status === 'online' ? 'Online' : host.status === 'offline' ? 'Offline' : 'Stale'}
        </span>
      </div>
      {host.error && (
        <div className="notice danger">
          {host.error}
          {host.lastSeen && <span>Last sample: {new Date(host.lastSeen).toLocaleString()}</span>}
        </div>
      )}
      <div className="host-meta">
        <span>
          <Clock3 size={13} />
          {live ? uptime(host.uptime) : 'Live metrics unavailable'}
        </span>
        {alerts != null && alerts > 0 ? (
          <span className="warning-text">
            <Bell size={13} />
            {alerts} {alerts === 1 ? 'alert' : 'alerts'}
          </span>
        ) : (
          <span className="muted">{host.hostname}</span>
        )}
      </div>
      <div className="metric-pair">
        <div className="metric-block">
          <div className="label">
            <Cpu size={14} />
            CPU utilization
          </div>
          <div className="metric-value">
            {percent(live ? host.cpu : null)}
            <span>{live && host.load ? `${num(host.load[0], 2)} load` : '— load'}</span>
          </div>
          <Spark points={points} metric="cpu" color="#bce894" />
        </div>
        <div className="metric-block">
          <div className="label">
            <MemoryStick size={14} />
            Memory
          </div>
          <div className="metric-value">
            {percent(live ? host.memory.percent : null)}
            <span>{live ? size(host.memory.used) : '—'} used</span>
          </div>
          <Spark points={points} metric="memory" color="#a7b4ef" />
        </div>
      </div>
      <div className="storage">
        <div className="section-label">
          <span>
            <HardDrive size={14} />
            Storage
          </span>
          <span>{host.disks.length ? `${host.disks.length} volumes` : 'Not available'}</span>
        </div>
        {host.disks.slice(0, expanded ? undefined : 3).map((d) => (
          <div className="volume" key={d.id}>
            <div>
              <span className="mount">{d.mount}</span>
              <span>
                {live ? diskSize(d.used) : '—'} <em>/ {diskSize(d.total)}</em>
                <b>{percent(live ? d.percent : null)}</b>
              </span>
            </div>
            <Meter value={live ? d.percent : null} />
          </div>
        ))}
        {!host.disks.length && <p className="muted small">No filesystem metrics reported.</p>}
        {!expanded && host.disks.length > 3 && (
          <span className="muted small">+{host.disks.length - 3} more in details</span>
        )}
      </div>
      <div className="throughput">
        <div>
          <div className="label">
            <Network size={14} />
            Network
          </div>
          <div className="rate-pair">
            <span>
              <ArrowDownLeft size={13} />
              {rate(live ? host.network.received : null)}
            </span>
            <span>
              <ArrowUpRight size={13} />
              {rate(live ? host.network.sent : null)}
            </span>
          </div>
        </div>
        <div>
          <div className="label">
            <HardDrive size={14} />
            Disk I/O
          </div>
          <div className="rate-pair">
            <span>
              <ArrowDownLeft size={13} />
              {rate(live ? host.io.read : null, true)}
            </span>
            <span>
              <ArrowUpRight size={13} />
              {rate(live ? host.io.write : null, true)}
            </span>
          </div>
        </div>
      </div>
      <div className="host-bottom">
        <div>
          <span title="Running containers reported by Netdata">
            <Box size={14} />
            {live && host.dockerAvailable ? `${running} running` : 'Docker unavailable'}
          </span>
          <span title={warmest?.name || 'Temperature unavailable'}>
            <Thermometer size={14} />
            {live && warmest ? `${num(warmest.value, 0)}°C max` : '— °C'}
          </span>
        </div>
        <button className="details-button" onClick={onExpand} aria-expanded={expanded}>
          {expanded ? 'Less detail' : 'Explore host'}
          {expanded ? <ChevronDown size={15} /> : <ChevronRight size={15} />}
        </button>
      </div>
      {expanded && (
        <div className="host-details">
          <div className="detail-tabs" role="tablist" aria-label={`${host.name} details`}>
            {(['performance', 'containers', 'sensors'] as const).map((t) => (
              <button
                role="tab"
                aria-selected={tab === t}
                className={tab === t ? 'active' : ''}
                onClick={() => setTab(t)}
                key={t}
              >
                {t === 'performance'
                  ? 'Performance'
                  : t === 'containers'
                    ? `Containers (${host.containers.length})`
                    : 'Temperatures'}
              </button>
            ))}
          </div>
          {tab === 'performance' && (
            <>
              <div className="chart-heading">
                <div>
                  <h3>Host performance</h3>
                  <p>{rangeLabels[range]} history · averaged samples · gaps mean no data</p>
                </div>
                <select
                  aria-label="Historical metric"
                  value={metric}
                  onChange={(e) => setMetric(e.target.value as typeof metric)}
                >
                  <option value="cpu">CPU utilization</option>
                  <option value="memory">Memory utilization</option>
                  <option value="load">CPU load</option>
                  <option value="network">Network throughput</option>
                  <option value="io">Disk I/O</option>
                </select>
              </div>
              <HistoryChart history={history} kind={metric} />
              {history?.errors.length ? (
                <p className="warning-text small">{history.errors.join(' · ')}</p>
              ) : null}
              <div className="detail-facts">
                <span>
                  Agent <b>{host.version || '—'}</b>
                </span>
                <span>
                  RAM capacity <b>{size(host.memory.total)}</b>
                </span>
                <span>
                  Load 1 / 5 / 15 min <b>{host.load?.map((v) => num(v, 2)).join(' / ') || '—'}</b>
                </span>
              </div>
            </>
          )}
          {tab === 'containers' && (
            <>
              <p className="detail-description">
                Agent-reported state and resources. CPU: 100% equals one core. Memory: resident
                usage.
              </p>
              {host.dockerAvailable ? (
                <div className="table-scroll">
                  <table>
                    <thead>
                      <tr>
                        <th>Container</th>
                        <th>State / health</th>
                        <th>CPU</th>
                        <th>Memory</th>
                      </tr>
                    </thead>
                    <tbody>
                      {host.containers.map((c) => (
                        <tr key={c.name}>
                          <td>
                            <b>{c.name}</b>
                            <span title={c.image}>{c.image}</span>
                          </td>
                          <td>
                            <span
                              className={`container-state ${c.state === 'running' ? 'good' : ''}`}
                            >
                              {live ? c.state : 'Unavailable'}
                            </span>
                            {c.health && c.health !== 'no_healthcheck' && (
                              <small
                                className={c.health.includes('unhealthy') ? 'warning-text' : ''}
                              >
                                {live ? c.health.replaceAll('_', ' ') : ''}
                              </small>
                            )}
                          </td>
                          <td>{percent(live ? c.cpu : null)}</td>
                          <td>{size(live ? c.memory : null)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : (
                <p className="empty-chart">Docker metrics are not available from this Agent.</p>
              )}
            </>
          )}
          {tab === 'sensors' && (
            <div className="sensor-grid">
              {host.sensors.length ? (
                host.sensors.map((s) => (
                  <div key={s.name}>
                    <Thermometer size={17} />
                    <span>{s.name}</span>
                    <b>{live && s.value !== null ? `${num(s.value)} °C` : '—'}</b>
                  </div>
                ))
              ) : (
                <p className="muted">No temperature sensors reported by this Agent.</p>
              )}
            </div>
          )}
          {host.warnings.length > 0 && (
            <div className="notice">Some metrics are unavailable: {host.warnings.join(' · ')}</div>
          )}
          <div className="sample-time">
            Last live sample:{' '}
            {host.lastSeen ? new Date(host.lastSeen).toLocaleString() : 'Unavailable'}
          </div>
        </div>
      )}
    </article>
  );
}
function App() {
  const [fleet, setFleet] = useState<Fleet>(),
    [histories, setHistories] = useState<Record<string, History>>({}),
    [range, setRange] = useState<Range>('1h'),
    [page, setPage] = useState<'overview' | 'servers' | 'alerts'>('overview'),
    [expanded, setExpanded] = useState<string | null>(null),
    [error, setError] = useState<string | null>(null),
    [historyError, setHistoryError] = useState<string | null>(null),
    [refresh, setRefresh] = useState(0),
    [fetching, setFetching] = useState(false),
    [now, setNow] = useState(Date.now()),
    [help, setHelp] = useState(false),
    [query, setQuery] = useState('');
  useEffect(() => {
    let cancelled = false,
      controller: AbortController | undefined;
    async function load() {
      controller = new AbortController();
      setFetching(true);
      try {
        const data = await get<Fleet>('/api/fleet', controller.signal);
        if (!cancelled) {
          setFleet(data);
          setError(null);
        }
      } catch (e) {
        if (!cancelled) setError(errorText(e));
      } finally {
        if (!cancelled) setFetching(false);
      }
    }
    void load();
    const interval = setInterval(() => void load(), 10000);
    return () => {
      cancelled = true;
      controller?.abort();
      clearInterval(interval);
    };
  }, [refresh]);
  const ids = fleet?.hosts.map((h) => h.id).join(',') || '';
  useEffect(() => {
    if (!ids) return;
    let cancelled = false;
    const controller = new AbortController();
    setHistories({});
    setHistoryError(null);
    async function load() {
      const results = await Promise.allSettled(
        ids
          .split(',')
          .map(
            async (id) =>
              [
                id,
                await get<History>(
                  `/api/hosts/${encodeURIComponent(id)}/history?range=${range}`,
                  controller.signal,
                ),
              ] as const,
          ),
      );
      if (cancelled) return;
      setHistories(
        Object.fromEntries(
          results
            .filter(
              (r): r is PromiseFulfilledResult<readonly [string, History]> =>
                r.status === 'fulfilled',
            )
            .map((r) => r.value),
        ),
      );
      setHistoryError(
        results.some((r) => r.status === 'rejected')
          ? 'Some history could not be loaded. Live metrics are shown separately.'
          : null,
      );
    }
    void load();
    const interval = setInterval(() => void load(), 30000);
    return () => {
      cancelled = true;
      controller.abort();
      clearInterval(interval);
    };
  }, [ids, range, refresh]);
  useEffect(() => {
    if (!help) return;
    const close = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setHelp(false);
    };
    window.addEventListener('keydown', close);
    return () => window.removeEventListener('keydown', close);
  }, [help]);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  const outdated = !!fleet && now - Date.parse(fleet.generatedAt) > 30000;
  const hosts = (fleet?.hosts || []).map((h) =>
      outdated
        ? {
            ...h,
            status: 'stale' as const,
            error: 'Dashboard updates have stopped. Values are no longer live.',
          }
        : h,
    ),
    online = hosts.filter((h) => h.status === 'online');
  const alerts = hosts.flatMap((h) =>
      (h.alerts || []).map((a) => ({ ...a, host: h.name, fresh: h.status === 'online' })),
    ),
    alertCount = alerts.reduce((n, a) => n + a.count, 0);
  const cpuHosts = online.filter((h) => h.cpu !== null && h.cores !== null),
    cores = cpuHosts.reduce((n, h) => n + h.cores!, 0),
    cpuAvg = cores ? cpuHosts.reduce((n, h) => n + h.cpu! * h.cores!, 0) / cores : null;
  const memoryHosts = online.filter((h) => h.memory.used !== null && h.memory.total !== null),
    memoryUsed = memoryHosts.length ? memoryHosts.reduce((n, h) => n + h.memory.used!, 0) : null;
  const containers = online.filter((h) => h.dockerAvailable).flatMap((h) => h.containers),
    running = containers.filter((c) => c.state === 'running').length;
  const visibleHosts = hosts.filter((h) =>
    `${h.name} ${h.hostname}`.toLowerCase().includes(query.toLowerCase()),
  );
  const age = fleet ? Math.max(0, Math.floor((now - Date.parse(fleet.generatedAt)) / 1000)) : null;
  const navigate = (value: typeof page) => {
    setPage(value);
    setQuery('');
    setExpanded(null);
  };
  return (
    <div className="app-shell">
      <aside className="sidebar">
        <a href="/" className="brand">
          <span className="brand-mark">
            <span />
            <span />
            <span />
          </span>
          hostboard<span className="beta">BETA</span>
        </a>
        <div className="workspace-label">MONITORING</div>
        <nav aria-label="Main navigation">
          <button
            className={page === 'overview' ? 'selected' : ''}
            onClick={() => navigate('overview')}
          >
            <LayoutDashboard size={18} />
            Overview
          </button>
          <button
            className={page === 'servers' ? 'selected' : ''}
            onClick={() => navigate('servers')}
          >
            <Server size={18} />
            Servers<span className="nav-count">{hosts.length || '—'}</span>
          </button>
          <button
            className={page === 'alerts' ? 'selected' : ''}
            onClick={() => navigate('alerts')}
          >
            <Bell size={18} />
            Alerts{alertCount > 0 && <span className="nav-count alert-count">{alertCount}</span>}
          </button>
        </nav>
        <div className="sidebar-bottom">
          <button className="about-button" onClick={() => setHelp(true)}>
            <CircleHelp size={16} />
            Dashboard info
            <ChevronRight size={14} />
          </button>
        </div>
      </aside>
      <div className="main-shell">
        <header className="topbar">
          <span>
            <Layers3 size={15} />
            <b>Monitoring</b>
            <ChevronRight size={13} />
            {page === 'overview' ? 'Overview' : page === 'servers' ? 'Servers' : 'Alerts'}
          </span>
          <div>
            <span className={`connection-dot ${error || outdated ? 'disconnected' : ''}`} />
            <span>
              {!fleet
                ? 'Connecting'
                : error || outdated
                  ? 'Updates interrupted'
                  : 'Live connection'}
            </span>
          </div>
        </header>
        <main>
          <section className="page-heading">
            <div>
              <h1>
                {page === 'overview' ? 'Fleet overview' : page === 'servers' ? 'Servers' : 'Alerts'}
              </h1>
            </div>
            <button
              className="refresh-button"
              onClick={() => setRefresh((v) => v + 1)}
              disabled={fetching}
              title="Refresh all metrics"
            >
              <RefreshCw size={15} className={fetching ? 'spinning' : ''} />
              <span>Refresh</span>
            </button>
          </section>
          {(error || outdated) && (
            <div className="notice danger" role="alert">
              {error ? `Cannot refresh dashboard: ${error}.` : ''}{' '}
              {fleet
                ? 'Previously received data is marked stale after 30 seconds.'
                : 'Waiting for a connection to the Hostboard backend.'}
            </div>
          )}
          {page !== 'alerts' && (
            <section className="fleet-stats" aria-label="Fleet summary">
              <div className="stat-card">
                <span className="stat-icon green">
                  <Server size={19} />
                </span>
                <div>
                  <span className="stat-label">Hosts online</span>
                  <div className="stat-value">
                    {fleet ? online.length : '—'}
                    <small>/ {fleet ? hosts.length : '—'}</small>
                  </div>
                  <span className="stat-note">
                    {!fleet
                      ? 'Connecting to hosts'
                      : online.length === hosts.length
                        ? 'All hosts reporting'
                        : 'Some hosts need attention'}
                  </span>
                </div>
                <span
                  className={`stat-dot ${online.length === hosts.length && fleet ? 'good' : ''}`}
                />
              </div>
              <div className="stat-card">
                <span className="stat-icon lime">
                  <Cpu size={19} />
                </span>
                <div>
                  <span className="stat-label">Fleet CPU</span>
                  <div className="stat-value">{percent(cpuAvg)}</div>
                  <span className="stat-note">Weighted across {cores || '—'} cores</span>
                </div>
              </div>
              <div className="stat-card">
                <span className="stat-icon lavender">
                  <MemoryStick size={19} />
                </span>
                <div>
                  <span className="stat-label">Memory in use</span>
                  <div className="stat-value">
                    {memoryUsed == null ? '—' : num(memoryUsed / 1024)}
                    <small>GiB</small>
                  </div>
                  <span className="stat-note">
                    {memoryHosts.length
                      ? `${num(memoryHosts.reduce((n, h) => n + h.memory.total!, 0) / 1024)} GiB monitored capacity`
                      : 'No live memory samples'}
                  </span>
                </div>
              </div>
              <div className="stat-card">
                <span className="stat-icon blue">
                  <Box size={19} />
                </span>
                <div>
                  <span className="stat-label">Containers running</span>
                  <div className="stat-value">
                    {online.some((h) => h.dockerAvailable) ? running : '—'}
                    <small>{containers.length ? `/ ${containers.length}` : ''}</small>
                  </div>
                  <span className="stat-note">
                    {online.some((h) => h.dockerAvailable)
                      ? 'Reported by Netdata Agents'
                      : 'Docker data unavailable'}
                  </span>
                </div>
              </div>
            </section>
          )}
          {page !== 'alerts' && (
            <>
              <section className="section-heading">
                <div>
                  <h2>
                    Servers <span>{hosts.length || '—'}</span>
                  </h2>
                  <p>Current metrics · {rangeLabels[range]} history</p>
                </div>
                <div className="range-picker" role="group" aria-label="Historical time range">
                  {ranges.map((r) => (
                    <button
                      key={r}
                      aria-pressed={range === r}
                      className={range === r ? 'active' : ''}
                      onClick={() => setRange(r)}
                    >
                      {r}
                    </button>
                  ))}
                </div>
              </section>
              {page === 'servers' && (
                <input
                  className="search"
                  aria-label="Filter servers"
                  placeholder="Find a server…"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                />
              )}
              {historyError && <div className="notice">{historyError}</div>}
              <section className="host-grid" aria-label="Servers">
                {fleet
                  ? visibleHosts.map((host) => (
                      <HostCard
                        key={host.id}
                        host={host}
                        history={histories[host.id]}
                        range={range}
                        expanded={expanded === host.id}
                        onExpand={() => setExpanded(expanded === host.id ? null : host.id)}
                      />
                    ))
                  : [0, 1].map((i) => (
                      <div key={i} className="skeleton" aria-label="Loading host metrics">
                        <div />
                        <div />
                        <div />
                      </div>
                    ))}
              </section>
              {fleet && !visibleHosts.length && (
                <p className="empty-chart">No servers match this search.</p>
              )}
            </>
          )}
          {page !== 'servers' && (
            <section className={`alerts-panel ${page === 'alerts' ? 'full-alerts' : ''}`}>
              <div className="alerts-heading">
                <span className="alerts-icon">
                  <Bell size={19} />
                </span>
                <div>
                  <h2>
                    Active alerts <span>{alertCount}</span>
                  </h2>
                  <p>Warnings and critical alerts.</p>
                </div>
                {page === 'overview' && (
                  <button className="text-button" onClick={() => navigate('alerts')}>
                    View alerts
                    <ChevronRight size={14} />
                  </button>
                )}
              </div>
              {alerts.map((a) => (
                <div className="alert-row" key={`${a.host}-${a.name}`}>
                  <span className={`severity ${a.severity}`}>{a.severity}</span>
                  <div>
                    <b>{a.summary}</b>
                    <span>
                      {a.host} · {a.name.replaceAll('_', ' ')}
                      {a.count > 1 ? ` · ${a.count} instances` : ''}
                      {!a.fresh ? ' · last known state' : ''}
                    </span>
                  </div>
                  <Bell size={15} />
                </div>
              ))}
              {!alerts.length && (
                <div className="all-clear">
                  <Check size={19} />
                  <span>
                    {hosts.length && hosts.every((h) => h.status === 'online' && h.alerts !== null)
                      ? 'No active warnings or critical alerts.'
                      : 'Alert status is not yet available for all hosts.'}
                  </span>
                </div>
              )}
              {hosts.some((h) => h.alerts === null || h.status !== 'online') && (
                <div className="notice">
                  Alert coverage is incomplete.{' '}
                  {hosts
                    .filter((h) => h.alerts === null || h.status !== 'online')
                    .map((h) => h.name)
                    .join(', ')}{' '}
                  cannot confirm current alert state.
                </div>
              )}
            </section>
          )}
          <footer>
            <span>
              <span className="footer-dot" />
              Metrics: Netdata
            </span>
            <span>
              {age === null ? 'Connecting…' : `Updated ${age < 2 ? 'just now' : `${age}s ago`}`}
              <i />
              Refreshes every 10s
            </span>
          </footer>
        </main>
      </div>
      {help && (
        <div className="modal-backdrop" onClick={() => setHelp(false)}>
          <section
            className="modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="about-title"
            onClick={(e) => e.stopPropagation()}
          >
            <button
              className="close-modal"
              onClick={() => setHelp(false)}
              aria-label="Close dashboard info"
              autoFocus
            >
              <X size={20} />
            </button>
            <h2 id="about-title">Dashboard info</h2>
            <p>
              Live metrics refresh every 10 seconds. Historical charts refresh every 30 seconds.
            </p>
            <p>
              Charts show up to 180 averaged samples for the selected time range. Gaps indicate
              missing data.
            </p>
            <p>
              Offline and stale hosts are excluded from fleet totals. Container CPU usage is
              measured per core: 100% equals one core.
            </p>
            <button className="primary-button" onClick={() => setHelp(false)}>
              Close
            </button>
          </section>
        </div>
      )}
    </div>
  );
}
createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
