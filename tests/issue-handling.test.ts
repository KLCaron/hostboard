import test from 'node:test';
import assert from 'node:assert/strict';
import { Configuration } from '../server/settings.js';
import { ChecksSchema } from '../server/check-config.js';
import { IssueHandlingStore } from '../server/issue-handling.js';
import { handlingFixture, sampleAlert } from './issue-handling-fixture.js';

test('handling persists, acknowledgement is occurrence-specific, and identity/rule/severity changes resurface alerts', async t => {
  const f = await handlingFixture(); t.after(() => f.close());
  const a = sampleAlert(), target = f.handling.metric('server-a', a)!;
  f.handling.save(target, {revision: f.store.revision(), mode: 'acknowledged', reason: 'Known current occurrence'}, 'operator');
  assert(f.handling.matching(target));
  const reopened = new Configuration(f.filename, ChecksSchema.parse({}));
  const saved = new IssueHandlingStore(reopened, () => 'guid-one');
  assert(saved.matching(saved.metric('server-a', a)));
  reopened.db.close();
  assert.equal(f.handling.matching(f.handling.metric('server-a', {...a, id: 'occurrence-2'})), undefined);
  f.handling.save(target, {revision: f.store.revision(), mode: 'ignored', reason: 'VPN subscription deliberately expired'}, 'operator');
  assert(f.handling.matching(f.handling.metric('server-a', {...a, id: 'occurrence-2'})));
  for (const changed of [{severity: 'critical'}, {config: 'new-rule'}, {chart: 'different-resource'}])
    assert.equal(f.handling.matching(f.handling.metric('server-a', {...a, ...changed})), undefined);
  f.setIdentity('replacement-guid');
  assert.equal(f.handling.matching(f.handling.metric('server-a', a)), undefined);
  assert.equal(f.handling.matching(f.handling.metric('other-server', a)), undefined);
});

test('snoozes expire, restore is audited, conflicts do not overwrite, and incomplete coverage never hides source alerts', async t => {
  const f = await handlingFixture(); t.after(() => f.close()); let now = 1000;
  const h = new IssueHandlingStore(f.store, () => 'guid-one', () => now), target = h.metric('server-a', sampleAlert())!;
  h.save(target, {revision: f.store.revision(), mode: 'snoozed', durationSeconds: 3600, reason: 'Scheduled maintenance'}, 'operator');
  assert(h.matching(target)); now += 3600; assert.equal(h.matching(target), undefined);
  assert.throws(() => h.restore(target.scope, 1, 'operator'), /changed/);
  h.restore(target.scope, f.store.revision(), 'operator');
  assert(h.view().rules[0].revokedAt);
  f.handling.save(target, {revision: f.store.revision(), mode: 'ignored', reason: 'Expected condition'}, 'operator');
  let host = await f.handling.host(f.host(), async () => f.history());
  assert.equal(host.alerts!.length, 0); assert.equal(host.handledAlerts, 1);
  f.setDetailError(true);
  assert.equal(f.handling.alerts('server-a', f.history()).active[0].handling, undefined);
  host = await f.handling.host(f.host(), async () => f.history());
  assert.equal(host.alerts!.length, 1); assert.match(host.warnings.join(), /could not be verified/);
  assert(f.store.db.prepare('SELECT count(*) n FROM config_audit').get()!.n as number >= 3);
});

test('handling suppresses queued Hostboard email while observations and incident recovery remain truthful', async t => {
  const f = await handlingFixture(); t.after(() => f.close());
  const check = f.checks.checks[0], now = Date.now()/1000;
  f.monitor.record(check, {ok: false, responseMs: 2, reason: 'HTTP 503'}, now);
  const incident = f.monitor.view(now).activeIncidents![0];
  f.handling.save(f.handling.incident(incident)!, {revision: f.store.revision(), mode: 'acknowledged', reason: 'Known maintenance'}, 'operator');
  await f.monitor.dispatch();
  assert.equal(f.sends, 0);
  let view = f.handling.monitor(f.monitor.view(now));
  assert.equal(view.checks[0].state, 'down'); assert.equal(view.activeIncidents![0].endedAt, null);
  assert(view.activeIncidents![0].handling); assert.equal(view.incidents[0].notifications[0].state, 'suppressed');
  f.monitor.record(check, {ok: true, responseMs: 2, reason: 'HTTP 200'}, now + 10);
  view = f.monitor.view(now + 10);
  assert.equal(view.incidents[0].id, incident.id); assert.equal(view.incidents[0].resolution, 'Reachability restored');
});

for (const mode of ['cloudflare', 'local'] as const) test(`issue actions enforce ${mode} administrator auth, CSRF, validation and revision checks`, async t => {
  const f = await handlingFixture(mode); t.after(() => f.close());
  let cookie = '';
  if (mode === 'local') {
    const form = await fetch(f.origin+'/auth/login'), html = await form.text();
    const initialCookie = form.headers.get('set-cookie')!.split(';')[0];
    const csrf = html.match(/name="csrf" value="([^"]+)"/)![1];
    const r = await fetch(f.origin+'/auth/login', {method: 'POST', redirect: 'manual', headers: {'Content-Type': 'application/x-www-form-urlencoded', Origin: f.origin, Cookie: initialCookie}, body: new URLSearchParams({username: 'operator', password: 'long-test-password', csrf})});
    assert.equal(r.status, 303); cookie = r.headers.get('set-cookie')!.split(';')[0];
  }
  const body = () => ({revision: f.store.revision(), kind: 'metric', hostId: 'server-a', alertId: 'occurrence-1', mode: 'ignored', reason: 'Expired VPN subscription'});
  const send = (data: unknown, patch = {}, authorized = true) => fetch(f.origin+'/api/admin/issues/handling', {method: 'POST', headers: {'Content-Type': 'application/json', Origin: f.origin, 'X-Hostboard-Request': '1', ...(authorized ? (mode === 'local' ? {Cookie: cookie} : {'Cf-Access-Jwt-Assertion': f.jwt}) : {}), ...patch}, body: JSON.stringify(data)});
  assert([401,403].includes((await send(body(), {}, false)).status));
  assert.equal((await send(body(), {Origin: 'https://evil.example'})).status, 403);
  assert.equal((await send({...body(), reason: ''})).status, 400);
  assert.equal((await send({...body(), mode: 'snoozed'})).status, 400);
  assert.equal((await send({...body(), alertId: 'missing'})).status, 400);
  assert.equal((await send({...body(), revision: 999})).status, 409);
  const r = await send(body()); assert.equal(r.status, 200); assert.equal((await r.json()).rules.length, 1);
  assert.equal((await send({...body(), kind: 'availability', alertId: undefined, incidentId: 999})).status, 400);
});
