import { AgentTrust, agentSlot, chartSlot, loadAgentTrust } from './agent-policy.js';
import { request as pinnedRequest } from './probe.js';
import { z } from 'zod';
import type { DiscoveredNode, ServerDiscovery } from '../src/server-types.js';
import { DIAGNOSTICS, sensorGroup, metricName, activeAlert, resolvedAlert } from './investigation.js';
import type { Metric, Diagnostic, AlertHistory, MetricHistory, Window } from '../src/investigation-types.js';
import type { HostConfig } from './config.js';
import type { Host, History, Range, Point, Container } from '../src/types.js';
// These contexts and units were verified against live Agent responses. v1 is used
// only for chart labels: v3 contexts currently omits per-instance mount/container labels.
export const CONTEXTS = [
  'system.cpu',
  'system.load',
  'system.ram',
  'system.uptime',
  'system.net',
  'system.io',
  'disk.space',
  'docker.container_state',
  'docker.container_health_status',
  'cgroup.cpu',
  'cgroup.mem_usage',
  'cgroup.io',
  'cgroup.net_net',
  'system.hw.sensor.temperature.input',
] as const;
export const RANGES: Record<Range, number> = { '15m': 900, '1h': 3600, '6h': 21600, '24h': 86400 };
type Chart = {
  id: string;
  context: string;
  family: string;
  units: string;
  chart_labels: Record<string, string>;
  dimensions?: Record<string, unknown>;
};
export type NodeInfo = {
  mg: string;
  nd: string;
  nm: string;
  state: string;
  v: string;
  hw?: { cpus?: string; memory?: string };
  labels?: Record<string, string>;
  os?: { nm?: string; v?: string; kernel?: { nm?: string; v?: string } };
  health?: { status?: string };
};
type Meta = {
  node: NodeInfo;
  charts: Record<string, Chart>;
  contexts: Record<string, unknown>;
  time: number;
  warnings?: string[];
};
export type Table = {
  result: { labels: string[]; data: (number | null)[][] };
  view?: { dimensions?: { ids: string[] }; update_every?: number };
  db?: { first_entry?: number; last_entry: number };
  summary?: { nodes?: { mg: string }[] };
};
type Sample = { time: number; values: Record<string, number | null> };
export function finite(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}
export function sum(values: (number | null)[]): number | null {
  return values.length && values.every((v) => v !== null)
    ? values.reduce<number>((a, v) => a + v!, 0)
    : null;
}
export function ratio(used: number | null, total: number | null) {
  return used !== null && total !== null && total > 0 ? (used / total) * 100 : null;
}
export function parseTable(table: Table): Map<string, Sample[]> {
  if (!table.result || !Array.isArray(table.result.data))
    throw new Error('Invalid Netdata data response');
  const ids = table.view?.dimensions?.ids || table.result.labels.slice(1);
  const map = new Map<string, Sample[]>();
  ids.forEach((id, index) => {
    const comma = id.indexOf(',');
    const at = id.lastIndexOf('@');
    const dimension = comma < 0 ? id : id.slice(0, comma),
      instance = comma < 0 ? '' : id.slice(comma + 1, at > comma ? at : undefined);
    if (!map.has(instance))
      map.set(
        instance,
        table.result.data.map((row) => ({ time: row[0] as number, values: {} })),
      );
    map
      .get(instance)!
      .forEach((sample, i) => (sample.values[dimension] = finite(table.result.data[i][index + 1])));
  });
  for (const samples of map.values()) samples.sort((a, b) => a.time - b.time);
  return map;
}
export function latest(
  samples: Sample[] | undefined,
  now: number,
  maxAge = 60,
): Sample | undefined {
  return samples
    ?.filter(
      (s) =>
        s.time <= now + 5 &&
        now - s.time <= maxAge &&
        Object.values(s.values).some((v) => v !== null),
    )
    .at(-1);
}
function cpu(values: Record<string, number | null>) {
  return sum(
    Object.entries(values)
      .filter(([k]) => k !== 'idle')
      .map(([, v]) => v),
  );
}
function memory(values: Record<string, number | null>) {
  const total = sum(Object.values(values));
  return { used: values.used ?? null, total, percent: ratio(values.used ?? null, total) };
}
export function empty(config: HostConfig, error: string, lastSeen: string | null = null): Host {
  return {
    id: config.id,
    name: config.name,
    hostname: config.node,
    status: 'offline',
    lastSeen,
    checkedAt: new Date().toISOString(),
    error,
    os: null,
    version: null,
    cores: null,
    uptime: null,
    cpu: null,
    load: null,
    memory: { used: null, total: null, percent: null },
    network: { received: null, sent: null },
    io: { read: null, write: null },
    disks: [],
    containers: [],
    dockerAvailable: false,
    sensors: [],
    alerts: null,
    warnings: [],
  };
}
export class Agent {
  private metadata?: Meta;
  private metadataRefreshAt = 0;
  private stopped = new AbortController();
  private successfulRequests = 0;
  private lastRequestError: unknown;
  lastCommunication: string | null = null;
  stop() { this.stopped.abort(); }

