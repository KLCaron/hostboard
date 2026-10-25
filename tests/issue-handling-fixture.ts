import express from 'express';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { generateKeyPair, exportJWK, createLocalJWKSet, SignJWT } from 'jose';
import { hash } from 'argon2';
import { randomBytes } from 'node:crypto';
import { Configuration } from '../server/settings.js';
import { Monitor } from '../server/monitor.js';
import { ChecksSchema } from '../server/check-config.js';
import { empty } from '../server/netdata.js';
import { authorization, type AdminConfig } from '../server/admin.js';
import { configAPI, synchronize } from '../server/config-api.js';
import { localAuthentication } from '../server/local-auth.js';
import { IssueHandlingStore, issueHandlingAPI } from '../server/issue-handling.js';
import type { Servers } from '../server/servers.js';
import type { AlertDetail } from '../src/investigation-types.js';
import type { IncidentView } from '../src/monitor-types.js';

export const sampleAlert = (patch: Partial<AlertDetail> = {}): AlertDetail => ({
  id: 'occurrence-1', name: 'vpn-health', summary: 'VPN subscription expired', info: 'Controlled fixture alert',
  state: 'WARNING', severity: 'warning', resource: 'vpn', chart: 'docker.vpn', context: 'docker.container_health_status',
  startedAt: Date.now()/1000 - 60, endedAt: null, duration: null, value: 1, units: 'state', config: 'rule-one',
  warning: '$unhealthy > 0', critical: null, resolved: false, ...patch,
});
export async function handlingFixture(mode: 'cloudflare' | 'local' = 'cloudflare') {
  const dir = mkdtempSync(path.join(tmpdir(), 'hb-handling-'));
  const filename = path.join(dir, 'monitor.sqlite');
  const checks = ChecksSchema.parse({checks: [{id: 'web', hostId: 'server-a', name: 'Web', type: 'http', url: 'http://127.0.0.1/', failureThreshold: 1}]});
  const store = new Configuration(filename, checks);
  let sends = 0, identity = 'guid-one', alerts = [sampleAlert()], detailError = false;
  const monitor = new Monitor(store.runtime(), store.db, {provider: 'fixture', send: async () => {sends++;}});
  synchronize(store, monitor);
  const handling = new IssueHandlingStore(store, id => id === 'server-a' ? identity : null);
  monitor.issueMuted = id => {
    const i = store.db.prepare('SELECT * FROM incidents WHERE id=?').get(id) as unknown as IncidentView;
    return !!i && !!handling.matching(handling.incident(i));
  };
  const history = () => ({active: alerts, resolved: [], errors: detailError ? ['incomplete source'] : [], fetchedAt: new Date().toISOString()});
  const host = () => ({...empty({id: 'server-a', name: 'Example server', node: 'fixture', url: 'http://127.0.0.1'}, ''), status: 'online' as const, error: null,
    alerts: alerts.map(a => ({name: a.name, summary: a.summary, severity: a.severity as 'warning' | 'critical', count: 1}))});
  const registry = {current: async () => host(), agent: (id: string) => id === 'server-a' ? {alertDetails: async () => history()} : undefined} as unknown as Servers;
  const app = express(), server = app.listen(0, '127.0.0.1');
  await new Promise<void>(r => server.once('listening', r));
  const origin = `http://127.0.0.1:${(server.address() as {port: number}).port}`;
  const keys = await generateKeyPair('RS256'), jwk = await exportJWK(keys.publicKey); jwk.kid = 'fixture';
  const admin: AdminConfig = mode === 'cloudflare' ? {issuer: 'https://fixture.cloudflareaccess.com', audience: 'fixture', emails: ['operator@example.com'], origin, targets: []} : {
    mode: 'local', origin, username: 'operator', passwordHash: await hash('long-test-password', {memoryCost: 65536, timeCost: 3, parallelism: 1}), sessionSecret: randomBytes(32).toString('hex'), trustedProxies: [], targets: [],
  };
  const jwt = await new SignJWT({email: 'operator@example.com'}).setProtectedHeader({alg: 'RS256', kid: jwk.kid}).setIssuer('https://fixture.cloudflareaccess.com').setAudience('fixture').setSubject('operator').setIssuedAt().setExpirationTime('1h').sign(keys.privateKey);
  const auth = authorization(admin, createLocalJWKSet({keys: [jwk]}));
  const stopSessions = admin.mode === 'local' ? localAuthentication(app, admin) : () => {};
  app.use('/api', configAPI(store, monitor, admin, ['server-a'], auth));
  app.use('/api', issueHandlingAPI(handling, registry, monitor, admin, auth));
  app.get('/api/health', (_q, r) => r.json({status: 'ok'}));
  app.get('/api/fleet', async (_q, r) => r.json({hosts: [await handling.host(host(), async () => history())], groups: [], generatedAt: new Date().toISOString(), refreshSeconds: 10}));
  app.get('/api/monitor', (_q, r) => r.json(handling.monitor(monitor.view())));
  app.get('/api/hosts/:id/alerts', (_q, r) => r.json(handling.alerts('server-a', history())));
  app.get('/api/hosts/:id/history', (_q, r) => r.json({points: [], errors: [], range: '1h', fetchedAt: new Date().toISOString()}));
  app.use(express.static(path.resolve('dist/client')));
  app.get(/.*/, (_q, r) => r.sendFile(path.resolve('dist/client/index.html')));
  return {origin, app, store, monitor, handling, filename, jwt, checks, host, history,
    get sends() {return sends;}, setAlerts: (a: AlertDetail[]) => {alerts = a;}, setIdentity: (s: string) => {identity = s;}, setDetailError: (v: boolean) => {detailError = v;},
    close: async () => {monitor.stop(); stopSessions(); server.closeAllConnections(); await new Promise<void>(r => server.close(() => r())); store.db.close(); rmSync(dir, {recursive: true, force: true});},
  };
}
