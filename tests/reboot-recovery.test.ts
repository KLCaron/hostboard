import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Agent } from '../server/netdata.js';
import { AgentTrust } from '../server/agent-policy.js';
import { Servers } from '../server/servers.js';
import { Configuration } from '../server/settings.js';
import { ChecksSchema } from '../server/check-config.js';
import { Monitor } from '../server/monitor.js';
import { probe } from '../server/probe.js';
import { TargetPolicy } from '../server/targets.js';

test('same Agent recovers from parent outage, child reconnect and provisional Docker catalogs without invalidation', async t => {
  let now = Date.now();
  t.mock.method(Date, 'now', () => now);
  let reachable = false, unavailable = false, docker = false, chartStatus = 200;
  let instance = 'old', catalogInstance = 'old', identity = 'child-guid';
  let chartCalls = 0;
  const chart = (id: string, context: string, labels = {}) => ({id, context, chart_labels: labels, family: '', units: ''});
  const source = http.createServer((req, res) => {
    const u = new URL(req.url!, 'http://fixture');
    if (unavailable) { res.writeHead(503).end(); return; }
    let body: unknown;
    if (u.pathname.endsWith('/nodes')) body = {nodes: [{mg: identity, nm: 'child', state: reachable ? 'reachable' : 'stale'}]};
    else if (u.pathname.endsWith('/charts')) {
      chartCalls++;
      res.statusCode = chartStatus;
      body = {hostname: 'child', charts: {cpu: chart('cpu', 'system.cpu'), ...(docker ? {[catalogInstance]: chart(catalogInstance, 'docker.container_state', {container_name: 'web'})} : {})}};
    } else if (u.pathname.endsWith('/contexts')) body = {contexts: {'system.cpu': {}, 'docker.container_state': {}}};
    else if (u.pathname.endsWith('/alerts')) body = {alerts: []};
    else {
      assert.equal(u.searchParams.get('nodes'), 'child-guid');
      const isDocker = u.searchParams.get('contexts') === 'docker.container_state';
      const ids = isDocker ? [`running,${instance}@child`] : ['user,cpu@child'];
      body = {summary: {nodes: [{mg: 'child-guid'}]}, result: {labels: ['time', ...ids], data: [[now / 1000 - 1, isDocker ? (docker ? 1 : null) : (reachable ? 12 : null)]]}, view: {dimensions: {ids}}};
    }
    res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(body));
  });
  await new Promise<void>(r => source.listen(0, '127.0.0.1', r));
  t.after(() => source.close());
  const url = `http://127.0.0.1:${(source.address() as {port: number}).port}`;
  const trust = new AgentTrust([{url, addresses: ['127.0.0.1']}]);
  const agent = new Agent({id: 'child', name: 'Child', url, node: 'child-guid'}, trust);
  const poll = async (advance = 9000) => { now += advance; return agent.current(); };
  assert.equal((await poll()).status, 'stale');
  reachable = true; docker = true;
  let host = await poll();
  assert.equal(host.status, 'online');
  assert.equal(host.cpu, 12);
  assert.equal(host.dockerAvailable, true);
  assert.equal(host.containers[0].state, 'running');
  const normalCalls = chartCalls;
  await poll(); assert.equal(chartCalls, normalCalls, 'healthy metadata remains cached');
  instance = 'new';
  host = await poll();
  assert.equal(host.dockerAvailable, false, 'unlabelled fresh instances cannot claim zero running');
  assert.match(host.warnings.join(), /instance metadata incomplete/);
  catalogInstance = 'new';
  host = await poll(31_000);
  assert.equal(host.dockerAvailable, true);
  assert.equal(host.containers.filter(c => c.state === 'running').length, 1);
  unavailable = true;
  host = await poll(); assert.equal(host.status, 'offline'); assert.equal(host.cpu, null);
  unavailable = false; chartStatus = 503;
  host = await poll(); assert.equal(host.dockerAvailable, false);
  chartStatus = 200;
  host = await poll(31_000); assert.equal(host.status, 'online'); assert.equal(host.dockerAvailable, true);
  docker = false;
  host = await poll(); assert.equal(host.dockerAvailable, false); assert.equal(host.containers[0].state, 'unknown');
  docker = true;
  host = await poll(31_000); assert.equal(host.dockerAvailable, true);
  reachable = false;
  host = await poll(); assert.equal(host.status, 'stale');
  reachable = true;
  host = await poll(); assert.equal(host.status, 'online');
  identity = 'replacement-guid';
  host = await poll(); assert.equal(host.status, 'offline'); assert.equal(host.cpu, null);
  assert.match(host.error!, /identity/);
});

