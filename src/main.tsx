import { DiscoverySummary } from "./ServerSettings";
import { TabList } from "./TabList";
import { LogsPage } from './Logs';
import { RangeSelector } from './RangeSelector';
import {
  Containers,
  HostDiagnostics,
  HostExplorer,
  Services,
  InvestigationDialog,
  type InvestigationTarget,
} from "./Investigation";
import { readPreference, savePreference } from "./preferences";
import React, { useEffect, useId, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  ArrowDownLeft,
  ArrowUpRight,
  Bell,
  Box,
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
  Settings as SettingsIcon,
  Activity,
  ScrollText,
} from "lucide-react";
import { Area, AreaChart, ResponsiveContainer, Tooltip, YAxis } from "recharts";
import type { Fleet, History, Host, Point, Range } from "./types";
import "./style.css";
import { useMonitoring, HealthSummary, ServiceChecks } from "./Monitoring";
import { Settings } from "./Settings";
import { Dashboard, type Widget } from "./Dashboard";
import { DisplayProvider, useDisplay, temperature } from "./display";
import { Issues } from "./Issues";
import { pages, resolveNavigation, type Page } from "./navigation";
import { activeIssueCount } from "./issues";
const ranges: Range[] = ["15m", "1h", "6h", "24h"];
const rangeLabels: Record<Range, string> = {
  "15m": "15 min",
  "1h": "1 hour",
  "6h": "6 hours",
  "24h": "24 hours",
};
const num = (n: number | null | undefined, d = 1) =>
  n == null
    ? "—"
    : n.toLocaleString(undefined, {
        maximumFractionDigits: d,
        minimumFractionDigits: d,
      });
const percent = (n: number | null | undefined) =>
  n == null ? "—" : `${num(n)}%`;
function size(mib: number | null | undefined) {
  if (mib == null) return "—";
  return mib >= 1024 ? `${num(mib / 1024)} GiB` : `${num(mib)} MiB`;
}
function diskSize(gib: number | null) {
  return gib == null
    ? "—"
    : gib >= 1024
      ? `${num(gib / 1024, 2)} TiB`
      : `${num(gib)} GiB`;
}
function rate(k: number | null | undefined, io = false) {
  if (k == null) return "—";
  const v = io ? k * 1024 : (k * 1000) / 8;
  return v >= 1048576
    ? `${num(v / 1048576)} MiB/s`
    : v >= 1024
      ? `${num(v / 1024)} KiB/s`
      : `${num(v, 0)} B/s`;
}
function uptime(seconds: number | null) {
  if (seconds == null) return "Uptime unavailable";
  return seconds >= 86400
    ? `${Math.floor(seconds / 86400)}d ${Math.floor((seconds % 86400) / 3600)}h uptime`
    : `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m uptime`;
}
const time = (seconds: number) =>
  new Date(seconds * 1000).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
  });
const errorText = (e: unknown) =>
  e instanceof Error ? e.message : "Request failed";
