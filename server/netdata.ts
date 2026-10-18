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
  'system.hw.sensor.temperature.input',
] as const;
export const RANGES: Record<Range, number> = { '15m': 900, '1h': 3600, '6h': 21600, '24h': 86400 };
type Chart = {
  id: string;
  context: string;
  family: string;
  units: string;
  chart_labels: Record<string, string>;
};
type NodeInfo = {
  mg: string;
  nd: string;
  nm: string;
  state: string;
  v: string;
  hw?: { cpus: string };
  os?: { nm: string; v: string };
  health?: { status: string };
};
type Meta = {
  node: NodeInfo;
  charts: Record<string, Chart>;
  contexts: Record<string, unknown>;
  time: number;
};
export type Table = {
  result: { labels: string[]; data: (number | null)[][] };
  view?: { dimensions?: { ids: string[] }; update_every?: number };
  db?: { last_entry: number };
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
function empty(config: HostConfig, error: string, lastSeen: string | null = null): Host {
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
  private snapshot?: { host: Host; time: number };
  private pending?: Promise<Host>;
  private histories = new Map<Range, { value: History; time: number }>();
  private historyPending = new Map<Range, Promise<History>>();
  constructor(public config: HostConfig) {}
  private async request(path: string, params: Record<string, string> = {}) {
    const url = new URL(path, this.config.url);
    Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));
    const token = this.config.tokenEnv ? process.env[this.config.tokenEnv] : undefined;
    const response = await fetch(url, {
      signal: AbortSignal.timeout(6000),
      redirect: 'error',
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    });
    if (!response.ok) throw new Error(`Agent returned HTTP ${response.status}`);
    return response.json();
  }
  private async meta(): Promise<Meta> {
    if (this.metadata && Date.now() - this.metadata.time < 60_000) return this.metadata;
    const response = await this.request('/api/v3/nodes');
    const matches: NodeInfo[] =
      response.nodes?.filter((n: NodeInfo) => [n.mg, n.nd, n.nm].includes(this.config.node)) || [];
    if (matches.length > 1)
      throw new Error('Node selector is ambiguous; configure a machine GUID instead');
    const node = matches[0];
    if (!node) throw new Error('Configured node was not found on this Agent');
    const [charts, contexts] = await Promise.all([
      this.request(`/host/${encodeURIComponent(node.mg)}/api/v1/charts`),
      this.request('/api/v3/contexts', { nodes: node.mg }),
    ]);
    if (charts.hostname !== node.nm)
      throw new Error('Agent returned metadata for an unexpected host');
    this.metadata = {
      node,
      charts: charts.charts,
      contexts: contexts.contexts || {},
      time: Date.now(),
    };
    return this.metadata;
  }
  private async data(meta: Meta, context: string, seconds: number, points: number): Promise<Table> {
    const data = await this.request('/api/v3/data', {
      nodes: meta.node.mg,
      contexts: context,
      after: String(-seconds),
      points: String(points),
      format: 'json',
      group_by: 'instance,dimension',
      options: 'jsonwrap',
      timeout: '5000',
    });
    if (data.summary?.nodes?.length !== 1 || data.summary.nodes[0].mg !== meta.node.mg)
      throw new Error('Agent data did not match the configured node');
    return data;
  }
  async current(): Promise<Host> {
    if (this.snapshot && Date.now() - this.snapshot.time < 8000) return this.snapshot.host;
    if (this.pending) return this.pending;
    this.pending = this.collect()
      .catch((error) =>
        empty(
          this.config,
          error instanceof Error && error.name === 'TimeoutError'
            ? 'Agent request timed out'
            : error instanceof Error
              ? error.message
              : 'Agent unavailable',
          this.snapshot?.host.lastSeen,
        ),
      )
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
    const meta = await this.meta(),
      now = Date.now() / 1000;
    const host = empty(this.config, '');
    host.error = null;
    host.hostname = meta.node.nm;
    host.version = meta.node.v;
    host.os = meta.node.os ? `${meta.node.os.nm} ${meta.node.os.v}` : null;
    host.cores = Number(meta.node.hw?.cpus) || null;
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
    host.status = cpuSample ? (meta.node.state === 'reachable' ? 'online' : 'stale') : 'stale';
    host.lastSeen = cpuSample
      ? new Date(cpuSample.time * 1000).toISOString()
      : this.snapshot?.host.lastSeen || null;
    if (host.status === 'stale')
      host.error = 'No fresh CPU samples from this host. Check the Agent or streaming connection.';
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
          name: `${labels.chip_id || chart.family} · ${labels.label && labels.label !== '[none]' ? labels.label : labels.feature || 'temperature'}`,
          value: v.input ?? null,
        });
    }
    host.disks.sort((a, b) => a.mount.localeCompare(b.mount));
    host.sensors.sort((a, b) => (b.value ?? -Infinity) - (a.value ?? -Infinity));
    host.dockerAvailable = [...(tables.get('docker.container_state')?.values() || [])].some(
      (samples) => !!latest(samples, now),
    );
    const containers = new Map<string, Container>();
    for (const chart of Object.values(meta.charts).filter(
      (c) => c.context === 'docker.container_state',
    )) {
      const labels = chart.chart_labels || {},
        name = labels.container_name;
      if (!name) continue;
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
      });
    }
    for (const chart of Object.values(meta.charts)) {
      const labels = chart.chart_labels || {},
        container = containers.get(labels.container_name || labels.cgroup_name);
      if (!container) continue;
      const v = values(chart.context, chart.id);
      if (chart.context === 'cgroup.cpu') container.cpu = cpu(v);
      if (chart.context === 'cgroup.mem_usage') container.memory = v.ram ?? null;
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
    return {
      hostId: this.config.id,
      range,
      points: [...points.values()].sort((a, b) => a.time - b.time),
      fetchedAt: new Date().toISOString(),
      errors,
    };
  }
}
