import express from 'express';
import { validateWindow } from './investigation.js';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig, privateBind } from './config.js';
import { Agent, RANGES } from './netdata.js';
import type { Range } from '../src/types.js';
import { loadChecks } from './check-config.js';
import { Monitor } from './monitor.js';
import { smtpDelivery } from './notifications.js';
const agents = loadConfig().hosts.map((host) => new Agent(host));
const monitor = new Monitor(loadChecks(agents.map(a => a.config.id)), process.env.HOSTBOARD_DB || 'data/monitor.sqlite', smtpDelivery());
const app = express();
app.disable('x-powered-by');
app.use((_req, res, next) => {
  res.set({
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'X-Frame-Options': 'DENY',
    'Content-Security-Policy':
      "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; font-src 'self'; frame-ancestors 'none'; base-uri 'none'; object-src 'none'",
  });
  next();
});
app.get('/api/health', (_req, res) => res.json({ status: 'ok' }));
app.use('/api', (_req, res, next) => {
  res.set('Cache-Control', 'no-store');
  next();
});
app.get('/api/monitor-health', (_req, res) => res.status(monitor.healthy() ? 200 : 503).json({ status: monitor.healthy() ? 'ok' : 'unavailable' }));
app.get('/api/monitor', (req, res) => {
  const before = req.query.before;
  if (before !== undefined && (typeof before !== 'string' || !/^\d{1,15}$/.test(before) || Number(before) < 1)) { res.status(400).json({ error: 'Invalid incident cursor' }); return; }
  res.json(monitor.view(undefined, before === undefined ? undefined : Number(before)));
});
app.get('/api/incidents/:id', (req, res) => {
  if (!/^\d{1,15}$/.test(req.params.id)) { res.status(400).json({ error: 'Invalid incident ID' }); return; }
  const id = Number(req.params.id);
  const incident = monitor.view(undefined, id + 1).incidents.find(i => i.id === id);
  if (!incident) { res.status(404).json({ error: 'Unknown incident' }); return; }
  res.json(incident);
});
app.get('/api/fleet', async (_req, res) =>
  res.json({
    hosts: await Promise.all(agents.map((agent) => agent.current())),
    generatedAt: new Date().toISOString(),
    refreshSeconds: 10,
  }),
);
app.get('/api/hosts/:id/health', async (req, res) => {
  const agent = agents.find(a => a.config.id === req.params.id);
  if (!agent) { res.status(404).json({ error: 'Unknown host' }); return; }
  const host = await agent.current();
  res.status(host.status === 'online' ? 200 : 503).json({ status: host.status === 'online' ? 'ok' : 'unavailable' });
});
app.get('/api/hosts/:id/history', async (req, res) => {
  const agent = agents.find((a) => a.config.id === req.params.id);
  if (!agent) {
    res.status(404).json({ error: 'Unknown host' });
    return;
  }
  const range = req.query.range ?? '1h';
  if (typeof range !== 'string' || !Object.hasOwn(RANGES, range)) {
    res.status(400).json({ error: 'Invalid time range' });
    return;
  }
  try {
    res.json(await agent.history(range as Range));
  } catch {
    res.status(502).json({ error: 'Agent history is unavailable' });
  }
});
// Investigation requests accept exact catalog IDs, never caller-provided Agent URLs.
for (const endpoint of ['metrics', 'diagnostics', 'alerts', 'metric-history'] as const) {
  app.get(`/api/hosts/:id/${endpoint}`, async (req, res) => {
    const agent = agents.find(a => a.config.id === req.params.id);
    if (!agent) { res.status(404).json({ error: 'Unknown host' }); return; }
    let window;
    if (endpoint === 'metric-history') {
      if (typeof req.query.chart !== 'string' || req.query.chart.length > 512) {
        res.status(400).json({ error: 'Choose a metric chart' }); return;
      }
      try { window = validateWindow(req.query.after, req.query.before); }
      catch (error) { res.status(400).json({ error: (error as Error).message }); return; }
    }
    try {
      if (endpoint === 'metrics') res.json(await agent.catalog());
      else if (endpoint === 'diagnostics') res.json(await agent.diagnostics());
      else if (endpoint === 'alerts') res.json(await agent.alertDetails());
      else {
        if (!(await agent.catalog()).some(c => c.id === req.query.chart)) { res.status(404).json({ error: 'Metric is no longer available on this host' }); return; }
        res.json(await agent.metricHistory(req.query.chart as string, window!));
      }
    } catch { res.status(502).json({ error: 'Agent investigation data unavailable. Check the host connection and retry.' }); }
  });
}
app.use('/api', (_req, res) => res.status(404).json({ error: 'Unknown endpoint' }));
const client = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../client');
app.use(express.static(client, { maxAge: '1h', index: false }));
app.get('/', (_req, res) =>
  res.sendFile(path.join(client, 'index.html'), { headers: { 'Cache-Control': 'no-cache' } }),
);
const bind = process.env.HOSTBOARD_BIND || '127.0.0.1',
  port = Number(process.env.PORT || 3001);
if (!privateBind(bind))
  throw new Error('HOSTBOARD_BIND must be loopback, a private LAN address, or a VPN address');
if (!Number.isInteger(port) || port < 1024 || port > 65535)
  throw new Error('PORT must be between 1024 and 65535');
// Same-host proxies can use localhost while browsers on the LAN use the
// configured private address. Never bind all interfaces to enable both.
const addresses = bind === '127.0.0.1' || bind === '::1' ? [bind] : [bind, '127.0.0.1'];
let listening = 0;
const servers = addresses.map((address) =>
  app.listen(port, address, () => {
    console.log(`Hostboard listening on ${address}:${port}; ${agents.length} hosts configured`);
    // Self-checks must not race the HTTP listeners during startup.
    if (++listening === addresses.length) monitor.start();
  }),
);
process.on('SIGTERM', () => {
  monitor.stop();
  let remaining = servers.length;
  for (const server of servers) {
    server.close(() => {
      if (--remaining === 0) process.exit(0);
    });
  }
});