async function get<T>(url: string, signal: AbortSignal): Promise<T> {
  const r = await fetch(url, {
    signal: AbortSignal.any([signal, AbortSignal.timeout(20000)]),
  });
  if (!r.ok) throw new Error(`Request failed (${r.status})`);
  return r.json();
}
function Spark({
  points,
  metric,
  color,
}: {
  points: Point[];
  metric: "cpu" | "memory";
  color: string;
}) {
  const id = useId().replaceAll(":", "");
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
            <YAxis hide domain={[0, "auto"]} />
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
  payload?: readonly {
    name?: string;
    value?: unknown;
    color?: string;
    payload?: Point;
  }[];
  label?: unknown;
  unit: string;
}) {
  if (!active || !payload?.length) return null;
  const point = payload[0].payload;
  return (
    <div className="chart-tip">
      <b>
        {point
          ? time(point.time)
          : typeof label === "number"
            ? time(label)
            : ""}
      </b>
      {payload.map((p, i) => (
        <span key={i}>
          {p.name}:{" "}
          {typeof p.value === "number"
            ? unit === "network"
              ? rate(p.value)
              : unit === "io"
                ? rate(p.value, true)
                : `${num(p.value)}${unit}`
            : "—"}
        </span>
      ))}
    </div>
  );
}
function Meter({
  value,
  color = "#bbdf93",
}: {
  value: number | null;
  color?: string;
}) {
  return (
    <div className="meter">
      <span
        style={{
          width: `${Math.max(0, Math.min(100, value ?? 0))}%`,
          background: value != null && value > 90 ? "#e4ac72" : color,
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
  onInvestigate,
}: {
  host: Host;
  history?: History;
  range: Range;
  expanded: boolean;
  onExpand: () => void;
  onInvestigate: (target: InvestigationTarget) => void;
}) {
  const display = useDisplay();
  const [tab, setTab] = useState<
    "performance" | "diagnostics" | "containers" | "sensors" | "information"
  >("performance");
  const live = host.status === "online",
    points = history?.points || [],
    running = host.containers.filter((c) => c.state === "running").length;
  const alerts = host.alerts?.reduce((n, a) => n + a.count, 0),
    warmest = host.sensors.find((s) => s.value !== null);
  return (
    <article
      id={`host-${host.id}`}
      className={`host-card ${expanded ? "expanded" : ""} ${!live ? "not-live" : ""}`}
    >
      <div className="host-heading">
        <button
          className="host-title"
          onClick={onExpand}
          aria-expanded={expanded}
        >
          <span className="server-icon">
            <Server size={21} />
          </span>
          <span>
            <h2>{host.name}</h2>
            <span className="host-sub">
              {host.cores ? `${host.cores} cores` : "Core count unavailable"}
              <i /> {host.os?.split(" (")[0] || host.hostname}
            </span>
          </span>
          {expanded ? <ChevronDown size={15} aria-hidden="true" /> : <ChevronRight size={15} aria-hidden="true" />}
        </button>
        <span className={`status ${host.status}`}>
          <i />
          {host.archived ? "Archived" : host.enabled === false ? "Disabled" : host.status === "online"
            ? "Online"
            : host.status === "offline"
              ? "Offline"
              : "Stale"}
        </span>
      </div>
      {host.error && (
        <div className="notice danger">
          {host.error}
          {host.lastSeen && (
            <span>Last sample: {new Date(host.lastSeen).toLocaleString()}</span>
          )}
        </div>
      )}
      <div className="host-meta">
        <span>
          <Clock3 size={13} />
          {live ? uptime(host.uptime) : "Live metrics unavailable"}
        </span>
        {alerts != null && alerts > 0 ? (
          <span className="warning-text">
            <Bell size={13} />
            {alerts} {alerts === 1 ? "alert" : "alerts"}
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
            <span>
              {live && host.load ? `${num(host.load[0], 2)} load` : "— load"}
            </span>
          </div>
          <Spark
            points={points.map((p) => ({
              ...p,
              cpu: history?.cpuPeaks?.some((s) => s.value != null)
                ? (history.cpuPeaks.find((s) => s.time === p.time)?.value ??
                  null)
                : p.cpu,
            }))}
            metric="cpu"
            color="#bce894"
          />
          <span className="muted small">
            {history?.cpuPeaks?.some((p) => p.value != null)
              ? `Peak ${percent(Math.max(...history.cpuPeaks.flatMap((p) => (p.value == null ? [] : [p.value]))))}`
              : "CPU peak unavailable"}
          </span>
        </div>
        <div className="metric-block">
          <div className="label">
            <MemoryStick size={14} />
            Memory
          </div>
          <div className="metric-value">
            {percent(live ? host.memory.percent : null)}
            <span>{live ? size(host.memory.used) : "—"} used</span>
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
          <span>
            {host.disks.length
              ? `${host.disks.length} volumes`
              : "Not available"}
          </span>
        </div>
        {host.disks.slice(0, expanded ? undefined : 3).map((d) => (
          <div className="volume" key={d.id}>
            <div>
              <span className="mount">{d.mount}</span>
              <span>
                {live ? diskSize(d.used) : "—"} <em>/ {diskSize(d.total)}</em>
                <b>{percent(live ? d.percent : null)}</b>
              </span>
            </div>
            <Meter value={live ? d.percent : null} />
          </div>
        ))}
        {!host.disks.length && (
          <p className="muted small">No filesystem metrics reported.</p>
        )}
        {!expanded && host.disks.length > 3 && (
          <span className="muted small">
            +{host.disks.length - 3} more in details
          </span>
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
            {live && host.dockerAvailable
              ? `${running} running`
              : "Docker unavailable"}
          </span>
          <span title={warmest?.name || "Temperature unavailable"}>
            <Thermometer size={14} />
            {live && warmest
              ? `${temperature(warmest.value, display.temperature, 0)} max`
              : `— °${display.temperature}`}
          </span>
        </div>
        <button
          className="details-button action-link"
          onClick={onExpand}
          aria-expanded={expanded}
        >
          {expanded ? "Less detail" : "Explore host"}
          {expanded ? <ChevronDown size={15} /> : <ChevronRight size={15} />}
        </button>
      </div>
      {expanded && (
        <div className="host-details">
          <TabList
            className="detail-tabs"
            aria-label={`${host.name} details`}
          >
            {(
              ["performance", "information", "diagnostics", "containers", "sensors"] as const
            ).map((t) => (
              <button
                role="tab"
                aria-selected={tab === t}
                tabIndex={tab === t ? 0 : -1}
                className={tab === t ? "active" : ""}
                onClick={() => setTab(t)}
                key={t}
              >
                {t === "information" ? "Host information" : t === "performance"
                  ? "Performance"
                  : t === "containers"
                    ? `Containers (${host.containers.length})`
                    : t === "diagnostics"
                      ? "Diagnostics"
                      : "Temperatures"}
              </button>
            ))}
          </TabList>
          {tab === "performance" && (
            <>
              <HostExplorer host={host} range={range} />
              <div className="detail-facts">
                <span>
                  Agent <b>{host.version || "—"}</b>
                </span>
                <span>
                  RAM capacity <b>{size(host.memory.total)}</b>
                </span>
                <span>
                  Load 1 / 5 / 15 min{" "}
                  <b>{host.load?.map((v) => num(v, 2)).join(" / ") || "—"}</b>
                </span>
              </div>
            </>
          )}
          {tab === "diagnostics" && (
            <HostDiagnostics host={host} range={range} />
          )}
          {tab === "containers" && (
            <Containers host={host} onInvestigate={onInvestigate} />
          )}
          {tab === "sensors" && (
            <>
              {[
                "CPU temperatures",
                "Storage temperatures",
                "Other temperatures",
              ].map((group) => (
                <section key={group}>
                  <h3 className="sensor-heading">{group}</h3>
                  <div className="sensor-grid">
                    {host.sensors
                      .filter((s) => s.group === group)
                      .map((s) => (
                        <button
                          className="sensor-reading"
                          key={s.id}
                          onClick={() => onInvestigate({ host, chart: s.id })}
                        >
                          <span>{s.name}</span>
                          <b>
                            {live
                              ? temperature(s.value, display.temperature)
                              : "—"}
                          </b>
                        </button>
                      ))}
                    {!host.sensors.some((s) => s.group === group) && (
                      <p className="muted small">No sensors reported.</p>
                    )}
                  </div>
                </section>
              ))}
            </>
          )}
          {tab === "information" && <section aria-label="Host information">
            <h3>{host.name} · {host.hostname}</h3>
            <p>{host.archived ? 'Archived · monitoring stopped' : host.enabled === false ? 'Monitoring disabled' : `Connection: ${host.status}`} · {host.groupName || 'Ungrouped'}</p>
            <p>Last successful communication: {host.lastCommunication ? new Date(host.lastCommunication).toLocaleString() : 'Not yet recorded'}</p>
            <p>Latest metric sample: {host.lastSeen ? new Date(host.lastSeen).toLocaleString() : 'Unavailable'} · Freshness: {host.status}</p>
            <p>Docker logs: {host.loggingConfigured ? 'Deployment-approved adapter configured' : 'Unconfigured; Agent registration does not grant log access'}</p>
            {host.discovery ? <DiscoverySummary value={host.discovery}/> : <p className="muted">No cached node metadata available. Retry the connection in Settings.</p>}
            <a className="action-link" href="#settings?tab=servers">Manage server / Test connection</a>
          </section>}
          <a className="text-link host-permalink" href={`#host=${host.id}`}>
            Direct link to {host.name} ↗
          </a>
          {host.warnings.length > 0 && (
            <div className="notice">
              Some metrics are unavailable: {host.warnings.join(" · ")}
            </div>
          )}
          <div className="sample-time">
            Last live sample:{" "}
            {host.lastSeen
              ? new Date(host.lastSeen).toLocaleString()
              : "Unavailable"}
          </div>
        </div>
      )}
    </article>
  );
}
function App() {
  const display = useDisplay();
  const [fleet, setFleet] = useState<Fleet>(),
    [histories, setHistories] = useState<Record<string, History>>({}),
    [range, setRange] = useState<Range>(() =>
      readPreference("range", "1h", (v) => ranges.includes(v as Range)),
    ),
    [page, setPage] = useState<Page>(
      () => resolveNavigation(location.hash, location.pathname).page,
    ),
    [expanded, setExpanded] = useState<string | null>(null),
    [error, setError] = useState<string | null>(null),
    [historyError, setHistoryError] = useState<string | null>(null),
    [refresh, setRefresh] = useState(0),
    [fetching, setFetching] = useState(false),
    [now, setNow] = useState(Date.now()),
    [help, setHelp] = useState(false),
    [query, setQuery] = useState("");
  const helpDialog = useRef<HTMLDialogElement>(null);
  const monitoring = useMonitoring(refresh, display.refreshSeconds);
  useEffect(() => {
    setRange(
      readPreference("range", display.range, (v) =>
        ranges.includes(v as Range),
      ),
    );
  }, [display.range]);
  useEffect(() => {
    if (!location.hash && location.pathname === "/") {
      setPage(display.landing);
    }
  }, [display.landing]);
  const [target, setTarget] = useState<InvestigationTarget | null>(null);
  useEffect(() => {
    const link = () => {
      const route = resolveNavigation(location.hash, location.pathname);
      if (route.canonical) {
        history.replaceState(null, "", `/${route.canonical}`);
        window.dispatchEvent(new HashChangeEvent("hashchange"));
      } else if (location.pathname !== "/")
        history.replaceState(null, "", `/${location.hash || `#${route.page}`}`);
      setPage(
        !location.hash && location.pathname === "/"
          ? display.landing
          : route.page,
      );
      setExpanded(route.host ?? null);
      if (route.host) { setGroupFilter(''); setShowArchived(true); }
      setQuery("");
      setTarget(null);
    };
    link();
    window.addEventListener("hashchange", link);
    window.addEventListener("popstate", link);
    return () => {
      window.removeEventListener("hashchange", link);
      window.removeEventListener("popstate", link);
    };
  }, []);
  useEffect(() => {
    let cancelled = false,
      controller: AbortController | undefined;
    async function load() {
      controller = new AbortController();
      setFetching(true);
      try {
        const data = await get<Fleet>("/api/fleet", controller.signal);
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
    window.addEventListener("hostboard:servers", load);
    const interval = setInterval(
      () => void load(),
      display.refreshSeconds * 1000,
    );
    return () => {
      cancelled = true;
      controller?.abort();
      window.removeEventListener("hostboard:servers", load);
      clearInterval(interval);
    };
  }, [refresh, display.refreshSeconds]);
  const ids = fleet?.hosts.filter(h => h.enabled !== false && !h.archived).map((h) => h.id).join(",") || "";
  useEffect(() => {
    if (!ids) return;
    let cancelled = false;
    const controller = new AbortController();
    setHistories({});
    setHistoryError(null);
    async function load() {
      const results = await Promise.allSettled(
        ids
          .split(",")
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
                r.status === "fulfilled",
            )
            .map((r) => r.value),
        ),
      );
      setHistoryError(
        results.some((r) => r.status === "rejected")
          ? "Some history could not be loaded. Live metrics are shown separately."
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
    const dialog = helpDialog.current!;
    dialog.showModal();
    return () => dialog.close();
  }, [help]);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  const outdated =
    !!fleet &&
    now - Date.parse(fleet.generatedAt) >
      Math.max(30000, display.refreshSeconds * 2000);
  const hosts = (fleet?.hosts || []).map((h) =>
      outdated
        ? {
            ...h,
            status: "stale" as const,
            error: "Dashboard updates have stopped. Values are no longer live.",
          }
        : h,
    ),
    allHosts = hosts;
  const [groupFilter, setGroupFilter] = useState(() => readPreference<string>('server-group', '', v => typeof v === 'string'));
  const [showArchived, setShowArchived] = useState(false);
  const effectiveGroup = groupFilter === 'ungrouped' || fleet?.groups?.some(g => g.id === groupFilter) ? groupFilter : '';
  const scopedHosts = hosts.filter(h => !h.archived && (!effectiveGroup || (effectiveGroup === 'ungrouped' ? !h.groupId : h.groupId === effectiveGroup)));
  const online = scopedHosts.filter(h => h.status === 'online' && h.enabled !== false);
  const groupLabel = effectiveGroup === 'ungrouped' ? 'Ungrouped' : fleet?.groups?.find(g => g.id === effectiveGroup)?.name;
  const issueCount = activeIssueCount(hosts, monitoring.data);
  const cpuHosts = online.filter((h) => h.cpu !== null && h.cores !== null),
    cores = cpuHosts.reduce((n, h) => n + h.cores!, 0),
    cpuAvg = cores
      ? cpuHosts.reduce((n, h) => n + h.cpu! * h.cores!, 0) / cores
      : null;
  const memoryHosts = online.filter(
      (h) => h.memory.used !== null && h.memory.total !== null,
    ),
    memoryUsed = memoryHosts.length
      ? memoryHosts.reduce((n, h) => n + h.memory.used!, 0)
      : null;
  const containers = online
      .filter((h) => h.dockerAvailable)
      .flatMap((h) => h.containers),
    running = containers.filter((c) => c.state === "running").length;
  const visibleHosts = (showArchived ? hosts.filter(h => !effectiveGroup || (effectiveGroup === 'ungrouped' ? !h.groupId : h.groupId === effectiveGroup)) : scopedHosts).filter((h) =>
    `${h.name} ${h.hostname}`.toLowerCase().includes(query.toLowerCase()),
  );
  const age = fleet
    ? Math.max(0, Math.floor((now - Date.parse(fleet.generatedAt)) / 1000))
    : null;
  const navigate = (event: React.MouseEvent<HTMLAnchorElement>) => {
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    if (
      !window.dispatchEvent(
        new Event("hostboard:navigate", { cancelable: true }),
      )
    ) event.preventDefault();
  };
  const fleetSummary = (
    <section className="fleet-stats" aria-label={effectiveGroup ? `${groupLabel} summary` : "Fleet summary"}>
      <div className="stat-card">
        <span className="stat-icon green">
          <Server size={19} />
        </span>
        <div>
          <span className="stat-label">Hosts online</span>
          <div className="stat-value">
            {fleet ? online.length : "—"}
            <small>/ {fleet ? scopedHosts.length : "—"}</small>
          </div>
          <span className="stat-note">
            {!fleet
              ? "Connecting to hosts"
              : online.length === scopedHosts.length
                ? "All hosts reporting"
                : "Some hosts need attention"}
          </span>
        </div>
        <span
          className={`stat-dot ${online.length === scopedHosts.length && fleet ? "good" : ""}`}
        />
      </div>
      <div className="stat-card">
        <span className="stat-icon lime">
          <Cpu size={19} />
        </span>
        <div>
          <span className="stat-label">{effectiveGroup ? "Group CPU" : "Fleet CPU"}</span>
          <div className="stat-value">{percent(cpuAvg)}</div>
          <span className="stat-note">
            Weighted across {cores || "—"} cores
          </span>
        </div>
      </div>
      <div className="stat-card">
        <span className="stat-icon lavender">
          <MemoryStick size={19} />
        </span>
        <div>
          <span className="stat-label">Memory in use</span>
          <div className="stat-value">
            {memoryUsed == null ? "—" : num(memoryUsed / 1024)}
            <small>GiB</small>
          </div>
          <span className="stat-note">
            {memoryHosts.length
              ? `${num(memoryHosts.reduce((n, h) => n + h.memory.total!, 0) / 1024)} GiB monitored capacity`
              : "No live memory samples"}
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
            {online.some((h) => h.dockerAvailable) ? running : "—"}
            <small>{containers.length ? `/ ${containers.length}` : ""}</small>
          </div>
          <span className="stat-note">
            {online.some((h) => h.dockerAvailable)
              ? "Reported by Netdata Agents"
              : "Docker data unavailable"}
          </span>
        </div>
      </div>
    </section>
  );
  const overviewWidgets: Widget[] = [
    {
      id: "health",
      title: "Monitoring health",
      width: "full",
      node: (
        <HealthSummary
          hosts={scopedHosts}
          data={effectiveGroup && monitoring.data ? { ...monitoring.data, checks: monitoring.data.checks.filter(c => scopedHosts.some(h => h.id === c.hostId)), activeIncidents: monitoring.data.activeIncidents?.filter(i => scopedHosts.some(h => h.id === i.hostId)) } : monitoring.data}
          error={monitoring.error}
        />
      ),
    },
    {
      id: "summary",
      title: "Fleet summary",
      width: "full",
      node: fleetSummary,
    },
    ...hosts.map((host) => ({
      id: `host-${host.id}`,
      title: host.name,
      width: "half" as const,
      expanded: expanded === host.id,
      node: (
        <HostCard
          host={host}
          history={histories[host.id]}
          range={range}
          expanded={expanded === host.id}
          onExpand={() => {
            const next = expanded === host.id ? null : host.id;
            setExpanded(next);
          }}
          onInvestigate={setTarget}
        />
      ),
    })),
  ];
  return (
    <div className={`app-shell ${display.compact ? "compact" : ""}`}>
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
          {pages.map((value) => {
            const Icon = {
              overview: LayoutDashboard,
              servers: Server,
              services: Activity,
              logs: ScrollText,
              issues: Bell,
              settings: SettingsIcon,
            }[value];
            const label = value[0].toUpperCase() + value.slice(1);
            return (
              <a
                href={`#${value}`}
                key={value}
                aria-label={label}
                aria-current={page === value ? "page" : undefined}
                title={label}
                className={page === value ? "selected" : ""}
                onClick={navigate}
              >
                <Icon size={18} />
                <span className="nav-label">{label}</span>
                {value === "issues" && issueCount > 0 && (
                  <span
                    className="nav-count alert-count"
                    aria-label={`${issueCount} active issues`}
                  >
                    {issueCount}
                  </span>
                )}
              </a>
            );
          })}
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
            {page[0].toUpperCase() + page.slice(1)}
          </span>
          <div>
            <span
              className={`connection-dot ${error || outdated ? "disconnected" : ""}`}
            />
            <span>
              {!fleet
                ? "Connecting"
                : error || outdated
                  ? "Updates interrupted"
                  : "Live connection"}
            </span>
          </div>
        </header>
        <main>
          <section className="page-heading">
            <div>
              <h1>
                {page === "overview"
                  ? "Fleet overview"
                  : page[0].toUpperCase() + page.slice(1)}
              </h1>
            </div>
            <button
              className="refresh-button"
              onClick={() => setRefresh((v) => v + 1)}
              disabled={fetching}
              aria-busy={fetching}
              title="Refresh all metrics"
              aria-label="Refresh"
            >
              <RefreshCw size={15} className={fetching ? "spinning" : ""} />
              <span>Refresh</span>
            </button>
          </section>
          {(error || outdated) && (
            <div className="notice danger" role="alert">
              {error ? `Cannot refresh dashboard: ${error}.` : ""}{" "}
              {fleet
                ? "Previously received data is marked stale when refresh coverage expires."
                : "Waiting for a connection to the Hostboard backend."}
            </div>
          )}
          {(page === "overview" || page === "servers") && fleet && <div className="server-filter settings-actions">
            <label>Server group <select aria-label="Filter by server group" value={effectiveGroup} onChange={e => { setGroupFilter(e.target.value); savePreference('server-group', e.target.value); }}><option value="">Entire fleet</option><option value="ungrouped">Ungrouped</option>{fleet.groups?.map(g => <option value={g.id} key={g.id}>{g.name}</option>)}</select></label>
            <span className="muted small">{effectiveGroup ? `${groupLabel}: ${scopedHosts.length} of ${allHosts.filter(h => !h.archived).length} servers. Summaries cover this group only.` : 'Entire fleet · archived servers excluded from summaries.'}</span>
            {effectiveGroup && <button onClick={() => { setGroupFilter(''); savePreference('server-group', ''); }}>Show entire fleet</button>}
          </div>}
          {page === "overview" && (
            <>
              <div className="overview-range">
                <span className="muted small">Chart time range</span>
                <RangeSelector value={range} short onChange={r => {if(r !== 'custom'){setRange(r);savePreference('range',r);}}}/>

              </div>
              {fleet ? (
                <Dashboard
                  widgets={overviewWidgets}
                  hosts={scopedHosts}
                  visibleHostIds={scopedHosts.map(h => h.id)}
                  range={range}
                />
              ) : (
                <p role="status">Loading dashboard widgets…</p>
              )}
            </>
          )}
          {page === "servers" && fleetSummary}
          {page === "servers" && (
            <>
              <section className="section-heading">
                <div>
                  <h2>
                    Servers <span>{scopedHosts.length || "—"}</span>
                  </h2>
                  <p>
                    Current metrics · {rangeLabels[range]} history · CPU
                    sparkline shows peaks
                  </p>
                </div>
                <RangeSelector value={range} short onChange={r => {if(r !== 'custom'){setRange(r);savePreference('range',r);}}}/>

              </section>
              {page === "servers" && (
                <input
                  className="search"
                  aria-label="Filter servers"
                  placeholder="Find a server…"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                />
              )}
              <div className="settings-actions"><label className="check-label"><input type="checkbox" checked={showArchived} onChange={e => setShowArchived(e.target.checked)}/>Show archived servers</label><a className="action-link" href="#settings?tab=servers">Manage servers</a></div>
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
                        onExpand={() => {
                          const next = expanded === host.id ? null : host.id;
                          setExpanded(next);
                          if (next)
                            history.replaceState(null, "", `#host=${host.id}`);
                          else
                            history.replaceState(null, "", location.pathname);
                        }}
                        onInvestigate={setTarget}
                      />
                    ))
                  : [0, 1].map((i) => (
                      <div
                        key={i}
                        className="skeleton"
                        aria-label="Loading host metrics"
                      >
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
          {page === "services" && (
            <>
              <ServiceChecks data={monitoring.data} error={monitoring.error} />
              <Services
                hosts={hosts}
                checks={monitoring.data?.checks}
                onInvestigate={setTarget}
              />
            </>
          )}
          {page === "logs" && <LogsPage hosts={hosts}/>}
          {page === "issues" && (
            <Issues
              hosts={hosts}
              data={monitoring.data}
              error={monitoring.error}
              onInvestigate={setTarget}
            />
          )}
          {page === "settings" && (
            <Settings
              data={monitoring.data}
              error={monitoring.error}
              hosts={hosts}
            />
          )}
          <footer>
            <span>
              <span className="footer-dot" />
              Metrics: Netdata
            </span>
            <span>
              {age === null
                ? "Connecting…"
                : `Updated ${age < 2 ? "just now" : `${age}s ago`}`}
              <i />
              Refreshes every {display.refreshSeconds}s
            </span>
          </footer>
        </main>
      </div>
      {target && (
        <InvestigationDialog target={target} onClose={() => setTarget(null)} />
      )}
      {help && (
        <dialog
          ref={helpDialog}
          className="modal about-dialog"
          onCancel={() => setHelp(false)}
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
            Live metrics refresh every {display.refreshSeconds} seconds.
            Historical charts refresh every 30 seconds.
          </p>
          <p>
            Overview sparklines show averages. Open a host or alert to
            investigate minimum, peak and average values with custom windows,
            zoom, pan and pause. Gaps indicate missing data.
          </p>
          <p>
            Offline and stale hosts are excluded from fleet totals. Container
            CPU usage is measured per core: 100% equals one core.
          </p>
          <button className="primary-button" onClick={() => setHelp(false)}>
            Close
          </button>
        </dialog>
      )}
    </div>
  );
}
createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <DisplayProvider>
      <App />
    </DisplayProvider>
  </React.StrictMode>,
);