test('restart retains registered GUIDs during source outage and restores polling and incidents with real probes', async t => {
  let available = true, parentAvailable = true;
  const endpoint = http.createServer((req, res) => {
    const u = new URL(req.url!, 'http://fixture');
    if (u.pathname === '/health') {res.writeHead(available ? 200 : 503).end('service'); return;}
    if (!parentAvailable) {res.writeHead(503).end(); return;}
    let data: unknown;
    if (u.pathname.endsWith('/nodes')) data = {nodes: [{mg: 'child-guid', nm: 'child-name', state: 'reachable'}]};
    else if (u.pathname.endsWith('/charts')) data = {hostname: 'child-name', charts: {cpu: {id: 'cpu', context: 'system.cpu', family: '', units: '', chart_labels: {}}}};
    else if (u.pathname.endsWith('/contexts')) data = {contexts: {'system.cpu': {}}};
    else if (u.pathname.endsWith('/alerts')) data = {alerts: []};
    else data = {summary: {nodes: [{mg: 'child-guid'}]}, result: {labels: ['time', 'user'], data: [[Date.now() / 1000 - 1, 12]]}, view: {dimensions: {ids: ['user,cpu@child']}}};
    res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(data));
  });
  await new Promise<void>(r => endpoint.listen(0, '127.0.0.1', r));
  t.after(() => endpoint.close());
  const port = (endpoint.address() as {port: number}).port;
  const url = `http://127.0.0.1:${port}`;
  const config = ChecksSchema.parse({checks: [{id: 'web', hostId: 'child', name: 'Web', type: 'http', url: url + '/health', intervalSeconds: 10, failureThreshold: 2, notify: false}]});
  const check = config.checks[0];
  const dir = mkdtempSync(path.join(tmpdir(), 'hb-reboot-'));
  t.after(() => rmSync(dir, {recursive: true, force: true}));
  const filename = path.join(dir, 'monitor.sqlite');
  const trust = new AgentTrust([{url, addresses: ['127.0.0.1']}]);
  const policy = new TargetPolicy([{host: '127.0.0.1', port, addresses: ['127.0.0.1']}]);
  let store = new Configuration(filename, config);
  const seed = [{id: 'child', name: 'Child', url, node: 'child-name'}];
  let monitor = new Monitor(store.runtime(), store.db, null);
  const original = new Servers(store, trust, seed);
  assert.equal((await original.current('child')).status, 'online');
  assert.equal(original.records()[0].guid, 'child-guid');
  let time = Date.now() / 1000 - 100;
  const observe = async () => {time += 10; monitor.record(check, await probe(check, policy), time, time);};
  await observe();
  available = false; parentAvailable = false;
  await observe(); assert.equal(monitor.view(time).activeIncidents!.length, 0);
  await observe();
  const incident = monitor.view(time).activeIncidents![0]; assert.ok(incident);
  monitor.stop(); store.db.close();
  store = new Configuration(filename, ChecksSchema.parse({}));
  t.after(() => {monitor.stop(); store.db.close();});
  monitor = new Monitor(store.runtime(), store.db, null);
  const registry = new Servers(store, trust, [{...seed[0], id: 'unexpected'}]);
  assert.deepEqual(registry.ids(), ['child']);
  assert.equal(registry.records()[0].guid, 'child-guid');
  assert.equal((await registry.current('child')).status, 'offline');
  monitor.policy = policy;
  assert.equal(monitor.view(time).activeIncidents![0].id, incident.id);
  assert.equal(monitor.view(time).activeIncidents![0].monitoringGap, true);
  await observe(); assert.equal(monitor.view(time).activeIncidents![0].id, incident.id);
  // Exercise the real scheduler: it must keep probing after failure and close
  // only on observed success. No production network, SMTP or service is used.
  monitor.start();
  const before = monitor.view().checks[0].checkedAt!;
  while (monitor.view().checks[0].checkedAt === before)
    await new Promise(r => setTimeout(r, 25));
  assert.equal(monitor.view().checks[0].state, 'down');
  available = true; parentAvailable = true;
  await t.test('scheduler retries after the failed observation and resolves the same incident', async () => {
    const deadline = Date.now() + 15_000;
    while (monitor.view().checks[0].state !== 'up') {
      assert.ok(Date.now() < deadline, 'scheduler did not recover');
      await new Promise(r => setTimeout(r, 100));
    }
  });
  assert.equal((await registry.current('child')).status, 'online');
  assert.equal(registry.records()[0].guid, 'child-guid');
  const view = monitor.view();
  assert.equal(view.activeIncidents!.length, 0);
  const resolved = view.incidents.find(i => i.id === incident.id)!;
  assert.equal(resolved.reason, incident.reason);
  assert.equal(resolved.startedAt, incident.startedAt);
  assert.equal(resolved.resolution, 'Reachability restored');
  assert.ok(resolved.endedAt);
  assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM check_generations WHERE checkId=?').get('web')!.n, 1);
});
