#!/usr/bin/env node
import assert from 'node:assert/strict';
const base = process.argv[2] || 'http://127.0.0.1:8088';
const fetchApi = async (path) => {
  const r = await fetch(new URL(path, base), { signal: AbortSignal.timeout(20_000) });
  assert.equal(r.status, 200, `${path}: expected HTTP 200`);
  return r.json();
};
assert.equal((await fetchApi('/api/health')).status, 'ok');
const fleet = await fetchApi('/api/fleet');
assert.ok(fleet.hosts.length > 0);
for (const h of fleet.hosts) {
  assert.equal(h.status, 'online', `${h.name} is not online`);
  assert.ok(typeof h.cpu === 'number' && h.cpu >= 0 && h.cpu <= 100.1, `${h.name}: CPU`);
  assert.ok(
    h.memory.total > 0 && h.memory.used >= 0 && h.memory.used <= h.memory.total,
    `${h.name}: RAM`,
  );
  assert.ok(
    h.disks.some((d) => d.total > 0 && d.used >= 0),
    `${h.name}: storage`,
  );
  assert.ok(
    [h.network.received, h.network.sent].every((n) => typeof n === 'number' && n >= 0),
    `${h.name}: network`,
  );
  assert.ok(
    [h.io.read, h.io.write].every((n) => typeof n === 'number' && n >= 0),
    `${h.name}: disk I/O`,
  );
  assert.equal(h.warnings.length, 0, `${h.name}: partial integration`);
  for (const range of ['15m', '1h', '6h', '24h']) {
    const history = await fetchApi(`/api/hosts/${encodeURIComponent(h.id)}/history?range=${range}`);
    assert.deepEqual(history.errors, [], `${h.name}/${range}: historical query errors`);
    assert.ok(history.points.length > 0);
    for (const metric of ['cpu', 'memory', 'received', 'sent', 'read', 'write', 'load'])
      assert.ok(
        history.points.some((p) => p[metric] !== null),
        `${h.name}/${range}: no ${metric} samples`,
      );
  }
  const alerts = await fetchApi(`/api/hosts/${h.id}/alerts`);
  assert.deepEqual(alerts.errors, [], `${h.name}: alert investigation errors`);
  for (const a of alerts.resolved) {
    assert.equal(a.state, 'CLEAR');
    assert.ok(a.duration === null || a.duration >= 0);
  }
  const diagnostics = await fetchApi(`/api/hosts/${h.id}/diagnostics`);
  const catalog = await fetchApi(`/api/hosts/${h.id}/metrics`);
  const cpu = catalog.find(c => c.context === 'system.cpu');
  assert.ok(cpu);
  const now = Math.floor(Date.now()/1000);
  const history = await fetchApi(`/api/hosts/${h.id}/metric-history?chart=${encodeURIComponent(cpu.id)}&after=${now-86400}&before=${now}`);
  assert.deepEqual(history.errors, []);
  assert.ok(history.points.length > 0 && history.points.length <= 300);
  assert.ok(history.retention.first > 0 && history.retention.last > 0);
  for (const p of history.points) {
    if (p['busy:min'] !== null && p['busy:max'] !== null) {
      assert.ok(p['busy:min'] <= p['busy:max']);
      assert.ok(p['busy:max'] <= 100.1 && p['busy:min'] >= -0.1);
    }
  }
  // Verify a real available diagnostic and container dimension without requiring
  // optional collectors on every installation.
  for (const metric of [diagnostics.find(d => d.context.includes('pressure')), catalog.find(c => c.context === 'cgroup.mem_usage')].filter(Boolean)) {
    const result = await fetchApi(`/api/hosts/${h.id}/metric-history?chart=${encodeURIComponent(metric.id)}&after=${now-3600}&before=${now}`);
    assert.deepEqual(result.errors, []);
    assert.ok(result.dimensions.length > 0);
  }
  console.log(
    `${h.name}: online; live metrics and all four historical ranges verified; ${h.containers.length} containers, ${h.sensors.length} sensors, ${h.alerts?.length ?? 'unknown'} active alert types`,
  );
}
for (const [path, status] of [
  ['/api/hosts/unknown/history', 404],
  ['/api/hosts/' + fleet.hosts[0].id + '/history?range=invalid', 400],
  ['/api/fetch?url=http://example.com', 404],
])
  assert.equal((await fetch(new URL(path, base))).status, status);
const root = await fetch(base);
assert.equal(root.status, 200);
assert.ok(root.headers.get('content-security-policy')?.includes("connect-src 'self'"));
const html = await root.text();
assert.ok(html.includes('Hostboard'));
const assets = [...html.matchAll(/(?:src|href)="(\/assets\/[^\"]+)"/g)].map((m) => m[1]);
assert.ok(assets.length > 0);
for (const asset of assets) assert.equal((await fetch(new URL(asset, base))).status, 200);
console.log('HTTP page/assets, security headers, range validation and proxy isolation verified.');
const monitor = await fetchApi('/api/monitor');
assert.equal(monitor.healthy, true, 'Service monitor coverage');
assert.ok(Array.isArray(monitor.activeIncidents));
assert.ok(monitor.activeIncidents.every(i => i.endedAt === null));
assert.equal(new Set(monitor.activeIncidents.map(i => i.id)).size, monitor.activeIncidents.length);
for (const check of monitor.checks) {
  assert.equal(check.state, 'up', `${check.name}: reachability`);
  assert.ok(check.checkedAt > 0 && check.lastSuccessfulAt > 0, `${check.name}: observation and last success`);
  assert.ok(check.trend.some(p => p.responseMs !== null), `${check.name}: retained response history`);
}
for (const section of ['overview', 'servers', 'services', 'issues', 'settings', 'alerts', 'incidents']) {
  const response = await fetch(new URL('/' + section, base));
  assert.equal(response.status, 200, `${section}: bookmarked path`);
  assert.match(response.headers.get('cache-control') || '', /no-cache/);
}
console.log(`${monitor.checks.length}/${monitor.checks.length} service checks reachable; scheduler, retained trends, active incidents and section/legacy paths verified.`);