  private snapshot?: { host: Host; time: number };
  private pending?: Promise<Host>;
  private histories = new Map<Range, { value: History; time: number }>();
  private historyPending = new Map<Range, Promise<History>>();
  constructor(public config: HostConfig, private trust: AgentTrust | Promise<AgentTrust> = loadAgentTrust([config]), private onDiscovery?: (value: ServerDiscovery) => void) {}
  invalidate() { this.metadata = undefined; this.snapshot = undefined; this.histories.clear(); this.detailsCache.clear(); }
  async nodes(): Promise<DiscoveredNode[]> {
    return (await this.nodeList()).map(n => ({ guid: n.mg, nodeId: n.nd || null, hostname: n.nm, state: n.state }));
  }
  private async nodeList(): Promise<NodeInfo[]> {
    const response = await this.request('/api/v3/nodes');
    const Node = z.object({ mg: z.string().regex(/^[a-zA-Z0-9_.:-]{1,128}$/), nd: z.string().max(128).nullish().transform(v => v || ''), nm: z.string().min(1).max(253), state: z.string().max(80).optional().default('unknown'), v: z.string().max(160).nullish().transform(v => v || ''),
      health: z.object({ status: z.string().max(80).optional() }).optional(),
      labels: z.record(z.string(), z.string().max(1024)).optional(),
      hw: z.object({ cpus: z.string().max(40).optional(), memory: z.string().max(40).optional() }).optional(),
      os: z.object({ nm: z.string().max(160).optional(), v: z.string().max(160).optional(), kernel: z.object({ nm: z.string().max(160).optional(), v: z.string().max(160).optional() }).optional() }).optional(),
    });
    return z.object({ nodes: z.array(Node).min(1).max(1000) }).parse(response).nodes;
  }
  async discover(force = false): Promise<ServerDiscovery> {
    if (force) this.invalidate();
    return discovery(await this.meta());
  }
  private detailsCache = new Map<string, { value: unknown; time: number }>();
  private detailsPending = new Map<string, Promise<any>>();
  private async cached<T>(key: string, task: () => Promise<T>): Promise<T> {
    const cache = this.detailsCache.get(key);
    if (cache && Date.now() - cache.time < 25000) return cache.value as T;
    if (this.detailsPending.has(key)) return this.detailsPending.get(key)!;
    const pending = task().then(value => {
      // Bound memory even when users explore many custom windows.
      for (const [key, value] of this.detailsCache) if (Date.now() - value.time > 30000) this.detailsCache.delete(key);
      if (this.detailsCache.size >= 16) this.detailsCache.delete(this.detailsCache.keys().next().value!);
      this.detailsCache.set(key, { value, time: Date.now() });
      return value;
    }).finally(() => this.detailsPending.delete(key));
    this.detailsPending.set(key, pending);
    return pending;
  }
  private activeRequests = 0;
  private requestQueue: (() => void)[] = [];
  private async request(path: string, params: Record<string, string> = {}) {
    if (this.activeRequests >= 3) {
      if (this.requestQueue.length >= 64) throw Error('Agent request capacity reached');
      await new Promise<void>(resolve => this.requestQueue.push(resolve));
    } else this.activeRequests++;
    const run = () => agentSlot(async () => {
      this.stopped.signal.throwIfAborted();
      const url = new URL(path, this.config.url);
      Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));
      const { address, token } = await (await this.trust).destination(this.config.url);
      const response = await pinnedRequest(url, token ? { Authorization: `Bearer ${token}` } : {}, AbortSignal.any([AbortSignal.timeout(6000), this.stopped.signal]), address, (path.endsWith('/charts') ? 16 : 4) * 1024 * 1024);
      if (!response.ok) throw new Error(`Agent returned HTTP ${response.status}`);
      const value = await response.json();
      this.successfulRequests++;
      this.lastCommunication = new Date().toISOString();
      return value;
    });
    try { return await (path.endsWith('/charts') ? chartSlot(run) : run()); } catch (e) { this.lastRequestError = e; throw e; } finally { const next = this.requestQueue.shift(); if (next) next(); else this.activeRequests--; }
  }
  private metaPending?: Promise<Meta>;
  private async meta(node?: NodeInfo): Promise<Meta> {
    // Node liveness is checked on every poll. A reconnect can also replace the
    // chart instances even when the physical machine GUID stays unchanged.
    if (node && this.metadata && node.state !== this.metadata.node.state)
      this.metadataRefreshAt = 0;
    if (this.metadata && Date.now() < this.metadataRefreshAt)
      return node ? { ...this.metadata, node } : this.metadata;
    if (this.metaPending) return this.metaPending;
    this.metaPending = this.fetchMeta(node).finally(() => { this.metaPending = undefined; });
    return this.metaPending;
  }
  private async selectedNode(): Promise<NodeInfo> {
    const nodes = await this.nodeList();
    const matches = nodes.filter(n => [n.mg, n.nd, n.nm].includes(this.config.node));
    if (matches.length > 1)
      throw new Error('Node selector is ambiguous; configure a machine GUID instead');
    const node = matches[0];
    if (!node) throw new Error('Configured node was not found on this Agent');
    return node;
  }
  private async fetchMeta(selected?: NodeInfo): Promise<Meta> {
    const node = selected || await this.selectedNode();
    const [chartResult, contextResult] = await Promise.allSettled([
      this.request(`/host/${encodeURIComponent(node.mg)}/api/v1/charts`),
      this.request('/api/v3/contexts', { nodes: node.mg }),
    ]);
    const warnings: string[] = [];
    const charts = chartResult.status === 'fulfilled' ? chartResult.value : (warnings.push('Chart instance metadata unavailable'), { charts: {}, hostname: node.nm });
    const contexts = contextResult.status === 'fulfilled' ? contextResult.value : (warnings.push('Metric contexts unavailable; using chart contexts'), { contexts: Object.fromEntries(Object.values(charts.charts || {}).map((c: any) => [c.context, {}])) });
    if (!charts.charts || typeof charts.charts !== 'object' || Array.isArray(charts.charts) || Object.keys(charts.charts).length > 20000 || !contexts.contexts || typeof contexts.contexts !== 'object' || Array.isArray(contexts.contexts) || Object.keys(contexts.contexts).length > 10000) throw Error('Invalid Netdata metadata response');
    if (chartResult.status === 'rejected' && contextResult.status === 'rejected') throw chartResult.reason;
    for (const [id, chart] of Object.entries(charts.charts) as [string, any][]) {
      if (!chart || typeof chart.context !== 'string' || typeof chart.id !== 'string' || chart.id !== id || typeof chart.family !== 'string' || typeof chart.units !== 'string' || (chart.chart_labels && (typeof chart.chart_labels !== 'object' || Object.values(chart.chart_labels).some(v => typeof v !== 'string')))) throw Error('Invalid Netdata chart response');
    }
    if (charts.hostname !== node.nm)
      throw new Error('Agent returned metadata for an unexpected host');
    const metadata: Meta = {
      node,
      charts: Object.fromEntries(Object.entries(charts.charts).map(([id, c]: [string, any]) => [id, { id: c.id, context: c.context, family: c.family, units: c.units, chart_labels: c.chart_labels || {}, plugin: c.plugin, module: c.module, dimensions: c.dimensions }])),
      contexts: Object.fromEntries(Object.keys(contexts.contexts).map(c => [c, true])),
      time: Date.now(),
      warnings,
    };
    this.onDiscovery?.(discovery(metadata));
    this.metadata = metadata;
    // Failed/partial startup catalogs are provisional, never cached for five minutes.
    this.metadataRefreshAt = Date.now() + (warnings.length || node.state !== 'reachable' ? 30_000 : 300_000);
    return metadata;
  }
  private async data(meta: Meta, context: string, seconds: number, points: number, extra: Record<string, string> = {}): Promise<Table> {
    const data = await this.request('/api/v3/data', {
      nodes: meta.node.mg,
      contexts: context,
      after: String(-seconds),
      points: String(points),
      format: 'json',
      group_by: 'instance,dimension',
      options: 'jsonwrap',
      timeout: '5000',
      ...extra,
    });
    if (data.summary?.nodes?.length !== 1 || data.summary.nodes[0].mg !== meta.node.mg)
      throw new Error('Agent data did not match the configured node');
    return data;
  }
  async current(): Promise<Host> {
    if (this.snapshot && Date.now() - this.snapshot.time < 8000) return this.snapshot.host;
    if (this.pending) return this.pending;
    this.pending = this.collect()
      .catch((error) => {
        this.metadataRefreshAt = 0;
        return empty(this.config, agentDiagnostic(error).message, this.snapshot?.host.lastSeen);
      })
      .then((host) => {
        this.snapshot = { host, time: Date.now() };
        return host;
      })
      .finally(() => {
        this.pending = undefined;
      });
    return this.pending;
  }
  private async collect(): Promise<Host> {
    const successfulBefore = this.successfulRequests;
    const node = await this.selectedNode();
    const meta = await this.meta(node),
      now = Date.now() / 1000;
    const host = empty(this.config, '');
    host.error = null;
    host.discovery = discovery(meta);
    host.warnings.push(...(meta.warnings || []));
    host.hostname = meta.node.nm;
    host.version = meta.node.v;
    host.os = meta.node.os ? `${meta.node.os.nm} ${meta.node.os.v}` : null;
    host.cores = Number(meta.node.hw?.cpus) || null;
    // The parent API remains reachable after a streaming child disconnects.
    // Netdata's nodes endpoint calls that child "stale"; it is offline from
    // Hostboard's perspective, even while recent samples remain in the parent.
    if (['stale', 'unreachable', 'offline', 'pruned', 'created'].includes(node.state)) {
      host.status = 'offline';
      host.error = 'Host is offline: Netdata reports no active Agent or streaming connection.';
      host.lastSeen = this.snapshot?.host.lastSeen || null;
      this.metadataRefreshAt = Math.min(this.metadataRefreshAt, Date.now() + 30_000);
      return host;
    }
    const tables = new Map<string, Map<string, Sample[]>>();
    await Promise.all(
      CONTEXTS.map(async (context) => {
        if (!meta.contexts[context]) return;
        try {
          tables.set(context, parseTable(await this.data(meta, context, 45, 15)));
        } catch {
          host.warnings.push(`${context}: metrics unavailable`);
        }
      }),
    );
    const values = (context: string, id?: string) => {
      const instances = tables.get(context);
      return latest(id ? instances?.get(id) : instances?.values().next().value, now)?.values || {};
    };
    const cpuSample = latest(tables.get('system.cpu')?.values().next().value, now);
    host.status = cpuSample ? (node.state === 'reachable' ? 'online' : 'stale') : 'stale';
    host.lastSeen = cpuSample
      ? new Date(cpuSample.time * 1000).toISOString()
      : this.snapshot?.host.lastSeen || null;
    if (host.status === 'stale')
      host.error = node.state === 'reachable'
        ? 'Agent is reachable but fresh CPU samples are unavailable. Check metric collection.'
        : 'Netdata node reachability is unknown. Check the Agent or streaming connection.';
    host.cpu = cpuSample ? cpu(cpuSample.values) : null;
    host.uptime = values('system.uptime').uptime ?? null;
    const load = values('system.load');
    host.load = [load.load1, load.load5, load.load15].every((v) => v != null)
      ? [load.load1!, load.load5!, load.load15!]
      : null;
    host.memory = memory(values('system.ram'));
    const net = values('system.net'),
      io = values('system.io');
    host.network = {
      received: net.received ?? null,
      sent: net.sent == null ? null : Math.abs(net.sent),
    };
    host.io = { read: io.reads ?? null, write: io.writes == null ? null : Math.abs(io.writes) };
    for (const chart of Object.values(meta.charts)) {
      const v = values(chart.context, chart.id),
        labels = chart.chart_labels || {};
      if (
        chart.context === 'disk.space' &&
        !['tmpfs', 'devtmpfs', 'overlay', 'squashfs'].includes(labels.filesystem)
      ) {
        const total = sum([v.used ?? null, v.avail ?? null, v['reserved for root'] ?? null]);
        host.disks.push({
          id: chart.id,
          mount: labels.mount_point || chart.family,
          filesystem: labels.filesystem || '',
          used: v.used ?? null,
          total,
          available: v.avail ?? null,
          percent: ratio(v.used ?? null, total),
        });
      }
      if (chart.context === 'system.hw.sensor.temperature.input')
        host.sensors.push({
          id: chart.id,
          group: sensorGroup(labels),
          name: `${labels.chip_id || chart.family} · ${labels.label && labels.label !== '[none]' ? labels.label : labels.feature || 'temperature'}`,
          value: v.input ?? null,
        });
    }
    host.disks.sort((a, b) => a.mount.localeCompare(b.mount));
    host.sensors.sort((a, b) => (b.value ?? -Infinity) - (a.value ?? -Infinity));
    const docker = tables.get('docker.container_state');
    const freshDocker = [...(docker?.entries() || [])].filter(([, samples]) => latest(samples, now));
    // Fresh dimensions without matching chart labels cannot establish a count.
    // This occurs while collectors start or recreate instances after a reboot.
    host.dockerAvailable = freshDocker.length > 0 && freshDocker.every(([id]) =>
      meta.charts[id]?.context === 'docker.container_state' && !!meta.charts[id].chart_labels.container_name &&
      Object.values(latest(docker?.get(id), now)!.values).some(value => value !== null && value > 0.5),
    );
    if (freshDocker.length && !host.dockerAvailable)
      host.warnings.push('Docker instance metadata incomplete; container count unavailable');
    const containers = new Map<string, Container>();
    for (const chart of Object.values(meta.charts).filter(
      (c) => c.context === 'docker.container_state',
    )) {
      const labels = chart.chart_labels || {},
        name = labels.container_name;
      if (!name) continue;
      if (containers.has(name) && !latest(docker?.get(chart.id), now)) continue;
      const v = values(chart.context, chart.id),
        state =
          Object.entries(v)
            .sort((a, b) => (b[1] ?? -1) - (a[1] ?? -1))
            .find(([, v]) => v !== null && v > 0.5)?.[0] || 'unknown';
      containers.set(name, {
        name,
        image: labels.image || '',
        state,
        health: null,
        cpu: null,
        memory: null,
        network: { received: null, sent: null },
        io: { read: null, write: null },
      });
    }
    for (const chart of Object.values(meta.charts)) {
      const labels = chart.chart_labels || {},
        container = containers.get(labels.container_name || labels.cgroup_name);
      if (!container) continue;
      const v = values(chart.context, chart.id);
      if (chart.context === 'cgroup.cpu') container.cpu = cpu(v);
      if (chart.context === 'cgroup.mem_usage') container.memory = v.ram ?? null;
      if (chart.context === 'cgroup.io') container.io = { read: v.read ?? null, write: v.write == null ? null : Math.abs(v.write) };
      if (chart.context === 'cgroup.net_net') {
        for (const [key, dimension] of [['received', 'received'], ['sent', 'sent']] as const) {
          const n = v[dimension];
          if (n != null) container.network[key] = (container.network[key] ?? 0) + Math.abs(n);
        }
      }
      if (chart.context === 'docker.container_health_status')
        container.health = Object.entries(v).find(([, v]) => v !== null && v > 0.5)?.[0] || null;
    }
    host.containers = [...containers.values()].sort((a, b) => a.name.localeCompare(b.name));
    try {
      const alerts = await this.request('/api/v3/alerts', {
        nodes: meta.node.mg,
        options: 'summary',
      });
      host.alerts = (alerts.alerts || [])
        .filter((a: { cr: number; wr: number }) => a.cr > 0 || a.wr > 0)
        .map((a: { nm: string; sum: string; cr: number; wr: number }) => ({
          name: a.nm,
          summary: a.sum,
          severity: a.cr > 0 ? 'critical' : 'warning',
          count: a.cr + a.wr,
        }));
    } catch {
      host.warnings.push('Netdata alerts unavailable');
    }
    if (host.status !== 'online' || host.warnings.length || !host.dockerAvailable)
      this.metadataRefreshAt = Math.min(this.metadataRefreshAt, Date.now() + 30_000);
    if (this.successfulRequests === successfulBefore) throw this.lastRequestError || Error('Agent connection failed');
    return host;
  }
  async history(range: Range): Promise<History> {
    const cached = this.histories.get(range);
    if (cached && Date.now() - cached.time < 25_000) return cached.value;
    const pending = this.historyPending.get(range);
    if (pending) return pending;
    const task = this.collectHistory(range)
      .then((value) => {
        this.histories.set(range, { value, time: Date.now() });
        return value;
      })
      .finally(() => this.historyPending.delete(range));
    this.historyPending.set(range, task);
    return task;
  }
  private async collectHistory(range: Range): Promise<History> {
    const meta = await this.meta(),
      points = new Map<number, Point>(),
      errors: string[] = [];
    await Promise.all(
      ['system.cpu', 'system.ram', 'system.net', 'system.io', 'system.load'].map(
        async (context) => {
          if (!meta.contexts[context]) {
            errors.push(`${context}: unavailable`);
            return;
          }
          try {
            const table = await this.data(meta, context, RANGES[range], 180),
              samples = parseTable(table).values().next().value || [];
            for (const s of samples) {
              if (!points.has(s.time))
                points.set(s.time, {
                  time: s.time,
                  cpu: null,
                  memory: null,
                  received: null,
                  sent: null,
                  read: null,
                  write: null,
                  load: null,
                });
              const p = points.get(s.time)!,
                v = s.values;
              if (context === 'system.cpu') p.cpu = cpu(v);
              if (context === 'system.ram') p.memory = memory(v).percent;
              if (context === 'system.net') {
                p.received = v.received ?? null;
                p.sent = v.sent == null ? null : Math.abs(v.sent);
              }
              if (context === 'system.io') {
                p.read = v.reads ?? null;
                p.write = v.writes == null ? null : Math.abs(v.writes);
              }
              if (context === 'system.load') p.load = v.load1 ?? null;
            }
          } catch {
            errors.push(`${context}: history unavailable`);
          }
        },
      ),
    );
    let cpuPeaks: { time: number; value: number | null }[] = [];
    if (meta.contexts['system.cpu']) {
      try {
        const table = await this.data(meta, 'system.cpu', RANGES[range], 180, { dimensions: 'idle', time_group: 'min' });
        cpuPeaks = [...parseTable(table).values()].flat().map(s => ({ time: s.time, value: s.values.idle == null ? null : 100 - s.values.idle }));
      } catch { errors.push('CPU peak history unavailable'); }
    }
    return {
      cpuPeaks,
      hostId: this.config.id,
      range,
      points: [...points.values()].sort((a, b) => a.time - b.time),
      fetchedAt: new Date().toISOString(),
      errors,
    };
  }
  async catalog(): Promise<Metric[]> {
    const meta = await this.meta();
    return Object.values(meta.charts).map(c => ({
      id: c.id, context: c.context, name: metricName(c), units: c.units,
      group: c.context === 'system.hw.sensor.temperature.input' ? sensorGroup(c.chart_labels || {}) : DIAGNOSTICS[c.context]?.[0] || (c.context.startsWith('cgroup.') ? 'Containers' : 'Other'),
      description: DIAGNOSTICS[c.context]?.[1] || (c.context.startsWith('cgroup.') ? 'Container resources reported by Netdata. CPU: 100% equals one core.' : c.context),
    }));
  }
  async diagnostics(): Promise<Diagnostic[]> {
    return this.cached('diagnostics', async () => {
      const meta = await this.meta(), catalog = await this.catalog();
      const metrics: Diagnostic[] = catalog.filter(c => DIAGNOSTICS[c.context]).map(c => ({ ...c, values: {} }));
      await Promise.all(Object.keys(DIAGNOSTICS).map(async context => {
        if (!meta.contexts[context]) return;
        try {
          const samples = parseTable(await this.data(meta, context, 30, 3));
          for (const m of metrics.filter(m => m.context === context)) m.values = latest(samples.get(m.id), Date.now() / 1000)?.values || {};
        } catch { /* Empty readings explicitly indicate unavailable data. */ }
      }));
      return metrics;
    });
  }
  async alertDetails(): Promise<AlertHistory> {
    return this.cached('alerts', async () => {
      const meta = await this.meta(), errors: string[] = [];
      const charts = Object.fromEntries((await this.catalog()).map(c => [c.id, c]));
      const [current, history] = await Promise.allSettled([
        this.request('/api/v3/alerts', { nodes: meta.node.mg, options: 'instances,values' }),
        this.request('/api/v3/alert_transitions', { nodes: meta.node.mg, after: '-604800', last: '200' }),
      ]);
      let active: import('../src/investigation-types.js').AlertDetail[] = [], resolved: typeof active = [];
      if (current.status === 'fulfilled') {
        const data = current.value;
        const ni = data.nodes?.find((n: any) => n.mg === meta.node.mg)?.ni;
        if (ni === undefined) errors.push('Alert node identity unavailable');
        else active = (data.alert_instances || []).filter((a: any) => a.ni === ni && ['WARNING', 'CRITICAL'].includes(a.st)).map((a: any) => activeAlert(a, charts));
      } else errors.push('Current alert details unavailable');
      if (history.status === 'fulfilled') resolved = (history.value.transitions || [])
        .filter((t: any) => t.machine_guid === meta.node.mg)
        .map((t: any) => resolvedAlert(t, charts)).filter(Boolean).slice(0, 50);
      else errors.push('Alert transition history unavailable');
      // Active start is the last state-change timestamp unless retained transitions
      // establish an uninterrupted WARNING/CRITICAL incident across severity changes.
      if (history.status === 'fulfilled') for (const a of active) {
        const transitions = (history.value.transitions || []).filter((t: any) => t.machine_guid === meta.node.mg && t.instance === a.chart && t.alert === a.name).sort((a: any,b: any) => b.when-a.when);
        for (const t of transitions) {
          if (!['WARNING','CRITICAL'].includes(t.new?.status)) break;
          a.startedAt = t.when;
          if (!['WARNING','CRITICAL'].includes(t.old?.status)) break;
        }
      }
      const configs = [...new Set([...active, ...resolved].map(a => a.config).filter(Boolean))].slice(0, 20);
      await Promise.all(configs.map(async config => {
        try {
          const c: any = await this.cached('config:' + config, () => this.request('/api/v3/alert_config', { config: config! }));
          for (const a of [...active, ...resolved].filter(a => a.config === config)) {
            a.warning = c.status?.warn || null; a.critical = c.status?.crit || null;
          }
        } catch { errors.push('Some alert threshold expressions unavailable'); }
      }));
      return { active, resolved, errors: [...new Set(errors)], fetchedAt: new Date().toISOString() };
    });
  }
  async metricHistory(id: string, window: Window): Promise<MetricHistory> {
    return this.cached(`metric:${id}:${window.after}:${window.before}`, async () => {
      const metric = (await this.catalog()).find(c => c.id === id);
      if (!metric) throw new Error('Unknown metric');
      const meta = await this.meta(), points = new Map<number, { time: number; [key: string]: number | null }>();
      const errors: string[] = [], dimensions = new Set<string>();
      let first: number | null = null, last: number | null = null, interval: number | null = null;
      await Promise.all(['average', 'min', 'max'].map(async aggregation => {
        try {
          const table = await this.data(meta, metric.context, 0, 240, {
            after: String(window.after), before: String(window.before), instances: id,
            time_group: aggregation,
            ...(metric.context === 'system.cpu' ? { dimensions: 'idle' } : {}),
          });
          first = finite(table.db?.first_entry); last = finite(table.db?.last_entry); interval = finite(table.view?.update_every);
          const samples = parseTable(table).get(id) || [];
          for (const sample of samples) {
            if (!points.has(sample.time)) points.set(sample.time, { time: sample.time });
            const p = points.get(sample.time)!;
            for (const [dimension, value] of Object.entries(sample.values)) {
              const busy = metric.context === 'system.cpu' && dimension === 'idle';
              const name = busy ? 'busy' : dimension;
              dimensions.add(name);
              const agg = busy && aggregation !== 'average' ? (aggregation === 'min' ? 'max' : 'min') : aggregation;
              p[`${name}:${agg}`] = value === null ? null : busy ? 100 - value : ['system.net','system.io','disk.io','cgroup.io','cgroup.net_net','mem.swapio'].includes(metric.context) ? Math.abs(value) : value;
            }
          }
        } catch { errors.push(`${aggregation} history unavailable`); }
      }));
      const ds = [...dimensions];
      for (const p of points.values()) for (const d of ds) for (const a of ['average','min','max']) p[`${d}:${a}`] ??= null;
      // Signed outbound series have negative minima; order their magnitudes.
      for (const p of points.values()) for (const d of ds) {
        const lo = p[`${d}:min`], hi = p[`${d}:max`];
        if (lo !== null && hi !== null && lo > hi) [p[`${d}:min`], p[`${d}:max`]] = [hi, lo];
      }
      return { metric, window, dimensions: ds, points: [...points.values()].sort((a,b) => a.time-b.time), retention: { first, last, interval }, errors, fetchedAt: new Date().toISOString() };
    });
  }

}

