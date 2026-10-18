import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { Agent, latest, parseTable, ratio, sum, type Table } from '../server/netdata.js';
import { ConfigSchema, privateBind } from '../server/config.js';

test('missing and invalid metrics stay missing; zero remains a real value', () => {
  assert.equal(sum([0, 0]), 0);
  assert.equal(sum([]), null);
  assert.equal(sum([2, null]), null);
  assert.equal(ratio(4, 0), null);
  const parsed = parseTable({
    result: {
      labels: ['time', 'used', 'avail'],
      data: [
        [90, 0, null],
        [80, 3, Infinity],
      ],
    },
    view: { dimensions: { ids: ['used,disk_space./@guid', 'avail,disk_space./@guid'] } },
  });
  assert.deepEqual(parsed.get('disk_space./')?.[1], { time: 90, values: { used: 0, avail: null } });
  assert.equal(latest(parsed.get('disk_space./'), 200), undefined);
  assert.equal(latest(parsed.get('disk_space./'), 100)?.values.used, 0);
});
test('configuration rejects duplicate ids, wildcard selectors, credential URLs and public listeners', () => {
  const host = { id: 'a', name: 'A', url: 'http://127.0.0.1:19999', node: 'node-a' };
  assert.ok(ConfigSchema.safeParse({ hosts: [host] }).success);
  assert.equal(ConfigSchema.safeParse({ hosts: [host, host] }).success, false);
  for (const invalid of [
    { node: '*' },
    { url: 'http://secret:token@localhost' },
    { url: 'http://localhost/proxy' },
  ])
    assert.equal(ConfigSchema.safeParse({ hosts: [{ ...host, ...invalid }] }).success, false);
  for (const address of ['0.0.0.0', '::', '8.8.8.8']) assert.equal(privateBind(address), false);
  for (const address of ['127.0.0.1', '192.168.5.4', '10.2.3.4', '172.16.0.2', '100.100.1.2'])
    assert.equal(privateBind(address), true);
});