export function agentDiagnostic(error: unknown): { code: string; message: string } {
  const e = error as { message?: string; name?: string; code?: string; cause?: { code?: string } };
  const message = e?.message || '', code = e?.cause?.code || e?.code || '';
  if (/Destination/.test(message)) return { code: 'policy', message: 'Destination blocked by Hostboard policy. Ask the deployment operator to approve this Agent origin and its IP addresses in private/agents.json, then restart Hostboard.' };
  if (/authentication is not configured/.test(message)) return { code: 'authentication', message: 'Agent authentication is not configured. Ask the deployment operator to check the private token configuration.' };
  if (/HTTP (401|403)/.test(message)) return { code: 'authentication', message: 'Agent denied access. Check Agent authorization and deployment-managed credentials.' };
  if (/HTTP 3\d\d/.test(message)) return { code: 'redirect', message: 'Agent redirected the request. Enter the final approved HTTP(S) origin; redirects are not followed.' };
  if (/CERT|TLS|SSL|SELF_SIGNED|UNABLE_TO_VERIFY/.test(code)) return { code: 'tls', message: 'TLS certificate verification failed. Check the Agent certificate and trusted certificate chain.' };
  if (/ENOTFOUND|EAI_AGAIN/.test(code)) return { code: 'dns', message: 'DNS resolution failed. Check the Agent hostname and DNS configuration.' };
  if (/Timeout|Abort/.test(e?.name || '') || /timed out/.test(message) || code === 'ETIMEDOUT') return { code: 'timeout', message: 'Agent connection timed out. Check connectivity, Docker networking and firewall rules.' };
  if (code === 'ECONNREFUSED') return { code: 'refused', message: 'Connection refused. Check the Agent address, port and listening interface.' };
  if (/node|host|identity|already registered/i.test(message) && /Configured|ambiguous|unexpected|identity|already registered/.test(message)) return { code: 'identity', message: 'Incorrect, ambiguous or duplicate node identity. Select the original machine GUID or restore its existing registration.' };
  if (error instanceof z.ZodError || error instanceof SyntaxError || /Invalid Netdata|HTTP|Response too large/.test(message)) return { code: 'response', message: 'Incompatible or unexpected Agent API response. Hostboard requires Netdata v3 nodes, contexts and data APIs; check the URL and Agent version.' };
  return { code: 'connection', message: 'Agent connection failed. Check the address, routing and firewall rules.' };
}
function discovery(meta: Meta): ServerDiscovery {
  const n = meta.node, labels = n.labels || {}, charts = Object.values(meta.charts);
  const text = (value: unknown) => typeof value === 'string' && value.length ? value.slice(0, 512) : null;
  const positive = (value: unknown) => Number.isFinite(Number(value)) && Number(value) > 0 ? Number(value) : null;
  const contexts = Object.keys(meta.contexts).sort();
  const categories = Object.entries({ 'CPU & load': /^(system\.(cpu|load)|cpu\.)/, 'Memory & swap': /^(system\.ram|mem\.)/, 'Storage': /^(disk\.|system\.io)/, 'Network': /^(net\.|system\.net)/, 'Temperatures': /temperature/, 'Docker': /^(docker\.|cgroup\.)/, 'Pressure': /pressure/, 'Alerts': /^netdata\.alarm/ }).filter(([, pattern]) => contexts.some(c => (pattern as RegExp).test(c))).map(([name]) => name);
  if (n.health?.status) categories.push('Alerts');
  return { guid: n.mg, nodeId: n.nd || null, hostname: n.nm, os: text([n.os?.nm, n.os?.v].filter(Boolean).join(' ')), kernel: text([n.os?.kernel?.nm, n.os?.kernel?.v].filter(Boolean).join(' ')) || text(labels._kernel_version), cpuModel: text(labels._system_cpu_model), cores: positive(n.hw?.cpus || labels._system_cores), memoryBytes: positive(n.hw?.memory || labels._system_ram_total), version: text(n.v), contexts, categories,
    collectors: [...new Set(charts.flatMap(c => [(c as any).plugin, (c as any).module].filter(v => typeof v === 'string')))].sort(),
    filesystems: charts.filter(c => c.context === 'disk.space').map(c => ({ id: c.id, mount: c.chart_labels?.mount_point || c.family, filesystem: c.chart_labels?.filesystem || '' })),
    interfaces: [...new Set(charts.filter(c => c.context === 'net.net').map(c => c.chart_labels?.interface || c.family))],
    sensors: charts.filter(c => /temperature/.test(c.context)).map(c => c.chart_labels?.label || c.family),
    chartCount: charts.length, discoveredAt: new Date(meta.time).toISOString(), warnings: meta.warnings || [] };
}