test('Agent integration selects one node, normalizes live units, joins containers, caches and preserves gaps', async (t) => {
  let calls = 0;
  const guid = 'node-guid';
  const now = Math.floor(Date.now() / 1000);
  let wrongNode = false;
  let duplicateNode = false;
  const rows: [string, string, Record<string, string>][] = [
    ['cpu', 'system.cpu', {}],
    ['ram', 'system.ram', {}],
    ['uptime', 'system.uptime', {}],
    ['load', 'system.load', {}],
    ['net', 'system.net', {}],
    ['io', 'system.io', {}],
    ['disk', 'disk.space', { mount_point: '/', filesystem: 'ext4' }],
    ['temp', 'system.hw.sensor.temperature.input', { chip_id: 'cpu', label: 'package' }],
    ['docker', 'docker.container_state', { container_name: 'web', image: 'example:1' }],
    ['health', 'docker.container_health_status', { container_name: 'web' }],
    ['cgroup_cpu', 'cgroup.cpu', { cgroup_name: 'web' }],
    ['cgroup_mem', 'cgroup.mem_usage', { cgroup_name: 'web' }],
  ];
  const charts = Object.fromEntries(
    rows.map(([id, context, labels]) => [
      id,
      { id, context, family: '', units: '', chart_labels: labels },
    ]),
  );
  const values: Record<string, Record<string, number | null>> = {
    cpu: { user: 10, system: 5, iowait: 1 },
    ram: { used: 256, free: 256, cached: 512, buffers: 0 },
    uptime: { uptime: 6000 },
    load: { load1: 1, load5: 2, load15: 3 },
    net: { received: 80, sent: -40 },
    io: { reads: 128, writes: -64 },
    disk: { used: 60, avail: 35, 'reserved for root': 5 },
    temp: { input: 45 },
    docker: { running: 1, exited: 0 },
    health: { healthy: 1 },
    cgroup_cpu: { user: 4, system: 2 },
    cgroup_mem: { ram: 64, swap: 5 },
  };
  const server = http.createServer((req, res) => {
    calls++;
    const u = new URL(req.url!, 'http://localhost');
    let data: unknown;
    if (u.pathname.endsWith('/nodes'))
      data = {
        nodes: [
          {
            mg: guid,
            nd: 'node-id',
            nm: 'node-a',
            state: 'reachable',
            v: '2',
            hw: { cpus: '4' },
            os: { nm: 'Ubuntu', v: '24' },
          },
        ],
      };
    else if (u.pathname.endsWith('/charts')) data = { hostname: 'node-a', charts };
    else if (u.pathname.endsWith('/contexts'))
      data = { contexts: Object.fromEntries(Object.values(charts).map((c) => [c.context, {}])) };
    else if (u.pathname.endsWith('/alerts'))
      data = {
        alerts: [
          { nm: 'disk', sum: 'Disk warning', cr: 0, wr: 1 },
          { nm: 'ok', sum: 'Clear', cr: 0, wr: 0 },
        ],
      };
    else {
      assert.equal(u.searchParams.get('nodes'), guid);
      assert.equal(u.searchParams.get('timeout'), '5000');
      const c = Object.values(charts).find((c) => c.context === u.searchParams.get('contexts'))!;
      const v = values[c.id as string],
        ids = Object.keys(v).map((d) => `${d},${c.id}@${guid}`);
      data = {
        summary: { nodes: [{ mg: wrongNode ? 'unexpected' : guid }] },
        result: {
          labels: ['time', ...ids],
          data: [
            [now - 3, ...Object.values(v)],
            [now - 6, ...Object.keys(v).map(() => null)],
          ],
        },
        view: { dimensions: { ids } },
      } satisfies Table;
    }
    if (duplicateNode && u.pathname.endsWith('/nodes')) {
      data = {
        nodes: [
          { mg: 'first', nm: 'node-a' },
          { mg: 'second', nm: 'node-a' },
        ],
      };
    }
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify(data));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const address = server.address() as { port: number };
  const config = { id: 'a', name: 'A', url: `http://127.0.0.1:${address.port}`, node: 'node-a' };
  const agent = new Agent(config);
  const [host, same] = await Promise.all([agent.current(), agent.current()]);
  assert.equal(host, same);
  assert.equal(host.status, 'online');
  assert.equal(host.cpu, 16);
  assert.equal(host.memory.percent, 25);
  assert.equal(host.network.sent, 40);
  assert.equal(host.io.write, 64);
  assert.equal(host.disks[0].percent, 60);
  assert.equal(host.containers[0].name, 'web');
  assert.equal(host.containers[0].memory, 64);
  assert.equal(host.containers[0].cpu, 6);
  assert.equal(host.containers[0].health, 'healthy');
  assert.equal(host.alerts?.length, 1);
  const count = calls;
  await agent.current();
  assert.equal(calls, count);
  const history = await agent.history('15m');
  assert.equal(history.points[0].cpu, null);
  assert.equal(history.points[1].cpu, 16);
  wrongNode = true;
  const bad = await new Agent(config).current();
  assert.equal(bad.status, 'stale');
  assert.equal(bad.cpu, null);
  assert.ok(bad.warnings.length > 0);
  wrongNode = false;
  values.docker = { running: null, exited: null };
  const missingDocker = await new Agent(config).current();
  assert.equal(missingDocker.status, 'online');
  assert.equal(missingDocker.dockerAvailable, false);
  assert.equal(missingDocker.containers[0].state, 'unknown');
  duplicateNode = true;
  const ambiguous = await new Agent(config).current();
  assert.equal(ambiguous.status, 'offline');
  assert.match(ambiguous.error!, /ambiguous/);
});

test('unreachable Agents return an explicit offline host with no invented values', async () => {
  const host = await new Agent({
    id: 'a',
    name: 'A',
    node: 'node-a',
    url: 'http://127.0.0.1:1',
  }).current();
  assert.equal(host.status, 'offline');
  assert.equal(host.cpu, null);
  assert.equal(host.memory.used, null);
  assert.equal(host.alerts, null);
  assert.equal(host.lastSeen, null);
});
